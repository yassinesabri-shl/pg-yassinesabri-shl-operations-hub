#!/usr/bin/env node
// Part of the harness asset library c6f3b4427d58f7c3 (see VERSION.json) · 2026-10-13
/**
 * check-coverage.mjs — the two coverage floors of decision 2a, judged on one commit.
 *
 * A spoke's checks.env names how it measures coverage and the two floors that apply:
 *
 *   COVERAGE_COMMAND        the repository's own command; the harness ships no coverage tool
 *   PROJECT_COVERAGE_FLOOR  whole-project line coverage may not fall below this (measured on the
 *                           trunk at the spoke install, rounded down, raised by hand between sprints)
 *   CHANGED_LINE_FLOOR      the lines the change added or modified must reach this (decision 2a: 95)
 *
 * This file is the single implementation of the judgement. The spoke's story-gate step runs it on
 * every pull request, and /dev-sprint's finalizer imports it for each round, through the candidate
 * rows of check-staged.mjs that commit the round.
 *
 *   usage:  node scripts/check-coverage.mjs --repo <dir> --base <commit> --checks-from-trunk [--install]
 *           node scripts/check-coverage.mjs --repo <dir> --base <commit> --checks <file> [--install]
 *
 *   --repo               the checkout to measure, at its HEAD; nothing tracked may be modified
 *   --base               the change is measured from `git merge-base <base> HEAD`
 *   --checks-from-trunk  the command and both floors come from checks.env on the spoke's trunk,
 *                        force-fetched, never from the branch being judged: a branch cannot lower
 *                        its own bar. The trunk is found by the trunk rule in spoke-trunk.mjs:
 *                        HARNESS_SPOKE_TRUNK where set, otherwise TRUNK_FOR_HUB at HEAD.
 *   --checks <file>      a checks.env file as it stands (a fixture, or a run by hand)
 *   --install            run INSTALL_COMMAND from the same checks.env first, once, at the root.
 *                        The story-gate step passes it: its checkout holds only tracked files, and
 *                        the coverage command needs the dependencies. The install is judged as the
 *                        finalizer judges it: by its exit code and by the tree. Files git ignores
 *                        may appear; a changed tracked file or a new file git does not ignore fails.
 *                        `none` and `none — <why>` install nothing. UNRESOLVED, missing or empty is
 *                        exit 2. A failed install is exit 1, and the coverage command does not run.
 *
 * The command's contract (checks.env.template states it for the team)
 *   It runs once through /bin/sh at the repository root with HARNESS_COVERAGE_BASE (the merge
 *   base) and HARNESS_COVERAGE_HEAD (the commit measured; in /dev-sprint's finalizer the candidate's
 *   tree, committed only once every row passes: either way, something `git diff` takes) set, and
 *   prints on stdout:
 *     project=<number>   whole-project line coverage, 0 to 100, `%` optional
 *     changed=<number>   line coverage of the lines added or changed between BASE and HEAD
 *     changed=n/a        it measured, and no measurable line changed
 *   Other lines are ignored, and the last of each wins. A single number alone on the last line is
 *   read as project=<number>, the earlier form. A changed-line floor with no changed= line cannot
 *   be verified: that is exit 2, never a pass.
 *
 * The record. Every result names the bar it was judged against, so a pass read later is a pass
 * against the floors in force then:
 *     project 72.5% (floor 70) · changed 96% (floor 95) · floors from checks.env@a1b2c3d4e5f6
 * The twelve characters are the git blob of the checks.env read: the same bytes on the trunk, in
 * a fixture and in a sprint's frozen copy give the same twelve characters.
 *
 * The values, and what they mean here
 *   a command, two numeric floors   measured and judged
 *   COVERAGE_COMMAND=none           no coverage step, said on purpose: COVERAGE NONE, a pass; a
 *                                   numeric floor beside it contradicts it (exit 2)
 *   UNRESOLVED, missing or empty    for the command or either floor beside a command: cannot verify
 *                                   (exit 2). Not configured never means fine, and the required
 *                                   check stays red until the owner writes them.
 *   a floor that is not 0 to 100    cannot verify (exit 2)
 *
 * Exit codes, shared with every check in the library:
 *   0 both floors met, or COVERAGE NONE  1 a floor not met, or the command failed — every finding
 *   listed  2 cannot verify: a value unresolved or malformed, a command that will not start or
 *   prints no figure, a trunk that cannot be read or is not the one named, a shallow clone, no
 *   merge base, a modified tree  3 usage  4 internal. 2 outranks 1; both are listed.
 *
 * Node standard library only, plus git and /bin/sh via child_process.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, writeSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseChecksEnv } from './test-guard/contract.mjs';
import { SpokeTrunkError, spokeTrunk } from './spoke-trunk.mjs';

export const EXIT = { PASS: 0, FAIL: 1, CANNOT_VERIFY: 2, USAGE: 3, INTERNAL: 4 };
export const COVERAGE_KEYS = ['COVERAGE_COMMAND', 'PROJECT_COVERAGE_FLOOR', 'CHANGED_LINE_FLOOR'];
export const BASE_VAR = 'HARNESS_COVERAGE_BASE';
export const HEAD_VAR = 'HARNESS_COVERAGE_HEAD';
export const INSTALL_KEY = 'INSTALL_COMMAND';
const REMOTE = 'origin';
const CHECKS_ENV = 'checks.env';
const EVIDENCE_LINES = 8;

class CoverageError extends Error {
  constructor(code, message, reason = null) { super(message); this.code = code; this.reason = reason; }
}
const cannotVerify = (message, reason = null) => new CoverageError(EXIT.CANNOT_VERIFY, message, reason);
const usageError = (message) => new CoverageError(EXIT.USAGE, message);
const short = (sha) => String(sha || '').slice(0, 12);

/* --------------------------------------------------------------- the pure judgement */

const get = (values, key) => (values instanceof Map ? values.get(key) : values ? values[key] : undefined);
const unresolved = (v) => v === undefined || v === null || String(v).trim() === '' || String(v).trim().startsWith('UNRESOLVED');
const NUMBER = /^(\d+(?:\.\d+)?)\s*%?$/;

/** A floor as checks.env states it: a number from 0 to 100, `none`, not configured, or invalid. */
export function parseFloor(value) {
  if (unresolved(value)) return { state: 'not-configured', value: null };
  const text = String(value).trim();
  if (text === 'none') return { state: 'none', value: null };
  const m = text.match(NUMBER);
  if (!m || Number(m[1]) > 100) return { state: 'invalid', value: text };
  return { state: 'number', value: Number(m[1]) };
}

/**
 * The three keys, read together. `cannot` lists every reason they cannot be judged, so setup and
 * the check refuse the same configurations in the same words.
 */
export function coverageConfig(values) {
  const command = get(values, 'COVERAGE_COMMAND');
  const floors = { project: parseFloor(get(values, 'PROJECT_COVERAGE_FLOOR')), changed: parseFloor(get(values, 'CHANGED_LINE_FLOOR')) };
  const names = { project: 'PROJECT_COVERAGE_FLOOR', changed: 'CHANGED_LINE_FLOOR' };
  const cannot = [];
  if (unresolved(command)) {
    cannot.push('COVERAGE_COMMAND is missing, empty or UNRESOLVED: nobody has said how this repository measures coverage, and not configured never means fine');
    return { state: 'not-configured', command: null, floors, cannot };
  }
  const none = String(command).trim() === 'none';
  for (const half of ['project', 'changed']) {
    const f = floors[half];
    if (f.state === 'invalid') cannot.push(`${names[half]} is "${f.value}": a floor is a number from 0 to 100`);
    else if (none && f.state === 'number') cannot.push(`${names[half]} is ${f.value} beside COVERAGE_COMMAND=none: a floor with no command to measure it contradicts itself`);
    else if (!none && f.state === 'none') cannot.push(`${names[half]} is none beside a coverage command: a floor is a number from 0 to 100; \`none\` belongs on COVERAGE_COMMAND`);
    else if (!none && f.state === 'not-configured') cannot.push(`${names[half]} is missing, empty or UNRESOLVED beside a coverage command: both floors are needed before anything is judged`);
  }
  return { state: none ? 'none' : 'command', command: none ? 'none' : String(command).trim(), floors, cannot };
}

/** The figures the command printed: project and changed, or why they cannot be read. */
export function parseCoverageOutput(stdout) {
  const lines = String(stdout ?? '').replace(/\r\n?/g, '\n').split('\n').map((l) => l.trim()).filter(Boolean);
  let project = null;
  let changed = null;
  const problems = [];
  for (const line of lines) {
    const p = line.match(/^project\s*=\s*(.*)$/);
    if (p) { project = p[1].trim(); continue; }
    const c = line.match(/^changed\s*=\s*(.*)$/);
    if (c) changed = c[1].trim();
  }
  const figure = (text, name) => {
    if (text === null) return null;
    if (name === 'changed' && text.toLowerCase() === 'n/a') return 'n/a';
    const m = text.match(NUMBER);
    if (!m || Number(m[1]) > 100) { problems.push(`${name}=${text} is not a percentage from 0 to 100`); return null; }
    return Number(m[1]);
  };
  let projectValue = figure(project, 'project');
  if (project === null && lines.length) {
    const bare = lines[lines.length - 1].match(NUMBER);
    if (bare && Number(bare[1]) <= 100) projectValue = Number(bare[1]);
  }
  return { project: projectValue, changed: figure(changed, 'changed'), problems };
}

function figureText(value, floor, label, ran) {
  const bar = floor.state === 'number' ? `floor ${floor.value}` : 'floor not configured';
  if (value === 'n/a') return `${label} n/a (${bar}; no measurable line changed)`;
  if (value === null || value === undefined) return `${label} ${ran ? 'not printed' : 'not measured'} (${bar})`;
  return `${label} ${value}% (${bar})`;
}

/** The one line that records a result against the bar that applied. */
export function recordLine({ config, measured, blob }) {
  const source = `floors from checks.env@${short(blob) || 'unknown'}`;
  if (config.state === 'none') return `coverage none, declared on purpose · ${source}`;
  const m = measured || {};
  const ran = Boolean(measured);
  return `${figureText(m.project, config.floors.project, 'project', ran)} · ${figureText(m.changed, config.floors.changed, 'changed', ran)} · ${source}`;
}

/**
 * The judgement, given the configuration and what the command did (`{ status, stdout, tail }`, or
 * null when nothing ran). Returns `result` ('pass' | 'fail' | 'cannot' | 'none'), the findings
 * (a floor not met, the command failed), the reasons it cannot be judged, notes, and the record.
 */
export function judgeCoverage({ config, run, blob }) {
  const findings = [];
  const cannot = [...config.cannot];
  const notes = [];
  if (config.state === 'none' && !cannot.length) {
    return { result: 'none', findings, cannot, notes, measured: null, record: recordLine({ config, measured: null, blob }) };
  }
  let measured = null;
  if (!cannot.length && run) {
    if (run.status !== 0) {
      findings.push(`COVERAGE_COMMAND exited ${run.status}${run.tail ? ` — ${run.tail}` : ''}`);
    } else {
      measured = parseCoverageOutput(run.stdout);
      cannot.push(...measured.problems);
      const { project: pf, changed: cf } = config.floors;
      if (measured.project === null) cannot.push('COVERAGE_COMMAND printed no project line coverage: a `project=<n>` line, or a single number on its last line');
      else if (measured.project < pf.value) findings.push(`project coverage ${measured.project} is below PROJECT_COVERAGE_FLOOR ${pf.value}`);
      if (measured.changed === null) cannot.push(`COVERAGE_COMMAND printed no changed= line, so the changed lines cannot be judged against CHANGED_LINE_FLOOR ${cf.value}; the command must print changed=<n> or changed=n/a`);
      else if (measured.changed === 'n/a') notes.push('no measurable line changed between the merge base and the commit measured: the changed-line floor had nothing to judge');
      else if (measured.changed < cf.value) findings.push(`changed-line coverage ${measured.changed} is below CHANGED_LINE_FLOOR ${cf.value}`);
    }
  }
  const result = cannot.length ? 'cannot' : findings.length ? 'fail' : 'pass';
  // A floor or a command that checks.env does not set is the configuration's. Anything else is the output's.
  const reason = result !== 'cannot' ? null : config.cannot.length ? 'config-invalid' : 'coverage-unreadable';
  return { result, reason, findings, cannot, notes, measured, record: recordLine({ config, measured, blob }) };
}

/* ---------------------------------------------------------------- the command, run */

function lastLines(text) {
  return String(text || '').split('\n').map((l) => l.trim()).filter(Boolean).slice(-EVIDENCE_LINES)
    .map((l) => (l.length > 200 ? `${l.slice(0, 200)}…` : l)).join(' · ');
}

/** Run the command once, with the two variables set. `cannotStart` when the shell could not run it. */
export function runCoverageCommand({ cwd, command, base, head, env = process.env }) {
  const res = spawnSync('/bin/sh', ['-c', command], {
    cwd, encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...env, [BASE_VAR]: base, [HEAD_VAR]: head },
  });
  const cannotStart = res.error ? res.error.message : (res.status === 126 || res.status === 127) ? `exit ${res.status}` : null;
  return { status: res.status, stdout: res.stdout || '', stderr: res.stderr || '', tail: lastLines(`${res.stdout || ''}\n${res.stderr || ''}`), cannotStart };
}

/* ------------------------------------------------------------------ the install */

/**
 * INSTALL_COMMAND as checks.env.template defines it: { state: 'command', command },
 * { state: 'none', reason }, or { state: 'unresolved', value } for missing, empty, UNRESOLVED and
 * any other word followed by text that is not ` — <why>`. Read here, not through check-staged.mjs,
 * because check-staged.mjs imports this file.
 */
export function installConfig(values) {
  const raw = get(values, INSTALL_KEY);
  const value = raw === undefined || raw === null ? '' : String(raw).trim();
  if (unresolved(value)) return { state: 'unresolved', value: value || null };
  if (value === 'none') return { state: 'none', reason: null };
  if (value.match(/^none\b/)) {
    const m = value.match(/^none\s+—\s+(\S.*)$/);
    return m ? { state: 'none', reason: m[1] } : { state: 'unresolved', value };
  }
  return { state: 'command', command: value };
}

/** Every path whose state differs from HEAD, untracked files git does not ignore included. */
function treeState(repo) {
  const res = git(repo, ['status', '--porcelain', '--untracked-files=all', '--ignore-submodules=all']);
  if (res.status !== 0) throw cannotVerify(`cannot read the tree: ${String(res.stderr).trim().split('\n')[0]}`, 'git-failed');
  return new Set(res.stdout.split('\n').filter((l) => l.length > 3));
}

/** Runs the install once and judges it. Returns { code, lines }: code 0, 1 or 2. */
export function runInstall({ repo, values, env = process.env }) {
  const config = installConfig(values);
  if (config.state === 'none') return { code: EXIT.PASS, lines: [`INSTALL NONE — ${config.reason || 'this repository installs nothing into a new checkout'}`] };
  if (config.state === 'unresolved') {
    const said = config.value === null ? 'missing or empty' : `"${config.value}"`;
    return { code: EXIT.CANNOT_VERIFY, reason: 'config-invalid', lines: [`CANNOT VERIFY: ${INSTALL_KEY} is ${said}: nobody has said how a new checkout gets its dependencies, so the coverage command cannot be run here`] };
  }
  const before = treeState(repo);
  const res = spawnSync('/bin/sh', ['-c', `exec 2>&1\n${config.command}`], { cwd: repo, env, encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'pipe'] });
  const tail = lastLines(`${res.stdout || ''}\n${res.stderr || ''}`);
  if (res.error || res.signal || res.status === 126 || res.status === 127) {
    const why = res.error ? res.error.message : res.signal ? `stopped by ${res.signal}` : `exit ${res.status}`;
    return { code: EXIT.CANNOT_VERIFY, reason: res.signal ? 'command-stopped' : 'tool-missing', lines: [`CANNOT VERIFY: ${INSTALL_KEY} "${config.command}" failed to start (${why})${tail ? ` — ${tail}` : ''}`] };
  }
  const changed = [...treeState(repo)].filter((l) => !before.has(l)).map((l) => l.slice(3));
  const lines = [];
  if (res.status !== 0) lines.push(`INSTALL FAILED — ${INSTALL_KEY} "${config.command}" exited ${res.status}${tail ? ` — ${tail}` : ''}`);
  if (changed.length) lines.push(`INSTALL FAILED — ${INSTALL_KEY} "${config.command}" changed the tree: ${changed.slice(0, 10).join(', ')}. It may write only files git ignores; a lockfile it rewrites is out of date`);
  if (lines.length) return { code: EXIT.FAIL, lines };
  return { code: EXIT.PASS, lines: [`INSTALL OK — ${config.command}`] };
}

/* ------------------------------------------------------------------ the checkout */

function git(repo, args, input) {
  return spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', input, maxBuffer: 1 << 26, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
}
function gitOut(repo, args, what, input) {
  const res = git(repo, args, input);
  if (res.error) throw new CoverageError(EXIT.INTERNAL, `git could not run: ${res.error.message}`);
  if (res.status !== 0) throw cannotVerify(`${what}: ${String(res.stderr || res.stdout).trim().split('\n')[0] || `git exited ${res.status}`}`, 'git-failed');
  return res.stdout.trim();
}

/** The checks.env on the spoke's trunk, by the trunk rule (spoke-trunk.mjs): its text and blob. */
function checksFromTrunk(repo) {
  let t;
  try {
    t = spokeTrunk(repo);
  } catch (err) {
    if (err instanceof SpokeTrunkError) throw cannotVerify(err.message, err.reason);
    throw err;
  }
  if (!t.text) throw cannotVerify(`${REMOTE}/${t.trunk} at ${short(t.commit)} has no ${CHECKS_ENV}: there is no recorded bar to judge against`, 'config-invalid');
  return { text: t.text, blob: t.blob, source: `${REMOTE}/${t.trunk} at ${short(t.commit)}` };
}

function checksFromFile(repo, file) {
  const path = resolve(file);
  if (!existsSync(path)) throw cannotVerify(`no checks.env at ${path}`, 'config-invalid');
  const bytes = readFileSync(path);
  return { text: bytes.toString('utf8'), blob: gitOut(repo, ['hash-object', '--stdin', '--no-filters'], 'cannot hash the checks.env file', bytes), source: path };
}

function prepare(o) {
  const repo = resolve(o.repo || '.');
  if (!existsSync(repo)) throw cannotVerify(`no directory at ${repo}`, 'not-a-checkout');
  const top = git(repo, ['rev-parse', '--show-toplevel']);
  if (top.status !== 0) throw cannotVerify(`${repo} is not a git checkout`, 'not-a-checkout');
  if (gitOut(repo, ['rev-parse', '--is-shallow-repository'], 'cannot ask whether the clone is shallow') === 'true') {
    throw cannotVerify('the clone is shallow: the merge base cannot be trusted. Fetch the whole history (fetch-depth: 0)', 'shallow-clone');
  }
  const head = gitOut(repo, ['rev-parse', '--verify', 'HEAD^{commit}'], `${repo} has no commit at HEAD`);
  const status = git(repo, ['status', '--porcelain', '--untracked-files=no', '--ignore-submodules=all']);
  if (status.status !== 0) throw cannotVerify(`cannot read the tree: ${String(status.stderr).trim().split('\n')[0]}`, 'git-failed');
  // Not trimmed: each record starts with a two-column status, and a leading space is one of them.
  const dirty = status.stdout.split('\n').filter((l) => l.length > 3);
  if (dirty.length) throw cannotVerify(`the tree measured is not the commit: tracked files are modified (${dirty.slice(0, 5).map((l) => l.slice(3)).join(', ')})`, 'uncommitted-changes');
  const base = gitOut(repo, ['rev-parse', '--verify', `${o.base}^{commit}`], `--base "${o.base}" is not a commit here`);
  const mergeBase = gitOut(repo, ['merge-base', base, head], `${short(base)} and HEAD ${short(head)} share no history`);
  const checks = o.trunk ? checksFromTrunk(repo) : checksFromFile(repo, o.checks);
  return { repo, head, mergeBase, checks };
}

/* ---------------------------------------------------------------------- the CLI */

function parseArgs(argv) {
  const o = { repo: '.', base: null, trunk: false, checks: null, install: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--checks-from-trunk') o.trunk = true;
    else if (a === '--install') o.install = true;
    else if (a === '--repo' || a === '--base' || a === '--checks') {
      if (i + 1 >= argv.length) throw usageError(`${a} needs a value`);
      o[a.slice(2)] = argv[(i += 1)];
    } else throw usageError(`unknown argument "${a}"`);
  }
  if (!o.base) throw usageError('--base <commit> is required');
  if (o.trunk === Boolean(o.checks)) throw usageError('name where the floors come from, once: --checks-from-trunk, or --checks <file>');
  return o;
}

const say = (line) => process.stdout.write(`${line}\n`);

function report(judged, where) {
  if (judged.result !== 'none' && judged.measured) say(`COVERAGE ${judged.record} · base ${short(where.mergeBase)} · head ${short(where.head)}`);
  for (const n of judged.notes) say(`note: ${n}`);
  for (const f of judged.findings) say(`FAIL ${f}`);
  for (const c of judged.cannot) say(`CANNOT VERIFY: ${c}`);
  if (judged.result === 'none') { say(`COVERAGE NONE — this repository declares no coverage step · ${judged.record}`); return EXIT.PASS; }
  if (judged.result === 'pass') { say(`COVERAGE OK — ${judged.record}`); return EXIT.PASS; }
  if (judged.result === 'cannot') {
    say(`CANNOT VERIFY — ${judged.cannot.length} problem(s)${judged.findings.length ? ` and ${judged.findings.length} finding(s)` : ''}; the floors read: ${judged.record}`);
    if (judged.reason) say(`REASON: ${judged.reason}`);
    return EXIT.CANNOT_VERIFY;
  }
  say(`COVERAGE FAILED — ${judged.findings.length} finding(s) · ${judged.record}`);
  return EXIT.FAIL;
}

function main(argv) {
  const o = parseArgs(argv);
  const where = prepare(o);
  say(`Coverage: ${where.repo} at ${short(where.head)}, changes since ${short(where.mergeBase)}; floors from ${where.checks.source}`);
  const values = parseChecksEnv(where.checks.text);
  if (o.install) {
    const installed = runInstall({ repo: where.repo, values });
    for (const line of installed.lines) say(line);
    if (installed.reason) say(`REASON: ${installed.reason}`);
    if (installed.code !== EXIT.PASS) return installed.code;
  }
  const config = coverageConfig(values);
  let run = null;
  if (config.state === 'command' && !config.cannot.length) {
    run = runCoverageCommand({ cwd: where.repo, command: config.command, base: where.mergeBase, head: where.head });
    if (run.stderr) process.stderr.write(run.stderr.endsWith('\n') ? run.stderr : `${run.stderr}\n`);
    if (run.cannotStart) throw cannotVerify(`COVERAGE_COMMAND "${config.command}" failed to start (${run.cannotStart})${run.tail ? ` — ${run.tail}` : ''}`, 'tool-missing');
  }
  return report(judgeCoverage({ config, run, blob: where.checks.blob }), where);
}

const invoked = (() => { try { return realpathSync(process.argv[1] || '') === realpathSync(fileURLToPath(import.meta.url)); } catch (err) { return false; } })();
if (invoked) {
  // The last line of an exit 2, 3 or 4 names this script and its code, so a shell line that hides
  // the code, with a pipe or `; echo`, still tells the harness's failure record. Written at once,
  // so a process.exit() never loses it.
  process.on('exit', (code) => { if (code >= 2 && code <= 4) { try { writeSync(2, `HARNESS EXIT: check-coverage ${code}\n`); } catch { /* stderr is closed */ } } });
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (err) {
    if (err instanceof CoverageError) {
      if (err.code === EXIT.USAGE) process.stderr.write(`${err.message}\nusage: node ${process.argv[1]} --repo <dir> --base <commit> (--checks-from-trunk | --checks <file>) [--install]\n`);
      else if (err.code === EXIT.INTERNAL) process.stderr.write(`INTERNAL: ${err.message}\n`);
      else {
        say(`CANNOT VERIFY: ${err.message}`);
        if (err.reason) say(`REASON: ${err.reason}`);
      }
      process.exit(err.code);
    }
    process.stderr.write(`INTERNAL: ${err && err.stack ? err.stack : String(err)}\n`);
    process.exit(EXIT.INTERNAL);
  }
}

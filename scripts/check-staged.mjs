#!/usr/bin/env node
// Part of the harness asset library c6f3b4427d58f7c3 (see VERSION.json) · 2026-10-09
/**
 * check-staged.mjs — the secret scan and the format, lint and type-check rows, run on what is
 * about to be committed.
 *
 * harness-commit.mjs runs it before every harness commit, and git is asked to commit only when it
 * passes. It is not a git hook: `git commit --no-verify` skips hooks, and this runs inside the
 * helper's own process. Run on its own, it says what the next harness commit would meet.
 *
 *   usage:  node scripts/check-staged.mjs [--repo <dir>] [--head | --trunk-merge <commit>]
 *
 *   --head  judge the checkout as committed, not what is staged: nothing may be staged and the
 *           tree must be clean, and the same rows run on it. The pre-merge check runs this on
 *           the tree it is about to push. It changes what is judged, never whether: the skips
 *           for harness-only commits and for a checkout with no `origin` do not apply. On the
 *           spoke install's own branch the commands come from `checks.env` at HEAD, because the
 *           trunk has none yet. The install runs this before it pushes. A harness file that fails
 *           the spoke's own format, lint or type-check command then never reaches the trunk.
 *   --trunk-merge <commit>
 *           judge a merge of the spoke's trunk that git made and that is about to be committed
 *           (§ The trunk merge, below). /dev-sprint makes one when the trunk moved during the build.
 *
 * What it does, in order
 *   1. Spoke or not. A checkout is a spoke when `checks.env` is staged at its root or is anywhere
 *      in HEAD's history. Anything else (a hub, which holds no code) passes untouched.
 *   2. No `origin`. A checkout with no `origin` remote cannot push: its commits ship only by
 *      being carried into one that has, and they are judged there. This is the protected-test
 *      guard's engineer clone in /dev-sprint: its finalizer commits the one candidate that ships
 *      through this check, with every row (the candidate rows, below). It passes untouched. An
 *      `origin` that is configured but cannot be reached is exit 2, never this.
 *   3. Harness files only. When every staged path is `checks.env`, the story-gate workflow (with
 *      an upgrade's `.shl-new` and `.shl-upstream.diff` beside it), the pre-commit hook,
 *      `.gitattributes` or a CODEOWNERS file (with a `.shl-new` beside it), the format, lint and
 *      type-check rows are skipped: a harness change is not
 *      a story. The secret scan is not: what is committed is read for secrets whatever it is.
 *      The condition is the staged paths, never a flag.
 *   4. The commands come from the trunk, never from this checkout. The trunk is found by the
 *      trunk rule in spoke-trunk.mjs: HARNESS_SPOKE_TRUNK where set, otherwise TRUNK_FOR_HUB in
 *      checks.env at HEAD, and the branch must exist on origin and agree with TRUNK_FOR_HUB at its
 *      tip. The trunk is force-fetched and `checks.env` read at its head, so a value edited on a
 *      branch counts only once a person merges it. No `checks.env` on the trunk yet is the spoke
 *      install's own branch: format, lint and type-check start once the install merges. Under
 *      --head they run on it, read from `checks.env` at HEAD.
 *   5. The secret scan is the first row: `secret-scan.cjs --staged`, beside this file, which reads
 *      `SECRET_SCAN_COMMAND` from the trunk the same way (told the trunk's name in
 *      HARNESS_SPOKE_TRUNK), hands the command `SHL_SCAN_MODE=staged`
 *      and judges it by its exit code. A spoke's scan is mandatory: `none` is refused, not
 *      passed, and the secret-scan row has no skip but the checkout with no `origin`. The spoke's
 *      pre-commit hook is the same scan, told it already ran (`SHL_SECRET_SCANNED=1`).
 *   6. The tree is what is staged. An unstaged change or an untracked file git does not ignore
 *      fails before anything runs: the checks would judge a tree that is not the one committed.
 *   7. FORMAT_COMMAND, LINT_COMMAND and TYPECHECK_COMMAND run in that order, at the repository
 *      root, through /bin/sh. Each row is judged by its exit code and by the tree: a row that
 *      changed, created or deleted a file fails and names it, so a formatter that rewrites in
 *      place is judged the same as one that only checks; so does a row that changed what is
 *      staged (a tool that stages its own fixes). Nothing it changed is undone or staged.
 *   8. On a pass, one `Harness-Check: <row> <result>` line per row, which harness-commit.mjs
 *      writes as trailers above the watermark: `pass <seconds>s` for a command, `none` or
 *      `none — <why>` for a step the repository does not have. A failed row is never committed,
 *      so no trailer records one. Nothing reads them back; they are the record of what ran.
 *
 * The values, as checks.env.template defines them (the secret scan's own: `none` is refused)
 *   a command                 run it
 *   none, none — <why>        no such step, on purpose: the row passes, reported as none
 *   UNRESOLVED                cannot verify: not set. A key that is missing or empty is the same
 *   UNRESOLVED — <reason>     cannot verify, the reason printed
 *
 * The candidate rows. /dev-sprint's finalizer commits the engineer's work through harness-commit.mjs
 * with CANDIDATE_ROWS, every command of checks.env in its order, INSTALL_COMMAND first, and `frozen`: the checks.env blob
 * frozen at the sprint's setup, read in place of the trunk's, with none of the skips in steps 1 to 4.
 * The same rule judges every row, a tree changed included. The secret scan is the frozen command,
 * run with SHL_SCAN_MODE=staged, and `none` is refused as in step 5; coverage is judged by
 * check-coverage.mjs, the judgement the spoke's story-gate step runs: both floors, the command told
 * `coverage` ({ base, head }) through HARNESS_COVERAGE_BASE and HARNESS_COVERAGE_HEAD, and the bar
 * recorded on the row; migration immutability, unset, reports NOT CONFIGURED and passes. `between(key)` is called after each command, before its tree
 * is judged: the finalizer's protected-test guard.
 *
 * The trunk merge. /dev-sprint brings a story's branch up to the trunk before it opens or pushes the
 * pull request: `git merge --no-ff --no-commit <trunk commit>`, then harness-commit.mjs
 * --trunk-merge <trunk commit>. This mode accepts git's own merge result and nothing else:
 *   - one merge is in progress, and its other parent is <commit>;
 *   - git left no path unmerged. A conflict is a person's to resolve, and the harness never
 *     resolves one;
 *   - <commit> is on the trunk, as the trunk rule finds it and force-fetched;
 *   - what is staged is the tree `git merge-tree --write-tree HEAD <commit>` writes, so no hand edit
 *     rides in the merge, and the working tree is what is staged.
 * The secret scan runs on what is staged. Format, lint and type-check do not run: the merged tree
 * holds only code that a person or a guarded round accepted, and the trunk's code. /dev-sprint runs
 * every command on the merged tree before the branch is pushed, and a guarded round fixes what
 * fails. The same commit made by the code host's "Update branch" button runs no check at all.
 * Outside this mode, a commit while a merge is in progress is refused: a merge with a change on top
 * of it is not git's own result.
 *
 * Exit codes: 0 the commit may be made · 1 a row failed (the scan found something, or its key is
 * `none`), or the tree is not what is staged · 2 cannot verify: a row unresolved, a tool that will
 * not start, the trunk unreachable or not the one named · 3 usage · 4 internal. Every row runs before it exits, and 2 outranks 1.
 * Node standard library only, plus git and /bin/sh.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, writeSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BASE_VAR, HEAD_VAR, coverageConfig, judgeCoverage } from './check-coverage.mjs';
import { SPOKE_TRUNK_VAR, SpokeTrunkError, spokeTrunk } from './spoke-trunk.mjs';

export const EXIT = { PASS: 0, CHECK_FAIL: 1, CANNOT_VERIFY: 2, USAGE: 3, INTERNAL: 4 };
export const CHECKS_ENV = 'checks.env';
export const ROWS = [
  ['FORMAT_COMMAND', 'format'],
  ['LINT_COMMAND', 'lint'],
  ['TYPECHECK_COMMAND', 'typecheck'],
];
// The install row is first: the finalizer's checkout is new and holds only tracked files, so the
// other commands find their dependencies only after it ran. It is not a commit row, because a
// working checkout installs its dependencies once, when it is made.
export const CANDIDATE_ROWS = [
  ['INSTALL_COMMAND', 'install'], ['BUILD_COMMAND', 'build'], ...ROWS, ['TEST_COMMAND', 'tests'], ['COVERAGE_COMMAND', 'coverage'],
  ['SECRET_SCAN_COMMAND', 'secret scan', { scan: true }], ['MIGRATION_IMMUTABILITY_COMMAND', 'migration immutability', { reported: true }],
];
// The spoke's harness-owned files, as scripts/upgrade.mjs writes them (STORY_GATE, CHECKS_ENV).
// Change one there, change it here in the same commit (generation.md §3.2).
const STORY_GATE = '.github/workflows/story-gate.yml';
const HOOK = '.githooks/pre-commit';
const ATTRIBUTES = '.gitattributes';
// The three places GitHub reads CODEOWNERS from, as spoke-codeowners.mjs names them (PLACES). The
// file holds the gate owners block, and `write` proposes a team's own file beside it as .shl-new.
const CODEOWNERS = ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS'];
export const HARNESS_ONLY = new Set([CHECKS_ENV, STORY_GATE, `${STORY_GATE}.shl-new`, `${STORY_GATE}.shl-upstream.diff`, HOOK, ATTRIBUTES, ...CODEOWNERS, ...CODEOWNERS.map((p) => `${p}.shl-new`)]);
// The secret-scan runner, beside this file in the hub: it reads the command from the trunk itself.
const SCAN_RUNNER = join(dirname(fileURLToPath(import.meta.url)), 'secret-scan.cjs');
export const SCAN_KEY = 'SECRET_SCAN_COMMAND';
// The trailer key harness-commit.mjs writes above the watermark, one line per row.
export const TRAILER = 'Harness-Check';
const REMOTE = 'origin';
const TAIL = 40;

/**
 * The line that ends a report that cannot verify: `REASON: <token>`, a token of REASONS in
 * scripts/spoke-remote.mjs. This check imports none of it, and `make reasons` proves the tokens.
 */
const reasonLine = (reason) => (reason ? `REASON: ${reason}\n` : '');
/** The token of the last `REASON: <token>` line in a program's output, or null. */
const lastReason = (text) => (String(text).match(/^REASON: (\S+)\s*$/gm) || []).pop()?.slice('REASON: '.length).trim() || null;

class StagedError extends Error {
  constructor(code, message, reason = null) { super(message); this.code = code; this.reason = reason; }
}

function git(root, args, opts = {}) {
  const res = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });
  if (res.error) throw new StagedError(EXIT.INTERNAL, `git could not run: ${res.error.message}`);
  return res;
}
function gitOut(root, args, code, what, opts = {}) {
  const res = git(root, args, opts);
  if (res.status !== 0) throw new StagedError(code, `${what}: ${(res.stderr || res.stdout).trim().split('\n')[0]}`);
  return res.stdout;
}

/** Flat KEY=value, one per line, `#` comments and blanks skipped, first wins (spoke-rules.mjs). */
export function parseChecksEnv(text) {
  const map = new Map();
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const m = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if (m && !map.has(m[1])) map.set(m[1], m[2].trim());
  }
  return map;
}

/**
 * One value, read as checks.env.template defines it.
 *   { state: 'command', command }
 *   { state: 'none', reason }            reason null when bare
 *   { state: 'unresolved', reason }      reason null when bare, missing or empty
 *   { state: 'invalid', value }          none or UNRESOLVED followed by anything but ` — <text>`
 */
export function valueState(value) {
  if (value === undefined || value === '') return { state: 'unresolved', reason: null };
  for (const [word, state] of [['UNRESOLVED', 'unresolved'], ['none', 'none']]) {
    if (value === word) return { state, reason: null };
    if (new RegExp(`^${word}\\b`).test(value)) {
      const m = value.match(new RegExp(`^${word}\\s+—\\s+(\\S.*)$`));
      return m ? { state, reason: m[1] } : { state: 'invalid', value };
    }
  }
  return { state: 'command', command: value };
}

/** Whether the checkout has an `origin` remote configured, reachable or not. */
const hasOrigin = (root) => git(root, ['remote']).stdout.split('\n').includes(REMOTE);

/** Paths staged for the commit, deletions included. */
function stagedPaths(root) {
  return gitOut(root, ['diff', '--cached', '--name-only', '-z', '--no-renames'], EXIT.INTERNAL, 'cannot list the staged paths').split('\0').filter(Boolean);
}

function isSpoke(root) {
  if (git(root, ['ls-files', '--cached', '--error-unmatch', '--', CHECKS_ENV]).status === 0) return true;
  if (git(root, ['rev-parse', '--verify', '--quiet', 'HEAD']).status !== 0) return false;
  return git(root, ['log', '-1', '--format=%H', 'HEAD', '--', CHECKS_ENV]).stdout.trim() !== '';
}

/**
 * Every path whose working copy is not what is staged, with a fingerprint of its content: files
 * changed or deleted against the index, and untracked files git does not ignore.
 */
function dirt(root) {
  const entries = gitOut(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames'], EXIT.INTERNAL, 'cannot read the working tree').split('\0').filter(Boolean);
  const paths = [];
  for (const entry of entries) {
    const status = entry.slice(0, 2);
    if (status === '??' || status[1] !== ' ') paths.push({ path: entry.slice(3), kind: status === '??' ? 'untracked' : status[1] === 'D' ? 'deleted' : 'changed' });
  }
  const present = paths.filter((p) => p.kind !== 'deleted');
  const hashes = present.length
    ? gitOut(root, ['hash-object', '--stdin-paths'], EXIT.INTERNAL, 'cannot hash the working tree', { input: present.map((p) => p.path).join('\n') }).trim().split('\n')
    : [];
  const map = new Map();
  present.forEach((p, i) => map.set(p.path, `${p.kind}:${hashes[i]}`));
  for (const p of paths) if (p.kind === 'deleted') map.set(p.path, 'deleted');
  return map;
}
function changedBetween(before, after) {
  const out = [];
  for (const path of new Set([...before.keys(), ...after.keys()])) {
    if (before.get(path) === after.get(path)) continue;
    const now = after.get(path);
    out.push(`${path} (${now === undefined ? 'restored' : now === 'deleted' ? 'deleted' : now.startsWith('untracked') ? 'created' : 'changed'})`);
  }
  return out.sort();
}

/** The trunk and checks.env at its tip, by the trunk rule (spoke-trunk.mjs). */
function readTrunk(root, named) {
  try {
    return spokeTrunk(root, named);
  } catch (err) {
    if (err instanceof SpokeTrunkError) throw new StagedError(EXIT.CANNOT_VERIFY, err.message, err.reason);
    throw err;
  }
}

/** The tool's own words, its last lines, indented under the row. */
function tail(text) {
  const lines = String(text).replace(/\s+$/, '').split('\n');
  if (lines.length === 1 && lines[0] === '') return [];
  const shown = lines.slice(-TAIL).map((l) => `      ${l}`);
  return lines.length > TAIL ? [`      … ${lines.length - TAIL} earlier line(s) not shown`, ...shown] : shown;
}

const stagedTree = (root) => gitOut(root, ['write-tree'], EXIT.INTERNAL, 'cannot read what is staged').trim();

/**
 * One row: the command through /bin/sh, or with `launch` a program of our own ({ file, args, env,
 * cannotVerify }, `command` then only what the report calls it). `cannotVerify(status)` says which
 * exit codes mean the row could not be judged: 126 and 127 for a command, everything but 0 and 1
 * for the scan runner, which has its own exit codes. `row` is what the finalizer records: the
 * output (coverage's stdout apart), the exit and the result. `coverage` is the finalizer's: the
 * base and head the coverage command is told, and the checks.env blob its record names.
 */
function runRow(root, key, name, command, { launch = null, env = process.env, between = () => {}, values = null, coverage: measure = null } = {}) {
  const staged = stagedTree(root);
  const before = dirt(root);
  const cannotVerify = launch ? launch.cannotVerify : (status) => status === 126 || status === 127;
  // stderr joined to stdout inside the shell, so the tool's words keep their order; coverage's
  // stdout is kept apart, because its figure is read from it.
  const coverage = key === 'COVERAGE_COMMAND' && values;
  const started = process.hrtime.bigint();
  const res = launch
    ? spawnSync(launch.file, launch.args, { cwd: root, env: launch.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 })
    : spawnSync('/bin/sh', ['-c', coverage ? command : `exec 2>&1\n${command}`], { cwd: root, env: coverage && measure ? { ...env, [BASE_VAR]: measure.base, [HEAD_VAR]: measure.head } : env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
  const ms = Math.round(Number(process.hrtime.bigint() - started) / 1e6);
  const seconds = `${(ms / 1000).toFixed(1)}s`;
  between(key);
  const after = dirt(root);
  const changed = changedBetween(before, after);
  const restaged = stagedTree(root) !== staged;
  const output = `${res.stdout || ''}${res.stderr || ''}`;
  const said = tail(output);
  const row = { key, name, command, exit: res.status, ms, output, ...(coverage ? { stdout: res.stdout || '' } : {}) };
  const cannot = (lines, reason) => ({ code: EXIT.CANNOT_VERIFY, lines, reason, row: { ...row, result: 'cannot' } });
  if (res.error) return cannot([`  [CANNOT VERIFY] ${key}  ${command} — did not start: ${res.error.message}`], 'tool-missing');
  if (res.signal) return cannot([`  [CANNOT VERIFY] ${key}  ${command} — stopped by ${res.signal} before it finished`, ...said], 'command-stopped');
  if (res.status !== 0 && cannotVerify(res.status)) {
    // A program of ours, such as the scan runner, names its own reason in a REASON line.
    return cannot([`  [CANNOT VERIFY] ${key}  ${command} — exit ${res.status}${launch ? '' : ': the tool is not installed on this machine, or cannot be run'}`, ...said], launch ? lastReason(output) : 'tool-missing');
  }
  const lines = [];
  const reasons = [];
  let code = EXIT.PASS;
  if (res.status !== 0) {
    code = EXIT.CHECK_FAIL;
    lines.push(`  [FAIL] ${key}  ${command} — exit ${res.status}`, ...said);
  }
  if (changed.length) {
    code = EXIT.CHECK_FAIL;
    reasons.push(`changed the tree: ${changed.join(', ')}`);
    lines.push(`  [FAIL] ${key}  ${command} — ${res.status === 0 ? 'exit 0, but it' : 'it also'} changed the tree, so what is staged is not what this tool accepts: ${changed.join(', ')}. Look at each change, stage it, and commit again`);
  }
  if (restaged) {
    code = EXIT.CHECK_FAIL;
    reasons.push('changed what is staged');
    lines.push(`  [FAIL] ${key}  ${command} — it changed what is staged (a tool that stages its own fixes): what would be committed is not what was handed to the checks. Unstage, look at each change, and commit again`);
  }
  let record = '';
  if (coverage && res.status === 0) {
    // check-coverage.mjs's judgement, the one the spoke's story-gate step runs: a figure it cannot
    // read, or a floor it cannot judge, is a row that cannot be verified, never a pass.
    const judged = judgeCoverage({ config: coverageConfig(values), run: { status: 0, stdout: res.stdout || '' }, blob: measure && measure.blob });
    Object.assign(row, { record: judged.record, notes: judged.notes, ...(judged.measured ? { coverage: judged.measured.project, changed: judged.measured.changed } : {}) });
    record = ` — ${judged.record}`;
    // Every finding is listed, a stop too: 2 outranks 1, and one run says everything to fix.
    if (judged.result === 'cannot') {
      const why = [...judged.cannot, ...judged.findings].join('; ');
      return { code: EXIT.CANNOT_VERIFY, lines: [...lines, `  [CANNOT VERIFY] ${key}  ${command} — ${why}${record}`], reason: judged.reason, row: { ...row, result: 'cannot', reason: why } };
    }
    for (const f of judged.findings) {
      code = EXIT.CHECK_FAIL;
      reasons.push(f);
      lines.push(`  [FAIL] ${key}  ${command} — ${f}${record}`);
    }
  }
  if (code === EXIT.PASS) lines.push(`  [PASS] ${key}  ${command}  (${seconds})${record}`);
  return { code, lines, trailer: `${name} pass ${seconds}`, output, row: { ...row, result: code === EXIT.PASS ? 'pass' : 'fail', ...(reasons.length ? { reason: reasons.join('; ') } : {}) } };
}

/** The commits a merge in progress joins to HEAD, from MERGE_HEAD; empty when no merge is in progress. */
function mergeHeads(root) {
  const path = gitOut(root, ['rev-parse', '--git-path', 'MERGE_HEAD'], EXIT.INTERNAL, 'cannot find the git directory').trim();
  const file = isAbsolute(path) ? path : join(root, path);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean);
}

/** The paths git left unmerged, each once. */
function unmergedPaths(root) {
  const out = gitOut(root, ['ls-files', '--unmerged', '-z'], EXIT.INTERNAL, 'cannot read the index').split('\0').filter(Boolean);
  return [...new Set(out.map((entry) => entry.slice(entry.indexOf('\t') + 1)))].sort();
}

/**
 * The trunk-merge row: the merge in progress is git's own merge of `commit`, a commit on the trunk
 * `t` (§ The trunk merge, in the header). Returns the row, with `merged`, the full hash, on a pass.
 */
function trunkMergeRow(root, commit, t) {
  const fails = [];
  const heads = mergeHeads(root);
  const full = git(root, ['rev-parse', '--verify', '--quiet', `${commit}^{commit}`]).stdout.trim();
  const short = (full || commit).slice(0, 12);
  if (!full) fails.push(`${commit} is not a commit in this checkout. Fetch the trunk, then merge the commit that was read`);
  if (!heads.length) fails.push(`no merge is in progress. Run git merge --no-ff --no-commit ${short} first`);
  else if (heads.length > 1) fails.push(`the merge in progress joins ${heads.length} commits to HEAD. A trunk merge joins one`);
  else if (full && heads[0] !== full) fails.push(`the merge in progress is of ${heads[0].slice(0, 12)}, not of ${short}`);
  const unmerged = unmergedPaths(root);
  if (unmerged.length) fails.push(`git left ${unmerged.length} path(s) unmerged: ${unmerged.join(', ')}. A person resolves a conflict. The harness never resolves one`);
  // merge-base --is-ancestor exits 1 for no. Any other exit is a git fault, never a finding.
  const onTrunk = full ? git(root, ['merge-base', '--is-ancestor', full, t.commit]) : null;
  if (onTrunk && onTrunk.status === 1) {
    fails.push(`${short} is not on ${REMOTE}/${t.trunk} at ${t.commit.slice(0, 12)}. A trunk merge brings in the trunk and nothing else`);
  } else if (onTrunk && onTrunk.status !== 0) {
    throw new StagedError(EXIT.CANNOT_VERIFY, `git merge-base --is-ancestor failed, so the check cannot tell whether ${short} is on ${REMOTE}/${t.trunk}: ${(onTrunk.stderr || onTrunk.stdout).trim().split('\n')[0]}`, 'git-failed');
  }
  if (!fails.length) {
    const res = git(root, ['merge-tree', '--write-tree', '--no-messages', 'HEAD', full]);
    if (res.status === 1) fails.push(`git cannot merge ${short} into HEAD without a conflict. A person resolves a conflict. The harness never resolves one`);
    else if (res.status !== 0) throw new StagedError(EXIT.CANNOT_VERIFY, `git merge-tree --write-tree failed, so the merge result cannot be compared (it needs git 2.38 or later): ${(res.stderr || res.stdout).trim().split('\n')[0]}`, 'git-failed');
    else {
      const tree = res.stdout.trim().split('\n')[0];
      const staged = stagedTree(root);
      if (tree !== staged) {
        const paths = gitOut(root, ['diff-tree', '-r', '--name-only', '--no-renames', tree, staged], EXIT.INTERNAL, 'cannot compare the staged tree with the merge result').trim().split('\n').filter(Boolean);
        fails.push(`what is staged is not git's own merge result. These paths differ: ${paths.join(', ')}. A trunk merge commits git's result unchanged. A change on top of it is the engineer's, in a guarded round`);
      }
    }
  }
  if (fails.length) return { code: EXIT.CHECK_FAIL, lines: fails.map((f) => `  [FAIL] trunk merge  ${f}`) };
  return {
    code: EXIT.PASS,
    merged: full,
    lines: [
      `  [PASS] trunk merge  git's own merge of ${short}, a commit on ${REMOTE}/${t.trunk}, with no conflict and no hand edit`,
      `  [SKIPPED] ${ROWS.map(([key]) => key).join(', ')}  a trunk merge holds only accepted code and the trunk's code. /dev-sprint runs every command on the merged tree before the branch is pushed`,
    ],
    trailer: `trunk-merge ${short} — format, lint and type-check run on the merged tree before the push`,
  };
}

/**
 * The secret-scan row. secret-scan.cjs reads the command from the trunk itself and answers in the
 * exit codes of this script, so the row is its exit code and the tree, like any other.
 * `ifDeclared` is the upgrade's: a spoke that names no scan yet passes, with a warning.
 */
function runScan(root, ifDeclared, named) {
  const env = { ...process.env };
  delete env.SHL_SECRET_SCANNED;
  // The scan applies the trunk rule itself, to the same name this run was handed.
  if (named) env[SPOKE_TRUNK_VAR] = named;
  else delete env[SPOKE_TRUNK_VAR];
  const args = [SCAN_RUNNER, '--repo', root, '--staged', ...(ifDeclared ? ['--if-declared'] : [])];
  const row = runRow(root, SCAN_KEY, 'secret-scan', 'secret-scan.cjs --staged', { launch: { file: process.execPath, args, env, cannotVerify: (status) => status !== 1 } });
  if (row.code !== EXIT.PASS) return row;
  const skipped = row.output.split('\n').find((l) => l.startsWith('SECRET SCAN SKIPPED'));
  if (skipped) return { code: EXIT.PASS, lines: [`  [SKIPPED] ${SCAN_KEY}  ${skipped.replace('SECRET SCAN SKIPPED — ', '')}`], trailer: 'secret-scan none — not named yet; the upgrade only', scanned: false };
  return { ...row, scanned: true };
}

/**
 * Judge what is staged in `repo`, or with `head` the checkout as committed. Returns
 * { code, ran, scanned, report, trailers, rows }: ran is false when the checkout passed untouched
 * (not a spoke, no origin, nothing staged); scanned is true when the secret scan ran and passed, so
 * the hook need not repeat it; trailers is the `Harness-Check:` lines on a pass, otherwise empty;
 * rows is each row as run. `secretScanIfDeclared` is the upgrade's: a spoke that names no scan yet
 * passes, with a warning. The finalizer passes `rows`, `frozen` ({ blob }), `env`, `between` and
 * `coverage` ({ base, head }) (see the header). `trunkMerge` is the trunk commit of a merge in
 * progress (§ The trunk merge). Its result also carries `merged`, the commit's full hash on a pass.
 */
export function checkStaged({ repo = '.', trunk: named = process.env[SPOKE_TRUNK_VAR], head: atHead = false, trunkMerge = null, secretScanIfDeclared = false, rows = ROWS, frozen = null, env = process.env, between = () => {}, coverage = null } = {}) {
  try {
    const root = gitOut(repo, ['rev-parse', '--show-toplevel'], EXIT.USAGE, `${repo} is not a git checkout`).trim();
    const pass = (why) => ({ code: EXIT.PASS, ran: false, scanned: false, trailers: [], report: `COMMIT CHECKS NOT RUN — ${why}\n` });
    // Every row ran, whichever of them: 2 outranks 1.
    const judged = (head, results, atHeadNow) => {
      const code = results.some((r) => r.code === EXIT.CANNOT_VERIFY) ? EXIT.CANNOT_VERIFY : results.some((r) => r.code === EXIT.CHECK_FAIL) ? EXIT.CHECK_FAIL : EXIT.PASS;
      const verdict = code === EXIT.PASS ? 'COMMIT CHECKS PASSED.'
        : code === EXIT.CHECK_FAIL ? (atHeadNow ? 'COMMIT CHECKS FAILED — the commit as it stands fails a row above.' : 'COMMIT CHECKS FAILED — fix each row above and commit again. Nothing was committed.')
          : `COMMIT CHECKS CANNOT VERIFY — ${atHeadNow ? 'the commit' : 'nothing was committed. A row above'} cannot be judged from here; this needs a person, not another attempt.`;
      const trailers = code === EXIT.PASS ? results.filter((r) => r.trailer).map((r) => `${TRAILER}: ${r.trailer}`) : [];
      const scanned = code === EXIT.PASS && results.some((r) => r.scanned === true);
      const reason = code === EXIT.CANNOT_VERIFY ? results.map((r) => r.code === EXIT.CANNOT_VERIFY && r.reason).find(Boolean) || null : null;
      return { code, reason, ran: true, scanned, trailers, rows: results.map((r) => r.row).filter(Boolean), report: `${head}\n${results.flatMap((r) => r.lines).join('\n')}\n\n${verdict}\n${reasonLine(reason)}` };
    };
    if (trunkMerge !== null) {
      if (frozen || atHead) throw new StagedError(EXIT.USAGE, '--trunk-merge judges a merge about to be committed. It takes neither --head nor a frozen checks.env');
      if (!isSpoke(root)) throw new StagedError(EXIT.USAGE, `--trunk-merge merges a spoke's trunk, and ${root} carries no ${CHECKS_ENV} in its tree or its history`);
      const t = readTrunk(root, named);
      const merge = trunkMergeRow(root, trunkMerge, t);
      const loose = changedBetween(new Map(), dirt(root));
      const tree = loose.length
        ? { code: EXIT.CHECK_FAIL, lines: [`  [FAIL] the working tree is not what is staged: ${loose.join(', ')}. Stage these, or remove them`] }
        : { code: EXIT.PASS, lines: [] };
      const result = judged(`COMMIT CHECKS — a trunk merge into ${gitOut(root, ['rev-parse', '--abbrev-ref', 'HEAD'], EXIT.INTERNAL, 'cannot read the branch').trim()}, from ${REMOTE}/${t.trunk} ${t.commit.slice(0, 12)}`,
        [merge, tree, ...(merge.code === EXIT.PASS && tree.code === EXIT.PASS ? [runScan(root, false, t.name)] : [])], false);
      return { ...result, merged: result.code === EXIT.PASS ? merge.merged : null };
    }
    let head;
    let text;
    let blob = frozen ? frozen.blob : null;
    if (frozen) {
      text = gitOut(root, ['cat-file', 'blob', frozen.blob], EXIT.CANNOT_VERIFY, `cannot read the frozen ${CHECKS_ENV} ${frozen.blob}`);
      head = `COMMIT CHECKS — the frozen ${CHECKS_ENV} (blob ${frozen.blob.slice(0, 12)})`;
    } else {
      if (!isSpoke(root)) return pass(`no ${CHECKS_ENV} in this checkout or its history: not a spoke, so there is no code to check`);
      const staged = stagedPaths(root);
      if (atHead && staged.length) {
        return { code: EXIT.CHECK_FAIL, ran: true, scanned: false, trailers: [], report: `COMMIT CHECKS — --head\n  [FAIL] --head judges the checkout as committed, and something is staged: ${staged.join(', ')}. Commit it or unstage it first\n\nCOMMIT CHECKS FAILED — nothing ran.\n` };
      }
      // A merge in progress commits as a merge, nothing staged or not. Only --trunk-merge takes one.
      if (!atHead && mergeHeads(root).length) {
        return { code: EXIT.CHECK_FAIL, ran: true, scanned: false, trailers: [], rows: [], report: `COMMIT CHECKS — a merge is in progress\n  [FAIL] the harness commits a merge only with --trunk-merge <commit>, which takes git's own merge of a trunk commit and nothing else. A merge that needs a hand resolution is a person's to make\n\nCOMMIT CHECKS FAILED — nothing ran and nothing was committed.\n` };
      }
      if (!atHead && !staged.length) return pass('nothing is staged');
      if (!atHead && !hasOrigin(root)) return pass(`no ${REMOTE} remote: this checkout cannot push, so its commits ship only through one that can. In /dev-sprint this is the protected-test guard's engineer clone, whose finalizer commits the candidate it builds through these checks`);
      // The secret scan reads what is staged, whatever it is: harness files too, and the install's
      // own branch, where it reads the command from this checkout (secret-scan.cjs says so).
      if (!atHead && staged.every((p) => HARNESS_ONLY.has(p))) {
        return judged(`COMMIT CHECKS — only harness files are staged (${staged.join(', ')}): format, lint and type-check are skipped, a harness change is not a story`, [runScan(root, secretScanIfDeclared, named)], false);
      }
      const t = readTrunk(root, named);
      if (!t.text && !atHead) {
        return judged(`COMMIT CHECKS — ${REMOTE}/${t.trunk} carries no ${CHECKS_ENV} yet: this is the spoke install's own branch, so format, lint and type-check start once it merges`, [runScan(root, secretScanIfDeclared, t.name)], false);
      }

      const at = atHead ? ` · HEAD ${gitOut(root, ['rev-parse', 'HEAD'], EXIT.INTERNAL, 'cannot read HEAD').trim().slice(0, 12)}, as committed` : '';
      if (t.text) {
        head = `COMMIT CHECKS — ${CHECKS_ENV} at ${REMOTE}/${t.trunk} ${t.commit.slice(0, 12)} (blob ${t.blob.slice(0, 12)})${at}`;
        text = t.text;
        blob = t.blob;
      } else {
        // The install's own branch, judged by the commands it brings. Once it merges, every commit
        // runs them over the whole tree, and the tree then holds the harness files it adds.
        blob = git(root, ['rev-parse', '--verify', '--quiet', `HEAD:${CHECKS_ENV}`]).stdout.trim();
        if (!blob) throw new StagedError(EXIT.CANNOT_VERIFY, `neither ${REMOTE}/${t.trunk} nor HEAD carries ${CHECKS_ENV}: there are no commands to judge the commit by`, 'config-invalid');
        head = `COMMIT CHECKS — ${CHECKS_ENV} at HEAD (blob ${blob.slice(0, 12)})${at}: ${REMOTE}/${t.trunk} carries none yet, so this is the spoke install's own branch, judged by the commands it brings`;
        text = gitOut(root, ['cat-file', 'blob', blob], EXIT.INTERNAL, `cannot read ${CHECKS_ENV} at HEAD`);
      }
    }
    const loose = changedBetween(new Map(), dirt(root));
    if (loose.length) {
      const what = atHead ? 'committed' : 'staged';
      return {
        code: EXIT.CHECK_FAIL, ran: true, scanned: false, trailers: [], rows: [],
        report: `${head}\n  [FAIL] the working tree is not what is ${what}: ${loose.join(', ')}. The checks would judge a tree that is not the one ${atHead ? 'pushed' : 'committed'}: ${atHead ? 'commit these' : 'stage these'}, or remove them\n\nCOMMIT CHECKS FAILED — nothing ran${atHead ? '' : ' and nothing was committed'}.\n`,
      };
    }

    const values = parseChecksEnv(text);
    const results = [...(atHead || frozen ? [] : [runScan(root, secretScanIfDeclared, named)]), ...rows.map(([key, name, { reported = false, scan = false } = {}]) => {
      const v = valueState(values.get(key));
      if (v.state === 'command') {
        // The frozen scan is the command itself, told what to read, as secret-scan.cjs tells it.
        const r = runRow(root, key, name, v.command, { env: scan ? { ...env, SHL_SCAN_MODE: 'staged' } : env, between, values, coverage: coverage && { ...coverage, blob } });
        return scan && r.code === EXIT.PASS ? { ...r, scanned: true } : r;
      }
      if (v.state === 'none' && scan) return { code: EXIT.CHECK_FAIL, lines: [`  [FAIL] ${key}  ${v.reason ? `none — ${v.reason}` : 'none'}: a spoke's secret scan is mandatory, so "none" is refused`], row: { key, name, command: 'none', result: 'fail', reason: 'a spoke\'s secret scan is mandatory' } };
      if (v.state === 'none') return { code: EXIT.PASS, lines: [`  [NONE] ${key}  ${v.reason ? `none — ${v.reason}` : 'none: this repository has no such step, on purpose'}`], trailer: `${name} ${v.reason ? `none — ${v.reason}` : 'none'}`, row: { key, name, command: 'none', result: 'none' } };
      if (v.state === 'invalid') return { code: EXIT.CANNOT_VERIFY, lines: [`  [CANNOT VERIFY] ${key}=${v.value} is not a command, "none", "none — <why>", "UNRESOLVED" or "UNRESOLVED — <reason>"`], reason: 'config-invalid', row: { key, name, command: v.value, result: 'cannot' } };
      if (reported) return { code: EXIT.PASS, lines: [`  [NOT CONFIGURED] ${key}  reported, never a stop`], trailer: `${name} not configured`, row: { key, name, command: values.get(key) || null, result: 'NOT CONFIGURED' } };
      const said = values.has(key) && values.get(key) !== '' ? '' : ` (${values.has(key) ? 'empty' : 'missing'})`;
      const what = v.reason ? 'unresolved' : 'not set';
      return { code: EXIT.CANNOT_VERIFY, lines: [`  [CANNOT VERIFY] ${key}  ${what}${said}${v.reason ? `: UNRESOLVED — ${v.reason}` : `: nobody has chosen a command or "none" for this step. Owner: the repository's tech lead, in ${CHECKS_ENV} on the trunk`}`], reason: 'config-invalid', row: { key, name, command: null, result: 'cannot' } };
    })];
    return judged(head, results, atHead);
  } catch (err) {
    const code = err instanceof StagedError ? err.code : EXIT.INTERNAL;
    const reason = code === EXIT.CANNOT_VERIFY ? err.reason || null : null;
    return { code, reason, ran: true, scanned: false, trailers: [], rows: [], report: `COMMIT CHECKS ${code === EXIT.CANNOT_VERIFY ? 'CANNOT VERIFY' : code === EXIT.USAGE ? 'USAGE' : 'INTERNAL'} — ${err.message}. Nothing was committed.\n${reasonLine(reason)}` };
  }
}

function main(argv) {
  let repo = '.';
  let head = false;
  let trunkMerge = null;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--repo' && argv[i + 1] !== undefined) { repo = argv[i + 1]; i += 1; }
    else if (argv[i] === '--head') head = true;
    else if (argv[i] === '--trunk-merge' && argv[i + 1] !== undefined) { trunkMerge = argv[i + 1]; i += 1; }
    else {
      process.stderr.write(`USAGE — node scripts/check-staged.mjs [--repo <dir>] [--head | --trunk-merge <commit>]; unknown argument: ${argv[i]}\n`);
      return EXIT.USAGE;
    }
  }
  const r = checkStaged({ repo, head, trunkMerge });
  (r.code === EXIT.PASS ? process.stdout : process.stderr).write(r.report);
  return r.code;
}

const invoked = (() => { try { return realpathSync(process.argv[1] || '') === realpathSync(fileURLToPath(import.meta.url)); } catch (err) { return false; } })();
// The last line of an exit 2, 3 or 4 names this script and its code, so a shell line that hides
// the code, with a pipe or `; echo`, still tells the harness's failure record. Written at once,
// so a process.exit() never loses it.
if (invoked) process.on('exit', (code) => { if (code >= 2 && code <= 4) { try { writeSync(2, `HARNESS EXIT: check-staged ${code}\n`); } catch { /* stderr is closed */ } } });
if (invoked) process.exit(main(process.argv.slice(2)));

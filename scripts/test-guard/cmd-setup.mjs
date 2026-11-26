/**
 * cmd-setup.mjs — `check` (the declaration and the secret scan, against a checkout) and `setup`
 * (the approved baseline frozen, once test-review reads APPROVED). A run for one pull-request
 * comment also carries its fix commit's subject (validateSubject), which the candidate's message
 * starts with.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { EXIT, GUARD_KEY, KEY_PATTERN, OID, REPO_ID, RUN_PREFIX, cannot, out, short, usageError } from './common.mjs';
import { git, gitTry, hashBlob, revParse } from './git.mjs';
import {
  buildManifest, frozenValues, makePolicy, parseChecksEnv, parseGuardPaths, parseReadSpoke, patternCoverage, retiredKeyProblem,
} from './contract.mjs';
import { commandIntegrity, controllerReady, declarationGaps, proveBaseline } from './baseline.mjs';
import { notConfigured } from './checks.mjs';
import { coverageConfig } from '../check-coverage.mjs';
import { SCAN_KEY, valueState } from '../check-staged.mjs';
import { MANIFEST_FILE, STATE_SCHEMA, refOf, saveState, writeJson } from './state.mjs';

const REQUIRED_COMMANDS = ['INSTALL_COMMAND', 'FORMAT_COMMAND', 'LINT_COMMAND', 'TYPECHECK_COMMAND', 'BUILD_COMMAND', 'TEST_COMMAND', 'COVERAGE_COMMAND'];
const entries = (n) => `${n} tracked entr${n === 1 ? 'y' : 'ies'}`;

/**
 * The secret scan, read as check-staged.mjs reads it. The finalizer refuses every round on a scan
 * that is not a command, and the engineer cannot change the frozen checks.env, so it is caught
 * before anyone is dispatched: `none` is a finding (exit 1), anything else a stop (exit 2), as
 * secret-scan.cjs has them. Null when the scan is a command.
 */
function scanProblem(env, where) {
  const value = env.get(SCAN_KEY);
  const v = valueState(value);
  if (v.state === 'command') return null;
  const said = value === undefined ? 'missing' : value === '' ? 'empty' : value;
  return { none: v.state === 'none', text: `${SCAN_KEY} is ${said}${where}; a spoke's secret scan is mandatory: name a command, never "none" or "UNRESOLVED"` };
}

/**
 * Why a pull-request comment's fix commit cannot start with `subject`: one line,
 * `fix(<KEY>): resolve <ref> — <title>`, where <ref> is a harness comment, `SHL-R<n>`, or a
 * scanner's, `PRIME-C<n>`. Neither is key-shaped. One commit may fix a group of Prime findings:
 * <ref> is then each `PRIME-C<n>` of the group, joined by ", ". A harness comment is always alone.
 * Empty when it can.
 */
export function validateSubject(key, subject) {
  const s = String(subject ?? '');
  const prefix = `fix(${key}): resolve `;
  const rest = s.startsWith(prefix) ? s.slice(prefix.length) : null;
  if (rest !== null && rest.search(/^(?:SHL-R[1-9]\d*|PRIME-C[1-9]\d*(?:, PRIME-C[1-9]\d*)*) — \S[^\r\n]*$/) === 0) return [];
  return [`--subject ${JSON.stringify(s)} is not "${prefix}<ref> — <title>" on one line, <ref> SHL-R<n>, PRIME-C<n>, or the PRIME-C<n> of a group joined by ", "`];
}

function requireCommit(name, value) {
  if (!value) throw usageError(`--${name} <commit> is required`);
  if (!OID.test(value)) throw usageError(`--${name} must be a complete commit hash, got "${value}"`);
}

/** The declaration — grammar, coverage, what it leaves uncovered, command integrity — and the secret scan, against a checkout's HEAD. */
export function cmdCheck(o) {
  const repo = resolve(o.repo || '.');
  const file = o.checks || join(repo, 'checks.env');
  if (!existsSync(file)) throw cannot(`no commands file at ${file}`, 'config-invalid');
  const bytes = readFileSync(file);
  const read = parseReadSpoke(bytes);
  const env = parseChecksEnv(read ? read.body : bytes.toString('utf8'));
  const source = read ? `${read.repository}@${short(read.commit)}:${read.path}` : file;
  const head = revParse(repo, 'HEAD^{commit}');
  if (!head) throw cannot(`${repo} has no commit to read`, 'git-failed');
  const findings = [];
  const stops = [];
  let notes = [];
  const guard = parseGuardPaths(env.get(GUARD_KEY));
  if (guard.state === 'not-configured') stops.push(`${GUARD_KEY} is missing, empty or UNRESOLVED; /dev-sprint stops on it`);
  if (guard.state === 'none') findings.push(`${GUARD_KEY}=none: nothing is protected, and a sprint that writes tests cannot run`);
  const retired = retiredKeyProblem(env);
  if (retired) findings.push(retired);
  findings.push(...guard.findings);
  const testCommand = env.get('TEST_COMMAND');
  if (notConfigured(testCommand)) stops.push('TEST_COMMAND is missing, empty or UNRESOLVED; /dev-sprint stops on it');
  else if (testCommand === 'none') findings.push('TEST_COMMAND=none: a sprint that writes tests needs a test command');
  const scan = scanProblem(env, '');
  if (scan) (scan.none ? findings : stops).push(scan.text);
  let protectedCount = 0;
  let kind = '';
  if (guard.state === 'patterns') {
    const { entries: manifest, tree } = buildManifest(repo, head, guard.patterns);
    protectedCount = manifest.length;
    const g = patternCoverage(GUARD_KEY, guard.patterns, tree);
    findings.push(...g.findings);
    notes = notes.concat(g.notes);
    if (!manifest.length) findings.push(`${GUARD_KEY} protects no tracked entry at ${short(head)}`);
    for (const e of manifest) if (!e.utf8) findings.push(`${e.path}: a protected path that is not UTF-8; rename it`);
    const policy = makePolicy({ guard: guard.patterns, manifest });
    findings.push(...declarationGaps(repo, tree, policy));
    if (!notConfigured(testCommand) && testCommand !== 'none') {
      const integrity = commandIntegrity(testCommand, new Map(tree.map((e) => [e.path, e])), (p) => policy.approved.has(p));
      findings.push(...integrity.findings);
      notes = notes.concat(integrity.notes);
      kind = integrity.kind;
    }
  }
  for (const n of notes) out(`NOTE ${n}`);
  for (const f of [...stops, ...findings]) out(`FAIL ${f}`);
  if (stops.length || findings.length) {
    out(`TEST GUARD DECLARATION NOT OK — ${stops.length + findings.length} finding(s) in ${source}, read against ${short(head)}`);
    return findings.length ? EXIT.FAIL : EXIT.CANNOT_VERIFY;
  }
  out(`TEST GUARD DECLARATION OK — ${guard.patterns.length} pattern(s) protect ${entries(protectedCount)} at ${short(head)}; test command ${kind}`);
  return EXIT.PASS;
}

function readChecks(o, ctl) {
  if (!existsSync(o.checks)) throw usageError(`--checks ${o.checks} does not exist`);
  const read = parseReadSpoke(readFileSync(o.checks));
  if (!read) throw usageError(`--checks ${o.checks} is not the output of read-spoke.mjs; save what \`node scripts/read-spoke.mjs ${o['repo-id']} <checks path>\` prints, header and all — the header is what pins the commit`);
  const findings = [];
  if (read.repository !== o['repo-id']) findings.push(`the commands file was read from ${read.repository}, not ${o['repo-id']}`);
  if (!OID.test(read.commit)) findings.push(`read-spoke's Commit line "${read.commit}" is not a complete commit hash`);
  if (hashBlob(ctl, read.bytes) !== read.blob) findings.push(`the commands file's bytes do not hash to the Blob read-spoke printed (${read.blob}); pass its output unedited`);
  return { read, env: parseChecksEnv(read.body), findings };
}

/** The approved baseline frozen: run directory, manifest, private refs. Writes nothing on a finding. */
export function cmdSetup(o) {
  for (const k of ['controller', 'key', 'repo-id', 'checks']) if (!o[k]) throw usageError(`--${k} is required`);
  if (!KEY_PATTERN.test(o.key)) throw usageError(`--key "${o.key}" does not match ${KEY_PATTERN}`);
  if (!REPO_ID.test(o['repo-id'])) throw usageError(`--repo-id "${o['repo-id']}" is not a repository id`);
  requireCommit('base', o.base);
  requireCommit('test', o.test);
  const ctl = realpathSync(resolve(o.controller));
  const top = gitTry(ctl, ['rev-parse', '--show-toplevel']);
  if (top.status !== 0 || realpathSync(top.stdout.trim()) !== ctl) throw usageError(`--controller ${ctl} is not the top of a git checkout`);
  const { read, env, findings } = readChecks(o, ctl);
  const stops = [];
  for (const k of REQUIRED_COMMANDS) if (notConfigured(env.get(k))) stops.push(`${k} is missing, empty or UNRESOLVED in ${read.path} at ${short(read.commit)}; "not configured" never means "fine"`);
  // A coverage command is judged against both floors, by the same rules as the spoke's story-gate
  // step: a floor unresolved or malformed beside it stops the sprint here, before anything runs.
  const coverage = coverageConfig(env);
  if (coverage.state !== 'not-configured') for (const c of coverage.cannot) stops.push(`${c} (${read.path} at ${short(read.commit)})`);
  const scan = scanProblem(env, ` in ${read.path} at ${short(read.commit)}`);
  if (scan) (scan.none ? findings : stops).push(scan.text);
  const testCommand = env.get('TEST_COMMAND');
  if (testCommand === 'none') findings.push('TEST_COMMAND=none: a sprint that writes tests needs a test command');
  const guard = parseGuardPaths(env.get(GUARD_KEY));
  if (guard.state === 'not-configured') stops.push(`${GUARD_KEY} is missing, empty or UNRESOLVED in ${read.path} at ${short(read.commit)}; a sprint that writes tests needs a resolved, non-empty declaration`);
  if (guard.state === 'none') findings.push(`${GUARD_KEY}=none: the repository declares nothing protected, and a sprint that writes tests cannot run`);
  const retired = retiredKeyProblem(env);
  if (retired) findings.push(retired);
  findings.push(...guard.findings);
  const subject = o.subject ?? null;
  if (subject !== null) findings.push(...validateSubject(o.key, subject));
  const branch = controllerReady(ctl, o.test, findings);
  let proof = null;
  if (guard.state === 'patterns' && !notConfigured(testCommand) && testCommand !== 'none') {
    // read-spoke read checks.env at the spoke's trunk commit; a trunk merge in the chain is judged against it.
    proof = proveBaseline({ ctl, key: o.key, base: o.base, test: o.test, guard: guard.patterns, testCommand, trunk: read.commit, subject, findings });
  }
  if (proof) for (const n of proof.notes) out(`NOTE ${n}`);
  for (const f of stops) out(`CANNOT VERIFY ${f}`);
  for (const f of findings) out(`FAIL ${f}`);
  if (stops.length || findings.length) {
    out(`TEST GUARD NOT READY — ${stops.length + findings.length} finding(s); nothing was created`);
    return stops.length ? EXIT.CANNOT_VERIFY : EXIT.FAIL;
  }

  const root = resolve(o['run-root'] || tmpdir());
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(join(root, `${RUN_PREFIX}${o.key}-`));
  const runId = basename(dir).slice(RUN_PREFIX.length);
  try {
    const state = {
      schema: STATE_SCHEMA,
      run_id: runId,
      key: o.key,
      subject,
      repo_id: o['repo-id'],
      created_at: new Date().toISOString(),
      controller: { path: ctl, branch, tip: o.test },
      checks: { repository: read.repository, path: read.path, commit: read.commit, blob: read.blob, values: frozenValues(env) },
      guard: { patterns: guard.patterns },
      test_command: { command: testCommand, kind: proof.integrity.kind, controlling: proof.integrity.controlling },
      // `base` is where coverage is measured from: --base, or the newest trunk commit a trunk merge brought in.
      baseline: { sha: o.test, tree: revParse(ctl, `${o.test}^{tree}`), base: proof.coverageBase },
      sync: null,
      hub: null,
      engineer: null,
      hooks: null,
      preflight: null,
      binding: null,
      rounds: [],
      undone: [],
      accepted: null,
    };
    writeJson(join(dir, MANIFEST_FILE), proof.entries);
    saveState(dir, state);
    const blob = git(ctl, ['hash-object', '-w', '--stdin', '--no-filters'], { input: read.bytes }).trim();
    for (const [name, value] of [['baseline', o.test], ['checks', blob]]) {
      const made = gitTry(ctl, ['update-ref', refOf(state, name), value, '']);
      if (made.status !== 0) throw cannot(`cannot create ${refOf(state, name)} in the controller: ${made.stderr.trim()}`, 'git-failed');
    }
    const n = proof.entries.length;
    out(`Run: ${dir}`);
    out(`Baseline: ${o.test} (ref ${refOf(state, 'baseline')})`);
    if (subject !== null) out(`Subject: ${subject}`);
    if (proof.coverageBase !== o.base) out(`Coverage base: ${proof.coverageBase}, the newest trunk commit the branch merged; changed lines are the branch's own`);
    out(`Manifest: ${n} approved entr${n === 1 ? 'y' : 'ies'} — protected ${guard.patterns.join(', ')}; only the test writer adds or changes a test`);
    out(`Commands: frozen from ${read.path} at ${read.commit} (blob ${blob}); test command ${proof.integrity.kind}${proof.integrity.controlling.length ? ` (depends on ${proof.integrity.controlling.join(', ')})` : ''}`);
    out(`TEST GUARD READY — run ${runId} · baseline ${short(o.test)} · ${n} approved entr${n === 1 ? 'y' : 'ies'}`);
    return EXIT.PASS;
  } catch (err) {
    for (const name of ['baseline', 'checks']) gitTry(ctl, ['update-ref', '-d', `refs/harness/test-guard/${runId}/${name}`]);
    rmSync(dir, { recursive: true, force: true });
    throw err;
  }
}

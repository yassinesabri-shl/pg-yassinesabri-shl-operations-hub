/**
 * state.mjs — the run directory: state, manifest, the in-agent event log, the trusted copy of the
 * engineer definition, the clone marker, and the checks that the run directory still says what the
 * controller recorded at setup.
 *
 * The run directory is temporary and the orchestrator's; nothing in it is kept after cleanup but
 * the one summary line it prints. The controller holds the facts the run directory is checked
 * against: the baseline ref and the frozen checks.env blob under refs/harness/test-guard/<run>/.
 * Both are local refs, as writable as the run directory to a process running as the same user:
 * they catch a run directory that drifted from its controller, not a determined same-user attacker.
 */

import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { GUARD_KEY, PR_LINE, REF_ROOT, RUN_PREFIX, cannot, plural, usageError } from './common.mjs';
import { git, gitTry, lsTree, revParse } from './git.mjs';
import { FROZEN_KEYS, buildManifest, frozenValues, hostsIn, makePolicy, parseChecksEnv, parseGuardPaths } from './contract.mjs';
import { discoveredConfigs } from './baseline.mjs';

export const STATE_FILE = 'state.json';
export const MANIFEST_FILE = 'manifest.json';
const EVENTS_FILE = 'events.jsonl';
export const STATE_SCHEMA = 'harness-test-guard/3';
// Written into an engineer clone's git directory: which run guards it, and that this run made it.
export const MARKER_FILE = 'harness-test-guard.json';

export function writeJson(path, value) {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, path);
}

export function loadState(dirArg) {
  if (!dirArg) throw usageError('--state <run directory> is required');
  const dir = resolve(dirArg);
  const path = join(dir, STATE_FILE);
  if (!existsSync(path)) throw cannot(`no run state at ${path}; run setup first`, 'guard-state-invalid');
  let state;
  let manifest;
  try {
    state = JSON.parse(readFileSync(path, 'utf8'));
    manifest = JSON.parse(readFileSync(join(dir, MANIFEST_FILE), 'utf8'));
  } catch (err) {
    throw cannot(`the run state in ${dir} cannot be read (${err.message}); clean it up and set the run up again`, 'guard-state-invalid');
  }
  if (state.schema !== STATE_SCHEMA) throw cannot(`${path} is not a ${STATE_SCHEMA} run state`, 'guard-state-invalid');
  return { dir, state, manifest };
}

export const saveState = (dir, state) => writeJson(join(dir, STATE_FILE), state);
export const refOf = (state, name) => `${REF_ROOT}/${state.run_id}/${name}`;
/**
 * The run's policy: the declaration, the manifest, the approved test commit's mixed files outside it,
 * and the configuration the frozen test command's runner would find there by searching — each read
 * from the controller's baseline commit and the frozen command, never from a list the run directory keeps.
 */
export function policyOf(state, manifest) {
  const tree = lsTree(state.controller.path, state.baseline.sha);
  return makePolicy({
    guard: state.guard.patterns, manifest, hosts: hostsIn(tree, new Map(manifest.map((e) => [e.path, e]))),
    discovered: discoveredConfigs(state.test_command && state.test_command.command, new Set(tree.map((e) => e.path))).absent,
  });
}

/** The controller is as the run left it: its baseline ref, its branch tip, whole history. */
export function verifyController(state) {
  const ctl = state.controller.path;
  if (!existsSync(ctl)) throw cannot(`the controller checkout ${ctl} is gone`, 'guard-state-invalid');
  if (gitTry(ctl, ['rev-parse', '--is-shallow-repository']).stdout.trim() === 'true') throw cannot(`${ctl} is a shallow clone; the guard reads whole history`, 'shallow-clone');
  const baseline = revParse(ctl, refOf(state, 'baseline'));
  if (baseline !== state.baseline.sha) throw cannot(`the controller's baseline ref ${refOf(state, 'baseline')} resolves to ${baseline || 'nothing'}, not the recorded ${state.baseline.sha}; the run state and the controller disagree`, 'guard-state-invalid');
  const tip = revParse(ctl, `refs/heads/${state.controller.branch}`);
  if (tip !== state.controller.tip) throw cannot(`the controller branch ${state.controller.branch} is at ${tip || 'nothing'}, not the expected ${state.controller.tip}; something other than this run moved it`, 'guard-state-invalid');
}

/**
 * The declaration, the commands and settings, and the manifest in the run directory are what the
 * controller recorded: the patterns, every frozen command and the coverage floors re-read from the
 * frozen checks.env blob, the manifest rebuilt from the baseline commit. A difference means
 * something else wrote the run directory, and the run stops. Returns the re-derived { manifest,
 * values }, which the finalizer and the acceptance judge by, never the run state's cached copies.
 */
export function verifyIntegrity(state, manifest) {
  const ctl = state.controller.path;
  const blob = revParse(ctl, refOf(state, 'checks'));
  if (blob !== state.checks.blob) throw cannot(`the controller's ${refOf(state, 'checks')} resolves to ${blob || 'nothing'}, not the frozen checks.env blob ${state.checks.blob}`, 'guard-state-invalid');
  const env = parseChecksEnv(git(ctl, ['cat-file', 'blob', blob]));
  const guard = parseGuardPaths(env.get(GUARD_KEY)).patterns;
  const problems = [];
  if (JSON.stringify(guard) !== JSON.stringify(state.guard.patterns)) problems.push(`${GUARD_KEY} in the run state is not the frozen declaration`);
  const values = frozenValues(env);
  const cached = (state.checks && state.checks.values) || {};
  for (const k of FROZEN_KEYS) if ((cached[k] ?? null) !== values[k]) problems.push(`${k} in the run state is not the frozen checks.env (${JSON.stringify(cached[k] ?? null)} for ${JSON.stringify(values[k])})`);
  if (!state.test_command || state.test_command.command !== values.TEST_COMMAND) problems.push('the test command in the run state is not the frozen checks.env\'s');
  const rebuilt = buildManifest(ctl, state.baseline.sha, guard).entries;
  if (JSON.stringify(rebuilt) !== JSON.stringify(manifest)) problems.push('the manifest in the run directory is not the one the baseline commit gives');
  if (problems.length) throw cannot(`${problems.join('; ')} — something other than the guard changed the run directory; escalate`, 'guard-state-invalid');
  return { manifest: rebuilt, values };
}

/* ----------------------------------------------------------------- the event log */

/** Kinds that are tampering — counted in the summary and the reminder — as against bookkeeping. */
export const TAMPER = new Set(['blocked', 'deleted', 'edited', 'mode', 'replaced', 'folder', 'staged', 'removed', 'configured', 'guard']);

/**
 * Appends events to the run's log. An event with a `key` is written once: two hooks Claude Code
 * fires for one tool call record it a single time.
 */
export function recordEvents(dir, events) {
  if (!events.length) return [];
  const keys = new Set(readEvents(dir).filter((e) => e.key).map((e) => e.key));
  const fresh = events.filter((e) => !e.key || !keys.has(e.key));
  if (fresh.length) appendFileSync(join(dir, EVENTS_FILE), fresh.map((e) => `${JSON.stringify({ at: new Date().toISOString(), ...e })}\n`).join(''));
  return fresh;
}

export function readEvents(dir) {
  try {
    return readFileSync(join(dir, EVENTS_FILE), 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

/** Protected-test changes refused or undone in the engineer's working tree so far in this run. */
export const attempts = (events) => events.filter((e) => (e.phase === 'pre' || e.phase === 'post') && TAMPER.has(e.kind)).length;

/** Messages for the engineer that Claude Code could not deliver when they arose; the next hook that can, does. */
export function queueNotice(dir, message) { appendFileSync(join(dir, 'pending-notices.txt'), `${message.replace(/\n/g, '\u2028')}\n`); }
export function takeNotices(dir) {
  const file = join(dir, 'pending-notices.txt');
  if (!existsSync(file)) return [];
  const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => l.replace(/\u2028/g, '\n'));
  rmSync(file, { force: true });
  return lines;
}

/** One mutation of the run directory at a time: two hooks may fire at once. */
export function withLock(dir, fn, timeoutMs = 10000) {
  const lock = join(dir, 'guard.lock');
  const started = Date.now();
  for (;;) {
    try { mkdirSync(lock); break; } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      try { if (Date.now() - statSync(lock).mtimeMs > 30000) { rmSync(lock, { recursive: true, force: true }); continue; } } catch { continue; }
      if (Date.now() - started > timeoutMs) throw cannot(`the guard's lock ${lock} is held by another check`, 'guard-locked');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  try { return fn(); } finally { rmSync(lock, { recursive: true, force: true }); }
}

/* ------------------------------------------- the guard's own hook configuration */

// The hub's engineer definition carries Claude Code's subagent hooks. The preflight keeps a trusted
// copy of it here; a changed or removed one is put back, and fails the round. Never removed.
export const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const copyOf = (dir, f) => join(dir, 'hooks', f.path.replace(/[/\\]/g, '__'));
const readOrNull = (p) => { try { return readFileSync(p); } catch { return null; } };

/** Trusted copies of files under `root` the guard relies on but does not write: { path, root, sha256 }. */
export function snapshotHooks(dir, root, paths) {
  const files = [];
  for (const path of paths) {
    const bytes = readOrNull(join(root, path));
    if (!bytes) continue;
    const f = { path, root, sha256: sha256(bytes) };
    mkdirSync(join(dir, 'hooks'), { recursive: true });
    writeFileSync(copyOf(dir, f), bytes);
    files.push(f);
  }
  return files;
}

/** Puts back every guard file that is missing or changed; returns { path, kind: 'guard' } for each. */
export function repairHooks(state, dir) {
  const changes = [];
  if (!state.hooks) return changes;
  for (const f of state.hooks.files || []) {
    const abs = join(f.root, f.path);
    const now = readOrNull(abs);
    if (now && sha256(now) === f.sha256) continue;
    const trusted = readOrNull(copyOf(dir, f));
    if (!trusted || sha256(trusted) !== f.sha256) throw new Error(`the trusted copy of ${f.path} in ${dir} is missing or changed`);
    rmSync(abs, { force: true, recursive: true });
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, trusted);
    changes.push({ path: abs, kind: 'guard' });
  }
  return changes;
}

/* ---------------------------------------------------------------- the clone marker */

export function writeMarker(clone, state, dir) {
  writeFileSync(join(clone, '.git', MARKER_FILE), `${JSON.stringify({ schema: 'harness-test-guard-clone/1', run_id: state.run_id, state: dir })}\n`);
}

export function readMarker(clone) {
  let marker;
  try { marker = JSON.parse(readFileSync(join(clone, '.git', MARKER_FILE), 'utf8')); } catch (err) { throw cannot(`the clone marker cannot be read (${err.message})`, 'guard-state-invalid'); }
  if (!marker || typeof marker.state !== 'string' || !basename(marker.state).startsWith(RUN_PREFIX)) throw cannot('the clone marker does not name a test-guard run directory', 'guard-state-invalid');
  return marker;
}

export const removeMarker = (clone) => rmSync(join(clone, '.git', MARKER_FILE), { force: true });

/** The engineer clone a path is in, or null. */
export function cloneRootOf(path) {
  for (let dir = resolve(path); ; dir = dirname(dir)) {
    if (existsSync(join(dir, '.git', MARKER_FILE))) return dir;
    if (dirname(dir) === dir) return null;
  }
}

/* -------------------------------------------------------------------- the summary */

/** The compact tampering summary: the one record of the run that outlives cleanup. */
export function summaryLine(state, events) {
  const tamper = (phase) => events.filter((e) => e.phase === phase && TAMPER.has(e.kind)).length;
  const rounds = state.rounds || [];
  return `${PR_LINE} ${tamper('pre')} blocked, ${tamper('post')} restored in the clone, ${(state.undone || []).length} undone by the finalizer in ${rounds.filter((r) => r.undone > 0).length} of ${plural(rounds.length, 'round')}, ${tamper('validate')} caught during validation`;
}

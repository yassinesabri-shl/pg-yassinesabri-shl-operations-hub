/**
 * inagent.mjs — the in-agent guard: the decision before a file operation, the restoration after a
 * command, and the words the engineer reads.
 *
 * The run is the one `test-guard.mjs dispatch` bound the engineer subagent's session to
 * (subagent.mjs), and that directory, outside the clone, is the authority: the baseline, the
 * manifest, the declaration, the event log. The marker in the clone's .git/ is only a cache, for a
 * call with no binding to find a clone under the hub by; removing or changing it disables nothing,
 * and the next check writes it back. A refusal blocks the one operation and says so as tool
 * feedback; the session goes on. This is early feedback, not a boundary: a command can change and
 * run a test before the check after it, and what is accepted is decided by the finalizer and
 * acceptance.
 */

import { existsSync, readdirSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { CONTINUING, NEXT_STEP, RUN_PREFIX, isHandshake, plural, short } from './common.mjs';
import { diffTree, revParse } from './git.mjs';
import { embeddedRunnerConfig, isRunnerConfig, isRunnerHost, testConvention } from './contract.mjs';
import {
  MARKER_FILE, TAMPER, attempts, cloneRootOf, loadState, policyOf, readEvents, readMarker, recordEvents, repairHooks, withLock, writeMarker,
} from './state.mjs';
import { restoreClone } from './scan.mjs';

function realOf(abs) {
  const rest = [];
  for (let cur = abs; ; cur = dirname(cur)) {
    try { return join(realpathSync.native(cur), ...rest); } catch { /* not there yet */ }
    if (dirname(cur) === cur) return abs;
    rest.unshift(basename(cur));
  }
}
const inside = (root, p) => { const r = relative(root, p); return r === '' || (!r.startsWith('..') && !isAbsolute(r)); };
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Whether a shell command starts in one of `dirs`: `cd <dir>` first, then `&&`, `;` or nothing. */
export function startsInClone(command, dirs) {
  const c = String(command || '').trimStart();
  return dirs.filter(Boolean).some((dir) => {
    const d = escapeRe(dir.replace(/\/+$/, ''));
    return new RegExp(`^cd\\s+(?:"${d}/?"|'${d}/?'|${d}/?)(?:\\s*(?:&&|;)|\\s*$)`).test(c);
  });
}
const relOf = (root, p) => relative(root, p).split(sep).join('/');
const inRunDir = (p) => p.split(sep).some((seg) => seg.startsWith(RUN_PREFIX));

/** The run from its trusted directory; the engineer clone is whatever that state records. */
export function openTrusted(stateDir) {
  const { dir, state, manifest } = loadState(stateDir);
  if (!state.engineer) throw new Error('the run records no engineer clone');
  return { dir, state, root: realOf(state.engineer.path), lexical: state.engineer.path, policy: policyOf(state, manifest) };
}

function openFromMarker(clone) {
  const marker = readMarker(clone);
  const run = openTrusted(marker.state);
  if (run.state.run_id !== marker.run_id || run.root !== realOf(clone)) throw new Error('the clone marker does not match the run it names');
  return run;
}

const reminder = (state, n) => `Protected-test reminder: ${plural(n, 'protected-test change')} refused or undone in this run. `
  + `Protected — tests, fixtures, snapshots, helpers, runner configuration: ${state.guard.patterns.join(', ')}. `
  + 'Only the test writer creates or changes them.';

const WHY = {
  approved: (p) => `${p} is an approved test and cannot be changed.`,
  location: (p) => `${p} is inside a protected test location, where only the test writer adds a file.`,
  config: (p) => `${p} would configure test discovery or the runner, which only the test writer may change.`,
  convention: (p, label) => `${p} is laid out as a test (${label}), and only the test writer adds a test.`,
  embedded: (p, found) => `${p} would carry test runner configuration (${found}), which only the test writer may add; keep runner settings out of it.`,
  meta: (p) => `${p} is the engineer clone's git metadata and cannot be changed through a file tool.`,
  controller: (p) => `${p} is in the controller checkout, which only the harness writes.`,
  link: (p, real) => `${p} resolves through a link to ${real}, outside the engineer clone, and cannot be written.`,
  outside: (p) => `${p} is outside your engineer clone, where you do not write.`,
  workdir: (p) => `this command does not start in your engineer clone. Begin every Bash command with cd "${p}" && — your shell keeps no directory between commands.`,
};

const headOf = (root) => { try { return revParse(root, 'HEAD'); } catch { return null; } };

/** A preflight call is recorded as its handshake, never as the engineer's activity; true when it was one. */
function handshake(run, event, step) {
  if (!isHandshake(event.callId, event.session)) return false;
  recordEvents(run.dir, [{ phase: 'handshake', step, event: event.event, nonce: isHandshake(event.session) ? event.session : event.callId }]);
  return true;
}

function refuse(run, event, rel, reason, extra, kind = 'blocked') {
  const message = `TEST_GUARD_BLOCKED: ${WHY[reason](rel, extra)} ${CONTINUING} ${NEXT_STEP}`;
  if (handshake(run, event, 'pre')) return { decision: 'deny', path: rel, message };
  recordEvents(run.dir, [{ phase: 'pre', kind, reason, path: rel, agent: event.agent || null, call: event.callId || null, head: headOf(run.root), key: event.callId ? `pre:${event.callId}:${rel}` : undefined }]);
  return { decision: 'deny', path: rel, message: `${message}\n${reminder(run.state, attempts(readEvents(run.dir)))}` };
}

function judge(run, rel) {
  if (rel === '.git' || rel.startsWith('.git/')) return ['meta'];
  const cls = run.policy.classify(rel);
  if (cls === 'approved') return ['approved'];
  if (cls === 'protected' || run.policy.collides(rel)) {
    if (isRunnerConfig(rel) || run.policy.discovers(rel)) return ['config'];
    return run.policy.declared(rel) || run.policy.collides(rel) ? ['location'] : ['convention', testConvention(rel)];
  }
  return null;
}

function cannotRead(path, err) {
  return { decision: 'deny', path, message: `TEST_GUARD_BLOCKED: ${path} cannot be checked: the guard's run state cannot be read (${err.message}), so this write is refused. ${CONTINUING} Tell the orchestrator: the run must be set up again, or its engineer clone cut afresh.` };
}

/** Before a file operation, or a command: { decision: allow } or { decision: deny, message }. */
export function preCheck(event) {
  const { paths = [] } = event;
  let run;
  try { run = openTrusted(event.state); } catch (err) { return cannotRead(paths[0] || 'this command', err); }
  // The Claude Code engineer subagent works in the hub's directory, its shell keeping none between
  // commands: confined to its clone, every command must say where it runs.
  if (event.confine && typeof event.command === 'string' && !startsInClone(event.command, [run.lexical, run.root])) {
    return refuse(run, event, run.lexical, 'workdir', null, 'redirected');
  }
  for (const p of paths) {
    const abs = resolve(event.cwd || run.root, String(p));
    const real = realOf(abs);
    if (inRunDir(abs) || inRunDir(real)) return { decision: 'deny', path: abs, message: `TEST_GUARD_BLOCKED: ${abs} is the protected-test guard's own state and cannot be changed. ${CONTINUING} Work only inside your engineer clone.` };
    if (inside(realOf(run.state.controller.path), real)) return refuse(run, event, relOf(realOf(run.state.controller.path), real) || '.', 'controller');
    const relReal = inside(run.root, real) ? relOf(run.root, real) : null;
    const relLex = inside(run.lexical, abs) ? relOf(run.lexical, abs) : inside(run.root, abs) ? relOf(run.root, abs) : null;
    if (relLex && !relReal) return refuse(run, event, relLex, 'link', real);
    if (event.confine && !relReal && !relLex) return refuse(run, event, abs, 'outside');
    for (const rel of new Set([relReal, relLex].filter(Boolean))) {
      const reason = judge(run, rel);
      if (reason) return refuse(run, event, rel, ...reason);
      // A whole file written: runner configuration in a mixed file is refused before it lands. An edit
      // is judged after the command, on what it left on disk.
      if (typeof event.content === 'string' && isRunnerHost(rel)) {
        const found = embeddedRunnerConfig(rel, event.content);
        if (found.length) return refuse(run, event, rel, 'embedded', found.join(', '));
      }
    }
  }
  return { decision: 'allow' };
}

const KIND = {
  deleted: 'deleted — restored',
  edited: 'edited — restored',
  mode: 'executable bit changed — restored',
  replaced: 'replaced — restored',
  folder: 'a folder above approved tests was replaced — rebuilt',
  staged: 'a staged change — put back in the index',
  removed: 'a file the declaration refuses (new, untracked or ignored, a new test included) — removed, kept aside until the run ends',
  configured: 'runner configuration added to it — the whole file put back to the approved test commit; make your other changes to it again, without the runner settings',
  guard: 'the guard\'s hook configuration was changed — put back',
};

function committedNote(run) {
  try {
    const changed = diffTree(run.root, run.state.baseline.sha, 'HEAD').filter((ch) => ['approved', 'protected'].includes(run.policy.classify(ch.path)));
    return changed.length ? `\nYour commits since the approved tests still hold ${plural(changed.length, 'protected change')} (${changed.slice(0, 5).map((c) => c.path).join(', ')}); the finalizer undoes them again before anything is imported, so they cannot count.` : '';
  } catch { return ''; }
}

/** Every marked engineer clone a call that names no run could have touched. */
function clonesFor({ cwd, paths = [], roots = [] }) {
  const found = new Map();
  const add = (dir) => { if (dir) { try { found.set(realpathSync.native(dir), dir); } catch { /* gone */ } } };
  const base = cwd || process.cwd();
  for (const p of [base, ...paths]) add(cloneRootOf(resolve(base, String(p))));
  for (const root of roots.filter(Boolean)) {
    add(cloneRootOf(root));
    const wt = join(root, '.worktrees');
    if (!existsSync(wt)) continue;
    for (const key of readdirSync(wt)) {
      let names = [];
      try { names = readdirSync(join(wt, key)); } catch { continue; }
      for (const name of names) if (existsSync(join(wt, key, name, '.git', MARKER_FILE))) add(join(wt, key, name));
    }
  }
  return [...found.values()];
}

function check(run, event) {
  const quarantine = join(run.dir, 'quarantine', `${Date.now()}-${process.pid}`);
  const { changes, markerFixed } = withLock(run.dir, () => {
    const restored = restoreClone(run.root, run.policy, { blobs: run.state.controller.path, quarantine });
    const hooks = repairHooks(run.state, run.dir);
    let fixed = false;
    try { const m = readMarker(run.root); fixed = m.run_id !== run.state.run_id || resolve(m.state) !== resolve(run.dir); } catch { fixed = true; }
    if (fixed) writeMarker(run.root, run.state, run.dir);
    return { changes: [...restored, ...hooks], markerFixed: fixed };
  });
  const head = headOf(run.root);
  const base = { phase: 'post', agent: event.agent || null, call: event.callId || null, head };
  recordEvents(run.dir, [...changes.map((c) => ({ ...base, kind: c.kind, path: c.path })), ...(markerFixed ? [{ ...base, kind: 'marker', path: `.git/${MARKER_FILE}` }] : [])]);
  handshake(run, event, event.phase);
  const tamper = changes.filter((c) => TAMPER.has(c.kind));
  if (!tamper.length) return null;
  const why = (c) => (c.kind === 'removed' && /\.snap$/i.test(c.path) ? `${KIND.removed}; a snapshot a test run wrote means an approved test has none committed, which is a test-change request` : KIND[c.kind]);
  const list = tamper.map((c) => `${c.path} (${why(c)})`).join('; ');
  return `TEST_GUARD_RESTORED: protected tests were changed, and the approved test commit ${short(run.state.baseline.sha)} has been put back: ${list}. ${CONTINUING} ${NEXT_STEP}${committedNote(run)}\n${reminder(run.state, attempts(readEvents(run.dir)))}`;
}

/** After a command, failed or not (or at the end of a turn): restore, then { decision: ok | restored | error, message }. */
export function postCheck(event) {
  const runs = [];
  const messages = [];
  let decision = 'ok';
  if (event.state) {
    try { runs.push(openTrusted(event.state)); } catch (err) { return { decision: 'error', message: `TEST_GUARD_ERROR: the guard's run state cannot be read (${err.message}); the protected tests could not be checked after this command. ${CONTINUING} Tell the orchestrator.` }; }
  } else {
    for (const clone of clonesFor(event)) {
      try { runs.push(openFromMarker(clone)); } catch (err) { messages.push(`TEST_GUARD_ERROR: the engineer clone ${clone} has no readable guard state (${err.message}); its protected tests could not be checked. ${CONTINUING} Tell the orchestrator.`); decision = 'error'; }
    }
  }
  for (const run of runs) {
    if (!existsSync(run.root)) continue;
    const message = check(run, event);
    if (message) { messages.push(message); decision = 'restored'; }
  }
  return messages.length ? { decision, message: messages.join('\n\n') } : { decision: 'ok' };
}

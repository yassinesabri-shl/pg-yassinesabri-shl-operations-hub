/**
 * cmd-engineer.mjs — `engineer-clone`, `preflight` and `dispatch`: the engineer's clone, the proof
 * that Claude Code can run the guard's hooks for it, and its binding to the run.
 *
 * One engineer per run. `dispatch` may be repeated while no engineer has claimed the binding (an
 * Agent call that never started); once one has, the run keeps it, and the orchestrator resumes it
 * with SendMessage. A different engineer means a fresh run, and the engineers of this session's
 * earlier runs are retired: their hooks refuse them in this one from its first call.
 */

import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { EXIT, cannot, out, short, usageError } from './common.mjs';
import { makeEngineerClone } from './clone.mjs';
import { runPreflight } from './preflight.mjs';
import { loadState, readEvents, recordEvents, saveState, sha256, verifyController, verifyIntegrity, withLock } from './state.mjs';
import { AGENT_FILE, boundAgent, dispatchPrompt, readEntry, writeEntry } from './subagent.mjs';

const read = (p) => { try { return readFileSync(p); } catch { return null; } };

/** Proves the engineer definition's hooks and records the result. Returns true when it passed. */
function preflight(dir, state, manifest, hub) {
  const res = runPreflight({ state, dir, manifest, hub });
  state.preflight = { ok: !res.stops.length, at: new Date().toISOString() };
  saveState(dir, state);
  for (const n of res.notes) out(`NOTE ${n}`);
  for (const f of res.stops) out(`CANNOT VERIFY ${f}`);
  if (res.stops.length) {
    out(`PREFLIGHT FAILED — ${res.stops.length} problem(s); do not dispatch the engineer. Fix each line above, then run: preflight --state ${dir}`);
    return false;
  }
  out(`Dispatch: node scripts/test-guard.mjs dispatch --state ${dir}, then the Agent tool with subagent_type "engineer" and the prompt dispatch prints — the engineer runs as a subagent of this session, never as a separate claude process`);
  out(`PREFLIGHT OK — the engineer definition in ${hub} carries the guard's hooks (kept as a trusted copy), every one answering for run ${state.run_id}; dispatch the engineer as a subagent with the line above, and the finalizer requires its binding claim`);
  return true;
}

/** The hub the orchestrator runs in: --hub, the one a preflight recorded, or the current folder. */
const hubOf = (o, state) => (o.hub ? resolve(o.hub) : state.hub || process.cwd());

export function cmdEngineerClone(o) {
  const { dir, state, manifest } = loadState(o.state);
  if (!o.into) throw usageError('--into <dir> is required');
  if (state.accepted) throw usageError(`round ${state.accepted.round} was already accepted; this run needs no engineer clone`);
  if (state.engineer) throw usageError(`this run already has an engineer clone at ${state.engineer.path}; a different clone means a fresh run`);
  verifyController(state);
  // The install command comes from the frozen checks.env blob, never the run state's cached copy.
  const { values } = verifyIntegrity(state, manifest);
  const made = makeEngineerClone(state, dir, o.into, state.baseline.sha, o.sync || null, values.INSTALL_COMMAND);
  state.engineer = { path: made.path, start: made.start, created_at: new Date().toISOString() };
  state.sync = o.sync || null;
  saveState(dir, state);
  out(`NOTE ${made.installNote}`);
  out(`NOTE ${made.hookNote}`);
  out(`ENGINEER CLONE READY — ${made.path} at ${made.start} on ${state.controller.branch}; independent objects, no remote configured${o.sync ? ', config synced' : ', config not synced (no --sync)'}`);
  return preflight(dir, state, manifest, hubOf(o, state)) ? EXIT.PASS : EXIT.CANNOT_VERIFY;
}

export function cmdPreflight(o) {
  const { dir, state, manifest } = loadState(o.state);
  if (state.accepted) throw usageError(`round ${state.accepted.round} was already accepted; no engineer is dispatched again`);
  verifyController(state);
  return preflight(dir, state, manifest, hubOf(o, state)) ? EXIT.PASS : EXIT.CANNOT_VERIFY;
}

export function cmdDispatch(o) {
  const { dir, state } = loadState(o.state);
  if (state.accepted) throw usageError(`round ${state.accepted.round} was already accepted; no engineer is dispatched again`);
  if (!state.engineer || !existsSync(state.engineer.path)) throw cannot('this run has no engineer clone on disk; run engineer-clone first', 'guard-state-invalid');
  if (!state.preflight || !state.preflight.ok) throw cannot(`the Claude Code preflight has not passed for this run: run preflight --state ${dir} first`, 'preflight-missing');
  const session = o.session || process.env.CLAUDE_CODE_SESSION_ID;
  if (!session) throw usageError('the orchestrator\'s Claude Code session is unknown: run dispatch from that session\'s Bash tool, which sets CLAUDE_CODE_SESSION_ID, or pass --session <id>');
  const hub = state.hub;
  const proved = ((state.hooks && state.hooks.files) || []).find((f) => f.path === AGENT_FILE);
  const now = hub && read(join(hub, AGENT_FILE));
  if (!proved || !now || sha256(now) !== proved.sha256) throw cannot(`${join(hub || '<hub>', AGENT_FILE)} is not the engineer definition the preflight proved: run preflight --state ${dir} again`, 'preflight-missing');
  verifyController(state);
  return withLock(dir, () => bind(dir, loadState(dir).state, session, hub));
}

/** The decision and the binding, under the run's lock: nothing can claim between the two. */
function bind(dir, state, session, hub) {
  const owner = state.binding ? boundAgent(readEvents(dir), state.binding) : null;
  if (owner) throw usageError(`engineer ${owner} already claimed this run, and a run has one engineer: resume it with SendMessage, or keep this clone for inspection (cleanup --keep-engineer) and start a fresh run`);
  const prev = readEntry(hub, session).entry || null;
  const retired = new Set([...((prev && prev.retired) || []), ...((state.binding && state.binding.retired) || [])]);
  if (prev && prev.run_id && prev.run_id !== state.run_id && prev.state) {
    let other = null;
    try { other = loadState(prev.state); } catch { /* gone or unreadable: nothing to finish */ }
    if (other && !other.state.accepted) throw usageError(`this session already has an engineer bound to run ${prev.run_id} (${other.state.key}); finish that run or clean it up before dispatching another`);
    const otherOwner = other && other.state.binding ? boundAgent(readEvents(other.dir), other.state.binding) : null;
    if (otherOwner) retired.add(otherOwner);
  }
  const binding = { session, hub, nonce: randomUUID(), clone: resolve(state.engineer.path), retired: [...retired], dispatched_at: new Date().toISOString() };
  state.binding = binding;
  saveState(dir, state);
  const entry = writeEntry(hub, session, { state: dir, run_id: state.run_id, nonce: binding.nonce, retired: binding.retired });
  recordEvents(dir, [{ phase: 'dispatch', nonce: binding.nonce, session, retired: binding.retired }]);

  out(`DISPATCH READY — run ${state.run_id} · baseline ${short(state.baseline.sha)} · engineer clone ${binding.clone} · session ${session}`);
  out(`Entry: ${entry} — the engineer's hooks read it for session ${session} in the hub ${hub}. When the hooks refuse the engineer, compare this session and this file with the ones the refusal names.`);
  if (binding.retired.length) out(`NOTE retired engineers of this session's earlier runs, refused in this one: ${binding.retired.join(', ')}`);
  out('Start it: the Agent tool with subagent_type "engineer" and this prompt, followed by the work — one engineer, never a separate claude process. After a verdict, resume that same engineer with SendMessage:');
  out('--- begin engineer binding ---');
  out(dispatchPrompt(state, binding));
  out('--- end engineer binding ---');
  out('The finalizer accepts nothing from this run until the engineer\'s first hook call from the clone claims it.');
  return EXIT.PASS;
}

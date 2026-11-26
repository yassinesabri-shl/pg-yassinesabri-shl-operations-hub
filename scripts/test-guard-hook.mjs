#!/usr/bin/env node
// Part of the harness asset library c6f3b4427d58f7c3 (see VERSION.json) · 2026-10-08
/**
 * test-guard-hook.mjs — the in-agent protected-test guard: the command the hooks block in the hub's
 * engineer definition runs for every hook call from the Claude Code engineer subagent, bound to a
 * run by `test-guard.mjs dispatch` (test-guard/subagent.mjs).
 *
 *   PreToolUse (Write, Edit, MultiEdit, NotebookEdit, Bash)
 *                       a write to an approved test, a new file in a protected location, a runner
 *                       configuration, the clone's git metadata, the controller, the guard's state,
 *                       a write through a link out of the clone, a path outside the clone, or a
 *                       command that does not start in it is refused with a `deny` whose reason the
 *                       engineer reads: `TEST_GUARD_BLOCKED: <path> is an approved test and cannot be
 *                       changed. Your session is continuing. Tests are owned by the test writer.
 *                       Continue with production code, or send the orchestrator a test-change
 *                       request.` and a reminder with the count.
 *   PostToolUse, PostToolUseFailure (a failed Bash call fires the second, not the first)
 *                       every approved test is put back from the approved commit, on disk and in the
 *                       index; every refused file — tracked, untracked or ignored, a new test
 *                       included — is moved aside; a
 *                       changed engineer definition is put back: `TEST_GUARD_RESTORED: …` through
 *                       `additionalContext`, the channel Claude reads on those events.
 *   Stop (run as SubagentStop for a subagent)
 *                       the same check, as a backstop; a report goes back as a reason to continue
 *                       once, and one that cannot be delivered (a stop already continuing) waits in
 *                       the run directory for the next hook that can.
 *
 * Nothing here ever sets `continue: false`: no answer ends the session. The run directory the binding
 * names is the authority; with no binding, an engineer clone under the hub is found by its marker, a
 * cache. This is early feedback, not a boundary: a shell command can change and run a test before
 * the check after it. What is accepted is decided by the finalizer and acceptance.
 */

import { readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONTINUING } from './test-guard/common.mjs';
import { postCheck, preCheck } from './test-guard/inagent.mjs';
import { queueNotice, takeNotices } from './test-guard/state.mjs';
import { subagentEvent } from './test-guard/subagent.mjs';

const PHASE = { PreToolUse: 'pre', PostToolUse: 'post', PostToolUseFailure: 'post', Stop: 'stop', SubagentStop: 'stop' };

/** A Claude Code hook payload as the guard reads it. */
function parse(p) {
  const input = p.tool_input || {};
  return {
    phase: PHASE[p.hook_event_name] || 'none', event: p.hook_event_name, callId: p.tool_use_id || null, session: p.session_id || null,
    cwd: p.cwd || null, paths: ['file_path', 'notebook_path'].map((k) => input[k]).filter((v) => typeof v === 'string' && v),
    stopActive: !!p.stop_hook_active, agentId: p.agent_id || null, command: p.tool_name === 'Bash' ? String(input.command || '') : undefined,
    content: p.tool_name === 'Write' && typeof input.content === 'string' ? input.content : undefined,
  };
}

const json = (value) => ({ stdout: `${JSON.stringify(value)}\n`, exit: 0 });
const silent = { stdout: '', exit: 0 };

/** The guard's decision in Claude Code's own form. */
function render(ev, res) {
  if (ev.phase === 'pre') return res.decision === 'deny' ? json({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: res.message } }) : silent;
  if (!res.message) return silent;
  if (ev.phase === 'post') return json({ hookSpecificOutput: { hookEventName: ev.event, additionalContext: res.message } });
  if (ev.phase === 'stop' && !ev.stopActive) return json({ decision: 'block', reason: res.message });
  return silent;
}

/**
 * The guard's decision for one bound event:
 *   { phase: pre | post | stop, state, cwd, paths, command, content, callId, session, agent, canDeliver, roots, confine }
 * Never throws. A report Claude Code cannot deliver now (`canDeliver: false`) waits in the run
 * directory and goes out with the next hook that can.
 */
export function guardEvent(event) {
  try {
    let res = event.phase === 'pre' ? preCheck(event) : event.phase === 'post' || event.phase === 'stop' ? postCheck(event) : { decision: 'allow' };
    if (event.state && (event.phase === 'post' || event.phase === 'stop')) {
      const dir = resolve(event.state);
      if (event.canDeliver === false) {
        if (res.message) { queueNotice(dir, res.message); res = { decision: 'queued', held: res.message }; }
      } else {
        const pending = takeNotices(dir);
        if (pending.length) res = { decision: res.decision === 'ok' ? 'restored' : res.decision, message: [...pending, res.message].filter(Boolean).join('\n\n') };
      }
    }
    return res;
  } catch (err) {
    const why = err && err.message ? err.message : String(err);
    if (event.phase === 'pre') return { decision: 'deny', message: `TEST_GUARD_BLOCKED: the protected-test guard could not check this write (${why}), so it is refused. ${CONTINUING} Tell the orchestrator.` };
    return { decision: 'error', message: `TEST_GUARD_ERROR: the protected-test guard could not check the engineer clone (${why}). ${CONTINUING} Tell the orchestrator.` };
  }
}

/** The parsed event, the decision and Claude Code's rendered answer for one payload, without exiting. */
function answer(payload) {
  const ev = parse(payload || {});
  if (ev.phase === 'none') return { event: ev, result: { decision: 'allow' }, out: silent };
  const hub = process.env.CLAUDE_PROJECT_DIR || ev.cwd;
  let s;
  try { s = subagentEvent(ev, hub); } catch (err) {
    s = { result: ev.phase === 'pre' ? { decision: 'deny', message: `TEST_GUARD_BLOCKED: the protected-test guard could not check this call (${err.message}), so it is refused. ${CONTINUING} Tell the orchestrator.` } : { decision: 'error', message: `TEST_GUARD_ERROR: ${err.message}. ${CONTINUING} Tell the orchestrator.` } };
  }
  if (s.result) return { event: ev, result: s.result, out: render(ev, s.result) };
  const event = { ...s.event, canDeliver: !(ev.phase === 'stop' && ev.stopActive) };
  let result = guardEvent(event);
  if (s.prefix) result = { decision: result.decision === 'ok' ? 'error' : result.decision, message: [s.prefix, result.message].filter(Boolean).join('\n\n') };
  return { event, result, out: render(ev, result) };
}

const invoked = (() => { try { return realpathSync(process.argv[1] || '') === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })();
if (invoked) {
  let payload;
  try { payload = JSON.parse(readFileSync(0, 'utf8') || '{}'); } catch { process.exit(0); }
  const { out } = answer(payload);
  if (out.stdout) process.stdout.write(out.stdout);
  process.exit(out.exit);
}

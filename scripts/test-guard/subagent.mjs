/**
 * subagent.mjs — Claude Code's engineer as a native subagent of the orchestrator's own session, and
 * its binding to one run.
 *
 * Claude Code scopes hooks to one subagent through the hooks block in that subagent's definition,
 * so the guard's hooks live in the hub's engineer definition (.claude/agents/engineer.md). Claude
 * Code runs them only while an engineer is active, and gives every call the engineer's `agent_id`,
 * the parent session's `session_id` and the hub as its working directory. A subagent never loads the
 * clone's settings, and its shell keeps no directory between commands, so the binding to a run and a
 * clone is explicit. One engineer per run:
 *
 *   dispatch  `test-guard.mjs dispatch` records a binding in the run state — the session, the
 *             engineer clone, a nonce, and the engineers of this session's earlier runs, which are
 *             retired — and points the hub's entry for that session at the run.
 *   claim     the first hook call from an engineer working in the clone claims the binding with its
 *             agent_id: one append-only event in the run's log, taken under the run's lock. It is
 *             the proof that Claude Code ran the hooks for this run; the preflight's handshake is not.
 *   check     every later call must come from that agent. Any other is refused and recorded. A
 *             retired engineer is refused before or after the claim and can never claim, so its
 *             refusals hold nothing up; any other refusal means two engineers contended for the
 *             run, and the finalizer accepts nothing more from it.
 *
 * Without an entry for the session (the same engineer writing a design in /dev-spec) the hooks
 * stand aside, except in an engineer clone the guard watches. Claude Code silently skips a project
 * agent's hooks until the hub folder is trusted, so no hook is assumed to have run: the finalizer
 * accepts nothing without the claim (bindingProblems).
 */

import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { CONTINUING, NEXT_STEP, RUN_PREFIX, isHandshake, plural } from './common.mjs';
import { gitTry } from './git.mjs';
import { cloneRootOf, loadState, readEvents, recordEvents, withLock } from './state.mjs';
import { openTrusted, startsInClone } from './inagent.mjs';

export const AGENT_TYPE = 'engineer';
export const AGENT_FILE = '.claude/agents/engineer.md';
export const HOOK_COMMAND = 'node "$CLAUDE_PROJECT_DIR/scripts/test-guard-hook.mjs"';
export const HOOK_EVENTS = ['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Stop'];
const TOOLS = 'Write|Edit|MultiEdit|NotebookEdit|Bash';

/**
 * The hooks block the engineer definition carries, exactly; the preflight refuses any other. YAML
 * flow style, one line per event, so the charter stays within its line cap.
 */
export function hookBlock() {
  const hook = `{ type: command, command: '${HOOK_COMMAND}', timeout: 60 }`;
  return `${['hooks:', ...HOOK_EVENTS.map((e) => `  ${e}: [{ ${e === 'Stop' ? '' : `matcher: "${TOOLS}", `}hooks: [${hook}] }]`)].join('\n')}\n`;
}

const frontmatter = (text) => {
  const m = String(text).replace(/\r\n/g, '\n').match(/^---\n([\s\S]*?\n)---(?:\n|$)/);
  return m ? m[1] : null;
};
export const hasHookBlock = (text) => { const fm = frontmatter(text); return !!fm && fm.includes(hookBlock()); };

/** Why the hub's engineer definition cannot carry the guard's hooks; empty when it can. */
export function agentProblems(hub) {
  const file = join(hub, AGENT_FILE);
  let text;
  try { text = readFileSync(file, 'utf8'); } catch (err) { return [`${file} ${err.code === 'ENOENT' ? 'does not exist' : `cannot be read (${err.code || err.message})`}: the engineer subagent is defined there, with the guard's hooks — install it from the library (generation reference row 8)`]; }
  const fm = frontmatter(text);
  if (!fm) return [`${file} has no frontmatter, so Claude Code reads no name and no hooks from it`];
  const problems = [];
  if (!/^name:\s*engineer\s*$/m.test(fm)) problems.push(`${file} does not name itself "engineer", the subagent type the orchestrator dispatches`);
  if (!fm.includes(hookBlock())) problems.push(`${file} does not carry the guard's hooks block exactly as the library writes it, so the engineer would run unguarded — put this block in its frontmatter, unchanged:\n${hookBlock()}`);
  return problems;
}

/* ------------------------------------------------------------ the hub's entries */

/**
 * Where the hub records which run an engineer of one session is bound to: inside its git directory,
 * never in its tree. The common git directory, which every worktree of the hub shares: a dispatch
 * from .worktrees/<KEY>/hub and a hook that reads the hub from CLAUDE_PROJECT_DIR find one entry.
 */
function entryPath(hub, session) {
  const r = gitTry(hub, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (r.status !== 0) return null;
  return join(r.stdout.trim(), 'harness-test-guard', `engineer-${String(session).replace(/[^A-Za-z0-9._-]/g, '_')}.json`);
}

/** { missing } | { file, error } | { file, entry }. */
export function readEntry(hub, session) {
  const file = hub && session ? entryPath(hub, session) : null;
  if (!file) return { missing: true };
  try { return { file, entry: JSON.parse(readFileSync(file, 'utf8')) }; } catch (err) { return err.code === 'ENOENT' ? { missing: true, file } : { file, error: err.message }; }
}

export function writeEntry(hub, session, entry) {
  const file = entryPath(hub, session);
  if (!file) throw new Error(`${hub} is not a git checkout, so it has nowhere to record the engineer's binding`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ schema: 'harness-test-guard-binding/2', ...entry })}\n`);
  return file;
}

export function removeEntry(hub, session) {
  const r = readEntry(hub, session);
  if (r.file) rmSync(r.file, { force: true });
}

/**
 * At cleanup: the session's entry stops naming this run, and keeps its engineer as retired, so a
 * fresh run in the same session refuses it from its first call. An entry naming another run is left.
 */
export function retireEntry(hub, session, runId, agent) {
  const r = readEntry(hub, session);
  if (!r.entry || r.entry.run_id !== runId) return;
  const retired = [...new Set([...(r.entry.retired || []), ...(agent ? [agent] : [])])];
  writeEntry(hub, session, { state: null, run_id: null, nonce: null, retired });
}

/* ------------------------------------------------------------------- the binding */

/** The engineer that claimed binding `b`, or null. */
export const boundAgent = (events, b) => {
  const e = b && events.find((x) => x.phase === 'bind' && x.nonce === b.nonce);
  return e ? e.agent : null;
};

/** Whether a call works in the bound clone: a path inside it, or a command that starts there. */
function worksInClone(ev, run) {
  if (typeof ev.command === 'string') return startsInClone(ev.command, [run.lexical, run.root]);
  return (ev.paths || []).some((p) => { const abs = resolve(ev.cwd || run.root, String(p)); return [run.lexical, run.root].some((c) => abs === c || abs.startsWith(`${c}/`)); });
}

/**
 * Claims binding `b` for the calling agent under the run's lock — the lock dispatch decides under —
 * re-reading the binding there, so a claim never lands on a binding a dispatch has since replaced.
 * True when the agent holds it afterwards.
 */
function claim(run, b, ev) {
  return withLock(run.dir, () => {
    let now;
    try { now = loadState(run.dir).state.binding; } catch { return false; }
    if (!now || now.nonce !== b.nonce || (now.retired || []).includes(ev.agentId)) return false;
    const owner = boundAgent(readEvents(run.dir), now);
    if (owner) return owner === ev.agentId;
    recordEvents(run.dir, [{ phase: 'bind', agent: ev.agentId, nonce: now.nonce, session: ev.session, key: `bind:${now.nonce}` }]);
    return true;
  });
}

/** Whether two paths name one folder, symbolic links resolved. */
function sameFolder(a, b) {
  const real = (p) => { try { return realpathSync.native(p); } catch { return resolve(p); } };
  return !!a && !!b && real(a) === real(b);
}

/**
 * What one engineer hook call is under its session's entry: { mode, run?, binding?, why? } with
 * mode unbound | broken | handshake | stale | retired | foreign | claim | bound.
 */
function resolveBinding(ev, hub) {
  const r = readEntry(hub, ev.session);
  if (r.missing) return { mode: 'unbound', file: r.file || null };
  if (r.error) return { mode: 'broken', why: `the hub's binding ${r.file} cannot be read (${r.error})` };
  const p = r.entry;
  if (p && p.state === null) return { mode: 'unbound', file: r.file, retiredEntry: true };
  if (!p || typeof p.state !== 'string' || !basename(p.state).startsWith(RUN_PREFIX)) return { mode: 'broken', why: `${r.file} does not name a guard run` };
  let run;
  try { run = openTrusted(p.state); } catch (err) { return { mode: 'broken', why: `the run ${p.state} the hub's binding names cannot be read (${err.message})` }; }
  if (isHandshake(ev.session)) return p.handshake === ev.session ? { mode: 'handshake', run } : { mode: 'stale', run, why: 'a preflight binding that is not this one' };
  const b = run.state.binding;
  if (!b || p.run_id !== run.state.run_id || p.nonce !== b.nonce) return { mode: 'stale', run, why: 'the hub\'s entry does not name the run\'s current dispatch' };
  if (b.session !== ev.session) return { mode: 'stale', run, why: 'the binding belongs to another session' };
  if (!sameFolder(b.hub, hub)) return { mode: 'stale', run, why: `the preflight proved the engineer definition in ${b.hub}, but Claude Code runs this session's engineer and its hooks from ${hub}. Run preflight --state ${run.dir} --hub ${hub}, then dispatch again` };
  if (run.state.accepted) return { mode: 'stale', run, why: `round ${run.state.accepted.round} was already accepted, so the run takes no more engineer work` };
  if ((b.retired || []).includes(ev.agentId)) return { mode: 'retired', run, binding: b, why: `agent ${ev.agentId} is the engineer of an earlier run in this session, and a fresh run never takes its work` };
  const owner = boundAgent(readEvents(run.dir), b);
  if (owner) return owner === ev.agentId ? { mode: 'bound', run, binding: b } : { mode: 'foreign', run, binding: b, why: `agent ${ev.agentId || 'unknown'} is not the engineer bound to this run (${owner})` };
  return { mode: 'claim', run, binding: b };
}

/**
 * What the hook looked up for an unbound call. The orchestrator compares it with what dispatch
 * printed: another session id or another entry file is the cause, and needs no guess.
 */
function unboundFacts(ev, hub, r) {
  const where = !r.file ? `${hub} is not a git checkout, so the hook has no entry file to read` : r.retiredEntry ? `the entry ${r.file} names no run, because its run was cleaned up` : `the hook found no entry file ${r.file}`;
  return `The hook got session ${ev.session || 'none'} and the hub ${hub}${process.env.CLAUDE_PROJECT_DIR ? ' (from CLAUDE_PROJECT_DIR)' : ' (from the call\'s folder, because CLAUDE_PROJECT_DIR is not set)'}, and ${where}.`;
}

const refused = (why, mode) => `TEST_GUARD_BLOCKED: this engineer's guard binding is ${mode === 'stale' ? 'stale' : mode === 'broken' ? 'unreadable' : 'not its own'}: ${why}. No change is accepted from it. ${CONTINUING} Stop and tell the orchestrator.`;

/**
 * Turns one engineer hook call into the guard's event, bound to its run and confined to its clone;
 * or into a decision of its own when the call has no valid binding. Returns { event, prefix? } or
 * { result }. Never throws.
 */
export function subagentEvent(ev, hub) {
  const base = { ...ev, agent: ev.agentId || null };
  let r;
  try { r = resolveBinding(ev, hub); } catch (err) { r = { mode: 'broken', why: err.message }; }
  if (r.mode === 'unbound') {
    if (ev.phase !== 'pre') return { event: { ...base, state: null, roots: [hub] } };
    const target = typeof ev.command === 'string'
      ? (ev.command.match(/^\s*cd\s+(?:"([^"]+)"|'([^']+)'|(\S+))/) || []).slice(1).find(Boolean)
      : (ev.paths || [])[0];
    const watched = target && cloneRootOf(resolve(ev.cwd || hub, String(target)));
    return { result: watched
      ? { decision: 'deny', message: `TEST_GUARD_BLOCKED: ${watched} is an engineer clone the protected-test guard watches, and this engineer was not dispatched to it: this session has no binding. ${unboundFacts(ev, hub, r)} ${CONTINUING} Stop and tell the orchestrator, which binds the engineer with test-guard.mjs dispatch before the Agent call.` }
      : { decision: 'allow' } };
  }
  if (r.mode === 'broken') {
    return { result: ev.phase === 'pre' ? { decision: 'deny', message: refused(r.why, 'broken') } : { decision: 'error', message: `TEST_GUARD_ERROR: ${r.why}. ${CONTINUING} Tell the orchestrator.` } };
  }
  let mode = r.mode;
  if (mode === 'claim' && worksInClone(ev, r.run) && !claim(r.run, r.binding, ev)) mode = 'foreign';
  if (mode === 'stale' || mode === 'retired' || mode === 'foreign') {
    const why = r.why || 'another engineer claimed this run first';
    const nonce = (r.run.state.binding || {}).nonce || '';
    recordEvents(r.run.dir, [{ phase: 'binding', kind: 'rejected', reason: mode, why, agent: ev.agentId || null, call: ev.callId || null, key: ev.callId ? `rejected:${nonce}:${ev.callId}:${ev.event}` : undefined }]);
    if (ev.phase === 'pre') return { result: { decision: 'deny', message: refused(why, mode) } };
    return { event: { ...base, state: r.run.dir }, prefix: refused(why, mode) };
  }
  return { event: { ...base, state: r.run.dir, confine: true } };
}

/* -------------------------------------------------------------- acceptance */

/**
 * Why the run's engineer binding does not hold for the finalizer: never dispatched, the hub's entry
 * changed, never claimed (the hooks did not run), or calls from another engineer, not a retired
 * one, since the dispatch. Empty when it holds.
 */
export function bindingProblems(dir, state) {
  const b = state.binding;
  if (!b) return ['the engineer was never dispatched through test-guard.mjs dispatch, so no hook is bound to this run'];
  const problems = [];
  if (!state.engineer || resolve(b.clone) !== resolve(state.engineer.path)) problems.push('the binding names another engineer clone');
  const entry = readEntry(b.hub, b.session).entry;
  if (!entry || entry.run_id !== state.run_id || entry.nonce !== b.nonce) problems.push(`the hub's entry for session ${b.session} no longer names this run's dispatch`);
  const events = readEvents(dir);
  if (!boundAgent(events, b)) problems.push(`no guard hook from an engineer reached the run since it was dispatched at ${b.dispatched_at}: its hooks did not run — the hub folder not trusted by Claude Code, the engineer definition without the guard's hooks, or an engineer started without dispatch`);
  const rejected = events.filter((e) => e.phase === 'binding' && e.kind === 'rejected' && e.reason !== 'retired' && e.at >= b.dispatched_at);
  if (rejected.length) problems.push(`${plural(rejected.length, 'tool call')} from ${[...new Set(rejected.map((e) => e.agent || 'an unknown agent'))].join(', ')}, not this run's engineer, reached the run: stop that agent, keep this clone for inspection (cleanup --keep-engineer) and start a fresh run`);
  return problems;
}

/** The text the engineer starts with: its binding, its clone, and the rules it works under. */
export function dispatchPrompt(state, b) {
  return [
    `You are the engineer for ${state.key}, bound to protected-test guard run ${state.run_id}, on the approved tests at ${String(state.baseline.sha).slice(0, 12)}.`,
    `Work only in your engineer clone: ${b.clone}`,
    `- Begin every Bash command with: cd "${b.clone}" && — your shell keeps no directory between commands, and a command that does not start there is refused.`,
    `- Write and Edit only paths under ${b.clone}.`,
    `- Commit with: cd "${b.clone}" && node "${join(b.hub, 'scripts', 'harness-commit.mjs')}" --repo . -m "<message>". The finalizer builds the candidate from your committed HEAD; uncommitted work is not part of it.`,
    `- Tests, fixtures, snapshots, helpers and runner configuration — ${state.guard.patterns.join(', ')} — you may read, and never create, change, delete or rename. ${NEXT_STEP}`,
    '- A test you believe is wrong, or one you find missing, is a test-change request: stop, and send the orchestrator the test, the design text it conflicts with by section and line, and the check output.',
    '- A TEST_GUARD_BLOCKED or TEST_GUARD_RESTORED message is feedback, not an end: read it and carry on the way it names.',
  ].join('\n');
}

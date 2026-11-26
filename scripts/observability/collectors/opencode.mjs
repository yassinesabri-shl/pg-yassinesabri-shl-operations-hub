// Part of the harness asset library c6f3b4427d58f7c3 (see VERSION.json) · 2026-10-26
/**
 * opencode.mjs — the collector adapter for OpenCode, written for v1.19.4.
 *
 * OpenCode keeps its sessions in its own database, not in a log file, so this adapter reads no
 * file. The plugin (accelerator/plugins/opencode/harness-observability.js) lists a session's
 * messages through OpenCode's own client and passes this adapter one entry for each `step-finish`
 * part: the part's id, a time, the model, the provider and the counts. Each idle session passes
 * every call again, and the checkpoint keeps every call from counting twice.
 *
 * The rules:
 *   - our input is OpenCode's `tokens.input`, which already leaves the cache reads and writes out;
 *   - OpenCode's `tokens.output` leaves reasoning out, so our output is output plus reasoning, and
 *     reasoning is kept as reasoning;
 *   - a child session is a seat, named by its title, and its run is its root session's.
 *
 * The plugin skips the messages that a fork copied, and passes no text. No live run has confirmed
 * this adapter yet.
 *
 * The time reader, `readTime`, is untested too. It is built from OpenCode v1.19.4's source, where
 * each model step is one assistant message, and its tool calls run inside that message's span:
 *   - a user message opens a turn of the root session, and a new run of a child session;
 *   - an assistant message's span, less the tool calls inside it, is model time;
 *   - a tool call's span is tool time, and OpenCode's question tool is a question;
 *   - a permission wait runs from `permission.asked` to `permission.replied`, as the plugin saw them;
 *   - a root session's turn ends at its last assistant message, because the session went idle.
 * The plugin passes every message again at each idle, so the offset is the latest time read.
 *
 * The same read gives the harness's failures (failures.mjs), untested too:
 *   - a `bash` call that names one harness script and exited 2, 3 or 4, or whose output has the
 *     script's own line `HARNESS EXIT: <script> <n>`. OpenCode completes the tool on a non-zero
 *     exit, with the code in `metadata.exit`. The plugin passes that code, the codes the output
 *     states, the token of its last `REASON:` line and the command line, and this adapter keeps
 *     only the script's name, the codes and a token on the list;
 *   - an assistant message whose `error` names its type, such as `APIError`. The plugin leaves out
 *     `MessageAbortedError`, which a person's abort gives.
 *
 * Node standard library only.
 */
import { OTHER_AGENT, RUNTIME_AGENT, cleanCounts, nowMs } from '../common.mjs';
import { SCRIPT_REASONS, cleanStated, scriptOf } from '../failures.mjs';
import { ASK_TOOL, minus } from '../time.mjs';

export const RUNTIME = 'opencode';
export const COLLECTOR = 'opencode/1';
/** The time reader and its version. Every work-time record of this adapter carries it. */
export const TIME_COLLECTOR = 'opencode-time/1';
/** The failure reader and its version. Every failure record of this adapter carries it. */
export const FAILURE_COLLECTOR = 'opencode-failures/1';
/** The plugin passes a child session at its own idle only, so that read finishes the seat's open piece. */
export const SEATS_READ_ONCE = true;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;
const SEAT_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const VERSION = /^[0-9A-Za-z][0-9A-Za-z._+-]{0,39}$/;
/** How far the plugin's time for a command may stand from the hook's clock before the hook uses its own. */
const CLOCK_SLACK_MS = 10 * 60 * 1000;

const text = (v) => (typeof v === 'string' ? v : null);
const idOf = (v) => (typeof v === 'string' && v.search(ID) === 0 ? v : null);
/** A provider name as the record allows it: lower case, letters, digits and dashes. */
const providerName = (v) => (typeof v === 'string' && v ? v.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 64) : null);

/** Our five counts from the tokens of one OpenCode step. */
export function mapTokens(t) {
  const n = (v) => (Number.isFinite(v) && v >= 0 ? v : 0);
  const reasoning = n(t?.reasoning);
  return cleanCounts({
    input: n(t?.input),
    cache_read: n(t?.cache?.read),
    cache_write: n(t?.cache?.write),
    cache_write_5m: null,
    cache_write_1h: null,
    output: n(t?.output) + reasoning,
    reasoning,
  });
}

/** The calls that the plugin passed for one session. There is no file, so the offset never moves. */
export function read(log, checkpoint) {
  const calls = [];
  for (const c of Array.isArray(log.calls) ? log.calls : []) {
    if (!c || !idOf(c.id) || !Number.isFinite(c.ms) || !c.tokens || typeof c.tokens !== 'object') continue;
    calls.push({ id: c.id, ms: c.ms, model: text(c.model) || '', provider: providerName(c.provider) || 'unknown', counts: mapTokens(c.tokens), speed: null });
  }
  return { calls, offset: checkpoint.offset || 0, runtimeVersion: log.version };
}

const at0 = (v) => Number.isFinite(v) && v >= 0;
/** At one moment, a run's start comes first and a turn's end last. */
const RANK = { prompt: 0, resume: 0, request: 1, answer: 2, result: 3, person: 4, 'runtime-error': 5, 'turn-end': 6 };

/**
 * One tool call's start and end. A shell call names the harness script it runs, and its result its
 * exit code, the exit codes its output states by script, and the token of its REASON line, which
 * the plugin found in the output. A token that is not on the list is dropped.
 */
function toolEvents(t) {
  const script = scriptOf(t.command);
  const exits = script && Number.isInteger(t.exit) ? { [t.id]: t.exit } : {};
  const said = script ? cleanStated(t.stated) : {};
  const stated = Object.keys(said).length ? { [t.id]: said } : {};
  const reasons = script && SCRIPT_REASONS.includes(t.reason) ? { [t.id]: t.reason } : {};
  return [
    { at: t.start, kind: 'answer', ref: null, tools: [{ id: t.id, name: t.name === 'question' ? ASK_TOOL : 'other', ...(script ? { script } : {}) }] },
    { at: t.end, kind: 'result', ids: [t.id], byPerson: false, exits, stated, reasons },
  ];
}

/** One assistant message's events: each tool call's start and end, the model time around them, and its error. */
function stepEvents(m) {
  const tools = (Array.isArray(m.tools) ? m.tools : []).filter((t) => idOf(t?.id) && at0(t.start) && at0(t.end) && t.end >= t.start);
  const events = tools.flatMap(toolEvents);
  minus([[m.created, m.completed]], tools.map((t) => [t.start, t.end])).forEach(([a, b], k) => {
    events.push({ at: a, kind: 'request', id: `${m.id}:${k}` }, { at: b, kind: 'answer', ref: `${m.id}:${k}`, tools: [] });
  });
  if (typeof m.error === 'string') events.push({ at: m.completed, kind: 'runtime-error', error: m.error });
  return events;
}

/** A root session's turns end at the last assistant message before the next user message: the session went idle. */
function turnEnds(users, steps) {
  const ends = [];
  users.forEach((u, i) => {
    const next = i + 1 < users.length ? users[i + 1].created : Infinity;
    const done = steps.filter((m) => m.created >= u.created && m.created < next).map((m) => m.completed);
    if (done.length) ends.push({ at: Math.max(...done), kind: 'turn-end' });
  });
  return ends;
}

/**
 * The time reader, as collect.mjs calls it: the events of every message time and every permission
 * wait that the plugin passed for one session, after `offset`, the latest time read before.
 */
export function readTime(log, offset, { main }) {
  const times = Array.isArray(log.times) ? log.times : [];
  const users = times.filter((t) => t?.role === 'user' && at0(t.created)).sort((a, b) => a.created - b.created);
  const steps = times.filter((t) => t?.role === 'assistant' && idOf(t.id) && at0(t.created) && at0(t.completed) && t.completed >= t.created);
  const events = [
    ...users.map((u) => (main ? { at: u.created, kind: 'prompt', by: 'human' } : { at: u.created, kind: 'resume' })),
    ...steps.flatMap(stepEvents),
    ...(Array.isArray(log.waits) ? log.waits : []).filter((w) => at0(w?.start) && at0(w?.end) && w.end > w.start)
      .map((w) => ({ at: w.start, kind: 'person', gate: 'permission-prompt', end: w.end })),
    ...(main ? turnEnds(users, steps) : []),
  ].sort((a, b) => a.at - b.at || RANK[a.kind] - RANK[b.kind]);
  const from = Number.isFinite(offset) ? offset : 0;
  const latest = events.reduce((m, e) => Math.max(m, e.at), from);
  return { events: events.filter((e) => e.at > from), offset: latest, runtimeVersion: log.version };
}

/** The plugin's time for a command, when it stands near the hook's own clock. */
function timeOf(v) {
  const now = nowMs();
  return Number.isFinite(v) && Math.abs(v - now) <= CLOCK_SLACK_MS ? v : null;
}

/** A plugin message in the runtime-neutral form the hook works with. */
export function normalise(event) {
  const session = idOf(event?.session_id);
  const none = { kind: 'other', session, cwd: null, prompt: null, command: null, main: null, seat: null };
  if (!session) return none;
  const cwd = text(event.cwd);
  if (event.hook_event_name === 'command') {
    if (!text(event.name)) return none;
    return { ...none, kind: 'prompt', cwd, at: timeOf(event.at), prompt: `/${event.name} ${text(event.arguments) || ''}`.trim() };
  }
  // The plugin passes a shell call's command line only when it names a harness script. The hook keeps only the key.
  if (event.hook_event_name === 'tool') {
    const command = text(event.command);
    return command === null ? none : { ...none, kind: 'tool', cwd, at: timeOf(event.at), command };
  }
  if (event.hook_event_name !== 'idle') return none;
  const logRef = idOf(event.log_ref);
  if (!logRef || !Array.isArray(event.calls)) return none;
  const version = typeof event.version === 'string' && event.version.search(VERSION) === 0 ? event.version : null;
  const log = { logRef, calls: event.calls, version, times: event.times, waits: event.waits };
  if (event.parent) return { ...none, kind: 'seat', cwd, seat: { ...log, name: event.seat } };
  return { ...none, kind: 'turn', cwd, main: log };
}

/**
 * A command that does not start. The plugin reads this from the hook's output at
 * `command.execute.before` and throws the reason, which stops the command before its prompt. No live
 * run has confirmed it.
 */
export const refusePrompt = (reason) => JSON.stringify({ decision: 'block', reason });

/** The plugin passes a session's calls whole at every idle, so there is no seat log to read again. */
export const seatLogs = () => [];

/** A seat is the harness's when the hub's agent registry lists it. */
export function isHarnessSeat(ctx, name) {
  return typeof name === 'string' && name.search(SEAT_NAME) === 0 && ctx.seats.has(name);
}

/**
 * The subagents that OpenCode itself ships (packages/opencode/src/agent/agent.ts). Their records
 * carry `runtime-agent`.
 */
const OWN_AGENTS = new Set(['general', 'explore']);

/**
 * The name a child session's records carry: a seat's own, runtime-agent for an agent that OpenCode
 * ships, or other-agent.
 */
export function agentName(ctx, name) {
  if (isHarnessSeat(ctx, name)) return name;
  return OWN_AGENTS.has(name) ? RUNTIME_AGENT : OTHER_AGENT;
}

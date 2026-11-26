// Part of the harness asset library c6f3b4427d58f7c3 (see VERSION.json) · 2026-10-26
/**
 * codex.mjs — the collector adapter for Codex.
 *
 * UNTESTED. It is built from Codex's source (openai/codex at commit 970111f, release
 * rust-v0.164.0), and no live run has confirmed it.
 *
 * Codex keeps one rollout file for each thread: the root thread's at the hook's
 * `transcript_path`, and each sub-agent's at `agent_transcript_path`. A rollout line is
 * `{ timestamp, type, payload }`. This adapter reads three types and parses no other line:
 *   - `session_meta`: the file's own thread id, the CLI version and the model provider;
 *   - `turn_context`: the model of the turns that follow;
 *   - `token_usage_record`: one completed response, by `response_id`, with its usage.
 * It never reads Codex's running totals, because a context overflow resets them.
 *
 * The rules:
 *   - a `token_usage_record` of another thread is a fork's copy, and is skipped;
 *   - our input is `input_tokens` minus `cached_input_tokens` minus `cache_write_input_tokens`,
 *     because Codex's input includes both;
 *   - `output_tokens` includes reasoning, and `reasoning_output_tokens` is kept as reasoning.
 * A remote compaction writes its own `token_usage_record`, so it counts here, although Codex leaves
 * it out of the total that `/status` shows.
 *
 * The time reader, `readTime`, is UNTESTED too, and built from the same source. Codex keeps these
 * lines in every rollout, and the reader takes their times, their ids and one tool name:
 *   - `event_msg` `turn_started` opens a turn, and `turn_complete` or `turn_aborted` ends it. In a
 *     sub-agent's rollout, each turn is one activation of the seat. A turn whose `turn_attribution`
 *     names an initiating agent is that agent's, never a person's.
 *   - `response_item` `function_call`, `custom_tool_call` and `local_shell_call` open a tool call,
 *     and the output with the same `call_id` ends it. `request_user_input` is a question.
 *   - `token_usage_record` ends one response. Codex writes no line when a request starts, so a
 *     response starts at the turn's start, the last tool output or the last response before it.
 * Codex keeps no approval request in the rollout, so no permission wait comes from it.
 *
 * The same read gives the harness's failures (failures.mjs), UNTESTED too, from Codex's source at
 * the same commit:
 *   - an `exec_command` call whose `cmd` names one harness script, and whose output's header has
 *     the line `Process exited with code <n>`, or whose output has the script's own line
 *     `HARNESS EXIT: <script> <n>`, which holds when a pipe or `; echo` hides the code. A process that is still running when the call
 *     returns gives its exit code later, in a `write_stdin` output, and this reader misses it. The
 *     rollout keeps no `exec_command_end` event by default;
 *   - a `turn_complete` whose `error` carries `codex_error_info`, the error's type, such as
 *     `rate_limit_exceeded`. Codex writes no `error` event to the rollout.
 *
 * Node standard library only.
 */
import { OTHER_AGENT, RUNTIME_AGENT, cleanCounts } from '../common.mjs';
import { reasonInOutput, scriptOf, statedExits } from '../failures.mjs';
import { ASK_TOOL } from '../time.mjs';
import { readLines } from './lines.mjs';

export const RUNTIME = 'codex';
export const COLLECTOR = 'codex/1';
/** The time reader and its version. Every work-time record of this adapter carries it. */
export const TIME_COLLECTOR = 'codex-time/1';
/** The failure reader and its version. Every failure record of this adapter carries it. */
export const FAILURE_COLLECTOR = 'codex-failures/1';
/** The hook reads a sub-agent's rollout only at its SubagentStop, so that read finishes the seat's open piece. */
export const SEATS_READ_ONCE = true;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;
const SEAT_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** The agent roles that Codex itself ships (core/src/agent/role.rs). Their records carry `runtime-agent`. */
const OWN_AGENTS = new Set(['default', 'explorer', 'worker']);
const NEEDLES = ['"session_meta"', '"turn_context"', '"token_usage_record"'];

const text = (v) => (typeof v === 'string' ? v : null);
const idOf = (v) => (typeof v === 'string' && v.search(ID) === 0 ? v : null);
/** A provider name as the record allows it: lower case, letters, digits and dashes. */
const providerName = (v) => (typeof v === 'string' && v ? v.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 64) : null);

/** Our five counts from one Codex usage block. */
export function mapUsage(u) {
  const n = (v) => (Number.isFinite(v) && v >= 0 ? v : 0);
  const cached = n(u.cached_input_tokens);
  const written = n(u.cache_write_input_tokens);
  return cleanCounts({
    input: Math.max(0, n(u.input_tokens) - cached - written),
    cache_read: cached,
    cache_write: written,
    cache_write_5m: null,
    cache_write_1h: null,
    output: n(u.output_tokens),
    reasoning: n(u.reasoning_output_tokens),
  });
}

/** Updates the file's own facts from a session_meta or turn_context payload. */
function noteContext(type, p, st) {
  if (type === 'session_meta') {
    if (!st.thread) st.thread = idOf(p.id);
    if (text(p.cli_version)) st.version = p.cli_version;
    if (providerName(p.model_provider)) st.provider = providerName(p.model_provider);
  } else if (type === 'turn_context' && text(p.model)) {
    st.model = p.model;
  }
}

/**
 * What is new in one rollout file since the checkpoint. The file's own thread, model, provider and
 * version stay in the checkpoint, because a later read starts past the lines that name them.
 */
export function read(log, checkpoint) {
  const st = checkpoint.codex || (checkpoint.codex = { thread: null, model: null, provider: null, version: null });
  const calls = [];
  const offset = readLines(log.path, checkpoint.offset, NEEDLES, (line) => {
    let row;
    try { row = JSON.parse(line); } catch { return; }
    const p = row && row.payload;
    if (!p || typeof p !== 'object') return;
    if (row.type !== 'token_usage_record') { noteContext(row.type, p, st); return; }
    if (!idOf(p.response_id) || !p.usage || typeof p.usage !== 'object') return;
    if (st.thread && p.thread_id !== st.thread) return;
    const ms = Date.parse(row.timestamp);
    if (!Number.isFinite(ms)) return;
    calls.push({ id: p.response_id, ms, model: st.model || log.model || '', provider: st.provider || 'openai', counts: mapUsage(p.usage), speed: null });
  });
  return { calls, offset, runtimeVersion: st.version };
}

/** The rollout lines that hold a time event, and the line that names the file's own thread. */
const TIME_NEEDLES = ['"turn_started"', '"turn_complete"', '"turn_aborted"', '"function_call', '"custom_tool_call', '"local_shell_call"', '"token_usage_record"', '"session_meta"'];
/** Codex's question tool, which waits for the person's answer. Its async form does not wait. */
const QUESTION_TOOL = 'request_user_input';
const TOOL_CALLS = new Set(['function_call', 'custom_tool_call', 'local_shell_call']);
const TOOL_OUTPUTS = new Set(['function_call_output', 'custom_tool_call_output']);

/** A turn's start: a person's prompt in the root thread, or an agent's. In a sub-agent's rollout, a new activation. */
function turnStart(p, main) {
  if (!main) return { kind: 'resume' };
  return { kind: 'prompt', by: p.turn_attribution?.initiating_agent_path ? 'peer' : 'human' };
}

/** Codex's shell tool. Its arguments are a JSON string whose `cmd` is the command line. */
const SHELL_TOOL = 'exec_command';
/** The header line of a shell call's output when its process ended inside the call. */
const EXIT_LINE = /(?:^|\n)Process exited with code (\d{1,3})(?:\n|$)/;

/** The harness script that a shell call runs, from its arguments, or null. */
function scriptOfCall(p) {
  if (p.type !== 'function_call' || p.name !== SHELL_TOOL || typeof p.arguments !== 'string') return null;
  try { return scriptOf(JSON.parse(p.arguments)?.cmd); } catch { return null; }
}

/**
 * A tool output's result event: the exit code of a process that ended, the exit codes the output
 * states by script, and the token of its REASON line.
 */
function resultOf(p) {
  const out = { kind: 'result', ids: [p.call_id], byPerson: false, exits: {}, stated: {}, reasons: {} };
  const text = typeof p.output === 'string' ? p.output : '';
  const m = text.match(EXIT_LINE);
  if (m) out.exits[p.call_id] = Number(m[1]);
  const said = statedExits(text);
  if (Object.keys(said).length) out.stated[p.call_id] = said;
  const reason = m || out.stated[p.call_id] ? reasonInOutput(text) : null;
  if (reason) out.reasons[p.call_id] = reason;
  return out;
}

/** The type of the error that failed a turn: `codex_error_info`, a string or an object with one key. */
function errorTypeOf(error) {
  const info = error?.codex_error_info;
  if (typeof info === 'string') return info;
  const keys = info && typeof info === 'object' ? Object.keys(info) : [];
  return keys.length === 1 ? keys[0] : null;
}

/** The events of one event_msg or response_item line, or an empty list. */
function itemEvents(row, p, main) {
  if (row.type === 'event_msg' && p.type === 'turn_started') return [turnStart(p, main)];
  if (row.type === 'event_msg' && p.type === 'turn_complete' && p.error) return [{ kind: 'runtime-error', error: errorTypeOf(p.error) }, { kind: 'turn-end' }];
  if (row.type === 'event_msg' && (p.type === 'turn_complete' || p.type === 'turn_aborted')) return [{ kind: 'turn-end' }];
  if (row.type !== 'response_item' || !idOf(p.call_id)) return [];
  if (TOOL_CALLS.has(p.type)) {
    const script = scriptOfCall(p);
    return [{ kind: 'answer', ref: null, tools: [{ id: p.call_id, name: p.name === QUESTION_TOOL ? ASK_TOOL : 'other', ...(script ? { script } : {}) }] }];
  }
  return TOOL_OUTPUTS.has(p.type) ? [resultOf(p)] : [];
}

/** The events of one token_usage_record of the file's own thread: the response's start and its end. */
function responseEvents(p, at, st) {
  if (!idOf(p.response_id) || (st.thread && p.thread_id !== st.thread) || st.from === null) return [];
  return [{ at: st.from, kind: 'request', id: p.response_id }, { at, kind: 'answer', ref: p.response_id, tools: [] }];
}

/** The time events of one rollout line, in order, and the reader's state moved past it. */
function timeEventsOf(line, main, st) {
  let row;
  try { row = JSON.parse(line); } catch { return []; }
  const p = row?.payload;
  const at = Date.parse(row?.timestamp);
  if (!p || typeof p !== 'object' || !Number.isFinite(at)) return [];
  if (row.type === 'session_meta') {
    noteContext('session_meta', p, st);
    return [];
  }
  const events = row.type === 'token_usage_record' ? responseEvents(p, at, st) : itemEvents(row, p, main).map((e) => ({ at, ...e }));
  // The next response starts where this line ends a turn's step: a turn's start, a tool output or a response.
  const kinds = new Set(events.map((e) => e.kind));
  if (kinds.has('prompt') || kinds.has('resume') || kinds.has('result') || row.type === 'token_usage_record') st.from = at;
  if (kinds.has('turn-end')) st.from = null;
  return events;
}

/**
 * The time reader, as collect.mjs calls it: every time event in one rollout file after `offset`. Its
 * state keeps the file's own thread and version, and where the next response starts.
 */
export function readTime(log, offset, { main, state }) {
  const st = { thread: null, model: null, provider: null, version: null, from: null, ...state };
  const events = [];
  const next = readLines(log.path, offset, TIME_NEEDLES, (line) => events.push(...timeEventsOf(line, main, st)));
  return { events, offset: next, runtimeVersion: st.version, state: st };
}

/**
 * The prompt as a harness command line. Codex may start a harness command as a skill, as in
 * `$dev-sprint PROJ-102`: that form is read as `/dev-sprint PROJ-102`. UNTESTED, like the rest.
 */
const asCommandLine = (prompt) => (typeof prompt === 'string' && prompt.trim().startsWith('$') ? `/${prompt.trim().slice(1)}` : prompt);

const KINDS = { UserPromptSubmit: 'prompt', PreToolUse: 'tool', Stop: 'turn', SessionEnd: 'end', SubagentStop: 'seat' };

/**
 * The command line of a shell call. Codex names every shell-like tool `Bash` in a hook's input, with
 * the command in `tool_input.command`. It stays in memory: the hook keeps only the key it names.
 */
function shellCommand(event) {
  if (event.tool_name !== 'Bash') return null;
  const c = event.tool_input?.command;
  if (Array.isArray(c) && c.every((part) => typeof part === 'string')) return c.join(' ');
  return text(c);
}

/** A Codex hook event in the runtime-neutral form the hook works with. Codex's input mirrors Claude Code's. */
export function normalise(event) {
  const session = idOf(event?.session_id);
  let kind = (session && KINDS[event.hook_event_name]) || 'other';
  // A prompt that a parent thread sends to a sub-agent is the seat's input, never a run start.
  if (kind === 'prompt' && event.agent_id) kind = 'other';
  const command = kind === 'tool' ? shellCommand(event) : null;
  if (kind === 'tool' && command === null) kind = 'other';
  const mainPath = text(event?.transcript_path);
  const seatId = idOf(event?.agent_id);
  const seatPath = text(event?.agent_transcript_path);
  return {
    kind,
    session,
    cwd: text(event?.cwd),
    prompt: kind === 'prompt' ? asCommandLine(text(event.prompt)) : null,
    command,
    main: kind !== 'other' && kind !== 'tool' && mainPath ? { logRef: session, path: mainPath, model: text(event.model) } : null,
    seat: kind === 'seat' && seatId && seatPath ? { logRef: seatId, path: seatPath, name: event.agent_type, model: text(event.model) } : null,
  };
}

/**
 * Codex names a sub-agent's rollout only at its SubagentStop, so the hook knows no seat log to read
 * again. A seat's call that reaches the disk after its SubagentStop waits for that seat's next one.
 */
export const seatLogs = () => [];

/** A seat is the harness's when the hub's agent registry lists it. Codex has no charter files. */
export function isHarnessSeat(ctx, name) {
  return typeof name === 'string' && name.search(SEAT_NAME) === 0 && ctx.seats.has(name);
}

/** The name a sub-agent's records carry: a seat's own, runtime-agent for a role that Codex ships, or other-agent. */
export function agentName(ctx, name) {
  if (isHarnessSeat(ctx, name)) return name;
  return OWN_AGENTS.has(name) ? RUNTIME_AGENT : OTHER_AGENT;
}

/** A message for the person, as Codex reads it from a Stop hook's output: shown as a warning. */
export const showMessage = (text) => JSON.stringify({ systemMessage: text });

/**
 * A prompt that does not start, as Codex reads it from a UserPromptSubmit hook's output: Codex takes
 * Claude Code's form and shows the person the reason (codex-rs/hooks/src/events/user_prompt_submit.rs
 * at 6dfaca4da). No live run has confirmed it.
 */
export const refusePrompt = (reason) => JSON.stringify({ decision: 'block', reason });

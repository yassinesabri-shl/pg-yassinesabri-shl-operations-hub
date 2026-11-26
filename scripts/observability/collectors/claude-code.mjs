// Part of the harness asset library c6f3b4427d58f7c3 (see VERSION.json) · 2026-10-26
/**
 * claude-code.mjs — the collector adapter for Claude Code.
 *
 * Claude Code keeps one transcript for each agent: the main session's at the hook's
 * `transcript_path`, and each seat's at `agent_transcript_path`, under
 * `<session>/subagents/`. Every assistant entry of a transcript is an entry of one model call, with
 * `message.id`, `message.model` and `message.usage`. A call can have several entries, one for each
 * content block and each streaming snapshot: the entry with the largest total counts (delta.mjs).
 *
 * The rows this adapter skips:
 *   - a row whose model is `<synthetic>`: Claude Code makes it itself, without a model call;
 *   - in the main transcript, a row with `isSidechain: true`: it is a seat's call, which the seat's
 *     own file holds. Read from the main file as well, it would count twice.
 *
 * Only the lines that carry usage are parsed, and only ids, times, the model and the counts are
 * taken from them. The transcript format is internal to Claude Code and can change in any release.
 * Claude Code updates itself, so a hub cannot hold it at one version. A live run on Claude Code
 * 2.1.308 confirmed this adapter on 2026-10-27.
 *
 * The time reader, `readTime`, reads more lines of the same transcripts, for work time (time.mjs):
 *   - each prompt line and its `origin`: a person's prompt, a seat's report, a notice, or a resume.
 *     A print-mode prompt (`claude -p`) carries no `origin`, and its `turnOrigin` is `sdk`;
 *   - each model call's request line, and each answer line's call id and tool calls;
 *   - each tool result, and the source of its permission decision;
 *   - each turn's end line, `turn_duration`, and each `stop_hook_summary`, the only line that says
 *     a print-mode turn stopped.
 * It keeps their times and ids, and only two tool names: the question to the person and a seat's
 * handback. Live runs on Claude Code 2.1.308 confirmed it on 2026-10-31.
 *
 * The same read gives the harness's failures (failures.mjs):
 *   - a `Bash` call whose command names one harness script, and whose result has `is_error` and
 *     starts `Exit code <n>`, or whose output has the script's own line `HARNESS EXIT: <script>
 *     <n>`, which holds when a pipe or `; echo` hides the call's code. The token of a last
 *     `REASON:` line is kept. The command line and the output stay in memory;
 *   - a line with `isApiErrorMessage`, whose `error` is the type, such as `server_error`.
 * A live run on Claude Code 2.1.316 confirmed this part in the main session on 2026-11-09.
 *
 * Node standard library only.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { OTHER_AGENT, RUNTIME_AGENT, cleanCounts } from '../common.mjs';
import { reasonInOutput, scriptOf, statedExits } from '../failures.mjs';
import { ASK_TOOL, HANDBACK_TOOL } from '../time.mjs';
import { readLines } from './lines.mjs';

export const RUNTIME = 'claude-code';
export const COLLECTOR = 'claude-code/1';
/** The time reader and its version. Every work-time record of this adapter carries it. */
export const TIME_COLLECTOR = 'claude-code-time/1';
/** The failure reader and its version. Every failure record of this adapter carries it. */
export const FAILURE_COLLECTOR = 'claude-code-failures/1';
const SEAT_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
/**
 * An agent type as Claude Code writes it. A seat's type is its name. Any other type only classifies
 * the subagent, so a capital, as in `Explore`, never reaches the state folder or a record. A
 * plugin's agent, `<plugin>:<name>`, does not match, so it is other-agent.
 */
const AGENT_TYPE = /^[A-Za-z][A-Za-z0-9-]{0,63}$/;
/**
 * The subagent types that Claude Code itself ships, as its sub-agents page lists them on 2026-10-29,
 * and `fork`, the type of a fork from v2.1.302. Their records carry `runtime-agent`.
 */
const OWN_AGENTS = new Set(['general-purpose', 'Explore', 'Plan', 'claude', 'statusline-setup', 'claude-code-guide', 'fork']);
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;

/** The API that Claude Code calls, from its environment: Amazon Bedrock, Google Cloud, or Anthropic's own. */
export function providerFromEnv(env = process.env) {
  const on = (v) => v === '1' || v === 'true';
  if (on(env.CLAUDE_CODE_USE_BEDROCK)) return 'bedrock';
  if (on(env.CLAUDE_CODE_USE_VERTEX)) return 'vertex';
  if (on(env.CLAUDE_CODE_USE_FOUNDRY)) return 'foundry';
  return 'anthropic';
}

/** The five counts of one usage block. The 5-minute and 1-hour writes stay apart where Claude Code splits them. */
export function mapUsage(u) {
  const n = (v) => (Number.isFinite(v) && v >= 0 ? v : 0);
  const split = u.cache_creation && typeof u.cache_creation === 'object';
  const w5 = split ? n(u.cache_creation.ephemeral_5m_input_tokens) : null;
  const w1 = split ? n(u.cache_creation.ephemeral_1h_input_tokens) : null;
  const written = Number.isFinite(u.cache_creation_input_tokens) ? n(u.cache_creation_input_tokens) : 0;
  return cleanCounts({
    input: n(u.input_tokens),
    cache_read: n(u.cache_read_input_tokens),
    cache_write: Math.max(written, split ? w5 + w1 : 0),
    cache_write_5m: w5,
    cache_write_1h: w1,
    output: n(u.output_tokens),
  });
}

/** One transcript line as a call, or null when the line is not one. */
function callOf(line, { main, provider }) {
  let row;
  try { row = JSON.parse(line); } catch { return null; }
  if (!row || row.type !== 'assistant' || !row.message || typeof row.message !== 'object') return null;
  const m = row.message;
  if (typeof m.id !== 'string' || !m.usage || typeof m.usage !== 'object') return null;
  if (m.model === '<synthetic>') return null;
  if (main && row.isSidechain === true) return null;
  const ms = Date.parse(row.timestamp);
  if (!Number.isFinite(ms)) return null;
  return {
    call: { id: m.id, ms, model: typeof m.model === 'string' ? m.model : '', provider, counts: mapUsage(m.usage), speed: m.usage.speed === 'fast' ? 'fast' : null },
    version: typeof row.version === 'string' ? row.version : null,
  };
}

/**
 * Every call in a transcript after `offset`, and the offset to start from next time. lines.mjs reads
 * only complete lines, and only a line that carries usage is parsed at all.
 */
export function readTranscript(path, offset, { main, provider = providerFromEnv() } = {}) {
  const calls = [];
  let runtimeVersion = null;
  const next = readLines(path, offset, ['"usage"'], (line) => {
    const found = callOf(line, { main, provider });
    if (!found) return;
    calls.push(found.call);
    if (found.version) runtimeVersion = found.version;
  });
  return { calls, offset: next, runtimeVersion };
}

/** The adapter's read, as collect.mjs calls it: what is new in one log since its checkpoint. */
export function read(log, checkpoint, opts) {
  return readTranscript(log.path, checkpoint.offset, opts);
}

/** The lines that hold a time event: prompts, tool results, answers, request lines and turn ends. */
const TIME_NEEDLES = ['"origin"', '"turnOrigin"', '"tool_result"', '"type":"assistant"', '"api-request"', '"turn_duration"', '"stop_hook_summary"'];
/** The only tool names that work time keeps. Any other tool is `other`, so no tool name of a person's own reaches the disk. */
const TIME_TOOLS = new Set([ASK_TOOL, HANDBACK_TOOL]);
const REF = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const refOf = (v) => (typeof v === 'string' && v.search(REF) === 0 ? v : null);
const blocksOf = (row) => (Array.isArray(row.message?.content) ? row.message.content : []);

/**
 * The prompt line's event. In the main transcript: a person's prompt, a seat's report or a
 * background agent's notice. In a seat's transcript: a resume by the main session, or another line.
 */
function promptOf(row, main) {
  // A print-mode prompt is the caller's, a person's or a script's, and carries no origin.
  const kind = row.origin?.kind ?? (row.turnOrigin === 'sdk' ? 'human' : null);
  if (!main) return { kind: kind === 'coordinator' ? 'resume' : 'line' };
  if (kind === 'human' && !row.isMeta) return { kind: 'prompt', by: 'human' };
  if (kind === 'peer') return { kind: 'prompt', by: 'peer' };
  if (kind === 'task-notification' && !row.isMeta) return { kind: 'prompt', by: 'notice' };
  return null;
}

/** A tool result's text: the content itself, or its first text block. */
function resultText(block) {
  if (typeof block.content === 'string') return block.content;
  const first = Array.isArray(block.content) ? block.content.find((c) => c?.type === 'text') : null;
  return typeof first?.text === 'string' ? first.text : '';
}

/** A failed shell call's result starts with this line. */
const EXIT_LINE = /^Exit code (\d{1,3})(?:\n|$)/;

/**
 * A user line's event: the results of tool calls, or a prompt line. A result keeps a failed call's
 * exit code, the exit codes its output states by script, and the token of its REASON line.
 */
function userEventOf(row, main) {
  const results = blocksOf(row).filter((b) => b?.type === 'tool_result' && refOf(b.tool_use_id));
  if (results.length) {
    const source = row.permissionDecision?.source;
    const exits = {};
    const stated = {};
    const reasons = {};
    for (const b of results) {
      const text = resultText(b);
      const m = b.is_error === true ? text.match(EXIT_LINE) : null;
      if (m) exits[b.tool_use_id] = Number(m[1]);
      const said = statedExits(text);
      if (Object.keys(said).length) stated[b.tool_use_id] = said;
      if (!m && !stated[b.tool_use_id]) continue;
      const reason = reasonInOutput(text);
      if (reason) reasons[b.tool_use_id] = reason;
    }
    return { kind: 'result', ids: results.map((b) => b.tool_use_id), byPerson: typeof source === 'string' && source.startsWith('user'), exits, stated, reasons };
  }
  return row.origin || row.turnOrigin === 'sdk' ? promptOf(row, main) : null;
}

/** A tool call as work time keeps it, with the harness script that a Bash call runs. */
function toolOf(b) {
  const script = b.name === 'Bash' ? scriptOf(b.input?.command) : null;
  return { id: b.id, name: TIME_TOOLS.has(b.name) ? b.name : 'other', ...(script ? { script } : {}) };
}

/** A line's event by its type, or null when the line holds none. */
function eventOf(row, main) {
  if (row.type === 'api-request') return refOf(row.id) ? { kind: 'request', id: row.id } : null;
  // Claude Code writes this line itself when a model call fails and ends the turn.
  if (row.type === 'assistant' && row.isApiErrorMessage === true) return { kind: 'runtime-error', error: typeof row.error === 'string' ? row.error : null };
  if (row.type === 'assistant') {
    const tools = blocksOf(row).filter((b) => b?.type === 'tool_use' && refOf(b.id)).map(toolOf);
    return { kind: 'answer', ref: refOf(row.requestRef), tools };
  }
  if (row.type === 'system' && main && row.subtype === 'turn_duration') return { kind: 'turn-end' };
  if (row.type === 'system') return main && row.subtype === 'stop_hook_summary' ? { kind: 'turn-stop' } : null;
  return row.type === 'user' ? userEventOf(row, main) : null;
}

/** One transcript line as a time event, with the version that wrote it, or null when it holds none. */
function timeEventOf(line, main) {
  let row;
  try { row = JSON.parse(line); } catch { return null; }
  const at = Date.parse(row?.timestamp);
  // In the main transcript, a sidechain line is a seat's, which the seat's own transcript holds.
  if (!Number.isFinite(at) || (main && row.isSidechain === true)) return null;
  const event = eventOf(row, main);
  return event ? { event: { at, ...event }, version: typeof row.version === 'string' ? row.version : null } : null;
}

/**
 * The time reader, as collect.mjs calls it: every time event in one log after `offset`, and the
 * offset to start from next time. Only a line with a time needle is parsed at all.
 */
export function readTime(log, offset, { main }) {
  const events = [];
  let runtimeVersion = null;
  const next = readLines(log.path, offset, TIME_NEEDLES, (line) => {
    const got = timeEventOf(line, main);
    if (!got) return;
    events.push(got.event);
    if (got.version) runtimeVersion = got.version;
  });
  return { events, offset: next, runtimeVersion };
}

/** The seat transcripts of a session, found again at its end: `<session>/subagents/`, searched recursively. */
export function seatTranscripts(transcriptPath, session) {
  const root = join(dirname(transcriptPath), String(session), 'subagents');
  const out = [];
  const walk = (dir, depth) => {
    if (depth > 4 || !existsSync(dir)) return;
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, name.name);
      if (name.isDirectory()) walk(p, depth + 1);
      else if (name.name.startsWith('agent-') && name.name.endsWith('.jsonl')) out.push(p);
    }
  };
  walk(root, 0);
  return out;
}

/** A seat's agent id from its transcript's file name, `agent-<id>.jsonl`. */
export function agentIdOf(path) {
  const m = basename(path).match(/^agent-(.+)\.jsonl$/);
  return m && m[1].search(ID) === 0 ? m[1] : null;
}

/** A subagent's type from the `.meta.json` file beside its transcript, where Claude Code writes one. */
export function seatFromMeta(path) {
  try {
    const meta = JSON.parse(readFileSync(path.replace(/\.jsonl$/, '.meta.json'), 'utf8'));
    const name = [meta.agentType, meta.agent_type, meta.subagent_type].find((v) => typeof v === 'string');
    return name && name.search(AGENT_TYPE) === 0 ? name : null;
  } catch {
    return null;
  }
}

/** The seat logs of a session, read again at each Stop and at its end: [{ logRef, path, metaName }]. */
export function seatLogs(ev) {
  if (!ev.main || !ev.main.path) return [];
  return seatTranscripts(ev.main.path, ev.session)
    .map((path) => ({ logRef: agentIdOf(path), path, metaName: seatFromMeta(path) }))
    .filter((s) => s.logRef);
}

/** A seat is the harness's when the hub's agent registry lists it, or the hub has its charter. */
export function isHarnessSeat(ctx, name) {
  if (typeof name !== 'string' || name.search(SEAT_NAME) !== 0) return false;
  return ctx.seats.has(name) || existsSync(join(ctx.main, '.claude', 'agents', `${name}.md`));
}

/** The name a subagent's records carry: a seat's own, runtime-agent for a type that Claude Code ships, or other-agent. */
export function agentName(ctx, name) {
  if (isHarnessSeat(ctx, name)) return name;
  return OWN_AGENTS.has(name) ? RUNTIME_AGENT : OTHER_AGENT;
}

/** A message for the person, as Claude Code reads it from a hook's output: shown, and never sent to the model. */
export const showMessage = (text) => JSON.stringify({ systemMessage: text });

/**
 * A prompt that does not start, as Claude Code reads it from a UserPromptSubmit hook's output: it
 * erases the prompt and shows the person the reason. No model call starts.
 */
export const refusePrompt = (reason) => JSON.stringify({ decision: 'block', reason });

/**
 * A Claude Code hook event in the runtime-neutral form the hook works with:
 *   { kind: 'prompt' | 'tool' | 'turn' | 'seat' | 'end' | 'other', session, prompt, command, cwd, main, seat }
 * `command` is the command line of a Bash call. It stays in memory: the hook keeps only the key it names.
 */
const text = (v) => (typeof v === 'string' ? v : null);
const idOf = (v) => (typeof v === 'string' && v.search(ID) === 0 ? v : null);
const KINDS = { UserPromptSubmit: 'prompt', PreToolUse: 'tool', Stop: 'turn', StopFailure: 'turn', SessionEnd: 'end', SubagentStop: 'seat' };

/** The seat a SubagentStop names, or null when its id or its transcript is missing. */
function seatOf(event) {
  const id = idOf(event.agent_id);
  const path = text(event.agent_transcript_path);
  return id && path ? { logRef: id, path, name: event.agent_type } : null;
}

export function normalise(event) {
  const session = idOf(event?.session_id);
  let kind = (session && KINDS[event.hook_event_name]) || 'other';
  const command = kind === 'tool' && event.tool_name === 'Bash' ? text(event.tool_input?.command) : null;
  if (kind === 'tool' && command === null) kind = 'other';
  const mainPath = text(event?.transcript_path);
  return {
    kind,
    session,
    cwd: text(event?.cwd),
    prompt: kind === 'prompt' ? text(event.prompt) : null,
    command,
    main: kind !== 'other' && kind !== 'tool' && mainPath ? { logRef: session, path: mainPath } : null,
    seat: kind === 'seat' ? seatOf(event) : null,
  };
}

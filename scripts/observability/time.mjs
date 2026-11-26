// Part of the harness asset library c6f3b4427d58f7c3 (see VERSION.json) · 2026-10-30
/**
 * time.mjs — the rules of work time: when each agent worked, when a run waited for the person, and
 * each command's elapsed time. It holds no runtime's log format. A collector adapter reads its log
 * into time events (its `readTime`), and `stepLog` turns them into finished pieces.
 *
 * Every time comes from a line of a log, never from a hook's clock. A piece is finished only when
 * the log says so, so a hook that runs before the last lines reach the disk changes nothing.
 *
 * The main session:
 *   - A turn starts at a prompt line: a person's prompt, a seat's report or a background notice.
 *     A prompt that comes while a turn runs joins that turn.
 *   - A turn ends at its last line. It is finished when its end line follows, or at the session's end.
 *   - A runtime can say that a turn stopped, with no end line (a `turn-stop`). The next prompt, or the
 *     session's end, finishes that turn. A line of the turn after the stop cancels it, as when a hook
 *     makes the turn go on.
 *   - A reply wait runs from the end of a turn to the next prompt of a person.
 *
 * A seat:
 *   - An activation starts at the seat's first line, or at a line that resumes the seat.
 *   - It ends at its last line before the next resume.
 *   - It is finished at its end line, where the runtime writes one, at the end of the read that
 *     holds its handback's result, at the next resume, or at the session's end. It is also finished
 *     at the first read after the runtime said that the seat stopped.
 *
 * Inside a turn or an activation:
 *   - A model call runs from its request line to its last answer line. Model time is their union.
 *   - A tool call runs from the answer line that holds it to its result. Tool time is their union,
 *     outside model time.
 *   - A question to the person is a wait, not work, so it splits the turn into two pieces.
 *   - A tool call that a person allowed is a permission wait. Its span also holds the tool's own run.
 *     The log cannot tell the two apart, so the span stays inside tool time too.
 *   - A runtime that times the person's decision itself gives a wait of its own (a `person` event).
 *     That wait is not work either, so it splits the piece as a question does.
 *
 * The same events give the harness's failures (failures.mjs):
 *   - A tool call that runs a harness script, and whose result carries exit 2, 3 or 4, is a script
 *     failure. It runs from the call to its result.
 *   - A line that says the runtime failed the turn is a runtime failure, at that line's time.
 * A failure belongs to the run of the turn or activation that holds it. It is not work and not a
 * wait, so it changes no piece of time.
 *
 * Node standard library only.
 */
import { OUTCOMES, RUNTIME_OUTCOME, isFailureExit, reasonOf } from './failures.mjs';
import { runAt } from './runs.mjs';

/** The tool that asks the person a question. Its call is a wait for the person. */
export const ASK_TOOL = 'AskUserQuestion';
/** The tool whose result finishes a seat's activation: the seat hands its report back. */
export const HANDBACK_TOOL = 'SubagentHandback';
/** A tool call that waits longer than this for its result is dropped from the state. */
const PENDING_MS = 2 * 24 * 3600 * 1000;
/**
 * How long after a person's prompt line its run may start. The hook opens a run at the prompt, and
 * the runtime can write the prompt's line just before that.
 */
export const PROMPT_SLACK_MS = 5000;

/* ------------------------------------------------------------------------------- intervals */

/** The union of intervals [start, end]: sorted, with no overlap and no empty interval. */
export function union(intervals) {
  const sorted = intervals.filter(([a, b]) => b > a).map(([a, b]) => [a, b]).sort((x, y) => x[0] - y[0]);
  const out = [];
  for (const [a, b] of sorted) {
    const last = out.at(-1);
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

/** The time that a set of intervals covers, each moment once. */
export const total = (intervals) => union(intervals).reduce((s, [a, b]) => s + b - a, 0);

/** The parts of each interval that fall inside [from, to]. */
export const clip = (intervals, [from, to]) => intervals.map(([a, b]) => [Math.max(a, from), Math.min(b, to)]).filter(([a, b]) => b > a);

/** The parts of `intervals` that no interval of `cuts` covers. */
export function minus(intervals, cuts) {
  let out = union(intervals);
  for (const [c, d] of union(cuts)) {
    out = out.flatMap(([a, b]) => (d <= a || c >= b ? [[a, b]] : [[a, Math.min(b, c)], [Math.max(a, d), b]].filter(([x, y]) => y > x)));
  }
  return out;
}

/* --------------------------------------------------------------------------- one log's pieces */

/** The time state of a log before its first read. */
export const freshState = () => ({ open: null, requests: {}, tools: {}, last_end: null, last_anchor: null, last_by: null, stop_seen: null, stop_pending: false });

function startPiece(state, at, by) {
  state.open = { start: at, last: at, by, calls: {}, tools: [], asks: [] };
}

/**
 * Finishes the open turn or activation. Its questions cut it into pieces of work, and each piece
 * takes its own model time and tool time.
 */
function finishPiece(state, items, main) {
  const o = state.open;
  if (!o) return;
  state.open = null;
  state.stop_pending = false;
  state.requests = {};
  const calls = union(Object.values(o.calls));
  for (const [a, b] of minus([[o.start, o.last]], o.asks)) {
    const model = union(clip(calls, [a, b]));
    const tools = minus(clip(o.tools, [a, b]), model);
    items.push({ type: 'work', start: a, end: b, model: total(model), tool: total(tools), anchor: o.start, by: o.by });
  }
  if (main) {
    state.last_end = o.last;
    state.last_anchor = o.start;
    state.last_by = o.by;
  }
}

/**
 * A harness script's call whose result carries a failure's exit code: its failure. The code the
 * script stated in its output wins, because a pipe or `; echo` can hide the code of the call.
 */
function scriptFailure(call, e, id, o) {
  const code = e.stated?.[id]?.[call.script] ?? e.exits?.[id];
  if (!call.script || !isFailureExit(code)) return null;
  return {
    type: 'failure', source: 'script', check: call.script, exit_code: code, outcome: OUTCOMES[code],
    reason: reasonOf(e.reasons?.[id]), start: call.at, end: e.at, anchor: o.start, by: o.by,
  };
}

/** A tool call's result: a question, a permission wait, or tool time. A handback marks the open piece. */
function onResult(state, items, e) {
  for (const id of e.ids || []) {
    const call = state.tools[id];
    delete state.tools[id];
    if (!call || !state.open) continue;
    const o = state.open;
    const failure = scriptFailure(call, e, id, o);
    if (failure) items.push(failure);
    if (call.name === ASK_TOOL) {
      o.asks.push([call.at, e.at]);
      items.push({ type: 'wait', gate: 'question', start: call.at, end: e.at, anchor: o.start, by: o.by });
      continue;
    }
    o.tools.push([call.at, e.at]);
    if (e.byPerson) items.push({ type: 'wait', gate: 'permission-prompt', start: call.at, end: e.at, anchor: o.start, by: o.by });
    if (call.name === HANDBACK_TOOL) o.handback = true;
  }
}

/** How each kind of event changes a log's state. */
const ON = {
  prompt(state, items, e, main) {
    if (main && state.open && state.stop_pending) finishPiece(state, items, main);
    if (!main || state.open) return;
    if (e.by === 'human' && state.last_end !== null && e.at >= state.last_end) {
      items.push({ type: 'wait', gate: 'reply', start: state.last_end, end: e.at, anchor: e.at, by: 'human', from: state.last_anchor, fromBy: state.last_by });
    }
    startPiece(state, e.at, e.by);
  },
  resume(state, items, e, main) {
    if (main || state.open.start === e.at) return;
    finishPiece(state, items, false);
    startPiece(state, e.at, 'seat');
  },
  line(state, items, e, main) {
    if (!main) state.open.last = Math.max(state.open.last, e.at);
  },
  request(state, items, e) {
    state.stop_pending = false;
    if (state.open && typeof e.id === 'string') state.requests[e.id] = e.at;
  },
  answer(state, items, e) {
    state.stop_pending = false;
    for (const t of e.tools || []) state.tools[t.id] = { at: e.at, name: t.name, ...(t.script ? { script: t.script } : {}) };
    const o = state.open;
    if (!o) return;
    o.last = Math.max(o.last, e.at);
    if (typeof e.ref !== 'string') return;
    const had = o.calls[e.ref];
    const from = state.requests[e.ref] ?? (had ? had[0] : e.at);
    o.calls[e.ref] = had ? [Math.min(had[0], from), Math.max(had[1], e.at)] : [from, e.at];
  },
  result(state, items, e) {
    state.stop_pending = false;
    if (state.open) state.open.last = Math.max(state.open.last, e.at);
    onResult(state, items, e);
  },
  person(state, items, e) {
    const o = state.open;
    if (!o || !Number.isFinite(e.end) || e.end <= e.at || !['question', 'permission-prompt'].includes(e.gate)) return;
    o.asks.push([e.at, e.end]);
    o.last = Math.max(o.last, e.end);
    items.push({ type: 'wait', gate: e.gate, start: e.at, end: e.end, anchor: o.start, by: o.by });
  },
  /** A line that says the runtime failed the turn. It belongs to the open piece, or to the turn that just ended. */
  'runtime-error'(state, items, e) {
    state.stop_pending = false;
    const o = state.open;
    if (o) o.last = Math.max(o.last, e.at);
    const anchor = o ? o.start : state.last_anchor;
    if (anchor === null) return;
    items.push({
      type: 'failure', source: 'runtime', check: null, exit_code: null, outcome: RUNTIME_OUTCOME,
      reason: reasonOf(e.error), start: e.at, end: e.at, anchor, by: o ? o.by : state.last_by,
    });
  },
  'turn-end'(state, items, e, main) {
    finishPiece(state, items, main);
  },
  'turn-stop'(state) {
    if (state.open) state.stop_pending = true;
  },
};

/**
 * A seat that handed its report back, or that the runtime said stopped at the read before this one,
 * finishes at the end of this read: its lines are on disk by then.
 */
function endOfSeatRead(state, items, stopped) {
  if (state.open && (state.open.handback || state.stop_seen === state.open.start)) finishPiece(state, items, false);
  state.stop_seen = stopped && state.open ? state.open.start : null;
}

/**
 * Steps one log's state through its new events, in place. Returns the finished pieces, and the failures:
 *   { type: 'work', start, end, model, tool, anchor, by }
 *   { type: 'wait', gate, start, end, anchor, by, from?, fromBy? }
 *   { type: 'failure', source, check, exit_code, outcome, reason, start, end, anchor, by }
 * `anchor` and `by` say which run a piece belongs to (`runOf`). A reply wait also names the turn
 * before it, in `from` and `fromBy`, because a reply belongs to a run only when both turns do.
 *
 * An event is { at, kind } with:
 *   prompt (main): by is human, peer or notice     resume (seat): a line that resumes the seat
 *   line (seat): any other prompt line             request: id, a model call's request line
 *   answer: ref, the call's id, and tools [{ id, name, script? }], where script names the harness
 *           script that a shell call runs
 *   result: ids of tool calls, and byPerson, and for a failed call its exit code in exits[id], the
 *           exit codes its output states by script in stated[id], and the token of its REASON
 *           line in reasons[id]
 *   turn-end: the line that ends a turn or a seat's run
 *   person: a wait for the person from at to end, with its gate, question or permission-prompt
 *   runtime-error: a line that says the runtime failed the turn, with its error type in error
 *
 * `stopped` says that this read follows the runtime's word that the seat stopped. `final` says that
 * the session ended, so every open piece finishes at its last line.
 */
export function stepLog(state, events, { main, stopped = false, final = false }) {
  const items = [];
  let latest = 0;
  for (const e of events) {
    if (!Object.hasOwn(ON, e.kind) || !Number.isFinite(e.at)) continue;
    latest = Math.max(latest, e.at);
    // A seat's activation starts at its first line, whatever that line is.
    if (!main && !state.open && e.kind !== 'turn-end') startPiece(state, e.at, 'seat');
    ON[e.kind](state, items, e, main);
  }
  if (!main) endOfSeatRead(state, items, stopped);
  if (final) finishPiece(state, items, main);
  for (const [id, call] of Object.entries(state.tools)) if (latest - call.at > PENDING_MS) delete state.tools[id];
  return items;
}

/* ------------------------------------------------------------------------------- the runs */

/**
 * The run that a piece belongs to: the run at its anchor. A person's prompt can reach the log just
 * before the hook opens the run that it starts, so a person's prompt looks a little later.
 */
export function runOf(binding, anchor, by) {
  if (!Number.isFinite(anchor)) return null;
  return runAt(binding, by === 'human' ? anchor + PROMPT_SLACK_MS : anchor);
}

/**
 * A command's figures from its run's finished pieces, in milliseconds, or null for a run with no work:
 *   started      its first piece of work, which its prompt starts
 *   ended        the end of its last turn or seat activation, or of a wait for the person after it
 *   busy         the time when at least one agent worked
 *   wait         the time when it waited for the person, outside busy time
 *   unexplained  the rest
 * A question that the person declines ends the turn, and no work follows it. Its wait is still the
 * command's, so the command ends with it.
 */
export function commandFigures({ work = [], waits = [] }) {
  const busy = union(work);
  if (!busy.length) return null;
  const started = busy[0][0];
  const ended = waits.reduce((end, [, b]) => Math.max(end, b), busy.at(-1)[1]);
  const busyMs = total(busy);
  const waitMs = total(minus(clip(waits, [started, ended]), busy));
  const duration = ended - started;
  return { started, ended, duration, busy: busyMs, wait: waitMs, unexplained: duration - busyMs - waitMs };
}

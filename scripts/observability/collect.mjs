// Part of the harness asset library c6f3b4427d58f7c3 (see VERSION.json) · 2026-10-26
/**
 * collect.mjs — one collection of one log. Every collector adapter calls it the same way, from the
 * hook, once it knows which log finished: the main session's after a turn, a seat's after it stops.
 *
 * Under the log's lock, in this order:
 *   1. finish any record a stopped process left as `.pending` (state.mjs `repair`);
 *   2. read what is new in the log, through the adapter's `read`;
 *   3. run the delta rule (delta.mjs) against the checkpoint and the call index;
 *   4. write each record as `.pending`;
 *   5. move the checkpoint and the call index;
 *   6. mark each record ready, so the sender may send it.
 *
 * A record that breaks the record rules is refused here, logged without its values, and its calls
 * are never sent.
 *
 * `collectTime` reads the same log's work time and the failures in it, under the lock of the log's
 * time state, by the rules of time.mjs. `finishRuns` writes the command record of each run whose work
 * has all finished.
 *
 * Node standard library only, plus git.
 */
import { existsSync } from 'node:fs';
import { ORCHESTRATOR, nowMs, secs } from './common.mjs';
import { computeDelta } from './delta.mjs';
import { loadPrices, tierOf } from './prices.mjs';
import { buildRecord, buildTimeRecord, validateRecord } from './record.mjs';
import { runAt, runById } from './runs.mjs';
import {
  bindingKey, bindingPath, checkpointPath, indexPath, loadBinding, loadCheckpoint, loadIndex, loadTimeRun, loadTimeState, logKeyOf, logLine,
  markReady, queueHas, repair, saveCheckpoint, saveIndex, saveTimeRun, saveTimeState, timeRunPath, timeStatePath, withLock, writePending,
  writeReady,
} from './state.mjs';
import { commandFigures, freshState, runOf, stepLog } from './time.mjs';

/**
 *   ctx         hubContext(start), with ok: true
 *   runtime     'claude-code', 'codex' or 'opencode'
 *   collector   the adapter and its version, such as 'claude-code/1'
 *   session     the runtime session whose binding holds the runs
 *   logRef      the runtime's id for this log
 *   seat        the seat's name, or null for the main session
 *   read        (checkpoint) => { calls, offset, runtimeVersion }, called under the log's lock
 *
 * Returns { calls, written }: the calls read, and the records queued.
 */
export function collect({ ctx, runtime, collector, session, logRef, seat = null, read, prices = loadPrices(), synthetic = false }) {
  const dir = ctx.dir;
  repair(dir);
  const logKey = logKeyOf(runtime, logRef);
  const bKey = bindingKey(runtime, session);
  const result = { calls: 0, written: 0 };
  withLock(checkpointPath(dir, logKey), () => {
    const checkpoint = loadCheckpoint(dir, logKey);
    const got = read(checkpoint) || {};
    const calls = Array.isArray(got.calls) ? got.calls : [];
    result.calls = calls.length;
    const binding = loadBinding(dir, bKey);
    if (seat && checkpoint.run_id === undefined && calls.length) {
      const first = Math.min(...calls.map((c) => c.ms).filter(Number.isFinite));
      const run = Number.isFinite(first) ? runAt(binding, first) : null;
      checkpoint.run_id = run ? run.run_id : null;
    }
    const seatRun = seat && checkpoint.run_id ? runById(binding, checkpoint.run_id) : null;
    const runFor = seat ? () => seatRun : (c) => runAt(binding, c.ms);
    const runtimeVersion = got.runtimeVersion || checkpoint.runtime_version || null;
    withLock(indexPath(dir, runtime), () => {
      const index = loadIndex(dir, runtime);
      const tierFor = (c) => tierOf(prices, c.provider, c.model, c.counts, c.speed);
      const { groups, marks, owned } = computeDelta({ calls, checkpoint, index, logKey, runFor, tierFor });
      const now = nowMs();
      const recordCtx = { hub: ctx.hub, harness: ctx.harness, runtime, collector, runtimeVersion, logRef, seat, synthetic };
      const ready = [];
      for (const g of groups) {
        const record = buildRecord(g, recordCtx);
        const problems = validateRecord(record);
        if (problems.length) {
          logLine(dir, 'WARN', `a record of ${g.calls.length} call(s) was refused before the queue: ${problems.join(' · ')}`);
          for (const c of g.calls) checkpoint.calls[c.id] = { sent: c.after, skipped: 'refused' };
          continue;
        }
        if (!queueHas(dir, record.record_id)) {
          const apply = {
            log: logKey, runtime, ms: now,
            calls: Object.fromEntries(g.calls.map((c) => [c.id, c.after])),
            index: g.calls.map((c) => c.id).filter((id) => owned.includes(id)),
          };
          writePending(dir, { record, local: { binding: bKey, run_id: g.run.run_id, created_ms: now, apply } });
          ready.push(record.record_id);
        }
        for (const c of g.calls) checkpoint.calls[c.id] = { sent: c.after };
      }
      for (const [id, mark] of Object.entries(marks)) checkpoint.calls[id] = mark;
      for (const id of owned) if (!(checkpoint.calls[id] && checkpoint.calls[id].skipped) && !index.calls[id]) index.calls[id] = [logKey, now];
      if (Number.isFinite(got.offset)) checkpoint.offset = got.offset;
      if (runtimeVersion) checkpoint.runtime_version = runtimeVersion;
      checkpoint.seat = seat;
      checkpoint.updated_ms = now;
      saveCheckpoint(dir, logKey, checkpoint);
      saveIndex(dir, runtime, index);
      for (const id of ready) markReady(dir, id);
      result.written = ready.length;
    });
  });
  return result;
}

/* ---------------------------------------------------------------------------------- work time */

/** Changes one run's work-time file under its lock: its finished pieces, and the logs that hold one open. */
function changeRun(dir, runId, bKey, change) {
  withLock(timeRunPath(dir, runId), () => {
    const run = loadTimeRun(dir, runId) || { run_id: runId, binding: bKey, work: [], waits: [], open: {}, runtime_version: null, done: false };
    change(run);
    saveTimeRun(dir, runId, run);
  });
}

/**
 * One finished piece as a record, with its run, or null. A piece before the first run belongs to no
 * run. A reply wait belongs to a run only when the turn before it does too: a person's prompt that
 * starts another harness command ends no reply wait.
 */
function pieceRecord(item, { binding, recordCtx, failureCtx, logRef, seat }) {
  const run = runOf(binding, item.anchor, item.by);
  if (!run) return null;
  if (item.gate === 'reply' && runOf(binding, item.from, item.fromBy)?.run_id !== run.run_id) return null;
  if (item.type === 'failure') {
    if (!failureCtx) return null;
    const own = { agent: seat ?? ORCHESTRATOR, source: item.source, check: item.check, exit_code: item.exit_code, outcome: item.outcome, reason: item.reason };
    return { run, record: buildTimeRecord('failure', { run, ctx: failureCtx, start: item.start, end: item.end, own, logRef }) };
  }
  const work = item.type === 'work';
  const own = work
    ? { agent: seat ?? ORCHESTRATOR, model_s: secs(item.model), tool_s: secs(item.tool) }
    : { gate: item.gate, gate_wait_s: null };
  return { run, record: buildTimeRecord(work ? 'work' : 'wait-in-session', { run, ctx: recordCtx, start: item.start, end: item.end, own, logRef }) };
}

/** Notes in its run's file that the run's command record must wait for this log's open piece. */
function noteOpenPiece(dir, st, { binding, bKey, logKey }) {
  const open = st.machine.open;
  const openRun = open ? runOf(binding, open.start, open.by)?.run_id ?? null : null;
  if (openRun === st.open_run) return;
  if (st.open_run) changeRun(dir, st.open_run, bKey, (run) => { delete run.open[logKey]; });
  if (openRun) changeRun(dir, openRun, bKey, (run) => { run.open[logKey] = true; });
  st.open_run = openRun;
}

/**
 * One read of one log's work time, under the lock of its time state:
 *   1. read the time events that are new in the log, through the adapter's `readTime`;
 *   2. step the log's open turn or activation (time.mjs), which gives the finished pieces;
 *   3. queue a record for each piece, and each failure, that belongs to a run, ready at once;
 *   4. add each piece to its run's file, and note which run waits for this log's open piece;
 *   5. move the log's time offset.
 * The same lines always give the same pieces and the same record ids, so a stop before step 5
 * never queues a record twice.
 *
 *   ctx, runtime, session, logRef, seat and synthetic, as for collect
 *   collector   the time reader and its version, such as 'claude-code-time/1'
 *   readTime    (offset, state) => { events, offset, runtimeVersion, state }. `state` is what the
 *               reader returned at its last read, for a log whose lines do not give each time alone
 *   stopped     true when the runtime said at this hook that the seat stopped
 *   final       true at the session's end, so every open piece finishes
 *   failures    { collector }: the failure reader and its version, such as
 *               'claude-code-failures/1'. Null for an adapter that reads no failure, so a failure
 *               gives no record
 *
 * Returns { written }: the records queued.
 */
export function collectTime({ ctx, runtime, collector, session, logRef, seat = null, readTime, stopped = false, final = false, failures = null, synthetic = false }) {
  const dir = ctx.dir;
  const logKey = logKeyOf(runtime, logRef);
  const bKey = bindingKey(runtime, session);
  let written = 0;
  withLock(timeStatePath(dir, logKey), () => {
    const st = loadTimeState(dir, logKey) || { offset: 0, machine: freshState(), open_run: null, runtime_version: null };
    const got = readTime(st.offset, st.reader ?? null) || {};
    if ('state' in got) st.reader = got.state;
    const binding = loadBinding(dir, bKey);
    const items = stepLog(st.machine, Array.isArray(got.events) ? got.events : [], { main: !seat, stopped, final });
    const runtimeVersion = got.runtimeVersion || st.runtime_version || null;
    const recordCtx = { hub: ctx.hub, harness: ctx.harness, runtime, collector, runtimeVersion, synthetic };
    const failureCtx = failures ? { ...recordCtx, collector: failures.collector } : null;
    const now = nowMs();
    for (const item of items) {
      const piece = pieceRecord(item, { binding, recordCtx, failureCtx, logRef, seat });
      if (!piece) continue;
      const problems = validateRecord(piece.record);
      if (problems.length) {
        logLine(dir, 'WARN', `a ${piece.record.type} record was refused before the queue: ${problems.join(' · ')}`);
        continue;
      }
      if (!queueHas(dir, piece.record.record_id)) {
        writeReady(dir, { record: piece.record, local: { binding: bKey, run_id: piece.run.run_id, created_ms: now } });
        written += 1;
      }
      // A failure is not work and not a wait, so the run's time does not change.
      if (item.type === 'failure') continue;
      changeRun(dir, piece.run.run_id, bKey, (run) => {
        (item.type === 'work' ? run.work : run.waits).push([item.start, item.end]);
        run.runtime = runtime;
        run.collector = collector;
        if (!seat && runtimeVersion) run.runtime_version = runtimeVersion;
      });
    }
    noteOpenPiece(dir, st, { binding, bKey, logKey });
    if (Number.isFinite(got.offset)) st.offset = got.offset;
    if (runtimeVersion) st.runtime_version = runtimeVersion;
    st.updated_ms = now;
    saveTimeState(dir, logKey, st);
  });
  return { written };
}

/**
 * Writes the command record of each ended run of a session whose work has all finished: no log holds
 * a piece of it open, and every seat log of the session has been read once. `final`, at the
 * session's end, writes every ended run's record. Returns the number of records queued.
 */
export function finishRuns({ ctx, runtime, collector, session, seatRefs = [], final = false, synthetic = false }) {
  const dir = ctx.dir;
  const bKey = bindingKey(runtime, session);
  if (!existsSync(bindingPath(dir, bKey))) return 0;
  // A seat log that no read has reached yet can still hold a piece of an ended run.
  if (!final && seatRefs.some((ref) => !existsSync(timeStatePath(dir, logKeyOf(runtime, ref))))) return 0;
  const binding = loadBinding(dir, bKey);
  let written = 0;
  for (const run of binding.runs || []) {
    if (run.ended_ms == null || !existsSync(timeRunPath(dir, run.run_id))) continue;
    withLock(timeRunPath(dir, run.run_id), () => {
      const times = loadTimeRun(dir, run.run_id);
      if (!times || times.done || (!final && Object.keys(times.open || {}).length)) return;
      times.done = true;
      const f = commandFigures(times);
      if (f) {
        const recordCtx = { hub: ctx.hub, harness: ctx.harness, runtime, collector, runtimeVersion: times.runtime_version, synthetic };
        const own = { busy_s: secs(f.busy), wait_s: secs(f.wait), unexplained_s: secs(f.unexplained) };
        const record = buildTimeRecord('command', { run, ctx: recordCtx, start: f.started, end: f.ended, own });
        const problems = validateRecord(record);
        if (problems.length) {
          logLine(dir, 'WARN', `a command record was refused before the queue: ${problems.join(' · ')}`);
        } else if (!queueHas(dir, record.record_id)) {
          writeReady(dir, { record, local: { binding: bKey, run_id: run.run_id, created_ms: nowMs() } });
          written += 1;
        }
      }
      saveTimeRun(dir, run.run_id, times);
    });
  }
  return written;
}

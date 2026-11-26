// Part of the harness asset library c6f3b4427d58f7c3 (see VERSION.json) · 2026-10-26
/**
 * delta.mjs — the delta rule. A record holds, for one log, the counts the log shows now minus the
 * counts already sent from it. Every call of a read goes through five questions:
 *
 *   1. Is it a real call?        The adapter answers it, with its runtime's own rules.
 *   2. Is it a copy?             Its id belongs to another log in the call index: skipped.
 *   3. Which run?                `runFor` answers it. No run: skipped, and never sent.
 *   4. What is new?              The largest counts seen, minus the counts already sent. Never negative.
 *   5. Which record?             One for each run, model and price tier.
 *
 * A skipped call stays skipped: its later entries are skipped too. Pure functions, no I/O.
 */
import { diffCounts, isEmptyDiff, maxCounts, totalOf } from './common.mjs';

/** One entry for each call id: the one with the largest total, whatever the order of the entries. */
export function largestEntries(calls) {
  const byId = new Map();
  for (const c of calls) {
    if (!c || typeof c.id !== 'string' || c.id === '' || !Number.isFinite(c.ms)) continue;
    const prev = byId.get(c.id);
    if (!prev || totalOf(c.counts) > totalOf(prev.counts)) byId.set(c.id, c);
  }
  return [...byId.values()];
}

/**
 * The five questions for one read of one log.
 *
 *   calls       [{ id, ms, model, provider, counts, speed }], as the adapter read them
 *   checkpoint  { calls: { [id]: { sent, skipped } } }
 *   index       { calls: { [id]: [logKey, ms] } }
 *   logKey      this log's key
 *   runFor      (call) => run or null
 *   tierFor     (call) => tier name or null
 *
 * Returns the record groups, the checkpoint marks of the calls that make no record, and the ids
 * this log now owns in the call index.
 */
export function computeDelta({ calls, checkpoint, index, logKey, runFor, tierFor }) {
  const groups = new Map();
  const marks = {};
  const owned = [];
  for (const c of largestEntries(calls)) {
    const had = checkpoint.calls[c.id];
    const sent = had ? had.sent : null;
    const owner = index.calls[c.id];
    if (owner && owner[0] !== logKey) {
      marks[c.id] = { sent: maxCounts(sent, c.counts), skipped: 'copy' };
      continue;
    }
    if (had && had.skipped) {
      marks[c.id] = { sent: maxCounts(sent, c.counts), skipped: had.skipped };
      continue;
    }
    const run = runFor(c);
    if (!run) {
      marks[c.id] = { sent: maxCounts(sent, c.counts), skipped: 'no-run' };
      continue;
    }
    const after = maxCounts(sent, c.counts);
    const diff = diffCounts(after, sent);
    if (isEmptyDiff(diff)) continue;
    if (!owner) owned.push(c.id);
    const tier = tierFor(c);
    const key = JSON.stringify([run.run_id, c.provider, c.model, tier]);
    if (!groups.has(key)) groups.set(key, { run, provider: c.provider, model: c.model, tier, calls: [] });
    groups.get(key).calls.push({ id: c.id, ms: c.ms, diff, after });
  }
  return { groups: [...groups.values()], marks, owned };
}

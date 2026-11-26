// Part of the harness asset library c6f3b4427d58f7c3 (see VERSION.json) · 2026-10-26
/**
 * sender.mjs — what leaves the queue for the observability platform, and when.
 *
 * One sender runs for a hub at a time. It takes the ready records, oldest first. For each record it:
 *   - holds it while its run has no key yet, until the run ends or for 24 hours at most;
 *   - takes the run's key, and from the hub's trunk the story's feature, the story's Jira ticket and
 *     the feature's Jira Epic;
 *   - names its bucket;
 *   - prices a tokens record from the list-price table: a work-time record holds no tokens;
 *   - gives a command record its pickup: the time from the last merge of the gate that the command
 *     follows to the command's start, read from the hub's trunk (gates.mjs);
 *   - gives a command record, and a wait in its session, the part of its waits that a gate's merge
 *     counts, `gate_wait_s`, so that no second of a person's wait counts twice;
 *   - checks it against the record rules.
 * Then it sends them in batches through the hub's platform adapter, each request with a time limit.
 * A GitHub workflow writes the gate records themselves (observability-gate.mjs), never this sender.
 *
 * An accepted record moves to sent/. A refused one moves to refused/, with the observability
 * platform's answer. A network error, a timeout or a server error keeps every record, and the next
 * try waits longer: 30 seconds, doubled after each failure, an hour at most. A web page in answer
 * is a failure too, even with a 2xx status: the URL leads to a web interface, which takes no
 * record. So are 401, 403 and 404, and an answer that the adapter knows as a wrong path: the URL or
 * the key is wrong, not the records, so the records wait. A failed connection names its cause.
 * Delivery is at least once. A duplicate can happen only when the observability platform accepted a
 * record and its answer was lost, and the record's id lets a query find it.
 *
 * Node standard library only, plus git.
 */
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { EXIT, iso, nowMs, secs } from './common.mjs';
import { hubContext } from './config.mjs';
import { PREVIOUS_GATE, openTrunk } from './gates.mjs';
import { featuresOnTrunk, ticketsOnTrunk } from './lookups.mjs';
import { costOf, loadPrices } from './prices.mjs';
import { leaving, validateRecord } from './record.mjs';
import { bucketOf, runById } from './runs.mjs';
import { folders, loadBinding, loadTimeRun, logLine, readJson, readyRecords, tryLock, writeJson } from './state.mjs';
import { minus, total, union } from './time.mjs';
import * as cubeapm from './platforms/cubeapm.mjs';
import * as grafana from './platforms/grafana.mjs';

// INTEGRATION POINT — another observability platform: an adapter in platforms/ with the same
// request(records, { url, hub, token, sendMs }), named here, in config.mjs's PLATFORMS and in the
// enum of governance/observability.schema.json. It may also export isWrongPath(status, answer) for
// an answer that means the URL is wrong. `token` is null when the hub's observability.json says
// "auth": "none", and the adapter then sends no Authorization header.
export const PLATFORMS = { cubeapm, grafana };
export const BATCH = 50;
/** How many times one sender collects the queue: the records that hooks queue while it sends. */
export const PASSES = 3;
export const HOLD_MS = 24 * 3600 * 1000;
const KEEP_SENT_MS = 30 * 24 * 3600 * 1000;
const FIRST_WAIT_MS = 30 * 1000;
const LONGEST_WAIT_MS = 3600 * 1000;

/** The time limit of one request: HARNESS_OBSERVABILITY_TIMEOUT_MS, or 10 seconds. */
const requestTimeout = () => {
  const v = Number(process.env.HARNESS_OBSERVABILITY_TIMEOUT_MS);
  return Number.isFinite(v) && v > 0 ? v : 10000;
};

const bindingQuiet = (dir, key) => { try { return loadBinding(dir, key); } catch { return null; } };

/** Why nothing leaves while the hub sends a bearer token and none is set. */
const NO_TOKEN = 'HARNESS_OBSERVABILITY_TOKEN is not set, so nothing is sent. The records wait in the queue. If the receiver needs no key, set "auth": "none" in docs/estate/observability.json';

/** One WARN line in observability.log while the records wait for the token: again only after a send, or a day later. */
function warnNoToken(dir, now) {
  const statePath = join(dir, 'send-state.json');
  const st = readJson(statePath, { failures: 0, next_ms: 0 });
  if (st.no_token_ms && now - st.no_token_ms < HOLD_MS) return;
  writeJson(statePath, { ...st, no_token_ms: now });
  logLine(dir, 'WARN', NO_TOKEN);
}

/** True while a run still lacks the key its command gives it. */
function missingKey(run, record) {
  if (run.key_kind === 'story') return !record.story;
  if (run.key_kind === 'feature') return !record.feature;
  return false;
}

const keyOf = (record) => (record.story ? { story: record.story } : record.feature ? { feature: record.feature } : null);

/**
 * A command's pickup: the gate that the command follows, that gate's last merge before the command
 * started, and the time between. All null when the command follows no gate, the key is missing, no
 * merge came before, or git cannot read the trunk. It is never asked again.
 */
function pickupOf(record, trunk) {
  const none = { previous_gate: null, previous_gate_merged_at: null, pickup_s: null };
  const follows = PREVIOUS_GATE[record.command];
  const started = Date.parse(record.started_at);
  if (!follows || !trunk) return none;
  const key = follows.key === 'story' ? { story: record.story } : { feature: record.feature };
  if (!key.story && !key.feature) return none;
  const m = trunk.lastMerge(follows.gate, key, started);
  if (!m || m.unknown) return none;
  return { previous_gate: follows.gate, previous_gate_merged_at: iso(m.mergedMs), pickup_s: secs(started - m.mergedMs) };
}

/**
 * The part of some waits that a gate record counts: for each merge of the key's hub gates that falls
 * inside a wait, the time from that wait's start to the merge. The person reviewed while the run
 * waited, and the gate's record counts that time from the hand-off. `busy` is cut out, so that this
 * part is outside busy time as `wait_s` is. Null when git cannot say.
 */
function gateOverlap(key, waits, busy, trunk) {
  if (!key || !trunk || !waits.length) return 0;
  const from = Math.min(...waits.map(([a]) => a));
  const to = Math.max(...waits.map(([, b]) => b));
  const got = trunk.mergesIn(key, from, to);
  if (got.unknown) return null;
  const parts = [];
  for (const { mergedMs } of got.merges) {
    for (const [a, b] of waits) if (mergedMs > a && mergedMs <= b) parts.push([a, mergedMs]);
  }
  return total(minus(union(parts), busy));
}

/** No ticket and no Epic: the lookups of a hub without Jira, or of a caller that does not need them. */
const NO_TICKETS = Object.freeze({ stories: new Map(), epics: new Map() });

/**
 * A command record's waits, from its run's time file, moved apart: `gate_wait_s`, the part that a
 * gate counts, and `wait_s`, the rest. The busy time, the whole and the unexplained part stay.
 */
function splitWaits(record, run, dir, trunk) {
  let times = null;
  try { times = run ? loadTimeRun(dir, run.run_id) : null; } catch { times = null; }
  const started = Date.parse(record.started_at);
  const ended = Date.parse(record.ended_at);
  const waits = (times?.waits || []).map(([a, b]) => [Math.max(a, started), Math.min(b, ended)]).filter(([a, b]) => b > a);
  const overlap = gateOverlap(keyOf(record), waits, union(times?.work || []), trunk);
  if (overlap === null) return { gate_wait_s: null };
  const gateWait = Math.min(secs(overlap), record.wait_s);
  return { gate_wait_s: gateWait, wait_s: secs(record.wait_s * 1000 - gateWait * 1000) };
}

/** A wait in a session: the part of it that a gate counts. Null while git cannot say. */
function sessionGateWait(record, trunk) {
  const wait = [[Date.parse(record.started_at), Date.parse(record.ended_at)]];
  const overlap = gateOverlap(keyOf(record), wait, [], trunk);
  return { gate_wait_s: overlap === null ? null : secs(overlap) };
}

/**
 * The record as it leaves: its key, its feature, its Jira ticket and Epic, its bucket, its price, and
 * a command's pickup and gate wait filled in. Null while it waits for its key, while its run has none
 * and has not ended. A record waits 24 hours at most. It never waits for a ticket: a story with no
 * ticket on the trunk yet leaves with none, and a view takes the URL from another record of the story.
 */
export function prepare(entry, { dir, features, tickets = NO_TICKETS, prices, now, trunk = null }) {
  const record = { ...entry.record };
  const local = entry.local || {};
  const binding = local.binding ? bindingQuiet(dir, local.binding) : null;
  const run = binding ? runById(binding, local.run_id) : null;
  const young = now - (local.created_ms ?? now) < HOLD_MS;
  if (run) {
    record.story = record.story ?? run.story ?? null;
    record.feature = record.feature ?? run.feature ?? null;
    if (missingKey(run, record) && run.ended_ms == null && young) return null;
  }
  if (record.story && !record.feature) record.feature = features.get(record.story) ?? null;
  record.ticket_url = (record.story && tickets.stories.get(record.story)) || null;
  const epic = (record.feature && tickets.epics.get(record.feature)) || null;
  record.epic = epic ? epic.key : null;
  record.epic_url = epic ? epic.url : null;
  if (record.type === 'tokens') {
    record.price_table = prices.version;
    record.cost_usd = costOf(prices, record);
  }
  if (record.type === 'command') Object.assign(record, pickupOf(record, trunk), splitWaits(record, run, dir, trunk));
  // A person can merge while the session waits for their reply. The gate's record counts that time.
  if (record.type === 'wait-in-session') Object.assign(record, sessionGateWait(record, trunk));
  return leaving(record, bucketOf(record, run));
}

function move(dir, entry, folder, extra) {
  const id = entry.record.record_id;
  writeJson(join(folders(dir)[folder], `${id}.json`), extra);
  rmSync(join(folders(dir).queue, `${id}.json`), { force: true });
}

function backOff(dir, statePath, st, out, now, why) {
  const failures = (st.failures || 0) + 1;
  const wait = Math.min(FIRST_WAIT_MS * 2 ** (failures - 1), LONGEST_WAIT_MS);
  // An earlier batch of this drain may have gone out before the failure.
  writeJson(statePath, { ...st, failures, next_ms: now + wait, last_sent_ms: out.sent ? now : (st.last_sent_ms ?? null), why });
  logLine(dir, 'WARN', `nothing more was sent: ${why}. The next try waits ${Math.round(wait / 1000)} s`);
  return { ...out, code: EXIT.CANNOT_VERIFY, reason: 'platform-unreachable', why };
}

function pruneSent(dir) {
  const sent = folders(dir).sent;
  if (!existsSync(sent)) return;
  const cutoff = Date.now() - KEEP_SENT_MS;
  for (const name of readdirSync(sent)) {
    const p = join(sent, name);
    try { if (statSync(p).mtimeMs < cutoff) rmSync(p, { force: true }); } catch { /* gone already */ }
  }
}

/**
 * The records ready to go, each prepared, and the counts of those held or refused before the send.
 * `seen` holds the ids that an earlier pass of this sender already handled, so a held record counts once.
 */
function gather(ctx, prices, now, out, trunk, seen) {
  const features = featuresOnTrunk(ctx.main);
  const tickets = ticketsOnTrunk(ctx.main);
  const unpriced = new Set();
  const batch = [];
  for (const entry of readyRecords(ctx.dir)) {
    if (seen.has(entry.record.record_id)) continue;
    seen.add(entry.record.record_id);
    const record = prepare(entry, { dir: ctx.dir, features, tickets, prices, now, trunk });
    if (!record) { out.held += 1; continue; }
    const problems = validateRecord(record);
    if (problems.length) {
      move(ctx.dir, entry, 'refused', { record, status: null, answer: `the record breaks the record rules: ${problems.join(' · ')}`, refused_ms: now });
      out.refused += 1;
      continue;
    }
    if (record.type === 'tokens' && record.cost_usd === null) unpriced.add(`${record.model_provider}/${record.model}`);
    batch.push({ entry, record });
  }
  for (const m of unpriced) logLine(ctx.dir, 'WARN', `no list price for ${m}, so its records carry no cost`);
  return batch;
}

/**
 * A 4xx answer refuses the records, except 408 and 429, which ask the sender to try again later. A wrong
 * URL or key (wrongSetup) is checked first, and keeps the records.
 */
const isRefusal = (status) => status >= 400 && status < 500 && status !== 408 && status !== 429;

/** Why the answer says the URL or the key is wrong, not the records. Null when it does not. */
function wrongSetup(platform, status, answer) {
  if (status === 401 || status === 403) {
    return `the observability platform answered ${status}, so it did not accept the request's authorisation. Check "auth" in docs/estate/observability.json, HARNESS_OBSERVABILITY_TOKEN, and the key its receiver expects`;
  }
  const wrongPath = status === 404 || (typeof platform.isWrongPath === 'function' && platform.isWrongPath(status, answer));
  return wrongPath ? `the URL in docs/estate/observability.json answered ${status}, so it does not lead to the observability platform's receiver` : null;
}

/** The error codes that say Node does not trust the certificate chain. */
const CERTIFICATE_CODES = new Set(['SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'DEPTH_ZERO_SELF_SIGNED_CERT']);
const ERROR_CODE = /^[A-Z][A-Z0-9_]{1,63}$/;

/** Why a request got no answer, with the cause's error code when there is one. */
function connectionFailure(err) {
  if (err?.name === 'TimeoutError') return 'the request reached its time limit';
  const cause = err?.cause;
  const raw = cause?.code ?? cause?.errors?.[0]?.code;
  const code = typeof raw === 'string' && raw.search(ERROR_CODE) === 0 ? raw : null;
  if (!code) return 'the observability platform could not be reached';
  if (!CERTIFICATE_CODES.has(code)) return `the observability platform could not be reached: ${code}`;
  return `the observability platform could not be reached: ${code}. Node does not trust the certificate chain. Behind a TLS inspection proxy, the sender needs NODE_USE_SYSTEM_CA=1`;
}

/** True when the answer is a web page: an HTML content type, or a body that opens as an HTML document. */
function isWebPage(res, answer) {
  const type = (res.headers.get('content-type') || '').toLowerCase();
  const start = answer.trimStart().slice(0, 15).toLowerCase();
  return type.startsWith('text/html') || start.startsWith('<!doctype html') || start.startsWith('<html');
}
const WEB_PAGE = 'the URL in docs/estate/observability.json answered with a web page, so it does not lead to the observability platform\'s receiver';

/**
 * Posts one batch of records to the hub's observability platform, in one request with a time limit.
 * Returns { accepted: true }, { refused: { status, answer } }, or { retry: why } when the request
 * should be tried again later. The laptop's sender and the gate workflow's script both use it.
 */
export async function post(records, { connection, hub, token, fetchImpl = globalThis.fetch, now = nowMs() }) {
  const platform = PLATFORMS[connection.platform];
  const req = platform.request(records, { url: connection.url, hub, token, sendMs: now });
  let res;
  try {
    res = await fetchImpl(req.url, { method: 'POST', headers: req.headers, body: req.body, signal: AbortSignal.timeout(requestTimeout()) });
  } catch (err) {
    return { retry: connectionFailure(err) };
  }
  const answer = await res.text().catch(() => '');
  // A misrouted URL can answer 200 with a web interface's page. Counting that as accepted would lose the records.
  if (res.ok && isWebPage(res, answer)) return { retry: WEB_PAGE };
  if (res.ok) return { accepted: true };
  const wrong = wrongSetup(platform, res.status, answer);
  if (wrong) return { retry: wrong };
  if (!isRefusal(res.status)) return { retry: `the observability platform answered ${res.status}` };
  return { refused: { status: res.status, answer: answer.slice(0, 300) } };
}

/**
 * Sends one batch. The records move to sent/ or refused/ by the observability platform's answer.
 * Returns the reason to stop and try again later, or null.
 */
async function sendBatch(ctx, part, { token, fetchImpl, now }, out) {
  const got = await post(part.map((p) => p.record), { connection: ctx.connection, hub: ctx.hub, token, fetchImpl, now });
  if (got.retry) return got.retry;
  if (got.accepted) {
    for (const p of part) move(ctx.dir, p.entry, 'sent', { record: p.record, sent_ms: now });
    out.sent += part.length;
    return null;
  }
  for (const p of part) move(ctx.dir, p.entry, 'refused', { record: p.record, status: got.refused.status, answer: got.refused.answer, refused_ms: now });
  out.refused += part.length;
  return null;
}

/** Sends a batch in requests of BATCH records at most. Returns the reason to stop and try again later, or null. */
async function sendAll(ctx, batch, send, out) {
  for (let i = 0; i < batch.length; i += BATCH) {
    const why = await sendBatch(ctx, batch.slice(i, i + BATCH), send, out);
    if (why) return why;
  }
  return null;
}

async function drainLocked(ctx, { token, fetchImpl, prices }) {
  const now = nowMs();
  const statePath = join(ctx.dir, 'send-state.json');
  const st = readJson(statePath, { failures: 0, next_ms: 0 });
  const out = { code: EXIT.PASS, sent: 0, refused: 0, held: 0 };
  if (st.next_ms && now < st.next_ms) return { ...out, waiting_until: st.next_ms };
  const send = { token, fetchImpl, now };
  const trunk = openTrunk(ctx.main);
  // A hook can queue a record while this sender sends. The sender that the hook starts then finds the
  // lock held and returns at once. So this sender collects the queue again after each send.
  const seen = new Set();
  for (let pass = 0; pass < PASSES; pass += 1) {
    const batch = gather(ctx, prices, pass ? nowMs() : now, out, trunk, seen);
    if (!batch.length) break;
    const why = await sendAll(ctx, batch, send, out);
    if (why) return backOff(ctx.dir, statePath, st, out, now, why);
  }
  writeJson(statePath, { failures: 0, next_ms: 0, last_sent_ms: out.sent ? now : (st.last_sent_ms ?? null) });
  pruneSent(ctx.dir);
  if (out.refused) out.code = EXIT.FAIL;
  return out;
}

/**
 * Sends what is ready. Returns { code, sent, refused, held, why, busy }. `start` is any folder of the
 * hub. Another sender that holds the lock makes this one return at once, with nothing sent.
 */
export async function drain({ start, token = process.env.HARNESS_OBSERVABILITY_TOKEN, fetchImpl = globalThis.fetch, prices = loadPrices() } = {}) {
  const ctx = hubContext(start);
  if (!ctx.ok) return { code: EXIT.CANNOT_VERIFY, reason: ctx.reason ?? null, why: ctx.why, sent: 0, refused: 0, held: 0 };
  const noToken = ctx.auth === 'bearer' && !token;
  const waiting = { code: EXIT.CANNOT_VERIFY, reason: 'credential-missing', why: NO_TOKEN, sent: 0, refused: 0, held: 0 };
  const release = tryLock(join(ctx.dir, 'send'));
  if (!release) return noToken ? waiting : { code: EXIT.PASS, busy: true, sent: 0, refused: 0, held: 0 };
  try {
    // The WARN line waits for the lock, so it never races a sender that writes send-state.json.
    if (noToken) {
      warnNoToken(ctx.dir, nowMs());
      return waiting;
    }
    // With "auth": "none" the token never leaves the laptop, even when HARNESS_OBSERVABILITY_TOKEN is set.
    return await drainLocked(ctx, { token: ctx.auth === 'none' ? null : token, fetchImpl, prices });
  } finally {
    release();
  }
}

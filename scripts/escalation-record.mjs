// Part of the harness asset library c6f3b4427d58f7c3 (see VERSION.json) · 2026-11-02
/**
 * escalation-record.mjs — the escalation record: its grammar, the rules a reader applies, the
 * state it derives, the ladder that the sweep follows, and the table `print` writes from it. No
 * git and no network, and no clock: every time is passed in, so a fixed clock proves the ladder.
 *
 * `escalation.mjs` imports this module, and so can any other reader of the record. The record of
 * one escalation is a JSON Lines file, the artifact `escalation-record.jsonl` on the escalation's
 * `[shl-harness]` issue in the hub (escalation-store.mjs). A reader takes the lines of one story or
 * feature, its key or slug, together. One line is one event. A writer only adds a line at the end,
 * and no line ever changes. `governance/escalation-record.schema.json` states the same format
 * for the dashboard, and `governance/escalation-points.json` lists the stop points.
 *
 * The reader rules (the feature's reference, section 3.3), each with the exit code it carries:
 *   - an unknown `schema_version` is refused                                         exit 1
 *   - a gap or a repeat in `seq` cannot be verified                                  exit 2
 *   - a line that is not one JSON object cannot be verified                          exit 2
 *   - `acknowledged`, `stopped` and `withdrawn` written by anything but a person     exit 1
 *   - a line after `resolved`, `stopped` or `withdrawn`                              exit 1
 *   - the state is the last state event: nothing stores it                           —
 *   - overdue is computed by the reader (the sweep) and never written                —
 *     An escalation is overdue when `at` of `raised` plus the wait of its path has
 *     passed, with no `acknowledged` since.
 * Every rule runs before the writer writes, so a bad record is never made worse.
 *
 * Node standard library only.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const SCHEMA_VERSION = 1;

export const EVENTS = ['raised', 'notified', 'reasked', 'acknowledged', 'handed-over', 'resumed', 'resolved', 'stopped', 'withdrawn'];
export const PERSON_EVENTS = ['acknowledged', 'stopped', 'withdrawn'];
export const FINAL_EVENTS = ['resolved', 'stopped', 'withdrawn'];
export const STATE_EVENTS = ['raised', 'acknowledged', ...FINAL_EVENTS];
export const WRITER_KINDS = ['seat', 'script', 'person'];
export const TRIGGERS = ['revision-cap', 'blocking-clarification', 'contradiction', 'control-undefined', 'cannot-verify', 'incident', 'handover', 'gate-waiting'];
export const PATHS = ['question', 'merge-waiting', 'review-cap', 'decision-owed', 'check-cannot-run', 'incident', 'handover'];
export const UPSTREAM_KINDS = ['design', 'tests', 'clarification', 'requirements'];
export const FACT_KINDS = ['verdict', 'exit', 'status', 'merge'];
// What a fact must read for the escalation to end. A resolution is a fact a script read.
export const FACT_VALUES = { verdict: 'APPROVED', exit: '0', status: 'Closed', merge: 'MERGED' };
export const SEVERITIES = ['CRITICAL', 'IMPORTANT', 'SUGGESTION'];

export const KEY_PATTERN = /^[A-Z][A-Z0-9]{1,9}-\d+$/;
export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ID_PATTERN = /^ESC-([A-Za-z0-9][A-Za-z0-9-]*)-(\d{2,})$/;
const AT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const HEX12 = /^[0-9a-f]{12}$/;

/** A reader rule that a line broke. `code` is the exit code: 1 refused, 2 cannot verify. */
export class RecordFault {
  constructor(code, text, line = null) { this.code = code; this.text = text; this.line = line; }
}

const has = (text, pattern) => typeof text === 'string' && text.search(pattern) !== -1;
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const nonEmpty = (v) => typeof v === 'string' && v.trim() !== '';

/* ------------------------------------------------------------------- the list of stop points */

let cachedPoints;
/** The list of stop points, read from governance/ beside this script in either layout. */
export function loadPoints() {
  if (!cachedPoints) {
    const doc = JSON.parse(readFileSync(fileURLToPath(new URL('../governance/escalation-points.json', import.meta.url)), 'utf8'));
    cachedPoints = { doc, byId: new Map(doc.points.map((p) => [p.id, p])) };
  }
  return cachedPoints;
}

/** The path a point follows, and the roles and wait of that path. `taken` names an alternative. */
export function routeOf(point, taken = null) {
  if (taken && taken !== point.path) {
    if (!point.alternative || point.alternative.path !== taken) return null;
    const alt = point.alternative;
    return { path: alt.path, trigger: alt.trigger, first: alt.first, next: alt.next, wait: alt.wait };
  }
  return { path: point.path, trigger: point.trigger, first: point.first, next: point.next, wait: point.wait };
}

/* ------------------------------------------------------------------------- names and ids */

export const escalationId = (owner, number) => `ESC-${owner}-${String(number).padStart(2, '0')}`;

/** `ESC-PROJ-421-01` → { owner: 'PROJ-421', number: 1 }, or null. */
export function parseId(id) {
  const m = typeof id === 'string' ? id.match(ID_PATTERN) : null;
  return m ? { owner: m[1], number: Number(m[2]) } : null;
}

/** The file name a work item or a feature owns: its key, or its slug before keys exist. */
export function ownerOf(workItem, slug) {
  if (workItem) return workItem;
  return slug || null;
}

export const isKey = (v) => has(v, KEY_PATTERN);
export const isSlug = (v) => has(v, SLUG_PATTERN);
export const isHex12 = (v) => has(v, HEX12);

/** Twelve hex characters of the SHA-256 of a text: the pin of a set that has no blob. */
export function pinOf(text) {
  return createHash('sha256').update(text).digest('hex').slice(0, 12);
}

/** `2026-10-29T14:02:11Z` from a Date or a millisecond count. */
export function stamp(when) {
  return new Date(when).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/* ------------------------------------------------------------------------ line grammar */

function whoWrote(by) {
  if (!isObject(by)) return 'by must be an object';
  if (!WRITER_KINDS.includes(by.kind)) return `by.kind must be one of ${WRITER_KINDS.join(', ')}`;
  if (by.kind === 'person' && !nonEmpty(by.role)) return 'a person line carries by.role';
  if (by.kind !== 'person' && !nonEmpty(by.name)) return `a ${by.kind} line carries by.name`;
  return null;
}

// The keys that each event needs beyond the six every line carries. Returns problems.
function eventProblems(obj, point) {
  const out = [];
  const need = (cond, text) => { if (!cond) out.push(text); };
  switch (obj.event) {
    case 'raised': {
      need(TRIGGERS.includes(obj.trigger), `trigger must be one of ${TRIGGERS.join(', ')}`);
      need(point !== undefined, `point ${JSON.stringify(obj.point)} is not in the list of stop points`);
      need(PATHS.includes(obj.path), `path must be one of ${PATHS.join(', ')}`);
      need(obj.path !== 'question', 'the question path writes no line: the command waits in the session');
      need(obj.work_item === null || isKey(obj.work_item), 'work_item is a key or null');
      need(isSlug(obj.slug), 'slug is the feature\'s slug');
      need(obj.repository === null || nonEmpty(obj.repository), 'repository is a repository id or null');
      need(obj.runner === null || nonEmpty(obj.runner), 'runner is a forge login or null');
      need(isObject(obj.route) && nonEmpty(obj.route.first) && (obj.route.next === null || nonEmpty(obj.route.next)), 'route carries first and next');
      need(obj.parked === null || (isObject(obj.parked) && (obj.parked.ref === null || nonEmpty(obj.parked.ref)) && (obj.parked.commit === null || isHex12(obj.parked.commit))), 'parked is null, or carries ref and a 12-hex commit');
      need(nonEmpty(obj.question) && !has(obj.question, /[\r\n]/), 'question is one line');
      need(obj.findings === null || nonEmpty(obj.findings), 'findings is a path or null');
      need(isObject(obj.links), 'links is an object');
      need(isHex12(obj.hub_commit), 'hub_commit is 12 hex characters');
      if (obj.path === 'incident') need(obj.findings === null, 'an incident never carries findings: the record holds where it is, never the secret or the data');
      if (point && obj.path !== 'question' && PATHS.includes(obj.path)) {
        need(obj.path === point.path || (point.alternative && point.alternative.path === obj.path), `point ${point.id} follows ${point.path}${point.alternative ? ` or ${point.alternative.path}` : ''}, not ${obj.path}`);
      }
      break;
    }
    case 'notified':
    case 'reasked':
      need(nonEmpty(obj.to), 'to names who was told');
      need(nonEmpty(obj.channel), 'channel names the channel used');
      break;
    case 'handed-over':
      need(nonEmpty(obj.to), 'to names the role the item went to');
      break;
    case 'acknowledged':
      break;
    case 'resumed':
      if (obj.upstream !== undefined) {
        const u = obj.upstream;
        need(isObject(u) && UPSTREAM_KINDS.includes(u.what), `upstream.what must be one of ${UPSTREAM_KINDS.join(', ')}`);
        need(isObject(u) && isHex12(u.from) && isHex12(u.to), 'upstream.from and upstream.to are 12 hex characters');
        need(isObject(u) && u.from !== u.to, 'upstream.from and upstream.to are the same: nothing changed');
        need(!isObject(u) || u.pr === undefined || nonEmpty(u.pr), 'upstream.pr is a link');
      }
      break;
    case 'resolved': {
      const f = obj.fact;
      need(isObject(f) && FACT_KINDS.includes(f.kind), `fact.kind must be one of ${FACT_KINDS.join(', ')}`);
      if (isObject(f) && FACT_KINDS.includes(f.kind)) need(String(f.value) === FACT_VALUES[f.kind], `a ${f.kind} fact that ends an escalation reads ${FACT_VALUES[f.kind]}, not ${JSON.stringify(f.value)}`);
      need(!isObject(f) || f.round === undefined || Number.isInteger(f.round), 'fact.round is a whole number');
      break;
    }
    case 'stopped':
    case 'withdrawn':
      need(nonEmpty(obj.reason), 'reason is the person\'s own words');
      break;
    default:
  }
  return out;
}

/* --------------------------------------------------------------------------- the reader */

/**
 * Read one record file. `owner` is the file's key or slug. Returns the escalations it holds, in
 * order of first line, and every fault found. A fault in one escalation never hides another.
 *
 *   escalation: { id, number, lines: [obj], raised, last, state, point, path, ... }
 *   fault:      { code, text, line }
 */
export function readRecord(owner, text) {
  const faults = [];
  const byId = new Map();
  const order = [];
  const rows = String(text || '').split('\n');
  if (rows.length && rows[rows.length - 1] === '') rows.pop();
  const { byId: points } = loadPoints();
  rows.forEach((raw, i) => {
    const n = i + 1;
    const fault = (code, why) => faults.push(new RecordFault(code, `line ${n}: ${why}`, n));
    let obj;
    try { obj = JSON.parse(raw); } catch { fault(2, 'is not JSON, so the record cannot be verified'); return; }
    if (!isObject(obj)) { fault(2, 'is not one JSON object, so the record cannot be verified'); return; }
    if (obj.schema_version !== SCHEMA_VERSION) { fault(1, `schema_version ${JSON.stringify(obj.schema_version)} is unknown. This reader knows ${SCHEMA_VERSION}, and it does not guess`); return; }
    const parsed = parseId(obj.id);
    if (!parsed) { fault(2, `id ${JSON.stringify(obj.id)} is not ESC-<key or slug>-<number>`); return; }
    if (parsed.owner !== owner) { fault(1, `id ${obj.id} belongs to ${parsed.owner}, not to ${owner}`); return; }
    if (!Number.isInteger(obj.seq) || obj.seq < 1) { fault(2, `seq ${JSON.stringify(obj.seq)} is not a whole number from 1`); return; }
    if (!EVENTS.includes(obj.event)) { fault(1, `event ${JSON.stringify(obj.event)} is not one of ${EVENTS.join(', ')}`); return; }
    if (typeof obj.at !== 'string' || !has(obj.at, AT_PATTERN)) { fault(1, `at ${JSON.stringify(obj.at)} is not a UTC time such as 2026-10-29T14:02:11Z`); return; }
    const writer = whoWrote(obj.by);
    if (writer) { fault(1, `${obj.id} seq ${obj.seq}: ${writer}`); return; }

    let esc = byId.get(obj.id);
    if (!esc) {
      esc = { id: obj.id, owner, number: parsed.number, lines: [], raised: null, last: null, state: null };
      byId.set(obj.id, esc);
      order.push(esc);
    }
    const expected = esc.lines.length + 1;
    if (obj.seq !== expected) { fault(2, `${obj.id} has seq ${obj.seq} where ${expected} is next: ${obj.seq > expected ? 'a line is missing' : 'a line repeats'}, so the state of ${obj.id} cannot be verified`); esc.broken = true; return; }
    if (esc.lines.length === 0 && obj.event !== 'raised') { fault(1, `${obj.id} starts with ${obj.event}: an escalation starts with raised`); esc.broken = true; return; }
    if (esc.lines.length > 0 && obj.event === 'raised') { fault(1, `${obj.id} has a second raised line: a new stop on the same work is a new id`); esc.broken = true; return; }
    if (esc.last && FINAL_EVENTS.includes(esc.last.event)) { fault(1, `${obj.id} seq ${obj.seq} comes after ${esc.last.event}: resolved, stopped and withdrawn end an escalation, and a new stop on the same work is a new id`); esc.broken = true; return; }
    if (PERSON_EVENTS.includes(obj.event) && obj.by.kind !== 'person') { fault(1, `${obj.id} seq ${obj.seq}: ${obj.event} was written by a ${obj.by.kind}. An agent never acknowledges, stops or withdraws its own escalation`); esc.broken = true; return; }
    const point = obj.event === 'raised' ? points.get(obj.point) : esc.raised ? points.get(esc.raised.point) : undefined;
    const problems = eventProblems(obj, point);
    if (problems.length) { fault(1, `${obj.id} seq ${obj.seq} (${obj.event}): ${problems.join('. ')}`); esc.broken = true; return; }

    esc.lines.push(obj);
    esc.last = obj;
    if (obj.event === 'raised') esc.raised = obj;
  });

  // An escalation whose first line was refused has no line to show: the fault says why.
  for (let i = order.length - 1; i >= 0; i -= 1) if (order[i].lines.length === 0) order.splice(i, 1);
  for (const esc of order) {
    esc.point = esc.raised ? esc.raised.point : null;
    esc.path = esc.raised ? esc.raised.path : null;
    esc.state = stateOf(esc);
  }
  return { escalations: order, faults };
}

/** open, acknowledged, resolved, stopped or withdrawn: the last state event, never a stored field. */
export function stateOf(esc) {
  let state = null;
  for (const line of esc.lines) if (STATE_EVENTS.includes(line.event)) state = line.event === 'raised' ? 'open' : line.event === 'acknowledged' ? 'acknowledged' : line.event;
  return state;
}

export const isFinal = (esc) => esc.state === 'resolved' || esc.state === 'stopped' || esc.state === 'withdrawn';

/**
 * An escalation whose last line is `resumed`, and which a later escalation of the same work and
 * point has replaced: the re-run reached the cap again. Derived by the reader, never written.
 */
export function supersededBy(escalations, esc) {
  if (isFinal(esc) || !esc.last || esc.last.event !== 'resumed') return null;
  return escalations.find((other) => other.number > esc.number && other.raised && esc.raised
    && other.raised.point === esc.raised.point && other.raised.slug === esc.raised.slug && other.raised.work_item === esc.raised.work_item) || null;
}

/** The exit code a list of faults asks for: 0 none, 1 refused, 2 cannot verify. */
export function faultCode(faults) {
  return faults.reduce((code, f) => Math.max(code, f.code), 0);
}

/**
 * Validate a record that already holds `existing` and is about to hold `line` as well. Returns
 * the new text and every fault of the whole file, so a writer never makes a bad record worse.
 */
export function appendLine(owner, existing, line) {
  const base = existing && !existing.endsWith('\n') && existing !== '' ? `${existing}\n` : existing || '';
  const text = `${base}${JSON.stringify(line)}\n`;
  return { text, ...readRecord(owner, text) };
}

/** The escalation with this id, from every file the reader holds, or undefined. */
export const findEscalation = (escalations, id) => escalations.find((e) => e.id === id);


/* ------------------------------------------------------------------ working time */

// The recipient's working day is the hub's: one time zone, one day start and end, five days.
// UNRESOLVED — whose working day each recipient has, and the hub's holidays. Owner: delivery
// lead. Resolves: docs/harness-decisions.md names the time zone and the day, as decision 7 names roles.


export const DEFAULT_CONFIG = { tz: 'UTC', dayEnd: '17:00', workDays: [1, 2, 3, 4, 5] };
const MIN = 60000;

const FORMATS = new Map();
function zoneParts(ms, tz) {
  let f = FORMATS.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    FORMATS.set(tz, f);
  }
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { y: Number(p.year), m: Number(p.month), d: Number(p.day), h: Number(p.hour), min: Number(p.minute) };
}

/** The instant at which a wall clock in `tz` reads y-m-d hh:mm. */
function zonedMs(y, m, d, hh, mm, tz) {
  const wall = Date.UTC(y, m - 1, d, hh, mm);
  let guess = wall;
  for (let i = 0; i < 3; i += 1) {
    const p = zoneParts(guess, tz);
    const diff = Date.UTC(p.y, p.m - 1, p.d, p.h, p.min) - wall;
    if (diff === 0) break;
    guess -= diff;
  }
  return guess;
}

const clock = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return { h, m }; };
const civil = (ms, tz) => { const p = zoneParts(ms, tz); return { y: p.y, m: p.m, d: p.d }; };
const addDays = (c, n) => { const t = new Date(Date.UTC(c.y, c.m - 1, c.d + n)); return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() }; };
const weekday = (c) => new Date(Date.UTC(c.y, c.m - 1, c.d)).getUTCDay();
const isWorking = (c, cfg) => cfg.workDays.includes(weekday(c));
const nextWorking = (c, cfg) => { let n = addDays(c, 1); while (!isWorking(n, cfg)) n = addDays(n, 1); return n; };
const endOf = (c, cfg) => { const k = clock(cfg.dayEnd); return zonedMs(c.y, c.m, c.d, k.h, k.m, cfg.tz); };

/**
 * When the wait of a path ends, counted from `from` (milliseconds). Null where the wait has no end
 * the clock can name: the standing sweep, and a path with no wait.
 */
export function waitEnds(from, wait, cfg = DEFAULT_CONFIG) {
  if (wait === 'sixty-minutes') return from + 60 * MIN;
  const c = civil(from, cfg.tz);
  if (wait === 'same-working-day') {
    // The end of the working day the stop falls in, or 2 hours after it, whichever is later.
    const day = isWorking(c, cfg) && from < endOf(c, cfg) ? c : nextWorking(c, cfg);
    return Math.max(endOf(day, cfg), from + 120 * MIN);
  }
  if (wait === 'next-working-day') return endOf(nextWorking(c, cfg), cfg);
  return null;
}

/* ------------------------------------------------------------------------- the ladder */

export const ROLE_SEPARATOR = ', ';
/** `security role on call, data officer` → two roles. Null is no role. */
export const splitRoles = (value) => (value ? String(value).split(ROLE_SEPARATOR).map((r) => r.trim()).filter(Boolean) : []);
export const DELIVERY_LEAD = 'delivery lead';
export const SWEEP_CHANNEL = 'issue';
const TOLD = ['notified', 'reasked', 'handed-over'];

/**
 * What the sweep owes one live escalation at `now` (milliseconds). The ladder is the same on every
 * path, and only the people and the wait change:
 *   1. at the stop, the run tells the runner (the `notified` line `raise` writes), and the sweep
 *      tells each other first role that nobody told yet;
 *   2. when the first wait ends with no acknowledgement, the sweep asks the first roles and the
 *      runner again (`reasked`), and tells the next roles (`notified`);
 *   3. when the second wait ends, the sweep tells the delivery lead. It sends nothing after that.
 * An acknowledgement stops the ladder. The escalation then comes up once at each standing sweep,
 * and so does a handover, whose only wait is the next standing sweep. A missed wait tells more
 * people and never lets the work continue.
 *
 * Returns { state, overdue, first, second, actions: [{ event, to, why }] }. It writes nothing.
 */
export function planLadder(esc, nowMs, cfg = DEFAULT_CONFIG, { standing = false } = {}) {
  const r = esc.raised;
  const point = loadPoints().byId.get(r.point);
  const route = point ? routeOf(point, r.path) : null;
  const wait = route ? route.wait : 'none';
  const ack = [...esc.lines].reverse().find((l) => l.event === 'acknowledged') || null;
  const told = (to) => esc.lines.some((l) => TOLD.includes(l.event) && l.to === to);
  const first = splitRoles(r.route.first);
  const next = splitRoles(r.route.next);
  const raisedMs = Date.parse(r.at);
  const d1 = waitEnds(raisedMs, wait, cfg);
  const d2 = d1 === null ? null : waitEnds(d1, wait, cfg);
  const actions = [];
  const add = (event, to, why) => { if (!actions.some((a) => a.event === event && a.to === to)) actions.push({ event, to, why }); };

  if (!ack) {
    for (const role of first) if (role !== 'runner' && !told(role)) add(r.path === 'handover' ? 'handed-over' : 'notified', role, 'the first role');
    const askedAgain = esc.lines.some((l) => l.event === 'reasked' && (!ack || l.seq < ack.seq));
    if (d1 !== null && nowMs >= d1 && !askedAgain) {
      for (const role of [...first, 'runner']) add('reasked', role, 'the first wait ended with no answer');
      for (const role of next) if (!told(role)) add('notified', role, 'the first wait ended with no answer');
    }
    if (d2 !== null && nowMs >= d2 && !told(DELIVERY_LEAD)) add('notified', DELIVERY_LEAD, 'the second wait ended with no answer');
  }
  if (standing) {
    const today = civil(nowMs, cfg.tz);
    const key = (ms) => { const c = civil(ms, cfg.tz); return `${c.y}-${c.m}-${c.d}`; };
    const remindedToday = (to) => esc.lines.some((l) => l.event === 'reasked' && l.to === to && l.channel === SWEEP_CHANNEL && key(Date.parse(l.at)) === `${today.y}-${today.m}-${today.d}` && (ack ? l.seq > ack.seq : r.path === 'handover'));
    if (ack) {
      const to = ack.by.role;
      if (!remindedToday(to)) add('reasked', to, 'an acknowledged escalation comes up at each standing sweep');
    } else if (r.path === 'handover') {
      for (const role of first) if (role !== 'runner' && !remindedToday(role) && told(role)) add('reasked', role, 'a handover comes up at each standing sweep');
    }
  }
  return {
    state: ack ? 'acknowledged' : 'open',
    overdue: !ack && d2 !== null && nowMs >= d2,
    first: d1, second: d2, actions,
  };
}

/* -------------------------------------------------------------------------- the view */

const TRIGGER_LABEL = {
  'revision-cap': 'Revision cap reached',
  'blocking-clarification': 'Blocking clarification',
  contradiction: 'Source contradiction',
  'control-undefined': 'Undefined control',
  'cannot-verify': 'Cannot verify',
  incident: 'Incident',
  handover: 'Handover',
  'gate-waiting': 'Gate waiting too long',
};
export const triggerLabel = (t) => TRIGGER_LABEL[t] || t;

const cell = (v) => String(v ?? '').replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();

/**
 * The § Escalation record table of docs/designs/CLAR-log.md, as a view of the lines: one row for
 * each escalation, Date | Trigger | Work item | Detail | Notified via | Acknowledged | Answered.
 * Nobody edits the table. `Notified via` lists the channels the lines name, never "escalated".
 */
export function renderTable(escalations) {
  const head = ['| Date | Trigger | Work item | Detail | Notified via | Acknowledged | Answered |', '|---|---|---|---|---|---|---|'];
  const rows = escalations.filter((e) => e.raised).map((e) => {
    const r = e.raised;
    const channels = [...new Set(e.lines.filter((l) => l.event === 'notified' || l.event === 'reasked').map((l) => l.channel))];
    const ack = e.lines.find((l) => l.event === 'acknowledged');
    const end = e.lines.find((l) => FINAL_EVENTS.includes(l.event));
    const answered = end ? (end.event === 'resolved' ? end.at : `${end.event} ${end.at}`) : '';
    const state = supersededBy(escalations, e) ? 'superseded' : e.state;
    return `| ${cell(r.at.slice(0, 10))} | ${cell(triggerLabel(r.trigger))} | ${cell(r.work_item || r.slug)} | ${cell(`${e.id} at ${r.point} (${state}): ${r.question}`)} | ${cell(channels.join(' + '))} | ${cell(ack ? ack.at : '')} | ${cell(answered)} |`;
  });
  return [...head, ...rows].join('\n');
}

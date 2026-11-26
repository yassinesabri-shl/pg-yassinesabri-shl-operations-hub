// Part of the harness asset library c6f3b4427d58f7c3 (see VERSION.json) · 2026-10-26
/**
 * common.mjs — the constants and the small helpers that every part of observability shares: the
 * collector adapters, the hook, the sender and the status command.
 *
 * In a hub, the user guide `docs/harness-observability.md` says what is collected, what never
 * leaves the laptop, and where the state is kept.
 *
 * Node standard library only.
 */
import { createHash } from 'node:crypto';

export { EXIT, REASONS, credentialInUrl, reasonIn, reasonLine } from '../spoke-remote.mjs';

/** The record form. It changes only when a field changes its meaning. */
export const SCHEMA = 'harness-observability/1';
/** The state folder, relative to the hub's main checkout. Git must ignore it. */
export const STATE_DIR = '.harness/observability';
/** The hub's connection to its observability platform. A hub without it collects nothing. */
export const CONNECTION_PATH = 'docs/estate/observability.json';
/** The hub's list of seats. A sub-agent that is not on it is not the harness's. */
export const REGISTRY_PATH = 'governance/agent-registry.json';
/** The install receipt, which names the library commit the hub came from. */
export const RECEIPT_PATH = 'docs/harness-install.json';
/** The name every record of a main session carries in `agent`: the session that dispatches the seats. */
export const ORCHESTRATOR = 'orchestrator';
/** The name every record of a subagent that the runtime ships carries in `agent`, such as Claude Code's `Explore`. */
export const RUNTIME_AGENT = 'runtime-agent';
/**
 * The name of a subagent that is neither a harness seat nor one of the runtime's own agents. A
 * person's own agents get it, so that no name from a person's settings leaves the laptop.
 */
export const OTHER_AGENT = 'other-agent';

/** The work-item key, the constant the gate and the fixtures share (generation.md §3.2). */
export const KEY_PATTERN = /^[A-Z][A-Z0-9]{1,9}-\d+$/;
/** A feature's slug: kebab-case, as /feature mints it. */
export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** The token counts every call carries once an adapter has mapped it, in record order. */
export const COUNTS = ['input', 'cache_read', 'cache_write', 'cache_write_5m', 'cache_write_1h', 'output', 'reasoning'];
/** The counts a runtime may not report. They stay null, never 0, when it does not. */
export const OPTIONAL_COUNTS = new Set(['cache_write_5m', 'cache_write_1h', 'reasoning']);

export const isKey = (text) => typeof text === 'string' && text.search(KEY_PATTERN) === 0;
export const isSlug = (text) => typeof text === 'string' && text.length <= 80 && text.search(SLUG_PATTERN) === 0;

/** A Jira issue key, as `tracker-links.schema.json` gives a ticket: a project key, a dash and a number. */
export const JIRA_KEY_PATTERN = /^[A-Z][A-Z0-9_]+-[1-9][0-9]*$/;
/** A Jira site: a bare host name, as `trackers.schema.json` gives `site`. */
export const SITE_PATTERN = /^(?=.{4,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,}$/;
/** The one shape of a ticket's URL on a record: a lowercase site, `/browse/` and the Jira key, and nothing else. */
const TICKET_URL_PATTERN = /^https:\/\/((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,})\/browse\/([A-Z][A-Z0-9_]+-[1-9][0-9]*)$/;

export const isJiraKey = (text) => typeof text === 'string' && text.length <= 64 && text.search(JIRA_KEY_PATTERN) === 0;
export const isSite = (text) => typeof text === 'string' && text.search(SITE_PATTERN) === 0;
export const isTicketUrl = (text) => {
  if (typeof text !== 'string' || text.length > 400) return false;
  const m = text.match(TICKET_URL_PATTERN);
  return Boolean(m) && m[1].length <= 253 && m[2].length <= 64;
};
/** The Jira key at the end of a ticket's URL, or null when the URL is not of the one shape. */
export const keyOfTicketUrl = (url) => (isTicketUrl(url) ? url.slice(url.lastIndexOf('/') + 1) : null);
/** The URL a person opens for the Jira key `key` on the site `site`, or null when either has the wrong shape. */
export function ticketUrl(site, key) {
  if (!isSite(site) || !isJiraKey(key)) return null;
  const url = `https://${site.toLowerCase()}/browse/${key}`;
  return isTicketUrl(url) ? url : null;
}

/** Now, in milliseconds. HARNESS_OBSERVABILITY_NOW (an ISO time) sets it, so the suites can move the clock. */
export function nowMs() {
  const fixed = process.env.HARNESS_OBSERVABILITY_NOW;
  if (fixed) {
    const t = Date.parse(fixed);
    if (!Number.isNaN(t)) return t;
  }
  return Date.now();
}

export const iso = (ms) => new Date(ms).toISOString();
/** Milliseconds as the seconds that a record carries, to the millisecond. */
export const secs = (ms) => Math.round(ms) / 1000;
export const sha256 = (text) => createHash('sha256').update(text).digest('hex');
/** A file name from any number of parts: never the parts themselves, which may hold a path. */
export const fileKey = (...parts) => sha256(parts.join('\u0000')).slice(0, 32);

/** A copy of counts with every field present: the optional ones null, the others 0. */
export function zeroCounts() {
  const out = {};
  for (const f of COUNTS) out[f] = OPTIONAL_COUNTS.has(f) ? null : 0;
  return out;
}

/** Counts read from anything: a missing or negative count is 0, or null where it is optional. */
export function cleanCounts(value) {
  const out = zeroCounts();
  for (const f of COUNTS) {
    const v = value ? value[f] : undefined;
    if (Number.isFinite(v) && v >= 0) out[f] = Math.round(v);
  }
  return out;
}

/** Every count of a call added up once: what "the largest total" compares. Reasoning is inside output. */
export const totalOf = (c) => (c.input || 0) + (c.cache_read || 0) + (c.cache_write || 0) + (c.output || 0);

/** Field by field, the larger of two counts. A count never goes back down once sent. */
export function maxCounts(a, b) {
  const out = zeroCounts();
  for (const f of COUNTS) {
    const x = a ? a[f] : null;
    const y = b ? b[f] : null;
    if (x === null && y === null) out[f] = OPTIONAL_COUNTS.has(f) ? null : 0;
    else out[f] = Math.max(x ?? 0, y ?? 0);
  }
  return out;
}

/** What `after` adds to `before`, field by field, never below 0. Null stays null where both are. */
export function diffCounts(after, before) {
  const out = zeroCounts();
  for (const f of COUNTS) {
    const a = after ? after[f] : null;
    const b = before ? before[f] : null;
    if (a === null && b === null) out[f] = OPTIONAL_COUNTS.has(f) ? null : 0;
    else out[f] = Math.max(0, (a ?? 0) - (b ?? 0));
  }
  return out;
}

export const isEmptyDiff = (d) => COUNTS.every((f) => !d[f]);

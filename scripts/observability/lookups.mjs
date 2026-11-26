// Part of the harness asset library c6f3b4427d58f7c3 (see VERSION.json) · 2026-10-26
/**
 * lookups.mjs — what a record takes from the hub's files:
 *
 *   - the feature of a story, from the folder of `docs/backlog/<SLUG>/<KEY>.item.md`
 *   - the Jira ticket of a story, as a URL, from the link file of its decomposition, or from the
 *     snapshot of a story that `/from-ticket` took in
 *   - the Jira Epic of a feature, as a key and a URL, from the feature's link file
 *
 * It reads the hub's trunk as the laptop last fetched it, `origin/<trunk>`, with git. It never
 * fetches, and it never reads the working tree. HARNESS_TRUNK names a trunk that is not `main`.
 * A lookup that finds nothing gives null, never a guess.
 *
 * Node standard library only, plus git.
 */
import { spawnSync } from 'node:child_process';
import { isKey, isSlug, ticketUrl } from './common.mjs';

/** The hub's Jira connection, its link files and its intake snapshots, as `jira-sync.mjs` and `check-intake.js` name them. */
const TRACKERS_PATH = 'docs/estate/trackers.json';
const LINKS_DIR = 'docs/estate/tracker-links';
const INTAKE_DIR = 'docs/backlog/jira';
/** A link file's `ticket` and `epic`: `<instance-id>:<JIRA-KEY>`, as `tracker-links.schema.json` gives them. */
const LINK_TICKET = /^([a-z][a-z0-9-]{0,19}):([A-Z][A-Z0-9_]+-[1-9][0-9]*)$/;
/** The snapshot's address line, as `check-intake.js` reads it. */
const SOURCE_LINE = /^Source:[ \t]*(\S.*?)\s*$/;
const FENCE = /^[ \t]{0,3}(`{3,}|~{3,})/;
const BIG = 64 * 1024 * 1024;

/** The trunk as this clone last fetched it: `origin/<trunk>`, or null when the clone has no such ref. */
export function trunkRef(main) {
  const named = process.env.HARNESS_TRUNK;
  const candidates = [];
  if (named) candidates.push(`origin/${named}`);
  const head = spawnSync('git', ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], { cwd: main, encoding: 'utf8' });
  if (!named && head.status === 0) candidates.push(head.stdout.trim());
  if (!named) candidates.push('origin/main');
  for (const ref of candidates) {
    const ok = spawnSync('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd: main, encoding: 'utf8' });
    if (ok.status === 0) return ref;
  }
  return null;
}

/** Every path under `dirs` on `ref`, or an empty list when git cannot say. */
function pathsOn(main, ref, dirs) {
  const r = spawnSync('git', ['ls-tree', '-r', '--name-only', ref, '--', ...dirs], { cwd: main, encoding: 'utf8', maxBuffer: BIG });
  return r.status === 0 ? r.stdout.split('\n').filter(Boolean) : [];
}

/** Every story's feature on the trunk, as a Map from key to slug. One git call for the whole drain. */
export function featuresOnTrunk(main) {
  const out = new Map();
  const ref = trunkRef(main);
  if (!ref) return out;
  for (const path of pathsOn(main, ref, ['docs/backlog/'])) {
    const m = path.match(/^docs\/backlog\/([^/]+)\/([^/]+)\.item\.md$/);
    if (m && isSlug(m[1]) && isKey(m[2]) && !out.has(m[2])) out.set(m[2], m[1]);
  }
  return out;
}

/** The text of each path on `ref`, in one git call. A path that is missing or not a file has no entry. */
function readOn(main, ref, paths) {
  const out = new Map();
  if (!paths.length) return out;
  const r = spawnSync('git', ['cat-file', '--batch'], { cwd: main, input: paths.map((p) => `${ref}:${p}\n`).join(''), maxBuffer: BIG });
  if (r.status !== 0 || !Buffer.isBuffer(r.stdout)) return out;
  const buf = r.stdout;
  let at = 0;
  for (const path of paths) {
    const end = buf.indexOf(0x0a, at);
    if (end < 0) break;
    const head = buf.subarray(at, end).toString('utf8').match(/^[0-9a-f]+ ([a-z]+) (\d+)$/);
    at = end + 1;
    if (!head) continue;
    const size = Number(head[2]);
    if (head[1] === 'blob') out.set(path, buf.subarray(at, at + size).toString('utf8'));
    at += size + 1;
  }
  return out;
}

const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** The JSON object in `text`, or null when the text is not one. */
function parseJson(text) {
  try {
    const value = JSON.parse(text);
    return isObject(value) ? value : null;
  } catch {
    return null;
  }
}

/** The URL of a link file's `<instance-id>:<JIRA-KEY>`, on the site that `trackers.json` gives the instance. */
function linkUrl(value, instances) {
  const m = typeof value === 'string' ? value.match(LINK_TICKET) : null;
  if (!m || !Object.hasOwn(instances, m[1]) || !isObject(instances[m[1]])) return null;
  const url = ticketUrl(instances[m[1]].site, m[2]);
  return url ? { key: m[2], url } : null;
}

/**
 * The URL of an intake snapshot's ticket: the host of its `Source:` line and the story's key, which
 * is the Jira key. The line's path, query and fragment never travel. The line inside a code fence
 * does not count, as `check-intake.js` masks it too.
 */
function intakeUrl(text, key) {
  let fenced = false;
  for (const line of text.split(/\r?\n/)) {
    if (line.search(FENCE) === 0) { fenced = !fenced; continue; }
    if (fenced) continue;
    const m = line.match(SOURCE_LINE);
    if (!m) continue;
    try {
      const address = new URL(m[1]);
      return address.protocol === 'https:' ? ticketUrl(address.hostname, key) : null;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * The Jira ticket of each story and the Jira Epic of each feature on the trunk:
 * `{ stories: Map<key, url>, epics: Map<slug, { key, url }> }`. Two git calls for the whole drain.
 *
 * A story's ticket comes from the link file of its decomposition first, on the site that
 * `trackers.json` gives the ticket's instance. A story that `/from-ticket` took in has no link file,
 * so its URL comes from the host of its snapshot's `Source:` line. A feature's Epic comes from its
 * link file. A defect's ticket does not count: a record names only its story's.
 */
export function ticketsOnTrunk(main) {
  const out = { stories: new Map(), epics: new Map() };
  const ref = trunkRef(main);
  if (!ref) return out;
  const links = [];
  const intake = [];
  for (const path of pathsOn(main, ref, [`${LINKS_DIR}/`, `${INTAKE_DIR}/`])) {
    let m = path.match(/^docs\/estate\/tracker-links\/([^/]+)\.json$/);
    if (m && isSlug(m[1])) { links.push({ path, slug: m[1] }); continue; }
    m = path.match(/^docs\/backlog\/jira\/([^/]+)\.ticket\.md$/);
    if (m && isKey(m[1])) intake.push({ path, key: m[1] });
  }
  if (!links.length && !intake.length) return out;
  const texts = readOn(main, ref, [TRACKERS_PATH, ...links.map((l) => l.path), ...intake.map((i) => i.path)]);
  const trackers = parseJson(texts.get(TRACKERS_PATH) ?? '');
  const instances = trackers && isObject(trackers.instances) ? trackers.instances : {};
  for (const { path, slug } of links) {
    const file = parseJson(texts.get(path) ?? '');
    if (!file) continue;
    const epic = linkUrl(file.epic, instances);
    if (epic && !out.epics.has(slug)) out.epics.set(slug, epic);
    const items = isObject(file.items) ? file.items : {};
    for (const [key, item] of Object.entries(items)) {
      if (!isKey(key) || out.stories.has(key) || !isObject(item) || item.type !== 'story') continue;
      const ticket = linkUrl(item.ticket, instances);
      if (ticket) out.stories.set(key, ticket.url);
    }
  }
  for (const { path, key } of intake) {
    if (out.stories.has(key)) continue;
    const url = intakeUrl(texts.get(path) ?? '', key);
    if (url) out.stories.set(key, url);
  }
  return out;
}

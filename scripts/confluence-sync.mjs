#!/usr/bin/env node
// Part of the harness asset library c6f3b4427d58f7c3 (see VERSION.json) · 2026-11-25
/**
 * confluence-sync.mjs — keep the harness copy of the ADRs and standards equal to Confluence (PLDC-712).
 *
 * Confluence is master. The sync reads the approved pages of one folder of the Key decisions tree
 * and writes an agent-readable summary of each into this repository, on one branch, for one pull
 * request that a person merges. It never writes to Confluence, and it never merges.
 *
 *   usage:  node scripts/confluence-sync.mjs plan     --level global|hub
 *           node scripts/confluence-sync.mjs apply    --level global|hub --out <dir>
 *           node scripts/confluence-sync.mjs discover --level global|hub [--draft] [--find-root]
 *
 *   discover  prove a connection: who the credential is, the space, the Key decisions folder, the
 *           run's folder and its "ADRs - …" and "standards - …" folders, and how many pages each
 *           holds. JSON on stdout, nothing written. --draft reads the connection from the working tree,
 *           for /connect-confluence before its pull request merges. --find-root lists the folders
 *           of the space titled "Key decisions", with their ids. Exit 0 when every folder is found,
 *           1 when one is missing (the output names it).
 *
 *   plan    what the sync would change, as JSON on stdout. Reads Confluence and the trunk, writes nothing.
 *   apply   the same, then writes the changes in a git worktree at <dir>/worktree on the branch
 *           context/confluence-sync, cut from the trunk, proves them with check-context.mjs, and commits
 *           them. It writes <dir>/result.json, <dir>/pr-body.md and <dir>/job-summary.md. It pushes
 *           nothing and opens no pull request: the context-sync workflow does both with gh.
 *   --level global   the run syncs Key decisions > global, in the global context repository.
 *   --level hub      the run syncs Key decisions > hubs > <HUB KEY>, in a hub. The key is the prefix of
 *                    the hub's key ledger, docs/backlog/keys.json.
 *
 * It reads, from this repository's trunk (never the working tree, after a force-fetch):
 *   docs/estate/confluence.json   the connection: { schema_version: 1, site, space, root_folder, mode }.
 *                                 A repository without the file has no sync: the run says so and exits 0.
 *   docs/architecture/, docs/standards/   the summaries there now.
 * And from the environment: CONFLUENCE_USER and CONFLUENCE_API_TOKEN, the read-only service account
 * (R-19). HARNESS_TRUNK names a trunk that is not `main`, and must match the remote's default branch.
 *
 * One problem never stops the run (principle 4): the page is skipped or listed, and the run goes on.
 * Only Confluence or git that cannot be reached stops it, and then it changes nothing (case 12).
 *
 * A run without --use-system-ca starts itself again once with it, so a proxy's root certificate in
 * the operating system's store is trusted (the laptop that /connect-confluence runs discover on).
 *
 * Exit codes: 0 the run finished, whatever it listed · 1 the connection file is not well formed, or
 * the hub has no key ledger · 2 cannot verify: Confluence, its credential, the remote or the trunk ·
 * 3 usage · 4 internal. Node standard library only, plus git.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfluenceError, createClient, EXIT, resolveRoot } from './confluence.mjs';
import { headerOf, judge, NO_LONGER, oneLine, summaryOf, withStatus } from './confluence-page.mjs';

const CONNECTION = 'docs/estate/confluence.json';
const KEYS = 'docs/backlog/keys.json';
const FOLDERS = { adr: 'docs/architecture', standard: 'docs/standards' };
export const BRANCH = 'context/confluence-sync';
/** The subject of every sync commit, and the title of its pull request, so a squash merge keeps it (R-13). */
export const SUBJECT = 'docs(context): sync ADRs and standards from Confluence';
const WATERMARK = 'Generated-by: SHL Agentic Harness';
const HUB_LABEL = /^shl-hub-/i;
const MAX_DEPTH = 8;

/* ------------------------------------------------------------------ arguments */

function usage(problem) {
  if (problem) process.stderr.write(`confluence-sync: ${problem}\n`);
  process.stderr.write('usage: node scripts/confluence-sync.mjs plan --level global|hub\n       node scripts/confluence-sync.mjs apply --level global|hub --out <dir>\n       node scripts/confluence-sync.mjs discover --level global|hub [--draft] [--find-root]\n');
  process.exit(EXIT.USAGE);
}

function parseArgs(argv) {
  const o = { verb: argv[0], level: null, out: null, draft: false, findRoot: false };
  if (!['plan', 'apply', 'discover'].includes(o.verb)) usage(`the first argument is plan, apply or discover, not ${JSON.stringify(o.verb || '')}`);
  for (let i = 1; i < argv.length; i += 1) {
    const a = argv[i];
    const value = () => { const v = argv[i + 1]; if (v === undefined || v.startsWith('--')) usage(`${a} needs a value`); i += 1; return v; };
    if (a === '--level') o.level = value();
    else if (a === '--out') o.out = resolve(value());
    else if (a === '--draft' && o.verb === 'discover') o.draft = true;
    else if (a === '--find-root' && o.verb === 'discover') o.findRoot = true;
    else usage(`unknown argument ${a}`);
  }
  if (o.level !== 'global' && o.level !== 'hub') usage('--level is global or hub');
  if (o.verb === 'apply' && !o.out) usage('apply needs --out <dir>');
  return o;
}

/* ------------------------------------------------------------------ git */

class Stop extends Error {
  constructor(exit, message, reason = null) { super(message); this.exit = exit; this.reason = reason; }
}

const QUIET = { ...process.env, GIT_TERMINAL_PROMPT: '0' };

function git(cwd, args, { allowFail = false } = {}) {
  try {
    return execFileSync('git', args, { cwd, env: QUIET, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
  } catch (err) {
    if (allowFail) return null;
    throw new Stop(EXIT.CANNOT_VERIFY, `git ${args.join(' ')} failed: ${String(err.stderr || err.message).split('\n')[0]}`, 'git-failed');
  }
}

/** The trunk: the remote's default branch, which HARNESS_TRUNK must match when it is set. Force-fetched. */
function trunkOf(cwd) {
  const out = git(cwd, ['ls-remote', '--symref', 'origin', 'HEAD'], { allowFail: true });
  if (out === null) throw new Stop(EXIT.CANNOT_VERIFY, 'cannot reach the remote origin', 'remote-unreachable');
  const m = out.match(/^ref: refs\/heads\/(\S+)\s+HEAD/m);
  if (!m) throw new Stop(EXIT.CANNOT_VERIFY, 'the remote origin names no default branch', 'no-default-branch');
  const named = process.env.HARNESS_TRUNK;
  if (named && named !== m[1]) throw new Stop(EXIT.CANNOT_VERIFY, `HARNESS_TRUNK is ${named} and the remote's default branch is ${m[1]}. The two must agree`, 'trunk-mismatch');
  const trunk = m[1];
  if (git(cwd, ['fetch', '--quiet', '--force', 'origin', `+refs/heads/${trunk}:refs/remotes/origin/${trunk}`], { allowFail: true }) === null) {
    throw new Stop(EXIT.CANNOT_VERIFY, `cannot fetch ${trunk} from origin`, 'fetch-failed');
  }
  return trunk;
}

const show = (cwd, ref, path) => git(cwd, ['show', `${ref}:${path}`], { allowFail: true });

/* ------------------------------------------------------------------ the connection */

function connectionOf(text) {
  let c;
  try { c = JSON.parse(text); } catch (err) { throw new Stop(EXIT.FAIL, `${CONNECTION} is not JSON: ${err.message}`, 'config-invalid'); }
  const problems = [];
  if (!c || typeof c !== 'object') problems.push('it is not an object');
  else {
    if (c.schema_version !== 1) problems.push('schema_version is not 1');
    let url = null;
    try { url = new URL(String(c.site)); } catch { url = null; }
    const local = url && ['127.0.0.1', 'localhost'].includes(url.hostname);
    if (!url || (url.protocol !== 'https:' && !(local && url.protocol === 'http:'))) problems.push('site is not an https URL such as https://<name>.atlassian.net');
    if (typeof c.space !== 'string' || !c.space.match(/^[A-Za-z0-9~_-]{1,255}$/)) problems.push('space is not a Confluence space key');
    if (typeof c.root_folder !== 'string' || !c.root_folder.match(/^\d+$/)) problems.push('root_folder is not the id of the Key decisions folder, as a string of digits');
    if (c.mode !== 'site' && c.mode !== 'gateway') problems.push('mode is not "site" (a classic API token) or "gateway" (a token with scopes)');
    // The paths of a standard's Scope boxes in this estate: { "<box>": ["<glob>", ...] }. Optional.
    if (c.scopes !== undefined) {
      const ok = c.scopes && typeof c.scopes === 'object' && !Array.isArray(c.scopes)
        && Object.values(c.scopes).every((v) => Array.isArray(v) && v.every((g) => typeof g === 'string' && g.trim() !== '' && !g.match(/\s/)));
      if (!ok) problems.push('scopes is not an object that maps a Scope box to a list of paths, such as { "Backend": ["services/**"] }');
    }
  }
  if (problems.length) throw new Stop(EXIT.FAIL, `${CONNECTION} is not well formed: ${problems.join('; ')}`, 'config-invalid');
  return { site: String(c.site).replace(/\/+$/, ''), space: c.space, root: c.root_folder, mode: c.mode, scopes: c.scopes || {} };
}

function hubKeyOf(cwd, trunk) {
  const text = show(cwd, `origin/${trunk}`, KEYS);
  if (text === null) throw new Stop(EXIT.FAIL, `${KEYS} is not on the trunk, so this hub has no key, and the sync cannot find its folder under Key decisions > hubs`, 'config-invalid');
  let prefix = null;
  try { prefix = JSON.parse(text).prefix; } catch { prefix = null; }
  if (typeof prefix !== 'string' || !prefix.match(/^[A-Z][A-Z0-9]{1,9}$/)) throw new Stop(EXIT.FAIL, `${KEYS} names no key prefix`, 'config-invalid');
  return prefix;
}

/* ------------------------------------------------------------------ the tree (R-01, R-16) */

const same = (a, b) => oneLine(a).toLowerCase() === oneLine(b).toLowerCase();

/**
 * The run's folder and the pages under its ADRs and standards folders.
 * Returns { found, path, pages: [{ id, title, kind, path }], ignored: [{ id, title, type, path, why }] }.
 */
async function readTree(client, conn, level, key) {
  const root = await client.node('folder', conn.root);
  const top = await client.children('folder', conn.root);
  const want = level === 'global' ? ['global'] : ['hubs', key];
  let node = { id: conn.root, type: 'folder', title: root.title };
  let list = top;
  const trail = [root.title];
  for (const name of want) {
    const next = list.find((c) => (c.type === 'folder' || c.type === 'page') && same(c.title, name));
    if (!next) return { found: false, path: [...trail, name].join(' > '), pages: [], ignored: [] };
    node = next;
    trail.push(next.title);
    list = await client.children(next.type, next.id);
  }
  const pages = [];
  const ignored = [];
  // The level's two folders are named by their first word: "ADRs - global", "standards - NOVA".
  for (const c of list) {
    const kind = c.type === 'folder' && String(c.title).match(/^\s*ADRs\b/i) ? 'adr'
      : c.type === 'folder' && String(c.title).match(/^\s*standards\b/i) ? 'standard' : null;
    if (!kind) { ignored.push({ id: c.id, title: c.title, type: c.type, path: trail.join(' > '), why: 'not under ADRs or standards (R-01)' }); continue; }
    await walk(client, c, kind, [...trail, c.title], 0, pages, ignored);
  }
  return { found: true, path: trail.join(' > '), node, pages, ignored };
}

async function walk(client, node, kind, trail, depth, pages, ignored) {
  if (depth > MAX_DEPTH) { ignored.push({ id: node.id, title: node.title, type: node.type, path: trail.join(' > '), why: `deeper than ${MAX_DEPTH} levels` }); return; }
  for (const c of await client.children(node.type, node.id)) {
    if (c.type === 'page') pages.push({ id: String(c.id), title: c.title, kind, path: trail.join(' > ') });
    else if (c.type !== 'folder') ignored.push({ id: c.id, title: c.title, type: c.type, path: trail.join(' > '), why: `a ${c.type}, not a page` });
    if (c.type === 'page' || c.type === 'folder') await walk(client, c, kind, [...trail, c.title], depth + 1, pages, ignored);
  }
}

/** Where a page sits now, as "A > B > C", or null when Confluence no longer has it. */
async function locationOf(client, pageId) {
  let page;
  try {
    page = await client.node('page', pageId);
  } catch (err) {
    if (err instanceof ConfluenceError && err.exit === EXIT.FAIL) return { exists: false };
    throw err;
  }
  if (page.status && page.status !== 'current') return { exists: false, status: page.status };
  const anc = await client.get(`/wiki/api/v2/pages/${encodeURIComponent(pageId)}/ancestors`, { limit: 50 });
  const names = [];
  for (const a of (anc && anc.results) || []) {
    try { names.push((await client.node(a.type === 'folder' ? 'folder' : 'page', a.id)).title); } catch { names.push(`#${a.id}`); }
  }
  return { exists: true, path: [...names, page.title].join(' > ') };
}

/* ------------------------------------------------------------------ the trunk's summaries */

function summariesOf(cwd, trunk) {
  const out = [];
  for (const [kind, folder] of Object.entries(FOLDERS)) {
    const listing = git(cwd, ['ls-tree', '-r', '--name-only', `origin/${trunk}`, '--', `${folder}/`], { allowFail: true }) || '';
    for (const path of listing.split('\n').filter(Boolean)) {
      const file = path.split('/').pop();
      if (path.split('/').length !== folder.split('/').length + 1 || !file.endsWith('.md') || file.startsWith('_')) continue;
      const text = show(cwd, `origin/${trunk}`, path);
      if (text === null) continue;
      const h = headerOf(text);
      out.push({ kind, path, text, name: h.name || null, status: h.status || null, revision: h.revision || null, pageId: h.pageId });
    }
  }
  return out;
}

/**
 * R-13: the edit a person made to a summary since the sync last wrote it, or null. The baseline is the
 * newest trunk commit that touched the file with the sync's subject (a merge by squash keeps it, as
 * the pull request's title), or else the newest that changed its revision line.
 */
function lostEditOf(cwd, trunk, path) {
  const ref = `origin/${trunk}`;
  const log = git(cwd, ['log', '--format=%H%x09%s', ref, '--', path], { allowFail: true }) || '';
  let base = log.split('\n').filter(Boolean).map((l) => l.split('\t')).find(([, s]) => s && s.startsWith(SUBJECT));
  let baseline = base ? base[0] : null;
  if (!baseline) {
    const rev = git(cwd, ['log', '-1', '--format=%H', '-G', '^revision: ', ref, '--', path], { allowFail: true });
    baseline = rev && rev.trim() ? rev.trim() : null;
  }
  if (!baseline) return null;
  const before = show(cwd, baseline, path);
  const now = show(cwd, ref, path);
  if (before === null || now === null || before === now) return null;
  const diff = git(cwd, ['diff', baseline, ref, '--', path], { allowFail: true }) || '';
  const authors = (git(cwd, ['log', '--format=%h %an: %s', `${baseline}..${ref}`, '--', path], { allowFail: true }) || '').split('\n').filter(Boolean);
  return { baseline: baseline.slice(0, 12), diff: diff.trim(), authors };
}

/* ------------------------------------------------------------------ decide */

const slugOf = (text) => String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').split('-').filter(Boolean).slice(0, 6).join('-');

function pathFor(record, existing) {
  if (existing) return existing.path;
  if (record.kind === 'standard') return `${FOLDERS.standard}/${record.id}.md`;
  const slug = slugOf(record.heading);
  return `${FOLDERS.adr}/${record.id}${slug ? `-${slug}` : ''}.md`;
}

/**
 * Every decision of one run. Returns { writes: Map(path → text), items: [...] }, where each item is
 * { action, id, kind, page, url, title, path, status, why, author, version, lostEdit, location }.
 * Actions: created, updated, restored, demoted, unchanged, no-file, reformat, skipped, duplicate,
 * orphan, moved, missing-folder, ignored, failed.
 */
async function decide({ client, conn, level, tree, pages, summaries, cwd, trunk }) {
  const items = [];
  const writes = new Map();
  const add = (item) => { items.push(item); return item; };

  if (!tree.found) {
    add({ action: 'missing-folder', path: tree.path, why: `Confluence has no folder ${tree.path}, so this run syncs nothing. A person creates it (R-16)` });
    return { writes, items };
  }
  for (const i of tree.ignored) add({ action: 'ignored', page: i.id, title: i.title, path: i.path, why: i.why });

  // Each page, read and judged on its own.
  const judged = [];
  const seenPages = new Set(pages.map((p) => p.id));
  for (const p of pages) {
    if (p.error) { add({ action: 'failed', page: p.id, title: p.title, path: p.path, why: p.error }); continue; }
    const j = judge({ title: p.title, adf: p.adf, kind: p.kind, scopes: conn.scopes });
    judged.push({ p, j });
  }

  // R-14: two pages that claim one id write nothing, and neither do pages that clash with a record.
  const claims = new Map();
  for (const { p, j } of judged) if (j.record) claims.set(j.record.id, [...(claims.get(j.record.id) || []), p.id]);
  const byPage = new Map(summaries.filter((s) => s.pageId).map((s) => [s.pageId, s]));
  const byName = new Map(summaries.filter((s) => s.name).map((s) => [s.name, s]));

  for (const { p, j } of judged) {
    const base = { page: p.id, title: p.title, url: p.url, version: p.version, author: p.author, kind: p.kind };
    if (!j.record) { add({ ...base, action: 'skipped', why: j.unreadable.join('; ') }); continue; }
    const id = j.record.id;
    if (level === 'global' && (p.labels || []).some((l) => l.match(HUB_LABEL))) {
      add({ ...base, id, action: 'skipped', why: `the label ${(p.labels || []).find((l) => l.match(HUB_LABEL))} marks a hub record under global (R-05)` });
      continue;
    }
    if (j.unreadable.length) { add({ ...base, id, action: 'skipped', why: j.unreadable.join('; ') }); continue; }
    if (claims.get(id).length > 1) { add({ ...base, id, action: 'duplicate', why: `pages ${claims.get(id).join(', ')} all claim ${id}; neither is written (R-14)` }); continue; }
    const mine = byPage.get(p.id);
    if (mine && mine.name !== id) { add({ ...base, id, action: 'duplicate', why: `${mine.path} is ${mine.name}, written from this page, and the page now claims ${id}; neither changes (R-14)` }); continue; }
    const named = byName.get(id);
    if (named && named.pageId && named.pageId !== p.id) { add({ ...base, id, action: 'duplicate', why: `${named.path} holds ${id} from page ${named.pageId}; neither changes (R-14)` }); continue; }
    if (named && named.kind !== j.record.kind) { add({ ...base, id, action: 'duplicate', why: `${named.path} already holds ${id} as a ${named.kind}` }); continue; }

    const existing = named || null;
    const status = j.status;
    const path = pathFor(j.record, existing);

    if (status.effect === 'binds') {
      if (j.reformat.length) { add({ ...base, id, path, action: 'reformat', why: j.reformat.join('; ') }); continue; }
      const text = summaryOf(j, { id: p.id, url: p.url, version: p.version }, status.status);
      if (existing && existing.text === text) { add({ ...base, id, path, status: status.status, action: 'unchanged' }); continue; }
      const action = !existing ? 'created' : existing.status === status.status ? 'updated' : 'restored';
      const lostEdit = existing && existing.pageId === p.id ? lostEditOf(cwd, trunk, existing.path) : null;
      const takeover = existing && !existing.pageId ? `it replaces ${existing.path}, which no page wrote` : null;
      const unmapped = j.scope && j.scope.unmapped.length
        ? `the Scope ${j.scope.unmapped.length === 1 ? 'box' : 'boxes'} ${j.scope.unmapped.map((u) => `"${u}"`).join(', ')} ${j.scope.unmapped.length === 1 ? 'has' : 'have'} no paths in ${CONNECTION} under scopes, so ${j.scope.unmapped.length === 1 ? 'it is' : 'they are'} left out of the globs`
        : null;
      writes.set(path, text);
      add({ ...base, id, path, status: status.status, action, lostEdit, unmapped: j.scope ? j.scope.unmapped : undefined, why: [takeover || status.why, unmapped].filter(Boolean).join('. ') });
      continue;
    }

    // A page that does not bind: an existing summary is demoted, and nothing is written for a new one.
    const target = status.effect === 'retire' ? status.status : NO_LONGER.status;
    const listed = status.effect === 'retire' ? status.listed : true;
    if (!existing) { add({ ...base, id, action: 'no-file', why: status.why }); continue; }
    if (!existing.pageId) { add({ ...base, id, path: existing.path, action: 'no-file', why: `${status.why}. ${existing.path} was not written from a page, so it stays as it is until the page is approved` }); continue; }
    if (existing.status === target) { add({ ...base, id, path: existing.path, status: target, action: 'unchanged', why: status.why }); continue; }
    writes.set(existing.path, withStatus(existing.text, target));
    add({ ...base, id, path: existing.path, status: target, action: 'demoted', listed, why: status.effect === 'retire' ? status.why : `${status.why}, so the record stops binding (R-08)` });
  }

  // R-15 and R-08: summaries with no page in this folder.
  for (const s of summaries) {
    if (s.pageId && seenPages.has(s.pageId)) continue;
    if (!s.pageId) { add({ action: 'orphan', id: s.name, kind: s.kind, path: s.path, why: 'no Confluence page holds this record. A person adds the page, or retires the summary (R-15)' }); continue; }
    const where = await locationOf(client, s.pageId);
    if (!where.exists) {
      const why = `page ${s.pageId} is ${where.status || 'deleted'} in Confluence, so the record stops binding (R-08)`;
      if (s.status === 'Deprecated' || (s.status || '').startsWith('Superseded by')) { add({ action: 'unchanged', id: s.name, kind: s.kind, page: s.pageId, path: s.path, status: s.status, why }); continue; }
      writes.set(s.path, withStatus(s.text, 'Deprecated'));
      add({ action: 'demoted', id: s.name, kind: s.kind, page: s.pageId, path: s.path, status: 'Deprecated', listed: true, why });
      continue;
    }
    add({ action: 'moved', id: s.name, kind: s.kind, page: s.pageId, path: s.path, location: where.path, why: `the page is now at ${where.path}, outside ${tree.path}. A person adds the page here, or retires the summary, for example with Superseded by global.${s.name} (R-15)` });
  }
  return { writes, items };
}

/* ------------------------------------------------------------------ read Confluence */

async function readPages(client, conn, level, tree) {
  const out = [];
  for (const p of tree.pages) {
    try {
      const page = await client.page(p.id);
      const labels = level === 'global' ? await client.labels(p.id) : [];
      const author = await client.person(page.version && page.version.authorId);
      const webui = page._links && page._links.webui ? page._links.webui : `/spaces/${conn.space}/pages/${p.id}`;
      out.push({ ...p, title: page.title || p.title, adf: page.adf, labels, author, version: page.version ? page.version.number : null, url: `${conn.site}/wiki${webui}` });
    } catch (err) {
      if (err instanceof ConfluenceError && err.exit === EXIT.CANNOT_VERIFY) throw err;
      out.push({ ...p, error: err.message });
    }
  }
  return out;
}

/* ------------------------------------------------------------------ write, prove, commit */

const WRITTEN = ['created', 'updated', 'restored', 'demoted'];

function commit(work, items) {
  const paragraph = items.filter((i) => WRITTEN.includes(i.action))
    .map((i) => `${i.action} ${i.id}${i.page ? ` from page ${i.page}` : ''}${i.version ? ` v${i.version}` : ''}`).join('\n');
  const helper = join(work, 'scripts', 'harness-commit.mjs');
  if (existsSync(helper)) {
    const r = spawnSync(process.execPath, [helper, '--repo', work, '-m', SUBJECT, '-m', paragraph || 'Status lines only.'], { cwd: work, encoding: 'utf8' });
    if (r.status !== 0) throw new Stop(r.status === 2 ? EXIT.CANNOT_VERIFY : EXIT.INTERNAL, `harness-commit.mjs refused the commit (exit ${r.status}): ${(r.stderr || r.stdout || '').trim().split('\n')[0]}`, r.status === 2 ? 'git-failed' : null);
  } else {
    // The global context repository has no commit helper. Its /add-context commits the same way.
    git(work, ['commit', '--quiet', '-m', SUBJECT, '-m', paragraph || 'Status lines only.', '-m', WATERMARK]);
  }
}

/** Stage the two folders. git refuses a pathspec that matches nothing, so a folder the tree lacks is left out. */
function stage(work) {
  const folders = Object.values(FOLDERS).filter((f) => existsSync(join(work, f)));
  if (folders.length) git(work, ['add', '-A', '--', ...folders]);
}

function apply({ cwd, trunk, out, level, writes, items }) {
  const work = join(out, 'worktree');
  if (existsSync(work)) throw new Stop(EXIT.USAGE, `${work} already exists; give an empty --out`);
  mkdirSync(out, { recursive: true });
  git(cwd, ['worktree', 'add', '--quiet', '-B', BRANCH, work, `origin/${trunk}`]);
  for (const [path, text] of writes) {
    mkdirSync(dirname(join(work, path)), { recursive: true });
    writeFileSync(join(work, path), text);
  }
  stage(work);
  if (!(git(work, ['diff', '--cached', '--name-only']) || '').trim()) return { changed: false, commit: null, work };
  commit(work, items);

  // Prove the commit with the repository's own check. The global check reads HEAD, never the working
  // tree, so it runs after the commit. A summary it refuses leaves the change, and the commit is amended.
  const check = join(work, 'scripts', 'check-context.mjs');
  if (existsSync(check)) {
    const r = spawnSync(process.execPath, [check, ...(level === 'global' ? ['--global'] : ['--offline'])], { cwd: work, env: { ...process.env, HARNESS_TRUNK: trunk }, encoding: 'utf8' });
    const said = `${r.stdout || ''}\n${r.stderr || ''}`;
    if (r.status !== 0) {
      let dropped = 0;
      for (const path of [...writes.keys()]) {
        if (!said.includes(path)) continue;
        const reason = said.split('\n').filter((l) => l.includes(path)).map((l) => l.trim()).slice(0, 3).join(' · ');
        const onTrunk = (git(work, ['ls-tree', '--name-only', `origin/${trunk}`, '--', path], { allowFail: true }) || '').trim();
        if (onTrunk) git(work, ['checkout', '--quiet', `origin/${trunk}`, '--', path]);
        else git(work, ['rm', '--quiet', '--', path]);
        writes.delete(path);
        dropped += 1;
        for (const it of items.filter((x) => x.path === path && WRITTEN.includes(x.action))) {
          it.action = 'failed';
          it.why = `check-context.mjs refuses the summary, so it is not written: ${reason}`;
        }
      }
      if (dropped) {
        stage(work);
        git(work, ['commit', '--quiet', '--amend', '--no-edit', '--allow-empty']);
      }
      if (r.status >= 2) items.push({ action: 'failed', why: `check-context.mjs could not judge the result (exit ${r.status}): ${said.trim().split('\n')[0]}` });
      else if (!dropped) items.push({ action: 'failed', why: `check-context.mjs reports problems the sync did not write: ${said.trim().split('\n').slice(0, 2).join(' · ')}` });
    }
  }
  if (git(work, ['diff', '--quiet', `origin/${trunk}`, 'HEAD', '--'], { allowFail: true }) !== null) return { changed: false, commit: null, work };
  return { changed: true, commit: git(work, ['rev-parse', 'HEAD']).trim(), work };
}

/* ------------------------------------------------------------------ the report */

const LABELS = {
  created: 'Created', updated: 'Updated', restored: 'Restored to binding', demoted: 'Demoted',
  reformat: 'Needs reformatting', skipped: 'Skipped', duplicate: 'Not written: the id is claimed twice',
  orphan: 'Summaries with no page', moved: 'Summaries whose page moved', 'missing-folder': 'Folder missing in Confluence',
  ignored: 'Ignored in the tree', failed: 'Failed', 'no-file': 'Not approved: no file',
};
const ORDER = ['created', 'updated', 'restored', 'demoted', 'reformat', 'duplicate', 'skipped', 'orphan', 'moved', 'missing-folder', 'failed', 'ignored', 'no-file'];

function report({ conn, level, folder, items, changed }) {
  const lines = [];
  const counts = Object.fromEntries(ORDER.map((a) => [a, items.filter((i) => i.action === a).length]));
  lines.push(`Confluence ${conn.site}, space ${conn.space}, folder ${folder}. Level: ${level}.`);
  lines.push('');
  lines.push(ORDER.filter((a) => counts[a]).map((a) => `${counts[a]} ${LABELS[a].toLowerCase()}`).join(' · ') || 'Nothing to report.');
  for (const a of ORDER) {
    const list = items.filter((i) => i.action === a);
    if (!list.length || a === 'no-file') continue;
    lines.push('', `### ${LABELS[a]}`, '');
    for (const i of list) {
      const page = i.url ? `[${i.title || i.page}](${i.url})` : i.page ? `page ${i.page}` : '';
      const by = i.author ? `, version ${i.version} by ${i.author}` : i.version ? `, version ${i.version}` : '';
      const what = [i.id, page].filter(Boolean).join(' — ');
      lines.push(`- ${what || i.path}${by}${i.path && what ? ` → \`${i.path}\`` : ''}${i.status ? `: ${i.status}` : ''}${i.why ? `. ${i.why}` : ''}`);
    }
  }
  const lost = items.filter((i) => i.lostEdit);
  if (lost.length) {
    lines.push('', '### Harness edits that Confluence replaces (R-13)', '');
    for (const i of lost) {
      lines.push(`- \`${i.path}\`, edited since the sync wrote it at ${i.lostEdit.baseline}:`);
      for (const a of i.lostEdit.authors) lines.push(`  - ${a}`);
      lines.push('', '  ```diff', ...i.lostEdit.diff.split('\n').map((l) => `  ${l}`), '  ```', '');
    }
  }
  if (!changed) lines.push('', 'No summary changes, so no pull request.');
  return lines.join('\n').replace(/\n{3,}/g, '\n\n');
}

/* ------------------------------------------------------------------ main */

/* ------------------------------------------------------------------ discover */

async function discover({ client, conn, level, key, findRoot }) {
  const out = { site: conn.site, space: conn.space, mode: conn.mode, level, hub: key, root: null, folder: null, folders: { adr: null, standard: null }, pages: { adr: 0, standard: 0 }, missing: [] };
  await client.space(conn.space);
  if (findRoot) {
    const found = await client.search(`space = "${conn.space.replace(/"/g, '')}" AND title = "Key decisions"`);
    out.candidates = found.filter((c) => c.type === 'folder' || c.type === 'page');
  }
  let root;
  try { root = await client.node('folder', conn.root); } catch (err) {
    if (err instanceof ConfluenceError && err.exit === EXIT.FAIL) { out.missing.push(`root_folder ${conn.root} is not a folder this account can read`); return out; }
    throw err;
  }
  out.root = { id: conn.root, title: root.title };
  let list = await client.children('folder', conn.root);
  const trail = [root.title];
  for (const name of level === 'global' ? ['global'] : ['hubs', key]) {
    const next = list.find((c) => (c.type === 'folder' || c.type === 'page') && same(c.title, name));
    if (!next) { out.missing.push(`the folder ${[...trail, name].join(' > ')}`); return out; }
    trail.push(next.title);
    list = await client.children(next.type, next.id);
  }
  out.folder = trail.join(' > ');
  for (const [kind, word, shown] of [['adr', /^\s*ADRs\b/i, `ADRs - ${level === 'global' ? 'global' : key}`], ['standard', /^\s*standards\b/i, `standards - ${level === 'global' ? 'global' : key}`]]) {
    const f = list.find((c) => c.type === 'folder' && String(c.title).match(word));
    if (!f) { out.missing.push(`the folder ${out.folder} > ${shown}`); continue; }
    out.folders[kind] = f.title;
    const pages = [];
    await walk(client, f, kind, [out.folder, f.title], 0, pages, []);
    out.pages[kind] = pages.length;
  }
  return out;
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  const cwd = process.cwd();
  const trunk = trunkOf(cwd);
  const connText = o.draft ? (existsSync(join(cwd, CONNECTION)) ? readFileSync(join(cwd, CONNECTION), 'utf8') : null) : show(cwd, `origin/${trunk}`, CONNECTION);
  if (connText === null) {
    process.stdout.write(`${JSON.stringify({ configured: false, reason: `${CONNECTION} is not ${o.draft ? 'in the working tree' : `on ${trunk}`}, so this repository has no Confluence sync` }, null, 2)}\n`);
    return EXIT.PASS;
  }
  const conn = connectionOf(connText);
  const key = o.level === 'hub' ? hubKeyOf(cwd, trunk) : null;
  const user = process.env.CONFLUENCE_USER || '';
  const token = process.env.CONFLUENCE_API_TOKEN || '';
  if (!user || !token) throw new Stop(EXIT.CANNOT_VERIFY, 'CONFLUENCE_USER and CONFLUENCE_API_TOKEN must both be set: the read-only service account (R-19)', 'credential-missing');

  const root = await resolveRoot(conn.site, conn.mode, { gatewayBase: process.env.HARNESS_CONFLUENCE_GATEWAY || undefined });
  const client = createClient({ root, user, token });
  const me = await client.whoami();
  process.stderr.write(`confluence-sync: reading ${conn.site} as ${me.displayName}, level ${o.level}${key ? ` (hub ${key})` : ''}, trunk ${trunk}\n`);
  if (o.verb === 'discover') {
    const d = await discover({ client, conn, level: o.level, key, findRoot: o.findRoot });
    process.stdout.write(`${JSON.stringify({ configured: true, account: me.displayName, ...d }, null, 2)}\n`);
    return d.missing.length ? EXIT.FAIL : EXIT.PASS;
  }
  await client.space(conn.space);

  const tree = await readTree(client, conn, o.level, key);
  const pages = tree.found ? await readPages(client, conn, o.level, tree) : [];
  const summaries = summariesOf(cwd, trunk);
  const { writes, items } = await decide({ client, conn, level: o.level, tree, pages, summaries, cwd, trunk });

  const result = { configured: true, level: o.level, hub: key, folder: tree.path, trunk, branch: BRANCH, subject: SUBJECT, changed: writes.size > 0, commit: null, items };
  if (o.verb === 'plan') {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return EXIT.PASS;
  }
  const done = apply({ cwd, trunk, out: o.out, level: o.level, writes, items });
  result.changed = done.changed;
  result.commit = done.commit;
  result.worktree = done.work;
  const body = report({ conn, level: o.level, folder: tree.path, items, changed: done.changed });
  writeFileSync(join(o.out, 'job-summary.md'), `## Confluence sync\n\n${body}\n`);
  writeFileSync(join(o.out, 'pr-body.md'), `Confluence is master for these records (PLDC-712). Merging this pull request makes the harness copy equal to the approved pages.\n\n${body}\n\n${WATERMARK}\n`);
  writeFileSync(join(o.out, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return EXIT.PASS;
}

/**
 * A laptop behind a proxy that inspects TLS trusts the proxy's root certificate in the operating
 * system's store only, and Node does not read that store unless --use-system-ca is set. So a run
 * without the flag starts itself again once with it, and exits with the child's status. A Node that
 * does not know the flag (before 22.15) runs as it is.
 */
function withSystemCa() {
  const has = (list) => list.some((a) => a === '--use-system-ca');
  if (has(process.execArgv) || has(String(process.env.NODE_OPTIONS || '').split(/\s+/))) return null;
  if (!process.allowedNodeEnvironmentFlags.has('--use-system-ca')) return null;
  const r = spawnSync(process.execPath, ['--use-system-ca', ...process.execArgv, fileURLToPath(import.meta.url), ...process.argv.slice(2)], { stdio: 'inherit' });
  if (r.error) {
    process.stderr.write(`confluence-sync: internal fault: cannot start Node again with --use-system-ca: ${r.error.message}\n`);
    return EXIT.INTERNAL;
  }
  return r.status === null ? EXIT.INTERNAL : r.status;
}

// realpath on both sides: on macOS the temporary folder is a symbolic link, and import.meta.url is the real path.
const invoked = (() => { try { return realpathSync(process.argv[1] || '') === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })();
const restarted = invoked ? withSystemCa() : null;
if (restarted !== null) process.exit(restarted);
if (invoked) {
  main().then((code) => process.exit(code), (err) => {
    const exit = err instanceof Stop || err instanceof ConfluenceError ? err.exit : EXIT.INTERNAL;
    process.stderr.write(`confluence-sync: ${err instanceof Stop || err instanceof ConfluenceError ? err.message : `internal fault: ${err && err.stack ? err.stack : err}`}\n`);
    if (exit === EXIT.CANNOT_VERIFY) process.stderr.write(`REASON: ${err.reason || 'wiki-unreachable'}\nConfluence or git could not be reached, so the run changed nothing.\n`);
    process.exit(exit);
  });
}

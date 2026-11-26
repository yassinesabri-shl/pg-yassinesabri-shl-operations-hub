#!/usr/bin/env node
// Part of the harness asset library c6f3b4427d58f7c3 (see VERSION.json) · 2026-10-22
/**
 * report-global.mjs — how far this hub is behind the global context repository.
 *
 *   usage:  node scripts/report-global.mjs
 *
 * The scheduled `global-report` workflow runs this script, and a person can run
 * it by hand (docs/proposals/global-context.md §10.3). It reads the hub's trunk
 * and the newest release of the global context repository, and prints five
 * sections. It lists. It does not judge, it runs no model, and it changes
 * nothing. A finding is a report line, never an exit code, so the report never
 * fails a build (D14, D21).
 *
 *   1. The global documents added, changed, superseded or removed between the
 *      baseline and the newest release. The baseline is the highest release that
 *      a requirements document on the hub's trunk records on its `Global:` line.
 *      When no document on the trunk records a release, the baseline is empty,
 *      and every document of the newest release is listed as added.
 *   2. Every hub record whose status is `Superseded by global.ADR-<NNN>`, with
 *      the state of that global record at the newest release. Then the
 *      candidates for /check-global: each Accepted global record whose title an
 *      Accepted hub record carries word for word, after `# ADR-<NNN>:`. A
 *      candidate is not a finding. The script compares titles only, so it never
 *      finds every duplicate, and it says so.
 *   3. Every Active exception that names this hub, by the prefix in
 *      docs/backlog/keys.json, and whose `review-by` date is before today.
 *      Today is the runner's UTC date, as the gates read it.
 *   4. Every open feature whose `Global:` line is behind the newest release. A
 *      missing line counts as `Global: none` (D23), and `none` is behind every
 *      release. A feature is open when it is one of these:
 *        - a requirements document on the trunk with no decomposition record,
 *          with no story, or with a story that has no validation report on the
 *          trunk or a report with a FAIL verdict
 *        - a `requirements/<slug>` branch on the hub's remote whose document
 *          differs from the trunk's: an open pull request, or one that nobody
 *          closed and deleted. The script cannot tell the two apart
 *   5. Each spoke that this hub shares with another hub: its HUBS line names a
 *      hub that is not this one. For each, this hub's binding records and
 *      standards whose globs cover a path at the spoke's trunk head, or that are
 *      always on, and the sibling hubs that the HUBS line names. The script never
 *      reads a sibling hub (D8).
 *
 * What it reads, and how:
 *   - The hub at its trunk, never the working tree: syncTrunk in
 *     spoke-remote.mjs fetches the trunk and the `requirements/*` branches by
 *     force, and confirms the trunk against the remote's default branch.
 *     HARNESS_TRUNK names a trunk that is not `main`.
 *   - docs/estate/global.json on the trunk. Without it the hub has no global
 *     layer: the script prints `Global: none`, reads nothing more and exits 0.
 *   - The global repository through the bare cache outside the hub, as
 *     read-global.mjs --resolve reads it (newestRelease in spoke-remote.mjs).
 *   - Each listed spoke at its trunk head, at depth 1, through the same cache.
 *     The registry and the HUBS lines are read as read-hubs.mjs reads them.
 *
 * Exit codes
 *   0  the report is complete, whatever it lists. Also `Global: none`
 *   2  cannot verify: the hub's trunk cannot be confirmed, or a part of the
 *      report cannot be read: the global repository, global.json or the list
 *      of repositories is not well formed, a listed spoke does not answer, or
 *      a spoke's HUBS line is malformed. Every part that can be read is still
 *      printed, and each part that cannot names why
 *   3  usage
 *   4  internal
 *   The script never exits 1: a finding is a line of the report.
 *
 * What this script cannot see
 *   - Whether a hub record repeats or contradicts a global record. That is a
 *     judgement. /check-global runs a critic for it.
 *   - Whether two hubs disagree about a shared spoke. /add-context reads the
 *     sibling hubs for a new record. This script names the siblings only.
 *   - Whether a `requirements/<slug>` branch still has an open pull request.
 */

import { stdout, stderr } from 'node:process';
import {
  EXIT, GLOBAL_PATH, KEYS_PATH, REGISTRY_PATH, SpokeError, reasonLine, cacheDir, catAt, compareVersions, git, hasCommit,
  hubOrigin, hubPrefixOf, isAncestor, newestRelease, parseGlobalLink, quietGitEnv, releaseVersion, resolveSpokeTrunk, short,
  syncTrunk, validateRegistry,
} from './spoke-remote.mjs';
import { HUBS_KEY, matchesGlobs, readHubsAt } from './spoke-rules.mjs';
import {
  GLOBAL_PREFIX, KINDS, RUN_SLUG, binds, readFoldersAt, readGlobalDocumentsAt, recordedRelease, splitRow,
} from './context-docs.mjs';
import { writeSync } from 'node:fs';

// The token of the run's first cannot-verify finding, which the run prints last.
let firstReason = null;
const because = (reason) => { firstReason = firstReason || reason || null; };

const CONFIG = {
  remote: 'origin',
  branch: process.env.HARNESS_TRUNK || 'main',
  // The branch /feature opens a requirements pull request from: requirements/<slug>.
  requirementsBranch: 'requirements/',
  // The paths check-fan-in.mjs reads a feature's stories and reports from.
  backlogDir: 'docs/backlog',
  recordSuffix: '.decomposition.md',
  itemSuffix: '.item.md',
  designDir: 'docs/designs',
  reportSuffix: '.validation.md',
  keyPattern: /^[A-Z][A-Z0-9]{1,9}-\d+$/,
};
// The kinds of a hub record this report lists.
const HUB_KINDS = ['adr', 'standard'];
const MAX_BUFFER = 256 * 1024 * 1024;

function usage(message) {
  const invoked = process.argv[1] || 'scripts/report-global.mjs';
  stderr.write(`${message}\nusage: node ${invoked}\n`);
  process.exit(EXIT.USAGE);
}

/* ------------------------------------------------------------------ the hub */

/** The text of `path` at `commit` in the hub, or null when no file is there. */
function textAt(hub, commit, path) {
  const got = catAt(hub.dir, commit, [path]).get(path);
  return got && got.type === 'blob' ? got.bytes.toString('utf8') : null;
}

/** The entries of one folder at `commit` in the hub: [{ type, name }], or [] when the folder is not there. */
function entriesAt(hub, commit, folder) {
  let out;
  try {
    out = git(['--git-dir', hub.dir, 'ls-tree', '-z', `${commit}:${folder}`], { env: quietGitEnv(), maxBuffer: MAX_BUFFER });
  } catch {
    return [];
  }
  return out.split('\0').filter(Boolean).map((row) => {
    const tab = row.indexOf('\t');
    return { type: row.slice(0, tab).split(' ')[1], name: row.slice(tab + 1) };
  });
}

/** True when a validation report carries a FAIL verdict, or no Verdict column at all. */
function failsValidation(text) {
  const rows = text.split(/\r?\n/).map(splitRow);
  const header = rows.findIndex((r) => r !== null && r.includes('Verdict'));
  if (header === -1) return true;
  const column = rows[header].indexOf('Verdict');
  return rows.slice(header + 1).some((r) => r !== null && r[column] === 'FAIL');
}

/** Whether the stories cut from a merged feature are all validated: { open, state }. */
function storyState(hub, slug) {
  if (textAt(hub, hub.head, `${CONFIG.backlogDir}/${slug}${CONFIG.recordSuffix}`) === null) {
    return { open: true, state: 'not decomposed yet' };
  }
  const keys = entriesAt(hub, hub.head, `${CONFIG.backlogDir}/${slug}`)
    .filter((e) => e.type === 'blob' && e.name.endsWith(CONFIG.itemSuffix))
    .map((e) => e.name.slice(0, -CONFIG.itemSuffix.length))
    .filter((k) => k.match(CONFIG.keyPattern));
  if (!keys.length) return { open: true, state: 'no story cut yet' };
  const reports = catAt(hub.dir, hub.head, keys.map((k) => `${CONFIG.designDir}/${k}${CONFIG.reportSuffix}`));
  const validated = keys.filter((k) => {
    const got = reports.get(`${CONFIG.designDir}/${k}${CONFIG.reportSuffix}`);
    return got && got.type === 'blob' && !failsValidation(got.bytes.toString('utf8'));
  });
  return { open: validated.length < keys.length, state: `${validated.length} of ${keys.length} stories validated` };
}

/**
 * Every requirements document the report knows: each one on the trunk, and each
 * `requirements/<slug>` branch whose document differs from the trunk's. Returns
 * [{ slug, where, merged, release, open, state }], where `release` is what
 * recordedRelease returns.
 */
function readFeatures(hub) {
  const { folder, file } = KINDS['requirements-document'];
  const pathOf = (slug) => `${folder}/${slug}/${file}`;
  const slugs = entriesAt(hub, hub.head, folder).filter((e) => e.type === 'tree' && e.name.match(RUN_SLUG)).map((e) => e.name);
  const onTrunk = catAt(hub.dir, hub.head, slugs.map(pathOf));
  const features = [];
  const trunkBytes = new Map();
  for (const slug of slugs) {
    const got = onTrunk.get(pathOf(slug));
    if (!got || got.type !== 'blob') continue;
    trunkBytes.set(slug, got.bytes);
    features.push({ slug, where: 'merged', merged: true, release: recordedRelease(got.bytes.toString('utf8')), ...storyState(hub, slug) });
  }

  const prefix = `refs/remotes/${CONFIG.remote}/${CONFIG.requirementsBranch}`;
  const branches = git(['--git-dir', hub.dir, 'for-each-ref', '--format=%(refname) %(objectname)', prefix], { env: quietGitEnv() })
    .split('\n').filter(Boolean).map((l) => l.split(' '));
  for (const [ref, commit] of branches) {
    const slug = ref.slice(prefix.length);
    if (!slug.match(RUN_SLUG)) continue;
    const got = catAt(hub.dir, commit, [pathOf(slug)]).get(pathOf(slug));
    if (!got || got.type !== 'blob') continue;
    if (trunkBytes.has(slug) && trunkBytes.get(slug).equals(got.bytes)) continue;
    features.push({ slug, where: `on branch ${CONFIG.requirementsBranch}${slug}`, merged: false, release: recordedRelease(got.bytes.toString('utf8')), open: true, state: 'not merged' });
  }
  return features;
}

/* --------------------------------------------------------------- the report */

const statusOf = (d) => (d.kind === 'adr' && d.supersedes ? `Superseded by ${d.supersedes}` : d.status);
const globalId = (d) => `${GLOBAL_PREFIX}${d.name}`;
const docLine = (verb, d, extra = '') => `- ${verb} ${globalId(d)} · ${d.kind} · ${statusOf(d)}${extra} · ${d.description}`;
const byPath = (a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
const releaseText = (r) => (r === null ? 'Global: none' : `Global: ${r.tag}`);

/**
 * The global layer at its newest release: { ok: true, release, documents, dir,
 * head } when a release binds, { ok: false, why } when nothing can be compared,
 * and the lines and notes the header prints.
 */
function readGlobal(link, lines, notes, cannot) {
  if (link === null) return { ok: false, why: 'Not read: docs/estate/global.json on the trunk is not well formed.' };
  let found;
  try {
    found = newestRelease(link);
  } catch (err) {
    if (!(err instanceof SpokeError)) throw err;
    cannot.push(`the global repository: ${err.message}`); because(err.reason);
    lines.push('Global: cannot be read');
    return { ok: false, why: 'Not read: the global repository cannot be read.' };
  }
  lines.push(...found.lines);
  if (found.release === null) {
    lines.push('Global: no release tag on the trunk, so nothing in the global repository binds yet');
    return { ok: false, why: 'None: the global repository has no release tag, so nothing in it binds yet.' };
  }
  const { release } = found;
  const read = readGlobalDocumentsAt(found.dir, release.commit);
  const count = (kind) => read.documents.filter((d) => d.kind === kind).length;
  lines.push(`Global: ${release.name} ${release.commit}`);
  lines.push(`Documents: ${read.documents.length} at ${release.name}: ${count('adr')} record(s), ${count('standard')} standard(s), ${count('exception')} exception(s)`);
  for (const f of read.findings) notes.push(`at ${release.name}: ${f}. The report does not read the document`);
  return { ok: true, release, documents: read.documents, dir: found.dir, head: found.head };
}

function sectionChanges(g, features, notes) {
  const out = ['', '== 1. Global documents added, changed, superseded or removed since the release this hub last recorded'];
  if (!g.ok) return { out: [...out, g.why], count: 0 };
  const recorded = features.filter((f) => f.merged && f.release)
    .map((f) => ({ ...f, version: releaseVersion(f.release.tag) }))
    .sort((a, b) => compareVersions(b.version, a.version));
  let before = [];
  if (!recorded.length) {
    out.push(`Baseline: none. No requirements document on the trunk records a release, so every document at ${g.release.name} is listed as added.`);
  } else {
    const base = recorded[0].release;
    const slugs = recorded.filter((f) => f.release.tag === base.tag && f.release.commit === base.commit).map((f) => f.slug);
    out.push(`Baseline: ${base.tag} ${base.commit}, the highest release that a requirements document on the trunk records (${slugs.join(', ')}).`);
    if (!hasCommit(g.dir, base.commit) || !isAncestor(g.dir, base.commit, g.head)) {
      out.push(`Not compared: ${short(base.commit)} is not on the global trunk. requirements-gate refuses a document that records it.`);
      return { out, count: 0 };
    }
    const read = readGlobalDocumentsAt(g.dir, base.commit);
    for (const f of read.findings) notes.push(`at ${base.tag}: ${f}. Section 1 does not compare the document`);
    before = read.documents;
  }
  const was = new Map(before.map((d) => [d.name, d]));
  const now = new Map(g.documents.map((d) => [d.name, d]));
  const changes = [];
  for (const d of [...g.documents].sort(byPath)) {
    const old = was.get(d.name);
    if (!old) changes.push(docLine('added', d));
    else if (old.blob !== d.blob) {
      const moved = statusOf(old) !== statusOf(d);
      if (moved && d.kind === 'adr' && d.supersedes) changes.push(docLine('superseded', d, ` (was ${statusOf(old)})`));
      else changes.push(docLine('changed', d, moved ? ` (was ${statusOf(old)})` : ''));
    }
  }
  for (const d of [...before].sort(byPath)) {
    if (!now.has(d.name)) changes.push(`- removed ${globalId(d)} · ${d.kind} · was ${statusOf(d)} · ${d.description}`);
  }
  out.push(...(changes.length ? changes : [`None: ${g.release.name} holds the same documents as the baseline.`]));
  return { out, count: changes.length };
}

function sectionSuperseded(g, hubDocs) {
  const out = ['', '== 2. Hub records superseded by a global record, and candidates for /check-global'];
  const superseded = hubDocs.filter((d) => d.kind === 'adr' && d.supersedes && d.supersedes.startsWith(GLOBAL_PREFIX)).sort(byPath);
  for (const d of superseded) {
    let state = '';
    if (g.ok) {
      const successor = g.documents.find((x) => x.kind === 'adr' && globalId(x) === d.supersedes);
      state = successor ? `. ${d.supersedes} is ${statusOf(successor)} at ${g.release.name}` : `. ${d.supersedes} is not at ${g.release.name}`;
    }
    out.push(`- ${d.name} · ${d.path} · Superseded by ${d.supersedes}${state}`);
  }
  out.push(`Superseded by a global record: ${superseded.length} hub record(s).`);
  if (!g.ok) return { out: [...out, `Candidates: ${g.why.replace(/^(?:Not read|None): /, '')}`], superseded: superseded.length, candidates: 0 };

  const accepted = (docs) => docs.filter((d) => d.kind === 'adr' && d.status === 'Accepted' && d.title);
  const globals = accepted(g.documents);
  const candidates = [];
  for (const h of accepted(hubDocs).sort(byPath)) {
    for (const x of globals.filter((y) => y.title === h.title)) {
      candidates.push(`- ${h.name} (${h.path}) and ${globalId(x)} carry the same title: "${h.title}"`);
    }
  }
  out.push(...candidates);
  out.push(`Candidates: ${candidates.length}. A candidate is not a finding. The script compares the titles of Accepted records word for word, so it does not find a duplicate under another title, and it judges no contradiction. Run /check-global for the judgement.`);
  return { out, superseded: superseded.length, candidates: candidates.length };
}

function sectionStale(g, prefix, today) {
  const out = ['', `== 3. Active exceptions that name this hub and are past their review-by date (today: ${today}, UTC)`];
  if (!g.ok) return { out: [...out, g.why], count: 0 };
  if (prefix === null) return { out: [...out, `None: this hub has no key prefix in ${KEYS_PATH}, so no exception can name it.`], count: 0 };
  const naming = g.documents.filter((d) => d.kind === 'exception' && d.status === 'Active' && d.hubs.includes(prefix)).sort(byPath);
  const stale = naming.filter((d) => d.reviewBy < today);
  for (const d of stale) {
    out.push(`- ${globalId(d)} · review-by ${d.reviewBy} · departs ${d.departs.map((x) => `${GLOBAL_PREFIX}${x}`).join(', ')} · repositories ${d.repositories.join(', ')} · ${d.description}`);
  }
  out.push(`Past review-by: ${stale.length} of ${naming.length} Active exception(s) that name ${prefix}. The gates still pass a design that cites one. Ask the Global Architecture Board to review it.`);
  return { out, count: stale.length };
}

function sectionBehind(g, features) {
  const out = ['', `== 4. Open features whose Global: line is behind ${g.ok ? g.release.name : 'the newest release'}`];
  if (!g.ok) return { out: [...out, g.why], count: 0 };
  const open = features.filter((f) => f.open).sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : a.merged ? -1 : 1));
  let behind = 0;
  for (const f of open) {
    const where = f.merged ? `${f.where}, ${f.state}` : f.where;
    if (f.release === false) {
      out.push(`- ${f.slug} (${where}): its Global: line does not name one release, so requirements-gate refuses it. Not compared`);
    } else if (f.release === null || compareVersions(releaseVersion(f.release.tag), g.release.version) < 0) {
      behind += 1;
      out.push(`- ${f.slug} (${where}): ${releaseText(f.release)}, behind ${g.release.name}`);
    }
  }
  const merged = open.filter((f) => f.merged).length;
  out.push(`Behind: ${behind} of ${open.length} open feature(s), ${merged} merged and ${open.length - merged} on a branch. An approved amendment of the requirements moves a feature to a newer release.`);
  return { out, count: behind };
}

function sectionShared(hub, prefix, hubDocs, notes, cannot) {
  const out = ['', '== 5. Spokes this hub shares with another hub'];
  const text = textAt(hub, hub.head, REGISTRY_PATH);
  if (text === null) return { out: [...out, `None: ${REGISTRY_PATH} is not on the trunk, so this hub lists no spoke.`], count: 0 };
  let registry;
  try {
    registry = JSON.parse(text);
  } catch (err) {
    cannot.push(`${REGISTRY_PATH} on ${hub.ref} is not JSON: ${err.message}`); because('registry-invalid');
    return { out: [...out, `Not read: ${REGISTRY_PATH} is not JSON.`], count: 0 };
  }
  const problems = validateRegistry(registry, REGISTRY_PATH);
  if (problems.length) {
    cannot.push(`${REGISTRY_PATH} on ${hub.ref} is not well formed. Run check-registry:\n  - ${problems.join('\n  - ')}`); because('registry-invalid');
    return { out: [...out, `Not read: ${REGISTRY_PATH} is not well formed.`], count: 0 };
  }

  const origin = hubOrigin();
  const isThisHub = (h) => (prefix !== null ? h.prefix === prefix : h.hub === origin.name);
  const covering = hubDocs.filter(binds).sort(byPath);
  let shared = 0;
  for (const id of Object.keys(registry.repositories).sort()) {
    const entry = registry.repositories[id];
    let dir;
    let commit;
    try {
      dir = cacheDir(id);
      ({ head: commit } = resolveSpokeTrunk(entry, dir));
    } catch (err) {
      if (!(err instanceof SpokeError)) throw err;
      cannot.push(`${id}: ${err.message}`); because(err.reason);
      out.push(`- ${id}: not read`);
      continue;
    }
    const at = `${id} at ${short(commit)}`;
    const state = readHubsAt(dir, commit, entry.checks);
    if (state === null || state.state === 'not-configured') {
      out.push(`- ${at}: no ${HUBS_KEY} line, so no other hub is known`);
      notes.push(`${id} has no ${HUBS_KEY} line on its trunk: it is not installed, so no hub's story-gate guards it yet`);
      continue;
    }
    if (state.state === 'invalid') {
      cannot.push(`${id}: ${HUBS_KEY} at ${short(commit)} is malformed, so the hubs that own it are unknown: ${state.findings.join('; ')}`); because('config-invalid');
      out.push(`- ${at}: ${HUBS_KEY} is malformed`);
      continue;
    }
    const siblings = state.hubs.filter((h) => !isThisHub(h));
    if (!siblings.length) {
      out.push(`- ${at}: not shared, ${HUBS_KEY} names only this hub`);
      continue;
    }
    shared += 1;
    const paths = git(['--git-dir', dir, 'ls-tree', '-r', '--name-only', '-z', commit], { env: quietGitEnv(), maxBuffer: MAX_BUFFER }).split('\0').filter(Boolean);
    const docs = covering.map((d) => {
      if (d.alwaysApply === true) return { d, where: 'always on' };
      const hit = d.globs.length ? paths.find((p) => matchesGlobs(p, d.globs)) : undefined;
      return hit === undefined ? null : { d, where: `covers ${hit}` };
    }).filter(Boolean);
    out.push(`- ${at}: shared with ${siblings.map((h) => `${h.prefix} ${h.hub}`).join(', ')}. This hub's binding records and standards that cover it: ${docs.length}`);
    for (const { d, where } of docs) out.push(`    ${d.name} · ${d.kind} · ${where} · ${d.description}`);
  }
  out.push(`Shared: ${shared} spoke(s). The report reads no sibling hub. When two hubs disagree about a shared spoke, the Global Architecture Board decides, and the decision moves to a spoke record or a global record.`);
  return { out, count: shared };
}

function main() {
  if (process.argv.length > 2) usage(`unknown arguments: ${process.argv.slice(2).join(' ')}. The report takes none`);
  const hub = syncTrunk(CONFIG.remote, CONFIG.branch, [`+refs/heads/${CONFIG.requirementsBranch}*:refs/remotes/${CONFIG.remote}/${CONFIG.requirementsBranch}*`]);
  const linkText = textAt(hub, hub.head, GLOBAL_PATH);
  if (linkText === null) {
    stdout.write('Global: none\n');
    return;
  }

  const today = new Date().toISOString().slice(0, 10);
  const notes = [];
  const cannot = [];
  const prefix = hubPrefixOf(textAt(hub, hub.head, KEYS_PATH) || '');
  const lines = [
    `Report: the hub at ${hub.ref} ${hub.head}, ${today} (UTC). It lists. It judges nothing, changes nothing and fails no build.`,
    `Hub: ${prefix || `no key prefix in ${KEYS_PATH}`}`,
  ];
  let link = null;
  try {
    link = parseGlobalLink(linkText, GLOBAL_PATH);
  } catch (err) {
    if (!(err instanceof SpokeError)) throw err;
    cannot.push(`${err.message}. requirements-gate refuses every requirements document while the link is not well formed`); because(err.reason || 'config-invalid');
  }
  const g = readGlobal(link, lines, notes, cannot);

  const hubRead = readFoldersAt(hub.dir, hub.head, HUB_KINDS, 'this hub');
  for (const f of hubRead.findings) notes.push(`on ${hub.ref}: ${f}. The report does not read the document`);
  const features = readFeatures(hub);

  const s1 = sectionChanges(g, features, notes);
  const s2 = sectionSuperseded(g, hubRead.documents);
  const s3 = sectionStale(g, prefix, today);
  const s4 = sectionBehind(g, features);
  const s5 = sectionShared(hub, prefix, hubRead.documents, notes, cannot);
  lines.push(...s1.out, ...s2.out, ...s3.out, ...s4.out, ...s5.out, '');
  lines.push(`Summary: ${s1.count} global change(s) since the baseline, ${s2.superseded} hub record(s) superseded by a global record, ${s2.candidates} candidate(s) for /check-global, ${s3.count} exception(s) past review-by, ${s4.count} open feature(s) behind, ${s5.count} shared spoke(s).`);
  stdout.write(`${lines.join('\n')}\n`);
  for (const n of notes) stderr.write(`NOTE: ${n}\n`);
  for (const c of cannot) stderr.write(`CANNOT VERIFY: ${c}\n`);
  if (cannot.length) { stderr.write(reasonLine(firstReason)); process.exit(EXIT.CANNOT_VERIFY); }
}

// The last line of an exit 2, 3 or 4 names this script and its code, so a shell line that hides
// the code, with a pipe or `; echo`, still tells the harness's failure record. Written at once,
// so a process.exit() never loses it.
process.on('exit', (code) => { if (code >= 2 && code <= 4) { try { writeSync(2, `HARNESS EXIT: report-global ${code}\n`); } catch { /* stderr is closed */ } } });

try {
  main();
} catch (err) {
  if (err instanceof SpokeError) {
    // The report never fails a build, so a failure it cannot report as a line is "cannot verify".
    stderr.write(`CANNOT VERIFY: ${err.message}\n${reasonLine(err.reason)}`);
    process.exit(err.exit === EXIT.INTERNAL ? EXIT.INTERNAL : EXIT.CANNOT_VERIFY);
  }
  stderr.write(`INTERNAL: ${err && err.stack ? err.stack : String(err)}\n`);
  process.exit(EXIT.INTERNAL);
}

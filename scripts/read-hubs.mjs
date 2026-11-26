#!/usr/bin/env node
// Part of the harness asset library c6f3b4427d58f7c3 (see VERSION.json) · 2026-10-21
/**
 * read-hubs.mjs — the hubs that own a spoke, and the records of a sibling hub.
 *
 *   usage:  node scripts/read-hubs.mjs --repos <id,id,...> [--registry <file>]
 *           node scripts/read-hubs.mjs --siblings <document> [--skip-hub <PREFIX>=<reason>]...
 *                                      [--registry <file>]
 *
 * A spoke can belong to more than one hub. Its `checks.env` lists them in the
 * HUBS line, one entry `<PREFIX> <owner>/<repo>` each. A hub does not know its
 * sibling hubs, but each spoke it shares does. Only /add-context runs this
 * script, with the access of the person who runs it. No gate runs it, and hub CI
 * never reads a sibling hub (docs/proposals/global-context.md D8).
 *
 * --repos: the hubs an exception names (§9.1). For each listed repository, the
 *   HUBS line of its `checks.env` on its trunk, read at the head commit. The last
 *   line is the exception's `hubs` header, every prefix once, in order:
 *
 *     Hub: <PREFIX>                    (this hub, from docs/backlog/keys.json)
 *     Repository: <id> at <40-hex> (trunk <branch>): HUBS <PREFIX> <owner>/<repo>, ...
 *     hubs: ["<PREFIX>", ...]
 *
 * --siblings <document>: the sibling hubs a new hub record or standard reaches
 *   (§9.2, §11.2). The document is the draft on disk. Its header's `globs` and
 *   `alwaysApply` decide which listed spokes it covers: a spoke is covered when a
 *   path at its trunk head matches the globs, and every spoke is covered by an
 *   always-on document. A document with no globs that is not always on covers
 *   no spoke. Each covered spoke's HUBS line names its hubs. Every hub there but
 *   this one is a sibling. For each sibling, the script reads its trunk and
 *   prints its binding records and standards: in full when a path that the new
 *   document covers is covered by the sibling's document too, when the sibling's
 *   document is always on, or when it has no globs and so can be about any code,
 *   and as an index line when its globs cover none of those paths. The script
 *   does not judge a contradiction. The agent that runs /add-context does.
 *   `--skip-hub <PREFIX>=<reason>` leaves one sibling unread, and the line
 *   `Skipped:` carries the reason into the pull-request description.
 *
 * Where a sibling hub is: the URL of this hub (`git remote get-url origin`) with
 * its owner and repository replaced by the HUBS entry's, or
 * HARNESS_HUB_BASE/<owner>/<repo>.git (siblingUrl in spoke-remote.mjs, which the
 * upgrade uses too). Each sibling is read from a disposable bare cache, at depth
 * 1, and the cache is deleted after.
 *
 * Exit codes
 *   0  read. --siblings also exits 0 when no covered spoke has a sibling hub
 *   1  --repos: a HUBS line is malformed, or does not list this hub.
 *      --siblings: the document does not parse
 *   2  cannot verify: a spoke or a sibling hub does not answer, a listed
 *      repository has no HUBS line on its trunk (--repos), a covered spoke's HUBS
 *      line is malformed (--siblings), or a sibling's URL cannot be derived. A
 *      sibling passed with --skip-hub is not read, so it is never exit 2
 *   3  usage
 *   4  internal
 *
 * What this script cannot see
 *   - Whether two records contradict. That is a judgement, and a model makes it.
 *   - Whether a sibling's record whose globs miss the covered paths still bears
 *     on the new document. It is printed as an index line, with its description.
 *   - A hub that owns a spoke without being in its HUBS line. The spoke install
 *     writes the line, and check-registry.mjs refuses a spoke that does not list
 *     its hub.
 */

import { mkdtempSync, readFileSync, rmSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stdout, stderr } from 'node:process';
import {
  EXIT, KEYS_PATH, REPO_ID, SpokeError, reasonLine, cacheDir, fetchOne, firstLine, git, hubOrigin, isPlaceholder, quietGitEnv,
  readHubPrefix, readRegistry, registryPath, resolveDefaultBranch, resolveSpokeTrunk, short, siblingUrl, validateRegistry,
} from './spoke-remote.mjs';
import { HUBS_KEY, matchesGlobs, readHubsAt } from './spoke-rules.mjs';
import { HUB_PREFIX, parseDocument, printedBody, readFoldersAt } from './context-docs.mjs';

// The token of the run's first cannot-verify finding, which the run prints last.
let firstReason = null;
const because = (reason) => { firstReason = firstReason || reason || null; };

// The kinds a new hub document may be, and the kinds a sibling hub is read for.
const HUB_DOCUMENT_KINDS = ['adr', 'standard'];

function usage(message) {
  const invoked = process.argv[1] || 'scripts/read-hubs.mjs';
  stderr.write(`${message}\nusage: node ${invoked} --repos <id,id,...> [--registry <file>]\n       node ${invoked} --siblings <document> [--skip-hub <PREFIX>=<reason>]... [--registry <file>]\n`);
  process.exit(EXIT.USAGE);
}

function parseArgs(argv) {
  const out = { repos: null, siblings: null, skip: new Map(), registry: null };
  const value = (i, flag) => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) usage(`${flag} needs a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--repos') {
      out.repos = value(i, a).split(',').map((s) => s.trim()).filter(Boolean);
      i += 1;
    } else if (a === '--siblings') {
      out.siblings = value(i, a);
      i += 1;
    } else if (a === '--registry') {
      out.registry = value(i, a);
      i += 1;
    } else if (a === '--skip-hub') {
      const raw = value(i, a);
      i += 1;
      const eq = raw.indexOf('=');
      const prefix = eq === -1 ? raw : raw.slice(0, eq);
      const reason = eq === -1 ? '' : raw.slice(eq + 1).trim();
      if (!prefix.match(HUB_PREFIX)) usage(`--skip-hub "${raw}": "${prefix}" is not a hub's key prefix`);
      if (reason === '' || isPlaceholder(reason)) usage(`--skip-hub ${prefix} needs a reason, as --skip-hub "${prefix}=<why this hub cannot be read>". The reason goes into the pull-request description, so the reviewer sees the check that did not run`);
      if (out.skip.has(prefix)) usage(`--skip-hub names ${prefix} twice`);
      out.skip.set(prefix, reason);
    } else {
      usage(`unknown argument ${a}`);
    }
  }
  if ((out.repos === null) === (out.siblings === null)) usage('say what to read: --repos <id,id,...> or --siblings <document>');
  if (out.repos !== null && out.skip.size) usage('--skip-hub belongs to --siblings');
  if (out.repos !== null && !out.repos.length) usage('--repos needs one repository id or more');
  return out;
}

function loadRegistry(explicit) {
  const path = registryPath(explicit);
  const registry = readRegistry(path);
  const problems = validateRegistry(registry, path);
  if (problems.length) throw new SpokeError(EXIT.FAIL, `the registry is not well formed; run check-registry first:\n  - ${problems.join('\n  - ')}`);
  return { path, repositories: registry.repositories };
}

/** One listed repository at its trunk head: { id, entry, dir, trunk, commit }. */
function readTrunk(id, entry) {
  const dir = cacheDir(id);
  // The trunk rule: the registry's declared trunk, fetched, with TRUNK_FOR_HUB agreeing.
  const { trunk, head } = resolveSpokeTrunk(entry, dir);
  return { id, entry, dir, trunk, commit: head };
}

const thisHub = () => {
  const prefix = readHubPrefix();
  return { prefix, line: `Hub: ${prefix || `no key prefix in ${KEYS_PATH}`}` };
};

const hubsText = (hubs) => hubs.map((h) => `${h.prefix} ${h.hub}`).join(', ');

/* ------------------------------------------------------------------- --repos */

function readRepos(args) {
  const registry = loadRegistry(args.registry);
  const seen = new Set();
  for (const id of args.repos) {
    if (!id.match(REPO_ID)) usage(`"${id}" is not a repository id (letters, digits, ".", "_", "-")`);
    if (!registry.repositories[id]) {
      const known = Object.keys(registry.repositories);
      usage(`"${id}" is not in ${registry.path}. Listed: ${known.length ? known.join(', ') : '(nothing yet)'}. An exception names the repositories this hub lists`);
    }
    if (seen.has(id)) usage(`--repos names ${id} twice`);
    seen.add(id);
  }

  const hub = thisHub();
  const lines = [hub.line];
  const fails = [];
  const cannot = [];
  const prefixes = new Set();
  for (const id of args.repos) {
    let read;
    try {
      read = readTrunk(id, registry.repositories[id]);
    } catch (err) {
      if (!(err instanceof SpokeError)) throw err;
      cannot.push(`${id}: ${err.message}`); because(err.reason);
      continue;
    }
    const at = `${short(read.commit)} (trunk ${read.trunk})`;
    const state = readHubsAt(read.dir, read.commit, read.entry.checks);
    if (state === null) {
      cannot.push(`${id}: ${read.entry.checks} is not on its trunk at ${at}, so no HUBS line says which hubs own it. The spoke install writes the file`); because('config-invalid');
      continue;
    }
    if (state.state === 'not-configured') {
      cannot.push(`${id}: ${read.entry.checks} at ${at} has no ${HUBS_KEY} line, or it is empty or UNRESOLVED, so nothing says which hubs own it. The spoke install writes it`); because('config-invalid');
      continue;
    }
    if (state.state === 'invalid') {
      fails.push(...state.findings.map((f) => `${id}: ${read.entry.checks} at ${at}: ${f}`));
      continue;
    }
    lines.push(`Repository: ${id} at ${read.commit} (trunk ${read.trunk}): ${HUBS_KEY} ${hubsText(state.hubs)}`);
    if (hub.prefix !== null && !state.hubs.some((h) => h.prefix === hub.prefix)) {
      fails.push(`${id}: ${HUBS_KEY} at ${at} lists ${state.hubs.map((h) => h.prefix).join(', ')}, and not this hub's prefix ${hub.prefix}. This hub cannot request an exception for a repository that does not name it. Run the spoke install from this hub first`);
    }
    for (const h of state.hubs) prefixes.add(h.prefix);
  }

  stdout.write(`${lines.join('\n')}\n`);
  for (const f of fails) stderr.write(`FAIL: ${f}\n`);
  for (const c of cannot) stderr.write(`CANNOT VERIFY: ${c}\n`);
  if (hub.prefix === null) stderr.write(`NOTE: this hub has no key prefix in ${KEYS_PATH}, so the script cannot check that each repository names this hub\n`);
  if (cannot.length) { stderr.write(reasonLine(firstReason)); process.exit(EXIT.CANNOT_VERIFY); }
  if (fails.length) process.exit(EXIT.FAIL);
  stdout.write(`hubs: ${JSON.stringify([...prefixes].sort())}\n`);
}

/* ---------------------------------------------------------------- --siblings */

/** The new document's globs and alwaysApply, from its header. Exit 1 when it does not parse. */
function readDocument(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    usage(`cannot read the document ${path}: ${err.message}`);
  }
  const doc = parseDocument(path, text, HUB_DOCUMENT_KINDS);
  if (doc.findings.length) {
    throw new SpokeError(EXIT.FAIL, `the document does not parse, so its globs cannot be trusted. Fix it first (check-context.mjs --offline names the same findings):\n  - ${doc.findings.join('\n  - ')}`);
  }
  return doc;
}

const statusOf = (d) => (d.kind === 'adr' && d.supersedes ? `Superseded by ${d.supersedes}` : d.status);
const bindsDoc = (d) => (d.kind === 'adr' ? d.status === 'Accepted' : d.status === 'Active');

/** One sibling hub at its trunk head, its documents read, or a SpokeError. */
function readSibling(url) {
  const tmp = mkdtempSync(join(tmpdir(), 'harness-sibling-'));
  try {
    const dir = join(tmp, 'hub.git');
    git(['init', '--bare', '--quiet', dir]);
    const { trunk } = resolveDefaultBranch(url, dir);
    const commit = fetchOne(dir, url, trunk);
    return { trunk, commit, ...readFoldersAt(dir, commit, HUB_DOCUMENT_KINDS, `the hub at ${url}`) };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function readSiblings(args) {
  const doc = readDocument(args.siblings);
  const registry = loadRegistry(args.registry);
  const hub = thisHub();
  const origin = hubOrigin();
  const lines = [hub.line, `Document: ${doc.name} (${doc.kind}) · ${doc.alwaysApply ? 'always on' : `globs ${JSON.stringify(doc.globs)}`}`];
  const cannot = [];
  const notes = [];

  if (!doc.alwaysApply && !doc.globs.length) {
    lines.push('No spoke covered: the document has no globs and is not always on, so it binds only a design that names it, and no sibling hub is read.');
    stdout.write(`${lines.join('\n')}\n`);
    return;
  }

  // Every listed spoke the document covers, and the hubs its HUBS line names.
  const covers = (p) => doc.alwaysApply === true || matchesGlobs(p, doc.globs);
  const siblings = new Map();
  const ids = Object.keys(registry.repositories).sort();
  lines.push(`Spokes: ${ids.length} listed, each read at its trunk head`);
  for (const id of ids) {
    let read;
    try {
      read = readTrunk(id, registry.repositories[id]);
    } catch (err) {
      if (!(err instanceof SpokeError)) throw err;
      cannot.push(`${id}: ${err.message}`); because(err.reason);
      continue;
    }
    const at = `${id} at ${short(read.commit)}`;
    const paths = git(['--git-dir', read.dir, 'ls-tree', '-r', '--name-only', '-z', read.commit], { env: quietGitEnv(), maxBuffer: 256 * 1024 * 1024 }).split('\0').filter(Boolean);
    const covered = paths.filter(covers);
    if (!covered.length) {
      lines.push(`  - ${at}: not covered`);
      continue;
    }
    const state = readHubsAt(read.dir, read.commit, read.entry.checks);
    if (state === null || state.state === 'not-configured') {
      lines.push(`  - ${at}: covered (${covered.length} path(s)); ${HUBS_KEY} NOT CONFIGURED, so no other hub is known`);
      notes.push(`${id} has no ${HUBS_KEY} line on its trunk: it is not installed, so no hub's story-gate guards it yet, and no sibling hub can be read for it`);
      continue;
    }
    if (state.state === 'invalid') {
      cannot.push(`${id}: ${HUBS_KEY} at ${short(read.commit)} is malformed, so the hubs that own it are unknown: ${state.findings.join('; ')}`); because('config-invalid');
      continue;
    }
    const others = state.hubs.filter((h) => h.prefix !== hub.prefix && h.hub !== origin.name);
    lines.push(`  - ${at}: covered (${covered.length} path(s), for example ${covered[0]}); ${HUBS_KEY} ${hubsText(state.hubs)}`);
    for (const h of others) {
      if (!siblings.has(h.prefix)) siblings.set(h.prefix, { hub: h.hub, spokes: [], covered: [] });
      const s = siblings.get(h.prefix);
      s.spokes.push(id);
      s.covered.push(...covered.map((p) => ({ id, path: p })));
    }
  }

  for (const prefix of args.skip.keys()) {
    if (!siblings.has(prefix)) notes.push(`--skip-hub ${prefix}: ${prefix} is not a sibling hub of the spokes this document covers, so nothing was skipped`);
  }

  if (!siblings.size) {
    lines.push('Siblings: none. No covered spoke names another hub.');
  } else {
    lines.push(`Siblings: ${[...siblings.keys()].sort().map((p) => `${p} ${siblings.get(p).hub} (shares ${siblings.get(p).spokes.join(', ')})`).join('; ')}`);
  }
  for (const [prefix, reason] of args.skip) {
    if (siblings.has(prefix)) lines.push(`Skipped: ${prefix} ${siblings.get(prefix).hub} — ${reason}`);
  }
  stdout.write(`${lines.join('\n')}\n`);

  let read = 0;
  for (const prefix of [...siblings.keys()].sort()) {
    if (args.skip.has(prefix)) continue;
    const s = siblings.get(prefix);
    const url = origin.url === null && !process.env.HARNESS_HUB_BASE ? null : siblingUrl(origin.url, s.hub);
    if (url === null) {
      cannot.push(`the sibling hub ${prefix} ${s.hub}: cannot derive its URL from this hub's origin remote (${origin.url || 'none'}). Set HARNESS_HUB_BASE, or pass --skip-hub "${prefix}=<reason>"`); because('no-remote');
      continue;
    }
    let sib;
    try {
      sib = readSibling(url);
    } catch (err) {
      if (!(err instanceof SpokeError)) throw err;
      cannot.push(`the sibling hub ${prefix} ${s.hub} cannot be read with your access: ${err.message}. Ask for read access, or pass --skip-hub "${prefix}=<reason>"`); because(err.reason);
      continue;
    }
    read += 1;
    const binding = sib.documents.filter(bindsDoc);
    const overlap = (d) => d.alwaysApply === true || !d.globs.length || s.covered.some((c) => matchesGlobs(c.path, d.globs));
    const full = binding.filter(overlap);
    const rest = binding.filter((d) => !overlap(d));
    const out = [
      '',
      `=== Sibling: ${prefix} ${s.hub} at ${sib.commit} (trunk ${sib.trunk}), sharing ${s.spokes.join(', ')}`,
      `Records and standards: ${binding.length} binding; ${full.length} cover a path this document covers, are always on, or have no globs`,
    ];
    for (const f of sib.findings) out.push(`Note: ${f}`);
    for (const d of full) {
      const where = d.alwaysApply ? 'always on' : !d.globs.length ? 'no globs: read by name' : `covers ${s.covered.filter((c) => matchesGlobs(c.path, d.globs)).slice(0, 3).map((c) => `${c.id}:${c.path}`).join(', ')}`;
      out.push(`--- ${prefix} ${d.name} · ${d.kind} · ${statusOf(d)} · ${where}`);
      out.push(`Cite: ${s.hub}@${short(sib.commit)}:${d.path}`);
      out.push(printedBody(d.body).trimEnd());
    }
    if (rest.length) {
      out.push('Index of its other binding documents (their globs cover none of the paths this document covers):');
      for (const d of rest) out.push(`- ${prefix} ${d.name} · ${d.kind} · ${statusOf(d)} · ${d.description}`);
    }
    stdout.write(`${out.join('\n')}\n`);
  }

  stdout.write(`\nRead: ${read} sibling hub(s); skipped ${[...args.skip.keys()].filter((p) => siblings.has(p)).length}; cannot verify ${cannot.length}\n`);
  for (const n of notes) stderr.write(`NOTE: ${n}\n`);
  for (const c of cannot) stderr.write(`CANNOT VERIFY: ${c}\n`);
  if (cannot.length) { stderr.write(reasonLine(firstReason)); process.exit(EXIT.CANNOT_VERIFY); }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.repos !== null) readRepos(args);
  else readSiblings(args);
}

// The last line of an exit 2, 3 or 4 names this script and its code, so a shell line that hides
// the code, with a pipe or `; echo`, still tells the harness's failure record. Written at once,
// so a process.exit() never loses it.
process.on('exit', (code) => { if (code >= 2 && code <= 4) { try { writeSync(2, `HARNESS EXIT: read-hubs ${code}\n`); } catch { /* stderr is closed */ } } });

try {
  main();
} catch (err) {
  if (err instanceof SpokeError) {
    stderr.write(`${err.exit === EXIT.CANNOT_VERIFY ? 'CANNOT VERIFY' : 'FAIL'}: ${err.message}\n${reasonLine(err.reason)}`);
    process.exit(err.exit);
  }
  stderr.write(`INTERNAL: ${err && err.stack ? err.stack : String(err)}\n`);
  process.exit(EXIT.INTERNAL);
}

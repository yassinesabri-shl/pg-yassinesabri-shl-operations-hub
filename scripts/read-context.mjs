#!/usr/bin/env node
// Part of the harness asset library c6f3b4427d58f7c3 (see VERSION.json) · 2026-09-16
/**
 * read-context.mjs — the context documents that bind one design, selected and
 * printed as text with the commit they were read at.
 *
 *   usage:  node scripts/read-context.mjs <repo-id> [--at <commit|12-hex>] [--global <commit>]
 *               [--design <file>] [--paths <a,b,...>] [--names <a,b,...>] [--all] [--sources <slug>]
 *               [--registry <file>]
 *           node scripts/read-context.mjs --hub [--global <commit>] [--names <a,b,...>] [--all] [--sources <slug>]
 *           node scripts/read-context.mjs <repo-id> --pinned <design> [--registry <file>]
 *
 *   <repo-id>   a key in docs/estate/repositories.json: the repository the story names
 *   --hub       the hub's documents alone: no repository, no registry, no remote.
 *               What /feature reads before its interview, when no story and no
 *               spoke are named yet. Takes --names, --all and --sources; refuses --at,
 *               --design and --paths, because selection by path belongs to a design
 *   --at        read the spoke at this commit instead of the trunk head, as
 *               read-spoke.mjs does -- the commit the design's `Rules:` line pins.
 *               A full 40-character commit, or its first 12 characters
 *   --global    read the global layer too, at this commit of the global
 *               repository: the commit the feature's `Global:` line records,
 *               which `read-global.mjs --resolve` printed. The URL is the one in
 *               docs/estate/global.json. Global documents join the index and the
 *               selection with the prefix `global.` on their ids, and come first,
 *               because they rank first. Without --global, nothing global is read
 *   --design    a design file on disk. Its §3.1 "Components changed or added"
 *               table names the paths the change touches; any document id the
 *               design names anywhere outside a code fence selects that document
 *   --paths     paths the change touches, comma-separated, added to --design's
 *   --names     document ids, comma-separated, added to the ones --design names
 *   --all       every document in scope, with bodies, for inspection
 *   --sources   a feature's slug. Prints the index lines of that feature's
 *               requirements sources, which the default index leaves out, and
 *               no other line. Refuses --design, --paths, --names and --all.
 *               A slug that names no feature in scope is a usage error
 *   --pinned    a merged design on disk. Reads each entry of its one `Context:`
 *               line at the bytes the entry pins -- a hub entry at the commit
 *               the design's one `Hub commit:` line names, which must be on the
 *               hub's origin trunk, force-fetched and confirmed against
 *               HARNESS_TRUNK; a spoke entry found among the commits of the
 *               spoke's trunk -- and prints each with a `Pin:` line
 *               (`current`, or `drift: <pin> → <now>` / `→ removed`) and a
 *               `Cite:` line naming the commit the bytes were found at. Reads the
 *               design's one `Rules:` line too, and the spoke's rules at the
 *               commit it cites, for the `Overridden:` lines. What
 *               /dev-sprint hands its seats. Takes --registry; refuses --at,
 *               --design, --paths, --names, --all, --hub and --global. A global
 *               entry is read at the commit the feature records: the `Global:`
 *               line of the requirements document the design's work item is cut
 *               from, on the hub's trunk, as the pickup gate finds it. The entry's
 *               pin must be that commit. The bytes are fetched from the global
 *               repository docs/estate/global.json names, and the `Pin:` line
 *               says `release <tag> at <12-hex>`, because a commit never drifts.
 *
 * With none of --design, --paths, --names, --all or --sources, this prints the
 * INDEX: one line per document in scope -- the hub's and this repository's --
 * and no bodies. That is what a design author reads first: enough to know a document
 * exists and what it is called, and nothing more, so the window holds the
 * working set rather than the corpus.
 *
 * A requirements source has no index line, because no command reads it from
 * the index. The /feature runs of its feature and check-requirements.js open a
 * source by its path. The `Index:` line says how many sources it left out.
 * `--names <id>` still opens one, `--all` still prints every one, and
 * `--sources <slug>` lists the sources of one feature.
 *
 * With --hub, the same index, and the same selection by --names or --all, over
 * the hub's documents only. The working directory is read and nothing is
 * fetched, so the read cannot fail for want of a remote. The header then says
 * `Repository: hub`, `Commit: not asked` and `Trunk: not asked`, and carries no
 * `Spoke:` line. `--hub --global <commit>` asks one remote, the global
 * repository, and reads nothing else from outside the working directory. The hub's documents include every requirements document,
 * `docs/requirements/<slug>/requirements.md`, one index line each with its
 * status -- `accepted` when the review beside it approves its bytes and the
 * local trunk ref (refs/remotes/origin/<HARNESS_TRUNK, or main>, never fetched)
 * carries those bytes, `proposed` otherwise, as on an amendment's open branch
 * -- so /feature finds an overlap with an intent from the index and opens the
 * one document by `--hub --names <slug>`, never the corpus. After its interview,
 * /feature selects with `--hub --names <id>,...` and the requirements document
 * copies the `Context:` line printed; `--names ''` selects the always-on
 * documents alone, and prints `Context: none` when there are none.
 *
 * What it prints, always, before any document:
 *
 *   Repository: <id>                               (or "hub" with --hub)
 *   Commit: <40-hex>                               (or "not asked" with --hub)
 *   Trunk: <branch as the remote reports it now>   (or "not asked" with --at or --hub)
 *   Hub: <n> document(s)
 *   Hub commit: <40-hex>                           the hub checkout's HEAD, which
 *                                                  the artefact copies beside Context:
 *   Global: <n> document(s) at <40-hex>           (only with --global)
 *   Spoke: <n> document(s) in <folder> | none declared | NOT CONFIGURED   (absent with --hub)
 *   Spoke records: ...                             (the same three states; absent with --hub)
 *   Spoke rules: <n> rule(s) in <folder> | none declared | NOT CONFIGURED  (absent with --hub)
 *   Paths: <p1>, <p2>                              (or "(none given)")
 *   Names: <id>, <id>                              (or "(none given)")
 *   Selected: <n> of <m>: <id>, <id>
 *   Overrides: <n> from <m> standard(s)            (or "Overrides: none"; absent with --hub)
 *   Note: <a spoke rule overrides a standard not in scope here>   (zero or more)
 *   Context: <entry>, <entry>                      (or "Context: none")
 *   ---
 *   Document: <id>
 *   Kind: <kind> · Rank: <n | unranked> · Owner: <role> · Revision: <text>
 *                                                  (a record, a standard or a requirements document: · Status: <status>)
 *   Hubs: <prefix>, ... · Departs: global.<id>, ... · Repositories: <id>, ... · Status: <status> · Review-by: <date>
 *                                                  (a global exception only, here and under --pinned)
 *   Overridden: <id> by <repository-id>:<rule>, ...
 *                                                  (a standard a spoke rule overrides, here and under --pinned)
 *   Cite: <id>@<12-hex>:<path>                     (a hub document: Cite: <path>;
 *                                                  a global one: Cite: global@<12-hex>:<path>)
 *   <the body, header removed>
 *   ---
 *
 * An index line is `- <id> · <kind> · <repository> · rank <n> | unranked [· always on]
 * [· <status>] · <description>`; the status is printed for a requirements
 * document and a decision record, whose rank is their status, for a standard,
 * which binds by its globs only when Active, and for an exception, which has
 * effect only when Active. A global document that no longer binds -- a
 * superseded or deprecated record, a Reserved standard, a withdrawn exception
 * -- leaves the index, and the `Index:` line says how many left. `--names
 * global.<id>` still opens one. A hub's or a spoke's document stays in the
 * index whatever its status.
 *
 * The `Context:` line is the value a design carries on its own `Context:` line
 * beside `Rules:`. Copy it; never type it. Each entry names one selected
 * document three ways: its id, the first twelve characters of the blob hash of
 * the bytes read, and where the file is --
 *
 *   <id>@<12-hex>:<path>                           a hub document
 *   <id>@<12-hex>:<repository-id>:<path>           a document kept in the spoke
 *   <id>@<12-hex>:global:<path>                    a global document. Its pin is
 *                                                  the global commit's, not the blob's
 *
 * -- so a reader sees which file was read, and the pickup gate can say when a
 * hub document moved after the design read it.
 *
 * The `Hub commit:` line is copied beside it. It names the commit the hub
 * checkout stood on when the hub's documents were read, so an architect can
 * trace each pinned document to a point in the hub's history, and the gates
 * can prove that the commit holds every hub entry's bytes. A selected hub
 * document whose bytes on disk are not the bytes at HEAD is a finding, exit 1:
 * the line would name a commit that never held what the Context: line pins.
 * Commit the change or discard it, then run again. The hub must be a git
 * checkout with a commit, or the read is exit 2.
 *
 * Overrides. A spoke rule may carry `overrides`: the hub or global standards,
 * or single standard rules, it replaces where it binds (`.claude/rules/estate.md`
 * §3). This script reads the spoke's rules folder at the same commit as its
 * documents -- under --pinned, at the commit the design's `Rules:` line cites --
 * selects the rules that bind the change the way read-spoke-rules.mjs does, and
 * prints an `Overridden:` line in each standard they touch. An overridden
 * standard rule does not bind this change; the spoke rule does. An override of
 * a rule the standard does not define is a finding, exit 1. An override of a
 * standard that is not in scope here is a `Note:` line and has no effect. A
 * malformed rules folder is a finding too, because it binds nobody and its
 * overrides cannot be read. Every document is read live --
 * the hub's from the working directory, the spoke's at one commit -- and never
 * from any saved list, so a hub pin is of the bytes on disk: read from an
 * up-to-date trunk, or the pin names bytes nobody merged.
 *
 * Exit codes
 *   0  read -- including a spoke that declares no contracts, or has not said, which
 *      are facts about the repository and not failures of this read
 *   1  a document in scope is malformed, the spoke's rules folder is malformed,
 *      or a spoke rule overrides a rule its standard does not define. A malformed
 *      set binds nobody, so nothing is selected until it is fixed -- or, with
 *      --pinned, an entry no commit on the trunk ever held, a bare-id entry, an
 *      entry kept in another repository, a Context: line missing or doubled, a
 *      Hub commit: line missing, doubled, not a full commit hash, naming a
 *      commit the hub's trunk does not hold or one that does not hold a hub
 *      entry's bytes, a
 *      Rules: line missing, doubled or citing a commit the spoke's trunk does not
 *      hold, or a global entry whose requirements document records no release,
 *      whose pin is another commit, or whose path is not at the commit
 *   2  cannot verify: no registry, the remote is unreachable, or --at names a
 *      commit neither the cache nor the remote will give up, or a 12-character
 *      --at matches no commit on the trunk, or more than one -- or, with --global,
 *      the hub has no docs/estate/global.json, the global repository does not
 *      answer, or it will not give up the commit -- or the hub is not a git
 *      checkout with a HEAD commit. With --hub alone no remote is asked and no
 *      registry opened -- or, with --pinned, the hub's
 *      origin cannot be reached, or reports a trunk other than HARNESS_TRUNK,
 *      or the global repository does not give up the recorded commit
 *   3  usage: bad arguments, a repository id not in the list, --global that is
 *      not a full commit hash, or --hub beside a repository id, --at, --design,
 *      --paths or --registry -- or --sources beside --design, --paths, --names or
 *      --all, or --sources with a slug that names no feature in scope -- or, with
 *      --pinned, --at, --design, --paths, --names, --all, --hub, --global or
 *      --sources beside it, or a design file it cannot read
 *   4  internal
 */

import { readFileSync, writeSync } from 'node:fs';
import { stdout, stderr } from 'node:process';
import {
  EXIT, REPO_ID, COMMIT, GLOBAL_ID, SpokeError, reasonLine, atProblem, pinAt,
  registryPath, readRegistry, validateRegistry, globalPath, readGlobalLink,
  resolveDefaultBranch, resolveSpokeTrunk, cacheDir, hasCommit, fetchOne, fetchBranchFully, short,
  git, quietGitEnv, firstLine, catAt,
} from './spoke-remote.mjs';
import { designPaths, orderRules, readRulesAt, selectRules } from './spoke-rules.mjs';
import {
  HUB, GLOBAL, CONTEXT_PIN, KINDS, contextLine, designNames, exceptionLine, indexLine, indexRows, printedBody, readGlobalDocumentsAt, readSpokeDocumentsAt, scanHub, selectRows, sortRows, sourceSlug, toRow,
  parseContextLine, parseDocument, headBlob, blobText, designKey, recordedRelease,
  overrideReport, overriddenLine, overridesLine, parseRulesLine,
  HUB_COMMIT_LABEL, hubCommitLine, parseHubCommitLine, hubHead, uncommittedHubDocuments,
} from './context-docs.mjs';

function usage(message) {
  const invoked = process.argv[1] || 'scripts/read-context.mjs';
  stderr.write(`${message}
usage: node ${invoked} <repo-id> [--at <commit|12-hex>] [--global <commit>] [--design <file>] [--paths <a,b>] [--names <a,b>] [--all] [--sources <slug>] [--registry <file>]
       node ${invoked} --hub [--global <commit>] [--names <a,b>] [--all] [--sources <slug>]
       node ${invoked} <repo-id> --pinned <design> [--registry <file>]
`);
  process.exit(EXIT.USAGE);
}

function parseArgs(argv) {
  const out = { positional: [], at: null, design: null, paths: null, names: null, all: false, registry: null, hub: false, pinned: null, global: null, sources: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--all') {
      out.all = true;
    } else if (a === '--hub') {
      out.hub = true;
    } else if (a === '--at' || a === '--registry' || a === '--design' || a === '--paths' || a === '--names' || a === '--pinned' || a === '--global' || a === '--sources') {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) usage(`${a} needs a value`);
      out[a.slice(2)] = v;
      i += 1;
    } else if (a.startsWith('--')) {
      usage(`unknown option ${a}`);
    } else {
      out.positional.push(a);
    }
  }
  return out;
}

const list = (xs) => (xs.length ? xs.join(', ') : '(none given)');

// The repository's entry in the hub's list, or a usage stop naming what is listed.
function registryEntry(id, registryArg) {
  const regPath = registryPath(registryArg);
  const registry = readRegistry(regPath);
  const problems = validateRegistry(registry, regPath);
  if (problems.length) {
    throw new SpokeError(EXIT.FAIL, `the registry is not well formed; run check-registry first:\n  - ${problems.join('\n  - ')}`);
  }
  const entry = registry.repositories[id];
  if (!entry) {
    const known = Object.keys(registry.repositories);
    usage(`"${id}" is not in ${regPath}. Listed: ${known.length ? known.join(', ') : '(nothing yet)'}. Add it with /add-repo`);
  }
  return entry;
}

// The hub's trunk for --pinned: the default branch its origin reports, checked
// against HARNESS_TRUNK when that is set, force-fetched with its whole history,
// so a pin is looked up among the commits a person merged and nowhere else.
function hubTrunk(root) {
  let url;
  let gitDir;
  try {
    url = git(['remote', 'get-url', 'origin'], { cwd: root }).trim();
    gitDir = git(['rev-parse', '--absolute-git-dir'], { cwd: root }).trim();
  } catch (err) {
    throw new SpokeError(EXIT.CANNOT_VERIFY, `the hub checkout has no origin to read its trunk from: ${firstLine(err.stderr) || err.message}`, 'no-remote');
  }
  const { trunk } = resolveDefaultBranch(url, gitDir);
  const named = process.env.HARNESS_TRUNK;
  if (named && named !== trunk) {
    throw new SpokeError(EXIT.CANNOT_VERIFY, `HARNESS_TRUNK is "${named}", and the hub's origin reports its default branch as "${trunk}"; the two must agree before a pin is looked up`, 'trunk-mismatch');
  }
  const ref = `refs/remotes/origin/${trunk}`;
  try {
    const shallow = git(['rev-parse', '--is-shallow-repository'], { cwd: root }).trim() === 'true';
    git(['fetch', '--quiet', '--force', '--no-tags', ...(shallow ? ['--unshallow'] : []), 'origin', `+refs/heads/${trunk}:${ref}`], { cwd: root, env: quietGitEnv() });
  } catch (err) {
    throw new SpokeError(EXIT.CANNOT_VERIFY, `cannot fetch ${trunk} from the hub's origin ${url}: ${firstLine(err.stderr) || err.message}`, 'fetch-failed');
  }
  return { trunk, ref, head: git(['rev-parse', ref], { cwd: root }).trim() };
}

// The revision of `path` on `ref` whose blob hash starts with `pin`: the commits
// on `ref` that changed the path, newest first, and the first whose blob there
// matches. `{ commit, blob }`, or null when no commit on `ref` ever held those
// bytes -- bytes nobody merged. A spoke entry is found this way, because a
// design records no commit for a spoke's documents beyond its Rules: line.
function spokeRevision(gitArgs, ref, path, pin) {
  const commits = git([...gitArgs, 'log', '--format=%H', ref, '--', path]).split('\n').filter(Boolean);
  for (const c of commits) {
    const blob = headBlob(gitArgs, c, path);
    if (blob !== null && blob.startsWith(pin)) return { commit: c, blob };
  }
  return null;
}

// The full hash of a commit a design cites -- the Rules: line's twelve
// characters, or the Hub commit: line's forty -- when the trunk holds it; null
// otherwise. A pin on an unmerged branch is a design written against rules or
// documents nobody merged.
function commitOnTrunk(gitArgs, pin, trunkHead) {
  let full;
  try {
    full = git([...gitArgs, 'rev-parse', '--verify', '--quiet', `${pin}^{commit}`]).trim();
  } catch {
    return null;
  }
  if (!full) return null;
  try {
    git([...gitArgs, 'merge-base', '--is-ancestor', full, trunkHead]);
    return full;
  } catch {
    return null;
  }
}

// The global release a design inherits, for --pinned: the Global: line of the
// requirements document its work item is cut from, on the hub's trunk -- the
// same document check-dev-ready.js reads. `{ tag, commit }`, or null with a
// finding pushed.
function pinnedRelease(designText, hub, findings) {
  const named = designKey(designText);
  if (named.finding) {
    findings.push(`the design carries a global entry, and ${named.finding}, so its requirements document cannot be found`);
    return null;
  }
  const items = git(['ls-tree', '-r', '--name-only', hub.ref, '--', 'docs/backlog'], { cwd: '.' }).split('\n')
    .filter((p) => p.split('/').length === 4 && p.endsWith(`/${named.key}.item.md`));
  if (items.length !== 1) {
    findings.push(`the design carries a global entry, and ${items.length} work items ${named.key}.item.md are under docs/backlog/ on the hub's trunk, so its requirements document cannot be found`);
    return null;
  }
  const path = `docs/requirements/${items[0].split('/')[2]}/requirements.md`;
  let text;
  try {
    text = git(['show', `${hub.ref}:${path}`], { cwd: '.' });
  } catch {
    findings.push(`the design carries a global entry, and ${path} is not on the hub's trunk (${hub.trunk})`);
    return null;
  }
  const release = recordedRelease(text);
  if (release === null || release === false) {
    findings.push(`the design carries a global entry, and ${path} ${release === null ? 'records "Global: none"' : 'carries no single "Global: vX.Y.Z <40-hex>" line'}, so no global release can be read`);
    return null;
  }
  return release;
}

// The global entries at the recorded release, read through the bare cache
// beside the spokes'. A global entry pins the commit, so its bytes never drift.
function readGlobalPinned(entries, release, findings) {
  const pin = release.commit.slice(0, CONTEXT_PIN);
  const wanted = entries.filter((e) => {
    if (e.pin === pin) return true;
    findings.push(`"${e.item}" pins the global commit ${e.pin}, and the feature records ${release.tag} at ${release.commit}; re-run scripts/read-context.mjs --global ${release.commit} for the design's paths, copy the line it prints, and amend the merged design by pull request with a human, with a fresh review`);
    return false;
  });
  if (!wanted.length) return [];
  const link = readGlobalLink();
  if (link === null) {
    findings.push(`the design carries a global entry, and the hub has no ${globalPath()}, so it has no global layer to read`);
    return [];
  }
  const dir = cacheDir(GLOBAL_ID);
  if (!hasCommit(dir, release.commit)) {
    const got = fetchOne(dir, link.url, release.commit);
    if (got !== release.commit) throw new SpokeError(EXIT.CANNOT_VERIFY, `asked ${link.url} for ${release.commit} and got ${got}`, 'fetch-failed');
  }
  const files = catAt(dir, release.commit, wanted.map((e) => e.path));
  const reads = [];
  for (const e of wanted) {
    const found = files.get(e.path);
    if (found === null || found.type !== 'blob') {
      findings.push(`"${e.id}" cites ${e.path}, which is ${found === null ? 'not' : `a ${found.type}, not a document,`} in the global repository at ${release.tag}`);
      continue;
    }
    const text = found.bytes.toString('utf8');
    // An exception's header fields print on their own line, as in the normal selection.
    let exception = null;
    if (e.path.startsWith(`${KINDS.exception.folder}/`)) {
      const doc = parseDocument(e.path, text, ['exception']);
      if (doc.findings.length) {
        findings.push(...doc.findings.map((f) => `"${e.id}" is malformed in the global repository at ${release.tag}: ${f}`));
        continue;
      }
      exception = exceptionLine(toRow(doc, { repository: GLOBAL, commit: release.commit }));
    }
    reads.push({ id: e.id, path: e.path, status: `release ${release.tag} at ${pin}`, cite: `${GLOBAL}@${pin}:${e.path}`, text, global: true, exception });
  }
  return reads;
}

// --pinned: the documents a merged design's Context: line names, at the bytes it
// pinned. Every entry is checked before exiting, so one run lists every finding.
function mainPinned(args) {
  const refused = [
    ['--at', args.at !== null], ['--design', args.design !== null], ['--paths', args.paths !== null],
    ['--names', args.names !== null], ['--all', args.all], ['--hub', args.hub], ['--global', args.global !== null], ['--sources', args.sources !== null],
  ].filter(([, given]) => given).map(([flag]) => flag);
  if (refused.length) usage(`--pinned reads the documents a design already names, at the bytes it pinned; it takes no ${refused.join(', ')}`);
  if (args.positional.length !== 1) usage('--pinned needs exactly one argument: <repo-id>, the repository the design lands in');
  const id = args.positional[0];
  if (!id.match(REPO_ID)) usage(`"${id}" is not a repository id (letters, digits, ".", "_", "-")`);
  let designText = '';
  try {
    designText = readFileSync(args.pinned, 'utf8');
  } catch (err) {
    usage(`cannot read --pinned ${args.pinned}: ${err.message}`);
  }
  const entry = registryEntry(id, args.registry);

  const parsed = parseContextLine(designText);
  const findings = [...parsed.findings];
  for (const e of parsed.entries) {
    if (!e.global && e.repository !== null && e.repository !== id) {
      findings.push(`"${e.item}" is kept in "${e.repository}"; this design lands in "${id}", and a design reads the hub's documents and its own repository's, no other`);
    }
  }
  const hubEntries = parsed.entries.filter((e) => e.repository === null);
  const spokeEntries = parsed.entries.filter((e) => e.repository === id);
  const globalEntries = parsed.entries.filter((e) => e.global);

  // The hub commit the design records: the one its hub entries are read at. It
  // must be a commit a person merged, so it is looked up on the hub's trunk.
  const hubCommit = parseHubCommitLine(designText);
  findings.push(...hubCommit.findings);

  // The spoke's rules at the commit the design's Rules: line cites, for the
  // overrides they make. A folder is read from the spoke's full trunk, which
  // the spoke entries need too.
  const rulesLine = parseRulesLine(designText);
  findings.push(...rulesLine.findings);
  if (rulesLine.cite !== null && rulesLine.cite.repository !== id) {
    findings.push(`the design's Rules: line cites "${rulesLine.cite.repository}"; this design lands in "${id}", and a design reads its own repository's rules`);
  }
  const readRules = rulesLine.cite !== null && rulesLine.cite.repository === id;

  const hub = hubTrunk('.');
  const hubAt = hubCommit.commit === null ? null : commitOnTrunk(['-C', '.'], hubCommit.commit, hub.head);
  if (hubCommit.commit !== null && hubAt === null) {
    findings.push(`the design's ${HUB_COMMIT_LABEL}: line names ${short(hubCommit.commit)}, and the hub's trunk (${hub.trunk}) does not hold that commit; the design was written against a hub nobody merged. Re-run scripts/read-context.mjs on an up-to-date trunk for the design's paths, copy the ${HUB_COMMIT_LABEL}: and Context: lines it prints, and amend the merged design by pull request with a human, with a fresh review`);
  }
  const release = globalEntries.length ? pinnedRelease(designText, hub, findings) : null;
  let commit = 'not asked';
  let spokeGit = null;
  if (spokeEntries.length || readRules) {
    const dir = cacheDir(id);
    const { trunk } = resolveSpokeTrunk(entry, dir);
    commit = fetchBranchFully(dir, entry.url, trunk);
    spokeGit = ['--git-dir', dir];
  }
  let boundRules = [];
  if (readRules) {
    const pin = rulesLine.cite.pin;
    const full = commitOnTrunk(spokeGit, pin, commit);
    if (full === null) {
      findings.push(`the design's Rules: line cites ${pin}, and ${id}'s trunk does not hold that commit; re-run scripts/read-spoke-rules.mjs for the design, copy the Rules: line it prints, and amend the merged design by pull request with a human, with a fresh review`);
    } else {
      const read = readRulesAt(spokeGit[1], full, entry.checks);
      if (read.state === 'path' && !read.findings.length) boundRules = selectRules(read.rules, designPaths(designText));
      else if (read.state === 'none' || read.state === 'not-configured') findings.push(`the design's Rules: line cites ${rulesLine.cite.folder} at ${pin}, and ${entry.checks} at that commit declares ${read.state === 'none' ? 'RULES_INDEX=none' : 'no RULES_INDEX'}`);
      else findings.push(...read.findings.map((f) => `the spoke's rules at ${pin}: ${f}`));
    }
  }

  // A hub entry is read at the commit the design's Hub commit: line names; a
  // spoke entry at the commit its Rules: line pins, found among the spoke's
  // trunk commits that changed the path.
  const reads = [];
  for (const e of [...hubEntries, ...spokeEntries]) {
    const onHub = e.repository === null;
    const where = onHub ? ['-C', '.'] : spokeGit;
    const ref = onHub ? hub.ref : commit;
    let found = null;
    if (onHub) {
      if (hubAt === null) continue; // already a finding
      const blob = headBlob(where, hubAt, e.path);
      if (blob !== null && blob.startsWith(e.pin)) found = { commit: hubAt, blob };
      else findings.push(`"${e.id}" pins ${e.pin} for ${e.path}, and the hub at ${short(hubAt)}, the commit the design's ${HUB_COMMIT_LABEL}: line names, ${blob === null ? 'has no file there' : `holds ${blob.slice(0, CONTEXT_PIN)} there`}; the two lines were not copied from one run. Re-run scripts/read-context.mjs on an up-to-date trunk for the design's paths, copy the ${HUB_COMMIT_LABEL}: and Context: lines it prints, and amend the merged design by pull request with a human, with a fresh review`);
    } else {
      found = spokeRevision(where, ref, e.path, e.pin);
      if (found === null) findings.push(`"${e.id}" pins ${e.pin} for ${e.path}, and no commit on ${id}'s trunk ever held those bytes; the design was written against bytes nobody merged. Re-run scripts/read-context.mjs on an up-to-date trunk for the design's paths, copy the line it prints, and amend the merged design by pull request with a human, with a fresh review`);
    }
    if (found === null) continue;
    const now = headBlob(where, ref, e.path);
    const status = now === null ? `drift: ${e.pin} → removed` : now.startsWith(e.pin) ? 'current' : `drift: ${e.pin} → ${now.slice(0, CONTEXT_PIN)}`;
    reads.push({ id: e.id, path: e.path, status, cite: `${onHub ? HUB : id}@${short(found.commit)}:${e.path}`, text: blobText(where, found.blob) });
  }
  if (release !== null) reads.push(...readGlobalPinned(globalEntries, release, findings));

  // The standards among the pinned reads, as rows, so the overrides are judged
  // against the rule ids the pinned bytes define.
  const standardRows = [];
  for (const r of reads) {
    if (!r.path.startsWith(`${KINDS.standard.folder}/`)) continue;
    const doc = parseDocument(r.path, r.text, ['standard']);
    if (doc.findings.length) continue;
    standardRows.push(toRow(doc, { repository: r.global ? GLOBAL : HUB, commit: null }));
  }
  const overrides = overrideReport(standardRows, boundRules, id);
  findings.push(...overrides.findings);

  const header = [
    `Repository: ${id}`,
    `Design: ${args.pinned}`,
    `Hub trunk: ${hub.trunk} at ${hub.head}`,
    hubCommit.value === null ? `${HUB_COMMIT_LABEL}: not read` : `${HUB_COMMIT_LABEL}: ${hubCommit.value}`,
    `Commit: ${commit}`,
    ...(release === null ? [] : [`Global: ${release.tag} ${release.commit}`]),
    rulesLine.value === null ? 'Rules: not read' : `Rules: ${rulesLine.value}`,
    parsed.value === null ? 'Context: not read' : `Context: ${parsed.value}`,
  ];
  if (findings.length) {
    header.push(`Status: NOT READ: ${findings.length} finding(s)`);
    stdout.write(`${header.join('\n')}\n`);
    stderr.write(`FAIL: the design's Context: line cannot be read at its pins, and no seat gets its context until it can:\n  - ${findings.join('\n  - ')}\n`);
    process.exit(EXIT.FAIL);
  }
  const drifted = reads.filter((r) => r.status.startsWith('drift')).length;
  const fixed = reads.filter((r) => r.global).length;
  header.push(`Pinned: ${reads.length} document(s): ${reads.length - drifted - fixed} current, ${drifted} drift${fixed ? `, ${fixed} at the global release` : ''}`);
  header.push(overridesLine(overrides));
  for (const n of overrides.notes) header.push(`Note: ${n}`);
  stdout.write(`${header.join('\n')}\n`);
  for (const r of reads) {
    // Trimmed for reading: leading blank lines dropped, one final newline. The
    // Pin: line, not this text, is the claim about the exact bytes.
    const body = r.text.replace(/^\n+/, '').replace(/\n*$/, '\n');
    const overridden = overriddenLine(overrides.byStandard, r.id);
    stdout.write(`---\nDocument: ${r.id}\nPin: ${r.status}\n${r.exception ? `${r.exception}\n` : ''}${overridden ? `${overridden}\n` : ''}Cite: ${r.cite}\n${body}`);
  }
  if (!reads.length) stdout.write('---\n');
}

// --global: the global repository's documents at the one commit asked for,
// through the bare cache beside the spokes', named by the reserved id. The hub
// must have the link file, because a hub without one has no global layer.
function readGlobalAt(commit) {
  const link = readGlobalLink();
  if (link === null) {
    throw new SpokeError(EXIT.CANNOT_VERIFY, `--global names ${commit}, and the hub has no ${globalPath()}, so it has no global layer to read. A feature whose requirements say "Global: none" reads without --global`, 'global-missing');
  }
  const dir = cacheDir(GLOBAL_ID);
  if (!hasCommit(dir, commit)) {
    const got = fetchOne(dir, link.url, commit);
    if (got !== commit) throw new SpokeError(EXIT.CANNOT_VERIFY, `asked ${link.url} for ${commit} and got ${got}`, 'fetch-failed');
  }
  return readGlobalDocumentsAt(dir, commit);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.pinned !== null) {
    mainPinned(args);
    return;
  }
  if (args.hub) {
    // The hub alone: what /feature reads before there is a story or a spoke to
    // name. Nothing that needs a repository, a commit or a design is accepted.
    if (args.positional.length) usage(`--hub reads the hub's documents alone and takes no repository id; got "${args.positional[0]}"`);
    if (args.at !== null) usage('--hub takes no --at: the hub is read live from the working directory, never at a commit');
    if (args.design !== null || args.paths !== null) usage('--hub takes no --design and no --paths: selection by path belongs to a design, and a hub-only read has none');
    if (args.registry !== null) usage('--hub opens no registry; drop --registry');
  } else {
    if (args.positional.length !== 1) usage('expected exactly one argument: <repo-id> (or --hub, for the hub\'s documents alone)');
    if (!REPO_ID.test(args.positional[0])) usage(`"${args.positional[0]}" is not a repository id (letters, digits, ".", "_", "-")`);
    if (args.at !== null && atProblem(args.at)) usage(atProblem(args.at));
  }
  if (args.sources !== null) {
    // A listing of one feature's sources selects nothing, so it takes no selector.
    const selectors = [['--design', args.design !== null], ['--paths', args.paths !== null], ['--names', args.names !== null], ['--all', args.all]]
      .filter(([, given]) => given).map(([flag]) => flag);
    if (selectors.length) usage(`--sources lists the sources of one feature and selects nothing; it takes no ${selectors.join(', ')}`);
  }
  if (args.global !== null && !args.global.match(COMMIT)) usage(`--global must be the full 40-character commit hash the feature's Global: line records, got "${args.global}"`);
  const id = args.hub ? HUB : args.positional[0];

  let designText = null;
  if (args.design !== null) {
    try {
      designText = readFileSync(args.design, 'utf8');
    } catch (err) {
      usage(`cannot read --design ${args.design}: ${err.message}`);
    }
  }
  const paths = [...new Set([
    ...(designText === null ? [] : designPaths(designText)),
    ...(args.paths === null ? [] : args.paths.split(',').map((p) => p.trim()).filter(Boolean)),
  ])];
  const givenNames = args.names === null ? [] : args.names.split(',').map((p) => p.trim()).filter(Boolean);
  const indexMode = designText === null && args.paths === null && args.names === null && !args.all;

  let entry = null;
  if (!args.hub) entry = registryEntry(id, args.registry);

  // The hub's documents, live from the working directory, and the commit the
  // checkout stands on: what the artefact's Hub commit: line records.
  const hub = scanHub('.');
  const head = hubHead('.');

  // The global layer's documents, at the one commit the feature records.
  const global = args.global === null ? { documents: [], findings: [] } : readGlobalAt(args.global);

  // The spoke's documents, live at one commit -- unless the hub alone was asked for.
  let commit = 'not asked';
  let trunk = 'not asked';
  let spoke = { state: 'not asked', documents: [], findings: [] };
  let spokeRules = { state: 'not asked', rules: [], findings: [] };
  if (!args.hub) {
    const dir = cacheDir(id);
    if (args.at === null) {
      ({ trunk, head: commit } = resolveSpokeTrunk(entry, dir));
    } else {
      commit = pinAt(id, entry, dir, args.at);
    }
    spoke = readSpokeDocumentsAt(dir, commit, entry.checks);
    // The spoke's rules at the same commit, for the overrides they make. A
    // malformed folder binds nobody, so it is a finding here as it is in
    // read-spoke-rules.mjs.
    if (spoke.contracts.state !== 'no-commands-file') {
      spokeRules = readRulesAt(dir, commit, entry.checks);
      spokeRules.findings = spokeRules.findings.map((f) => `the spoke's rules: ${f}`);
    }
  }

  const header = [`Repository: ${id}`, `Commit: ${commit}`, `Trunk: ${trunk}`, `Hub: ${hub.documents.length} document(s)`, hubCommitLine(head)];
  if (args.global !== null) header.push(`Global: ${global.documents.length} document(s) at ${args.global}`);
  if (!args.hub) {
    if (spoke.contracts.state === 'no-commands-file') {
      stdout.write(`${header.join('\n')}\n`);
      stderr.write(`NOT FOUND: ${entry.checks} is not in ${id} at ${short(commit)} (trunk: ${trunk})\n`);
      process.exit(EXIT.FAIL);
    }
    for (const [label, read] of [['Spoke', spoke.contracts], ['Spoke records', spoke.decisions]]) {
      if (read.state === 'path') header.push(`${label}: ${read.documents.length} document(s) in ${read.path}`);
      else if (read.state === 'none') header.push(`${label}: none declared (${read.key}=none)`);
      else if (read.state === 'not-configured') header.push(`${label}: NOT CONFIGURED (${read.key} missing or UNRESOLVED)`);
      else header.push(`${label}: ${read.state.replace(/-/g, ' ')}`);
    }
    if (spokeRules.state === 'path') header.push(`Spoke rules: ${spokeRules.rules.length} rule(s) in ${spokeRules.path}`);
    else if (spokeRules.state === 'none') header.push('Spoke rules: none declared (RULES_INDEX=none)');
    else if (spokeRules.state === 'not-configured') header.push('Spoke rules: NOT CONFIGURED (RULES_INDEX missing or UNRESOLVED)');
    else header.push(`Spoke rules: ${spokeRules.state.replace(/-/g, ' ')}`);
  }

  const findings = [...global.findings, ...hub.findings, ...spoke.findings, ...spokeRules.findings];
  const rows = sortRows([
    ...global.documents.map((d) => toRow(d, { repository: GLOBAL, commit: args.global })),
    ...hub.documents.map((d) => toRow(d, { repository: HUB, commit: null })),
    ...spoke.documents.map((d) => toRow(d, { repository: id, commit })),
  ]);
  const seen = new Set();
  for (const r of rows) {
    if (seen.has(r.id)) findings.push(`id "${r.id}" names two documents; a design cannot say which it read`);
    seen.add(r.id);
  }
  // The spoke rules that bind this change, selected as read-spoke-rules.mjs
  // selects them, and the standards they override. Nothing for the index.
  const boundRules = indexMode || spokeRules.state !== 'path' || spokeRules.findings.length
    ? []
    : args.all ? orderRules(spokeRules.rules) : selectRules(spokeRules.rules, paths);
  const overrides = overrideReport(rows, boundRules, id);
  findings.push(...overrides.findings);
  if (findings.length) {
    header.push(`Status: NOT WELL FORMED: ${findings.length} finding(s)`);
    stdout.write(`${header.join('\n')}\n`);
    stderr.write(`FAIL: a document in scope is malformed, and a malformed set binds nobody until it is fixed:\n  - ${findings.join('\n  - ')}\n`);
    process.exit(EXIT.FAIL);
  }

  if (indexMode) {
    if (args.sources !== null) {
      // One feature's sources, the lines the default index leaves out.
      const features = [...new Set(rows.flatMap((r) => (r.kind === 'requirements-document' ? [r.id] : r.kind === 'requirements-source' ? [sourceSlug(r)] : [])))].sort();
      if (!features.includes(args.sources)) usage(`--sources ${args.sources}: no feature in scope has that slug. Features: ${features.length ? features.join(', ') : '(none)'}`);
      const sources = rows.filter((r) => sourceSlug(r) === args.sources);
      header.push(`Index: ${sources.length} requirements source(s) of ${args.sources}; pass --names <id> to open one`);
      stdout.write(`${header.join('\n')}\n---\n`);
      for (const r of sources) stdout.write(`${indexLine(r)}\n`);
      return;
    }
    // A global document that no longer binds, and a requirements source, leave
    // the index. --names still opens either, and --sources lists the sources.
    const listed = indexRows(rows);
    const sources = rows.filter((r) => r.kind === 'requirements-source').length;
    const unbound = rows.length - listed.length - sources;
    const notes = [
      ...(unbound ? [`; ${unbound} global document(s) that no longer bind left out, and --names global.<id> opens one`] : []),
      ...(sources ? [`; ${sources} requirements source(s) left out, and --sources <slug> lists those of one feature`] : []),
    ];
    header.push(`Index: ${listed.length} document(s) in scope; pass ${args.hub ? '--names or --all' : '--design, --paths, --names or --all'} to select${notes.join('')}`);
    stdout.write(`${header.join('\n')}\n---\n`);
    for (const r of listed) stdout.write(`${indexLine(r)}\n`);
    return;
  }

  const ids = rows.map((r) => r.id);
  const names = [...new Set([...(designText === null ? [] : designNames(designText, ids)), ...givenNames])];
  const unknown = givenNames.filter((n) => !ids.includes(n));
  if (unknown.length) usage(`--names ${unknown.join(', ')}: not a document in scope. In scope: ${ids.length ? ids.join(', ') : '(none)'}`);
  const selected = args.all ? rows : selectRows(rows, id, { paths, names });
  // A selected hub document must be the bytes at HEAD, or the Hub commit: line
  // would name a commit that never held what the Context: line pins.
  const uncommitted = uncommittedHubDocuments('.', head, selected);
  if (uncommitted.length) {
    header.push(`Status: NOT COMMITTED: ${uncommitted.length} finding(s)`);
    stdout.write(`${header.join('\n')}\n`);
    stderr.write(`FAIL: a selected hub document is not the bytes at HEAD, so no ${HUB_COMMIT_LABEL}: line can pin it:\n  - ${uncommitted.join('\n  - ')}\n`);
    process.exit(EXIT.FAIL);
  }
  header.push(`Paths: ${list(paths)}`);
  header.push(`Names: ${list(names)}`);
  header.push(`Selected: ${selected.length} of ${rows.length}${selected.length ? `: ${selected.map((r) => r.id).join(', ')}` : ''}`);
  if (!args.hub) {
    header.push(overridesLine(overrides));
    for (const n of overrides.notes) header.push(`Note: ${n}`);
  }
  header.push(contextLine(selected));
  stdout.write(`${header.join('\n')}\n`);

  // Keyed by layer and path: the global repository uses the hub's folder names,
  // so one path can name a document in each.
  const at = (repository, path) => `${repository}\n${path}`;
  const bodies = new Map([
    ...global.documents.map((d) => [at(GLOBAL, d.path), d.body]),
    ...hub.documents.map((d) => [at(HUB, d.path), d.body]),
    ...spoke.documents.map((d) => [at(id, d.path), d.body]),
  ]);
  for (const r of selected) {
    const cite = r.repository === HUB ? r.path : `${r.repository}@${short(r.commit)}:${r.path}`;
    const rank = r.rank === null ? 'unranked' : String(r.rank);
    const meta = [`Kind: ${r.kind}`, `Rank: ${rank}`, `Owner: ${r.owner === null ? 'none recorded' : r.owner}`, `Revision: ${r.revision === null ? 'none recorded' : r.revision}`];
    if ('status' in r) meta.push(`Status: ${r.status}`);
    const body = printedBody(bodies.get(at(r.repository, r.path)));
    const exception = r.repository === GLOBAL ? exceptionLine(r) : null;
    const overridden = overriddenLine(overrides.byStandard, r.id);
    stdout.write(`---\nDocument: ${r.id}\n${meta.join(' · ')}\n${exception ? `${exception}\n` : ''}${overridden ? `${overridden}\n` : ''}Cite: ${cite}\n${body}`);
  }
  if (!selected.length) stdout.write('---\n');
}

// The last line of an exit 2, 3 or 4 names this script and its code, so a shell line that hides
// the code, with a pipe or `; echo`, still tells the harness's failure record. Written at once,
// so a process.exit() never loses it.
process.on('exit', (code) => { if (code >= 2 && code <= 4) { try { writeSync(2, `HARNESS EXIT: read-context ${code}\n`); } catch { /* stderr is closed */ } } });

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

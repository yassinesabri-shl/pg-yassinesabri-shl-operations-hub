#!/usr/bin/env node
// Part of the harness asset library c6f3b4427d58f7c3 (see VERSION.json) · 2026-09-18
/**
 * check-context.mjs — does every context document in the estate parse?
 *
 *   usage:  node scripts/check-context.mjs [--offline] [--registry <file>]
 *           node scripts/check-context.mjs --local <dir> [--index <path> | --decisions <path>]
 *           node scripts/check-context.mjs --global
 *
 * The folders are the fact. Nothing is written and nothing is compared with a
 * saved list: the documents are read where they live, each must parse, and the
 * index a design reads is printed on demand by read-context.mjs from the same
 * folders. Three parts, and the first two read no remote.
 *
 *   1. The hub's documents, on disk from the working directory: every decision
 *      record under docs/architecture/, every standard under docs/standards/,
 *      the one estate overview at docs/estate/overview.md, every merged
 *      requirements document at docs/requirements/<slug>/requirements.md -- id
 *      the slug, read from its title and its control table, the
 *      review beside it peeked at for the status (`accepted` when it approves
 *      the document's bytes and the local trunk ref carries them, never
 *      fetched; `proposed` otherwise) and otherwise the
 *      requirements gate's alone -- and every copied requirements source under
 *      docs/requirements/, filed <slug>/runs/<yyyymmdd_hhmm>/<file>.md -- one
 *      folder per document, one per /feature run -- with the id
 *      <slug>-<yyyymmdd>-<hhmm>-<stem>. Each must parse -- the header the
 *      library fixes, or the requirements document's own
 *      structure -- with no placeholder in any field, a record's status one
 *      of Accepted, Superseded by ADR-<NNN>, Superseded by global.ADR-<NNN>
 *      (a global record states it now), Deprecated, and a standard in the
 *      template's shape: std-<topic> in its name, file and title, the nine
 *      sections in order, every rule under an id <name>.<NN>. Only a standard's
 *      id starts with std-. Ids are unique across the estate. The hub line
 *      counts each folder, saying how many under docs/requirements/ are
 *      documents and how many are sources, and notes each requirements
 *      document's status and why: a note, never a finding.
 *   2. The hub's always-on rules: every `.claude/rules/*.md` with alwaysApply
 *      true is imported by CLAUDE.md with an `@.claude/rules/<file>` line.
 *      A runtime that reads neither globs nor the rules folder loads only the
 *      imports, so one that is not imported binds nobody there. Then every
 *      file in that folder says when Claude Code loads it: Claude Code loads
 *      the whole folder unless a file's `paths:` scopes it, so a path-scoped
 *      rule carries `paths:` equal to its `globs:` (checkRulesScoped).
 *   3. Each spoke on the list, unless --offline: its commands file at the commit
 *      the list records (`readAt`), the folder its CONTRACTS_INDEX names
 *      (`contracts/` by convention) at the same commit, every `.md` in it parsed
 *      as a contract or vendor document, and the folder its DECISIONS_INDEX names
 *      (`decisions/` by convention), every `.md` in it a decision record of the
 *      spoke's own, `ADR-<NNN>-<slug>.md`, its id `<repository-id>.ADR-<NNN>`
 *      everywhere else. A missing key is NOT CONFIGURED: reported
 *      in every run, never a stop, exactly as RULES_INDEX is. So is a commands file
 *      that is not at `readAt` at all -- a spoke /add-repo listed before its install
 *      landed the file: nothing to read, never a stop, and /add-repo refreshes
 *      it afterwards. The trunk head is asked for as well: a `readAt` behind
 *      it is reported, never failed -- /add-repo is the refresh.
 *      Then, report only, which repositories each path-scoped hub standard
 *      reaches: the listed repositories holding a path at `readAt` its globs
 *      match. A standard that reaches none is noted, never failed -- a standard
 *      for a stack nobody uses yet waits for the first design that touches one.
 *      A Reserved standard is noted in the hub line: it binds only when named.
 *
 * Offline, the list is still read for shape and the spokes are counted, not
 * asked: one line says how many are listed and that no remote was reached.
 *
 * Exit codes -- the gate's, and the highest across parts:
 *   0  every document parses, every always-on rule is imported and every
 *      path-scoped rule carries paths:
 *   1  a malformed document, an unimported always-on rule, a rule that Claude
 *      Code loads in every session against its frontmatter, a duplicate id
 *   2  cannot verify: no registry, or a remote that could not be reached
 *   3  usage
 *   4  internal
 *
 * Two jobs. Part 1 and 2 read no remote and may be a required check in the hub
 * (`--offline`). Part 3 reads every spoke and is report-only, as
 * check-registry.mjs is, because a check that stalls on another repository's
 * outage is not enforcement.
 *
 * A third way in, --local <dir>: one spoke checkout on disk, its commands file at
 * the root saying where the contracts folder and the decision-record folder are
 * (or --index, or --decisions, naming one of them directly), every document in
 * them parsed, and nothing else -- no registry. This is what
 * /add-context runs on the spoke clone before it opens the spoke's pull
 * request, and what a spoke's own CI may run from the hub checkout it holds.
 *
 * A fourth way in, --global: the global context repository's own check, what
 * its required check `global-gate` runs on every pull request there
 * (docs/proposals/global-context.md §10.1). It reads the commit HEAD names in
 * the repository it runs in, never the working tree, so a change under the
 * three document folders that is not committed is exit 2: commit it first. It
 * proves six things, and runs every one before it exits:
 *
 *   1. every document in docs/architecture/, docs/standards/ and
 *      docs/exceptions/ parses, with the header and shape its kind fixes, and
 *      no id names two documents
 *   2. a superseded record names a record that is at the same commit
 *   3. an exception carries a Reason, a Scope and Alternatives considered that
 *      are not empty, a review-by date, and one hub and one repository or more
 *      (the parse in context-docs.mjs, part 1)
 *   4. every id in an exception's `departs` is at the same commit: a record by
 *      its number, a standard's rule by a rule the standard defines
 *   5. every hub in `hubs` is a key prefix (the parse, part 1)
 *   6. the always-on bodies of the binding global documents, as read-context.mjs
 *      prints them, stay within GLOBAL_ALWAYS_ON_CAP bytes, and the global
 *      index lines, as read-context.mjs prints them, within GLOBAL_INDEX_CAP
 *      bytes (`rules/context-budget.md` § The global layer)
 *
 * and, for rule 1, that no id the history removed is used again for other
 * bytes. It walks the first-parent history of HEAD, so a shallow clone is
 * exit 2: the workflow checks out with fetch-depth: 0. Restoring the exact
 * bytes of a removed document is not a reuse. It reads no remote and no
 * registry. Hubs, spokes and the hub's always-on rules are not its business.
 *
 * What this script cannot see
 *   - Whether a document is right, current with its vendor, or obeyed. It checks
 *     that one is there, headed and owned. The critic and the human merge do the rest.
 *   - A document copied somewhere other than the folders above. Convention is the
 *     mechanism; a file outside it is context nothing hands in.
 */

import { existsSync, writeSync } from 'node:fs';
import { stdout, stderr } from 'node:process';
import {
  EXIT, SpokeError, reasonLine,
  registryPath, readRegistry, validateRegistry,
  resolveSpokeTrunk, cacheDir, ensureCommit, short, git, quietGitEnv,
} from './spoke-remote.mjs';
import {
  HUB, GLOBAL, GLOBAL_PREFIX, KINDS, GLOBAL_KINDS, CONTRACTS_INDEX_KEY, DECISIONS_INDEX_KEY, ADR_FILE, STD_FILE, EXC_FILE, GLOBAL_ALWAYS_ON_CAP, GLOBAL_INDEX_CAP,
  binds, checkAlwaysOnImported, checkRulesScoped, indexLine, indexRows, printedBody, readDocumentsLocal, readGlobalDocumentsAt, readSpokeDocumentsAt, scanHub, sortRows,
  standardsReach, toRow,
} from './context-docs.mjs';

function usage(message) {
  const invoked = process.argv[1] || 'scripts/check-context.mjs';
  stderr.write(`${message}\nusage: node ${invoked} [--offline] [--registry <file>]\n       node ${invoked} --local <dir> [--index <path> | --decisions <path>]\n       node ${invoked} --global\n`);
  process.exit(EXIT.USAGE);
}

function parseArgs(argv) {
  const out = { offline: false, registry: null, local: null, index: null, decisions: null, global: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--offline') out.offline = true;
    else if (a === '--global') out.global = true;
    else if (a === '--registry' || a === '--local' || a === '--index' || a === '--decisions') {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) usage(`${a} needs a value`);
      out[a.slice(2)] = v;
      i += 1;
    } else usage(`unknown argument ${a}`);
  }
  if (out.index !== null && out.local === null) usage('--index belongs to --local');
  if (out.decisions !== null && out.local === null) usage('--decisions belongs to --local');
  if (out.decisions !== null && out.index !== null) usage('--index names the contracts folder and --decisions the records folder; check one at a time');
  if (out.local !== null && (out.offline || out.registry !== null)) usage('--local checks one checkout and takes no other option');
  if (out.global && argv.length > 1) usage('--global checks the global context repository it runs in and takes no other option');
  return out;
}

// One spoke checkout: its contracts folder and its decision-record folder, or the
// one folder --index (contracts) or --decisions (records) names.
function checkLocal(dir, indexPath, decisionsPath) {
  if (!existsSync(dir)) {
    stderr.write(`CANNOT VERIFY: --local ${dir} is not a directory\n${reasonLine('not-a-checkout')}`);
    process.exit(EXIT.CANNOT_VERIFY);
  }
  let reads;
  if (decisionsPath !== null) reads = [readDocumentsLocal(dir, { indexPath: decisionsPath, key: DECISIONS_INDEX_KEY })];
  else if (indexPath !== null) reads = [readDocumentsLocal(dir, { indexPath })];
  else {
    reads = [readDocumentsLocal(dir)];
    if (reads[0].state !== 'no-commands-file') reads.push(readDocumentsLocal(dir, { key: DECISIONS_INDEX_KEY }));
  }
  stdout.write(`\ncontext documents  (--local ${dir})\n\n`);
  let worst = EXIT.PASS;
  const verdicts = [];
  for (const read of reads) {
    const { exit, verdict } = reportLocal(read);
    worst = Math.max(worst, exit);
    verdicts.push(verdict);
  }
  stdout.write(`\n${verdicts.join('\n')}\n`);
  process.exit(worst);
}

// One folder's lines, and its verdict. The two folders hold different things, and say so.
function reportLocal(read) {
  const what = read.key === DECISIONS_INDEX_KEY ? 'its own decision records' : 'contracts';
  if (read.state === 'not-configured') {
    stdout.write(`  [NOT CONFIGURED] ${read.key} is missing, empty or UNRESOLVED\n`);
    return { exit: EXIT.PASS, verdict: `NOT CONFIGURED: this repository has not said whether it keeps ${what}. Reported in every pull-request body; never a pass.` };
  }
  if (read.state === 'none') {
    stdout.write(`  [PASS] ${read.key}=none\n`);
    return { exit: EXIT.PASS, verdict: read.key === DECISIONS_INDEX_KEY ? 'NO DECISION RECORDS DECLARED: this repository says on purpose that it keeps no decision records of its own.' : 'NO CONTRACTS DECLARED: this repository says on purpose that it has no contracts.' };
  }
  if (read.state !== 'path') {
    stdout.write(`  [FAIL] ${read.state.replace(/-/g, ' ')}\n`);
    for (const f of read.findings) stdout.write(`         - ${f}\n`);
    return { exit: EXIT.FAIL, verdict: `NOT WELL FORMED: ${read.findings.length} finding(s).` };
  }
  for (const d of read.documents) stdout.write(`  [PASS] ${d.path}  (${d.name}, ${d.kind}${d.alwaysApply ? ', always on' : ''})\n`);
  if (read.findings.length) {
    stdout.write(`  [FAIL] ${read.path}\n`);
    for (const f of read.findings) stdout.write(`         - ${f}\n`);
    return { exit: EXIT.FAIL, verdict: `NOT WELL FORMED: ${read.findings.length} finding(s) in ${read.path}. A malformed set binds nobody until it is fixed.` };
  }
  return { exit: EXIT.PASS, verdict: `WELL FORMED: ${read.documents.length} document(s) in ${read.path}${read.documents.length ? `: ${read.documents.map((d) => d.name).join(', ')}` : ''}.` };
}

const label = (exit) => (exit === EXIT.PASS ? 'PASS' : exit === EXIT.FAIL ? 'FAIL' : 'CANNOT VERIFY');

function section(name, exit, summary, findings) {
  stdout.write(`  [${label(exit)}] ${name.padEnd(18)} ${summary}\n`);
  for (const f of findings) stdout.write(`         - ${f}\n`);
}

// One repository, its rows and its findings. Never throws for a per-repository
// problem: an unreachable remote is that repository's exit 2 and the next one is
// still asked. The rows exist only for the duplicate-id pass; nothing keeps them.
// The token of the run's first cannot-verify finding, which the summary prints last.
let firstReason = null;

function readSpoke(id, entry) {
  const findings = [];
  let exit = EXIT.PASS;
  const fail = (m) => { findings.push(m); exit = Math.max(exit, EXIT.FAIL); };
  const cannot = (m, reason = null) => { findings.push(m); exit = Math.max(exit, EXIT.CANNOT_VERIFY); firstReason = firstReason || reason; };
  const note = (m) => { findings.push(m); };

  const dir = cacheDir(id);
  let trunk;
  let head;
  try {
    ({ trunk, head } = resolveSpokeTrunk(entry, dir));
  } catch (err) {
    if (!(err instanceof SpokeError)) throw err;
    cannot(err.message, err.reason);
    return { exit, findings, rows: [], summary: 'not reached' };
  }
  if (!ensureCommit(dir, entry.url, trunk, entry.readAt)) {
    fail(`readAt ${short(entry.readAt)} is not a commit ${entry.url} knows; run check-registry and /add-repo`);
    return { exit, findings, rows: [], summary: 'readAt unknown' };
  }
  const read = readSpokeDocumentsAt(dir, entry.readAt, entry.checks);
  let summary;
  if (read.contracts.state === 'no-commands-file') {
    // A spoke listed before its install. /add-repo records the path the commands
    // file will have, and the spoke install lands the file on the spoke's own
    // pull request. Nothing can be read, so nothing is a document: the same NOT
    // CONFIGURED as a missing CONTRACTS_INDEX key, reported in every run and
    // never a stop. A folder on disk is not read until the key says so, and
    // there is no key yet.
    summary = `commands file ${entry.checks} is not at ${short(entry.readAt)}, NOT CONFIGURED: reported, never a stop`;
    note(`the spoke install adds ${entry.checks}; run /add-repo ${entry.url} --trunk ${entry.trunk} afterwards to refresh`);
  } else {
    const says = (part, nothing) => {
      if (part.state === 'path') return `${part.documents.length} document(s) in ${part.path} at ${short(entry.readAt)}`;
      if (part.state === 'none') return `${part.key}=none: ${nothing}, on purpose`;
      if (part.state === 'not-configured') return `${part.key} NOT CONFIGURED: reported, never a stop`;
      return part.state.replace(/-/g, ' ');
    };
    summary = `${says(read.contracts, 'no contracts')}; ${says(read.decisions, 'no decision records')}`;
    for (const f of read.findings) fail(f);
  }
  if (entry.readAt !== head) note(`readAt ${short(entry.readAt)} is behind the trunk head ${short(head)}: documents were read at readAt. Run /add-repo ${entry.url} --trunk ${entry.trunk} to refresh`);
  const rows = read.findings.length ? [] : read.documents.map((d) => toRow(d, { repository: id, commit: entry.readAt }));
  // Every path at readAt, for which hub standards reach this repository.
  const paths = git(['--git-dir', dir, 'ls-tree', '-r', '--name-only', entry.readAt], { env: quietGitEnv() }).split('\n').filter(Boolean);
  return { exit, findings, rows, summary, paths };
}

/* ------------------------------------------------- the global repository */

// The id a document file carries in the global repository, from its folder and
// its file name, or null for a file that is not a document there.
function globalIdOf(path) {
  const slash = path.lastIndexOf('/');
  const folder = path.slice(0, slash);
  const file = path.slice(slash + 1);
  const pattern = { [KINDS.adr.folder]: ADR_FILE, [KINDS.standard.folder]: STD_FILE, [KINDS.exception.folder]: EXC_FILE }[folder];
  if (!pattern) return null;
  const m = file.match(pattern);
  return m ? m[1] : null;
}

/**
 * Every id the first-parent history of `head` removed and that names other
 * bytes at `head`. The walk keeps each document path's blob, commit by commit,
 * oldest first. An id is removed by the commit after which no path carries it.
 * At `head`, an id that a commit removed is reused when its blob is none of the
 * blobs the id held before that removal.
 */
function reusedIds(gitDir, head, folders) {
  const log = git(['--git-dir', gitDir, '-c', 'core.quotePath=false', 'log', '--first-parent', '--reverse', '--diff-merges=first-parent', '--raw', '--no-renames', '--no-abbrev', '--format=commit %H', head, '--', ...folders], { env: quietGitEnv(), maxBuffer: 256 * 1024 * 1024 });
  const present = new Map();
  const held = new Map();
  const removed = new Map();
  const idsNow = () => new Set([...present.keys()].map(globalIdOf).filter(Boolean));
  let before = new Set();
  let commit = null;
  const settle = () => {
    if (commit === null) return;
    const after = idsNow();
    for (const id of before) {
      if (after.has(id) || removed.has(id)) continue;
      removed.set(id, { commit, blobs: new Set(held.get(id)) });
    }
    before = after;
  };
  for (const line of log.split('\n')) {
    if (line.startsWith('commit ')) {
      settle();
      commit = line.slice(7).trim();
      continue;
    }
    const m = line.match(/^:\d+ \d+ ([0-9a-f]+) ([0-9a-f]+) ([A-Z])\d*\t(.+)$/);
    if (!m) continue;
    const [, , blob, status, path] = m;
    if (status === 'D') present.delete(path);
    else present.set(path, blob);
    const id = globalIdOf(path);
    if (id !== null && status !== 'D') {
      if (!held.has(id)) held.set(id, new Set());
      held.get(id).add(blob);
    }
  }
  settle();
  const findings = [];
  for (const [path, blob] of present) {
    const id = globalIdOf(path);
    const gone = id === null ? null : removed.get(id);
    if (gone && !gone.blobs.has(blob)) findings.push(`${path}: id ${id} was removed at ${short(gone.commit)} and names other bytes again. An id names one document for ever: give this document a number, or a name, that no document ever had`);
  }
  return findings;
}

function checkGlobal() {
  const quiet = { env: quietGitEnv() };
  const cannot = (message, reason) => {
    stdout.write(`\ncontext documents  (--global)\n\nCANNOT VERIFY: ${message}\n${reasonLine(reason)}`);
    process.exit(EXIT.CANNOT_VERIFY);
  };
  let gitDir;
  let head;
  try {
    gitDir = git(['rev-parse', '--absolute-git-dir'], quiet).trim();
    head = git(['rev-parse', '--verify', 'HEAD^{commit}'], quiet).trim();
  } catch {
    cannot('--global reads the commit HEAD names, and this directory is not a git repository with a commit. Run it at the root of the global context repository', 'not-a-checkout');
  }
  if (git(['rev-parse', '--is-shallow-repository'], quiet).trim() === 'true') {
    cannot('the history is shallow, and an id the history removed cannot be told from a new one. Fetch the full history (fetch-depth: 0 in the workflow)', 'shallow-clone');
  }
  const folders = GLOBAL_KINDS.map((k) => KINDS[k].folder);
  const dirty = git(['status', '--porcelain', '--untracked-files=all', '--', ...folders], quiet).split('\n').filter(Boolean);
  if (dirty.length) {
    cannot(`--global reads the commit HEAD names, and ${dirty.length} change(s) under ${folders.join(', ')} are not committed: ${dirty.map((l) => l.slice(3)).join(', ')}. Commit them, or remove them, and run it again`, 'uncommitted-changes');
  }

  stdout.write(`\ncontext documents  (--global: the global repository at ${short(head)})\n\n`);
  let worst = EXIT.PASS;
  const part = (name, findings, summary) => {
    const exit = findings.length ? EXIT.FAIL : EXIT.PASS;
    worst = Math.max(worst, exit);
    section(name, exit, summary, findings);
  };

  // 1, 3 and 5: every document parses; its kind's header and shape hold.
  const read = readGlobalDocumentsAt(gitDir, head);
  const counts = Object.entries(read.folders).map(([folder, n]) => `${n} in ${folder}`).join(', ');
  part(GLOBAL, read.findings, `${read.documents.length} document(s): ${counts}`);

  const byName = new Map(read.documents.map((d) => [d.name, d]));
  const at = short(head);

  // 2: a superseded record names a record at the same commit.
  const successors = [];
  const superseded = read.documents.filter((d) => d.kind === 'adr' && d.supersedes);
  for (const d of superseded) {
    const next = byName.get(d.supersedes);
    if (d.supersedes.startsWith(GLOBAL_PREFIX)) successors.push(`${d.path}: is superseded by ${d.supersedes}, and a file in the global repository names a global record without "${GLOBAL_PREFIX}": "Superseded by ${d.supersedes.slice(GLOBAL_PREFIX.length)}"`);
    else if (!next || next.kind !== 'adr') successors.push(`${d.path}: is superseded by ${d.supersedes}, and no well-formed record ${d.supersedes} is at ${at}. A superseded record names the record that replaced it`);
  }
  part('successors', successors, `${superseded.length} superseded record(s), each replaced by a record at ${at}`);

  // 4: every id an exception departs from is at the same commit.
  const departs = [];
  const exceptions = read.documents.filter((d) => d.kind === 'exception');
  for (const d of exceptions) {
    for (const id of d.departs) {
      const rule = id.match(/^(std-[a-z0-9]+(?:-[a-z0-9]+)*)\.\d{2,}$/);
      if (rule) {
        const standard = byName.get(rule[1]);
        if (!standard || standard.kind !== 'standard') departs.push(`${d.path}: departs from ${id}, and no well-formed standard ${rule[1]} is at ${at}`);
        else if (!(standard.rules || []).includes(id)) departs.push(`${d.path}: departs from ${id}, and ${rule[1]} defines no rule ${id} at ${at}. Its rules are ${(standard.rules || []).join(', ') || 'none'}`);
      } else {
        const record = byName.get(id);
        if (!record || record.kind !== 'adr') departs.push(`${d.path}: departs from ${id}, and no well-formed record ${id} is at ${at}`);
      }
    }
  }
  part('departs', departs, `${exceptions.length} exception(s), every id they depart from at ${at}`);

  // 1: no id the history removed names other bytes now.
  part('ids', reusedIds(gitDir, head, folders), 'no id the history removed names other bytes');

  // 6: the two caps, measured on what read-context.mjs prints.
  const rows = read.documents.map((d) => toRow(d, { repository: GLOBAL, commit: head }));
  const bodyOf = new Map(read.documents.map((d) => [d.path, d.body]));
  const always = rows.filter((r) => r.alwaysApply === true && binds(r)).map((r) => ({ id: r.id, bytes: Buffer.byteLength(printedBody(bodyOf.get(r.path))) }));
  const lines = indexRows(rows).map((r) => ({ id: r.id, bytes: Buffer.byteLength(`${indexLine(r)}\n`) }));
  const total = (list) => list.reduce((n, x) => n + x.bytes, 0);
  const largest = (list) => [...list].sort((a, b) => b.bytes - a.bytes).slice(0, 5).map((x) => `${x.id} (${x.bytes})`).join(', ');
  const budget = [];
  if (total(always) > GLOBAL_ALWAYS_ON_CAP) budget.push(`the always-on bodies are ${total(always)} bytes, and the cap is ${GLOBAL_ALWAYS_ON_CAP} (rules/context-budget.md). Every product reads them in every run. Give a document globs in place of alwaysApply: true, or shorten it. Largest: ${largest(always)}`);
  if (total(lines) > GLOBAL_INDEX_CAP) budget.push(`the index lines are ${total(lines)} bytes, and the cap is ${GLOBAL_INDEX_CAP} (rules/context-budget.md). Every product reads the index in every run. Supersede the records that no longer bind, or shorten the descriptions. Largest: ${largest(lines)}`);
  part('budget', budget, `always-on bodies ${total(always)} of ${GLOBAL_ALWAYS_ON_CAP} bytes (${always.length} document(s)); index lines ${total(lines)} of ${GLOBAL_INDEX_CAP} bytes (${lines.length} line(s))`);

  stdout.write('\n');
  if (worst === EXIT.PASS) stdout.write(`WELL FORMED: ${read.documents.length} global document(s) at ${at}; every superseded record and every departed id is at this commit, no id is used again, and both caps hold.\n`);
  else stdout.write('NOT WELL FORMED: fix every finding above before the Board merges. A malformed set binds no product.\n');
  process.exit(worst);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.global) checkGlobal();
  if (args.local !== null) checkLocal(args.local, args.index, args.decisions);
  let worst = EXIT.PASS;
  const rows = [];

  stdout.write(`\ncontext documents${args.offline ? '  (offline: remotes not asked)' : ''}\n\n`);

  // 1. The hub's documents.
  const hub = scanHub('.');
  // One count per folder; where two kinds share a folder, which is which.
  const sharing = (folder) => Object.entries(KINDS).filter(([, k]) => k.scope === HUB && k.folder === folder).map(([kind]) => kind);
  const counts = Object.entries(hub.folders).map(([folder, n]) => {
    const kinds = sharing(folder);
    if (kinds.length < 2) return `${n} in ${folder}`;
    return `${n} in ${folder} (${kinds.map((kind) => `${hub.kinds[kind]} ${kind.replace(/-/g, ' ')}(s)`).join(', ')})`;
  }).join(', ');
  const hubExit = hub.findings.length ? EXIT.FAIL : EXIT.PASS;
  worst = Math.max(worst, hubExit);
  // A requirements document's status is a fact about the review beside it, told
  // once here so a reader knows why it ranks where it does; never a finding.
  const notes = [
    ...hub.documents.filter((d) => d.kind === 'requirements-document').map((d) => `${d.path}: ${d.status} -- ${d.statusReason}`),
    ...hub.documents.filter((d) => d.kind === 'standard' && d.status === 'Reserved').map((d) => `${d.path}: Reserved -- binds only a design that names ${d.name}; /add-context makes it Active`),
  ];
  section(HUB, hubExit, `${hub.documents.length} document(s): ${counts}`, [...hub.findings, ...notes]);
  // Every well-formed hub document is a row for reach; the id check takes them only from a clean hub.
  const hubRows = hub.documents.map((d) => toRow(d, { repository: HUB, commit: null }));
  if (!hub.findings.length) rows.push(...hubRows);

  // 2. Always-on rules imported.
  const rules = checkAlwaysOnImported('.');
  const rulesExit = rules.findings.length ? EXIT.FAIL : EXIT.PASS;
  worst = Math.max(worst, rulesExit);
  section('always-on rules', rulesExit, `${rules.imported.length} imported by CLAUDE.md`, rules.findings);
  const scopedRules = checkRulesScoped('.');
  const scopedExit = scopedRules.findings.length ? EXIT.FAIL : EXIT.PASS;
  worst = Math.max(worst, scopedExit);
  section('path-scoped rules', scopedExit, `${scopedRules.scoped.length} scoped by paths:`, scopedRules.findings);

  // 3. The spokes.
  const regPath = registryPath(args.registry);
  const registry = readRegistry(regPath);
  const problems = validateRegistry(registry, regPath);
  if (problems.length) {
    section('registry', EXIT.FAIL, 'not well formed; run check-registry first', problems);
    stdout.write(`\nNOT WELL FORMED: the list is not readable, so no spoke was asked.\n`);
    process.exit(EXIT.FAIL);
  }
  const ids = Object.keys(registry.repositories);

  if (args.offline) {
    section('spokes', EXIT.PASS, `${ids.length} listed, remotes not asked`, []);
  } else {
    const trees = new Map();
    for (const id of ids) {
      const { exit, findings, rows: spokeRows, summary, paths } = readSpoke(id, registry.repositories[id]);
      worst = Math.max(worst, exit);
      section(id, exit, summary, findings);
      rows.push(...spokeRows);
      if (paths) trees.set(id, paths);
    }
    // Report only: which repositories each path-scoped hub standard reaches.
    const reach = standardsReach(hubRows, trees);
    if (reach.length) section('standards reach', EXIT.PASS, `${trees.size} of ${ids.length} repositories read`, reach);
  }

  // Ids are unique across the estate: a design names an id, and two documents
  // answering to one name is a design that cannot say which it read. Offline
  // only the hub's are in hand; the full run and read-context.mjs see the rest.
  const seen = new Map();
  const duplicates = [];
  for (const r of sortRows(rows)) {
    if (seen.has(r.id)) duplicates.push(`id "${r.id}" is both ${seen.get(r.id)} and ${r.repository}:${r.path}`);
    else seen.set(r.id, `${r.repository}:${r.path}`);
  }
  if (duplicates.length) {
    worst = Math.max(worst, EXIT.FAIL);
    section('ids', EXIT.FAIL, `${duplicates.length} duplicate(s)`, duplicates);
  }

  stdout.write('\n');
  if (worst === EXIT.PASS) stdout.write(`WELL FORMED: ${rows.length} context document(s); every always-on rule is imported.\n`);
  else if (worst === EXIT.FAIL) stdout.write('NOT WELL FORMED: a document is malformed, a rule binds nobody, or an id is doubled. Fix it where it lives.\n');
  else stdout.write(`CANNOT VERIFY: at least one repository could not be reached. Nothing about its documents is known.\n${reasonLine(firstReason)}`);
  process.exit(worst);
}

// The last line of an exit 2, 3 or 4 names this script and its code, so a shell line that hides
// the code, with a pipe or `; echo`, still tells the harness's failure record. Written at once,
// so a process.exit() never loses it.
process.on('exit', (code) => { if (code >= 2 && code <= 4) { try { writeSync(2, `HARNESS EXIT: check-context ${code}\n`); } catch { /* stderr is closed */ } } });

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

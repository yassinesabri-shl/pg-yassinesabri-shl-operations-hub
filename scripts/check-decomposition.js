#!/usr/bin/env node
/**
 * check-decomposition.js — the decomposition check.
 *
 * `/decompose` writes one record per source revision, docs/backlog/<SLUG>.decomposition.md,
 * one file per work item under docs/backlog/<SLUG>/, the critic's final review
 * beside the record as <SLUG>.decomposition-review.md, and advances the key
 * ledger docs/backlog/keys.json -- all in one pull request in the hub. This
 * file is what runs on that pull request, and again on the trunk before the
 * command's second invocation creates anything in a tracker. It reads all of
 * that on the trunk, plus the source document the record names and the list
 * of repositories, and says whether the decomposition is complete: every
 * requirement in the source is claimed by a story or marked out of scope with
 * a reason; every story names exactly one repository that is in the list;
 * every story criterion carries one requirement criterion the source defines;
 * every key is from the block the ledger records for this slug, and the
 * counter has moved past it; the dependency map is acyclic; no placeholder
 * cell anywhere; every story carries one `Hub commit:` line naming a trunk
 * commit and one `Context:` line whose hub documents that commit holds at the
 * bytes they pin and which are used on the page, and every document the source's
 * `Context:` line names reaches at least one story; and exactly one review
 * approves the record's bytes as they are on the trunk now.
 *
 *   usage:  node scripts/check-decomposition.js payments-onboarding
 *
 * Exit codes
 *   0  the decomposition is complete  -> the second invocation may create the items
 *   1  at least one check failed      -> not complete; all findings printed
 *   2  cannot verify                  -> refused to judge (stale or unreachable remote)
 *   3  usage error                    -> bad or missing slug
 *   4  internal error                 -> unexpected; treat as not complete
 *
 * Design notes
 *   - Same trunk discipline as check-dev-ready.js. Reads the DEFAULT BRANCH,
 *     never the working tree, confirms the branch name against the remote's own
 *     default branch, and force-fetches first. Run on a pull request through
 *     the candidate-trunk construction the CI workflows use.
 *   - The record's shape is the library's, not the organisation's: the four
 *     sections read here -- Coverage map, Repository map, Items, Dependency map
 *     -- are the schema decompose-requirements/SKILL.md fixes, and the item
 *     file's Key:, Repository: and Acceptance criteria are the fields the same
 *     skill lists. The source document's format IS the organisation's, and it
 *     is read as check-requirements.js reads it: REQ-<n> headings and the
 *     `| ID | Criterion |` table beneath each, with the same functions.
 *   - A story's `Context:` line names the documents /decompose selected for
 *     it with scripts/read-context.mjs <repository> --at <commit> --names: the
 *     hub's decision records, standards and requirements documents, and its
 *     own repository's contracts. It is read as check-requirements.js reads a
 *     requirements document's line: each hub entry proved at the commit the
 *     story's `Hub commit:` line names, which is on the trunk, each
 *     entry used on the page, a standard by a rule id it defines, and each
 *     decision record and rule the page cites on the line. An entry kept in a
 *     repository is checked for its shape and for the story's own repository.
 *     The source's line is a floor, compared by id: every document on it is on
 *     at least one story's line, because a document that shaped a requirement
 *     binds the work that builds it.
 *   - A story may also cite a document of the global context repository,
 *     `<id>@<12-hex>:global:<path>` (docs/proposals/global-context.md §8),
 *     proved as check-dev-ready.js proves a design's: its pin is the commit
 *     on the `Global:` line of this slug's requirements document, the path is
 *     at that commit with a header that names the id, and an exception is
 *     Active, names this hub and sits beside every record it departs from. A
 *     hub without docs/estate/global.json refuses every global entry.
 *   - The review binds to the record by the hash of its bytes: `Record
 *     revision: <git hash-object>`, the gate's pattern with this artefact
 *     type's label. It binds the record and nothing else; an item file is not
 *     covered by it, and generation.md §8 says so.
 *   - One record per slug, revised in place, and one ledger block per run that
 *     minted keys under it: a re-cut adds a block. The blocks for the slug are,
 *     together, exactly the item files.
 *   - The list of repositories is read for its ids only, from the trunk blob.
 *     No spoke is reached: a check that reads several remotes cannot be a
 *     required check, and this one is meant to be required. The one other
 *     remote it reads is the global context repository, and only when a story
 *     carries a global entry. It reads that repository through a bare cache
 *     outside the hub (HARNESS_SPOKE_CACHE, or the system temporary
 *     directory), with the credential the hub's CI gives git for its spokes,
 *     and exits 2 when it does not answer.
 *   - Runs EVERY check before exiting. No short-circuit.
 *   - Node standard library only, plus git via child_process.
 *   - ES module. Save as check-decomposition.mjs where package.json is not
 *     { "type": "module" }.
 *   - Non-`main` trunk: set HARNESS_TRUNK=<branch>, as for the gate.
 *   - A source ahead of its record: `/decompose` reads a source on the trunk,
 *     so a requirements pull request cannot carry the next revision of the
 *     record. The decomposition-gate workflow sets HARNESS_SOURCE_AHEAD=1 for a
 *     slug when the pull request changes none of its record, review and item
 *     files. Three findings are then notes, and the check exits 0 when nothing
 *     else fails: a story carries a criterion the source marks DEPRECATED, the
 *     source defines a requirement the record does not map, and a document on
 *     the source's `Context:` line reaches no story. Every other rule fails as
 *     before. Without the variable the three fail, so the trunk is not
 *     complete until `/decompose` writes the next revision of the record.
 *   - A story retires a criterion as the source does: DEPRECATED as the first
 *     word of its Criterion cell, the number kept. A retired row may carry a
 *     criterion the source retired or a requirement the record excludes, and
 *     it does not make a requirement Covered.
 *
 * What this check cannot see
 *   - Whether the cut is good. Every story could be the wrong size, in the
 *     wrong place, and pass. The critic's reading and the human merge are the
 *     controls on that.
 *   - Whether a citation into a repository is true. It carries a commit, and
 *     the critic opens it; this file reads one remote.
 *   - Whether an item file changed after the review. The review binds the
 *     record's bytes.
 *   - Whether a story's `Context:` line lists every document that bears on
 *     it, or whether a document kept in a repository exists. The critic reads
 *     the first; the second needs a remote this file does not read.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const EXIT = { PASS: 0, CHECK_FAIL: 1, CANNOT_VERIFY: 2, USAGE: 3, INTERNAL: 4 };

const CONFIG = {
  remote: 'origin',
  branch: process.env.HARNESS_TRUNK || 'main',
  // The workflow sets HARNESS_SOURCE_AHEAD=1 when the pull request changes none
  // of the slug's record, review and item files. Any other value is ignored.
  sourceAhead: process.env.HARNESS_SOURCE_AHEAD === '1',
  backlogDir: 'docs/backlog',
  recordSuffix: '.decomposition.md',
  reviewSuffix: '.decomposition-review.md',
  itemSuffix: '.item.md',
  keysPath: 'docs/backlog/keys.json',
  registryPath: 'docs/estate/repositories.json',
  slugPattern: /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
  // Reserved for the stories /from-ticket takes from Jira. check-dev-ready.js and
  // check-intake.js carry the same slug.
  ticketSlug: 'jira',
  keyPattern: /^[A-Z][A-Z0-9]{1,9}-\d+$/,
  prefixPattern: /^[A-Z][A-Z0-9]{1,9}$/,
  // The record's control table names its source on this row.
  sourceLabel: 'Source',
  // The four sections of the record, and the first header cell that identifies
  // each table. Columns read beyond the first are found by header name.
  coverageSection: 'Coverage map',
  coverageFirst: 'Source section',
  coverageColumns: { items: 'Items', disposition: 'Disposition', reason: 'Reason and owner' },
  dispositions: ['Covered', 'Out of scope', 'Unresolved'],
  unresolvedMarker: /UNRESOLVED — .+\. Owner: .+\. Resolves: .+/,
  repositoriesSection: 'Repository map',
  repositoriesFirst: 'Repository',
  repositoriesColumns: { readAt: 'Read at' },
  // Twelve hex characters, as read-spoke.mjs prints on its Cite: line. A row
  // rests on a tree read at a pinned commit, never on the list's purpose.
  readAtPattern: /^[0-9a-f]{12}$/,
  itemsSection: 'Items',
  itemsFirst: 'Key',
  itemsColumns: { repository: 'Repository' },
  dependenciesSection: 'Dependency map',
  dependenciesFirst: 'From',
  dependenciesSecond: 'To',
  // The item file: two lines read by label, one section read as a table.
  keyLine: /^Key:[ \t]*(\S.*?)\s*$/,
  repositoryLabel: 'Repository',
  repositoryPattern: /^[A-Za-z0-9][A-Za-z0-9._-]*$/,
  acSection: 'Acceptance criteria',
  acIdPattern: /^AC-[1-9]\d*$/,
  acIdLoose: /^AC-\d+$/i,
  carriesColumn: 'Carries',
  // The source document, read as check-requirements.js reads it.
  requirementHeading: /^ {0,3}(#{1,6})\s+(REQ-\S*)/,
  requirementPattern: /^REQ-[1-9]\d*$/,
  // A requirement named in prose: REQ-3, "REQ-3." at the end of a sentence, but
  // not the REQ-3 inside REQ-3.AC-1, and not REQ-30.
  requirementMention: /(?<![A-Za-z0-9-])REQ-[1-9]\d*(?!\.AC-)(?![A-Za-z0-9-])/g,
  keyMention: /[A-Z][A-Z0-9]{1,9}-\d+/g,
  criterionPattern: /^REQ-[1-9]\d*\.AC-[1-9]\d*$/,
  criterionLoose: /^REQ-\d+\.AC-\d+$/i,
  deprecated: /^DEPRECATED\b/,
  // The review's machine surface, shared with the gate.
  approvedVerdict: '### VERDICT: APPROVED',
  verdictLine: /^###\s+VERDICT:\s*(.+?)\s*$/,
  modeLine: /^Mode:[ \t]*(\S.*?)\s*$/,
  mode: 'decomposition-review',
  revisionLabel: 'Record revision',
  revisionLine: /^Record revision:[ \t]*([0-9a-fA-F]{7,40})\s*$/,
  literalNone: 'NONE',
  placeholderToken: /^(?:[-–—]+|\?+|tbd|todo|n\/?a|na|none|nil|pending|placeholder|seebelow|x+)$/i,
  // The line that says which context documents a story, and the requirements
  // document it is cut from, were written against, in the grammar the gate reads
  // on a design: the literal `none`, or one entry per document joined by ", ",
  // as `scripts/read-context.mjs` prints it. A hub entry is `<id>@<12-hex>:<path>`;
  // an entry kept in the story's own repository is
  // `<id>@<12-hex>:<repository-id>:<path>`. check-dev-ready.js,
  // check-requirements.js and `scripts/context-docs.mjs` carry the same
  // grammar; the four are kept in step by hand.
  contextLabel: 'Context',
  contextLine: /^Context:[ \t]*(\S.*?)\s*$/,
  contextNone: 'none',
  contextSeparator: ', ',
  contextEntry: /^([a-z0-9][a-z0-9-]*|(?:[A-Za-z0-9][A-Za-z0-9._-]*\.)?ADR-\d{3,}|global\.(?:std-[a-z0-9]+(?:-[a-z0-9]+)*|EXC-\d{3,}))@([0-9a-f]{12}):(?:([A-Za-z0-9][A-Za-z0-9._-]*):)?((?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[^\s,:]+)$/,
  // The global layer (docs/proposals/global-context.md §8): a third entry form,
  // `<id>@<12-hex>:global:<path>`, its id `global.<id>`, its pin the global
  // commit that the requirements document of this slug records on its
  // `Global:` line. The same names as in check-dev-ready.js, kept in step by
  // hand (generation.md §3.2).
  globalPlace: 'global',
  globalPrefix: 'global.',
  globalStandardId: /^global\.std-[a-z0-9]+(?:-[a-z0-9]+)*$/,
  globalExceptionId: /^global\.EXC-\d{3,}$/,
  globalRuleCite: /(?<![A-Za-z0-9.-])global\.std-[a-z0-9]+(?:-[a-z0-9]+)*\.\d{2,}(?![0-9])/g,
  globalExceptionCite: /(?<![A-Za-z0-9.-])global\.EXC-\d{3,}(?![0-9])/g,
  departsRule: /^std-[a-z0-9]+(?:-[a-z0-9]+)*\.\d{2,}$/,
  exceptionActive: 'Active',
  reviewByDate: /^\d{4}-\d{2}-\d{2}$/,
  // The line beside Context: that names the hub commit the documents were read
  // at: `Hub commit: <40-hex>`, as scripts/read-context.mjs prints it. The same
  // label as in check-requirements.js, check-dev-ready.js and
  // `scripts/context-docs.mjs` (HUB_COMMIT_LABEL); kept in step by hand.
  hubCommitLabel: 'Hub commit',
  hubCommitLine: /^Hub commit:[ \t]*(\S.*?)\s*$/,
  hubCommit: /^[0-9a-f]{40}$/,
  requirementsDir: 'docs/requirements',
  requirementsFile: 'requirements.md',
  globalLine: /^Global:[ \t]*(\S.*?)\s*$/,
  globalNone: 'none',
  globalValue: /^(\S+) (\S+)$/,
  releaseTag: /^v(\d+)\.(\d+)\.(\d+)$/,
  globalCommit: /^[0-9a-f]{40}$/,
  globalPath: 'docs/estate/global.json',
  globalCacheId: 'global',
  // A standard's id, the rule ids it defines, and a decision record's id, as
  // check-requirements.js reads them. A dot before a rule id joins it to the
  // global layer: `global.std-go.03` is never a rule of a hub standard.
  standardId: /^std-[a-z0-9]+(?:-[a-z0-9]+)*$/,
  standardRuleCite: /(?<![A-Za-z0-9.-])std-[a-z0-9]+(?:-[a-z0-9]+)*\.\d{2,}(?![0-9])/g,
  standardRuleDefined: /^-\s+\*\*(std-[a-z0-9]+(?:-[a-z0-9]+)*\.\d{2,})\*\*/,
  // A hyphen after the number makes the id part of a file name, as in
  // docs/architecture/ADR-010-<slug>.md, which names no record. read-context.mjs
  // selects by the same end (designNames), and so does check-dev-ready.js.
  decisionRecordCite: /(?<![A-Za-z0-9.-])(?:[A-Za-z0-9][A-Za-z0-9._-]*\.)?ADR-\d{3,}(?![A-Za-z0-9_-])/g,
};

/* ---------------------------------------------------------------- git access */

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function refuseToJudge(reason, token) {
  process.stderr.write(`\nCANNOT VERIFY: ${reason}\n`);
  process.stderr.write('Refusing to check against unverified state. Fix the remote and re-run.\n');
  // This line names the cause as a fixed token, for the harness's failure record, just before the
  // exit line that the exit handler writes. The token
  // must be on REASONS in scripts/spoke-remote.mjs, and the check of the tokens proves it.
  if (token) process.stderr.write(`REASON: ${token}\n`);
  process.exit(EXIT.CANNOT_VERIFY);
}

function remoteUrl() {
  try {
    return git(['remote', 'get-url', CONFIG.remote]).trim();
  } catch (err) {
    return 'unresolved';
  }
}

function remoteDefaultBranch() {
  try {
    const out = git(['ls-remote', '--symref', CONFIG.remote, 'HEAD']);
    const match = out.match(/^ref:\s+refs\/heads\/(\S+)\s+HEAD/m);
    return match ? match[1] : null;
  } catch (err) {
    return null;
  }
}

function syncDefaultBranch() {
  const ref = `${CONFIG.remote}/${CONFIG.branch}`;
  try {
    git(['fetch', '--no-tags', '--prune', '--force', CONFIG.remote,
      `+refs/heads/${CONFIG.branch}:refs/remotes/${ref}`]);
  } catch (err) {
    refuseToJudge(`could not fetch ${ref} (${String(err.message).split('\n')[0]})`, 'fetch-failed');
  }
  try {
    git(['rev-parse', '--verify', `${ref}^{commit}`]);
  } catch (err) {
    refuseToJudge(`${ref} does not resolve to a commit after fetch`, 'fetch-failed');
  }
  const actual = remoteDefaultBranch();
  if (actual === null) {
    refuseToJudge(`${CONFIG.remote} reports no default branch, so "${CONFIG.branch}" cannot be confirmed as the trunk`, 'no-default-branch');
  }
  if (actual !== CONFIG.branch) {
    refuseToJudge(`the check was pointed at "${CONFIG.branch}" but ${CONFIG.remote}'s default branch is "${actual}"`, 'trunk-mismatch');
  }
  return ref;
}

function listTree(ref, dir) {
  try {
    return git(['ls-tree', '-r', '-z', '--full-name', ref, '--', `:(top)${dir}`])
      .split('\0')
      .filter(Boolean)
      .map((entry) => {
        const tab = entry.indexOf('\t');
        const [mode, type] = entry.slice(0, tab).split(/\s+/);
        return { mode, type, path: entry.slice(tab + 1) };
      });
  } catch (err) {
    return [];
  }
}

function readFromRef(ref, path) {
  try {
    return git(['show', `${ref}:${path}`]);
  } catch (err) {
    return null;
  }
}

// The hash of the BYTES at a path on the trunk. Content-addressed, so it is the
// same value `git hash-object <path>` prints for the same file in a work tree.
function blobHash(ref, path) {
  try {
    return git(['rev-parse', `${ref}:${path}`]).trim();
  } catch (err) {
    return null;
  }
}

// The one entry at exactly `path` on the trunk -- a file, a folder or a link --
// or null when nothing is there. Copied from the gate.
function treeEntry(ref, path) {
  try {
    const out = git(['ls-tree', '-z', '--full-name', ref, '--', `:(top)${path}`]).split('\0').filter(Boolean);
    const hit = out.map((entry) => {
      const tab = entry.indexOf('\t');
      const [mode, type] = entry.slice(0, tab).split(/\s+/);
      return { mode, type, path: entry.slice(tab + 1) };
    }).find((e) => e.path === path);
    return hit || null;
  } catch (err) {
    return null;
  }
}

// Whether this clone can see `commit` at all. A shallow clone may not, and then
// no question about the commit has an answer here.
function knownCommit(commit) {
  try {
    git(['cat-file', '-e', `${commit}^{commit}`]);
    return true;
  } catch (err) {
    return false;
  }
}

function isShallow() {
  try {
    return git(['rev-parse', '--is-shallow-repository']).trim() === 'true';
  } catch (err) {
    return true;
  }
}

// Whether `commit` is on `ref`: itself or one of its ancestors.
function onRef(commit, ref) {
  try {
    git(['merge-base', '--is-ancestor', commit, ref]);
    return true;
  } catch (err) {
    return false;
  }
}

// A story's one `Hub commit:` line: the trunk commit scripts/read-context.mjs
// read the hub's documents at, copied beside the Context: line. Exactly one
// line, a full commit hash, and a commit on the trunk, or the hub entries
// cannot be placed in the hub's history. Returns the commit, or null after a
// failure. A clone too shallow to see the commit is exit 2, never a guess.
// Copied from check-requirements.js.
function checkHubCommit(ref, lines, path, report, hint) {
  const label = CONFIG.hubCommitLabel;
  const claims = [];
  lines.forEach((line, i) => {
    const m = line.match(CONFIG.hubCommitLine);
    if (m) claims.push({ no: i + 1, value: m[1] });
  });
  const expected = `"${label}: <40-hex>", as ${hint} prints it beside the ${CONFIG.contextLabel}: line`;
  if (claims.length === 0) {
    report.fail(`${path} never says which hub commit its context documents were read at: expected exactly one ${expected}`);
    return null;
  }
  if (claims.length > 1) {
    report.fail(`${path} carries ${claims.length} "${label}:" lines (${claims.map((c) => `"${c.value}" on line ${c.no}`).join(', ')}); a story reads the hub at one commit`);
    return null;
  }
  const { value, no } = claims[0];
  const at = `${path} line ${no}: "${label}: ${value}"`;
  if (isPlaceholder(value) || value.search(CONFIG.hubCommit) !== 0) {
    report.fail(`${at} is not a full commit hash, 40 lowercase hex characters; copy the ${expected}`);
    return null;
  }
  if (!knownCommit(value)) {
    if (isShallow()) refuseToJudge(`${at} names a commit this clone cannot see, and this clone is shallow, so the check cannot tell a commit off the trunk from one beyond its depth; fetch full history (fetch-depth: 0) and re-run`, 'shallow-clone');
    report.fail(`${at} names a commit ${ref} does not hold; the story was written against a hub nobody merged, so re-run ${hint} on an up-to-date trunk and copy the ${label}: and ${CONFIG.contextLabel}: lines it prints`);
    return null;
  }
  if (!onRef(value, ref)) {
    report.fail(`${at} names a commit that is not on ${ref}; the story was written against a hub nobody merged, so re-run ${hint} on an up-to-date trunk and copy the ${label}: and ${CONFIG.contextLabel}: lines it prints`);
    return null;
  }
  return value;
}

function stripBom(text) {
  // A byte-order mark is not content, and left in place it sits in front of the
  // first line where every anchored pattern below would read it as a character.
  return text.replace(/^\uFEFF/, '');
}

function readArtefact(ref, entry, report, label) {
  if (entry.mode === '120000') {
    report.fail(`${entry.path} is a symbolic link on ${ref}, not a ${label}; the check reads the bytes committed at that path`);
    return null;
  }
  if (entry.type !== 'blob') {
    report.fail(`${entry.path} is not a file on ${ref}; git reports it as a ${entry.type}`);
    return null;
  }
  const text = readFromRef(ref, entry.path);
  if (text === null) {
    report.fail(`could not read ${entry.path} from ${ref}`);
    return null;
  }
  if (text.trim() === '') {
    report.fail(`${entry.path} is empty on ${ref}; an empty file is not a ${label}`);
    return null;
  }
  return stripBom(text);
}

/* -------------------------------------------------------------- check results */

// A note is a fact the reader should see that does not decide completeness: it
// is printed under its check, pass or fail, and never changes the exit code.
const checks = [];
function check(name) {
  const c = { name, failures: [], notes: [] };
  checks.push(c);
  return { fail: (msg) => c.failures.push(msg), note: (msg) => c.notes.push(msg) };
}

const prefixed = (report, prefix) => ({ fail: (msg) => report.fail(`${prefix}${msg}`) });

/* ------------------------------------------------------- non-content masking */

// Copied from check-dev-ready.js and kept the same on purpose: every check in
// the library reads a page the way a reader sees it, and they have to agree on
// what is content.
const FENCE = /^( {0,3})(`{3,}|~{3,})(.*)$/;
const RAW_TEXT_HTML = /^ {0,3}<(pre|script|style|textarea)(?:[\s/>]|$)/i;
const LIST_ITEM = /^( *)([-*+]|\d{1,9}[.)])( +|$)/;
const ATX_HEADING = /^ {0,3}#{1,6}(?:\s|$)/;
const THEMATIC_BREAK = /^ {0,3}(?:(?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})$/;
const COMMENT_BLOCK = { '<!--': '-->', '{/*': '*/}' };
const COMMENT_BLOCK_OPEN = /^ {0,3}(<!--|\{\/\*)/;
const LINK_DEF = /^ {0,3}\[(?:[^\]\\]|\\.)*\]:(.*)$/;
const TITLE_CLOSER = { '"': '"', "'": "'", '(': ')' };

function indentWidth(line) {
  let width = 0;
  for (const ch of line) {
    if (ch === ' ') width += 1;
    else if (ch === '\t') width += 4 - (width % 4);
    else break;
  }
  return width;
}

function stripInlineComments(line) {
  let text = line;
  for (const [open, close] of Object.entries(COMMENT_BLOCK)) {
    for (;;) {
      const start = text.indexOf(open);
      if (start === -1) break;
      const end = text.indexOf(close, start + open.length);
      if (end === -1) break;
      text = text.slice(0, start) + text.slice(end + close.length);
    }
  }
  return text;
}

function linkDefTitle(line) {
  const m = line.match(LINK_DEF);
  let rest = m[1].trim();
  if (rest === '') return null;
  if (rest.startsWith('<')) {
    const gt = rest.indexOf('>');
    rest = gt === -1 ? '' : rest.slice(gt + 1).trim();
  } else {
    const sp = rest.search(/\s/);
    rest = sp === -1 ? '' : rest.slice(sp).trim();
  }
  return rest === '' ? null : rest;
}

function maskNonContent(text) {
  const lines = String(text).split(/\r\n|\n|\r/);
  const masked = [];
  let fence = null;
  let rawHtml = null;
  let commentClose = null;
  let titleClose = null;
  let titlePending = false;
  let codeIndent = -1;
  let listContent = 0;
  let blockStart = true;

  for (const line of lines) {
    if (fence) {
      const m = line.match(FENCE);
      const closes = !!m && m[2][0] === fence.char && m[2].length >= fence.length && m[3].trim() === '';
      masked.push('');
      if (closes) { fence = null; blockStart = true; }
      continue;
    }
    if (rawHtml) {
      masked.push('');
      if (new RegExp(`</\\s*${rawHtml}\\s*>`, 'i').test(line)) { rawHtml = null; blockStart = true; }
      continue;
    }
    if (commentClose) {
      masked.push('');
      if (line.includes(commentClose)) { commentClose = null; blockStart = true; }
      continue;
    }
    if (titleClose) {
      masked.push('');
      if (line.includes(titleClose)) { titleClose = null; blockStart = true; }
      continue;
    }
    if (codeIndent >= 0) {
      if (line.trim() === '' || indentWidth(line) >= codeIndent) { masked.push(''); continue; }
      codeIndent = -1;
    }
    if (titlePending) {
      titlePending = false;
      const trimmed = line.trim();
      const closer = TITLE_CLOSER[trimmed[0]];
      if (closer) {
        masked.push('');
        if (trimmed.indexOf(closer, 1) === -1) titleClose = closer;
        else blockStart = true;
        continue;
      }
    }
    if (line.trim() === '') { masked.push(line); blockStart = true; continue; }

    const indent = indentWidth(line);
    if (indent < listContent) listContent = 0;

    if (blockStart && indent >= listContent + 4) {
      codeIndent = listContent + 4;
      masked.push('');
      continue;
    }

    if (blockStart && LINK_DEF.test(line)) {
      const title = linkDefTitle(line);
      masked.push('');
      if (title === null) { titlePending = true; continue; }
      const closer = TITLE_CLOSER[title[0]];
      if (closer && title.indexOf(closer, 1) === -1) { titleClose = closer; continue; }
      blockStart = true;
      continue;
    }

    const opener = line.match(FENCE);
    if (opener && !(opener[2][0] === '`' && opener[3].includes('`'))) {
      fence = { char: opener[2][0], length: opener[2].length };
      masked.push('');
      continue;
    }

    const raw = line.match(RAW_TEXT_HTML);
    if (raw) {
      const tag = raw[1].toLowerCase();
      masked.push('');
      if (new RegExp(`</\\s*${tag}\\s*>`, 'i').test(line)) blockStart = true;
      else rawHtml = tag;
      continue;
    }

    const block = line.match(COMMENT_BLOCK_OPEN);
    if (block) {
      const close = COMMENT_BLOCK[block[1]];
      masked.push('');
      if (line.indexOf(close, block[0].length) === -1) commentClose = close;
      else blockStart = true;
      continue;
    }

    if (!THEMATIC_BREAK.test(line)) {
      const li = line.match(LIST_ITEM);
      if (li) listContent = indent + li[2].length + Math.min(Math.max(li[3].length, 1), 4);
    }

    masked.push(stripInlineComments(line));
    blockStart = ATX_HEADING.test(line) || THEMATIC_BREAK.test(line);
  }
  return masked;
}

/* ------------------------------------------------------------- hidden markup */

const HIDDEN_MARKUP = /<\/?\s*(details|summary|table)\b/i;
const HIDDEN_STYLE = /<([a-z][a-z0-9-]*)\b[^>]*(?:\shidden(?=[\s/>=])|style\s*=\s*(?:"[^"]*|'[^']*)(?:display\s*:\s*none|visibility\s*:\s*hidden))/i;

function withoutCodeSpans(line) {
  let out = '';
  let i = 0;
  while (i < line.length) {
    if (line[i] !== '`') { out += line[i]; i += 1; continue; }
    let run = 0;
    while (line[i + run] === '`') run += 1;
    const marker = '`'.repeat(run);
    const end = line.indexOf(marker, i + run);
    if (end === -1) { out += marker; i += run; continue; }
    out += ' ';
    i = end + run;
  }
  return out;
}

function findHiddenMarkup(line) {
  const visible = withoutCodeSpans(line);
  const tag = visible.match(HIDDEN_MARKUP);
  if (tag) return `<${tag[1].toLowerCase()}>`;
  const styled = visible.match(HIDDEN_STYLE);
  if (styled) return `a hidden <${styled[1].toLowerCase()}>`;
  return null;
}

function rejectHiddenMarkup(lines, path, report) {
  for (let i = 0; i < lines.length; i += 1) {
    const found = findHiddenMarkup(lines[i]);
    if (found) {
      report.fail(`${path} carries HTML ${found} markup (line ${i + 1}); the check reads what the page shows, and this markup puts content somewhere the page does not show it`);
      return;
    }
  }
}

/* ------------------------------------------------------------- table parsing */

const SECTION_END = /^#{1,2}\s/;
const HEADING = /^ {0,3}#{1,6}\s/;

function sectionRanges(lines, heading) {
  const re = new RegExp(`^##\\s+(?:\\d+\\.\\s+)?${heading}\\s*$`);
  const starts = [];
  lines.forEach((line, i) => { if (re.test(line)) starts.push(i); });
  return starts.map((start) => {
    let end = lines.length - 1;
    for (let i = start + 1; i < lines.length; i += 1) {
      if (SECTION_END.test(lines[i])) { end = i - 1; break; }
    }
    return [start, end];
  });
}

function sectionRange(lines, heading, report) {
  const all = sectionRanges(lines, heading);
  if (all.length > 1 && report) {
    report.fail(`"## ${heading}" appears ${all.length} times (lines ${all.map((r) => r[0] + 1).join(', ')}); one section, once`);
  }
  return all.length ? all[0] : null;
}

const INVISIBLE = /[\u200B-\u200F\u202A-\u202E\u2060\uFEFF\u00AD]/g;

function splitRow(line) {
  const trimmed = line.replace(INVISIBLE, '').trim();
  if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) return null;
  if (/(?:^|[^\\])(?:\\\\)*\\$/.test(trimmed.slice(0, -1))) return null;
  return trimmed
    .slice(1, -1)
    .split(/(?<!\\)\|/)
    .map((c) => c.trim().replace(/\\\|/g, '|'));
}

function isPlaceholder(cell) {
  const value = cell.trim();
  if (value === '') return false;
  // The one literal that is not a placeholder. `none` in any other casing is.
  if (value === CONFIG.literalNone) return false;
  // A bare number is a value -- a rank, a count, a revision -- where the gate's
  // tables never carry one. The gate's rule below treats any one-character cell
  // as a placeholder; here a digit is content.
  if (/^\d+$/.test(value)) return false;
  if (value.startsWith('<') && value.endsWith('>')) return true;
  let token = value;
  let last;
  do {
    last = token;
    token = token
      .replace(/^[("'`“‘\[]+/, '')
      .replace(/[)"'`”’\]]+$/, '')
      .replace(/[.,;:!?…]+$/, '')
      .trim();
  } while (token !== last);
  const compact = token.replace(/\s+/g, '').toLowerCase();
  if (CONFIG.placeholderToken.test(compact)) return true;
  if (!/[a-z0-9]/i.test(compact)) return true;
  return compact.length < 2;
}

function isSeparatorRow(cells, width) {
  return !!cells && cells.length === width && cells.every((c) => /^:?-{2,}:?$/.test(c));
}

const UNREADABLE_ROW = /^\s*>[\s>]*\|.*\|\s*$/;

function rejectUnreadableRows(lines, range, sectionName, report) {
  for (let i = range[0] + 1; i <= range[1]; i += 1) {
    if (UNREADABLE_ROW.test(lines[i])) {
      report.fail(`the "${sectionName}" section carries a row the check cannot read (line ${i + 1}); every row is a markdown row at the top level of the section`);
      return true;
    }
  }
  return false;
}

function tableBlocks(lines, range) {
  const blocks = [];
  let current = null;
  for (let i = range[0] + 1; i <= range[1]; i += 1) {
    const isRow = lines[i].replace(INVISIBLE, '').trim().startsWith('|');
    if (!isRow) { current = null; continue; }
    if (!current) {
      const before = i === 0 ? '' : lines[i - 1];
      current = {
        opensBlock: i === range[0] + 1 || before.trim() === '' || HEADING.test(before),
        rows: [],
      };
      blocks.push(current);
    }
    current.rows.push({ line: lines[i], no: i + 1 });
  }
  return blocks;
}

function selectTable(blocks, isHeader, idPattern, sectionName, expected, report) {
  const matches = blocks.filter((b) => isHeader(splitRow(b.rows[0].line)));
  if (matches.length > 1) {
    report.fail(`the "${sectionName}" section carries ${matches.length} tables with the same header (lines ${matches.map((b) => b.rows[0].no).join(', ')}); one table, once`);
    return null;
  }
  if (matches.length === 0) {
    report.fail(`the "${sectionName}" table header (line ${blocks[0].rows[0].no}) must begin "${expected}"`);
    return null;
  }
  const chosen = matches[0];
  for (const block of blocks) {
    if (block === chosen) continue;
    for (const entry of block.rows) {
      const cells = splitRow(entry.line);
      if (cells && idPattern.test(cells[0])) {
        report.fail(`the "${sectionName}" section carries a row identified "${cells[0]}" (line ${entry.no}) that is not in the table the check reads`);
      }
    }
  }
  if (!chosen.opensBlock) {
    report.fail(`the "${sectionName}" table (line ${chosen.rows[0].no}) does not start a block; leave a blank line above the header row`);
    return null;
  }
  return chosen;
}

// One table in one section, identified by its first header cell (and second,
// where given). Returns the header and the well-formed data rows, or null where
// the section or the table is missing. A malformed row is a finding and is
// skipped; the rest of the table is still read.
function readTable(lines, sectionName, first, second, idPattern, report, options = {}) {
  const range = sectionRange(lines, sectionName, report);
  if (!range) {
    report.fail(`no "## ${sectionName}" section`);
    return null;
  }
  if (rejectUnreadableRows(lines, range, sectionName, report)) return null;
  const blocks = tableBlocks(lines, range);
  if (blocks.length === 0) {
    if (options.tableOptional) return { header: null, rows: [], line: range[0] + 1 };
    report.fail(`the "${sectionName}" section (line ${range[0] + 1}) has no table`);
    return null;
  }
  const expected = second ? `| ${first} | ${second} |` : `| ${first} |`;
  const table = selectTable(
    blocks,
    (h) => !!h && h.length >= (second ? 2 : 1) && h[0] === first && (!second || h[1] === second),
    idPattern, sectionName, expected, report,
  );
  if (!table) return null;
  const header = splitRow(table.rows[0].line);
  if (table.rows.length < 2 || !isSeparatorRow(splitRow(table.rows[1].line), header.length)) {
    report.fail(`the "${sectionName}" table (line ${table.rows[0].no}) is missing a well-formed separator row`);
    return null;
  }
  const rows = [];
  for (const entry of table.rows.slice(2)) {
    const cells = splitRow(entry.line);
    if (!cells || cells.length !== header.length) {
      report.fail(`"${sectionName}" row (line ${entry.no}) is malformed: expected ${header.length} cells, found ${cells ? cells.length : 0}`);
      continue;
    }
    rows.push({ cells, no: entry.no });
  }
  return { header, rows, line: table.rows[0].no };
}

// The index of one named column, or -1 with a finding.
function column(table, name, sectionName, report) {
  const hits = table.header.map((h, i) => (h === name ? i : -1)).filter((i) => i >= 0);
  if (hits.length !== 1) {
    report.fail(`the "${sectionName}" table header (line ${table.line}) must carry exactly one "${name}" column, found ${hits.length}`);
    return -1;
  }
  return hits[0];
}

const unquoted = (cell) => cell.trim().replace(/^`+|`+$/g, '');

// Every table on a page, and every data cell in it, as check-requirements.js
// reads them. A placeholder is an empty cell wearing a value.
function rejectPlaceholders(lines, path, report) {
  for (const block of tableBlocks(lines, [-1, lines.length - 1])) {
    const header = splitRow(block.rows[0].line);
    for (const entry of block.rows.slice(1)) {
      const cells = splitRow(entry.line);
      if (!cells || (header && isSeparatorRow(cells, header.length))) continue;
      cells.forEach((cell, i) => {
        if (isPlaceholder(cell)) {
          const col = header && header[i] ? `the "${header[i]}" column` : `column ${i + 1}`;
          report.fail(`${path} line ${entry.no} has "${cell}" in ${col}; a placeholder cell is an unknown nobody marked -- write UNRESOLVED — <what>. Owner: <role>. Resolves: <trigger>.`);
        }
      });
    }
  }
}

// Every pipe table on a page. GitHub drops the cells of a row past its header's
// count and pads a short row, so a row whose count is not the header's hides text
// or holds a gap that a reader cannot see (PLDC-686). GitHub renders a table under
// a paragraph line too, so a block counts wherever it starts. A block with no
// separator row of the header's width renders as text, and is skipped. Not seen:
// a row with no leading pipe, and a table inside a blockquote.
function rejectMalformedRows(lines, path, report) {
  for (const block of tableBlocks(lines, [-1, lines.length - 1])) {
    if (block.rows.length < 2) continue;
    const header = splitRow(block.rows[0].line);
    if (!header || !isSeparatorRow(splitRow(block.rows[1].line), header.length)) continue;
    for (const entry of block.rows.slice(2)) {
      const cells = splitRow(entry.line);
      if (!cells) {
        report.fail(`${path} line ${entry.no}: the table row does not end with an unescaped |, so its cells cannot be counted against its header (line ${block.rows[0].no}); end the row with |, and write a literal pipe in a cell as \\|`);
      } else if (cells.length !== header.length) {
        report.fail(`${path} line ${entry.no}: the table row has ${cells.length} cells and its header (line ${block.rows[0].no}) has ${header.length}; write one row on one line, and a literal pipe in a cell as \\|`);
      }
    }
  }
}

/* ---------------------------------------------------------------- the source */

// Copied from check-requirements.js and kept the same on purpose: the two files
// read one document and must agree on what a requirement is.
function requirementSections(lines) {
  const found = [];
  lines.forEach((line, i) => {
    const m = line.match(CONFIG.requirementHeading);
    if (m) found.push({ level: m[1].length, id: m[2], start: i });
  });
  return found.map((section) => {
    let end = lines.length - 1;
    for (let i = section.start + 1; i < lines.length; i += 1) {
      const h = lines[i].match(/^ {0,3}(#{1,6})\s/);
      if (h && h[1].length <= section.level) { end = i - 1; break; }
    }
    return { ...section, end };
  });
}

function parseRequirements(lines, report) {
  const sections = requirementSections(lines);
  if (sections.length === 0) {
    report.fail('no requirement heading in the document: expected at least one heading beginning "REQ-<n>", e.g. "### REQ-1 — <what must be true>"');
    return [];
  }
  const requirements = [];
  const seenCriteria = new Map();
  for (const section of sections) {
    const label = `${section.id} (line ${section.start + 1})`;
    if (!CONFIG.requirementPattern.test(section.id)) {
      report.fail(`requirement heading ${label} has identifier "${section.id}", which does not match REQ-<n> with no leading zeros`);
    }
    if (requirements.some((r) => r.id === section.id)) {
      report.fail(`requirement ${section.id} is defined twice (line ${section.start + 1}); identifiers are minted once and never reused`);
    }
    const requirement = { id: section.id, line: section.start + 1, criteria: [] };
    requirements.push(requirement);

    if (rejectUnreadableRows(lines, [section.start, section.end], section.id, report)) continue;
    const blocks = tableBlocks(lines, [section.start, section.end]);
    if (blocks.length === 0) {
      report.fail(`requirement ${label} has no criteria table; every requirement carries a table beginning "| ID | Criterion |" with at least one REQ-<n>.AC-<m> row`);
      continue;
    }
    const table = selectTable(
      blocks,
      (h) => !!h && h.length >= 2 && h[0] === 'ID' && h[1] === 'Criterion',
      CONFIG.criterionLoose, section.id, '| ID | Criterion |', report,
    );
    if (!table) continue;
    const rows = table.rows;
    const header = splitRow(rows[0].line);
    if (rows.length < 3) {
      report.fail(`the criteria table of ${label} (line ${rows[0].no}) has no rows; at least one criterion per requirement`);
      continue;
    }
    if (!isSeparatorRow(splitRow(rows[1].line), header.length)) {
      report.fail(`the criteria table of ${label} (line ${rows[1].no}) is missing a well-formed separator row`);
      continue;
    }
    for (const entry of rows.slice(2)) {
      const cells = splitRow(entry.line);
      if (!cells || cells.length !== header.length) {
        report.fail(`criterion row under ${section.id} (line ${entry.no}) is malformed: expected ${header.length} cells, found ${cells ? cells.length : 0}`);
        continue;
      }
      const id = cells[0];
      if (!CONFIG.criterionPattern.test(id)) {
        report.fail(`criterion row under ${section.id} (line ${entry.no}) has identifier "${id}", which does not match REQ-<n>.AC-<m> with no leading zeros`);
        continue;
      }
      if (!id.startsWith(`${section.id}.`)) {
        report.fail(`criterion ${id} (line ${entry.no}) sits under ${section.id}; a criterion is scoped to the requirement it is written under, so its identifier begins "${section.id}."`);
      }
      if (seenCriteria.has(id)) {
        report.fail(`criterion ${id} is defined twice (lines ${seenCriteria.get(id)} and ${entry.no}); identifiers are minted once`);
        continue;
      }
      seenCriteria.set(id, entry.no);
      if (cells[1] === '' ) {
        report.fail(`criterion ${id} (line ${entry.no}) has nothing in the Criterion column; a criterion states one observable thing, or reads DEPRECATED with its number kept`);
      }
      requirement.criteria.push({ id, deprecated: CONFIG.deprecated.test(cells[1]), no: entry.no });
    }
    if (requirement.criteria.length === 0) {
      report.fail(`requirement ${label} defines no REQ-<n>.AC-<m> row; at least one criterion per requirement`);
    }
  }
  return requirements;
}

/* --------------------------------------------------------- context documents */

// Whether `id` stands alone somewhere in `lines`, and not inside a longer id.
// A plain search, because the id comes from the page.
function mentions(lines, id) {
  const isIdChar = (ch) => ch !== undefined && ch.search(/[A-Za-z0-9-]/) === 0;
  // A dot before the id joins it to a repository's id: "sample-service.ADR-003" is not ADR-003.
  return lines.some((line) => {
    for (let at = line.indexOf(id); at !== -1; at = line.indexOf(id, at + 1)) {
      if (!isIdChar(line[at - 1]) && line[at - 1] !== '.' && !isIdChar(line[at + id.length])) return true;
    }
    return false;
  });
}

// Every match of a global pattern on the page, each once.
function citations(lines, pattern) {
  return [...new Set(lines.flatMap((line) => line.match(pattern) || []))];
}

// The ids on a page's one Context: line, or null when the page has no single
// well-formed line. For the source document, whose line check-requirements.js
// proves in full; this file reads only which documents it names.
function contextIds(lines) {
  const values = lines.map((line) => line.match(CONFIG.contextLine)).filter(Boolean).map((m) => m[1]);
  if (values.length !== 1) return null;
  if (values[0] === CONFIG.contextNone) return [];
  const entries = values[0].split(CONFIG.contextSeparator).map((item) => item.match(CONFIG.contextEntry));
  return entries.every(Boolean) ? entries.map((m) => m[1]) : null;
}

// The requirements document of this slug on the trunk, as checkGlobalEntries
// takes it: `{ path, release }`, or `{ reason }` when it is not there. A copy
// of the same function in check-dev-ready.js.
function requirementsSource(ref, slug) {
  const path = `${CONFIG.requirementsDir}/${slug}/${CONFIG.requirementsFile}`;
  const text = readFromRef(ref, path);
  if (text === null) return { reason: `${path} is not on ${ref}` };
  return { path, release: recordedRelease(maskNonContent(text.replace(/^\uFEFF/, ''))) };
}

/* ---------------------------------------------------- global context entries */

// The global entries on a Context: line are proved against the global context
// repository (docs/proposals/global-context.md §8, rules 2 to 6). The functions
// from here to checkGlobalUse are the same in check-dev-ready.js,
// check-requirements.js and check-decomposition.js, because each check ships
// verbatim and imports nothing. Change one, change the three in the same commit
// (generation.md §3.2).

// The release a requirements document records on its one Global: line: `{ tag,
// commit }`, null for `Global: none` or no line, or false when the line does
// not name one release. check-requirements.js proves the line itself.
function recordedRelease(lines) {
  const values = lines.map((line) => line.match(CONFIG.globalLine)).filter(Boolean).map((m) => m[1]);
  if (values.length > 1) return false;
  if (values.length === 0 || values[0] === CONFIG.globalNone) return null;
  const m = values[0].match(CONFIG.globalValue);
  if (!m || m[1].search(CONFIG.releaseTag) !== 0 || m[2].search(CONFIG.globalCommit) !== 0) return false;
  return { tag: m[1], commit: m[2] };
}

// The frontmatter of a global document as a map of its keys, or null when the
// document opens with none. The global repository's own check proves the
// header in full. A gate reads the keys it needs.
function frontmatter(text) {
  const lines = String(text).replace(/^\uFEFF/, '').split(/\r?\n/);
  if (lines[0] !== '---') return null;
  const close = lines.indexOf('---', 1);
  if (close === -1) return null;
  const fields = new Map();
  for (const line of lines.slice(1, close)) {
    const m = line.match(/^([A-Za-z][A-Za-z0-9_-]*):[ \t]*(.*?)\s*$/);
    if (m && !fields.has(m[1])) fields.set(m[1], m[2]);
  }
  return fields;
}

// The bytes of the blob a hub entry pins, when the trunk moved past them: its
// history held them, so git can read them. Null when git cannot resolve the
// pin. Copied from the gate.
function pinnedBlob(pin) {
  try {
    return git(['cat-file', 'blob', pin]);
  } catch (err) {
    return null;
  }
}

// Whether a context document is one scripts/read-context.mjs adds to every line
// it prints, whatever ids it is given: alwaysApply: true in its header, and in
// force -- an Accepted decision record, an Active standard, or a document of
// another kind but an exception. The script never drops it, so the page owes
// it no use, and the writer never invents one. The bytes the entry pins decide,
// because those are the bytes the writer was handed. Copied from the gate.
function alwaysOn(text) {
  const header = text === null ? null : frontmatter(text);
  if (header === null || header.get('alwaysApply') !== 'true') return false;
  const kind = header.get('kind');
  if (kind === 'adr') return header.get('status') === 'Accepted';
  if (kind === 'standard') return header.get('status') === 'Active';
  return kind !== undefined && kind !== 'exception';
}

// A one-line JSON array of strings from a header value, or an empty list.
function headerList(value) {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((x) => typeof x === 'string') ? parsed : [];
  } catch (err) {
    return [];
  }
}

// The global repository is read the way the hub reads a spoke: from a bare cache
// outside the hub, never from the checkout the gate stands in. A hub checkout on
// a CI runner carries the runner's own credential in its local git
// configuration, and git sends that before the hub's read credential for its
// spokes, so a private global repository asked from inside the hub is "not
// found". cacheDir and the reads below are copies of the same functions in
// `scripts/spoke-remote.mjs`.

// No prompts, ever: a read that would ask for a password fails instead.
function quietGitEnv() {
  return { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'true', GCM_INTERACTIVE: 'never' };
}

function remoteGit(args) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: quietGitEnv() });
}

function firstLine(text) {
  return String(text || '').split('\n').map((l) => l.trim()).find(Boolean) || '';
}

function cacheDir(id) {
  const root = process.env.HARNESS_SPOKE_CACHE || join(tmpdir(), 'harness-spokes');
  const dir = join(root, `${id}.git`);
  // The cache holds nothing that a fetch cannot bring again. macOS removes files from the temp
  // directory that are older than three days, and the folder that remains is not a repository.
  // A folder that git does not open as a repository is removed and made again.
  if (existsSync(dir) && !isCacheRepository(dir)) rmSync(dir, { recursive: true, force: true });
  if (!existsSync(dir)) {
    mkdirSync(root, { recursive: true });
    git(['init', '--bare', '--quiet', dir]);
  }
  return dir;
}

function isCacheRepository(dir) {
  try {
    git(['--git-dir', dir, 'rev-parse', '--git-dir']);
    return true;
  } catch {
    return false;
  }
}

// The trunk is what the remote says HEAD points at, now.
function globalTrunk(dir, url) {
  let out;
  try {
    out = remoteGit(['--git-dir', dir, 'ls-remote', '--symref', url, 'HEAD']);
  } catch (err) {
    return refuseToJudge(`cannot reach the global repository ${url}: ${firstLine(err.stderr) || firstLine(err.message)}`, 'remote-unreachable');
  }
  const m = out.match(/^ref: refs\/heads\/(\S+)\tHEAD$/m);
  if (!m) refuseToJudge(`the global repository ${url} did not report a default branch, so its trunk cannot be confirmed`, 'no-default-branch');
  return m[1];
}

// The trunk's whole history. `--unshallow` when a depth-1 reader left the cache
// shallow.
function fetchGlobalTrunk(dir, url, trunk) {
  try {
    const args = ['--git-dir', dir, 'fetch', '--quiet', '--no-tags'];
    if (existsSync(join(dir, 'shallow'))) args.push('--unshallow');
    remoteGit([...args, url, trunk]);
  } catch (err) {
    return refuseToJudge(`cannot fetch ${trunk} from the global repository ${url}: ${firstLine(err.stderr) || firstLine(err.message)}`, 'fetch-failed');
  }
  return git(['--git-dir', dir, 'rev-parse', 'FETCH_HEAD']).trim();
}

// Whether the cache holds `commit` after asking the remote for it: by hash at
// depth 1 first, then the trunk in full, for a server that refuses a bare hash.
// A remote that does not answer is exit 2. False is a fact: the remote does not
// know the commit.
function haveGlobalCommit(dir, url, commit) {
  const held = () => {
    try {
      git(['--git-dir', dir, 'cat-file', '-e', `${commit}^{commit}`]);
      return true;
    } catch (err) {
      return false;
    }
  };
  if (held()) return true;
  const trunk = globalTrunk(dir, url);
  try {
    remoteGit(['--git-dir', dir, 'fetch', '--quiet', '--depth', '1', '--no-tags', url, commit]);
  } catch (err) {
    // A server may refuse a bare hash. The full trunk below is the fallback.
  }
  if (held()) return true;
  fetchGlobalTrunk(dir, url, trunk);
  return held();
}

// What is at `commit:path` in the cache: `{ type, text }`, or null when nothing is.
function globalObject(dir, commit, path) {
  let type;
  try {
    type = git(['--git-dir', dir, 'cat-file', '-t', `${commit}:${path}`]).trim();
  } catch (err) {
    return null;
  }
  return { type, text: type === 'blob' ? git(['--git-dir', dir, 'cat-file', 'blob', `${commit}:${path}`]) : null };
}

// The hub's link to the global repository, read from the trunk: `{ url }`, null
// when the trunk carries no link and the hub has no global layer, or false when
// the link is there and broken, which is reported here. The rules are the ones
// `governance/global.schema.json` states and `scripts/spoke-remote.mjs`
// (validateGlobalLink) reads, copied.
function readGlobalLink(ref, report) {
  const path = CONFIG.globalPath;
  const found = treeEntry(ref, path);
  if (found === null) return null;
  if (found.mode === '120000' || found.type !== 'blob') {
    report.fail(`${path} is ${found.mode === '120000' ? 'a symbolic link' : `a ${found.type}`} on ${ref}, not the hub's link to the global repository`);
    return false;
  }
  const text = readFromRef(ref, path);
  if (text === null) {
    report.fail(`could not read ${path} on ${ref}`);
    return false;
  }
  let link;
  try {
    link = JSON.parse(text);
  } catch (err) {
    report.fail(`${path} on ${ref} is not JSON: ${err.message}`);
    return false;
  }
  const problems = [];
  if (link === null || typeof link !== 'object' || Array.isArray(link)) {
    problems.push('the root must be an object with "schema_version" and "url"');
  } else {
    for (const k of Object.keys(link)) {
      if (k !== 'schema_version' && k !== 'url') problems.push(`unknown root field "${k}"`);
    }
    if (link.schema_version !== 1) problems.push(`"schema_version" must be 1, got ${JSON.stringify(link.schema_version)}`);
    if (!('url' in link)) problems.push('"url" is missing');
    else if (typeof link.url !== 'string') problems.push('"url" must be a string');
    else if (link.url.trim() === '') problems.push('"url" is empty');
    else if (credentialInUrl(link.url)) problems.push('"url" carries a user name or password, and a clone URL in a committed file is never a credential');
  }
  if (problems.length) {
    report.fail(`${path} on ${ref} is not well formed: ${problems.join('; ')}`);
    return false;
  }
  return { url: link.url };
}

function credentialInUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch (err) {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  return parsed.username !== '' || parsed.password !== '';
}

// This hub's key prefix, from the key ledger on the trunk, or null.
function hubPrefix(ref) {
  const text = readFromRef(ref, CONFIG.keysPath);
  if (text === null) return null;
  try {
    const prefix = JSON.parse(text.replace(/^\uFEFF/, '')).prefix;
    return typeof prefix === 'string' ? prefix : null;
  } catch (err) {
    return null;
  }
}

// The repository ids this hub lists, from its registry on the trunk.
function registryIds(ref) {
  const text = readFromRef(ref, CONFIG.registryPath);
  if (text === null) return [];
  try {
    const repos = JSON.parse(text.replace(/^\uFEFF/, '')).repositories;
    return repos && typeof repos === 'object' && !Array.isArray(repos) ? Object.keys(repos) : [];
  } catch (err) {
    return [];
  }
}

// Rules 2 to 6 of §8 for the global entries on one Context: line.
//   entries  the line's entries whose place is `global`
//   ids      every id on the line
//   at       the line, for a message
//   source   `{ path, release }`: the requirements document the artefact traces
//            to and what recordedRelease read on it, or `{ reason }` when that
//            document cannot be found
//   link     what readGlobalLink returned
//   remote   false in the story-gate mode: rule 2 only, and the global
//            repository is not read
// Returns a map from each global document on the line to its text at the
// recorded commit, for checkGlobalUse.
function checkGlobalEntries(ref, { entries, ids, at, source, link, remote, report }) {
  const texts = new Map();
  if (!entries.length || link === false) return texts;
  const named = entries.map((e) => `"${e.id}"`).join(', ');
  if (link === null) {
    report.fail(`${at}: ${named} cite${entries.length === 1 ? 's' : ''} the global layer, and ${ref} carries no ${CONFIG.globalPath}, so this hub has no global layer and cites no global document; remove the global entries, or connect the hub first`);
    return texts;
  }
  if (source.reason) {
    report.fail(`${at}: ${named} cite${entries.length === 1 ? 's' : ''} the global layer, and ${source.reason}, so nothing says which global release the feature records`);
    return texts;
  }
  const { path, release } = source;
  if (release === null) {
    report.fail(`${at}: ${named} cite${entries.length === 1 ? 's' : ''} the global layer, and ${path} records "Global: ${CONFIG.globalNone}", so the feature reads no global release; amend the requirements to a release first`);
    return texts;
  }
  if (release === false) {
    report.fail(`${at}: ${named} cite${entries.length === 1 ? 's' : ''} the global layer, and ${path} carries no single "Global: vX.Y.Z <40-hex>" line, so nothing says which global release the feature records; run scripts/check-requirements.js on it`);
    return texts;
  }
  const pin = release.commit.slice(0, 12);
  const pinned = entries.filter((e) => {
    if (e.pin === pin) return true;
    report.fail(`${at}: "${e.item}" pins the global commit ${e.pin}, and ${path} records ${release.tag} at ${release.commit}. An artefact cites the global release its feature records, so copy the line scripts/read-context.mjs --global ${release.commit} prints`);
    return false;
  });
  if (!remote || !pinned.length) return texts;

  // Every rule below asks the global repository. An unreachable remote is exit 2.
  const dir = cacheDir(CONFIG.globalCacheId);
  if (!haveGlobalCommit(dir, link.url, release.commit)) {
    report.fail(`${at}: ${link.url} has no commit ${release.commit}, the one ${path} records for ${release.tag}, so no global entry on the line can be read`);
    return texts;
  }
  const where = `the global repository at ${release.tag} (${pin})`;
  let prefix;
  let listed;
  for (const e of pinned) {
    const found = globalObject(dir, release.commit, e.path);
    if (found === null) {
      report.fail(`${at}: "${e.id}" cites ${e.path}, which is not in ${where}; copy the line scripts/read-context.mjs --global ${release.commit} prints`);
      continue;
    }
    if (found.type !== 'blob') {
      report.fail(`${at}: "${e.id}" cites ${e.path}, which is a ${found.type} in ${where}, not a document`);
      continue;
    }
    const own = e.id.slice(CONFIG.globalPrefix.length);
    const header = frontmatter(found.text);
    const name = header === null ? null : header.get('name') || null;
    if (name !== own) {
      report.fail(`${at}: "${e.id}" cites ${e.path}, and its header in ${where} names ${name === null ? 'no id' : `"${name}"`}, not "${own}"; copy the line scripts/read-context.mjs --global ${release.commit} prints`);
      continue;
    }
    texts.set(e.id, found.text);
    if (e.id.search(CONFIG.globalExceptionId) !== 0) continue;

    // Rule 5: the exception has effect for this hub, and the line cites what it departs from.
    const status = header.get('status') || null;
    if (status !== CONFIG.exceptionActive) {
      report.fail(`${at}: "${e.id}" is ${status === null ? 'without a status' : status} in ${where}, and only an ${CONFIG.exceptionActive} exception has effect; follow the record it departed from`);
    }
    if (prefix === undefined) {
      prefix = hubPrefix(ref);
      listed = registryIds(ref);
    }
    const hubs = headerList(header.get('hubs'));
    if (prefix === null) {
      report.fail(`${at}: "${e.id}" names the hubs ${hubs.join(', ') || '(none)'}, and ${CONFIG.keysPath} on ${ref} carries no key prefix, so nothing says whether the exception names this hub`);
    } else if (!hubs.includes(prefix)) {
      // §9.1: an exception that covers a spoke names every hub that owns it.
      const shared = headerList(header.get('repositories')).filter((r) => listed.includes(r));
      report.fail(shared.length
        ? `${at}: "${e.id}" covers ${shared.join(', ')}, which this hub also lists in ${CONFIG.registryPath}, and names the hubs ${hubs.join(', ') || '(none)'}, not ${prefix}. An exception that covers a shared spoke names every hub that owns it, so ask the Global Architecture Board for an exception that names ${prefix}`
        : `${at}: "${e.id}" names the hubs ${hubs.join(', ') || '(none)'}, not this hub, ${prefix}. A hub departs from a global record only through an exception that names it`);
    }
    for (const departed of headerList(header.get('departs'))) {
      const needed = `${CONFIG.globalPrefix}${departed.search(CONFIG.departsRule) === 0 ? departed.slice(0, departed.lastIndexOf('.')) : departed}`;
      if (!ids.has(needed)) {
        report.fail(`${at}: "${e.id}" departs from ${CONFIG.globalPrefix}${departed}, and ${needed} is not on the line. An artefact that cites an exception cites the record it departs from beside it`);
      }
    }
    const reviewBy = header.get('review-by') || '';
    if (reviewBy.search(CONFIG.reviewByDate) === 0 && reviewBy < new Date().toISOString().slice(0, 10)) {
      report.note(`stale exception: "${e.id}" passed its review-by date, ${reviewBy}. It still has effect, and the Global Architecture Board revisits it`);
    }
  }
  return texts;
}

// Rule 4 of §8 for the global ids: each one on the line is used on the page, a
// global standard by a rule it defines, `global.std-<topic>.<NN>`; and each
// global standard rule or exception the page cites is on the line. A global
// record the page cites, `global.ADR-<NNN>`, is a decision record, and the
// caller's own record check lists it. A global document the script adds to
// every line, an always-on one, owes the page no use. `body` is the page
// without the line, `texts` what checkGlobalEntries returned, or null where
// the global repository was not read and design-gate proved each use, and
// `what` the artefact's noun.
function checkGlobalUse(body, path, at, entries, report, texts, what) {
  const ruleCites = citations(body, CONFIG.globalRuleCite);
  const ruleOf = (rule) => rule.slice(0, rule.lastIndexOf('.'));
  for (const e of entries.filter((x) => x.id.startsWith(CONFIG.globalPrefix))) {
    const owed = texts !== null && !alwaysOn(texts.get(e.id) ?? null);
    if (e.id.search(CONFIG.globalStandardId) === 0) {
      const cited = ruleCites.filter((rule) => ruleOf(rule) === e.id);
      if (cited.length === 0) {
        if (owed) report.fail(`${at}: "${e.id}" is a global standard on the "${CONFIG.contextLabel}:" line, and the ${what} cites none of its rules; cite each rule that applies by its id, ${e.id}.<NN>, or remove the standard from the line`);
      } else if (texts !== null && texts.has(e.id)) {
        const defined = new Set(texts.get(e.id).split('\n').map((line) => line.match(CONFIG.standardRuleDefined)).filter(Boolean).map((m) => `${CONFIG.globalPrefix}${m[1]}`));
        for (const rule of cited.filter((r) => !defined.has(r))) {
          report.fail(`${path} cites ${rule}, which ${e.path} does not define in the global repository; cite a rule the standard carries`);
        }
      }
    } else if (owed && !mentions(body, e.id)) {
      report.fail(`${at}: "${e.id}" is on the "${CONFIG.contextLabel}:" line and named nowhere else in the ${what}; name it where it applies, or remove it from the line`);
    }
  }
  const listed = new Set(entries.map((e) => e.id));
  for (const standard of [...new Set(ruleCites.map(ruleOf))].filter((x) => !listed.has(x))) {
    report.fail(`${path} cites ${ruleCites.filter((r) => ruleOf(r) === standard).join(', ')}, and its "${CONFIG.contextLabel}:" line does not list ${standard}; a ${what} lists every global standard it read, so copy the line scripts/read-context.mjs --global prints`);
  }
  for (const exception of citations(body, CONFIG.globalExceptionCite).filter((x) => !listed.has(x))) {
    report.fail(`${path} names ${exception}, and its "${CONFIG.contextLabel}:" line does not list it; a ${what} that departs from a global record cites the exception on the line, so copy the line scripts/read-context.mjs --global prints`);
  }
}

// One story's Context: line: the documents /decompose selected for it with
// scripts/read-context.mjs <repository> --at <commit> --names, and handed to the
// critic as text. Exactly one line: the literal `none`, or one entry per
// document. A hub entry is proved on the trunk as the gate proves a design's: on
// the trunk, at the bytes it pins or bytes the trunk once held, with a drift
// note when the document moved. An entry kept in a repository must be kept in
// the story's own repository, and is checked for its shape alone, because this
// file reads one remote. Each entry must show that the story used it, where a
// reader sees it: its id named on the page, and a standard cited by at least one
// rule it defines. The reverse holds too: a decision record or a standard's rule
// the page cites is on the line. A global entry is proved by checkGlobalEntries
// against `global`: `{ link, source }`, the hub's link to the global repository
// and the requirements document of this slug. Returns the ids on the line, or
// null.
function checkItemContext(ref, item, report, global) {
  const { lines, path } = item;
  const hint = `scripts/read-context.mjs ${item.repository || '<repository>'} --at <commit> --names`;
  const hubCommit = checkHubCommit(ref, lines, path, report, hint);
  const claims = [];
  lines.forEach((line, i) => {
    const m = line.match(CONFIG.contextLine);
    if (m) claims.push({ no: i + 1, value: m[1] });
  });
  const expected = `"${CONFIG.contextLabel}: ${CONFIG.contextNone}" or "${CONFIG.contextLabel}: <id>@<12-hex>:<path>${CONFIG.contextSeparator}<id>@<12-hex>:<repository-id>:<path>"`;
  if (claims.length === 0) {
    report.fail(`${path} never says which context documents the story was written against: expected exactly one ${expected} line, as ${hint} prints it`);
    return null;
  }
  if (claims.length > 1) {
    report.fail(`${path} carries ${claims.length} "${CONFIG.contextLabel}:" lines (${claims.map((c) => `"${c.value}" on line ${c.no}`).join(', ')}); a story is written against one set of context documents`);
    return null;
  }
  const { value, no } = claims[0];
  const at = `${path} line ${no}: "${CONFIG.contextLabel}: ${value}"`;
  let entries = [];
  if (value !== CONFIG.contextNone) {
    const items = value.split(CONFIG.contextSeparator);
    const parsed = items.map((entry) => {
      const m = entry.match(CONFIG.contextEntry);
      return m ? { item: entry, id: m[1], pin: m[2], repository: m[3] || null, path: m[4] } : null;
    });
    const bad = items.filter((entry, i) => parsed[i] === null);
    const ids = parsed.filter(Boolean).map((e) => e.id);
    const repeated = ids.filter((id, i) => ids.indexOf(id) !== i);
    if (items.includes(CONFIG.contextNone)) {
      report.fail(`${at} lists "${CONFIG.contextNone}" beside document ids; "${CONFIG.contextNone}" stands alone, and means no document binds`);
      return null;
    }
    if (isPlaceholder(value) || bad.length) {
      report.fail(`${at} is neither ${expected}${bad.length && !isPlaceholder(value) ? `: ${bad.map((b) => JSON.stringify(b)).join(', ')} ${bad.length === 1 ? 'is not a context entry' : 'are not context entries'}` : ''}; copy the line ${hint} prints`);
      return null;
    }
    if (repeated.length) {
      report.fail(`${at} names ${[...new Set(repeated)].map((r) => `"${r}"`).join(', ')} more than once; copy the line ${hint} prints`);
      return null;
    }
    entries = parsed;
  }

  // The page as a reader sees it, without the line itself: a citation on the
  // line is not a use of the document.
  const body = lines.map((line, i) => (i === no - 1 ? '' : line));
  const ruleCites = citations(body, CONFIG.standardRuleCite);
  const ruleOf = (rule) => rule.slice(0, rule.lastIndexOf('.'));

  const globalEntries = [];
  for (const e of entries) {
    let text = null;
    let pinned = null;
    // Rule 1 of the global layer: a global id only in the global form, and the
    // global form only around a global id.
    const globalId = e.id.startsWith(CONFIG.globalPrefix);
    if (globalId && e.repository !== CONFIG.globalPlace) {
      report.fail(`${at}: "${e.item}" is a global document and the entry places it ${e.repository === null ? 'in the hub' : `in "${e.repository}"`}. A global entry is <id>@<12-hex>:${CONFIG.globalPlace}:<path>, so copy the line ${hint} prints`);
      continue;
    }
    if (!globalId && e.repository === CONFIG.globalPlace) {
      report.fail(`${at}: "${e.item}" places ${e.id} in the global layer, and a global document's id starts with "${CONFIG.globalPrefix}". Copy the line ${hint} prints`);
      continue;
    }
    if (globalId) {
      globalEntries.push(e);
      continue;
    }
    if (e.repository !== null) {
      // A document kept in a repository other than the hub: this file reads one
      // remote, so the shape and the id are all it can check.
      if (item.repository !== null && e.repository !== item.repository) {
        report.fail(`${at}: "${e.item}" is kept in "${e.repository}"; this story lands in "${item.repository}", and a story reads the hub's documents and its own repository's, no other`);
      }
    } else {
      const found = treeEntry(ref, e.path);
      if (found === null) {
        report.fail(`${at}: "${e.id}" cites ${e.path}, which is not on ${ref}; a story is written against documents a person merged, so merge the document first or copy the line ${hint} prints`);
      } else if (found.mode === '120000' || found.type !== 'blob') {
        report.fail(`${at}: "${e.id}" cites ${e.path}, which is ${found.mode === '120000' ? 'a symbolic link' : `a ${found.type}`} on ${ref}, not a document`);
      } else {
        text = readFromRef(ref, e.path);
        const actual = blobHash(ref, e.path);
        if (actual === null || text === null) {
          report.fail(`could not read ${e.path} on ${ref}`);
        } else {
          // The commit the Hub commit: line names holds the pinned bytes, or
          // the two lines were not copied from one run. A failed Hub commit:
          // line is already reported, and leaves nothing to prove the pin against.
          const held = hubCommit === null ? null : blobHash(hubCommit, e.path);
          if (hubCommit !== null && !(held !== null && held.startsWith(e.pin))) {
            report.fail(`${at}: "${e.id}" pins ${e.pin} for ${e.path}, and the hub at ${hubCommit.slice(0, e.pin.length)}, the commit the ${CONFIG.hubCommitLabel}: line names, ${held === null ? 'has no file there' : `holds ${held.slice(0, e.pin.length)} there`}; the two lines were not copied from one run, so re-run ${hint} on an up-to-date trunk and copy the ${CONFIG.hubCommitLabel}: and ${CONFIG.contextLabel}: lines it prints`);
          } else if (!actual.startsWith(e.pin)) {
            if (hubCommit !== null) pinned = pinnedBlob(e.pin);
            report.note(`context drift: "${e.id}" (${e.path}) was ${e.pin} when ${item.key} read it and is ${actual.slice(0, e.pin.length)} on ${ref} now; the document moved after the story was written, so re-read it and decide whether the story still holds`);
          } else {
            pinned = text;
          }
        }
      }
    }
    // The script adds an always-on document to every line, so a story that does
    // not use it is not a failure. A rule the story cites from it is still proved.
    const always = alwaysOn(pinned);
    if (e.id.search(CONFIG.standardId) === 0) {
      const cited = ruleCites.filter((rule) => ruleOf(rule) === e.id);
      if (cited.length === 0) {
        if (!always) report.fail(`${at}: "${e.id}" is a standard, and the story cites none of its rules; cite each rule that shapes a criterion by its id, ${e.id}.<NN>, or remove the standard from the line`);
      } else if (text !== null) {
        const defined = new Set(text.split('\n').map((line) => line.match(CONFIG.standardRuleDefined)).filter(Boolean).map((m) => m[1]));
        for (const rule of cited.filter((r) => !defined.has(r))) {
          report.fail(`${path} cites ${rule}, which ${e.path} on ${ref} does not define; cite a rule the standard carries`);
        }
      }
    } else if (!always && !mentions(body, e.id)) {
      report.fail(`${at}: "${e.id}" is on the line and named nowhere else in the story; name it where it shapes a criterion, or remove it from the line`);
    }
  }
  // A story inherits the Global: line of the requirements document it is cut from.
  const globalTexts = checkGlobalEntries(ref, { entries: globalEntries, ids: new Set(entries.map((e) => e.id)), at, source: global.source, link: globalEntries.length ? global.link : null, remote: true, report });
  checkGlobalUse(body, path, at, entries, report, globalTexts, 'story');

  const listed = new Set(entries.map((e) => e.id));
  for (const standard of [...new Set(ruleCites.map(ruleOf))].filter((x) => !listed.has(x))) {
    report.fail(`${path} cites ${ruleCites.filter((r) => ruleOf(r) === standard).join(', ')}, and its "${CONFIG.contextLabel}:" line does not list ${standard}; a story lists every standard it read, so select it with ${hint} and copy the line it prints`);
  }
  for (const record of citations(body, CONFIG.decisionRecordCite).filter((r) => !listed.has(r))) {
    report.fail(`${path} names ${record}, and its "${CONFIG.contextLabel}:" line does not list it; a story lists every decision record it read, so select it with ${hint} and copy the line it prints`);
  }
  return entries.map((e) => e.id);
}

/* ----------------------------------------------------------------- the items */

// One work-item file: its key, its one repository, and its criteria with the
// requirement criterion each carries. Findings are recorded and the item is
// still collected where it can be, so one defect is one finding.
function parseItem(lines, path, key, report) {
  const item = { key, path, repository: null, criteria: [] };

  const keys = lines.filter((l) => CONFIG.keyLine.test(l)).map((l) => l.match(CONFIG.keyLine)[1]);
  if (keys.length !== 1) {
    report.fail(`${path} must carry exactly one "Key: <KEY>" line, found ${keys.length}`);
  } else if (keys[0] !== key) {
    report.fail(`${path} says "Key: ${keys[0]}" but is filed as ${key}; one item, one key, and the filename carries it`);
  }

  const repoLine = new RegExp(`^${CONFIG.repositoryLabel}:[ \\t]*(\\S.*?)\\s*$`);
  const repos = lines.filter((l) => repoLine.test(l)).map((l) => l.match(repoLine)[1]);
  if (repos.length !== 1) {
    report.fail(`${path} must carry exactly one "${CONFIG.repositoryLabel}: <id>" line, found ${repos.length}; a story lands in exactly one repository`);
  } else if (!CONFIG.repositoryPattern.test(repos[0]) || isPlaceholder(repos[0])) {
    report.fail(`${path}: "${CONFIG.repositoryLabel}: ${repos[0]}" is not a repository id`);
  } else {
    item.repository = repos[0];
  }

  const table = readTable(lines, CONFIG.acSection, 'ID', 'Criterion', CONFIG.acIdLoose, prefixed(report, `${path}: `));
  if (!table) return item;
  const carries = column(table, CONFIG.carriesColumn, CONFIG.acSection, prefixed(report, `${path}: `));
  for (const { cells, no } of table.rows) {
    const id = cells[0];
    if (!CONFIG.acIdPattern.test(id)) {
      report.fail(`${path} line ${no}: criterion identifier "${id}" does not match AC-<n>`);
      continue;
    }
    if (item.criteria.some((c) => c.id === id)) {
      report.fail(`${path} line ${no}: criterion ${id} is defined twice`);
      continue;
    }
    let carried = null;
    if (carries >= 0) {
      if (CONFIG.criterionPattern.test(cells[carries])) {
        carried = cells[carries];
      } else {
        report.fail(`${path} line ${no}: criterion ${id} carries "${cells[carries]}", which is not one REQ-<n>.AC-<m>; every item criterion names the requirement criterion it carries`);
      }
    }
    // A story retires a criterion as the source does: DEPRECATED first in the
    // Criterion cell, the number kept. A retired row builds nothing.
    item.criteria.push({ id, carries: carried, deprecated: CONFIG.deprecated.test(cells[1]), no });
  }
  if (item.criteria.length === 0) {
    report.fail(`${path}: the "${CONFIG.acSection}" table defines no AC-<n> row; a story with no criteria cannot be accepted`);
  }
  return item;
}

/* ---------------------------------------------------------------- the ledger */

const isCount = (v) => Number.isInteger(v) && v >= 1;

// docs/backlog/keys.json: the prefix, the next free number, and one block per
// artefact that minted keys. The shape is read by hand, standard library only.
function parseKeys(text, report) {
  let keys;
  try {
    keys = JSON.parse(stripBom(text));
  } catch (err) {
    report.fail(`${CONFIG.keysPath} is not JSON: ${String(err.message).split('\n')[0]}`);
    return null;
  }
  if (!keys || typeof keys !== 'object' || Array.isArray(keys)) {
    report.fail(`${CONFIG.keysPath} must be a JSON object with "prefix", "next" and "blocks"`);
    return null;
  }
  let sound = true;
  if (keys.schema_version !== 1) {
    report.fail(`${CONFIG.keysPath}: "schema_version" must be 1`);
    sound = false;
  }
  if (typeof keys.prefix !== 'string' || !CONFIG.prefixPattern.test(keys.prefix)) {
    report.fail(`${CONFIG.keysPath}: "prefix" must match ${CONFIG.prefixPattern} (the letters before the hyphen in every key), found ${JSON.stringify(keys.prefix)}`);
    sound = false;
  }
  if (!isCount(keys.next)) {
    report.fail(`${CONFIG.keysPath}: "next" must be a positive integer, the next number nobody has minted; found ${JSON.stringify(keys.next)}`);
    sound = false;
  }
  if (!Array.isArray(keys.blocks)) {
    report.fail(`${CONFIG.keysPath}: "blocks" must be an array, one entry per block of keys minted`);
    return sound ? { ...keys, blocks: [] } : null;
  }
  const blocks = [];
  keys.blocks.forEach((block, i) => {
    const label = `${CONFIG.keysPath} blocks[${i}]`;
    if (!block || typeof block !== 'object' || Array.isArray(block)) {
      report.fail(`${label} is not an object`);
      sound = false;
      return;
    }
    let ok = true;
    if (!isCount(block.from) || !isCount(block.to) || block.from > block.to) {
      report.fail(`${label}: "from" and "to" must be positive integers with from <= to, found ${JSON.stringify(block.from)} and ${JSON.stringify(block.to)}`);
      ok = false;
    }
    if (block.taken_by === 'decomposition') {
      if (typeof block.slug !== 'string' || !CONFIG.slugPattern.test(block.slug)) {
        report.fail(`${label}: a block taken by a decomposition names its "slug" in kebab-case, found ${JSON.stringify(block.slug)}`);
        ok = false;
      }
    } else if (block.taken_by === 'validation') {
      if (typeof block.key !== 'string' || !CONFIG.keyPattern.test(block.key)) {
        report.fail(`${label}: a block taken by a validation names the "key" of the work item validated, found ${JSON.stringify(block.key)}`);
        ok = false;
      }
    } else {
      report.fail(`${label}: "taken_by" must be "decomposition" or "validation", found ${JSON.stringify(block.taken_by)}`);
      ok = false;
    }
    if (ok && isCount(keys.next) && block.to >= keys.next) {
      report.fail(`${label} runs to ${block.to} but "next" is ${keys.next}; the counter moves past every block minted`);
      ok = false;
    }
    if (ok) blocks.push({ ...block, index: i });
    else sound = false;
  });
  for (let a = 0; a < blocks.length; a += 1) {
    for (let b = a + 1; b < blocks.length; b += 1) {
      if (blocks[a].from <= blocks[b].to && blocks[b].from <= blocks[a].to) {
        report.fail(`${CONFIG.keysPath} blocks[${blocks[a].index}] (${blocks[a].from}-${blocks[a].to}) and blocks[${blocks[b].index}] (${blocks[b].from}-${blocks[b].to}) overlap; two artefacts minting one number is two items wearing one key`);
        sound = false;
      }
    }
  }
  return sound ? { ...keys, blocks } : null;
}

/* ---------------------------------------------------------------- the review */

// The review binds to a REVISION of the record, and the only durable name for a
// revision is the hash of the bytes reviewed. Copied from the gate's
// checkReviewRevision with this artefact type's label.
function checkReviewRevision(ref, recordPath, reviewPath, reviewLines, report) {
  const actual = blobHash(ref, recordPath);
  if (actual === null) {
    report.fail(`could not read the revision of ${recordPath} on ${ref}`);
    return;
  }
  const hits = [];
  reviewLines.forEach((line, i) => {
    const m = line.match(CONFIG.revisionLine);
    if (m) hits.push({ no: i + 1, value: m[1].toLowerCase() });
  });
  if (hits.length === 0) {
    report.fail(`${reviewPath} carries no "${CONFIG.revisionLabel}: <hash>" line, so it names no revision of ${recordPath}; write the value of \`git hash-object ${recordPath}\` for the record you reviewed (on ${ref} that is currently ${actual})`);
    return;
  }
  if (hits.length > 1) {
    report.fail(`${reviewPath} carries ${hits.length} "${CONFIG.revisionLabel}:" lines (lines ${hits.map((h) => h.no).join(', ')}); a review approves one revision`);
    return;
  }
  const claimed = hits[0].value;
  if (!actual.startsWith(claimed)) {
    report.fail(`${reviewPath} approves revision ${claimed} of ${recordPath}, but ${ref} carries ${actual}; the record changed after it was reviewed, so the current record is unreviewed`);
  }
}

function checkReview(ref, reviewEntry, reviewLines, recordPath, slug, report) {
  const path = reviewEntry.path;
  rejectHiddenMarkup(reviewLines, path, report);
  rejectMalformedRows(reviewLines, path, report);
  const verdicts = reviewLines.filter((l) => CONFIG.verdictLine.test(l));
  if (verdicts.length !== 1) {
    report.fail(`${path} must contain exactly one verdict line, found ${verdicts.length}`);
  } else if (verdicts[0].trimEnd() !== CONFIG.approvedVerdict) {
    report.fail(`${path} verdict is "${verdicts[0].trim()}"; the check opens only on "${CONFIG.approvedVerdict}"`);
  }
  const modes = reviewLines.filter((l) => CONFIG.modeLine.test(l)).map((l) => l.match(CONFIG.modeLine)[1]);
  if (modes.length !== 1) {
    report.fail(`${path} must carry exactly one "Mode: ${CONFIG.mode}" line, found ${modes.length}`);
  } else if (modes[0] !== CONFIG.mode) {
    report.fail(`${path} carries "Mode: ${modes[0]}"; a decomposition review is written in "Mode: ${CONFIG.mode}"`);
  }
  const mention = new RegExp(`(?:^|[^a-z0-9-])${slug}(?![a-z0-9-])`);
  if (!reviewLines.some((l) => mention.test(l))) {
    report.fail(`${path} never names ${slug}; a review is evidence about one decomposition`);
  }
  if (recordPath !== null) {
    checkReviewRevision(ref, recordPath, path, reviewLines, report);
  }
}

/* --------------------------------------------------------------- dependencies */

// A cycle among the edges, as a path, or null.
function findCycle(edges) {
  const out = new Map();
  for (const { from, to } of edges) {
    if (!out.has(from)) out.set(from, []);
    out.get(from).push(to);
  }
  const state = new Map();
  const stack = [];
  const visit = (node) => {
    state.set(node, 'open');
    stack.push(node);
    for (const next of out.get(node) || []) {
      if (state.get(next) === 'open') return [...stack.slice(stack.indexOf(next)), next];
      if (!state.has(next)) {
        const found = visit(next);
        if (found) return found;
      }
    }
    stack.pop();
    state.set(node, 'done');
    return null;
  };
  for (const node of out.keys()) {
    if (!state.has(node)) {
      const found = visit(node);
      if (found) return found;
    }
  }
  return null;
}

/* ---------------------------------------------------------------------- main */

function main() {
  const slug = process.argv[2];
  if (!slug || !CONFIG.slugPattern.test(slug)) {
    const invoked = process.argv[1] || 'scripts/check-decomposition.js';
    process.stderr.write(`usage: node ${invoked} <SLUG>   e.g. payments-onboarding (kebab-case, the source document's slug)\n`);
    process.exit(EXIT.USAGE);
  }
  // The stories /from-ticket takes from Jira sit under this one slug, and
  // check-intake.js checks them. A decomposition under it would put two kinds of
  // story in one folder, each read by a different check.
  if (slug === CONFIG.ticketSlug) {
    process.stdout.write(`\n${slug} decomposition check\n\n  [FAIL] slug\n         - "${slug}" is reserved for stories taken from Jira tickets (${CONFIG.backlogDir}/${slug}/, checked by scripts/check-intake.js); a decomposition takes the slug of its source document, so name the record after that document\n\nDECOMPOSITION INCOMPLETE: the slug is reserved. Nothing is created from it.\n\n`);
    process.exit(EXIT.CHECK_FAIL);
  }

  const ref = syncDefaultBranch();
  const tracked = listTree(ref, CONFIG.backlogDir);
  const inBacklog = (e) => e.path.slice(0, e.path.lastIndexOf('/')) === CONFIG.backlogDir;
  const named = (suffix) => tracked.filter((e) => {
    const base = e.path.slice(e.path.lastIndexOf('/') + 1);
    return inBacklog(e) && base.startsWith(`${slug}.`) && base.endsWith(suffix);
  });

  // The list of repositories, read for its ids only, from the trunk blob.
  let registry = null;
  let registryFinding = null;
  const registryText = readFromRef(ref, CONFIG.registryPath);
  if (registryText === null) {
    registryFinding = `no ${CONFIG.registryPath} on ${ref}; a story names a repository from the list, and the list is written by the hub install and filled by /add-repo`;
  } else {
    try {
      const parsed = JSON.parse(stripBom(registryText));
      const repos = parsed && typeof parsed === 'object' && parsed.repositories && typeof parsed.repositories === 'object' && !Array.isArray(parsed.repositories)
        ? Object.keys(parsed.repositories) : null;
      if (repos === null) registryFinding = `${CONFIG.registryPath} on ${ref} has no "repositories" object; run scripts/check-registry.mjs --offline`;
      else if (repos.length === 0) registryFinding = `${CONFIG.registryPath} on ${ref} names no repository, so no story has anywhere to land; /add-repo comes first`;
      else registry = repos;
    } catch (err) {
      registryFinding = `${CONFIG.registryPath} on ${ref} is not JSON: ${String(err.message).split('\n')[0]}`;
    }
  }

  // Check 1 -- the record: one file, readable, shown as written, naming its
  // source, with the four sections the schema fixes.
  const c1 = check('decomposition record');
  const records = named(CONFIG.recordSuffix).filter((e) => !e.path.endsWith(CONFIG.reviewSuffix));
  if (records.length !== 1) {
    c1.fail(`expected exactly one "*${CONFIG.recordSuffix}" for ${slug} on ${ref}, found ${records.length}${records.length ? `: ${records.map((e) => e.path).join(', ')}` : ''}`);
  }
  const recordPath = records.length === 1 ? records[0].path : null;
  const recordText = recordPath ? readArtefact(ref, records[0], c1, 'decomposition record') : null;
  let recordLines = null;
  let sourcePath = null;
  let coverage = null;
  let repoMap = null;
  let itemsTable = null;
  let deps = null;
  if (recordText !== null) {
    recordLines = maskNonContent(recordText);
    rejectHiddenMarkup(recordLines, recordPath, c1);
    rejectMalformedRows(recordLines, recordPath, c1);
    const sources = [];
    recordLines.forEach((line, i) => {
      const cells = splitRow(line);
      if (!cells || cells.length < 2 || cells[0] !== CONFIG.sourceLabel) return;
      // A header row whose first column is named "Source" (a table of the
      // sources the planner ranked, say) names no document. Only a data row does.
      if (i + 1 < recordLines.length && isSeparatorRow(splitRow(recordLines[i + 1]), cells.length)) return;
      sources.push({ no: i + 1, value: unquoted(cells[1]) });
    });
    if (sources.length !== 1) {
      c1.fail(`${recordPath} must carry exactly one "| ${CONFIG.sourceLabel} | <path> |" row naming the requirements document it was cut from, found ${sources.length}`);
    } else if (sources[0].value === '' || isPlaceholder(sources[0].value) || /\s/.test(sources[0].value)) {
      c1.fail(`${recordPath} line ${sources[0].no}: "${CONFIG.sourceLabel} | ${sources[0].value}" is not a path in this repository`);
    } else {
      sourcePath = sources[0].value;
    }
    coverage = readTable(recordLines, CONFIG.coverageSection, CONFIG.coverageFirst, null, CONFIG.requirementPattern, c1);
    repoMap = readTable(recordLines, CONFIG.repositoriesSection, CONFIG.repositoriesFirst, null, CONFIG.repositoryPattern, c1);
    itemsTable = readTable(recordLines, CONFIG.itemsSection, CONFIG.itemsFirst, null, CONFIG.keyPattern, c1);
    deps = readTable(recordLines, CONFIG.dependenciesSection, CONFIG.dependenciesFirst, CONFIG.dependenciesSecond, CONFIG.keyPattern, c1, { tableOptional: true });
  }

  // Check 2 -- the work items: one file per key under the slug's directory,
  // each with one key, one listed repository and criteria that each carry one
  // requirement criterion; and the record's Items table is exactly that set.
  const c2 = check('work items');
  const itemDir = `${CONFIG.backlogDir}/${slug}/`;
  const itemEntries = tracked.filter((e) => e.path.startsWith(itemDir) && e.path.endsWith(CONFIG.itemSuffix) && !e.path.slice(itemDir.length).includes('/'));
  const items = [];
  if (registryFinding) c2.fail(registryFinding);
  if (itemEntries.length === 0) {
    c2.fail(`no "*${CONFIG.itemSuffix}" under ${itemDir} on ${ref}; a decomposition with no work item cut nothing`);
  }
  for (const entry of itemEntries) {
    const key = entry.path.slice(itemDir.length, -CONFIG.itemSuffix.length);
    if (!CONFIG.keyPattern.test(key)) {
      c2.fail(`${entry.path} is not filed under a work-item key; item files are docs/backlog/<SLUG>/<KEY>.item.md with <KEY> matching ${CONFIG.keyPattern}`);
      continue;
    }
    const text = readArtefact(ref, entry, c2, 'work item');
    if (text === null) {
      items.push({ key, path: entry.path, repository: null, criteria: [], unreadable: true });
      continue;
    }
    const lines = maskNonContent(text);
    rejectHiddenMarkup(lines, entry.path, c2);
    rejectMalformedRows(lines, entry.path, c2);
    const item = parseItem(lines, entry.path, key, c2);
    item.lines = lines;
    if (item.repository !== null && registry !== null && !registry.includes(item.repository)) {
      c2.fail(`${entry.path} names repository "${item.repository}", which ${CONFIG.registryPath} does not carry (it lists ${registry.join(', ')}); /add-repo comes first, and an invented id names nothing`);
    }
    items.push(item);
  }
  const itemKeys = items.map((i) => i.key);
  if (itemsTable) {
    const repoCol = column(itemsTable, CONFIG.itemsColumns.repository, CONFIG.itemsSection, c2);
    const listed = [];
    for (const { cells, no } of itemsTable.rows) {
      const key = unquoted(cells[0]);
      if (!CONFIG.keyPattern.test(key)) {
        c2.fail(`${recordPath} line ${no}: "${cells[0]}" in the Items table is not a work-item key`);
        continue;
      }
      if (listed.includes(key)) {
        c2.fail(`${recordPath} line ${no}: ${key} is listed twice in the Items table`);
        continue;
      }
      listed.push(key);
      const item = items.find((i) => i.key === key);
      if (!item) {
        c2.fail(`${recordPath} line ${no}: the Items table lists ${key}, but there is no ${itemDir}${key}${CONFIG.itemSuffix} on ${ref}`);
      } else if (repoCol >= 0 && item.repository !== null && unquoted(cells[repoCol]) !== item.repository) {
        c2.fail(`${recordPath} line ${no}: the Items table says ${key} lands in "${unquoted(cells[repoCol])}" but ${item.path} says "${CONFIG.repositoryLabel}: ${item.repository}"`);
      }
    }
    for (const key of itemKeys) {
      if (!listed.includes(key)) c2.fail(`${itemDir}${key}${CONFIG.itemSuffix} exists on ${ref} but the record's Items table does not list ${key}; every item cut is in the record`);
    }
  }

  // What a newer source explains: a failure, or a note under
  // HARNESS_SOURCE_AHEAD=1 (see the design notes).
  let behindSource = 0;
  const behind = (report) => (msg) => {
    if (!CONFIG.sourceAhead) return report.fail(msg);
    behindSource += 1;
    return report.note(msg);
  };

  // Check 3 -- the source: every requirement in it is claimed by a story or
  // marked out of scope with a reason, and every requirement criterion a story
  // carries is one the source defines.
  const c3 = check('source coverage');
  // The ids on the source's Context: line, for check 8: undefined when there is
  // no readable source, null when it carries no single well-formed line.
  let sourceContext;
  if (sourcePath === null) {
    c3.fail('skipped: the record names no readable source');
  } else {
    const sourceText = readFromRef(ref, sourcePath);
    if (sourceText === null) {
      c3.fail(`${recordPath} names its source as ${sourcePath}, which is not on ${ref}; a decomposition is cut from a document on the trunk`);
    } else {
      const sourceLines = maskNonContent(stripBom(sourceText));
      sourceContext = contextIds(sourceLines);
      const requirements = parseRequirements(sourceLines, prefixed(c3, `${sourcePath}: `));
      const defined = new Set(requirements.flatMap((r) => r.criteria.map((c) => c.id)));
      const retired = new Set(requirements.flatMap((r) => r.criteria.filter((c) => c.deprecated).map((c) => c.id)));
      for (const item of items) {
        for (const c of item.criteria) {
          if (c.carries === null) continue;
          if (!defined.has(c.carries)) {
            c3.fail(`${item.path} line ${c.no}: ${c.id} carries ${c.carries}, which ${sourcePath} does not define`);
          } else if (retired.has(c.carries) && !c.deprecated) {
            behind(c3)(`${item.path} line ${c.no}: ${c.id} carries ${c.carries}, which ${sourcePath} marks DEPRECATED; a retired criterion is not built, so the story's row reads DEPRECATED too, with its number kept`);
          }
        }
      }
      if (coverage) {
        const dispCol = column(coverage, CONFIG.coverageColumns.disposition, CONFIG.coverageSection, c3);
        const itemsCol = column(coverage, CONFIG.coverageColumns.items, CONFIG.coverageSection, c3);
        const reasonCol = column(coverage, CONFIG.coverageColumns.reason, CONFIG.coverageSection, c3);
        const rows = coverage.rows.map(({ cells, no }) => ({
          no,
          mentions: [...cells[0].matchAll(CONFIG.requirementMention)].map((m) => m[0]),
          disposition: dispCol >= 0 ? cells[dispCol] : null,
          items: itemsCol >= 0 ? [...cells[itemsCol].matchAll(CONFIG.keyMention)].map((m) => m[0]) : [],
          reason: reasonCol >= 0 ? cells[reasonCol] : null,
        }));
        for (const row of rows) {
          if (row.disposition === null) continue;
          if (!CONFIG.dispositions.includes(row.disposition)) {
            c3.fail(`${recordPath} line ${row.no}: disposition "${row.disposition}" is not one of ${CONFIG.dispositions.join(' / ')}; a requirement is cut, excluded with a reason, or marked unresolved in the pinned grammar`);
            continue;
          }
          if (row.disposition === 'Covered') {
            const claimed = row.items.filter((k) => itemKeys.includes(k));
            if (claimed.length === 0) {
              c3.fail(`${recordPath} line ${row.no} is marked Covered but its Items cell names no item of this decomposition${row.items.length ? ` (it names ${row.items.join(', ')})` : ''}`);
            }
          } else if (row.disposition === 'Unresolved') {
            if (row.reason !== null && !CONFIG.unresolvedMarker.test(row.reason)) {
              c3.fail(`${recordPath} line ${row.no} is marked Unresolved, so its reason cell reads "UNRESOLVED — <what>. Owner: <role>. Resolves: <trigger>." and nothing else; found "${row.reason}"`);
            }
          } else if (row.reason !== null && (row.reason.trim() === '' || isPlaceholder(row.reason))) {
            c3.fail(`${recordPath} line ${row.no} is marked Out of scope with ${row.reason.trim() === '' ? 'nothing' : `"${row.reason}"`} for a reason; an exclusion names its reason and the role who owns it`);
          }
        }
        const carried = new Set(items.flatMap((i) => i.criteria.filter((c) => c.carries !== null && !c.deprecated).map((c) => c.carries.split('.')[0])));
        for (const requirement of requirements) {
          const mine = rows.filter((r) => r.mentions.includes(requirement.id));
          if (mine.length === 0) {
            behind(c3)(`${sourcePath} defines ${requirement.id} and ${recordPath} does not map it: every requirement in the source has a row in the "${CONFIG.coverageSection}" table, cut into items or excluded with a reason`);
            continue;
          }
          if (mine.some((r) => r.disposition === 'Covered')) {
            if (!carried.has(requirement.id)) {
              c3.fail(`${recordPath} marks ${requirement.id} Covered, but no item criterion carries a ${requirement.id}.AC-<m>; a requirement is claimed by a story through the criteria the story carries`);
            }
            continue;
          }
          // Held or excluded: no story carries it. A requirement the business has
          // not settled, built anyway, is exactly the work the disposition exists
          // to stop.
          const held = mine.map((r) => r.disposition).filter(Boolean)[0] || 'not Covered';
          for (const item of items) {
            for (const c of item.criteria) {
              if (c.carries !== null && !c.deprecated && c.carries.startsWith(`${requirement.id}.`)) {
                c3.fail(`${item.path} line ${c.no}: ${c.id} carries ${c.carries}, but ${recordPath} holds ${requirement.id} ${held}; a held or excluded requirement gets no story and no key`);
              }
            }
          }
        }
      }
    }
  }

  // Check 4 -- the keys: every item key is from the one block the ledger
  // records for this slug, the block is exactly those keys, and the counter
  // has moved past it.
  const c4 = check('key block');
  const keysText = readFromRef(ref, CONFIG.keysPath);
  let keys = null;
  if (keysText === null) {
    c4.fail(`no ${CONFIG.keysPath} on ${ref}; the hub install writes it with the client's prefix, and /decompose mints from it`);
  } else {
    keys = parseKeys(keysText, c4);
  }
  if (keys !== null) {
    // One block per run that minted keys under this slug: the first cut, and a
    // re-cut after a clarification closes. Together they are exactly the items.
    const mine = keys.blocks.filter((b) => b.taken_by === 'decomposition' && b.slug === slug);
    if (mine.length === 0) {
      c4.fail(`${CONFIG.keysPath} records no block taken by the decomposition of ${slug}; /decompose takes a block per run and records it as { "from", "to", "taken_by": "decomposition", "slug": "${slug}" }`);
    } else {
      const ranges = mine.map((b) => `${keys.prefix}-${b.from} to ${keys.prefix}-${b.to}`).join(', ');
      const blockWord = mine.length === 1 ? 'block' : 'blocks';
      const numbers = new Map();
      for (const key of itemKeys) {
        const [prefix, number] = key.split('-');
        if (prefix !== keys.prefix) {
          c4.fail(`${itemDir}${key}${CONFIG.itemSuffix}: the key's prefix "${prefix}" is not the ledger's "${keys.prefix}"; every key in this hub is minted from ${CONFIG.keysPath}`);
          continue;
        }
        const n = Number(number);
        if (String(n) !== number) {
          c4.fail(`${itemDir}${key}${CONFIG.itemSuffix}: "${number}" has a leading zero; the ledger numbers this key ${keys.prefix}-${n}, and two spellings of one number are two items wearing one key`);
          continue;
        }
        if (!mine.some((b) => n >= b.from && n <= b.to)) {
          c4.fail(`${itemDir}${key}${CONFIG.itemSuffix}: ${n} is outside the ${blockWord} ${ranges} the ledger records for ${slug}`);
          continue;
        }
        numbers.set(n, key);
      }
      for (const block of mine) {
        for (let n = block.from; n <= block.to; n += 1) {
          if (!numbers.has(n)) {
            c4.fail(`${CONFIG.keysPath} gives ${slug} the block ${keys.prefix}-${block.from} to ${keys.prefix}-${block.to}, but no item file carries ${keys.prefix}-${n}; a block is exactly the keys minted, so a spare number is a key nobody can account for`);
          }
        }
      }
    }
  }

  // Check 5 -- the dependency map: every edge from an item of this
  // decomposition to a work-item key, and no cycle.
  const c5 = check('dependency map');
  if (deps === null) {
    c5.fail('skipped: no readable dependency map');
  } else {
    const edges = [];
    for (const { cells, no } of deps.rows) {
      const from = unquoted(cells[0]);
      const to = unquoted(cells[1]);
      if (!itemKeys.includes(from)) {
        c5.fail(`${recordPath} line ${no}: "${from}" in the From column is not an item of this decomposition; the map declares what these items depend on`);
        continue;
      }
      if (!CONFIG.keyPattern.test(to)) {
        c5.fail(`${recordPath} line ${no}: "${to}" in the To column is not a work-item key`);
        continue;
      }
      if (from === to) {
        c5.fail(`${recordPath} line ${no}: ${from} depends on itself`);
        continue;
      }
      edges.push({ from, to, no });
    }
    const cycle = findCycle(edges);
    if (cycle) {
      c5.fail(`the dependency map has a cycle: ${cycle.join(' → ')}; a cycle is a boundary drawn through the middle of one behaviour, so re-cut the items rather than record the loop`);
    }
  }

  // Check 6 -- the repository map: one row per repository in the list, no row
  // for a repository the list does not carry, and every row read at a pinned
  // commit. A row without one rests on the list's purpose, which orders the
  // reading and is never evidence: a stale purpose could hide a repository
  // from a planner who trusted it, and this is the check that makes that
  // impossible rather than merely forbidden.
  const c6 = check('repository map');
  if (repoMap === null || registry === null) {
    c6.fail(`skipped: ${repoMap === null ? 'no readable repository map' : 'no readable list of repositories'}`);
  } else {
    const readAtCol = column(repoMap, CONFIG.repositoriesColumns.readAt, CONFIG.repositoriesSection, c6);
    const seen = [];
    for (const { cells, no } of repoMap.rows) {
      const id = unquoted(cells[0]);
      if (!registry.includes(id)) {
        c6.fail(`${recordPath} line ${no}: the repository map names "${id}", which ${CONFIG.registryPath} does not carry`);
        continue;
      }
      if (seen.includes(id)) c6.fail(`${recordPath} line ${no}: "${id}" has two rows in the repository map; one row per repository`);
      seen.push(id);
      if (readAtCol >= 0) {
        const readAt = unquoted(cells[readAtCol] || '');
        if (!CONFIG.readAtPattern.test(readAt)) {
          c6.fail(`${recordPath} line ${no}: "${id}" has "${readAt}" in the "${CONFIG.repositoriesColumns.readAt}" column, which is not a twelve-character commit; a row rests on the tree read at a pinned commit through scripts/read-spoke.mjs, never on the list's purpose`);
        }
      }
    }
    for (const id of registry) {
      if (!seen.includes(id)) c6.fail(`${CONFIG.registryPath} lists "${id}" and the repository map has no row for it; a repository with no row was never considered, and nobody can tell that from one that was`);
    }
  }

  // Check 7 -- no placeholder cell in any table of the record or an item.
  const c7 = check('placeholder cells');
  if (recordLines === null) c7.fail('skipped: no readable decomposition record');
  else rejectPlaceholders(recordLines, recordPath, c7);
  for (const item of items) {
    if (item.lines) rejectPlaceholders(item.lines, item.path, c7);
  }

  // Check 8 -- the context documents: each story carries one Context: line
  // whose documents are on the trunk and used on the page, and every document
  // the source's Context: line names reaches at least one story.
  const c8 = check('context documents');
  const carried = new Set();
  let everyLineRead = true;
  // The hub's link to the global repository, read once and only for a story
  // that carries a global entry, and the release this slug's requirements
  // document records: what a story's global entries are proved against.
  let link;
  const global = {
    source: requirementsSource(ref, slug),
    get link() {
      if (link === undefined) link = readGlobalLink(ref, c8);
      return link;
    },
  };
  for (const item of items) {
    if (!item.lines) {
      everyLineRead = false;
      continue;
    }
    const ids = checkItemContext(ref, item, c8, global);
    if (ids === null) everyLineRead = false;
    else ids.forEach((id) => carried.add(id));
  }
  if (sourceContext === undefined) {
    c8.fail('skipped the carry from the source: the record names no readable source');
  } else if (sourceContext === null) {
    c8.fail(`${sourcePath} carries no single well-formed "${CONFIG.contextLabel}:" line, so nothing can say which of its documents reach a story; run scripts/check-requirements.js ${slug}`);
  } else if (everyLineRead) {
    for (const id of sourceContext.filter((x) => !carried.has(x))) {
      behind(c8)(`${sourcePath} was written against "${id}", and no story's "${CONFIG.contextLabel}:" line carries it; a document that shaped a requirement binds at least one story, so select it for each story it bears on`);
    }
  }

  // Check 9 -- the review: one file, the approved verdict matched literally,
  // the mode this artefact is reviewed in, the slug named, and the revision it
  // approved the revision of the record on the trunk now.
  const c9 = check('decomposition review');
  const reviews = named(CONFIG.reviewSuffix);
  if (reviews.length !== 1) {
    c9.fail(`expected exactly one "*${CONFIG.reviewSuffix}" for ${slug} on ${ref}, found ${reviews.length}${reviews.length ? `: ${reviews.map((e) => e.path).join(', ')}` : ''}`);
  } else {
    const reviewText = readArtefact(ref, reviews[0], c9, 'decomposition review');
    if (reviewText !== null) {
      checkReview(ref, reviews[0], maskNonContent(reviewText), recordPath, slug, c9);
    }
  }

  // Report -- every check, every finding, then exit.
  const failed = checks.filter((c) => c.failures.length > 0);
  const width = Math.max(...checks.map((c) => c.name.length));
  process.stdout.write(`\n${slug} decomposition check  (against ${ref}, ${CONFIG.remote} -> ${remoteUrl()})\n\n`);
  for (const c of checks) {
    const status = c.failures.length ? 'FAIL' : 'PASS';
    process.stdout.write(`  [${status}] ${c.name.padEnd(width)}`.trimEnd() + '\n');
    for (const f of c.failures) process.stdout.write(`         - ${f}\n`);
    for (const n of c.notes) process.stdout.write(`         note: ${n}\n`);
  }
  if (!failed.length) {
    process.stdout.write(`\n  ${items.length} item(s): ${items.map((i) => `${i.key} (${i.repository})`).join(', ')}\n`);
  }
  process.stdout.write(
    failed.length
      ? `\nDECOMPOSITION INCOMPLETE: ${failed.length} of ${checks.length} checks failed. Nothing is created from it.\n\n`
      : behindSource
        ? `\nDECOMPOSITION BEHIND ITS SOURCE: ${checks.length} of ${checks.length} checks passed, and ${behindSource} note(s) say what the record does not carry yet. Merge the source, then run /decompose on ${slug}.\n\n`
        : `\nDECOMPOSITION COMPLETE: ${checks.length} of ${checks.length} checks passed.\n\n`
  );
  process.exit(failed.length ? EXIT.CHECK_FAIL : EXIT.PASS);
}

// The last line of an exit 2, 3 or 4 names this script and its code, so a shell line that hides
// the code, with a pipe or `; echo`, still tells the harness's failure record. Written at once,
// so a process.exit() never loses it.
process.on('exit', (code) => { if (code >= 2 && code <= 4) { try { writeSync(2, `HARNESS EXIT: check-decomposition ${code}\n`); } catch { /* stderr is closed */ } } });

try {
  main();
} catch (err) {
  process.stderr.write(`INTERNAL ERROR: ${err && err.stack ? err.stack : String(err)}\n`);
  process.exit(EXIT.INTERNAL);
}

#!/usr/bin/env node
/**
 * check-requirements.js — the requirements-document check.
 *
 * `/feature` writes one requirements document per slug, in a folder of its
 * own: docs/requirements/<SLUG>/requirements.md, beside it the critic's final
 * review, requirements-review.md, and below it the run folders
 * (runs/<yyyymmdd_hhmm>/) holding the interview record and every copied brief. It
 * opens a pull request in the hub with all of them. This file is what runs on that pull request, and again on the
 * trunk after the merge. It reads the document and its review on the trunk and
 * says whether the document is complete: every requirement has a stable
 * REQ-<n> identifier, every criterion under it a stable REQ-<n>.AC-<m>
 * identifier, at least one criterion per requirement, no placeholder cell
 * anywhere and no fill-in token left on the page, one `Context:` line whose documents are on the trunk and used on
 * the page, one `Hub commit:` line naming the trunk commit that holds every hub
 * entry's bytes, a `Global:` line that names a release of the global context
 * repository when the hub links one, and exactly one review that approves the
 * document's bytes as they are on the trunk now.
 *
 *   usage:  node scripts/check-requirements.js payments-onboarding
 *
 * Exit codes
 *   0  the document is complete       -> /decompose may cut it after the merge
 *   1  at least one check failed      -> not complete; all findings printed
 *   2  cannot verify                  -> refused to judge (stale or unreachable remote)
 *   3  usage error                    -> bad or missing slug
 *   4  internal error                 -> unexpected; treat as not complete
 *
 * Design notes
 *   - Same trunk discipline as check-dev-ready.js. Reads the DEFAULT BRANCH,
 *     never the working tree, confirms the branch name against the remote's own
 *     default branch, and force-fetches first. Run on a pull request through
 *     the candidate-trunk construction the CI workflows use; never through a
 *     branch flag, because there is none.
 *   - The document's FORMAT is the adopting organisation's own, so this file
 *     reads structure, not sections: a heading that begins `REQ-<n>`, at any
 *     level, and beneath it one table whose first two columns are `ID` and
 *     `Criterion`. Everything else on the page is the organisation's to shape.
 *     One row in the document is read by name where it exists: a `| Slug | … |`
 *     table row, which has to name the slug the file is filed under. The cell
 *     is read literally -- the slug, optionally in backticks, and nothing else:
 *     a citation or a note appended to it is a different value, and the
 *     failure message says what the cell had to be. A document with no such
 *     row is not failed for it.
 *   - Reads the trunk only, so on a branch it reports the trunk's document and
 *     says nothing about the branch. check-requirements-candidate.mjs, beside
 *     this file, builds the candidate trunk CI builds -- a bare repository with
 *     HEAD pushed to it as the trunk -- and runs this file inside a clone of it.
 *     That is the one approved way to run this check on a branch.
 *   - The `Context:` line names the hub documents the writer was handed --
 *     decision records, standards, earlier requirements documents -- in the
 *     grammar the gate reads on a design, each entry pinned to the blob hash of
 *     the bytes read. Each entry is proved on the trunk the way the gate proves
 *     a design's: the commit on the document's one `Hub commit:` line is on the
 *     trunk and holds the entry's bytes at its path, or the two lines were not
 *     copied from one run, a failure; bytes that moved on the trunk since are a
 *     drift note. A line alone does not show that a document was read, so
 *     each entry must also be used on the page: its id named outside the line,
 *     and a standard cited by at least one rule id it defines, `std-<topic>.<NN>`.
 *     An always-on document in force is the exception: read-context.mjs adds
 *     it to every line, whatever ids it is given, so the page owes it no use.
 *     The bytes the entry pins say whether it is always on. The reverse holds too: a decision record or a standard's rule cited on
 *     the page is on the line. The line may also cite a document of the global
 *     context repository, `<id>@<12-hex>:global:<path>` (§8 of the proposal),
 *     pinned to the commit on this document's own `Global:` line. Such an entry
 *     is proved as check-dev-ready.js proves a design's: the path is at that
 *     commit with a header that names the id, a cited global rule is one the
 *     standard defines, and an exception is Active, names this hub by its key
 *     prefix and sits beside every record it departs from.
 *   - The `Global:` line names the release of the global context repository the
 *     document was written against (docs/proposals/global-context.md §6). The
 *     hub links that repository with docs/estate/global.json on the trunk. Without
 *     the file the line is `Global: none` or absent, and an absent line counts as
 *     `none`. With it the line is `Global: vX.Y.Z <40-hex>`, and the check asks
 *     the global repository three things: the tag is a release tag, the tag
 *     still points at the recorded commit, and the commit is on the global
 *     trunk. A moved or deleted tag fails, because the commit binds and the tag
 *     is a label. A global repository that does not answer is exit 2. The read
 *     uses a bare cache outside the hub (HARNESS_SPOKE_CACHE, or the system
 *     temporary directory), and the credential the hub's CI gives git for its
 *     spokes.
 *   - The review binds to the document by the hash of its bytes, exactly as a
 *     design review binds to a design: `Document revision: <git hash-object>`.
 *     One changed byte after the review and the review no longer applies. This
 *     is the same check the pickup gate makes, with the label the review-file
 *     template gives this artefact type.
 *   - The document is read as a reader reads it: fenced and indented code,
 *     comments, raw-text HTML and link reference definitions are blanked
 *     before parsing, and markup that hides content is refused outright. The
 *     masking and table functions are copied from the gate and kept the same
 *     on purpose: one file per check, installed verbatim, no shared module.
 *   - Runs EVERY check before exiting. No short-circuit.
 *   - Node standard library only, plus git via child_process.
 *   - ES module. Save as check-requirements.mjs where package.json is not
 *     { "type": "module" }.
 *   - Non-`main` trunk: set HARNESS_TRUNK=<branch>, as for the gate.
 *
 * What this check cannot see
 *   - Whether a requirement is right, or wanted. A fluent, well-cited set of
 *     requirements describing the wrong outcome passes. The critic's reading
 *     and the human merge are the controls on that; this file proves the
 *     paperwork cannot be skipped.
 *   - Whether a citation resolves. The check reads one document; the critic
 *     samples the citations against the source.
 *   - Whether the `Context:` line lists every document that bears on the
 *     requirements, or whether a cited rule is applied correctly. The check
 *     proves that each listed document is used, and that each cited decision
 *     record and standard is listed. Whether one was missed is the critic's
 *     finding.
 *   - Whether the `Global:` line names the newest release. The newest release
 *     when /feature ran is what read-global.mjs prints, and a later release does
 *     not unapprove a merged document. Nor does the check compare the line with
 *     an earlier revision of the document: check-requirements-amend.mjs refuses
 *     a move to an equal or older release when an amendment starts.
 *   - Whether the review is independent. The verdict is a token; who wrote the
 *     file is git configuration.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const EXIT = { PASS: 0, CHECK_FAIL: 1, CANNOT_VERIFY: 2, USAGE: 3, INTERNAL: 4 };

const CONFIG = {
  remote: 'origin',
  branch: process.env.HARNESS_TRUNK || 'main',
  // requirementsDir, documentFile, reviewFile and slugPattern are copied in
  // check-requirements-amend.mjs. Change one here, change it there in the same
  // commit (generation.md row 88b).
  requirementsDir: 'docs/requirements',
  // The document and its review, directly in docs/requirements/<SLUG>/. The run
  // folders below runs/ are /feature's inputs, never a document.
  documentFile: 'requirements.md',
  reviewFile: 'requirements-review.md',
  // The slug /feature mints: kebab-case, and the folder both files are filed under.
  slugPattern: /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
  // A requirement is a heading, at any level, whose first word begins REQ-. The
  // loose form finds the heading -- and finds REQ-3a and REQ-4. too, so a
  // malformed identifier is a finding and not a requirement quietly dropped; the
  // strict form is the grammar the identifier has to meet. No leading zeros:
  // REQ-01 and REQ-1 are two names for one thing, and downstream artefacts cite
  // one of them.
  requirementHeading: /^ {0,3}(#{1,6})\s+(REQ-\S*)/,
  requirementPattern: /^REQ-[1-9]\d*$/,
  criterionPattern: /^REQ-[1-9]\d*\.AC-[1-9]\d*$/,
  criterionLoose: /^REQ-\d+\.AC-\d+$/i,
  deprecated: /^DEPRECATED\b/,
  slugLabel: 'Slug',
  // The review's machine surface, shared with the gate: one verdict line,
  // matched literally; the mode this artefact type is reviewed in; and the
  // revision line the review-file template gives a requirements review.
  approvedVerdict: '### VERDICT: APPROVED',
  verdictLine: /^###\s+VERDICT:\s*(.+?)\s*$/,
  modeLine: /^Mode:[ \t]*(\S.*?)\s*$/,
  mode: 'feature-review',
  revisionLabel: 'Document revision',
  revisionLine: /^Document revision:[ \t]*([0-9a-fA-F]{7,40})\s*$/,
  // The one literal that is not a placeholder: NONE standing alone, where a
  // schema calls for it (a clarification table with no rows). Everything else
  // in this list is an empty cell wearing a value.
  literalNone: 'NONE',
  placeholderToken: /^(?:[-–—]+|\?+|tbd|todo|n\/?a|na|none|nil|pending|placeholder|seebelow|x+)$/i,
  // A fill-in token the template writes as `\<like this>`: the backslash keeps it
  // visible in a markdown viewer, and it also keeps the cell from starting with
  // `<`, so the placeholder rule above never sees it. Left anywhere on the page,
  // outside a code span, it is a template nobody finished -- a whole cell or a
  // part of one, as in `r\<n>`.
  fillInToken: /\\<[^<>\n]*>/g,
  // The line that says which context documents the document was written
  // against, in the grammar the gate reads on a design: the literal `none`, or
  // one entry per document joined by ", ", as `scripts/read-context.mjs --hub`
  // prints it. A requirements document names no repository, so every entry is
  // a hub entry, `<id>@<12-hex>:<path>`, or a global one,
  // `<id>@<12-hex>:global:<path>`. contextEntry is the gate's, which also
  // matches a repository entry so that this file can name it and refuse it.
  // check-dev-ready.js and `scripts/context-docs.mjs` carry the same grammar;
  // the three are kept in step by hand.
  contextLabel: 'Context',
  contextLine: /^Context:[ \t]*(\S.*?)\s*$/,
  contextNone: 'none',
  contextSeparator: ', ',
  contextEntry: /^([a-z0-9][a-z0-9-]*|(?:[A-Za-z0-9][A-Za-z0-9._-]*\.)?ADR-\d{3,}|global\.(?:std-[a-z0-9]+(?:-[a-z0-9]+)*|EXC-\d{3,}))@([0-9a-f]{12}):(?:([A-Za-z0-9][A-Za-z0-9._-]*):)?((?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[^\s,:]+)$/,
  // The line beside Context: that names the hub commit the documents were read
  // at: `Hub commit: <40-hex>`, as scripts/read-context.mjs prints it. The
  // commit must be on the trunk and hold every hub entry's bytes. The same
  // label is read by check-decomposition.js, check-dev-ready.js and
  // `scripts/context-docs.mjs` (HUB_COMMIT_LABEL); the copies are kept in step
  // by hand.
  hubCommitLabel: 'Hub commit',
  hubCommitLine: /^Hub commit:[ \t]*(\S.*?)\s*$/,
  hubCommit: /^[0-9a-f]{40}$/,
  // A standard's id is `std-<topic>`, and each rule in it `<id>.<NN>`, opened in
  // the standard as `- **<id>.<NN>** MUST ...` (`scripts/context-docs.mjs`,
  // STD_RULE). The document cites a standard by the rules it applies. A dot
  // before a rule id joins it to the global layer: `global.std-go.03` is never
  // a rule of a hub standard.
  standardId: /^std-[a-z0-9]+(?:-[a-z0-9]+)*$/,
  standardRuleCite: /(?<![A-Za-z0-9.-])std-[a-z0-9]+(?:-[a-z0-9]+)*\.\d{2,}(?![0-9])/g,
  standardRuleDefined: /^-\s+\*\*(std-[a-z0-9]+(?:-[a-z0-9]+)*\.\d{2,})\*\*/,
  // A decision record named anywhere on the page is a document the writer read,
  // so it is on the line with its pin.
  // A hyphen after the number makes the id part of a file name, as in
  // docs/architecture/ADR-010-<slug>.md, which names no record. read-context.mjs
  // selects by the same end (designNames), and so does check-dev-ready.js.
  decisionRecordCite: /(?<![A-Za-z0-9.-])(?:[A-Za-z0-9][A-Za-z0-9._-]*\.)?ADR-\d{3,}(?![A-Za-z0-9_-])/g,
  // The release of the global context repository the document was written
  // against: `Global: vX.Y.Z <40-hex>`, the last line `scripts/read-global.mjs
  // --resolve` prints, or `Global: none`. A hub has a global layer when its
  // trunk carries globalPath, which holds the URL only. Without one, the line is
  // `none` or absent, and an absent line counts as `none`, so a hub without a
  // global layer sees no change. The commit binds and the tag is a label.
  // globalPath and globalCommit are copies of GLOBAL_PATH and COMMIT in
  // `scripts/spoke-remote.mjs`, releaseTag of RELEASE_TAG in
  // `scripts/read-global.mjs`, and globalCacheId of GLOBAL_ID, the name of the
  // bare cache beside the spokes'. globalLabel, globalLine, globalNone,
  // globalValue and releaseTag are copied in check-requirements-amend.mjs. The
  // copies are kept in step by hand (generation.md §3.2).
  globalLabel: 'Global',
  globalLine: /^Global:[ \t]*(\S.*?)\s*$/,
  globalNone: 'none',
  globalValue: /^(\S+) (\S+)$/,
  releaseTag: /^v(\d+)\.(\d+)\.(\d+)$/,
  globalCommit: /^[0-9a-f]{40}$/,
  globalPath: 'docs/estate/global.json',
  globalCacheId: 'global',
  // The global entry on the Context: line (docs/proposals/global-context.md
  // §8): `<id>@<12-hex>:global:<path>`, its id `global.<id>`, its pin the
  // commit this document's own Global: line records. The same names as in
  // check-dev-ready.js, kept in step by hand (generation.md §3.2).
  globalPlace: 'global',
  globalPrefix: 'global.',
  globalStandardId: /^global\.std-[a-z0-9]+(?:-[a-z0-9]+)*$/,
  globalExceptionId: /^global\.EXC-\d{3,}$/,
  globalRuleCite: /(?<![A-Za-z0-9.-])global\.std-[a-z0-9]+(?:-[a-z0-9]+)*\.\d{2,}(?![0-9])/g,
  globalExceptionCite: /(?<![A-Za-z0-9.-])global\.EXC-\d{3,}(?![0-9])/g,
  departsRule: /^std-[a-z0-9]+(?:-[a-z0-9]+)*\.\d{2,}$/,
  exceptionActive: 'Active',
  reviewByDate: /^\d{4}-\d{2}-\d{2}$/,
  keysPath: 'docs/backlog/keys.json',
  registryPath: 'docs/estate/repositories.json',
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

// The document's one `Hub commit:` line: the trunk commit scripts/read-context.mjs
// read the hub's documents at, copied beside the Context: line. Exactly one line,
// a full commit hash, and a commit on the trunk, or the hub entries cannot be
// placed in the hub's history. Returns the commit, or null after a failure. A
// clone too shallow to see the commit is exit 2, never a guess.
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
    report.fail(`${path} carries ${claims.length} "${label}:" lines (${claims.map((c) => `"${c.value}" on line ${c.no}`).join(', ')}); a document reads the hub at one commit`);
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
    report.fail(`${at} names a commit ${ref} does not hold; the document was written against a hub nobody merged, so re-run ${hint} on an up-to-date trunk and copy the ${label}: and ${CONFIG.contextLabel}: lines it prints`);
    return null;
  }
  if (!onRef(value, ref)) {
    report.fail(`${at} names a commit that is not on ${ref}; the document was written against a hub nobody merged, so re-run ${hint} on an up-to-date trunk and copy the ${label}: and ${CONFIG.contextLabel}: lines it prints`);
    return null;
  }
  return value;
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
  // A byte-order mark is not content, and left in place it sits in front of the
  // first line where every anchored pattern below would read it as a character.
  return text.replace(/^\uFEFF/, '');
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

const HEADING = /^ {0,3}#{1,6}\s/;
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

/* -------------------------------------------------------------- the document */

// Every requirement heading, with the range of lines it governs: from the
// heading to the line before the next heading of the same or a higher level.
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

// The requirements and their criteria. Returns one entry per requirement --
// its id and the criterion ids under it -- and records every finding about the
// identifiers on the way. As in the gate, a row with a bad cell is recorded AND
// kept where it can be, so one defect is reported once and not again as a
// false "no criteria" one check later.
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

// Every table in the document, read the way a renderer reads it, and every data
// cell in it. A placeholder is an empty cell wearing a value, and there is no
// table in a requirements document where one is legitimate.
function rejectPlaceholders(lines, path, report) {
  for (const block of tableBlocks(lines, [-1, lines.length - 1])) {
    const header = splitRow(block.rows[0].line);
    for (const entry of block.rows.slice(1)) {
      const cells = splitRow(entry.line);
      if (!cells || (header && isSeparatorRow(cells, header.length))) continue;
      cells.forEach((cell, i) => {
        if (isPlaceholder(cell)) {
          const column = header && header[i] ? `the "${header[i]}" column` : `column ${i + 1}`;
          report.fail(`${path} line ${entry.no} has "${cell}" in ${column}; a placeholder cell is an unknown nobody marked -- write UNRESOLVED — <what>. Owner: <role>. Resolves: <trigger>.`);
        }
      });
    }
  }
}

// Every line of the page as a reader sees it -- comments are already blanked --
// for a fill-in token the template left. A token inside a code span is quoted,
// not left, so it is not read.
function rejectFillInTokens(lines, path, report) {
  lines.forEach((line, i) => {
    const tokens = withoutCodeSpans(line).match(CONFIG.fillInToken);
    if (tokens) {
      const named = tokens.map((t) => `"${t}"`).join(', ');
      report.fail(`${path} line ${i + 1} carries ${named}, the template's fill-in ${tokens.length === 1 ? 'token' : 'tokens'}, left in place; replace the whole token, backslash included, with the value, or write UNRESOLVED — <what>. Owner: <role>. Resolves: <trigger>.`);
    }
  });
}

// The `| Slug | <slug> |` row of the document's control table, where the format
// has one. A document filed under one slug that says it is another is two
// documents wearing one name. Absent, the comparison is skipped: the format is
// the organisation's, and the filename already carries the slug.
//
// The cell is compared whole, on purpose. Backticks around the slug are the
// template's and are removed; anything else in the cell -- a citation, a note, a
// second value -- makes it a different value, and the message names the exact
// cell expected rather than leaving the writer to guess what tripped it. This is
// the same rule as a verdict token: read literally, never normalised.
function checkSlugRow(lines, path, slug, report) {
  const rows = [];
  lines.forEach((line, i) => {
    const cells = splitRow(line);
    if (cells && cells.length >= 2 && cells[0] === CONFIG.slugLabel) rows.push({ no: i + 1, cell: cells[1], value: cells[1].replace(/^`|`$/g, '') });
  });
  for (const row of rows) {
    if (row.value !== slug) {
      report.fail(`${path} line ${row.no} has "${row.cell}" in the ${CONFIG.slugLabel} cell; expected "| ${CONFIG.slugLabel} | \`${slug}\` |" and nothing else in the cell -- the document is filed under "${slug}", /decompose reuses it, and a citation or note for this row belongs on the line under the table, not in a cell the check reads literally`);
    }
  }
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

// The context documents the document was written against. /feature selects them
// with scripts/read-context.mjs --hub, hands their text to the writer, and copies
// the line the script prints. Exactly one line: the literal `none`, or one hub
// entry per document. Each entry must show that the writer used it, where a
// reader sees it: its id named in the document, and a standard cited by at least
// one of its rules, a rule the standard defines. The reverse holds too: a
// decision record or a rule of a standard that the page names is on the line,
// because the writer read it, and the line pins the bytes that were read.
function checkContext(ref, lines, path, report, hubCommit) {
  const claims = [];
  lines.forEach((line, i) => {
    const m = line.match(CONFIG.contextLine);
    if (m) claims.push({ no: i + 1, value: m[1] });
  });
  const expected = `"${CONFIG.contextLabel}: ${CONFIG.contextNone}" or "${CONFIG.contextLabel}: <id>@<12-hex>:<path>${CONFIG.contextSeparator}<id>@<12-hex>:<path>"`;
  if (claims.length === 0) {
    report.fail(`${path} never says which context documents it was written against: expected exactly one ${expected} line, as scripts/read-context.mjs --hub prints it`);
    return;
  }
  if (claims.length > 1) {
    report.fail(`${path} carries ${claims.length} "${CONFIG.contextLabel}:" lines (${claims.map((c) => `"${c.value}" on line ${c.no}`).join(', ')}); a document is written against one set of context documents`);
    return;
  }
  const { value, no } = claims[0];
  const at = `${path} line ${no}: "${CONFIG.contextLabel}: ${value}"`;
  let entries = [];
  if (value !== CONFIG.contextNone) {
    const items = value.split(CONFIG.contextSeparator);
    const parsed = items.map((item) => {
      const m = item.match(CONFIG.contextEntry);
      return m ? { item, id: m[1], pin: m[2], repository: m[3] || null, path: m[4] } : null;
    });
    const bad = items.filter((item, i) => parsed[i] === null);
    const ids = parsed.filter(Boolean).map((e) => e.id);
    const repeated = ids.filter((id, i) => ids.indexOf(id) !== i);
    if (items.includes(CONFIG.contextNone)) {
      report.fail(`${at} lists "${CONFIG.contextNone}" beside document ids; "${CONFIG.contextNone}" stands alone, and means no document binds`);
      return;
    }
    if (isPlaceholder(value) || bad.length) {
      report.fail(`${at} is neither ${expected}${bad.length && !isPlaceholder(value) ? `: ${bad.map((b) => JSON.stringify(b)).join(', ')} ${bad.length === 1 ? 'is not a context entry' : 'are not context entries'}` : ''}; copy the line scripts/read-context.mjs --hub prints`);
      return;
    }
    if (repeated.length) {
      report.fail(`${at} names ${[...new Set(repeated)].map((r) => `"${r}"`).join(', ')} more than once; copy the line scripts/read-context.mjs --hub prints`);
      return;
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
    // Rule 1 of the global layer: a global id only in the global form, and the
    // global form only around a global id.
    const globalId = e.id.startsWith(CONFIG.globalPrefix);
    if (globalId && e.repository !== CONFIG.globalPlace) {
      report.fail(`${at}: "${e.item}" is a global document and the entry places it ${e.repository === null ? 'in the hub' : `in "${e.repository}"`}. A global entry is <id>@<12-hex>:${CONFIG.globalPlace}:<path>, so copy the line scripts/read-context.mjs --hub --global prints`);
      continue;
    }
    if (!globalId && e.repository === CONFIG.globalPlace) {
      report.fail(`${at}: "${e.item}" places ${e.id} in the global layer, and a global document's id starts with "${CONFIG.globalPrefix}". Copy the line scripts/read-context.mjs --hub prints`);
      continue;
    }
    if (globalId) {
      globalEntries.push(e);
      continue;
    }
    if (e.repository !== null) {
      report.fail(`${at}: "${e.item}" is kept in "${e.repository}"; a requirements document names no repository, so it reads the hub's documents and the global layer's alone -- copy the line scripts/read-context.mjs --hub prints`);
      continue;
    }
    let text = null;
    let pinned = null;
    const found = treeEntry(ref, e.path);
    if (found === null) {
      report.fail(`${at}: "${e.id}" cites ${e.path}, which is not on ${ref}; a document is written against documents a person merged, so merge the document first or copy the line scripts/read-context.mjs --hub prints`);
    } else if (found.mode === '120000' || found.type !== 'blob') {
      report.fail(`${at}: "${e.id}" cites ${e.path}, which is ${found.mode === '120000' ? 'a symbolic link' : `a ${found.type}`} on ${ref}, not a document`);
    } else {
      text = readFromRef(ref, e.path);
      const actual = blobHash(ref, e.path);
      if (actual === null || text === null) {
        report.fail(`could not read ${e.path} on ${ref}`);
      } else {
        // The commit the Hub commit: line names holds the pinned bytes, or the
        // two lines were not copied from one run. A failed Hub commit: line is
        // already reported, and leaves nothing to prove the pin against.
        const held = hubCommit === null ? null : blobHash(hubCommit, e.path);
        if (hubCommit !== null && !(held !== null && held.startsWith(e.pin))) {
          report.fail(`${at}: "${e.id}" pins ${e.pin} for ${e.path}, and the hub at ${hubCommit.slice(0, e.pin.length)}, the commit the ${CONFIG.hubCommitLabel}: line names, ${held === null ? 'has no file there' : `holds ${held.slice(0, e.pin.length)} there`}; the two lines were not copied from one run, so re-run scripts/read-context.mjs --hub on an up-to-date trunk and copy the ${CONFIG.hubCommitLabel}: and ${CONFIG.contextLabel}: lines it prints`);
        } else if (!actual.startsWith(e.pin)) {
          if (hubCommit !== null) pinned = pinnedBlob(e.pin);
          report.note(`context drift: "${e.id}" (${e.path}) was ${e.pin} when the document read it and is ${actual.slice(0, e.pin.length)} on ${ref} now; the document moved after this one was written, so re-read it with scripts/read-context.mjs --hub and decide whether the requirements still hold`);
        } else {
          pinned = text;
        }
      }
    }
    // The script adds an always-on document to every line, so a page that does
    // not use it is not a failure. A rule the page cites from it is still proved.
    const always = alwaysOn(pinned);
    if (e.id.search(CONFIG.standardId) === 0) {
      const cited = ruleCites.filter((rule) => ruleOf(rule) === e.id);
      if (cited.length === 0) {
        if (!always) report.fail(`${at}: "${e.id}" is a standard, and the document cites none of its rules; cite each rule that shapes a requirement by its id, ${e.id}.<NN>, or remove the standard from the line`);
      } else if (text !== null) {
        const defined = new Set(text.split('\n').map((line) => line.match(CONFIG.standardRuleDefined)).filter(Boolean).map((m) => m[1]));
        for (const rule of cited.filter((r) => !defined.has(r))) {
          report.fail(`${path} cites ${rule}, which ${e.path} on ${ref} does not define; cite a rule the standard carries`);
        }
      }
    } else if (!always && !mentions(body, e.id)) {
      report.fail(`${at}: "${e.id}" is on the line and named nowhere else in the document; name it where it shapes a requirement, or remove it from the line`);
    }
  }
  // A global entry pins the release this document records on its own Global:
  // line. checkGlobal reports a broken link file, so it is read quietly here.
  const quiet = { fail: () => {}, note: () => {} };
  const globalTexts = checkGlobalEntries(ref, { entries: globalEntries, ids: new Set(entries.map((e) => e.id)), at, source: { path, release: recordedRelease(lines) }, link: readGlobalLink(ref, quiet), remote: true, report });
  checkGlobalUse(body, path, at, entries, report, globalTexts, 'document');

  const listed = new Set(entries.map((e) => e.id));
  for (const standard of [...new Set(ruleCites.map(ruleOf))].filter((s) => !listed.has(s))) {
    report.fail(`${path} cites ${ruleCites.filter((r) => ruleOf(r) === standard).join(', ')}, and its "${CONFIG.contextLabel}:" line does not list ${standard}; a document lists every standard it read, so select it with scripts/read-context.mjs --hub --names and copy the line it prints`);
  }
  for (const record of citations(body, CONFIG.decisionRecordCite).filter((r) => !listed.has(r))) {
    report.fail(`${path} names ${record}, and its "${CONFIG.contextLabel}:" line does not list it; a document lists every decision record it read, so select it with scripts/read-context.mjs --hub --names and copy the line it prints`);
  }
}

/* ------------------------------------------------------------ global release */

// The global repository is read the way the hub reads a spoke: from a bare cache
// outside the hub, never from the checkout the check stands in. A hub checkout
// on a CI runner carries the runner's own credential in its local git
// configuration, and git sends that before the hub's read credential for its
// spokes, so a private global repository asked from inside the hub is "not
// found". cacheDir and the four reads below are copies of the same functions in
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

// Every tag the remote lists now, by name, an annotated tag peeled to the
// commit it names. Asked of the remote, never of the cache, so a moved or
// deleted tag shows at once.
function globalTags(dir, url) {
  let out;
  try {
    out = remoteGit(['--git-dir', dir, 'ls-remote', '--tags', url]);
  } catch (err) {
    return refuseToJudge(`cannot list the tags of the global repository ${url}: ${firstLine(err.stderr) || firstLine(err.message)}`, 'remote-unreachable');
  }
  const direct = new Map();
  const peeled = new Map();
  for (const line of out.split('\n')) {
    const m = line.match(/^([0-9a-f]{40})\trefs\/tags\/(.+?)(\^\{\})?$/);
    if (m) (m[3] ? peeled : direct).set(m[2], m[1]);
  }
  return new Map([...direct.keys()].map((name) => [name, peeled.get(name) || direct.get(name)]));
}

// The trunk's whole history, so "on the trunk" is a fact about ancestry and not
// about how deep an earlier read fetched. `--unshallow` when a depth-1 reader
// left the cache shallow.
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

function onGlobalTrunk(dir, commit, head) {
  try {
    git(['--git-dir', dir, 'cat-file', '-e', `${commit}^{commit}`]);
    git(['--git-dir', dir, 'merge-base', '--is-ancestor', commit, head]);
    return true;
  } catch (err) {
    return false;
  }
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

/* ---------------------------------------------------- global context entries */

// The global entries on a Context: line are proved against the global context
// repository (docs/proposals/global-context.md §8, rules 2 to 6). The functions
// from here to checkGlobalUse are the same in check-dev-ready.js,
// check-requirements.js and check-decomposition.js, because each check ships
// verbatim and imports nothing. Change one, change the three in the same commit
// (generation.md §3.2).
// The remote reads they use -- cacheDir, globalTrunk, fetchGlobalTrunk and
// readGlobalLink -- sit under "global release" above.

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

// The release of the global repository the document was written against.
// /feature runs scripts/read-global.mjs --resolve and copies the last line it
// prints. Without a link on the trunk the line is `none` or absent. With one, the
// line names a release tag and its commit, and the remote must agree now: the
// tag still points at that commit, and the commit is on the global trunk. The
// check does not ask for the newest tag. A later release does not unapprove a
// document written against an earlier one.
function checkGlobal(ref, lines, path, report) {
  const claims = [];
  lines.forEach((line, i) => {
    const m = line.match(CONFIG.globalLine);
    if (m) claims.push({ no: i + 1, value: m[1] });
  });
  const label = CONFIG.globalLabel;
  const expected = `"${label}: vX.Y.Z <40-hex>", the last line scripts/read-global.mjs --resolve prints`;
  if (claims.length > 1) {
    report.fail(`${path} carries ${claims.length} "${label}:" lines (${claims.map((c) => `"${c.value}" on line ${c.no}`).join(', ')}); a document is written against one release of the global repository`);
    return;
  }
  const link = readGlobalLink(ref, report);
  if (link === false) return;
  const claim = claims[0] || null;
  const at = claim ? `${path} line ${claim.no}: "${label}: ${claim.value}"` : path;

  if (link === null) {
    if (claim !== null && claim.value !== CONFIG.globalNone) {
      report.fail(`${at}: ${ref} carries no ${CONFIG.globalPath}, so this hub has no global layer, and the line is "${label}: ${CONFIG.globalNone}" or absent; copy the line scripts/read-global.mjs --resolve prints`);
    }
    return;
  }
  if (claim === null) {
    report.fail(`${path} never says which release of the global repository it was written against, and ${CONFIG.globalPath} on ${ref} links this hub to ${link.url}: expected exactly one ${expected}`);
    return;
  }
  if (claim.value === CONFIG.globalNone) {
    report.fail(`${at}: ${CONFIG.globalPath} on ${ref} links this hub to ${link.url}, so the document records a release of it, not "${CONFIG.globalNone}": expected ${expected}`);
    return;
  }
  const m = claim.value.match(CONFIG.globalValue);
  if (!m) {
    report.fail(`${at} is not ${expected}, a release tag and a full commit hash separated by one space`);
    return;
  }
  const [, tag, commit] = m;
  let wellFormed = true;
  if (tag.search(CONFIG.releaseTag) !== 0) {
    report.fail(`${at}: "${tag}" is not a release tag, vX.Y.Z; a pre-release or any other tag binds nothing, so copy the line scripts/read-global.mjs --resolve prints`);
    wellFormed = false;
  }
  if (commit.search(CONFIG.globalCommit) !== 0) {
    report.fail(`${at}: "${commit}" is not a full commit hash, 40 lowercase hex characters`);
    wellFormed = false;
  }
  if (!wellFormed) return;

  // Every rule below asks the remote. An unreachable remote is exit 2, never a guess.
  const dir = cacheDir(CONFIG.globalCacheId);
  const trunk = globalTrunk(dir, link.url);
  const tagged = globalTags(dir, link.url).get(tag);
  if (tagged === undefined) {
    report.fail(`${at}: ${link.url} no longer has the tag ${tag}. The commit binds and the tag is a label, and a deleted label leaves no release to read; ask the Global Architecture Board why it was deleted, and amend the document to a release that exists`);
  } else if (tagged !== commit) {
    report.fail(`${at}: on ${link.url} the tag ${tag} points at ${tagged} now, not at the recorded ${commit}. The commit binds and the tag is a label, and a moved label makes the release ambiguous; ask the Global Architecture Board why it moved, and amend the document to a release that holds`);
  }
  const head = fetchGlobalTrunk(dir, link.url, trunk);
  if (!onGlobalTrunk(dir, commit, head)) {
    report.fail(`${at}: the commit ${commit} is not on ${trunk}, the trunk of ${link.url}. Only a commit the Board merged to the trunk and tagged binds`);
  }
}

/* ---------------------------------------------------------------- the review */

// The review binds to a REVISION of the document, and the only durable name for
// a revision is the hash of the bytes reviewed. Copied from the gate's
// checkReviewRevision with this artefact type's label.
function checkReviewRevision(ref, documentPath, reviewPath, reviewLines, report) {
  const actual = blobHash(ref, documentPath);
  if (actual === null) {
    report.fail(`could not read the revision of ${documentPath} on ${ref}`);
    return;
  }
  const hits = [];
  reviewLines.forEach((line, i) => {
    const m = line.match(CONFIG.revisionLine);
    if (m) hits.push({ no: i + 1, value: m[1].toLowerCase() });
  });
  if (hits.length === 0) {
    report.fail(`${reviewPath} carries no "${CONFIG.revisionLabel}: <hash>" line, so it names no revision of ${documentPath}; write the value of \`git hash-object ${documentPath}\` for the document you reviewed (on ${ref} that is currently ${actual})`);
    return;
  }
  if (hits.length > 1) {
    report.fail(`${reviewPath} carries ${hits.length} "${CONFIG.revisionLabel}:" lines (lines ${hits.map((h) => h.no).join(', ')}); a review approves one revision`);
    return;
  }
  const claimed = hits[0].value;
  if (!actual.startsWith(claimed)) {
    report.fail(`${reviewPath} approves revision ${claimed} of ${documentPath}, but ${ref} carries ${actual}; the document changed after it was reviewed, so the current document is unreviewed`);
  }
}

function checkReview(ref, reviewEntry, reviewLines, documentPath, slug, report) {
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
    report.fail(`${path} carries "Mode: ${modes[0]}"; a requirements review is written in "Mode: ${CONFIG.mode}"`);
  }
  // Bounded, not a substring: a review of `payments` has not named `payments-v2`.
  const mention = new RegExp(`(?:^|[^a-z0-9-])${slug}(?![a-z0-9-])`);
  if (!reviewLines.some((l) => mention.test(l))) {
    report.fail(`${path} never names ${slug}; a review is evidence about one document`);
  }
  if (documentPath !== null) {
    checkReviewRevision(ref, documentPath, path, reviewLines, report);
  }
}

/* ---------------------------------------------------------------------- main */

function main() {
  const slug = process.argv[2];
  if (!slug || !CONFIG.slugPattern.test(slug)) {
    const invoked = process.argv[1] || 'scripts/check-requirements.js';
    process.stderr.write(`usage: node ${invoked} <SLUG>   e.g. payments-onboarding (kebab-case, as /feature minted it)\n`);
    process.exit(EXIT.USAGE);
  }

  const ref = syncDefaultBranch();
  const tracked = listTree(ref, `${CONFIG.requirementsDir}/${slug}`);
  // The file at its place in the slug's folder -- and the same file at the flat
  // path the library used before the folder existed, so a half-moved slug is
  // reported as two documents rather than silently read from either.
  const named = (file) => {
    const inFolder = `${CONFIG.requirementsDir}/${slug}/${file}`;
    const flat = `${CONFIG.requirementsDir}/${slug}.${file}`;
    return [...tracked, ...listTree(ref, flat)].filter((e) => e.path === inFolder || e.path === flat);
  };
  const expected = (file) => `${CONFIG.requirementsDir}/${slug}/${file}`;

  // Check 1 -- the document: one file, readable, shown as written, filed under
  // the slug it names.
  const c1 = check('requirements document');
  const documents = named(CONFIG.documentFile);
  if (documents.length !== 1) {
    c1.fail(`expected exactly one ${expected(CONFIG.documentFile)} on ${ref}, found ${documents.length}${documents.length ? `: ${documents.map((e) => e.path).join(', ')}` : ''}`);
  }
  const documentText = documents.length === 1 ? readArtefact(ref, documents[0], c1, 'requirements document') : null;
  let documentLines = null;
  if (documentText !== null) {
    documentLines = maskNonContent(documentText);
    rejectHiddenMarkup(documentLines, documents[0].path, c1);
    rejectMalformedRows(documentLines, documents[0].path, c1);
    checkSlugRow(documentLines, documents[0].path, slug, c1);
  }

  // Check 2 -- the identifiers: every requirement a REQ-<n> heading with a
  // criteria table beneath it, every criterion a REQ-<n>.AC-<m> under its own
  // requirement, at least one per requirement, none defined twice.
  const c2 = check('requirement identifiers');
  let requirements = null;
  if (documentLines === null) {
    c2.fail('skipped: no readable requirements document');
  } else {
    requirements = parseRequirements(documentLines, c2);
  }

  // Check 3 -- no placeholder cell in any table on the page, and no fill-in
  // token left anywhere on it.
  const c3 = check('placeholder cells');
  if (documentLines === null) {
    c3.fail('skipped: no readable requirements document');
  } else {
    rejectPlaceholders(documentLines, documents[0].path, c3);
    rejectFillInTokens(documentLines, documents[0].path, c3);
  }

  // Check 4 -- the context documents: one Hub commit: line naming a trunk
  // commit; one Context: line, each hub entry held by that commit at the bytes
  // it pins, each one used on the page, and every decision record or standard
  // the page cites listed. Then the Global: line, the release of the global
  // repository the document read. It sits under this check, so a hub without a
  // global layer sees the same report as before the line existed.
  const c4 = check('context documents');
  if (documentLines === null) {
    c4.fail('skipped: no readable requirements document');
  } else {
    const hubCommit = checkHubCommit(ref, documentLines, documents[0].path, c4, 'scripts/read-context.mjs --hub');
    checkContext(ref, documentLines, documents[0].path, c4, hubCommit);
    checkGlobal(ref, documentLines, documents[0].path, c4);
  }

  // Check 5 -- the review: one file, the approved verdict matched literally,
  // the mode this artefact is reviewed in, the slug named, and the revision it
  // approved the revision on the trunk now.
  const c5 = check('requirements review');
  const reviews = named(CONFIG.reviewFile);
  if (reviews.length !== 1) {
    c5.fail(`expected exactly one ${expected(CONFIG.reviewFile)} on ${ref}, found ${reviews.length}${reviews.length ? `: ${reviews.map((e) => e.path).join(', ')}` : ''}`);
  } else {
    const reviewText = readArtefact(ref, reviews[0], c5, 'requirements review');
    if (reviewText !== null) {
      checkReview(ref, reviews[0], maskNonContent(reviewText), documents.length === 1 ? documents[0].path : null, slug, c5);
    }
  }

  // Report -- every check, every finding, then exit.
  const failed = checks.filter((c) => c.failures.length > 0);
  const width = Math.max(...checks.map((c) => c.name.length));
  process.stdout.write(`\n${slug} requirements check  (against ${ref}, ${CONFIG.remote} -> ${remoteUrl()})\n\n`);
  for (const c of checks) {
    const status = c.failures.length ? 'FAIL' : 'PASS';
    process.stdout.write(`  [${status}] ${c.name.padEnd(width)}`.trimEnd() + '\n');
    for (const f of c.failures) process.stdout.write(`         - ${f}\n`);
    for (const n of c.notes) process.stdout.write(`         note: ${n}\n`);
  }
  if (requirements && !failed.length) {
    const criteria = requirements.reduce((n, r) => n + r.criteria.length, 0);
    process.stdout.write(`\n  ${requirements.length} requirement(s), ${criteria} criteria: ${requirements.map((r) => r.id).join(', ')}\n`);
  }
  process.stdout.write(
    failed.length
      ? `\nDOCUMENT INCOMPLETE: ${failed.length} of ${checks.length} checks failed. The document is not accepted.\n\n`
      : `\nDOCUMENT COMPLETE: ${checks.length} of ${checks.length} checks passed.\n\n`
  );
  process.exit(failed.length ? EXIT.CHECK_FAIL : EXIT.PASS);
}

// The last line of an exit 2, 3 or 4 names this script and its code, so a shell line that hides
// the code, with a pipe or `; echo`, still tells the harness's failure record. Written at once,
// so a process.exit() never loses it.
process.on('exit', (code) => { if (code >= 2 && code <= 4) { try { writeSync(2, `HARNESS EXIT: check-requirements ${code}\n`); } catch { /* stderr is closed */ } } });

try {
  main();
} catch (err) {
  process.stderr.write(`INTERNAL ERROR: ${err && err.stack ? err.stack : String(err)}\n`);
  process.exit(EXIT.INTERNAL);
}

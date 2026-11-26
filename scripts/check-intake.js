#!/usr/bin/env node
/**
 * check-intake.js — the ticket-intake check.
 *
 * `/from-ticket <KEY>` takes one Jira story and writes three files into one pull
 * request in the hub, under the reserved slug `jira`:
 *
 *   docs/backlog/jira/<KEY>.ticket.md          the ticket as fetched: the snapshot
 *   docs/backlog/jira/<KEY>.item.md            the work item, in /decompose's format
 *   docs/backlog/jira/<KEY>.ticket-review.md   the critic's final review of both
 *
 * The snapshot is the story's source, as a requirements document is the source of
 * a decomposed story. This file is what runs on that pull request, and again on
 * the trunk. It says whether the ticket is good enough to design from and whether
 * the story traces to it: the snapshot has the shape the quality bar fixes
 * (`.claude/rules/ticket-quality.md`), with Given / When / Then criteria, an
 * out-of-scope section and a design section, and no placeholder; the work item
 * names one listed repository and one Context: line whose documents are on the
 * trunk; every item criterion carries a criterion of its own ticket, and every
 * ticket criterion is carried or excluded with a reason; the key is one story
 * only; and one review approves the snapshot's and the item's bytes as they are.
 *
 *   usage:  node scripts/check-intake.js PROJ-512
 *           node scripts/check-intake.js --draft <path-to-snapshot>
 *
 * `--draft` reads one snapshot from a file, not from the trunk, and runs the
 * snapshot's rules only. /from-ticket and /enrich-ticket run it before a review
 * and before anything is written to Jira, so the two commands and this gate apply
 * one bar.
 *
 * Exit codes
 *   0  complete              -> the story may enter the backlog
 *   1  at least one failure  -> not complete; all findings printed
 *   2  cannot verify         -> refused to judge (stale or unreachable remote)
 *   3  usage error           -> bad or missing key, or a draft that cannot be read
 *   4  internal error        -> unexpected; treat as not complete
 *
 * Design notes
 *   - Same trunk discipline as check-dev-ready.js and check-decomposition.js.
 *     Reads the DEFAULT BRANCH, never the working tree, confirms the branch name
 *     against the remote's own default branch, and force-fetches first. Runs on a
 *     pull request through the candidate-trunk construction the CI workflows use.
 *   - Reads no tracker. The gate holds no Jira credential, so it cannot prove
 *     that the snapshot matches the ticket: the human merge of the intake pull
 *     request attests to that, and the snapshot's `Fetched: <KEY>@<updated>` line
 *     says which version of the ticket it copies.
 *   - A ticket criterion's id is `JIRA-<KEY>.AC-<m>`, numbered from 1 in the order
 *     the ticket lists them. check-dev-ready.js and check-validation.js accept it
 *     beside `REQ-<n>.AC-<m>`; check-dev-ready.js allows it only under this slug.
 *   - The review binds to two artefacts by the hashes of their bytes:
 *     `Ticket revision:` and `Item revision:`, each the gate's pattern with its
 *     label. One changed byte in either unapproves the intake.
 *   - The masking, table and context-line functions are copied from
 *     check-decomposition.js and kept the same on purpose: the two checks read one
 *     work-item format.
 *   - Runs EVERY check before exiting. No short-circuit.
 *   - Node standard library only, plus git via child_process.
 *   - ES module. Save as check-intake.mjs where package.json is not
 *     { "type": "module" }.
 *   - Non-`main` trunk: set HARNESS_TRUNK=<branch>, as for the gate.
 *
 * What this check cannot see
 *   - Whether the snapshot is a faithful copy of the ticket. The person who merges
 *     the intake reads both.
 *   - Whether the criteria are testable, the values concrete, and the detail
 *     enough to design from. The critic judges that in `Mode: ticket-review`
 *     against the quality bar; this file proves only the shape.
 *   - Whether the item states a ticket criterion faithfully. The critic reads the
 *     two side by side.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeSync } from 'node:fs';

const EXIT = { PASS: 0, CHECK_FAIL: 1, CANNOT_VERIFY: 2, USAGE: 3, INTERNAL: 4 };

const CONFIG = {
  remote: 'origin',
  branch: process.env.HARNESS_TRUNK || 'main',
  backlogDir: 'docs/backlog',
  // Reserved for stories taken from Jira. check-dev-ready.js and
  // check-decomposition.js carry the same slug; the three are kept in step by hand.
  ticketSlug: 'jira',
  ticketSuffix: '.ticket.md',
  itemSuffix: '.item.md',
  reviewSuffix: '.ticket-review.md',
  keysPath: 'docs/backlog/keys.json',
  registryPath: 'docs/estate/repositories.json',
  linksDir: 'docs/estate/tracker-links',
  keyPattern: /^[A-Z][A-Z0-9]{1,9}-\d+$/,
  // The snapshot's lines, read by label.
  keyLine: /^Key:[ \t]*(\S.*?)\s*$/,
  sourceLine: /^Source:[ \t]*(\S.*?)\s*$/,
  sourcePattern: /^https:\/\/\S+$/,
  fetchedLine: /^Fetched:[ \t]*(\S.*?)\s*$/,
  // `<KEY>@<the ticket's updated time>`, in ISO 8601 as Jira gives it.
  fetchedValue: /^([A-Z][A-Z0-9]{1,9}-\d+)@(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}:?\d{2}))$/,
  parentLine: /^Parent:[ \t]*(\S.*?)\s*$/,
  parentNone: 'none',
  // The snapshot's sections. The criteria table begins `| ID |` and has one
  // Given, one When and one Then column, found by name; other columns, such as a
  // scenario name, are kept as the ticket gives them.
  acSection: 'Acceptance criteria',
  ticketIdLoose: /^JIRA-\S+\.AC-\d+$/i,
  criterionColumns: ['Given', 'When', 'Then'],
  scopeSection: 'Out of scope',
  designSection: 'Design',
  // The work item: the lines /decompose writes, and its criteria table.
  repositoryLabel: 'Repository',
  repositoryPattern: /^[A-Za-z0-9][A-Za-z0-9._-]*$/,
  acIdPattern: /^AC-[1-9]\d*$/,
  acIdLoose: /^AC-\d+$/i,
  carriesColumn: 'Carries',
  // A ticket criterion the story leaves out, with the reason, one per line.
  notCarriedLine: /^Not carried:[ \t]*(\S+)[ \t]+—[ \t]+(\S.*?)\s*$/,
  // The review's machine surface, shared with the gate.
  approvedVerdict: '### VERDICT: APPROVED',
  verdictLine: /^###\s+VERDICT:\s*(.+?)\s*$/,
  modeLine: /^Mode:[ \t]*(\S.*?)\s*$/,
  mode: 'ticket-review',
  ticketRevision: { label: 'Ticket revision', line: /^Ticket revision:[ \t]*([0-9a-fA-F]{7,40})\s*$/ },
  itemRevision: { label: 'Item revision', line: /^Item revision:[ \t]*([0-9a-fA-F]{7,40})\s*$/ },
  literalNone: 'NONE',
  // check-decomposition.js's tokens, and the ones a ticket uses for a value
  // nobody has decided: `TBC`, `to be confirmed`, `to be defined`, and a cell
  // that only points at the designs.
  placeholderToken: /^(?:[-–—]+|\?+|tbd|tbc|todo|n\/?a|na|none|nil|pending|placeholder|seebelow|seedesigns?|tobeconfirmed|tobedefined|x+)$/i,
  // The Context: line, as check-decomposition.js reads it on a story.
  contextLabel: 'Context',
  contextLine: /^Context:[ \t]*(\S.*?)\s*$/,
  contextNone: 'none',
  contextSeparator: ', ',
  contextEntry: /^([a-z0-9][a-z0-9-]*|ADR-\d{3,})@([0-9a-f]{12}):(?:([A-Za-z0-9][A-Za-z0-9._-]*):)?((?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[^\s,:]+)$/,
  standardId: /^std-[a-z0-9]+(?:-[a-z0-9]+)*$/,
  standardRuleCite: /(?<![A-Za-z0-9-])std-[a-z0-9]+(?:-[a-z0-9]+)*\.\d{2,}(?![0-9])/g,
  standardRuleDefined: /^-\s+\*\*(std-[a-z0-9]+(?:-[a-z0-9]+)*\.\d{2,})\*\*/,
  decisionRecordCite: /(?<![A-Za-z0-9-])ADR-\d{3,}(?![0-9])/g,
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

// Whether some commit on `ref` held `path` with a blob whose hash starts with
// `pin`. Null when the clone is shallow, so its history cannot answer. Copied
// from the gate, with its reading of "held".
function pinOnHistory(ref, path, pin) {
  try {
    if (git(['rev-parse', '--is-shallow-repository']).trim() === 'true') return null;
  } catch (err) {
    return null;
  }
  const commits = git(['log', '--format=%H', ref, '--', path]).split('\n').filter(Boolean);
  return commits.some((commit) => {
    const blob = blobHash(commit, path);
    return blob !== null && blob.startsWith(pin);
  });
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

/* --------------------------------------------------------- context documents */

// Whether `id` stands alone somewhere in `lines`, and not inside a longer id.
// A plain search, because the id comes from the page.
function mentions(lines, id) {
  const isIdChar = (ch) => ch !== undefined && ch.search(/[A-Za-z0-9-]/) === 0;
  return lines.some((line) => {
    for (let at = line.indexOf(id); at !== -1; at = line.indexOf(id, at + 1)) {
      if (!isIdChar(line[at - 1]) && !isIdChar(line[at + id.length])) return true;
    }
    return false;
  });
}

// Every match of a global pattern on the page, each once.
function citations(lines, pattern) {
  return [...new Set(lines.flatMap((line) => line.match(pattern) || []))];
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
// the page cites is on the line. Returns the ids on the line, or null.
function checkItemContext(ref, item, report) {
  const { lines, path } = item;
  const claims = [];
  lines.forEach((line, i) => {
    const m = line.match(CONFIG.contextLine);
    if (m) claims.push({ no: i + 1, value: m[1] });
  });
  const hint = `scripts/read-context.mjs ${item.repository || '<repository>'} --at <commit> --names`;
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

  for (const e of entries) {
    let text = null;
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
        } else if (!actual.startsWith(e.pin)) {
          // Moved, or never merged: only the trunk's history can say which.
          const held = pinOnHistory(ref, e.path, e.pin);
          if (held === null) {
            refuseToJudge(`"${e.id}" (${e.path}) is ${actual.slice(0, e.pin.length)} on ${ref}, not the ${e.pin} ${item.key} read, and this clone is shallow, so the check cannot tell a moved document from bytes nobody merged; fetch full history (fetch-depth: 0) and re-run`, 'shallow-clone');
          } else if (!held) {
            report.fail(`${at}: "${e.id}" pins ${e.pin} for ${e.path}, and no commit on ${ref} ever held those bytes; the story was written against bytes nobody merged, so re-run ${hint} on an up-to-date trunk and copy the line it prints`);
          } else {
            report.note(`context drift: "${e.id}" (${e.path}) was ${e.pin} when ${item.key} read it and is ${actual.slice(0, e.pin.length)} on ${ref} now; the document moved after the story was written, so re-read it and decide whether the story still holds`);
          }
        }
      }
    }
    if (e.id.search(CONFIG.standardId) === 0) {
      const cited = ruleCites.filter((rule) => ruleOf(rule) === e.id);
      if (cited.length === 0) {
        report.fail(`${at}: "${e.id}" is a standard, and the story cites none of its rules; cite each rule that shapes a criterion by its id, ${e.id}.<NN>, or remove the standard from the line`);
      } else if (text !== null) {
        const defined = new Set(text.split('\n').map((line) => line.match(CONFIG.standardRuleDefined)).filter(Boolean).map((m) => m[1]));
        for (const rule of cited.filter((r) => !defined.has(r))) {
          report.fail(`${path} cites ${rule}, which ${e.path} on ${ref} does not define; cite a rule the standard carries`);
        }
      }
    } else if (!mentions(body, e.id)) {
      report.fail(`${at}: "${e.id}" is on the line and named nowhere else in the story; name it where it shapes a criterion, or remove it from the line`);
    }
  }

  const listed = new Set(entries.map((e) => e.id));
  for (const standard of [...new Set(ruleCites.map(ruleOf))].filter((x) => !listed.has(x))) {
    report.fail(`${path} cites ${ruleCites.filter((r) => ruleOf(r) === standard).join(', ')}, and its "${CONFIG.contextLabel}:" line does not list ${standard}; a story lists every standard it read, so select it with ${hint} and copy the line it prints`);
  }
  for (const record of citations(body, CONFIG.decisionRecordCite).filter((r) => !listed.has(r))) {
    report.fail(`${path} names ${record}, and its "${CONFIG.contextLabel}:" line does not list it; a story lists every decision record it read, so select it with ${hint} and copy the line it prints`);
  }
  return entries.map((e) => e.id);
}

/* -------------------------------------------------------------- the snapshot */

// One line read by label: its value and its line number, or null with a finding
// when the page carries none or more than one.
function oneLine(lines, pattern, label, path, report) {
  const hits = [];
  lines.forEach((line, i) => {
    const m = line.match(pattern);
    if (m) hits.push({ value: m[1], no: i + 1 });
  });
  if (hits.length !== 1) {
    report.fail(`${path} must carry exactly one "${label}" line, found ${hits.length}`);
    return null;
  }
  return hits[0];
}

// The lines of a section a reader sees as its content: not blank, not a heading.
function sectionContent(lines, heading, path, report) {
  const range = sectionRange(lines, heading, report);
  if (!range) {
    report.fail(`${path} has no "## ${heading}" section`);
    return null;
  }
  return lines.slice(range[0] + 1, range[1] + 1)
    .map((line, i) => ({ text: line.trim(), no: range[0] + 2 + i }))
    .filter((l) => l.text !== '' && l.text.search(HEADING) !== 0);
}

// The ticket as fetched. Returns the ids of its criteria, in order, or null when
// no criterion can be read. Every rule here is one the quality bar makes
// mechanical; the critic judges the rest.
function checkSnapshot(lines, path, key, report) {
  rejectHiddenMarkup(lines, path, report);
  rejectMalformedRows(lines, path, report);

  const keyHit = oneLine(lines, CONFIG.keyLine, 'Key: <KEY>', path, report);
  if (keyHit && keyHit.value !== key) {
    report.fail(`${path} line ${keyHit.no} says "Key: ${keyHit.value}", and the snapshot is filed as ${key}; one ticket, one key, and the file name carries it`);
  }
  const source = oneLine(lines, CONFIG.sourceLine, 'Source: <ticket URL>', path, report);
  if (source && source.value.search(CONFIG.sourcePattern) !== 0) {
    report.fail(`${path} line ${source.no}: "Source: ${source.value}" is not an https address; the snapshot names the ticket it copies`);
  }
  const fetched = oneLine(lines, CONFIG.fetchedLine, 'Fetched: <KEY>@<updated>', path, report);
  if (fetched) {
    const m = fetched.value.match(CONFIG.fetchedValue);
    if (!m) {
      report.fail(`${path} line ${fetched.no}: "Fetched: ${fetched.value}" is not <KEY>@<the ticket's updated time in ISO 8601>; the line says which version of the ticket this copies`);
    } else if (m[1] !== key) {
      report.fail(`${path} line ${fetched.no}: "Fetched: ${fetched.value}" names ${m[1]}, not ${key}`);
    }
  }
  const parent = oneLine(lines, CONFIG.parentLine, `Parent: <KEY> or "Parent: ${CONFIG.parentNone}"`, path, report);
  if (parent && parent.value !== CONFIG.parentNone && parent.value.search(CONFIG.keyPattern) !== 0) {
    report.fail(`${path} line ${parent.no}: "Parent: ${parent.value}" is neither a ticket key nor "${CONFIG.parentNone}"`);
  }

  let ids = null;
  const at = prefixed(report, `${path}: `);
  const table = readTable(lines, CONFIG.acSection, 'ID', null, CONFIG.ticketIdLoose, at);
  if (table) {
    const cols = CONFIG.criterionColumns.map((name) => column(table, name, CONFIG.acSection, at));
    ids = [];
    table.rows.forEach(({ cells, no }, i) => {
      const expected = `JIRA-${key}.AC-${i + 1}`;
      if (cells[0] !== expected) {
        report.fail(`${path} line ${no}: criterion "${cells[0]}" is not ${expected}; the ticket's criteria are numbered JIRA-${key}.AC-1, -2, … in the order the ticket lists them`);
      }
      cols.forEach((col, c) => {
        if (col >= 0 && cells[col] === '') {
          report.fail(`${path} line ${no}: ${cells[0]} has nothing in the "${CONFIG.criterionColumns[c]}" column; a criterion states its condition, its action and its observable outcome`);
        }
      });
      ids.push(cells[0]);
    });
    if (ids.length === 0) {
      report.fail(`${path}: the "${CONFIG.acSection}" table has no criterion; a ticket with no criteria cannot be accepted`);
      ids = null;
    }
  }

  for (const heading of [CONFIG.scopeSection, CONFIG.designSection]) {
    const content = sectionContent(lines, heading, path, report);
    if (content === null) continue;
    if (content.length === 0) {
      report.fail(`${path}: the "## ${heading}" section is empty; ${heading === CONFIG.scopeSection ? 'a ticket says what it does not change, so nobody builds it by accident' : 'a ticket links its design, or says "none — <why>"'}`);
    } else if (content.every((l) => isPlaceholder(l.text.replace(/^[-*+]\s+/, '')))) {
      report.fail(`${path} line ${content[0].no}: the "## ${heading}" section holds only a placeholder; an unknown nobody marked is still unknown`);
    }
  }

  rejectPlaceholders(lines, path, report);
  return ids;
}

/* ----------------------------------------------------------------- the item */

// The work item /from-ticket wrote: its key, its one repository, its criteria
// with the ticket criterion each carries, and the ticket criteria it leaves out.
function checkItem(lines, path, key, registry, report) {
  const item = { key, path, lines, repository: null, criteria: [], notCarried: [] };
  rejectHiddenMarkup(lines, path, report);
  rejectMalformedRows(lines, path, report);

  const keyHit = oneLine(lines, CONFIG.keyLine, 'Key: <KEY>', path, report);
  if (keyHit && keyHit.value !== key) {
    report.fail(`${path} line ${keyHit.no} says "Key: ${keyHit.value}", and the item is filed as ${key}; one item, one key, and the file name carries it`);
  }
  const repoLine = new RegExp(`^${CONFIG.repositoryLabel}:[ \\t]*(\\S.*?)\\s*$`);
  const repo = oneLine(lines, repoLine, `${CONFIG.repositoryLabel}: <id>`, path, report);
  if (repo) {
    if (repo.value.search(CONFIG.repositoryPattern) !== 0 || isPlaceholder(repo.value)) {
      report.fail(`${path} line ${repo.no}: "${CONFIG.repositoryLabel}: ${repo.value}" is not a repository id`);
    } else if (registry !== null && !registry.includes(repo.value)) {
      report.fail(`${path} names repository "${repo.value}", which ${CONFIG.registryPath} does not carry (it lists ${registry.join(', ')}); /add-repo comes first, and an invented id names nothing`);
    } else {
      item.repository = repo.value;
    }
  }

  const prefix = `JIRA-${key}.AC-`;
  const isTicketCriterion = (cell) => cell.startsWith(prefix) && cell.slice(prefix.length).search(/^[1-9]\d*$/) === 0;
  const at = prefixed(report, `${path}: `);
  const table = readTable(lines, CONFIG.acSection, 'ID', 'Criterion', CONFIG.acIdLoose, at);
  if (table) {
    const carries = column(table, CONFIG.carriesColumn, CONFIG.acSection, at);
    for (const { cells, no } of table.rows) {
      const id = cells[0];
      if (id.search(CONFIG.acIdPattern) !== 0) {
        report.fail(`${path} line ${no}: criterion identifier "${id}" does not match AC-<n>`);
        continue;
      }
      if (item.criteria.some((c) => c.id === id)) {
        report.fail(`${path} line ${no}: criterion ${id} is defined twice`);
        continue;
      }
      let carried = null;
      if (carries >= 0) {
        if (isTicketCriterion(cells[carries])) carried = cells[carries];
        else report.fail(`${path} line ${no}: ${id} carries "${cells[carries]}", which is not one ${prefix}<m>; a story taken from a ticket carries the criteria of its own ticket`);
      }
      item.criteria.push({ id, carries: carried, no });
    }
    if (item.criteria.length === 0) {
      report.fail(`${path}: the "${CONFIG.acSection}" table defines no AC-<n> row; a story with no criteria cannot be accepted`);
    }
  }

  lines.forEach((line, i) => {
    const m = line.match(CONFIG.notCarriedLine);
    if (!m) return;
    if (!isTicketCriterion(m[1])) {
      report.fail(`${path} line ${i + 1}: "Not carried: ${m[1]}" names no criterion of ${key}; write "Not carried: ${prefix}<m> — <reason>"`);
    } else if (isPlaceholder(m[2])) {
      report.fail(`${path} line ${i + 1}: ${m[1]} is not carried, with "${m[2]}" for a reason; an exclusion names its reason`);
    } else {
      item.notCarried.push({ id: m[1], no: i + 1 });
    }
  });

  rejectPlaceholders(lines, path, report);
  return item;
}

/* ---------------------------------------------------------------- the review */

// A review binds to a REVISION of each artefact it approved, and the only durable
// name for a revision is the hash of its bytes. The gate's pattern, once per
// artefact.
function checkRevision(ref, targetPath, reviewPath, reviewLines, revision, report) {
  const actual = blobHash(ref, targetPath);
  if (actual === null) {
    report.fail(`could not read the revision of ${targetPath} on ${ref}`);
    return;
  }
  const hits = [];
  reviewLines.forEach((line, i) => {
    const m = line.match(revision.line);
    if (m) hits.push({ no: i + 1, value: m[1].toLowerCase() });
  });
  if (hits.length === 0) {
    report.fail(`${reviewPath} carries no "${revision.label}: <hash>" line, so it names no revision of ${targetPath}; write the value of \`git hash-object ${targetPath}\` for the bytes you reviewed (on ${ref} that is currently ${actual})`);
  } else if (hits.length > 1) {
    report.fail(`${reviewPath} carries ${hits.length} "${revision.label}:" lines (lines ${hits.map((h) => h.no).join(', ')}); a review approves one revision`);
  } else if (!actual.startsWith(hits[0].value)) {
    report.fail(`${reviewPath} approves revision ${hits[0].value} of ${targetPath}, but ${ref} carries ${actual}; the file changed after it was reviewed, so the current file is unreviewed`);
  }
}

function checkReview(ref, reviewPath, reviewLines, ticketPath, itemPath, key, report) {
  rejectHiddenMarkup(reviewLines, reviewPath, report);
  rejectMalformedRows(reviewLines, reviewPath, report);
  const verdicts = reviewLines.filter((l) => l.search(CONFIG.verdictLine) === 0);
  if (verdicts.length !== 1) {
    report.fail(`${reviewPath} must contain exactly one verdict line, found ${verdicts.length}`);
  } else if (verdicts[0].trimEnd() !== CONFIG.approvedVerdict) {
    report.fail(`${reviewPath} verdict is "${verdicts[0].trim()}"; the check opens only on "${CONFIG.approvedVerdict}"`);
  }
  const modes = reviewLines.map((l) => l.match(CONFIG.modeLine)).filter(Boolean).map((m) => m[1]);
  if (modes.length !== 1) {
    report.fail(`${reviewPath} must carry exactly one "Mode: ${CONFIG.mode}" line, found ${modes.length}`);
  } else if (modes[0] !== CONFIG.mode) {
    report.fail(`${reviewPath} carries "Mode: ${modes[0]}"; a ticket intake is reviewed in "Mode: ${CONFIG.mode}"`);
  }
  if (!mentions(reviewLines, key)) {
    report.fail(`${reviewPath} never names ${key}; a review is evidence about one ticket`);
  }
  if (ticketPath !== null) checkRevision(ref, ticketPath, reviewPath, reviewLines, CONFIG.ticketRevision, report);
  if (itemPath !== null) checkRevision(ref, itemPath, reviewPath, reviewLines, CONFIG.itemRevision, report);
}

/* ---------------------------------------------------------------------- main */

function usage() {
  const invoked = process.argv[1] || 'scripts/check-intake.js';
  process.stderr.write(`usage: node ${invoked} <KEY>              e.g. PROJ-512, the Jira key of a story under ${CONFIG.backlogDir}/${CONFIG.ticketSlug}/\n`);
  process.stderr.write(`       node ${invoked} --draft <file>     the snapshot rules only, on a file\n`);
  process.exit(EXIT.USAGE);
}

function printAndExit(title, done, notDone) {
  const failed = checks.filter((c) => c.failures.length > 0);
  const width = Math.max(...checks.map((c) => c.name.length));
  process.stdout.write(`\n${title}\n\n`);
  for (const c of checks) {
    process.stdout.write(`  [${c.failures.length ? 'FAIL' : 'PASS'}] ${c.name.padEnd(width)}`.trimEnd() + '\n');
    for (const f of c.failures) process.stdout.write(`         - ${f}\n`);
    for (const n of c.notes) process.stdout.write(`         note: ${n}\n`);
  }
  process.stdout.write(failed.length
    ? `\n${notDone}: ${failed.length} of ${checks.length} checks failed.\n\n`
    : `\n${done}: ${checks.length} of ${checks.length} checks passed.\n\n`);
  process.exit(failed.length ? EXIT.CHECK_FAIL : EXIT.PASS);
}

// --draft: one snapshot, from a file. The key is the one its Key: line names, or
// the file name's, so a snapshot with no Key: line is still checked.
function draft(file) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    process.stderr.write(`cannot read ${file}: ${String(err.message).split('\n')[0]}\n`);
    process.exit(EXIT.USAGE);
  }
  const lines = maskNonContent(stripBom(text));
  const named = lines.map((l) => l.match(CONFIG.keyLine)).filter(Boolean).map((m) => m[1]);
  const base = file.slice(file.search(/[^/\\]*$/));
  const fromName = base.endsWith(CONFIG.ticketSuffix) ? base.slice(0, -CONFIG.ticketSuffix.length) : null;
  const key = named.length === 1 && named[0].search(CONFIG.keyPattern) === 0 ? named[0]
    : (fromName !== null && fromName.search(CONFIG.keyPattern) === 0 ? fromName : '<KEY>');
  const c1 = check('ticket snapshot');
  checkSnapshot(lines, file, key, c1);
  printAndExit(`${key} ticket check  (draft: ${file})`, 'TICKET READY', 'TICKET NOT READY');
}

function main() {
  const arg = process.argv[2];
  if (arg === '--draft') {
    if (!process.argv[3] || process.argv.length > 4) usage();
    draft(process.argv[3]);
    return;
  }
  if (!arg || process.argv.length > 3 || arg.search(CONFIG.keyPattern) !== 0) usage();
  const key = arg;

  const ref = syncDefaultBranch();
  const dir = `${CONFIG.backlogDir}/${CONFIG.ticketSlug}/`;
  const ticketPath = `${dir}${key}${CONFIG.ticketSuffix}`;
  const itemPath = `${dir}${key}${CONFIG.itemSuffix}`;
  const reviewPath = `${dir}${key}${CONFIG.reviewSuffix}`;

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

  const read = (path, report, label) => {
    const entry = treeEntry(ref, path);
    if (entry === null) {
      report.fail(`no ${path} on ${ref}; /from-ticket ${key} writes it`);
      return null;
    }
    const text = readArtefact(ref, entry, report, label);
    return text === null ? null : maskNonContent(text);
  };

  // Check 1 -- the snapshot: the ticket as fetched, in the shape the quality bar
  // fixes.
  const c1 = check('ticket snapshot');
  const ticketLines = read(ticketPath, c1, 'ticket snapshot');
  const ticketIds = ticketLines === null ? null : checkSnapshot(ticketLines, ticketPath, key, c1);

  // Check 2 -- the work item: one key, one listed repository, criteria that each
  // carry a criterion of this ticket.
  const c2 = check('work item');
  if (registryFinding) c2.fail(registryFinding);
  const itemLines = read(itemPath, c2, 'work item');
  const item = itemLines === null ? null : checkItem(itemLines, itemPath, key, registry, c2);

  // Check 3 -- the trace, both ways: every item criterion carries a criterion the
  // snapshot defines, and every snapshot criterion is carried or left out with a
  // reason.
  const c3 = check('trace to the ticket');
  if (ticketIds === null || item === null) {
    c3.fail(`skipped: ${ticketIds === null ? 'no readable criteria in the snapshot' : 'no readable work item'}`);
  } else {
    const defined = new Set(ticketIds);
    const carried = new Set(item.criteria.map((c) => c.carries).filter(Boolean));
    for (const c of item.criteria) {
      if (c.carries !== null && !defined.has(c.carries)) {
        c3.fail(`${itemPath} line ${c.no}: ${c.id} carries ${c.carries}, which ${ticketPath} does not define`);
      }
    }
    const excluded = new Set();
    for (const n of item.notCarried) {
      if (!defined.has(n.id)) c3.fail(`${itemPath} line ${n.no}: "Not carried: ${n.id}" names a criterion ${ticketPath} does not define`);
      else if (carried.has(n.id)) c3.fail(`${itemPath} line ${n.no}: ${n.id} is marked not carried, and a criterion of the item carries it; say one or the other`);
      else if (excluded.has(n.id)) c3.fail(`${itemPath} line ${n.no}: ${n.id} is marked not carried twice`);
      excluded.add(n.id);
    }
    for (const id of ticketIds) {
      if (!carried.has(id) && !excluded.has(id)) {
        c3.fail(`${ticketPath} defines ${id}, and ${itemPath} neither carries it nor says "Not carried: ${id} — <reason>"; a criterion the ticket asks for is built or excluded, never dropped`);
      }
    }
  }

  // Check 4 -- the context documents: one Context: line whose hub documents are
  // on the trunk and used on the page.
  const c4 = check('context documents');
  if (item === null) c4.fail('skipped: no readable work item');
  else checkItemContext(ref, item, c4);

  // Check 5 -- one key, one story: no other work item carries this key, the
  // hub's ledger never minted it, and no link file already ties this ticket to a
  // story the hub decomposed.
  const c5 = check('one story per key');
  const itemName = `${key}${CONFIG.itemSuffix}`;
  const depth = CONFIG.backlogDir.split('/').length + 2;
  for (const e of listTree(ref, CONFIG.backlogDir)) {
    const parts = e.path.split('/');
    if (parts.length === depth && parts[parts.length - 1] === itemName && e.path !== itemPath) {
      c5.fail(`${e.path} is on ${ref} too; one key is one story, and ${key} already has a work item there, so run /dev-spec on it instead of taking the ticket again`);
    }
  }
  const keysText = readFromRef(ref, CONFIG.keysPath);
  if (keysText === null) {
    c5.note(`no ${CONFIG.keysPath} on ${ref}, so no minted key can collide with ${key}`);
  } else {
    let keys = null;
    try {
      keys = JSON.parse(stripBom(keysText));
    } catch (err) {
      c5.fail(`${CONFIG.keysPath} on ${ref} is not JSON, so nothing can say whether the hub minted ${key}: ${String(err.message).split('\n')[0]}`);
    }
    const [prefix, number] = key.split('-');
    if (keys && typeof keys === 'object' && keys.prefix === prefix) {
      const n = Number(number);
      const blocks = Array.isArray(keys.blocks) ? keys.blocks : [];
      const hit = blocks.find((b) => b && Number.isInteger(b.from) && Number.isInteger(b.to) && n >= b.from && n <= b.to);
      if (hit) {
        c5.fail(`${key} is a key this hub minted (${CONFIG.keysPath}: ${prefix}-${hit.from} to ${prefix}-${hit.to}, taken by ${hit.taken_by || 'an unnamed artefact'}); a ticket key that is also a minted key is two stories wearing one key`);
      } else {
        c5.note(`${key} shares the prefix "${prefix}" of ${CONFIG.keysPath}; a later /decompose may mint ${key} for another story, so a hub that takes tickets from a Jira project keeps a different prefix`);
      }
    }
  }
  for (const e of listTree(ref, CONFIG.linksDir).filter((x) => x.path.endsWith('.json'))) {
    const text = readFromRef(ref, e.path);
    let links = null;
    try {
      links = text === null ? null : JSON.parse(stripBom(text));
    } catch (err) {
      c5.fail(`${e.path} on ${ref} is not JSON, so nothing can say whether it already links ${key}: ${String(err.message).split('\n')[0]}`);
    }
    const items = links && links.items && typeof links.items === 'object' ? links.items : {};
    for (const [hubKey, link] of Object.entries(items)) {
      const ticket = link && typeof link.ticket === 'string' ? link.ticket : '';
      if (ticket.slice(ticket.lastIndexOf(':') + 1) === key) {
        c5.fail(`${e.path} links the ticket ${key} to the story ${hubKey}, which a decomposition made; the story is already in the hub, so run /dev-spec ${hubKey}`);
      }
    }
  }

  // Check 6 -- the review: one file, the approved verdict matched literally, the
  // mode, the key named, and the revisions of the snapshot and the item on the
  // trunk now.
  const c6 = check('ticket review');
  const reviewLines = read(reviewPath, c6, 'ticket review');
  if (reviewLines !== null) {
    checkReview(ref, reviewPath, reviewLines, ticketLines === null ? null : ticketPath, itemLines === null ? null : itemPath, key, c6);
  }

  printAndExit(`${key} intake check  (against ${ref}, ${CONFIG.remote} -> ${remoteUrl()})`,
    'INTAKE COMPLETE', 'INTAKE INCOMPLETE');
}

// The last line of an exit 2, 3 or 4 names this script and its code, so a shell line that hides
// the code, with a pipe or `; echo`, still tells the harness's failure record. Written at once,
// so a process.exit() never loses it.
process.on('exit', (code) => { if (code >= 2 && code <= 4) { try { writeSync(2, `HARNESS EXIT: check-intake ${code}\n`); } catch { /* stderr is closed */ } } });

try {
  main();
} catch (err) {
  process.stderr.write(`INTERNAL ERROR: ${err && err.stack ? err.stack : String(err)}\n`);
  process.exit(EXIT.INTERNAL);
}

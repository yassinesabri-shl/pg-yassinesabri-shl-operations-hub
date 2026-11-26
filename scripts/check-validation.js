#!/usr/bin/env node
/**
 * check-validation.js — the validation-report check.
 *
 * `/qa-sprint` validates the head commit of the story's open code pull request.
 * When every criterion passes, it writes one report, docs/designs/<KEY>.validation.md,
 * and opens a pull request in the hub with it. This file is what runs on that pull
 * request, on the trunk after the merge, and inside the spoke's qa-gate through
 * check-qa-gate.mjs. It reads the report and the design it validates, both on the
 * trunk, and says whether the report is complete and passing: one row per
 * criterion in the design, the requirement each row names the same as the
 * design's, PASS on every row (N/A only against a DEPRECATED criterion),
 * evidence on every row, and a closing line whose counts are the table's.
 *
 * A failing criterion never reaches the hub. Its rows go back to /dev-sprint as a
 * fix round on the same branch, so a FAIL row here is a finding.
 *
 *   usage:  node scripts/check-validation.js PROJ-412
 *
 * Exit codes
 *   0  complete, every criterion passed -> the code pull request may merge
 *   1  at least one check failed    -> not complete; all findings printed
 *   2  cannot verify                -> refused to judge (stale or unreachable remote)
 *   3  usage error                  -> bad or missing work-item key
 *   4  internal error               -> unexpected; treat as not complete
 *
 * Design notes
 *   - Same trunk discipline as check-dev-ready.js. Reads the DEFAULT BRANCH,
 *     never the working tree, confirms the branch name against the remote's own
 *     default branch, and force-fetches first. Run on a pull request through
 *     the candidate-trunk construction the CI workflows use; never through a
 *     branch flag, because there is none.
 *   - The report has ONE shape and this file reads exactly that shape: a
 *     heading, three lines, one table, one closing line, and nothing else. A
 *     line the shape does not allow fails, wherever it is. There is no masking
 *     here because there is nothing to mask: a fence, a comment or a paragraph
 *     in a validation report is a line the report may not carry.
 *   - The design is read the way the pickup gate reads it, and the criteria
 *     table is parsed with the same functions, copied and kept the same on
 *     purpose: the two files read one table and must agree on what a row is.
 *   - Binds the report to the DESIGN it validated. The `Design:` line names the
 *     hub commit the design was read at; that commit must be on the trunk, and
 *     the design's bytes at that commit must be the design's bytes on the trunk
 *     now. One changed byte since the report was written and the report is
 *     about an older design. This is the `Design revision:` check of a review,
 *     written as a commit rather than a blob because the seat that produced
 *     the text held no hub checkout and was handed the commit with the design.
 *   - Runs EVERY check before exiting. No short-circuit.
 *   - Node standard library only, plus git via child_process.
 *   - ES module. Save as check-validation.mjs where package.json is not
 *     { "type": "module" }.
 *   - Non-`main` trunk: set HARNESS_TRUNK=<branch>, as for the gate.
 *
 * What this check cannot see
 *   - Whether the spoke commit exists, or is on the spoke's trunk. That commit
 *     lives in another repository, and this file reads one remote: the one
 *     holding the report. The `Spoke commit:` line is checked for SHAPE — forty
 *     hex characters — and nothing else. A check that reads several remotes
 *     cannot be a required check, and this one is meant to be required.
 *   - Whether the evidence is true. A test name and a file and line are what
 *     the validating seat wrote down; whether that test asserts the criterion
 *     is the seat's judgement, and a wrong judgement produces a complete report.
 *   - Whether a PASS is deserved. This file proves the paperwork cannot be
 *     skipped: every criterion has a verdict, every verdict names its evidence,
 *     the requirement column reaches the end of the flow. It does not prove the
 *     code is right.
 *   - Whether the spoke commit is the head of the open code pull request. That
 *     is check-qa-gate.mjs, which the spoke's qa-gate runs with the head commit
 *     from the pull-request event.
 */

import { execFileSync } from 'node:child_process';
import { writeSync } from 'node:fs';

const EXIT = { PASS: 0, CHECK_FAIL: 1, CANNOT_VERIFY: 2, USAGE: 3, INTERNAL: 4 };

const CONFIG = {
  remote: 'origin',
  branch: process.env.HARNESS_TRUNK || 'main',
  designDir: 'docs/designs',
  designSuffix: '.lld.md',
  reviewSuffix: '.lld-review.md',
  reportSuffix: '.validation.md',
  keyPattern: /^[A-Z][A-Z0-9]{1,9}-\d+$/,
  // The design's own heading. The report repeats its title, so a report written
  // against one design and filed under another key is caught by the words too.
  designHeading: /^# LLD — ([A-Z][A-Z0-9]{1,9}-\d+): (\S.*?)\s*$/,
  reportHeading: /^# Validation — ([A-Z][A-Z0-9]{1,9}-\d+): (\S.*?)\s*$/,
  // The three header lines, in this order, literal labels.
  designLine: /^Design:[ \t]*(\S+)[ \t]+at[ \t]+([0-9a-fA-F]{40})\s*$/,
  repositoryLine: /^Repository:[ \t]*(\S.*?)\s*$/,
  spokeLine: /^Spoke commit:[ \t]*([0-9a-fA-F]{40})\s*$/,
  // The closing line. Every count is derived from the table and checked against
  // the number written here; the numbers are never checked against each other.
  closingLine: /^Criteria:[ \t]*(\d+)[ \t]*·[ \t]*PASS[ \t]+(\d+)[ \t]*·[ \t]*FAIL[ \t]+(\d+)[ \t]*·[ \t]*defects raised:[ \t]*(\S.*?)\s*$/,
  reportHeader: ['AC', 'Criterion (short)', 'Requirement', 'Verdict', 'Evidence'],
  // The whole verdict set. `FAIL` is read so that the finding can name it, and a
  // FAIL row fails check 3. `N/A` is legal only against a criterion the design
  // marks DEPRECATED; a deprecated criterion may still carry PASS. The
  // marker is the bare word DEPRECATED as the first word of the Criterion cell,
  // followed by nothing or by a reason -- the form LLD.template.md §4 states.
  verdicts: ['PASS', 'FAIL', 'N/A'],
  deprecated: /^DEPRECATED\b/,
  acSection: 'Acceptance criteria',
  acIdPattern: /^AC-[1-9]\d*$/,
  acIdLoose: /^AC-\d+$/i,
  requirementColumn: 'Requirement',
  // A requirements document's criterion, or a Jira ticket's for a story taken
  // from a ticket. The same pattern as check-dev-ready.js, kept in step by hand.
  requirementPattern: /^(?:REQ-[1-9]\d*|JIRA-[A-Z][A-Z0-9]{1,9}-\d+)\.AC-[1-9]\d*$/,
  requirementForms: 'REQ-<n>.AC-<m> or JIRA-<KEY>.AC-<m>',
  repositoryLabel: 'Repository',
  repositoryPattern: /^[A-Za-z0-9][A-Za-z0-9._-]*$/,
  placeholderToken: /^(?:[-–—]+|\?+|tbd|todo|n\/?a|na|none|nil|pending|placeholder|seebelow|x+)$/i,
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

function blobHash(ref, path) {
  try {
    return git(['rev-parse', `${ref}:${path}`]).trim();
  } catch (err) {
    return null;
  }
}

function commitExists(sha) {
  try {
    git(['cat-file', '-e', `${sha}^{commit}`]);
    return true;
  } catch (err) {
    return false;
  }
}

function isAncestor(sha, ref) {
  try {
    git(['merge-base', '--is-ancestor', sha, ref]);
    return true;
  } catch (err) {
    return false;
  }
}

// A shallow clone is missing history on purpose, and a commit it does not have
// is not a commit that does not exist. The two are different answers.
function isShallow() {
  try {
    return git(['rev-parse', '--is-shallow-repository']).trim() === 'true';
  } catch (err) {
    return false;
  }
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

const checks = [];
function check(name) {
  const c = { name, failures: [] };
  checks.push(c);
  return { fail: (msg) => c.failures.push(msg) };
}

/* ------------------------------------------------------- non-content masking */

// Copied from check-dev-ready.js and kept the same on purpose. The design is the
// gate's document, and this file has to read its criteria table exactly as the
// gate does, or the two disagree on which rows are criteria.
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

/* ---------------------------------------------------------------- the design */

// Section 4 of the design, read as the gate reads it. Returns one entry per
// criterion: its id, whether the design has deprecated it, and the requirement
// criterion it carries. Everything the report has to agree with is here.
function parseCriteria(lines, range, report) {
  if (!range) {
    report.fail(`no "## ${CONFIG.acSection}" section in the design document`);
    return null;
  }
  if (rejectUnreadableRows(lines, range, CONFIG.acSection, report)) return null;
  const blocks = tableBlocks(lines, range);
  if (blocks.length === 0) {
    report.fail(`the "${CONFIG.acSection}" section (line ${range[0] + 1}) has no criterion table`);
    return null;
  }
  const table = selectTable(
    blocks,
    (h) => !!h && h.length >= 2 && h[0] === 'ID' && h[1] === 'Criterion',
    CONFIG.acIdLoose, CONFIG.acSection, '| ID | Criterion |', report,
  );
  if (!table) return null;
  const rows = table.rows;
  const header = splitRow(rows[0].line);
  if (rows.length < 3) {
    report.fail(`the "${CONFIG.acSection}" table (line ${rows[0].no}) has no rows`);
    return null;
  }
  if (!isSeparatorRow(splitRow(rows[1].line), header.length)) {
    report.fail(`the "${CONFIG.acSection}" table (line ${rows[1].no}) is missing a well-formed separator row`);
    return null;
  }
  // As in the gate: a finding about the requirement column is recorded and the
  // criterion is still collected, so the report is still checked for a row
  // against it. Dropping the criterion here would turn "bad requirement cell"
  // into a false "the design does not define AC-n" one check later, and would
  // let a report omit that criterion unnoticed. `requirement: null` means "the
  // design's cell is unusable, and check 1 has already said so".
  const reqCols = header.map((h, i) => (h === CONFIG.requirementColumn ? i : -1)).filter((i) => i >= 0);
  if (reqCols.length !== 1) {
    report.fail(`the "${CONFIG.acSection}" table header (line ${rows[0].no}) must carry exactly one "${CONFIG.requirementColumn}" column, found ${reqCols.length}; without it the report has no requirement to repeat`);
  }
  const reqCol = reqCols.length === 1 ? reqCols[0] : -1;
  const criteria = [];
  for (const entry of rows.slice(2)) {
    const cells = splitRow(entry.line);
    if (!cells || cells.length !== header.length) {
      report.fail(`acceptance-criteria row (line ${entry.no}) is malformed: expected ${header.length} cells, found ${cells ? cells.length : 0}`);
      continue;
    }
    if (!CONFIG.acIdPattern.test(cells[0])) {
      report.fail(`acceptance-criteria row (line ${entry.no}) identifier "${cells[0]}" does not match AC-<n>`);
      continue;
    }
    let requirement = null;
    if (reqCol >= 0) {
      if (CONFIG.requirementPattern.test(cells[reqCol])) {
        requirement = cells[reqCol];
      } else {
        report.fail(`acceptance criterion ${cells[0]} (line ${entry.no}) names requirement "${cells[reqCol]}", which is not one ${CONFIG.requirementForms}`);
      }
    }
    if (criteria.some((c) => c.id === cells[0])) {
      report.fail(`acceptance criterion ${cells[0]} is defined twice (line ${entry.no})`);
      continue;
    }
    criteria.push({ id: cells[0], deprecated: CONFIG.deprecated.test(cells[1]), requirement });
  }
  if (criteria.length === 0) report.fail(`the "${CONFIG.acSection}" table defines no AC-<n> rows`);
  return criteria;
}

// The design's one-line title, from its heading, and the one repository it names.
// The gate does not check the heading, so a merged design may lack the template's
// form; then there is no title to compare and the comparison is skipped rather
// than failing a report for a design nothing else objected to.
function designIdentity(lines, path, key, report) {
  const heading = lines.find((l) => CONFIG.designHeading.test(l));
  let title = null;
  if (heading) {
    const m = heading.match(CONFIG.designHeading);
    if (m[1] === key) title = m[2];
  }
  const repoLine = new RegExp(`^${CONFIG.repositoryLabel}:[ \\t]*(\\S.*?)\\s*$`);
  const repos = lines.filter((l) => repoLine.test(l)).map((l) => l.match(repoLine)[1]);
  let repository = null;
  if (repos.length !== 1) {
    report.fail(`${path} must carry exactly one "${CONFIG.repositoryLabel}: <id>" line, found ${repos.length}; the report names a repository and there is nothing to check it against`);
  } else if (!CONFIG.repositoryPattern.test(repos[0])) {
    report.fail(`${path}: "${CONFIG.repositoryLabel}: ${repos[0]}" is not a repository id`);
  } else {
    repository = repos[0];
  }
  return { title, repository };
}

/* ---------------------------------------------------------------- the report */

// The report's fixed shape, read line by line. Blank lines are skipped; every
// other line has to be the next thing the shape expects, and the check says
// what it expected where it found something else. Returns the parsed parts, or
// null where the shape is too broken to read a table out of.
function parseReport(text, path, report) {
  const lines = String(text).split(/\r\n|\n|\r/);
  const content = [];
  lines.forEach((line, i) => { if (line.trim() !== '') content.push({ line, no: i + 1 }); });

  const parts = { heading: null, design: null, repository: null, spoke: null, rows: [], closing: null };
  const expect = (index, label, re) => {
    const entry = content[index];
    if (!entry) {
      report.fail(`${path} ends before its ${label}; the report is one heading, three header lines, one table and one closing line`);
      return null;
    }
    const m = entry.line.match(re);
    if (!m) {
      report.fail(`${path} line ${entry.no} should be the ${label}; found "${entry.line.trim()}"`);
      return null;
    }
    return { m, entry };
  };

  const heading = expect(0, 'heading "# Validation — <KEY>: <the design\'s title>"', CONFIG.reportHeading);
  if (heading) parts.heading = { key: heading.m[1], title: heading.m[2], no: heading.entry.no };
  const design = expect(1, '"Design: docs/designs/<KEY>.lld.md at <40-character hub commit>" line', CONFIG.designLine);
  if (design) parts.design = { path: design.m[1], commit: design.m[2].toLowerCase(), no: design.entry.no };
  const repository = expect(2, '"Repository: <id>" line', CONFIG.repositoryLine);
  if (repository) parts.repository = { value: repository.m[1], no: repository.entry.no };
  const spoke = expect(3, '"Spoke commit: <40-character commit>" line', CONFIG.spokeLine);
  if (spoke) parts.spoke = { commit: spoke.m[1].toLowerCase(), no: spoke.entry.no };

  // The table. Header, separator, then rows until the closing line.
  const headerEntry = content[4];
  if (!headerEntry) {
    report.fail(`${path} ends before its table; expected the header "${row(CONFIG.reportHeader)}"`);
    return null;
  }
  const headerCells = splitRow(headerEntry.line);
  if (!headerCells || headerCells.join('|') !== CONFIG.reportHeader.join('|')) {
    report.fail(`${path} line ${headerEntry.no} should be the table header "${row(CONFIG.reportHeader)}"; found "${headerEntry.line.trim()}"`);
    return null;
  }
  if (headerEntry.no >= 2 && lines[headerEntry.no - 2].trim() !== '') {
    report.fail(`${path} line ${headerEntry.no}: the table does not start a block, so a renderer prints its pipes as text; leave a blank line above the header row`);
  }
  const sepEntry = content[5];
  if (!sepEntry || !isSeparatorRow(splitRow(sepEntry.line), CONFIG.reportHeader.length)) {
    report.fail(`${path} line ${sepEntry ? sepEntry.no : headerEntry.no + 1} should be the table's separator row`);
    return null;
  }
  // The table is one run of consecutive lines. A blank line inside it ends the
  // table on the page, and the rows below it render as pipes in a paragraph; a
  // closing line on the line straight after the last row is one more table row
  // to a renderer. Both are read as the reader would see them: refused.
  let i = 6;
  let previous = sepEntry.no;
  for (; i < content.length; i += 1) {
    const entry = content[i];
    if (CONFIG.closingLine.test(entry.line)) break;
    if (entry.no !== previous + 1) {
      report.fail(`${path} line ${entry.no}: a blank line inside the table (after line ${previous}) ends it, so this row and every row after it render as text below the table; the table is one unbroken run of rows`);
      return null;
    }
    previous = entry.no;
    const cells = splitRow(entry.line);
    if (!cells) {
      report.fail(`${path} line ${entry.no} is not a row of the table and not the closing line "Criteria: <n> · PASS <n> · FAIL <n> · defects raised: NONE"; the report carries nothing else. Found "${entry.line.trim()}"`);
      return null;
    }
    if (cells.length !== CONFIG.reportHeader.length) {
      report.fail(`${path} line ${entry.no} is malformed: expected ${CONFIG.reportHeader.length} cells, found ${cells.length}`);
      continue;
    }
    const [ac, short, requirement, verdict, evidence] = cells.map((c) => stripInlineComments(c).trim());
    parts.rows.push({ ac, short, requirement, verdict, evidence, no: entry.no });
  }
  if (i >= content.length) {
    report.fail(`${path} has no closing line "Criteria: <n> · PASS <n> · FAIL <n> · defects raised: NONE"`);
    return parts;
  }
  if (content[i].no === previous + 1) {
    report.fail(`${path} line ${content[i].no}: the closing line follows the last row with no blank line between, so a renderer reads it as one more row of the table; leave a blank line above the closing line`);
  }
  const closing = content[i].line.match(CONFIG.closingLine);
  parts.closing = {
    criteria: Number(closing[1]), pass: Number(closing[2]), fail: Number(closing[3]), defects: closing[4], no: content[i].no,
  };
  for (const extra of content.slice(i + 1)) {
    report.fail(`${path} line ${extra.no} comes after the closing line; the report ends there. Found "${extra.line.trim()}"`);
  }
  return parts;
}

const row = (cells) => `| ${cells.join(' | ')} |`;

/* ---------------------------------------------------------------------- main */

function main() {
  const key = process.argv[2];
  if (!key || !CONFIG.keyPattern.test(key)) {
    const invoked = process.argv[1] || 'scripts/check-validation.js';
    process.stderr.write(`usage: node ${invoked} <WORK-ITEM-KEY>   e.g. PROJ-412\n`);
    process.exit(EXIT.USAGE);
  }

  const ref = syncDefaultBranch();
  const tracked = listTree(ref, CONFIG.designDir);
  const named = (suffix) => tracked.filter((e) => {
    const base = e.path.slice(e.path.lastIndexOf('/') + 1);
    return base.startsWith(`${key}.`) && base.endsWith(suffix);
  });

  // Check 1 -- the design the report validates: one file, readable, its title,
  // its repository, and its criteria table with the requirement column.
  const c1 = check('design document');
  const designs = named(CONFIG.designSuffix).filter((e) => !e.path.endsWith(CONFIG.reviewSuffix));
  if (designs.length !== 1) {
    c1.fail(`expected exactly one "*${CONFIG.designSuffix}" for ${key} on ${ref}, found ${designs.length}${designs.length ? `: ${designs.map((e) => e.path).join(', ')}` : ''}`);
  }
  const designText = designs.length === 1 ? readArtefact(ref, designs[0], c1, 'design document') : null;
  let criteria = null;
  let identity = { title: null, repository: null };
  if (designText !== null) {
    const designLines = maskNonContent(designText);
    rejectHiddenMarkup(designLines, designs[0].path, c1);
    rejectMalformedRows(designLines, designs[0].path, c1);
    identity = designIdentity(designLines, designs[0].path, key, c1);
    criteria = parseCriteria(designLines, sectionRange(designLines, CONFIG.acSection, c1), c1);
  }

  // Check 2 -- the report: one file, readable, the fixed shape, and its three
  // header lines bound to the design on the trunk.
  const c2 = check('validation report');
  const reports = named(CONFIG.reportSuffix);
  if (reports.length !== 1) {
    c2.fail(`expected exactly one "*${CONFIG.reportSuffix}" for ${key} on ${ref}, found ${reports.length}${reports.length ? `: ${reports.map((e) => e.path).join(', ')}` : ''}`);
  }
  const reportText = reports.length === 1 ? readArtefact(ref, reports[0], c2, 'validation report') : null;
  let parts = null;
  if (reportText !== null) {
    const reportPath = reports[0].path;
    rejectHiddenMarkup(String(reportText).split(/\r\n|\n|\r/), reportPath, c2);
    rejectMalformedRows(maskNonContent(reportText), reportPath, c2);
    parts = parseReport(reportText, reportPath, c2);
    if (parts && parts.heading) {
      if (parts.heading.key !== key) {
        c2.fail(`${reportPath} line ${parts.heading.no} is headed as ${parts.heading.key}, not ${key}; a report is evidence about one work item`);
      } else if (identity.title !== null && parts.heading.title !== identity.title) {
        c2.fail(`${reportPath} line ${parts.heading.no} carries the title "${parts.heading.title}" but the design is titled "${identity.title}"; the report repeats the design's title`);
      }
    }
    if (parts && parts.design) {
      if (designs.length === 1 && parts.design.path !== designs[0].path) {
        c2.fail(`${reportPath} line ${parts.design.no} names ${parts.design.path}, but the design for ${key} is ${designs[0].path}`);
      } else if (designs.length === 1) {
        const sha = parts.design.commit;
        if (!commitExists(sha)) {
          if (isShallow()) {
            refuseToJudge(`${reportPath} names hub commit ${sha}, which this shallow clone does not have; fetch full history (fetch-depth: 0) and re-run`, 'shallow-clone');
          }
          c2.fail(`${reportPath} line ${parts.design.no} names hub commit ${sha}, which this repository does not have; the design was not read at a commit of ${ref}`);
        } else if (!isAncestor(sha, ref)) {
          c2.fail(`${reportPath} line ${parts.design.no} names hub commit ${sha}, which is not on ${ref}; the design was read from a branch, not from the trunk`);
        } else {
          const then = blobHash(sha, designs[0].path);
          const now = blobHash(ref, designs[0].path);
          if (then === null) {
            c2.fail(`${reportPath} line ${parts.design.no} names hub commit ${sha}, at which ${designs[0].path} does not exist`);
          } else if (then !== now) {
            c2.fail(`${reportPath} validated ${designs[0].path} as it was at ${sha} (revision ${then}), but ${ref} now carries revision ${now}; the design changed after it was validated, so the report is about an older design`);
          }
        }
      }
    }
    if (parts && parts.repository && identity.repository !== null) {
      if (parts.repository.value !== identity.repository) {
        c2.fail(`${reportPath} line ${parts.repository.no} names repository "${parts.repository.value}" but the design names "${identity.repository}"; a report about the wrong repository is worse than no report`);
      }
    }
    // The spoke commit is checked for shape in parseReport() and for nothing
    // else. It is a commit of another repository, and this file reads one remote.
  }

  // Check 3 -- one row per criterion, the same requirement, a verdict from the
  // set, evidence on every row.
  const c3 = check('criterion verdicts');
  if (criteria === null || parts === null) {
    c3.fail('skipped: no readable design criteria or no readable report table');
  } else {
    const seen = [];
    for (const r of parts.rows) {
      if (!CONFIG.acIdPattern.test(r.ac)) {
        c3.fail(`report row (line ${r.no}) identifier "${r.ac}" does not match AC-<n>`);
        continue;
      }
      if (seen.includes(r.ac)) {
        c3.fail(`report row (line ${r.no}) records ${r.ac} a second time; every criterion has exactly one row`);
        continue;
      }
      seen.push(r.ac);
      const criterion = criteria.find((c) => c.id === r.ac);
      if (!criterion) {
        c3.fail(`report row (line ${r.no}) records ${r.ac}, which the design's "${CONFIG.acSection}" table does not define`);
        continue;
      }
      // A null requirement means the design's own cell was refused in check 1;
      // there is nothing sound to compare against, and the finding is already made.
      if (criterion.requirement !== null && r.requirement !== criterion.requirement) {
        c3.fail(`report row ${r.ac} (line ${r.no}) names requirement "${r.requirement}" but the design's row carries "${criterion.requirement}"; the report repeats the design's requirement column`);
      }
      if (!r.short || isPlaceholder(r.short)) {
        c3.fail(`report row ${r.ac} (line ${r.no}) has ${r.short ? `"${r.short}"` : 'nothing'} in the criterion column; a placeholder there is a criterion nobody restated`);
      }
      if (!CONFIG.verdicts.includes(r.verdict)) {
        c3.fail(`report row ${r.ac} (line ${r.no}) has verdict "${r.verdict}"; the whole verdict set is ${CONFIG.verdicts.join(' / ')}, matched literally`);
      } else if (r.verdict === 'N/A' && !criterion.deprecated) {
        c3.fail(`report row ${r.ac} (line ${r.no}) is N/A but the design does not mark ${r.ac} DEPRECATED; a live criterion passes`);
      } else if (r.verdict === 'FAIL') {
        c3.fail(`report row ${r.ac} (line ${r.no}) is FAIL; a report reaches the hub only when every criterion passes. The failing rows go back to /dev-sprint as a fix round on the same branch`);
      }
      if (!r.evidence || isPlaceholder(r.evidence)) {
        c3.fail(`report row ${r.ac} (line ${r.no}) has ${r.evidence ? `"${r.evidence}"` : 'nothing'} in the evidence column; a verdict with no evidence is an unvalidated criterion wearing a tick`);
      }
    }
    const missing = criteria.filter((c) => !seen.includes(c.id)).map((c) => c.id);
    if (missing.length) {
      c3.fail(`no row for ${missing.join(', ')}; every criterion in the design has one row, including deprecated ones`);
    }
  }

  // Check 4 -- the closing line's counts are the table's, and it raises no
  // defects. The `defects raised:` field stays in the grammar so that a report
  // written before QA moved ahead of the merge still reads; its one legal value
  // is NONE.
  const c4 = check('closing counts');
  if (parts === null || parts.closing === null) {
    c4.fail('skipped: no readable closing line');
  } else {
    const { closing, rows } = parts;
    const passes = rows.filter((r) => r.verdict === 'PASS').length;
    const fails = rows.filter((r) => r.verdict === 'FAIL').length;
    if (closing.criteria !== rows.length) {
      c4.fail(`closing line (line ${closing.no}) says "Criteria: ${closing.criteria}" but the table has ${rows.length} row(s)`);
    }
    if (closing.pass !== passes) {
      c4.fail(`closing line (line ${closing.no}) says "PASS ${closing.pass}" but the table records ${passes}`);
    }
    if (closing.fail !== fails) {
      c4.fail(`closing line (line ${closing.no}) says "FAIL ${closing.fail}" but the table records ${fails}`);
    }
    if (closing.defects !== 'NONE') {
      c4.fail(`closing line (line ${closing.no}) says "defects raised: ${closing.defects}"; the one legal value is NONE, because a failing criterion goes back to /dev-sprint and raises no defect item`);
    }
  }

  // Report -- every check, every finding, then exit.
  const failed = checks.filter((c) => c.failures.length > 0);
  const width = Math.max(...checks.map((c) => c.name.length));
  process.stdout.write(`\n${key} validation check  (against ${ref}, ${CONFIG.remote} -> ${remoteUrl()})\n\n`);
  for (const c of checks) {
    const status = c.failures.length ? 'FAIL' : 'PASS';
    process.stdout.write(`  [${status}] ${c.name.padEnd(width)}`.trimEnd() + '\n');
    for (const f of c.failures) process.stdout.write(`         - ${f}\n`);
  }
  if (parts && parts.spoke && !failed.length) {
    process.stdout.write(`\n  Spoke commit ${parts.spoke.commit}: shape checked only. This file reads one remote, and that commit lives in another.\n`);
  }
  process.stdout.write(
    failed.length
      ? `\nREPORT INCOMPLETE: ${failed.length} of ${checks.length} checks failed. The work item does not move.\n\n`
      : `\nREPORT COMPLETE: ${checks.length} of ${checks.length} checks passed.\n\n`
  );
  process.exit(failed.length ? EXIT.CHECK_FAIL : EXIT.PASS);
}

// The last line of an exit 2, 3 or 4 names this script and its code, so a shell line that hides
// the code, with a pipe or `; echo`, still tells the harness's failure record. Written at once,
// so a process.exit() never loses it.
process.on('exit', (code) => { if (code >= 2 && code <= 4) { try { writeSync(2, `HARNESS EXIT: check-validation ${code}\n`); } catch { /* stderr is closed */ } } });

try {
  main();
} catch (err) {
  process.stderr.write(`INTERNAL ERROR: ${err && err.stack ? err.stack : String(err)}\n`);
  process.exit(EXIT.INTERNAL);
}

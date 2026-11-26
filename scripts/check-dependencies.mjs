#!/usr/bin/env node
// Part of the harness asset library c6f3b4427d58f7c3 (see VERSION.json) · 2026-09-12
/**
 * check-dependencies.mjs -- may this story move on, given the stories it depends on?
 *
 *   usage:  node scripts/check-dependencies.mjs <KEY> --step design|code
 *                [--head <commit> --head-repo <dir>]      (code step only)
 *
 * A story depends on another story when the dependency map of its decomposition
 * has a `blocks` row from its key to the other key. The map is the only source:
 * check-decomposition proves it acyclic, and the item's prose can name a key that
 * is not a dependency. A `To` key can be an item of another slug. A row from
 * the story's key with a Type other than `blocks` or `shares a contract` fails
 * the check, because check-decomposition does not read that column.
 *
 * `--step design` holds the story's design until, for every dependency:
 *
 *   1. the dependency's design is on the trunk and `check-dev-ready <DEP>` exits
 *      0, asked as the dependency's repository. This is question 1 of
 *      story-done.mjs, the same question check-fan-in.mjs asks;
 *   2. the dependency's design is on the trunk at the story's `Hub commit:`, with
 *      the same blob there as on the trunk now. The first half proves that the
 *      story's design was written against the merged design. The second half
 *      fails the story when an amendment changed the dependency's design later;
 *   3. no row in §9 of the story's design names the dependency's design in
 *      `Source` while its status is not `Closed` or `Withdrawn`.
 *
 * When the story has no design on the trunk yet, as at the start of /dev-spec,
 * rules 2 and 3 are not asked, and the output says so.
 *
 * `--step code` holds the story's code merge. It asks every rule above, and
 * three more, for every dependency. Rules 4 and 5 are questions 2 to 4 of
 * story-done.mjs, the same questions check-fan-in.mjs asks:
 *
 *   4. the dependency's validation report passes `check-validation <DEP>`, and
 *      every verdict in it is PASS;
 *   5. the report's `Spoke commit:` is on the trunk of the dependency's spoke, as
 *      the spoke's remote names it now. After a squash or a rebase merge, a trunk
 *      commit with the same tree counts, and so does a run of trunk commits with
 *      the same change, for a branch that was behind the trunk;
 *   6. when the dependency's item names the same Repository: as the story's
 *      item, the trunk commit that rule 5 found is an ancestor of `--head` in
 *      the checkout `--head-repo` names. So the story's branch holds the code
 *      it depends on, and the story was built and tested on that code. A
 *      dependency in another spoke has no commit in the story's head, so rule 6
 *      is not asked for it.
 *
 * `--head` is the 40-hex head commit of the story's pull request, from the
 * pull-request event. `--head-repo` is a checkout of the story's own spoke
 * with its full history. Give both or neither. Without them rule 6 is not
 * asked, and the output says so: /dev-sprint and the fan-in report call the
 * code step without a head.
 *
 * Questions 2 to 4 wait for question 1: a dependency whose design is not merged
 * has no report to read. Rule 6 waits for rule 5 in the same way. The check
 * reaches the spoke of every dependency first. When one spoke cannot be
 * reached, nothing is judged and the exit is 2.
 *
 * Exit codes -- the gate's
 *   0  every dependency is done for the step, or the     DEPENDENCIES DONE
 *      story has no `blocks` row
 *   1  at least one rule failed for at least one          DEPENDENCIES NOT DONE
 *      dependency, or the story has no item file, or its
 *      dependency map cannot be read, or a row from the
 *      story has a Type the check does not know
 *   2  cannot verify: the hub's trunk could not be confirmed, a sibling
 *      check is not installed beside this file, or (code step) the spoke of a
 *      dependency could not be reached. With `--head`: the head repository is
 *      not a git checkout or is shallow, the head commit is not in it, or (with
 *      no rule failed) a trunk commit that rule 6 asks about is not in it
 *   3  usage: no key, a malformed key, no `--step`, `--head` without
 *      `--head-repo` or the reverse, a head that is not a 40-hex commit, or
 *      `--head` with `--step design`
 *   4  internal
 *
 * Design notes
 *   - Same trunk discipline as the gate: it reads origin's default branch, never
 *     the working tree, through syncTrunk in spoke-remote.mjs. HARNESS_TRUNK
 *     names a trunk that is not `main`.
 *   - Runs every rule for every dependency before it exits, so one run lists
 *     everything to fix. Each failure line names the dependency, the rule and the
 *     next step.
 *   - Imports spoke-remote.mjs and story-done.mjs from beside itself. In the
 *     library this file sits in gate/ and those in scripts/. The hub install puts
 *     all of them in scripts/, where the imports resolve. So this file is .mjs in
 *     both layouts, as check-fan-in.mjs is.
 *   - Node standard library only, plus git via child_process.
 */

import { basename, dirname, resolve } from 'node:path';
import { stdout, stderr } from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  EXIT, REPO_ID, SpokeError, reasonLine, git, firstLine, short, syncTrunk,
} from './spoke-remote.mjs';
import {
  QUESTIONS, KEY_PATTERN, REPOSITORY_LINE, sibling, readBlob, readRegistryBlob, reachRepositories, askStory,
} from './story-done.mjs';
import { writeSync } from 'node:fs';

const HERE = dirname(fileURLToPath(import.meta.url));

const CONFIG = {
  remote: 'origin',
  branch: process.env.HARNESS_TRUNK || 'main',
  steps: ['design', 'code'],
  backlogDir: 'docs/backlog',
  recordSuffix: '.decomposition.md',
  itemSuffix: '.item.md',
  designDir: 'docs/designs',
  designSuffix: '.lld.md',
  dependenciesSection: 'Dependency map',
  dependenciesFirst: 'From',
  dependenciesSecond: 'To',
  dependencyColumns: { type: 'Type' },
  blocksType: 'blocks',
  // The two types a dependency map row can carry. Only `blocks` holds a story.
  // check-decomposition.js does not read the Type column, so any other value,
  // "Blocks" included, is refused here rather than read as no dependency.
  dependencyTypes: ['blocks', 'shares a contract'],
  clarSection: 'Clarifications',
  clarColumns: { id: 'ID', source: 'Source', status: 'Status' },
  clarIdLoose: /^CLAR-\S*$/i,
  // The statuses that release a clarification row, as check-dev-ready.js reads them.
  clarReleased: ['Closed', 'Withdrawn'],
  hubCommitLine: /^Hub commit:[ \t]*(\S.*?)\s*$/,
  fullCommit: /^[0-9a-f]{40}$/,
  reportSuffix: '.validation.md',
  siblings: { gate: 'check-dev-ready', validation: 'check-validation' },
  registryPath: 'docs/estate/repositories.json',
};

/* ------------------------------------------------------------------- usage */

function usage(message) {
  const invoked = process.argv[1] || 'scripts/check-dependencies.mjs';
  stderr.write(`${message}\nusage: node ${invoked} <KEY> --step design|code [--head <commit> --head-repo <dir>]   e.g. SHOP-2 --step design\n`);
  process.exit(EXIT.USAGE);
}

const OPTIONS = ['--step', '--head', '--head-repo'];

// A key, `--step <step>`, and for the code step `--head <commit>` with
// `--head-repo <dir>`, in any order. Each option takes the next argument as its value.
function parseArgs(args) {
  const values = {};
  const rest = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!OPTIONS.includes(arg)) {
      if (arg.startsWith('--')) usage(`"${arg}" is not an option; the options are ${OPTIONS.join(', ')}`);
      rest.push(arg);
      continue;
    }
    if (arg in values) usage(`${arg} is given more than once`);
    if (i + 1 >= args.length || OPTIONS.includes(args[i + 1])) usage(`expected a value after ${arg}`);
    values[arg] = args[i + 1];
    i += 1;
  }
  if (!('--step' in values)) usage('expected --step followed by design or code');
  if (rest.length !== 1) usage(`expected exactly one key; got ${rest.length}`);
  const key = rest[0];
  const step = values['--step'];
  if (key.search(KEY_PATTERN) !== 0) usage(`"${key}" is not a work-item key`);
  if (!CONFIG.steps.includes(step)) usage(`"${step}" is not a step; the steps are ${CONFIG.steps.join(' and ')}`);
  const hasHead = '--head' in values;
  if (hasHead !== ('--head-repo' in values)) usage('give --head and --head-repo together, or neither');
  if (!hasHead) return { key, step, head: null };
  if (step !== 'code') usage('--head and --head-repo are valid only with --step code');
  const commit = values['--head'].toLowerCase();
  if (commit.search(CONFIG.fullCommit) !== 0) usage(`"${values['--head']}" is not a full 40-hex commit`);
  return { key, step, head: { commit, dir: resolve(values['--head-repo']) } };
}

/* ------------------------------------------ copied from check-decomposition.js */

// maskNonContent, rejectHiddenMarkup, sectionRange, splitRow, isSeparatorRow,
// tableBlocks, selectTable, readTable, column and unquoted, with the helpers
// they call, are copied from check-decomposition.js. The two files read the
// same dependency map, so they must agree on what a page and a table say.
// Change both files together. The only change here is the form of each
// pattern match: text.search(pattern) in place of pattern.test(text).

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
      if (line.search(new RegExp(`</\\s*${rawHtml}\\s*>`, 'i')) !== -1) { rawHtml = null; blockStart = true; }
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

    if (blockStart && line.search(LINK_DEF) !== -1) {
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
      if (line.search(new RegExp(`</\\s*${tag}\\s*>`, 'i')) !== -1) blockStart = true;
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

    if (line.search(THEMATIC_BREAK) === -1) {
      const li = line.match(LIST_ITEM);
      if (li) listContent = indent + li[2].length + Math.min(Math.max(li[3].length, 1), 4);
    }

    masked.push(stripInlineComments(line));
    blockStart = line.search(ATX_HEADING) !== -1 || line.search(THEMATIC_BREAK) !== -1;
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
  lines.forEach((line, i) => { if (line.search(re) !== -1) starts.push(i); });
  return starts.map((start) => {
    let end = lines.length - 1;
    for (let i = start + 1; i < lines.length; i += 1) {
      if (lines[i].search(SECTION_END) !== -1) { end = i - 1; break; }
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
  if (trimmed.slice(0, -1).search(/(?:^|[^\\])(?:\\\\)*\\$/) !== -1) return null;
  return trimmed
    .slice(1, -1)
    .split(/(?<!\\)\|/)
    .map((c) => c.trim().replace(/\\\|/g, '|'));
}

function isSeparatorRow(cells, width) {
  return !!cells && cells.length === width && cells.every((c) => c.search(/^:?-{2,}:?$/) !== -1);
}

const UNREADABLE_ROW = /^\s*>[\s>]*\|.*\|\s*$/;

function rejectUnreadableRows(lines, range, sectionName, report) {
  for (let i = range[0] + 1; i <= range[1]; i += 1) {
    if (lines[i].search(UNREADABLE_ROW) !== -1) {
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
        opensBlock: i === range[0] + 1 || before.trim() === '' || before.search(HEADING) !== -1,
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
      if (cells && cells[0].search(idPattern) !== -1) {
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

/* -------------------------------------------------------------- hub reads */

// The findings of one read. The copied table readers report through this shape.
function collector() {
  const failures = [];
  return { failures, fail: (msg) => failures.push(msg) };
}

// Every file under docs/backlog/ on the trunk. `:(top)` anchors the pathspec
// to the repository root, so the answer is the same from any directory.
// A path that is not there gives no lines, not an error. So a git error here
// is a fault of this run, never a finding about the hub.
function backlogPaths(head) {
  const out = gitOrInternal(['ls-tree', '-r', '-z', '--full-name', '--name-only', head, '--', `:(top)${CONFIG.backlogDir}`]);
  return out.split('\0').filter(Boolean);
}

function gitOrInternal(args) {
  try {
    return git(args);
  } catch (err) {
    throw new SpokeError(EXIT.INTERNAL, `git ${args[0]} failed: ${firstLine(err.stderr) || err.message}`);
  }
}

// A shallow clone cuts the history that rule 2 reads. A commit beyond its
// depth then looks like a commit off the trunk, so the check refuses to judge.
// check-dev-ready.js refuses in the same case.
function refuseIfShallow(path) {
  let shallow;
  try {
    shallow = git(['rev-parse', '--is-shallow-repository']).trim() === 'true';
  } catch (err) {
    shallow = true;
  }
  if (shallow) {
    throw new SpokeError(EXIT.CANNOT_VERIFY, `this clone is shallow. The check cannot place the "Hub commit:" line of ${path} in the trunk's history, and it cannot tell a commit off the trunk from a commit beyond the clone's depth. Fetch the full history (git fetch --unshallow, or fetch-depth: 0 in CI) and run again`, 'shallow-clone');
  }
}

// The item files of one key: docs/backlog/<SLUG>/<KEY>.item.md, in any slug.
// A string comparison, so no regular expression is built from the key.
function itemPathsOf(paths, key) {
  const suffix = `/${key}${CONFIG.itemSuffix}`;
  return paths.filter((p) => p.endsWith(suffix) && p.split('/').length === 4);
}

// git merge-base --is-ancestor exits 0 for yes and 1 for no. Any other exit is a
// fault of this run, never a finding. The caller asks hasCommit first, because
// git exits 128 for a commit that the hub does not have.
function isAncestor(commit, head) {
  try {
    git(['merge-base', '--is-ancestor', commit, head]);
    return true;
  } catch (err) {
    if (err.status === 1) return false;
    throw new SpokeError(EXIT.INTERNAL, `git merge-base --is-ancestor failed: ${firstLine(err.stderr) || err.message}`);
  }
}

function hasCommit(commit) {
  try {
    git(['cat-file', '-e', `${commit}^{commit}`]);
    return true;
  } catch (err) {
    return false;
  }
}

function blobAt(commit, path) {
  try {
    return git(['rev-parse', '--verify', '--quiet', `${commit}:${path}`]).trim() || null;
  } catch (err) {
    return null;
  }
}

// The oldest trunk commit, along the first parent, that adds `path`. Each
// merge on the trunk is one first-parent commit, so two files that a single
// pull request adds share this commit.
function firstAdded(head, path) {
  const out = gitOrInternal(['log', '--first-parent', '--diff-filter=A', '--format=%H', head, '--', `:(top)${path}`]);
  const all = out.split('\n').filter(Boolean);
  return all.length ? all[all.length - 1] : null;
}

/* --------------------------------------------------- the story's own head */

// Rule 6 reads history in the checkout of the story's own spoke. A directory
// that git cannot read, a shallow clone, or a clone without the head cannot
// answer it, so the check refuses to judge.
function checkHead(head) {
  const inDir = (args) => git(['-C', head.dir, ...args]);
  try {
    inDir(['rev-parse', '--git-dir']);
  } catch (err) {
    throw new SpokeError(EXIT.CANNOT_VERIFY, `--head-repo ${head.dir} is not a git checkout (${firstLine(err.stderr) || err.message}). Give the checkout of the story's own spoke`, 'not-a-checkout');
  }
  let shallow;
  try {
    shallow = inDir(['rev-parse', '--is-shallow-repository']).trim() === 'true';
  } catch (err) {
    shallow = true;
  }
  if (shallow) {
    throw new SpokeError(EXIT.CANNOT_VERIFY, `--head-repo ${head.dir} is a shallow clone. The check cannot tell a commit that is not in the head's history from a commit beyond the clone's depth. Fetch the full history (git fetch --unshallow, or fetch-depth: 0 in CI) and run again`, 'shallow-clone');
  }
  if (!hasCommitIn(head.dir, head.commit)) {
    throw new SpokeError(EXIT.CANNOT_VERIFY, `the head ${head.commit} is not a commit in --head-repo ${head.dir}. Fetch the pull request's head into that checkout, and run again`, 'commit-not-found');
  }
}

function hasCommitIn(dir, commit) {
  try {
    git(['-C', dir, 'cat-file', '-e', `${commit}^{commit}`]);
    return true;
  } catch (err) {
    return false;
  }
}

// git merge-base --is-ancestor exits 0 for yes and 1 for no. Any other exit is a
// fault of this run, never a finding.
function isAncestorIn(dir, commit, head) {
  try {
    git(['-C', dir, 'merge-base', '--is-ancestor', commit, head]);
    return true;
  } catch (err) {
    if (err.status === 1) return false;
    throw new SpokeError(EXIT.INTERNAL, `git merge-base --is-ancestor failed in ${dir}: ${firstLine(err.stderr) || err.message}`);
  }
}

/* ----------------------------------------------------------------- stories */

// One story, read from its one item file. A key with no item file, or with
// two, is still listed. It fails with its fault named.
function readStory(head, paths, key) {
  const found = itemPathsOf(paths, key);
  const faults = [];
  let repo = null;
  let slug = null;
  if (found.length === 0) {
    faults.push(`${key} has no item file on ${CONFIG.branch} (${CONFIG.backlogDir}/<SLUG>/${key}${CONFIG.itemSuffix})`);
  } else if (found.length > 1) {
    faults.push(`${key} has ${found.length} item files on ${CONFIG.branch} (${found.join(', ')}); a key names one story`);
  } else {
    slug = found[0].split('/')[2];
    const text = readBlob(head, found[0]);
    const line = text === null ? null : text.match(REPOSITORY_LINE);
    if (!line) faults.push(`${found[0]} has no "Repository: <id>" line`);
    else if (line[1].search(REPO_ID) !== 0) faults.push(`${found[0]} has the Repository: line "${line[1]}", which is not a repository id`);
    else repo = line[1];
  }
  return { key, repo, slug, path: found.length === 1 ? found[0] : null, faults };
}

// The `blocks` rows of the dependency map whose From is the story's key, in the
// order the map lists them, each To key once.
function readDependencies(head, key, slug) {
  const recordPath = `${CONFIG.backlogDir}/${slug}${CONFIG.recordSuffix}`;
  const text = readBlob(head, recordPath);
  if (text === null) {
    throw new SpokeError(EXIT.FAIL, `no decomposition record for "${slug}" on ${CONFIG.branch} (${recordPath}); run /decompose`);
  }
  const report = collector();
  const lines = maskNonContent(text);
  rejectHiddenMarkup(lines, recordPath, report);
  const table = readTable(lines, CONFIG.dependenciesSection, CONFIG.dependenciesFirst, CONFIG.dependenciesSecond, KEY_PATTERN, report, { tableOptional: true });
  const typeCol = table && table.header ? column(table, CONFIG.dependencyColumns.type, CONFIG.dependenciesSection, report) : -1;
  if (report.failures.length) {
    throw new SpokeError(EXIT.FAIL, `the dependency map in ${recordPath} cannot be read; run check-decomposition ${slug} first:\n  - ${report.failures.join('\n  - ')}`);
  }
  const deps = [];
  const unknown = [];
  for (const { cells, no } of table.rows) {
    if (unquoted(cells[0]) !== key) continue;
    const type = unquoted(cells[typeCol]);
    if (!CONFIG.dependencyTypes.includes(type)) {
      unknown.push(`line ${no}: the row ${key} -> ${unquoted(cells[1])} has the Type "${type}", which is not ${CONFIG.dependencyTypes.map((t) => `"${t}"`).join(' or ')}`);
      continue;
    }
    if (type !== CONFIG.blocksType) continue;
    const to = unquoted(cells[1]);
    if (!deps.includes(to)) deps.push(to);
  }
  if (unknown.length) {
    throw new SpokeError(EXIT.FAIL, `the dependency map in ${recordPath} has a Type that the check cannot read. Correct the Type in the dependency map with /decompose:\n  - ${unknown.join('\n  - ')}`);
  }
  return { recordPath, deps };
}

/* -------------------------------------------------------- the story's design */

// The story's own design: the commit its Hub commit: line names, and the open
// rows of its §9. Null when the design is not on the trunk.
function readOwnDesign(head, path) {
  const text = readBlob(head, path);
  if (text === null) return null;
  refuseIfShallow(path);
  const lines = maskNonContent(text);
  const own = { hubCommit: null, hubFault: null, clars: [], clarFault: null };

  const claims = lines.map((l) => l.match(CONFIG.hubCommitLine)).filter(Boolean).map((m) => m[1]);
  if (claims.length !== 1) {
    own.hubFault = `${path} carries ${claims.length} "Hub commit:" lines, not one`;
  } else if (claims[0].search(CONFIG.fullCommit) !== 0) {
    own.hubFault = `${path} has "Hub commit: ${claims[0]}", which is not a full commit hash`;
  } else if (!hasCommit(claims[0]) || !isAncestor(claims[0], head)) {
    own.hubFault = `${path} has "Hub commit: ${short(claims[0])}", which is not a commit on ${CONFIG.branch}`;
  } else {
    own.hubCommit = claims[0];
  }

  const report = collector();
  rejectHiddenMarkup(lines, path, report);
  const table = readTable(lines, CONFIG.clarSection, CONFIG.clarColumns.id, 'Question', CONFIG.clarIdLoose, report, { tableOptional: true });
  if (table && table.header) {
    const idCol = column(table, CONFIG.clarColumns.id, CONFIG.clarSection, report);
    const sourceCol = column(table, CONFIG.clarColumns.source, CONFIG.clarSection, report);
    const statusCol = column(table, CONFIG.clarColumns.status, CONFIG.clarSection, report);
    if (idCol >= 0 && sourceCol >= 0 && statusCol >= 0) {
      own.clars = table.rows
        .map(({ cells }) => ({ id: cells[idCol], source: cells[sourceCol], status: cells[statusCol] }))
        .filter((c) => !CONFIG.clarReleased.includes(c.status));
    }
  }
  if (report.failures.length) own.clarFault = report.failures.join('; ');
  return own;
}

// Does a Source cell name this design? The cell names a design by its path,
// then the usual "§ title" and "L<n>". A word can carry the path in backticks,
// in brackets, as a markdown link, or with a period or a colon after it. So
// each word loses those characters at both ends, and a link splits at its
// brackets, so that its target is a word of its own. The last path part of a
// word is compared with the file name, so no regular expression is built from
// the key. evals/lib/graders.mjs carries the same test. Change both together.
const SOURCE_TRIM = /^[`()[\]<>.:,;]+|[`()[\]<>.:,;]+$/g;
function namesDesign(source, file) {
  return source.split(/\s+/)
    .flatMap((word) => word.replace(SOURCE_TRIM, '').split(/[()\]]/))
    .map((word) => word.replace(SOURCE_TRIM, ''))
    .some((word) => word.slice(word.lastIndexOf('/') + 1) === file);
}

/* ------------------------------------------------------------- the rules */

// The rules of one dependency: the three of the design step, and for the code
// step (`repositories` is set) questions 2 to 4 of story-done.mjs as well.
// Returns the lines of its block, and one failure line for each failed rule.
// The next step for a fault in the story's own design. /dev-spec rewrites a
// design only while its pull request is open. It refuses a merged design, and a
// merged design changes only by an amendment pull request.
function reviseOwn(key) {
  return `While ${key}'s design pull request is open, run /dev-spec ${key} again. After it merges, amend ${key}'s design by pull request with a fresh review, as /dev-sprint precondition 9 says.`;
}

function askStep(dep, key, own, hub, siblings, repositories, head) {
  const depFile = `${dep.key}${CONFIG.designSuffix}`;
  const depPath = `${CONFIG.designDir}/${depFile}`;
  const ownPath = `${CONFIG.designDir}/${key}${CONFIG.designSuffix}`;
  const rules = [];
  const failures = [];
  const cannot = [];
  const fail = (text) => failures.push(`${dep.key}: ${text}`);
  for (const f of dep.faults) {
    rules.push({ label: 'item file', ok: false, detail: f });
    fail(`the dependency map names it, and ${f}. Correct the dependency map, or cut the item with /decompose.`);
  }

  // 1. The design is on the trunk, and the pickup gate passes it. The code step
  // goes on to the report and the spoke only when question 1 passes, so the
  // design is asked alone first.
  const [q1] = askStory(dep, hub, new Map(), siblings, { through: 1 });
  rules.push(q1);
  const merged = readBlob(hub.head, depPath) !== null;
  if (!q1.ok) {
    const detail = q1.detail.replace(/^no: /, '');
    fail(repositories
      ? `${detail}. Run this check again after ${dep.key}'s design ${merged ? 'passes the pickup gate' : 'merges'} and its code is on its trunk.`
      : `${detail}. ${key}'s design can merge after ${dep.key}'s design ${merged ? 'passes the pickup gate' : 'merges'}.`);
  }

  // Code step only, questions 2 to 4 of story-done.mjs: the report, its verdicts, and the spoke's trunk.
  let codeOk = true;
  let trunkCommit = null;
  if (repositories) {
    if (q1.ok) {
      // The same answer to question 1 comes again, so only 2 to 4 are kept.
      const rest = askStory(dep, hub, repositories, siblings).slice(1);
      rules.push(...rest);
      const [report, verdicts, onTrunk] = rest;
      const repo = dep.repo || 'its repository';
      if (!report.ok) {
        // A report on the trunk that check-validation refuses has gone through QA
        // and failed. Only a missing report is a /qa-sprint that has not run.
        const reportPath = `${CONFIG.designDir}/${dep.key}${CONFIG.reportSuffix}`;
        const detail = report.detail.replace(/^no: /, '');
        fail(readBlob(hub.head, reportPath) === null
          ? `${detail}. Run /qa-sprint ${dep.key}, and merge its report.`
          : `${dep.key}'s validation report does not pass check-validation (${detail}). ${dep.key} must pass QA before ${key}'s code can merge.`);
      }
      else if (!verdicts.ok) fail(`${verdicts.detail.replace(/^no: /, '')}. Run /dev-sprint ${dep.key} to fix the failing criteria.`);
      else if (!onTrunk.ok) {
        const detail = onTrunk.detail.replace(/^no: /, '');
        // The next step follows the reason story-done.mjs gives. Only a story that
        // has not merged is fixed by waiting.
        if (onTrunk.reason === 'not-merged') {
          fail(`its code is not on the trunk of ${repo}: ${detail}. Run this check again after ${dep.key} merges.`);
        } else if (onTrunk.reason === 'merged-changed') {
          fail(`${short(onTrunk.named)} on the trunk of ${repo} names ${dep.key} in its message, but no trunk commit holds the change QA validated at ${short(onTrunk.validated)}. The code on the trunk is not the code QA validated. A person compares the two commits, and then reverts the merge, or opens a new pull request for ${dep.key} with /dev-sprint ${dep.key} and runs /qa-sprint ${dep.key} on its head.`);
        } else if (onTrunk.reason === 'unknown-commit') {
          fail(`${detail}. Check that ${dep.key}'s report names the head commit of its code pull request, and that the server of ${repo} serves that commit.`);
        } else if (['no-repository', 'wrong-repository', 'not-listed'].includes(onTrunk.reason)) {
          fail(`${detail}. Fix ${dep.key}'s item, its report or the list of repositories.`);
        } else {
          throw new SpokeError(EXIT.INTERNAL, `story-done.mjs gave question 4 the reason "${onTrunk.reason}", which this file does not know; the two files are from different versions`);
        }
      }
      codeOk = rest.every((r) => r.ok);
      // Question 4 names the trunk commit that holds the report's code. Rule 6 reads it.
      if (codeOk) trunkCommit = onTrunk.commit;
    } else {
      for (const label of [QUESTIONS.report, QUESTIONS.verdicts, QUESTIONS.merged]) {
        rules.push({ label, ok: false, detail: 'not asked: needs 1' });
      }
      codeOk = false;
    }
  }

  // 2. The design is at the story's Hub commit, and unchanged since.
  const pinLabel = `pin: ${dep.key}'s design at ${key}'s Hub commit, unchanged since`;
  if (own === null) {
    rules.push({ label: pinLabel, ok: true, detail: `not asked: ${key} has no design on the trunk yet` });
  } else if (!q1.ok) {
    rules.push({ label: pinLabel, ok: false, detail: 'not asked: needs 1' });
  } else if (own.hubFault) {
    rules.push({ label: pinLabel, ok: false, detail: `no: ${own.hubFault}` });
    fail(`${own.hubFault}. ${reviseOwn(key)}`);
  } else {
    const at = own.hubCommit;
    const then = blobAt(at, depPath);
    const now = blobAt(hub.head, depPath);
    if (then === null) {
      const depFirst = firstAdded(hub.head, depPath);
      const ownFirst = firstAdded(hub.head, ownPath);
      if (depFirst !== null && depFirst === ownFirst) {
        rules.push({ label: pinLabel, ok: false, detail: `no: ${dep.key}'s design and ${key}'s design first appear in the same commit ${short(depFirst)}` });
        fail(`its design and ${key}'s design first appear in the same commit ${short(depFirst)}. Split them: merge ${dep.key}'s design first. ${reviseOwn(key)}`);
      } else {
        rules.push({ label: pinLabel, ok: false, detail: `no: ${dep.key}'s design is not on the trunk at ${key}'s Hub commit ${short(at)}` });
        fail(`its design is not on the trunk at ${key}'s Hub commit ${short(at)}. ${key}'s design must read ${dep.key}'s merged design. ${reviseOwn(key)}`);
      }
    } else if (then !== now) {
      rules.push({ label: pinLabel, ok: false, detail: `no: the design is blob ${short(then)} at ${key}'s Hub commit ${short(at)}, and blob ${short(now)} on ${CONFIG.branch} at ${short(hub.head)}` });
      fail(`its design changed after ${key}'s Hub commit. ${reviseOwn(key)}`);
    } else {
      rules.push({ label: pinLabel, ok: true, detail: 'yes' });
    }
  }

  // 3. No clarification that is still open names the design.
  const clarLabel = `clarifications: no open row names ${depFile}`;
  if (own === null) {
    rules.push({ label: clarLabel, ok: true, detail: `not asked: ${key} has no design on the trunk yet` });
  } else if (own.clarFault) {
    rules.push({ label: clarLabel, ok: false, detail: `no: §9 of ${ownPath} cannot be read: ${own.clarFault}` });
    fail(`§9 of ${key}'s design cannot be read. ${reviseOwn(key)}`);
  } else {
    const open = own.clars.filter((c) => namesDesign(c.source, depFile));
    if (open.length === 0) {
      rules.push({ label: clarLabel, ok: true, detail: 'yes' });
    } else {
      rules.push({ label: clarLabel, ok: false, detail: `no: ${open.map((c) => `${c.id} is ${c.status} and names ${depFile}`).join(', ')}` });
      for (const c of open) fail(`${c.id} is ${c.status} and names ${depFile}. Close it from ${dep.key}'s merged design. ${reviseOwn(key)}`);
    }
  }

  // 6. Code step with a head only: the story's head holds the dependency's
  // merged code, when the two stories share a spoke.
  let headOk = true;
  if (repositories && head) {
    const headLabel = `head: ${key}'s head ${short(head.commit)} holds ${dep.key}'s merged code`;
    if (dep.repo !== head.repo) {
      rules.push({ label: headLabel, ok: true, detail: `not asked: ${dep.key} is in ${dep.repo || 'no known repository'} and ${key} is in ${head.repo}, so ${key}'s head cannot hold ${dep.key}'s code` });
    } else if (trunkCommit === null) {
      rules.push({ label: headLabel, ok: false, detail: 'not asked: needs 4' });
      headOk = false;
    } else {
      const { trunk } = repositories.get(dep.repo);
      headOk = false;
      if (!hasCommitIn(head.dir, trunkCommit)) {
        rules.push({ label: headLabel, ok: false, detail: `cannot verify: ${short(trunkCommit)} is not a commit in ${head.dir}` });
        cannot.push(`${dep.key}: ${short(trunkCommit)}, the commit on the trunk ${trunk} of ${dep.repo} that holds ${dep.key}'s code, is not in --head-repo ${head.dir}. Fetch the trunk into that checkout, and run again.`);
      } else if (isAncestorIn(head.dir, trunkCommit, head.commit)) {
        rules.push({ label: headLabel, ok: true, detail: `yes: ${short(trunkCommit)} on the trunk ${trunk} is an ancestor of ${short(head.commit)}` });
        headOk = true;
      } else {
        rules.push({ label: headLabel, ok: false, detail: `no: ${short(trunkCommit)} on the trunk ${trunk} is not an ancestor of ${short(head.commit)}` });
        fail(`${key}'s head ${short(head.commit)} does not hold ${dep.key}'s merged code, ${short(trunkCommit)} on the trunk ${trunk} of ${dep.repo}. Bring ${key}'s branch up to the trunk: run /dev-sprint ${key} again before the pull request opens, or use the forge's "Update branch". The head then moves, so run /qa-sprint ${key} on the new head, and then run qa-gate again.`);
      }
    }
  }

  // The summary names the next step when the one failure is a design that is
  // not merged yet. Any other failure has its own next step.
  const onlyUnmerged = !merged && dep.faults.length === 0 && rules.every((r) => r === q1 || r.ok || r.detail === 'not asked: needs 1');
  return { ok: failures.length === 0 && cannot.length === 0 && codeOk && headOk, rules, failures, cannot, onlyUnmerged };
}

/* --------------------------------------------------------------------- main */

// The code step reads the spoke of every dependency, and decides nothing until
// every spoke has answered. A spoke that is not in the registry is not a fault
// of the read: question 4 reports it for its story.
function reachSpokes(hub, stories) {
  const registry = readRegistryBlob(hub.head, hub.ref);
  const ids = [...new Set(stories.map((s) => s.repo).filter(Boolean))];
  const repositories = reachRepositories(ids, registry);
  stdout.write('  repositories\n');
  const width = Math.max(1, ...ids.map((i) => i.length));
  const unreachable = [];
  for (const id of ids) {
    const state = repositories.get(id);
    if (!state.listed) stdout.write(`    [FAIL] ${id.padEnd(width)}  not in ${CONFIG.registryPath}\n`);
    else if (state.unreachable) { unreachable.push(id); stdout.write(`    [CANNOT VERIFY] ${id.padEnd(width)}  ${state.unreachable}\n`); }
    else stdout.write(`    [OK] ${id.padEnd(width)}  trunk ${state.trunk} at ${short(state.head)}\n`);
  }
  if (ids.length === 0) stdout.write('    (no dependency names a repository)\n');
  stdout.write('\n');
  if (unreachable.length) {
    for (const id of unreachable) {
      stdout.write(`CANNOT VERIFY: ${id} could not be reached (${repositories.get(id).unreachable}). Set the secret that checks.env names in SPOKE_READ_TOKEN_SECRET, or check the spoke's remote.\n`);
    }
    stdout.write(`\nNothing is judged until every spoke answers.\n\n${reasonLine(repositories.get(unreachable[0]).reason)}`);
    process.exit(EXIT.CANNOT_VERIFY);
  }
  return repositories;
}

const plural = (n) => (n === 1 ? 'dependency is' : 'dependencies are');

// The hub's design-gate builds its candidate trunk from the merge commit of the
// pull-request event. A re-run of the same job uses that commit again, so it
// does not see a fix that merged after the event.
const RERUN_DESIGN_GATE = 'On the design pull request, after the fix merges, push a commit or close and reopen the pull request, so that design-gate reads the new trunk. A re-run of the failed job reads the old trunk.';

function listed(keys) {
  return keys.length === 1 ? keys[0] : `${keys.slice(0, -1).join(', ')} and ${keys[keys.length - 1]}`;
}

function main() {
  const { key, step, head } = parseArgs(process.argv.slice(2));
  if (head) checkHead(head);
  const caller = basename(process.argv[1] || 'check-dependencies.mjs');
  const siblings = { gate: sibling(CONFIG.siblings.gate, HERE, caller) };
  // Only the code step runs the validation check.
  if (step === 'code') siblings.validation = sibling(CONFIG.siblings.validation, HERE, caller);
  const hub = syncTrunk(CONFIG.remote, CONFIG.branch);

  const paths = backlogPaths(hub.head);
  const story = readStory(hub.head, paths, key);
  if (story.slug === null) throw new SpokeError(EXIT.FAIL, `${story.faults.join('; ')}; run /decompose`);
  const { deps } = readDependencies(hub.head, key, story.slug);

  stdout.write(`\n${key} dependencies, step ${step}  (against ${CONFIG.branch} at ${short(hub.head)}, ${CONFIG.remote} -> ${hub.url})\n\n`);
  if (deps.length === 0) {
    stdout.write(`DEPENDENCIES DONE: ${key} has no ${CONFIG.blocksType} row in the dependency map.\n\n`);
    process.exit(EXIT.PASS);
  }

  const own = readOwnDesign(hub.head, `${CONFIG.designDir}/${key}${CONFIG.designSuffix}`);
  const stories = deps.map((depKey) => {
    const dep = readStory(hub.head, paths, depKey);
    if (depKey.search(KEY_PATTERN) !== 0) dep.faults.push(`"${depKey}" is not a work-item key`);
    return dep;
  });
  const repositories = step === 'code' ? reachSpokes(hub, stories) : null;
  if (head) {
    // Rule 6 compares each dependency's Repository: with the story's own.
    if (story.repo === null) {
      throw new SpokeError(EXIT.FAIL, `${story.faults.join('; ')}. The check cannot tell which dependency shares ${key}'s spoke. Correct ${key}'s item with /decompose`);
    }
    head.repo = story.repo;
    stdout.write(`  head: ${short(head.commit)} in ${head.dir}, the checkout of ${key}'s spoke ${story.repo}\n\n`);
  } else if (step === 'code') {
    stdout.write(`  head: not asked. No --head was given, so the check does not ask that ${key}'s head holds the code of a dependency in its own spoke.\n\n`);
  }
  const results = stories.map((dep) => ({ dep, ...askStep(dep, key, own, hub, siblings, repositories, head) }));

  for (const { dep, ok, rules } of results) {
    stdout.write(`  [${ok ? 'PASS' : 'FAIL'}] ${dep.key}  ${dep.repo || '(repository unknown)'}\n`);
    for (const r of rules) stdout.write(`         ${r.label}: ${r.detail}\n`);
    stdout.write('\n');
  }
  const failures = results.flatMap((r) => r.failures);
  for (const line of failures) stdout.write(`  ${line}\n`);
  if (failures.length) stdout.write('\n');
  const cannot = results.flatMap((r) => r.cannot);
  for (const line of cannot) stdout.write(`  CANNOT VERIFY: ${line}\n`);
  if (cannot.length) stdout.write('\n');

  const n = results.length;
  const done = results.filter((r) => r.ok).length;
  if (done === n) {
    stdout.write(`DEPENDENCIES DONE: ${n} of ${n} ${plural(n)} done for the ${step} step.\n\n`);
    process.exit(EXIT.PASS);
  }
  // A verified failure is a fact whatever the checkout lacks, so it decides the exit.
  if (failures.length === 0 && cannot.length) {
    stdout.write(`CANNOT VERIFY: ${done} of ${n} ${plural(n)} done for the ${step} step, and the check cannot judge the rest. Each CANNOT VERIFY line above names the next step.\n\n${reasonLine('commit-not-found')}`);
    process.exit(EXIT.CANNOT_VERIFY);
  }
  const failed = results.filter((r) => !r.ok);
  // The code step waits for more than a design, so only the design step names one.
  const next = step === 'design' && failed.every((r) => r.onlyUnmerged)
    ? (failed.length === 1
      ? `${key}'s design can merge after ${failed[0].dep.key}'s design merges.`
      : `${key}'s design can merge after the designs of ${listed(failed.map((r) => r.dep.key))} merge.`)
    : 'Each failure line above names the next step.';
  stdout.write(`DEPENDENCIES NOT DONE: ${done} of ${n} ${plural(n)} done for the ${step} step. ${next}${step === 'design' ? ` ${RERUN_DESIGN_GATE}` : ''}\n\n`);
  process.exit(EXIT.FAIL);
}

// The last line of an exit 2, 3 or 4 names this script and its code, so a shell line that hides
// the code, with a pipe or `; echo`, still tells the harness's failure record. Written at once,
// so a process.exit() never loses it.
process.on('exit', (code) => { if (code >= 2 && code <= 4) { try { writeSync(2, `HARNESS EXIT: check-dependencies ${code}\n`); } catch { /* stderr is closed */ } } });

try {
  main();
} catch (err) {
  if (err instanceof SpokeError) {
    const label = err.exit === EXIT.CANNOT_VERIFY ? 'CANNOT VERIFY' : err.exit === EXIT.INTERNAL ? 'INTERNAL' : 'FAIL';
    stderr.write(`${label}: ${err.message}\n${reasonLine(err.reason)}`);
    process.exit(err.exit);
  }
  stderr.write(`INTERNAL: ${err && err.stack ? err.stack : String(err)}\n`);
  process.exit(EXIT.INTERNAL);
}

#!/usr/bin/env node
// Part of the harness asset library c6f3b4427d58f7c3 (see VERSION.json) · 2026-11-14
/**
 * read-discovery.mjs — the discovery maps of earlier stories that read the same
 * folders of one spoke, each row marked current or drifted at one commit.
 *
 *   usage:  node scripts/read-discovery.mjs <repo-id> --paths <a,b,...>
 *               [--at <commit|12-hex>] [--keys <K1,K2>] [--registry <file>]
 *
 *   <repo-id>   a key in docs/estate/repositories.json: the spoke the story lands in
 *   --paths     the paths the change touches, comma-separated, relative to the
 *               spoke's root. The folder of a path is its parent folder, and a
 *               file at the root has the folder ".". A path is in the form git
 *               prints: no "./" and no doubled "/". A path that ends with one
 *               "/" names that folder itself: "src/ledger/" is the folder
 *               src/ledger
 *   --at        read the spoke at this commit instead of the trunk head, as
 *               read-spoke.mjs does. A full 40-character commit, or its first
 *               12 characters
 *   --keys      work-item keys, comma-separated: print the maps of these keys,
 *               with their text, instead of the index
 *   --registry  the registry file, when it is not the hub's own
 *
 * The maps are the files docs/designs/<KEY>.discovery.md on the hub's origin
 * trunk. The trunk is force-fetched and confirmed against HARNESS_TRUNK
 * (default: the branch the origin reports), as read-context.mjs --pinned does,
 * so a map on an open branch is never read. A map is in scope when its
 * `Repository:` is <repo-id>, and some path in its Files read or Ruled out
 * table has the folder of some --paths entry. A map the script cannot rule
 * out is in scope: its `Repository:` cannot be read, or one of those tables or
 * paths cannot be read. Such a map always breaks the grammar, so it stops the
 * read with exit 1.
 *
 * A map in scope or asked for must also be the bytes its design pins:
 * docs/designs/<KEY>.lld.md on the trunk carries one `Discovery:` line, and its
 * 12-hex starts the map's blob hash. Otherwise no person approved the map with
 * the design, and the read stops with exit 1.
 *
 * A row's pin compares the 12-hex `Blob` the map stored with the blob of the
 * same path at the pinned spoke commit: `current`, `drift: <old> → <new>`, or
 * `drift: <old> → removed`. The map's own `Commit:` is never needed for this.
 *
 * What it prints, always:
 *
 *   Repository: <id>
 *   Commit: <40-hex>                      the spoke commit the pins are read at
 *   Trunk: <branch>                       (or "not asked" with --at)
 *   Paths: <p1>, <p2>
 *   Maps: <n>                             the maps in scope
 *   ---
 *
 * Then, with no --keys, the INDEX: one line per map in scope, in key order,
 * and no bodies:
 *
 *   <KEY> · commit <12-hex> · files <n> (<d> drift) · searches <n> · ruled out <n> · folders <f1>, <f2>
 *
 * With --keys, for each key in the order given:
 *
 *   Map: docs/designs/<KEY>.discovery.md
 *   Cite: <KEY>.discovery.md@<12-hex>      the first 12 characters of the map's blob
 *   <the map's text, with a Pin column added to Files read and Ruled out>
 *   ---
 *
 * The map grammar is kept in step by hand with check-dev-ready.js (its CONFIG
 * keys discovery* and checkDiscoveryMap). This script refuses what the gate
 * refuses, so a map the gate merged reads here, and a map that reads here
 * passes the gate's grammar.
 *
 * Exit codes
 *   0  read, including no map in scope
 *   1  a map in scope breaks the grammar or is not the bytes its design pins,
 *      or a key in --keys has no map on the trunk, or its map reads another
 *      repository. Every map and every key is checked before exit, and each
 *      finding names the map and the rule
 *   2  cannot verify: no registry, the hub's origin cannot be fetched or reports
 *      a trunk other than HARNESS_TRUNK, the spoke is unreachable, or --at
 *      names a commit the spoke will not give up
 *   3  usage: no --paths, an empty path, a path not in the form git prints,
 *      a bad --at, a bad key, an unknown option, or a repository id not in the list
 *   4  internal
 */

import { stdout, stderr } from 'node:process';
import {
  EXIT, REPO_ID, SpokeError, git, atProblem, pinAt,
  registryPath, readRegistry, validateRegistry, resolveSpokeTrunk, cacheDir, short,
  resolveDefaultBranch, quietGitEnv, firstLine,
} from './spoke-remote.mjs';

/* ------------------------------------------------------------- the grammar */

// The map grammar. Kept in step by hand with check-dev-ready.js (CONFIG, the
// discovery* keys). Change one, and change the other in the same commit.
const CONFIG = {
  designDir: 'docs/designs',
  keyPattern: /^[A-Z][A-Z0-9]{1,9}-\d+$/,
  discoveryLabel: 'Discovery',
  discoverySuffix: '.discovery.md',
  designSuffix: '.lld.md',
  discoveryPin: /^([A-Z][A-Z0-9]{1,9}-\d+)\.discovery\.md@([0-9a-f]{12})$/,
  discoveryBlob: /^[0-9a-f]{12}$/,
  discoveryCommit: /^[0-9a-f]{40}$/,
  discoverySearch: /^--(?:grep|files) \S/,
  discoveryDrift: /^drift: ([0-9a-f]{12}) → (?:([0-9a-f]{12})|removed)$/,
  discoveryCurrent: 'current',
  discoveryNone: 'NONE',
  discoveryPath: /^(?!.*(?:^|\/)\.{1,2}(?:\/|$))[^\s,:\/]+(?:\/[^\s,:\/]+)*$/,
  discoveryCount: /^\d+$/,
  discoveryTables: [
    { title: 'Files read', columns: ['Path', 'Blob', 'Why'], none: false },
    { title: 'Searches', columns: ['Search', 'Hits', 'Kept'], none: false },
    { title: 'Ruled out', columns: ['Path', 'Blob', 'Search', 'Reason'], none: true },
    { title: 'Reused', columns: ['Map', 'Path', 'Pin'], none: true },
  ],
  placeholderToken: /^(?:[-–—]+|\?+|tbd|todo|n\/?a|na|none|nil|pending|placeholder|seebelow|x+)$/i,
};

/* ------------------------------------------------------- non-content masking */

// Kept in step by hand with maskNonContent() in check-dev-ready.js: a reader
// reads the same lines the gate reads. A region a reader does not read as
// content is blanked, and every line keeps its number.
const FENCE = /^( {0,3})(`{3,}|~{3,})(.*)$/;
const RAW_TEXT_HTML = /^ {0,3}<(pre|script|style|textarea)(?:[\s/>]|$)/i;
// One closing pattern for each raw-text tag, so no pattern is built from file text.
const RAW_TEXT_CLOSE = {
  pre: /<\/\s*pre\s*>/i, script: /<\/\s*script\s*>/i, style: /<\/\s*style\s*>/i, textarea: /<\/\s*textarea\s*>/i,
};
const LIST_ITEM = /^( *)([-*+]|\d{1,9}[.)])( +|$)/;
const ATX_HEADING = /^ {0,3}#{1,6}(?:\s|$)/;
const THEMATIC_BREAK = /^ {0,3}(?:(?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})$/;
const COMMENT_BLOCK = { '<!--': '-->', '{/*': '*/}' };
const COMMENT_BLOCK_OPEN = /^ {0,3}(<!--|\{\/\*)/;
const LINK_DEF = /^ {0,3}\[(?:[^\]\\]|\\.)*\]:(.*)$/;
const TITLE_CLOSER = { '"': '"', "'": "'", '(': ')' };

const has = (text, pattern) => text.search(pattern) !== -1;

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

function splitLines(text) {
  return String(text).split(/\r\n|\n|\r/);
}

function maskNonContent(text) {
  const lines = splitLines(text);
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
      if (has(line, RAW_TEXT_CLOSE[rawHtml])) { rawHtml = null; blockStart = true; }
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

    if (blockStart && has(line, LINK_DEF)) {
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
      if (has(line, RAW_TEXT_CLOSE[tag])) blockStart = true;
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

    if (!has(line, THEMATIC_BREAK)) {
      const li = line.match(LIST_ITEM);
      if (li) listContent = indent + li[2].length + Math.min(Math.max(li[3].length, 1), 4);
    }

    masked.push(stripInlineComments(line));
    blockStart = has(line, ATX_HEADING) || has(line, THEMATIC_BREAK);
  }
  return masked;
}

/* ------------------------------------------------------------- hidden markup */

// Kept in step by hand with rejectHiddenMarkup() in check-dev-ready.js.
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
      report.fail(`${path} carries HTML ${found} markup (line ${i + 1}). The page does not show what this markup holds. Write the map as markdown, and put HTML you describe in backticks.`);
      return;
    }
  }
}

/* --------------------------------------------------------- sections, tables */

// Kept in step by hand with the same functions in check-dev-ready.js.
const SECTION_END = /^#{1,2}\s/;
const HEADING = /^ {0,3}#{1,6}\s/;
const INVISIBLE = /[\u200B-\u200F\u202A-\u202E\u2060\uFEFF\u00AD]/g;

// `heading` is a title from CONFIG, never text from a file or the command line.
function sectionRanges(lines, heading) {
  const re = new RegExp(`^##\\s+(?:\\d+\\.\\s+)?${heading}\\s*$`);
  const starts = [];
  lines.forEach((line, i) => { if (has(line, re)) starts.push(i); });
  return starts.map((start) => {
    let end = lines.length - 1;
    for (let i = start + 1; i < lines.length; i += 1) {
      if (has(lines[i], SECTION_END)) { end = i - 1; break; }
    }
    return [start, end];
  });
}

function splitRow(line) {
  const trimmed = line.replace(INVISIBLE, '').trim();
  if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) return null;
  if (has(trimmed.slice(0, -1), /(?:^|[^\\])(?:\\\\)*\\$/)) return null;
  return trimmed
    .slice(1, -1)
    .split(/(?<!\\)\|/)
    .map((c) => c.trim().replace(/\\\|/g, '|'));
}

function isSeparatorRow(cells, width) {
  return !!cells && cells.length === width && cells.every((c) => has(c, /^:?-{2,}:?$/));
}

function tableBlocks(lines, range) {
  const blocks = [];
  let current = null;
  for (let i = range[0] + 1; i <= range[1]; i += 1) {
    const isRow = lines[i].replace(INVISIBLE, '').trim().startsWith('|');
    if (!isRow) { current = null; continue; }
    if (!current) {
      const before = i === 0 ? '' : lines[i - 1];
      current = { opensBlock: i === range[0] + 1 || before.trim() === '' || has(before, HEADING), rows: [] };
      blocks.push(current);
    }
    current.rows.push({ line: lines[i], no: i + 1 });
  }
  return blocks;
}

function rejectMalformedRows(lines, path, report) {
  for (const block of tableBlocks(lines, [-1, lines.length - 1])) {
    if (block.rows.length < 2) continue;
    const header = splitRow(block.rows[0].line);
    if (!header || !isSeparatorRow(splitRow(block.rows[1].line), header.length)) continue;
    for (const entry of block.rows.slice(2)) {
      const cells = splitRow(entry.line);
      if (!cells) {
        report.fail(`${path} line ${entry.no}: the table row does not end with an unescaped |, so its cells cannot be counted against its header (line ${block.rows[0].no}). End the row with |, and write a literal pipe in a cell as \\|.`);
      } else if (cells.length !== header.length) {
        report.fail(`${path} line ${entry.no}: the table row has ${cells.length} cells and its header (line ${block.rows[0].no}) has ${header.length}. Write one row on one line, and a literal pipe in a cell as \\|.`);
      }
    }
  }
}

// Kept in step by hand with isPlaceholder() in check-dev-ready.js.
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
  if (has(compact, CONFIG.placeholderToken)) return true;
  if (!has(compact, /[a-z0-9]/i)) return true;
  return compact.length < 2;
}

/* ------------------------------------------------------------- one map */

// The one value of a `<label>:` head line. `label` is a constant.
function mapHeadLine(lines, mapPath, label, expected, report) {
  const re = new RegExp(`^${label}:[ \\t]*(\\S.*?)\\s*$`);
  const hits = [];
  lines.forEach((line, i) => {
    const m = line.match(re);
    if (m) hits.push({ no: i + 1, value: m[1] });
  });
  if (hits.length === 0) {
    report.fail(`${mapPath} carries no "${label}:" line. Write exactly one "${label}: ${expected}" line.`);
    return null;
  }
  if (hits.length > 1) {
    report.fail(`${mapPath} carries ${hits.length} "${label}:" lines (lines ${hits.map((h) => h.no).join(', ')}). A map has one "${label}:" line.`);
    return null;
  }
  return hits[0];
}

// The rows of one map table as { header, rows: [{ no, cells }] }, where
// `header` is the line number of the header row, or null for NONE. Null when
// the section cannot be read.
function mapTable(lines, mapPath, spec, report) {
  const ranges = sectionRanges(lines, spec.title);
  const header = `| ${spec.columns.join(' | ')} |`;
  if (ranges.length === 0) {
    report.fail(`${mapPath} carries no "## ${spec.title}" section. Write the section with the table "${header}".`);
    return null;
  }
  if (ranges.length > 1) {
    report.fail(`${mapPath} carries the "## ${spec.title}" section ${ranges.length} times (lines ${ranges.map((r) => r[0] + 1).join(', ')}). Write each section once.`);
    return null;
  }
  const range = ranges[0];
  const body = lines.slice(range[0] + 1, range[1] + 1).map((l) => l.trim()).filter((l) => l !== '');
  const blocks = tableBlocks(lines, range).filter((b) => {
    const cells = splitRow(b.rows[0].line);
    return cells !== null && cells.join('|') === spec.columns.join('|');
  });
  const hasNone = body.includes(CONFIG.discoveryNone);
  if (hasNone && !spec.none) {
    report.fail(`${mapPath}: the "${spec.title}" section is ${CONFIG.discoveryNone}. The map lists at least one row in the table "${header}".`);
    return null;
  }
  if (hasNone && body.length === 1) return { header: null, rows: [] };
  if (hasNone) {
    report.fail(`${mapPath}: the "${spec.title}" section carries ${CONFIG.discoveryNone} and other content. Write the table "${header}" or ${CONFIG.discoveryNone} alone.`);
    return null;
  }
  if (blocks.length !== 1) {
    const or = spec.none ? ` or the token ${CONFIG.discoveryNone}` : '';
    const found = blocks.length === 0 ? 'no table' : `${blocks.length} tables`;
    report.fail(`${mapPath}: the "${spec.title}" section carries ${found} with the header "${header}". Write one table${or}.`);
    return null;
  }
  const block = blocks[0];
  if (block.rows.length < 2 || !isSeparatorRow(splitRow(block.rows[1].line), spec.columns.length)) {
    report.fail(`${mapPath} line ${block.rows[0].no}: the "${spec.title}" header has no separator row under it, so the page shows text and not a table.`);
    return null;
  }
  // A row with the wrong number of cells is a rejectMalformedRows finding.
  const rows = block.rows.slice(2)
    .map((r) => ({ no: r.no, cells: splitRow(r.line) }))
    .filter((r) => r.cells !== null && r.cells.length === spec.columns.length);
  if (rows.length === 0 && !spec.none) {
    report.fail(`${mapPath}: the "${spec.title}" table has no rows. The map lists at least one.`);
  }
  return { header: block.rows[0].no, rows };
}

// A cell with the backticks around it removed. Only a Search cell is read this way.
function unquoted(cell) {
  const m = cell.match(/^`([^`]*)`$/);
  return m ? m[1].trim() : cell;
}

/**
 * Check one map against the grammar, as checkDiscoveryMap() in
 * check-dev-ready.js checks it, less the rules that need a design. Every rule
 * runs. `hub` is { ref, trunk } for the reused-map rule. Returns what the
 * selection and the print need, and the findings. The look-up of a Reused pin
 * in the trunk's history waits for historyFindings(), because only a map in
 * scope or asked for needs it.
 */
function readMap(key, text, hub) {
  const mapPath = `${CONFIG.designDir}/${key}${CONFIG.discoverySuffix}`;
  const findings = [];
  const report = { fail: (msg) => findings.push(msg) };

  const lines = maskNonContent(text);
  rejectHiddenMarkup(lines, mapPath, report);
  rejectMalformedRows(lines, mapPath, report);

  const ticket = mapHeadLine(lines, mapPath, 'Ticket', key, report);
  if (ticket !== null && ticket.value !== key) {
    report.fail(`${mapPath} line ${ticket.no}: "Ticket: ${ticket.value}" is not ${key}. A map is evidence about one work item.`);
  }
  const repository = mapHeadLine(lines, mapPath, 'Repository', '<repository-id>', report);
  const commit = mapHeadLine(lines, mapPath, 'Commit', '<40-hex>', report);
  if (commit !== null && commit.value.match(CONFIG.discoveryCommit) === null) {
    report.fail(`${mapPath} line ${commit.no}: "Commit: ${commit.value}" is not a commit hash of 40 lowercase hex characters.`);
  }

  const [filesSpec, searchSpec, ruledSpec, reusedSpec] = CONFIG.discoveryTables;
  const filesRead = mapTable(lines, mapPath, filesSpec, report);
  const searches = mapTable(lines, mapPath, searchSpec, report);
  const ruledOut = mapTable(lines, mapPath, ruledSpec, report);
  const reused = mapTable(lines, mapPath, reusedSpec, report);

  const checkPath = (r, path) => {
    if (path.match(CONFIG.discoveryPath) === null) {
      report.fail(`${mapPath} line ${r.no}: the path "${path}" is not a relative path in the repository. Write it as git prints it: no leading or trailing /, no . or .. segment, no doubled /, and no whitespace, comma or colon.`);
      return false;
    }
    return true;
  };
  const checkBlob = (r, blob) => {
    if (blob.match(CONFIG.discoveryBlob) === null) {
      report.fail(`${mapPath} line ${r.no}: the blob "${blob}" is not 12 lowercase hex characters. Copy the first 12 characters of the file's blob hash at the map's commit.`);
    }
  };
  const checkReason = (r, column, cell, what) => {
    if (cell.trim() === '' || isPlaceholder(cell)) {
      report.fail(`${mapPath} line ${r.no}: the "${column}" cell "${cell}" is empty or a placeholder. Say ${what}.`);
    }
  };

  const history = [];
  const readPaths = new Set();
  for (const r of filesRead ? filesRead.rows : []) {
    const [path, blob, why] = r.cells;
    if (checkPath(r, path)) readPaths.add(path);
    checkBlob(r, blob);
    checkReason(r, 'Why', why, 'why the seat read the file');
  }

  const searchSet = new Set();
  for (const r of searches ? searches.rows : []) {
    const [cell, hits, kept] = r.cells;
    const search = unquoted(cell);
    searchSet.add(search);
    if (search.search(CONFIG.discoverySearch) !== 0) {
      report.fail(`${mapPath} line ${r.no}: the search "${search}" is not a scripts/read-spoke.mjs search. Write the arguments after the repository id, starting "--grep " or "--files ".`);
    }
    const counts = [['Hits', hits], ['Kept', kept]].filter(([, v]) => v.match(CONFIG.discoveryCount) === null);
    for (const [column, v] of counts) {
      report.fail(`${mapPath} line ${r.no}: the "${column}" cell "${v}" is not a whole number of 0 or more.`);
    }
    if (counts.length === 0 && Number(kept) > Number(hits)) {
      report.fail(`${mapPath} line ${r.no}: "Kept" is ${kept} and "Hits" is ${hits}. A search keeps no more hits than it found.`);
    }
  }

  for (const r of ruledOut ? ruledOut.rows : []) {
    const [path, blob, cell, reason] = r.cells;
    checkPath(r, path);
    checkBlob(r, blob);
    const search = unquoted(cell);
    if (searches !== null && !searchSet.has(search)) {
      report.fail(`${mapPath} line ${r.no}: the search "${search}" is not in the "${searchSpec.title}" table. A path is ruled out by a search the map lists.`);
    }
    checkReason(r, 'Reason', reason, 'why the path was ruled out');
  }

  for (const r of reused ? reused.rows : []) {
    const [mapCell, path, pinCell] = r.cells;
    const other = mapCell.match(CONFIG.discoveryPin);
    const pathOk = checkPath(r, path);
    if (other === null) {
      report.fail(`${mapPath} line ${r.no}: the map "${mapCell}" is not "<OTHER-KEY>${CONFIG.discoverySuffix}@<12-hex>".`);
    } else if (other[1] === key) {
      report.fail(`${mapPath} line ${r.no}: the map "${mapCell}" is this story's own map. A map reuses the rows of another story's map.`);
    } else {
      // The pinned bytes are a map a person merged: the trunk carries them
      // now, or some commit on the trunk held them.
      // The trunk's history answers only for a map that binds the read: see
      // historyFindings().
      const otherPath = `${CONFIG.designDir}/${other[1]}${CONFIG.discoverySuffix}`;
      const now = hubBlob(hub.ref, otherPath);
      if (now === null || !now.startsWith(other[2])) history.push({ no: r.no, otherPath, pin: other[2] });
    }
    if (pinCell === CONFIG.discoveryCurrent) continue;
    const drift = pinCell.match(CONFIG.discoveryDrift);
    if (drift === null) {
      report.fail(`${mapPath} line ${r.no}: the pin "${pinCell}" is not "${CONFIG.discoveryCurrent}", "drift: <12-hex> → <12-hex>" or "drift: <12-hex> → removed".`);
    } else if (drift[2] !== undefined && pathOk && filesRead !== null && !readPaths.has(path)) {
      report.fail(`${mapPath} line ${r.no}: ${path} drifted to ${drift[2]} since ${mapCell}, and the "${filesSpec.title}" table does not list it: a file that moved is read again. Read the file and add its row.`);
    }
  }

  const rowsOf = (t) => (t === null ? [] : t.rows);
  return {
    key,
    mapPath,
    findings,
    repository: repository === null ? null : repository.value,
    commit: commit === null ? null : commit.value,
    filesRead,
    ruledOut,
    searchCount: rowsOf(searches).length,
    // The Reused pins the trunk does not carry now, for historyFindings().
    history,
    // Paths that pass the path rule, for the selection by folder.
    paths: [...rowsOf(filesRead), ...rowsOf(ruledOut)].map((r) => r.cells[0]).filter((p) => p.match(CONFIG.discoveryPath) !== null),
    // False when a path table cannot be read or a path cell breaks the path
    // rule. The selection then cannot rule the map out by folder.
    pathsKnown: filesRead !== null && ruledOut !== null
      && [...filesRead.rows, ...ruledOut.rows].every((r) => r.cells[0].match(CONFIG.discoveryPath) !== null),
  };
}

/* -------------------------------------------------------------- the hub */

// The hub's trunk: the default branch its origin reports, confirmed against
// HARNESS_TRUNK when that is set, and force-fetched with its whole history.
// The same flow as hubTrunk() in read-context.mjs.
function hubTrunk(root) {
  let url;
  let gitDir;
  try {
    url = git(['remote', 'get-url', 'origin'], { cwd: root }).trim();
    gitDir = git(['rev-parse', '--absolute-git-dir'], { cwd: root }).trim();
  } catch (err) {
    throw new SpokeError(EXIT.CANNOT_VERIFY, `the hub checkout has no origin to read its trunk from: ${firstLine(err.stderr) || err.message}`);
  }
  const { trunk } = resolveDefaultBranch(url, gitDir);
  const named = process.env.HARNESS_TRUNK;
  if (named && named !== trunk) {
    throw new SpokeError(EXIT.CANNOT_VERIFY, `HARNESS_TRUNK is "${named}", and the hub's origin reports its default branch as "${trunk}". The two must agree before a map is read`);
  }
  const ref = `refs/remotes/origin/${trunk}`;
  try {
    const shallow = git(['rev-parse', '--is-shallow-repository'], { cwd: root }).trim() === 'true';
    git(['fetch', '--quiet', '--force', '--no-tags', ...(shallow ? ['--unshallow'] : []), 'origin', `+refs/heads/${trunk}:${ref}`], { cwd: root, env: quietGitEnv() });
  } catch (err) {
    throw new SpokeError(EXIT.CANNOT_VERIFY, `cannot fetch ${trunk} from the hub's origin ${url}: ${firstLine(err.stderr) || err.message}`);
  }
  return { trunk, ref };
}

function hubBlob(ref, path) {
  try {
    return git(['rev-parse', '--verify', '--quiet', `${ref}:${path}`]).trim() || null;
  } catch {
    return null;
  }
}

// Whether some commit on `ref` held `path` with a blob whose hash starts with
// `pin`. hubTrunk() fetched the whole history, so a shallow clone here is a
// fault of the checkout, and the read cannot verify.
function pinOnHistory(ref, path, pin) {
  if (git(['rev-parse', '--is-shallow-repository']).trim() === 'true') {
    throw new SpokeError(EXIT.CANNOT_VERIFY, `the hub checkout is shallow after the fetch, so the history of ${path} cannot be read`);
  }
  const commits = git(['log', '--format=%H', ref, '--', path]).split('\n').filter(Boolean);
  return commits.some((commit) => {
    const blob = hubBlob(commit, path);
    return blob !== null && blob.startsWith(pin);
  });
}

// The findings of the Reused pins that the trunk does not carry now: each must
// be on the trunk's history. Run only for a map in scope or asked for.
function historyFindings(map, hub) {
  return map.history
    .filter((h) => !pinOnHistory(hub.ref, h.otherPath, h.pin))
    .map((h) => `${map.mapPath} line ${h.no}: no commit on the hub's trunk ever held ${h.otherPath} at ${h.pin}. Reuse the rows of a map a person merged.`);
}

// A finding when the design beside the map does not pin the map's bytes on the
// trunk, or null. The gate reads the map only through the design's
// "Discovery:" line, so a map that no design pins was never approved at these
// bytes. `mapBlob` is the map's blob hash on the trunk.
function designPinFinding(ref, key, mapPath, mapBlob) {
  const designPath = `${CONFIG.designDir}/${key}${CONFIG.designSuffix}`;
  const entry = treeEntries(git(['ls-tree', '-z', '--full-name', ref, '--', `:(top,literal)${designPath}`]))[0];
  if (entry === undefined || entry.type !== 'blob' || entry.mode === '120000') {
    return `${mapPath} has no design beside it: ${designPath} is not on the hub's trunk. A map is read only when the design beside it pins it.`;
  }
  const lineRe = new RegExp(`^${CONFIG.discoveryLabel}:[ \\t]*(\\S.*?)\\s*$`);
  const claims = maskNonContent(git(['cat-file', 'blob', entry.object]))
    .map((line) => line.match(lineRe))
    .filter((m) => m !== null)
    .map((m) => m[1]);
  if (claims.length !== 1) {
    return `${designPath} carries ${claims.length} "${CONFIG.discoveryLabel}:" lines, so it pins no one map. ${mapPath} is read only when its design pins it on one line.`;
  }
  const pin = claims[0].match(CONFIG.discoveryPin);
  if (pin === null || pin[1] !== key || !mapBlob.startsWith(pin[2])) {
    return `${designPath} pins "${claims[0]}", and ${mapPath} is at ${mapBlob.slice(0, 12)} on the hub's trunk. A map is read only at the bytes that its design pins.`;
  }
  return null;
}

// The entries of one tree listing, from `git ls-tree -z`.
function treeEntries(out) {
  return out.split('\0').filter(Boolean).map((entry) => {
    const tab = entry.indexOf('\t');
    const [mode, type, object] = entry.slice(0, tab).split(/\s+/);
    return { mode, type, object, path: entry.slice(tab + 1) };
  });
}

// Every docs/designs/<KEY>.discovery.md on the trunk, as { key, path, entry }.
function trunkMaps(ref) {
  const out = git(['ls-tree', '-z', '--full-name', ref, '--', `:(top)${CONFIG.designDir}/`]);
  const maps = new Map();
  for (const e of treeEntries(out)) {
    const name = e.path.slice(CONFIG.designDir.length + 1);
    if (!name.endsWith(CONFIG.discoverySuffix)) continue;
    const key = name.slice(0, -CONFIG.discoverySuffix.length);
    if (key.match(CONFIG.keyPattern) === null) continue;
    maps.set(key, { key, path: e.path, entry: e });
  }
  return maps;
}

// The map's text, or a finding when the trunk holds something other than a file.
function mapText(m, findings) {
  if (m.entry.mode === '120000') {
    findings.push(`${m.path} is a symbolic link on the hub's trunk, not a discovery map`);
    return null;
  }
  if (m.entry.type !== 'blob') {
    findings.push(`${m.path} is not a file on the hub's trunk. Git reports it as a ${m.entry.type}`);
    return null;
  }
  const text = git(['cat-file', 'blob', m.entry.object]);
  if (text.trim() === '') {
    findings.push(`${m.path} is empty on the hub's trunk. An empty file is not a discovery map`);
    return null;
  }
  return text;
}

/* -------------------------------------------------------------- the spoke */

// The blob of each path at the pinned commit, or no entry for a path that is
// not a file there.
function spokeBlobs(dir, commit, paths) {
  if (!paths.length) return new Map();
  const out = git(['--git-dir', dir, '--literal-pathspecs', 'ls-tree', '-z', '--full-name', commit, '--', ...paths]);
  return new Map(treeEntries(out).filter((e) => e.type === 'blob').map((e) => [e.path, e.object]));
}

function pinOf(blobs, path, stored) {
  const now = blobs.get(path);
  if (now === undefined) return `drift: ${stored} → removed`;
  return now.startsWith(stored) ? CONFIG.discoveryCurrent : `drift: ${stored} → ${now.slice(0, 12)}`;
}

/* -------------------------------------------------------------- folders */

function folderOf(path) {
  const i = path.lastIndexOf('/');
  return i === -1 ? '.' : path.slice(0, i);
}

// A --paths entry without the one "/" that may end it.
function withoutFolderSlash(path) {
  return path.endsWith('/') ? path.slice(0, -1) : path;
}

// The folder a --paths entry names: the folder itself when it ends with "/",
// else its parent folder.
function askedFolder(p) {
  return p.endsWith('/') ? withoutFolderSlash(p) : folderOf(p);
}

/* ------------------------------------------------------------------ usage */

function usage(message) {
  const invoked = process.argv[1] || 'scripts/read-discovery.mjs';
  stderr.write(`${message}\nusage: node ${invoked} <repo-id> --paths <a,b,...> [--at <commit|12-hex>] [--keys <K1,K2>] [--registry <file>]\n`);
  process.exit(EXIT.USAGE);
}

function parseArgs(argv) {
  const out = { positional: [], at: null, paths: null, keys: null, registry: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--at' || a === '--paths' || a === '--keys' || a === '--registry') {
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

// The comma-separated entries of a list option, each trimmed. An empty entry is usage.
function listOption(flag, value) {
  const entries = value.split(',').map((p) => p.trim());
  if (entries.some((p) => p === '')) usage(`${flag} "${value}" holds an empty path or key. Separate the entries with one comma each`);
  return entries;
}

function keyOrder(a, b) {
  const [pa, na] = a.split('-');
  const [pb, nb] = b.split('-');
  if (pa !== pb) return pa < pb ? -1 : 1;
  return Number(na) - Number(nb);
}

/* ------------------------------------------------------------------- main */

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.positional.length !== 1) usage('expected exactly one argument: <repo-id>, the spoke the story lands in');
  const id = args.positional[0];
  if (id.match(REPO_ID) === null) usage(`"${id}" is not a repository id (letters, digits, ".", "_", "-")`);
  if (args.paths === null) usage('--paths is required: the paths the change touches select the maps by folder');
  const paths = listOption('--paths', args.paths);
  for (const p of paths) {
    if (withoutFolderSlash(p).match(CONFIG.discoveryPath) === null) usage(`--paths "${p}" is not a relative path in the repository. Write it as git prints it: no leading /, no . or .. segment, no doubled /, and no whitespace or colon. One trailing / names a folder`);
  }
  if (args.at !== null && atProblem(args.at)) usage(atProblem(args.at));
  const keys = args.keys === null ? null : [...new Set(listOption('--keys', args.keys))];
  for (const k of keys || []) {
    if (k.match(CONFIG.keyPattern) === null) usage(`--keys "${k}" is not a work-item key (for example PROJ-412)`);
  }

  // The spoke's entry in the hub's list, as read-spoke.mjs pin() reads it.
  const regPath = registryPath(args.registry);
  const registry = readRegistry(regPath);
  const problems = validateRegistry(registry, regPath);
  if (problems.length) {
    throw new SpokeError(EXIT.FAIL, `the registry is not well formed. Run check-registry first:\n  - ${problems.join('\n  - ')}`);
  }
  const entry = registry.repositories[id];
  if (!entry) {
    const known = Object.keys(registry.repositories);
    usage(`"${id}" is not in ${regPath}. Listed: ${known.length ? known.join(', ') : '(nothing yet)'}. Add it with /add-repo`);
  }

  const hub = hubTrunk('.');

  // The spoke commit the pins are read at: the trunk head, or --at.
  const dir = cacheDir(id);
  let commit;
  let trunk = 'not asked';
  if (args.at === null) ({ trunk, head: commit } = resolveSpokeTrunk(entry, dir));
  else commit = pinAt(id, entry, dir, args.at);

  // Every map on the trunk, read once. A map out of scope and not asked for
  // binds nobody, so its findings are dropped.
  const onTrunk = trunkMaps(hub.ref);
  const read = new Map();
  const findings = [];
  for (const m of onTrunk.values()) {
    const own = [];
    const text = mapText(m, own);
    read.set(m.key, { ...m, text, map: text === null ? null : readMap(m.key, text, hub), own });
  }

  // A map is in scope unless the script can rule it out: it names another
  // repository, or every path it lists is readable and none is in an asked
  // folder. A map the script cannot read well enough to rule out is in scope,
  // so its findings stop the read and are never dropped.
  const asked = new Set(paths.map(askedFolder));
  const ruledOut = (m) => (m.repository !== null && m.repository !== id)
    || (m.pathsKnown && !m.paths.some((p) => asked.has(folderOf(p))));
  const inScope = [...read.values()]
    .filter((r) => r.map === null || !ruledOut(r.map))
    .sort((a, b) => keyOrder(a.key, b.key));

  const checked = new Set();
  // The checks that only a map in scope or asked for needs run here: the
  // design's pin of the map, and the trunk's history of each Reused pin.
  const report = (r) => {
    if (checked.has(r.key)) return;
    checked.add(r.key);
    findings.push(...r.own);
    if (r.map === null) return;
    findings.push(...r.map.findings, ...historyFindings(r.map, hub));
    const unpinned = designPinFinding(hub.ref, r.key, r.path, r.entry.object);
    if (unpinned !== null) findings.push(unpinned);
  };
  inScope.forEach(report);
  for (const k of keys || []) {
    const r = read.get(k);
    const path = `${CONFIG.designDir}/${k}${CONFIG.discoverySuffix}`;
    if (r === undefined) {
      findings.push(`${k}: ${path} is not on the hub's trunk (${hub.trunk}). Ask for a key whose map a person merged`);
      continue;
    }
    report(r);
    if (r.map !== null && r.map.repository !== null && r.map.repository !== id) {
      findings.push(`${k}: ${path} reads "${r.map.repository}", not "${id}". A map is read for the repository it names`);
    }
  }

  const header = [`Repository: ${id}`, `Commit: ${commit}`, `Trunk: ${trunk}`, `Paths: ${paths.join(', ')}`, `Maps: ${inScope.length}`];
  if (findings.length) {
    header.push(`Status: NOT READ: ${findings.length} finding(s)`);
    stdout.write(`${header.join('\n')}\n`);
    stderr.write(`FAIL: a discovery map cannot be read, and no seat gets it until it is fixed:\n  - ${findings.join('\n  - ')}\n`);
    process.exit(EXIT.FAIL);
  }
  stdout.write(`${header.join('\n')}\n---\n`);

  if (keys === null) {
    for (const r of inScope) {
      const files = r.map.filesRead.rows;
      const blobs = spokeBlobs(dir, commit, files.map((x) => x.cells[0]));
      const drift = files.filter((x) => pinOf(blobs, x.cells[0], x.cells[1]) !== CONFIG.discoveryCurrent).length;
      const folders = [...new Set(r.map.paths.map(folderOf))].sort();
      stdout.write(`${r.key} · commit ${r.map.commit.slice(0, 12)} · files ${files.length} (${drift} drift) · searches ${r.map.searchCount} · ruled out ${r.map.ruledOut.rows.length} · folders ${folders.join(', ')}\n`);
    }
    return;
  }

  for (const k of keys) {
    const r = read.get(k);
    const lines = splitLines(r.text);
    const tables = [r.map.filesRead, r.map.ruledOut].filter((t) => t.header !== null);
    const blobs = spokeBlobs(dir, commit, tables.flatMap((t) => t.rows.map((x) => x.cells[0])));
    // Line numbers are 1-based and match the raw text, because masking keeps every line.
    const append = (no, cell) => { lines[no - 1] = `${lines[no - 1].replace(/\s+$/, '')} ${cell} |`; };
    for (const t of tables) {
      append(t.header, 'Pin');
      lines[t.header] = `${lines[t.header].replace(/\s+$/, '')}---|`;
      for (const x of t.rows) append(x.no, pinOf(blobs, x.cells[0], x.cells[1]));
    }
    const body = lines.join('\n').replace(/^\n+/, '').replace(/\n*$/, '\n');
    stdout.write(`Map: ${r.path}\nCite: ${k}${CONFIG.discoverySuffix}@${short(r.entry.object)}\n${body}---\n`);
  }
}

try {
  main();
} catch (err) {
  if (err instanceof SpokeError) {
    stderr.write(`${err.exit === EXIT.CANNOT_VERIFY ? 'CANNOT VERIFY' : 'FAIL'}: ${err.message}\n`);
    process.exit(err.exit);
  }
  stderr.write(`INTERNAL: ${err && err.stack ? err.stack : String(err)}\n`);
  process.exit(EXIT.INTERNAL);
}

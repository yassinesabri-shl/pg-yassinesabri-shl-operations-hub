#!/usr/bin/env node
// Part of the harness asset library c6f3b4427d58f7c3 (see VERSION.json) · 2026-11-20
/**
 * check-bug.mjs — the bug-record check.
 *
 *   usage:  node scripts/check-bug.mjs PLDC-731
 *           HARNESS_REPO=<spoke id> node scripts/check-bug.mjs PLDC-731
 *
 * `/bugfix <KEY>` takes one Jira bug and writes two files into one pull request in the hub:
 *
 *   docs/bugs/<KEY>.bug.md           the bug record: the ticket's snapshot, the claim, the pinned
 *                                    commit, the chain to the root cause, the reproduction, the
 *                                    files to change and the clash report
 *   docs/bugs/<KEY>.bug-review.md    the critic's final review of the record
 *
 * A person merges that pull request, and the merge is the whole acceptance of the root cause.
 * This file runs on that pull request, through the hub's `bug-gate` job, and again on the trunk.
 * With HARNESS_REPO it also runs in the spoke's `story-gate` job on a `bugfix/<KEY>-<slug>`
 * branch, from a clone of the hub, and then the record must be merged and written for that
 * repository. Five checks, all run before the exit:
 *
 *   1. the bug record has its shape: one Key, Repository, Verdict and Size line, each section
 *      once and not empty, no placeholder, the reproduction layer and file, and the files to change;
 *   2. the ticket snapshot keeps the ticket's text: its source, its fetch time for this key, its
 *      type and its description;
 *   3. the chain has at least one link, each in the form `<repo>@<12-hex>:<path>:<line>`, each
 *      in a listed repository, and one in the record's own repository;
 *   4. the repository is in the hub's list, and is the one HARNESS_REPO names, where it is set;
 *   5. the review carries the approved verdict, `Mode: bug-review`, the key, and the blob hash of
 *      the record on the trunk now. One changed byte unapproves it.
 *
 * Exit codes
 *   0  complete              -> the record is reviewed, and the bug may be fixed
 *   1  at least one failure  -> not complete; all findings printed
 *   2  cannot verify         -> refused to judge (stale or unreachable remote)
 *   3  usage error           -> a bad key, or HARNESS_REPO that is not a repository id
 *   4  internal error        -> unexpected; treat as not complete
 *
 * Design notes
 *   - Same trunk discipline as the other checks: reads the DEFAULT BRANCH, never the working
 *     tree, confirms the branch name against the remote's own default branch, and force-fetches
 *     first. Runs on a pull request through the candidate-trunk construction the CI workflows use.
 *     HARNESS_TRUNK names a non-`main` trunk.
 *   - Reads no tracker. The gate holds no Jira credential, so it cannot prove that the snapshot
 *     matches the ticket: the person who merges attests to that, and the snapshot's
 *     `Fetched: <KEY>@<updated>` line says which version of the ticket it copies.
 *   - The masking, table and hidden-markup functions are copied from check-intake.js and kept the
 *     same on purpose: the checks read a page the way a reader sees it.
 *   - Imports spoke-remote.mjs from beside itself. The hub install lands both in scripts/, so this
 *     file is .mjs in both layouts.
 *   - Node standard library only, plus git via child_process.
 *
 * What this check cannot see
 *   - Whether the chain is the root cause. The critic reads the code at the pinned commit in
 *     `Mode: bug-review`, and the person who merges reads the chain.
 *   - Whether the reproduction fails on the pinned commit. The spoke's frozen test proves that,
 *     and the spoke's `story-gate` judges the fix.
 */

import { stdout, stderr } from 'node:process';
import { EXIT, REPO_ID, REGISTRY_PATH, SpokeError, git, firstLine, quietGitEnv, resolveDefaultBranch, short } from './spoke-remote.mjs';

/**
 * The hub's trunk, force-fetched and confirmed against the remote's default branch. `branch` names
 * the trunk and does not choose one, so a name the remote does not confirm is "cannot verify".
 */
function syncTrunk(remote, branch) {
  let url;
  try {
    url = git(['remote', 'get-url', remote]).trim();
  } catch {
    throw new SpokeError(EXIT.CANNOT_VERIFY, `this checkout has no remote called ${remote}; run from the hub checkout`);
  }
  const dir = git(['rev-parse', '--absolute-git-dir']).trim();
  const ref = `${remote}/${branch}`;
  try {
    git(['fetch', '--no-tags', '--prune', '--force', remote, `+refs/heads/${branch}:refs/remotes/${ref}`], { env: quietGitEnv() });
  } catch (err) {
    throw new SpokeError(EXIT.CANNOT_VERIFY, `could not fetch ${ref} (${firstLine(err.stderr) || err.message})`);
  }
  let actual;
  try {
    ({ trunk: actual } = resolveDefaultBranch(url, dir));
  } catch (err) {
    if (!(err instanceof SpokeError)) throw err;
    throw new SpokeError(EXIT.CANNOT_VERIFY, `${remote} reports no default branch, so "${branch}" cannot be confirmed as the trunk (${err.message})`);
  }
  if (actual !== branch) {
    throw new SpokeError(EXIT.CANNOT_VERIFY, `this check was pointed at "${branch}" but ${remote}'s default branch is "${actual}"; set HARNESS_TRUNK to the trunk's real name`);
  }
  let head;
  try {
    head = git(['rev-parse', '--verify', `${ref}^{commit}`]).trim();
  } catch {
    throw new SpokeError(EXIT.CANNOT_VERIFY, `${ref} does not resolve to a commit after fetch`);
  }
  return { ref, head, url, dir };
}

const CONFIG = {
  remote: 'origin',
  branch: process.env.HARNESS_TRUNK || 'main',
  bugDir: 'docs/bugs',
  recordSuffix: '.bug.md',
  reviewSuffix: '.bug-review.md',
  branchOf: (key) => `bugfix/${key}`,
  keyPattern: /^[A-Z][A-Z0-9]{1,9}-\d+$/,
  // The record's header lines, read by label before the first section.
  keyLine: /^Key:[ \t]*(\S.*?)\s*$/,
  repositoryLine: /^Repository:[ \t]*(\S.*?)\s*$/,
  verdictLabel: /^Verdict:[ \t]*(\S.*?)\s*$/,
  sizeLabel: /^Size:[ \t]*(\S.*?)\s*$/,
  verdictValue: 'Bug',
  sizeValue: 'one-fix',
  // The record's sections, each once.
  sections: ['Ticket snapshot', 'Claim', 'Pinned commit', 'Chain', 'Reproduction', 'Files to change', 'Clash report'],
  sourceLine: /^Source:[ \t]*(\S.*?)\s*$/,
  sourcePattern: /^https:\/\/\S+$/,
  fetchedLine: /^Fetched:[ \t]*(\S.*?)\s*$/,
  // `<KEY>@<the ticket's updated time>`, in ISO 8601 as Jira gives it.
  fetchedValue: /^([A-Z][A-Z0-9]{1,9}-\d+)@(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}:?\d{2}))$/,
  typeLine: /^Type:[ \t]*(\S.*?)\s*$/,
  typeValue: 'Bug',
  descriptionHeading: /^###\s+Description\s*$/,
  pinnedLine: /^Pinned:[ \t]*(\S.*?)\s*$/,
  pinnedValue: /^([A-Za-z0-9][A-Za-z0-9._-]*)@([0-9a-f]{12})$/,
  // A chain link: `<repo>@<12-hex>:<path>:<line>`, the path inside its repository.
  linkValue: /^([A-Za-z0-9][A-Za-z0-9._-]*)@([0-9a-f]{12}):((?!\/)(?!(?:.*\/)?\.\.(?:\/|:))[^\s:]+):([1-9]\d*)$/,
  layerLine: /^Layer:[ \t]*(\S.*?)\s*$/,
  layers: ['unit', 'integration', 'e2e'],
  fileLine: /^File:[ \t]*(\S.*?)\s*$/,
  safePath: /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[^\s:]+$/,
  bullet: /^[-*][ \t]+(\S.*?)\s*$/,
  // A value nobody has decided. `none` is a value in the clash report, so it is not on this list.
  placeholderToken: /^(?:tbd|tbc|todo|pending|placeholder|\?+)$/i,
  // The review's machine surface, shared with the gate.
  approvedVerdict: '### VERDICT: APPROVED',
  verdictLine: /^###\s+VERDICT:\s*(.+?)\s*$/,
  modeLine: /^Mode:[ \t]*(\S.*?)\s*$/,
  mode: 'bug-review',
  recordRevision: { label: 'Record revision', line: /^Record revision:[ \t]*([0-9a-fA-F]{7,40})\s*$/ },
};

/* ---------------------------------------------------------------- git access */

function readFromRef(ref, path) {
  try {
    return git(['show', `${ref}:${path}`]);
  } catch {
    return null;
  }
}

// The hash of the BYTES at a path on the trunk: the value `git hash-object <path>` prints for the
// same file in a work tree.
function blobHash(ref, path) {
  try {
    return git(['rev-parse', `${ref}:${path}`]).trim();
  } catch {
    return null;
  }
}

// The one entry at exactly `path` on the trunk, or null where nothing is there.
function treeEntry(ref, path) {
  try {
    const out = git(['ls-tree', '-z', '--full-name', ref, '--', `:(top)${path}`]).split('\0').filter(Boolean);
    const hit = out.map((entry) => {
      const tab = entry.indexOf('\t');
      const [mode, type] = entry.slice(0, tab).split(/\s+/);
      return { mode, type, path: entry.slice(tab + 1) };
    }).find((e) => e.path === path);
    return hit || null;
  } catch {
    return null;
  }
}

// Whether the hub's remote has the branch /bugfix writes the record on. Asked only to word the
// finding; a remote that does not answer leaves the finding as it is.
function recordBranchExists(key) {
  try {
    return git(['ls-remote', '--heads', CONFIG.remote, CONFIG.branchOf(key)], { env: quietGitEnv() }).trim() !== '';
  } catch {
    return false;
  }
}

const stripBom = (text) => text.replace(/^﻿/, '');

function readArtefact(ref, path, label, report, hint) {
  const entry = treeEntry(ref, path);
  if (entry === null) {
    report.fail(`no ${path} on ${ref}; ${hint}`);
    return null;
  }
  if (entry.mode === '120000') {
    report.fail(`${path} is a symbolic link on ${ref}, not a ${label}; the check reads the bytes committed at that path`);
    return null;
  }
  if (entry.type !== 'blob') {
    report.fail(`${path} is not a file on ${ref}; git reports it as a ${entry.type}`);
    return null;
  }
  const text = readFromRef(ref, path);
  if (text === null) {
    report.fail(`could not read ${path} from ${ref}`);
    return null;
  }
  if (text.trim() === '') {
    report.fail(`${path} is empty on ${ref}; an empty file is not a ${label}`);
    return null;
  }
  return maskNonContent(stripBom(text));
}

/* -------------------------------------------------------------- check results */

const checks = [];
function check(name) {
  const c = { name, failures: [], notes: [] };
  checks.push(c);
  return { fail: (msg) => c.failures.push(msg), note: (msg) => c.notes.push(msg) };
}

/* ------------------------------------------------------- non-content masking */

// Copied from check-intake.js and kept the same on purpose: every check in the library reads a
// page the way a reader sees it, and they have to agree on what is content.
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

/* ------------------------------------------------------------ reading a record */

function mentions(lines, id) {
  return lines.some((line) => line.includes(id));
}

// The non-blank lines of one section, or null where it is missing. A section that appears more
// than once is a finding, and the first one is read.
function sectionBody(lines, heading, path, report) {
  const all = sectionRanges(lines, heading);
  if (all.length === 0) {
    report.fail(`${path} has no "## ${heading}" section`);
    return null;
  }
  if (all.length > 1) {
    report.fail(`"## ${heading}" appears ${all.length} times in ${path} (lines ${all.map((r) => r[0] + 1).join(', ')}); one section, once`);
  }
  const [start, end] = all[0];
  const body = lines.slice(start + 1, end + 1).filter((l) => l.trim() !== '');
  if (body.length === 0) report.fail(`the section "${heading}" is empty in ${path}; write the content, or the word "none" where the section allows it`);
  return body;
}

// The one value of a labelled line in `lines`, or null with a finding.
function oneLine(lines, pattern, label, path, report) {
  const hits = lines.map((l, i) => ({ m: l.match(pattern), no: i + 1 })).filter((h) => h.m);
  if (hits.length === 0) {
    report.fail(`${path} has no "${label}:" line`);
    return null;
  }
  if (hits.length > 1) report.fail(`${path} has ${hits.length} "${label}:" lines; write one`);
  return hits[0].m[1];
}

// A value in angle brackets, or a token that says nobody decided it.
function placeholderValue(value) {
  const v = value.trim();
  if (v.startsWith('<') && v.endsWith('>')) return true;
  return v.replace(/[.,;:!]+$/, '').search(CONFIG.placeholderToken) === 0;
}

function rejectPlaceholders(lines, path, report) {
  lines.forEach((line, i) => {
    const row = splitRow(line);
    const values = row ? row.filter((c) => !c.startsWith('-') && !c.startsWith(':')) : [line.replace(/^(?:[A-Za-z][A-Za-z ]*:[ \t]+)?(?:[-*][ \t]+)?/, '')];
    for (const v of values) {
      if (v !== '' && placeholderValue(v)) {
        report.fail(`${path} line ${i + 1}: "${v}" is a placeholder; write the value, or take the line out`);
        return;
      }
    }
  });
}

const isSafePath = (p) => p.search(CONFIG.safePath) === 0;

/* ---------------------------------------------------------------- the record */

// Check 1. The record's own lines and sections. Returns what the other checks read.
function checkRecord(lines, path, key, report) {
  rejectHiddenMarkup(lines, path, report);
  const firstSection = lines.findIndex((l) => l.search(/^##\s/) === 0);
  const header = firstSection === -1 ? lines : lines.slice(0, firstSection);
  const out = { repository: null, snapshot: null, chainRows: null, pinned: null };

  const named = oneLine(header, CONFIG.keyLine, 'Key', path, report);
  if (named !== null && named !== key) report.fail(`${path}: "Key: ${named}" is not ${key}; the record is named for ${key}, so its Key line says ${key}`);
  out.repository = oneLine(header, CONFIG.repositoryLine, 'Repository', path, report);
  if (out.repository !== null && out.repository.search(REPO_ID) !== 0) {
    report.fail(`${path}: "Repository: ${out.repository}" is not a repository id`);
    out.repository = null;
  }
  const verdict = oneLine(header, CONFIG.verdictLabel, 'Verdict', path, report);
  if (verdict !== null && verdict !== CONFIG.verdictValue) {
    report.fail(`${path}: "Verdict: ${verdict}" cannot have a record; only a ${CONFIG.verdictValue} has a record. Any other verdict ends /bugfix with a reply to the reporter`);
  }
  const size = oneLine(header, CONFIG.sizeLabel, 'Size', path, report);
  if (size !== null && size !== CONFIG.sizeValue) {
    report.fail(`${path}: "Size: ${size}" is not ${CONFIG.sizeValue}; a bug that is too large for one fix goes to /feature`);
  }

  const body = {};
  for (const name of CONFIG.sections) body[name] = sectionBody(lines, name, path, report);
  out.snapshot = body['Ticket snapshot'];
  out.chainRows = body.Chain;

  // The ticket's own words may hold an angle bracket, so the snapshot is not read for placeholders.
  for (const name of CONFIG.sections.filter((s) => s !== 'Ticket snapshot')) {
    if (body[name]) rejectPlaceholders(body[name], path, report);
  }
  rejectPlaceholders(header, path, report);

  if (body['Pinned commit']) {
    const pinned = oneLine(body['Pinned commit'], CONFIG.pinnedLine, 'Pinned', path, report);
    if (pinned !== null) {
      const m = pinned.match(CONFIG.pinnedValue);
      if (!m) report.fail(`${path}: "Pinned: ${pinned}" is not <repo>@<12-hex>, the repository and the first 12 characters of the commit the investigation read`);
      else out.pinned = { repository: m[1], commit: m[2] };
    }
  }
  if (body.Reproduction) {
    const layer = oneLine(body.Reproduction, CONFIG.layerLine, 'Layer', path, report);
    if (layer !== null && !CONFIG.layers.includes(layer)) report.fail(`${path}: "Layer: ${layer}" is not one of ${CONFIG.layers.join(', ')}; name the layer of the test that shows the bug`);
    const file = oneLine(body.Reproduction, CONFIG.fileLine, 'File', path, report);
    if (file !== null && !isSafePath(file)) report.fail(`${path}: the reproduction's "File: ${file}" is not a path inside the repository`);
  }
  if (body['Files to change']) {
    const files = body['Files to change'].map((l) => l.match(CONFIG.bullet)).filter(Boolean).map((m) => m[1].replace(/^`(.*)`$/, '$1'));
    if (files.length === 0) report.fail(`${path} names no file to change; list each one as "- <path>"`);
    for (const f of files) {
      if (!isSafePath(f)) report.fail(`${path}: the file to change "${f}" is not a path inside the repository`);
    }
  }
  return out;
}

/* -------------------------------------------------------------- the snapshot */

// Check 2. The ticket as fetched, in the lines this check can read.
function checkSnapshot(rows, path, key, report) {
  if (rows === null) {
    report.fail('skipped: no readable "Ticket snapshot" section');
    return;
  }
  const source = oneLine(rows, CONFIG.sourceLine, 'Source', path, report);
  if (source !== null && source.search(CONFIG.sourcePattern) !== 0) report.fail(`${path}: the snapshot's "Source: ${source}" is not an https address of the ticket`);
  const fetched = oneLine(rows, CONFIG.fetchedLine, 'Fetched', path, report);
  if (fetched !== null) {
    const m = fetched.match(CONFIG.fetchedValue);
    if (!m) report.fail(`${path}: "Fetched: ${fetched}" is not <KEY>@<the ticket's updated time, ISO 8601>`);
    else if (m[1] !== key) report.fail(`${path}: "Fetched: ${fetched}" is for ${m[1]}, not ${key}; the snapshot copies the ticket the record is named for`);
  }
  const type = oneLine(rows, CONFIG.typeLine, 'Type', path, report);
  if (type !== null && type !== CONFIG.typeValue) {
    report.fail(`${path}: "Type: ${type}" is not ${CONFIG.typeValue}; /bugfix takes a bug, and a story goes through /from-ticket`);
  }
  const at = rows.findIndex((l) => l.search(CONFIG.descriptionHeading) === 0);
  if (at === -1) report.fail(`${path} has no "### Description" in its snapshot; copy the ticket's description as the ticket gives it`);
  else if (rows.slice(at + 1).filter((l) => l.trim() !== '').length === 0) report.fail(`${path}: the snapshot's "### Description" is empty; copy the ticket's description as the ticket gives it`);
}

/* ------------------------------------------------------------------ the chain */

// Check 3. Each link as `<repo>@<12-hex>:<path>:<line>`, in a listed repository.
function checkChain(rows, path, repository, registry, report) {
  if (rows === null) {
    report.fail('skipped: no readable "Chain" section');
    return;
  }
  const links = [];
  for (const row of rows.map((l) => ({ cells: splitRow(l) })).filter((r) => r.cells)) {
    const cells = row.cells;
    if (cells.length < 2 || cells.every((c) => c.search(/^:?-{3,}:?$/) === 0)) continue;
    if (cells[0].toLowerCase() === 'link') continue;
    links.push(cells[1]);
  }
  if (links.length === 0) {
    report.fail(`${path}'s "Chain" names no link; write one table row for each link, "| <n> | <repo>@<12-hex>:<path>:<line> | <what happens> |"`);
    return;
  }
  let own = 0;
  for (const link of links) {
    const m = link.match(CONFIG.linkValue);
    if (!m) {
      report.fail(`${path}: the chain link "${link}" is not <repo>@<12-hex>:<path>:<line>, with a path inside the repository and a line from 1`);
      continue;
    }
    if (m[1] === repository) own += 1;
    if (registry !== null && !registry.includes(m[1])) {
      report.fail(`${path}: the chain link "${link}" names the repository ${m[1]}, which is not in ${REGISTRY_PATH}`);
    }
  }
  if (repository !== null && own === 0) report.fail(`${path}: no link of the chain is in ${repository}, the repository the record is for`);
}

/* ------------------------------------------------------------- the repository */

// Check 4. The record's repository is listed, is the pinned commit's, and is HARNESS_REPO's.
function checkRepository(record, path, registry, registryFinding, pullRequestRepo, report) {
  if (registryFinding) report.fail(registryFinding);
  if (record.repository !== null && registry !== null && !registry.includes(record.repository)) {
    report.fail(`${path}: "Repository: ${record.repository}" is not in ${REGISTRY_PATH}; /add-repo adds a repository to the list`);
  }
  if (record.pinned && record.repository !== null && record.pinned.repository !== record.repository) {
    report.fail(`${path}: "Pinned: ${record.pinned.repository}@${record.pinned.commit}" is in another repository than "Repository: ${record.repository}"; pin the commit of ${record.repository}`);
  }
  if (pullRequestRepo !== null && record.repository !== null && record.repository !== pullRequestRepo) {
    report.fail(`${path} names repository "${record.repository}", not "${pullRequestRepo}"; the record was written for another repository's fix`);
  }
}

/* ---------------------------------------------------------------- the review */

function checkReview(ref, reviewPath, reviewLines, recordPath, key, report) {
  rejectHiddenMarkup(reviewLines, reviewPath, report);
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
    report.fail(`${reviewPath} carries "Mode: ${modes[0]}"; a bug record is reviewed in "Mode: ${CONFIG.mode}"`);
  }
  if (!mentions(reviewLines, key)) report.fail(`${reviewPath} never names ${key}; a review is evidence about one ticket`);
  if (recordPath === null) return;
  const actual = blobHash(ref, recordPath);
  if (actual === null) {
    report.fail(`could not read the revision of ${recordPath} on ${ref}`);
    return;
  }
  const hits = [];
  reviewLines.forEach((line, i) => {
    const m = line.match(CONFIG.recordRevision.line);
    if (m) hits.push({ no: i + 1, value: m[1].toLowerCase() });
  });
  if (hits.length === 0) {
    report.fail(`${reviewPath} carries no "${CONFIG.recordRevision.label}: <hash>" line, so it names no revision of ${recordPath}; write the value of \`git hash-object ${recordPath}\` for the bytes you reviewed (on ${ref} that is currently ${actual})`);
  } else if (hits.length > 1) {
    report.fail(`${reviewPath} carries ${hits.length} "${CONFIG.recordRevision.label}:" lines (lines ${hits.map((h) => h.no).join(', ')}); a review approves one revision`);
  } else if (!actual.startsWith(hits[0].value)) {
    report.fail(`${reviewPath} approves revision ${hits[0].value} of ${recordPath}, but ${ref} carries ${actual}; the file changed after it was reviewed, so the current file is unreviewed`);
  }
}

/* ---------------------------------------------------------------------- main */

function usage(message) {
  const invoked = process.argv[1] || 'scripts/check-bug.mjs';
  stderr.write(`${message}\nusage: [HARNESS_REPO=<repository id>] node ${invoked} <KEY>     e.g. PLDC-731, the Jira key of a bug with a record under ${CONFIG.bugDir}/\n`);
  process.exit(EXIT.USAGE);
}

// The registry's repository ids, from the trunk blob, or a finding that says why not.
function readRegistry(ref) {
  const text = readFromRef(ref, REGISTRY_PATH);
  if (text === null) return { ids: null, finding: `no ${REGISTRY_PATH} on ${ref}; a record names a repository from the list, and the list is written by the hub install and filled by /add-repo` };
  try {
    const parsed = JSON.parse(stripBom(text));
    const repos = parsed && typeof parsed === 'object' && parsed.repositories && typeof parsed.repositories === 'object' && !Array.isArray(parsed.repositories)
      ? Object.keys(parsed.repositories) : null;
    if (repos === null) return { ids: null, finding: `${REGISTRY_PATH} on ${ref} has no "repositories" object; run scripts/check-registry.mjs --offline` };
    if (repos.length === 0) return { ids: null, finding: `${REGISTRY_PATH} on ${ref} names no repository, so no record has anywhere to land; /add-repo comes first` };
    return { ids: repos, finding: null };
  } catch (err) {
    return { ids: null, finding: `${REGISTRY_PATH} on ${ref} is not JSON: ${firstLine(err.message)}` };
  }
}

function main() {
  const arg = process.argv[2];
  if (!arg) usage('expected the bug\'s Jira key');
  if (process.argv.length > 3) usage(`unexpected argument "${process.argv[3]}"`);
  if (arg.search(CONFIG.keyPattern) !== 0) usage(`"${arg}" is not a Jira key`);
  const key = arg;
  const pullRequestRepo = process.env.HARNESS_REPO || null;
  if (pullRequestRepo !== null && pullRequestRepo.search(REPO_ID) !== 0) usage(`HARNESS_REPO "${pullRequestRepo}" is not a repository id`);

  const hub = syncTrunk(CONFIG.remote, CONFIG.branch);
  const ref = hub.ref;
  const recordPath = `${CONFIG.bugDir}/${key}${CONFIG.recordSuffix}`;
  const reviewPath = `${CONFIG.bugDir}/${key}${CONFIG.reviewSuffix}`;
  const { ids: registry, finding: registryFinding } = readRegistry(ref);

  const c1 = check('bug record');
  const c2 = check('ticket snapshot');
  const c3 = check('chain to the root cause');
  const c4 = check('repository');
  const c5 = check('bug review');

  const hint = recordBranchExists(key)
    ? `${CONFIG.branchOf(key)} exists on ${CONFIG.remote}; merge the hub's pull request for ${key}, then run this job again`
    : `/bugfix ${key} writes it`;
  const recordLines = readArtefact(ref, recordPath, 'bug record', c1, hint);
  const record = recordLines === null ? null : checkRecord(recordLines, recordPath, key, c1);
  if (record === null) {
    c2.fail('skipped: no readable bug record');
    c3.fail('skipped: no readable bug record');
    c4.fail('skipped: no readable bug record');
  } else {
    checkSnapshot(record.snapshot, recordPath, key, c2);
    checkChain(record.chainRows, recordPath, record.repository, registry, c3);
    checkRepository(record, recordPath, registry, registryFinding, pullRequestRepo, c4);
  }

  const reviewLines = readArtefact(ref, reviewPath, 'bug review', c5, `/bugfix ${key} writes it beside the record`);
  if (reviewLines !== null) checkReview(ref, reviewPath, reviewLines, recordLines === null ? null : recordPath, key, c5);

  const failed = checks.filter((c) => c.failures.length > 0);
  const width = Math.max(...checks.map((c) => c.name.length));
  const where = pullRequestRepo === null ? '' : ` for ${pullRequestRepo}`;
  stdout.write(`\n${key} bug check${where}  (against ${ref} at ${short(hub.head)}, ${CONFIG.remote} -> ${hub.url})\n\n`);
  for (const c of checks) {
    stdout.write(`  [${c.failures.length ? 'FAIL' : 'PASS'}] ${c.name.padEnd(width)}`.trimEnd() + '\n');
    for (const f of c.failures) stdout.write(`         - ${f}\n`);
    for (const n of c.notes) stdout.write(`         note: ${n}\n`);
  }
  stdout.write(failed.length
    ? `\nBUG RECORD INCOMPLETE: ${failed.length} of ${checks.length} checks failed.\n\n`
    : `\nBUG RECORD COMPLETE: ${checks.length} of ${checks.length} checks passed.\n\n`);
  process.exit(failed.length ? EXIT.FAIL : EXIT.PASS);
}

// The last line of an exit 2, 3 or 4 names this script and its code, so a shell line that hides
// the code, with a pipe or `; echo`, still tells the harness's failure record. Written at once,
// so a process.exit() never loses it.

try {
  main();
} catch (err) {
  if (err instanceof SpokeError) {
    stderr.write(`\nCANNOT VERIFY: ${err.message}\nRefusing to check against unverified state. Fix the remote and re-run.\n`);
    process.exit(err.exit);
  }
  stderr.write(`INTERNAL ERROR: ${err && err.stack ? err.stack : String(err)}\n`);
  process.exit(EXIT.INTERNAL);
}

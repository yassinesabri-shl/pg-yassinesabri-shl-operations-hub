#!/usr/bin/env node
// Part of the harness asset library c6f3b4427d58f7c3 (see VERSION.json) · 2026-11-09
/**
 * plan-survey.mjs: cut the files of a repository at one commit into parts, so
 * that /survey-repo reads no more than one part in a dispatch.
 *
 *   usage:  node scripts/plan-survey.mjs --id <ID> --clone <dir> --commit <40-hex> --out <dir> [--budget <bytes>]
 *           node scripts/plan-survey.mjs --id <ID> --clone <dir> --commit <40-hex> --out <dir> --previous <survey> --since <40-hex>
 *           node scripts/plan-survey.mjs --id <ID> --clone <dir> --commit <40-hex> --out <dir> --split <part>
 *           node scripts/plan-survey.mjs --id <ID> --clone <dir> --commit <40-hex> --out <dir> --check-facts
 *           node scripts/plan-survey.mjs --id <ID> --clone <dir> --commit <40-hex> --out <dir> --facts-for <part>
 *
 * The script reads the files and their sizes from git at --commit, never from
 * the working tree. It drops a binary file, a submodule and a symbolic link.
 * A binary file has a NUL byte in its first 8000 bytes, the rule git uses.
 * The script reads the bytes itself and ignores .gitattributes, so a text file
 * marked -diff or binary is still in a part.
 *
 * The script also leaves out the files that the rule table in surveys.mjs
 * matches: an archive, a vendored folder, a folder that directly holds a licence document, a
 * test, a migration, a locale file, CI configuration, a file the harness installs, a lock file,
 * a data file, an asset, a quiet page, a file of 16 bytes or less and a file over 500000 bytes. Each rule reads
 * the path and the size. The data rule also reads the content of a .json file above 16384 bytes,
 * when no earlier rule matches it: the file is data when at least 80% of its characters are
 * digits, "-", ".", ",", "[", "]" or white space. The vendored rule also reads the first 4096
 * bytes of a code file, and takes the file when they name a third-party licence. The markup rule
 * reads a page template or an HTML page, and takes it when it holds no sign of a call (contentAt
 * in surveys.mjs). The script reads no other content of a matched file, except a CI
 * file that builds the repository: the manifest rule reads it. It writes each matched file to `excluded` in
 * plan.json, with its size and its rule, sorted by path. No part holds a file that is in
 * `excluded`. A binary file that no rule matches is dropped with no record.
 *
 * Three modes.
 *
 *   1. Full: it groups the files by folder. A folder whose files total the
 *      budget or less is one part. A larger folder is cut, and each part of it
 *      holds files of that folder only:
 *        - A child folder that is cut gives its own parts.
 *        - The files directly in the folder and its child folders that fit go,
 *          in path order, into the first part of the folder with room.
 *      A single file over the budget is a part of its own. The pack reads only
 *      paths and sizes, so two runs give the same parts. It writes
 *      <out>/plan.json. The budget is 250000 bytes. --budget exists for the
 *      fixture suites.
 *   2. Delta: --previous names the survey a refresh replaces, and --since the
 *      commit it was read at. The plan is full, and `reason` says why, when the
 *      survey has a finding, names another repository, is on a template that
 *      is not the current one, or names another commit than --since. It is
 *      also full when --since is not in the clone. Otherwise the script lists
 *      the files that changed since --since, with --no-renames, so a moved file
 *      is a deleted file and an added file.
 *        - A row or an open point whose evidence names no changed or deleted
 *          file is carried. The script re-pins each of its pointers at
 *          --commit, and writes them to <out>/carried.md, the part `carried`.
 *          The bytes a pointer names did not change, so the re-pin is exact.
 *          An open point whose text names the key of a row looked at again is
 *          not carried, because the seat can drop that row.
 *        - Every other row and open point is looked at again. Its `files` are
 *          its evidence files that the plan still reads at --commit, in
 *          pointer order.
 *        - The parts cover the added and changed files, and the files of the
 *          rows looked at again, by the rule of mode 1.
 *        - A row looked at again goes to the part that holds its first file,
 *          or to P1 when it has none. `rows` keeps its table line word for
 *          word, with its section title. P1 has no paths when no file is left.
 *      With no change and nothing to look at again, the plan has no part.
 *   3. Split: --split <part> reads <out>/plan.json, cuts that part into two
 *      halves at half its bytes, names them <part>.1 and <part>.2, and writes
 *      plan.json again. A row of the part goes to the half that holds the first
 *      file of the row, or to <part>.1 when it has none. `excluded` stays as
 *      the plan has it.
 *
 * Check the fact sheet. --check-facts reads <out>/facts.md, the return of the seat of the fact
 * sheet, and writes nothing. It gives the form findings of parseFacts in surveys.mjs. It proves
 * every pointer against the clone at --commit: the file is a file there, and the range ends
 * inside it. The sheet must name --id and --commit. Each part seat copies the names of the
 * sheet, so a wrong sheet would give every part the same wrong row, and the join would see no
 * conflict. The check cannot see whether a true pointer carries a wrong name. On exit 0, stdout
 * is `FACTS OK: <n> row(s)`. On exit 1, it gives one line for each finding, then
 * `FACTS FINDINGS: <n> finding(s) in facts.md`. Exit 2: facts.md is missing.
 *
 * Cut the fact sheet for one part. --facts-for <part> reads <out>/facts.md and the files of the part
 * in <out>/plan.json at --commit, and writes <out>/facts.<part>.md: the Stores and Routes sections
 * whole, and each property and helper row that the part can use. A row is kept when a pointer of
 * it names a file of the part, or when a file of the part holds its name (factsFor in
 * surveys.mjs). One survey test run gave a sheet of 226 rows to every part, and most parts used a
 * few. stdout is `FACTS FOR: <part> <kept> of <n> property and helper row(s)`. Exit 1: the sheet
 * has a form finding. Exit 2: facts.md or plan.json is missing, or the plan has no such part.
 *
 * On a delta plan, `excluded` is every matched file at --commit, never the
 * list of the previous survey. A row looked at again whose evidence files are
 * all excluded or deleted goes to P1.
 *
 * Each part in plan.json has `paths`, the folders and files of the part, and
 * `files`, every file that the part holds as { path, bytes }, sorted by path.
 * `files` holds no excluded file and no binary file. The `bytes` of a part is
 * the sum of the bytes of its files. A split of a plan from before `files`
 * writes `files` for every part.
 *
 * Output: `Mode: <full|delta> (<reason>)`, then `Part: <id> <bytes> bytes <n>
 * paths` for each part. Then `Large file: <path> <bytes> bytes (<part id>)` for
 * each file above the budget, sorted by path. A file of exactly the budget is
 * not large. The line changes nothing in the plan. A delta plan adds `Carried: <n> row(s)` and `Look
 * again: <n> row(s)`. Both count table rows only, as join-survey.mjs does. An
 * open point goes to carried.md or to a part by the rule for a row, but it is
 * not counted. Then `Package: <folder> (<licence file name>)` for each folder that directly
 * holds a licence document, sorted by folder, whether or not an earlier rule took its files.
 * Then `Manifest: <path> (<why>)` for each manifest and `Not a manifest: <path> (<why>)` for
 * each other dependency list, sorted by path, by the rule of manifestsOf in surveys.mjs.
 * plan.json holds both lists as `manifests` and `notManifests`. A library row rests only on a
 * manifest. On a delta plan, a library row with a pointer to any other file is looked at again.
 * Then `Excluded: <n> file(s), <b> bytes`. Then the fact files, by the rule of factFiles in
 * surveys.mjs: `Fact file: <path> (<kind>)` for each file of `facts`, and `Fact file left out:
 * <path> (<kind>, <bytes> bytes, over the budget)` for each file of `factsLeft`, both sorted by
 * path. Then `Facts: <n> file(s), <b> bytes`, or `Facts: none (<why>)`. plan.json holds both
 * lists as `facts` and `factsLeft`, and `factsWhy` when `facts` is empty. The seat of the fact
 * sheet reads `facts`. A plan of fewer than two parts has no fact file: its one seat reads
 * every file anyway. A split keeps the fact files of the plan. The last line is
 * `PLANNED: <ID>@<12> in <n> part(s)`.
 *
 * Exit codes:
 *   0  plan written
 *   1  a part that cannot split: it is one file, or a fact sheet with a finding
 *   2  cannot verify: the clone is not at --commit, or cannot be read, or git
 *      cannot read a .json blob that the data rule reads, or the
 *      previous survey cannot be read, or the plan that --split reads is not
 *      one this script writes
 *   3  usage
 *   4  internal
 *
 * What this script cannot see
 *   - What a file holds, other than the share of numeric characters in a large
 *     .json file. A file of data in another form counts toward the budget, so it
 *     can cost one dispatch that finds nothing. A `Large file:` line shows the
 *     worst case.
 *   - A matched file that does serve or call. No seat reads it. Section 7 of the
 *     survey shows the folder of each matched file, so a reader can see what the
 *     survey did not read.
 *   - A blob that git lists with no size, such as a missing object. The file
 *     list leaves it out with no record.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { stdout, stderr } from 'node:process';
import { EXIT, SpokeError, REPO_ID, COMMIT, catAt, git, reasonLine } from './spoke-remote.mjs';
import { CURRENT_TEMPLATE, LIBRARY_TABLES, factFiles, factsFor, lineCount, parseFacts, SECTIONS, excludeRule, keysIn, manifestsAt, normaliseKey, notReadRows, contentAt, packageLicences, parseLsTree, parseSurvey, renderSurvey } from './surveys.mjs';

export const BUDGET = 250000;
const PART_ID = /^P\d+(\.\d+)*$/;
const BIG = 1 << 30;
const CARRIED = 'carried';
const OPEN_POINTS = SECTIONS.find((s) => s.open).title;

const byCodeUnit = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function usage(message) {
  const invoked = process.argv[1] || 'scripts/plan-survey.mjs';
  stderr.write(`${message}\nusage: node ${invoked} --id <ID> --clone <dir> --commit <40-hex> --out <dir> [--budget <bytes>] [--previous <survey> --since <40-hex> | --split <part> | --check-facts | --facts-for <part>]\n`);
  process.exit(EXIT.USAGE);
}

function gitIn(clone, args) {
  try {
    return git(['-C', clone, ...args], { maxBuffer: BIG });
  } catch (err) {
    const detail = String((err.stderr || err.message || '')).trim().split('\n')[0];
    throw new SpokeError(EXIT.CANNOT_VERIFY, `git ${args[0]} failed in ${clone}: ${detail}`, 'git-failed');
  }
}

/* --------------------------------------------------------------------- files */

// git calls a blob binary when its first 8000 bytes hold a NUL byte. The
// script reads the bytes itself: `git diff --numstat` also obeys
// .gitattributes, and a text file marked -diff or binary would fall out of
// every part.
const FIRST_FEW_BYTES = 8000;

/**
 * The blobs of `shas` that git's rule calls binary. One `git cat-file --batch`
 * streams every blob, and the script keeps only the first bytes of each, so a
 * large repository never sits in memory.
 */
function binaryBlobs(clone, shas) {
  return new Promise((done, fail) => {
    const binary = new Set();
    const cannot = (why) => new SpokeError(EXIT.CANNOT_VERIFY, `git cat-file failed in ${clone}: ${why}`, 'git-failed');
    const child = spawn('git', ['-C', clone, 'cat-file', '--batch'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let header = Buffer.alloc(0);
    let blob = null;
    let errors = '';
    let broken = null;
    child.stdout.on('data', (chunk) => {
      let at = 0;
      while (at < chunk.length && broken === null) {
        if (blob === null) {
          const end = chunk.indexOf(0x0a, at);
          if (end < 0) {
            header = Buffer.concat([header, chunk.subarray(at)]);
            return;
          }
          const line = Buffer.concat([header, chunk.subarray(at, end)]).toString('utf8');
          header = Buffer.alloc(0);
          at = end + 1;
          const [sha, type, size] = line.split(' ');
          if (type !== 'blob') {
            broken = cannot(`it answered "${line}" for a blob of the tree`);
            child.kill();
            return;
          }
          // The content, then the line feed that ends each object.
          blob = { sha, length: Number(size) + 1, head: Math.min(Number(size), FIRST_FEW_BYTES), read: 0 };
          continue;
        }
        const take = Math.min(blob.length - blob.read, chunk.length - at);
        const inHead = Math.min(take, blob.head - blob.read);
        if (inHead > 0 && chunk.subarray(at, at + inHead).includes(0)) binary.add(blob.sha);
        blob.read += take;
        at += take;
        if (blob.read === blob.length) blob = null;
      }
    });
    child.stderr.on('data', (chunk) => { errors += chunk; });
    child.on('error', (err) => fail(cannot(err.message)));
    child.on('close', (code) => {
      if (broken !== null) fail(broken);
      else if (code !== 0 || blob !== null) fail(cannot(errors.trim().split('\n')[0] || `exit ${code}`));
      else done(binary);
    });
    child.stdin.on('error', () => {});
    child.stdin.end(shas.map((sha) => `${sha}\n`).join(''));
  });
}

/**
 * The files at the commit, as { files, excluded, content, packages, manifests, notManifests }. `excluded` holds every file
 * that excludeRule matches, binary or text, with its rule. `files` holds the
 * plannable rest: no binary file, no submodule, no symbolic link. Both sort by
 * path, by code unit. `content` holds the paths that the three content rules take
 * (contentAt in surveys.mjs): the data, vendored and markup rules. The script reads the content
 * of a file only for those rules and for the manifest rule.
 */
export async function listFiles(clone, commit) {
  const tree = gitIn(clone, ['ls-tree', '-r', '-l', '-z', commit]);
  const shas = new Map();
  for (const record of tree.split('\0')) {
    const tab = record.indexOf('\t');
    if (tab >= 0) shas.set(record.slice(tab + 1), record.slice(0, tab).split(/\s+/)[2]);
  }
  const excluded = [];
  const candidates = [];
  const all = parseLsTree(tree);
  const licences = packageLicences(all);
  const roots = new Set(licences.keys());
  const gitDir = gitIn(clone, ['rev-parse', '--absolute-git-dir']).trim();
  let content;
  try {
    content = contentAt(gitDir, commit, all);
  } catch (err) {
    throw new SpokeError(EXIT.CANNOT_VERIFY, `cannot read the files whose content a rule reads in ${clone}: ${err.message.split('\n')[0]}`, 'git-failed');
  }
  for (const { path, bytes } of all) {
    const hit = excludeRule(path, bytes, roots, content);
    if (hit) excluded.push({ path, bytes, rule: hit.rule });
    else candidates.push({ path, bytes, sha: shas.get(path) });
  }
  const binary = await binaryBlobs(clone, [...new Set(candidates.map((e) => e.sha))]);
  const files = candidates.filter((e) => !binary.has(e.sha)).map(({ path, bytes }) => ({ path, bytes }));
  const packages = [...licences].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([folder, name]) => ({ folder, name }));
  // The rule reads the files that excludeRule keeps, binary or not, and the CI build files, so the survey check gets the same list from the tree.
  let lists;
  try {
    lists = manifestsAt(gitDir, commit, all, content);
  } catch (err) {
    throw new SpokeError(EXIT.CANNOT_VERIFY, `cannot read the build and workspace files in ${clone}: ${err.message}`, 'git-failed');
  }
  return { files, excluded, content, packages, manifests: lists.manifests, notManifests: lists.left };
}

/* ------------------------------------------------------------------- packing */

function folderOf(path) {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
}

/**
 * Pack `files` into parts of `budget` bytes or less, by the folder rule of mode 1. `all` is every file at the
 * commit, the excluded files too: a folder shows as `<folder>/` (`./` for the root) only when every
 * file of it in `all` is in `files`. Otherwise the part lists the files, and
 * the whole folders inside them still show as folders.
 */
export function packParts(files, all, budget) {
  const sorted = [...files].sort((a, b) => byCodeUnit(a.path, b.path));
  const root = { name: '', files: [], children: new Map(), bytes: 0, count: 0 };
  const nodeFor = (folder) => {
    let node = root;
    if (folder === '') return node;
    let prefix = '';
    for (const part of folder.split('/')) {
      prefix = prefix ? `${prefix}/${part}` : part;
      if (!node.children.has(part)) node.children.set(part, { name: prefix, files: [], children: new Map(), bytes: 0, count: 0 });
      node = node.children.get(part);
    }
    return node;
  };
  for (const file of sorted) nodeFor(folderOf(file.path)).files.push(file);
  const total = (node) => {
    node.bytes = node.files.reduce((sum, f) => sum + f.bytes, 0);
    node.count = node.files.length;
    for (const child of node.children.values()) {
      total(child);
      node.bytes += child.bytes;
      node.count += child.count;
    }
  };
  total(root);

  const inAll = new Map();
  for (const file of all) {
    let folder = folderOf(file.path);
    for (;;) {
      inAll.set(folder, (inAll.get(folder) || 0) + 1);
      if (folder === '') break;
      folder = folderOf(folder);
    }
  }

  const childrenOf = (node) => [...node.children.entries()].sort((a, b) => byCodeUnit(a[0], b[0])).map(([, c]) => c);
  const pathsOf = (node) => {
    if (node.count > 0 && inAll.get(node.name) === node.count) return [node.name === '' ? './' : `${node.name}/`];
    return [...node.files.map((f) => f.path), ...childrenOf(node).flatMap(pathsOf)];
  };
  const filesOf = (node) => [...node.files, ...childrenOf(node).flatMap(filesOf)];

  // A part holds files of one folder only. A seat reads one module at a time, and each
  // extra folder costs it more reads. A folder that fits is one part. A folder that does
  // not fit gives the parts of its child folders that do not fit, and puts its own files
  // and its child folders that fit into parts of their own. A piece goes into the first
  // of those parts with room, so a small piece at the end fills an earlier part.
  const pack = (node) => {
    if (node.count === 0) return [];
    if (node.bytes <= budget) return [{ bytes: node.bytes, paths: pathsOf(node), files: filesOf(node) }];
    const out = [];
    const open = [];
    const place = (piece) => {
      const home = piece.bytes <= budget ? open.find((p) => p.bytes + piece.bytes <= budget) : undefined;
      if (home) {
        home.bytes += piece.bytes;
        home.paths.push(...piece.paths);
        home.files.push(...piece.files);
        return;
      }
      const part = { bytes: piece.bytes, paths: [...piece.paths], files: [...piece.files] };
      out.push(part);
      if (piece.bytes <= budget) open.push(part);
    };
    for (const f of node.files) place({ bytes: f.bytes, paths: [f.path], files: [f] });
    for (const child of childrenOf(node)) {
      const inner = pack(child);
      if (inner.length === 1) place(inner[0]);
      else out.push(...inner);
    }
    return out;
  };

  const parts = pack(root);
  // A folder walk puts "a/x" before "a-b", so the list sorts again by path.
  for (const part of parts) part.files = part.files.map(({ path, bytes }) => ({ path, bytes })).sort((a, b) => byCodeUnit(a.path, b.path));
  return parts;
}

/* ----------------------------------------------------------------------- plan */

const asParts = (packed, start = 1) => packed.map((p, i) => ({ id: `P${start + i}`, bytes: p.bytes, paths: p.paths, files: p.files, rows: [] }));

function fullPlan(args, all, excluded, lists, reason) {
  return {
    repository: args.id,
    commit: args.commit,
    budget: args.budget,
    mode: 'full',
    reason,
    parts: asParts(packParts(all, [...all, ...excluded], args.budget)),
    excluded,
    ...lists,
  };
}

function filesOfPart(part, all) {
  const chosen = new Set();
  for (const path of part.paths) {
    if (path === './') all.forEach((f) => chosen.add(f.path));
    else if (path.endsWith('/')) all.filter((f) => f.path.startsWith(path)).forEach((f) => chosen.add(f.path));
    else chosen.add(path);
  }
  return all.filter((f) => chosen.has(f.path));
}

function splitPart(plan, id, all, excluded) {
  const index = plan.parts.findIndex((p) => p.id === id);
  if (index < 0) usage(`${id} is not a part of the plan`);
  const part = plan.parts[index];
  const files = filesOfPart(part, all);
  if (files.length === 0) throw new SpokeError(EXIT.FAIL, `${id} has no file to split`);
  if (files.length === 1) throw new SpokeError(EXIT.FAIL, `${id} is one file and cannot split: ${files[0].path}`);
  const bytes = files.reduce((sum, f) => sum + f.bytes, 0);
  let cut = files.length - 1;
  let running = 0;
  for (let i = 0; i < files.length; i += 1) {
    running += files[i].bytes;
    if (running >= bytes / 2) {
      cut = Math.min(i + 1, files.length - 1);
      break;
    }
  }
  const halves = [files.slice(0, cut), files.slice(cut)];
  const made = halves.map((half, i) => {
    const [packed] = packParts(half, [...all, ...excluded], Infinity);
    const own = new Set(half.map((f) => f.path));
    return { id: `${id}.${i + 1}`, bytes: packed.bytes, paths: packed.paths, files: packed.files, rows: [], own };
  });
  for (const row of part.rows || []) {
    const first = row.files && row.files.length ? row.files[0] : null;
    const home = first !== null && made[1].own.has(first) ? made[1] : made[0];
    home.rows.push(row);
  }
  plan.parts.splice(index, 1, ...made.map(({ own, ...rest }) => rest));
  // A plan written before the files list gets one for every other part, so each part of the new plan has it.
  for (const other of plan.parts) {
    if (other.files === undefined) other.files = filesOfPart(other, all).map(({ path, bytes }) => ({ path, bytes }));
  }
}

/* ----------------------------------------------------------------- fact files */

/**
 * The fact files of a plan, as { facts, factsLeft, factsWhy }. A plan of two parts or more has
 * a fact sheet. A plan of one part has none: its one seat reads every file, so a sheet seat
 * would cost one more dispatch and save no read. `factsWhy` says why a plan has no fact file.
 */
function factsOf(plan, all, budget) {
  if (plan.parts.length < 2) return { facts: [], factsLeft: [], factsWhy: `the plan has ${plan.parts.length} part(s)` };
  const { facts, left } = factFiles(all, budget);
  if (facts.length) return { facts, factsLeft: left };
  return { facts, factsLeft: left, factsWhy: left.length ? 'every fact file is over the budget' : 'no file of the plan is a fact file' };
}

/* ---------------------------------------------------------------------- delta */

/** True when the clone holds `rev` as a commit. */
function hasCommit(clone, rev) {
  try {
    git(['-C', clone, 'cat-file', '-e', `${rev}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

/** The paths git names between two commits, by status. A move is a delete and an add. */
function changesSince(clone, since, commit) {
  const fields = gitIn(clone, ['diff', '--name-status', '-z', '--no-renames', since, commit]).split('\0');
  const changes = { changed: new Set(), deleted: new Set(), added: new Set() };
  for (let i = 0; i + 1 < fields.length && fields[i] !== ''; i += 2) {
    const [status, path] = [fields[i], fields[i + 1]];
    if (status === 'M' || status === 'T') changes.changed.add(path);
    else if (status === 'D') changes.deleted.add(path);
    else if (status === 'A') changes.added.add(path);
    else throw new SpokeError(EXIT.INTERNAL, `git diff --name-status gave the status "${status}" for ${path}, which this script does not read`);
  }
  return changes;
}

/** Why the refresh cannot be a delta, or null when it can. */
function fullReason(survey, args) {
  if (survey.findings.length) return `the previous survey has ${survey.findings.length} finding(s)`;
  if (survey.repository !== args.id) return `the previous survey is of ${survey.repository}, not ${args.id}`;
  if (survey.template !== CURRENT_TEMPLATE) return `the previous survey is on ${survey.template}, not ${CURRENT_TEMPLATE}`;
  if (survey.commit !== args.since) return `the previous survey is at ${survey.commit.slice(0, 12)}, not at --since ${args.since.slice(0, 12)}`;
  if (!hasCommit(args.clone, args.since)) return `--since ${args.since.slice(0, 12)} is not in the clone`;
  return null;
}

function readPrevious(file) {
  try {
    return readFileSync(file, 'utf8');
  } catch (err) {
    throw new SpokeError(EXIT.CANNOT_VERIFY, `cannot read the previous survey ${file}: ${err.code || err.message}`, 'file-unreadable');
  }
}

/**
 * The delta plan of a refresh, or a full plan with the reason a delta cannot
 * be made. Returns { plan, carried, counts }. carried is the text of
 * carried.md, or null when nothing is carried. counts is { carried, look } on
 * a delta plan, and absent on a full plan. It counts table rows only.
 */
function deltaPlan(args, all, excluded, lists) {
  const text = readPrevious(args.previous);
  const survey = parseSurvey(args.previous, text);
  const reason = fullReason(survey, args);
  if (reason !== null) return { plan: fullPlan(args, all, excluded, lists, reason), carried: null };

  const { changed, deleted, added } = changesSince(args.clone, args.since, args.commit);
  const plannable = new Set(all.map((f) => f.path));
  const lines = text.split(/\r?\n/);
  const pin = args.commit.slice(0, 12);
  const repin = (item) => ({
    ...item,
    evidence: item.evidence.map((p) => ({ ...p, pin, text: `${p.id}@${pin}:${p.path} L${p.from}-${p.to}` })),
  });

  const carriedRows = [];
  const carriedOpen = [];
  const look = [];
  // A library row that rests on a file the plan does not list as a manifest is looked at again, so the seat can drop it.
  const manifests = new Set(lists.manifests.map((m) => m.path));
  const offManifest = (item) => LIBRARY_TABLES.has(item.table) && item.evidence.some((p) => !manifests.has(p.path));
  const touched = (item) => item.evidence.some((p) => changed.has(p.path) || deleted.has(p.path)) || offManifest(item);
  const lookAgain = (item, section) => {
    const files = [...new Set(item.evidence.map((p) => p.path).filter((p) => plannable.has(p)))];
    look.push({ section, line: lines[item.line - 1], files });
  };
  for (const row of survey.rows) {
    if (touched(row)) lookAgain(row, SECTIONS.find((s) => s.table === row.table).title);
    else carriedRows.push(repin(row));
  }
  // The seat can drop a row it looks at again. A carried open point that names
  // the key of that row would then name a key that no row carries.
  const lookedKeys = new Set(survey.rows.filter(touched).map((r) => normaliseKey(r.key)));
  const namesLooked = (p) => keysIn(`${p.what} ${p.resolves}`).some((k) => lookedKeys.has(normaliseKey(k)));
  for (const point of survey.openPoints) {
    if (touched(point) || namesLooked(point)) lookAgain(point, OPEN_POINTS);
    else carriedOpen.push(repin(point));
  }

  const wanted = new Set([...changed, ...added, ...look.flatMap((r) => r.files)]);
  const parts = asParts(packParts(all.filter((f) => wanted.has(f.path)), [...all, ...excluded], args.budget));
  if (look.length && !parts.length) parts.push({ id: 'P1', bytes: 0, paths: [], files: [], rows: [] });
  const owners = parts.map((part) => new Set(part.files.map((f) => f.path)));
  for (const row of look) {
    const index = row.files.length ? owners.findIndex((own) => own.has(row.files[0])) : 0;
    parts[index].rows.push(row);
  }

  let carried = null;
  if (carriedRows.length || carriedOpen.length) {
    carried = renderSurvey({ repository: args.id, commit: args.commit, part: CARRIED, rows: carriedRows, openPoints: carriedOpen });
    const { findings } = parseSurvey(`${CARRIED}.md`, carried, { part: true });
    if (findings.length) throw new SpokeError(EXIT.INTERNAL, `${CARRIED}.md does not parse as a partial survey: ${findings[0]}`);
  }
  const plan = {
    repository: args.id,
    commit: args.commit,
    budget: args.budget,
    mode: 'delta',
    reason: `${changed.size} changed, ${deleted.size} deleted, ${added.size} added since ${args.since.slice(0, 12)}`,
    parts,
    excluded,
    ...lists,
  };
  const lookRows = look.filter((row) => row.section !== OPEN_POINTS).length;
  return { plan, carried, counts: { carried: carriedRows.length, look: lookRows } };
}

/* ------------------------------------------------------------------------ cli */

function parseArgs(argv) {
  const out = { id: null, clone: null, commit: null, out: null, budget: BUDGET, split: null, previous: null, since: null, checkFacts: false, factsFor: null };
  const names = new Map([
    ['--id', 'id'], ['--clone', 'clone'], ['--commit', 'commit'], ['--out', 'out'], ['--budget', 'budget'],
    ['--split', 'split'], ['--previous', 'previous'], ['--since', 'since'], ['--facts-for', 'factsFor'],
  ]);
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--check-facts') {
      out.checkFacts = true;
      continue;
    }
    const key = names.get(argv[i]);
    if (!key) usage(`unknown argument ${argv[i]}`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) usage(`${argv[i]} needs a value`);
    out[key] = value;
    i += 1;
  }
  for (const key of ['id', 'clone', 'commit', 'out']) if (out[key] === null) usage(`--${key} is required`);
  if (out.id.search(REPO_ID) < 0) usage(`--id ${out.id} is not a repository id`);
  if (out.commit.search(COMMIT) < 0) usage('--commit must be 40 lower-case hex digits');
  if (typeof out.budget === 'string') {
    if (out.budget.search(/^[1-9]\d*$/) < 0) usage('--budget must be a positive whole number of bytes');
    out.budget = Number(out.budget);
  }
  if (out.split !== null && out.split.search(PART_ID) < 0) usage(`--split ${out.split} is not a part id`);
  if ((out.previous === null) !== (out.since === null)) usage('--previous and --since go together');
  if (out.since !== null && out.since.search(COMMIT) < 0) usage('--since must be 40 lower-case hex digits');
  if (out.checkFacts && (out.split !== null || out.previous !== null)) usage('--check-facts reads the fact sheet only. It takes no --split, --previous or --since');
  if (out.factsFor !== null) {
    if (out.factsFor.search(PART_ID) < 0) usage(`--facts-for ${out.factsFor} is not a part id`);
    if (out.checkFacts || out.split !== null || out.previous !== null) usage('--facts-for reads the fact sheet and the plan only. It takes no --check-facts, --split, --previous or --since');
  }
  if (out.split !== null && out.previous !== null) usage('--split reads the plan that is already written. It takes no --previous or --since');
  return out;
}

/** The plan that --split cuts. A file that is not a plan cannot verify, as in join-survey.mjs. */
function readPlanToSplit(file, args) {
  if (!existsSync(file)) throw new SpokeError(EXIT.CANNOT_VERIFY, `there is no plan at ${file}`, 'file-unreadable');
  let plan;
  try {
    plan = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new SpokeError(EXIT.CANNOT_VERIFY, `the plan at ${file} is not JSON: ${err.message}`, 'plan-invalid');
  }
  const bad = (what) => new SpokeError(EXIT.CANNOT_VERIFY, `the plan at ${file} is not one plan-survey.mjs writes: ${what}`, 'plan-invalid');
  if (typeof plan !== 'object' || plan === null || Array.isArray(plan)) throw bad('it is not an object');
  if (plan.repository !== args.id || plan.commit !== args.commit) {
    throw new SpokeError(EXIT.CANNOT_VERIFY, `the plan at ${file} is for ${plan.repository}@${String(plan.commit).slice(0, 12)}, not ${args.id}@${args.commit.slice(0, 12)}`, 'plan-invalid');
  }
  if (!Array.isArray(plan.parts)) throw bad('parts is not a list');
  if (plan.excluded !== undefined && (!Array.isArray(plan.excluded) || plan.excluded.some((e) => !e || typeof e.path !== 'string'))) throw bad('excluded is not a list of files');
  for (const key of ['manifests', 'notManifests']) {
    if (plan[key] !== undefined && (!Array.isArray(plan[key]) || plan[key].some((e) => !e || typeof e.path !== 'string' || typeof e.why !== 'string'))) throw bad(`${key} is not a list of files with a reason`);
  }
  for (const part of plan.parts) {
    const id = part && typeof part.id === 'string' ? part.id : '';
    if (id.search(PART_ID) < 0) throw bad(`"${id}" is not a part id P<n> or P<n>.<n>`);
    if (!Array.isArray(part.paths) || part.paths.some((p) => typeof p !== 'string')) throw bad(`the paths of ${id} are not a list of paths`);
    if (part.rows !== undefined && (!Array.isArray(part.rows) || part.rows.some((r) => !r || !Array.isArray(r.files)))) throw bad(`the rows of ${id} are not a list of rows`);
    // A plan from before the files list has none. The split writes it.
    if (part.files !== undefined && (!Array.isArray(part.files) || part.files.some((f) => !f || typeof f.path !== 'string' || !Number.isInteger(f.bytes) || f.bytes < 0))) {
      throw bad(`the files of ${id} are not a list of files with their bytes`);
    }
  }
  return plan;
}

/**
 * A folder name can make a row that the section cannot hold, such as a name with markup or a
 * line break. The join would refuse the survey and `--full` would not help, so the plan stops.
 */
function checkNotReadRows(args, excluded, content) {
  for (const row of notReadRows(excluded, content)) {
    const text = renderSurvey({ repository: args.id, commit: args.commit, rows: [], openPoints: [], notRead: [row] });
    const back = parseSurvey('survey.md', text);
    const same = back.notRead.length === 1 && back.notRead[0].folder === row.folder && back.notRead[0].rule === row.rule
      && back.notRead[0].files === row.files && back.notRead[0].bytes === row.bytes;
    if (back.findings.length || !same) {
      throw new SpokeError(EXIT.CANNOT_VERIFY, `the folder ${JSON.stringify(row.folder)} cannot be written in the "Not read" section of a survey. Rename the folder or leave it out of the survey`, 'plan-invalid');
    }
  }
}

/** --check-facts: the findings of <out>/facts.md, its pointers proved against the clone. */
function checkFacts(args) {
  const name = 'facts.md';
  const file = join(args.out, name);
  if (!existsSync(file)) throw new SpokeError(EXIT.CANNOT_VERIFY, `${file} is missing. Write the return of the seat of the fact sheet there first`, 'file-unreadable');
  const sheet = parseFacts(name, readFileSync(file, 'utf8'));
  const findings = [...sheet.findings];
  if (sheet.repository !== null && sheet.repository !== args.id) findings.push(`${name}: the sheet is of ${sheet.repository}, not ${args.id}`);
  if (sheet.commit !== null && sheet.commit !== args.commit) findings.push(`${name}: the sheet is at ${sheet.commit.slice(0, 12)}, not at ${args.commit.slice(0, 12)}`);
  const pointers = sheet.rows.flatMap((r) => r.evidence.map((p) => ({ ...p, line: r.line })));
  const gitDir = gitIn(args.clone, ['rev-parse', '--absolute-git-dir']).trim();
  const files = catAt(gitDir, args.commit, pointers.map((p) => p.path));
  const pin = args.commit.slice(0, 12);
  for (const p of pointers) {
    const got = files.get(p.path);
    if (got === null) findings.push(`${name} L${p.line}: ${p.text}: ${p.path} is not in ${args.id} at ${pin}`);
    else if (got.type !== 'blob') findings.push(`${name} L${p.line}: ${p.text}: ${p.path} is a ${got.type === 'tree' ? 'folder' : got.type}, not a file; point at the lines`);
    else {
      const n = lineCount(got.bytes.toString('utf8'));
      if (p.to > n) findings.push(`${name} L${p.line}: ${p.text}: the range ends at line ${p.to}; ${p.path} has ${n} line(s) at ${pin}`);
    }
  }
  for (const line of findings) stdout.write(`${line}\n`);
  if (findings.length) {
    stdout.write(`FACTS FINDINGS: ${findings.length} finding(s) in ${name}\n`);
    process.exit(EXIT.FAIL);
  }
  stdout.write(`FACTS OK: ${sheet.rows.length} row(s)\n`);
}

/** --facts-for: the fact sheet of one part, written to <out>/facts.<part>.md. */
function writeFactsFor(args) {
  const sheetFile = join(args.out, 'facts.md');
  if (!existsSync(sheetFile)) throw new SpokeError(EXIT.CANNOT_VERIFY, `${sheetFile} is missing. Write the return of the seat of the fact sheet there first`, 'file-unreadable');
  const plan = readPlanToSplit(join(args.out, 'plan.json'), args);
  const part = plan.parts.find((p) => p.id === args.factsFor);
  if (!part) throw new SpokeError(EXIT.CANNOT_VERIFY, `the plan has no part ${args.factsFor}`, 'plan-invalid');
  const gitDir = gitIn(args.clone, ['rev-parse', '--absolute-git-dir']).trim();
  const paths = (part.files || []).map((f) => f.path);
  const texts = new Map([...catAt(gitDir, args.commit, paths)].map(([path, blob]) => [path, blob && blob.type === 'blob' ? blob.bytes.toString('utf8') : '']));
  let cut;
  try {
    cut = factsFor(readFileSync(sheetFile, 'utf8'), texts);
  } catch (err) {
    throw new SpokeError(EXIT.FAIL, `${err.message}. Run --check-facts first`);
  }
  writeFileSync(join(args.out, `facts.${part.id}.md`), cut.text);
  stdout.write(`FACTS FOR: ${part.id} ${cut.kept} of ${cut.total} property and helper row(s)\n`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const head = gitIn(args.clone, ['rev-parse', 'HEAD']).trim();
  if (head !== args.commit) {
    throw new SpokeError(EXIT.CANNOT_VERIFY, `the clone ${args.clone} is at ${head}, which is not at ${args.commit}`, 'commit-not-found');
  }
  if (args.checkFacts) {
    checkFacts(args);
    return;
  }
  if (args.factsFor !== null) {
    writeFactsFor(args);
    return;
  }
  const { files: all, excluded, content, packages, manifests, notManifests } = await listFiles(args.clone, args.commit);
  const lists = { manifests, notManifests };
  checkNotReadRows(args, excluded, content);
  const planFile = join(args.out, 'plan.json');
  const carriedFile = join(args.out, `${CARRIED}.md`);
  let plan;
  let delta = null;
  if (args.split !== null) {
    plan = readPlanToSplit(planFile, args);
    plan.excluded = plan.excluded || excluded;
    plan.manifests = plan.manifests || manifests;
    plan.notManifests = plan.notManifests || notManifests;
    splitPart(plan, args.split, all, plan.excluded);
  } else if (args.previous !== null) {
    delta = deltaPlan(args, all, excluded, lists);
    plan = delta.plan;
  } else {
    plan = fullPlan(args, all, excluded, lists, 'no previous survey');
  }
  if (args.split === null) Object.assign(plan, factsOf(plan, all, args.budget));
  // A plan from before the fact files has none, and a split adds none: the sheet comes before any split.
  plan.facts = plan.facts || [];
  plan.factsLeft = plan.factsLeft || [];
  mkdirSync(args.out, { recursive: true });
  writeFileSync(planFile, `${JSON.stringify(plan, null, 2)}\n`);
  // A carried.md left by an earlier plan would join rows this plan does not carry.
  if (args.split === null) {
    if (delta && delta.carried !== null) writeFileSync(carriedFile, delta.carried);
    else rmSync(carriedFile, { force: true });
  }
  stdout.write(`Mode: ${plan.mode} (${plan.reason})\n`);
  for (const part of plan.parts) stdout.write(`Part: ${part.id} ${part.bytes} bytes ${part.paths.length} paths\n`);
  // A file above the budget is a part of its own, and one dispatch may find nothing in it. The person sees it first.
  const budget = Number.isInteger(plan.budget) ? plan.budget : args.budget;
  const large = plan.parts.flatMap((part) => part.files.filter((f) => f.bytes > budget).map((f) => ({ ...f, id: part.id })));
  for (const { path, bytes, id } of large.sort((a, b) => byCodeUnit(a.path, b.path))) stdout.write(`Large file: ${path} ${bytes} bytes (${id})\n`);
  if (delta && delta.counts) {
    stdout.write(`Carried: ${delta.counts.carried} row(s)\n`);
    stdout.write(`Look again: ${delta.counts.look} row(s)\n`);
  }
  // The person sees each package folder before the paid dispatch. A wrong match is then visible.
  for (const { folder, name } of packages) stdout.write(`Package: ${folder} (${name})\n`);
  // The same holds for the manifests: a library row can rest only on a file listed here.
  for (const { path, why } of plan.manifests) stdout.write(`Manifest: ${path} (${why})\n`);
  for (const { path, why } of plan.notManifests) stdout.write(`Not a manifest: ${path} (${why})\n`);
  const left = plan.excluded || [];
  stdout.write(`Excluded: ${left.length} file(s), ${left.reduce((sum, e) => sum + e.bytes, 0)} bytes\n`);
  for (const { path, kind } of plan.facts) stdout.write(`Fact file: ${path} (${kind})\n`);
  for (const { path, kind, bytes } of plan.factsLeft) stdout.write(`Fact file left out: ${path} (${kind}, ${bytes} bytes, over the budget)\n`);
  if (plan.facts.length) stdout.write(`Facts: ${plan.facts.length} file(s), ${plan.facts.reduce((sum, f) => sum + f.bytes, 0)} bytes\n`);
  else stdout.write(`Facts: none (${plan.factsWhy || 'the plan has no fact sheet'})\n`);
  stdout.write(`PLANNED: ${plan.repository}@${plan.commit.slice(0, 12)} in ${plan.parts.length} part(s)\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  // The last line of an exit 2, 3 or 4 names this script and its code, so a shell line that hides
  // the code, with a pipe or `; echo`, still tells the harness's failure record. Written at once,
  // so a process.exit() never loses it.
  process.on('exit', (code) => { if (code >= 2 && code <= 4) { try { writeSync(2, `HARNESS EXIT: plan-survey ${code}\n`); } catch { /* stderr is closed */ } } });
  try {
    await main();
  } catch (err) {
    if (err instanceof SpokeError) {
      stderr.write(`${err.message}\n`);
      if (err.exit === EXIT.CANNOT_VERIFY) stderr.write(reasonLine(err.reason));
      process.exit(err.exit ?? err.code ?? EXIT.INTERNAL);
    }
    stderr.write(`internal error: ${err && err.stack ? err.stack : String(err)}\n`);
    process.exit(EXIT.INTERNAL);
  }
}

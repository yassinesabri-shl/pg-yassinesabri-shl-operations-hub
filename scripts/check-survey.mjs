#!/usr/bin/env node
// Part of the harness asset library c6f3b4427d58f7c3 (see VERSION.json) · 2026-09-28
/**
 * check-survey.mjs — is every service survey well formed, and does every
 * pointer in it point at something real?
 *
 *   usage:  node scripts/check-survey.mjs <ID>... [options]
 *           node scripts/check-survey.mjs --all [options]
 *           node scripts/check-survey.mjs --changed-since <sha> [options]
 *   options: --rev <rev>  --offline  --registry <file>
 *
 * A survey (`docs/estate/surveys/<ID>.md`, written by /survey-repo) says what a
 * repository serves, what it calls and in which repository, at which third
 * party's host or with the provider unnamed, which data stores it touches, and which libraries it uses:
 * shared inside the estate, or a third party's. Every row carries a key in a
 * fixed grammar and points at the lines it rests on, at one pinned commit of
 * the repository. surveys.mjs owns the shape; this script proves it, and then
 * proves every pointer against the repository itself.
 *
 * Surveys are read out of the hub's git at --rev (HEAD by default), never off
 * the working tree, so the check judges what a pull request carries.
 *
 * Which surveys. Named ids; --all; or --changed-since <sha>, which is what the
 * hub's required `survey-gate` runs: the surveys changed between <sha> and
 * --rev. A change to the list of repositories selects every survey, because a
 * removed repository can leave a survey naming nobody and a removed provider
 * can leave a call naming nobody. When nothing is selected the script says so
 * and exits 0 before it opens the list or reaches any remote. That is what lets
 * a check that reads remotes be required: a pull request that does not touch a
 * survey reads nothing, and one that does reads only the repositories whose
 * surveys it changed -- the repositories the pull request is about. A base the
 * clone does not hold selects every survey, and says so.
 *
 * Two kinds of rule, all run before the script exits.
 *
 *   1. Form, offline: the shape surveys.mjs fixes; the file named for the
 *      repository it surveys; that repository on the list; every provider on the
 *      list, `external:<host>` or `unknown`; no key left in an open point's
 *      text that no row carries; nothing stray in the folder.
 *   2. Truth, against the repository, unless --offline: it answers; it knows
 *      the survey's commit; that commit is on its trunk; every pointer's path is
 *      a file at that commit and its line range ends within the file. A commit
 *      behind the trunk head is noted, never failed: the survey says when it
 *      was true, and /survey-repo is the refresh.
 *      For a survey on template v6, section 7 ("Not read") must equal the one
 *      this script builds from the file list at the survey's commit: every
 *      row, and its file count and byte count. The data rule reads the content
 *      of each .json file above 16384 bytes, as plan-survey.mjs does. Git that
 *      cannot read such a blob is exit 2. A v4 or v5 survey has no section 7,
 *      and the script builds none.
 *      For a v6 survey, every pointer of a library row must name a manifest
 *      that plan-survey.mjs lists at the survey's commit (manifestsOf in
 *      surveys.mjs). A v4 or v5 survey is not held to the rule.
 *
 * Exit codes -- the gate's, and the highest across surveys:
 *   0  every selected survey is well formed and, unless offline, true
 *   1  a form finding, an unlisted repository, or a pointer that is not true
 *   2  cannot verify: no registry, or a repository that could not be reached
 *   3  usage
 *   4  internal
 *
 * What this script cannot see
 *   - Whether the survey is complete. It proves every row it has, not that the
 *     repository has no other endpoint. A survey points; the design still reads
 *     the code at a pinned commit.
 *   - Whether a line range shows what its row says. It proves the lines exist.
 *     The person who merges the survey's pull request reads the rows.
 */

import { stdout, stderr } from 'node:process';
import {
  EXIT, SpokeError, reasonLine, REGISTRY_PATH, REPO_ID, git,
  registryPath, readRegistry, validateRegistry,
  resolveSpokeTrunk, cacheDir, fetchBranchFully, ensureCommit, isAncestor, catAt, short,
} from './spoke-remote.mjs';
import {
  SURVEY_DIR, EXTERNAL, UNKNOWN, CURRENT_TEMPLATE, parseSurvey, readSurveysAt, idFromPath, lineCount,
  parseLsTree, notReadRows, contentAt, manifestsAt, libraryRowsOffManifest,
} from './surveys.mjs';
import { writeSync } from 'node:fs';

function usage(message) {
  const invoked = process.argv[1] || 'scripts/check-survey.mjs';
  stderr.write(`${message}\nusage: node ${invoked} <ID>... | --all | --changed-since <sha>  [--rev <rev>] [--offline] [--registry <file>]\n`);
  process.exit(EXIT.USAGE);
}

function parseArgs(argv) {
  const out = { ids: [], all: false, since: null, rev: 'HEAD', offline: false, registry: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--all') out.all = true;
    else if (a === '--offline') out.offline = true;
    else if (a === '--changed-since' || a === '--rev' || a === '--registry') {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) usage(`${a} needs a value`);
      if (a === '--changed-since') out.since = v;
      else out[a.slice(2)] = v;
      i += 1;
    } else if (a.startsWith('--')) usage(`unknown argument ${a}`);
    else out.ids.push(a);
  }
  const ways = [out.ids.length > 0, out.all, out.since !== null].filter(Boolean).length;
  if (ways === 0) usage('name the surveys to check: ids, --all, or --changed-since <sha>');
  if (ways > 1) usage('ids, --all and --changed-since are three ways to choose; use one');
  return out;
}

const label = (exit) => (exit === EXIT.PASS ? 'PASS' : exit === EXIT.FAIL ? 'FAIL' : 'CANNOT VERIFY');

function section(name, exit, summary, lines) {
  stdout.write(`  [${label(exit)}] ${name.padEnd(18)} ${summary}\n`);
  for (const l of lines) stdout.write(`         - ${l}\n`);
}

const hasRev = (rev) => {
  try {
    git(['cat-file', '-e', `${rev}^{commit}`]);
    return true;
  } catch {
    return false;
  }
};

/**
 * Which surveys to read, and why. Returns { mode, paths | null, heading,
 * nothing }. `paths` null means every survey at --rev.
 */
function select(args) {
  if (args.all) return { paths: null, heading: 'all' };
  if (args.ids.length) return { paths: args.ids.map((id) => `${SURVEY_DIR}/${id}.md`), heading: `named: ${args.ids.join(', ')}`, named: true };
  if (!hasRev(args.since)) {
    return { paths: null, heading: `base ${args.since} is not in this clone, so every survey is checked` };
  }
  const changed = git(['diff', '--name-only', '--no-renames', args.since, args.rev, '--', `${SURVEY_DIR}/`, REGISTRY_PATH])
    .split('\n').filter(Boolean);
  const base = short(git(['rev-parse', args.since]).trim());
  if (changed.includes(REGISTRY_PATH)) return { paths: null, heading: `changed since ${base}: the list of repositories, so every survey` };
  if (!changed.length) return { nothing: `no survey changed since ${base}; nothing to check` };
  return { paths: changed, heading: `changed since ${base}: ${changed.map((p) => p.slice(SURVEY_DIR.length + 1)).join(', ')}` };
}

// The token of the run's first cannot-verify finding, which the summary prints last.
let firstReason = null;

// The rules of a v6 survey that need the file list at its commit. The data rule reads the
// content of each large .json file, the vendored rule the first bytes of each code file, and the
// markup rule each page, as plan-survey.mjs does, so both give one section 7.
function checkTree(dir, survey, fail, cannot) {
  let all;
  try {
    all = parseLsTree(git(['--git-dir', dir, 'ls-tree', '-r', '-l', '-z', survey.commit], { maxBuffer: 256 * 1024 * 1024 }));
  } catch (err) {
    cannot(`cannot list the files of ${survey.repository} at ${short(survey.commit)}: ${err.message.split('\n')[0]}`, 'git-failed');
    return;
  }
  let content;
  try {
    content = contentAt(dir, survey.commit, all);
  } catch (err) {
    cannot(`cannot read the files whose content a rule reads of ${survey.repository} at ${short(survey.commit)}: ${err.message.split('\n')[0]}`, 'git-failed');
    return;
  }
  compareNotRead(all, content, survey, fail);
  compareManifests(dir, all, content, survey, fail, cannot);
}

// A library row of a v6 survey rests only on the manifests that plan-survey.mjs lists at the commit.
function compareManifests(dir, all, content, survey, fail, cannot) {
  let lists;
  try {
    lists = manifestsAt(dir, survey.commit, all, content);
  } catch (err) {
    cannot(`cannot read the build and workspace files of ${survey.repository} at ${short(survey.commit)}: ${err.message.split('\n')[0]}`, 'git-failed');
    return;
  }
  for (const { row, path } of libraryRowsOffManifest(survey.rows, lists.manifests)) {
    fail(`L${row.line}: "${row.key}" rests on ${path}, which is not a manifest at ${short(survey.commit)}. A library row rests only on a manifest; run /survey-repo ${survey.repository} --full again`);
  }
}

// Section 7 of a v6 survey, against the section built again from the commit.
// Rows match by folder and rule. Every difference is a finding.
function compareNotRead(all, content, survey, fail) {
  const key = (r) => `${r.folder}\0${r.rule}`;
  const built = new Map(notReadRows(all, content).map((r) => [key(r), r]));
  const stated = new Map(survey.notRead.map((r) => [key(r), r]));
  for (const [k, b] of built) {
    const s = stated.get(k);
    if (!s) fail(`"## 7. Not read" leaves out ${b.rule} ${b.folder}. The commit holds ${b.files} file(s) of it. Run /survey-repo ${survey.repository} --full again`);
    else {
      if (s.files !== b.files) fail(`L${s.line}: "## 7. Not read" says ${s.rule} ${s.folder} holds ${s.files} file(s), and the commit holds ${b.files}`);
      if (s.bytes !== b.bytes) fail(`L${s.line}: "## 7. Not read" says ${s.rule} ${s.folder} holds ${s.bytes} byte(s), and the commit holds ${b.bytes}`);
    }
  }
  for (const [k, s] of stated) {
    if (!built.has(k)) fail(`L${s.line}: "## 7. Not read" names ${s.rule} ${s.folder}, which the commit does not hold`);
  }
}

// One survey against its repository. Never throws for a per-repository
// problem: an unreachable remote is that survey's exit 2, and the next survey
// is still checked.
function checkTruth(survey, entry, fail, cannot, note) {
  const dir = cacheDir(survey.repository);
  let trunk;
  let head;
  try {
    ({ trunk, head } = resolveSpokeTrunk(entry, dir));
    fetchBranchFully(dir, entry.url, trunk);
  } catch (err) {
    if (!(err instanceof SpokeError)) throw err;
    cannot(err.message, err.reason);
    return;
  }
  if (!ensureCommit(dir, entry.url, trunk, survey.commit)) {
    fail(`commit ${short(survey.commit)} is not a commit ${entry.url} knows; run /survey-repo ${survey.repository} again`);
    return;
  }
  if (!isAncestor(dir, survey.commit, head)) {
    fail(`commit ${short(survey.commit)} is not on the trunk (${trunk}); a survey describes what is on the trunk`);
    return;
  }
  const pointers = [...survey.rows, ...survey.openPoints].flatMap((r) => r.evidence);
  const files = catAt(dir, survey.commit, pointers.map((p) => p.path));
  for (const p of pointers) {
    const got = files.get(p.path);
    if (got === null) fail(`${p.text}: ${p.path} is not in ${survey.repository} at ${short(survey.commit)}`);
    else if (got.type !== 'blob') fail(`${p.text}: ${p.path} is a ${got.type === 'tree' ? 'folder' : got.type}, not a file; point at the lines`);
    else {
      const n = lineCount(got.bytes.toString('utf8'));
      if (p.to > n) fail(`${p.text}: the range ends at line ${p.to}; ${p.path} has ${n} line(s) at ${short(survey.commit)}`);
    }
  }
  if (survey.template === CURRENT_TEMPLATE) checkTree(dir, survey, fail, cannot);
  if (survey.commit !== head) note(`commit ${short(survey.commit)} is behind the trunk head ${short(head)}: the survey says what was true there. Run /survey-repo ${survey.repository} to refresh`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const chosen = select(args);
  stdout.write(`\nservice surveys  (${chosen.nothing ? 'nothing selected' : chosen.heading}${args.offline ? '; offline: remotes not asked' : ''})\n\n`);
  if (chosen.nothing) {
    stdout.write(`NOTHING TO CHECK: ${chosen.nothing}.\n`);
    process.exit(EXIT.PASS);
  }

  let worst = EXIT.PASS;
  const regPath = registryPath(args.registry);
  const registry = readRegistry(regPath);
  const problems = validateRegistry(registry, regPath);
  if (problems.length) {
    worst = EXIT.FAIL;
    section('registry', EXIT.FAIL, 'not well formed; run check-registry first. No repository was asked', problems);
  }
  const listed = problems.length ? null : registry.repositories;

  const { surveys, stray } = readSurveysAt(args.rev);
  const byPath = new Map(surveys.map((s) => [s.path, s]));
  let targets;
  if (chosen.paths === null) {
    targets = surveys;
    if (stray.length) {
      worst = Math.max(worst, EXIT.FAIL);
      section('surveys folder', EXIT.FAIL, `${stray.length} file(s) that are not surveys`, stray.map((p) => `${p}: ${SURVEY_DIR} holds one <ID>.md per surveyed repository and nothing else; the template lives beside the folder`));
    }
  } else {
    targets = [];
    const strayHere = chosen.paths.filter((p) => stray.includes(p));
    if (strayHere.length) {
      worst = Math.max(worst, EXIT.FAIL);
      section('surveys folder', EXIT.FAIL, `${strayHere.length} file(s) that are not surveys`, strayHere.map((p) => `${p}: ${SURVEY_DIR} holds one <ID>.md per surveyed repository and nothing else`));
    }
    for (const p of chosen.paths) {
      if (byPath.has(p)) targets.push(byPath.get(p));
      else if (chosen.named) {
        worst = Math.max(worst, EXIT.FAIL);
        section(idFromPath(p), EXIT.FAIL, 'no survey', [`${p} is not in the hub at ${args.rev}; run /survey-repo ${idFromPath(p)}`]);
      }
      // A survey the pull request deleted has nothing left to check.
    }
  }
  if (!targets.length) {
    stdout.write(`\n${worst === EXIT.PASS ? `NOTHING TO CHECK: no survey at ${args.rev}.` : 'NOT WELL FORMED: see above.'}\n`);
    process.exit(worst);
  }

  let rows = 0;
  for (const { path, text } of targets) {
    const lines = [];
    let exit = EXIT.PASS;
    const fail = (m) => { lines.push(m); exit = Math.max(exit, EXIT.FAIL); };
    const cannot = (m, reason = null) => { lines.push(m); exit = Math.max(exit, EXIT.CANNOT_VERIFY); firstReason = firstReason || reason; };
    const note = (m) => { lines.push(m); };

    const survey = parseSurvey(path, text);
    for (const f of survey.findings) fail(f);
    const named = idFromPath(path);
    if (survey.repository !== null && survey.repository !== named) fail(`${path}: surveys repository "${survey.repository}"; the file is named for the repository it surveys, ${survey.repository}.md`);
    if (listed !== null) {
      if (!Object.hasOwn(listed, named)) fail(`${path}: ${named} is not on the list of repositories; a survey of an unlisted repository points at nothing. Delete it, or run /add-repo first`);
      for (const r of survey.rows) {
        // A malformed provider is already a finding of its own.
        const repository = r.table === 'calls' && r.host === null && !r.unknown && r.provider !== EXTERNAL && REPO_ID.test(r.provider);
        if (repository && r.provider !== survey.repository && !Object.hasOwn(listed, r.provider)) {
          fail(`${path} L${r.line}: "${r.key}": provider ${r.provider} is not on the list of repositories; list it, write ${EXTERNAL}:<host> for a third party, or ${UNKNOWN} where the code names neither`);
        }
      }
    }

    const reachable = !args.offline && listed !== null && survey.repository === named
      && survey.commit !== null && Object.hasOwn(listed, named);
    if (reachable) checkTruth(survey, listed[named], fail, cannot, note);

    worst = Math.max(worst, exit);
    rows += survey.rows.length;
    const files = new Set([...survey.rows, ...survey.openPoints].flatMap((r) => r.evidence.map((p) => p.path))).size;
    const unnamed = survey.rows.filter((r) => r.unknown).length;
    const summary = exit === EXIT.PASS
      ? `${survey.rows.length} row(s), ${files} file(s) cited, ${survey.openPoints.length} open point(s)${unnamed ? `, ${unnamed} call(s) with the provider ${UNKNOWN}` : ''}, at ${short(survey.commit)}${args.offline ? ', pointers not proved' : ''}`
      : exit === EXIT.FAIL ? `${lines.length} finding(s)` : 'not reached';
    section(named, exit, summary, lines);
  }

  stdout.write('\n');
  if (worst === EXIT.PASS) stdout.write(`WELL FORMED: ${targets.length} survey(s), ${rows} row(s)${args.offline ? '; pointers not proved against the repositories' : ', every pointer true'}.\n`);
  else if (worst === EXIT.FAIL) stdout.write('NOT WELL FORMED: a survey is malformed, names an unlisted repository, or points at something that is not there. Fix it and run again.\n');
  else stdout.write(`CANNOT VERIFY: at least one repository could not be reached. Nothing about its survey's pointers is known.\n${reasonLine(firstReason)}`);
  process.exit(worst);
}

// The last line of an exit 2, 3 or 4 names this script and its code, so a shell line that hides
// the code, with a pipe or `; echo`, still tells the harness's failure record. Written at once,
// so a process.exit() never loses it.
process.on('exit', (code) => { if (code >= 2 && code <= 4) { try { writeSync(2, `HARNESS EXIT: check-survey ${code}\n`); } catch { /* stderr is closed */ } } });

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

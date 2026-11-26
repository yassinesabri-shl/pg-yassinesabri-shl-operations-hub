#!/usr/bin/env node
// Part of the harness asset library c6f3b4427d58f7c3 (see VERSION.json) · 2026-09-12
/**
 * check-qa-gate.mjs — did QA pass on this exact head commit?
 *
 *   usage:  HARNESS_REPO=<spoke id> node scripts/check-qa-gate.mjs <KEY> --head <40-hex commit>
 *
 * /qa-sprint validates the head commit of a story's open code pull request, before
 * the merge. When every criterion passes, it writes the validation report into a
 * pull request in the hub, and a person merges it. The spoke's `qa-gate` job then
 * runs this file from its clone of the hub, with the pull request's head commit
 * from the event. The code pull request may merge only when this file exits 0, so
 * a merge to the spoke's trunk means the change passed QA.
 *
 * Four checks, all run before the exit:
 *
 *   1. docs/designs/<KEY>.validation.md is on the hub's trunk;
 *   2. `check-validation <KEY>` exits 0 against that trunk: the report is complete
 *      and every criterion passed. That file is the single reader of the report's
 *      shape and verdicts, and nothing here re-implements it;
 *   3. the report's `Repository:` line names HARNESS_REPO, this repository;
 *   4. the report's `Spoke commit:` line names the --head commit. A commit pushed
 *      after QA moves the head, and the report is then about older code.
 *
 * Exit codes -- the gate's
 *   0  every check passed                              QA PASSED
 *   1  at least one check failed; each says what to do QA NOT PASSED
 *   2  cannot verify: the hub's trunk could not be confirmed, check-validation is
 *      not installed beside this file, check-validation could not verify, or the
 *      trunk moved during the run
 *   3  usage: a bad key, --head not 40 hex characters, HARNESS_REPO unset or not
 *      a repository id
 *   4  internal, and check-validation exiting 3 or 4
 *
 * Design notes
 *   - Same trunk discipline as the gate: reads origin's default branch, never the
 *     working tree, confirms the name against the remote and force-fetches first.
 *     HARNESS_TRUNK names a non-`main` trunk; a name the remote does not confirm
 *     is exit 2.
 *   - Reads one remote, the hub. The head commit comes from the pull-request
 *     event, as the secret scan and the watermark step receive it, so this file
 *     never reaches the spoke and can be a required check.
 *   - A report that is on a `validation/<KEY>` branch and not yet on the trunk is
 *     named as such, so the person reads "merge the hub's pull request" rather
 *     than "run /qa-sprint".
 *   - Imports spoke-remote.mjs from beside itself and runs check-validation from
 *     beside itself, as check-fan-in.mjs does. The hub install lands all three in
 *     scripts/, so this file is .mjs in both layouts.
 *   - Node standard library only, plus git via child_process.
 *
 * What this check cannot see
 *   - Whether the head commit is the code that merges. A squash or a rebase merge
 *     writes new commits. After the merge, story-done.mjs compares their tree, or
 *     their change when the branch was behind the trunk.
 *   - Whether a PASS is deserved. It reads the verdict the validating seat wrote,
 *     through the check that proves the paperwork.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, writeSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { stdout, stderr } from 'node:process';
import { fileURLToPath } from 'node:url';
import { EXIT, REPO_ID, SpokeError, reasonIn, reasonLine, git, firstLine, resolveDefaultBranch, quietGitEnv, short } from './spoke-remote.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

const CONFIG = {
  remote: 'origin',
  branch: process.env.HARNESS_TRUNK || 'main',
  designDir: 'docs/designs',
  reportSuffix: '.validation.md',
  reportBranch: (key) => `validation/${key}`,
  keyPattern: /^[A-Z][A-Z0-9]{1,9}-\d+$/,
  head: /^[0-9a-fA-F]{40}$/,
  // The two header lines this file compares. check-validation proves the shape;
  // these are read on their own so that every check runs, even on a report that
  // check-validation refuses.
  repositoryLine: /^Repository:[ \t]*(\S.*?)\s*$/m,
  spokeLine: /^Spoke commit:[ \t]*([0-9a-fA-F]{40})\s*$/m,
  validationSummary: /^REPORT (?:IN)?COMPLETE: .*$/m,
  sibling: 'check-validation',
};

/* ------------------------------------------------------------------- usage */

function usage(message) {
  const invoked = process.argv[1] || 'scripts/check-qa-gate.mjs';
  stderr.write(`${message}\nusage: HARNESS_REPO=<repository id> node ${invoked} <KEY> --head <40-hex commit>\n`);
  process.exit(EXIT.USAGE);
}

function parseArgs(argv) {
  let key = null;
  let head = null;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--head') {
      if (i + 1 >= argv.length) usage('--head needs a value');
      head = argv[i + 1];
      i += 1;
    } else if (a.startsWith('--')) {
      usage(`unknown option ${a}`);
    } else if (key === null) {
      key = a;
    } else {
      usage(`unexpected argument "${a}"`);
    }
  }
  if (key === null) usage('expected the work-item key');
  if (!key.match(CONFIG.keyPattern)) usage(`"${key}" is not a work-item key`);
  if (head === null) usage('expected --head <the pull request\'s head commit>');
  if (!head.match(CONFIG.head)) usage(`--head "${head}" is not a full 40-character commit`);
  const repo = process.env.HARNESS_REPO;
  if (!repo) usage('HARNESS_REPO is not set; it names the repository the pull request is in');
  if (!repo.match(REPO_ID)) usage(`HARNESS_REPO "${repo}" is not a repository id`);
  return { key, head: head.toLowerCase(), repo };
}

// check-validation lives beside this file after the hub install, under either
// extension. Not finding it is an install fault, so "cannot verify".
function sibling(name) {
  for (const ext of ['.js', '.mjs']) {
    const path = join(HERE, `${name}${ext}`);
    if (existsSync(path)) return path;
  }
  throw new SpokeError(EXIT.CANNOT_VERIFY, `${name}.js (or .mjs) is not beside ${basename(process.argv[1] || 'check-qa-gate.mjs')} in ${HERE}; the hub install puts the gate, its sibling checks and this script in one directory`, 'script-missing');
}

/* ---------------------------------------------------------------- hub trunk */

function remoteUrl() {
  try {
    return git(['remote', 'get-url', CONFIG.remote]).trim();
  } catch (err) {
    throw new SpokeError(EXIT.CANNOT_VERIFY, `this checkout has no remote called ${CONFIG.remote}; run from the hub checkout`, 'no-remote');
  }
}

// The gate's discipline: fetch the named branch, then confirm the remote itself
// calls that branch its default. HARNESS_TRUNK names the trunk; it does not
// choose one.
function syncHubTrunk() {
  const url = remoteUrl();
  const ref = `${CONFIG.remote}/${CONFIG.branch}`;
  try {
    git(['fetch', '--no-tags', '--prune', '--force', CONFIG.remote, `+refs/heads/${CONFIG.branch}:refs/remotes/${ref}`], { env: quietGitEnv() });
  } catch (err) {
    throw new SpokeError(EXIT.CANNOT_VERIFY, `could not fetch ${ref} (${firstLine(err.stderr) || err.message})`, 'fetch-failed');
  }
  let actual;
  try {
    ({ trunk: actual } = resolveDefaultBranch(url, git(['rev-parse', '--git-dir']).trim()));
  } catch (err) {
    if (!(err instanceof SpokeError)) throw err;
    throw new SpokeError(EXIT.CANNOT_VERIFY, `${CONFIG.remote} reports no default branch, so "${CONFIG.branch}" cannot be confirmed as the trunk (${err.message})`, 'no-default-branch');
  }
  if (actual !== CONFIG.branch) {
    throw new SpokeError(EXIT.CANNOT_VERIFY, `this check was pointed at "${CONFIG.branch}" but ${CONFIG.remote}'s default branch is "${actual}"; set HARNESS_TRUNK to the trunk's real name`, 'trunk-mismatch');
  }
  let head;
  try {
    head = git(['rev-parse', '--verify', `${ref}^{commit}`]).trim();
  } catch (err) {
    throw new SpokeError(EXIT.CANNOT_VERIFY, `${ref} does not resolve to a commit after fetch`, 'fetch-failed');
  }
  return { ref, head, url };
}

function readBlob(commit, path) {
  try {
    return git(['show', `${commit}:${path}`]).replace(/^﻿/, '');
  } catch (err) {
    return null;
  }
}

// Whether the hub's remote has the branch /qa-sprint writes the report on. Asked
// only to word the finding; a remote that does not answer leaves the finding as
// it is.
function reportBranchExists(key) {
  try {
    return git(['ls-remote', '--heads', CONFIG.remote, CONFIG.reportBranch(key)], { env: quietGitEnv() }).trim() !== '';
  } catch (err) {
    return false;
  }
}

// check-validation fetches the hub's trunk again and judges its tip; this file
// read the report at the tip it confirmed first. If the two differ the trunk
// moved during the run, and one run must not mix two versions of the report.
function runValidation(path, key, hub) {
  const res = spawnSync(process.execPath, [path, key], { cwd: process.cwd(), env: process.env, encoding: 'utf8' });
  const name = basename(path);
  if (res.error) throw new SpokeError(EXIT.INTERNAL, `could not run ${name}: ${res.error.message}`);
  const now = git(['rev-parse', '--verify', `${hub.ref}^{commit}`]).trim();
  if (now !== hub.head) {
    throw new SpokeError(EXIT.CANNOT_VERIFY, `${hub.ref} moved from ${short(hub.head)} to ${short(now)} while this ran; run again`, 'trunk-moved');
  }
  if (res.status === EXIT.CANNOT_VERIFY) {
    throw new SpokeError(EXIT.CANNOT_VERIFY, `${name} ${key}: ${firstLine(String(res.stderr).replace(/^\s*CANNOT VERIFY:\s*/m, '')) || 'refused to judge'}`, reasonIn(String(res.stderr)));
  }
  if (res.status !== EXIT.PASS && res.status !== EXIT.FAIL) {
    throw new SpokeError(EXIT.INTERNAL, `${name} ${key} exited ${res.status}: ${firstLine(res.stderr) || firstLine(res.stdout) || 'no output'}`);
  }
  return { status: res.status, stdout: String(res.stdout || '') };
}

const quote = (text, re) => {
  const m = text.match(re);
  return m ? `"${m[0].trim()}"` : 'see its output';
};

/* --------------------------------------------------------------------- main */

function main() {
  const { key, head, repo } = parseArgs(process.argv.slice(2));
  const validation = sibling(CONFIG.sibling);
  const hub = syncHubTrunk();
  const reportPath = `${CONFIG.designDir}/${key}${CONFIG.reportSuffix}`;
  const rerun = `run /qa-sprint ${key} on this pull request`;

  const checks = [];
  const check = (name) => {
    const c = { name, failures: [] };
    checks.push(c);
    return { fail: (m) => c.failures.push(m) };
  };

  // 1. The report is on the trunk.
  const c1 = check('validation report on the trunk');
  const report = readBlob(hub.head, reportPath);
  if (report === null) {
    c1.fail(reportBranchExists(key)
      ? `no ${reportPath} on ${hub.ref}, but ${CONFIG.reportBranch(key)} exists on ${CONFIG.remote}; merge the hub's validation pull request, then run this job again`
      : `no ${reportPath} on ${hub.ref}; ${rerun}`);
  }

  // 2. The report is complete and passing, in check-validation's own words.
  const c2 = check('report complete and every criterion passed');
  if (report === null) {
    c2.fail('skipped: no report');
  } else {
    const res = runValidation(validation, key, hub);
    if (res.status !== EXIT.PASS) {
      c2.fail(`the validation check says ${quote(res.stdout, CONFIG.validationSummary)} (node scripts/${basename(validation)} ${key}); ${rerun}`);
    }
  }

  // 3. The report is about this repository.
  const c3 = check('report names this repository');
  if (report === null) {
    c3.fail('skipped: no report');
  } else {
    const m = report.match(CONFIG.repositoryLine);
    if (!m) c3.fail(`${reportPath} has no "Repository: <id>" line`);
    else if (m[1] !== repo) c3.fail(`${reportPath} names repository "${m[1]}", not "${repo}"; the report validated another repository's code`);
  }

  // 4. The report is about this head commit.
  const c4 = check('report names this head commit');
  if (report === null) {
    c4.fail('skipped: no report');
  } else {
    const m = report.match(CONFIG.spokeLine);
    if (!m) c4.fail(`${reportPath} has no "Spoke commit: <40-hex>" line`);
    else if (m[1].toLowerCase() !== head) {
      c4.fail(`${reportPath} names spoke commit ${short(m[1].toLowerCase())}, but this pull request's head is ${short(head)}; a commit landed after QA, so ${rerun} again`);
    }
  }

  const failed = checks.filter((c) => c.failures.length > 0);
  const width = Math.max(...checks.map((c) => c.name.length));
  stdout.write(`\n${key} QA gate for ${repo} at ${short(head)}  (against ${hub.ref} at ${short(hub.head)}, ${CONFIG.remote} -> ${hub.url})\n\n`);
  for (const c of checks) {
    stdout.write(`  [${c.failures.length ? 'FAIL' : 'PASS'}] ${c.name.padEnd(width)}`.trimEnd() + '\n');
    for (const f of c.failures) stdout.write(`         - ${f}\n`);
  }
  stdout.write(failed.length
    ? `\nQA NOT PASSED: ${failed.length} of ${checks.length} checks failed. The code pull request may not merge.\n\n`
    : `\nQA PASSED: ${key} validated at ${short(head)} on ${hub.ref}@${short(hub.head)}. The code pull request may merge.\n\n`);
  process.exit(failed.length ? EXIT.FAIL : EXIT.PASS);
}

// The last line of an exit 2, 3 or 4 names this script and its code, so a shell line that hides
// the code, with a pipe or `; echo`, still tells the harness's failure record. Written at once,
// so a process.exit() never loses it.
process.on('exit', (code) => { if (code >= 2 && code <= 4) { try { writeSync(2, `HARNESS EXIT: check-qa-gate ${code}\n`); } catch { /* stderr is closed */ } } });

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

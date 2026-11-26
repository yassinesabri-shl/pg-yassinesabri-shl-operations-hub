#!/usr/bin/env node
/**
 * check-requirements-candidate.mjs — the requirements check, on the branch you
 * are on, exactly as CI runs it.
 *
 * check-requirements.js reads one thing: the remote's default branch. That is
 * the property it exists to establish -- the document it judges is the document
 * that would be on the trunk -- and it is also why, run by hand on a feature
 * branch, it reports the trunk's document and says nothing about the branch.
 * The requirements-gate workflow gets round that by building a CANDIDATE
 * TRUNK: a bare repository whose trunk is the pull request's head, cloned and
 * checked as if the merge had happened. This file is that construction, in one
 * place, so a person, a command and the workflow run the same thing. Nothing
 * here points the check at a branch ref. The tempting local fix -- pointing it
 * at the branch -- deletes the one property the check exists to establish
 * (.claude/rules/workflow.md), and there is no flag for it because there is
 * none in the check.
 *
 *   usage:  node scripts/check-requirements-candidate.mjs <SLUG> [<SLUG> ...]
 *
 * What it does, in order
 *   1. Refuses when the working tree has uncommitted changes under
 *      docs/requirements/ -- modified, staged or untracked -- naming each file.
 *      The candidate is built from HEAD, and an uncommitted document is not
 *      what would merge; checking the committed one would report on a document
 *      nobody is looking at.
 *   2. Initialises a bare repository in a temporary directory with HEAD
 *      pointing at the trunk (HARNESS_TRUNK, or main), pushes this
 *      repository's HEAD to it as that trunk, and clones it.
 *   3. Runs the check that is IN THE CLONE -- scripts/check-requirements.js, or
 *      .mjs on a non-module repository -- once per slug, with the report
 *      printed as the check prints it. The check confirms the clone's remote
 *      default branch is the trunk it was told, as it does in CI.
 *   4. Exits with the worst exit code the check returned, as the workflow does;
 *      removes the temporary directory either way.
 *
 * Exit codes -- the check's, unchanged, plus this file's own refusals:
 *   0  the document is complete on the candidate trunk
 *   1  at least one check failed; all findings printed
 *   2  cannot verify: uncommitted requirements files, no commit at HEAD, no
 *      check in the clone, or the candidate could not be built
 *   3  usage error: no slug, or a slug that is not kebab-case
 *   4  internal error
 *
 * Design notes
 *   - The check runs FROM THE CLONE, so the bytes checked are the bytes that
 *      would merge, including the check itself. This file never imports it.
 *   - Node standard library only, plus git via child_process. ES module, .mjs
 *      in both layouts: it imports nothing and is renamed nowhere.
 *   - Runs from any directory inside the repository.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const EXIT = { PASS: 0, CHECK_FAIL: 1, CANNOT_VERIFY: 2, USAGE: 3, INTERNAL: 4 };

const CONFIG = {
  trunk: process.env.HARNESS_TRUNK || 'main',
  // The folder the check reads and the workflow diffs. One value, named once.
  requirementsDir: 'docs/requirements',
  // The check, under the two names it is installed as (generation.md §1).
  checkCandidates: ['scripts/check-requirements.js', 'scripts/check-requirements.mjs'],
  // The slug grammar the check enforces; refused here so a typo is a usage error
  // before a candidate is built for it.
  slugPattern: /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
};

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function refuseToJudge(reason, token) {
  process.stderr.write(`\nCANNOT VERIFY: ${reason}\n`);
  process.stderr.write('Refusing to check against unverified state. Fix it and re-run.\n');
  // This line names the cause as a fixed token, for the harness's failure record, just before the
  // exit line that the exit handler writes. The token
  // must be on REASONS in scripts/spoke-remote.mjs, and the check of the tokens proves it.
  if (token) process.stderr.write(`REASON: ${token}\n`);
  process.exit(EXIT.CANNOT_VERIFY);
}

function usage(message) {
  const invoked = process.argv[1] || 'scripts/check-requirements-candidate.mjs';
  if (message) process.stderr.write(`${message}\n`);
  process.stderr.write(`usage: node ${invoked} <SLUG> [<SLUG> ...]   e.g. payments-onboarding (kebab-case, as /feature minted it)\n`);
  process.exit(EXIT.USAGE);
}

/* ------------------------------------------------------------ the repository */

function repositoryRoot() {
  try {
    return git(['rev-parse', '--show-toplevel']).trim();
  } catch (err) {
    return refuseToJudge('not inside a git repository', 'not-a-checkout');
  }
}

function headCommit(root) {
  try {
    return git(['rev-parse', '--verify', 'HEAD^{commit}'], root).trim();
  } catch (err) {
    return refuseToJudge('HEAD does not name a commit; the candidate trunk is built from HEAD, so commit first', 'not-a-checkout');
  }
}

function headName(root) {
  try {
    const name = git(['symbolic-ref', '--quiet', '--short', 'HEAD'], root).trim();
    return name || 'detached HEAD';
  } catch (err) {
    return 'detached HEAD';
  }
}

// Every path under the requirements folder that differs from HEAD: modified,
// staged, renamed or untracked. Ignored files are not listed, because git would
// not commit them either.
function uncommittedRequirements(root) {
  const out = git(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', `:(top)${CONFIG.requirementsDir}`], root);
  const entries = out.split('\0').filter(Boolean);
  const files = [];
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    const status = entry.slice(0, 2);
    const path = entry.slice(3);
    files.push(`${path} (${describe(status)})`);
    // A rename or copy carries the original path in the next NUL-separated field.
    if (/[RC]/.test(status)) i += 1;
  }
  return files;
}

function describe(status) {
  if (status === '??') return 'untracked';
  if (status.includes('D')) return 'deleted';
  if (status.includes('A')) return 'added, not committed';
  if (/[RC]/.test(status)) return 'renamed, not committed';
  return 'modified, not committed';
}

/* -------------------------------------------------------- the candidate trunk */

function buildCandidate(root, tmp) {
  const bare = join(tmp, 'candidate-trunk.git');
  const clone = join(tmp, 'candidate');
  try {
    git(['init', '--bare', '--quiet', bare]);
    git(['--git-dir', bare, 'symbolic-ref', 'HEAD', `refs/heads/${CONFIG.trunk}`]);
    git(['push', '--quiet', bare, `HEAD:refs/heads/${CONFIG.trunk}`], root);
    git(['clone', '--quiet', bare, clone]);
  } catch (err) {
    refuseToJudge(`could not build the candidate trunk (${String(err.message).split('\n')[0]})`, 'git-failed');
  }
  return clone;
}

function checkInClone(clone) {
  const found = CONFIG.checkCandidates.find((rel) => existsSync(join(clone, rel)));
  if (!found) {
    refuseToJudge(`the candidate trunk carries no ${CONFIG.checkCandidates.join(' or ')}; the check that would run on the pull request is not committed`, 'script-missing');
  }
  return found;
}

/* ---------------------------------------------------------------------- main */

function main() {
  const slugs = process.argv.slice(2);
  if (slugs.length === 0) usage();
  for (const slug of slugs) {
    if (!CONFIG.slugPattern.test(slug)) usage(`"${slug}" is not a slug`);
  }

  const root = repositoryRoot();
  const head = headCommit(root);

  const dirty = uncommittedRequirements(root);
  if (dirty.length) {
    refuseToJudge(
      `the working tree has uncommitted changes under ${CONFIG.requirementsDir}/, and an uncommitted document is not what would merge:\n`
      + dirty.map((f) => `  - ${f}`).join('\n')
      + '\nCommit them on the branch, or discard them, then re-run.',
      'uncommitted-changes',
    );
  }

  const tmp = mkdtempSync(join(tmpdir(), 'requirements-candidate-'));
  let worst = EXIT.PASS;
  try {
    const clone = buildCandidate(root, tmp);
    const check = checkInClone(clone);
    process.stdout.write(`\ncandidate trunk: ${CONFIG.trunk} as it would read after ${headName(root)} (${head.slice(0, 12)}) merges; running ${check} in a clone of it\n`);
    for (const slug of slugs) {
      const res = spawnSync(process.execPath, [check, slug], {
        cwd: clone,
        stdio: 'inherit',
        env: { ...process.env, HARNESS_TRUNK: CONFIG.trunk },
      });
      const code = res.status === null ? EXIT.INTERNAL : res.status;
      if (code > worst) worst = code;
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  process.exit(worst);
}

// The last line of an exit 2, 3 or 4 names this script and its code, so a shell line that hides
// the code, with a pipe or `; echo`, still tells the harness's failure record. Written at once,
// so a process.exit() never loses it.
process.on('exit', (code) => { if (code >= 2 && code <= 4) { try { writeSync(2, `HARNESS EXIT: check-requirements-candidate ${code}\n`); } catch { /* stderr is closed */ } } });

try {
  main();
} catch (err) {
  process.stderr.write(`INTERNAL ERROR: ${err && err.stack ? err.stack : String(err)}\n`);
  process.exit(EXIT.INTERNAL);
}

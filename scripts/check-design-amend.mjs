#!/usr/bin/env node
/**
 * check-design-amend.mjs — may /dev-spec amend this open design pull request?
 *
 * A design pull request is accepted by a person merging it (human gate 1).
 * Before that, a person may want to answer the open questions in its §9, or
 * change what it says. Editing the design by hand unapproves it: the review's
 * `Design revision:` names the bytes the critic read, and the gate fails on
 * one changed byte. The way is /dev-spec again, on the open branch, as an
 * AMENDMENT: the answers and changes taken from the person, the design revised
 * in place, a fresh review bound to the new bytes, new commits on the same
 * branch. This file is the start of that run. It says, from git alone, whether
 * the checkout in front of it is a branch an amendment may be made on, and
 * refuses otherwise.
 *
 *   usage:  node scripts/check-design-amend.mjs <KEY>
 *
 * What it checks -- every rule, before it exits
 *   1. The branch: the checkout is on feature/<KEY>-<branch-slug>, the branch
 *      /dev-spec cut and opened the pull request from.
 *   2. The working tree: nothing modified, staged or untracked anywhere, each
 *      file named. The run commits what it writes, and only that.
 *   3. In step with the remote: HEAD is origin/<that branch> after a forced
 *      fetch -- not behind it (someone pushed; pull first), not ahead of it
 *      (push first), not apart from it.
 *   4. The design and its review: docs/designs/<KEY>.lld.md and
 *      <KEY>.lld-review.md are both committed at HEAD.
 *   5. Not merged: the branch's tip is not already on the trunk, and the trunk
 *      carries no design for <KEY>. There is exactly one design per work item,
 *      so a design on the trunk is a merged one -- which is also how a squash
 *      merge, which leaves no shared commit, is caught.
 *
 * What it does not check, and cannot: that the pull request is still OPEN.
 * Git knows "merged" and nothing else; a pull request closed without a merge
 * looks the same as an open one. /dev-spec asks the person, in the turn that
 * confirms the kind of run, and generation.md §8 records it.
 *
 * Exit codes -- the shared vocabulary:
 *   0  an amendment may start      -> prints the start commit and the hash
 *                                     of the design at it
 *   1  at least one rule failed    -> all findings printed
 *   2  cannot verify               -> the remote is unreachable, or its default
 *                                     branch is not the trunk named
 *   3  usage error                 -> no key, or one that is not a key
 *   4  internal error
 *
 * Design notes
 *   - Same remote discipline as check-dev-ready.js: force-fetch first, confirm
 *     the trunk (HARNESS_TRUNK, or main) is the remote's default branch, never
 *     trust a stale ref.
 *   - Reads git only. No forge API: the harness assumes no particular host for
 *     its pull requests.
 *   - Node standard library only, plus git via child_process. ES module, .mjs
 *     in both layouts: it imports nothing and is renamed nowhere.
 *   - Runs from any directory inside the repository, a worktree included.
 */

import { execFileSync } from 'node:child_process';
import { writeSync } from 'node:fs';

const EXIT = { PASS: 0, CHECK_FAIL: 1, CANNOT_VERIFY: 2, USAGE: 3, INTERNAL: 4 };

const CONFIG = {
  trunk: process.env.HARNESS_TRUNK || 'main',
  remote: 'origin',
  // designDir, designSuffix, reviewSuffix and keyPattern are copies of
  // check-dev-ready.js's. Change one there, change it here in the same commit
  // (generation.md §3.2).
  designDir: 'docs/designs',
  designSuffix: '.lld.md',
  reviewSuffix: '.lld-review.md',
  // The branch /dev-spec cuts: feature/<KEY>-<BRANCH-SLUG> (dev-spec.md § The hub checkout).
  branchPrefix: 'feature/',
  branchSlugPattern: /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
  keyPattern: /^[A-Z][A-Z0-9]{1,9}-\d+$/,
};

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function gitOk(args, cwd) {
  try {
    git(args, cwd);
    return true;
  } catch (err) {
    return false;
  }
}

function refuseToJudge(reason, token) {
  process.stderr.write(`\nCANNOT VERIFY: ${reason}\n`);
  process.stderr.write('Refusing to judge against unverified state. Fix it and re-run.\n');
  // This line names the cause as a fixed token, for the harness's failure record, just before the
  // exit line that the exit handler writes. The token
  // must be on REASONS in scripts/spoke-remote.mjs, and the check of the tokens proves it.
  if (token) process.stderr.write(`REASON: ${token}\n`);
  process.exit(EXIT.CANNOT_VERIFY);
}

function usage(message) {
  const invoked = process.argv[1] || 'scripts/check-design-amend.mjs';
  if (message) process.stderr.write(`${message}\n`);
  process.stderr.write(`usage: node ${invoked} <KEY>   e.g. PROJ-412 (the work item the design is for)\n`);
  process.exit(EXIT.USAGE);
}

const checks = [];
function check(name) {
  const c = { name, failures: [] };
  c.fail = (message) => c.failures.push(message);
  checks.push(c);
  return c;
}

const short = (sha) => sha.slice(0, 12);

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
    return refuseToJudge('HEAD does not name a commit', 'not-a-checkout');
  }
}

function branchName(root) {
  try {
    return git(['symbolic-ref', '--quiet', '--short', 'HEAD'], root).trim() || null;
  } catch (err) {
    return null;
  }
}

// Every path that differs from HEAD, anywhere in the tree. Ignored files are
// not listed, because git would not commit them either.
function uncommitted(root) {
  const entries = git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], root).split('\0').filter(Boolean);
  const files = [];
  for (let i = 0; i < entries.length; i += 1) {
    const status = entries[i].slice(0, 2);
    files.push(`${entries[i].slice(3)} (${status === '??' ? 'untracked' : 'not committed'})`);
    // A rename or copy carries the original path in the next NUL-separated field.
    if (/[RC]/.test(status)) i += 1;
  }
  return files;
}

/* ---------------------------------------------------------------- the remote */

// The remote's heads, by name, with the default branch. One ls-remote, so an
// unreachable remote is one refusal rather than a failure per rule.
function remoteHeads(root) {
  let out;
  try {
    out = git(['ls-remote', '--symref', CONFIG.remote], root);
  } catch (err) {
    return refuseToJudge(`could not reach ${CONFIG.remote} (${String(err.message).split('\n')[0]})`, 'remote-unreachable');
  }
  const symref = out.match(/^ref:\s+refs\/heads\/(\S+)\s+HEAD/m);
  const heads = new Set();
  for (const line of out.split('\n')) {
    const m = line.match(/^[0-9a-f]+\s+refs\/heads\/(\S+)$/);
    if (m) heads.add(m[1]);
  }
  return { defaultBranch: symref ? symref[1] : null, heads };
}

function fetchBranch(root, branch) {
  const ref = `${CONFIG.remote}/${branch}`;
  try {
    git(['fetch', '--no-tags', '--force', CONFIG.remote, `+refs/heads/${branch}:refs/remotes/${ref}`], root);
    return git(['rev-parse', '--verify', `refs/remotes/${ref}^{commit}`], root).trim();
  } catch (err) {
    return refuseToJudge(`could not fetch ${ref} (${String(err.message).split('\n')[0]})`, 'fetch-failed');
  }
}

const isAncestor = (root, a, b) => gitOk(['merge-base', '--is-ancestor', a, b], root);

function blobAt(root, commit, path) {
  try {
    return git(['rev-parse', '--verify', '--quiet', `${commit}:${path}`], root).trim() || null;
  } catch (err) {
    return null;
  }
}

// Is this a branch /dev-spec would have cut for the key?
function isKeyBranch(name, key) {
  const prefix = `${CONFIG.branchPrefix}${key}-`;
  return name !== null && name.startsWith(prefix) && CONFIG.branchSlugPattern.test(name.slice(prefix.length));
}

/* ---------------------------------------------------------------------- main */

function main() {
  const args = process.argv.slice(2);
  if (args.length !== 1) usage();
  const key = args[0];
  if (!CONFIG.keyPattern.test(key)) usage(`"${key}" is not a work-item key`);
  const designPath = `${CONFIG.designDir}/${key}${CONFIG.designSuffix}`;
  const reviewPath = `${CONFIG.designDir}/${key}${CONFIG.reviewSuffix}`;

  const root = repositoryRoot();
  const head = headCommit(root);

  const remote = remoteHeads(root);
  if (remote.defaultBranch === null) {
    refuseToJudge(`${CONFIG.remote} reports no default branch, so "${CONFIG.trunk}" cannot be confirmed as the trunk`, 'no-default-branch');
  }
  if (remote.defaultBranch !== CONFIG.trunk) {
    refuseToJudge(`the check was pointed at "${CONFIG.trunk}" but ${CONFIG.remote}'s default branch is "${remote.defaultBranch}"`, 'trunk-mismatch');
  }
  const trunkTip = fetchBranch(root, CONFIG.trunk);
  const current = branchName(root);
  const onKeyBranch = isKeyBranch(current, key);
  const branchTip = onKeyBranch && remote.heads.has(current) ? fetchBranch(root, current) : null;
  const keyBranches = [...remote.heads].filter((h) => isKeyBranch(h, key)).sort();

  // Rule 1 -- the branch.
  const c1 = check('branch');
  if (!onKeyBranch) {
    const where = keyBranches.length === 0
      ? `${CONFIG.remote} has no branch ${CONFIG.branchPrefix}${key}-<branch-slug>, so no design pull request can be open for ${key}`
      : `Check out ${keyBranches.map((h) => `"${h}"`).join(' or ')} and re-run`;
    c1.fail(`the checkout is on ${current === null ? 'a detached HEAD' : `"${current}"`}; an amendment starts on the branch the open design pull request is from. ${where}`);
  }

  // Rule 2 -- the working tree.
  const c2 = check('working tree');
  const dirty = uncommitted(root);
  if (dirty.length) {
    c2.fail(`the working tree has uncommitted changes, and the run commits what it writes and nothing else:\n${dirty.map((f) => `             ${f}`).join('\n')}\n           Commit them, or discard them, then re-run`);
  }

  // Rule 3 -- in step with the remote.
  const c3 = check('in step with the remote');
  const offBranch = `skipped: the checkout is not on a ${CONFIG.branchPrefix}${key}-<branch-slug> branch, so HEAD is not the pull request's commit`;
  if (!onKeyBranch) {
    c3.fail(offBranch);
  } else if (branchTip === null) {
    c3.fail(`${CONFIG.remote} has no branch "${current}", so no pull request can be open from it. A first design is written by /dev-spec in the checkout it makes`);
  } else if (head !== branchTip) {
    if (isAncestor(root, head, branchTip)) c3.fail(`HEAD (${short(head)}) is behind ${CONFIG.remote}/${current} (${short(branchTip)}): someone pushed to the pull request. Pull first, so the amendment starts from what the reviewer read`);
    else if (isAncestor(root, branchTip, head)) c3.fail(`HEAD (${short(head)}) is ahead of ${CONFIG.remote}/${current} (${short(branchTip)}): commits nobody has reviewed. Push them, or drop them, first`);
    else c3.fail(`HEAD (${short(head)}) and ${CONFIG.remote}/${current} (${short(branchTip)}) have gone apart. Settle the branch with the person who pushed, then re-run`);
  }

  // Rule 4 -- the design and its review, committed at HEAD.
  const c4 = check('design and review');
  const designBlob = blobAt(root, head, designPath);
  if (!onKeyBranch) c4.fail(offBranch);
  else if (designBlob === null) c4.fail(`HEAD carries no ${designPath}; there is nothing to amend`);
  if (onKeyBranch && blobAt(root, head, reviewPath) === null) c4.fail(`HEAD carries no ${reviewPath}; a design that never reached its review is unfinished, not amended -- finish the first run of /dev-spec on this branch`);

  // Rule 5 -- not merged.
  const c5 = check('not merged');
  // The tip whose merge is in question: the pull request's branch on the
  // remote, else HEAD on a key branch pushed nowhere, else -- off the branch --
  // the one key branch the remote carries. Off the branch with none or several,
  // only the design on the trunk can show a merge.
  let tipName = null;
  let tip = null;
  if (branchTip !== null) [tipName, tip] = [`${CONFIG.remote}/${current}`, branchTip];
  else if (onKeyBranch) [tipName, tip] = ['HEAD', head];
  else if (keyBranches.length === 1) [tipName, tip] = [`${CONFIG.remote}/${keyBranches[0]}`, fetchBranch(root, keyBranches[0])];
  const merged = 'The design is accepted, and a merged design changes only by a human amendment on the trunk (workflow.md § Prohibited), never by this run';
  if (tip !== null && isAncestor(root, tip, trunkTip)) {
    c5.fail(`${tipName} (${short(tip)}) is already on ${CONFIG.remote}/${CONFIG.trunk}: the pull request was merged. ${merged}`);
  } else if (blobAt(root, trunkTip, designPath) !== null) {
    c5.fail(`${CONFIG.remote}/${CONFIG.trunk} already carries ${designPath}, and there is one design per work item: the pull request was merged, by a squash or otherwise. ${merged}`);
  }

  const failed = checks.filter((c) => c.failures.length > 0);
  const width = Math.max(...checks.map((c) => c.name.length));
  process.stdout.write(`\n${key} design amendment start  (${current === null ? 'detached HEAD' : current} against ${CONFIG.remote}/${CONFIG.trunk})\n\n`);
  for (const c of checks) {
    process.stdout.write(`  [${c.failures.length ? 'FAIL' : 'PASS'}] ${c.name.padEnd(width)}`.trimEnd() + '\n');
    for (const f of c.failures) process.stdout.write(`         - ${f}\n`);
  }
  if (failed.length) {
    process.stdout.write(`\nAMENDMENT REFUSED: ${failed.length} of ${checks.length} rules failed.\n\n`);
    process.exit(EXIT.CHECK_FAIL);
  }
  process.stdout.write(`\n  start commit: ${head}\n  design:       ${designPath} @ ${designBlob}\n`);
  process.stdout.write('\nAMENDMENT START OK: not merged. Ask the person whether its pull request is still open; git cannot tell.\n\n');
  process.exit(EXIT.PASS);
}

// The last line of an exit 2, 3 or 4 names this script and its code, so a shell line that hides
// the code, with a pipe or `; echo`, still tells the harness's failure record. Written at once,
// so a process.exit() never loses it.
process.on('exit', (code) => { if (code >= 2 && code <= 4) { try { writeSync(2, `HARNESS EXIT: check-design-amend ${code}\n`); } catch { /* stderr is closed */ } } });

try {
  main();
} catch (err) {
  process.stderr.write(`INTERNAL ERROR: ${err && err.stack ? err.stack : String(err)}\n`);
  process.exit(EXIT.INTERNAL);
}

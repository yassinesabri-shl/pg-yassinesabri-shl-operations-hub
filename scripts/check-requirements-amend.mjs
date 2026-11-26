#!/usr/bin/env node
/**
 * check-requirements-amend.mjs — may /feature amend this open requirements
 * pull request?
 *
 * A requirements pull request is accepted by a person merging it. When a
 * reviewer finds something wrong in it first -- an assumption the writer
 * derived that does not hold -- the fix is /feature again, on the open branch,
 * as an AMENDMENT: a new run folder, the document revised in place, a fresh
 * review bound to the new bytes, new commits on the same branch. This file is
 * the start of that run. It says, from git alone, whether the checkout in
 * front of it is a branch an amendment may be made on, and refuses otherwise.
 *
 *   usage:  node scripts/check-requirements-amend.mjs <SLUG>
 *           node scripts/check-requirements-amend.mjs <SLUG> --global "Global: vX.Y.Z <40-hex>"
 *
 * What it checks -- every rule, before it exits
 *   1. The branch: the checkout is on requirements/<SLUG>, the branch /feature
 *      opened the pull request from.
 *   2. The working tree: nothing modified, staged or untracked anywhere, each
 *      file named. The run commits what it writes, and only that.
 *   3. In step with the remote: HEAD is origin/requirements/<SLUG> after a
 *      forced fetch -- not behind it (a reviewer pushed; pull first), not ahead
 *      of it (push first), not apart from it.
 *   4. The document and its review: docs/requirements/<SLUG>/requirements.md
 *      and requirements-review.md are both committed at HEAD.
 *   5. Not merged: the branch's tip is not already on the trunk. A merged
 *      branch is accepted, and changing what it says is a revision after the
 *      merge, run from the trunk (feature.md § Running it again).
 *   6. Only with --global: the move of the feature's global release goes
 *      forward. The value is the last line scripts/read-global.mjs --resolve
 *      prints. It is compared with the `Global:` line of the document at HEAD,
 *      where an absent line counts as `Global: none`. A release with a higher
 *      version than the recorded one passes, and so does any release when the
 *      document records `none`. An equal or lower version is refused, and so is
 *      a move back to `none` (docs/proposals/global-context.md §6.3). Without
 *      --global the amendment keeps the line, and this rule does not run.
 *
 * What it does not check, and cannot: that the pull request is still OPEN.
 * Git knows "merged" and nothing else; a pull request closed without a merge
 * looks the same as an open one. /feature asks the person, in the turn that
 * confirms the kind of run, and generation.md §8 records it.
 *
 * Exit codes -- the shared vocabulary:
 *   0  an amendment may start      -> prints the start commit and the hash
 *                                     of the document the last review approved
 *   1  at least one rule failed    -> all findings printed
 *   2  cannot verify               -> the remote is unreachable, or its default
 *                                     branch is not the trunk named
 *   3  usage error                 -> no slug, one that is not kebab-case, or
 *                                     a --global value that is not a Global:
 *                                     line read-global.mjs prints
 *   4  internal error
 *
 * Design notes
 *   - Same remote discipline as check-requirements.js: force-fetch first,
 *     confirm the trunk (HARNESS_TRUNK, or main) is the remote's default
 *     branch, never trust a stale ref.
 *   - Reads git only. No forge API: the harness assumes no particular host for
 *     its pull requests.
 *   - Node standard library only, plus git via child_process. ES module, .mjs
 *     in both layouts: it imports nothing and is renamed nowhere.
 *   - Runs from any directory inside the repository.
 */

import { execFileSync } from 'node:child_process';
import { writeSync } from 'node:fs';

const EXIT = { PASS: 0, CHECK_FAIL: 1, CANNOT_VERIFY: 2, USAGE: 3, INTERNAL: 4 };

const CONFIG = {
  trunk: process.env.HARNESS_TRUNK || 'main',
  remote: 'origin',
  // requirementsDir, documentFile, reviewFile and slugPattern are copies of
  // check-requirements.js's. Change one there, change it here in the same commit
  // (generation.md row 88b).
  requirementsDir: 'docs/requirements',
  documentFile: 'requirements.md',
  reviewFile: 'requirements-review.md',
  // The branch /feature opens the pull request from (feature.md step 11).
  branchPrefix: 'requirements/',
  slugPattern: /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
  // globalLabel, globalLine, globalNone, globalValue and releaseTag are copies
  // of check-requirements.js's. Change one there, change it here in the same
  // commit (generation.md §3.2).
  globalLabel: 'Global',
  globalLine: /^Global:[ \t]*(\S.*?)\s*$/,
  globalNone: 'none',
  globalValue: /^(\S+) (\S+)$/,
  releaseTag: /^v(\d+)\.(\d+)\.(\d+)$/,
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
  const invoked = process.argv[1] || 'scripts/check-requirements-amend.mjs';
  if (message) process.stderr.write(`${message}\n`);
  process.stderr.write(`usage: node ${invoked} <SLUG> [--global "Global: vX.Y.Z <40-hex>"]   e.g. payments-onboarding (kebab-case, as /feature minted it)\n`);
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

/* ------------------------------------------------------------ global release */

// A `Global:` value: `{ none: true }`, `{ tag, commit, version }` for a release
// tag and a full commit hash, or null for anything else.
function parseGlobal(value) {
  if (value === CONFIG.globalNone) return { none: true };
  const m = value.match(CONFIG.globalValue);
  if (!m) return null;
  const tag = m[1].match(CONFIG.releaseTag);
  if (!tag || m[2].search(/^[0-9a-f]{40}$/) !== 0) return null;
  return { none: false, tag: m[1], commit: m[2], version: tag.slice(1, 4).map(Number) };
}

const describe = (g) => (g.none ? `"${CONFIG.globalLabel}: ${CONFIG.globalNone}"` : g.tag);

// Negative, zero or positive, as `a` is lower than, equal to or higher than `b`.
function compareVersions(a, b) {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

// The `Global:` lines of a document, outside fenced code and HTML comments: the
// lines a reader sees, as check-requirements.js reads them.
function globalClaims(text) {
  const claims = [];
  let fence = null;
  let comment = false;
  String(text).split(/\r\n|\n|\r/).forEach((line, i) => {
    if (comment) {
      if (line.includes('-->')) comment = false;
      return;
    }
    const opener = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (fence) {
      if (opener && opener[1][0] === fence[0] && opener[1].length >= fence.length) fence = null;
      return;
    }
    if (opener) {
      fence = opener[1];
      return;
    }
    if (line.search(/^ {0,3}<!--/) === 0) {
      if (!line.includes('-->')) comment = true;
      return;
    }
    const m = line.match(CONFIG.globalLine);
    if (m) claims.push({ no: i + 1, value: m[1] });
  });
  return claims;
}

// Rule 6: a move goes forward only. `target` is the parsed --global value.
function checkGlobalMove(c, documentPath, text, target) {
  const claims = globalClaims(text);
  if (claims.length > 1) {
    c.fail(`${documentPath} at HEAD carries ${claims.length} "${CONFIG.globalLabel}:" lines (lines ${claims.map((x) => x.no).join(', ')}), so there is no one release to move from. requirements-gate fails the document too`);
    return null;
  }
  const recorded = claims.length ? parseGlobal(claims[0].value) : { none: true };
  if (recorded === null) {
    c.fail(`${documentPath} line ${claims[0].no} at HEAD reads "${CONFIG.globalLabel}: ${claims[0].value}", which is neither "${CONFIG.globalLabel}: ${CONFIG.globalNone}" nor a release tag and a commit, so there is no release to compare with. requirements-gate fails the document too`);
    return null;
  }
  if (target.none) {
    c.fail(recorded.none
      ? `the document already records "${CONFIG.globalLabel}: ${CONFIG.globalNone}", so this is not a move. Start without --global to keep the line`
      : `the document records ${recorded.tag}, and a move back to "${CONFIG.globalLabel}: ${CONFIG.globalNone}" goes backward. A move goes forward only`);
    return null;
  }
  if (!recorded.none) {
    const order = compareVersions(target.version, recorded.version);
    if (order === 0) {
      c.fail(`the document already records ${recorded.tag}, and ${target.tag} is an equal version, so this is not a move forward. Start without --global to keep the line`);
      return null;
    }
    if (order < 0) {
      c.fail(`the document records ${recorded.tag}, and ${target.tag} is an older version. A move goes forward only`);
      return null;
    }
  }
  return recorded;
}

/* ---------------------------------------------------------------------- main */

function main() {
  const args = process.argv.slice(2);
  let target = null;
  if (args.length === 3 && args[1] === '--global') {
    const m = args[2].match(CONFIG.globalLine);
    target = m ? parseGlobal(m[1]) : null;
    if (target === null) usage(`"${args[2]}" is not a line scripts/read-global.mjs --resolve prints: "${CONFIG.globalLabel}: ${CONFIG.globalNone}" or "${CONFIG.globalLabel}: vX.Y.Z <40-hex>"`);
  } else if (args.length !== 1) {
    usage();
  }
  const slug = args[0];
  if (slug.search(CONFIG.slugPattern) !== 0) usage(`"${slug}" is not a slug`);
  const branch = `${CONFIG.branchPrefix}${slug}`;
  const documentPath = `${CONFIG.requirementsDir}/${slug}/${CONFIG.documentFile}`;
  const reviewPath = `${CONFIG.requirementsDir}/${slug}/${CONFIG.reviewFile}`;

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
  const branchTip = remote.heads.has(branch) ? fetchBranch(root, branch) : null;

  // Rule 1 -- the branch.
  const c1 = check('branch');
  const current = branchName(root);
  if (current !== branch) {
    c1.fail(`the checkout is on ${current === null ? 'a detached HEAD' : `"${current}"`}; an amendment starts on "${branch}", the branch the open pull request is from. Check it out and re-run`);
  }

  // Rule 2 -- the working tree.
  const c2 = check('working tree');
  const dirty = uncommitted(root);
  if (dirty.length) {
    c2.fail(`the working tree has uncommitted changes, and the run commits what it writes and nothing else:\n${dirty.map((f) => `             ${f}`).join('\n')}\n           Commit them, or discard them, then re-run`);
  }

  // Rule 3 -- in step with the remote.
  const c3 = check('in step with the remote');
  const offBranch = `skipped: the checkout is not on "${branch}", so HEAD is not the pull request's commit`;
  if (current !== branch) {
    c3.fail(offBranch);
  } else if (branchTip === null) {
    c3.fail(`${CONFIG.remote} has no branch "${branch}", so no pull request can be open from it. A first run starts on a clean ${CONFIG.trunk}`);
  } else if (head !== branchTip) {
    if (isAncestor(root, head, branchTip)) c3.fail(`HEAD (${short(head)}) is behind ${CONFIG.remote}/${branch} (${short(branchTip)}): someone pushed to the pull request. Pull first, so the amendment starts from what the reviewer read`);
    else if (isAncestor(root, branchTip, head)) c3.fail(`HEAD (${short(head)}) is ahead of ${CONFIG.remote}/${branch} (${short(branchTip)}): commits nobody has reviewed. Push them, or drop them, first`);
    else c3.fail(`HEAD (${short(head)}) and ${CONFIG.remote}/${branch} (${short(branchTip)}) have gone apart. Settle the branch with the person who pushed, then re-run`);
  }

  // Rule 4 -- the document and its review, committed at HEAD.
  const c4 = check('document and review');
  const documentBlob = blobAt(root, head, documentPath);
  if (current !== branch) c4.fail(offBranch);
  else if (documentBlob === null) c4.fail(`HEAD carries no ${documentPath}; there is nothing to amend`);
  if (current === branch && blobAt(root, head, reviewPath) === null) c4.fail(`HEAD carries no ${reviewPath}; a run that never reached its review is finished, not amended -- delete its branch and start again from ${CONFIG.trunk}`);

  // Rule 5 -- not merged.
  const c5 = check('not merged');
  const tip = branchTip === null ? head : branchTip;
  if (isAncestor(root, tip, trunkTip)) {
    c5.fail(`${branchTip === null ? 'HEAD' : `${CONFIG.remote}/${branch}`} (${short(tip)}) is already on ${CONFIG.remote}/${CONFIG.trunk}: the pull request was merged, and the document is accepted. A change to it now is a revision after the merge -- run /feature from a clean ${CONFIG.trunk}`);
  }

  // Rule 6 -- the move of the global release, only when one is asked for.
  let recorded = null;
  if (target !== null) {
    const c6 = check('global release');
    if (current !== branch) c6.fail(offBranch);
    else if (documentBlob === null) c6.fail(`skipped: HEAD carries no ${documentPath}`);
    else recorded = checkGlobalMove(c6, documentPath, git(['cat-file', 'blob', documentBlob], root), target);
  }

  const failed = checks.filter((c) => c.failures.length > 0);
  const width = Math.max(...checks.map((c) => c.name.length));
  process.stdout.write(`\n${slug} amendment start  (${branch} against ${CONFIG.remote}/${CONFIG.trunk})\n\n`);
  for (const c of checks) {
    process.stdout.write(`  [${c.failures.length ? 'FAIL' : 'PASS'}] ${c.name.padEnd(width)}`.trimEnd() + '\n');
    for (const f of c.failures) process.stdout.write(`         - ${f}\n`);
  }
  if (failed.length) {
    process.stdout.write(`\nAMENDMENT REFUSED: ${failed.length} of ${checks.length} rules failed.\n\n`);
    process.exit(EXIT.CHECK_FAIL);
  }
  process.stdout.write(`\n  start commit: ${head}\n  document:     ${documentPath} @ ${documentBlob}\n`);
  if (recorded !== null) process.stdout.write(`  global:       ${describe(recorded)} -> ${describe(target)} ${target.commit}\n`);
  process.stdout.write('\nAMENDMENT START OK: not merged. Ask the person whether its pull request is still open; git cannot tell.\n\n');
  process.exit(EXIT.PASS);
}

// The last line of an exit 2, 3 or 4 names this script and its code, so a shell line that hides
// the code, with a pipe or `; echo`, still tells the harness's failure record. Written at once,
// so a process.exit() never loses it.
process.on('exit', (code) => { if (code >= 2 && code <= 4) { try { writeSync(2, `HARNESS EXIT: check-requirements-amend ${code}\n`); } catch { /* stderr is closed */ } } });

try {
  main();
} catch (err) {
  process.stderr.write(`INTERNAL ERROR: ${err && err.stack ? err.stack : String(err)}\n`);
  process.exit(EXIT.INTERNAL);
}

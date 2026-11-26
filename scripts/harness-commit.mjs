#!/usr/bin/env node
// Part of the harness asset library c6f3b4427d58f7c3 (see VERSION.json) · 2026-10-01
/**
 * harness-commit.mjs — the one way the installed harness makes a commit.
 *
 * It runs in the hub and spoke repositories the harness is installed into. The shl-harness
 * library repository itself is not watermarked: its own development commits are ordinary.
 *
 * Every harness commit path uses it: /feature, /decompose, /dev-spec, /dev-sprint, /qa-sprint,
 * /survey-repo, /add-repo, /add-context, /check-global --connect, the hub and spoke installation, and the hub and spoke
 * upgrade (scripts/upgrade.mjs imports it). It commits what is staged with the given message
 * and the watermark appended as its final line — the last git trailer (`rules/watermark.md`),
 * written by `git interpret-trailers` itself — after checking the whole
 * message with check-watermark.mjs — so git is never asked to create a commit that would fail.
 * In a spoke it then runs check-staged.mjs, the secret scan and the format, lint and type-check
 * rows of the trunk's checks.env, on what is staged, and asks git to commit only when they pass,
 * recording each row as a `Harness-Check:` trailer above the watermark; /dev-sprint's finalizer
 * commits its candidate here with every command of its frozen checks.env (check-staged.mjs). Those
 * checks are not a hook, so `git commit --no-verify` has nothing of theirs to skip. The spoke's
 * pre-commit hook runs the same scan, and is told it already ran (SHL_SECRET_SCANNED=1).
 * It never changes the person's git name, email or signing configuration.
 *
 *   usage:  node scripts/harness-commit.mjs [--repo <dir>] [--trunk-merge <commit>] -m <subject> [-m <paragraph>]...
 *           node scripts/harness-commit.mjs --install-hook <checkout> [--worktree]
 *
 *   -m              one paragraph each, in order. None may carry the watermark; it is appended
 *                   here, once, as the last trailer: into the final paragraph when that is
 *                   already a trailer block (Co-authored-by, Signed-off-by stay trailers),
 *                   otherwise as a final paragraph of its own.
 *   --repo          the checkout to commit in; default the current directory.
 *   --trunk-merge   commit the merge in progress of <commit>, a commit on the spoke's trunk, as
 *                   check-staged.mjs § The trunk merge judges it: git's own result, the secret scan
 *                   run, format, lint and type-check left to /dev-sprint's run on the merged tree.
 *                   The subject is `chore(<KEY>): merge the trunk at <12 hex of commit>`, because
 *                   /dev-sprint counts its fix rounds past these commits. The commit made has two
 *                   parents, HEAD before and <commit>, and the tree that was judged.
 *   --install-hook  write the commit-msg check into a checkout the harness works in (the hub
 *                   checkout /dev-spec makes, the code checkout /dev-sprint makes). --worktree writes per-worktree config, so nothing reaches
 *                   the person's own checkout. A person's commits pass the hook untouched. The
 *                   checkout's own hooks keep running: every hook is handed on to the hooks
 *                   folder in force before the install (core.hooksPath, or .git/hooks) — the
 *                   watermark check first, then the checkout's own commit-msg.
 *
 * The commit runs with HARNESS_COMMIT=1, so a commit-msg hook knows it is harness-managed.
 *
 * Exit codes: 0 committed · 1 the message fails the check, a commit check failed, or git refused
 * (a hook, nothing staged to commit) · 2 a commit check cannot verify · 3 usage · 4 internal.
 * Node standard library only, plus git.
 */

import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WATERMARK, claims, commentChar, watermarkProblem } from './check-watermark.mjs';
import { checkStaged } from './check-staged.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export { WATERMARK };

export class HarnessCommitError extends Error {
  constructor(code, message, reason = null) { super(message); this.code = code; this.reason = reason; }
}

function git(args, opts = {}) {
  const res = spawnSync('git', args, { encoding: 'utf8', ...opts });
  if (res.error) throw new HarnessCommitError(4, `git could not run: ${res.error.message}`);
  return res;
}

/**
 * The message the harness commits: the paragraphs, then `trailers` (the commit checks'
 * `Harness-Check:` lines, in order), then the watermark as the last trailer.
 */
export function harnessMessage(paragraphs, comment = '#', trailers = []) {
  const paras = (paragraphs || []).map((p) => String(p).trim()).filter(Boolean);
  if (!paras.length) throw new HarnessCommitError(3, 'a commit needs a subject: -m "<type>(<scope>): <summary>"');
  if (paras.some(claims)) throw new HarnessCommitError(3, `the message already carries the watermark; it is appended here, once, as the final line`);
  if (paras.some((p) => p.split('\n').some((l) => l.startsWith(comment)))) {
    throw new HarnessCommitError(3, `a message line starts with "${comment}", git's comment character; the commit-msg check drops comment lines, so write it another way`);
  }
  const res = git(['-c', 'trailer.separators=:', 'interpret-trailers', '--where', 'end', '--if-exists', 'add', '--if-missing', 'add', ...[...trailers, WATERMARK].flatMap((t) => ['--trailer', t])],
    { input: `${paras.join('\n\n')}\n` });
  if (res.status !== 0) throw new HarnessCommitError(4, `git interpret-trailers failed: ${res.stderr.trim()}`);
  return `${res.stdout.replace(/\s+$/, '')}\n`;
}

/**
 * Commit what is staged in `repo`. `gitArgs` are passed before `commit` unchanged — the upgrade
 * script's existing fallback identity for a machine with none configured; this function adds no
 * identity or signing setting of its own. `checks` is passed to check-staged.mjs unchanged — the
 * finalizer's candidate rows. `onChecks` receives the commit checks' report and result when their
 * rows ran and passed; a failing report is the error's message, and the result its `checks`.
 * `secretScanIfDeclared` is the upgrade's: a spoke that names no secret scan yet is let through
 * with a warning, which is how the requirement reaches it; story-gate still refuses that pull
 * request.
 */
export function harnessCommit({ repo = '.', paragraphs, gitArgs = [], checks: options = {}, onChecks = () => {}, secretScanIfDeclared = false }) {
  const comment = commentChar(repo);
  const lost = lostHook(repo);
  if (lost) process.stderr.write(`WARNING — ${lost}\n`);
  const problem = watermarkProblem(harnessMessage(paragraphs, comment));
  if (problem) throw new HarnessCommitError(1, `the message fails the watermark check: ${problem}`);
  const merging = options.trunkMerge !== undefined && options.trunkMerge !== null;
  const subject = String(paragraphs[0] ?? '').trim();
  if (merging && subject.search(TRUNK_MERGE_SUBJECT) !== 0) {
    throw new HarnessCommitError(3, `a trunk merge's subject is "chore(<KEY>): merge the trunk at <12 hex>", not ${JSON.stringify(subject)}`);
  }
  const before = merging ? git(['-C', repo, 'rev-parse', 'HEAD']).stdout.trim() : null;
  const checks = checkStaged({ ...options, repo, secretScanIfDeclared });
  if (checks.code !== 0) throw Object.assign(new HarnessCommitError(checks.code, `the commit checks did not pass — nothing committed:\n${checks.report.trim()}`, checks.reason || null), { checks });
  if (merging && !checks.merged.startsWith(subject.match(TRUNK_MERGE_SUBJECT)[1])) {
    throw new HarnessCommitError(3, `the subject names the trunk at ${subject.match(TRUNK_MERGE_SUBJECT)[1]}, and the merge in progress is of ${checks.merged.slice(0, 12)}`);
  }
  const judgedTree = merging ? git(['-C', repo, 'write-tree']).stdout.trim() : null;
  if (checks.ran) onChecks(checks.report, checks);
  // The rows that ran, as trailers above the watermark: the record, read back by nothing.
  const message = harnessMessage(paragraphs, comment, checks.trailers);
  const recorded = watermarkProblem(message);
  if (recorded) throw new HarnessCommitError(4, `the commit checks' trailers broke the watermark: ${recorded}`);
  const res = git(['-C', repo, ...gitArgs, 'commit', '--quiet', '--cleanup=whitespace', '-F', '-'],
    { input: message, env: { ...process.env, HARNESS_COMMIT: '1', ...(checks.scanned ? { SHL_SECRET_SCANNED: '1' } : {}) } });
  if (res.status !== 0) throw new HarnessCommitError(1, `git refused the commit — nothing committed:\n${`${res.stdout}${res.stderr}`.trim()}`);
  const sha = git(['-C', repo, 'rev-parse', 'HEAD']).stdout.trim();
  const after = watermarkProblem(git(['-C', repo, 'log', '-1', '--format=%B', sha]).stdout);
  if (after) throw new HarnessCommitError(1, `commit ${sha.slice(0, 12)} was made, but a hook changed its message: ${after}`);
  if (merging) {
    // What git committed is what was judged: a hook that changed the tree or the parents fails it.
    const [tree, ...parents] = git(['-C', repo, 'log', '-1', '--format=%T %P', sha]).stdout.trim().split(' ');
    if (tree !== judgedTree || parents.length !== 2 || parents[0] !== before || parents[1] !== checks.merged) {
      throw new HarnessCommitError(1, `commit ${sha.slice(0, 12)} was made, but it is not the judged merge: tree ${tree.slice(0, 12)} with parents ${parents.map((p) => p.slice(0, 12)).join(', ')}, where the merge of ${checks.merged.slice(0, 12)} into ${before.slice(0, 12)} has tree ${judgedTree.slice(0, 12)}. A hook changed it`);
    }
  }
  return sha;
}

// The subject of a trunk merge, with the 12 hex of the trunk commit it merges.
const TRUNK_MERGE_SUBJECT = /^chore\([^()\s]+\): merge the trunk at ([0-9a-f]{12})$/;

// Every client-side hook git runs. Each is handed on to the hooks folder in force before the
// install, so a checkout's pre-commit, pre-push, husky or lefthook keep running.
const HOOKS = [
  'applypatch-msg', 'pre-applypatch', 'post-applypatch', 'pre-commit', 'pre-merge-commit',
  'prepare-commit-msg', 'commit-msg', 'post-commit', 'pre-rebase', 'post-checkout', 'post-merge',
  'pre-push', 'post-rewrite', 'pre-auto-gc', 'sendemail-validate', 'post-index-change',
  'reference-transaction',
];
const CHAIN_FILE = '.chained-to';
const shq = (v) => `'${String(v).replace(/'/g, `'\\''`)}'`;

function hooksFolder(checkout) {
  const r = git(['-C', checkout, 'rev-parse', '--path-format=absolute', '--git-path', 'hooks']);
  if (r.status !== 0) throw new HarnessCommitError(1, `cannot read the hooks folder of ${checkout}: ${r.stderr.trim()}`);
  return r.stdout.trim();
}

function harnessHooks(checkout) {
  const r = git(['-C', checkout, 'rev-parse', '--absolute-git-dir']);
  if (r.status !== 0) throw new HarnessCommitError(1, `${checkout} is not a git checkout`);
  return join(r.stdout.trim(), 'harness-hooks');
}

/** Why this checkout's watermark hook no longer runs, or null when it runs or was never installed. */
export function lostHook(checkout) {
  try {
    const ours = harnessHooks(checkout);
    if (!existsSync(join(ours, CHAIN_FILE))) return null;
    const active = hooksFolder(checkout);
    return active === ours ? null : `the watermark hook installed in this checkout no longer runs: core.hooksPath now points at ${active}. The helper still checks its own commits; run harness-commit.mjs --install-hook again to restore the local check`;
  } catch (err) { return null; }
}

/** The commit-msg check, chained in front of the checkout's own hooks rather than replacing them. */
export function installHook({ checkout, worktree = false }) {
  const scope = worktree ? ['--worktree'] : [];
  const run = (args) => {
    const r = git(['-C', checkout, ...args]);
    if (r.status !== 0) throw new HarnessCommitError(1, `git ${args.join(' ')}: ${r.stderr.trim()}`);
    return r.stdout.trim();
  };
  if (worktree) run(['config', 'extensions.worktreeConfig', 'true']);
  const hooks = harnessHooks(checkout);
  const current = hooksFolder(checkout);
  // Installing twice keeps the first chain: never chain the folder to itself.
  const previous = current === hooks && existsSync(join(hooks, CHAIN_FILE)) ? readFileSync(join(hooks, CHAIN_FILE), 'utf8').trim() : current;
  mkdirSync(hooks, { recursive: true });
  writeFileSync(join(hooks, CHAIN_FILE), `${previous}\n`);
  const handOn = (name) => `prev=${shq(previous)}\n[ -x "$prev/${name}" ] && exec "$prev/${name}" "$@"\nexit 0\n`;
  for (const name of HOOKS) {
    const head = '#!/bin/sh\n# Written by harness-commit.mjs (rules/watermark.md).';
    const body = name === 'commit-msg'
      ? `${head} The watermark check, then this checkout's own commit-msg hook.\nnode ${shq(join(HERE, 'check-watermark.mjs'))} --commit-msg "$1" || exit $?\n${handOn(name)}`
      : `${head} Hands ${name} on to this checkout's own hooks.\n${handOn(name)}`;
    writeFileSync(join(hooks, name), body);
    chmodSync(join(hooks, name), 0o755);
  }
  run(['config', ...scope, 'core.hooksPath', hooks]);
  return { hook: join(hooks, 'commit-msg'), previous };
}

function main(argv) {
  const o = { paragraphs: [], worktree: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const value = () => { if (argv[i + 1] === undefined) throw new HarnessCommitError(3, `${a} needs a value`); i += 1; return argv[i]; };
    if (a === '-m') o.paragraphs.push(value());
    else if (a === '--repo') o.repo = value();
    else if (a === '--install-hook') o.hook = value();
    else if (a === '--worktree') o.worktree = true;
    else if (a === '--trunk-merge') o.trunkMerge = value();
    else throw new HarnessCommitError(3, `unknown argument: ${a}`);
  }
  if (o.hook !== undefined) {
    if (o.paragraphs.length || o.repo || o.trunkMerge) throw new HarnessCommitError(3, '--install-hook takes no message');
    const r = installHook({ checkout: o.hook, worktree: o.worktree });
    process.stdout.write(`HARNESS HOOK INSTALLED — ${r.hook}, then this checkout's own hooks in ${r.previous}\n`);
    return 0;
  }
  const sha = harnessCommit({ repo: o.repo || '.', paragraphs: o.paragraphs, checks: o.trunkMerge ? { trunkMerge: o.trunkMerge } : {}, onChecks: (report) => process.stdout.write(report) });
  process.stdout.write(`HARNESS COMMIT ${sha} — the message ends with "${WATERMARK}"\n`);
  return 0;
}

const invoked = (() => { try { return realpathSync(process.argv[1] || '') === realpathSync(fileURLToPath(import.meta.url)); } catch (err) { return false; } })();
if (invoked) {
  // The last line of an exit 2, 3 or 4 names this script and its code, so a shell line that hides
  // the code, with a pipe or `; echo`, still tells the harness's failure record. Written at once,
  // so a process.exit() never loses it.
  process.on('exit', (code) => { if (code >= 2 && code <= 4) { try { writeSync(2, `HARNESS EXIT: harness-commit ${code}\n`); } catch { /* stderr is closed */ } } });
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (err) {
    const code = err instanceof HarnessCommitError ? err.code : 4;
    process.stderr.write(`${code === 3 ? 'USAGE' : code === 4 ? 'INTERNAL' : code === 2 ? 'HARNESS COMMIT CANNOT VERIFY' : 'HARNESS COMMIT REFUSED'} — ${err.message}\n`);
    // The checks' report ends with its REASON line already. Any other cause names its own here.
    const said = `REASON: ${err.reason}`;
    if (code === 2 && err.reason && !err.message.trimEnd().endsWith(said)) process.stderr.write(`${said}\n`);
    process.exit(code);
  }
}

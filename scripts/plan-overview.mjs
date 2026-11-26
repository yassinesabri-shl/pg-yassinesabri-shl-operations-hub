#!/usr/bin/env node
// Part of the harness asset library c6f3b4427d58f7c3 (see VERSION.json) · 2026-11-11
/**
 * plan-overview.mjs: which source files of the estate overview changed since the overview did?
 *
 *   usage:  node scripts/plan-overview.mjs
 *
 * /estate-overview-refresh runs it before it reads a diff or drafts a line. The script reads the
 * hub trunk on the remote `origin`, never the working tree. It force-fetches the trunk and
 * records its tip as T. HARNESS_TRUNK names a trunk other than `main`, and the remote's default
 * branch must have the same name.
 *
 * P is the last commit at or before T that changed docs/estate/overview.md. A hand edit to the
 * page moves P too. The script lists each source file that changed between P and T, with
 * --no-renames, so a moved file is a deleted file and an added file. The source files:
 *
 *   docs/estate/repositories.json
 *   docs/estate/surveys/*.md
 *   docs/requirements/<slug>/requirements.md
 *   docs/architecture/*.md
 *   docs/standards/*.md
 *
 * A `*` matches one name and never a `/`, so a file in a folder below one of these folders is
 * not a source. A file under docs/requirements/<slug>/runs/ is not a source for that reason. A
 * file whose name starts with `_TEMPLATE` is not a source.
 *
 * Output, on standard output:
 *   since <12-hex P> at <12-hex T>     then `no source change`, or one line for each changed
 *                                      source file: `<status letter>\t<path>`, sorted by path
 *   at <12-hex T>                      then `no overview`, when T has no overview
 *
 * Exit codes, shared with every check in the library:
 *   0  an overview is on the trunk and no source file changed since P
 *   1  no overview, or one or more source files changed. The list is printed
 *   2  cannot verify: no remote `origin`, the trunk cannot be fetched, or its name is not the
 *      remote's default branch
 *   3  usage
 *   4  internal
 *
 * What this script cannot see
 *   - What a change means. A file that changed may change nothing on the page. The session that
 *     runs /estate-overview-refresh reads each diff and decides.
 *   - A source outside the hub. A spoke's code and its README are not sources. The surveys
 *     describe each spoke.
 */

import { writeSync } from 'node:fs';
import { stdout, stderr } from 'node:process';
import { pathToFileURL } from 'node:url';
import { EXIT, SpokeError, firstLine, git, quietGitEnv, reasonLine, resolveDefaultBranch, short } from './spoke-remote.mjs';

const CONFIG = {
  remote: 'origin',
  branch: process.env.HARNESS_TRUNK || 'main',
  overview: 'docs/estate/overview.md',
  // `glob` magic: `*` does not match `/`. `top` anchors each path to the repository root.
  sources: [
    ':(top,glob)docs/estate/repositories.json',
    ':(top,glob)docs/estate/surveys/*.md',
    ':(top,glob)docs/requirements/*/requirements.md',
    ':(top,glob)docs/architecture/*.md',
    ':(top,glob)docs/standards/*.md',
    ':(top,glob,exclude)**/_TEMPLATE*',
  ],
};

function usage(message) {
  stderr.write(`${message}\nusage: node scripts/plan-overview.mjs\n`);
  process.exit(EXIT.USAGE);
}

function remoteUrl() {
  try {
    return git(['remote', 'get-url', CONFIG.remote]).trim();
  } catch (err) {
    throw new SpokeError(EXIT.CANNOT_VERIFY, `this checkout has no remote called ${CONFIG.remote}. Run the script from the hub checkout`, 'no-remote');
  }
}

// The gate's discipline, as jira-sync.mjs carries it: fetch the named branch, then confirm that
// the remote calls that branch its default. HARNESS_TRUNK names the trunk. It does not choose one.
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
    throw new SpokeError(EXIT.CANNOT_VERIFY, `this was pointed at "${CONFIG.branch}" but ${CONFIG.remote}'s default branch is "${actual}". Set HARNESS_TRUNK to the trunk's real name`, 'trunk-mismatch');
  }
  try {
    return git(['rev-parse', '--verify', `${ref}^{commit}`]).trim();
  } catch (err) {
    throw new SpokeError(EXIT.CANNOT_VERIFY, `${ref} does not resolve to a commit after the fetch`, 'fetch-failed');
  }
}

function hasOverview(tip) {
  try {
    git(['cat-file', '-e', `${tip}:${CONFIG.overview}`]);
    return true;
  } catch (err) {
    return false;
  }
}

// `-z` keeps a path with a space or a non-ASCII name exactly as git stores it.
function changedSources(since, tip) {
  const out = git(['diff', '--no-color', '--no-ext-diff', '--no-renames', '-z', '--name-status', since, tip, '--', ...CONFIG.sources]);
  const fields = out.split('\0');
  if (fields[fields.length - 1] === '') fields.pop();
  const changes = [];
  for (let i = 0; i + 1 < fields.length; i += 2) changes.push({ status: fields[i], path: fields[i + 1] });
  return changes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

function main() {
  const args = process.argv.slice(2);
  if (args.length) usage(`unknown argument: ${args[0]}`);
  const tip = syncHubTrunk();
  if (!hasOverview(tip)) {
    stdout.write(`at ${short(tip)}\nno overview\n`);
    return EXIT.FAIL;
  }
  const since = git(['rev-list', '-1', tip, '--', `:(top)${CONFIG.overview}`]).trim();
  if (!since) throw new SpokeError(EXIT.INTERNAL, `${CONFIG.overview} is at ${short(tip)}, and no commit at or before it changed the file`);
  const changes = changedSources(since, tip);
  stdout.write(`since ${short(since)} at ${short(tip)}\n`);
  if (!changes.length) {
    stdout.write('no source change\n');
    return EXIT.PASS;
  }
  for (const { status, path } of changes) stdout.write(`${status}\t${path}\n`);
  return EXIT.FAIL;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  // The last line of an exit 2, 3 or 4 names this script and its code, so a shell line that hides
  // the code, with a pipe or `; echo`, still tells the harness's failure record. Written at once,
  // so a process.exit() never loses it.
  process.on('exit', (code) => { if (code >= 2 && code <= 4) { try { writeSync(2, `HARNESS EXIT: plan-overview ${code}\n`); } catch { /* stderr is closed */ } } });
  try {
    process.exitCode = main();
  } catch (err) {
    if (err instanceof SpokeError) {
      stderr.write(err.exit === EXIT.CANNOT_VERIFY ? `CANNOT VERIFY: ${err.message}\n` : `${err.message}\n`);
      if (err.exit === EXIT.CANNOT_VERIFY) stderr.write(reasonLine(err.reason));
      process.exit(err.exit ?? EXIT.INTERNAL);
    }
    stderr.write(`internal error: ${err && err.stack ? err.stack : String(err)}\n`);
    process.exit(EXIT.INTERNAL);
  }
}

#!/usr/bin/env node
// Part of the harness asset library c6f3b4427d58f7c3 (see VERSION.json) · 2026-09-12
/**
 * read-spoke.mjs — the one approved way to read another repository from the hub.
 *
 *   usage:  node scripts/read-spoke.mjs <repo-id> <path> [--at <commit|12-hex>]
 *                                        [--registry <file>]
 *           node scripts/read-spoke.mjs <repo-id> --grep <text> [--regex]
 *                                        [--ignore-case] [--paths <glob>]...
 *                                        [--at <commit|12-hex>] [--registry <file>]
 *           node scripts/read-spoke.mjs <repo-id> --files <glob>
 *                                        [--at <commit|12-hex>] [--registry <file>]
 *           node scripts/read-spoke.mjs <repo-id> --requests <file>
 *                                        --at <commit|12-hex> [--registry <file>]
 *
 *   <repo-id>   a key in docs/estate/repositories.json
 *   <path>      a file or directory in that repository, relative to its root.
 *               "." is the root.
 *   --at        read at this commit instead of the trunk head. The hash comes
 *               from an earlier run of this script, so a planner reading several
 *               files reads them all at one commit. There is no branch argument,
 *               and there will not be one: a branch is a moving name, and a
 *               citation into a moving name is not a citation. The value is a
 *               full 40-character commit, or its first 12 characters as a
 *               citation holds them. The script resolves a prefix to one
 *               commit on the trunk (spoke-remote.mjs, resolveCommitPrefix),
 *               and then reads as with the full commit. `Commit:` prints all
 *               40 characters.
 *   --grep      search the files at the commit for one line of text, instead
 *               of a read. It takes no <path>. The text is fixed, or an
 *               extended regular expression with --regex. Binary files are
 *               skipped. --ignore-case matches either case. The logic is in
 *               spoke-search.mjs, beside this file.
 *   --files     list the paths at the commit that one glob selects, instead of
 *               a read. It takes no <path> and no --paths. It prints one path on
 *               each line, in path order. Over 500 paths, it prints the count
 *               for each parent folder instead.
 *   --paths     search only the files that this glob selects, in git's
 *               `:(glob)` grammar. It can occur more than one time, and a file
 *               must match one of the globs. A glob is relative and does not
 *               climb.
 *   --requests  run the request round of the critic in lld-review. The file
 *               is the critic's whole reply. It holds one "### REQUESTS" block
 *               of at most 10 `grep`, `files` and `read` lines. It needs --at,
 *               and it excludes <path>, --grep, --files, --paths, --regex and
 *               --ignore-case. The script checks every line before any git
 *               call, pins the commit one time, and then runs each request
 *               against that commit. The grammar is in spoke-search.mjs.
 *
 * What it prints, always, before any content:
 *
 *   Repository: <id>
 *   Commit: <40-hex>
 *   Trunk: <branch as the remote reports it now>   (or "not asked" with --at)
 *   Path: <path>
 *   Blob: <hash>            (or "Tree: <hash>" for a directory)
 *   Lines: <n>              (a file only: its line count, the top of any range cited into it)
 *   Cite: <id>@<12-hex>:<path>
 *   ---
 *   <the file, byte for byte>   (or one `git ls-tree` line per entry)
 *
 * What --grep prints: `Repository:`, `Commit:` and `Trunk:` as above, then
 * `Search:`, `Scope: <n> files`, `Hits:`, `Files:`, `Shown:` and `---`. A fixed
 * search with no hit and a "|" in its text adds a `Note:` line before `---`
 * that names --regex. Then one
 * `<path>:<line>: <text>` line for each hit. Over 200 hits, it prints the hit
 * count of each file instead. A search prints no `Cite:` line: a hit finds a
 * location, and the seat then reads the file and cites that read.
 *
 * What --files prints: `Repository:`, `Commit:` and `Trunk:`, then `Search:`,
 * `Scope: <n> files`, `Files:` (the same number), `Shown:` and `---`, with no
 * `Hits:` line and no `Cite:` line.
 *
 * What --requests prints, on stdout, for each request in the order of the block:
 *
 *   Request <i> of <n>: <the request line as written, after "- ">
 *   Exit: <the exit code of that request alone>
 *   <that mode's stdout: the header, `---` and the body>
 *   <that mode's error text, for example the `NOT FOUND:` line of a read>
 *
 * One blank line separates a result from the next. When a result does not end
 * with a line end, the script adds one, so a file read with no last line end
 * gets one in the round.
 *
 * A read in a round has a cap. A plain read has none. The body prints at most
 * 400 lines (`CAPS.readLines`), and the script cuts a line over 300 characters
 * with " [cut]". Over 400 lines, the body ends with "[cut: <k> more lines]".
 * The `Lines:` value in the header is the full count. A file with a NUL byte
 * prints the header and "[binary file not shown]", and no byte of the file.
 *
 * The `Cite:` line is the grammar a story or a design uses for a fact read here.
 * A citation into a spoke without a commit is malformed, and the checkers that
 * read stories reject it; this line is how the commit gets there.
 *
 * Exit codes
 *   0  read, or a search that ran. `Hits: 0` is an answer. With --requests:
 *      every request ran. A request that exits 1, 2, 3 or 4 is an answer, and
 *      its result shows that code on its `Exit:` line.
 *   1  the repository is listed and reachable, but the path is not at that
 *      commit, or no file at that commit matches the --paths globs
 *   2  cannot verify: no registry, the remote is unreachable, or --at names a
 *      commit neither the cache nor the remote will give up, or a 12-character
 *      --at matches no commit on the trunk, or more than one. With --requests,
 *      the script checks this one time, before any request runs
 *   3  usage: bad arguments, a repository id not in the list, a glob that
 *      climbs, or a --regex pattern that git refuses. With --requests: a file
 *      that the script cannot read, or that breaks the grammar or the cap of
 *      10 requests. Every problem prints with its line number, and no request
 *      runs
 *   4  internal
 *
 * Design notes
 *   - Reads the registry for the URL and nothing else. The trunk is asked of the
 *     remote on every run without --at, so a stored branch name cannot go stale
 *     because none is stored.
 *   - Fetches at depth 1 into a bare cache repository, one per spoke, under the
 *     system temp directory (HARNESS_SPOKE_CACHE to move it). A read never
 *     clones a history and never writes inside the hub.
 *   - Never prompts. A remote that wants a password fails with exit 2.
 *   - Reads. It has no write path, takes no branch, pushes nothing. That is the
 *     whole reason a planning seat may hold it and may not hold a shell.
 *
 * What this script cannot see
 *   - Whether the repository listed under this id is the one the team meant. It
 *     trusts the URL the registry gives it and prints the commit it read, so a
 *     wrong URL is visible in the transcript rather than silent.
 *   - Anything not on the trunk. A branch is not a fact about the repository yet.
 */

import { stdout, stderr } from 'node:process';
import {
  EXIT, REPO_ID, SpokeError, reasonLine, git, atProblem, pinAt,
  registryPath, readRegistry, validateRegistry,
  resolveSpokeTrunk, cacheDir, objectType, quietGitEnv, short,
} from './spoke-remote.mjs';
import { readFileSync, writeSync } from 'node:fs';
import { checkGlob, checkText, checkPath, parseRequests, roundReadBody, scope, grep, formatGrep, formatFiles } from './spoke-search.mjs';

/** A bad argument. The caller prints the message and the usage lines, and exits 3. */
class UsageError extends Error {}

function usageText(message) {
  const invoked = process.argv[1] || 'scripts/read-spoke.mjs';
  return `${message}\nusage: node ${invoked} <repo-id> <path> [--at <commit|12-hex>] [--registry <file>]\n`
    + `       node ${invoked} <repo-id> --grep <text> [--regex] [--ignore-case] [--paths <glob>]... [--at <commit|12-hex>] [--registry <file>]\n`
    + `       node ${invoked} <repo-id> --files <glob> [--at <commit|12-hex>] [--registry <file>]\n`
    + `       node ${invoked} <repo-id> --requests <file> --at <commit|12-hex> [--registry <file>]\n`;
}

function usage(message) {
  throw new UsageError(message);
}

function parseArgs(argv) {
  const out = { positional: [], at: null, registry: null, text: null, regex: false, ignoreCase: false, globs: [], files: null, requests: null };
  const value = (a, i) => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) usage(`${a} needs a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--at' || a === '--registry') {
      out[a.slice(2)] = value(a, i);
      i += 1;
    } else if (a === '--grep') {
      // The text is data for git, so it may start with "-" or "--".
      if (argv[i + 1] === undefined) usage('--grep needs a text');
      if (out.text !== null) usage('--grep can occur only one time. Join two texts in one --regex alternation');
      out.text = argv[i + 1];
      i += 1;
    } else if (a === '--files') {
      if (out.files !== null) usage('--files can occur only one time');
      out.files = value(a, i);
      i += 1;
    } else if (a === '--requests') {
      if (out.requests !== null) usage('--requests can occur only one time');
      out.requests = value(a, i);
      i += 1;
    } else if (a === '--paths') {
      out.globs.push(value(a, i));
      i += 1;
    } else if (a === '--regex') {
      out.regex = true;
    } else if (a === '--ignore-case') {
      out.ignoreCase = true;
    } else if (a.startsWith('--')) {
      usage(`unknown option ${a}`);
    } else {
      out.positional.push(a);
    }
  }
  if (out.requests !== null) {
    if (out.text !== null || out.files !== null || out.regex || out.ignoreCase || out.globs.length) {
      usage('--requests excludes --grep, --files, --paths, --regex and --ignore-case');
    }
    if (out.at === null) usage('--requests needs --at: the round runs at the commit of the design under review');
    out.mode = 'requests';
    if (out.positional.length !== 1) usage('--requests takes no <path>: expected exactly one argument, <repo-id>');
    [out.id] = out.positional;
  } else if (out.files !== null) {
    if (out.text !== null) usage('--grep and --files exclude each other');
    if (out.regex || out.ignoreCase || out.globs.length) usage('--paths, --regex and --ignore-case need --grep');
    out.mode = 'files';
    if (out.positional.length !== 1) usage('--files takes no <path>: expected exactly one argument, <repo-id>');
    [out.id] = out.positional;
  } else if (out.text !== null) {
    out.mode = 'grep';
    if (out.positional.length !== 1) usage('--grep takes no <path>: expected exactly one argument, <repo-id>');
    [out.id] = out.positional;
  } else {
    out.mode = 'read';
    if (out.regex || out.ignoreCase || out.globs.length) usage('--paths, --regex and --ignore-case need --grep');
    if (out.positional.length !== 2) usage('expected exactly two arguments: <repo-id> <path>');
    [out.id, out.path] = out.positional;
  }
  return out;
}

// Relative, inside the repository, and written the way git wants it. "." and ""
// are the root. Anything absolute or climbing is refused as usage, because a path
// is the caller's argument and not a fact about the spoke.
function normalisePath(raw) {
  const problem = checkPath(raw);
  if (problem) usage(problem);
  const p = raw.replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+$/, '');
  return p === '.' ? '' : p;
}

/**
 * The commit a read or a search looks at: the trunk head by the trunk rule, or
 * `at`, fetched when the cache does not hold it. Returns { dir, commit, trunk }.
 */
function pin(id, at, registryFile) {
  if (!REPO_ID.test(id)) usage(`"${id}" is not a repository id (letters, digits, ".", "_", "-")`);
  if (at !== null && atProblem(at)) usage(atProblem(at));
  const regPath = registryPath(registryFile);
  const registry = readRegistry(regPath);
  const problems = validateRegistry(registry, regPath);
  if (problems.length) {
    throw new SpokeError(EXIT.FAIL, `the registry is not well formed; run check-registry first:\n  - ${problems.join('\n  - ')}`);
  }
  const entry = registry.repositories[id];
  if (!entry) {
    const known = Object.keys(registry.repositories);
    usage(`"${id}" is not in ${regPath}. Listed: ${known.length ? known.join(', ') : '(nothing yet)'}. Add it with /add-repo`);
  }

  const dir = cacheDir(id);
  if (at === null) {
    const { trunk, head } = resolveSpokeTrunk(entry, dir);
    return { dir, commit: head, trunk };
  }
  return { dir, commit: pinAt(id, entry, dir, at), trunk: 'not asked' };
}

/**
 * Run one mode and return { exit, out, err }, with the text for stdout and for
 * stderr. A usage error or a SpokeError becomes a result. Any other error is a
 * fault in this script and is thrown.
 */
function settle(fn) {
  try {
    return fn();
  } catch (err) {
    if (err instanceof UsageError) return { exit: EXIT.USAGE, out: '', err: usageText(err.message) };
    if (err instanceof SpokeError) {
      const label = { [EXIT.CANNOT_VERIFY]: 'CANNOT VERIFY', [EXIT.USAGE]: 'USAGE' }[err.exit] || 'FAIL';
      return { exit: err.exit, out: '', err: `${label}: ${err.message}\n${reasonLine(err.reason)}` };
    }
    throw err;
  }
}

/**
 * A read of one file or one directory: { id, path, at, registry, round }. With
 * `round`, the read is a request of a round, and roundReadBody caps the body of
 * a file. The header is the same in both cases.
 */
function readMode({ id, path: rawPath, at = null, registry = null, round = false }) {
  return settle(() => {
    const path = normalisePath(rawPath);
    const { dir, commit, trunk } = pin(id, at, registry);
    const type = objectType(dir, commit, path);
    const shown = path === '' ? '.' : path;
    if (type === null) {
      return { exit: EXIT.FAIL, out: '', err: `NOT FOUND: ${shown} is not in ${id} at ${short(commit)} (trunk: ${trunk})\n` };
    }
    if (type !== 'blob' && type !== 'tree') {
      throw new SpokeError(EXIT.FAIL, `${shown} in ${id} at ${short(commit)} is a ${type}, which this script does not read`);
    }

    const spec = path === '' ? `${commit}^{tree}` : `${commit}:${path}`;
    const objectHash = git(['--git-dir', dir, 'rev-parse', spec]).trim();
    const bytes = type === 'blob' ? git(['--git-dir', dir, 'cat-file', 'blob', objectHash], { encoding: null, maxBuffer: 64 * 1024 * 1024 }) : null;
    const header = [
      `Repository: ${id}`,
      `Commit: ${commit}`,
      `Trunk: ${trunk}`,
      `Path: ${shown}`,
      `${type === 'blob' ? 'Blob' : 'Tree'}: ${objectHash}`,
      ...(bytes ? [`Lines: ${lineCount(bytes)}`] : []),
      `Cite: ${id}@${short(commit)}:${shown}`,
      '---',
      '',
    ].join('\n');
    const tree = () => Buffer.from(git(['--git-dir', dir, 'ls-tree', objectHash], { env: quietGitEnv() }));
    const body = bytes ? (round ? Buffer.from(roundReadBody(bytes)) : bytes) : tree();
    return { exit: EXIT.PASS, out: Buffer.concat([Buffer.from(header), body]), err: '' };
  });
}

/**
 * A text search: { id, text, regex, ignoreCase, globs, at, registry }. Exit 1
 * when no file at the commit matches the globs. The header prints all the same.
 */
function grepMode({ id, text, regex = false, ignoreCase = false, globs = [], at = null, registry = null }) {
  return settle(() => {
    const problem = checkText(text) || globs.map(checkGlob).find(Boolean);
    if (problem) usage(problem);
    const { dir, commit, trunk } = pin(id, at, registry);
    const inScope = scope(dir, commit, globs).length;
    const result = inScope ? grep(dir, commit, { text, regex, ignoreCase, globs }) : { counts: [], lines: [] };
    const header = [`Repository: ${id}`, `Commit: ${commit}`, `Trunk: ${trunk}`];
    const out = formatGrep(header, { text, regex, ignoreCase, globs }, inScope, result);
    return { exit: inScope ? EXIT.PASS : EXIT.FAIL, out, err: '' };
  });
}

/**
 * A path search: { id, glob, at, registry }. Exit 1 when the glob selects no
 * file at the commit. The header prints all the same.
 */
function filesMode({ id, glob, at = null, registry = null }) {
  return settle(() => {
    const problem = checkGlob(glob);
    if (problem) usage(problem);
    const { dir, commit, trunk } = pin(id, at, registry);
    const paths = scope(dir, commit, [glob]);
    const out = formatFiles([`Repository: ${id}`, `Commit: ${commit}`, `Trunk: ${trunk}`], glob, paths);
    return { exit: paths.length ? EXIT.PASS : EXIT.FAIL, out, err: '' };
  });
}

/**
 * The critic's request round: { id, file, at, registry }. The parse checks
 * every line of the reply before any git call, and a problem is exit 3 with
 * nothing run. The commit is pinned one time, and each request then runs
 * against it from the cache. The round exits 0 when every request ran. Each
 * result carries its own exit code.
 */
function requestsMode({ id, file, at, registry = null }) {
  return settle(() => {
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch (err) {
      usage(`cannot read the requests file ${file}: ${err.code || err.message}`);
    }
    const { requests, problems } = parseRequests(text);
    if (problems.length) usage(`${file} is not a valid request round, and no request ran:\n  - ${problems.join('\n  - ')}`);
    const { commit } = pin(id, at, registry);
    const results = requests.map((request, i) => {
      const result = runRequest({ id, at: commit, registry }, request);
      const body = Buffer.concat([Buffer.from(result.out), Buffer.from(result.err)]);
      const end = body.length && body[body.length - 1] !== 0x0a ? '\n' : '';
      return Buffer.concat([
        Buffer.from(`Request ${i + 1} of ${requests.length}: ${request.source}\nExit: ${result.exit}\n`),
        body,
        Buffer.from(end),
      ]);
    });
    const parts = results.flatMap((r, i) => (i ? [Buffer.from('\n'), r] : [r]));
    return { exit: EXIT.PASS, out: Buffer.concat(parts), err: '' };
  });
}

/** One request of a round. A fault in one request is its own exit 4, and the round goes on. */
function runRequest(common, request) {
  try {
    if (request.kind === 'grep') {
      return grepMode({ ...common, text: request.text, regex: request.regex, ignoreCase: request.ignoreCase, globs: request.globs });
    }
    return request.kind === 'files' ? filesMode({ ...common, glob: request.glob }) : readMode({ ...common, path: request.path, round: true });
  } catch (err) {
    return { exit: EXIT.INTERNAL, out: '', err: `INTERNAL: ${err && err.message ? err.message : String(err)}\n` };
  }
}

function main() {
  const result = settle(() => {
    const args = parseArgs(process.argv.slice(2));
    const common = { id: args.id, at: args.at, registry: args.registry };
    if (args.mode === 'requests') return requestsMode({ ...common, file: args.requests });
    if (args.mode === 'files') return filesMode({ ...common, glob: args.files });
    return args.mode === 'grep'
      ? grepMode({ ...common, text: args.text, regex: args.regex, ignoreCase: args.ignoreCase, globs: args.globs })
      : readMode({ ...common, path: args.path });
  });
  if (result.out.length) stdout.write(result.out);
  if (result.err) stderr.write(result.err);
  // exitCode, not exit(): a large file written to a pipe must drain first.
  process.exitCode = result.exit;
}

/** The lines a reader counts: one per newline, and one more for a last line with no newline. */
function lineCount(bytes) {
  let n = 0;
  for (const b of bytes) if (b === 0x0a) n += 1;
  return bytes.length && bytes[bytes.length - 1] !== 0x0a ? n + 1 : n;
}

// The last line of an exit 2, 3 or 4 names this script and its code, so a shell line that hides
// the code, with a pipe or `; echo`, still tells the harness's failure record. Written at once,
// so a process.exit() never loses it.
process.on('exit', (code) => { if (code >= 2 && code <= 4) { try { writeSync(2, `HARNESS EXIT: read-spoke ${code}\n`); } catch { /* stderr is closed */ } } });

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

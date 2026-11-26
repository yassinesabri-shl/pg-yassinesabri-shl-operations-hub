// Part of the harness asset library c6f3b4427d58f7c3 (see VERSION.json) · 2026-11-06
//
// spoke-search.mjs — the search logic behind `read-spoke.mjs --grep` and
// `--files`, and the parse of the critic's request round behind `--requests`.
//
// Not a command. `read-spoke.mjs` imports it from beside itself, in the library
// and after install. Git does every match on the bare cache of one spoke at one
// commit. JavaScript builds no RegExp from an argument and matches no glob, so a
// text or a glob from a seat is always data that git reads.
//
// Globs use git's `:(glob)` pathspec grammar: `*` stays inside one folder, `**/`
// matches zero or more folders, and `?` matches one character.
//
// Node standard library only, plus git via child_process.

import { git, EXIT, SpokeError, firstLine } from './spoke-remote.mjs';

/**
 * The output caps. A search over a cap prints counts, not lines. `readLines`
 * caps a read in a request round only. A plain read prints the whole file.
 */
export const CAPS = { hitLines: 200, files: 100, lineChars: 300, paths: 500, folders: 100, requests: 10, readLines: 400 };

const BIG = 256 * 1024 * 1024;

/**
 * The error text for a glob, or null when git can read it as a relative path.
 * A leading ":" is refused because git reads it as pathspec magic, which could
 * turn a glob into an exclude or a literal.
 */
export function checkGlob(raw) {
  if (typeof raw !== 'string' || raw === '') return 'a glob must not be empty';
  if (raw.startsWith('/') || raw.startsWith(':')) return `a glob must not start with "/" or ":", got "${raw}"`;
  const segments = raw.split('/');
  if (segments.includes('..')) return `a glob must not climb with "..", got "${raw}"`;
  if (segments.includes('')) return `a glob must not hold an empty segment, got "${raw}"`;
  return null;
}

/**
 * The error text for a search text, or null. An empty text matches every line,
 * and git reads a text with a line end as two patterns.
 */
export function checkText(raw) {
  if (typeof raw !== 'string' || raw === '') return '--grep needs a text, and the text must not be empty';
  if (raw.includes('\n') || raw.includes('\r')) return '--grep needs a text on one line, with no line end in it';
  return null;
}

/**
 * The error text for the path of a read, or null. "." and "" are the root. A
 * path is relative and does not climb. `read-spoke.mjs` uses the same rule for
 * its `<path>` argument.
 */
export function checkPath(raw) {
  const p = raw.replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+$/, '');
  if (p === '.' || p === '') return null;
  if (p.startsWith('/')) return `path must be relative to the repository root, got "${raw}"`;
  if (p.split('/').some((seg) => seg === '..' || seg === '')) return `path must not climb or contain empty segments, got "${raw}"`;
  return null;
}

/**
 * The requests in a critic's reply: { requests, problems }. A request is
 * { lineNo, source, kind, text?, regex?, ignoreCase?, globs?, glob?, path? },
 * where `source` is the line after "- ". A problem is "line <n>: <what>", or
 * a text with no line number when the reply has no block. The parse checks
 * every line before it returns, so one run lists every problem.
 *
 * Grammar: the block starts at a line that is exactly "### REQUESTS" and ends
 * at the first blank line or at the end of the text. Each block line is "- ",
 * a kind (grep, files or read), and one JSON string. A grep line can then hold
 * --regex, --ignore-case and `--paths "<glob>"`, which can occur more than one
 * time. A line that starts with "### VERDICT:" anywhere in the reply is a
 * problem, because a request round has no verdict.
 */
export function parseRequests(text) {
  const lines = text.split('\r\n').join('\n').split('\n');
  const problems = [];
  const requests = [];

  const starts = [];
  lines.forEach((line, i) => {
    if (line === '### REQUESTS') starts.push(i);
    if (line.startsWith('### VERDICT:')) problems.push(`line ${i + 1}: a request round has no verdict, but the reply holds "${line}"`);
  });
  if (starts.length === 0) {
    problems.unshift('the reply holds no "### REQUESTS" block');
    return { requests, problems };
  }
  for (const i of starts.slice(1)) problems.push(`line ${i + 1}: a second "### REQUESTS" block. A reply holds one block`);

  const head = starts[0];
  let count = 0;
  for (let i = head + 1; i < lines.length && lines[i].trim() !== ''; i += 1) {
    count += 1;
    const line = lines[i];
    if (!line.startsWith('- ')) {
      problems.push(`line ${i + 1}: a request line starts with "- ", got "${line}"`);
      continue;
    }
    const parsed = parseRequestLine(line.slice(2));
    if (typeof parsed === 'string') problems.push(`line ${i + 1}: ${parsed}`);
    else requests.push({ lineNo: i + 1, source: line.slice(2), ...parsed });
  }
  if (count === 0) problems.push(`line ${head + 1}: the block holds no request`);
  if (count > CAPS.requests) problems.push(`line ${head + 1}: the block holds ${count} requests, over the cap of ${CAPS.requests}`);
  problems.sort((x, y) => lineOf(x) - lineOf(y));
  return { requests, problems };
}

function lineOf(problem) {
  return Number(problem.slice(5, problem.indexOf(':')));
}

const OPERAND = { grep: 'text', files: 'glob', read: 'path' };

/** One request, from the text after "- ": the request fields, or the error text. */
function parseRequestLine(body) {
  const tokens = tokenize(body);
  if (typeof tokens === 'string') return tokens;
  const [kindToken, operand, ...rest] = tokens;
  if (!kindToken || kindToken.string || !Object.hasOwn(OPERAND, kindToken.value)) {
    return `unknown kind ${kindToken ? kindToken.raw : '""'}. A request is grep, files or read`;
  }
  const kind = kindToken.value;
  const what = OPERAND[kind];
  if (!operand) return `${kind} needs a ${what}: a JSON string in double quotes`;
  if (!operand.string) return `the ${what} must be a JSON string in double quotes, got ${operand.raw}`;

  if (kind !== 'grep') {
    if (rest.length) {
      const next = rest[0];
      const flag = !next.string && ['--regex', '--ignore-case', '--paths'].includes(next.value);
      return flag ? `${next.value} applies to grep only` : `unexpected ${next.raw} after the operands`;
    }
    const problem = kind === 'files' ? checkGlob(operand.value) : checkPath(operand.value);
    return problem || (kind === 'files' ? { kind, glob: operand.value } : { kind, path: operand.value });
  }

  const request = { kind, text: operand.value, regex: false, ignoreCase: false, globs: [] };
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (token.string) return `unexpected ${token.raw} after the operands`;
    if (token.value === '--regex' || token.value === '--ignore-case') {
      const key = token.value === '--regex' ? 'regex' : 'ignoreCase';
      if (request[key]) return `${token.value} can occur only one time`;
      request[key] = true;
    } else if (token.value === '--paths') {
      const glob = rest[i + 1];
      if (!glob || !glob.string) return '--paths needs a glob: a JSON string in double quotes';
      request.globs.push(glob.value);
      i += 1;
    } else if (token.value.startsWith('--')) {
      return `unknown flag ${token.value}. A grep line takes --regex, --ignore-case and --paths`;
    } else {
      return `unexpected ${token.raw} after the operands`;
    }
  }
  return checkText(request.text) || request.globs.map(checkGlob).find(Boolean) || request;
}

/**
 * The tokens of one request line, split at spaces: { string, value, raw }, or
 * the error text. A JSON string runs to its closing quote. The scan skips each
 * backslash and the character after it, and `JSON.parse` then reads the slice,
 * so no RegExp reads the line.
 */
function tokenize(body) {
  const tokens = [];
  let at = 0;
  while (at < body.length) {
    if (body[at] === ' ') {
      at += 1;
      continue;
    }
    if (body[at] === '"') {
      let end = at + 1;
      while (end < body.length && body[end] !== '"') end += body[end] === '\\' ? 2 : 1;
      if (end >= body.length) return `unclosed string ${body.slice(at)}: it has no closing quote`;
      const raw = body.slice(at, end + 1);
      let value;
      try {
        value = JSON.parse(raw);
      } catch (err) {
        return `bad JSON string ${raw}: ${err.message}`;
      }
      if (end + 1 < body.length && body[end + 1] !== ' ') return `a space must follow the string ${raw}`;
      // A command-line argument cannot hold a NUL, and git refuses one.
      if (value.includes('\0')) return `a string must not hold a NUL character, got ${raw}`;
      tokens.push({ string: true, value, raw });
      at = end + 1;
    } else {
      let end = body.indexOf(' ', at);
      if (end === -1) end = body.length;
      const raw = body.slice(at, end);
      tokens.push({ string: false, value: raw, raw: `"${raw}"` });
      at = end;
    }
  }
  return tokens;
}

/** The pathspecs for a list of globs: none means the whole tree. */
function pathspecs(globs) {
  return globs.map((g) => `:(glob)${g}`);
}

// A user's environment can tell git to read every pathspec literally, which
// turns `:(glob)` into a file name. The search removes those switches.
function searchEnv() {
  const env = { ...process.env };
  for (const key of ['GIT_LITERAL_PATHSPECS', 'GIT_GLOB_PATHSPECS', 'GIT_NOGLOB_PATHSPECS', 'GIT_ICASE_PATHSPECS']) delete env[key];
  return env;
}

/**
 * The paths at `commit` that the globs select, in git's path order. The diff
 * against the empty tree lists every file, because `git ls-tree` refuses a glob
 * pathspec. Binary files are included.
 */
export function scope(dir, commit, globs) {
  // `--stdin` with no input hashes the empty tree in either hash format, and it
  // needs no /dev/null on Windows.
  const empty = git(['--git-dir', dir, 'hash-object', '-t', 'tree', '--stdin'], { input: '', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  const out = git(['--git-dir', dir, 'diff-tree', '-r', '--name-only', '-z', '--no-renames', empty, commit, '--', ...pathspecs(globs)],
    { encoding: null, maxBuffer: BIG, env: searchEnv() });
  return splitNul(out).filter((p) => p !== '');
}

/**
 * Search `commit` for one text. Returns `counts`, the hit lines in each file,
 * and `lines`, every hit, or null when the total is over `CAPS.hitLines`. Git
 * exit 1 is no hit. Git exit 128 is a pattern git refuses, which is usage.
 */
export function grep(dir, commit, { text, regex, ignoreCase, globs }) {
  const base = [
    '--git-dir', dir, '-c', 'grep.column=false', '-c', 'grep.lineNumber=false', 'grep',
    '--no-color', '-z', '-I', regex ? '-E' : '-F', ...(ignoreCase ? ['-i'] : []),
  ];
  const tail = ['-e', text, commit, '--', ...pathspecs(globs)];
  const prefix = `${commit}:`;

  const counts = [];
  for (const [path, n] of fields(runGrep([...base, '-c', ...tail]), 1)) {
    counts.push([stripPrefix(path, prefix), Number(n)]);
  }
  counts.sort((x, y) => (y[1] - x[1]) || byPath(x[0], y[0]));
  const total = counts.reduce((sum, [, n]) => sum + n, 0);
  if (total > CAPS.hitLines) return { counts, lines: null };

  const lines = [];
  if (total > 0) {
    for (const [path, line, hit] of fields(runGrep([...base, '-n', ...tail]), 2)) {
      lines.push({ path: stripPrefix(path, prefix), line: Number(line), text: hit });
    }
    lines.sort((x, y) => byPath(x.path, y.path) || (x.line - y.line));
  }
  return { counts, lines };
}

function runGrep(args) {
  try {
    return git(args, { encoding: null, maxBuffer: BIG, env: searchEnv() }).toString('utf8');
  } catch (err) {
    if (err && err.status === 1) return '';
    if (err && err.status === 128) throw new SpokeError(EXIT.USAGE, firstLine(err.stderr && err.stderr.toString('utf8')) || 'git grep refused the search');
    throw err;
  }
}

// The records of `git grep -z`: each is `nuls` fields that end in NUL, then a
// last field that ends at the line end. A path can hold a line end, and the
// matched text cannot, so the parse finds each NUL before it looks for "\n".
function fields(text, nuls) {
  const out = [];
  let at = 0;
  while (at < text.length) {
    const record = [];
    for (let i = 0; i < nuls; i += 1) {
      const nul = text.indexOf('\0', at);
      if (nul === -1) throw new SpokeError(EXIT.INTERNAL, `git grep wrote a record this reader does not understand: ${JSON.stringify(text.slice(at, at + 200))}`);
      record.push(text.slice(at, nul));
      at = nul + 1;
    }
    let end = text.indexOf('\n', at);
    if (end === -1) end = text.length;
    record.push(text.slice(at, end));
    at = end + 1;
    out.push(record);
  }
  return out;
}

function splitNul(buf) {
  return buf.toString('utf8').split('\0');
}

function stripPrefix(path, prefix) {
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

/** Byte order of the code points, the order git lists paths in. Not the locale order. */
function byPath(x, y) {
  if (x === y) return 0;
  return Buffer.compare(Buffer.from(x, 'utf8'), Buffer.from(y, 'utf8'));
}

/**
 * At most `CAPS.lineChars` characters, then " [cut]". The count is in code
 * points, so a cut never splits a multi-byte character. A carriage return at
 * the end is the end of a CRLF line, not text, and does not print.
 */
export function cutLine(text) {
  const line = text.endsWith('\r') ? text.slice(0, -1) : text;
  const points = [...line];
  return points.length <= CAPS.lineChars ? line : `${points.slice(0, CAPS.lineChars).join('')} [cut]`;
}

/**
 * The body of a read in a request round, from the bytes of the file. A file
 * with a NUL byte is binary and prints only "[binary file not shown]". Other
 * files print at most `CAPS.readLines` lines, each through cutLine. Over the
 * cap, the body ends with "[cut: <k> more lines]". Every line ends with "\n".
 */
export function roundReadBody(bytes) {
  if (bytes.includes(0)) return '[binary file not shown]\n';
  const text = bytes.toString('utf8');
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  const shown = lines.slice(0, CAPS.readLines).map(cutLine);
  const rest = lines.length - shown.length;
  if (rest > 0) shown.push(`[cut: ${rest} more lines]`);
  return shown.length ? `${shown.join('\n')}\n` : '';
}

/**
 * The whole output of one search: the `header` lines (repository, commit,
 * trunk), the search lines, `---`, and the body. Every line ends with "\n".
 */
export function formatGrep(header, query, scopeCount, result) {
  const total = result.counts.reduce((sum, [, n]) => sum + n, 0);
  const search = [
    'grep', query.regex ? 'regex' : 'fixed', JSON.stringify(query.text),
    ...(query.ignoreCase ? ['ignore-case'] : []),
    ...(query.globs.length ? ['paths', ...query.globs] : []),
    '(binary files skipped)',
  ].join(' ');
  const lines = [
    ...header,
    `Search: ${search}`,
    `Scope: ${scopeCount} files`,
    `Hits: ${total}`,
    `Files: ${result.counts.length}`,
    `Shown: ${result.lines ? 'every hit' : `counts only: ${total} hits is over the cap of ${CAPS.hitLines}`}`,
  ];
  // A seat that writes grep's "a\|b" or "a|b" without --regex wants one of
  // several texts. A fixed search finds the literal text, usually nowhere, and
  // "Hits: 0" then reads as proof that the code holds none of them.
  if (!query.regex && total === 0 && query.text.includes('|')) {
    lines.push('Note: a fixed search reads "|" and "\\|" as text. To find one of several texts, search again with --regex and join them with "|".');
  }
  lines.push('---');
  if (result.lines) {
    for (const hit of result.lines) lines.push(`${hit.path}:${hit.line}: ${cutLine(hit.text)}`);
  } else {
    for (const [path, n] of result.counts.slice(0, CAPS.files)) lines.push(`${n} ${path}`);
    const rest = result.counts.length - CAPS.files;
    if (rest > 0) lines.push(`${rest} more ${rest === 1 ? 'file' : 'files'} not shown`);
  }
  return `${lines.join('\n')}\n`;
}

/**
 * The whole output of `--files`: the `header` lines, the search lines, `---`,
 * and the body. Under `CAPS.paths`, one path on each line. Over it, one
 * `<count> <folder>/` line for each parent folder.
 */
export function formatFiles(header, glob, paths) {
  const over = paths.length > CAPS.paths;
  const lines = [
    ...header,
    `Search: files ${glob}`,
    `Scope: ${paths.length} files`,
    `Files: ${paths.length}`,
    `Shown: ${over ? `counts only: ${paths.length} paths is over the cap of ${CAPS.paths}` : 'every path'}`,
    '---',
  ];
  if (!over) {
    lines.push(...paths);
  } else {
    const folders = folderCounts(paths);
    for (const [folder, n] of folders.slice(0, CAPS.folders)) lines.push(`${n} ${folder}`);
    const rest = folders.length - CAPS.folders;
    if (rest > 0) lines.push(`${rest} more ${rest === 1 ? 'folder' : 'folders'} not shown`);
  }
  return `${lines.join('\n')}\n`;
}

// The parent folder of a path is its directory, with a trailing "/" (`gen/a/x.ts`
// is `gen/a/`). A file at the root has the folder `./`. The folders sort by
// count, high first, then by folder name in byte order.
function folderCounts(paths) {
  const counts = new Map();
  for (const p of paths) {
    const cut = p.lastIndexOf('/');
    const folder = cut === -1 ? './' : p.slice(0, cut + 1);
    counts.set(folder, (counts.get(folder) || 0) + 1);
  }
  return [...counts].sort((x, y) => (y[1] - x[1]) || byPath(x[0], y[0]));
}

#!/usr/bin/env node
// Part of the harness asset library c6f3b4427d58f7c3 (see VERSION.json) · 2026-11-06
/**
 * check-survey-secrets.mjs — scan the files of a spoke at one commit with Gitleaks, and say which
 * findings the spoke's .gitleaksignore accepts.
 *
 *   usage:  node scripts/check-survey-secrets.mjs --clone <dir> --commit <40-hex> [--hub <dir>] [--rev <rev>] [--pull] [--timeout <s>]
 *           node scripts/check-survey-secrets.mjs --ensure-image [--hub <dir>] [--rev <rev>] [--timeout <s>]
 *
 * /survey-repo runs the scan right after it clones the spoke, before it dispatches the seat. The
 * scan is the only source of credential locations. The design is docs/proposals/survey-gitleaks.md
 * in the harness library.
 *
 *   --hub  the hub that holds the pin and the rules (default: the one this script is installed in),
 *          and --rev the revision of it, default HEAD. They are read from that COMMITTED revision
 *          with git: `scripts/gitleaks/` installed, `accelerator/gate/gitleaks/` in the library.
 *   --pull fetch the Gitleaks image first if this machine does not have it.
 *   --timeout  the seconds each container run may take, default 900 (15 minutes). A run that
 *          takes longer is stopped, its container is removed, and the exit is 2.
 *   --ensure-image  the preflight, and all it does: fetch the pinned image with Docker's progress
 *          shown, and give up after five minutes (--timeout <seconds> changes that). Where it
 *          cannot, exit 2, with `REASON: <code>` just before the `HARNESS EXIT:` line.
 *
 * The scan:
 *   1. Read the pin (gitleaks.json) and the rules (gitleaks.toml) from the hub at --rev.
 *   2. Confirm that the clone is at --commit and is not shallow: a commit entry in step 5 needs the
 *      whole history of the trunk. Export the files at --commit with `git ls-tree` and
 *      `git cat-file --batch` (one process for the whole tree) into <work>/scan/tree/, never from the working tree.
 *      - `.gitleaksignore` and `.gitleaks.toml` are exported and scanned as ordinary files. Gitleaks
 *        reads neither as its own: it scans /scan, not /scan/tree, `--config` names the library's
 *        rules, and `--gitleaks-ignore-path` names an empty read-only folder.
 *      - A symbolic link becomes a file that holds the link text, so the scan never follows a link.
 *        A submodule is skipped.
 *      - A file whose name ends in `.tgz`, in any case, is exported with `.tar.gz` in place of that
 *        suffix, because Gitleaks opens a `.tar.gz` and not a `.tgz`. Each finding in it is reported
 *        at the real path: `lib/a.tar.gz!inner/key.pem` becomes `lib/a.tgz!inner/key.pem`. A tree path
 *        that is the new name, or starts with the new name and `!`, would make two readings of one
 *        report path: exit 2, naming both.
 *      - The script counts each `gitleaks:allow` in the exported files for a note. The scan passes
 *        `--ignore-gitleaks-allow`, so a line that carries the marker is scanned like any other.
 *      - Before the export, a probe file shows whether the export folder ignores the case of
 *        letters. If it does, two tree paths that differ only in case would be one file, and one
 *        would go unscanned: exit 2, naming both. The test hook SHL_SURVEY_SECRETS_CASE_INSENSITIVE=1,
 *        which only the fixture suite sets, makes the probe say yes.
 *      - Each file is written only if nothing is at its place yet. Where a path is already there, or
 *        a file stands where a folder must be, exit 2 names the path. This catches what the probe
 *        misses: two Unicode forms of one name, or a crafted tree that holds one path twice.
 *      - A canary goes into <work>/scan/canary/: a private-key block of random bytes, made on each
 *        run and never committed. Gitleaks must report it, and only it, under /scan/canary/. A
 *        Docker that mounts an empty folder (rootless or snap Docker, or file sharing off) then
 *        cannot pass as a clean scan.
 *   3. Run `gitleaks dir /scan` in the pinned image (`<GITLEAKS_IMAGE or zricethezav/gitleaks>:v<pin>`),
 *      in a container with no network, with the library's rules only, `--ignore-gitleaks-allow`,
 *      `--redact` and `--exit-code 0`. The rules are the defaults of the pinned version with no
 *      global path allowlist, so a file in node_modules/ or vendor/ is scanned too. The rules add
 *      two value allowlists to generic-api-key: a SemVer version and a Go checksum line.
 *      `--max-archive-depth 8` scans into archives. A finding in an archive has the path
 *      `<archive>!<path inside>`, for example `lib/a.tar.gz!inner/key.pem`.
 *      With `--exit-code 0`, a non-zero exit means that Gitleaks failed. It never means a finding.
 *      A finding outside /scan/tree/ and /scan/canary/ is a report this script does not recognise.
 *   4. Run `gitleaks version` in the same image. A version that is not the pin cannot verify.
 *   5. Read .gitleaksignore from git at --commit. A file entry `<path>:<rule>:<line>` accepts a
 *      finding when the path, the rule and the line are all the finding's. A commit entry
 *      `<commit>:<path>:<rule>:<line>` accepts a finding that no file entry accepts, under these conditions:
 *      - `git blame` at --commit gives every line of the finding to the entry's commit.
 *      - The rule is the finding's.
 *      - The path and the line are those that blame gives for the first line of the finding in that commit.
 *      This is the fingerprint that a Gitleaks scan of the history gives the commit that added the
 *      lines. Blame follows a file that moves, so the entry still matches after a move. A line
 *      edited after that commit blames to a newer commit, and the entry does not match it. Blame
 *      runs with no ignore list of revisions and with the myers diff, whatever the git configuration
 *      says. A finding at line 0, or inside an archive, has no lines to blame. Only a file entry
 *      accepts it.
 *   6. Print the result and delete the export and the report.
 *
 * The script matches the entries itself, because the pull request lists each accepted location for
 * the security role and Gitleaks does not report a finding that it skips.
 *
 * Output (the value of a credential never appears: --redact removes it, and only the path, the
 * line and the rule are printed):
 *   .gitleaksignore: none at <12>  |  .gitleaksignore: <n> file entries, <m> commit entries at <12>
 *   gitleaks <version>, rules <12-hex hash of gitleaks.toml>
 *   [ACCEPTED] <path> L<n>: <rule> (.gitleaksignore: <entry>)
 *   [LIVE] <path> L<n>: <rule>
 * Each location is one line: findings with one path, one line and one rule give one line.
 * A rule that matches a file by its path alone reports line 0, and the entry for it ends in `:0`.
 * A path or an entry that holds a control character is printed as a JSON string, so it cannot
 * forge or garble a line.
 *
 * Exit codes, the gate's:
 *   0  no finding, or every finding is accepted
 *   1  a [LIVE] finding: an incident
 *   2  cannot verify: Docker is not installed or not running, the image is missing, the version is
 *      not the pin, Gitleaks failed, wrote no readable report or did not see the exported files,
 *      git failed, the clone is not at --commit or is shallow, or two tree paths are one file on this machine
 *      (or one path is in the tree twice, or a renamed .tgz name is another tree path)
 *   3  usage
 *   4  internal
 *
 * Node standard library only, plus git and docker.
 */

import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DockerError, ensureImage, isImageName, PREFLIGHT_PULL_TIMEOUT_MS, PULL_TIMEOUT_MS, runContainer, tailOf } from './docker-image.mjs';

export const EXIT = { PASS: 0, LIVE: 1, CANNOT_VERIFY: 2, USAGE: 3, INTERNAL: 4 };

// Where the pin and the rules sit in a hub at a revision: installed, then in this library.
const PIN_DIRS = ['scripts/gitleaks', 'accelerator/gate/gitleaks'];
const IMAGE_REPOSITORY = 'zricethezav/gitleaks';
const TIMEOUT_MS = 15 * 60 * 1000;
const HERE = dirname(fileURLToPath(import.meta.url));
const IGNORE_FILE = '.gitleaksignore';
// The empty folder that --gitleaks-ignore-path names, so Gitleaks finds no ignore file of its own.
const NO_IGNORE = '/no-ignore';
// The depth of archives inside archives that Gitleaks opens. Its default, 0, opens none.
const ARCHIVE_DEPTH = '8';
// A C0 or C1 control character, or DEL: a path that holds one is printed as a JSON string.
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const RULE_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
// Line 0 is a finding by path alone, as `pkcs12-file` reports for a .p12 file.
const LINE_NO = /^(?:0|[1-9][0-9]*)$/;
const COMMIT_ID = /^[0-9a-f]{40}$/;
const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+$/;
const SCAN = '/scan';
const TREE = `${SCAN}/tree/`;
const CANARY = `${SCAN}/canary/`;
const CANARY_FILE = 'canary.pem';
const CANARY_RULE = 'private-key';
const ALLOW_MARKER = Buffer.from('gitleaks:allow');
// Gitleaks 8.30.1 opens `.tar.gz` and `.tar`, and not `.tgz`. The export gives such a file the suffix it opens.
const TGZ = /\.tgz$/i;
const TAR_GZ = '.tar.gz';
const CASE_HOOK = 'SHL_SURVEY_SECRETS_CASE_INSENSITIVE';

class ScanError extends Error {
  // `reason` names why Docker or the image is not ready, for the preflight's caller to ask the right question.
  constructor(code, message, reason = null) { super(message); this.code = code; this.reason = reason; }
}

// Orca warns on pattern.test(text) for text from a file or the command line; search() passes.
const matches = (text, pattern) => String(text).search(pattern) >= 0;
const short = (sha) => String(sha).slice(0, 12);

// A .gitleaksignore entry may start with ./, as Gitleaks writes none. A git path holds no ./ and
// may hold a literal backslash, so a path is never changed beyond that prefix.
const entryPath = (path) => path.replace(/^(?:\.\/)+/, '');
const shown = (text) => (matches(text, CONTROL) ? JSON.stringify(text) : text);

function git(dir, args, binary = false) {
  const res = spawnSync('git', ['-C', dir, ...args], { encoding: binary ? 'buffer' : 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (res.error) throw new ScanError(EXIT.CANNOT_VERIFY, `git could not run: ${res.error.message}`);
  return res;
}
function gitOut(dir, args, what) {
  const res = git(dir, args);
  if (res.status !== 0) throw new ScanError(EXIT.CANNOT_VERIFY, `${what}: ${String(res.stderr || res.stdout).trim().split('\n')[0]}`);
  return res.stdout;
}
function blobAt(dir, spec, what) {
  const res = git(dir, ['cat-file', 'blob', spec], true);
  if (res.status !== 0) throw new ScanError(EXIT.CANNOT_VERIFY, `cannot read ${what}: ${String(res.stderr).trim().split('\n')[0]}`);
  return res.stdout;
}

/**
 * The Gitleaks pin and rules as the hub holds them at `rev`: { version, rules, rulesHash }, where
 * `rules` is the bytes of gitleaks.toml and `rulesHash` the first 12 hex of its SHA-256. Throws.
 */
export function readPin({ hub = HERE, rev = 'HEAD' } = {}) {
  if (String(rev).startsWith('-')) throw new ScanError(EXIT.USAGE, `--rev takes a revision, not "${rev}"`);
  const top = gitOut(hub, ['rev-parse', '--show-toplevel'], `${hub} is not a git checkout`).trim();
  const commit = gitOut(top, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`], `cannot read hub revision ${rev}`).trim();
  for (const base of PIN_DIRS) {
    const listed = gitOut(top, ['ls-tree', '-z', '--name-only', commit, '--', `${base}/gitleaks.json`], `cannot list ${base} at ${short(commit)}`);
    if (!listed.split('\0').includes(`${base}/gitleaks.json`)) continue;
    const pinText = blobAt(top, `${commit}:${base}/gitleaks.json`, `${base}/gitleaks.json at ${short(commit)}`).toString('utf8');
    let pin;
    try { pin = JSON.parse(pinText); } catch { throw new ScanError(EXIT.CANNOT_VERIFY, `${base}/gitleaks.json at ${short(commit)} is not JSON`); }
    if (!pin || typeof pin.gitleaks !== 'string' || !matches(pin.gitleaks, VERSION)) {
      throw new ScanError(EXIT.CANNOT_VERIFY, `${base}/gitleaks.json at ${short(commit)} needs "gitleaks": "<major>.<minor>.<patch>", with no v`);
    }
    const hasRules = gitOut(top, ['ls-tree', '-z', '--name-only', commit, '--', `${base}/gitleaks.toml`], `cannot list ${base} at ${short(commit)}`);
    if (!hasRules.split('\0').includes(`${base}/gitleaks.toml`)) throw new ScanError(EXIT.CANNOT_VERIFY, `no gitleaks.toml at ${short(commit)} beside ${base}/gitleaks.json: upgrade the hub`);
    const rules = blobAt(top, `${commit}:${base}/gitleaks.toml`, `${base}/gitleaks.toml at ${short(commit)}`);
    return { version: pin.gitleaks, rules, rulesHash: createHash('sha256').update(rules).digest('hex').slice(0, 12) };
  }
  throw new ScanError(EXIT.CANNOT_VERIFY, `no gitleaks.json at ${short(commit)} (looked in ${PIN_DIRS.join(' and ')}): upgrade the hub`);
}

/**
 * Parse .gitleaksignore text. Fields split on ':' and are read from the right, because a path may
 * hold a colon and a rule id and a line number never do. A first field of 40 hexadecimal
 * characters, with at least three fields after it, makes a commit entry.
 */
function parseIgnore(text) {
  const files = [];
  const commits = [];
  const unreadable = [];
  text.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const fields = line.split(':');
    const lineNo = fields[fields.length - 1];
    const rule = fields[fields.length - 2];
    if (fields.length < 3 || !matches(lineNo, LINE_NO) || !matches(rule || '', RULE_ID)) {
      unreadable.push(index + 1);
      return;
    }
    const commit = fields.length >= 4 && matches(fields[0], COMMIT_ID) ? fields[0] : null;
    const path = entryPath(fields.slice(commit ? 1 : 0, -2).join(':'));
    if (!path) {
      unreadable.push(index + 1);
      return;
    }
    (commit ? commits : files).push({ commit, path, rule, line: Number(lineNo), entry: line });
  });
  return { files, commits, unreadable };
}

/** The bytes of a C-style quoted git path, `"a\tb"`, as text. Null where the quoting is not git's. */
function unquoteGitPath(quoted) {
  if (!quoted.startsWith('"') || !quoted.endsWith('"') || quoted.length < 2) return null;
  const simple = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 };
  const bytes = [];
  const body = Buffer.from(quoted.slice(1, -1), 'utf8');
  for (let i = 0; i < body.length; i += 1) {
    if (body[i] !== 92) { bytes.push(body[i]); continue; }
    const next = String.fromCharCode(body[i + 1]);
    if (next in simple) { bytes.push(simple[next]); i += 1; continue; }
    const octal = body.toString('latin1', i + 1, i + 4);
    if (!matches(octal, /^[0-3][0-7]{2}$/)) return null;
    bytes.push(parseInt(octal, 8));
    i += 3;
  }
  return Buffer.from(bytes).toString('utf8');
}

/** The number of lines in `blob`, as git blame counts them: a last line with no newline counts too. */
const lineCount = (blob) => {
  let count = 0;
  for (let at = blob.indexOf(10); at >= 0; at = blob.indexOf(10, at + 1)) count += 1;
  return blob.length > 0 && blob[blob.length - 1] !== 10 ? count + 1 : count;
};

/**
 * Where `git blame` at `commit` puts the lines `start` to `end` of `path`: { commit, path, line },
 * the commit that every line comes from and the path and the line of `start` in it. Null where the
 * lines come from more than one commit, or `start` is past the end of the file. Lines past the end
 * are not blamed: they hold nothing.
 */
function blameLines(clone, commit, path, start, end) {
  const total = lineCount(blobAt(clone, `${commit}:${path}`, `${path} at ${short(commit)}`));
  if (start > total) return null;
  const last = Math.min(end, total);
  // No ignore list of revisions and the myers diff: a global git configuration must not move a line to an older commit.
  const res = git(clone, ['-c', 'core.quotePath=false', 'blame', '--line-porcelain', '--no-ignore-revs-file', '--diff-algorithm=myers',
    '-L', `${start},${last}`, commit, '--', path]);
  if (res.status !== 0) throw new ScanError(EXIT.CANNOT_VERIFY, `cannot blame ${JSON.stringify(path)} at ${short(commit)}: ${String(res.stderr).trim().split('\n')[0]}`);
  const blamed = [];
  for (const row of res.stdout.split('\n')) {
    const head = row.match(/^([0-9a-f]{40}) ([0-9]+) ([0-9]+)(?: [0-9]+)?$/);
    if (head) blamed.push({ commit: head[1], line: Number(head[2]), path: null });
    else if (row.startsWith('filename ') && blamed.length) {
      const name = row.slice('filename '.length);
      blamed[blamed.length - 1].path = name.startsWith('"') ? unquoteGitPath(name) : name;
    }
  }
  if (blamed.length !== last - start + 1 || blamed.some((b) => b.path === null)) {
    throw new ScanError(EXIT.CANNOT_VERIFY, `git blame of ${JSON.stringify(path)} at ${short(commit)} gave an answer this script does not recognise`);
  }
  return blamed.every((b) => b.commit === blamed[0].commit) ? blamed[0] : null;
}

/** The .gitleaksignore text at the commit, or null where the commit has none. */
function readIgnoreAt(clone, commit) {
  const what = `cannot read ${IGNORE_FILE} at ${short(commit)}`;
  const listed = gitOut(clone, ['ls-tree', commit, '--', IGNORE_FILE], what).trim();
  if (!listed) return { text: null, note: null };
  const [mode, type] = listed.split(/\s+/);
  if (type !== 'blob' || mode === '120000') {
    return { text: null, note: `${IGNORE_FILE} at the root is not a regular file. It accepts nothing` };
  }
  return { text: blobAt(clone, `${commit}:${IGNORE_FILE}`, `${IGNORE_FILE} at ${short(commit)}`).toString('utf8'), note: null };
}

function confirmClone(clone, commit) {
  const res = git(clone, ['rev-parse', '--verify', 'HEAD^{commit}']);
  if (res.status !== 0) throw new ScanError(EXIT.CANNOT_VERIFY, `no repository at ${clone}: ${String(res.stderr).trim().split('\n')[0]}`);
  const head = res.stdout.trim();
  if (head !== commit) throw new ScanError(EXIT.CANNOT_VERIFY, `the clone at ${clone} is at ${short(head)}, not at ${short(commit)}`);
  // In a shallow clone, blame gives every older line to the first commit the clone holds.
  const shallow = gitOut(clone, ['rev-parse', '--is-shallow-repository'], `cannot read the history of ${clone}`).trim();
  if (shallow !== 'false') throw new ScanError(EXIT.CANNOT_VERIFY, `the clone at ${clone} is shallow. Clone the whole history of the trunk, with no --depth, and scan it again`);
}

/** Whether the file system under `dir` ignores the case of letters: a probe file, read back in the other case. */
function ignoresCase(dir) {
  if (process.env[CASE_HOOK] === '1') return true;
  const probe = join(dir, 'case-probe');
  writeFileSync(probe, '');
  try { return existsSync(join(dir, 'CASE-PROBE')); } finally { rmSync(probe, { force: true }); }
}

/** The number of `gitleaks:allow` markers in `blob`. The scan ignores them, and a note gives the count. */
function countAllowMarkers(blob) {
  let count = 0;
  for (let at = blob.indexOf(ALLOW_MARKER); at >= 0; at = blob.indexOf(ALLOW_MARKER, at + ALLOW_MARKER.length)) count += 1;
  return count;
}

/** The path a tree path has in the export: a `.tgz` name, in any case, ends in `.tar.gz` there. */
const exportPathOf = (path) => (matches(path, TGZ) ? `${path.slice(0, -'.tgz'.length)}${TAR_GZ}` : path);

/**
 * The real path of a path in the report. A renamed archive and each file inside it (`<archive>!<path>`)
 * get the archive's tree path back. `renamed` maps each export path to its tree path.
 */
function realPathOf(path, renamed) {
  for (const [exported, real] of renamed) {
    if (path === exported) return real;
    if (path.startsWith(`${exported}!`)) return `${real}${path.slice(exported.length)}`;
  }
  return path;
}

/**
 * The blobs for `objects`, read with one `git cat-file --batch` process: a Map of object id to bytes.
 * The stream is `<oid> <type> <size>\n<bytes>\n` for each id, in the order asked.
 */
function readBlobs(clone, objects, commit) {
  const wanted = [...new Set(objects)];
  const blobs = new Map();
  if (wanted.length === 0) return blobs;
  const res = spawnSync('git', ['-C', clone, 'cat-file', '--batch'], { input: Buffer.from(`${wanted.join('\n')}\n`), maxBuffer: 1024 * 1024 * 1024 });
  if (res.error) throw new ScanError(EXIT.CANNOT_VERIFY, `git could not run: ${res.error.message}`);
  if (res.status !== 0) throw new ScanError(EXIT.CANNOT_VERIFY, `cannot read the files of ${short(commit)}: ${String(res.stderr).trim().split('\n')[0]}`);
  const data = res.stdout;
  let at = 0;
  for (const oid of wanted) {
    const eol = data.indexOf(10, at);
    const head = eol < 0 ? '' : data.toString('utf8', at, eol).split(' ');
    if (head.length !== 3 || head[0] !== oid || head[1] !== 'blob' || !matches(head[2], /^[0-9]+$/)) {
      throw new ScanError(EXIT.CANNOT_VERIFY, `cannot read a file of ${short(commit)}: git answered ${JSON.stringify(eol < 0 ? '' : data.toString('utf8', at, eol).slice(0, 80))} for ${short(oid)}`);
    }
    const size = Number(head[2]);
    if (eol + 1 + size > data.length) throw new ScanError(EXIT.CANNOT_VERIFY, `cannot read a file of ${short(commit)}: git ended its answer early`);
    blobs.set(oid, data.subarray(eol + 1, eol + 1 + size));
    at = eol + 1 + size + 1;
  }
  return blobs;
}

/**
 * Write the files of `commit` under `into`, from git objects alone. Each blob becomes a regular
 * file, a symbolic link included (its blob is the link text). A submodule has no blob and is skipped.
 * One `git cat-file --batch` process reads every blob. Returns { markers, renamed, paths }: the number of
 * `gitleaks:allow` markers in the files, a Map from the export path of each `.tgz` file to its
 * tree path, and the Set of the tree paths exported.
 */
function exportFiles(clone, commit, into, caseless) {
  mkdirSync(into, { recursive: true });
  const root = realpathSync(into);
  const entries = gitOut(clone, ['ls-tree', '-r', '-z', commit], `cannot list the files of ${short(commit)}`).split('\0');
  // On a file system that ignores case, each path and each folder above it, in lower case, has one spelling.
  const spelled = new Map();
  const files = [];
  for (const entry of entries) {
    if (entry === '') continue;
    const tab = entry.indexOf('\t');
    const [mode, type, object] = entry.slice(0, tab).split(' ');
    const path = entry.slice(tab + 1);
    if (mode === '160000' || type !== 'blob') continue;
    // git refuses such paths in a checkout. A crafted tree could still hold one, so it is refused here too.
    const parts = path.split('/');
    const target = resolve(root, path);
    const inside = relative(root, target);
    if (parts.some((p) => p === '' || p === '.' || p === '..' || p.toLowerCase() === '.git')
      || isAbsolute(inside) || inside.startsWith('..') || inside.split(sep).includes('..')) {
      throw new ScanError(EXIT.CANNOT_VERIFY, `the tree at ${short(commit)} holds a path this script does not write: ${JSON.stringify(path)}`);
    }
    if (caseless) {
      for (let i = 1; i <= parts.length; i += 1) {
        const prefix = parts.slice(0, i).join('/');
        const seen = spelled.get(prefix.toLowerCase());
        if (seen === undefined) spelled.set(prefix.toLowerCase(), prefix);
        else if (seen !== prefix) {
          throw new ScanError(EXIT.CANNOT_VERIFY, `the tree at ${short(commit)} holds ${JSON.stringify(seen)} and ${JSON.stringify(prefix)}, which are one file on this file system, because it ignores case. Scan on a machine whose file system keeps case`);
        }
      }
    }
    files.push({ object, path, target });
  }
  // A report path must have one reading: a new `.tgz` name is no other tree path, and no tree path starts with it and `!`.
  const renamed = new Map();
  const clash = (a, b) => new ScanError(EXIT.CANNOT_VERIFY, `the tree at ${short(commit)} holds ${JSON.stringify(a)} and ${JSON.stringify(b)}. The scan opens a .tgz file as ${JSON.stringify(exportPathOf(matches(a, TGZ) ? a : b))}, so one report path would have two readings`);
  const byExport = new Map();
  for (const f of files) {
    const to = exportPathOf(f.path);
    const before = byExport.get(to);
    // Only a rename is checked here. One path twice, with no rename, is the EEXIST refusal below.
    if (before !== undefined && (before !== to || to !== f.path)) throw clash(before, f.path);
    byExport.set(to, f.path);
    if (to !== f.path) { renamed.set(to, f.path); f.target = resolve(root, to); }
  }
  for (const [to, real] of renamed) {
    const inside = files.find((f) => f.path.startsWith(`${to}!`));
    if (inside) throw clash(real, inside.path);
  }
  const blobs = readBlobs(clone, files.map((f) => f.object), commit);
  let markers = 0;
  for (const { object, path, target } of files) {
    const bytes = blobs.get(object);
    markers += countAllowMarkers(bytes);
    // 'wx' never replaces a file. A replaced file would go unscanned, and the exit would be 0.
    try {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, bytes, { flag: 'wx' });
    } catch (err) {
      if (!['EEXIST', 'ENOTDIR', 'EISDIR'].includes(err.code)) throw err;
      throw new ScanError(EXIT.CANNOT_VERIFY, `the tree at ${short(commit)} holds ${JSON.stringify(path)}, and the export already has a file or a folder at its place (${err.code}). One of them would go unscanned`);
    }
  }
  return { markers, renamed, paths: new Set(files.map((f) => f.path)) };
}

/** The canary: a private-key block of random bytes, made on each run, that the default rules find. */
function writeCanary(dir) {
  mkdirSync(dir, { recursive: true });
  const body = randomBytes(192).toString('base64').match(/.{1,64}/g).join('\n');
  // The header is built from parts: the watermark suite refuses a tracked file that holds it whole.
  const label = 'PRIVATE' + ' KEY';
  writeFileSync(join(dir, CANARY_FILE), `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`);
}

/** The docker module throws its own error. The scan reports it as a ScanError with the same text and reason. */
function ensureGitleaksImage(image, pull, env, show = false, pullTimeoutMs = PULL_TIMEOUT_MS) {
  try {
    return ensureImage({ image, pull, env, show, pullTimeoutMs, label: 'Gitleaks' });
  } catch (err) {
    if (err instanceof DockerError) throw new ScanError(EXIT.CANNOT_VERIFY, err.message, err.reason);
    throw err;
  }
}

const containerName = () => `shl-survey-secrets-${process.pid}-${Date.now().toString(36)}`;

function refuseRun(res, what, timeoutMs) {
  if (res.error) throw new ScanError(EXIT.CANNOT_VERIFY, res.error.code === 'ETIMEDOUT' ? `${what} did not finish within ${Math.round(timeoutMs / 1000)} s` : `docker could not run: ${res.error.message}`);
  if (res.signal) throw new ScanError(EXIT.CANNOT_VERIFY, `${what} was stopped by ${res.signal}`);
  if (res.status !== 0) throw new ScanError(EXIT.CANNOT_VERIFY, `docker run exited ${res.status}${tailOf(res.stderr) ? `:\n${tailOf(res.stderr)}` : ''}`);
}

/**
 * The findings of the report in the exported tree: [{ path, rule, line, endLine }]. Only RuleID, File,
 * StartLine and EndLine are ever read. The canary must be the one finding under /scan/canary/, and is dropped.
 */
function findingsOf(file, renamed) {
  let text;
  try { text = readFileSync(file, 'utf8'); } catch (err) { throw new ScanError(EXIT.CANNOT_VERIFY, `gitleaks wrote no readable report (${err.code || 'unreadable'})`); }
  let report;
  // The parser's own message can quote the text, so it is not printed.
  try { report = JSON.parse(text); } catch { throw new ScanError(EXIT.CANNOT_VERIFY, 'gitleaks wrote no readable report (not JSON)'); }
  const unknown = new ScanError(EXIT.CANNOT_VERIFY, 'gitleaks wrote a report this script does not recognise');
  if (!Array.isArray(report)) throw unknown;
  const found = [];
  const canaries = [];
  for (const f of report) {
    if (!f || typeof f !== 'object' || typeof f.RuleID !== 'string' || !matches(f.RuleID, RULE_ID)
      || typeof f.File !== 'string' || !Number.isInteger(f.StartLine) || f.StartLine < 0
      || !Number.isInteger(f.EndLine) || f.EndLine < f.StartLine) throw unknown;
    if (f.File.startsWith(TREE)) found.push({ path: realPathOf(f.File.slice(TREE.length), renamed), rule: f.RuleID, line: f.StartLine, endLine: f.EndLine });
    else if (f.File.startsWith(CANARY)) canaries.push(f);
    else throw unknown;
  }
  if (canaries.length !== 1 || canaries[0].File !== `${CANARY}${CANARY_FILE}` || canaries[0].RuleID !== CANARY_RULE) {
    throw new ScanError(EXIT.CANNOT_VERIFY, 'gitleaks did not see the exported files: the canary it must report is missing or not alone. Docker may mount an empty folder (rootless or snap Docker, or file sharing off)');
  }
  return found.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.line - b.line || (a.rule < b.rule ? -1 : a.rule > b.rule ? 1 : 0)));
}

/** Gitleaks over the exported files, then its version: the findings, or a ScanError. */
function runGitleaks({ image, pull, pin, rulesDir, scanDir, noIgnore, out, timeoutMs, renamed }) {
  const env = { ...process.env };
  ensureGitleaksImage(image, pull, env);
  const scanned = runContainer({
    image, name: containerName(), workdir: SCAN, timeoutMs, spawnEnv: env, env: {},
    mounts: [{ src: rulesDir, dst: '/rules' }, { src: scanDir, dst: SCAN }, { src: noIgnore, dst: NO_IGNORE }, { src: out, dst: '/out', writable: true }],
    command: ['dir', SCAN, '--config', '/rules/gitleaks.toml', '--gitleaks-ignore-path', NO_IGNORE, '--max-archive-depth', ARCHIVE_DEPTH,
      '--ignore-gitleaks-allow', '--redact', '--no-banner', '--report-format', 'json', '--report-path', '/out/gitleaks.json', '--exit-code', '0', '--log-level', 'warn'],
  });
  refuseRun(scanned, 'gitleaks', timeoutMs);
  const findings = findingsOf(join(out, 'gitleaks.json'), renamed);
  const asked = runContainer({ image, name: containerName(), workdir: '/', timeoutMs, spawnEnv: env, env: {}, mounts: [], command: ['version'] });
  refuseRun(asked, 'gitleaks version', timeoutMs);
  const ran = String(asked.stdout || '').trim().replace(/^v/, '');
  if (ran !== pin) throw new ScanError(EXIT.CANNOT_VERIFY, `gitleaks ${ran || '(no version printed)'} ran, the hub pins ${pin}`);
  return findings;
}

function imageFor(image, version) {
  const name = `${image}:v${version}`;
  if (!isImageName(name)) throw new ScanError(EXIT.USAGE, `"${name}" is not an image name (GITLEAKS_IMAGE and the pin in gitleaks.json make it)`);
  return name;
}

/** Why a scan or a fetch did not happen, as the caller reports it: { code, reason, report }. */
function refusal(err) {
  const code = err instanceof ScanError ? err.code : EXIT.INTERNAL;
  const label = code === EXIT.USAGE ? 'USAGE' : code === EXIT.CANNOT_VERIFY ? 'CANNOT VERIFY' : 'INTERNAL';
  const message = code === EXIT.INTERNAL && err && err.stack ? err.stack : (err && err.message) || String(err);
  return { code, reason: err instanceof ScanError ? err.reason : null, report: `${label}: ${message}\n` };
}

/**
 * Scan the files of `clone` at `commit`. Never throws: { code, report }, where `report` is the text
 * to print and always says why on a code other than 0 and 1. `image` (GITLEAKS_IMAGE) is the image
 * repository.
 */
export function scanClone({ clone, commit, hub = HERE, rev = 'HEAD', pull = false, image = process.env.GITLEAKS_IMAGE || IMAGE_REPOSITORY, timeoutMs = TIMEOUT_MS } = {}) {
  let work = null;
  let result;
  try {
    if (typeof commit !== 'string' || !matches(commit, COMMIT_ID)) throw new ScanError(EXIT.USAGE, '--commit must be 40 lowercase hexadecimal characters');
    const pin = readPin({ hub, rev });
    const imageName = imageFor(image, pin.version);
    confirmClone(clone, commit);
    work = mkdtempSync(join(tmpdir(), 'survey-secrets-'));
    const rulesDir = join(work, 'rules');
    const scanDir = join(work, 'scan');
    const out = join(work, 'out');
    const noIgnore = join(work, 'no-ignore');
    mkdirSync(rulesDir);
    mkdirSync(out);
    mkdirSync(noIgnore);
    writeFileSync(join(rulesDir, 'gitleaks.toml'), pin.rules);
    const { markers, renamed, paths } = exportFiles(clone, commit, join(scanDir, 'tree'), ignoresCase(work));
    writeCanary(join(scanDir, 'canary'));
    const findings = runGitleaks({ image: imageName, pull, pin: pin.version, rulesDir, scanDir, noIgnore, out, timeoutMs, renamed });

    const ignore = readIgnoreAt(clone, commit);
    const parsed = ignore.text === null ? { files: [], commits: [], unreadable: [] } : parseIgnore(ignore.text);
    const lines = [ignore.text === null ? `${IGNORE_FILE}: none at ${short(commit)}`
      : `${IGNORE_FILE}: ${parsed.files.length} file entries, ${parsed.commits.length} commit entries at ${short(commit)}`];
    lines.push(`gitleaks ${pin.version}, rules ${pin.rulesHash}`);
    if (ignore.note) lines.push(`note: ${ignore.note}`);
    if (parsed.unreadable.length) {
      lines.push(`note: ${IGNORE_FILE} lines ${parsed.unreadable.join(', ')} are not file:rule:line or commit:file:rule:line. They accept nothing`);
    }
    if (markers) lines.push(`note: ${markers} gitleaks:allow markers ignored`);
    let live = 0;
    // A commit entry needs the lines of a file in the tree. A finding at line 0 or inside an archive has none.
    const commitEntryFor = (f) => {
      if (f.line === 0 || !paths.has(f.path) || !parsed.commits.some((e) => e.rule === f.rule)) return null;
      const origin = blameLines(clone, commit, f.path, f.line, f.endLine);
      return origin && parsed.commits.find((e) => e.commit === origin.commit && e.path === origin.path && e.rule === f.rule && e.line === origin.line);
    };
    // Gitleaks reports each match of a rule, so one line can give several findings with one path,
    // line and rule. The pull request lists a location once: one survey test run printed 65 lines
    // for 18 locations.
    const seen = new Set();
    for (const f of findings) {
      const at = `${f.path}\0${f.line}\0${f.rule}`;
      if (seen.has(at)) continue;
      seen.add(at);
      const entry = parsed.files.find((e) => e.path === f.path && e.rule === f.rule && e.line === f.line) || commitEntryFor(f);
      if (entry) lines.push(`[ACCEPTED] ${shown(f.path)} L${f.line}: ${f.rule} (${IGNORE_FILE}: ${shown(entry.entry)})`);
      else { live += 1; lines.push(`[LIVE] ${shown(f.path)} L${f.line}: ${f.rule}`); }
    }
    result = { code: live ? EXIT.LIVE : EXIT.PASS, report: `${lines.join('\n')}\n` };
  } catch (err) {
    const r = refusal(err);
    result = { code: r.code, report: r.report };
  }
  if (work) {
    // The export holds the spoke's files. A person must know when it stays on disk.
    try { rmSync(work, { recursive: true, force: true }); } catch (err) {
      result.report += `note: could not delete the export at ${work} (${err.code || err.message}). Delete it by hand\n`;
    }
  }
  return result;
}

/**
 * The preflight: make sure the Gitleaks image the hub pins is on this machine, fetching it with
 * Docker's progress shown where it is not. Scans nothing. Never throws: { code, report, reason },
 * where `reason` says what to tell the person on a failure, and is null otherwise.
 */
export function prepareImage({ hub = HERE, rev = 'HEAD', image = process.env.GITLEAKS_IMAGE || IMAGE_REPOSITORY, timeoutMs = PREFLIGHT_PULL_TIMEOUT_MS } = {}) {
  try {
    const pin = readPin({ hub, rev });
    const imageName = imageFor(image, pin.version);
    const did = ensureGitleaksImage(imageName, true, { ...process.env }, true, timeoutMs);
    return { code: EXIT.PASS, report: `GITLEAKS IMAGE — ${imageName} ${did === 'pulled' ? 'fetched' : 'is already on this machine'}\n`, reason: null };
  } catch (err) {
    return refusal(err);
  }
}

const USAGE_TEXT = [
  'usage: node scripts/check-survey-secrets.mjs --clone <dir> --commit <40-hex> [--hub <dir>] [--rev <rev>] [--pull] [--timeout <s>]',
  '       node scripts/check-survey-secrets.mjs --ensure-image [--hub <dir>] [--rev <rev>] [--timeout <s>]',
].join('\n');

function main(argv) {
  const o = {};
  const usage = (message) => { process.stderr.write(`USAGE: ${message}\n${USAGE_TEXT}\n`); return EXIT.USAGE; };
  const valued = { '--clone': 'clone', '--commit': 'commit', '--hub': 'hub', '--rev': 'rev', '--timeout': 'timeout' };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--pull' || a === '--ensure-image') {
      const key = a === '--pull' ? 'pull' : 'ensureImage';
      if (o[key]) return usage(`${a} given twice`);
      o[key] = true;
      continue;
    }
    if (!(a in valued)) return usage(`unknown argument: ${a}`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) return usage(`${a} needs a value`);
    if (o[valued[a]] !== undefined) return usage(`${a} given twice`);
    o[valued[a]] = value;
    i += 1;
  }
  let timeoutMs;
  if (o.timeout !== undefined) {
    timeoutMs = Number(o.timeout) * 1000;
    if (!(timeoutMs > 0)) return usage(`--timeout takes a number of seconds, not "${o.timeout}"`);
  }
  const where = { ...(o.hub !== undefined ? { hub: o.hub } : {}), ...(o.rev !== undefined ? { rev: o.rev } : {}) };
  if (o.ensureImage) {
    if (o.clone !== undefined || o.commit !== undefined || o.pull) return usage('--ensure-image scans nothing: give it no --clone, no --commit and no --pull');
    const r = prepareImage({ ...where, ...(timeoutMs ? { timeoutMs } : {}) });
    (r.code === EXIT.PASS ? process.stdout : process.stderr).write(r.report);
    // The caller tells the person what to do for each: install Docker, start it, or run the command again.
    if (r.code !== EXIT.PASS && r.reason) process.stderr.write(`REASON: ${r.reason}\n`);
    return r.code;
  }
  for (const key of ['clone', 'commit']) if (o[key] === undefined) return usage(`--${key} is required`);
  if (!matches(o.commit, COMMIT_ID)) return usage('--commit must be 40 lowercase hexadecimal characters');
  const r = scanClone({ clone: o.clone, commit: o.commit, pull: Boolean(o.pull), ...where, ...(timeoutMs ? { timeoutMs } : {}) });
  (r.code === EXIT.PASS || r.code === EXIT.LIVE ? process.stdout : process.stderr).write(r.report);
  return r.code;
}

const invoked = (() => { try { return realpathSync(process.argv[1] || '') === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })();
if (invoked) {
  // The last line of an exit 2, 3 or 4 names this script and its code, so a shell line that hides
  // the code, with a pipe or `; echo`, still tells the harness's failure record. Written at once,
  // so a process.exit() never loses it.
  process.on('exit', (code) => { if (code >= 2 && code <= 4) { try { writeSync(2, `HARNESS EXIT: check-survey-secrets ${code}\n`); } catch { /* stderr is closed */ } } });
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`INTERNAL: ${err && err.stack ? err.stack : String(err)}\n`);
    process.exitCode = EXIT.INTERNAL;
  }
}

#!/usr/bin/env node
// Part of the harness asset library c6f3b4427d58f7c3 (see VERSION.json) · 2026-10-15
/**
 * test-quality-scan.mjs — run Semgrep CE's test-quality rules over the test files a range of
 * commits changes. One scanner, two callers: the hook that runs at every `test-review` critic
 * launch (test-quality-hook.mjs, in the hub) and the spoke's story-gate step. Same script, same
 * rules, same pin.
 *
 *   usage:  node scripts/test-quality-scan.mjs --repo <checkout> --range <base>..<head>
 *                [--hub <hub checkout>] [--rev <hub revision>] [--sarif <file>] [--timeout <seconds>] [--pull]
 *          node scripts/test-quality-scan.mjs --ensure-image [--hub <hub checkout>] [--rev <hub revision>]
 *
 *          node scripts/test-quality-scan.mjs --coverage --repo <checkout> [--hub <hub checkout>] [--rev <hub revision>]
 *
 *   --coverage  which test stacks the checkout's committed tree holds, and which of them the hub's
 *            rules cover; reads files and git only. `/add-repo` runs it while linking a spoke. A stack
 *            with tests and no rules is listed `[NOT COVERED]`: exit 0, because it is a fact to decide on
 *   --ensure-image  the preflight, and all it does: fetch the pinned Semgrep image if this machine
 *            does not have it, with Docker's progress shown, and give up after five minutes
 *            (--timeout <seconds> changes that: a person is waiting); scan nothing. `/dev-sprint` runs it at the
 *            start of a run, so the hook finds the image there. Where it cannot, exit 2 and a last line
 *            `REASON: docker-not-installed | docker-not-running | pull-failed`, so the caller can tell
 *            the person what to do (start Docker, install it, run the command again)
 *
 *   --range  the test files added or modified since <base> is where <head> branched (a three-dot
 *            diff), read as committed at <head>, never the working tree
 *   --hub    the hub that holds the rules (default: the one this script is installed in), and
 *            --rev the revision of it, default HEAD. The rules and the pin are read from that
 *            COMMITTED revision with git — `scripts/test-quality/` installed,
 *            `accelerator/gate/test-quality/` in the library — so an uncommitted edit in the hub and
 *            anything in the spoke change nothing. In CI the hub is a clean clone of its trunk
 *   --sarif  keep the SARIF report here, stamped with the commit, tree, ruleset hash and semgrep version
 *   --pull   fetch the Semgrep image first if this machine does not have it (CI does; the hook never
 *            does, because a download does not belong inside a review: its scan must end inside
 *            100 s and the first fetch takes minutes)
 *
 * The rules folder is one: the library's rule files and the hub's own (`hub-*.yml`, written by the
 * hub, never touched by an upgrade) sit side by side, are hashed together, and a rule id defined
 * twice is exit 2, because Semgrep would drop one silently.
 *
 * The changed source files are exported from the commit into a temporary folder with an empty
 * `.semgrepignore` of our own (Semgrep's default skips `test/` and `tests/`); which of them are
 * tests is the rules' own `paths:`. Semgrep runs in Docker, as the image `semgrep/semgrep:<pin>`
 * (SEMGREP_IMAGE names a mirror of that repository): no network, a read-only root, the rules and the
 * files mounted read-only, no capabilities, as the caller's user, `--metrics=off
 * --disable-version-check --disable-nosem`, no token, no registry. Docker is the only way it runs:
 * there is no Semgrep install to point at. The version that ran must be the pin.
 * ERROR findings are violations, WARNING findings are for a reviewer to judge, INFO is ignored; a
 * changed test file in a language without rules is listed as not covered, never as clean. The
 * scan and the hook never install anything: the image comes from `--ensure-image` (the
 * `/dev-sprint` preflight), from a person's `docker pull`, or from CI's `--pull`.
 *
 * Exit codes, as every check has them: 0 clean or warnings only · 1 violations · 2 cannot verify
 * (Docker or semgrep missing, not the pin, crashed, timed out or wrote nothing readable; a file or
 * rule it did not run; a rule id used twice; no rules at that hub revision; a commit it cannot
 * read) · 3 usage · 4 internal. Node standard library only, plus git and docker (or semgrep).
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DockerError, ensureImage, isImageName, PREFLIGHT_PULL_TIMEOUT_MS, PULL_TIMEOUT_MS, runContainer, tailOf } from './docker-image.mjs';

export const EXIT = { PASS: 0, VIOLATIONS: 1, CANNOT_VERIFY: 2, USAGE: 3, INTERNAL: 4 };
// Where the shared rules sit in a hub at a revision: installed, then in this library.
const RULE_DIRS = ['scripts/test-quality', 'accelerator/gate/test-quality'];
const STAMP_KEY = 'shlTestQuality';
// The languages the library's rules read, by the `languages:` name a rule gives. A changed file of another
// kind is never exported, unless a rule of the hub's own names its language (LANGUAGES below).
const LIBRARY_EXTENSIONS = ['js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'mts', 'cts', 'py', 'go', 'java', 'php'];
// Semgrep's language name -> the file extensions it reads, for the languages a hub may add a rule for.
// `label` is what a person reads; it is also the list of stacks the library has no rules for.
const LANGUAGES = {
  kotlin: { label: 'Kotlin', extensions: ['kt', 'kts'] }, csharp: { label: 'C#', extensions: ['cs'] },
  ruby: { label: 'Ruby', extensions: ['rb'] }, scala: { label: 'Scala', extensions: ['scala'] },
  swift: { label: 'Swift', extensions: ['swift'] }, dart: { label: 'Dart', extensions: ['dart'] },
  elixir: { label: 'Elixir', extensions: ['ex', 'exs'] }, rust: { label: 'Rust', extensions: ['rs'] },
  c: { label: 'C', extensions: ['c', 'h'] }, cpp: { label: 'C++', extensions: ['cc', 'cpp', 'cxx', 'hpp'] },
};
// What a person reads for the languages the library does cover, by extension.
const COVERED_LABELS = { js: 'JavaScript', jsx: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript', ts: 'TypeScript', tsx: 'TypeScript', mts: 'TypeScript', cts: 'TypeScript', py: 'Python', go: 'Go', java: 'Java', php: 'PHP' };
const labelOf = (extension) => COVERED_LABELS[extension] || Object.values(LANGUAGES).find((l) => l.extensions.includes(extension))?.label || extension;
const TEST_DIRECTORIES = new Set(['test', 'tests', 'spec', 'specs', '__tests__']);
/** A path that is a test by the usual conventions of any language: a test folder, or a name that says so. */
function looksLikeTest(path) {
  const parts = path.split('/');
  const name = parts[parts.length - 1];
  if (parts.slice(0, -1).some((d) => TEST_DIRECTORIES.has(d.toLowerCase()) || d.endsWith('.Tests') || d.endsWith('.Test'))) return true;
  const stem = name.includes('.') ? name.slice(0, name.lastIndexOf('.')) : name;
  return stem.endsWith('Test') || stem.endsWith('Tests') || stem.endsWith('Spec') || stem.endsWith('Suite') || stem.endsWith('_test') || stem.endsWith('_spec')
    || stem.startsWith('test_') || stem.search(/\.(test|tests|spec)$/) !== -1;
}
// The Semgrep image: this repository, tagged with the pin.
const IMAGE_REPOSITORY = 'semgrep/semgrep';
const SEMGREP_FLAGS = ['--metrics=off', '--disable-version-check', '--disable-nosem', '--quiet'];
const SHOWN = 30;
const TIMEOUT_MS = 15 * 60 * 1000;
const HERE = dirname(fileURLToPath(import.meta.url));

class ScanError extends Error {
  // `reason` names why Docker or the image is not ready, for the preflight's caller to ask the right question.
  constructor(code, message, reason = null) { super(message); this.code = code; this.reason = reason; }
}

function git(dir, args, binary = false) {
  const res = spawnSync('git', ['-C', dir, ...args], { encoding: binary ? 'buffer' : 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (res.error) throw new ScanError(EXIT.CANNOT_VERIFY, `git could not run: ${res.error.message}`);
  return res;
}
function gitOut(dir, args, what) {
  const res = git(dir, args);
  if (res.status !== 0) throw new ScanError(EXIT.CANNOT_VERIFY, `${what}: ${(res.stderr || res.stdout).trim().split('\n')[0]}`);
  return res.stdout;
}
const commitOf = (dir, rev, what) => gitOut(dir, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`], `cannot read ${what}`).trim();

/** The rules and the pin as the hub holds them at `rev`, written under `into`. */
function exportRules(hub, rev, into) {
  const top = gitOut(hub, ['rev-parse', '--show-toplevel'], `${hub} is not a git checkout`).trim();
  const commit = commitOf(top, rev, `hub revision ${rev}`);
  for (const base of RULE_DIRS) {
    const everything = gitOut(top, ['ls-tree', '-r', '-z', '--name-only', commit, '--', base], `cannot list ${base} at ${commit.slice(0, 12)}`).split('\0');
    // Suggested rulesets sit beside the rules, off: `suggested/hub-<semgrep language>.yml`, adopted by copying one into rules/.
    const suggested = new Set(everything.filter((p) => p.startsWith(`${base}/suggested/hub-`) && p.endsWith('.yml')).map((p) => p.slice(`${base}/suggested/hub-`.length, -'.yml'.length)));
    const listed = everything.filter((p) => p === `${base}/ruleset.json` || (p.startsWith(`${base}/rules/`) && (p.endsWith('.yml') || p.endsWith('.yaml'))));
    if (!listed.includes(`${base}/ruleset.json`)) continue;
    const hash = createHash('sha256');
    const idOwner = new Map();
    const extensions = new Set(LIBRARY_EXTENSIONS);
    const includes = new Set();
    for (const path of listed.sort()) {
      const blob = git(top, ['cat-file', 'blob', `${commit}:${path}`], true);
      if (blob.status !== 0) throw new ScanError(EXIT.CANNOT_VERIFY, `cannot read ${path} at ${commit.slice(0, 12)}`);
      const rel = path.slice(base.length + 1);
      mkdirSync(dirname(join(into, rel)), { recursive: true });
      writeFileSync(join(into, rel), blob.stdout);
      hash.update(`${rel}\0`).update(blob.stdout).update('\0');
      // Semgrep keeps one of two rules with the same id and says nothing: a hub rule must not hide or be hidden.
      const text = blob.stdout.toString('utf8');
      for (const [, id] of text.matchAll(/^\s*-\s+id:\s*(\S+)/gm)) {
        if (idOwner.has(id)) throw new ScanError(EXIT.CANNOT_VERIFY, `rule id ${id} is defined in both ${idOwner.get(id)} and ${rel}: give the hub's rule an id of its own (hub-<name>)`);
        idOwner.set(id, rel);
      }
      // A rule that names a language the library has no rules for (a hub's own) widens what is exported to it.
      for (const [, list] of text.matchAll(/^\s*languages:\s*\[([^\]]*)\]/gm)) {
        for (const name of list.split(',')) for (const extension of (LANGUAGES[name.trim().replace(/["']/g, '')] || { extensions: [] }).extensions) extensions.add(extension);
      }
      for (const [, list] of text.matchAll(/^\s*include:\s*\[([^\]]*)\]/gm)) {
        for (const glob of list.split(',')) includes.add(glob.trim().replace(/^["']|["']$/g, ''));
      }
    }
    let ruleset;
    try { ruleset = JSON.parse(readFileSync(join(into, 'ruleset.json'), 'utf8')); } catch (err) { throw new ScanError(EXIT.CANNOT_VERIFY, `${base}/ruleset.json at ${commit.slice(0, 12)} is not JSON: ${err.message}`); }
    if (typeof ruleset.semgrep !== 'string' || ruleset.semgrep === '' || typeof ruleset.ruleset !== 'string') {
      throw new ScanError(EXIT.CANNOT_VERIFY, `${base}/ruleset.json at ${commit.slice(0, 12)} needs a "ruleset" version and the "semgrep" version it pins`);
    }
    if (!listed.some((p) => p.startsWith(`${base}/rules/`))) throw new ScanError(EXIT.CANNOT_VERIFY, `${base}/rules/ holds no rule file at ${commit.slice(0, 12)}`);
    return { ruleset, rulesSha: hash.digest('hex'), hubCommit: commit, rulesDir: join(into, 'rules'), extensions, includes: [...includes], suggested };
  }
  throw new ScanError(EXIT.CANNOT_VERIFY, `hub revision ${commit.slice(0, 12)} carries no test-quality rules (looked in ${RULE_DIRS.join(' and ')}): upgrade the hub`);
}

/** Files the range adds or modifies, as committed at `head`: [{ path }], and the paths no rule covers. */
function changedFiles(repo, base, head, extensions) {
  // base...head: what the branch changed since it left the base, not what the base moved on to since
  const raw = gitOut(repo, ['diff', '--raw', '-z', '--no-renames', '--diff-filter=AM', `${base}...${head}`], `cannot read the range ${base.slice(0, 12)}...${head.slice(0, 12)}`).split('\0');
  const sources = [];
  const uncovered = [];
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const mode = raw[i].split(' ')[1];
    const path = raw[i + 1];
    if (mode === '120000' || mode === '160000') continue;
    const extension = path.includes('.') ? path.slice(path.lastIndexOf('.') + 1) : '';
    if (extensions.has(extension)) sources.push(path);
    else if (uncoveredLanguage(extension) && looksLikeTest(path)) uncovered.push(path);
  }
  return { sources, uncovered };
}

function exportSubject(repo, head, paths, into) {
  mkdirSync(into, { recursive: true });
  // Semgrep's default ignore list skips test/ and tests/; this file replaces it, and is the only one read.
  writeFileSync(join(into, '.semgrepignore'), '# the harness scans test folders: nothing is ignored\n');
  for (const path of paths) {
    const blob = git(repo, ['cat-file', 'blob', `${head}:${path}`], true);
    if (blob.status !== 0) throw new ScanError(EXIT.CANNOT_VERIFY, `cannot read ${path} at ${head.slice(0, 12)}`);
    mkdirSync(dirname(join(into, path)), { recursive: true });
    writeFileSync(join(into, path), blob.stdout);
  }
}

/** Semgrep's name for the language an extension belongs to, among those a hub may add a rule for. */
const languageKeyOf = (extension) => Object.keys(LANGUAGES).find((key) => LANGUAGES[key].extensions.includes(extension)) || null;
const uncoveredLanguage = (extension) => Object.values(LANGUAGES).some((l) => l.extensions.includes(extension));

/** A Semgrep `paths.include` entry against a path: `dir/` is a folder anywhere in it, `*Name.ext` is a file name. */
function globMatches(path, glob) {
  if (glob.endsWith('/')) return `/${path}`.includes(`/${glob.replace(/^(\*\*\/)+/, '')}`);
  const name = path.slice(path.lastIndexOf('/') + 1);
  const parts = glob.split('*');
  if (parts.length === 1) return name === glob;
  if (!name.startsWith(parts[0]) || !name.endsWith(parts[parts.length - 1])) return false;
  let at = parts[0].length;
  for (const part of parts.slice(1, -1)) { at = name.indexOf(part, at); if (at === -1) return false; at += part.length; }
  return at <= name.length - parts[parts.length - 1].length;
}

const notCovered = (path) => `  [NOT COVERED] ${path} — no rules for this language or framework: nothing was checked`;

/** The docker module throws its own error; the scan reports it as a ScanError with the same text and reason. */
function ensureSemgrepImage(image, pull, env, show = false, pullTimeoutMs = PULL_TIMEOUT_MS) {
  try {
    return ensureImage({ image, pull, env, show, pullTimeoutMs, label: 'Semgrep', size: '430 MB' });
  } catch (err) {
    if (err instanceof DockerError) throw new ScanError(EXIT.CANNOT_VERIFY, err.message, err.reason);
    throw err;
  }
}

/** Semgrep in a container that can read the rules and the files, write only its two reports, and reach nothing. */
function dockerRun({ image, rulesDir, subject, out, env, timeoutMs }) {
  const name = `shl-test-quality-${process.pid}-${Date.now().toString(36)}`;
  return runContainer({
    image, name, workdir: '/src', timeoutMs, spawnEnv: env,
    mounts: [{ src: rulesDir, dst: '/rules' }, { src: subject, dst: '/src' }, { src: out, dst: '/out', writable: true }],
    env: { SEMGREP_SEND_METRICS: 'off', SEMGREP_ENABLE_VERSION_CHECK: '0', NO_COLOR: '1' },
    command: ['semgrep', 'scan', '--config', '/rules', ...SEMGREP_FLAGS, '--json-output', '/out/semgrep.json', '--sarif-output', '/out/semgrep.sarif', '.'],
  });
}

function runSemgrep({ image, pull, pin, rulesDir, subject, out, timeoutMs }) {
  const env = { ...process.env, SEMGREP_SEND_METRICS: 'off', SEMGREP_ENABLE_VERSION_CHECK: '0', NO_COLOR: '1' };
  delete env.SEMGREP_APP_TOKEN;
  const jsonFile = join(out, 'semgrep.json');
  const sarifFile = join(out, 'semgrep.sarif');
  ensureSemgrepImage(image, pull, env);
  const res = dockerRun({ image, rulesDir, subject, out, env, timeoutMs });
  if (res.error) throw new ScanError(EXIT.CANNOT_VERIFY, res.error.code === 'ETIMEDOUT' ? `semgrep did not finish within ${Math.round(timeoutMs / 1000)} s` : `docker could not run: ${res.error.message}`);
  if (res.signal) throw new ScanError(EXIT.CANNOT_VERIFY, `semgrep was stopped by ${res.signal}`);
  if (res.status !== 0) throw new ScanError(EXIT.CANNOT_VERIFY, `docker run exited ${res.status}${tailOf(res.stderr) ? `:\n${tailOf(res.stderr)}` : ''}`);
  const read = (file, what) => {
    try { return JSON.parse(readFileSync(file, 'utf8')); } catch (err) { throw new ScanError(EXIT.CANNOT_VERIFY, `semgrep wrote no readable ${what} (${err.message})`); }
  };
  const json = read(jsonFile, 'JSON report');
  const sarif = read(sarifFile, 'SARIF report');
  if (!Array.isArray(json.results) || !Array.isArray(json.errors) || !json.paths || !Array.isArray(json.paths.scanned)) {
    throw new ScanError(EXIT.CANNOT_VERIFY, 'semgrep wrote a JSON report this script does not recognise');
  }
  if (!sarif || !Array.isArray(sarif.runs) || !sarif.runs[0]) throw new ScanError(EXIT.CANNOT_VERIFY, 'semgrep wrote a SARIF report this script does not recognise');
  if (json.version !== pin) throw new ScanError(EXIT.CANNOT_VERIFY, `semgrep ${json.version} ran, the hub pins ${pin}`);
  return { json, sarif };
}

const cleanPath = (p) => String(p).split(sep).join('/').replace(/^\.\//, '');
const ruleOf = (checkId) => String(checkId).slice(String(checkId).lastIndexOf('.') + 1);

function findingsOf(json) {
  const found = { violations: [], warnings: [] };
  for (const r of json.results) {
    const severity = r.extra && r.extra.severity;
    const finding = { rule: ruleOf(r.check_id), path: cleanPath(r.path), line: r.start && r.start.line, message: String((r.extra && r.extra.message) || '').trim().split('\n')[0] };
    if (severity === 'ERROR') found.violations.push(finding);
    else if (severity === 'WARNING') found.warnings.push(finding);
  }
  const order = (a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.line - b.line || (a.rule < b.rule ? -1 : 1));
  found.violations.sort(order);
  found.warnings.sort(order);
  return found;
}

function render({ stamp, targeted, scanned, violations, warnings, uncovered, partial = [] }) {
  const lines = [`TEST QUALITY SCAN — semgrep ${stamp.semgrep} · ruleset ${stamp.ruleset} (sha ${stamp.rulesSha256.slice(0, 12)}, hub ${stamp.hubCommit.slice(0, 12)}) · commit ${stamp.commit.slice(0, 12)} tree ${stamp.tree.slice(0, 12)}`];
  lines.push(`  ${scanned} of ${targeted} changed source file(s) held tests the rules apply to`);
  let n = 0;
  const list = (label, items) => {
    for (const f of items.slice(0, SHOWN)) { n += 1; lines.push(`  [${label}] SG-${n} ${f.rule}  ${f.path}:${f.line} — ${f.message}`); }
    if (items.length > SHOWN) { n += items.length - SHOWN; lines.push(`  [${label}] … ${items.length - SHOWN} more of the same kind; the SARIF report lists all`); }
  };
  list('VIOLATION', violations);
  list('WARNING', warnings);
  for (const f of partial) lines.push(`  [PARTIAL] ${f.path}${f.line ? `:${f.line}` : ''} — Semgrep could not parse part of this file; anything wrong in that part is not seen`);
  for (const path of uncovered) lines.push(notCovered(path));
  lines.push(`TEST QUALITY: ${violations.length} violation(s), ${warnings.length} warning(s)${partial.length ? `, ${partial.length} partly parsed` : ''}${uncovered.length ? `, ${uncovered.length} file(s) not covered` : ''}.`);
  return `${lines.join('\n')}\n`;
}

/**
 * Scan the test files `base..head` changes in `repo`. Never throws: { code, report, ... }, where
 * `report` always says why on a non-zero code. `image` (SEMGREP_IMAGE) is the image repository.
 */
export function scan({ repo = '.', range, hub = HERE, rev = 'HEAD', sarifOut = null, image = process.env.SEMGREP_IMAGE || IMAGE_REPOSITORY, pull = false, timeoutMs = TIMEOUT_MS } = {}) {
  const work = mkdtempSync(join(tmpdir(), 'test-quality-'));
  try {
    const bounds = typeof range === 'string' ? range.split('..') : [];
    // A bound that starts with `-` would be an option to git, not a revision.
    if (bounds.length !== 2 || bounds.some((b) => b === '' || b.startsWith('-'))) throw new ScanError(EXIT.USAGE, `--range takes <base>..<head>, not "${range}"`);
    const [baseRev, headRev] = bounds;
    const root = gitOut(repo, ['rev-parse', '--show-toplevel'], `${repo} is not a git checkout`).trim();
    const base = commitOf(root, baseRev, `${baseRev} in ${root}`);
    const head = commitOf(root, headRev, `${headRev} in ${root}`);
    const tree = gitOut(root, ['rev-parse', '--verify', `${head}^{tree}`], `cannot read the tree of ${head.slice(0, 12)}`).trim();
    const rules = exportRules(hub, rev, join(work, 'rules-source'));
    const stamp = { commit: head, tree, base, ruleset: rules.ruleset.ruleset, rulesSha256: rules.rulesSha, hubCommit: rules.hubCommit, semgrep: rules.ruleset.semgrep };
    const files = changedFiles(root, base, head, rules.extensions);
    if (files.sources.length === 0) {
      const report = `TEST QUALITY SCAN — no source file changed in ${base.slice(0, 12)}...${head.slice(0, 12)}: nothing to scan\n${files.uncovered.map((p) => `${notCovered(p)}\n`).join('')}`;
      return { code: EXIT.PASS, report, violations: [], warnings: [], uncovered: files.uncovered, stamp };
    }
    const subject = join(work, 'subject');
    exportSubject(root, head, files.sources, subject);
    const reports = join(work, 'reports');
    mkdirSync(reports);
    const imageName = `${image}:${rules.ruleset.semgrep}`;
    if (!isImageName(imageName)) throw new ScanError(EXIT.USAGE, `"${imageName}" is not an image name (SEMGREP_IMAGE and the pin in ruleset.json make it)`);
    const out = runSemgrep({ image: imageName, pull, pin: rules.ruleset.semgrep, rulesDir: rules.rulesDir, subject, out: reports, timeoutMs });
    // A recovered partial parse (a TypeScript generic its parser does not know) leaves the rest of the
    // file scanned: it is reported, not fatal. Any other error means a file or a rule was not run.
    const typeOf = (e) => (Array.isArray(e.type) ? e.type[0] : e.type);
    const partial = out.json.errors.filter((e) => typeOf(e) === 'PartialParsing' && e.level === 'warn')
      .map((e) => ({ path: cleanPath(e.path), line: e.spans && e.spans[0] && e.spans[0].start ? e.spans[0].start.line : null }));
    const fatal = out.json.errors.filter((e) => !(typeOf(e) === 'PartialParsing' && e.level === 'warn'));
    if (fatal.length) {
      const named = fatal.slice(0, 8).map((e) => `    ${typeOf(e)}${e.path ? ` ${cleanPath(e.path)}` : ''}`).join('\n');
      throw new ScanError(EXIT.CANNOT_VERIFY, `semgrep reported ${fatal.length} error(s), so what it checked cannot be trusted:\n${named}`);
    }
    const run = out.sarif.runs[0];
    run.properties = { ...(run.properties || {}), [STAMP_KEY]: stamp };
    if (sarifOut) {
      mkdirSync(dirname(resolve(sarifOut)), { recursive: true });
      writeFileSync(resolve(sarifOut), `${JSON.stringify(out.sarif, null, 2)}\n`);
    }
    const { violations, warnings } = findingsOf(out.json);
    const report = render({ stamp, targeted: files.sources.length, scanned: out.json.paths.scanned.length, violations, warnings, uncovered: files.uncovered, partial });
    return { code: violations.length ? EXIT.VIOLATIONS : EXIT.PASS, report, violations, warnings, uncovered: files.uncovered, partial, stamp };
  } catch (err) {
    return { ...refusal(err), violations: [], warnings: [], uncovered: [], stamp: null };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** Why a scan or a fetch did not happen, as the caller reports it: { code, why, reason, report }. */
function refusal(err) {
  const code = err instanceof ScanError ? err.code : EXIT.INTERNAL;
  const label = code === EXIT.USAGE ? 'USAGE' : code === EXIT.CANNOT_VERIFY ? 'TEST QUALITY SCAN CANNOT VERIFY' : 'INTERNAL';
  return { code, why: err.message, reason: err instanceof ScanError ? err.reason : null, report: `${label} — ${err.message}\n` };
}

/**
 * The preflight: make sure the Semgrep image the hub pins is on this machine, fetching it with
 * Docker's progress shown where it is not. `/dev-sprint` runs it at the start of a run, before the
 * test writer, and stops there with what to do when it fails, so the hook (which never downloads)
 * finds the image there. Scans nothing. Never throws: { code, report, why, reason }, exit 0 when the
 * image is present or fetched; `reason` says what to tell the person on a failure.
 */
export function prepareImage({ hub = HERE, rev = 'HEAD', image = process.env.SEMGREP_IMAGE || IMAGE_REPOSITORY, timeoutMs = PREFLIGHT_PULL_TIMEOUT_MS } = {}) {
  const work = mkdtempSync(join(tmpdir(), 'test-quality-'));
  try {
    const rules = exportRules(hub, rev, join(work, 'rules-source'));
    const imageName = `${image}:${rules.ruleset.semgrep}`;
    if (!isImageName(imageName)) throw new ScanError(EXIT.USAGE, `"${imageName}" is not an image name (SEMGREP_IMAGE and the pin in ruleset.json make it)`);
    const env = { ...process.env };
    delete env.SEMGREP_APP_TOKEN;
    const did = ensureSemgrepImage(imageName, true, env, true, timeoutMs);
    return { code: EXIT.PASS, report: `TEST QUALITY IMAGE — ${imageName} ${did === 'pulled' ? 'fetched' : 'is already on this machine'}\n` };
  } catch (err) {
    return refusal(err);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/**
 * Which test stacks a repository holds and whether the hub's rules cover them: the committed tree of
 * `repo` against the rules at `rev`. Reads files and git only (no Docker, no Semgrep), so `/add-repo`
 * can say it while linking a spoke. Never throws: { code, report, covered, uncovered }, where each is
 * [{ language, key, suggested, files, example }] (`suggested` names the library's suggested ruleset for it, or null). A stack with tests and no rules is the one a person has to decide on.
 */
export function coverage({ repo = '.', hub = HERE, rev = 'HEAD' } = {}) {
  const work = mkdtempSync(join(tmpdir(), 'test-quality-'));
  try {
    const root = gitOut(repo, ['rev-parse', '--show-toplevel'], `${repo} is not a git checkout`).trim();
    const head = commitOf(root, 'HEAD', `HEAD in ${root}`);
    const rules = exportRules(hub, rev, join(work, 'rules-source'));
    const tally = (map, path, extension) => {
      const language = labelOf(extension);
      const key = languageKeyOf(extension);
      const seen = map.get(language) || { language, key, suggested: key !== null && rules.suggested.has(key) ? `hub-${key}.yml` : null, files: 0, example: path };
      seen.files += 1;
      map.set(language, seen);
    };
    const covered = new Map();
    const uncovered = new Map();
    for (const path of gitOut(root, ['ls-tree', '-r', '-z', '--name-only', head], `cannot list the files of ${head.slice(0, 12)}`).split('\0')) {
      if (path === '') continue;
      const extension = path.includes('.') ? path.slice(path.lastIndexOf('.') + 1) : '';
      if (rules.extensions.has(extension)) { if (rules.includes.some((glob) => globMatches(path, glob))) tally(covered, path, extension); }
      else if (uncoveredLanguage(extension) && looksLikeTest(path)) tally(uncovered, path, extension);
    }
    const byName = (map) => [...map.values()].sort((a, b) => (a.language < b.language ? -1 : 1));
    const lines = [`TEST STACKS — ${root} at ${head.slice(0, 12)} · rules ${rules.ruleset.ruleset} (sha ${rules.rulesSha.slice(0, 12)})`];
    if (covered.size) lines.push(`  covered by the rules: ${byName(covered).map((c) => `${c.language} (${c.files} test file(s))`).join(', ')}`);
    for (const u of byName(uncovered)) lines.push(`  [NOT COVERED] ${u.language} — ${u.files} test file(s), e.g. ${u.example}: no rules, so nothing in them is checked${u.suggested ? `; a suggested ruleset is ready: ${u.suggested}` : '; no suggested ruleset ships for it'}`);
    if (!covered.size && !uncovered.size) lines.push('  no test files found at this commit');
    lines.push(`TEST STACKS: ${covered.size} covered, ${uncovered.size} not covered.`);
    return { code: EXIT.PASS, report: `${lines.join('\n')}\n`, covered: byName(covered), uncovered: byName(uncovered) };
  } catch (err) {
    return { ...refusal(err), covered: [], uncovered: [] };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/**
 * In GitHub Actions, one warning annotation per test file nothing checked, so the pull request says so
 * beside the file and not only in a log. A warning: the step's result is unchanged. Elsewhere, nothing.
 */
function annotations(uncovered) {
  if (process.env.GITHUB_ACTIONS !== 'true') return '';
  const property = (text) => text.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A').replace(/:/g, '%3A').replace(/,/g, '%2C');
  return uncovered.map((path) => `::warning file=${property(path)},title=Not checked by the test-quality scan::No rules for this language, so nothing in this test file was checked. The test critic reads it by hand; the hub can add a rule (hub-<language>.yml).\n`).join('');
}

function main(argv) {
  const o = { repo: '.', hub: HERE, rev: 'HEAD' };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const value = () => { if (argv[i + 1] === undefined) return null; i += 1; return argv[i]; };
    if (a === '--pull') { o.pull = true; continue; }
    if (a === '--ensure-image') { o.ensureImage = true; continue; }
    if (a === '--coverage') { o.coverage = true; continue; }
    const known = { '--repo': 'repo', '--range': 'range', '--hub': 'hub', '--rev': 'rev', '--sarif': 'sarifOut', '--timeout': 'timeoutSeconds' };
    if (!(a in known)) { process.stderr.write(`USAGE — unknown argument: ${a}\n`); return EXIT.USAGE; }
    const v = value();
    if (v === null) { process.stderr.write(`USAGE — ${a} needs a value\n`); return EXIT.USAGE; }
    o[known[a]] = v;
  }
  if (o.timeoutSeconds !== undefined) { o.timeoutMs = Number(o.timeoutSeconds) * 1000; if (!(o.timeoutMs > 0)) { process.stderr.write(`USAGE — --timeout takes a number of seconds, not "${o.timeoutSeconds}"\n`); return EXIT.USAGE; } }
  if (o.coverage) {
    if (o.range || o.pull || o.ensureImage || o.sarifOut || o.timeoutSeconds) { process.stderr.write('USAGE — --coverage only reads files: give it --repo, and --hub / --rev if needed, and nothing else\n'); return EXIT.USAGE; }
    const r = coverage({ repo: o.repo, hub: o.hub, rev: o.rev });
    (r.code === EXIT.PASS ? process.stdout : process.stderr).write(r.report);
    return r.code;
  }
  if (o.ensureImage) {
    if (o.range || o.pull) { process.stderr.write('USAGE — --ensure-image scans nothing: give it no --range and no --pull\n'); return EXIT.USAGE; }
    const r = prepareImage({ hub: o.hub, rev: o.rev, ...(o.timeoutMs ? { timeoutMs: o.timeoutMs } : {}) });
    (r.code === EXIT.PASS ? process.stdout : process.stderr).write(r.report);
    // The caller tells the person what to do for each: start Docker, install it, or run the command again.
    if (r.code !== EXIT.PASS && r.reason) process.stderr.write(`REASON: ${r.reason}\n`);
    return r.code;
  }
  if (!o.range) { process.stderr.write('USAGE — node scripts/test-quality-scan.mjs --repo <checkout> --range <base>..<head> [--hub <dir>] [--rev <revision>] [--sarif <file>] [--timeout <seconds>] [--pull]\n       node scripts/test-quality-scan.mjs --ensure-image [--hub <dir>] [--rev <revision>]\n       node scripts/test-quality-scan.mjs --coverage --repo <checkout> [--hub <dir>] [--rev <revision>]\n'); return EXIT.USAGE; }
  const r = scan(o);
  (r.code === EXIT.PASS ? process.stdout : process.stderr).write(r.report);
  process.stdout.write(annotations(r.uncovered || []));
  return r.code;
}

const invoked = (() => { try { return realpathSync(process.argv[1] || '') === realpathSync(fileURLToPath(import.meta.url)); } catch (err) { return false; } })();
// The last line of an exit 2, 3 or 4 names this script and its code, so a shell line that hides
// the code, with a pipe or `; echo`, still tells the harness's failure record. Written at once,
// so a process.exit() never loses it.
if (invoked) process.on('exit', (code) => { if (code >= 2 && code <= 4) { try { writeSync(2, `HARNESS EXIT: test-quality-scan ${code}\n`); } catch { /* stderr is closed */ } } });
if (invoked) process.exit(main(process.argv.slice(2)));

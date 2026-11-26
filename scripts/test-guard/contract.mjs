/**
 * contract.mjs — what a spoke's checks.env declares about its tests, and how a path is classed.
 *
 * TEST_GUARD_PATHS   the test writer's paths: tests — in test folders or beside the code — fixtures,
 *                    snapshots, helpers and runner configuration. Every tracked entry they match at
 *                    the approved test commit is approved and immutable, and a new path they match
 *                    is refused: only the test writer creates or changes a test. A new runner
 *                    configuration, and a new file a supported runner would collect as a test, are
 *                    refused anywhere; runner configuration added to a mixed file (package.json,
 *                    pyproject.toml, setup.cfg) is undone. The declaration is the scope: a test the
 *                    supported conventions do not name, outside it, is not seen. TEST_WRITABLE_PATHS,
 *                    which once let the engineer add tests, is retired and refused when set
 *                    (retiredKeyProblem).
 *
 * Grammar: comma-separated patterns, each matched against the whole repository-relative
 * path from the root, case-sensitive. `**` is a whole segment (any number of folders; a trailing
 * `/**` is everything inside a folder, never the folder itself), `*` any run of characters inside
 * one segment, `?` one character. No negation, braces, brackets, escapes, absolute paths or `..`.
 */

import { GUARD_KEY, RETIRED_KEY } from './common.mjs';
import { lsTree } from './git.mjs';

/** Flat KEY=value, `#` comments skipped, first wins — the grammar of spoke-rules.mjs parseChecksEnv. */
export function parseChecksEnv(text) {
  const map = new Map();
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const m = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if (m && !map.has(m[1])) map.set(m[1], m[2].trim());
  }
  return map;
}

/** The output of read-spoke.mjs, as it printed it: the header fields and the bytes after `---`. */
export function parseReadSpoke(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(String(input), 'utf8');
  const end = buf.indexOf('\n---\n');
  if (end === -1) return null;
  const header = buf.subarray(0, end).toString('utf8');
  const field = (name) => { const m = header.match(new RegExp(`^${name}: (.+)$`, 'm')); return m ? m[1].trim() : null; };
  const bytes = buf.subarray(end + 5);
  const read = { repository: field('Repository'), commit: field('Commit'), path: field('Path'), blob: field('Blob'), bytes, body: bytes.toString('utf8') };
  return read.repository && read.commit && read.path && read.blob ? read : null;
}

/** Why one pattern is malformed, or null. */
function patternProblem(p) {
  if (p === '') return 'is empty';
  if (/[\u0000-\u001f\u007f]/.test(p)) return 'holds a control character';
  if (p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p)) return 'is absolute; write it from the repository root, with no leading "/"';
  if (p.includes('\\')) return 'holds "\\": the separator is "/" and the grammar has no escapes';
  if (p.startsWith('!')) return 'starts with "!": the grammar has no negation, so the protected set only ever grows by a pattern';
  if (p.startsWith(':')) return 'starts with ":", which git reads as pathspec magic; this grammar has none';
  if (/[[\]{}]/.test(p)) return 'holds "[", "]", "{" or "}", which this grammar does not have: list each pattern on its own, and match an unusual character with "?"';
  const segments = p.split('/');
  if (p.endsWith('/')) return 'ends with "/"; patterns name files — write "<folder>/**" for everything inside a folder';
  if (segments.some((s) => s === '')) return 'has an empty segment ("//")';
  if (segments.some((s) => s === '..')) return 'climbs out of the repository with ".."';
  if (segments.some((s) => s === '.')) return 'has a "." segment; write the path from the repository root';
  if (segments.some((s) => s.includes('**') && s !== '**')) return '"**" must be a whole segment, as in "**/x", "x/**" or "a/**/b"';
  if (segments.every((s) => /^[*?]+$/.test(s))) return 'names nothing: every segment is a wildcard, so it would protect production code as well';
  return null;
}

function parseList(key, value) {
  const v = value === undefined ? '' : String(value).trim();
  if (v === '' || v === 'UNRESOLVED') return { state: 'not-configured', patterns: [], findings: [] };
  if (v === 'none') return { state: 'none', patterns: [], findings: [] };
  const findings = [];
  const patterns = [];
  v.split(',').forEach((raw, i) => {
    const p = raw.replace(/^[ \t]+|[ \t]+$/g, '');
    const at = `${key} entry ${i + 1}${p ? ` "${p}"` : ''}`;
    if (p === 'none' || p === 'UNRESOLVED') { findings.push(`${at}: "${p}" stands alone, never beside other entries`); return; }
    const problem = patternProblem(p);
    if (problem) findings.push(`${at}: ${problem}`);
    else if (patterns.includes(p)) findings.push(`${at}: is listed twice`);
    else patterns.push(p);
  });
  return findings.length ? { state: 'invalid', patterns: [], findings } : { state: 'patterns', patterns, findings: [] };
}

/** TEST_GUARD_PATHS: { state: patterns | none | not-configured | invalid, patterns, findings }. */
export const parseGuardPaths = (value) => parseList(GUARD_KEY, value);

/**
 * TEST_WRITABLE_PATHS set to patterns: refused, never ignored — its patterns may name tests that
 * TEST_GUARD_PATHS does not cover, which ignoring it would leave unprotected. Null when unset.
 */
export function retiredKeyProblem(env) {
  const v = String(env.get(RETIRED_KEY) ?? '').trim();
  if (v === '' || v === 'none' || v === 'UNRESOLVED') return null;
  return `${RETIRED_KEY} is retired: the engineer adds no test, and only the test writer creates or changes one. Move its patterns into ${GUARD_KEY}, where a new file is refused, and delete the key`;
}

const SEGMENT_CACHE = new Map();
function segmentRe(segment) {
  let re = SEGMENT_CACHE.get(segment);
  if (!re) {
    const src = [...segment].map((c) => (c === '*' ? '.*' : c === '?' ? '.' : c.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&'))).join('');
    re = new RegExp(`^${src}$`, 'su');
    SEGMENT_CACHE.set(segment, re);
  }
  return re;
}

/** True when the whole path matches the whole pattern, by the grammar above. */
export function matchPattern(pattern, path) {
  const ps = pattern.split('/');
  const xs = String(path).split('/');
  const seen = new Set();
  const walk = (i, j) => {
    const key = `${i}:${j}`;
    if (seen.has(key)) return false;
    seen.add(key);
    if (i === ps.length) return j === xs.length;
    if (ps[i] === '**') {
      if (i === ps.length - 1) return j < xs.length;
      for (let k = j; k <= xs.length; k += 1) if (walk(i + 1, k)) return true;
      return false;
    }
    return j < xs.length && segmentRe(ps[i]).test(xs[j]) && walk(i + 1, j + 1);
  };
  return walk(0, 0);
}

export const isMatched = (patterns, path) => patterns.some((p) => matchPattern(p, path));

// Files that configure a test runner or its discovery, by name. A new one is refused anywhere in
// the repository, untracked and ignored copies included, and a tracked one must sit under the
// declaration. Case is ignored: a case-insensitive disk would read `Conftest.py` as `conftest.py`.
const RUNNER_CONFIG = [
  /^conftest\.py$/, /^pytest\.ini$/, /^tox\.ini$/, /^noxfile\.py$/, /^\.coveragerc$/,
  /^(jest|vitest|playwright|cypress|ava|karma|wdio|mocha)\.(config|setup|workspace|conf)(\.[^/]+)?$/, /^vitest\.workspace(\.[^/]+)?$/,
  /^\.mocharc(\.[^/]+)?$/, /^\.nycrc(\.[^/]+)?$/, /^setuptests\.[^/]+$/, /^phpunit\.xml(\.dist)?$/, /^\.rspec$/, /^(spec|rails)_helper\.rb$/,
];
const nameOf = (path) => String(path).split('/').pop().toLowerCase();
export const isRunnerConfig = (path) => RUNNER_CONFIG.some((re) => re.test(nameOf(path)));
const isMatchedLoose = (patterns, path) => patterns.some((p) => matchPattern(p.toLowerCase(), String(path).toLowerCase()));

// Where the supported runners look for tests by default: a file named or placed this way is a test,
// wherever the declaration leaves it. A new one is refused anywhere, like a new runner configuration,
// and a tracked one must sit under the declaration (declarationGaps). This is the supported set, not
// every test layout there is: a runner configured to collect other names is the declaration's to name.
// Folders are matched only where the convention is unambiguous — `test/` and `tests/` at the
// repository root, never deeper, where the word can be the product's own.
const TEST_CONVENTIONS = [
  { label: '*.test.* or *.spec.* (Jest, Vitest, Mocha, AVA, Playwright)', name: /\.(test|spec)\.[cm]?[jt]sx?$/ },
  { label: '*.cy.* (Cypress)', name: /\.cy\.[cm]?[jt]sx?$/ },
  { label: '*-test.js, *_test.js or test-*.js (node --test)', name: /(^test[-_][^/]*|[-_]test)\.[cm]?js$/ },
  { label: 'test_*.py or *_test.py (pytest)', name: /^test_[^/]*\.py$|_test\.py$/ },
  { label: '*_test.go (go test)', name: /_test\.go$/ },
  { label: '*_spec.rb or *_test.rb (RSpec, Minitest)', name: /_(spec|test)\.rb$/ },
  { label: '*.snap (Jest and Vitest snapshots)', name: /\.snap$/ },
  { label: 'a __tests__, __mocks__, __snapshots__ or __fixtures__ folder', dir: /(^|\/)(__tests__|__mocks__|__snapshots__|__fixtures__)\// },
  { label: 'test/ or tests/ at the repository root', dir: /^tests?\// },
  { label: 'src/test/ (Maven, Gradle)', dir: /(^|\/)src\/test\// },
];
/** The convention a path follows as a test, or null. Case is ignored, as for the declaration. */
export function testConvention(path) {
  const lower = String(path).toLowerCase();
  const hit = TEST_CONVENTIONS.find((c) => (c.name ? c.name.test(nameOf(path)) : c.dir.test(lower)));
  return hit ? hit.label : null;
}

// Files that hold a repository's dependencies or packaging and may also configure a supported
// runner. The guard protects files whole and has no field-level policy, so it reads these for one
// fact only: whether they carry runner configuration. One that does must be declared whole — which
// freezes the rest of it for the sprint, its dependencies included — or the configuration moved into
// a runner file of its own (RUNNER_CONFIG) and that declared. One that does not stays production
// code, and runner configuration added to it during a run is undone.
const PACKAGE_JSON_KEYS = ['jest', 'mocha', 'ava', 'nyc', 'c8', 'tap'];
const sectionsOf = (text, re) => [...new Set(text.split(/\r?\n/).map((l) => l.match(re)).filter(Boolean).map((m) => m[1].trim()))];
const EMBEDDED = {
  'package.json': (text) => {
    let data;
    try { data = JSON.parse(text.replace(/^﻿/, '')); } catch { return ['it is not valid JSON, so whether it configures a runner cannot be read']; }
    if (!data || typeof data !== 'object' || Array.isArray(data)) return [];
    return PACKAGE_JSON_KEYS.filter((k) => Object.prototype.hasOwnProperty.call(data, k)).map((k) => `the top-level "${k}" key`);
  },
  'pyproject.toml': (text) => sectionsOf(text, /^\s*\[\[?\s*(tool\.(?:pytest|coverage)\b[^\]]*)\]/).map((s) => `the [${s}] table`)
    .concat(sectionsOf(text, /^\s*(tool\.(?:pytest|coverage)\b[^=\s]*)\s*=/).map((s) => `the ${s} key`)),
  'setup.cfg': (text) => sectionsOf(text, /^\s*\[\s*(tool:pytest|coverage:[^\]]*)\]/).map((s) => `the [${s}] section`),
};
export const isRunnerHost = (path) => Object.prototype.hasOwnProperty.call(EMBEDDED, nameOf(path));
/** The runner configuration a mixed file carries, one phrase per item; empty when it carries none. */
export function embeddedRunnerConfig(path, bytes) {
  const read = EMBEDDED[nameOf(path)];
  return read ? read(Buffer.isBuffer(bytes) ? bytes.toString('utf8') : String(bytes)) : [];
}
/** The mixed files a tree holds outside the manifest: path to entry. They carry no runner configuration once setup has passed. */
export const hostsIn = (tree, approved = new Map()) => new Map(tree.filter((e) => e.type === 'blob' && isRunnerHost(e.path) && !approved.has(e.path)).map((e) => [e.path, e]));

/**
 * The run's policy over paths. `classify(path)` is one of
 *   approved   a tracked entry of the approved test commit under the declaration: immutable
 *   protected  any new path under the declaration (matched ignoring case), a new runner
 *              configuration anywhere, a new file laid out as a test by a supported runner's
 *              convention anywhere, or a configuration the frozen test command's runner would find
 *              by searching (`discovered`, from baseline.mjs discoveredConfigs): refused
 *   free       production code
 * `declared(path)` is the declaration alone, without the conventions. `collides(path)` is true for a
 * path that would sit above or below an approved entry. `hosts` holds the mixed files of the approved
 * test commit outside the manifest (hostsIn), the versions runner configuration added to one is
 * undone to. `discovers(path)` is true for one of the `discovered` paths, matched ignoring case.
 * `conventionOnly(path)` is true for a protected path that only a supported runner's test convention
 * names: outside the declaration, not runner configuration, not discovered, colliding with nothing.
 */
export function makePolicy({ guard, manifest, hosts = new Map(), discovered = [] }) {
  const approved = new Map(manifest.map((e) => [e.path, e]));
  const approvedDirs = new Set();
  for (const e of manifest) {
    const parts = e.path.split('/');
    for (let i = 1; i < parts.length; i += 1) approvedDirs.add(parts.slice(0, i).join('/'));
  }
  const found = new Set(discovered.map((p) => p.toLowerCase()));
  const discovers = (path) => found.has(String(path).toLowerCase());
  return {
    guard, approved, hosts, discovers,
    declared: (path) => approved.has(path) || isMatchedLoose(guard, path) || isRunnerConfig(path),
    classify(path) {
      if (approved.has(path)) return 'approved';
      if (isMatchedLoose(guard, path) || isRunnerConfig(path) || testConvention(path) || discovers(path)) return 'protected';
      return 'free';
    },
    collides(path) {
      if (approvedDirs.has(path)) return true;
      const parts = path.split('/');
      for (let i = 1; i < parts.length; i += 1) if (approved.has(parts.slice(0, i).join('/'))) return true;
      return false;
    },
    conventionOnly(path) {
      return !approved.has(path) && !isMatchedLoose(guard, path) && !isRunnerConfig(path) && !discovers(path) && !this.collides(path) && !!testConvention(path);
    },
  };
}

/** The manifest: every tracked entry of a commit the declaration covers, sorted by path. */
export function buildManifest(cwd, commit, patterns) {
  const tree = lsTree(cwd, commit);
  const entries = tree.filter((e) => isMatched(patterns, e.path))
    .map(({ path, mode, type, oid, utf8 }) => ({ path, mode, type, oid, utf8 }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { entries, tree };
}

/** Findings for patterns that name a folder at this commit; notes for patterns that match nothing. */
export function patternCoverage(key, patterns, tree) {
  const findings = [];
  const notes = [];
  const folders = new Set();
  for (const e of tree) {
    const parts = e.path.split('/');
    for (let i = 1; i < parts.length; i += 1) folders.add(parts.slice(0, i).join('/'));
  }
  for (const p of patterns) {
    if (!/[*?]/.test(p) && folders.has(p)) findings.push(`${key} entry "${p}" names a folder, and a pattern matches files: write "${p}/**"`);
    else if (!tree.some((e) => matchPattern(p, e.path))) notes.push(`${key} entry "${p}" matches no tracked entry yet; it still governs a path added there`);
  }
  return { findings, notes };
}

/** The checks.env keys a run freezes: the commands the finalizer runs, the coverage floors and the declaration. */
export const FROZEN_KEYS = ['INSTALL_COMMAND', 'FORMAT_COMMAND', 'LINT_COMMAND', 'TYPECHECK_COMMAND', 'BUILD_COMMAND', 'TEST_COMMAND', 'COVERAGE_COMMAND',
  'SECRET_SCAN_COMMAND', 'MIGRATION_IMMUTABILITY_COMMAND', 'PROJECT_COVERAGE_FLOOR', 'CHANGED_LINE_FLOOR', GUARD_KEY];

/** What a run takes from a checks.env: the one reading setup records and the finalizer re-derives. */
export const frozenValues = (env) => Object.fromEntries(FROZEN_KEYS.map((k) => [k, env.has(k) ? env.get(k) : null]));

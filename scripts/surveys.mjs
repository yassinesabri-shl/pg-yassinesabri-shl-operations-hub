// Part of the harness asset library c6f3b4427d58f7c3 (see VERSION.json) · 2026-09-28
/**
 * surveys.mjs — the service surveys the hub keeps: where they are, what shape
 * one has, and how it is read out of the hub at a commit.
 *
 * Shared by check-survey.mjs, read-survey.mjs and join-survey.mjs. Not a command. It owns five
 * things so they cannot drift apart:
 *
 *   - the folder. `docs/estate/surveys/<ID>.md`, one file per listed
 *     repository, flat, nothing else in it. The template lives beside the
 *     folder, never in it, so every file in it is a survey;
 *   - the shape. Frontmatter with exactly four keys (`kind`, `repository`,
 *     `commit`, `template`), a fixed title, a fixed disclaimer, and six
 *     sections in a fixed order: six tables, the last of them the open points.
 *     A survey on template v6 adds a seventh table, "Not read", after them.
 *     An empty table is the single line `None found.`; no open points is
 *     `None.`;
 *   - the keys. Every row opens with one key in a fixed grammar, so a call in
 *     one survey and a serve in another are matched exactly, never guessed:
 *       http:<METHOD>:<path>    METHOD in capitals, or ANY for a route that
 *                               accepts every method; path lower case,
 *                               except on a call to external:<host>, where it
 *                               keeps the host's case; a segment mixes text
 *                               and {snake_case} parameters, never two side by
 *                               side; a :verb only at the end; no trailing
 *                               slash, no host, no query
 *       event:<topic>  queue:<name>  job:<name>
 *                               event and queue also take {<property>}, the
 *                               name of a configuration placeholder, where the
 *                               repository does not hold the value
 *       store:<engine>:<name>   the logical store; its tables go in Objects.
 *                               The name also takes {<property>}, as event
 *                               and queue do
 *       lib:<package>
 *     Which kinds a table takes is fixed by SECTIONS. A call's provider is a
 *     listed repository id; `external:<host>` -- the host the call reaches,
 *     lower case, no scheme, port or path -- so a third party is named, never
 *     only "outside"; or `unknown`, where the code names no host and no
 *     repository, so the call is still a row a reader can find. An open point
 *     holds only what the grammar cannot key: a key written in one that no row
 *     carries is a finding, because nothing that reads the graph sees it;
 *   - the evidence. Every row points at the lines it rests on, at the survey's
 *     own commit: `<ID>@<12-hex>:<path> L<a>-<b>`, several joined by ", ". The
 *     pointer is re-proved against the spoke by check-survey.mjs; this file
 *     checks only its form;
 *   - the graph. Who serves each key, who calls it, who calls it with the
 *     provider unnamed, which third-party hosts each repository calls, which
 *     stores and libraries more than one repository shares, and which calls
 *     match no serve --
 *     built from the surveys when asked and never saved, so it can never be
 *     behind them. A call matches a serve when the two keys are equal after
 *     every {parameter} is written {}: `/users/{id}` and `/users/{user_id}`
 *     are one route. A serve of http:ANY matches a call of every method. A
 *     placeholder name is listed apart, never matched. Exact, on a normal
 *     form; never a guess.
 *
 * A survey describes what a repository's code does and points at it. It is
 * never cited as authority, and it never outranks a contract.
 *
 * A partial survey is the survey of one part of a repository, as one seat
 * dispatch returns it. join-survey.mjs merges the parts into the survey. A part
 * has the survey's shape with two changes. Its kind is `service-survey-part`,
 * and a fifth key, `part`, names it. Its open points can name a key whose row
 * is in another part. parseSurvey reads a part with `{ part: true }`, and
 * renderSurvey writes a part or a survey from the rows parseSurvey gives.
 *
 * The body is read the way a person reads it, so anything a person would not
 * see is refused rather than masked: HTML, comments, code fences, indented
 * code, link definitions and invisible characters. A survey has no use for any
 * of them. A code span is text that a person sees, so HTML inside one is not
 * refused. A placeholder is written {word}, never <word>.
 *
 * Exit codes are the gate's, reported by the scripts that import this:
 *   0 pass · 1 verified and failed · 2 cannot verify · 3 usage · 4 internal.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { git, catAt, catBlobs, isPlaceholder, REPO_ID, COMMIT, SpokeError, EXIT } from './spoke-remote.mjs';
import { splitFrontmatter, splitRow } from './context-docs.mjs';

export const SURVEY_DIR = 'docs/estate/surveys';
export const SURVEY_KIND = 'service-survey';
export const PART_KIND = 'service-survey-part';
// A part of the plan, R (the part that resolves conflicts), or carried (the
// rows a refresh keeps).
export const PART_ID = /^(?:P\d+(?:\.\d+)*|R|carried)$/;
export const CURRENT_TEMPLATE = 'service-survey v6';
// Only a survey on template v6 carries section 7. A part never does.
export const SURVEY_TEMPLATES = ['service-survey v4', 'service-survey v5', CURRENT_TEMPLATE];
export const EXTERNAL = 'external';
// A call whose provider the code does not name: no host, no repository. Still a
// row, so read-survey --readers can name its caller as a possible reader.
export const UNKNOWN = 'unknown';
// `external:<host>`: a DNS name of two labels or more, lower case, nothing else.
const LABEL = '[a-z0-9](?:[a-z0-9-]*[a-z0-9])?';
const EXTERNAL_PROVIDER = new RegExp(`^${EXTERNAL}:(${LABEL}(?:\\.${LABEL})+)$`);
export const NONE_FOUND = 'None found.';
// The start of the finding for a key in an open point that no row carries.
// join-survey.mjs reads it to find the one rule that part mode skips.
export const LOOSE_KEYS = 'an open point names';
export const NO_OPEN_POINTS = 'None.';
export const DISCLAIMER = 'Generated by /survey-repo from the repository at the commit above. It describes what the code does and points at it; it is never cited as authority and never outranks a contract. Where the two disagree, the contract wins and this survey is refreshed.';

const FIELDS = ['kind', 'repository', 'commit', 'template'];
export const ACCESS = ['read', 'write', 'read-write'];
const ROW_KINDS = ['http', 'event', 'queue', 'job'];

export const SECTIONS = [
  { title: '1. Serves', table: 'serves', header: ['Key', 'What', 'Evidence'], kinds: ROW_KINDS },
  { title: '2. Calls', table: 'calls', header: ['Key', 'Provider', 'Evidence'], kinds: ROW_KINDS },
  { title: '3. Data stores', table: 'stores', header: ['Key', 'Access', 'Objects', 'Evidence'], kinds: ['store'] },
  { title: '4. Shared libraries', table: 'libraries', header: ['Key', 'Version', 'Evidence'], kinds: ['lib'] },
  { title: '5. Third-party libraries', table: 'third_party', header: ['Key', 'Version', 'Evidence'], kinds: ['lib'] },
  { title: '6. Open points', open: true, header: ['Unresolved', 'Owner', 'Resolves', 'Evidence'] },
];

// The section a v6 survey adds. The join writes it from the file list, and no seat does.
export const NOT_READ = { title: '7. Not read', header: ['Rule', 'Folder', 'Files', 'Bytes'] };

const METHOD = '(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|ANY)';
const PARAMETER = '\\{[a-z][a-z0-9_]*\\}';
// An http path. A segment mixes literal text and {snake_case} parameters, as in v{version} or
// {action}-instance. Two parameters side by side are refused, because no caller can split them.
// The last segment can end in a :verb, the custom method of a Google API, as in
// {session_id}:detectIntent. A colon anywhere else is refused, so an unconverted :id stays a finding.
// `letters` is the letter range of the literal text and of the verb.
const httpKey = (letters) => new RegExp(`^http:${METHOD}:(?!.*\\}\\{)(?:/|(?:/(?:[${letters}0-9._~-]|${PARAMETER})+)+(?::[${letters}][${letters}0-9]*)?)$`);
// The http key of a call to external:<host>. The path keeps the case of the host's API, because
// the host can treat case as part of the path. No Serves row in the estate matches such a call.
export const EXTERNAL_HTTP_KEY = httpKey('A-Za-z');
// The http key before template v6: a segment is one literal or one parameter, and no :verb.
// Only the rule on keys in open points reads it, for a survey on template v4 or v5.
const LEGACY_HTTP_KEY = new RegExp(`^http:${METHOD}:(?:/|(?:/(?:[a-z0-9._~-]+|${PARAMETER}))+)$`);
export const KEYS = {
  http: httpKey('a-z'),
  event: /^event:(?:[A-Za-z0-9._/-]+|\{[A-Za-z0-9._-]+\})$/,
  queue: /^queue:(?:[A-Za-z0-9._/-]+|\{[A-Za-z0-9._-]+\})$/,
  job: /^job:[a-z0-9][a-z0-9._-]*$/,
  store: /^store:[a-z0-9]+:(?:[A-Za-z0-9._/-]+|\{[A-Za-z0-9._-]+\})$/,
  lib: /^lib:[A-Za-z0-9@][A-Za-z0-9@._/:-]*$/,
};

// `<ID>@<12-hex>:<path> L<a>-<b>`. A path carries no space, comma or colon, and
// no leading "/" or "..", so a cell of several pointers splits one way.
export const POINTER = /^([A-Za-z0-9][A-Za-z0-9._-]*)@([0-9a-f]{12}):((?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[^\s,:]+) L(\d+)-(\d+)$/;

// The files a survey does not read. Each rule uses the path and the size of a file, which
// `git ls-tree -r -l` gives. Three rules also read content (contentAt), in the plan and the check
// alike, so both derive the same result from the commit:
//   - the data rule takes a .json file above NUMERIC_JSON_LIMIT bytes whose text is mostly numbers
//   - the vendored rule takes a code file whose first bytes name a third-party licence
//   - the markup rule takes a page template or an HTML page that holds no sign of a call
// The join reads no content: it takes the rule of each file from plan.json.
// The rules belong to the template version: a change to them needs a new template. A rule can
// also change inside a template version that is in no release.
// UNRESOLVED — a path-only override for a folder of own code that holds a licence document. Owner: harness lead. Resolves: the template version that adds the override.
export const EXCLUDE_RULES = Object.freeze(['archive', 'vendored', 'test', 'migration', 'locale', 'ci', 'harness', 'lock', 'data', 'asset', 'markup', 'tiny', 'size']);
export const EXCLUDE_LIMIT = 500000;
// A .json file above this size is data when at least 80% of its characters are numeric.
export const NUMERIC_JSON_LIMIT = 16384;
// A file of this size or less holds no survey row, unless the manifest rule reads it.
export const TINY_LIMIT = 16;

const ARCHIVE_EXT = ['.phar', '.jar', '.war', '.zip', '.gz', '.tgz', '.7z'];
const DATA_EXT = ['.sql', '.csv', '.tsv'];
// A lock file pins the versions that the manifest beside it names. The manifest stays in the plan.
const LOCK_NAMES = ['composer.lock', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'gemfile.lock', 'poetry.lock', 'go.sum', 'cargo.lock'];
const CI_FOLDERS = ['.github', '.circleci'];
const CI_NAMES = ['.gitlab-ci.yml', 'jenkinsfile'];
// The files that the harness installs in a spoke, at the root. They hold no survey row, and one
// survey test run gave them a seat of their own.
const HARNESS_FOLDERS = ['.githooks'];
const HARNESS_NAMES = ['checks.env'];
// A licence document names a file such as LICENSE, COPYING.lib or LICENSE-MIT.txt. The pattern
// refuses a code extension on purpose: license.php is code about licences, not a licence.
const LICENCE_DOC = /^(licen[cs]e|copying)(-[a-z0-9]+)?(\.(txt|md|markdown|rst|lib|lesser))?$/i;
const ASSET_EXT = ['.css', '.scss', '.less', '.map', '.svg', '.min.js', '.min.css'];
// A vendored file with no licence document beside it, as a copied helper or an IDE stub, names
// its licence in its first lines. The rule reads the first HEADER_BYTES bytes of a code file
// (licensedAt). A line "SPDX-License-Identifier" alone is no marker, because own code often has
// one. The phrases are the ones that the texts of MIT, BSD, Apache, GPL and MPL hold.
const HEADER_EXT = ['.php', '.js', '.mjs', '.cjs', '.ts', '.jsx', '.tsx', '.py', '.rb', '.java', '.kt', '.go', '.cs', '.c', '.h', '.cpp', '.hpp', '.swift', '.scala'];
export const HEADER_BYTES = 4096;
const LICENCE_MARKERS = [
  /permission is hereby granted, free of charge/i,
  /redistribution and use in source and binary forms/i,
  /licensed under the apache license/i,
  /gnu (?:lesser |library |affero )?general public license/i,
  /mozilla public license/i,
  /@license\b[^\n]*\b(?:mit|bsd|apache|gpl|lgpl|mpl|isc)\b/i,
];
// A folder named stubs or stub holds the signatures of a library for an IDE, not code that runs.
const STUB_FOLDERS = ['stub', 'stubs'];
// A page loads a stylesheet, a script, an image, an icon or a font as a file. That is not an API
// call, and a planner who reads Calls for the services a repository depends on gains nothing from it.
const STATIC_FILE_EXT = ['.css', '.js', '.map', '.ico', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.avif', '.bmp', '.woff', '.woff2', '.ttf', '.otf', '.eot'];
// The test rule takes no "simulator" folder. A simulator can serve real routes, so the survey reads it.
const SEGMENT_RULES = [
  ['vendored', ['vendor', 'node_modules', 'third_party', 'bower_components', 'dist', ...STUB_FOLDERS]],
  ['test', ['tests', 'specs', '__tests__', '__mocks__', 'mock', 'mocks', 'fixtures', 'testdata', 'e2e']],
  ['migration', ['migrations', 'migration', 'migrate', 'seeds', 'seeders', 'seed']],
  ['locale', ['translations', 'locale', 'locales', 'i18n', 'lang']],
];
// A folder named test or spec is a test folder only at the root or directly below a folder named
// src, as in Maven's src/test. In other places the name can be a module of the service: one
// survey test run lost a whole assessment module, application/modules/test, to the rule.
const ROOT_TEST_FOLDERS = ['test', 'spec'];
// Two consecutive folders. A bare "changelog" or "versions" folder is not a rule.
const PAIR_RULES = [['migration', [['db', 'changelog'], ['alembic', 'versions']]]];

/**
 * The package roots of a file list: every folder below the repository root that directly holds
 * a licence document. Each folder ends in "/". A licence document at the root marks nothing.
 */
export function packageRoots(files) {
  return new Set(packageLicences(files).keys());
}

/**
 * The licence document that marks each package root, as a Map from folder to file name. A folder
 * with several licence documents names the first in code-unit order.
 */
export function packageLicences(files) {
  const licences = new Map();
  for (const { path } of files) {
    const slash = path.lastIndexOf('/');
    if (slash < 0) continue;
    const name = path.slice(slash + 1);
    if (name.search(LICENCE_DOC) !== 0) continue;
    const folder = path.slice(0, slash + 1);
    const known = licences.get(folder);
    if (known === undefined || name < known) licences.set(folder, name);
  }
  return licences;
}

/**
 * Which rule leaves a file out of the survey, and the folder its row names. The first rule
 * in EXCLUDE_RULES order wins. A segment rule names the folder nearest the root that matches.
 * The `vendored` rule also matches a package root (see packageRoots), and the match nearest the
 * root wins. A rule on the file name or the size names the folder that holds the file.
 * `content` holds the three sets of contentAt, each of paths:
 *   - `numeric`: the text of the file is numeric (isNumericText). It counts only for a .json file
 *     above NUMERIC_JSON_LIMIT bytes.
 *   - `licensed`: the first bytes of a code file name a third-party licence. Such a file is
 *     vendored, and its row names its folder.
 *   - `quiet`: a markup file holds no sign of a call (isQuietMarkup).
 */
export function excludeRule(path, bytes, roots = new Set(), content = NO_CONTENT) {
  const numeric = content.numeric.has(path);
  const licensed = content.licensed.has(path);
  const quiet = content.quiet.has(path);
  const parts = path.split('/');
  const name = parts.pop();
  const dirs = parts.map((d) => d.toLowerCase());
  const lower = name.toLowerCase();
  const own = parts.length ? `${parts.join('/')}/` : './';
  const endsWith = (list) => list.some((ext) => lower.endsWith(ext));
  const through = (i) => `${parts.slice(0, i + 1).join('/')}/`;
  // `end` is the index of the last folder of a match. The match nearest the root has the smallest end.
  const segment = (rule, names) => {
    for (let i = 0; i < dirs.length; i += 1) {
      if (names.includes(dirs[i])) return { rule, folder: through(i), end: i };
    }
    return null;
  };
  const pair = (rule, pairs) => {
    for (let i = 1; i < dirs.length; i += 1) {
      if (pairs.some(([a, b]) => dirs[i - 1] === a && dirs[i] === b)) return { rule, folder: through(i), end: i };
    }
    return null;
  };
  const rootTest = () => {
    for (let i = 0; i < dirs.length; i += 1) {
      if (ROOT_TEST_FOLDERS.includes(dirs[i]) && (i === 0 || dirs[i - 1] === 'src')) return { rule: 'test', folder: through(i), end: i };
    }
    return null;
  };
  const nearest = (one, two) => (one && two ? (two.end < one.end ? two : one) : one || two);
  const result = ({ rule, folder }) => ({ rule, folder });
  const packageRoot = (rule) => {
    for (let i = 0; i < parts.length; i += 1) {
      if (roots.has(through(i))) return { rule, folder: through(i), end: i };
    }
    return null;
  };

  if (endsWith(ARCHIVE_EXT)) return { rule: 'archive', folder: own };
  for (const [rule, names] of SEGMENT_RULES) {
    let hit = segment(rule, names);
    if (rule === 'vendored') hit = nearest(hit, packageRoot(rule));
    if (rule === 'vendored' && !hit && licensed && isHeaderCandidate(path)) hit = { rule, folder: own };
    if (rule === 'test') hit = nearest(hit, rootTest());
    if (!hit && rule === 'test' && (lower.search(/\.(test|spec)\./) >= 0 || lower.search(/[_-]test\./) >= 0)) {
      hit = { rule, folder: own };
    }
    if (rule === 'migration') hit = nearest(hit, pair(rule, PAIR_RULES[0][1]));
    if (hit) return result(hit);
  }
  const ci = segment('ci', CI_FOLDERS);
  if (ci) return result(ci);
  if (CI_NAMES.includes(lower)) return { rule: 'ci', folder: own };
  if (dirs.length && HARNESS_FOLDERS.includes(dirs[0])) return { rule: 'harness', folder: through(0) };
  if (!dirs.length && HARNESS_NAMES.includes(lower)) return { rule: 'harness', folder: own };
  if (LOCK_NAMES.includes(lower)) return { rule: 'lock', folder: own };
  if (endsWith(DATA_EXT) || (numeric && isNumericCandidate(path, bytes))) return { rule: 'data', folder: own };
  if (endsWith(ASSET_EXT)) return { rule: 'asset', folder: own };
  if (quiet && isMarkup(path)) return { rule: 'markup', folder: own };
  if (bytes <= TINY_LIMIT && !isManifestInput(path)) return { rule: 'tiny', folder: own };
  if (bytes > EXCLUDE_LIMIT) return { rule: 'size', folder: own };
  return null;
}

/* ---------------------------------------------------------------- fact files */

// The kinds of a fact file, in the order the budget takes them. Each seat of a large survey
// looked up the same store names, configuration keys, route rules and HTTP helper. The seat
// of the fact sheet reads these files once, and every part seat gets its sheet.
// Routes and HTTP helpers come before constants: one survey test run spent the budget on enum
// classes and left out the one router file.
export const FACT_KINDS = Object.freeze(['config', 'routes', 'http', 'constants', 'docs']);
const CONFIG_FOLDERS = ['config', 'configs', 'configuration', 'conf', 'settings'];
const CONFIG_NAMES = [
  /^(application|bootstrap)([-.][a-z0-9]+)*\.(properties|ya?ml)$/,
  /^appsettings([-.][a-z0-9]+)*\.json$/,
  /^(config|settings)\.[a-z]+$/,
  /\.ini(\.[a-z0-9]+)?$/,
  /^(docker-)?compose([-.][a-z0-9]+)*\.ya?ml$/,
];
const ROUTE_NAMES = /^(routes?|router|urls)(\.[a-z0-9]+)+$/;
const HTTP_NAMES = /(api|http|rest)[-_]?(client|helper)/;
const DOC_NAMES = /^(readme|install)(\.[a-z]+)?$/;

/**
 * The kind of a fact file, or null. The rule reads the path only. An environment file
 * (".env" and every name that starts with it) is never a fact file, because its values are
 * often secrets, and the survey copies nothing from it. A document is a fact file only at the
 * repository root.
 */
export function factKind(path) {
  const parts = path.toLowerCase().split('/');
  const name = parts.pop();
  if (name.startsWith('.env')) return null;
  if (parts.some((d) => CONFIG_FOLDERS.includes(d)) || CONFIG_NAMES.some((re) => name.search(re) >= 0)) return 'config';
  if (parts.includes('constants') || name.includes('constant')) return 'constants';
  if (parts.includes('routes') || name.search(ROUTE_NAMES) >= 0) return 'routes';
  if (name.search(HTTP_NAMES) >= 0) return 'http';
  if (parts.length === 0 && name.search(DOC_NAMES) >= 0) return 'docs';
  return null;
}

/**
 * The fact files of a plan, as { facts, left }. `files` is the plannable files, so no excluded
 * file is a fact file. The budget takes the files by kind, in FACT_KINDS order, then by path,
 * while their bytes total `budget` or less. A file that does not fit goes to `left`. Both lists
 * hold { path, bytes, kind } and sort by path.
 */
export function factFiles(files, budget) {
  const byPath = (a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const found = files.map((f) => ({ path: f.path, bytes: f.bytes, kind: factKind(f.path) })).filter((f) => f.kind !== null);
  found.sort((a, b) => FACT_KINDS.indexOf(a.kind) - FACT_KINDS.indexOf(b.kind) || byPath(a, b));
  const facts = [];
  const left = [];
  let total = 0;
  for (const file of found) {
    if (total + file.bytes <= budget) {
      facts.push(file);
      total += file.bytes;
    } else {
      left.push(file);
    }
  }
  return { facts: facts.sort(byPath), left: left.sort(byPath) };
}

/** True for a code file whose first bytes the vendored rule reads for a licence marker. */
function isHeaderCandidate(path) {
  const lower = path.toLowerCase();
  return HEADER_EXT.some((ext) => lower.endsWith(ext));
}

/** True when a text names a third-party licence: LICENCE_MARKERS. */
export function isLicensedText(text) {
  return LICENCE_MARKERS.some((marker) => text.search(marker) >= 0);
}

/**
 * The paths of the code files whose first HEADER_BYTES bytes name a third-party licence, read
 * from the git directory at the commit. Only a file that no rule takes, or that a rule after
 * `vendored` takes, is read. Throws when git cannot read a blob, so the caller exits 2.
 */
export function licensedAt(gitDir, commit, files) {
  return readMatching(gitDir, commit, candidatesOf(files, 'vendored', isHeaderCandidate), (bytes) => isLicensedText(bytes.subarray(0, HEADER_BYTES).toString('utf8')));
}

// A page template or an HTML page. One survey test run read 50 templates of one module, and one
// of them held a call. A page that holds no sign of a call is the markup rule's: a link, an
// image or a script file that the page loads is not a call.
const MARKUP_EXT = ['.tpl', '.html', '.htm'];
const CALL_SIGNS = [
  /\$\.(?:ajax|post|get|getjson)\s*\(/i,
  /\bjquery\.(?:ajax|post|get|getjson)\s*\(/i,
  /\.load\s*\(\s*["'`]/,
  /\bfetch\s*\(/,
  /\bxmlhttprequest\b/i,
  /\baxios\b/,
  /\$http\s*[.(]/,
  /\bnew\s+(?:websocket|eventsource)\s*\(/i,
  /\bsendbeacon\s*\(/i,
  /<form\b[^>]*\baction\s*=/i,
  /<iframe\b[^>]*\bsrc\s*=\s*["']?(?:https?:)?\/\//i,
];

/** True for a page template or an HTML page: MARKUP_EXT. */
export function isMarkup(path) {
  const lower = path.toLowerCase();
  return MARKUP_EXT.some((ext) => lower.endsWith(ext));
}

/**
 * True when a markup text holds no sign of a call: no AJAX or fetch call, no socket, no form
 * that posts, and no frame of another host. The markup rule leaves such a file out.
 */
export function isQuietMarkup(text) {
  return !CALL_SIGNS.some((sign) => text.search(sign) >= 0);
}

/** The paths of the markup files that hold no sign of a call, read from git at the commit. */
export function quietMarkupAt(gitDir, commit, files) {
  return readMatching(gitDir, commit, candidatesOf(files, 'markup', isMarkup), (bytes) => isQuietMarkup(bytes.toString('utf8')));
}

/**
 * The files whose content a rule reads: each file that `wanted` takes, where no rule before
 * `rule` takes it on its path and size.
 */
function candidatesOf(files, rule, wanted) {
  const roots = packageRoots(files);
  const at = EXCLUDE_RULES.indexOf(rule);
  return files.filter(({ path, bytes }) => {
    if (!wanted(path)) return false;
    const hit = excludeRule(path, bytes, roots);
    return hit === null || EXCLUDE_RULES.indexOf(hit.rule) > at;
  });
}

/**
 * The paths of `candidates` whose bytes `test` accepts, read from the git directory in batches.
 * Throws when git cannot read a blob, so the caller exits 2.
 */
function readMatching(gitDir, commit, candidates, test) {
  const found = new Set();
  let batch = [];
  let size = 0;
  const read = () => {
    for (const [path, blob] of catAt(gitDir, commit, batch)) {
      if (!blob || blob.type !== 'blob') throw new Error(`git cannot read the blob of ${path} at ${commit.slice(0, 12)}`);
      if (test(blob.bytes)) found.add(path);
    }
    batch = [];
    size = 0;
  };
  for (const { path, bytes } of candidates) {
    if (batch.length && size + bytes > READ_BATCH) read();
    batch.push(path);
    size += bytes;
  }
  if (batch.length) read();
  return found;
}

/** No content read: every content rule finds nothing. */
export const NO_CONTENT = Object.freeze({ numeric: new Set(), licensed: new Set(), quiet: new Set() });

/**
 * The three sets of paths that the content rules take, read from git at the commit: { numeric,
 * licensed, quiet }. The plan and the check both call it, so both derive one section 7.
 * Throws when git cannot read a blob.
 */
export function contentAt(gitDir, commit, files) {
  return {
    numeric: numericJsonAt(gitDir, commit, files),
    licensed: licensedAt(gitDir, commit, files),
    quiet: quietMarkupAt(gitDir, commit, files),
  };
}

/** True for a .json file above NUMERIC_JSON_LIMIT bytes: the data rule reads its content. */
function isNumericCandidate(path, bytes) {
  return bytes > NUMERIC_JSON_LIMIT && path.toLowerCase().endsWith('.json');
}

// The characters of numeric data: digits, "-", ".", ",", "[", "]" and the white space of JSON.
const NUMERIC_CHARS = new Set([...'0123456789-.,[] \t\n\r']);

/** True when at least 80% of the characters of the text are numeric. An empty text is not numeric. */
export function isNumericText(text) {
  let hits = 0;
  for (let i = 0; i < text.length; i += 1) if (NUMERIC_CHARS.has(text[i])) hits += 1;
  // Whole numbers, so the edge of 80% is exact.
  return text.length > 0 && hits * 5 >= text.length * 4;
}

/**
 * The paths whose content the data rule reads: each .json file above NUMERIC_JSON_LIMIT bytes
 * that no rule before `data` takes. The order of `files` is kept.
 */
export function numericCandidates(files) {
  const roots = packageRoots(files);
  const data = EXCLUDE_RULES.indexOf('data');
  return files.filter(({ path, bytes }) => {
    if (!isNumericCandidate(path, bytes)) return false;
    const hit = excludeRule(path, bytes, roots);
    return hit === null || EXCLUDE_RULES.indexOf(hit.rule) > data;
  }).map((f) => f.path);
}

// One read of git cat-file holds at most this many bytes of blobs.
const READ_BATCH = 64 * 1024 * 1024;

/**
 * The paths of numericCandidates whose text is numeric, read from the git directory at the
 * commit. Throws when git cannot read a blob, so the caller exits 2.
 */
export function numericJsonAt(gitDir, commit, files) {
  const wanted = new Set(numericCandidates(files));
  return readMatching(gitDir, commit, files.filter((f) => wanted.has(f.path)), (bytes) => isNumericText(bytes.toString('utf8')));
}

/**
 * The rows of the "Not read" section. A row is one folder and one rule. Rows sort by folder in
 * code-unit order, then by the rule's place in EXCLUDE_RULES, so one input gives one text.
 * `content` holds the paths that the content rules take (contentAt).
 */
export function notReadRows(files, content = NO_CONTENT) {
  const rows = new Map();
  const roots = packageRoots(files);
  for (const { path, bytes } of files) {
    const hit = excludeRule(path, bytes, roots, content);
    if (!hit) continue;
    const key = `${hit.folder}\0${hit.rule}`;
    const row = rows.get(key) || { rule: hit.rule, folder: hit.folder, files: 0, bytes: 0 };
    row.files += 1;
    row.bytes += bytes;
    rows.set(key, row);
  }
  return [...rows.values()].sort((a, b) => {
    if (a.folder !== b.folder) return a.folder < b.folder ? -1 : 1;
    return EXCLUDE_RULES.indexOf(a.rule) - EXCLUDE_RULES.indexOf(b.rule);
  });
}

/** The files that no rule of excludeRule leaves out: the files the survey can read. */
export function readableFiles(files, content = NO_CONTENT) {
  const roots = packageRoots(files);
  return files.filter(({ path, bytes }) => !excludeRule(path, bytes, roots, content));
}

/* ------------------------------------------------------------------ manifests */

// A manifest is a file that a package manager reads by its fixed name. Each name belongs to one
// ecosystem, because the rule for a nested manifest compares manifests of one ecosystem only.
const MANIFEST_NAMES = new Map([
  ['package.json', 'npm'],
  ['pyproject.toml', 'python'], ['requirements.txt', 'python'], ['Pipfile', 'python'], ['setup.py', 'python'], ['setup.cfg', 'python'],
  ['go.mod', 'go'],
  ['Cargo.toml', 'cargo'],
  ['pom.xml', 'maven'],
  ['build.gradle', 'gradle'], ['build.gradle.kts', 'gradle'],
  ['composer.json', 'php'],
  ['Gemfile', 'ruby'],
  ['mix.exs', 'elixir'],
  ['pubspec.yaml', 'dart'],
  ['Package.swift', 'swift'],
]);
const DOTNET_PROJECT = /\.(cs|fs|vb)proj$/;
// A Python requirements file can have any name, so only a build file that names it makes it count.
const FREE_REQUIREMENTS = /requirements.*\.(txt|in)$/i;

// The files that can declare the members of a workspace, each read from one folder, and the
// ecosystem of the members it names.
const WORKSPACE_FILES = new Map([
  ['package.json', 'npm'], ['pnpm-workspace.yaml', 'npm'], ['composer.json', 'php'], ['Cargo.toml', 'cargo'],
  ['go.work', 'go'], ['pom.xml', 'maven'], ['settings.gradle', 'gradle'], ['settings.gradle.kts', 'gradle'],
]);

const BUILD_NAMES = new Set([
  'Dockerfile', 'Containerfile', 'Makefile', 'makefile', 'GNUmakefile', 'Jenkinsfile',
  '.gitlab-ci.yml', 'azure-pipelines.yml', 'bitbucket-pipelines.yml',
]);

const baseName = (path) => path.slice(path.lastIndexOf('/') + 1);
const folderOfPath = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** The ecosystem of a manifest by its fixed name, or null for any other file. */
function ecosystemOf(name) {
  if (MANIFEST_NAMES.has(name)) return MANIFEST_NAMES.get(name);
  return name.search(DOTNET_PROJECT) >= 0 ? 'dotnet' : null;
}

/** True for a file that builds, ships or sets up the repository: a container file, a CI pipeline, a make file or a shell script. */
function isBuildFile(path) {
  const name = baseName(path);
  if (BUILD_NAMES.has(name) || name.startsWith('Dockerfile.') || name.endsWith('.dockerfile') || name.endsWith('.sh')) return true;
  if (name.search(/^(docker-)?compose[^/]*\.ya?ml$/) >= 0 || name.search(/^buildspec[^/]*\.ya?ml$/) >= 0) return true;
  if (path.startsWith('.github/workflows/') && name.search(/\.ya?ml$/) >= 0) return true;
  return path === '.circleci/config.yml';
}

/** True for a file that the manifest rule reads: a dependency list, a workspace file or a build file. */
function isManifestInput(path) {
  const name = baseName(path);
  return ecosystemOf(name) !== null || name.search(FREE_REQUIREMENTS) >= 0 || WORKSPACE_FILES.has(name) || isBuildFile(path);
}

/** A path joined to a folder, with "." and ".." resolved. Null when it leaves the repository. */
function joinPath(folder, relative) {
  const out = folder ? folder.split('/') : [];
  for (const segment of relative.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (!out.length) return null;
      out.pop();
    } else out.push(segment);
  }
  return out.join('/');
}

/** A glob segment with "*" against one folder name. Matched by hand: the pattern comes from a file. */
function segmentMatches(pattern, name) {
  const pieces = pattern.split('*');
  if (pieces.length === 1) return pattern === name;
  if (!name.startsWith(pieces[0])) return false;
  let at = pieces[0].length;
  for (let i = 1; i < pieces.length - 1; i += 1) {
    const found = name.indexOf(pieces[i], at);
    if (found < 0) return false;
    at = found + pieces[i].length;
  }
  const last = pieces[pieces.length - 1];
  return name.length - at >= last.length && name.endsWith(last);
}

/** A folder glob ("*" in a segment, "**" for any number of segments) against a folder path. */
function globMatches(pattern, folder) {
  const want = pattern.split('/').filter((s) => s !== '' && s !== '.');
  const have = folder ? folder.split('/') : [];
  const walk = (i, j) => {
    if (i === want.length) return j === have.length;
    if (want[i] === '**') return walk(i + 1, j) || (j < have.length && walk(i, j + 1));
    return j < have.length && segmentMatches(want[i], have[j]) && walk(i + 1, j + 1);
  };
  return walk(0, 0);
}

const quoted = (text) => [...text.matchAll(/["']([^"'\n]+)["']/g)].map((m) => m[1]);

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** The member globs a workspace file declares, relative to its folder. A file it cannot read declares none. */
function workspaceMembers(name, text) {
  if (name === 'package.json') {
    const json = parseJson(text);
    const w = json && json.workspaces;
    const list = Array.isArray(w) ? w : w && Array.isArray(w.packages) ? w.packages : [];
    return list.filter((s) => typeof s === 'string');
  }
  if (name === 'composer.json') {
    const json = parseJson(text);
    const repos = json && json.repositories;
    const list = Array.isArray(repos) ? repos : repos && typeof repos === 'object' ? Object.values(repos) : [];
    return list.filter((r) => r && r.type === 'path' && typeof r.url === 'string').map((r) => r.url);
  }
  if (name === 'pnpm-workspace.yaml') {
    const out = [];
    let inside = false;
    for (const line of text.split(/\r?\n/)) {
      if (line.search(/^packages:\s*$/) === 0) inside = true;
      else if (inside && line.search(/^\s+-\s*/) === 0) out.push(line.replace(/^\s+-\s*/, '').replace(/\s+#.*$/, '').replace(/^["']|["']$/g, ''));
      else if (inside && line.trim() !== '' && line.search(/^\s/) < 0) inside = false;
    }
    return out;
  }
  if (name === 'Cargo.toml') {
    const start = text.search(/^\[workspace\]\s*$/m);
    if (start < 0) return [];
    const rest = text.slice(start).replace(/^\[workspace\]\s*$/m, '');
    const end = rest.search(/^\[/m);
    const members = (end < 0 ? rest : rest.slice(0, end)).match(/members\s*=\s*\[([\s\S]*?)\]/);
    return members ? quoted(members[1]) : [];
  }
  if (name === 'go.work') {
    const body = text.replace(/\/\/.*$/gm, '');
    const out = [];
    for (const m of body.matchAll(/^\s*use\s*\(([\s\S]*?)\)/gm)) out.push(...m[1].split(/\s+/).filter(Boolean));
    for (const m of body.matchAll(/^\s*use\s+([^\s(]+)\s*$/gm)) out.push(m[1]);
    return out.map((s) => s.replace(/^["']|["']$/g, ''));
  }
  if (name === 'pom.xml') {
    const body = text.replace(/<!--[\s\S]*?-->/g, '');
    return [...body.matchAll(/<module>\s*([^<]+?)\s*<\/module>/g)].map((m) => m[1]);
  }
  if (name === 'settings.gradle' || name === 'settings.gradle.kts') {
    const out = [];
    for (const line of text.split(/\r?\n/)) {
      if (line.search(/^\s*include\b/) === 0) out.push(...quoted(line).map((s) => s.replace(/^:/, '').split(':').join('/')));
    }
    return out;
  }
  return [];
}

/** The dependency lists of a file list: every manifest by its fixed name, and every requirements file. */
function dependencyLists(files) {
  const lists = [];
  for (const { path } of files) {
    const name = baseName(path);
    const ecosystem = ecosystemOf(name);
    if (ecosystem !== null || name.search(FREE_REQUIREMENTS) >= 0) lists.push({ path, folder: folderOfPath(path), ecosystem: ecosystem || 'python', fixed: ecosystem !== null });
  }
  return lists;
}

/** The paths manifestsOf reads: the build files, the CI build files, and every file that can declare a workspace. */
export function manifestInputs(files, ciFiles = []) {
  return [
    ...files.map((f) => f.path).filter((p) => isBuildFile(p) || WORKSPACE_FILES.has(baseName(p))),
    ...ciFiles.map((f) => f.path).filter(isBuildFile),
  ];
}

/**
 * The manifests at a project root, as { manifests, left }, each a list of { path, why } sorted
 * by path. `files` is the list readableFiles gives, and `texts` is a Map from each path of
 * manifestInputs to its text (null or absent when it cannot be read). `ciFiles` are the files
 * that the ci rule takes. No part holds them, but a CI pipeline still builds the repository, so
 * it can name a dependency list as a build file does.
 *
 * A dependency list counts when one of these holds:
 *   1. It has a fixed name, and no folder above it holds a manifest of the same ecosystem
 *      ("top-level"). With a manifest at the root, that is the root's manifest only.
 *   2. A workspace file in the root, or beside a manifest that counts, names its folder
 *      ("workspace <file>"): npm or pnpm workspaces, composer path repositories, a Cargo
 *      workspace, go.work, Maven modules, Gradle settings.
 *   3. A build file names its path, from the root or from the build file's folder
 *      ("named by <file>"). A requirements file with a free name counts only this way.
 * Every other dependency list is in `left`, with the manifest above it or "no build file names it".
 */
export function manifestsOf(files, texts, ciFiles = []) {
  const lists = dependencyLists(files);
  const byPath = new Map(lists.map((l) => [l.path, l]));
  const why = new Map();
  const textOf = (path) => {
    const t = texts.get(path);
    return typeof t === 'string' ? t : null;
  };

  const named = new Map();
  for (const path of [...files, ...ciFiles].map((f) => f.path).filter(isBuildFile)) {
    const text = textOf(path);
    if (text === null) continue;
    const folder = folderOfPath(path);
    for (const token of text.split(/[\s'"=(),;[\]{}<>`|&]+/)) {
      if (token === '' || token.startsWith('/')) continue;
      for (const candidate of [joinPath('', token), joinPath(folder, token)]) {
        if (candidate !== null && byPath.has(candidate) && !named.has(candidate)) named.set(candidate, path);
      }
    }
  }

  const above = (list) => {
    let nearest = null;
    for (const other of lists) {
      if (!other.fixed || other.ecosystem !== list.ecosystem || other.folder === list.folder) continue;
      const inside = other.folder === '' || list.folder.startsWith(`${other.folder}/`);
      if (inside && (nearest === null || other.folder.length > nearest.folder.length)) nearest = other;
    }
    return nearest;
  };
  for (const list of lists) if (list.fixed && above(list) === null) why.set(list.path, 'top-level');

  // Workspaces can nest, as Maven modules do, so read the folders of new manifests until none is added.
  const read = new Set();
  for (;;) {
    const folders = new Set(['', ...[...why.keys()].map(folderOfPath)]);
    let added = false;
    for (const folder of folders) {
      for (const [name, ecosystem] of WORKSPACE_FILES) {
        const file = folder ? `${folder}/${name}` : name;
        if (read.has(file)) continue;
        read.add(file);
        const text = textOf(file);
        if (text === null) continue;
        for (const pattern of workspaceMembers(name, text)) {
          if (pattern.startsWith('!') || pattern.split('/').includes('..')) continue;
          const glob = folder ? `${folder}/${pattern}` : pattern;
          for (const list of lists) {
            if (!list.fixed || list.ecosystem !== ecosystem || why.has(list.path) || !globMatches(glob, list.folder)) continue;
            why.set(list.path, `workspace ${file}`);
            added = true;
          }
        }
      }
    }
    if (!added) break;
  }
  for (const [path, build] of named) if (!why.has(path)) why.set(path, `named by ${build}`);

  const manifests = [];
  const left = [];
  for (const list of [...lists].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    if (why.has(list.path)) manifests.push({ path: list.path, why: why.get(list.path) });
    else {
      const parent = list.fixed ? above(list) : null;
      left.push({ path: list.path, why: parent ? `below ${parent.path}` : 'no build file names it' });
    }
  }
  return { manifests, left };
}

/**
 * manifestsOf over the files at a commit, with the text of each input read from the git directory.
 * `all` is every file at the commit, and `content` the sets that contentAt gives. The plan and
 * the check pass the same two, so both derive the same manifests.
 */
export function manifestsAt(gitDir, commit, all, content = NO_CONTENT) {
  const roots = packageRoots(all);
  const readable = [];
  const ciFiles = [];
  for (const file of all) {
    const hit = excludeRule(file.path, file.bytes, roots, content);
    if (hit === null) readable.push(file);
    else if (hit.rule === 'ci') ciFiles.push(file);
  }
  const texts = new Map();
  for (const [path, blob] of catAt(gitDir, commit, manifestInputs(readable, ciFiles))) {
    if (blob && blob.type === 'blob') texts.set(path, blob.bytes.toString('utf8'));
  }
  return manifestsOf(readable, texts, ciFiles);
}

/** The library tables: a row of them names a package that a manifest declares. */
export const LIBRARY_TABLES = new Set(['libraries', 'third_party']);

/** Each library row with a pointer to a file that is not in `manifests`, as { row, path } for its first such pointer. */
export function libraryRowsOffManifest(rows, manifests) {
  const listed = new Set(manifests.map((m) => m.path));
  const out = [];
  for (const row of rows) {
    if (!LIBRARY_TABLES.has(row.table)) continue;
    const off = row.evidence.find((p) => !listed.has(p.path));
    if (off) out.push({ row, path: off.path });
  }
  return out;
}

/**
 * Parse `git ls-tree -r -l -z`. A record is `<mode> <type> <object> <size>\t<path>`, ended by a
 * NUL. The size pads with spaces, and a submodule has `-`. The survey cannot read a submodule
 * or a symbolic link, so both leave the list.
 */
export function parseLsTree(text) {
  const files = [];
  for (const record of text.split('\0')) {
    if (!record) continue;
    const tab = record.indexOf('\t');
    if (tab < 0) continue;
    const head = record.slice(0, tab).match(/^(\d+) (\w+) \S+ +(\d+|-)$/);
    if (!head) continue;
    const [, mode, type, size] = head;
    if (type === 'commit' || mode === '120000') continue;
    files.push({ path: record.slice(tab + 1), bytes: Number(size) });
  }
  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

const INVISIBLE = /[\u200B-\u200F\u202A-\u202E\u2060\uFEFF\u00AD]/;
// Each rule is the pattern, what it finds, and whether a match inside a code
// span is allowed. A reader sees a code span as text, so HTML in it hides nothing.
const HIDDEN = [
  [/<!--|-->/, 'an HTML comment', true],
  [/<\/?[A-Za-z!][^>]*>/, 'raw HTML', true],
  [/^\s{0,3}(?:`{3,}|~{3,})/, 'a code fence', false],
  [/^(?: {4,}|\t)\S/, 'indented code', false],
  [/^\s{0,3}\[[^\]]+\]:/, 'a link definition', false],
];
// A tag that is one word, as a seat writes a placeholder by mistake.
const WORD_TAG = /^<([A-Za-z][A-Za-z0-9_.-]*)>$/;
// A finding quotes at most this many characters of the match.
const QUOTE_LIMIT = 40;

/**
 * The code spans of one line, each [start, end) over the backticks too. A run
 * of n backticks opens a span, and the next run of exactly n closes it, as
 * CommonMark reads it. A backslash makes the next backtick literal outside a
 * span. An unescaped "|" ends the search for a closer, because a table splits
 * its cells before it reads a span. A run with no closer is literal text.
 */
export function codeSpans(line) {
  const s = String(line);
  const spans = [];
  const runEnd = (from) => {
    let j = from;
    while (s[j] === '`') j += 1;
    return j;
  };
  let i = 0;
  while (i < s.length) {
    if (s[i] === '\\') {
      i += 2;
      continue;
    }
    if (s[i] !== '`') {
      i += 1;
      continue;
    }
    const open = runEnd(i);
    let close = -1;
    for (let k = open; k < s.length;) {
      if (s[k] === '|' && s[k - 1] !== '\\') break;
      if (s[k] !== '`') {
        k += 1;
        continue;
      }
      const end = runEnd(k);
      if (end - k === open - i) {
        close = end;
        break;
      }
      k = end;
    }
    if (close === -1) {
      i = open;
      continue;
    }
    spans.push([i, close]);
    i = close;
  }
  return spans;
}

/** The first match of a HIDDEN rule on a line, or null. */
function hiddenMatch(line, re, spanAllowed) {
  const spans = spanAllowed ? codeSpans(line) : [];
  const inSpan = (from, to) => spans.some(([a, b]) => from >= a && to <= b);
  for (const m of line.matchAll(new RegExp(re.source, 'g'))) {
    if (!inSpan(m.index, m.index + m[0].length)) return m[0];
  }
  return null;
}

function hiddenFinding(what, text) {
  const quoted = text.length > QUOTE_LIMIT ? `${text.slice(0, QUOTE_LIMIT)}...` : text;
  const word = text.match(WORD_TAG);
  const fix = word ? `. Write a placeholder as {${word[1]}}` : '';
  return `carries ${what} "${quoted}". A survey has none, because a reader would not see it${fix}`;
}

// Shapes a credential takes. A match is named by its line, never quoted.
const CREDENTIAL = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'a private key'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'a cloud access key'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/, 'a code-host token'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/, 'a chat token'],
  [/(?:password|passwd|pwd|secret|api[_-]?key)\s*[:=]\s*['"]?(?=[^\s'"|`]*\d)[^\s'"|`]{8,}/i, 'a password or key assignment'],
];

/** The line count `wc -l` would give, plus one for a last line with no newline. */
export function lineCount(text) {
  const s = String(text);
  if (s === '') return 0;
  const n = s.split('\n').length;
  return s.endsWith('\n') ? n - 1 : n;
}

const unwrap = (cell) => {
  const m = String(cell).match(/^`([^`]+)`$/);
  return m ? m[1] : String(cell);
};

const isSeparator = (cells) => cells.every((c) => /^:?-{3,}:?$/.test(c));

/** The kind a key names: the part before its first colon. */
export const keyKind = (key) => String(key).split(':')[0];

/** The host an `external:<host>` provider names, or null for anything else. */
export function externalHost(provider) {
  const m = String(provider).match(EXTERNAL_PROVIDER);
  return m ? m[1] : null;
}

/**
 * Parse one survey. Returns { path, repository, commit, part, rows, openPoints,
 * notRead, findings }; an open point is { line, what, owner, resolves, evidence }.
 * A row of "## 7. Not read" is { line, rule, folder, files, bytes }, and notRead is [] for a
 * survey before v6 and for a part. Findings are about form only; whether the repository and every
 * provider are listed, and whether every pointer is true, is the caller's.
 * A survey with findings is malformed, and its rows are for reporting only.
 *
 * With `{ part: true }` it reads a partial survey. The kind must be PART_KIND,
 * and the fifth key `part` must match PART_ID. An open point can name a key
 * that no row of the part carries, because the row can be in another part.
 * join-survey.mjs applies that rule to the joined survey. `part` is null in
 * survey mode.
 */
export function parseSurvey(path, text, { part = false } = {}) {
  const findings = [];
  const at = (line, m) => findings.push(`${path}${line ? ` L${line}` : ''}: ${m}`);
  const out = { path, repository: null, commit: null, template: null, part: null, rows: [], openPoints: [], notRead: [], findings };
  const wantKeys = part ? [...FIELDS, 'part'] : FIELDS;
  const wantKind = part ? PART_KIND : SURVEY_KIND;
  const all = String(text).split(/\r?\n/);

  // No line cap. Scripts read the rows, and no seat loads a survey whole, so
  // a long survey costs nothing a short one does not; a cap would drop the
  // survey of the largest repository, the one a planner most needs.
  all.forEach((line, i) => {
    if (INVISIBLE.test(line)) at(i + 1, 'carries an invisible character; a survey says only what a reader sees');
    for (const [re, what, spanAllowed] of HIDDEN) {
      const text = hiddenMatch(line, re, spanAllowed);
      if (text !== null) at(i + 1, hiddenFinding(what, text));
    }
    for (const [re, what] of CREDENTIAL) if (re.test(line)) at(i + 1, `looks like ${what}; never copy a secret into a survey -- name its location in the pull request, for the security role`);
  });

  const { fields, body, findings: fm } = splitFrontmatter(path, text);
  findings.push(...fm);
  if (fields.size === 0 && fm.length) return out;
  // Survey mode keeps its old messages word for word. Part mode is new text.
  const keyMessage = (k) => (part
    ? `frontmatter key "${k}" is not one a partial survey carries. The keys are ${wantKeys.join(', ')}`
    : `frontmatter key "${k}" is not one a survey carries; the keys are ${wantKeys.join(', ')}`);
  for (const k of fields.keys()) if (!wantKeys.includes(k)) at(0, keyMessage(k));
  for (const k of wantKeys) if (!fields.has(k)) at(0, `frontmatter is missing "${k}"`);
  const kind = fields.get('kind');
  if (kind !== undefined && kind !== wantKind) {
    at(0, part ? `kind is "${kind}". A partial survey's kind is "${wantKind}"` : `kind is "${kind}"; a survey's kind is "${wantKind}"`);
  }
  if (part && fields.has('part')) {
    const id = fields.get('part');
    if (id.search(PART_ID) === 0) out.part = id;
    else at(0, `part "${id}" is not a part id. A part id is P<n>, P<n>.<n> and deeper, R or carried`);
  }
  const template = fields.get('template');
  if (template !== undefined && !SURVEY_TEMPLATES.includes(template)) at(0, `template is "${template}"; this checker knows ${SURVEY_TEMPLATES.map((t) => `"${t}"`).join(', ')}. Run /survey-repo <ID> --full to write it again in that shape`);
  else out.template = template ?? null;
  const repository = fields.get('repository');
  if (repository !== undefined) {
    if (REPO_ID.test(repository)) out.repository = repository;
    else at(0, `repository "${repository}" is not a repository id`);
  }
  const commit = fields.get('commit');
  if (commit !== undefined) {
    if (COMMIT.test(commit)) out.commit = commit;
    else at(0, 'commit must be the full 40-character hash the survey was read at');
  }

  // Body lines keep their file line numbers.
  const offset = all.length - body.split(/\r?\n/).length;
  const lines = body.split(/\r?\n/).map((textLine, i) => ({ n: offset + i + 1, text: textLine }));
  const nonBlank = lines.filter((l) => l.text.trim() !== '');

  const title = `# Service survey: ${out.repository ?? repository ?? '<ID>'}`;
  let cursor = 0;
  if (nonBlank[cursor]?.text !== title) at(nonBlank[cursor]?.n, `the first line after the frontmatter must be "${title}"`);
  else cursor += 1;
  if (nonBlank[cursor]?.text !== DISCLAIMER) at(nonBlank[cursor]?.n, 'the fixed disclaimer must follow the title, word for word, as the template gives it');
  else cursor += 1;

  // Split the rest by level-2 headings. Anything before the first is stray.
  const rest = nonBlank.slice(cursor);
  const headings = rest.filter((l) => /^#{1,6}\s/.test(l.text));
  const stray = rest.slice(0, rest.findIndex((l) => l.text.startsWith('## ')) === -1 ? rest.length : rest.findIndex((l) => l.text.startsWith('## ')));
  for (const l of stray) at(l.n, 'text outside a section. Everything after the disclaimer belongs under one of the section headings');
  for (const h of headings) if (!h.text.startsWith('## ') || /^#{3,}/.test(h.text)) at(h.n, `"${h.text}" is not a section heading. A survey has only the sections of its template, all "## "`);
  const h2 = headings.filter((h) => /^## /.test(h.text));
  const got = h2.map((h) => h.text.slice(3));
  const withNotRead = !part && out.template === CURRENT_TEMPLATE;
  const sections = withNotRead ? [...SECTIONS, NOT_READ] : SECTIONS;
  const want = sections.map((s) => s.title);
  if (got.join('\n') !== want.join('\n')) {
    at(h2[0]?.n, `the sections must be exactly, in order: ${want.map((t) => `"## ${t}"`).join(', ')}; found ${got.length ? got.map((t) => `"## ${t}"`).join(', ') : 'none'}`);
  }

  for (const section of SECTIONS) {
    const idx = h2.findIndex((h) => h.text === `## ${section.title}`);
    if (idx === -1) continue;
    const start = h2[idx].n;
    const end = idx + 1 < h2.length ? h2[idx + 1].n : Infinity;
    const content = lines.filter((l) => l.n > start && l.n < end && l.text.trim() !== '' && !/^#{1,6}\s/.test(l.text));
    if (section.open) readOpenPoints(section, content, out, at);
    else readTable(section, content, out, at, part);
  }
  if (withNotRead) {
    const idx = h2.findIndex((h) => h.text === `## ${NOT_READ.title}`);
    if (idx !== -1) {
      const start = h2[idx].n;
      const end = idx + 1 < h2.length ? h2[idx + 1].n : Infinity;
      readNotRead(lines.filter((l) => l.n > start && l.n < end && l.text.trim() !== '' && !/^#{1,6}\s/.test(l.text)), out, at);
    }
  }

  // A library is shared inside the estate or it is a third party's; never both.
  const shared = new Set(out.rows.filter((r) => r.table === 'libraries').map((r) => r.key));
  for (const r of out.rows) {
    if (r.table === 'third_party' && shared.has(r.key)) at(r.line, `"${r.key}" is under both "## 4. Shared libraries" and "## 5. Third-party libraries"; a library is shared inside the estate or it is a third party's, so it has one row`);
  }

  // A key the grammar can write is a row. In an open point it is text, and
  // --readers never sees it: the caller would be a reader nobody moves.
  // A part skips the rule, because the row can be in another part.
  const carried = new Set(out.rows.map((r) => normaliseKey(r.key)));
  for (const p of part ? [] : out.openPoints) {
    const loose = [...new Set(keysIn(`${p.what} ${p.resolves}`, { legacy: out.template !== CURRENT_TEMPLATE }).filter((k) => !carried.has(normaliseKey(k))))];
    if (!loose.length) continue;
    const named = loose.length > 3 ? `${loose.slice(0, 3).map((k) => `"${k}"`).join(', ')} and ${loose.length - 3} more` : loose.map((k) => `"${k}"`).join(', ');
    at(p.line, `${LOOSE_KEYS} ${loose.length} key(s) no row carries: ${named}. A key in an open point is invisible to read-survey --readers; write each as a row, and a call whose provider the code does not name goes under "## 2. Calls" with Provider ${UNKNOWN}`);
  }
  return out;
}

/* ---------------------------------------------------------------- fact sheet */

export const FACTS_KIND = 'service-survey-facts';
// What a configuration property of the fact sheet holds. A fixed list, so two sheets say it alike.
export const FACT_HOLDS = Object.freeze(['host', 'base address', 'queue', 'topic', 'bucket', 'database']);
export const FACT_SECTIONS = [
  { title: 'Stores', table: 'stores', header: ['Key', 'What', 'Evidence'] },
  { title: 'Configuration properties', table: 'properties', header: ['Property', 'Holds', 'Value', 'Evidence'] },
  { title: 'Routes', table: 'routes', header: ['Rule', 'Evidence'] },
  { title: 'HTTP helpers', table: 'helpers', header: ['Helper', 'Method', 'Evidence'] },
];

/**
 * Parse a fact sheet, the file that one seat writes before the parts of a large survey and
 * every part seat reads. Returns { path, repository, commit, rows, findings }. A row is
 * { table, line, cells, evidence }. Findings are about form only. Whether each pointer is
 * true is the caller's, which holds the clone. The sheet has no part, no template and no
 * disclaimer. It carries the hidden-markup and credential rules of a survey, because each
 * part seat copies from it.
 */
export function parseFacts(path, text) {
  const findings = [];
  const at = (line, m) => findings.push(`${path}${line ? ` L${line}` : ''}: ${m}`);
  const out = { path, repository: null, commit: null, rows: [], findings };
  const all = String(text).split(/\r?\n/);
  all.forEach((line, i) => {
    if (INVISIBLE.test(line)) at(i + 1, 'carries an invisible character; a fact sheet says only what a reader sees');
    for (const [re, what, spanAllowed] of HIDDEN) {
      const found = hiddenMatch(line, re, spanAllowed);
      if (found !== null) at(i + 1, hiddenFinding(what, found));
    }
    for (const [re, what] of CREDENTIAL) if (re.test(line)) at(i + 1, `looks like ${what}; never copy a secret into a fact sheet. Write "secret, not copied" in the Value cell`);
  });

  const { fields, body, findings: fm } = splitFrontmatter(path, text);
  findings.push(...fm);
  if (fields.size === 0 && fm.length) return out;
  const want = ['kind', 'repository', 'commit'];
  for (const k of fields.keys()) if (!want.includes(k)) at(0, `frontmatter key "${k}" is not one a fact sheet carries. The keys are ${want.join(', ')}`);
  for (const k of want) if (!fields.has(k)) at(0, `frontmatter is missing "${k}"`);
  const kind = fields.get('kind');
  if (kind !== undefined && kind !== FACTS_KIND) at(0, `kind is "${kind}". A fact sheet's kind is "${FACTS_KIND}"`);
  const repository = fields.get('repository');
  if (repository !== undefined) {
    if (REPO_ID.test(repository)) out.repository = repository;
    else at(0, `repository "${repository}" is not a repository id`);
  }
  const commit = fields.get('commit');
  if (commit !== undefined) {
    if (COMMIT.test(commit)) out.commit = commit;
    else at(0, 'commit must be the full 40-character hash the sheet was read at');
  }

  const offset = all.length - body.split(/\r?\n/).length;
  const lines = body.split(/\r?\n/).map((textLine, i) => ({ n: offset + i + 1, text: textLine }));
  const nonBlank = lines.filter((l) => l.text.trim() !== '');
  const title = `# Fact sheet of ${out.repository ?? repository ?? '<ID>'}`;
  let cursor = 0;
  if (nonBlank[cursor]?.text !== title) at(nonBlank[cursor]?.n, `the first line after the frontmatter must be "${title}"`);
  else cursor += 1;
  const rest = nonBlank.slice(cursor);
  const firstHeading = rest.findIndex((l) => l.text.startsWith('## '));
  for (const l of rest.slice(0, firstHeading === -1 ? rest.length : firstHeading)) at(l.n, 'text outside a section. Everything after the title belongs under one of the section headings');
  const headings = rest.filter((l) => /^#{1,6}\s/.test(l.text));
  for (const h of headings) if (!h.text.startsWith('## ') || /^#{3,}/.test(h.text)) at(h.n, `"${h.text}" is not a section heading. A fact sheet has only its four sections, all "## "`);
  const h2 = headings.filter((h) => /^## /.test(h.text));
  const got = h2.map((h) => h.text.slice(3));
  const titles = FACT_SECTIONS.map((s) => s.title);
  if (got.join('\n') !== titles.join('\n')) {
    at(h2[0]?.n, `the sections must be exactly, in order: ${titles.map((t) => `"## ${t}"`).join(', ')}; found ${got.length ? got.map((t) => `"## ${t}"`).join(', ') : 'none'}`);
  }

  for (const section of FACT_SECTIONS) {
    const idx = h2.findIndex((h) => h.text === `## ${section.title}`);
    if (idx === -1) continue;
    const start = h2[idx].n;
    const end = idx + 1 < h2.length ? h2[idx + 1].n : Infinity;
    const content = lines.filter((l) => l.n > start && l.n < end && l.text.trim() !== '' && !/^#{1,6}\s/.test(l.text));
    const where = `"## ${section.title}"`;
    const seen = new Map();
    for (const { n, cell } of tableRows(section, content, NONE_FOUND, 'the repository has none', at)) {
      const cells = Object.fromEntries(Object.entries(cell).map(([k, v]) => [k, unwrap(v)]));
      const first = cells[section.header[0]];
      if (first.trim() === '') at(n, `${where} row has an empty ${section.header[0]} cell`);
      if (section.table === 'stores' && !KEYS.store.test(first)) at(n, `"${first}" is not a store key. A store key is store:<engine>:<name>, with the engine in lower case`);
      if (section.table === 'properties' && !FACT_HOLDS.includes(cells.Holds)) at(n, `${where} row holds "${cells.Holds}". Holds is one of ${FACT_HOLDS.map((h) => `"${h}"`).join(', ')}`);
      if (section.table === 'properties' && cells.Value.trim() === '') at(n, `${where} row has an empty Value cell. Write the value, "none in the repository" or "secret, not copied"`);
      const name = section.table === 'stores' ? normaliseKey(first) : first;
      if (section.table !== 'routes' && seen.has(name)) at(n, `${where} names "${first}" twice, also at L${seen.get(name)}. One name has one row`);
      else seen.set(name, n);
      const evidence = readEvidence(`${where} "${first}"`, cell.Evidence, n, out, at);
      out.rows.push({ table: section.table, line: n, cells, evidence });
    }
  }
  return out;
}

// The sections of a fact sheet that a part seat gets whole. A store row names the store in a
// form that the code of a part may not spell, as a constant, so a cut could drop a row that the
// part needs. A route rule applies to every route of the repository.
const WHOLE_FACT_TABLES = new Set(['stores', 'routes']);

/** The names a property or helper row of a fact sheet can be found by in the text of a file. */
function factNames(row) {
  if (row.table === 'properties') {
    const property = row.cells.Property.replace(/[{}]/g, '');
    const last = property.split(/[.:]/).pop();
    return [...new Set([property, last].filter((name) => name.length >= 3))];
  }
  return [...new Set(row.cells.Helper.match(/[A-Za-z_][A-Za-z0-9_]{3,}/g) || [])];
}

/**
 * The fact sheet that one part seat gets: the stores and routes whole, and each property and
 * helper row that the part can use. A row is kept when one of its pointers names a file of the
 * part, or when the text of a file of the part holds one of its names (factNames). `texts` maps
 * each path of the part to its text. Returns { text, kept, total }, where `kept` and `total`
 * count property and helper rows. A section left with no row is "None found.".
 */
export function factsFor(sheetText, texts) {
  const sheet = parseFacts('facts.md', sheetText);
  if (sheet.findings.length) throw new Error(`the fact sheet has ${sheet.findings.length} finding(s): ${sheet.findings[0]}`);
  const paths = new Set(texts.keys());
  const bodies = [...texts.values()];
  const drop = new Set();
  let total = 0;
  let kept = 0;
  for (const row of sheet.rows) {
    if (WHOLE_FACT_TABLES.has(row.table)) continue;
    total += 1;
    const used = row.evidence.some((p) => paths.has(p.path)) || factNames(row).some((name) => bodies.some((body) => body.includes(name)));
    if (used) kept += 1;
    else drop.add(row.line);
  }
  const lines = String(sheetText).split(/\r?\n/);
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    const n = i + 1;
    if (drop.has(n)) continue;
    out.push(lines[i]);
  }
  // A table whose rows were all dropped keeps only its header and its separator. Write "None found." instead.
  const text = out.join('\n').replace(/^(\|[^\n]*\|)\n(\|(?:\s*:?-+:?\s*\|)+)(?=\n\s*(?:\n|## |$))/gm, NONE_FOUND);
  const back = parseFacts('facts.md', text);
  if (back.findings.length) throw new Error(`the cut fact sheet does not parse: ${back.findings[0]}`);
  return { text, kept, total };
}

// A key as prose writes it: not glued to a word before it, and ending at a
// space or punctuation. Trailing dots and colons are the sentence's.
const KEY_IN_TEXT = /(?<![A-Za-z0-9_])((?:http|event|queue|job|store|lib):[^\s;,()`'"]+)/g;

/**
 * The well-formed keys written in a piece of text. An http key can be the key of any row,
 * so it takes the case of a call to external:<host>. `legacy` reads http keys in the grammar
 * before template v6, so a survey on v4 or v5 finds no more keys than it did when it was written.
 */
export function keysIn(text, { legacy = false } = {}) {
  const out = [];
  for (const m of String(text).matchAll(KEY_IN_TEXT)) {
    const key = m[1].replace(/[.:]+$/, '');
    const kind = keyKind(key);
    const pattern = kind === 'http' ? (legacy ? LEGACY_HTTP_KEY : EXTERNAL_HTTP_KEY) : KEYS[kind];
    if (pattern && key.search(pattern) === 0) out.push(key);
  }
  return out;
}

const WHOLE_NUMBER = /^(?:0|[1-9]\d*)$/;

// The order notReadRows gives: folder in code-unit order, then the rule's place in EXCLUDE_RULES.
const notReadOrder = (a, b) => {
  if (a.folder !== b.folder) return a.folder < b.folder ? -1 : 1;
  return EXCLUDE_RULES.indexOf(a.rule) - EXCLUDE_RULES.indexOf(b.rule);
};

function readNotRead(content, out, at) {
  const where = `"## ${NOT_READ.title}"`;
  const seen = new Set();
  let previous = null;
  for (const { n, cell } of tableRows(NOT_READ, content, NONE_FOUND, 'the survey left no file out', at)) {
    const row = { line: n, rule: cell.Rule, folder: cell.Folder, files: NaN, bytes: NaN };
    if (!EXCLUDE_RULES.includes(row.rule)) at(n, `rule "${row.rule}" is not one of ${EXCLUDE_RULES.join(', ')}`);
    if (!row.folder.endsWith('/') && row.folder !== './') at(n, `folder "${row.folder}": a folder ends in "/" or is "./"`);
    for (const [h, field] of [['Files', 'files'], ['Bytes', 'bytes']]) {
      if (cell[h].search(WHOLE_NUMBER) === 0) row[field] = Number(cell[h]);
      else at(n, `${h} "${cell[h]}" is not a whole number. Write digits only, with no separator`);
    }
    const id = `${row.folder}\0${row.rule}`;
    if (seen.has(id)) at(n, `folder "${row.folder}" with rule "${row.rule}" is in ${where} twice. One folder and one rule make one row`);
    else if (previous !== null && notReadOrder(row, previous) < 0) at(n, `${where} rows must sort by folder, then by rule. "${row.folder}" with rule "${row.rule}" comes before "${previous.folder}" with rule "${previous.rule}"`);
    seen.add(id);
    previous = row;
    out.notRead.push(row);
  }
}

function readOpenPoints(section, content, out, at) {
  const rows = tableRows(section, content, NO_OPEN_POINTS, 'there is nothing open', at);
  for (const { n, cell } of rows) {
    const label = `open point "${cell.Unresolved}"`;
    for (const h of ['Unresolved', 'Owner', 'Resolves']) {
      if (isPlaceholder(cell[h])) at(n, `an open point's ${h} cell is a placeholder; write what is open, the role that owns it, and what settles it`);
    }
    out.openPoints.push({ line: n, what: cell.Unresolved, owner: cell.Owner, resolves: cell.Resolves, evidence: readEvidence(label, cell.Evidence, n, out, at) });
  }
}

/**
 * The rows of a section's one table, each { n, cell } with cell keyed by the
 * header, or [] when the section is the single `empty` line or is malformed
 * (the finding is already recorded).
 */
function tableRows(section, content, empty, when, at) {
  const where = `"## ${section.title}"`;
  if (content.length === 1 && content[0].text === empty) return [];
  if (!content.length) {
    at(0, `${where} is empty; write "${empty}" when ${when}`);
    return [];
  }
  for (let i = 1; i < content.length; i += 1) {
    if (content[i].n !== content[i - 1].n + 1) {
      at(content[i].n, `${where} holds one table and nothing else; a blank line splits it in two`);
      return [];
    }
  }
  const cells = content.map((l) => ({ n: l.n, cells: splitRow(l.text) }));
  const notRow = cells.find((c) => c.cells === null);
  if (notRow) {
    at(notRow.n, `${where} holds one table, or the single line "${empty}"`);
    return [];
  }
  const [head, sep, ...rows] = cells;
  if (head.cells.join('|') !== section.header.join('|')) {
    at(head.n, `${where} header must be | ${section.header.join(' | ')} |`);
    return [];
  }
  if (!sep || !isSeparator(sep.cells) || sep.cells.length !== section.header.length) {
    at(sep?.n ?? head.n, `${where} needs its separator row under the header`);
    return [];
  }
  if (!rows.length) {
    at(sep.n, `${where} has a header and no rows; write "${empty}" instead of an empty table`);
    return [];
  }
  const out = [];
  for (const r of rows) {
    if (r.cells.length !== section.header.length) at(r.n, `${where} row has ${r.cells.length} cells; the header has ${section.header.length}`);
    else out.push({ n: r.n, cell: Object.fromEntries(section.header.map((h, i) => [h, r.cells[i]])) });
  }
  return out;
}

/** The pointers of one Evidence cell, each checked for form only. */
function readEvidence(label, text, n, out, at) {
  const pieces = text.trim() === '' ? [] : text.split(',').map((s) => unwrap(s.trim()));
  if (!pieces.length) at(n, `${label}: a row without evidence is not a row; point at the lines it rests on`);
  const evidence = [];
  for (const p of pieces) {
    const m = p.match(POINTER);
    if (!m) {
      at(n, `${label}: "${p}" is not a pointer <ID>@<12-hex>:<path> L<a>-<b>`);
      continue;
    }
    const [, id, pin, file, a, b] = m;
    const pointer = { id, pin, path: file, from: Number(a), to: Number(b), text: p };
    if (out.repository !== null && id !== out.repository) at(n, `"${p}" points into ${id}; a survey points only into the repository it surveys, ${out.repository}`);
    if (out.commit !== null && pin !== out.commit.slice(0, 12)) at(n, `"${p}" is pinned at ${pin}; every pointer is pinned at the survey's commit, ${out.commit.slice(0, 12)}`);
    if (pointer.from < 1 || pointer.from > pointer.to) at(n, `"${p}": the line range must start at 1 or later and not run backwards`);
    evidence.push(pointer);
  }
  return evidence;
}

// The http grammar, as the finding for a malformed http key states it.
const HTTP_GRAMMAR = `method in capitals; each segment holds literal text and {snake_case} parameters, never two parameters side by side; a :verb only at the end of the last segment; the path in lower case, except on a call to ${EXTERNAL}:<host>, where it keeps the case of the host's API; no trailing slash, no host or query`;

// A call whose whole path is one parameter. In the graph it matches every one-segment path. A
// seat wrote it for a call whose whole address is one property with no value in the repository.
const WHOLE_PATH_PARAMETER = new RegExp(`^http:${METHOD}:/${PARAMETER}$`);
// A first segment that is a host name: two dots or more, and a last label of letters that is not
// the extension of a file. The host belongs in the Provider cell.
const HOST_SEGMENT = /^http:[A-Z]+:\/((?:[A-Za-z0-9-]+\.){2,}([A-Za-z]{2,}))(?:\/|$)/;
const FILE_LABELS = ['js', 'css', 'map', 'php', 'html', 'htm', 'json', 'xml', 'txt', 'aspx', 'asp', 'jsp', 'cgi', 'pl', 'py'];

/** The findings of the path of an http call that no caller can send: one parameter only, or a host. */
function callPathFindings(key) {
  const found = [];
  if (key.search(WHOLE_PATH_PARAMETER) === 0) found.push(`"${key}": a call whose whole path is one parameter matches every one-segment path; where one property holds the whole address, write one open point that names the property, and no row`);
  const host = key.match(HOST_SEGMENT);
  if (host && !FILE_LABELS.includes(host[2].toLowerCase())) found.push(`"${key}": the first segment "${host[1]}" is a host; name it in Provider as ${EXTERNAL}:<host> or the listed repository, and keep only the path in the key`);
  return found;
}

// The pattern of a row's key. Only a call to external:<host> keeps upper case in an http path.
const keyPattern = (section, kind, cell) => (kind === 'http' && section.table === 'calls' && externalHost(cell.Provider) !== null ? EXTERNAL_HTTP_KEY : KEYS[kind]);

function readTable(section, content, out, at, part) {
  const where = `"## ${section.title}"`;
  let previous = null;
  const seen = new Set();
  for (const { n, cell } of tableRows(section, content, NONE_FOUND, 'the repository has none', at)) {
    const key = unwrap(cell.Key);
    const row = { table: section.table, key, line: n, evidence: [] };
    const kind = keyKind(key);
    if (!KEYS[kind]) at(n, `"${key}" is not a key: a key opens with ${Object.keys(KEYS).map((k) => `${k}:`).join(', ')}`);
    else if (!section.kinds.includes(kind)) at(n, `"${key}" is a ${kind} key; ${where} takes ${section.kinds.join(', ')} keys`);
    else if (key.search(keyPattern(section, kind, cell)) < 0 || key.search(/\/\.\.?(?:[/:]|$)/) >= 0) at(n, `"${key}" is not a well-formed ${kind} key${kind === 'http' ? `: ${HTTP_GRAMMAR}` : ''}`);
    if (seen.has(key)) at(n, `"${key}" appears twice in ${where}; one key is one row, with every pointer in its Evidence cell`);
    // A part is not held to the order. Its rows carry keys, and the join sorts them.
    else if (!part && previous !== null && key < previous) at(n, `${where} rows must be sorted by key; "${key}" comes before "${previous}"`);
    seen.add(key);
    previous = key;

    for (const [h, v] of Object.entries(cell)) {
      if (h !== 'Evidence' && h !== 'Key' && isPlaceholder(v)) at(n, `"${key}": the ${h} cell is a placeholder`);
    }
    if (section.table === 'serves') row.what = cell.What;
    if (section.table === 'calls') {
      row.provider = cell.Provider;
      row.host = externalHost(cell.Provider);
      row.unknown = cell.Provider === UNKNOWN;
      if (cell.Provider === EXTERNAL) at(n, `"${key}": Provider "${EXTERNAL}" must name the host the call reaches: ${EXTERNAL}:<host>, for example ${EXTERNAL}:api.example.com`);
      else if (cell.Provider.startsWith(`${UNKNOWN}:`)) at(n, `"${key}": Provider "${UNKNOWN}" stands alone; where the code names the host, write ${EXTERNAL}:<host> or the listed repository`);
      else if (row.host === null && !row.unknown && (cell.Provider.startsWith(`${EXTERNAL}:`) || !REPO_ID.test(cell.Provider))) at(n, `"${key}": Provider must be a listed repository id, ${EXTERNAL}:<host> with the host in lower case and no scheme, port or path, or ${UNKNOWN} where the code names neither`);
      else if (out.repository !== null && cell.Provider === out.repository) at(n, `"${key}": a repository does not call itself; its own ${kind} belongs under Serves`);
      // Only a part is held to the rule, so a survey joined before the rule still passes the check.
      if (part && kind === 'http' && STATIC_FILE_EXT.some((ext) => key.endsWith(ext))) at(n, `"${key}": a page's load of a static file is not a call; leave the row out of the survey`);
      // Template v6 is the first to hold the rule, so a survey on an older template still passes.
      if (kind === 'http' && (part || out.template === CURRENT_TEMPLATE)) for (const finding of callPathFindings(key)) at(n, finding);
    }
    if (section.table === 'stores') {
      row.access = cell.Access;
      row.objects = cell.Objects.split(',').map((s) => s.trim()).filter(Boolean);
      if (!ACCESS.includes(cell.Access)) at(n, `"${key}": Access is one of ${ACCESS.join(', ')}`);
      if (!row.objects.length) at(n, `"${key}": Objects names the tables, collections or prefixes this repository touches`);
    }
    if (section.table === 'libraries' || section.table === 'third_party') row.version = cell.Version;

    row.evidence = readEvidence(`"${key}"`, cell.Evidence, n, out, at);
    out.rows.push(row);
  }
}

// A cell holds a "|" only escaped, the way splitRow reads it back.
const cellText = (value) => String(value).replace(/\|/g, '\\|');
const evidenceText = (evidence) => evidence.map((p) => p.text).join(', ');

/** The cells of one row of a section, in the order of its header. */
function rowCells(table, row) {
  const value = {
    serves: () => [row.what],
    calls: () => [row.provider],
    stores: () => [row.access, row.objects.join(', ')],
    libraries: () => [row.version],
    third_party: () => [row.version],
  }[table];
  return [row.key, ...value(), evidenceText(row.evidence)];
}

function tableText(header, rows, empty) {
  if (!rows.length) return empty;
  return [
    `| ${header.join(' | ')} |`,
    `|${header.map(() => '---').join('|')}|`,
    ...rows.map((cells) => `| ${cells.map(cellText).join(' | ')} |`),
  ].join('\n');
}

/**
 * Write a survey, or a partial survey when `part` is given, from rows and open
 * points in the shape parseSurvey gives. The template is always
 * CURRENT_TEMPLATE. A survey ends with "## 7. Not read" from `notRead`, rows in the shape
 * notReadRows gives. A part never has the section. Each section's rows are sorted by key, in code-unit order.
 * The open points keep the order given. parseSurvey of the result gives no
 * finding when the rows and open points are well formed, and the same rows
 * render to the same bytes.
 */
export function renderSurvey({ repository, commit, part, rows, openPoints, notRead = [] }) {
  const isPart = part !== undefined && part !== null;
  const front = ['---', `kind: ${isPart ? PART_KIND : SURVEY_KIND}`, `repository: ${repository}`, `commit: ${commit}`, `template: ${CURRENT_TEMPLATE}`];
  if (isPart) front.push(`part: ${part}`);
  front.push('---');
  const out = [front.join('\n'), `# Service survey: ${repository}`, DISCLAIMER];
  for (const section of SECTIONS) {
    let body;
    if (section.open) {
      body = tableText(section.header, openPoints.map((p) => [p.what, p.owner, p.resolves, evidenceText(p.evidence)]), NO_OPEN_POINTS);
    } else {
      const mine = rows.filter((r) => r.table === section.table).sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
      body = tableText(section.header, mine.map((r) => rowCells(section.table, r)), NONE_FOUND);
    }
    out.push(`## ${section.title}`, body);
  }
  if (!isPart) {
    const cells = notRead.map((r) => [r.rule, r.folder, String(r.files), String(r.bytes)]);
    out.push(`## ${NOT_READ.title}`, tableText(NOT_READ.header, cells, NONE_FOUND));
  }
  return `${out.join('\n\n')}\n`;
}

/**
 * Every file under SURVEY_DIR at a revision of the hub, read out of git and
 * never off the working tree, so a check judges what a pull request carries.
 * Returns { surveys: [{ path, text }], stray: [path] }: a file that is not a
 * flat `.md` is stray, because the folder holds surveys and nothing else.
 */
export function readSurveysAt(rev, root = '.') {
  let listing;
  try {
    listing = git(['-C', root, 'ls-tree', '-r', rev, '--', `${SURVEY_DIR}/`]);
  } catch (err) {
    throw new SpokeError(EXIT.CANNOT_VERIFY, `cannot list ${SURVEY_DIR} at ${rev}: ${String(err.stderr || err.message).trim()}`, 'git-failed');
  }
  const entries = listing.split('\n').filter(Boolean).map((l) => {
    const m = l.match(/^\d+ (\w+) ([0-9a-f]+)\t(.+)$/);
    if (!m) throw new SpokeError(EXIT.INTERNAL, `ls-tree printed a line this reader does not understand: ${JSON.stringify(l)}`);
    return { type: m[1], sha: m[2], path: m[3] };
  });
  const flat = new RegExp(`^${SURVEY_DIR.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/[^/]+\\.md$`);
  const stray = entries.filter((e) => e.type !== 'blob' || !flat.test(e.path)).map((e) => e.path);
  const wanted = entries.filter((e) => e.type === 'blob' && flat.test(e.path));
  const gitDir = git(['-C', root, 'rev-parse', '--absolute-git-dir']).trim();
  const blobs = catBlobs(gitDir, wanted.map((e) => e.sha));
  const surveys = wanted.map((e) => ({ path: e.path, text: blobs.get(e.sha).toString('utf8') }));
  return { surveys, stray };
}

/** The repository id a survey file's name says it is. */
export const idFromPath = (path) => path.slice(SURVEY_DIR.length + 1).replace(/\.md$/, '');

/**
 * The surveys on disk under `root`, for a reader standing in a hub checkout:
 * the same { surveys, stray } readSurveysAt returns from git.
 */
export function readSurveysLocal(root = '.') {
  const dir = join(root, SURVEY_DIR);
  if (!existsSync(dir)) return { surveys: [], stray: [] };
  const surveys = [];
  const stray = [];
  for (const name of readdirSync(dir).sort()) {
    const path = `${SURVEY_DIR}/${name}`;
    if (!name.endsWith('.md') || !statSync(join(dir, name)).isFile()) stray.push(path);
    else surveys.push({ path, text: readFileSync(join(dir, name), 'utf8') });
  }
  return { surveys, stray };
}

/** The form two keys are compared in: every {parameter} of a web path written {}. */
export function normaliseKey(key) {
  return keyKind(key) === 'http' ? key.replace(/\{[^}]*\}/g, '{}') : key;
}

/** True for an event, queue or store key whose name is only a configuration placeholder, `{...}`. */
export function isPlaceholderName(key) {
  const kind = keyKind(key);
  if (kind === 'store') return key.split(':').slice(2).join(':').startsWith('{');
  return (kind === 'event' || kind === 'queue') && key.slice(key.indexOf(':') + 1).startsWith('{');
}

const httpParts = (key) => {
  const m = key.match(/^http:([A-Z]+):(.*)$/);
  return m ? { method: m[1], path: normaliseKey(`http:x:${m[2]}`) } : null;
};

/**
 * Whether two keys name the same thing. Two http keys match when their normal
 * paths are equal and the methods are equal or either is ANY. Any other two keys
 * match when normaliseKey gives one string. A placeholder matches only itself.
 */
export function keysMatch(a, b) {
  const x = httpParts(a);
  const y = httpParts(b);
  if (x && y) return x.path === y.path && (x.method === y.method || x.method === 'ANY' || y.method === 'ANY');
  return normaliseKey(a) === normaliseKey(b);
}

/**
 * The http calls of one set of rows that go to the same rows' Serves: each
 * Calls row with the provider `unknown` whose key matches a Serves key, as
 * { row, serve }, in row order. The host of an unknown call is unknown, so
 * the method and the path decide, as keysMatch matches them in the graph.
 * Without this check, the row is a false edge to every other repository that
 * serves the key.
 *
 * Only join-survey.mjs calls it. parseSurvey does not, so a survey committed
 * before the rule still passes check-survey.mjs. An event or a queue can have
 * publishers or consumers in other repositories, so only http keys count.
 */
export function selfCalls(rows) {
  const serves = rows.filter((r) => r.table === 'serves' && keyKind(r.key) === 'http');
  const out = [];
  for (const row of rows) {
    if (row.table !== 'calls' || row.provider !== UNKNOWN || keyKind(row.key) !== 'http') continue;
    const serve = serves.find((s) => keysMatch(s.key, row.key));
    if (serve) out.push({ row, serve });
  }
  return out;
}

/** The finding for one result of selfCalls. */
export function selfCallFinding({ row, serve }) {
  return `"${row.key}": this repository serves this key under "## 1. Serves" as "${serve.key}". A call to it is a call to itself. Leave the row out of the survey, or name the provider where the code names another host or repository`;
}

/** The sorted repositories of every serves entry whose key matches the key. */
export function servedBy(serves, key) {
  return sortedUnique(Object.entries(serves).filter(([k]) => keysMatch(k, key)).flatMap(([, ids]) => ids));
}

const sortedUnique = (xs) => [...new Set(xs)].sort();
const byKeys = (obj) => Object.fromEntries(Object.keys(obj).sort().map((k) => [k, obj[k]]));

/**
 * The graph of a set of well-formed surveys (parseSurvey results with no
 * findings). Deterministic: every object's keys and every list are sorted, so
 * two runs over the same surveys print the same bytes.
 *
 *   surveys          id -> the commit its survey was read at
 *   serves           normal key -> the repositories that serve it
 *   consumers        normal key -> [{ repository, provider, key }] from Calls
 *                    to a listed repository. A call to a third party is not a
 *                    consumer of anything the estate serves, whatever its key
 *   unknown_provider normal key -> [{ repository, key }] from Calls whose
 *                    provider is `unknown`: each may reach whoever serves the
 *                    key, or a third party, and only the code can say which
 *   external         host -> [{ repository, key }] from Calls to external:<host>
 *   stores           store key -> { read: [ids], write: [ids] }
 *   shared_stores    store keys more than one repository touches
 *   libraries        lib key -> the repositories that use it, shared inside
 *                    the estate
 *   shared_libraries lib keys more than one repository uses
 *   third_party_libraries  lib key -> the repositories that use it, a third
 *                    party's
 *   placeholder_names  event|queue|store -> [{ repository, table, key }] for
 *                    every serve, call or store whose key is a {placeholder}
 *                    name. Such a row is in no other map, and is never
 *                    unmatched. Two stores with one property name are not
 *                    one store, so a placeholder store is never shared
 *   unmatched_calls  [{ repository, key, provider, reason }] for every call to a
 *                    listed repository that the provider's survey does not
 *                    serve, or whose provider has no survey. External and
 *                    unknown calls are never unmatched: they name no
 *                    repository to match.
 */
export function buildGraph(parsed) {
  const surveys = {};
  const serves = {};
  const consumers = {};
  const external = {};
  const unknown = {};
  const stores = {};
  const libraries = {};
  const thirdParty = {};
  const placeholders = { event: [], queue: [], store: [] };
  for (const s of parsed) {
    surveys[s.repository] = s.commit;
    for (const r of s.rows) {
      if (isPlaceholderName(r.key)) {
        if (r.table === 'serves' || r.table === 'calls' || r.table === 'stores') (placeholders[keyKind(r.key)] ??= []).push({ repository: s.repository, table: r.table, key: r.key });
        continue;
      }
      const k = normaliseKey(r.key);
      if (r.table === 'serves') (serves[k] ??= []).push(s.repository);
      if (r.table === 'calls' && r.host !== null) (external[r.host] ??= []).push({ repository: s.repository, key: r.key });
      else if (r.table === 'calls' && r.unknown) (unknown[k] ??= []).push({ repository: s.repository, key: r.key });
      else if (r.table === 'calls') (consumers[k] ??= []).push({ repository: s.repository, provider: r.provider, key: r.key });
      if (r.table === 'stores') {
        const e = (stores[r.key] ??= { read: [], write: [] });
        if (r.access !== 'write') e.read.push(s.repository);
        if (r.access !== 'read') e.write.push(s.repository);
      }
      if (r.table === 'libraries') (libraries[r.key] ??= []).push(s.repository);
      if (r.table === 'third_party') (thirdParty[r.key] ??= []).push(s.repository);
    }
  }
  const unmatched = [];
  for (const [k, list] of Object.entries(consumers)) {
    for (const c of list) {
      if (!Object.hasOwn(surveys, c.provider)) unmatched.push({ repository: c.repository, key: c.key, provider: c.provider, reason: 'provider not surveyed' });
      else if (!servedBy(serves, c.key).includes(c.provider)) unmatched.push({ repository: c.repository, key: c.key, provider: c.provider, reason: 'provider serves no such key' });
    }
  }
  for (const kind of Object.keys(placeholders)) placeholders[kind].sort((a, b) => (a.repository + a.key + a.table < b.repository + b.key + b.table ? -1 : 1));
  const cmp = (a, b) => (a.repository + a.key + a.provider < b.repository + b.key + b.provider ? -1 : 1);
  for (const k of Object.keys(serves)) serves[k] = sortedUnique(serves[k]);
  for (const k of Object.keys(consumers)) consumers[k].sort(cmp);
  const byRepositoryKey = (a, b) => (a.repository + a.key < b.repository + b.key ? -1 : 1);
  for (const h of Object.keys(external)) external[h].sort(byRepositoryKey);
  for (const k of Object.keys(unknown)) unknown[k].sort(byRepositoryKey);
  for (const k of Object.keys(stores)) stores[k] = { read: sortedUnique(stores[k].read), write: sortedUnique(stores[k].write) };
  for (const k of Object.keys(libraries)) libraries[k] = sortedUnique(libraries[k]);
  for (const k of Object.keys(thirdParty)) thirdParty[k] = sortedUnique(thirdParty[k]);
  return {
    surveys: byKeys(surveys),
    serves: byKeys(serves),
    consumers: byKeys(consumers),
    unknown_provider: byKeys(unknown),
    external: byKeys(external),
    stores: byKeys(stores),
    shared_stores: Object.keys(stores).filter((k) => new Set([...stores[k].read, ...stores[k].write]).size > 1).sort(),
    libraries: byKeys(libraries),
    shared_libraries: Object.keys(libraries).filter((k) => libraries[k].length > 1).sort(),
    third_party_libraries: byKeys(thirdParty),
    unmatched_calls: unmatched.sort(cmp),
    placeholder_names: placeholders,
  };
}

// Part of the harness asset library c6f3b4427d58f7c3 (see VERSION.json) · 2026-09-12
/**
 * spoke-remote.mjs — what the hub knows about a spoke, and how it reaches one.
 *
 * Shared by read-spoke.mjs and check-registry.mjs. Not a command: nothing here
 * is run by hand. It owns these things so the scripts cannot drift apart:
 *
 *   - the shape of the registry file, checked by hand against the same rules
 *     `governance/repository-registry.schema.json` publishes. The scripts use
 *     the Node standard library only, so the schema is the contract and this
 *     file is its reading; a fixture keeps the two in step;
 *   - the shape of the hub's link to the global context repository,
 *     `docs/estate/global.json`, against `governance/global.schema.json` in the
 *     same way. read-global.mjs and read-context.mjs read the global repository
 *     through the same cache, fetch and cat-file as a spoke, under the reserved
 *     id `global`;
 *   - the prefix of the keys this hub mints, from its ledger, this hub's
 *     origin, and where a sibling hub that a spoke's HUBS line names is found:
 *     read-hubs.mjs, report-global.mjs and scripts/upgrade.mjs ask the same
 *     questions, so they share one answer;
 *   - how the hub's own trunk is read: fetched by force and confirmed against
 *     the remote's default branch (syncTrunk), for check-fan-in.mjs and
 *     report-global.mjs;
 *   - the newest release of the global repository (newestRelease), for
 *     read-global.mjs and report-global.mjs;
 *   - how a spoke's trunk is found: the trunk rule. The registry entry's
 *     `trunk` names it: `default` is the branch the remote reports as its
 *     default (`git ls-remote --symref`), any other value is that branch. The
 *     branch must exist on the remote, and `TRUNK_FOR_HUB` in the commands file
 *     at its tip must name the same value. A tip with no commands file is the
 *     spoke install's own window: the agreement is pending, not refused;
 *   - where a spoke is asked from: the bare cache below, never the repository
 *     the caller stands in. A hub checkout on a CI runner carries the runner's
 *     own credential in its local git configuration for every address on the
 *     forge, and git sends that in preference to a token in the address, so a
 *     spoke asked from inside the hub is answered as the hub and a private one
 *     is "not found". Every command here that reaches a remote names the cache
 *     with `--git-dir`;
 *   - how a 12-character `--at` becomes one commit: in a second bare
 *     repository for each spoke, under `history/` beside the caches, that
 *     holds the trunk's commits and no file contents. The cache itself never
 *     gets a filter, so every other reader of it is unchanged.
 *   - how a spoke's content is fetched: a bare cache repository per spoke,
 *     fetched at depth 1 for the one commit wanted, so a read pins a commit
 *     without cloning a history -- and how a folder of files is read back out
 *     of it: one `git cat-file --batch` call for every blob wanted, so a spoke
 *     with a thousand documents costs the same five processes as one with two.
 *
 * Exit codes are the gate's, because the scripts that import this report them:
 *   0 pass · 1 verified and failed · 2 cannot verify · 3 usage · 4 internal.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

export const EXIT = { PASS: 0, FAIL: 1, CANNOT_VERIFY: 2, USAGE: 3, INTERNAL: 4 };

// The same pattern check-dev-ready.js applies to a design's `Repository:` line
// and to HARNESS_REPO. Three readers, one grammar.
export const REPO_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
export const COMMIT = /^[0-9a-f]{40}$/;
// The short commit a citation and a `Rules:` line hold. `--at` takes it too.
export const COMMIT_PREFIX = /^[0-9a-f]{12}$/;
// The name of the global context layer: the third place of a `Context:` entry,
// `<id>@<12-hex>:global:<path>`, the prefix of every global id (`global.ADR-012`),
// and the name of the global repository's bare cache beside the spokes'.
export const GLOBAL_ID = 'global';
// Ids no listed repository may take. A service survey's Provider cell uses
// `external` and `unknown` for what is not a listed repository (surveys.mjs), and
// a `Context:` entry uses `global` for the global layer. A repository listed
// under one would be ambiguous.
export const RESERVED_IDS = ['external', 'unknown', GLOBAL_ID];
export const REGISTRY_PATH = 'docs/estate/repositories.json';
// The hub's link to the global context repository: the URL and nothing else.
// A hub without the file has no global layer.
export const GLOBAL_PATH = 'docs/estate/global.json';
export const PURPOSE_MAX = 600;
// The hub's key ledger. Its `prefix` is the name every spoke's HUBS line gives
// this hub, and the name an exception's `hubs` gives it.
export const KEYS_PATH = 'docs/backlog/keys.json';
// The spoke's own name for its harness trunk, in its commands file, and the
// value that means "the remote's default branch". The registry's `trunk` field
// uses the same grammar, and the two must agree.
export const TRUNK_KEY = 'TRUNK_FOR_HUB';
export const TRUNK_DEFAULT = 'default';

// Where the registry is. The hub's own path unless the caller says otherwise;
// the environment variable exists so a fixture can point at a throwaway file.
export function registryPath(explicit) {
  return explicit || process.env.HARNESS_REGISTRY || REGISTRY_PATH;
}

/**
 * Why a check cannot verify, as one token. A script prints the token as `REASON: <token>`, after
 * the sentence for the person and just before its `HARNESS EXIT:` line. The observability collector keeps only
 * the token, so the sentence, with its URLs, paths and branches, never leaves the laptop.
 * check-dev-ready.js keeps its own copy of the tokens it uses, because it imports nothing.
 */
export const REASONS = Object.freeze([
  // git and the remotes
  'remote-unreachable', 'auth-failed', 'fetch-failed', 'no-remote', 'no-default-branch', 'git-failed',
  'not-a-checkout', 'shallow-clone', 'uncommitted-changes', 'commit-not-found', 'commit-ambiguous',
  // the trunk
  'trunk-mismatch', 'trunk-missing', 'trunk-undeclared', 'trunk-moved',
  // the hub's own files and install
  'registry-missing', 'registry-invalid', 'plan-invalid', 'not-registered', 'config-invalid', 'file-unreadable', 'script-missing',
  'global-missing', 'tracker-missing',
  // GitHub, the escalation record and the tracker
  'gh-unavailable', 'gh-failed', 'gh-repo-unknown', 'record-unreadable', 'write-conflict', 'upstream-unreadable',
  'credential-missing', 'tracker-unreachable', 'tracker-failed',
  // a command that checks.env names
  'tool-missing', 'command-stopped', 'coverage-unreadable',
  // the protected-test guard of /dev-sprint
  'guard-state-invalid', 'guard-locked', 'guard-fault', 'preflight-missing',
  // the observability platform
  'platform-unreachable',
  // the wiki the context sync reads (confluence.mjs)
  'wiki-unreachable', 'wiki-failed',
  // Docker
  'docker-not-installed', 'docker-not-running', 'image-missing', 'pull-failed',
]);

/**
 * A failure the caller reports with a known exit code, not a stack trace. `reason` is a token of
 * REASONS, or null when the failure has none. A token that is not on the list becomes null.
 */
export class SpokeError extends Error {
  constructor(exit, message, reason = null) {
    super(message);
    this.exit = exit;
    this.reason = REASONS.includes(reason) ? reason : null;
  }
}

/**
 * The line that names why a script cannot verify: `REASON: <token>`, with a newline. The script's
 * exit handler writes its `HARNESS EXIT:` line after it.
 * Empty for a reason that is null or not on REASONS, so a script can print it in every case.
 */
export const reasonLine = (reason) => (REASONS.includes(reason) ? `REASON: ${reason}\n` : '');

/**
 * The token of the last `REASON: <token>` line in a script's output, or null. Only a token on
 * REASONS counts. A check that runs another check passes the other's reason up this way, and the
 * observability collector reads a script's reason this way.
 */
export function reasonIn(text) {
  if (typeof text !== 'string') return null;
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const m = lines[i].match(/^REASON: (\S+)\s*$/);
    if (m) return REASONS.includes(m[1]) ? m[1] : null;
  }
  return null;
}

export function git(args, opts = {}) {
  return execFileSync('git', args, {
    encoding: opts.encoding === null ? undefined : 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...opts,
  });
}

/* ------------------------------------------------------------------ registry */

// Read and parse. A missing or unreadable registry is "cannot verify": there is
// nothing to check anything against, which is a different fact from "checked and
// wrong".
export function readRegistry(path) {
  if (!existsSync(path)) {
    throw new SpokeError(EXIT.CANNOT_VERIFY, `no registry at ${path}; run /add-repo to create it, or set HARNESS_REGISTRY`, 'registry-missing');
  }
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    throw new SpokeError(EXIT.CANNOT_VERIFY, `cannot read ${path}: ${err.message}`, 'file-unreadable');
  }
  return parseRegistry(text, path);
}

// The same parse, for registry text a caller read from git rather than a file.
export function parseRegistry(text, path = REGISTRY_PATH) {
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new SpokeError(EXIT.FAIL, `${path} is not JSON: ${err.message}`);
  }
}

// Angle brackets, or a token an author writes instead of a value. Kept short and
// aligned with the gate's list; a purpose is prose, so only whole-value tokens
// count.
const PLACEHOLDER = /^(?:[-–—]+|\?+|tbd|todo|n\/?a|na|none|nil|pending|placeholder|x+)$/i;
export function isPlaceholder(value) {
  const v = String(value).trim();
  if (v === '') return true;
  if (v.startsWith('<') && v.endsWith('>')) return true;
  // A template's fill-in token written `\<like this>`, so a markdown viewer shows
  // it, and left in place: in the whole value or a part of it.
  if (v.search(/\\<[^<>\n]*>/) !== -1) return true;
  return PLACEHOLDER.test(v.replace(/[.\s"'`]/g, ''));
}

// A URL that carries who you are is a credential in a committed file. Only the
// forms a URL parser recognises are checked; `git@host:owner/repo.git` names the
// ssh user, not a secret, and is left alone.
export function credentialInUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (!/^https?:$/.test(parsed.protocol)) return false;
  return parsed.username !== '' || parsed.password !== '';
}

const RELATIVE_PATH = /^(?!\/)(?!.*(^|\/)\.\.(\/|$)).+$/;

/**
 * Every structural rule the schema states, as a list of findings. Empty means
 * the file is well formed. The order is the order a reader fixes things in.
 */
export function validateRegistry(registry, path = REGISTRY_PATH) {
  const out = [];
  const at = (where) => `${path}: ${where}`;
  if (registry === null || typeof registry !== 'object' || Array.isArray(registry)) {
    return [at('the root must be an object with "schema_version" and "repositories"')];
  }
  const rootKeys = Object.keys(registry);
  for (const k of rootKeys) {
    if (k !== 'schema_version' && k !== 'repositories') out.push(at(`unknown root field "${k}"`));
  }
  if (registry.schema_version !== 1) out.push(at(`"schema_version" must be 1, got ${JSON.stringify(registry.schema_version)}`));
  const repos = registry.repositories;
  if (repos === null || typeof repos !== 'object' || Array.isArray(repos)) {
    out.push(at('"repositories" must be an object keyed by repository id'));
    return out;
  }
  for (const [id, entry] of Object.entries(repos)) {
    const here = (field) => at(`repositories["${id}"]${field ? `.${field}` : ''}`);
    if (!REPO_ID.test(id)) {
      out.push(`${here()} is not a repository id: expected the repository's bare name (letters, digits, ".", "_", "-")`);
    } else if (RESERVED_IDS.includes(id)) {
      out.push(`${here()} is a reserved id (${RESERVED_IDS.join(', ')}): a service survey uses "external" and "unknown" for a provider that is not a listed repository, and a Context: entry uses "global" for the global layer. List the repository under another id`);
    }
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      out.push(`${here()} must be an object`);
      continue;
    }
    for (const k of Object.keys(entry)) {
      if (!['url', 'checks', 'purpose', 'readAt', 'trunk'].includes(k)) out.push(`${here(k)} is not a field the schema knows`);
    }
    for (const k of ['url', 'checks', 'purpose', 'readAt', 'trunk']) {
      if (!(k in entry)) out.push(`${here(k)} is missing`);
    }
    if (typeof entry.url === 'string') {
      if (entry.url.trim() === '') out.push(`${here('url')} is empty`);
      else if (credentialInUrl(entry.url)) out.push(`${here('url')} carries a user name or password; a clone URL in a committed file is never a credential`);
    } else if ('url' in entry) out.push(`${here('url')} must be a string`);
    if (typeof entry.checks === 'string') {
      if (!RELATIVE_PATH.test(entry.checks)) out.push(`${here('checks')} must be a path relative to the repository root, with no leading "/" and no ".."`);
    } else if ('checks' in entry) out.push(`${here('checks')} must be a string`);
    if (typeof entry.purpose === 'string') {
      if (isPlaceholder(entry.purpose)) out.push(`${here('purpose')} is a placeholder; write what the repository does or do not list it`);
      else if (entry.purpose.length > PURPOSE_MAX) out.push(`${here('purpose')} is ${entry.purpose.length} characters; the cap is ${PURPOSE_MAX}. A purpose orients, it does not document`);
    } else if ('purpose' in entry) out.push(`${here('purpose')} must be a string`);
    if (typeof entry.readAt === 'string') {
      if (!COMMIT.test(entry.readAt)) out.push(`${here('readAt')} must be a full 40-character commit hash`);
    } else if ('readAt' in entry) out.push(`${here('readAt')} must be a string`);
    if (typeof entry.trunk === 'string') {
      if (!isTrunkName(entry.trunk)) out.push(`${here('trunk')} must be "${TRUNK_DEFAULT}" or a branch name git accepts, got ${JSON.stringify(entry.trunk)}`);
    } else if ('trunk' in entry) out.push(`${here('trunk')} must be a string`);
  }
  return out;
}

/* --------------------------------------------------------------- global link */

// Where the global link file is. The hub's own path unless the environment says
// otherwise, so a fixture can point at a throwaway file, as with the registry.
export function globalPath() {
  return process.env.HARNESS_GLOBAL || GLOBAL_PATH;
}

/**
 * The hub's global link, `{ url }`, or null when the hub has no link file and so
 * no global layer. A file that is there and unreadable is "cannot verify". A file
 * that is not JSON, or breaks a rule of `governance/global.schema.json`, is a
 * failure that names every rule it breaks.
 */
export function readGlobalLink(path = globalPath()) {
  if (!existsSync(path)) return null;
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    throw new SpokeError(EXIT.CANNOT_VERIFY, `cannot read ${path}: ${err.message}`, 'file-unreadable');
  }
  return parseGlobalLink(text, path);
}

/**
 * The link `{ url }` from the text of a link file, wherever the text was read:
 * the working tree for readGlobalLink, the hub's trunk for report-global.mjs.
 */
export function parseGlobalLink(text, path = GLOBAL_PATH) {
  let link;
  try {
    link = JSON.parse(text);
  } catch (err) {
    throw new SpokeError(EXIT.FAIL, `${path} is not JSON: ${err.message}`);
  }
  const problems = validateGlobalLink(link, path);
  if (problems.length) throw new SpokeError(EXIT.FAIL, `${path} is not well formed:\n  - ${problems.join('\n  - ')}`);
  return { url: link.url };
}

/**
 * Every rule the schema states, as a list of findings. Empty means the file is
 * well formed. The file names no branch, tag or commit: the trunk is asked of the
 * remote, and the version a piece of work reads is in that work's requirements.
 */
export function validateGlobalLink(link, path = GLOBAL_PATH) {
  const at = (where) => `${path}: ${where}`;
  if (link === null || typeof link !== 'object' || Array.isArray(link)) {
    return [at('the root must be an object with "schema_version" and "url"')];
  }
  const out = [];
  for (const k of Object.keys(link)) {
    if (k !== 'schema_version' && k !== 'url') out.push(at(`unknown root field "${k}". The file holds the URL only, and the version a feature reads is on its requirements document`));
  }
  if (link.schema_version !== 1) out.push(at(`"schema_version" must be 1, got ${JSON.stringify(link.schema_version)}`));
  if (!('url' in link)) out.push(at('"url" is missing'));
  else if (typeof link.url !== 'string') out.push(at('"url" must be a string'));
  else if (link.url.trim() === '') out.push(at('"url" is empty'));
  else if (credentialInUrl(link.url)) out.push(at('"url" carries a user name or password, and a clone URL in a committed file is never a credential'));
  return out;
}

/* ---------------------------------------------------------------- the hubs */

/**
 * The prefix of the keys this hub mints, from its ledger in the working tree,
 * or null when the hub has no ledger yet or the ledger names no prefix.
 */
export function readHubPrefix(path = KEYS_PATH) {
  if (!existsSync(path)) return null;
  try {
    return hubPrefixOf(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/** The prefix in the text of a key ledger, or null when the text names none. */
export function hubPrefixOf(text) {
  try {
    const prefix = JSON.parse(text).prefix;
    return typeof prefix === 'string' && prefix !== '' ? prefix : null;
  } catch {
    return null;
  }
}

/**
 * This hub's `origin` remote: `{ url, name }`, where `name` is its
 * `<owner>/<repo>`, the form a spoke's HUBS line names a hub in. Both are null
 * when the hub has no origin. A HUBS entry names this hub when its prefix is the
 * ledger's, or, for a hub with no ledger yet, when its `<owner>/<repo>` is this.
 */
export function hubOrigin() {
  try {
    const url = git(['remote', 'get-url', 'origin'], { env: quietGitEnv() }).trim();
    const m = url.match(/([^/:]+\/[^/]+?)(?:\.git)?\/?$/);
    return { url, name: m ? m[1] : null };
  } catch {
    return { url: null, name: null };
  }
}

/**
 * Where a hub that a spoke's HUBS line names as `<owner>/<repo>` is found: the
 * URL of this hub with its owner and repository replaced, or
 * HARNESS_HUB_BASE/<owner>/<repo>.git where the host lays its repositories out
 * otherwise. Null when this hub's URL has no `<owner>/<repo>` to replace.
 */
export function siblingUrl(url, name) {
  if (process.env.HARNESS_HUB_BASE) return `${process.env.HARNESS_HUB_BASE.replace(/\/+$/, '')}/${name}.git`;
  const m = String(url || '').match(/^(.*[/:])[^/:]+\/[^/]+?(\.git)?\/?$/);
  return m ? `${m[1]}${name}${m[2] || ''}` : null;
}

/**
 * The grammar of a trunk name, in the registry and in `TRUNK_FOR_HUB`: the word
 * `default`, or a name `git check-ref-format --branch` accepts as it is. The
 * output is compared with the input, because inside a repository git expands
 * `@{-1}` to a real branch. `UNRESOLVED` is refused: the installer always knows
 * the trunk, so an open decision is never a valid value here.
 */
export function isTrunkName(value) {
  if (typeof value !== 'string' || value === '') return false;
  if (value === TRUNK_DEFAULT) return true;
  if (value === '@' || value === 'UNRESOLVED' || value.startsWith('refs/')) return false;
  try {
    return git(['check-ref-format', '--branch', value], { cwd: tmpdir() }).trim() === value;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------- commands file */

/**
 * Flat KEY=value, one per line, `#` comments and blanks skipped, first wins.
 * The one reader of a spoke's commands file on the hub side. spoke-rules.mjs
 * exports it too, and every key the hub reads goes through it.
 */
export function parseChecksEnv(text) {
  const map = new Map();
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const m = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if (!m) continue;
    if (!map.has(m[1])) map.set(m[1], m[2].trim());
  }
  return map;
}

/* -------------------------------------------------------------------- remote */

// The remote's default branch: whatever the remote says HEAD points at, now.
// Unreachable, or a remote with no symbolic HEAD, is "cannot verify". `dir` is
// the git directory the question is asked from: a spoke's bare cache from
// cacheDir(), or, for the repository a caller stands in, that repository's own.
// The answer must never depend on the working directory. A reader of a spoke
// never calls this directly: it calls resolveSpokeTrunk, which applies the
// spoke's declared trunk first.
export function resolveDefaultBranch(url, dir) {
  if (!dir) throw new SpokeError(EXIT.INTERNAL, `resolveDefaultBranch(${url}) was not told which git directory to ask from`);
  let out;
  try {
    out = git(['--git-dir', dir, 'ls-remote', '--symref', url, 'HEAD'], { env: quietGitEnv() });
  } catch (err) {
    throw new SpokeError(EXIT.CANNOT_VERIFY, `cannot reach ${url}: ${firstLine(err.stderr) || err.message}`, 'remote-unreachable');
  }
  const ref = out.match(/^ref: refs\/heads\/(\S+)\tHEAD$/m);
  const head = out.match(/^([0-9a-f]{40})\tHEAD$/m);
  if (!ref || !head) {
    throw new SpokeError(EXIT.CANNOT_VERIFY, `${url} did not report a default branch; the gate and every command need one`, 'no-default-branch');
  }
  return { trunk: ref[1], head: head[1] };
}

/**
 * The hub's own trunk, as every check reads it: fetch the named branch from
 * `remote` by force, then confirm that the remote itself calls that branch its
 * default. `branch` is HARNESS_TRUNK or `main`. It names the trunk and does not
 * choose one, so a name the remote does not confirm is "cannot verify".
 * `refspecs` are fetched in the same call, so one run reads one state of the
 * remote. Returns { ref, head, url, dir }, where `dir` is the hub's own git
 * directory: the one place a question about the hub is asked from.
 */
export function syncTrunk(remote, branch, refspecs = []) {
  let url;
  try {
    url = git(['remote', 'get-url', remote]).trim();
  } catch {
    throw new SpokeError(EXIT.CANNOT_VERIFY, `this checkout has no remote called ${remote}; run from the hub checkout`, 'no-remote');
  }
  const dir = git(['rev-parse', '--absolute-git-dir']).trim();
  const ref = `${remote}/${branch}`;
  try {
    git(['fetch', '--no-tags', '--prune', '--force', remote, `+refs/heads/${branch}:refs/remotes/${ref}`, ...refspecs], { env: quietGitEnv() });
  } catch (err) {
    throw new SpokeError(EXIT.CANNOT_VERIFY, `could not fetch ${ref} (${firstLine(err.stderr) || err.message})`, 'fetch-failed');
  }
  let actual;
  try {
    ({ trunk: actual } = resolveDefaultBranch(url, dir));
  } catch (err) {
    if (!(err instanceof SpokeError)) throw err;
    throw new SpokeError(EXIT.CANNOT_VERIFY, `${remote} reports no default branch, so "${branch}" cannot be confirmed as the trunk (${err.message})`, 'no-default-branch');
  }
  if (actual !== branch) {
    throw new SpokeError(EXIT.CANNOT_VERIFY, `this check was pointed at "${branch}" but ${remote}'s default branch is "${actual}"; set HARNESS_TRUNK to the trunk's real name`, 'trunk-mismatch');
  }
  let head;
  try {
    head = git(['rev-parse', '--verify', `${ref}^{commit}`]).trim();
  } catch {
    throw new SpokeError(EXIT.CANNOT_VERIFY, `${ref} does not resolve to a commit after fetch`, 'fetch-failed');
  }
  return { ref, head, url, dir };
}

/**
 * The trunk rule, for every hub read of a spoke. `entry` is the spoke's
 * registry entry: its `trunk` names the branch, `default` the remote's default
 * branch. The branch must exist on the remote. It is force-fetched into the
 * cache, and `TRUNK_FOR_HUB` in the commands file at its tip must equal the
 * entry's `trunk`, or the read stops with exit 2 and names both values.
 *
 * Returns { trunk, head, state, declared }: `head` is the tip that was fetched
 * and read, `declared` is false for `default`, and `state` is `agreed`, or
 * `pending` where the tip has no commands file yet (the spoke install has not
 * merged). A caller that needs the commands file still stops on `pending`.
 */
export function resolveSpokeTrunk(entry, dir) {
  if (!dir) throw new SpokeError(EXIT.INTERNAL, `resolveSpokeTrunk(${entry && entry.url}) was not told which git directory to ask from`);
  const named = entry.trunk;
  if (!isTrunkName(named)) {
    throw new SpokeError(EXIT.CANNOT_VERIFY, `the registry entry for ${entry.url} has trunk ${JSON.stringify(named)}; it must be "${TRUNK_DEFAULT}" or a branch name`, 'registry-invalid');
  }
  const declared = named !== TRUNK_DEFAULT;
  let trunk;
  if (declared) {
    let out;
    try {
      out = git(['--git-dir', dir, 'ls-remote', '--heads', entry.url, `refs/heads/${named}`], { env: quietGitEnv() });
    } catch (err) {
      throw new SpokeError(EXIT.CANNOT_VERIFY, `cannot reach ${entry.url}: ${firstLine(err.stderr) || err.message}`, 'remote-unreachable');
    }
    if (!out.split('\n').some((line) => line.endsWith(`\trefs/heads/${named}`))) {
      throw new SpokeError(EXIT.CANNOT_VERIFY, `the registry declares the trunk ${named}, and ${entry.url} has no branch ${named}. Create and protect it, or correct the registry`, 'trunk-missing');
    }
    trunk = named;
  } else {
    ({ trunk } = resolveDefaultBranch(entry.url, dir));
  }
  const head = fetchOne(dir, entry.url, trunk);
  const { checks } = entry;
  if (objectType(dir, head, checks) !== 'blob') return { trunk, head, state: 'pending', declared };
  const values = parseChecksEnv(git(['--git-dir', dir, 'cat-file', 'blob', `${head}:${checks}`]));
  const said = values.get(TRUNK_KEY);
  if (said === undefined || said === '') {
    throw new SpokeError(EXIT.CANNOT_VERIFY, `${checks} at ${trunk} (${short(head)}) has ${TRUNK_KEY} ${said === undefined ? 'missing' : 'empty'}; it must name the trunk the registry names, ${named}`, 'trunk-undeclared');
  }
  if (said !== named) {
    throw new SpokeError(EXIT.CANNOT_VERIFY, `the registry names the trunk ${named}, and ${checks} at ${trunk} (${short(head)}) has ${TRUNK_KEY}=${said}. The two must agree`, 'trunk-mismatch');
  }
  return { trunk, head, state: 'agreed', declared };
}

// One bare repository per spoke, under a directory the caller may choose. The
// default is the system temp directory, so nothing lands inside the hub.
export function cacheDir(id) {
  const root = process.env.HARNESS_SPOKE_CACHE || join(tmpdir(), 'harness-spokes');
  const dir = join(root, `${id}.git`);
  // The cache holds nothing that a fetch cannot bring again. macOS removes files from the temp
  // directory that are older than three days, and the folder that remains is not a repository.
  // A folder that git does not open as a repository is removed and made again.
  if (existsSync(dir) && !isCacheRepository(dir)) rmSync(dir, { recursive: true, force: true });
  return initBare(dir);
}

/**
 * A bare repository at `dir`, made when it is absent. Two processes can start
 * at the same moment, and `git init` into one folder from both breaks. So git
 * makes the repository in a folder of this process's own, and a rename puts it
 * in place. When the rename finds the folder there, the other process won, and
 * its repository is used.
 */
function initBare(dir) {
  if (existsSync(dir)) return dir;
  const parent = dirname(dir);
  mkdirSync(parent, { recursive: true });
  const own = join(parent, `.${basename(dir)}.${process.pid}.${Date.now()}.tmp`);
  try {
    git(['init', '--bare', '--quiet', own]);
    renameSync(own, dir);
  } catch (err) {
    if (!existsSync(dir)) throw err;
  } finally {
    rmSync(own, { recursive: true, force: true });
  }
  return dir;
}

function isCacheRepository(dir) {
  try {
    git(['--git-dir', dir, 'rev-parse', '--git-dir']);
    return true;
  } catch {
    return false;
  }
}

/**
 * Every tag the remote lists, as `[{ name, commit }]`, with an annotated tag
 * peeled to the commit it names. Asked of the remote every time, never of the
 * cache, so a moved or deleted tag shows at once. Unreachable is "cannot verify".
 */
export function remoteTags(dir, url) {
  let out;
  try {
    out = git(['--git-dir', dir, 'ls-remote', '--tags', url], { env: quietGitEnv() });
  } catch (err) {
    throw new SpokeError(EXIT.CANNOT_VERIFY, `cannot list the tags of ${url}: ${firstLine(err.stderr) || err.message}`, 'remote-unreachable');
  }
  const direct = new Map();
  const peeled = new Map();
  for (const line of out.split('\n')) {
    const m = line.match(/^([0-9a-f]{40})\trefs\/tags\/(.+?)(\^\{\})?$/);
    if (!m) continue;
    (m[3] ? peeled : direct).set(m[2], m[1]);
  }
  return [...direct.keys()].sort().map((name) => ({ name, commit: peeled.get(name) || direct.get(name) }));
}

/* ------------------------------------------------------------------- --at */

/**
 * The usage problem with an `--at` value, or null when it is a full
 * 40-character commit or a 12-character prefix, in lower-case hex.
 */
export function atProblem(at) {
  if (typeof at === 'string' && (at.match(COMMIT) || at.match(COMMIT_PREFIX))) return null;
  return `--at must be a full 40-character commit hash or its first 12 characters, in lower-case hex, got "${at}"`;
}

/**
 * The commit a read pins for `--at`, in the spoke's cache `dir`. A full commit
 * takes the path it always took: the cache, else one fetch of that hash. A
 * prefix is first resolved to one full commit on the trunk by
 * resolveCommitPrefix, and then takes the same path.
 */
export function pinAt(id, entry, dir, at) {
  const commit = at.length === 40 ? at : resolveCommitPrefix(id, entry, at);
  // Not in the cache from an earlier read: ask the remote for that one commit.
  // Servers that refuse a bare hash make this exit 2, which is the honest
  // answer -- the read cannot be pinned to what was asked for. Reads of one
  // spoke run side by side, so the fetch writes no FETCH_HEAD, which another
  // read could overwrite, and a lock that another fetch holds is waited out.
  for (let attempt = 1; !hasCommit(dir, commit); attempt += 1) {
    try {
      git(['--git-dir', dir, 'fetch', '--quiet', '--depth', '1', '--no-tags', '--no-write-fetch-head', entry.url, commit], { env: quietGitEnv() });
    } catch (err) {
      if (attempt < LOCK_TRIES && lockFailed(err)) {
        pause(attempt);
        continue;
      }
      if (hasCommit(dir, commit)) break;
      throw new SpokeError(EXIT.CANNOT_VERIFY, `cannot fetch ${commit} from ${entry.url}: ${firstLine(err.stderr) || err.message}`, 'fetch-failed');
    }
    if (!hasCommit(dir, commit)) throw new SpokeError(EXIT.CANNOT_VERIFY, `asked ${entry.url} for ${commit}, and the cache does not hold it after the fetch`, 'fetch-failed');
  }
  return commit;
}

// A git command that fails because another git process holds a lock in the
// same repository. Parallel reads of one spoke meet this, and a short wait and
// a new try is the answer. The text is git's, never an argument's.
const LOCK_FAILURE = /could not lock config file|cannot lock ref|Unable to create '[^']*\.lock'|shallow file has changed since we read it/;
const LOCK_TRIES = 6;

function lockFailed(err) {
  return String((err && err.stderr) || '').search(LOCK_FAILURE) !== -1;
}

/** Wait 50 ms, then 100, 200 and so on, without a busy loop. */
function pause(attempt) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50 * 2 ** (attempt - 1));
}

/** Run one git command, and try it again while another process holds a lock it needs. */
function gitWithLockRetry(args, opts = {}) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return git(args, opts);
    } catch (err) {
      if (attempt >= LOCK_TRIES || !lockFailed(err)) throw err;
      pause(attempt);
    }
  }
}

/**
 * The bare repository that resolves prefixes for one spoke. It is a partial
 * clone with the remote named `origin`, so it is kept apart from the cache:
 * a filter in the cache would apply to every later fetch of every reader.
 */
export function historyDir(id) {
  const root = process.env.HARNESS_SPOKE_CACHE || join(tmpdir(), 'harness-spokes');
  return initBare(join(root, 'history', `${id}.git`));
}

/**
 * The one commit on the spoke's trunk whose hash starts with `prefix`. The
 * history repository is asked first. When it already holds exactly one such
 * commit on the trunk, nothing is fetched. Otherwise the trunk's commits are
 * fetched with `--filter=tree:0`, so no tree and no file comes with them, and
 * the history repository is asked again. A server that ignores the filter
 * sends everything, and the answer is the same. Git lists the objects that
 * start with the prefix, and only commits on the trunk count. No commit, or
 * more than one: exit 2, naming the prefix.
 */
export function resolveCommitPrefix(id, entry, prefix) {
  const dir = historyDir(id);
  const named = entry.trunk;
  if (!isTrunkName(named)) {
    throw new SpokeError(EXIT.CANNOT_VERIFY, `the registry entry for ${entry.url} has trunk ${JSON.stringify(named)}. It must be "${TRUNK_DEFAULT}" or a branch name`, 'registry-invalid');
  }
  const trunk = named === TRUNK_DEFAULT ? resolveDefaultBranch(entry.url, dir).trunk : named;
  // The registry entry's URL is the history repository's one remote. The
  // config is written only when it differs, because a write takes a lock that
  // a parallel read of the same spoke may hold.
  let onTrunk = sameUrl(dir, entry.url) ? commitsOnTrunk(dir, trunk, prefix) : [];
  if (onTrunk.length === 1) return onTrunk[0];
  try {
    if (!sameUrl(dir, entry.url)) gitWithLockRetry(['--git-dir', dir, 'config', 'remote.origin.url', entry.url]);
    gitWithLockRetry(['--git-dir', dir, '-c', 'gc.auto=0', '-c', 'maintenance.auto=false', 'fetch', '--quiet', '--no-tags', '--no-write-fetch-head', '--filter=tree:0', 'origin', `+refs/heads/${trunk}:refs/heads/${trunk}`], { env: quietGitEnv() });
  } catch (err) {
    throw new SpokeError(EXIT.CANNOT_VERIFY, `cannot fetch the commits of ${trunk} from ${entry.url} to resolve --at ${prefix}: ${firstLine(err.stderr) || err.message}`, 'fetch-failed');
  }
  onTrunk = commitsOnTrunk(dir, trunk, prefix);
  if (onTrunk.length === 1) return onTrunk[0];
  if (onTrunk.length === 0) {
    throw new SpokeError(EXIT.CANNOT_VERIFY, `--at ${prefix} matches no commit on ${trunk} of ${entry.url}`, 'commit-not-found');
  }
  throw new SpokeError(EXIT.CANNOT_VERIFY, `--at ${prefix} matches ${onTrunk.length} commits on ${trunk} of ${entry.url} (${onTrunk.join(', ')}). Pass the full 40-character commit`, 'commit-ambiguous');
}

/** True when the history repository's `origin` is this URL. */
function sameUrl(dir, url) {
  try {
    return git(['--git-dir', dir, 'config', '--get', 'remote.origin.url']).trim() === url;
  } catch {
    return false;
  }
}

/**
 * The commits in the history repository that start with `prefix` and are on
 * the local ref of `trunk`. Empty when the ref is not there yet. Only commits
 * on the trunk count: a commit off the trunk is not citable.
 */
function commitsOnTrunk(dir, trunk, prefix) {
  const ref = `refs/heads/${trunk}`;
  try {
    git(['--git-dir', dir, 'rev-parse', '--verify', '--quiet', ref]);
  } catch {
    return [];
  }
  const listed = git(['--git-dir', dir, 'rev-parse', '--disambiguate=' + prefix]).split('\n').filter(Boolean);
  const types = listed.length
    ? git(['--git-dir', dir, 'cat-file', '--batch-check'], { input: `${listed.join('\n')}\n`, stdio: ['pipe', 'pipe', 'pipe'] }).split('\n').filter(Boolean)
    : [];
  const commits = types.map((line) => line.split(' ')).filter(([, type]) => type === 'commit').map(([sha]) => sha);
  return commits.filter((sha) => isAncestor(dir, sha, ref));
}

/** True when the cache already holds this commit. */
export function hasCommit(dir, sha) {
  try {
    git(['--git-dir', dir, 'cat-file', '-e', `${sha}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Fetch one thing -- a branch name or a commit hash -- at depth 1 into the cache,
 * and return the commit it resolved to. A server that refuses to serve a bare
 * commit hash makes this throw; callers decide whether that is a failure or a
 * reason to fetch the branch in full.
 */
export function fetchOne(dir, url, want) {
  try {
    git(['--git-dir', dir, 'fetch', '--quiet', '--depth', '1', '--no-tags', url, want], { env: quietGitEnv() });
  } catch (err) {
    throw new SpokeError(EXIT.CANNOT_VERIFY, `cannot fetch ${want} from ${url}: ${firstLine(err.stderr) || err.message}`, 'fetch-failed');
  }
  return git(['--git-dir', dir, 'rev-parse', 'FETCH_HEAD']).trim();
}

/**
 * Fetch a branch with its whole history. The fallback when a hash cannot be
 * fetched, and the fetch a caller that asks about ancestry needs. The cache is
 * shared with the depth-1 readers, so it may be shallow when this is called; a
 * plain fetch never deepens past a shallow boundary, and `--is-ancestor` then
 * says no about a commit that is on the branch. `--unshallow` when the cache is
 * shallow, so "whole history" is true.
 */
export function fetchBranchFully(dir, url, branch) {
  try {
    const args = ['--git-dir', dir, 'fetch', '--quiet', '--no-tags'];
    if (existsSync(join(dir, 'shallow'))) args.push('--unshallow');
    git([...args, url, branch], { env: quietGitEnv() });
  } catch (err) {
    throw new SpokeError(EXIT.CANNOT_VERIFY, `cannot fetch ${branch} from ${url}: ${firstLine(err.stderr) || err.message}`, 'fetch-failed');
  }
  return git(['--git-dir', dir, 'rev-parse', 'FETCH_HEAD']).trim();
}

/**
 * Make sure the cache holds one commit: by hash first, then by fetching the
 * branch in full for a server that refuses bare hashes. False when the remote
 * does not know the commit at all -- a fact about the spoke, not an outage.
 */
export function ensureCommit(dir, url, trunk, sha) {
  if (hasCommit(dir, sha)) return true;
  try {
    if (fetchOne(dir, url, sha) === sha) return true;
  } catch {
    // fall through to the full fetch
  }
  try {
    fetchBranchFully(dir, url, trunk);
  } catch {
    return false;
  }
  return hasCommit(dir, sha);
}

/** True when `ancestor` is `descendant` or behind it. Both must be in the cache, with history. */
export function isAncestor(dir, ancestor, descendant) {
  try {
    git(['--git-dir', dir, 'merge-base', '--is-ancestor', ancestor, descendant]);
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------ the release */

// A release tag of the global repository, and nothing else: no pre-release, no
// build metadata, no prefix but `v`. The three numbers are compared as numbers.
// check-requirements.js carries its own copy (`releaseTag`), because it ships
// verbatim and imports nothing.
export const RELEASE_TAG = /^v(\d+)\.(\d+)\.(\d+)$/;

/** The three numbers of a release tag, or null when the tag is not one. */
export function releaseVersion(tag) {
  const m = String(tag).match(RELEASE_TAG);
  return m ? m.slice(1, 4).map(Number) : null;
}

/** Below zero when version `a` is lower than `b`, zero when equal, above zero when higher. */
export function compareVersions(a, b) {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

/**
 * The newest release on the trunk of the global repository that `link` names
 * (docs/proposals/global-context.md §6.1). It lists the remote's tags, keeps
 * only release tags, drops every tag whose commit is not on the trunk the
 * remote reports now, and takes the highest version. It asks the remote every
 * time and never falls back to a cache. Returns
 *   { lines, dir, link, trunk, head, release }
 * where `lines` are the lines read-global.mjs --resolve prints before its last,
 * `dir` is the bare cache that now holds the trunk's whole history, and
 * `release` is `{ name, commit, version }`, or null when the trunk carries no
 * release tag. Returns null when `link` is null: the hub has no global layer.
 */
export function newestRelease(link) {
  if (link === null) return null;
  const dir = cacheDir(GLOBAL_ID);
  const { trunk } = resolveDefaultBranch(link.url, dir);
  const tags = remoteTags(dir, link.url);
  // The trunk's whole history, so "on the trunk" is a fact about ancestry and not
  // about how deep an earlier read fetched.
  const head = fetchBranchFully(dir, link.url, trunk);

  const ignored = [];
  const releases = [];
  for (const tag of tags) {
    const version = releaseVersion(tag.name);
    if (version === null) {
      ignored.push(`${tag.name} (not a release tag)`);
    } else if (!hasCommit(dir, tag.commit) || !isAncestor(dir, tag.commit, head)) {
      ignored.push(`${tag.name} (its commit ${tag.commit.slice(0, 12)} is not on ${trunk})`);
    } else {
      releases.push({ ...tag, version });
    }
  }
  releases.sort((a, b) => compareVersions(b.version, a.version));

  const lines = [
    `Global repository: ${link.url}`,
    `Trunk: ${trunk} at ${head}`,
    `Release tags: ${releases.length ? `${releases.length} on the trunk: ${releases.map((r) => r.name).join(', ')}` : 'none on the trunk'}`,
  ];
  if (ignored.length) lines.push(`Ignored: ${ignored.join(', ')}`);
  return { lines, dir, link, trunk, head, release: releases[0] || null };
}

/** The object type at `commit:path` in the cache: 'blob', 'tree', or null when absent. */
export function objectType(dir, commit, path) {
  const spec = path === '' ? `${commit}^{tree}` : `${commit}:${path}`;
  try {
    return git(['--git-dir', dir, 'cat-file', '-t', spec]).trim();
  } catch {
    return null;
  }
}

/**
 * The bytes of many blobs in one `git cat-file --batch` call, as a Map from
 * hash to Buffer. The hashes come from an `ls-tree` a moment earlier, so one
 * that git reports missing is a cache that changed under us: internal, not a
 * fact about the spoke. Output is parsed by the byte length git announces, so
 * a body with multi-byte characters or a blank last line reads back whole.
 */
export function catBlobs(dir, shas) {
  const wanted = [...new Set(shas)];
  const out = new Map();
  if (!wanted.length) return out;
  const raw = git(['--git-dir', dir, 'cat-file', '--batch'], {
    input: `${wanted.join('\n')}\n`,
    encoding: null,
    maxBuffer: 256 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let at = 0;
  while (at < raw.length) {
    const nl = raw.indexOf(0x0a, at);
    if (nl === -1) break;
    const header = raw.subarray(at, nl).toString('utf8');
    at = nl + 1;
    const m = header.match(/^([0-9a-f]{40}) (\w+) (\d+)$/);
    if (!m) {
      const missing = header.match(/^([0-9a-f]{40}) missing$/);
      throw new SpokeError(EXIT.INTERNAL, missing
        ? `the cache at ${dir} no longer holds ${missing[1]}, which ls-tree listed a moment ago`
        : `cat-file --batch returned a line this reader does not understand: ${JSON.stringify(header)}`);
    }
    const size = Number(m[3]);
    out.set(m[1], Buffer.from(raw.subarray(at, at + size)));
    at += size + 1; // the newline git writes after every object
  }
  for (const sha of wanted) {
    if (!out.has(sha)) throw new SpokeError(EXIT.INTERNAL, `cat-file --batch returned nothing for ${sha}`);
  }
  return out;
}

/**
 * Many paths at one commit in one `git cat-file --batch` call, as a Map from
 * path to `{ type, bytes }`, or to null when the path is not at that commit.
 * Unlike catBlobs, a missing path is an answer here, not a broken cache: the
 * paths come from a document that claims they exist. A tree comes back with its
 * type and no bytes a caller should read as text.
 */
export function catAt(dir, commit, paths) {
  const wanted = [...new Set(paths)];
  const out = new Map();
  if (!wanted.length) return out;
  const raw = git(['--git-dir', dir, 'cat-file', '--batch'], {
    input: `${wanted.map((p) => `${commit}:${p}`).join('\n')}\n`,
    encoding: null,
    maxBuffer: 256 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let at = 0;
  let i = 0;
  while (at < raw.length && i < wanted.length) {
    const nl = raw.indexOf(0x0a, at);
    if (nl === -1) break;
    const header = raw.subarray(at, nl).toString('utf8');
    at = nl + 1;
    const path = wanted[i];
    i += 1;
    if (header.endsWith(' missing') || header.endsWith(' ambiguous')) {
      out.set(path, null);
      continue;
    }
    const m = header.match(/^[0-9a-f]{40} (\w+) (\d+)$/);
    if (!m) throw new SpokeError(EXIT.INTERNAL, `cat-file --batch returned a line this reader does not understand: ${JSON.stringify(header)}`);
    const size = Number(m[2]);
    out.set(path, { type: m[1], bytes: Buffer.from(raw.subarray(at, at + size)) });
    at += size + 1;
  }
  for (const p of wanted) {
    if (!out.has(p)) throw new SpokeError(EXIT.INTERNAL, `cat-file --batch returned nothing for ${commit}:${p}`);
  }
  return out;
}

// No prompts, ever. A read that would ask for a password must fail instead, so
// a seat cannot be walked into typing one.
export function quietGitEnv() {
  return { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'true', GCM_INTERACTIVE: 'never' };
}

/** The first non-blank line of a command's output, for a message. */
export function firstLine(text) {
  return String(text || '').split('\n').map((l) => l.trim()).find(Boolean) || '';
}

/** Twelve characters of a hash: enough to cite, short enough to read. */
export function short(sha) {
  return sha.slice(0, 12);
}

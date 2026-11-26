// Part of the harness asset library c6f3b4427d58f7c3 (see VERSION.json) · 2026-10-27
/**
 * spoke-trunk.mjs — the trunk rule for a spoke checkout: which branch is the trunk, and the
 * checks.env at its tip.
 *
 * check-staged.mjs and check-coverage.mjs import it. It installs into the hub as
 * scripts/spoke-trunk.mjs, beside them. secret-scan.cjs applies the same rule by hand, because a
 * spoke has no hub scripts to import, and spoke-remote.mjs applies it for every hub read of a
 * spoke. A fixture in each suite keeps the three in step (generation.md §3.2).
 *
 * The rule, given a name N:
 *   1. N is HARNESS_SPOKE_TRUNK where it is set. Otherwise N is TRUNK_FOR_HUB in checks.env at
 *      HEAD of the checkout, or in the checkout's own checks.env where HEAD has none (the spoke
 *      install's own first commit). story-gate always sets the variable from the base commit, so
 *      a pull request cannot use this path to judge itself.
 *   2. N is `default` or a branch name. `default` is the branch origin reports as its default.
 *   3. The branch must exist on origin. It is force-fetched, and checks.env is read at its tip.
 *   4. TRUNK_FOR_HUB at the tip must name the same branch as N. `default` and the name of the
 *      default branch name the same branch, so a caller may hand in either.
 *   5. A tip with no checks.env is the spoke install's own branch: the trunk is returned with no
 *      text, and the caller decides.
 *
 * Every refusal is exit 2, cannot verify: a trunk that cannot be found or does not agree is not a
 * verdict about the change. Node standard library only, plus git.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const SPOKE_TRUNK_VAR = 'HARNESS_SPOKE_TRUNK';
export const TRUNK_KEY = 'TRUNK_FOR_HUB';
export const TRUNK_DEFAULT = 'default';
const REMOTE = 'origin';
const CHECKS_ENV = 'checks.env';

/** A refusal of the trunk rule. `code` is always 2, so a caller can rethrow it as its own. */
export class SpokeTrunkError extends Error {
  constructor(message, reason = null) { super(message); this.code = 2; this.reason = reason; }
}

function git(root, args) {
  const res = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (res.error) throw new SpokeTrunkError(`git could not run: ${res.error.message}`, 'git-failed');
  return res;
}
const firstLine = (text) => String(text || '').trim().split('\n')[0];

/** The value of one key in a commands file's text, or undefined. Flat KEY=value, first wins. */
export function keyIn(text, key) {
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const m = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if (m && m[1] === key) return m[2].trim();
  }
  return undefined;
}

/** `default`, or a name git accepts as a branch, unchanged. `UNRESOLVED` is never a trunk. */
export function isTrunkName(root, value) {
  if (typeof value !== 'string' || value === '') return false;
  if (value === TRUNK_DEFAULT) return true;
  if (value === '@' || value === 'UNRESOLVED' || value.startsWith('refs/')) return false;
  const res = git(root, ['check-ref-format', '--branch', value]);
  return res.status === 0 && res.stdout.trim() === value;
}

/** The name to apply the rule to, and where it came from (step 1). */
function nameFor(root, named) {
  if (named !== undefined && named !== '') {
    if (!isTrunkName(root, named)) throw new SpokeTrunkError(`${SPOKE_TRUNK_VAR} is "${named}"; it must be "${TRUNK_DEFAULT}" or a branch name`, 'config-invalid');
    return { name: named, from: SPOKE_TRUNK_VAR };
  }
  const atHead = git(root, ['show', `HEAD:${CHECKS_ENV}`]);
  let text;
  let where;
  if (atHead.status === 0) {
    text = atHead.stdout;
    where = `${CHECKS_ENV} at HEAD`;
  } else if (existsSync(join(root, CHECKS_ENV))) {
    text = readFileSync(join(root, CHECKS_ENV), 'utf8');
    where = `this checkout's ${CHECKS_ENV} (HEAD has none: the spoke install's own branch)`;
  } else {
    throw new SpokeTrunkError(`${SPOKE_TRUNK_VAR} is not set and there is no ${CHECKS_ENV} at HEAD, so there is no ${TRUNK_KEY} to name the trunk`, 'config-invalid');
  }
  const value = keyIn(text, TRUNK_KEY);
  if (value === undefined || value === '') throw new SpokeTrunkError(`${TRUNK_KEY} is ${value === undefined ? 'missing' : 'empty'} in ${where}; it is required: "${TRUNK_DEFAULT}" or the harness trunk's branch name`, 'trunk-undeclared');
  if (!isTrunkName(root, value)) throw new SpokeTrunkError(`${TRUNK_KEY}=${value} in ${where} is not "${TRUNK_DEFAULT}" or a branch name`, 'config-invalid');
  return { name: value, from: `${TRUNK_KEY} in ${where}` };
}

/** The branch origin reports as its default. */
function defaultBranch(root) {
  const ls = git(root, ['ls-remote', '--symref', REMOTE, 'HEAD']);
  if (ls.status !== 0) throw new SpokeTrunkError(`could not reach ${REMOTE} (${firstLine(ls.stderr)}), so the trunk cannot be read`, 'remote-unreachable');
  const m = ls.stdout.match(/^ref:\s+refs\/heads\/(\S+)\s+HEAD/m);
  if (!m) throw new SpokeTrunkError(`${REMOTE} reports no default branch, so "${TRUNK_DEFAULT}" names no trunk`, 'no-default-branch');
  return m[1];
}

/** The branch a name stands for (step 2), confirmed on origin (step 3). */
function branchFor(root, name) {
  if (name === TRUNK_DEFAULT) return defaultBranch(root);
  const ls = git(root, ['ls-remote', '--heads', REMOTE, `refs/heads/${name}`]);
  if (ls.status !== 0) throw new SpokeTrunkError(`could not reach ${REMOTE} (${firstLine(ls.stderr)}), so the trunk cannot be read`, 'remote-unreachable');
  if (!ls.stdout.split('\n').some((l) => l.endsWith(`\trefs/heads/${name}`))) {
    throw new SpokeTrunkError(`the trunk is ${name}, and ${REMOTE} has no branch ${name}`, 'trunk-missing');
  }
  return name;
}

/**
 * Apply the rule in the checkout at `root`. `named` is HARNESS_SPOKE_TRUNK by default.
 * Returns { name, from, trunk, ref, commit, blob, text }: `name` is the name the rule was applied
 * to, `trunk` the branch, `ref` its remote-tracking ref after the force-fetch. `blob` and `text`
 * are null where the tip has no checks.env (step 5).
 */
export function spokeTrunk(root, named = process.env[SPOKE_TRUNK_VAR]) {
  const { name, from } = nameFor(root, named);
  const trunk = branchFor(root, name);
  const ref = `refs/remotes/${REMOTE}/${trunk}`;
  const fetched = git(root, ['fetch', '--quiet', '--no-tags', '--force', REMOTE, `+refs/heads/${trunk}:${ref}`]);
  if (fetched.status !== 0) throw new SpokeTrunkError(`could not fetch ${REMOTE}/${trunk} (${firstLine(fetched.stderr)})`, 'fetch-failed');
  const commit = git(root, ['rev-parse', '--verify', `${ref}^{commit}`]);
  if (commit.status !== 0) throw new SpokeTrunkError(`${REMOTE}/${trunk} does not resolve to a commit`, 'fetch-failed');
  const sha = commit.stdout.trim();
  const blob = git(root, ['rev-parse', '--verify', '--quiet', `${sha}:${CHECKS_ENV}`]);
  if (blob.status !== 0) return { name, from, trunk, ref, commit: sha, blob: null, text: null };
  const oid = blob.stdout.trim();
  const text = git(root, ['cat-file', 'blob', oid]);
  if (text.status !== 0) throw new SpokeTrunkError(`cannot read ${CHECKS_ENV} at ${REMOTE}/${trunk}`, 'git-failed');
  // Step 4. The tip's own value is resolved the same way, so `default` and its branch agree.
  const said = keyIn(text.stdout, TRUNK_KEY);
  if (said === undefined || said === '') {
    throw new SpokeTrunkError(`${CHECKS_ENV} at ${REMOTE}/${trunk} ${sha.slice(0, 12)} has ${TRUNK_KEY} ${said === undefined ? 'missing' : 'empty'}; it must name this trunk`, 'trunk-undeclared');
  }
  let agrees = said === name;
  if (!agrees && isTrunkName(root, said)) {
    try {
      agrees = branchFor(root, said) === trunk;
    } catch {
      agrees = false;
    }
  }
  if (!agrees) {
    throw new SpokeTrunkError(`the trunk is ${name} (from ${from}), and ${CHECKS_ENV} at ${REMOTE}/${trunk} ${sha.slice(0, 12)} has ${TRUNK_KEY}=${said}. The two must name the same branch`, 'trunk-mismatch');
  }
  return { name, from, trunk, ref, commit: sha, blob: oid, text: text.stdout };
}

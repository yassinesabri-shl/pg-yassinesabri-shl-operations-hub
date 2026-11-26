#!/usr/bin/env node
// Part of the harness asset library c6f3b4427d58f7c3 (see VERSION.json) · 2026-10-27
/**
 * story-gate-plan.mjs — decide what a spoke's story-gate job checks on one pull request.
 *
 *   usage:  node hub/scripts/story-gate-plan.mjs --repo . --hub hub --base <sha> --head <sha> \
 *             --base-ref <branch> --head-ref <branch> --repo-id <id> [--supports bug]
 *
 * `--supports` is the workflow's own declaration of the steps it has, a comma list of lower-case
 * words. Only `bug` is known: the workflow has the run_bug step. It is optional, so a workflow that
 * predates it runs unchanged.
 *
 * The story-gate workflow runs it from the hub clone and only reads its output, so the decision
 * is in a script that a fixture suite tests, not in workflow text. It assumes no CI system: the
 * workflow passes every fact as an argument.
 *
 * What it reads
 *   - checks.env at the base commit (`--base`), with `git show`, never from the checkout. A pull
 *     request that edits checks.env does not change how it is judged until a person merges it.
 *   - the hub registry, from the trunk of the hub's `origin` after a force-fetch, never from the
 *     hub checkout. It is parsed and checked with spoke-remote.mjs.
 *   - the spoke's `origin`, for its default branch and for the branches that exist.
 *
 * The order. The first step that applies decides.
 *   1. The base has no checks.env: not-harness.
 *   2. TRUNK_FOR_HUB or SYNC_BRANCH at the base is missing, empty or not valid, or HUBS at the
 *      base is missing, empty, UNRESOLVED or malformed: exit 2.
 *   3. The registry cross-check. The repository is not in the registry: exit 2. The base branch
 *      is the registry's `trunk` or TRUNK_FOR_HUB (each resolved through `default`), and the two
 *      values differ: exit 2. The trunk TRUNK_FOR_HUB names is missing on the remote: exit 2.
 *   4. The base branch is not the trunk: not-harness.
 *   5. The head branch names a work item (feature/<KEY>-...), and HUBS lists the key's prefix:
 *      story. HUBS lists no hub with that prefix: exit 1, no hub of this repository mints the key.
 *   6. The head branch is bugfix/<KEY>-<slug>, and the workflow said `--supports bug`: bugfix. Every
 *      spoke can have this type, so no checks.env key turns it on. The workflow declares it
 *      instead. HUBS lists no hub with the key's prefix: exit 1, as for a story. A workflow that
 *      predates the bug route does not pass the flag, and ignores run_bug, so the plan makes no
 *      bugfix type for it: a bugfix/ branch goes on to step 11 and is exit 1 as it was, with a
 *      reason that names the upgrade. The spoke upgrade writes the new workflow.
 *   7. A bugfix branch that also matches SYNC_BRANCH or STORY_GATE_EXCEPTION: exit 2. Read before
 *      step 6 decides, and only where the workflow supports bug fixes.
 *   8. The head branch matches both SYNC_BRANCH and STORY_GATE_EXCEPTION: exit 2.
 *   9. The head branch matches SYNC_BRANCH: sync.
 *  10. The head branch matches STORY_GATE_EXCEPTION: exception.
 *  11. Otherwise: exit 1, the branch names no work item.
 *
 * Output, on stdout, one `key=value` line each. The workflow appends every line but `extra=` to
 * its environment, with the key in upper case:
 *   type=story|bugfix|sync|exception|not-harness    absent on exit 1 and 2
 *   key=<KEY or empty>
 *   trunk=<the resolved spoke trunk, or empty>
 *   reason=<one sentence for the job summary>
 *   hub_secret=<HUB_TOKEN_SECRET at the base, or HUB_READ_TOKEN_SECRET in a checks.env from before the rename>
 *   rules_index=<RULES_INDEX at the base where it names a folder, or empty>
 *   run_scan= run_rules= run_gate= run_coverage= run_watermark= run_test_quality= run_qa= run_bug=
 *                            each 1 or 0. run_qa is the qa-gate job's one step, and only a story
 *                            sets it. run_test_quality is the Semgrep test-quality scan: every
 *                            pull request into the trunk, a sync too. run_bug is the bug-record
 *                            check, and only a bugfix sets it
 *   extra=<sha> <subject>    a sync only: each non-merge commit in base..head that is not on the
 *                            remote's default branch. Information for the reviewer, never a failure
 * On exit 1 the scan, the test-quality scan and the watermark still run, as they do on every
 * pull request into the trunk. On exit 2 every flag is 0.
 *
 * The workflow chooses the hub to clone before this script can run, because the script is in
 * the hub: the key's prefix in HUBS, or the first hub listed where the branch names no key. This
 * script applies the same HUBS grammar (spoke-rules.mjs) to checks.env at the base again, so
 * the decision a fixture tests is the one that judges.
 *
 * The patterns come from a file and the branch names from the command line, so they are applied
 * with `text.search(pattern)` and `text.match(pattern)`, never `pattern.test(text)`.
 *
 * Exit codes: 0 a plan was made · 1 the branch names no work item · 2 cannot verify · 3 usage ·
 * 4 internal. Node standard library only, plus git.
 */

import { spawnSync } from 'node:child_process';
import { realpathSync, writeSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { EXIT, REGISTRY_PATH, REPO_ID, SpokeError, reasonLine, TRUNK_DEFAULT, TRUNK_KEY, isTrunkName, parseChecksEnv, parseRegistry, validateRegistry } from './spoke-remote.mjs';
import { HUBS_KEY, hubsState } from './spoke-rules.mjs';

export const SYNC_KEY = 'SYNC_BRANCH';
export const EXCEPTION_KEY = 'STORY_GATE_EXCEPTION';
// The same grammar the workflow used before this script: a key, then an optional slug.
const STORY_BRANCH = /^feature\/([A-Z][A-Z0-9]{1,9}-[0-9]+)(-.*)?$/;
// A bugfix branch names its ticket the way a story branch does: a key, then an optional slug.
const BUGFIX_BRANCH = /^bugfix\/([A-Z][A-Z0-9]{1,9}-[0-9]+)(-.*)?$/;
const SUPPORT_WORD = /^[a-z][a-z0-9-]*$/;
const COMMIT = /^[0-9a-f]{40}$/;
const REMOTE = 'origin';
const CHECKS_ENV = 'checks.env';
const FLAGS = ['run_scan', 'run_rules', 'run_gate', 'run_coverage', 'run_watermark', 'run_test_quality', 'run_qa', 'run_bug'];

function git(dir, args) {
  const res = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (res.error) throw new SpokeError(EXIT.INTERNAL, `git could not run: ${res.error.message}`);
  return res;
}
const firstLine = (text) => String(text || '').trim().split('\n')[0];
const cannot = (message, reason = null) => new SpokeError(EXIT.CANNOT_VERIFY, message, reason);

function parseArgs(argv) {
  const names = { '--repo': 'repo', '--hub': 'hub', '--base': 'base', '--head': 'head', '--base-ref': 'baseRef', '--head-ref': 'headRef', '--repo-id': 'repoId', '--supports': 'supports' };
  const o = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = names[argv[i]];
    if (!key) throw new SpokeError(EXIT.USAGE, `unknown argument ${argv[i]}`);
    if (argv[i + 1] === undefined || argv[i + 1].startsWith('--')) throw new SpokeError(EXIT.USAGE, `${argv[i]} needs a value`);
    o[key] = argv[i + 1];
    i += 1;
  }
  for (const [flag, key] of Object.entries(names)) if (!o[key] && key !== 'supports') throw new SpokeError(EXIT.USAGE, `${flag} is required`);
  o.supports = o.supports === undefined ? [] : o.supports.split(',');
  if (o.supports.some((w) => w.search(SUPPORT_WORD) !== 0)) throw new SpokeError(EXIT.USAGE, `--supports takes a comma list of lower-case words, not "${o.supports.join(',')}"`);
  for (const key of ['base', 'head']) if (o[key].search(COMMIT) !== 0) throw new SpokeError(EXIT.USAGE, `--${key} takes a full 40-character commit hash, not "${o[key]}"`);
  if (o.repoId.search(REPO_ID) !== 0) throw new SpokeError(EXIT.USAGE, `--repo-id "${o.repoId}" is not a repository id`);
  return o;
}

/** checks.env at the base commit, or null where the base has none. */
function checksAtBase(repo, base) {
  if (git(repo, ['cat-file', '-e', `${base}^{commit}`]).status !== 0) throw cannot(`the base commit ${base} is not in ${repo}; check out with the whole history (fetch-depth: 0)`, 'shallow-clone');
  const res = git(repo, ['show', `${base}:${CHECKS_ENV}`]);
  return res.status === 0 ? res.stdout : null;
}

/** A pattern key: null for `none`, or the compiled pattern. Missing, empty or not a pattern is exit 2 where `required`. */
function patternOf(values, key, required) {
  const value = values.get(key);
  if (value === undefined || value === '') {
    if (required) throw cannot(`${key} is ${value === undefined ? 'missing' : 'empty'} in ${CHECKS_ENV} at the base; it is required: "none" or a regular expression`, 'config-invalid');
    return null;
  }
  if (value === 'none') return null;
  if (value === 'UNRESOLVED') throw cannot(`${key}=UNRESOLVED in ${CHECKS_ENV} at the base; it must be "none" or a regular expression`, 'config-invalid');
  try {
    return new RegExp(value);
  } catch {
    throw cannot(`${key}=${value} is not "none" or a regular expression`, 'config-invalid');
  }
}
const matches = (pattern, text) => pattern !== null && text.search(pattern) !== -1;

/** The branch origin reports as its default, asked from the checkout at `dir`. */
function defaultBranch(dir, what) {
  const ls = git(dir, ['ls-remote', '--symref', REMOTE, 'HEAD']);
  if (ls.status !== 0) throw cannot(`could not reach the ${what}'s ${REMOTE} (${firstLine(ls.stderr)})`, 'remote-unreachable');
  const m = ls.stdout.match(/^ref:\s+refs\/heads\/(\S+)\s+HEAD/m);
  if (!m) throw cannot(`the ${what}'s ${REMOTE} reports no default branch`, 'no-default-branch');
  return m[1];
}

/** The hub registry from the trunk of the hub's origin, force-fetched, and checked. */
function hubRegistry(hub) {
  const trunk = defaultBranch(hub, 'hub');
  const ref = `refs/remotes/${REMOTE}/${trunk}`;
  const fetched = git(hub, ['fetch', '--quiet', '--no-tags', '--force', REMOTE, `+refs/heads/${trunk}:${ref}`]);
  if (fetched.status !== 0) throw cannot(`could not fetch the hub's ${REMOTE}/${trunk} (${firstLine(fetched.stderr)})`, 'fetch-failed');
  const shown = git(hub, ['show', `${ref}:${REGISTRY_PATH}`]);
  if (shown.status !== 0) throw cannot(`the hub's trunk ${trunk} has no ${REGISTRY_PATH}`, 'registry-missing');
  let registry;
  try {
    registry = parseRegistry(shown.stdout, `${REGISTRY_PATH} on the hub's ${trunk}`);
  } catch (err) {
    if (err instanceof SpokeError) throw cannot(err.message, err.reason);
    throw err;
  }
  const problems = validateRegistry(registry, `${REGISTRY_PATH} on the hub's ${trunk}`);
  if (problems.length) throw cannot(`the hub registry is not well formed, so it cannot be cross-checked: ${problems.join('; ')}`, 'registry-invalid');
  return { registry, trunk };
}

/** True when origin has the branch. */
function hasBranch(repo, branch) {
  const ls = git(repo, ['ls-remote', '--heads', REMOTE, `refs/heads/${branch}`]);
  if (ls.status !== 0) throw cannot(`could not reach this repository's ${REMOTE} (${firstLine(ls.stderr)})`, 'remote-unreachable');
  return ls.stdout.split('\n').some((l) => l.endsWith(`\trefs/heads/${branch}`));
}

/** Each non-merge commit in base..head that is not on the default branch: what a sync carries beyond BAU. */
function extraCommits(repo, o, bau) {
  const ref = `refs/remotes/${REMOTE}/${bau}`;
  const fetched = git(repo, ['fetch', '--quiet', '--no-tags', '--force', REMOTE, `+refs/heads/${bau}:${ref}`]);
  if (fetched.status !== 0) throw cannot(`could not fetch ${REMOTE}/${bau} (${firstLine(fetched.stderr)})`, 'fetch-failed');
  const log = git(repo, ['log', '--no-merges', '--format=%H %s', o.head, `^${o.base}`, `^${ref}`]);
  if (log.status !== 0) throw cannot(`cannot list the commits of ${o.base.slice(0, 12)}..${o.head.slice(0, 12)} (${firstLine(log.stderr)})`, 'git-failed');
  return log.stdout.split('\n').filter(Boolean);
}

/** The plan as { exit, lines }. Throws SpokeError for exit 2, 3 and 4. */
export function plan(o) {
  const out = (fields) => Object.entries(fields).map(([k, v]) => `${k}=${v}`);
  const flags = (on) => Object.fromEntries(FLAGS.map((f) => [f, on.includes(f) ? 1 : 0]));
  const text = checksAtBase(o.repo, o.base);
  if (text === null) {
    return { exit: EXIT.PASS, lines: out({ type: 'not-harness', key: '', trunk: '', reason: `the base commit ${o.base.slice(0, 12)} has no ${CHECKS_ENV}, so ${o.baseRef} is not a harness trunk`, hub_secret: '', rules_index: '', ...flags([]) }) };
  }
  const values = parseChecksEnv(text);
  const named = values.get(TRUNK_KEY);
  if (named === undefined || named === '') throw cannot(`${TRUNK_KEY} is ${named === undefined ? 'missing' : 'empty'} in ${CHECKS_ENV} at the base; it is required: "${TRUNK_DEFAULT}" or the harness trunk's branch name`, 'trunk-undeclared');
  if (!isTrunkName(named)) throw cannot(`${TRUNK_KEY}=${named} is not "${TRUNK_DEFAULT}" or a branch name`, 'config-invalid');
  const sync = patternOf(values, SYNC_KEY, true);
  const hubs = hubsState(values);
  if (hubs.state === 'not-configured') throw cannot(`${HUBS_KEY} is missing, empty or UNRESOLVED in ${CHECKS_ENV} at the base; write one entry per hub, "<PREFIX> <owner>/<repo>"`, 'config-invalid');
  if (hubs.state === 'invalid') throw cannot(`${HUBS_KEY} in ${CHECKS_ENV} at the base is malformed: ${hubs.findings.join('; ')}`, 'config-invalid');
  const exception = patternOf(values, EXCEPTION_KEY, false);
  // A checks.env written before the rename names the token HUB_READ_TOKEN_SECRET.
  const hubSecret = values.get('HUB_TOKEN_SECRET') || values.get('HUB_READ_TOKEN_SECRET') || '';
  const rulesValue = values.get('RULES_INDEX') || '';
  const rulesIndex = ['', 'none', 'UNRESOLVED'].includes(rulesValue) ? '' : rulesValue;

  // Step 3. The registry is read before the base branch is compared, so a typo in either name
  // stops the job instead of turning the gate off.
  const { registry } = hubRegistry(o.hub);
  const entry = registry.repositories[o.repoId];
  if (!entry) throw cannot(`"${o.repoId}" is not in the hub registry; add it with /add-repo before its pull requests can be judged`, 'not-registered');
  const bau = defaultBranch(o.repo, 'repository');
  const resolve = (name) => (name === TRUNK_DEFAULT ? bau : name);
  if ((o.baseRef === resolve(entry.trunk) || o.baseRef === resolve(named)) && entry.trunk !== named) {
    throw cannot(`the hub registry names the trunk ${entry.trunk}, and ${CHECKS_ENV} at the base has ${TRUNK_KEY}=${named}. The two must agree`, 'trunk-mismatch');
  }
  const trunk = resolve(named);
  if (!hasBranch(o.repo, trunk)) throw cannot(`${TRUNK_KEY} names the trunk ${trunk}, and this repository's ${REMOTE} has no branch ${trunk}`, 'trunk-missing');

  const common = { trunk, hub_secret: hubSecret, rules_index: rulesIndex };
  if (o.baseRef !== trunk) {
    return { exit: EXIT.PASS, lines: out({ type: 'not-harness', key: '', ...common, reason: `the base branch ${o.baseRef} is not the harness trunk ${trunk}; the harness does not judge this pull request`, ...flags([]) }) };
  }
  const key = o.headRef.match(STORY_BRANCH);
  if (key) {
    const prefix = key[1].split('-')[0];
    if (!hubs.hubs.some((h) => h.prefix === prefix)) {
      return { exit: EXIT.FAIL, lines: out({ key: key[1], ...common, reason: `no hub of this repository mints the key ${key[1]}. ${HUBS_KEY} lists the prefixes ${hubs.hubs.map((h) => h.prefix).join(' ')}`, ...flags(['run_scan', 'run_watermark', 'run_test_quality']) }) };
    }
    return { exit: EXIT.PASS, lines: out({ type: 'story', key: key[1], ...common, reason: `${o.headRef} is the story ${key[1]} into the harness trunk ${trunk}`, ...flags(['run_scan', 'run_gate', 'run_coverage', 'run_watermark', 'run_test_quality', 'run_qa', ...(rulesIndex ? ['run_rules'] : [])]) }) };
  }
  const isSync = matches(sync, o.headRef);
  const isException = matches(exception, o.headRef);
  // The type exists only for a workflow that has the step. An older one passes no flag.
  const bug = o.supports.includes('bug') ? o.headRef.match(BUGFIX_BRANCH) : null;
  if (bug) {
    for (const [other, name, on] of [[SYNC_KEY, 'sync', isSync], [EXCEPTION_KEY, 'exception', isException]]) {
      if (on) {
        throw cannot(`the branch ${o.headRef} matches both the bugfix grammar (bugfix/<KEY>-<slug>) and ${other} (${values.get(other)}); a branch is a bugfix or a ${name}, never both`, 'config-invalid');
      }
    }
    // The key's prefix selects the hub that holds the bug record, as it selects a story's hub.
    const prefix = bug[1].split('-')[0];
    if (!hubs.hubs.some((h) => h.prefix === prefix)) {
      return { exit: EXIT.FAIL, lines: out({ key: bug[1], ...common, reason: `no hub of this repository mints the key ${bug[1]}. ${HUBS_KEY} lists the prefixes ${hubs.hubs.map((h) => h.prefix).join(' ')}`, ...flags(['run_scan', 'run_watermark', 'run_test_quality']) }) };
    }
    return { exit: EXIT.PASS, lines: out({ type: 'bugfix', key: bug[1], ...common, reason: `${o.headRef} is the bug fix ${bug[1]} into the harness trunk ${trunk}: the bug record must be merged in the hub, and the design gate and the QA gate do not apply`, ...flags(['run_scan', 'run_bug', 'run_coverage', 'run_watermark', 'run_test_quality', ...(rulesIndex ? ['run_rules'] : [])]) }) };
  }
  if (isSync && isException) {
    throw cannot(`the branch ${o.headRef} matches both ${SYNC_KEY} (${values.get(SYNC_KEY)}) and ${EXCEPTION_KEY} (${values.get(EXCEPTION_KEY)}); a branch is a sync or an exception, never both`, 'config-invalid');
  }
  if (isSync) {
    const extra = extraCommits(o.repo, o, bau);
    const reason = `${o.headRef} is a sync into the harness trunk ${trunk}: only the secret scan and the test-quality scan run, and a person reviews the merge${extra.length ? `. ${extra.length} commit(s) are not on ${bau}` : ''}`;
    return { exit: EXIT.PASS, lines: [...out({ type: 'sync', key: '', ...common, reason, ...flags(['run_scan', 'run_test_quality']) }), ...extra.map((l) => `extra=${l}`)] };
  }
  if (isException) {
    return { exit: EXIT.PASS, lines: out({ type: 'exception', key: '', ...common, reason: `${o.headRef} names no work item and matches ${EXCEPTION_KEY} (${values.get(EXCEPTION_KEY)}); the design gate and the coverage floors do not apply`, ...flags(['run_scan', 'run_watermark', 'run_test_quality', ...(rulesIndex ? ['run_rules'] : [])]) }) };
  }
  return { exit: EXIT.FAIL, lines: out({ key: '', ...common, reason: `the branch ${o.headRef} names no work item. Branches are feature/<KEY>-<slug>; a hotfix is a story with a short design${o.headRef.search(BUGFIX_BRANCH) === 0 && !o.supports.includes('bug') ? '. A bugfix/<KEY>-<slug> branch needs this spoke\'s story-gate workflow to be upgraded: it predates the bug route' : ''}`, ...flags(['run_scan', 'run_watermark', 'run_test_quality']) }) };
}

function main(argv) {
  const o = parseArgs(argv);
  const result = plan(o);
  process.stdout.write(`${result.lines.join('\n')}\n`);
  if (result.exit === EXIT.FAIL) process.stderr.write(`STORY GATE FAILED — ${result.lines.find((l) => l.startsWith('reason=')).slice('reason='.length)}\n`);
  return result.exit;
}

const invoked = (() => { try { return realpathSync(process.argv[1] || '') === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })();
if (invoked) {
  // The last line of an exit 2, 3 or 4 names this script and its code, so a shell line that hides
  // the code, with a pipe or `; echo`, still tells the harness's failure record. Written at once,
  // so a process.exit() never loses it.
  process.on('exit', (code) => { if (code >= 2 && code <= 4) { try { writeSync(2, `HARNESS EXIT: story-gate-plan ${code}\n`); } catch { /* stderr is closed */ } } });
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (err) {
    if (err instanceof SpokeError) {
      const label = { [EXIT.CANNOT_VERIFY]: 'CANNOT VERIFY', [EXIT.USAGE]: 'USAGE', [EXIT.FAIL]: 'FAIL' }[err.exit] || 'INTERNAL';
      process.stderr.write(`${label} — ${err.message}\n${reasonLine(err.reason)}`);
      if (err.exit === EXIT.USAGE) process.stderr.write('usage: node scripts/story-gate-plan.mjs --repo <dir> --hub <dir> --base <sha> --head <sha> --base-ref <branch> --head-ref <branch> --repo-id <id> [--supports bug]\n');
      process.stdout.write(`reason=${err.message}\n${FLAGS.map((f) => `${f}=0`).join('\n')}\n`);
      process.exit(err.exit);
    }
    process.stderr.write(`INTERNAL — ${err && err.stack ? err.stack : String(err)}\n`);
    process.exit(EXIT.INTERNAL);
  }
}

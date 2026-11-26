#!/usr/bin/env node
/**
 * run.mjs — the fixture suite for story-gate-plan.mjs.
 *
 *   usage:  node run.mjs            run every fixture
 *           node run.mjs 3 7        run only the numbered fixtures
 *           node run.mjs --keep     leave the throwaway repositories on disk
 *
 * A fixture is a REPOSITORY STATE: a bare hub remote whose trunk carries the registry, a clone of
 * it as the hub checkout, a bare spoke remote with a default branch and, where the fixture says,
 * a declared harness trunk, and a clone of the spoke at the pull request's head branch. The
 * shipped script runs against them exactly as the story-gate workflow runs it. The exit code and
 * the output lines are asserted.
 *
 * Node standard library only, plus git via child_process. No test framework.
 * Exit 0 if every fixture passes, 1 if any fails.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

// Two layouts. The library: this suite at accelerator/gate/tests/story-gate-plan/, the script at
// accelerator/gate/, spoke-remote.mjs and spoke-rules.mjs at accelerator/scripts/. An installed
// hub: this suite at tests/story-gate-plan/ and every script at scripts/. The script imports
// spoke-remote.mjs and spoke-rules.mjs from beside itself, so all three are copied into one
// folder for each fixture.
function locate(label, candidates) {
  const found = candidates.filter(Boolean).find((p) => existsSync(p));
  if (!found) {
    console.error(`cannot locate ${label}. Looked in order:`);
    for (const c of candidates.filter(Boolean)) console.error(`  ${c}`);
    process.exit(4);
  }
  return found;
}
const UP = resolve(HERE, '..', '..');
const SCRIPT = locate('story-gate-plan.mjs', [process.env.HARNESS_STORY_GATE_PLAN, join(UP, 'story-gate-plan.mjs'), join(UP, 'scripts', 'story-gate-plan.mjs')]);
const SPOKE_REMOTE = locate('spoke-remote.mjs', [process.env.HARNESS_SPOKE_REMOTE, resolve(UP, '..', 'scripts', 'spoke-remote.mjs'), join(UP, 'scripts', 'spoke-remote.mjs')]);
const SPOKE_RULES = locate('spoke-rules.mjs', [process.env.HARNESS_SPOKE_RULES, resolve(UP, '..', 'scripts', 'spoke-rules.mjs'), join(UP, 'scripts', 'spoke-rules.mjs')]);

/* ------------------------------------------------------------------ git helpers */

const SANDBOX_HOME = mkdtempSync(join(tmpdir(), 'story-gate-plan-home-'));
const ENV = {
  ...process.env,
  HOME: SANDBOX_HOME,
  XDG_CONFIG_HOME: join(SANDBOX_HOME, '.config'),
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
  GIT_ASKPASS: 'true',
  GIT_AUTHOR_NAME: 'Fixture Runner',
  GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'Fixture Runner',
  GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
};
for (const k of ['HARNESS_TRUNK', 'HARNESS_SPOKE_TRUNK', 'HARNESS_REGISTRY', 'HARNESS_REPO']) delete ENV[k];

function git(cwd, args) {
  return execFileSync('git', args, { cwd, env: ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function writeFiles(root, files) {
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(root, rel);
    if (body === null) {
      rmSync(abs, { force: true });
      continue;
    }
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }
}

function commit(work, files, message) {
  writeFiles(work, files);
  git(work, ['add', '-A']);
  git(work, ['commit', '-q', '--allow-empty', '-m', message]);
  return git(work, ['rev-parse', 'HEAD']).trim();
}

const checksEnv = (values) => `${Object.entries(values).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${v}`).join('\n')}\n`;

// The spoke's commands file for a declared trunk, and for one that uses the default branch.
const DECLARED = {
  SECRET_SCAN_COMMAND: 'node scripts/scan.mjs',
  HUB_TOKEN_SECRET: 'SPOKE_HUB_TOKEN',
  STORY_GATE_EXCEPTION: '^(harness|release)/',
  TRUNK_FOR_HUB: 'harness-main',
  SYNC_BRANCH: '^sync/',
  RULES_INDEX: 'none',
  HUBS: 'ABC owner/hub, OPS owner/ops-hub',
};
const PLAIN = { ...DECLARED, TRUNK_FOR_HUB: 'default', SYNC_BRANCH: 'none' };

/**
 * Build one estate.
 *   bau         checks.env values on the default branch `main`, or null for no checks.env
 *   harness     checks.env values on the declared branch `harness-main`, cut from main; null for none
 *   registry    the hub registry's entry for `svc`: { trunk } , or null to leave `svc` out
 *   base        the branch the pull request targets
 *   head        { name, files, merge } — the pull request's branch, cut from `base`; `merge` merges
 *               main into it first (a sync)
 *   hubLocal    a registry text written only in the hub checkout, never pushed
 */
function estate(root, { bau = PLAIN, harness = null, registry = { trunk: 'default' }, base = 'main', head, hubLocal = null, registryText = null }) {
  const spokeBare = join(root, 'svc.git');
  const work = join(root, 'svc-work');
  git(root, ['init', '--bare', '-q', '--initial-branch', 'main', spokeBare]);
  git(root, ['init', '-q', '--initial-branch', 'main', work]);
  git(work, ['config', 'commit.gpgsign', 'false']);
  commit(work, { 'README.md': '# svc\n', ...(bau ? { 'checks.env': checksEnv(bau) } : {}) }, 'bau: first');
  if (harness !== null) {
    git(work, ['checkout', '-q', '-b', 'harness-main']);
    commit(work, { 'checks.env': checksEnv(harness), 'HARNESS.md': 'the harness trunk\n' }, 'harness: declare the trunk');
    git(work, ['checkout', '-q', 'main']);
  }
  // BAU moves on after the harness branch was cut.
  const bauTip = commit(work, { 'src/bau.js': 'export const bau = 1;\n' }, 'bau: a change the BAU team made');
  const baseSha = git(work, ['rev-parse', base]).trim();
  git(work, ['checkout', '-q', '-b', head.name, base]);
  if (head.merge) git(work, ['merge', '-q', '--no-ff', '--no-edit', 'main']);
  const headSha = commit(work, head.files || { 'src/story.js': 'export const story = 1;\n' }, head.message || 'story: the change');
  git(work, ['push', '-q', spokeBare, 'main', ...(harness !== null ? ['harness-main'] : []), head.name]);

  const hubBare = join(root, 'hub.git');
  const hubWork = join(root, 'hub-work');
  git(root, ['init', '--bare', '-q', '--initial-branch', 'main', hubBare]);
  git(root, ['init', '-q', '--initial-branch', 'main', hubWork]);
  git(hubWork, ['config', 'commit.gpgsign', 'false']);
  const repositories = registry === null ? {} : {
    svc: { url: spokeBare, checks: 'checks.env', purpose: 'The service the fixtures judge.', readAt: bauTip, ...registry },
  };
  const text = registryText !== null ? registryText : `${JSON.stringify({ schema_version: 1, repositories }, null, 2)}\n`;
  commit(hubWork, { 'docs/estate/repositories.json': text }, 'hub: the registry');
  git(hubWork, ['push', '-q', hubBare, 'main']);
  const hub = join(root, 'hub');
  git(root, ['clone', '-q', hubBare, hub]);
  if (hubLocal !== null) writeFiles(hub, { 'docs/estate/repositories.json': hubLocal });

  const checkout = join(root, 'checkout');
  git(root, ['clone', '-q', '--branch', head.name, spokeBare, checkout]);
  return { checkout, hub, baseSha, headSha, bauTip };
}

/* ------------------------------------------------------------------- fixtures */

const story = { name: 'feature/ABC-12-limits' };
const bugBranch = { name: 'bugfix/ABC-12-rounding' };
const run = (e, over = {}) => ['--repo', e.checkout, '--hub', e.hub, '--base', e.baseSha, '--head', e.headSha, '--base-ref', over.baseRef, '--head-ref', over.headRef, '--repo-id', over.repoId || 'svc', ...(over.supports === undefined ? [] : ['--supports', over.supports])];
const NOT_HARNESS = ['type=not-harness', 'run_scan=0', 'run_rules=0', 'run_gate=0', 'run_coverage=0', 'run_watermark=0', 'run_test_quality=0', 'run_qa=0', 'run_bug=0'];

// Each fixture's `build(root)` returns the arguments; `extra(output, estate)` may add problems.
const FIXTURES = [
  {
    n: 1,
    name: 'control: a story into a declared trunk runs every step but the rule-file check',
    build: (root) => {
      const e = estate(root, { harness: DECLARED, registry: { trunk: 'harness-main' }, base: 'harness-main', head: story });
      return { e, args: run(e, { baseRef: 'harness-main', headRef: story.name }) };
    },
    exit: 0,
    includes: ['type=story', 'key=ABC-12', 'trunk=harness-main', 'hub_secret=SPOKE_HUB_TOKEN', 'rules_index=\n', 'run_scan=1', 'run_rules=0', 'run_gate=1', 'run_coverage=1', 'run_watermark=1', 'run_test_quality=1', 'run_qa=1', 'reason='],
    excludes: ['extra='],
  },
  {
    n: 2,
    name: 'step 1: the base commit has no checks.env, so the pull request is not harness work',
    build: (root) => {
      const e = estate(root, { bau: null, registry: null, head: { name: 'harness/spoke' } });
      return { e, args: run(e, { baseRef: 'main', headRef: 'harness/spoke' }) };
    },
    exit: 0,
    includes: [...NOT_HARNESS, 'has no checks.env'],
  },
  ...[
    ['TRUNK_FOR_HUB missing', { TRUNK_FOR_HUB: undefined }, 'TRUNK_FOR_HUB is missing'],
    ['TRUNK_FOR_HUB empty', { TRUNK_FOR_HUB: '' }, 'TRUNK_FOR_HUB is empty'],
    ['TRUNK_FOR_HUB UNRESOLVED', { TRUNK_FOR_HUB: 'UNRESOLVED' }, 'TRUNK_FOR_HUB=UNRESOLVED is not "default" or a branch name'],
    ['SYNC_BRANCH missing', { SYNC_BRANCH: undefined }, 'SYNC_BRANCH is missing'],
    ['SYNC_BRANCH empty', { SYNC_BRANCH: '' }, 'SYNC_BRANCH is empty'],
    ['SYNC_BRANCH not a pattern', { SYNC_BRANCH: '^sync/(' }, 'SYNC_BRANCH=^sync/( is not "none" or a regular expression'],
  ].map(([what, change, says], i) => ({
    n: 3 + i,
    name: `step 2: ${what} at the base is exit 2`,
    build: (root) => {
      const e = estate(root, { bau: { ...PLAIN, ...change }, head: story });
      return { e, args: run(e, { baseRef: 'main', headRef: story.name }) };
    },
    exit: 2,
    // Every flag is 0 on exit 2, the qa-gate job's run_qa with the rest.
    includes: [says, 'CANNOT VERIFY', 'run_gate=0', 'run_qa=0'],
    excludes: ['type='],
  })),
  {
    n: 9,
    name: 'step 3: the repository is not in the hub registry',
    build: (root) => {
      const e = estate(root, { registry: null, head: story });
      return { e, args: run(e, { baseRef: 'main', headRef: story.name }) };
    },
    exit: 2,
    includes: ['"svc" is not in the hub registry', 'REASON: not-registered'],
  },
  {
    n: 10,
    name: 'step 3: the base is the registry trunk, and TRUNK_FOR_HUB names another branch (a typo cannot switch the gate off)',
    build: (root) => {
      const e = estate(root, { harness: { ...DECLARED, TRUNK_FOR_HUB: 'harnes-main' }, registry: { trunk: 'harness-main' }, base: 'harness-main', head: story });
      return { e, args: run(e, { baseRef: 'harness-main', headRef: story.name }) };
    },
    exit: 2,
    includes: ['the hub registry names the trunk harness-main', 'TRUNK_FOR_HUB=harnes-main', 'The two must agree', 'REASON: trunk-mismatch'],
  },
  {
    n: 11,
    name: 'step 3: the base is TRUNK_FOR_HUB, and the registry names another trunk',
    build: (root) => {
      const e = estate(root, { harness: DECLARED, registry: { trunk: 'default' }, base: 'harness-main', head: story });
      return { e, args: run(e, { baseRef: 'harness-main', headRef: story.name }) };
    },
    exit: 2,
    includes: ['the hub registry names the trunk default', 'TRUNK_FOR_HUB=harness-main'],
  },
  {
    n: 12,
    name: 'step 3: the declared trunk is missing on the remote',
    build: (root) => {
      const e = estate(root, { bau: DECLARED, registry: { trunk: 'harness-main' }, head: story });
      return { e, args: run(e, { baseRef: 'main', headRef: story.name }) };
    },
    exit: 2,
    includes: ['has no branch harness-main', 'REASON: trunk-missing'],
  },
  {
    n: 13,
    name: 'step 4: a pull request into the BAU branch is not harness work, though checks.env declares a trunk',
    build: (root) => {
      const e = estate(root, { bau: DECLARED, harness: DECLARED, registry: { trunk: 'harness-main' }, base: 'main', head: { name: 'bau/fix-rounding' } });
      return { e, args: run(e, { baseRef: 'main', headRef: 'bau/fix-rounding' }) };
    },
    exit: 0,
    includes: [...NOT_HARNESS, 'trunk=harness-main', 'the base branch main is not the harness trunk harness-main'],
  },
  {
    n: 14,
    name: 'step 8: a branch with no key that matches both SYNC_BRANCH and STORY_GATE_EXCEPTION is exit 2',
    build: (root) => {
      const both = { ...DECLARED, STORY_GATE_EXCEPTION: '^(harness|release|sync)/' };
      const e = estate(root, { bau: both, harness: both, registry: { trunk: 'harness-main' }, base: 'harness-main', head: { name: 'sync/bau-1' } });
      return { e, args: run(e, { baseRef: 'harness-main', headRef: 'sync/bau-1' }) };
    },
    exit: 2,
    includes: ['matches both SYNC_BRANCH', 'and STORY_GATE_EXCEPTION'],
  },
  {
    n: 15,
    name: 'step 9: a sync runs only the secret scan and the test-quality scan, and lists each commit that is not on the default branch',
    build: (root) => {
      const e = estate(root, {
        bau: DECLARED, harness: DECLARED, registry: { trunk: 'harness-main' }, base: 'harness-main',
        head: { name: 'sync/bau-1', merge: true, files: { 'src/glue.js': 'export const glue = 1;\n' }, message: 'sync: a fix that is not on BAU' },
      });
      return { e, args: run(e, { baseRef: 'harness-main', headRef: 'sync/bau-1' }) };
    },
    exit: 0,
    includes: ['type=sync', 'key=\n', 'run_scan=1', 'run_rules=0', 'run_gate=0', 'run_coverage=0', 'run_watermark=0', 'run_test_quality=1', 'run_qa=0', 'sync: a fix that is not on BAU'],
    excludes: ['bau: a change the BAU team made'],
    extra: (out, e) => (out.includes(`extra=${e.headSha} sync: a fix that is not on BAU`) ? [] : [`no extra= line for ${e.headSha}`]),
  },
  {
    n: 16,
    name: 'step 10: an exception branch runs the scan, the test-quality scan and the watermark, not the gate or the floors',
    build: (root) => {
      const e = estate(root, { bau: DECLARED, harness: DECLARED, registry: { trunk: 'harness-main' }, base: 'harness-main', head: { name: 'harness/upgrade-abc' } });
      return { e, args: run(e, { baseRef: 'harness-main', headRef: 'harness/upgrade-abc' }) };
    },
    exit: 0,
    includes: ['type=exception', 'run_scan=1', 'run_rules=0', 'run_gate=0', 'run_coverage=0', 'run_watermark=1', 'run_test_quality=1', 'run_qa=0'],
  },
  {
    n: 17,
    name: 'step 11: a branch that names no work item is exit 1, and the scan, the test-quality scan and the watermark still run',
    build: (root) => {
      const e = estate(root, { head: { name: 'quick-fix' } });
      return { e, args: run(e, { baseRef: 'main', headRef: 'quick-fix' }) };
    },
    exit: 1,
    includes: ['branch quick-fix names no work item', 'run_scan=1', 'run_gate=0', 'run_coverage=0', 'run_watermark=1', 'run_test_quality=1', 'run_qa=0'],
    excludes: ['type='],
  },
  {
    n: 18,
    name: '`default` is resolved through the remote: a story into the default branch',
    build: (root) => {
      const e = estate(root, { head: story });
      return { e, args: run(e, { baseRef: 'main', headRef: story.name }) };
    },
    exit: 0,
    includes: ['type=story', 'key=ABC-12', 'trunk=main', 'run_gate=1'],
  },
  {
    n: 19,
    name: 'a key wins over a broad SYNC_BRANCH: a story branch is never a sync',
    build: (root) => {
      const broad = { ...DECLARED, SYNC_BRANCH: '.*' };
      const e = estate(root, { bau: broad, harness: broad, registry: { trunk: 'harness-main' }, base: 'harness-main', head: story });
      return { e, args: run(e, { baseRef: 'harness-main', headRef: story.name }) };
    },
    exit: 0,
    includes: ['type=story', 'run_gate=1', 'run_coverage=1'],
  },
  {
    n: 20,
    name: 'the base wins: a branch that adds its own exception to checks.env is still exit 1',
    build: (root) => {
      const e = estate(root, { head: { name: 'chore/tidy', files: { 'checks.env': checksEnv({ ...PLAIN, STORY_GATE_EXCEPTION: '^chore/' }) } } });
      return { e, args: run(e, { baseRef: 'main', headRef: 'chore/tidy' }) };
    },
    exit: 1,
    includes: ['branch chore/tidy names no work item'],
  },
  {
    n: 21,
    name: 'a declared rules folder runs the rule-file check on a story, and its path is printed',
    build: (root) => {
      const rules = { ...PLAIN, RULES_INDEX: 'docs/rules' };
      const e = estate(root, { bau: rules, head: story });
      return { e, args: run(e, { baseRef: 'main', headRef: story.name }) };
    },
    exit: 0,
    includes: ['type=story', 'rules_index=docs/rules', 'run_rules=1'],
  },
  {
    n: 22,
    name: 'the registry is read from the hub\'s origin, never from the hub checkout',
    build: (root) => {
      const local = `${JSON.stringify({ schema_version: 1, repositories: { svc: { url: 'x', checks: 'checks.env', purpose: 'Local only.', readAt: 'a'.repeat(40), trunk: 'default' } } })}\n`;
      const e = estate(root, { registry: null, hubLocal: local, head: story });
      return { e, args: run(e, { baseRef: 'main', headRef: story.name }) };
    },
    exit: 2,
    includes: ['"svc" is not in the hub registry', 'REASON: not-registered'],
  },
  {
    n: 23,
    name: 'a hub registry that is not well formed cannot be cross-checked',
    build: (root) => {
      const e = estate(root, { registryText: '{ "schema_version": 1, "repositories": { ', head: story });
      return { e, args: run(e, { baseRef: 'main', headRef: story.name }) };
    },
    exit: 2,
    includes: ['is not JSON'],
  },
  {
    n: 24,
    name: 'a missing argument is a usage error',
    build: (root) => {
      const e = estate(root, { head: story });
      return { e, args: ['--repo', e.checkout, '--hub', e.hub, '--base', e.baseSha] };
    },
    exit: 3,
    includes: ['--head is required'],
  },
  {
    n: 25,
    name: 'with no declared trunk, a sync branch is no sync: SYNC_BRANCH=none, and the branch names no work item',
    build: (root) => {
      const e = estate(root, { head: { name: 'sync/bau-1' } });
      return { e, args: run(e, { baseRef: 'main', headRef: 'sync/bau-1' }) };
    },
    exit: 1,
    includes: ['branch sync/bau-1 names no work item'],
  },
  ...[
    ['HUBS missing', { HUBS: undefined }, 'HUBS is missing, empty or UNRESOLVED'],
    ['HUBS UNRESOLVED', { HUBS: 'UNRESOLVED' }, 'HUBS is missing, empty or UNRESOLVED'],
    ['an entry out of grammar', { HUBS: 'ABC owner/hub, ops owner/ops-hub' }, 'the HUBS entry "ops owner/ops-hub" is not "<PREFIX> <owner>/<repo>"'],
    ['a prefix twice', { HUBS: 'ABC owner/hub, ABC owner/ops-hub' }, 'HUBS lists the prefix ABC more than once'],
  ].map(([what, change, says], i) => ({
    n: 26 + i,
    name: `step 2: HUBS at the base, ${what}, is exit 2`,
    build: (root) => {
      const e = estate(root, { bau: { ...PLAIN, ...change }, head: story });
      return { e, args: run(e, { baseRef: 'main', headRef: story.name }) };
    },
    exit: 2,
    includes: [says, 'CANNOT VERIFY', 'run_gate=0', 'run_test_quality=0', 'run_qa=0'],
    excludes: ['type='],
  })),
  {
    n: 30,
    name: 'step 5: a key whose prefix no hub in HUBS mints is exit 1, and the scan, the test-quality scan and the watermark still run',
    build: (root) => {
      const e = estate(root, { head: { name: 'feature/PAY-3-refunds' } });
      return { e, args: run(e, { baseRef: 'main', headRef: 'feature/PAY-3-refunds' }) };
    },
    exit: 1,
    includes: ['no hub of this repository mints the key PAY-3', 'HUBS lists the prefixes ABC OPS', 'STORY GATE FAILED', 'run_scan=1', 'run_gate=0', 'run_coverage=0', 'run_watermark=1', 'run_test_quality=1', 'run_qa=0'],
    excludes: ['type='],
  },
  {
    n: 31,
    name: 'step 5: a key of the second hub in HUBS is a story',
    build: (root) => {
      const e = estate(root, { head: { name: 'feature/OPS-7-cut-off' } });
      return { e, args: run(e, { baseRef: 'main', headRef: 'feature/OPS-7-cut-off' }) };
    },
    exit: 0,
    includes: ['type=story', 'key=OPS-7', 'run_gate=1'],
  },
  {
    n: 32,
    name: 'the base wins for HUBS too: a branch that adds its own prefix to checks.env is still exit 1',
    build: (root) => {
      const e = estate(root, { head: { name: 'feature/PAY-3-refunds', files: { 'checks.env': checksEnv({ ...PLAIN, HUBS: 'ABC owner/hub, PAY owner/pay-hub' }) } } });
      return { e, args: run(e, { baseRef: 'main', headRef: 'feature/PAY-3-refunds' }) };
    },
    exit: 1,
    includes: ['no hub of this repository mints the key PAY-3'],
  },
  // The bugfix type. Every spoke can have it, and the workflow says so with --supports bug.
  {
    n: 33,
    name: 'step 6: a bugfix branch, from a workflow that supports bug fixes, runs the bug check, the scan, the floors and the watermark, not the design gate or the QA gate',
    build: (root) => {
      const e = estate(root, { head: bugBranch });
      return { e, args: run(e, { baseRef: 'main', headRef: bugBranch.name, supports: 'bug' }) };
    },
    exit: 0,
    includes: ['type=bugfix', 'key=ABC-12', 'trunk=main', 'run_bug=1', 'run_scan=1', 'run_rules=0', 'run_gate=0', 'run_coverage=1', 'run_watermark=1', 'run_test_quality=1', 'run_qa=0'],
  },
  {
    n: 34,
    name: 'roll-out: a workflow that does not say --supports bug still gives exit 1 for a bugfix branch, names the upgrade, and no step runs the bug check',
    build: (root) => {
      const e = estate(root, { head: bugBranch });
      return { e, args: run(e, { baseRef: 'main', headRef: bugBranch.name }) };
    },
    exit: 1,
    includes: ['branch bugfix/ABC-12-rounding names no work item', 'predates the bug route', 'upgrade', 'run_bug=0', 'run_scan=1', 'run_gate=0', 'run_coverage=0'],
    excludes: ['type='],
  },
  {
    n: 35,
    name: 'roll-out: --supports with a capability that is not bug is no support for bug fixes',
    build: (root) => {
      const e = estate(root, { head: bugBranch });
      return { e, args: run(e, { baseRef: 'main', headRef: bugBranch.name, supports: 'other' }) };
    },
    exit: 1,
    includes: ['names no work item', 'predates the bug route', 'run_bug=0'],
    excludes: ['type='],
  },
  {
    n: 36,
    name: 'step 7: a bugfix branch that STORY_GATE_EXCEPTION also matches is exit 2 for a workflow that supports bug fixes',
    build: (root) => {
      const wide = { ...PLAIN, STORY_GATE_EXCEPTION: '^(harness|release|bugfix)/' };
      const e = estate(root, { bau: wide, head: bugBranch });
      return { e, args: run(e, { baseRef: 'main', headRef: bugBranch.name, supports: 'bug' }) };
    },
    exit: 2,
    includes: ['matches both the bugfix grammar', 'and STORY_GATE_EXCEPTION', 'run_bug=0'],
    excludes: ['type='],
  },
  {
    n: 37,
    name: 'step 7: a bugfix branch that SYNC_BRANCH also matches is exit 2 for a workflow that supports bug fixes',
    build: (root) => {
      const e = estate(root, { bau: { ...PLAIN, SYNC_BRANCH: '^bugfix/' }, head: bugBranch });
      return { e, args: run(e, { baseRef: 'main', headRef: bugBranch.name, supports: 'bug' }) };
    },
    exit: 2,
    includes: ['matches both the bugfix grammar', 'and SYNC_BRANCH'],
  },
  {
    n: 38,
    name: 'an old workflow is unchanged where the owner widened the exception: the bugfix branch is an exception, as before',
    build: (root) => {
      const wide = { ...PLAIN, STORY_GATE_EXCEPTION: '^(harness|release|bugfix)/' };
      const e = estate(root, { bau: wide, head: bugBranch });
      return { e, args: run(e, { baseRef: 'main', headRef: bugBranch.name }) };
    },
    exit: 0,
    includes: ['type=exception', 'run_bug=0', 'run_gate=0'],
  },
  {
    n: 39,
    name: '--supports that is not a list of lower-case words is a usage error',
    build: (root) => {
      const e = estate(root, { head: bugBranch });
      return { e, args: run(e, { baseRef: 'main', headRef: bugBranch.name, supports: 'Bug,' }) };
    },
    exit: 3,
    includes: ['--supports'],
  },
  {
    n: 40,
    name: 'step 6: a bugfix/ branch that names no key is exit 1, though the workflow supports bug fixes',
    build: (root) => {
      const e = estate(root, { head: { name: 'bugfix/rounding' } });
      return { e, args: run(e, { baseRef: 'main', headRef: 'bugfix/rounding', supports: 'bug' }) };
    },
    exit: 1,
    includes: ['branch bugfix/rounding names no work item', 'run_bug=0'],
    excludes: ['type='],
  },
  {
    n: 41,
    name: 'a declared rules folder runs the rule-file check on a bugfix, and its path is printed',
    build: (root) => {
      const e = estate(root, { bau: { ...PLAIN, RULES_INDEX: 'docs/rules' }, head: bugBranch });
      return { e, args: run(e, { baseRef: 'main', headRef: bugBranch.name, supports: 'bug' }) };
    },
    exit: 0,
    includes: ['type=bugfix', 'rules_index=docs/rules', 'run_rules=1', 'run_bug=1'],
  },
  {
    n: 42,
    name: 'a key wins: a story branch is a story, though the workflow supports bug fixes',
    build: (root) => {
      const e = estate(root, { head: story });
      return { e, args: run(e, { baseRef: 'main', headRef: story.name, supports: 'bug' }) };
    },
    exit: 0,
    includes: ['type=story', 'run_gate=1', 'run_bug=0'],
  },
  {
    n: 43,
    name: 'a bugfix branch into a branch that is not the harness trunk is not harness work, though the workflow supports bug fixes',
    build: (root) => {
      const e = estate(root, { bau: DECLARED, harness: DECLARED, registry: { trunk: 'harness-main' }, base: 'main', head: bugBranch });
      return { e, args: run(e, { baseRef: 'main', headRef: bugBranch.name, supports: 'bug' }) };
    },
    exit: 0,
    includes: [...NOT_HARNESS],
  },
  {
    n: 44,
    name: 'step 6: a bugfix key whose prefix no hub in HUBS mints is exit 1, and the scan, the test-quality scan and the watermark still run',
    build: (root) => {
      const e = estate(root, { head: { name: 'bugfix/PAY-3-rounding' } });
      return { e, args: run(e, { baseRef: 'main', headRef: 'bugfix/PAY-3-rounding', supports: 'bug' }) };
    },
    exit: 1,
    includes: ['no hub of this repository mints the key PAY-3', 'HUBS lists the prefixes ABC OPS', 'run_scan=1', 'run_bug=0', 'run_gate=0', 'run_watermark=1', 'run_test_quality=1'],
    excludes: ['type='],
  },
  {
    n: 45,
    name: 'step 6: a bugfix key of the second hub in HUBS is a bugfix',
    build: (root) => {
      const e = estate(root, { head: { name: 'bugfix/OPS-7-cut-off' } });
      return { e, args: run(e, { baseRef: 'main', headRef: 'bugfix/OPS-7-cut-off', supports: 'bug' }) };
    },
    exit: 0,
    includes: ['type=bugfix', 'key=OPS-7', 'run_bug=1'],
  },
  {
    n: 46,
    name: 'a checks.env from before the rename: HUB_READ_TOKEN_SECRET still names the hub token',
    build: (root) => {
      const e = estate(root, { harness: { ...DECLARED, HUB_TOKEN_SECRET: undefined, HUB_READ_TOKEN_SECRET: 'OLD_HUB_TOKEN' }, registry: { trunk: 'harness-main' }, base: 'harness-main', head: story });
      return { e, args: run(e, { baseRef: 'harness-main', headRef: story.name }) };
    },
    exit: 0,
    includes: ['type=story', 'hub_secret=OLD_HUB_TOKEN'],
  },
];

/* ---------------------------------------------------------------------- runner */

function runFixture(fixture) {
  const root = mkdtempSync(join(tmpdir(), `story-gate-plan-fx${String(fixture.n).padStart(2, '0')}-`));
  try {
    const scripts = join(root, 'scripts');
    mkdirSync(scripts);
    copyFileSync(SCRIPT, join(scripts, 'story-gate-plan.mjs'));
    copyFileSync(SPOKE_REMOTE, join(scripts, 'spoke-remote.mjs'));
    copyFileSync(SPOKE_RULES, join(scripts, 'spoke-rules.mjs'));
    const { e, args } = fixture.build(root);
    const res = spawnSync(process.execPath, [join(scripts, 'story-gate-plan.mjs'), ...args], {
      cwd: root,
      env: { ...ENV, HARNESS_SPOKE_CACHE: join(root, 'cache') },
      encoding: 'utf8',
    });
    const output = `${res.stdout || ''}${res.stderr || ''}`;
    const problems = [];
    if (res.status !== fixture.exit) problems.push(`expected exit ${fixture.exit}, got ${res.status}`);
    for (const needle of fixture.includes || []) if (!output.includes(needle)) problems.push(`output does not contain: ${JSON.stringify(needle)}`);
    for (const needle of fixture.excludes || []) if (output.includes(needle)) problems.push(`output should not contain: ${JSON.stringify(needle)}`);
    if (fixture.extra) problems.push(...fixture.extra(output, e));
    return { problems, output };
  } catch (err) {
    return { problems: [`fixture setup failed: ${err && err.message ? err.message : String(err)}`], output: '' };
  } finally {
    if (!process.argv.includes('--keep')) rmSync(root, { recursive: true, force: true });
  }
}

function main() {
  const wanted = process.argv.slice(2).filter((a) => a.search(/^\d+$/) === 0).map(Number);
  const selected = wanted.length ? FIXTURES.filter((f) => wanted.includes(f.n)) : FIXTURES;
  let failed = 0;
  for (const fixture of selected) {
    const { problems, output } = runFixture(fixture);
    if (problems.length) {
      failed += 1;
      process.stdout.write(`  FAIL  ${fixture.n}. ${fixture.name} [exit ${fixture.exit}]\n`);
      for (const p of problems) process.stdout.write(`          - ${p}\n`);
      process.stdout.write(`${output.split('\n').map((l) => `          | ${l}`).join('\n')}\n`);
    } else {
      process.stdout.write(`  PASS  ${fixture.n}. ${fixture.name} [exit ${fixture.exit}]\n`);
    }
  }
  process.stdout.write(failed
    ? `\n${failed} of ${selected.length} fixtures FAILED. The story-gate plan is not trustworthy until this is green.\n`
    : `\nAll ${selected.length} fixtures passed.\n`);
  rmSync(SANDBOX_HOME, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
}

main();

#!/usr/bin/env node
/**
 * run.mjs — the fixture suite for check-registry.mjs.
 *
 *   usage:  node run.mjs            run every fixture
 *           node run.mjs 3 7        run only the numbered fixtures
 *           node run.mjs --keep     leave the throwaway repositories on disk
 *
 * A fixture is a REPOSITORY STATE: one or more real bare remotes built on disk,
 * a registry file pointing at them, and the shipped script run against that
 * file exactly as a hub would run it. The script is never imported and never
 * stubbed. Exit code and messages are asserted.
 *
 * Node standard library only, plus git via child_process. No test framework.
 * Exit 0 if every fixture passes, 1 if any fails.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

// Two layouts: the library, where the script is two levels up; and an adopting
// repository, where this suite lands at tests/check-registry/ and the script at
// scripts/. The script imports spoke-remote.mjs from beside itself, so it is run
// in place rather than copied.
const SCRIPT = [
  process.env.HARNESS_CHECK_REGISTRY,
  resolve(HERE, '..', '..', 'check-registry.mjs'),
  resolve(HERE, '..', '..', 'scripts', 'check-registry.mjs'),
].filter(Boolean).find((p) => existsSync(p));

if (!SCRIPT) {
  console.error('cannot locate check-registry.mjs. Set HARNESS_CHECK_REGISTRY=/path/to/check-registry.mjs.');
  process.exit(4);
}

/* ------------------------------------------------------------------ git helpers */

const SANDBOX_HOME = mkdtempSync(join(tmpdir(), 'registry-home-'));
const ENV = {
  ...process.env,
  HOME: SANDBOX_HOME,
  XDG_CONFIG_HOME: join(SANDBOX_HOME, '.config'),
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
  GIT_ASKPASS: 'true',
};

function git(cwd, args) {
  return execFileSync('git', args, { cwd, env: ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function writeFiles(root, files) {
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }
}

/**
 * A bare remote with a trunk of the given name and one commit per entry in
 * `commits`, each a set of files added or changed. Returns the URL (a plain path,
 * which git accepts) and the commit hashes, oldest first.
 */
function makeRemote(root, name, { trunk = 'main', commits, allowAnySha = true, branch = null }) {
  const bare = join(root, `${name}.git`);
  const work = join(root, `${name}-work`);
  git(root, ['init', '--bare', '-q', '--initial-branch', trunk, bare]);
  git(root, ['--git-dir', bare, 'symbolic-ref', 'HEAD', `refs/heads/${trunk}`]);
  if (allowAnySha) git(root, ['--git-dir', bare, 'config', 'uploadpack.allowAnySHA1InWant', 'true']);
  git(root, ['init', '-q', '--initial-branch', trunk, work]);
  git(work, ['config', 'user.name', 'Fixture Runner']);
  git(work, ['config', 'user.email', 'fixture@example.invalid']);
  git(work, ['config', 'commit.gpgsign', 'false']);
  const shas = [];
  commits.forEach((files, i) => {
    writeFiles(work, files);
    git(work, ['add', '-A']);
    git(work, ['commit', '-q', '-m', `commit ${i + 1}`]);
    shas.push(git(work, ['rev-parse', 'HEAD']).trim());
  });
  git(work, ['push', '-q', bare, trunk]);
  // A second branch, cut from the trunk's tip: a declared harness trunk.
  let branchHead = null;
  if (branch) {
    git(work, ['checkout', '-q', '-b', branch.name]);
    branch.commits.forEach((files, i) => {
      writeFiles(work, files);
      git(work, ['add', '-A']);
      git(work, ['commit', '-q', '-m', `${branch.name} commit ${i + 1}`]);
    });
    branchHead = git(work, ['rev-parse', 'HEAD']).trim();
    git(work, ['push', '-q', bare, branch.name]);
  }
  return { url: bare, shas, head: shas[shas.length - 1], trunk, branchHead };
}

const README = { 'README.md': '# transfer-service\n\nMoves money between accounts.\n' };
const SCAN = 'SECRET_SCAN_COMMAND=node scripts/secret-scan.mjs\nHUBS=TRF acme/payments-hub\n';
const DEFAULT = 'TRUNK_FOR_HUB=default\n';
const CHECKS = { 'checks.env': `TEST_COMMAND=npm test\n${SCAN}${DEFAULT}` };
const DECLARED = { 'checks.env': `TEST_COMMAND=npm test\n${SCAN}TRUNK_FOR_HUB=harness-main\n` };
const LEDGER = (prefix) => ({ 'docs/backlog/keys.json': `${JSON.stringify({ prefix, next: 1 })}\n` });
const hubsRemote = (root, hubs) => makeRemote(root, 'transfer-service', { commits: [{ ...README, 'checks.env': `TEST_COMMAND=npm test\nSECRET_SCAN_COMMAND=node scripts/secret-scan.mjs\n${DEFAULT}${hubs}` }] });

const entry = (remote, overrides = {}) => ({
  url: remote.url,
  checks: 'checks.env',
  purpose: 'Moves money between accounts. Owns the transfer API and the step-up challenge.',
  readAt: remote.head,
  trunk: 'default',
  ...overrides,
});

const registry = (repositories, root = {}) => JSON.stringify({ schema_version: 1, repositories, ...root }, null, 2);

/* ------------------------------------------------------------------- fixtures */

// Each fixture's `build(root)` returns the registry text to write, or `null` to
// write no registry at all. Remotes are built inside `root`.
const FIXTURES = [
  {
    n: 1,
    name: 'two well-formed entries, both remotes answer as the registry says',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [{ ...README, ...CHECKS }] });
      const b = makeRemote(root, 'ledger-service', { commits: [{ 'README.md': '# ledger\n', ...CHECKS }] });
      return registry({ 'transfer-service': entry(a), 'ledger-service': entry(b) });
    },
    exit: 0,
    includes: ['[PASS] shape', '[PASS] transfer-service', '[PASS] ledger-service', 'readAt is the trunk head: current', 'secret scan declared (SECRET_SCAN_COMMAND=node scripts/secret-scan.mjs)', 'TRUE: every listed repository answered'],
  },
  {
    n: 2,
    name: 'offline: shape is checked and the remotes are not asked',
    args: ['--offline'],
    build: () => registry({ 'transfer-service': entry({ url: 'https://example.invalid/acme/transfer-service.git', head: 'a'.repeat(40) }) }),
    exit: 0,
    includes: ['[PASS] shape', '[SKIP] transfer-service', 'remote not asked', 'WELL FORMED: 1 repository listed'],
    excludes: ['cannot reach', 'REASON:'],
  },
  {
    n: 3,
    name: 'no registry file',
    build: () => null,
    exit: 2,
    includes: ['CANNOT VERIFY: no registry at', 'run /add-repo to create it', 'REASON: registry-missing'],
  },
  {
    n: 4,
    name: 'the registry is not JSON',
    build: () => '{ "schema_version": 1, "repositories": { ',
    exit: 1,
    includes: ['is not JSON'],
  },
  {
    n: 5,
    name: 'an id with an owner and a slash is not a repository id',
    args: ['--offline'],
    build: () => registry({ 'acme/transfer-service': entry({ url: 'https://example.invalid/x.git', head: 'a'.repeat(40) }) }),
    exit: 1,
    includes: ['[FAIL] shape', 'repositories["acme/transfer-service"] is not a repository id', 'Remotes were not asked'],
  },
  {
    n: 6,
    name: 'a clone URL carrying a token is a credential in a committed file',
    args: ['--offline'],
    build: () => registry({ 'transfer-service': entry({ url: 'https://x-access-token:ghp_abc@example.invalid/acme/transfer-service.git', head: 'a'.repeat(40) }) }),
    exit: 1,
    includes: ['.url carries a user name or password'],
  },
  {
    n: 7,
    name: 'the commands file is not at the trunk yet: the agreement is pending, and the entry passes',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [README] });
      return registry({ 'transfer-service': entry(a) });
    },
    exit: 0,
    includes: ['[PASS] transfer-service', 'trunk is main (default branch) at', 'agreement pending: no checks.env on main yet', 'TRUE: every listed repository answered'],
    excludes: ['secret scan declared'],
  },
  {
    n: 8,
    name: 'readAt names a commit the remote does not know',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [{ ...README, ...CHECKS }] });
      return registry({ 'transfer-service': entry(a, { readAt: 'd'.repeat(40) }) });
    },
    exit: 1,
    includes: ['readAt dddddddddddd is not a commit', 'read at a commit nobody can open'],
  },
  {
    n: 9,
    name: 'readAt is an older trunk commit: stale, reported, not failed',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [{ ...README, ...CHECKS }, { 'src/app.ts': 'export {};\n' }] });
      return registry({ 'transfer-service': entry(a, { readAt: a.shas[0] }) });
    },
    exit: 0,
    includes: ['[PASS] transfer-service', 'is behind the trunk head', 'stale. Run /add-repo'],
  },
  {
    n: 10,
    name: 'readAt is older and the server refuses bare hashes: the branch is fetched in full instead',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { allowAnySha: false, commits: [{ ...README, ...CHECKS }, { 'src/app.ts': 'export {};\n' }] });
      return registry({ 'transfer-service': entry(a, { readAt: a.shas[0] }) });
    },
    exit: 0,
    includes: ['[PASS] transfer-service', 'stale. Run /add-repo'],
  },
  {
    n: 11,
    name: 'one remote is unreachable: exit 2 for the run, the other is still checked',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [{ ...README, ...CHECKS }] });
      return registry({
        'transfer-service': entry(a),
        'ledger-service': entry({ url: join(root, 'no-such-remote.git'), head: 'b'.repeat(40) }),
      });
    },
    exit: 2,
    includes: ['[PASS] transfer-service', '[CANNOT VERIFY] ledger-service', 'cannot reach', 'CANNOT VERIFY: at least one repository could not be reached', 'REASON: remote-unreachable'],
  },
  {
    n: 12,
    name: 'a purpose that is a placeholder',
    args: ['--offline'],
    build: () => registry({ 'transfer-service': entry({ url: 'https://example.invalid/x.git', head: 'a'.repeat(40) }, { purpose: 'TBD' }) }),
    exit: 1,
    includes: ['.purpose is a placeholder'],
  },
  {
    n: 13,
    name: 'a field the schema does not know, and two missing ones: checks and trunk',
    args: ['--offline'],
    build: () => registry({
      'transfer-service': { url: 'https://example.invalid/x.git', checks: 'checks.env', purpose: 'Moves money.', readAt: 'a'.repeat(40), trunk: 'default', branch: 'main' },
      'ledger-service': { url: 'https://example.invalid/y.git', purpose: 'Keeps the books.', readAt: 'b'.repeat(40) },
    }),
    exit: 1,
    includes: ['["transfer-service"].branch is not a field the schema knows', '["ledger-service"].checks is missing', '["ledger-service"].trunk is missing'],
  },
  {
    n: 14,
    name: 'a trunk called master is read from the remote, not assumed',
    build: (root) => {
      const a = makeRemote(root, 'legacy-batch', { trunk: 'master', commits: [{ 'README': 'batch jobs\n', ...CHECKS }] });
      return registry({ 'legacy-batch': entry(a) });
    },
    exit: 0,
    includes: ['trunk is master (default branch) at', '[PASS] legacy-batch'],
  },
  {
    n: 15,
    name: 'a commands file under a directory, and a readAt that is current',
    build: (root) => {
      const a = makeRemote(root, 'ledger-service', { commits: [{ 'ci/checks.env': `TEST_COMMAND=pytest\n${SCAN}${DEFAULT}` }] });
      return registry({ 'ledger-service': entry(a, { checks: 'ci/checks.env' }) });
    },
    exit: 0,
    includes: ['commands file ci/checks.env present'],
  },
  {
    n: 16,
    name: 'a checks path that climbs out of the repository',
    args: ['--offline'],
    build: () => registry({ 'transfer-service': entry({ url: 'https://example.invalid/x.git', head: 'a'.repeat(40) }, { checks: '../hub/checks.env' }) }),
    exit: 1,
    includes: ['.checks must be a path relative to the repository root'],
  },
  {
    n: 17,
    name: 'an empty list is well formed',
    build: () => registry({}),
    exit: 0,
    includes: ['WELL FORMED: no repositories listed yet'],
  },
  {
    n: 18,
    name: 'a wrong schema version and an unknown root field',
    args: ['--offline'],
    build: () => JSON.stringify({ schema_version: 2, repositories: {}, hub: 'x' }),
    exit: 1,
    includes: ['"schema_version" must be 1', 'unknown root field "hub"'],
  },
  {
    n: 19,
    name: 'the commands file names a rules folder and the folder is at the trunk',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', {
        commits: [{ ...README, 'checks.env': `TEST_COMMAND=npm test\n${SCAN}${DEFAULT}RULES_INDEX=docs/rules\n`, 'docs/rules/repository.md': '---\nname: repository\ndescription: x\nglobs: ["**/*"]\nalwaysApply: true\n---\n\n- x\n' }],
      });
      return registry({ 'transfer-service': entry(a) });
    },
    exit: 0,
    includes: ['commands file checks.env present', 'rules folder docs/rules present', 'TRUE: every listed repository answered'],
  },
  {
    n: 20,
    name: 'the commands file names a rules folder that is not at the trunk',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [{ ...README, 'checks.env': `TEST_COMMAND=npm test\n${SCAN}${DEFAULT}RULES_INDEX=docs/rules\n` }] });
      return registry({ 'transfer-service': entry(a) });
    },
    exit: 1,
    includes: ['[FAIL] transfer-service', 'RULES_INDEX=docs/rules, and docs/rules is not a folder at this commit', 'NOT TRUE'],
  },
  {
    n: 21,
    name: 'a reserved id: the two a service survey uses for a provider that is not a listed repository, and the global layer\'s name',
    args: ['--offline'],
    build: () => registry({
      external: entry({ url: 'https://example.invalid/x.git', head: 'a'.repeat(40) }),
      unknown: entry({ url: 'https://example.invalid/y.git', head: 'b'.repeat(40) }),
      global: entry({ url: 'https://example.invalid/z.git', head: 'c'.repeat(40) }),
    }),
    exit: 1,
    includes: ['[FAIL] shape', 'repositories["external"] is a reserved id (external, unknown, global)', 'repositories["unknown"] is a reserved id', 'repositories["global"] is a reserved id', 'a Context: entry uses "global" for the global layer'],
  },
  ...[
    ['missing', `TEST_COMMAND=npm test\n${DEFAULT}`, 'SECRET_SCAN_COMMAND missing'],
    ['UNRESOLVED', `TEST_COMMAND=npm test\nSECRET_SCAN_COMMAND=UNRESOLVED\n${DEFAULT}`, 'SECRET_SCAN_COMMAND unresolved'],
    ['`none`', `TEST_COMMAND=npm test\nSECRET_SCAN_COMMAND=none\n${DEFAULT}`, 'SECRET_SCAN_COMMAND `none`'],
    ['empty', `TEST_COMMAND=npm test\nSECRET_SCAN_COMMAND=\n${DEFAULT}`, 'SECRET_SCAN_COMMAND empty'],
  ].map(([state, text, finding], i) => ({
    n: 22 + i,
    name: `the commands file's secret scan is ${state}: every spoke names its own`,
    build: (root) => registry({ 'transfer-service': entry(makeRemote(root, 'transfer-service', { commits: [{ ...README, 'checks.env': text }] })) }),
    exit: 1,
    includes: ['[FAIL] transfer-service', `checks.env has ${finding}`, 'a command that runs on Windows, Linux and Mac', 'NOT TRUE'],
  })),
  {
    n: 26,
    name: "the spoke's HUBS routes this hub's prefix to a hub",
    hub: LEDGER('TRF'),
    build: (root) => registry({ 'transfer-service': entry(makeRemote(root, 'transfer-service', { commits: [{ ...README, ...CHECKS }] })) }),
    exit: 0,
    includes: ['[PASS] transfer-service', "HUBS routes this hub's prefix TRF to acme/payments-hub", 'TRUE: every listed repository answered'],
  },
  {
    n: 27,
    name: 'a spoke of two hubs: this hub is the second one listed',
    hub: LEDGER('LED'),
    build: (root) => registry({ 'transfer-service': entry(hubsRemote(root, 'HUBS=TRF acme/payments-hub, LED acme/ledger-hub\n')) }),
    exit: 0,
    includes: ['[PASS] transfer-service', "HUBS routes this hub's prefix LED to acme/ledger-hub"],
  },
  {
    n: 28,
    name: "the spoke's HUBS lists other hubs and not this one",
    hub: LEDGER('LED'),
    build: (root) => registry({ 'transfer-service': entry(hubsRemote(root, 'HUBS=TRF acme/payments-hub\n')) }),
    exit: 1,
    includes: ['[FAIL] transfer-service', "checks.env has HUBS listing TRF, and not this hub's prefix LED", 'story-gate refuses every LED key', 'NOT TRUE'],
  },
  ...[
    ['missing', '', 'checks.env has no HUBS; story-gate cannot choose a hub to clone'],
    ['UNRESOLVED', 'HUBS=UNRESOLVED\n', 'checks.env has no HUBS; story-gate cannot choose a hub to clone'],
    ['an entry without a hub', 'HUBS=TRF\n', 'the HUBS entry "TRF" is not "<PREFIX> <owner>/<repo>"'],
    ['a prefix listed twice', 'HUBS=TRF acme/payments-hub, TRF acme/ledger-hub\n', 'HUBS lists the prefix TRF more than once; one prefix names one hub'],
  ].map(([state, hubs, finding], i) => ({
    n: 29 + i,
    name: `the spoke's HUBS is ${state}`,
    hub: LEDGER('TRF'),
    build: (root) => registry({ 'transfer-service': entry(hubsRemote(root, hubs)) }),
    exit: 1,
    includes: ['[FAIL] transfer-service', finding, 'NOT TRUE'],
  })),
  {
    n: 33,
    name: 'a hub without a key ledger checks HUBS for form only',
    build: (root) => registry({ 'transfer-service': entry(makeRemote(root, 'transfer-service', { commits: [{ ...README, ...CHECKS }] })) }),
    exit: 0,
    includes: ['[PASS] transfer-service', 'HUBS lists TRF; this hub has no key prefix in docs/backlog/keys.json to look for', 'harness library not recorded (HARNESS_LIBRARY missing or UNRESOLVED)'],
  },
  ...[
    ['the same major as this hub', '1.4.0', 0, ['[PASS] transfer-service', `harness library 1.2.0 at ${'a'.repeat(12)}`]],
    ['another major than this hub', '2.0.0', 1, ['[FAIL] transfer-service', 'records harness library 1.2.0, major 1, and this hub runs 2.0.0, major 2', 'every hub of a spoke runs one major']],
  ].map(([state, version, exit, includes], i) => ({
    n: 34 + i,
    name: `the spoke's HARNESS_LIBRARY is on ${state}`,
    hub: { ...LEDGER('TRF'), 'docs/harness-install.json': `${JSON.stringify({ library: { harnessVersion: version } })}\n` },
    build: (root) => registry({ 'transfer-service': entry(hubsRemote(root, `HUBS=TRF acme/payments-hub\nHARNESS_LIBRARY=1.2.0 ${'a'.repeat(40)}\n`)) }),
    exit,
    includes,
  })),
  {
    n: 36,
    name: "the spoke's HARNESS_LIBRARY is not a version and a commit",
    hub: LEDGER('TRF'),
    build: (root) => registry({ 'transfer-service': entry(hubsRemote(root, 'HUBS=TRF acme/payments-hub\nHARNESS_LIBRARY=latest\n')) }),
    exit: 1,
    includes: ['[FAIL] transfer-service', 'HARNESS_LIBRARY=latest, which is not "<version> <full library commit>"'],
  },
  {
    n: 37,
    name: 'a declared trunk that exists and agrees: read there, not on the default branch',
    build: (root) => {
      // The default branch carries no commands file, so a read of the wrong branch shows as pending.
      const a = makeRemote(root, 'transfer-service', { commits: [README], branch: { name: 'harness-main', commits: [DECLARED] } });
      return registry({ 'transfer-service': entry(a, { trunk: 'harness-main', readAt: a.branchHead }) });
    },
    exit: 0,
    includes: ['[PASS] transfer-service', 'trunk is harness-main (declared) at', 'TRUNK_FOR_HUB agrees', 'readAt is the trunk head: current'],
    excludes: ['agreement pending'],
  },
  {
    n: 38,
    name: 'a declared trunk that still carries TRUNK_FOR_HUB=default from the branch it was cut from: cannot verify',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [{ ...README, ...CHECKS }], branch: { name: 'harness-main', commits: [{ 'src/app.ts': 'export {};\n' }] } });
      return registry({ 'transfer-service': entry(a, { trunk: 'harness-main', readAt: a.branchHead }) });
    },
    exit: 2,
    includes: ['[CANNOT VERIFY] transfer-service', 'the registry names the trunk harness-main', 'TRUNK_FOR_HUB=default', 'The two must agree', 'REASON: trunk-mismatch'],
  },
  {
    n: 39,
    name: 'a declared trunk whose TRUNK_FOR_HUB names another trunk: cannot verify, both values named',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [README], branch: { name: 'harness-main', commits: [{ 'checks.env': `TEST_COMMAND=npm test\n${SCAN}TRUNK_FOR_HUB=harness-next\n` }] } });
      return registry({ 'transfer-service': entry(a, { trunk: 'harness-main', readAt: a.branchHead }) });
    },
    exit: 2,
    includes: ['[CANNOT VERIFY] transfer-service', 'the registry names the trunk harness-main', 'TRUNK_FOR_HUB=harness-next', 'CANNOT VERIFY: at least one repository', 'REASON: trunk-mismatch'],
  },
  {
    n: 40,
    name: 'a declared trunk the remote does not have: cannot verify',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [{ ...README, ...DECLARED }] });
      return registry({ 'transfer-service': entry(a, { trunk: 'harness-main' }) });
    },
    exit: 2,
    includes: ['[CANNOT VERIFY] transfer-service', 'has no branch harness-main', 'Create and protect it, or correct the registry', 'REASON: trunk-missing'],
  },
  {
    n: 41,
    name: 'a declared trunk with no commands file: pending, read on the declared branch',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [README], branch: { name: 'harness-main', commits: [{ 'src/app.ts': 'export {};\n' }] } });
      return registry({ 'transfer-service': entry(a, { trunk: 'harness-main', readAt: a.branchHead }) });
    },
    exit: 0,
    includes: ['[PASS] transfer-service', 'trunk is harness-main (declared) at', 'agreement pending: no checks.env on harness-main yet'],
  },
  {
    n: 42,
    name: 'the commands file has no TRUNK_FOR_HUB: cannot verify',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [{ ...README, 'checks.env': `TEST_COMMAND=npm test\n${SCAN}` }] });
      return registry({ 'transfer-service': entry(a) });
    },
    exit: 2,
    includes: ['[CANNOT VERIFY] transfer-service', 'has TRUNK_FOR_HUB missing; it must name the trunk the registry names, default', 'REASON: trunk-undeclared'],
  },
  {
    n: 43,
    name: 'a trunk that is not "default" and not a branch name',
    args: ['--offline'],
    build: () => registry({ 'transfer-service': entry({ url: 'https://example.invalid/x.git', head: 'a'.repeat(40) }, { trunk: 'harness..main' }) }),
    exit: 1,
    includes: ['[FAIL] shape', '.trunk must be "default" or a branch name git accepts, got "harness..main"'],
  },
];

/* ---------------------------------------------------------------------- runner */

function runFixture(fixture) {
  const root = mkdtempSync(join(tmpdir(), `registry-fx${String(fixture.n).padStart(2, '0')}-`));
  try {
    const hub = join(root, 'hub');
    mkdirSync(join(hub, 'docs', 'estate'), { recursive: true });
    writeFiles(hub, fixture.hub || {});
    const text = fixture.build(root);
    if (text !== null) writeFileSync(join(hub, 'docs', 'estate', 'repositories.json'), text);
    const res = spawnSync(process.execPath, [SCRIPT, ...(fixture.args || [])], {
      cwd: hub,
      env: { ...ENV, HARNESS_SPOKE_CACHE: join(root, 'cache') },
      encoding: 'utf8',
    });
    const output = `${res.stdout || ''}${res.stderr || ''}`;
    const problems = [];
    if (res.status !== fixture.exit) problems.push(`expected exit ${fixture.exit}, got ${res.status}`);
    for (const needle of fixture.includes || []) {
      if (!output.includes(needle)) problems.push(`output does not contain: ${needle}`);
    }
    for (const needle of fixture.excludes || []) {
      if (output.includes(needle)) problems.push(`output should not contain: ${needle}`);
    }
    return { problems, output };
  } catch (err) {
    return { problems: [`fixture setup failed: ${err && err.message ? err.message : String(err)}`], output: '' };
  } finally {
    if (!process.argv.includes('--keep')) rmSync(root, { recursive: true, force: true });
  }
}

function main() {
  const wanted = process.argv.slice(2).filter((a) => /^\d+$/.test(a)).map(Number);
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
    ? `\n${failed} of ${selected.length} fixtures FAILED. The registry check is not trustworthy until this is green.\n`
    : `\nAll ${selected.length} fixtures passed.\n`);
  rmSync(SANDBOX_HOME, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
}

main();

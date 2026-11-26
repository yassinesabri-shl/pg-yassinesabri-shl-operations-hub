#!/usr/bin/env node
/**
 * run.mjs — the fixture suite for read-spoke-rules.mjs.
 *
 *   usage:  node run.mjs            run every fixture
 *           node run.mjs 2 6        run only the numbered fixtures
 *           node run.mjs --keep     leave the throwaway repositories on disk
 *
 * A fixture is a REPOSITORY STATE: a real bare remote holding a commands file
 * and a rules folder, a registry pointing at it, and the shipped script run from
 * a throwaway hub exactly as the orchestrator would run it. Exit code, header
 * lines and, where it matters, the rules printed after the separator are
 * asserted. Fixture 1 is the valid control; most others change one thing.
 *
 * Node standard library only, plus git via child_process. No test framework.
 * Exit 0 if every fixture passes, 1 if any fails.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

const SCRIPT = [
  process.env.HARNESS_READ_SPOKE_RULES,
  resolve(HERE, '..', '..', 'read-spoke-rules.mjs'),
  resolve(HERE, '..', '..', 'scripts', 'read-spoke-rules.mjs'),
].filter(Boolean).find((p) => existsSync(p));

if (!SCRIPT) {
  console.error('cannot locate read-spoke-rules.mjs. Set HARNESS_READ_SPOKE_RULES=/path/to/read-spoke-rules.mjs.');
  process.exit(4);
}

/* ------------------------------------------------------------------ git helpers */

const SANDBOX_HOME = mkdtempSync(join(tmpdir(), 'rules-home-'));
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

function makeRemote(root, name, { trunk = 'main', commits, branch = null }) {
  const bare = join(root, `${name}.git`);
  const work = join(root, `${name}-work`);
  git(root, ['init', '--bare', '-q', '--initial-branch', trunk, bare]);
  git(root, ['--git-dir', bare, 'symbolic-ref', 'HEAD', `refs/heads/${trunk}`]);
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
    git(work, ['checkout', '-q', trunk]);
  }
  return { url: bare, work, bare, trunk, shas, head: shas[shas.length - 1], branchHead };
}

/** Commit more files on the remote's trunk after the registry was written. */
function advance(remote, files) {
  writeFiles(remote.work, files);
  git(remote.work, ['add', '-A']);
  git(remote.work, ['commit', '-q', '-m', 'later']);
  git(remote.work, ['push', '-q', remote.bare, remote.trunk]);
  return git(remote.work, ['rev-parse', 'HEAD']).trim();
}

/* -------------------------------------------------------------- the content */

const CHECKS = (rulesIndex, trunk = 'default') => [
  'FORMAT_COMMAND=none',
  `TRUNK_FOR_HUB=${trunk}`,
  'TEST_COMMAND=npm test',
  ...(rulesIndex === undefined ? [] : [`RULES_INDEX=${rulesIndex}`]),
  'STORY_GATE_EXCEPTION=^harness/',
  '',
].join('\n');

const rule = ({ name, description = `The ${name} rule.`, globs = '["**/*"]', alwaysApply = false, overrides = null, body = `# Rule — ${name}\n\n- One checkable sentence.\n` }) =>
  `---\nname: ${name}\ndescription: ${description}\nglobs: ${globs}\nalwaysApply: ${alwaysApply}\n${overrides === null ? '' : `overrides: ${overrides}\n`}---\n\n${body}`;

const REPOSITORY_RULE = rule({ name: 'repository', alwaysApply: true, body: '# transfer-service — repository rule\n\n- Node 24, no build step.\n- Commit types: feat, fix, test, refactor, chore.\n' });
const HANDLERS_RULE = rule({ name: 'http-handlers', globs: '["src/**/*.ts", "!src/**/*.test.ts"]', body: '# HTTP handlers\n\n- Every response sets content-type explicitly.\n' });
const TESTS_RULE = rule({ name: 'tests', globs: '["src/**/*.test.ts"]', body: '# Tests\n\n- One server per test case.\n' });

const VALID_SPOKE = {
  'README.md': '# transfer-service\n\nMoves money between accounts.\n',
  'checks.env': CHECKS('docs/rules'),
  'docs/rules/repository.md': REPOSITORY_RULE,
  'docs/rules/http-handlers.md': HANDLERS_RULE,
  'docs/rules/tests.md': TESTS_RULE,
  'src/server.ts': 'export {};\n',
};

const DESIGN = [
  '# LLD — TRF-7: correlate every response',
  '',
  '## 1. Traceability',
  '',
  'Work item: TRF-7',
  'Repository: transfer-service',
  '',
  '## 3. The design',
  '',
  '### 3.1 Components changed or added',
  '',
  '| Path | Change | Responsibility |',
  '|---|---|---|',
  '| `src/server.ts` | modified | sets the header |',
  '| `src/server.ts` | modified | reads the request id |',
  '| `README.md` | modified | documents the header |',
  '',
  '### 3.2 Data and interface changes',
  '',
  'None.',
  '',
].join('\n');

const registry = (repositories) => JSON.stringify({ schema_version: 1, repositories }, null, 2);
const entry = (remote, checks = 'checks.env') => ({
  url: remote.url,
  checks,
  purpose: 'Moves money between accounts.',
  readAt: remote.head,
  trunk: 'default',
});

/** Problems when the cache config holds a filter or a promisor: a prefix resolution must leave it as it was. */
function cacheHasNoFilter(cache) {
  const config = readFileSync(join(cache, 'config'), 'utf8');
  return ['promisor', 'partialclonefilter'].filter((key) => config.includes(key)).map((key) => `the cache config ${cache} holds "${key}"`);
}

/* ------------------------------------------------------------------- fixtures */

// `build(root)` returns { registry, args, files?, before?, expect? }. `files` are
// written into the throwaway hub before the run (a design to select by).
// `expect(stdout)` may return extra problems.
const FIXTURES = [
  {
    n: 1,
    name: 'valid folder, selected by the design: the always-on rule and the one whose glob matches src/server.ts',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [VALID_SPOKE] });
      return {
        registry: registry({ 'transfer-service': entry(a) }),
        files: { 'docs/designs/TRF-7.lld.md': DESIGN },
        args: ['transfer-service', '--design', 'docs/designs/TRF-7.lld.md'],
        expect: (out) => {
          const problems = [];
          if (!out.includes(`Commit: ${a.head}`)) problems.push('header does not pin the trunk head');
          if (!out.includes(`Rules: transfer-service@${a.head.slice(0, 12)}:docs/rules`)) problems.push('no paste-ready Rules: line with the short commit');
          if (!out.includes(`Cite: transfer-service@${a.head.slice(0, 12)}:docs/rules/repository.md`)) problems.push('always-on rule has no Cite line');
          if (!out.includes(`Cite: transfer-service@${a.head.slice(0, 12)}:docs/rules/http-handlers.md`)) problems.push('matched rule has no Cite line');
          if (out.includes('alwaysApply:')) problems.push('frontmatter leaked into the printed body');
          if (out.includes('One server per test case')) problems.push('the tests rule was selected though no test file is touched');
          return problems;
        },
      };
    },
    exit: 0,
    includes: ['Repository: transfer-service', 'Trunk: main', 'Status: 3 rule(s) declared', 'Paths: src/server.ts, README.md', 'Selected: 2 of 3: repository, http-handlers', 'Rule: repository', 'Rule: http-handlers', 'Every response sets content-type explicitly'],
  },
  {
    n: 2,
    name: 'no design and no paths: only the always-on rule',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [VALID_SPOKE] });
      return { registry: registry({ 'transfer-service': entry(a) }), args: ['transfer-service'] };
    },
    exit: 0,
    includes: ['Paths: (none given)', 'Selected: 1 of 3: repository', 'Rule: repository'],
    excludes: ['Rule: http-handlers', 'Rule: tests'],
  },
  {
    n: 3,
    name: '--paths with a test file: the negated glob keeps the handler rule out and the tests rule in',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [VALID_SPOKE] });
      return { registry: registry({ 'transfer-service': entry(a) }), args: ['transfer-service', '--paths', 'src/server.test.ts'] };
    },
    exit: 0,
    includes: ['Selected: 2 of 3: repository, tests', 'Rule: tests'],
    excludes: ['Rule: http-handlers'],
  },
  {
    n: 4,
    name: '--all prints every rule',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [VALID_SPOKE] });
      return { registry: registry({ 'transfer-service': entry(a) }), args: ['transfer-service', '--all'] };
    },
    exit: 0,
    includes: ['Selected: 3 of 3: repository, http-handlers, tests', 'Rule: repository', 'Rule: http-handlers', 'Rule: tests'],
  },
  {
    n: 5,
    name: 'RULES_INDEX=none: the repository declares no rules, and that is a read, not a failure',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [{ 'README.md': '# x\n', 'checks.env': CHECKS('none') }] });
      return { registry: registry({ 'transfer-service': entry(a) }), args: ['transfer-service', '--paths', 'src/server.ts'] };
    },
    exit: 0,
    includes: ['Rules: none', 'Status: none declared', 'Selected: 0 of 0'],
  },
  {
    n: 6,
    name: 'no RULES_INDEX key at all: NOT CONFIGURED, exit 0',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [{ 'README.md': '# x\n', 'checks.env': CHECKS(undefined) }] });
      return { registry: registry({ 'transfer-service': entry(a) }), args: ['transfer-service'] };
    },
    exit: 0,
    includes: ['Rules: none', 'Status: NOT CONFIGURED'],
  },
  {
    n: 7,
    name: 'RULES_INDEX=UNRESOLVED is the same as missing: NOT CONFIGURED',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [{ 'README.md': '# x\n', 'checks.env': CHECKS('UNRESOLVED') }] });
      return { registry: registry({ 'transfer-service': entry(a) }), args: ['transfer-service'] };
    },
    exit: 0,
    includes: ['Status: NOT CONFIGURED'],
  },
  {
    n: 8,
    name: 'the commands file names a folder that is not at the commit',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [{ 'README.md': '# x\n', 'checks.env': CHECKS('docs/rules') }] });
      return { registry: registry({ 'transfer-service': entry(a) }), args: ['transfer-service'] };
    },
    exit: 1,
    includes: ['FAIL:', 'RULES_INDEX=docs/rules, and docs/rules is not a folder at this commit'],
  },
  {
    n: 9,
    name: 'two always-on rules: the set is malformed and nothing is selected',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', {
        commits: [{ ...VALID_SPOKE, 'docs/rules/tests.md': rule({ name: 'tests', alwaysApply: true }) }],
      });
      return { registry: registry({ 'transfer-service': entry(a) }), args: ['transfer-service', '--all'] };
    },
    exit: 1,
    includes: ['Status: NOT WELL FORMED: 1 finding(s)', 'FAIL: the rule set is malformed and binds nobody', '2 rules are alwaysApply: true'],
    excludes: ['Rule: repository'],
  },
  {
    n: 10,
    name: '--at reads the pinned commit after a rule was added on the trunk',
    build: (root) => {
      const twoRules = Object.fromEntries(Object.entries(VALID_SPOKE).filter(([p]) => p !== 'docs/rules/tests.md'));
      const a = makeRemote(root, 'transfer-service', { commits: [twoRules] });
      const pinned = a.head;
      return {
        registry: registry({ 'transfer-service': entry(a) }),
        before: (hub, env) => {
          const first = spawnSync(process.execPath, [SCRIPT, 'transfer-service'], { cwd: hub, env, encoding: 'utf8' });
          if (first.status !== 0) throw new Error(`warm-up read failed: ${first.stderr}`);
          advance(a, { 'docs/rules/tests.md': TESTS_RULE });
        },
        args: ['transfer-service', '--all', '--at', pinned],
        expect: (out) => (out.includes(`Commit: ${pinned}`) ? [] : ['header does not name the pinned commit']),
      };
    },
    exit: 0,
    includes: ['Trunk: not asked', 'Status: 2 rule(s) declared', 'Selected: 2 of 2'],
    excludes: ['Rule: tests'],
  },
  {
    n: 11,
    name: 'the remote is unreachable',
    build: (root) => ({
      registry: registry({ 'transfer-service': { url: join(root, 'no-such-remote.git'), checks: 'checks.env', purpose: 'Gone.', readAt: 'a'.repeat(40), trunk: 'default' } }),
      args: ['transfer-service'],
    }),
    exit: 2,
    includes: ['CANNOT VERIFY: cannot reach', 'REASON: remote-unreachable'],
  },
  {
    n: 12,
    name: 'two positional arguments are a usage error',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [VALID_SPOKE] });
      return { registry: registry({ 'transfer-service': entry(a) }), args: ['transfer-service', 'docs/rules'] };
    },
    exit: 3,
    includes: ['expected exactly one argument'],
  },
  {
    n: 13,
    name: 'a design whose §3.1 table carries a fenced example row and a placeholder row: both are ignored',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [VALID_SPOKE] });
      const design = DESIGN
        .replace('### 3.1 Components changed or added\n', '### 3.1 Components changed or added\n\n```\n| Path | Change | Responsibility |\n|---|---|---|\n| `src/server.test.ts` | new | example only |\n```\n')
        .replace('| `README.md` | modified | documents the header |', '| <path> | new / modified | <one line> |');
      return {
        registry: registry({ 'transfer-service': entry(a) }),
        files: { 'docs/designs/TRF-7.lld.md': design },
        args: ['transfer-service', '--design', 'docs/designs/TRF-7.lld.md'],
      };
    },
    exit: 0,
    includes: ['Paths: src/server.ts\n', 'Selected: 2 of 3: repository, http-handlers'],
    excludes: ['Rule: tests', '<path>'],
  },
  {
    n: 14,
    name: 'a registry that is not well formed is refused before any remote is asked',
    build: () => ({
      registry: JSON.stringify({ schema_version: 1, repositories: { 'transfer-service': { url: 'https://example.invalid/x.git' } } }),
      args: ['transfer-service'],
    }),
    exit: 1,
    includes: ['the registry is not well formed; run check-registry first'],
    excludes: ['cannot reach'],
  },
  {
    n: 15,
    name: 'a repository id that is not in the list is a usage error',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [VALID_SPOKE] });
      return { registry: registry({ 'transfer-service': entry(a) }), args: ['ledger-service'] };
    },
    exit: 3,
    includes: ['"ledger-service" is not in', 'Listed: transfer-service'],
  },
  {
    n: 16,
    name: 'the commands file lives at a non-root path the list records, and the folder is read from the same commit',
    build: (root) => {
      const a = makeRemote(root, 'ledger-service', {
        commits: [{ 'README.md': '# ledger\n', 'ci/checks.env': CHECKS('rules'), 'rules/repository.md': REPOSITORY_RULE }],
      });
      return { registry: registry({ 'ledger-service': entry(a, 'ci/checks.env') }), args: ['ledger-service'] };
    },
    exit: 0,
    includes: ['Rules: ledger-service@', ':rules\n', 'Selected: 1 of 1: repository'],
  },
  {
    n: 17,
    name: 'a selected rule that overrides a hub standard rule and a whole global standard: its block carries an Overrides: line, and the header carries the union',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', {
        commits: [{ ...VALID_SPOKE, 'docs/rules/http-handlers.md': rule({ name: 'http-handlers', globs: '["src/**/*.ts"]', overrides: '["std-http-apis.03", "global.std-logging"]' }) }],
      });
      return { registry: registry({ 'transfer-service': entry(a) }), args: ['transfer-service', '--paths', 'src/server.ts'] };
    },
    exit: 0,
    includes: ['Selected: 2 of 3: repository, http-handlers\nOverrides: std-http-apis.03, global.std-logging\n', ':docs/rules/http-handlers.md\nOverrides: std-http-apis.03, global.std-logging\n'],
    expect: (out) => (out.search(/:docs\/rules\/repository\.md\nOverrides:/) === -1 ? [] : ['the always-on rule, which overrides nothing, carries an Overrides: line']),
  },
  {
    n: 18,
    name: 'a rule with overrides that no path selects: the header says Overrides: none, because a rule overrides only where it binds',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', {
        commits: [{ ...VALID_SPOKE, 'docs/rules/tests.md': rule({ name: 'tests', globs: '["src/**/*.test.ts"]', overrides: '["std-testing.02"]' }) }],
      });
      return { registry: registry({ 'transfer-service': entry(a) }), args: ['transfer-service', '--paths', 'src/server.ts'] };
    },
    exit: 0,
    includes: ['Selected: 2 of 3: repository, http-handlers\nOverrides: none\n'],
    excludes: ['std-testing.02'],
  },
  {
    n: 19,
    name: 'RULES_INDEX=none prints Overrides: none too, so every header has the line',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [{ 'README.md': '# x\n', 'checks.env': CHECKS('none') }] });
      return { registry: registry({ 'transfer-service': entry(a) }), args: ['transfer-service'] };
    },
    exit: 0,
    includes: ['Selected: 0 of 0\nOverrides: none\n'],
  },
  {
    n: 20,
    name: 'a declared trunk: the rules are read on that branch, not on the default branch',
    build: (root) => {
      // The default branch declares no rules. Only the declared trunk has the folder.
      const a = makeRemote(root, 'transfer-service', {
        commits: [{ 'README.md': '# x\n', 'checks.env': CHECKS('none') }],
        branch: { name: 'harness-main', commits: [{ ...VALID_SPOKE, 'checks.env': CHECKS('docs/rules', 'harness-main') }] },
      });
      return {
        registry: registry({ 'transfer-service': { ...entry(a), trunk: 'harness-main', readAt: a.branchHead } }),
        args: ['transfer-service'],
        expect: (out) => (out.includes(`Commit: ${a.branchHead}`) ? [] : [`header does not pin the declared trunk's head ${a.branchHead}`]),
      };
    },
    exit: 0,
    includes: ['Trunk: harness-main', 'Status: 3 rule(s) declared', 'Rule: repository'],
  },
  {
    n: 21,
    name: '--at with the 12-character prefix of the trunk head prints the full commit and the Rules: line',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [VALID_SPOKE] });
      return {
        registry: registry({ 'transfer-service': entry(a) }),
        args: ['transfer-service', '--all', '--at', a.head.slice(0, 12)],
        expect: (out) => (out.includes(`\nCommit: ${a.head}\n`) && out.includes(`Rules: transfer-service@${a.head.slice(0, 12)}:docs/rules`) ? [] : ['header does not name the full commit and the Rules: line']),
      };
    },
    exit: 0,
    includes: ['Trunk: not asked', 'Status: 3 rule(s) declared'],
  },
  {
    n: 22,
    name: '--at with the prefix of an older commit after a rule was added reads the old rules, prints what the full commit prints, and the cache gets no filter',
    build: (root) => {
      const twoRules = Object.fromEntries(Object.entries(VALID_SPOKE).filter(([p]) => p !== 'docs/rules/tests.md'));
      const a = makeRemote(root, 'transfer-service', { commits: [twoRules] });
      const pinned = a.head;
      let full = null;
      return {
        registry: registry({ 'transfer-service': entry(a) }),
        before: (hub, env) => {
          advance(a, { 'docs/rules/tests.md': TESTS_RULE });
          full = spawnSync(process.execPath, [SCRIPT, 'transfer-service', '--all', '--at', pinned], { cwd: hub, env: { ...env, HARNESS_SPOKE_CACHE: join(root, 'cache-full') }, encoding: 'utf8' });
        },
        args: ['transfer-service', '--all', '--at', pinned.slice(0, 12)],
        expect: (out) => [
          ...(full.status === 0 && out === full.stdout ? [] : ['stdout is not what the full commit prints']),
          ...cacheHasNoFilter(join(root, 'cache', 'transfer-service.git')),
        ],
      };
    },
    exit: 0,
    includes: ['Status: 2 rule(s) declared'],
    excludes: ['Rule: tests'],
  },
  {
    n: 23,
    name: '--at with a prefix that matches no commit on the trunk is exit 2, and the message names the prefix',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [VALID_SPOKE] });
      return { registry: registry({ 'transfer-service': entry(a) }), args: ['transfer-service', '--at', '0123456789ab'] };
    },
    exit: 2,
    includes: ['CANNOT VERIFY: --at 0123456789ab matches no commit', 'REASON: commit-not-found'],
  },
  ...[['13 characters', 'abcdef0123456'], ['upper case', 'ABCDEF012345']].map(([label, value], i) => ({
    n: 24 + i,
    name: `a --at value of ${label} is a usage error`,
    build: (root) => ({
      registry: registry({ 'transfer-service': { url: join(root, 'never-asked.git'), checks: 'checks.env', purpose: 'Never asked.', readAt: 'a'.repeat(40), trunk: 'default' } }),
      args: ['transfer-service', '--at', value],
    }),
    exit: 3,
    includes: ['--at must be a full 40-character commit hash or its first 12 characters', value],
  })),
];

/* ---------------------------------------------------------------------- runner */

function runFixture(fixture) {
  const root = mkdtempSync(join(tmpdir(), `rules-fx${String(fixture.n).padStart(2, '0')}-`));
  try {
    const hub = join(root, 'hub');
    mkdirSync(join(hub, 'docs', 'estate'), { recursive: true });
    const built = fixture.build(root);
    if (built.registry !== null) writeFileSync(join(hub, 'docs', 'estate', 'repositories.json'), built.registry);
    if (built.files) writeFiles(hub, built.files);
    const env = { ...ENV, HARNESS_SPOKE_CACHE: join(root, 'cache') };
    if (built.before) built.before(hub, env);
    const res = spawnSync(process.execPath, [SCRIPT, ...built.args], { cwd: hub, env, encoding: 'utf8' });
    const output = `${res.stdout || ''}${res.stderr || ''}`;
    const problems = [];
    if (res.status !== fixture.exit) problems.push(`expected exit ${fixture.exit}, got ${res.status}`);
    for (const needle of fixture.includes || []) {
      if (!output.includes(needle)) problems.push(`output does not contain: ${JSON.stringify(needle)}`);
    }
    for (const needle of fixture.excludes || []) {
      if (output.includes(needle)) problems.push(`output should not contain: ${JSON.stringify(needle)}`);
    }
    if (built.expect) problems.push(...built.expect(res.stdout || ''));
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
    ? `\n${failed} of ${selected.length} fixtures FAILED. The rules read is not trustworthy until this is green.\n`
    : `\nAll ${selected.length} fixtures passed.\n`);
  rmSync(SANDBOX_HOME, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
}

main();

#!/usr/bin/env node
/**
 * run.mjs — the fixture suite for check-spoke-rules.mjs.
 *
 *   usage:  node run.mjs            run every fixture
 *           node run.mjs 2 6        run only the numbered fixtures
 *           node run.mjs --keep     leave the throwaway repositories on disk
 *
 * A fixture is a REPOSITORY STATE: a real bare remote (remote mode) or a
 * checkout on disk (--local mode) holding a commands file and a rules folder,
 * and the shipped script run exactly as the hub or the spoke's CI would run it.
 * Exit code and report text are asserted. Fixture 1 is the valid control; most
 * others change exactly one thing about one rule file.
 *
 * Node standard library only, plus git via child_process. No test framework.
 * Exit 0 if every fixture passes, 1 if any fails.
 * Reads the whole tree it is installed in.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

const SCRIPT = [
  process.env.HARNESS_CHECK_SPOKE_RULES,
  resolve(HERE, '..', '..', 'check-spoke-rules.mjs'),
  resolve(HERE, '..', '..', 'scripts', 'check-spoke-rules.mjs'),
].filter(Boolean).find((p) => existsSync(p));

if (!SCRIPT) {
  console.error('cannot locate check-spoke-rules.mjs. Set HARNESS_CHECK_SPOKE_RULES=/path/to/check-spoke-rules.mjs.');
  process.exit(4);
}

// The rule template, in the library and in an installed hub. Fixture 26 writes a
// rule from it, so a template the checker would refuse fails here, not in a spoke.
const TEMPLATE = [
  process.env.HARNESS_RULE_TEMPLATE,
  resolve(HERE, '..', '..', '..', 'templates', 'rule.template.md'),
  resolve(HERE, '..', '..', 'docs', 'estate', '_TEMPLATE.rule.md'),
].filter(Boolean).find((p) => existsSync(p));

const TEMPLATE_SECTIONS = ['## Must', '## Scope', '## Checked by', '## Exceptions', '## Examples', '## Origin'];

// Fill the template the way /add-context --kind rule does: drop the comment,
// name the rule, give it a path, and replace every other <placeholder>.
function ruleFromTemplate(text) {
  const lines = text.split('\n');
  const missing = TEMPLATE_SECTIONS.filter((h) => !lines.includes(h));
  if (missing.length) throw new Error(`the rule template lacks ${missing.join(', ')}`);
  return text
    .replace(/<!--[\s\S]*?-->\n\n?/, '')
    .replace('name: <kebab-case-id>', 'name: camel-case-variables')
    .replace('globs: ["<path pattern>"]', 'globs: ["**/*.go"]')
    .replace(/<[^<>\n]+>/g, 'filled');
}

/* ------------------------------------------------------------------ git helpers */

const SANDBOX_HOME = mkdtempSync(join(tmpdir(), 'rulescheck-home-'));
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

/* -------------------------------------------------------------- the content */

const CHECKS = (rulesIndex, trunk = 'default') => [
  'FORMAT_COMMAND=none',
  `TRUNK_FOR_HUB=${trunk}`,
  'TEST_COMMAND=npm test',
  ...(rulesIndex === undefined ? [] : [`RULES_INDEX=${rulesIndex}`]),
  'STORY_GATE_EXCEPTION=^harness/',
  '',
].join('\n');

const rule = ({ name, description = `The ${name} rule.`, globs = '["src/**"]', alwaysApply = false, body = `# Rule — ${name}\n\n- One checkable sentence.\n`, extra = '' }) =>
  `---\nname: ${name}\ndescription: ${description}\nglobs: ${globs}\nalwaysApply: ${alwaysApply}\n${extra}---\n\n${body}`;

const REPOSITORY_RULE = rule({ name: 'repository', globs: '["**/*"]', alwaysApply: true });
const HANDLERS_RULE = rule({ name: 'http-handlers', globs: '["src/**/*.ts", "!src/**/*.test.ts"]' });

const VALID = {
  'README.md': '# transfer-service\n',
  'checks.env': CHECKS('docs/rules'),
  'docs/rules/repository.md': REPOSITORY_RULE,
  'docs/rules/http-handlers.md': HANDLERS_RULE,
};

const withRules = (overrides) => {
  const files = { ...VALID };
  for (const [k, v] of Object.entries(overrides)) {
    if (v === null) delete files[k];
    else files[k] = v;
  }
  return files;
};

const registry = (repositories) => JSON.stringify({ schema_version: 1, repositories }, null, 2);
const entry = (remote) => ({ url: remote.url, checks: 'checks.env', purpose: 'Moves money between accounts.', readAt: remote.head, trunk: 'default' });

// A remote-mode fixture from one spoke tree: the common case.
const remoteCase = (n, name, files, exit, includes, excludes) => ({
  n,
  name,
  build: (root) => {
    const a = makeRemote(root, 'transfer-service', { commits: [files] });
    return { registry: registry({ 'transfer-service': entry(a) }), args: ['transfer-service'] };
  },
  exit,
  includes,
  excludes,
});

/** Problems when the cache config holds a filter or a promisor: a prefix resolution must leave it as it was. */
function cacheHasNoFilter(cache) {
  const config = readFileSync(join(cache, 'config'), 'utf8');
  return ['promisor', 'partialclonefilter'].filter((key) => config.includes(key)).map((key) => `the cache config ${cache} holds "${key}"`);
}

/** Commit more files on the remote's trunk after the registry was written. */
function advance(remote, files) {
  writeFiles(remote.work, files);
  git(remote.work, ['add', '-A']);
  git(remote.work, ['commit', '-q', '-m', 'later']);
  git(remote.work, ['push', '-q', remote.bare, remote.trunk]);
  return git(remote.work, ['rev-parse', 'HEAD']).trim();
}

/* ------------------------------------------------------------------- fixtures */

const FIXTURES = [
  remoteCase(1, 'valid folder, remote: one always-on rule, one path-scoped, well formed',
    VALID, 0,
    ['spoke rules  (transfer-service at', 'trunk: main)', '[PASS] docs/rules/http-handlers.md  (http-handlers)', '[PASS] docs/rules/repository.md  (repository, always on)', 'WELL FORMED: 2 rule(s) in docs/rules, always on: repository.'],
    ['FAIL']),
  {
    n: 2,
    name: 'valid folder, --local against a checkout on disk, folder from the commands file',
    build: (root) => {
      const co = join(root, 'checkout');
      writeFiles(co, VALID);
      return { registry: null, args: ['--local', co] };
    },
    exit: 0,
    includes: [', local)', 'WELL FORMED: 2 rule(s) in docs/rules'],
  },
  {
    n: 3,
    name: '--local with --index overrides the commands file',
    build: (root) => {
      const co = join(root, 'checkout');
      writeFiles(co, withRules({ 'checks.env': CHECKS('none'), 'conventions/repository.md': REPOSITORY_RULE, 'docs/rules/repository.md': null, 'docs/rules/http-handlers.md': null }));
      return { registry: null, args: ['--local', co, '--index', 'conventions'] };
    },
    exit: 0,
    includes: ['WELL FORMED: 1 rule(s) in conventions'],
  },
  remoteCase(4, 'RULES_INDEX=none: no rules declared, exit 0',
    { 'README.md': '# x\n', 'checks.env': CHECKS('none') }, 0,
    ['[PASS] RULES_INDEX=none', 'NO RULES DECLARED']),
  remoteCase(5, 'RULES_INDEX missing: NOT CONFIGURED, exit 0, never a pass',
    { 'README.md': '# x\n', 'checks.env': CHECKS(undefined) }, 0,
    ['[NOT CONFIGURED] RULES_INDEX is missing, empty or UNRESOLVED', 'NOT CONFIGURED: this repository has not said whether it writes rules'],
    ['WELL FORMED']),
  remoteCase(6, 'a file that is not .md in the folder',
    withRules({ 'docs/rules/notes.txt': 'scratch\n' }), 1,
    ['[FAIL] docs/rules/notes.txt', 'is not a ".md" file', 'NOT WELL FORMED: 1 finding(s)']),
  remoteCase(7, 'a sub-folder in the folder',
    withRules({ 'docs/rules/backend/db.md': rule({ name: 'db' }) }), 1,
    ['[FAIL] docs/rules/backend', 'is a folder; the rules folder is flat']),
  remoteCase(8, 'a rule with no frontmatter',
    withRules({ 'docs/rules/http-handlers.md': '# HTTP handlers\n\n- Set content-type.\n' }), 1,
    ['[FAIL] docs/rules/http-handlers.md', 'does not open with a frontmatter line "---" on line 1']),
  remoteCase(9, 'a rule with a frontmatter key the shape does not know',
    withRules({ 'docs/rules/http-handlers.md': rule({ name: 'http-handlers', extra: 'owner: tech lead\n' }) }), 1,
    ['frontmatter key "owner" is not one of name, description, globs, alwaysApply, overrides']),
  remoteCase(10, 'a rule whose globs is not a JSON array',
    withRules({ 'docs/rules/http-handlers.md': rule({ name: 'http-handlers', globs: 'src/**' }) }), 1,
    ['globs must be a one-line JSON array of non-empty strings']),
  remoteCase(11, 'no rule is always on',
    withRules({ 'docs/rules/repository.md': rule({ name: 'repository', globs: '["docs/**"]', alwaysApply: false }) }), 1,
    ['[FAIL] docs/rules', 'no rule is alwaysApply: true; exactly one always-on rule']),
  remoteCase(12, 'two rules share a name',
    withRules({ 'docs/rules/http-handlers.md': rule({ name: 'repository' }) }), 1,
    ['name "repository" is already used by docs/rules/http-handlers.md']),
  remoteCase(13, 'a rule over the line cap',
    withRules({ 'docs/rules/http-handlers.md': rule({ name: 'http-handlers', body: `# Long\n\n${'- A line.\n'.repeat(80)}` }) }), 1,
    ['lines; the cap is 80. Move method to a skill or split the contract']),
  remoteCase(14, 'a path-scoped rule with a catch-all glob',
    withRules({ 'docs/rules/http-handlers.md': rule({ name: 'http-handlers', globs: '["**/*"]' }) }), 1,
    ['is path-scoped but its globs match everything', 'a rule that binds every change is alwaysApply: true']),
  remoteCase(15, 'a rule with frontmatter and no body',
    withRules({ 'docs/rules/http-handlers.md': '---\nname: http-handlers\ndescription: Handlers.\nglobs: ["src/**"]\nalwaysApply: false\n---\n\n\n' }), 1,
    ['has no body after the frontmatter']),
  remoteCase(16, 'a missing frontmatter key',
    withRules({ 'docs/rules/http-handlers.md': '---\nname: http-handlers\nglobs: ["src/**"]\nalwaysApply: false\n---\n\n# H\n\n- x\n' }), 1,
    ['frontmatter is missing "description"']),
  remoteCase(17, 'alwaysApply that is not the literal true or false',
    withRules({ 'docs/rules/http-handlers.md': rule({ name: 'http-handlers', alwaysApply: 'yes' }) }), 1,
    ['alwaysApply must be the literal true or false']),
  remoteCase(18, 'RULES_INDEX is an absolute path',
    { 'README.md': '# x\n', 'checks.env': CHECKS('/etc/rules') }, 1,
    ['[FAIL] RULES_INDEX', 'RULES_INDEX=/etc/rules is not a path relative to the repository root']),
  remoteCase(19, 'the folder the commands file names is not at the commit',
    { 'README.md': '# x\n', 'checks.env': CHECKS('docs/rules') }, 1,
    ['RULES_INDEX=docs/rules, and docs/rules is not a folder at this commit']),
  {
    n: 20,
    name: '--local with an empty folder: declare none instead',
    build: (root) => {
      const co = join(root, 'checkout');
      writeFiles(co, { 'checks.env': CHECKS('docs/rules') });
      mkdirSync(join(co, 'docs', 'rules'), { recursive: true });
      return { registry: null, args: ['--local', co] };
    },
    exit: 1,
    includes: ['holds no rule files; declare RULES_INDEX=none instead of an empty folder'],
  },
  {
    n: 21,
    name: '--local with no commands file and no --index',
    build: (root) => {
      const co = join(root, 'checkout');
      writeFiles(co, { 'README.md': '# x\n' });
      return { registry: null, args: ['--local', co] };
    },
    exit: 1,
    includes: ['FAIL: no commands file at checks.env; pass --index <path> or write the commands file'],
  },
  {
    n: 22,
    name: '--local pointing at a directory that does not exist is a usage error',
    build: (root) => ({ registry: null, args: ['--local', join(root, 'nowhere')] }),
    exit: 3,
    includes: ['does not exist'],
  },
  {
    n: 23,
    name: 'the remote is unreachable',
    build: (root) => ({
      registry: registry({ 'transfer-service': { url: join(root, 'no-such-remote.git'), checks: 'checks.env', purpose: 'Gone.', readAt: 'a'.repeat(40), trunk: 'default' } }),
      args: ['transfer-service'],
    }),
    exit: 2,
    includes: ['CANNOT VERIFY: cannot reach', 'REASON: remote-unreachable'],
  },
  {
    n: 24,
    name: '--index without --local is a usage error',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [VALID] });
      return { registry: registry({ 'transfer-service': entry(a) }), args: ['transfer-service', '--index', 'docs/rules'] };
    },
    exit: 3,
    includes: ['--index is only for --local'],
  },
  remoteCase(25, 'every finding is listed in one run: a bad name, a missing key and a duplicate name together',
    withRules({
      'docs/rules/http-handlers.md': '---\nname: HTTP Handlers\nglobs: ["src/**"]\nalwaysApply: false\n---\n\n- x\n',
      'docs/rules/tests.md': rule({ name: 'repository' }),
    }), 1,
    ['name "HTTP Handlers" must be lowercase letters, digits and hyphens', 'frontmatter is missing "description"', 'name "repository" is already used by', 'NOT WELL FORMED: 3 finding(s)']),
  {
    n: 26,
    name: 'a rule written from the shipped rule template is well formed',
    build: (root) => {
      if (!TEMPLATE) throw new Error('cannot locate the rule template. Set HARNESS_RULE_TEMPLATE=/path/to/rule.template.md.');
      const co = join(root, 'checkout');
      writeFiles(co, withRules({ 'docs/rules/camel-case-variables.md': ruleFromTemplate(readFileSync(TEMPLATE, 'utf8')) }));
      return { registry: null, args: ['--local', co] };
    },
    exit: 0,
    includes: ['[PASS] docs/rules/camel-case-variables.md  (camel-case-variables)', 'WELL FORMED: 3 rule(s) in docs/rules'],
  },
  remoteCase(27, 'a rule that overrides a hub standard rule, a whole hub standard and a global standard rule is well formed, and the report names what it overrides',
    withRules({ 'docs/rules/http-handlers.md': rule({ name: 'http-handlers', extra: 'overrides: ["std-http-apis.03", "std-logging", "global.std-security.01"]\n' }) }),
    0, ['[PASS] docs/rules/http-handlers.md  (http-handlers, overrides std-http-apis.03, std-logging, global.std-security.01)', 'WELL FORMED: 2 rule(s)']),
  remoteCase(28, 'an override of a decision record is a finding: a spoke rule says how, and a record decides what',
    withRules({ 'docs/rules/http-handlers.md': rule({ name: 'http-handlers', extra: 'overrides: ["ADR-004"]\n' }) }),
    1, ['overrides entry "ADR-004" is not a standard, std-<topic>, or one of its rules, std-<topic>.<NN>, with or without the global. prefix; a decision record is never overridden', 'NOT WELL FORMED: 1 finding(s)']),
  remoteCase(29, 'overrides that is not a JSON array of strings, an empty array, a repeated id, and a rule named beside the whole of its standard: each a finding',
    withRules({
      'docs/rules/http-handlers.md': rule({ name: 'http-handlers', extra: 'overrides: std-http-apis.03\n' }),
      'docs/rules/empty.md': rule({ name: 'empty', extra: 'overrides: []\n' }),
      'docs/rules/twice.md': rule({ name: 'twice', extra: 'overrides: ["std-http-apis.03", "std-http-apis.03"]\n' }),
      'docs/rules/whole.md': rule({ name: 'whole', extra: 'overrides: ["std-http-apis", "std-http-apis.03"]\n' }),
    }),
    1, [
      'overrides must be a one-line JSON array of strings, got "std-http-apis.03"',
      'overrides is empty; drop the key when the rule overrides nothing',
      'overrides names std-http-apis.03 twice',
      'overrides names std-http-apis.03 and the whole of std-http-apis; name one or the other',
      'NOT WELL FORMED: 4 finding(s)',
    ]),
  {
    n: 30,
    name: 'a declared trunk: the rules folder is checked on that branch, not on the default branch',
    build: (root) => {
      // The default branch names a folder it does not have. Only the declared trunk has a well-formed one.
      const a = makeRemote(root, 'transfer-service', {
        commits: [{ 'README.md': '# x\n', 'checks.env': CHECKS('docs/missing') }],
        branch: { name: 'harness-main', commits: [{ ...VALID, 'checks.env': CHECKS('docs/rules', 'harness-main') }] },
      });
      return { registry: registry({ 'transfer-service': { ...entry(a), trunk: 'harness-main', readAt: a.branchHead } }), args: ['transfer-service'] };
    },
    exit: 0,
    includes: ['trunk: harness-main)', 'WELL FORMED: 2 rule(s) in docs/rules'],
    excludes: ['docs/missing'],
  },
  {
    n: 31,
    name: '--at with the 12-character prefix of the trunk head checks that commit',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [VALID] });
      return { registry: registry({ 'transfer-service': entry(a) }), args: ['transfer-service', '--at', a.head.slice(0, 12)], expect: (out) => (out.includes(`transfer-service at ${a.head.slice(0, 12)}, trunk: not asked`) ? [] : ['the report does not name the resolved commit']) };
    },
    exit: 0,
    includes: ['WELL FORMED: 2 rule(s) in docs/rules'],
  },
  {
    n: 32,
    name: '--at with the prefix of an older commit after a push checks the old rules, prints what the full commit prints, and the cache gets no filter',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [VALID] });
      const pinned = a.head;
      let full = null;
      return {
        registry: registry({ 'transfer-service': entry(a) }),
        before: (hub, env) => {
          advance(a, { 'docs/rules/broken.md': 'no frontmatter\n' });
          full = spawnSync(process.execPath, [SCRIPT, 'transfer-service', '--at', pinned], { cwd: hub, env: { ...env, HARNESS_SPOKE_CACHE: join(root, 'cache-full') }, encoding: 'utf8' });
        },
        args: ['transfer-service', '--at', pinned.slice(0, 12)],
        expect: (out) => [
          ...(full.status === 0 && out === full.stdout ? [] : ['stdout is not what the full commit prints']),
          ...cacheHasNoFilter(join(root, 'cache', 'transfer-service.git')),
        ],
      };
    },
    exit: 0,
    includes: ['WELL FORMED: 2 rule(s) in docs/rules'],
    excludes: ['broken.md'],
  },
  {
    n: 33,
    name: '--at with a prefix that matches no commit on the trunk is exit 2, and the message names the prefix',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [VALID] });
      return { registry: registry({ 'transfer-service': entry(a) }), args: ['transfer-service', '--at', '0123456789ab'] };
    },
    exit: 2,
    includes: ['CANNOT VERIFY: --at 0123456789ab matches no commit', 'REASON: commit-not-found'],
  },
  ...[['11 characters', 'abcdef01234'], ['upper case', 'ABCDEF012345']].map(([label, value], i) => ({
    n: 34 + i,
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
  const root = mkdtempSync(join(tmpdir(), `rulescheck-fx${String(fixture.n).padStart(2, '0')}-`));
  try {
    const hub = join(root, 'hub');
    mkdirSync(join(hub, 'docs', 'estate'), { recursive: true });
    const built = fixture.build(root);
    if (built.registry !== null) writeFileSync(join(hub, 'docs', 'estate', 'repositories.json'), built.registry);
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
    ? `\n${failed} of ${selected.length} fixtures FAILED. The rules check is not trustworthy until this is green.\n`
    : `\nAll ${selected.length} fixtures passed.\n`);
  rmSync(SANDBOX_HOME, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
}

main();

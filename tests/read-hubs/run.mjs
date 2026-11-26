#!/usr/bin/env node
/**
 * run.mjs — the fixture suite for read-hubs.mjs.
 *
 *   usage:  node run.mjs            run every fixture
 *           node run.mjs 2 6        run only the numbered fixtures
 *           node run.mjs --keep     leave the throwaway repositories on disk
 *
 * A fixture is a REPOSITORY STATE: a throwaway hub with its registry, its key
 * ledger and an origin remote; real bare spoke remotes whose checks.env carries
 * a HUBS line; and a real bare sibling hub with its records and standards, laid
 * out as `<root>/acme/<repo>.git`, so the sibling's URL is derived from the
 * hub's origin as the script derives it. The shipped script is run from the hub
 * as /add-context runs it. The exit code and the output text are asserted.
 * Fixture 1 is the valid control for --siblings, and fixture 2 for --repos.
 * Most others change one thing. Every fixture runs under a private HOME, so a
 * developer's gitconfig cannot change a result, and with its own spoke cache.
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

const SCRIPT = [
  process.env.HARNESS_READ_HUBS,
  resolve(HERE, '..', '..', 'read-hubs.mjs'),
  resolve(HERE, '..', '..', 'scripts', 'read-hubs.mjs'),
].filter(Boolean).find((p) => existsSync(p));

if (!SCRIPT) {
  console.error('cannot locate read-hubs.mjs. Set HARNESS_READ_HUBS=/path/to/read-hubs.mjs.');
  process.exit(4);
}

/* ------------------------------------------------------------------ git helpers */

const SANDBOX_HOME = mkdtempSync(join(tmpdir(), 'readhubs-home-'));
const ENV = {
  ...process.env,
  HOME: SANDBOX_HOME,
  XDG_CONFIG_HOME: join(SANDBOX_HOME, '.config'),
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
  GIT_ASKPASS: 'true',
};
delete ENV.HARNESS_HUB_BASE;
delete ENV.HARNESS_REGISTRY;

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

/** A bare remote at `<root>/acme/<name>.git` whose trunk carries `files`. Returns its URL. */
function makeRemote(root, name, files, { trunk = 'main' } = {}) {
  const bare = join(root, 'acme', `${name}.git`);
  const work = join(root, 'work', name);
  mkdirSync(dirname(bare), { recursive: true });
  git(root, ['init', '--bare', '-q', '--initial-branch', trunk, bare]);
  git(root, ['--git-dir', bare, 'symbolic-ref', 'HEAD', `refs/heads/${trunk}`]);
  git(root, ['init', '-q', '--initial-branch', trunk, work]);
  git(work, ['config', 'user.name', 'Fixture Runner']);
  git(work, ['config', 'user.email', 'fixture@example.invalid']);
  git(work, ['config', 'commit.gpgsign', 'false']);
  writeFiles(work, files);
  git(work, ['add', '-A']);
  git(work, ['commit', '-q', '-m', 'trunk']);
  git(work, ['push', '-q', bare, trunk]);
  return bare;
}

/* -------------------------------------------------------------- the content */

const CHECKS = (hubs) => [
  'TEST_COMMAND=node --test',
  'TRUNK_FOR_HUB=default',
  ...(hubs === null ? [] : [`HUBS=${hubs}`]),
  'STORY_GATE_EXCEPTION=^harness/',
  '',
].join('\n');

const SHARED = 'SCR acme/scr-hub, SIM acme/sim-hub';

// The spokes: auth-service is shared by SCR and SIM; scr-web belongs to SCR alone.
const AUTH = (hubs = SHARED) => ({ 'checks.env': CHECKS(hubs), 'src/auth/token.ts': 'export {};\n', 'README.md': '# auth-service\n' });
const WEB = (hubs = 'SCR acme/scr-hub') => ({ 'checks.env': CHECKS(hubs), 'src/web/page.ts': 'export {};\n' });

const adr = ({ n, title, globs = '[]', status = 'Accepted', alwaysApply = false, rule = 'MUST follow the decision.' }) => `---\n${[
  `name: ADR-${n}`, `description: ${title}`, `globs: ${globs}`, `alwaysApply: ${alwaysApply}`, 'kind: adr', `status: ${status}`,
  'owner: lead architect', 'revision: v1', 'origin: architecture minutes',
].join('\n')}\n---\n\n${[
  `# ADR-${n}: ${title}`, '', '## Decision', '', title, '', '## Rules', '', `- ${rule}`, '',
  '## Why', '', 'Recorded by the hub.', '', '## Rejected', '', '- None.', '', '## Accepted costs', '', '- None.', '',
].join('\n')}`;

const SECTIONS = ['Applies to', 'Must', 'Should', 'Values', 'Checked by', 'Relations', 'Exceptions', 'Unresolved', 'Origin'];
const standard = ({ topic, title, globs = '[]', alwaysApply = false, status = 'Active' }) => `---\n${[
  `name: std-${topic}`, `description: ${title}`, `globs: ${globs}`, `alwaysApply: ${alwaysApply}`, 'kind: standard', `status: ${status}`,
  'owner: platform team', 'revision: 2026-01', 'origin: client intranet',
].join('\n')}\n---\n\n${[
  `# std-${topic}: ${title}`, '',
  ...SECTIONS.flatMap((h) => [`## ${h}`, '', h === 'Must' ? `- **std-${topic}.01** MUST ${title.toLowerCase()}. *(Source: §1)*` : h === 'Should' ? 'None.' : h === 'Unresolved' ? 'None.' : 'Stated by the hub.', '']),
].join('\n')}`;

// The sibling hub SIM: one record about the shared spoke's paths, one record about
// nothing the new document covers, one record with no globs, one superseded
// record, an always-on standard and a reserved one.
const SIM_HUB = {
  'docs/architecture/_TEMPLATE.adr.md': '# ADR-<NNN>: <state the decision>\n',
  'docs/architecture/ADR-044-token-library-b.md': adr({ n: '044', title: 'auth-service issues tokens with library B', globs: '["src/auth/**"]', rule: 'MUST issue tokens with library B.' }),
  'docs/architecture/ADR-001-simulator-offline.md': adr({ n: '001', title: 'The simulator runs offline', globs: '["src/simulator/**"]' }),
  'docs/architecture/ADR-003-token-lifetime.md': adr({ n: '003', title: 'Every token lives 15 minutes', rule: 'MUST expire a token after 15 minutes.' }),
  'docs/architecture/ADR-002-old-tokens.md': adr({ n: '002', title: 'Tokens with library C', globs: '["src/auth/**"]', status: 'Superseded by ADR-044' }),
  'docs/standards/std-logging.md': standard({ topic: 'logging', title: 'Log in JSON lines', alwaysApply: true }),
  'docs/standards/std-rust.md': standard({ topic: 'rust', title: 'Write Rust with clippy clean', globs: '["src/auth/**"]', status: 'Reserved' }),
};

// The new hub record the person drafts in hub SCR.
const DRAFT = (globs = '["src/auth/**"]', alwaysApply = false) => adr({ n: '031', title: 'auth-service issues tokens with library A', globs, alwaysApply, rule: 'MUST issue tokens with library A.' });
const DRAFT_PATH = 'docs/architecture/ADR-031-token-library-a.md';

const registry = (entries) => `${JSON.stringify({ schema_version: 1, repositories: Object.fromEntries(Object.entries(entries).map(([id, url]) => [id, { url, checks: 'checks.env', purpose: `${id}: a service of the estate.`, readAt: '0'.repeat(40), trunk: 'default' }])) }, null, 2)}\n`;

/**
 * The common estate: hub SCR with auth-service and scr-web listed, and the
 * sibling hub SIM on the host. `opts` changes one part:
 *   auth, web     the spokes' files; null for a remote that does not exist
 *   sim           the sibling's files; null for a sibling that does not exist
 *   prefix        the hub's key prefix; null for no ledger
 *   origin        false for a hub with no origin remote
 *   draft         the draft's text; null for no draft
 */
function estate(root, opts = {}) {
  const o = { auth: AUTH(), web: WEB(), sim: SIM_HUB, prefix: 'SCR', origin: true, draft: DRAFT(), ...opts };
  const url = (name, files) => (files === null ? join(root, 'acme', `${name}.git`) : makeRemote(root, name, files));
  const repos = { 'auth-service': url('auth-service', o.auth), 'scr-web': url('scr-web', o.web) };
  if (o.sim !== null) makeRemote(root, 'sim-hub', o.sim);
  const hub = join(root, 'scr-hub');
  mkdirSync(hub, { recursive: true });
  git(hub, ['init', '-q', '--initial-branch', 'main']);
  if (o.origin) git(hub, ['remote', 'add', 'origin', join(root, 'acme', 'scr-hub.git')]);
  writeFiles(hub, {
    'docs/estate/repositories.json': registry(repos),
    ...(o.prefix === null ? {} : { 'docs/backlog/keys.json': `${JSON.stringify({ prefix: o.prefix, next: 32 })}\n` }),
    ...(o.draft === null ? {} : { [DRAFT_PATH]: o.draft }),
  });
  return hub;
}

const SIBLINGS = ['--siblings', DRAFT_PATH];

/* ------------------------------------------------------------------- fixtures */

// `build(root)` returns { hub, args, env?, expect? }. `expect(stdout)` returns extra problems.
const FIXTURES = [
  {
    n: 1,
    name: 'valid control, --siblings: the draft covers the shared auth-service, so SIM is read; its overlapping record and its always-on standard print in full, the rest as index lines',
    build: (root) => ({
      hub: estate(root),
      args: SIBLINGS,
      expect: (out) => {
        const problems = [];
        if (!out.includes('MUST issue tokens with library B.')) problems.push('the body of SIM ADR-044 is not printed');
        if (!out.includes('MUST expire a token after 15 minutes.')) problems.push('the body of SIM ADR-003, which has no globs, is not printed');
        if (out.includes('Tokens with library C')) problems.push('a superseded record was printed');
        if (out.includes('Write Rust with clippy clean')) problems.push('a reserved standard was printed');
        return problems;
      },
    }),
    exit: 0,
    includes: [
      'Hub: SCR', 'Document: ADR-031 (adr) · globs ["src/auth/**"]', 'Spokes: 2 listed',
      'auth-service at ', 'covered (1 path(s), for example src/auth/token.ts); HUBS SCR acme/scr-hub, SIM acme/sim-hub',
      'scr-web at ', ': not covered',
      'Siblings: SIM acme/sim-hub (shares auth-service)',
      '=== Sibling: SIM acme/sim-hub at ', '(trunk main), sharing auth-service',
      'Records and standards: 4 binding; 3 cover a path this document covers, are always on, or have no globs',
      '--- SIM ADR-003 · adr · Accepted · no globs: read by name',
      '--- SIM ADR-044 · adr · Accepted · covers auth-service:src/auth/token.ts', 'Cite: acme/sim-hub@',
      '--- SIM std-logging · standard · Active · always on',
      '- SIM ADR-001 · adr · Accepted · The simulator runs offline',
      'Read: 1 sibling hub(s); skipped 0; cannot verify 0',
    ],
    excludes: ['CANNOT VERIFY', 'Skipped:'],
  },
  {
    n: 2,
    name: 'valid control, --repos: every hub the HUBS lines name, once, in order, as the exception\'s hubs header',
    build: (root) => ({ hub: estate(root), args: ['--repos', 'auth-service,scr-web'] }),
    exit: 0,
    includes: ['Hub: SCR', 'Repository: auth-service at ', '(trunk main): HUBS SCR acme/scr-hub, SIM acme/sim-hub', 'Repository: scr-web at ', 'hubs: ["SCR","SIM"]'],
    excludes: ['FAIL', 'CANNOT VERIFY'],
  },
  {
    n: 3,
    name: '--repos: a repository whose HUBS line does not name this hub: exit 1, and no hubs line',
    build: (root) => ({ hub: estate(root, { web: WEB('SIM acme/sim-hub') }), args: ['--repos', 'auth-service,scr-web'] }),
    exit: 1,
    includes: ['FAIL: scr-web: HUBS at ', 'lists SIM, and not this hub\'s prefix SCR', 'Run the spoke install from this hub first'],
    excludes: ['hubs: ['],
  },
  {
    n: 4,
    name: '--repos: a malformed HUBS line: exit 1, naming the entry',
    build: (root) => ({ hub: estate(root, { web: WEB('SCR scr-hub') }), args: ['--repos', 'scr-web'] }),
    exit: 1,
    includes: ['FAIL: scr-web: checks.env at ', 'the HUBS entry "SCR scr-hub" is not "<PREFIX> <owner>/<repo>"'],
    excludes: ['hubs: ['],
  },
  {
    n: 5,
    name: '--repos: HUBS is UNRESOLVED: nothing says which hubs own the repository, exit 2',
    build: (root) => ({ hub: estate(root, { web: WEB('UNRESOLVED') }), args: ['--repos', 'scr-web'] }),
    exit: 2,
    includes: ['CANNOT VERIFY: scr-web: checks.env at ', 'has no HUBS line, or it is empty or UNRESOLVED'],
    excludes: ['hubs: ['],
  },
  {
    n: 6,
    name: '--repos: no checks.env on the trunk: the spoke is not installed, exit 2',
    build: (root) => ({ hub: estate(root, { web: { 'src/web/page.ts': 'export {};\n' } }), args: ['--repos', 'scr-web'] }),
    exit: 2,
    includes: ['CANNOT VERIFY: scr-web: checks.env is not on its trunk at ', 'The spoke install writes the file'],
  },
  {
    n: 7,
    name: '--repos: one repository does not answer: exit 2, and the other is still read',
    build: (root) => ({ hub: estate(root, { web: null }), args: ['--repos', 'auth-service,scr-web'] }),
    exit: 2,
    includes: ['Repository: auth-service at ', 'CANNOT VERIFY: scr-web: cannot reach ', 'REASON: remote-unreachable'],
    excludes: ['hubs: ['],
  },
  {
    n: 8,
    name: '--repos: a repository the registry does not list: a usage error',
    build: (root) => ({ hub: estate(root), args: ['--repos', 'auth-service,billing'] }),
    exit: 3,
    includes: ['"billing" is not in docs/estate/repositories.json', 'Listed: auth-service, scr-web'],
  },
  {
    n: 9,
    name: '--repos with --skip-hub: a usage error',
    build: (root) => ({ hub: estate(root), args: ['--repos', 'auth-service', '--skip-hub', 'SIM=no access'] }),
    exit: 3,
    includes: ['--skip-hub belongs to --siblings'],
  },
  {
    n: 10,
    name: '--repos: a hub with no key ledger yet: the hubs line is printed, with a note that this hub could not be checked',
    build: (root) => ({ hub: estate(root, { prefix: null }), args: ['--repos', 'auth-service'] }),
    exit: 0,
    includes: ['Hub: no key prefix in docs/backlog/keys.json', 'hubs: ["SCR","SIM"]', 'NOTE: this hub has no key prefix'],
  },
  {
    n: 11,
    name: '--siblings: the draft covers only scr-web, which no other hub owns: no sibling read, exit 0',
    build: (root) => ({ hub: estate(root, { draft: DRAFT('["src/web/**"]') }), args: SIBLINGS }),
    exit: 0,
    includes: ['auth-service at ', ': not covered', 'scr-web at ', 'HUBS SCR acme/scr-hub', 'Siblings: none. No covered spoke names another hub.', 'Read: 0 sibling hub(s)'],
    excludes: ['=== Sibling'],
  },
  {
    n: 12,
    name: '--siblings: a draft with no globs that is not always on covers no spoke, and no remote is asked',
    build: (root) => ({ hub: estate(root, { draft: DRAFT('[]'), auth: null, web: null, sim: null }), args: SIBLINGS }),
    exit: 0,
    includes: ['No spoke covered: the document has no globs and is not always on'],
    excludes: ['CANNOT VERIFY', 'Spokes:'],
  },
  {
    n: 13,
    name: '--siblings: an always-on draft covers every spoke, so the shared one brings SIM in',
    build: (root) => ({ hub: estate(root, { draft: DRAFT('[]', true) }), args: SIBLINGS }),
    exit: 0,
    includes: ['Document: ADR-031 (adr) · always on', 'scr-web at ', 'Siblings: SIM acme/sim-hub (shares auth-service)', '--- SIM ADR-044 · adr · Accepted · covers auth-service:'],
  },
  {
    n: 14,
    name: '--siblings: the sibling hub cannot be read with the person\'s access: exit 2, naming the hub and the way to skip it',
    build: (root) => ({ hub: estate(root, { sim: null }), args: SIBLINGS }),
    exit: 2,
    includes: ['Siblings: SIM acme/sim-hub (shares auth-service)', 'CANNOT VERIFY: the sibling hub SIM acme/sim-hub cannot be read with your access', 'pass --skip-hub "SIM=<reason>"', 'cannot verify 1'],
    excludes: ['=== Sibling'],
  },
  {
    n: 15,
    name: '--siblings --skip-hub with a reason: the sibling is not read, the reason is printed for the pull request, exit 0',
    build: (root) => ({ hub: estate(root, { sim: null }), args: [...SIBLINGS, '--skip-hub', 'SIM=the SIM hub is private to the simulator team'] }),
    exit: 0,
    includes: ['Skipped: SIM acme/sim-hub — the SIM hub is private to the simulator team', 'Read: 0 sibling hub(s); skipped 1; cannot verify 0'],
    excludes: ['CANNOT VERIFY', '=== Sibling'],
  },
  {
    n: 16,
    name: '--siblings --skip-hub with no reason: a usage error, because the reviewer must see why the check did not run',
    build: (root) => ({ hub: estate(root), args: [...SIBLINGS, '--skip-hub', 'SIM'] }),
    exit: 3,
    includes: ['--skip-hub SIM needs a reason'],
  },
  {
    n: 17,
    name: '--siblings --skip-hub with a placeholder reason: a usage error',
    build: (root) => ({ hub: estate(root), args: [...SIBLINGS, '--skip-hub', 'SIM=TBD'] }),
    exit: 3,
    includes: ['--skip-hub SIM needs a reason'],
  },
  {
    n: 18,
    name: '--siblings --skip-hub for a hub that is not a sibling: a note, nothing skipped, and SIM is still read',
    build: (root) => ({ hub: estate(root), args: [...SIBLINGS, '--skip-hub', 'TAL=not ours'] }),
    exit: 0,
    includes: ['NOTE: --skip-hub TAL: TAL is not a sibling hub', '=== Sibling: SIM'],
    excludes: ['Skipped:'],
  },
  {
    n: 19,
    name: '--siblings: no origin remote and no HARNESS_HUB_BASE: the sibling\'s URL cannot be derived, exit 2',
    build: (root) => ({ hub: estate(root, { origin: false }), args: SIBLINGS }),
    exit: 2,
    includes: ['CANNOT VERIFY: the sibling hub SIM acme/sim-hub: cannot derive its URL', 'Set HARNESS_HUB_BASE'],
  },
  {
    n: 20,
    name: '--siblings: HARNESS_HUB_BASE places the sibling where the hub has no origin to derive it from',
    build: (root) => ({ hub: estate(root, { origin: false }), args: SIBLINGS, env: { HARNESS_HUB_BASE: root } }),
    exit: 0,
    includes: ['=== Sibling: SIM acme/sim-hub at ', '--- SIM ADR-044'],
  },
  {
    n: 21,
    name: '--siblings: a covered spoke with no HUBS line: a note, no sibling, exit 0',
    build: (root) => ({ hub: estate(root, { auth: AUTH(null) }), args: SIBLINGS }),
    exit: 0,
    includes: ['HUBS NOT CONFIGURED, so no other hub is known', 'NOTE: auth-service has no HUBS line on its trunk', 'Siblings: none.'],
  },
  {
    n: 22,
    name: '--siblings: a covered spoke with a malformed HUBS line: its hubs are unknown, exit 2',
    build: (root) => ({ hub: estate(root, { auth: AUTH('SCR acme/scr-hub, SIM') }), args: SIBLINGS }),
    exit: 2,
    includes: ['CANNOT VERIFY: auth-service: HUBS at ', 'is malformed, so the hubs that own it are unknown'],
  },
  {
    n: 23,
    name: '--siblings: a spoke does not answer: exit 2, and the shared spoke is still read',
    build: (root) => ({ hub: estate(root, { web: null }), args: SIBLINGS }),
    exit: 2,
    includes: ['CANNOT VERIFY: scr-web: cannot reach ', '=== Sibling: SIM', 'REASON: remote-unreachable'],
  },
  {
    n: 24,
    name: '--siblings: a draft that does not parse: exit 1, because its globs cannot be trusted',
    build: (root) => ({ hub: estate(root, { draft: DRAFT().replace('status: Accepted\n', '') }), args: SIBLINGS }),
    exit: 1,
    includes: ['FAIL: the document does not parse'],
    excludes: ['Spokes:'],
  },
  {
    n: 25,
    name: '--siblings: a hub with no key ledger is still told apart from its sibling by its origin\'s owner/repo',
    build: (root) => ({ hub: estate(root, { prefix: null }), args: SIBLINGS }),
    exit: 0,
    includes: ['Hub: no key prefix in docs/backlog/keys.json', 'Siblings: SIM acme/sim-hub (shares auth-service)'],
    excludes: ['Siblings: SCR', '=== Sibling: SCR'],
  },
  {
    n: 26,
    name: 'no arguments: a usage error',
    build: (root) => ({ hub: estate(root), args: [] }),
    exit: 3,
    includes: ['say what to read: --repos <id,id,...> or --siblings <document>', 'usage: node '],
  },
  {
    n: 27,
    name: 'both --repos and --siblings: a usage error',
    build: (root) => ({ hub: estate(root), args: ['--repos', 'auth-service', ...SIBLINGS] }),
    exit: 3,
    includes: ['say what to read'],
  },
];

/* ---------------------------------------------------------------------- runner */

function runFixture(fixture) {
  const root = mkdtempSync(join(tmpdir(), `readhubs-fx${String(fixture.n).padStart(2, '0')}-`));
  try {
    const built = fixture.build(root);
    const env = { ...ENV, HARNESS_SPOKE_CACHE: join(root, 'cache'), ...(built.env || {}) };
    const res = spawnSync(process.execPath, [SCRIPT, ...built.args], { cwd: built.hub, env, encoding: 'utf8' });
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
  const wanted = process.argv.slice(2).filter((a) => a.match(/^\d+$/)).map(Number);
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
    ? `\n${failed} of ${selected.length} fixtures FAILED. The hubs an exception names, and the sibling hubs a record is checked against, are not trustworthy until this is green.\n`
    : `\nAll ${selected.length} fixtures passed.\n`);
  rmSync(SANDBOX_HOME, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
}

main();

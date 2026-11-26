#!/usr/bin/env node
/**
 * run.mjs — the fixture suite for report-global.mjs, the scheduled report of how
 * far a hub is behind the global context repository.
 *
 *   usage:  node run.mjs            run every fixture
 *           node run.mjs 2 6        run only the numbered fixtures
 *           node run.mjs --keep     leave the throwaway repositories on disk
 *
 * A fixture is a REPOSITORY STATE: a throwaway hub with a real bare origin at
 * `<root>/acme/scr-hub.git`, its records, requirements documents, stories and
 * reports on the trunk, and `requirements/<slug>` branches beside it; a real bare
 * global remote with a trunk and release tags; real bare spoke remotes whose
 * checks.env carries a HUBS line; and, where a fixture says so, a real bare
 * sibling hub that the script must never read. The shipped script is run from
 * the hub as the `global-report` workflow runs it. The exit code and the output
 * text are asserted. Fixture 1 is the valid control. Most others change one
 * thing. Every fixture runs under a private HOME, so a developer's gitconfig
 * cannot change a result, and with its own bare cache, so no fixture reads
 * another's.
 *
 * Node standard library only, plus git via child_process. No test framework.
 * Exit 0 if every fixture passes, 1 if any fails.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

const SCRIPT = [
  process.env.HARNESS_REPORT_GLOBAL,
  resolve(HERE, '..', '..', 'report-global.mjs'),
  resolve(HERE, '..', '..', 'scripts', 'report-global.mjs'),
].filter(Boolean).find((p) => existsSync(p));

if (!SCRIPT) {
  console.error('cannot locate report-global.mjs. Set HARNESS_REPORT_GLOBAL=/path/to/report-global.mjs.');
  process.exit(4);
}

/* ------------------------------------------------------------------ git helpers */

const SANDBOX_HOME = mkdtempSync(join(tmpdir(), 'reportglobal-home-'));
const ENV = {
  ...process.env,
  HOME: SANDBOX_HOME,
  XDG_CONFIG_HOME: join(SANDBOX_HOME, '.config'),
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
  GIT_ASKPASS: 'true',
};
for (const name of ['HARNESS_TRUNK', 'HARNESS_GLOBAL', 'HARNESS_REGISTRY', 'HARNESS_HUB_BASE', 'HARNESS_SPOKE_CACHE']) delete ENV[name];

function git(cwd, args) {
  return execFileSync('git', args, { cwd, env: ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** Write each file. A null body removes the file. */
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

function initWork(work, trunk) {
  git(dirname(work), ['init', '-q', '--initial-branch', trunk, work]);
  git(work, ['config', 'user.name', 'Fixture Runner']);
  git(work, ['config', 'user.email', 'fixture@example.invalid']);
  git(work, ['config', 'commit.gpgsign', 'false']);
  git(work, ['config', 'tag.gpgsign', 'false']);
}

function initBare(bare, trunk) {
  mkdirSync(dirname(bare), { recursive: true });
  git(dirname(bare), ['init', '--bare', '-q', '--initial-branch', trunk, bare]);
  git(dirname(bare), ['--git-dir', bare, 'symbolic-ref', 'HEAD', `refs/heads/${trunk}`]);
}

function commitAll(work, message) {
  git(work, ['add', '-A']);
  git(work, ['commit', '-q', '--allow-empty', '-m', message]);
  return git(work, ['rev-parse', 'HEAD']).trim();
}

/**
 * The global remote: one commit per element of `commits`, each a map of files
 * (null removes one), and `tags` naming the commit index each release tags.
 */
function makeGlobal(root, { commits, tags = {} }) {
  const bare = join(root, 'global-context.git');
  const work = join(root, 'work', 'global-context');
  initBare(bare, 'main');
  mkdirSync(dirname(work), { recursive: true });
  initWork(work, 'main');
  const shas = commits.map((files, i) => {
    writeFiles(work, files);
    return commitAll(work, `global ${i + 1}`);
  });
  git(work, ['push', '-q', bare, 'main']);
  for (const [name, i] of Object.entries(tags)) {
    git(work, ['tag', name, shas[i]]);
    git(work, ['push', '-q', bare, `refs/tags/${name}`]);
  }
  return { url: bare, bare, work, shas };
}

/** One commit on a side branch of the global remote, pushed and never merged. Returns its hash. */
function globalSide(g, files) {
  git(g.work, ['checkout', '-q', '-b', 'board/try', g.shas[g.shas.length - 1]]);
  writeFiles(g.work, files);
  const sha = commitAll(g.work, 'on a side branch');
  git(g.work, ['push', '-q', g.bare, 'board/try']);
  git(g.work, ['checkout', '-q', 'main']);
  return sha;
}

/** A bare remote at `<root>/acme/<name>.git` whose trunk carries `files`. Returns its URL. */
function makeRemote(root, name, files, { trunk = 'main' } = {}) {
  const bare = join(root, 'acme', `${name}.git`);
  const work = join(root, 'work', name);
  initBare(bare, trunk);
  mkdirSync(dirname(work), { recursive: true });
  initWork(work, trunk);
  writeFiles(work, files);
  commitAll(work, 'trunk');
  git(work, ['push', '-q', bare, trunk]);
  return bare;
}

/**
 * The hub: a work clone at `<root>/hub` with the origin `<root>/acme/scr-hub.git`.
 * `files` is the trunk. `branches` maps a branch name to the files it adds on top
 * of the trunk. `unpushed` is committed on the trunk and never pushed.
 * `working` is written into the working tree and never committed.
 */
function makeHub(root, files, { trunk = 'main', branches = {}, unpushed = null, working = null, origin = true } = {}) {
  const bare = join(root, 'acme', 'scr-hub.git');
  const work = join(root, 'hub');
  initWork(work, trunk);
  if (origin) {
    initBare(bare, trunk);
    git(work, ['remote', 'add', 'origin', bare]);
  } else {
    git(work, ['remote', 'add', 'origin', join(root, 'acme', 'no-such-hub.git')]);
  }
  writeFiles(work, files);
  commitAll(work, 'hub trunk');
  if (origin) git(work, ['push', '-q', 'origin', trunk]);
  for (const [branch, extra] of Object.entries(origin ? branches : {})) {
    git(work, ['checkout', '-q', '-b', branch]);
    writeFiles(work, extra);
    commitAll(work, `on ${branch}`);
    git(work, ['push', '-q', 'origin', branch]);
    git(work, ['checkout', '-q', trunk]);
  }
  if (unpushed) {
    writeFiles(work, unpushed);
    commitAll(work, 'not pushed');
  }
  if (working) writeFiles(work, working);
  return work;
}

/* -------------------------------------------------------------- the content */

const slugOf = (title) => title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30);

/** A decision record, in the hub's or the global repository's records folder. */
const adr = ({ n, title, globs = '[]', status = 'Accepted', alwaysApply = false, description = title }) => ({
  [`docs/architecture/ADR-${n}-${slugOf(title)}.md`]: `---\n${[
    `name: ADR-${n}`, `description: ${description}`, `globs: ${globs}`, `alwaysApply: ${alwaysApply}`, 'kind: adr', `status: ${status}`,
    'owner: lead architect', 'revision: v1', 'origin: architecture minutes',
  ].join('\n')}\n---\n\n${[
    `# ADR-${n}: ${title}`, '', '## Decision', '', title, '', '## Rules', '', '- MUST follow the decision.', '',
    '## Why', '', 'Recorded for the fixture.', '', '## Rejected', '', '- None.', '', '## Accepted costs', '', '- None.', '',
  ].join('\n')}`,
});

const SECTIONS = ['Applies to', 'Must', 'Should', 'Values', 'Checked by', 'Relations', 'Exceptions', 'Unresolved', 'Origin'];
const standard = ({ topic, title, globs = '[]', alwaysApply = false, status = 'Active' }) => ({
  [`docs/standards/std-${topic}.md`]: `---\n${[
    `name: std-${topic}`, `description: ${title}`, `globs: ${globs}`, `alwaysApply: ${alwaysApply}`, 'kind: standard', `status: ${status}`,
    'owner: platform team', 'revision: 2026-01', 'origin: client intranet',
  ].join('\n')}\n---\n\n${[
    `# std-${topic}: ${title}`, '',
    ...SECTIONS.flatMap((h) => [`## ${h}`, '', h === 'Must' ? `- **std-${topic}.01** MUST ${title.toLowerCase()}. *(Source: §1)*` : h === 'Should' || h === 'Unresolved' ? 'None.' : 'Stated for the fixture.', '']),
  ].join('\n')}`,
});

const exception = ({ n, hubs = '["SCR"]', status = 'Active', reviewBy = '2099-01-01', repositories = '["auth-service"]', departs = '["ADR-012"]' }) => ({
  [`docs/exceptions/EXC-${n}-departure.md`]: `---\n${[
    `name: EXC-${n}`, `description: Exception ${n} lets a product depart from a global record.`, 'kind: exception',
    `hubs: ${hubs}`, `repositories: ${repositories}`, `departs: ${departs}`, `status: ${status}`, `review-by: ${reviewBy}`,
    'owner: product tech lead', 'approver: Global Architecture Board', 'revision: v1', 'origin: this repository',
  ].join('\n')}\n---\n\n${[
    `# EXC-${n} — a departure for the fixture`, '', '## Reason', '', 'The product cannot follow the record.', '',
    '## Scope', '', 'Only the session cache.', '', '## Alternatives considered', '', '- Comply. Rejected: it does not run offline.', '',
    '## What the product does instead', '', 'Hub record ADR-031 states the decision.', '', '## Exit', '', 'A network mode.', '',
  ].join('\n')}`,
});

const REDIS = 'Use only Redis for caching';

// The global repository of the control: v1.0.0, then v1.1.0 adds ADR-013,
// supersedes ADR-011, changes std-go and removes ADR-009.
const GLOBAL_V1 = {
  ...adr({ n: '009', title: 'Keep a changelog' }),
  ...adr({ n: '011', title: 'Issue tokens with library C' }),
  ...adr({ n: '012', title: REDIS, globs: '["**/cache/**"]' }),
  ...standard({ topic: 'go', title: 'Write Go with vet clean', globs: '["**/*.go"]' }),
  ...exception({ n: '004', reviewBy: '2020-01-01' }),
  ...exception({ n: '005', reviewBy: '2099-01-01' }),
};
const GLOBAL_V11 = {
  'docs/architecture/ADR-009-keep-a-changelog.md': null,
  ...adr({ n: '011', title: 'Issue tokens with library C', status: 'Superseded by ADR-013' }),
  ...adr({ n: '013', title: 'Issue tokens with library A' }),
  ...standard({ topic: 'go', title: 'Write Go with vet and staticcheck clean', globs: '["**/*.go"]' }),
};

const link = (url) => `${JSON.stringify({ schema_version: 1, url }, null, 2)}\n`;
const KEYS = (prefix = 'SCR') => ({ 'docs/backlog/keys.json': `${JSON.stringify({ schema_version: 1, prefix, next: 10, blocks: [] })}\n` });

/** A requirements document. `release` is "<tag> <commit>", "none", or null for no Global: line. */
const requirements = (slug, release) => ({
  [`docs/requirements/${slug}/requirements.md`]: `# ${slug}: something must become true\n\n| Slug | \`${slug}\` |\n|---|---|\n\n${release === null ? '' : `Global: ${release}\n`}`,
});

/** A decomposed feature: the record, one item per key, and a report per key that has a verdict list. */
const feature = (slug, stories) => {
  const files = { [`docs/backlog/${slug}.decomposition.md`]: `# Decomposition — ${slug}\n` };
  for (const [key, verdicts] of Object.entries(stories)) {
    files[`docs/backlog/${slug}/${key}.item.md`] = `Key: ${key}\nRepository: auth-service\n`;
    if (verdicts !== null) {
      files[`docs/designs/${key}.validation.md`] = `# Validation — ${key}\n\n| AC | Criterion (short) | Requirement | Verdict | Evidence |\n|---|---|---|---|---|\n${verdicts.map((v, i) => `| AC-${i + 1} | criterion ${i + 1} | REQ-1.AC-${i + 1} | ${v} | the test |`).join('\n')}\n`;
    }
  }
  return files;
};

const CHECKS = (hubs) => ['TEST_COMMAND=node --test', 'TRUNK_FOR_HUB=default', ...(hubs === null ? [] : [`HUBS=${hubs}`]), 'STORY_GATE_EXCEPTION=^harness/', ''].join('\n');
const SHARED = 'SCR acme/scr-hub, SIM acme/sim-hub';

const registry = (entries) => `${JSON.stringify({ schema_version: 1, repositories: Object.fromEntries(Object.entries(entries).map(([id, url]) => [id, { url, checks: 'checks.env', purpose: `${id}: a service of the estate.`, readAt: '0'.repeat(40), trunk: 'default' }])) }, null, 2)}\n`;

// This hub's records and standards: one superseded by a global record, one that
// carries a global record's title, one whose globs cover the shared spoke, one
// always-on standard, and one record with no globs.
const HUB_RECORDS = {
  ...adr({ n: '020', title: 'Cache only in Redis', status: 'Superseded by global.ADR-012' }),
  ...adr({ n: '021', title: REDIS }),
  ...adr({ n: '022', title: 'auth-service issues tokens with library A', globs: '["src/auth/**"]' }),
  ...adr({ n: '023', title: 'Every token lives 15 minutes' }),
  ...standard({ topic: 'logging', title: 'Log in JSON lines', alwaysApply: true }),
};

/**
 * The common estate. Builds the global remote, the spokes and the hub, and
 * returns { hub, g, urls }. `opts` changes one part:
 *   global        { commits, tags } for the global remote
 *   link          the text of docs/estate/global.json, a function of the global URL, or null for none
 *   hubFiles      a function (g, urls) => files added to the hub's trunk; a null body removes a default
 *   spokes        { id: files | null } for the spoke remotes; null lists one that does not exist
 *   hubOpts       passed to makeHub
 */
function estate(root, opts = {}) {
  const g = makeGlobal(root, opts.global || { commits: [GLOBAL_V1, GLOBAL_V11], tags: { 'v1.0.0': 0, 'v1.1.0': 1 } });
  const spokes = opts.spokes || {
    'auth-service': { 'checks.env': CHECKS(SHARED), 'src/auth/token.ts': 'export {};\n' },
    'scr-web': { 'checks.env': CHECKS('SCR acme/scr-hub'), 'src/web/page.ts': 'export {};\n' },
  };
  const urls = {};
  for (const [id, files] of Object.entries(spokes)) urls[id] = files === null ? join(root, 'acme', `${id}-gone.git`) : makeRemote(root, id, files);
  const v10 = `v1.0.0 ${g.shas[0]}`;
  const v11 = `v1.1.0 ${g.shas[1]}`;
  const linkText = opts.link === undefined ? link(g.url) : typeof opts.link === 'function' ? opts.link(g.url) : opts.link;
  const files = {
    ...KEYS(),
    ...(linkText === null ? {} : { 'docs/estate/global.json': linkText }),
    'docs/estate/repositories.json': registry(urls),
    'docs/architecture/_TEMPLATE.adr.md': '# ADR-<NNN>: <state the decision>\n',
    ...HUB_RECORDS,
    ...requirements('alpha', v10),
    ...feature('alpha', { 'SCR-1': ['PASS'] }),
    ...requirements('beta', v10),
    ...feature('beta', { 'SCR-2': ['PASS', 'FAIL'] }),
    ...requirements('gamma', null),
    ...(opts.hubFiles ? opts.hubFiles(g, urls) : {}),
  };
  for (const [k, v] of Object.entries(files)) if (v === null) delete files[k];
  const hubOpts = { branches: { 'requirements/delta': requirements('delta', v11) }, ...(opts.hubOpts || {}) };
  const hub = makeHub(root, files, hubOpts);
  return { hub, g, urls };
}

const TODAY = new Date().toISOString().slice(0, 10);

/* ------------------------------------------------------------------- fixtures */

// `build(root)` returns { hub, env?, expect? }. `expect(stdout, root)` returns extra problems.
const FIXTURES = [
  {
    n: 1,
    name: 'valid control: all five sections, from the hub trunk and the newest release',
    build: (root) => {
      const { hub, g } = estate(root);
      return {
        hub,
        expect: (out) => {
          const problems = [];
          if (!out.includes(`Global: v1.1.0 ${g.shas[1]}\n`)) problems.push('the newest release and its commit are not printed');
          if (!out.includes(`Baseline: v1.0.0 ${g.shas[0]}, the highest release that a requirements document on the trunk records (alpha, beta).`)) problems.push('the baseline is not v1.0.0 from alpha and beta');
          const cached = readdirSync(join(root, 'cache')).sort().join(',');
          if (cached !== 'auth-service.git,global.git,scr-web.git') problems.push(`the cache holds ${cached}, not only the global repository and the two listed spokes`);
          return problems;
        },
      };
    },
    exit: 0,
    includes: [
      'Report: the hub at origin/main ', 'Hub: SCR',
      'Documents: 6 at v1.1.0: 3 record(s), 1 standard(s), 2 exception(s)',
      '== 1. Global documents added, changed, superseded or removed',
      '- superseded global.ADR-011 · adr · Superseded by ADR-013 (was Accepted) · Issue tokens with library C',
      '- added global.ADR-013 · adr · Accepted · Issue tokens with library A',
      '- changed global.std-go · standard · Active · Write Go with vet and staticcheck clean',
      '- removed global.ADR-009 · adr · was Accepted · Keep a changelog',
      '- ADR-020 · docs/architecture/ADR-020-cache-only-in-redis.md · Superseded by global.ADR-012. global.ADR-012 is Accepted at v1.1.0',
      'Superseded by a global record: 1 hub record(s).',
      `- ADR-021 (docs/architecture/ADR-021-use-only-redis-for-caching.md) and global.ADR-012 carry the same title: "${REDIS}"`,
      'Candidates: 1. A candidate is not a finding.', 'Run /check-global for the judgement.',
      `== 3. Active exceptions that name this hub and are past their review-by date (today: ${TODAY}, UTC)`,
      '- global.EXC-004 · review-by 2020-01-01 · departs global.ADR-012 · repositories auth-service',
      'Past review-by: 1 of 2 Active exception(s) that name SCR.',
      '== 4. Open features whose Global: line is behind v1.1.0',
      '- beta (merged, 0 of 1 stories validated): Global: v1.0.0, behind v1.1.0',
      '- gamma (merged, not decomposed yet): Global: none, behind v1.1.0',
      'Behind: 2 of 3 open feature(s), 2 merged and 1 on a branch.',
      "- auth-service at ", ": shared with SIM acme/sim-hub. This hub's binding records and standards that cover it: 2",
      '    ADR-022 · adr · covers src/auth/token.ts · auth-service issues tokens with library A',
      '    std-logging · standard · always on · Log in JSON lines',
      ': not shared, HUBS names only this hub',
      'Shared: 1 spoke(s). The report reads no sibling hub.',
      'Summary: 4 global change(s) since the baseline, 1 hub record(s) superseded by a global record, 1 candidate(s) for /check-global, 1 exception(s) past review-by, 2 open feature(s) behind, 1 shared spoke(s).',
    ],
    excludes: ['- alpha (', '- delta (', 'ADR-023 ·', 'EXC-005 ·', 'CANNOT VERIFY', 'NOTE:', 'ADR-020 (docs'],
  },
  {
    n: 2,
    name: 'no docs/estate/global.json on the trunk: Global: none, and nothing else is read or printed',
    build: (root) => {
      const { hub } = estate(root, { link: null });
      return { hub, expect: (_out, r) => (existsSync(join(r, 'cache', 'global.git')) ? ['the global repository was read'] : []) };
    },
    exit: 0,
    includes: ['Global: none'],
    excludes: ['Report:', '== ', 'CANNOT VERIFY'],
  },
  {
    n: 3,
    name: 'global.json in the working tree but not on the trunk: the report reads the trunk, so Global: none',
    build: (root) => {
      const g0 = join(root, 'global-context.git');
      const { hub } = estate(root, { link: null, hubOpts: { working: { 'docs/estate/global.json': link(g0) } } });
      return { hub };
    },
    exit: 0,
    includes: ['Global: none'],
    excludes: ['Report:', '== '],
  },
  {
    n: 4,
    name: 'the global repository does not answer: exit 2, and the hub sections are still printed',
    build: (root) => ({ hub: estate(root, { link: () => link(join(root, 'no-such-global.git')) }).hub }),
    exit: 2,
    includes: [
      'Global: cannot be read', 'Not read: the global repository cannot be read.',
      '- ADR-020 · docs/architecture/ADR-020-cache-only-in-redis.md · Superseded by global.ADR-012\n',
      'Candidates: the global repository cannot be read.',
      ': shared with SIM acme/sim-hub.',
      'CANNOT VERIFY: the global repository: cannot reach ', 'no-such-global.git',
    ],
    excludes: ['Baseline:'],
  },
  {
    n: 5,
    name: 'global.json on the trunk is not well formed: exit 2, and the hub sections are still printed',
    build: (root) => ({ hub: estate(root, { link: () => `${JSON.stringify({ schema_version: 1, url: 'https://example.invalid/g.git', branch: 'main' })}\n` }).hub }),
    exit: 2,
    includes: [
      'Not read: docs/estate/global.json on the trunk is not well formed.',
      'CANNOT VERIFY: docs/estate/global.json is not well formed', 'unknown root field "branch"',
      'requirements-gate refuses every requirements document while the link is not well formed',
      'Shared: 1 spoke(s).',
    ],
    excludes: ['Global repository:'],
  },
  {
    n: 6,
    name: 'the global trunk carries no release tag: nothing binds yet, and the report is complete',
    build: (root) => ({ hub: estate(root, { global: { commits: [GLOBAL_V1, GLOBAL_V11], tags: { 'v1.0.0-rc.1': 0 } } }).hub }),
    exit: 0,
    includes: [
      'Release tags: none on the trunk', 'Global: no release tag on the trunk, so nothing in the global repository binds yet',
      'None: the global repository has no release tag, so nothing in it binds yet.',
      'Candidates: the global repository has no release tag, so nothing in it binds yet.',
    ],
    excludes: ['Baseline:', 'CANNOT VERIFY'],
  },
  {
    n: 7,
    name: 'the baseline is the highest release recorded on the trunk, compared as numbers: v1.10.0 over v1.9.0',
    build: (root) => {
      const { hub, g } = estate(root, {
        global: { commits: [GLOBAL_V1, adr({ n: '014', title: 'Retry three times' }), GLOBAL_V11], tags: { 'v1.9.0': 0, 'v1.10.0': 1, 'v1.11.0': 2 } },
        hubFiles: (gl) => ({ ...requirements('alpha', `v1.9.0 ${gl.shas[0]}`), ...requirements('beta', `v1.10.0 ${gl.shas[1]}`) }),
      });
      return { hub, expect: (out) => (out.includes(`Baseline: v1.10.0 ${g.shas[1]}, the highest release that a requirements document on the trunk records (beta).`) ? [] : ['the baseline is not v1.10.0 from beta']) };
    },
    exit: 0,
    includes: ['- added global.ADR-013', '- beta (merged, 0 of 1 stories validated): Global: v1.10.0, behind v1.11.0'],
    excludes: ['- added global.ADR-014'],
  },
  {
    n: 8,
    name: 'no requirements document on the trunk records a release: the baseline is empty, and every document is added',
    build: (root) => ({ hub: estate(root, { hubFiles: () => ({ ...requirements('alpha', 'none'), ...requirements('beta', null) }) }).hub }),
    exit: 0,
    includes: [
      'Baseline: none. No requirements document on the trunk records a release, so every document at v1.1.0 is listed as added.',
      '- added global.ADR-011 · adr · Superseded by ADR-013', '- added global.ADR-012', '- added global.EXC-004', '- added global.std-go',
      'Summary: 6 global change(s) since the baseline',
    ],
    excludes: ['- removed'],
  },
  {
    n: 9,
    name: 'the baseline is the newest release: no change is listed',
    build: (root) => ({ hub: estate(root, { hubFiles: (g) => ({ ...requirements('alpha', `v1.1.0 ${g.shas[1]}`) }) }).hub }),
    exit: 0,
    includes: ['None: v1.1.0 holds the same documents as the baseline.', 'Summary: 0 global change(s) since the baseline'],
    excludes: ['- added', '- changed'],
  },
  {
    n: 10,
    name: 'a newer release on a requirements branch does not move the baseline: only the trunk counts',
    build: (root) => ({ hub: estate(root).hub }),
    exit: 0,
    includes: ['Baseline: v1.0.0 ', '- added global.ADR-013'],
    excludes: ['Baseline: v1.1.0', '(delta'],
  },
  {
    n: 11,
    name: 'the baseline commit is not on the global trunk: section 1 says so and compares nothing',
    build: (root) => {
      const r = estate(root, {
        global: { commits: [GLOBAL_V1, GLOBAL_V11], tags: { 'v1.0.0': 0, 'v1.1.0': 1 } },
        hubFiles: () => ({ ...requirements('alpha', `v1.0.5 ${'a'.repeat(40)}`) }),
      });
      return { hub: r.hub };
    },
    exit: 0,
    includes: [`Baseline: v1.0.5 ${'a'.repeat(40)}`, `Not compared: ${'a'.repeat(12)} is not on the global trunk.`],
    excludes: ['- added global'],
  },
  {
    n: 12,
    name: 'a hub record superseded by a global record that the newest release does not hold says so',
    build: (root) => ({ hub: estate(root, { hubFiles: () => adr({ n: '020', title: 'Cache only in Redis', status: 'Superseded by global.ADR-099' }) }).hub }),
    exit: 0,
    includes: ['Superseded by global.ADR-099. global.ADR-099 is not at v1.1.0'],
  },
  {
    n: 13,
    name: 'a candidate needs the same title word for word, on two Accepted records',
    build: (root) => ({
      hub: estate(root, {
        global: { commits: [{ ...GLOBAL_V1, ...adr({ n: '015', title: 'Issue tokens with library C', status: 'Superseded by ADR-012' }) }, GLOBAL_V11], tags: { 'v1.0.0': 0, 'v1.1.0': 1 } },
        hubFiles: () => ({
          ...adr({ n: '021', title: 'Use only redis for caching' }),
          ...adr({ n: '024', title: REDIS, status: 'Deprecated' }),
          ...adr({ n: '025', title: 'Issue tokens with library C' }),
        }),
      }).hub,
    }),
    exit: 0,
    includes: ['Candidates: 0. A candidate is not a finding.'],
    excludes: ['carry the same title'],
  },
  {
    n: 14,
    name: 'past review-by only: another hub, a withdrawn exception, today and a later date are not listed',
    build: (root) => ({
      hub: estate(root, {
        global: {
          commits: [{
            ...adr({ n: '012', title: REDIS }),
            ...exception({ n: '004', hubs: '["SIM"]', reviewBy: '2020-01-01' }),
            ...exception({ n: '005', status: 'Withdrawn', reviewBy: '2020-01-01' }),
            ...exception({ n: '006', reviewBy: TODAY }),
            ...exception({ n: '007', reviewBy: '2099-01-01' }),
          }],
          tags: { 'v1.0.0': 0 },
        },
        hubFiles: (g) => ({ ...requirements('alpha', `v1.0.0 ${g.shas[0]}`), ...requirements('beta', `v1.0.0 ${g.shas[0]}`) }),
      }).hub,
    }),
    exit: 0,
    includes: ['Past review-by: 0 of 2 Active exception(s) that name SCR.'],
    excludes: ['- global.EXC-'],
  },
  {
    n: 15,
    name: 'a hub with no key prefix: no exception can name it, and its HUBS entry is found by its origin',
    build: (root) => ({ hub: estate(root, { hubFiles: () => ({ 'docs/backlog/keys.json': null }) }).hub }),
    exit: 0,
    includes: ['Hub: no key prefix in docs/backlog/keys.json', 'None: this hub has no key prefix in docs/backlog/keys.json, so no exception can name it.', ': shared with SIM acme/sim-hub.', ': not shared, HUBS names only this hub'],
  },
  {
    n: 16,
    name: 'a feature is closed when every story has a report with no FAIL, and open while one story has none',
    build: (root) => ({
      hub: estate(root, {
        hubFiles: () => ({
          ...feature('alpha', { 'SCR-1': ['PASS', 'N/A'], 'SCR-3': ['PASS'] }),
          ...feature('beta', { 'SCR-2': ['PASS'], 'SCR-4': null }),
        }),
      }).hub,
    }),
    exit: 0,
    includes: ['- beta (merged, 1 of 2 stories validated): Global: v1.0.0, behind v1.1.0'],
    excludes: ['- alpha ('],
  },
  {
    n: 17,
    name: 'a decomposition record with no story cut yet keeps the feature open',
    build: (root) => ({ hub: estate(root, { hubFiles: () => ({ 'docs/backlog/alpha/SCR-1.item.md': null, 'docs/designs/SCR-1.validation.md': null }) }).hub }),
    exit: 0,
    includes: ['- alpha (merged, no story cut yet): Global: v1.0.0, behind v1.1.0'],
  },
  {
    n: 18,
    name: 'an open feature at the newest release is not behind, and a malformed Global: line is not compared',
    build: (root) => ({ hub: estate(root, { hubFiles: (g) => ({ ...requirements('beta', `v1.1.0 ${g.shas[1]}`), ...requirements('gamma', 'v1.1 latest') }) }).hub }),
    exit: 0,
    includes: ['- gamma (merged, not decomposed yet): its Global: line does not name one release, so requirements-gate refuses it. Not compared', 'Behind: 0 of 3 open feature(s)'],
    excludes: ['- beta ('],
  },
  {
    n: 19,
    name: 'requirements branches: one behind is listed, one identical to the trunk and one with no document are not',
    build: (root) => ({
      hub: estate(root, {
        hubOpts: {
          branches: {
            'requirements/epsilon': requirements('epsilon', null),
            'requirements/gamma': {},
            'requirements/zeta': { 'notes.md': 'nothing yet\n' },
          },
        },
      }).hub,
    }),
    exit: 0,
    includes: ['- epsilon (on branch requirements/epsilon): Global: none, behind v1.1.0', 'Behind: 3 of 3 open feature(s), 2 merged and 1 on a branch.'],
    excludes: ['on branch requirements/gamma', 'zeta'],
  },
  {
    n: 20,
    name: 'a listed spoke does not answer: exit 2, and every other part is printed',
    build: (root) => ({ hub: estate(root, { spokes: { 'auth-service': { 'checks.env': CHECKS(SHARED), 'src/auth/token.ts': 'export {};\n' }, ghost: null } }).hub }),
    exit: 2,
    includes: ['- ghost: not read', 'CANNOT VERIFY: ghost: cannot reach ', ': shared with SIM acme/sim-hub.', 'Past review-by: 1 of 2', 'REASON: remote-unreachable'],
  },
  {
    n: 21,
    name: 'a spoke with no HUBS line is not installed: a note, and no other hub is known',
    build: (root) => ({ hub: estate(root, { spokes: { 'scr-web': { 'checks.env': CHECKS(null), 'src/web/page.ts': 'export {};\n' } } }).hub }),
    exit: 0,
    includes: [': no HUBS line, so no other hub is known', 'NOTE: scr-web has no HUBS line on its trunk', 'Shared: 0 spoke(s).'],
  },
  {
    n: 22,
    name: 'a malformed HUBS line: the hubs that own the spoke are unknown, exit 2',
    build: (root) => ({ hub: estate(root, { spokes: { 'auth-service': { 'checks.env': CHECKS('scr acme/scr-hub'), 'src/auth/token.ts': 'export {};\n' } } }).hub }),
    exit: 2,
    includes: [': HUBS is malformed', 'CANNOT VERIFY: auth-service: HUBS at '],
  },
  {
    n: 23,
    name: 'no list of repositories on the trunk: the hub shares no spoke, exit 0',
    build: (root) => ({ hub: estate(root, { hubFiles: () => ({ 'docs/estate/repositories.json': null }) }).hub }),
    exit: 0,
    includes: ['None: docs/estate/repositories.json is not on the trunk, so this hub lists no spoke.', 'Summary: '],
    excludes: ['CANNOT VERIFY'],
  },
  {
    n: 24,
    name: 'a list of repositories that is not well formed: section 5 is not read, exit 2',
    build: (root) => ({ hub: estate(root, { hubFiles: () => ({ 'docs/estate/repositories.json': `${JSON.stringify({ schema_version: 1, repositories: { global: { url: 'x', checks: 'checks.env', purpose: 'p', readAt: '0'.repeat(40), trunk: 'default' } } })}\n` }) }).hub }),
    exit: 2,
    includes: ['Not read: docs/estate/repositories.json is not well formed.', 'CANNOT VERIFY: docs/estate/repositories.json on origin/main is not well formed', 'is a reserved id'],
  },
  {
    n: 25,
    name: 'the report reads the remote trunk: an unpushed commit and the working tree change nothing',
    build: (root) => ({
      hub: estate(root, {
        hubOpts: {
          unpushed: adr({ n: '030', title: 'Retry with backoff', status: 'Superseded by global.ADR-012' }),
          working: adr({ n: '031', title: REDIS }),
        },
      }).hub,
    }),
    exit: 0,
    includes: ['Superseded by a global record: 1 hub record(s).', 'Candidates: 1.'],
    excludes: ['ADR-030', 'ADR-031'],
  },
  {
    n: 26,
    name: 'HARNESS_TRUNK names a branch the remote does not call its default: exit 2',
    build: (root) => ({ hub: estate(root, { hubOpts: { trunk: 'master' } }).hub, env: { HARNESS_TRUNK: 'main' } }),
    exit: 2,
    includes: ['CANNOT VERIFY: could not fetch origin/main', 'REASON: fetch-failed'],
    excludes: ['Report:'],
  },
  {
    n: 27,
    name: 'a trunk called master, named by HARNESS_TRUNK: the report runs',
    build: (root) => ({ hub: estate(root, { hubOpts: { trunk: 'master' } }).hub, env: { HARNESS_TRUNK: 'master' } }),
    exit: 0,
    includes: ['Report: the hub at origin/master ', 'Summary: 4 global change(s)'],
  },
  {
    n: 28,
    name: 'the report never reads a sibling hub, though the sibling exists on the same host',
    build: (root) => {
      makeRemote(root, 'sim-hub', { ...adr({ n: '044', title: 'auth-service issues tokens with library B', globs: '["src/auth/**"]' }), ...KEYS('SIM') });
      return {
        hub: estate(root).hub,
        env: { HARNESS_HUB_BASE: join(root, 'acme') },
        expect: (_out, r) => (readdirSync(join(r, 'cache')).some((n) => n.includes('sim')) ? ['a sibling hub was fetched into the cache'] : []),
      };
    },
    exit: 0,
    includes: [': shared with SIM acme/sim-hub.'],
    excludes: ['library B', 'ADR-044'],
  },
  {
    n: 29,
    name: 'an argument is a usage error: the report takes none',
    build: (root) => ({ hub: estate(root).hub, args: ['--siblings'] }),
    exit: 3,
    includes: ['unknown arguments: --siblings. The report takes none', 'usage: node '],
    excludes: ['Report:'],
  },
  {
    n: 30,
    name: 'a global document that does not parse is a note, and the report is complete',
    build: (root) => ({ hub: estate(root, { global: { commits: [GLOBAL_V1, { ...GLOBAL_V11, 'docs/architecture/ADR-016-broken.md': '# no header\n' }], tags: { 'v1.0.0': 0, 'v1.1.0': 1 } } }).hub }),
    exit: 0,
    includes: ['NOTE: at v1.1.0: docs/architecture/ADR-016-broken.md: does not open with a frontmatter line', 'Documents: 6 at v1.1.0'],
    excludes: ['CANNOT VERIFY', 'ADR-016 ·'],
  },
  {
    n: 31,
    name: 'the hub origin does not answer: exit 2 before anything is printed',
    build: (root) => ({ hub: estate(root, { hubOpts: { origin: false } }).hub }),
    exit: 2,
    includes: ['CANNOT VERIFY: could not fetch origin/main', 'REASON: fetch-failed'],
    excludes: ['Report:', 'Global: none'],
  },
  {
    n: 32,
    name: 'a hub record or standard that does not bind is never listed for a shared spoke, though its globs cover it',
    build: (root) => ({
      hub: estate(root, {
        hubFiles: () => ({
          ...adr({ n: '026', title: 'Tokens with library D', globs: '["src/auth/**"]', status: 'Deprecated' }),
          ...standard({ topic: 'rust', title: 'Write Rust with clippy clean', globs: '["src/**"]', status: 'Reserved' }),
        }),
      }).hub,
    }),
    exit: 0,
    includes: ["This hub's binding records and standards that cover it: 2"],
    excludes: ['ADR-026 ·', 'std-rust ·'],
  },
];

/* ---------------------------------------------------------------------- runner */

function runFixture(fixture) {
  const root = mkdtempSync(join(tmpdir(), `reportglobal-fx${String(fixture.n).padStart(2, '0')}-`));
  try {
    const built = fixture.build(root);
    const env = { ...ENV, HARNESS_SPOKE_CACHE: join(root, 'cache'), ...(built.env || {}) };
    const res = spawnSync(process.execPath, [SCRIPT, ...(built.args || [])], { cwd: built.hub, env, encoding: 'utf8' });
    const output = `${res.stdout || ''}${res.stderr || ''}`;
    const problems = [];
    if (res.status !== fixture.exit) problems.push(`expected exit ${fixture.exit}, got ${res.status}`);
    for (const needle of fixture.includes || []) {
      if (!output.includes(needle)) problems.push(`output does not contain: ${JSON.stringify(needle)}`);
    }
    for (const needle of fixture.excludes || []) {
      if (output.includes(needle)) problems.push(`output should not contain: ${JSON.stringify(needle)}`);
    }
    if (built.expect) problems.push(...built.expect(res.stdout || '', root));
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
    ? `\n${failed} of ${selected.length} fixtures FAILED. The global report is not trustworthy until this is green.\n`
    : `\nAll ${selected.length} fixtures passed.\n`);
  rmSync(SANDBOX_HOME, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
}

main();

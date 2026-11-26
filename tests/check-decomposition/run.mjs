#!/usr/bin/env node
/**
 * run.mjs — the fixture suite for check-decomposition.js.
 *
 *   usage:  node run.mjs            run every fixture
 *           node run.mjs 9 11       run only the numbered fixtures
 *           node run.mjs --keep     leave the throwaway repositories on disk
 *
 * A fixture here is a REPOSITORY STATE, as in the pickup gate's suite. Each case
 * builds a throwaway hub with a real bare `origin`: the list of repositories,
 * the source requirements document, the key ledger, the decomposition record,
 * its work items and its review, all on the default branch. It copies the
 * shipped check to `scripts/check-decomposition.js`, runs it exactly as CI
 * would, and asserts the exit code and the messages. The check is never
 * imported and never stubbed.
 *
 * One placeholder is substituted when the repository is built: `<RECORD-REVISION>`
 * becomes the blob hash of the record as written -- the value `git hash-object`
 * prints for it. A fixture that changes the record in a later commit is NOT
 * re-substituted: the review keeps naming the revision it really read.
 *
 * A fixture marked `global` also builds a real bare global context repository
 * beside the hub, with release tags, and the check reads it through the
 * fixture's own bare cache (HARNESS_SPOKE_CACHE). Its commits are substituted
 * for placeholders before the review is bound (see buildGlobal). A fixture
 * marked `noGlobalRead` also asserts that the check made no cache for the
 * global repository.
 *
 * `run.mjs` is the list. Every fixture carries its number, its name, the expected
 * exit code and a comment saying why it exists.
 *
 * Node standard library only, plus git via child_process. No test framework.
 * Exit 0 if every fixture passes, 1 if any fails.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

const CHECK_CANDIDATES = [
  process.env.HARNESS_CHECK,
  process.argv[2] && !/^\d+$/.test(process.argv[2]) && !process.argv[2].startsWith('--') ? process.argv[2] : undefined,
  resolve(HERE, '..', '..', 'scripts', 'check-decomposition.js'),
  resolve(HERE, '..', '..', 'scripts', 'check-decomposition.mjs'),
  resolve(HERE, '..', '..', 'check-decomposition.js'),
  resolve(HERE, '..', '..', 'check-decomposition.mjs'),
].filter(Boolean);

const CHECK = CHECK_CANDIDATES.find((p) => existsSync(p));

if (!CHECK) {
  console.error('cannot locate the check script. Looked in order:');
  for (const c of CHECK_CANDIDATES) console.error('  ' + c);
  console.error('\nSet HARNESS_CHECK=/path/to/check-decomposition.js or pass the path as argument 1.');
  process.exit(4);
}

const SLUG = 'step-up-authentication';
const SOURCE_PATH = `docs/requirements/${SLUG}/requirements.md`;
const RECORD_PATH = `docs/backlog/${SLUG}.decomposition.md`;
const REVIEW_PATH = `docs/backlog/${SLUG}.decomposition-review.md`;
const KEYS_PATH = 'docs/backlog/keys.json';
const REGISTRY_PATH = 'docs/estate/repositories.json';
const ITEM_DIR = `docs/backlog/${SLUG}`;
// Replaced, in every file of a fixture, by the trunk commit the hub's context
// documents landed on: the commit a story's Hub commit: line names. The hub's
// documents are the files under these folders.
const HUB_COMMIT = '<HUB-COMMIT>';
const HUB_DOCUMENT_FOLDERS = ['docs/architecture/', 'docs/standards/', 'docs/exceptions/'];
const REPOS = ['transfer-service', 'ledger-service'];
const KEY1 = 'PAY-201';
const KEY2 = 'PAY-202';

// The hub's context documents every fixture carries on the trunk: one decision
// record and one standard, as /add-context files them. The source names both on
// its Context: line, and the first story carries both, uses both, and carries a
// contract kept in its own repository.
const ADR_PATH = 'docs/architecture/ADR-007-step-up.md';
const ADR_BODY = '---\nname: ADR-007\nkind: adr\nstatus: Accepted\n---\n\n# ADR-007: step-up on the same session\n';
const STD_PATH = 'docs/standards/std-auth.md';
const STD_BODY = [
  '---',
  'name: std-auth',
  'kind: standard',
  'status: Active',
  '---',
  '',
  '# std-auth: second-factor challenges',
  '',
  '## Must',
  '',
  '- **std-auth.01** MUST record the outcome of every second-factor challenge. *(Source: § 2.1)*',
  '- **std-auth.02** MUST NOT store a one-time code. *(Source: § 2.4)*',
  '',
].join('\n');

// A record always on: read-context.mjs adds it to every line, so a story owes
// it no use. Only one in force is added: an Accepted record.
const ALWAYS_PATH = 'docs/architecture/ADR-008-utc-times.md';
const ALWAYS_BODY = '---\nname: ADR-008\nalwaysApply: true\nkind: adr\nstatus: Accepted\n---\n\n# ADR-008: every stored time is UTC\n';
const DEPRECATED_BODY = ALWAYS_BODY.replace('status: Accepted', 'status: Deprecated');

function gitBlob(content) {
  const body = Buffer.from(content, 'utf8');
  return createHash('sha1').update(`blob ${body.length}\0`).update(body).digest('hex');
}

const ADR_ENTRY = `ADR-007@${gitBlob(ADR_BODY).slice(0, 12)}:${ADR_PATH}`;
const STD_ENTRY = `std-auth@${gitBlob(STD_BODY).slice(0, 12)}:${STD_PATH}`;
const CONTRACT_ENTRY = 'transfer-api@0123456789ab:transfer-service:contracts/transfer-api.md';
const SOURCE_CONTEXT = `${ADR_ENTRY}, ${STD_ENTRY}`;
const ITEM1_CONTEXT = `${ADR_ENTRY}, ${STD_ENTRY}, ${CONTRACT_ENTRY}`;
// The sentence that uses each of them where a reader sees it.
const ITEM1_USES = 'The challenge runs on the same session, as ADR-007 decides, its outcome is recorded under std-auth.01, and the response keeps the transfer-api contract.';

/* ------------------------------------------------------------------ git helpers */

const SANDBOX_HOME = mkdtempSync(join(tmpdir(), 'decomposition-home-'));
const ENV = {
  ...process.env,
  HARNESS_TRUNK: 'main',
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

function writeLinks(root, links) {
  for (const [rel, target] of Object.entries(links)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    symlinkSync(target, abs);
  }
}

const row = (cells) => `| ${cells.map((c) => String(c)).join(' | ')} |`;

// Rows the fixtures for PLDC-686 edit by exact text.
const DECISION_CELLS = ['D-1', 'The threshold is read from the ledger, not cached', 'The brief names the ledger as the record', 'high', 'brief § Thresholds L40'];
const DECISION_ROW = row(DECISION_CELLS);
const REVIEW_ROW_1 = row(['REQ-1', 'the second factor', KEY1, 'YES']);
const REVIEW_ROW_2 = row(['REQ-2', 'the recorded value', KEY2, 'YES']);
const sep = (n) => `|${'---|'.repeat(n)}`;
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

/* ------------------------------------------------------------------ the estate */

function registry(ids = REPOS) {
  const repositories = {};
  for (const id of ids) {
    repositories[id] = { url: `https://example.invalid/${id}.git`, checks: 'checks.env', purpose: `The ${id}.`, readAt: 'a'.repeat(40) };
  }
  return json({ schema_version: 1, repositories });
}

function keys(overrides = {}) {
  const k = {
    schema_version: 1,
    prefix: 'PAY',
    next: 203,
    blocks: [{ from: 201, to: 202, taken_by: 'decomposition', slug: SLUG }],
    ...overrides,
  };
  return json(k);
}

/* ------------------------------------------------------------------ the source */

const REQ1 = [
  ['REQ-1.AC-1', 'A transfer above the step-up threshold is refused until a second factor is presented.', 'positive', 'brief § Authentication L18-19'],
  ['REQ-1.AC-2', 'A read-only advisory view is served on the existing session, with no challenge.', 'positive', 'brief § Authentication L24'],
  ['REQ-1.AC-3', 'A transfer whose second factor fails writes no transfer record.', 'negative', 'brief § Authentication L31'],
];
const REQ2 = [
  ['REQ-2.AC-1', 'The step-up threshold is the value the product owner records, in the account currency.', 'positive', 'brief § Thresholds L40-41'],
  ['REQ-2.AC-2', 'A threshold change applies to transfers initiated after the change and to no earlier transfer.', 'negative', 'brief § Thresholds L43'],
];
const REQ3 = [
  ['REQ-3.AC-1', 'A support engineer can list the challenges issued to one account in the last day.', 'positive', 'brief § Support L60'],
];

function requirement(id, title, criteria) {
  return [
    `### ${id} — ${title}`,
    '',
    'Derives from: brief § the cited section',
    '',
    row(['ID', 'Criterion', 'Type', 'Source']),
    sep(4),
    ...criteria.map((c) => row(c)),
    '',
  ];
}

function source(overrides = {}) {
  // A string is one Context: line, null is none. `global` is the Global: line's
  // value, null for no line.
  const s = { req3: false, context: SOURCE_CONTEXT, global: null, ...overrides };
  return [
    '# Requirements — step-up authentication',
    '',
    '## 1. Document control',
    '',
    row(['Field', 'Value']),
    sep(2),
    row(['Document revision', 'r1']),
    row(['Slug', SLUG]),
    '',
    ...(s.context === null ? [] : [`Context: ${s.context}`, '']),
    ...(s.global === null ? [] : [`Global: ${s.global}`, '']),
    '## 6. Requirements',
    '',
    ...requirement('REQ-1', 'A high-value transfer demands a second factor', REQ1),
    ...requirement('REQ-2', 'The step-up threshold is a recorded value', REQ2),
    ...(s.req3 ? requirement('REQ-3', 'Support can see the challenges issued', REQ3) : []),
  ].join('\n');
}

/* ------------------------------------------------------------------- the items */

const ITEM1_CRITERIA = [
  ['AC-1', 'A transfer above the threshold returns a challenge and writes nothing.', 'positive', 'REQ-1.AC-1', `requirements § REQ-1 L20; \`transfer-service@3f2a9c1e7b4d:src/transfer.py L40-61\``],
  ['AC-2', 'An advisory read is served with no challenge.', 'positive', 'REQ-1.AC-2', `requirements § REQ-1 L21; \`transfer-service@3f2a9c1e7b4d:src/advisory.py L12-30\``],
  ['AC-3', 'A failed second factor leaves the ledger untouched.', 'negative', 'REQ-1.AC-3', `requirements § REQ-1 L22; \`transfer-service@3f2a9c1e7b4d:src/transfer.py L62-70\``],
];
const ITEM2_CRITERIA = [
  ['AC-1', 'The ledger exposes the recorded threshold in the account currency.', 'positive', 'REQ-2.AC-1', `requirements § REQ-2 L30; \`ledger-service@9e8d7c6b5a4f:ledger/threshold.py L8-20\``],
  ['AC-2', 'A changed threshold is not applied to a transfer initiated before the change.', 'negative', 'REQ-2.AC-2', `requirements § REQ-2 L31; \`ledger-service@9e8d7c6b5a4f:ledger/threshold.py L22-40\``],
];

function item(overrides = {}) {
  const s = {
    key: KEY1,
    keyLine: undefined,
    title: 'Demand a second factor on a high-value transfer',
    repository: 'transfer-service',
    criteria: ITEM1_CRITERIA,
    header: ['ID', 'Criterion', 'Type', 'Carries', 'Source'],
    dependencies: 'None block this item.',
    appendix: null,
    // A string is one Context: line, an array is several, null is none.
    context: ITEM1_CONTEXT,
    // The Hub commit: line. The default token becomes the trunk commit the
    // hub's documents landed on; a string is one line as given, an array
    // several, null is no line.
    hubCommit: HUB_COMMIT,
    uses: ITEM1_USES,
    ...overrides,
  };
  const keyLine = s.keyLine === undefined ? s.key : s.keyLine;
  return [
    `# ${s.key} — ${s.title}`,
    '',
    ...(keyLine === null ? [] : [`Key: ${keyLine}`]),
    ...(s.repository === null ? [] : [].concat(s.repository).map((r) => `Repository: ${r}`)),
    ...[].concat(s.context === null ? [] : s.context).map((value) => `Context: ${value}`),
    ...[].concat(s.hubCommit === null ? [] : s.hubCommit).map((value) => `Hub commit: ${value}`),
    '',
    '## Traceability',
    '',
    `Derives from: \`${SOURCE_PATH}\` § REQ-1 L14-24`,
    '',
    ...(s.uses ? [s.uses, ''] : []),
    '## Acceptance criteria',
    '',
    row(s.header),
    sep(s.header.length),
    ...s.criteria.map((c) => (typeof c === 'string' ? c : row(c))),
    '',
    '## Dependencies',
    '',
    s.dependencies,
    '',
    '## Decisions',
    '',
    row(['#', 'Interpretation', 'Why it is defensible', 'Confidence', 'Source']),
    sep(5),
    DECISION_ROW,
    '',
    '## Clarifications',
    '',
    'NONE',
    '',
    ...(s.appendix ? [s.appendix, ''] : []),
  ].join('\n');
}

const item2 = (overrides = {}) => item({
  key: KEY2,
  title: 'Record the step-up threshold in the ledger',
  repository: 'ledger-service',
  criteria: ITEM2_CRITERIA,
  dependencies: row(['Depends on', 'Type', 'Why']) + '\n' + sep(3) + '\n' + row([KEY1, 'blocks', 'The threshold this item records is the one PAY-201 reads']),
  context: 'none',
  uses: null,
  ...overrides,
});

/* ------------------------------------------------------------------ the record */

const COVERAGE = [
  ['REQ-1 — a high-value transfer demands a second factor', 'L14-24', `${KEY1} (AC-1 to AC-3 carry REQ-1.AC-1 to AC-3)`, 'Covered', 'Fully carried; no exclusion to own'],
  ['REQ-2 — the step-up threshold is a recorded value', 'L26-33', `${KEY2} (AC-1, AC-2 carry REQ-2.AC-1, AC-2)`, 'Covered', 'Fully carried; no exclusion to own'],
  ['Reporting', 'L50-58', 'deliberately none', 'Out of scope', 'Served by the existing reporting pack; product owner'],
];
const REPO_MAP = [
  ['`transfer-service`', '`3f2a9c1e7b4d`', 'Changes', `${KEY1}. The one transfer path is \`transfer-service@3f2a9c1e7b4d:src/transfer.py L40-70\``],
  ['`ledger-service`', '`9e8d7c6b5a4f`', 'Changes', `${KEY2}. The threshold record lives at \`ledger-service@9e8d7c6b5a4f:ledger/threshold.py L8-40\``],
];
const ITEMS = [
  [KEY1, 'Demand a second factor on a high-value transfer', '`transfer-service`', 'REQ-1.AC-1, REQ-1.AC-2, REQ-1.AC-3'],
  [KEY2, 'Record the step-up threshold in the ledger', '`ledger-service`', 'REQ-2.AC-1, REQ-2.AC-2'],
];
const DEPS = [
  [KEY2, KEY1, 'blocks', 'The threshold PAY-202 records is the one PAY-201 reads'],
];

function record(overrides = {}) {
  const s = {
    sourceRow: `\`${SOURCE_PATH}\``,
    coverage: COVERAGE,
    coverageHeader: ['Source section', 'Lines', 'Items', 'Disposition', 'Reason and owner'],
    repoMap: REPO_MAP,
    items: ITEMS,
    deps: DEPS,
    depsSection: true,
    depsTable: true,
    appendix: null,
    ...overrides,
  };
  const rows = (entries) => entries.map((e) => (typeof e === 'string' ? e : row(e)));
  return [
    `# Decomposition — ${SLUG}`,
    '',
    row(['Field', 'Value']),
    sep(2),
    ...(s.sourceRow === null ? [] : [row(['Source', s.sourceRow])]),
    row(['Source revision', 'r1']),
    row(['Record revision', 'r1']),
    row(['Date', '2026-09-12']),
    row(['Key block', `${KEY1} to ${KEY2}, taken from \`${KEYS_PATH}\``]),
    '',
    '## Coverage map',
    '',
    row(s.coverageHeader),
    sep(s.coverageHeader.length),
    ...rows(s.coverage),
    '',
    '## Repository map',
    '',
    row(['Repository', 'Read at', 'Disposition', 'Stories, or the evidence read']),
    sep(4),
    ...rows(s.repoMap),
    '',
    '## Items',
    '',
    row(['Key', 'Title', 'Repository', 'Carries']),
    sep(4),
    ...rows(s.items),
    '',
    ...(s.depsSection ? [
      '## Dependency map',
      '',
      ...(s.depsTable ? [row(['From', 'To', 'Type', 'Why']), sep(4), ...rows(s.deps), ''] : ['No dependency between these items.', '']),
    ] : []),
    '## Decisions',
    '',
    row(['#', 'Decision', 'Alternatives rejected', 'Why', 'Date']),
    sep(5),
    row(['D-1', 'Two stories, one per repository', 'One story spanning both', 'A story names one repository', '2026-09-12']),
    '',
    '## Clarifications',
    '',
    'NONE',
    '',
    ...(s.appendix ? [s.appendix, ''] : []),
  ].join('\n');
}

/* ------------------------------------------------------------------ the review */

const RECORD_REVISION = '<RECORD-REVISION>';

function review(overrides = {}) {
  const s = {
    heading: `## Review: ${SLUG} — the decomposition against the requirements document`,
    verdict: '### VERDICT: APPROVED',
    mode: 'Mode: decomposition-review',
    revision: `Record revision: ${RECORD_REVISION}`,
    extra: [],
    after: [],
    eol: '\n',
    ...overrides,
  };
  return [
    s.heading,
    '',
    ...(s.verdict === null ? [] : [s.verdict]),
    'Cycle: 1 of 2',
    ...(s.mode === null ? [] : [s.mode]),
    'Reviewer: pm-critic',
    ...(s.revision === null ? [] : [s.revision]),
    ...s.extra,
    '',
    '### Acceptance-criterion coverage',
    '',
    row(['AC', 'Criterion (short)', 'Covered where', 'Covered']),
    sep(4),
    REVIEW_ROW_1,
    REVIEW_ROW_2,
    '',
    'Derived AC count: 2 · Derived covered: 2 · Author declared: 2 / 2 · Match: YES',
    '',
    '### Citation spot-check',
    '',
    'Sampled 4 of 12 citations (minimum 30%) · fabricated or drifted: 0 · NONE',
    ...s.after,
    '',
  ].join(s.eol);
}

/** One row with one cell changed. */
const withCell = (r, i, value) => r.map((c, j) => (j === i ? value : c));

const ITEM1_PATH = `${ITEM_DIR}/${KEY1}.item.md`;
const ITEM2_PATH = `${ITEM_DIR}/${KEY2}.item.md`;

function valid(overrides = {}) {
  return {
    [REGISTRY_PATH]: registry(),
    [SOURCE_PATH]: source(),
    [KEYS_PATH]: keys(),
    [RECORD_PATH]: record(),
    [REVIEW_PATH]: review(),
    [ITEM1_PATH]: item(),
    [ITEM2_PATH]: item2(),
    ...overrides,
  };
}

/* ------------------------------------------------------------ the global layer */

// This hub's key prefix, and the repository the global exceptions cover.
const HUB_PREFIX = 'PAY';
const GLOBAL_REPO = 'transfer-service';

// The global context repository a fixture marked `global` builds beside the hub
// (docs/proposals/global-context.md §8): a real bare remote whose trunk is
// `main`, three commits on it, and the release tags v1.3.0 on the first and
// v1.4.0 on the second. The second commit adds the Board's documents below; the
// third changes the record, so a read at the recorded commit and a read at the
// trunk head differ. The commits are substituted for these placeholders before
// the review is bound: `<GLOBAL-C1>`, `<GLOBAL-C2>` and their first twelve
// characters `<GLOBAL-P1>`, `<GLOBAL-P2>`; and `<GLOBAL-URL>` and
// `<GLOBAL-MISSING>`, a path where no repository is.
const GLOBAL_LINK_PATH = 'docs/estate/global.json';
const globalLink = (url = '<GLOBAL-URL>') => `${JSON.stringify({ schema_version: 1, url }, null, 2)}\n`;
const GC1 = '<GLOBAL-C1>';
const GC2 = '<GLOBAL-C2>';
const GP1 = '<GLOBAL-P1>';
const GP2 = '<GLOBAL-P2>';
const gHeader = (fields) => `---\n${Object.entries(fields).map(([k, v]) => `${k}: ${v}`).join('\n')}\n---\n\n`;
const G_ADR_PATH = 'docs/architecture/ADR-012-redis-only.md';
const G_ADR_BODY = `${gHeader({ name: 'ADR-012', description: 'Use only Redis for caching', globs: '["**/cache/**"]', alwaysApply: 'false', kind: 'adr', status: 'Accepted', owner: 'Global Architecture Board', revision: 'v1', origin: 'architecture board minutes' })}# ADR-012: Use only Redis for caching\n\n## Decision\n\nEvery cache in every product is Redis.\n`;
// A global record always on, which the script adds to every line.
const G_ALWAYS_PATH = 'docs/architecture/ADR-015-utc-times.md';
const G_ALWAYS_BODY = `${gHeader({ name: 'ADR-015', description: 'Every stored time is UTC', globs: '[]', alwaysApply: 'true', kind: 'adr', status: 'Accepted', owner: 'Global Architecture Board', revision: 'v1', origin: 'architecture board minutes' })}# ADR-015: Every stored time is UTC\n\n## Decision\n\nEvery product stores a time in UTC.\n`;
const G_STD_PATH = 'docs/standards/std-go.md';
const G_STD_BODY = `${gHeader({ name: 'std-go', description: 'How Go is written in every product.', globs: '["**/*.go"]', alwaysApply: 'false', kind: 'standard', status: 'Active', owner: 'Global Architecture Board', revision: 'v1', origin: 'architecture board minutes' })}# std-go: Go\n\n## Must\n\n- **std-go.01** MUST wrap every returned error with its context. *(Source: §1)*\n`;
const G_EXC_PATH = (n) => `docs/exceptions/EXC-${n}-local-cache.md`;
const gException = (n, { hubs = `["${HUB_PREFIX}"]`, repositories = `["${GLOBAL_REPO}"]`, departs = '["ADR-012"]', status = 'Active', reviewBy = '2099-01-01' } = {}) => `${gHeader({
  name: `EXC-${n}`, description: 'The service keeps an in-process cache instead of Redis.', kind: 'exception', hubs, repositories, departs, status, 'review-by': reviewBy,
  owner: 'service tech lead', approver: 'Global Architecture Board', revision: 'v1', origin: 'this repository',
})}# EXC-${n} — the service's in-process cache\n\n## Reason\n\nThe service runs where no Redis is reachable.\n\n## Scope\n\nOnly the session cache.\n\n## Alternatives considered\n\n1. Embedded Redis. Rejected: a second process.\n`;
// EXC-004 has effect for this hub; EXC-005 is withdrawn; EXC-006 names another
// hub and another repository; EXC-007 is past its review-by date; EXC-008 names
// another hub and covers a repository this hub lists too (§9.1); EXC-009
// departs from a rule of the global standard.
const GLOBAL_DOCS = {
  [G_ADR_PATH]: G_ADR_BODY,
  [G_STD_PATH]: G_STD_BODY,
  [G_ALWAYS_PATH]: G_ALWAYS_BODY,
  [G_EXC_PATH('004')]: gException('004'),
  [G_EXC_PATH('005')]: gException('005', { status: 'Withdrawn' }),
  [G_EXC_PATH('006')]: gException('006', { hubs: '["SIM"]', repositories: '["sim-desktop"]' }),
  [G_EXC_PATH('007')]: gException('007', { reviewBy: '2020-01-01' }),
  [G_EXC_PATH('008')]: gException('008', { hubs: '["SIM"]' }),
  [G_EXC_PATH('009')]: gException('009', { departs: '["std-go.01"]' }),
};
const gEntry = (id, path, pin = GP2) => `${id}@${pin}:global:${path}`;
const G_ADR_ENTRY = gEntry('global.ADR-012', G_ADR_PATH);
const G_STD_ENTRY = gEntry('global.std-go', G_STD_PATH);
const gExcEntry = (n) => gEntry(`global.EXC-${n}`, G_EXC_PATH(n));
// The sentences that use them where a reader sees them.
const G_ADR_USE = 'Every cache is Redis, as global.ADR-012 decides.';
const G_STD_USE = 'Every returned error is wrapped, as global.std-go.01 requires.';
const gExcUse = (n) => `The session cache stays in process under global.EXC-${n}, which departs from global.ADR-012.`;

function buildGlobal(root) {
  const bare = join(root, 'global-context.git');
  const work = join(root, 'global-context-work');
  git(root, ['init', '--bare', '-q', bare]);
  git(root, ['--git-dir', bare, 'symbolic-ref', 'HEAD', 'refs/heads/main']);
  git(root, ['init', '-q', work]);
  git(work, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  git(work, ['config', 'user.name', 'Fixture Runner']);
  git(work, ['config', 'user.email', 'fixture@example.invalid']);
  git(work, ['config', 'commit.gpgsign', 'false']);
  const commits = [];
  for (const files of [
    { 'README.md': '# Global context\n' },
    GLOBAL_DOCS,
    { [G_ADR_PATH]: G_ADR_BODY.replace('Use only Redis', 'Use Redis or Valkey') },
  ]) {
    writeFiles(work, files);
    git(work, ['add', '-A']);
    git(work, ['commit', '-q', '-m', 'the Board merges']);
    commits.push(git(work, ['rev-parse', 'HEAD']).trim());
  }
  git(work, ['push', '-q', bare, 'main']);
  for (const [tag, at] of [['v1.3.0', commits[0]], ['v1.4.0', commits[1]]]) {
    git(work, ['tag', tag, at]);
    git(work, ['push', '-q', bare, `refs/tags/${tag}`]);
  }
  return {
    '<GLOBAL-URL>': bare,
    '<GLOBAL-MISSING>': join(root, 'no-such-global.git'),
    [GC1]: commits[0],
    [GC2]: commits[1],
    [GP1]: commits[0].slice(0, 12),
    [GP2]: commits[1].slice(0, 12),
  };
}

/** The files with every global placeholder replaced by its value. */
function substitute(files, values) {
  if (!values) return files;
  const out = {};
  for (const [rel, body] of Object.entries(files)) {
    out[rel] = typeof body === 'string'
      ? Object.entries(values).reduce((text, [token, value]) => text.split(token).join(value), body)
      : body;
  }
  return out;
}

// The decomposition with these global entries on the first story's line after
// its own, and these sentences after its own. `link` is the hub's link file
// (null for none), `global` the source's Global: value.
function globalFiles(entries, uses = '', { link = globalLink(), global = `v1.4.0 ${GC2}` } = {}) {
  return valid({
    ...(link === null ? {} : { [GLOBAL_LINK_PATH]: link }),
    [SOURCE_PATH]: source({ global }),
    [ITEM1_PATH]: item({ context: [ITEM1_CONTEXT, ...[].concat(entries)].join(', '), uses: `${ITEM1_USES} ${uses}`.trim() }),
  });
}

/* ------------------------------------------------------------------- fixtures */

const FIXTURES = [
  {
    n: 1,
    name: 'complete decomposition: two stories in two repositories, approved review bound to the record',
    files: valid(),
    exit: 0,
    includes: ['DECOMPOSITION COMPLETE: 9 of 9 checks passed', '2 item(s): PAY-201 (transfer-service), PAY-202 (ledger-service)'],
  },
  {
    n: 2,
    name: 'no record on the trunk (record exists only on a feature branch)',
    files: { [REGISTRY_PATH]: registry(), [SOURCE_PATH]: source(), [KEYS_PATH]: keys() },
    branch: { name: `backlog/${SLUG}`, files: valid() },
    exit: 1,
    includes: [`"*.decomposition.md" for ${SLUG} on origin/main, found 0`],
    excludes: ['DECOMPOSITION COMPLETE'],
  },
  {
    // The whole point of the review file: before it, the verdict was a temp file
    // and a typed approval row, and the record merged on the row.
    n: 3,
    name: 'no review beside the record',
    files: valid({ [REVIEW_PATH]: undefined }),
    exit: 1,
    includes: [`"*.decomposition-review.md" for ${SLUG} on origin/main, found 0`],
  },
  {
    n: 4,
    name: 'the review says CHANGES REQUESTED',
    files: valid({ [REVIEW_PATH]: review({ verdict: '### VERDICT: CHANGES REQUESTED' }) }),
    exit: 1,
    includes: ['verdict is "### VERDICT: CHANGES REQUESTED"; the check opens only on "### VERDICT: APPROVED"'],
  },
  {
    // The binding, and the case that makes it matter.
    n: 5,
    name: 'the record changed on the trunk after it was reviewed',
    files: valid(),
    thenChange: { [RECORD_PATH]: record({ appendix: 'Amended after review: a third story was added in prose.' }) },
    exit: 1,
    includes: ['the record changed after it was reviewed, so the current record is unreviewed'],
  },
  {
    n: 6,
    name: 'the review carries no Record revision line',
    files: valid({ [REVIEW_PATH]: review({ revision: null }) }),
    exit: 1,
    includes: ['carries no "Record revision: <hash>" line', `git hash-object ${RECORD_PATH}`],
  },
  {
    n: 7,
    name: 'the review never names the slug',
    files: valid({ [REVIEW_PATH]: review({ heading: '## Review: payments-v2 — a different decomposition' }) }),
    exit: 1,
    includes: [`never names ${SLUG}; a review is evidence about one decomposition`],
  },
  {
    n: 8,
    name: 'the review carries the wrong mode',
    files: valid({ [REVIEW_PATH]: review({ mode: 'Mode: feature-review' }) }),
    exit: 1,
    includes: ['carries "Mode: feature-review"; a decomposition review is written in "Mode: decomposition-review"'],
  },
  {
    // A decomposition is cut from a document on the trunk. One that names a
    // document nobody can open was cut from something else.
    n: 9,
    name: 'the source document is not on the trunk',
    files: valid({ [SOURCE_PATH]: undefined }),
    exit: 1,
    includes: [`names its source as ${SOURCE_PATH}, which is not on origin/main`],
  },
  {
    n: 10,
    name: 'the record has no Source row',
    files: valid({ [RECORD_PATH]: record({ sourceRow: null }) }),
    exit: 1,
    includes: ['must carry exactly one "| Source | <path> |" row', 'skipped: the record names no readable source'],
  },
  {
    // The check that replaces the signed set: every requirement in the source is
    // in the coverage map, cut or excluded. A requirement nobody mapped is a
    // silent scope cut.
    n: 11,
    name: 'a requirement in the source with no row in the coverage map',
    files: valid({ [SOURCE_PATH]: source({ req3: true }) }),
    exit: 1,
    includes: ['defines REQ-3 and docs/backlog/step-up-authentication.decomposition.md does not map it'],
  },
  {
    // "Covered" is a claim about the items, checked against the items.
    n: 12,
    name: 'a requirement marked Covered that no item criterion carries',
    files: valid({
      [SOURCE_PATH]: source({ req3: true }),
      [RECORD_PATH]: record({ coverage: [...COVERAGE, ['REQ-3 — support can see the challenges', 'L35-42', KEY1, 'Covered', 'Carried by the transfer story']] }),
    }),
    exit: 1,
    includes: ['marks REQ-3 Covered, but no item criterion carries a REQ-3.AC-<m>'],
  },
  {
    n: 13,
    name: 'a requirement marked Covered whose Items cell names no item of this decomposition',
    files: valid({ [RECORD_PATH]: record({ coverage: [withCell(COVERAGE[0], 2, 'PAY-999'), COVERAGE[1], COVERAGE[2]] }) }),
    exit: 1,
    includes: ['is marked Covered but its Items cell names no item of this decomposition (it names PAY-999)'],
  },
  {
    // The disposition set is closed. "Awaiting sign-off" is what the typed row
    // used to produce, and it is not a disposition any more.
    n: 14,
    name: 'a disposition outside the set',
    files: valid({
      [SOURCE_PATH]: source({ req3: true }),
      [RECORD_PATH]: record({ coverage: [...COVERAGE, ['REQ-3 — support can see the challenges', 'L35-42', 'deliberately none', 'Awaiting sign-off', 'Held by the signing role']] }),
    }),
    exit: 1,
    includes: ['disposition "Awaiting sign-off" is not one of Covered / Out of scope / Unresolved'],
  },
  {
    // A requirement held on an open question is Unresolved, in the pinned
    // grammar, and the decomposition is still complete.
    n: 15,
    name: 'a requirement held Unresolved with the marker — must pass',
    files: valid({
      [SOURCE_PATH]: source({ req3: true }),
      [RECORD_PATH]: record({ coverage: [...COVERAGE, ['REQ-3 — support can see the challenges', 'L35-42', 'none yet, blocked', 'Unresolved', 'UNRESOLVED — what a support engineer may see of another account\'s challenges. Owner: product owner. Resolves: CLAR-PAY-stepup-02 closes.']] }),
    }),
    exit: 0,
    includes: ['DECOMPOSITION COMPLETE: 9 of 9 checks passed'],
  },
  {
    n: 16,
    name: 'a requirement held Unresolved without the marker',
    files: valid({
      [SOURCE_PATH]: source({ req3: true }),
      [RECORD_PATH]: record({ coverage: [...COVERAGE, ['REQ-3 — support can see the challenges', 'L35-42', 'none yet, blocked', 'Unresolved', 'Waiting on the product owner']] }),
    }),
    exit: 1,
    includes: ['is marked Unresolved, so its reason cell reads "UNRESOLVED — <what>. Owner: <role>. Resolves: <trigger>."'],
  },
  {
    n: 17,
    name: 'a requirement excluded with no reason',
    files: valid({
      [SOURCE_PATH]: source({ req3: true }),
      [RECORD_PATH]: record({ coverage: [...COVERAGE, ['REQ-3 — support can see the challenges', 'L35-42', 'deliberately none', 'Out of scope', '']] }),
    }),
    exit: 1,
    includes: ['is marked Out of scope with nothing for a reason'],
  },
  {
    // The link the whole plan exists to carry. A criterion that names a
    // requirement criterion the source does not define is a link to nothing.
    n: 18,
    name: 'an item criterion carries a requirement criterion the source does not define',
    files: valid({ [ITEM1_PATH]: item({ criteria: [ITEM1_CRITERIA[0], withCell(ITEM1_CRITERIA[1], 3, 'REQ-1.AC-9'), ITEM1_CRITERIA[2]] }) }),
    exit: 1,
    includes: [`AC-2 carries REQ-1.AC-9, which ${SOURCE_PATH} does not define`],
  },
  {
    n: 19,
    name: 'an item criterion with a bad Carries cell',
    files: valid({ [ITEM1_PATH]: item({ criteria: [ITEM1_CRITERIA[0], withCell(ITEM1_CRITERIA[1], 3, 'REQ-1'), withCell(ITEM1_CRITERIA[2], 3, '')] }) }),
    exit: 1,
    includes: ['criterion AC-2 carries "REQ-1", which is not one REQ-<n>.AC-<m>', 'criterion AC-3 carries "", which is not one REQ-<n>.AC-<m>'],
  },
  {
    // The identifiers are universal now: an item table with no Carries column
    // has nowhere to record the link.
    n: 20,
    name: 'an item criteria table without a Carries column',
    files: valid({ [ITEM1_PATH]: item({ header: ['ID', 'Criterion', 'Type', 'Source'], criteria: ITEM1_CRITERIA.map((c) => [c[0], c[1], c[2], c[4]]) }) }),
    exit: 1,
    includes: ['must carry exactly one "Carries" column, found 0'],
  },
  {
    n: 21,
    name: 'an item with no Repository line',
    files: valid({ [ITEM1_PATH]: item({ repository: null }) }),
    exit: 1,
    includes: ['must carry exactly one "Repository: <id>" line, found 0; a story lands in exactly one repository'],
  },
  {
    n: 22,
    name: 'an item with two Repository lines',
    files: valid({ [ITEM1_PATH]: item({ repository: ['transfer-service', 'ledger-service'] }) }),
    exit: 1,
    includes: ['must carry exactly one "Repository: <id>" line, found 2'],
  },
  {
    n: 23,
    name: 'an item naming a repository the list does not carry',
    files: valid({ [ITEM1_PATH]: item({ repository: 'notifications' }), [RECORD_PATH]: record({ items: [withCell(ITEMS[0], 2, '`notifications`'), ITEMS[1]] }) }),
    exit: 1,
    includes: ['names repository "notifications", which docs/estate/repositories.json does not carry (it lists transfer-service, ledger-service); /add-repo comes first'],
  },
  {
    // A hub with no list has nowhere for a story to land.
    n: 24,
    name: 'no list of repositories on the trunk',
    files: valid({ [REGISTRY_PATH]: undefined }),
    exit: 1,
    includes: ['no docs/estate/repositories.json on origin/main', 'skipped: no readable list of repositories'],
  },
  {
    n: 25,
    name: 'an empty list of repositories',
    files: valid({ [REGISTRY_PATH]: registry([]) }),
    exit: 1,
    includes: ['names no repository, so no story has anywhere to land; /add-repo comes first'],
  },
  {
    // A repository with no row was never considered, and nobody can tell that
    // from one that was.
    n: 26,
    name: 'a listed repository with no row in the repository map',
    files: valid({ [REGISTRY_PATH]: registry([...REPOS, 'notifications']) }),
    exit: 1,
    includes: ['lists "notifications" and the repository map has no row for it'],
  },
  {
    n: 27,
    name: 'a repository map row for a repository the list does not carry',
    files: valid({ [RECORD_PATH]: record({ repoMap: [...REPO_MAP, ['`notifications`', '`1c2d3e4f5a6b`', 'Does not change', 'Nothing here reaches a notification']] }) }),
    exit: 1,
    includes: ['the repository map names "notifications", which docs/estate/repositories.json does not carry'],
  },
  {
    n: 28,
    name: 'the Key line disagrees with the filename',
    files: valid({ [ITEM1_PATH]: item({ keyLine: 'PAY-210' }) }),
    exit: 1,
    includes: ['says "Key: PAY-210" but is filed as PAY-201'],
  },
  {
    // Every key in the hub is minted from the ledger, under its prefix.
    n: 29,
    name: 'an item key with a prefix that is not the ledger\'s',
    files: valid({
      [ITEM2_PATH]: undefined,
      [`${ITEM_DIR}/SVC-202.item.md`]: item2({ key: 'SVC-202' }),
      [RECORD_PATH]: record({ items: [ITEMS[0], withCell(ITEMS[1], 0, 'SVC-202')], deps: [['SVC-202', KEY1, 'blocks', 'as before']] }),
    }),
    exit: 1,
    includes: ['the key\'s prefix "SVC" is not the ledger\'s "PAY"'],
  },
  {
    n: 30,
    name: 'an item key outside the block the ledger records',
    files: valid({
      [ITEM2_PATH]: undefined,
      [`${ITEM_DIR}/PAY-250.item.md`]: item2({ key: 'PAY-250' }),
      [RECORD_PATH]: record({ items: [ITEMS[0], withCell(ITEMS[1], 0, 'PAY-250')], deps: [['PAY-250', KEY1, 'blocks', 'as before']] }),
    }),
    exit: 1,
    includes: ['250 is outside the block PAY-201 to PAY-202 the ledger records', 'no item file carries PAY-202'],
  },
  {
    // The block is exactly the keys minted. A spare number is a key nobody can
    // account for -- the reserved-block habit this ledger replaces.
    n: 31,
    name: 'a block with a number no item carries',
    files: valid({ [KEYS_PATH]: keys({ next: 221, blocks: [{ from: 201, to: 220, taken_by: 'decomposition', slug: SLUG }] }) }),
    exit: 1,
    includes: ['no item file carries PAY-203; a block is exactly the keys minted'],
  },
  {
    // Two decompositions racing conflict on this number at merge; a counter that
    // did not move is the race nobody noticed.
    n: 32,
    name: 'the counter was not advanced past the block',
    files: valid({ [KEYS_PATH]: keys({ next: 202 }) }),
    exit: 1,
    includes: ['runs to 202 but "next" is 202; the counter moves past every block minted'],
  },
  {
    n: 33,
    name: 'no block recorded for this slug',
    files: valid({ [KEYS_PATH]: keys({ blocks: [] }) }),
    exit: 1,
    includes: [`records no block taken by the decomposition of ${SLUG}`],
  },
  {
    // A re-cut adds a block. Two blocks for one slug are legal when, together,
    // they are exactly the items; a second block nothing was cut from is not.
    n: 34,
    name: 'a second block for this slug whose numbers no item carries',
    files: valid({ [KEYS_PATH]: keys({ next: 205, blocks: [{ from: 201, to: 202, taken_by: 'decomposition', slug: SLUG }, { from: 203, to: 204, taken_by: 'decomposition', slug: SLUG }] }) }),
    exit: 1,
    includes: ['gives step-up-authentication the block PAY-203 to PAY-204, but no item file carries PAY-203'],
  },
  {
    n: 65,
    name: 'two blocks for this slug, each fully cut — a re-cut — must pass',
    files: valid({ [KEYS_PATH]: keys({ next: 203, blocks: [{ from: 201, to: 201, taken_by: 'decomposition', slug: SLUG }, { from: 202, to: 202, taken_by: 'decomposition', slug: SLUG }] }) }),
    exit: 0,
    includes: ['DECOMPOSITION COMPLETE: 9 of 9 checks passed'],
  },
  {
    // PAY-0202 and PAY-202 are one number spelt twice.
    n: 66,
    name: 'an item key with a leading zero',
    files: valid({
      [ITEM2_PATH]: undefined,
      [`${ITEM_DIR}/PAY-0202.item.md`]: item2({ key: 'PAY-0202' }),
      [RECORD_PATH]: record({ items: [ITEMS[0], withCell(ITEMS[1], 0, 'PAY-0202')], deps: [['PAY-0202', KEY1, 'blocks', 'as before']] }),
    }),
    exit: 1,
    includes: ['"0202" has a leading zero; the ledger numbers this key PAY-202'],
  },
  {
    // The other half of the held-requirement rule: a story that builds a
    // requirement the record holds Unresolved is the work the row exists to stop.
    n: 67,
    name: 'an item carries a criterion of a requirement the record holds Unresolved',
    files: valid({
      [SOURCE_PATH]: source({ req3: true }),
      [RECORD_PATH]: record({ coverage: [...COVERAGE, ['REQ-3 — support can see the challenges', 'L35-42', 'none yet, blocked', 'Unresolved', 'UNRESOLVED — what a support engineer may see. Owner: product owner. Resolves: CLAR-PAY-stepup-02 closes.']] }),
      [ITEM2_PATH]: item2({ criteria: [...ITEM2_CRITERIA, ['AC-3', 'Support lists the challenges issued to one account.', 'positive', 'REQ-3.AC-1', 'requirements § REQ-3 L40']] }),
    }),
    exit: 1,
    includes: ['AC-3 carries REQ-3.AC-1, but docs/backlog/step-up-authentication.decomposition.md holds REQ-3 Unresolved; a held or excluded requirement gets no story and no key'],
  },
  {
    // A retired criterion keeps its number in the source and is not built.
    n: 68,
    name: 'an item carries a criterion the source marks DEPRECATED',
    files: valid({ [SOURCE_PATH]: source().replace(row(REQ1[1]), row(withCell(REQ1[1], 1, 'DEPRECATED — folded into REQ-1.AC-1 on 2026-09-12'))) }),
    exit: 1,
    includes: [`AC-2 carries REQ-1.AC-2, which ${SOURCE_PATH} marks DEPRECATED; a retired criterion is not built`],
  },
  {
    // The source's own malformed heading is a finding against the source, and
    // the requirement under it is still demanded of the coverage map.
    n: 69,
    name: 'a source requirement heading with a malformed identifier',
    files: valid({ [SOURCE_PATH]: source({ req3: true }).replace('### REQ-3 —', '### REQ-3a —') }),
    exit: 1,
    includes: [`${SOURCE_PATH}: requirement heading REQ-3a (line`, 'does not match REQ-<n>', 'defines REQ-3a and docs/backlog/step-up-authentication.decomposition.md does not map it'],
  },
  {
    // "REQ-3." at the end of a sentence still names REQ-3.
    n: 70,
    name: 'a coverage row that names the requirement with a trailing full stop — must pass',
    files: valid({
      [SOURCE_PATH]: source({ req3: true }),
      [RECORD_PATH]: record({ coverage: [...COVERAGE, ['Support, stated as REQ-3.', 'L35-42', 'none yet, blocked', 'Unresolved', 'UNRESOLVED — what a support engineer may see. Owner: product owner. Resolves: CLAR-PAY-stepup-02 closes.']] }),
    }),
    exit: 0,
    includes: ['DECOMPOSITION COMPLETE: 9 of 9 checks passed'],
  },
  {
    n: 35,
    name: 'two blocks that overlap',
    files: valid({ [KEYS_PATH]: keys({ next: 205, blocks: [{ from: 201, to: 202, taken_by: 'decomposition', slug: SLUG }, { from: 202, to: 204, taken_by: 'validation', key: 'PAY-150' }] }) }),
    exit: 1,
    includes: ['blocks[0] (201-202) and blocks[1] (202-204) overlap'],
  },
  {
    // A validation's defect keys sit in the same ledger, and a well-formed ledger
    // with both kinds of block passes.
    n: 36,
    name: 'a ledger that also records a validation\'s defect keys — must pass',
    files: valid({ [KEYS_PATH]: keys({ next: 205, blocks: [{ from: 201, to: 202, taken_by: 'decomposition', slug: SLUG }, { from: 203, to: 204, taken_by: 'validation', key: 'PAY-150' }] }) }),
    exit: 0,
    includes: ['DECOMPOSITION COMPLETE: 9 of 9 checks passed'],
  },
  {
    n: 37,
    name: 'no key ledger on the trunk',
    files: valid({ [KEYS_PATH]: undefined }),
    exit: 1,
    includes: ['no docs/backlog/keys.json on origin/main; the hub install writes it'],
  },
  {
    n: 38,
    name: 'a key ledger that is not JSON',
    files: valid({ [KEYS_PATH]: '{ "prefix": "PAY", "next": 203, "blocks": [ }\n' }),
    exit: 1,
    includes: ['docs/backlog/keys.json is not JSON'],
  },
  {
    n: 39,
    name: 'a block whose taken_by is neither decomposition nor validation',
    files: valid({ [KEYS_PATH]: keys({ blocks: [{ from: 201, to: 202, taken_by: 'planner', slug: SLUG }] }) }),
    exit: 1,
    includes: ['"taken_by" must be "decomposition" or "validation", found "planner"'],
  },
  {
    // The record and the directory are one set.
    n: 40,
    name: 'an item file the record\'s Items table does not list',
    files: valid({ [RECORD_PATH]: record({ items: [ITEMS[0]] }) }),
    exit: 1,
    includes: ['exists on origin/main but the record\'s Items table does not list PAY-202'],
  },
  {
    n: 41,
    name: 'an Items row with no item file',
    files: valid({ [RECORD_PATH]: record({ items: [...ITEMS, ['PAY-203', 'A third story', '`transfer-service`', 'REQ-1.AC-1']] }) }),
    exit: 1,
    includes: ['the Items table lists PAY-203, but there is no docs/backlog/step-up-authentication/PAY-203.item.md'],
  },
  {
    n: 42,
    name: 'the Items table names a different repository from the item file',
    files: valid({ [RECORD_PATH]: record({ items: [withCell(ITEMS[0], 2, '`ledger-service`'), ITEMS[1]] }) }),
    exit: 1,
    includes: ['the Items table says PAY-201 lands in "ledger-service" but docs/backlog/step-up-authentication/PAY-201.item.md says "Repository: transfer-service"'],
  },
  {
    // A cycle is a boundary through the middle of one behaviour.
    n: 43,
    name: 'a cycle in the dependency map',
    files: valid({ [RECORD_PATH]: record({ deps: [...DEPS, [KEY1, KEY2, 'blocks', 'and back again']] }) }),
    exit: 1,
    includes: ['the dependency map has a cycle: PAY-202 → PAY-201 → PAY-202'],
  },
  {
    n: 44,
    name: 'a dependency From a key that is not an item of this decomposition',
    files: valid({ [RECORD_PATH]: record({ deps: [...DEPS, ['PAY-150', KEY1, 'blocks', 'an earlier item']] }) }),
    exit: 1,
    includes: ['"PAY-150" in the From column is not an item of this decomposition'],
  },
  {
    // A dependency on an item from an earlier decomposition is a row like any
    // other, and it is not a cycle.
    n: 45,
    name: 'a dependency To an item of an earlier decomposition — must pass',
    files: valid({ [RECORD_PATH]: record({ deps: [...DEPS, [KEY1, 'PAY-150', 'blocks', 'consumes the account record PAY-150 created']] }) }),
    exit: 0,
    includes: ['DECOMPOSITION COMPLETE: 9 of 9 checks passed'],
  },
  {
    n: 46,
    name: 'no Dependency map section',
    files: valid({ [RECORD_PATH]: record({ depsSection: false }) }),
    exit: 1,
    includes: ['no "## Dependency map" section', 'skipped: no readable dependency map'],
  },
  {
    // One item, no dependencies: the section is there and says so in prose.
    n: 47,
    name: 'a Dependency map section with no table — must pass',
    files: valid({ [RECORD_PATH]: record({ depsTable: false }) }),
    exit: 0,
    includes: ['DECOMPOSITION COMPLETE: 9 of 9 checks passed'],
  },
  {
    n: 48,
    name: 'placeholder cells in an item and in the record',
    files: valid({
      [ITEM1_PATH]: item({ criteria: [withCell(ITEM1_CRITERIA[0], 4, '-'), ITEM1_CRITERIA[1], ITEM1_CRITERIA[2]] }),
      [RECORD_PATH]: record({ repoMap: [REPO_MAP[0], withCell(REPO_MAP[1], 1, 'TBD')] }),
    }),
    exit: 1,
    includes: ['PAY-201.item.md line', 'has "-" in the "Source" column', 'decomposition.md line', 'has "TBD" in the "Read at" column'],
  },
  {
    n: 49,
    name: 'an approval block with a typed row is a table like any other, and its cells are read',
    files: valid({ [RECORD_PATH]: record({ appendix: ['## Approval', '', row(['Approving role', 'Date', 'Record revision approved', 'Decision', 'Keys approved']), sep(5), row(['Product owner', '2026-09-12', 'r1', 'Approved', '-'])].join('\n') }) }),
    exit: 1,
    includes: ['has "-" in the "Keys approved" column'],
  },
  {
    n: 50,
    name: 'hidden markup in the record',
    files: valid({ [RECORD_PATH]: record({ appendix: '<details><summary>Notes</summary>REQ-2 was dropped.</details>' }) }),
    exit: 1,
    includes: ['carries HTML <details> markup'],
  },
  {
    n: 51,
    name: 'an item with a duplicate criterion identifier',
    files: valid({ [ITEM1_PATH]: item({ criteria: [ITEM1_CRITERIA[0], withCell(ITEM1_CRITERIA[1], 0, 'AC-1'), ITEM1_CRITERIA[2]] }) }),
    exit: 1,
    includes: ['criterion AC-1 is defined twice'],
  },
  {
    n: 52,
    name: 'an item with no criteria',
    files: valid({ [ITEM1_PATH]: item({ criteria: [] }) }),
    exit: 1,
    includes: ['defines no AC-<n> row; a story with no criteria cannot be accepted'],
  },
  {
    n: 53,
    name: 'no item file at all',
    files: valid({ [ITEM1_PATH]: undefined, [ITEM2_PATH]: undefined }),
    exit: 1,
    includes: [`no "*.item.md" under ${ITEM_DIR}/ on origin/main; a decomposition with no work item cut nothing`],
  },
  {
    // The source's own defects are reported against the source, once, and the
    // decomposition is still read.
    n: 54,
    name: 'a source document whose criteria table is malformed',
    files: valid({ [SOURCE_PATH]: source().replace(row(REQ2[1]), '| REQ-2.AC-2 | two cells |') }),
    exit: 1,
    includes: [`${SOURCE_PATH}: criterion row under REQ-2 (line`, 'is malformed', `AC-2 carries REQ-2.AC-2, which ${SOURCE_PATH} does not define`],
  },
  {
    n: 55,
    name: 'usage error: the slug is not kebab-case',
    files: valid(),
    key: 'Step_Up',
    exit: 3,
    includes: ['usage:'],
    excludes: ['decomposition check  ('],
  },
  {
    n: 56,
    name: 'the remote is unreachable — cannot verify',
    files: valid(),
    breakRemote: true,
    exit: 2,
    includes: ['CANNOT VERIFY'],
  },
  {
    n: 57,
    name: 'HARNESS_TRUNK names a branch that is not the remote\'s default — cannot verify',
    files: valid(),
    env: { HARNESS_TRUNK: 'develop' },
    exit: 2,
    includes: ['CANNOT VERIFY'],
  },
  {
    // The binding is by blob hash, so no history is needed.
    // A story's Hub commit: line names a commit before the decomposition's own,
    // and a clone of depth 1 cannot see it: the check refuses rather than guess.
    n: 58,
    name: 'a shallow clone cannot see the Hub commit — cannot verify',
    files: valid(),
    shallow: true,
    exit: 2,
    includes: ['CANNOT VERIFY', 'names a commit this clone cannot see, and this clone is shallow', 'fetch full history (fetch-depth: 0)', 'REASON: shallow-clone'],
  },
  {
    n: 59,
    name: 'a record, items and a review with CRLF line endings — must pass',
    files: valid({
      [RECORD_PATH]: record().split('\n').join('\r\n'),
      [ITEM1_PATH]: item().split('\n').join('\r\n'),
      [REVIEW_PATH]: review({ eol: '\r\n' }),
    }),
    exit: 0,
    includes: ['DECOMPOSITION COMPLETE: 9 of 9 checks passed'],
  },
  {
    n: 60,
    name: 'a record, a review and a ledger that all start with a byte-order mark — must pass',
    files: valid({ [RECORD_PATH]: `\uFEFF${record()}`, [REVIEW_PATH]: `\uFEFF${review()}`, [KEYS_PATH]: `\uFEFF${keys()}` }),
    exit: 0,
    includes: ['DECOMPOSITION COMPLETE: 9 of 9 checks passed'],
  },
  {
    n: 61,
    name: 'run from a subdirectory — must pass',
    files: valid({ 'scripts/README.md': 'the hub\'s scripts\n' }),
    from: 'scripts',
    exit: 0,
    includes: ['DECOMPOSITION COMPLETE: 9 of 9 checks passed'],
  },
  {
    n: 62,
    name: 'the record is a symbolic link',
    files: valid({ [RECORD_PATH]: undefined, 'docs/backlog/other.md': record() }),
    symlinks: { [RECORD_PATH]: 'other.md' },
    exit: 1,
    includes: ['is a symbolic link on origin/main, not a decomposition record'],
  },
  {
    // An item file in a nested directory is not an item of this decomposition,
    // and a stray record for another slug is not this record.
    n: 63,
    name: 'files for another slug beside this one are not read — must pass',
    files: valid({
      'docs/backlog/other-feature.decomposition.md': record(),
      'docs/backlog/other-feature/PAY-300.item.md': item({ key: 'PAY-300' }),
    }),
    exit: 0,
    includes: ['2 item(s): PAY-201 (transfer-service), PAY-202 (ledger-service)'],
  },
  {
    // A Parent epic line and an epic file are not read and not failed: they are
    // simply not part of the shape any more.
    n: 64,
    name: 'a Parent epic line in an item is ignored — must pass',
    files: valid({ [ITEM1_PATH]: item().replace('\n\n## Traceability', '\nParent epic: EPIC-7\n\n## Traceability') }),
    exit: 0,
    includes: ['DECOMPOSITION COMPLETE: 9 of 9 checks passed'],
  },
  {
    // A row ruled out on the list's purpose, with no commit this run read at.
    // The purpose orders the reading and is never evidence; a row rests on the
    // tree read at a pinned commit, or it is refused.
    n: 71,
    name: 'a repository-map row whose Read at is not a twelve-character commit',
    files: valid({ [RECORD_PATH]: record({ repoMap: [REPO_MAP[0], withCell(REPO_MAP[1], 1, 'ruled out on purpose')] }) }),
    exit: 1,
    includes: ['decomposition.md line', '"ledger-service" has "ruled out on purpose" in the "Read at" column, which is not a twelve-character commit', 'never on the list\'s purpose'],
  },
  {
    // A forty-character commit is a commit, but not the twelve the Cite: line
    // prints; the column is read literally, as every token is.
    n: 72,
    name: 'a repository-map row whose Read at is a forty-character commit',
    files: valid({ [RECORD_PATH]: record({ repoMap: [REPO_MAP[0], withCell(REPO_MAP[1], 1, '`9e8d7c6b5a4f9e8d7c6b5a4f9e8d7c6b5a4f9e8d`')] }) }),
    exit: 1,
    includes: ['"ledger-service" has "9e8d7c6b5a4f9e8d7c6b5a4f9e8d7c6b5a4f9e8d" in the "Read at" column, which is not a twelve-character commit'],
  },

  /* ---------------------------------------------------- context documents */

  {
    n: 73,
    name: 'a story with no Context: line',
    files: valid({ [ITEM2_PATH]: item2({ context: null }) }),
    exit: 1,
    includes: [`${ITEM2_PATH} never says which context documents the story was written against`, 'scripts/read-context.mjs ledger-service --at <commit> --names'],
    excludes: ['DECOMPOSITION COMPLETE'],
  },
  {
    n: 74,
    name: 'a story with two Context: lines',
    files: valid({ [ITEM2_PATH]: item2({ context: ['none', 'none'] }) }),
    exit: 1,
    includes: ['carries 2 "Context:" lines', 'a story is written against one set of context documents'],
  },
  {
    n: 75,
    name: 'a story entry that is not a context entry',
    files: valid({ [ITEM1_PATH]: item({ context: `ADR-007, ${STD_ENTRY}, ${CONTRACT_ENTRY}` }) }),
    exit: 1,
    includes: ['"ADR-007" is not a context entry'],
  },
  {
    // A story reads the hub's documents and its own repository's, no other.
    n: 76,
    name: 'a story entry kept in another repository',
    files: valid({ [ITEM2_PATH]: item2({ context: CONTRACT_ENTRY, uses: 'The transfer-api contract applies.' }) }),
    exit: 1,
    includes: ['is kept in "transfer-service"; this story lands in "ledger-service"'],
  },
  {
    n: 77,
    name: 'a story entry for a hub document that is not on the trunk',
    files: valid({ [ITEM2_PATH]: item2({ context: 'ADR-009@0123456789ab:docs/architecture/ADR-009-limits.md', uses: 'ADR-009 sets the limit.' }) }),
    exit: 1,
    includes: ['"ADR-009" cites docs/architecture/ADR-009-limits.md, which is not on origin/main'],
  },
  {
    n: 78,
    name: 'a story pin the commit on its Hub commit: line does not hold',
    files: valid({ [ITEM1_PATH]: item({ context: `ADR-007@0123456789ab:${ADR_PATH}, ${STD_ENTRY}, ${CONTRACT_ENTRY}` }) }),
    exit: 1,
    includes: ['"ADR-007" pins 0123456789ab', 'the commit the Hub commit: line names, holds ', 'the two lines were not copied from one run', 'copy the Hub commit: and Context: lines it prints'],
  },
  {
    n: 79,
    name: 'a context document changed after the story read it — must pass, with a drift note',
    files: valid(),
    thenChange: { [ADR_PATH]: `${ADR_BODY}A later paragraph.\n` },
    exit: 0,
    includes: [`note: context drift: "ADR-007" (${ADR_PATH}) was`, 'when PAY-201 read it', 'DECOMPOSITION COMPLETE: 9 of 9 checks passed'],
  },
  {
    n: 80,
    name: 'a moved context document in a shallow clone — cannot verify',
    files: valid(),
    thenChange: { [ADR_PATH]: `${ADR_BODY}A later paragraph.\n` },
    shallow: true,
    exit: 2,
    includes: ['CANNOT VERIFY', 'this clone is shallow', 'REASON: shallow-clone'],
  },
  {
    n: 81,
    name: 'a story lists a decision record it never names',
    files: valid({ [ITEM1_PATH]: item({ uses: 'The outcome is recorded under std-auth.01, and the response keeps the transfer-api contract.' }) }),
    exit: 1,
    includes: ['"ADR-007" is on the line and named nowhere else in the story'],
  },
  {
    n: 82,
    name: 'a story lists a contract it never names',
    files: valid({ [ITEM1_PATH]: item({ uses: 'The challenge runs on the same session, as ADR-007 decides, under std-auth.01.' }) }),
    exit: 1,
    includes: ['"transfer-api" is on the line and named nowhere else in the story'],
  },
  {
    n: 83,
    name: 'a story names a standard and cites none of its rules',
    files: valid({ [ITEM1_PATH]: item({ uses: 'The challenge follows ADR-007 and std-auth, and keeps the transfer-api contract.' }) }),
    exit: 1,
    includes: ['"std-auth" is a standard, and the story cites none of its rules'],
  },
  {
    n: 84,
    name: 'a story cites a rule the standard does not define',
    files: valid({ [ITEM1_PATH]: item({ uses: `${ITEM1_USES} A code expires under std-auth.09.` }) }),
    exit: 1,
    includes: [`cites std-auth.09, which ${STD_PATH} on origin/main does not define`],
  },
  {
    // The reverse rule: what the story cites, it read, so the line pins it.
    n: 85,
    name: 'a story cites a decision record and a standard rule its line does not list',
    files: valid({ [ITEM2_PATH]: item2({ uses: 'The threshold follows ADR-007 and is recorded under std-auth.01.' }) }),
    exit: 1,
    includes: ['names ADR-007, and its "Context:" line does not list it', 'cites std-auth.01, and its "Context:" line does not list std-auth'],
  },
  {
    // The floor: a document that shaped a requirement binds some story.
    n: 86,
    name: 'a document on the source\'s Context: line reaches no story',
    files: valid({ [ITEM1_PATH]: item({ context: `${ADR_ENTRY}, ${CONTRACT_ENTRY}`, uses: 'The challenge runs on the same session, as ADR-007 decides, and keeps the transfer-api contract.' }) }),
    exit: 1,
    includes: [`${SOURCE_PATH} was written against "std-auth", and no story's "Context:" line carries it`],
    excludes: ['written against "ADR-007"'],
  },
  {
    // At least one story, not every story: the second story carries none of it.
    n: 87,
    name: 'the source\'s documents spread across the stories — must pass',
    files: valid({
      [ITEM1_PATH]: item({ context: `${ADR_ENTRY}, ${CONTRACT_ENTRY}`, uses: 'The challenge runs on the same session, as ADR-007 decides, and keeps the transfer-api contract.' }),
      [ITEM2_PATH]: item2({ context: STD_ENTRY, uses: 'The threshold change is recorded under std-auth.01.' }),
    }),
    exit: 0,
    includes: ['DECOMPOSITION COMPLETE: 9 of 9 checks passed'],
  },
  {
    n: 88,
    name: 'the source carries no Context: line',
    files: valid({ [SOURCE_PATH]: source({ context: null }) }),
    exit: 1,
    includes: [`${SOURCE_PATH} carries no single well-formed "Context:" line`, `run scripts/check-requirements.js ${SLUG}`],
  },
  {
    // Context: none on the source sets no floor; each story still reads its own.
    n: 89,
    name: 'the source says Context: none — must pass',
    files: valid({ [SOURCE_PATH]: source({ context: 'none' }) }),
    exit: 0,
    includes: ['DECOMPOSITION COMPLETE: 9 of 9 checks passed'],
  },
  // ---------------------------------------------------------- the global layer
  // Fixtures 90 to 106: global Context: entries on a story
  // (docs/proposals/global-context.md §8). Each builds a real bare global
  // repository with release tags, and reads it through its own bare cache.
  // globalFiles() links the hub and has the source record v1.4.0.
  {
    // A hub without docs/estate/global.json sees no change, and nothing global is read.
    n: 90,
    name: 'global: a hub without global.json and no global entry — must pass, no global repository read',
    files: valid(),
    noGlobalRead: true,
    exit: 0,
    includes: ['DECOMPOSITION COMPLETE: 9 of 9 checks passed'],
  },
  {
    n: 91,
    name: 'global: a hub without global.json and a global entry on a story',
    global: true,
    files: globalFiles(G_ADR_ENTRY, G_ADR_USE, { link: null }),
    noGlobalRead: true,
    exit: 1,
    includes: ['"global.ADR-012" cites the global layer, and origin/main carries no docs/estate/global.json, so this hub has no global layer'],
  },
  {
    n: 92,
    name: 'global: a story cites a global record at the recorded commit, and uses it — must pass',
    global: true,
    files: globalFiles(G_ADR_ENTRY, G_ADR_USE),
    exit: 0,
    includes: ['DECOMPOSITION COMPLETE: 9 of 9 checks passed'],
  },
  {
    n: 93,
    name: 'global: a story cites a global standard by a rule it defines — must pass',
    global: true,
    files: globalFiles(G_STD_ENTRY, G_STD_USE),
    exit: 0,
    includes: ['DECOMPOSITION COMPLETE: 9 of 9 checks passed'],
  },
  {
    n: 94,
    name: 'global: a global id in the hub form and in the spoke form, and a hub id in the global form',
    global: true,
    files: globalFiles([`global.ADR-012@${GP2}:${G_ADR_PATH}`, `global.std-go@${GP2}:transfer-service:${G_STD_PATH}`, `ADR-009@${GP2}:global:docs/architecture/ADR-009-queues.md`], `${G_ADR_USE} ${G_STD_USE} Queues follow ADR-009.`),
    exit: 1,
    includes: [
      'is a global document and the entry places it in the hub. A global entry is <id>@<12-hex>:global:<path>',
      'is a global document and the entry places it in "transfer-service"',
      'places ADR-009 in the global layer, and a global document\'s id starts with "global."',
    ],
  },
  {
    n: 95,
    name: 'global: a story entry that pins another global commit than the source records',
    global: true,
    files: globalFiles(gEntry('global.ADR-012', G_ADR_PATH, GP1), G_ADR_USE),
    exit: 1,
    includes: ['pins the global commit', `and ${SOURCE_PATH} records v1.4.0 at`],
  },
  {
    n: 96,
    name: 'global: a path that is not at the commit, and a header that names another id',
    global: true,
    files: globalFiles([gEntry('global.ADR-099', 'docs/architecture/ADR-099-missing.md'), gEntry('global.ADR-013', G_ADR_PATH)], 'global.ADR-099 and global.ADR-013 apply.'),
    exit: 1,
    includes: ['"global.ADR-099" cites docs/architecture/ADR-099-missing.md, which is not in the global repository at v1.4.0', 'names "ADR-012", not "ADR-013"'],
  },
  {
    n: 97,
    name: 'global: global ids named on a story and missing from its line, and a global id on the line not used',
    global: true,
    files: globalFiles(G_STD_ENTRY, `${G_ADR_USE} The session cache is covered by global.EXC-004.`),
    exit: 1,
    includes: ['names global.ADR-012, and its "Context:" line does not list it', 'names global.EXC-004, and its "Context:" line does not list it', '"global.std-go" is a global standard on the "Context:" line, and the story cites none of its rules'],
  },
  {
    n: 98,
    name: 'global: an Active exception for this hub, with the record it departs from on the line — must pass',
    global: true,
    files: globalFiles([G_ADR_ENTRY, gExcEntry('004')], gExcUse('004')),
    exit: 0,
    includes: ['DECOMPOSITION COMPLETE: 9 of 9 checks passed'],
  },
  {
    n: 99,
    name: 'global: a Withdrawn exception',
    global: true,
    files: globalFiles([G_ADR_ENTRY, gExcEntry('005')], gExcUse('005')),
    exit: 1,
    includes: ['"global.EXC-005" is Withdrawn in the global repository at v1.4.0'],
  },
  {
    n: 100,
    name: 'global: an exception for another hub',
    global: true,
    files: globalFiles([G_ADR_ENTRY, gExcEntry('006')], gExcUse('006')),
    exit: 1,
    includes: [`"global.EXC-006" names the hubs SIM, not this hub, ${HUB_PREFIX}`],
  },
  {
    n: 101,
    name: 'global: an exception whose departed record is not on the line',
    global: true,
    files: globalFiles(gExcEntry('004'), 'The session cache stays in process under global.EXC-004.'),
    exit: 1,
    includes: ['"global.EXC-004" departs from global.ADR-012, and global.ADR-012 is not on the line'],
  },
  {
    n: 102,
    name: 'global: an exception past its review-by date — must pass, with a note',
    global: true,
    files: globalFiles([G_ADR_ENTRY, gExcEntry('007')], gExcUse('007')),
    exit: 0,
    includes: ['note: stale exception: "global.EXC-007" passed its review-by date, 2020-01-01', 'DECOMPOSITION COMPLETE: 9 of 9 checks passed'],
  },
  {
    // §9.1: the hub's list carries transfer-service, which the exception covers.
    n: 103,
    name: 'global: an exception that covers a shared spoke and does not name this hub',
    global: true,
    files: globalFiles([G_ADR_ENTRY, gExcEntry('008')], gExcUse('008')),
    exit: 1,
    includes: [`"global.EXC-008" covers transfer-service, which this hub also lists in docs/estate/repositories.json, and names the hubs SIM, not ${HUB_PREFIX}`],
  },
  {
    n: 104,
    name: 'global: the global repository does not answer — exit 2',
    global: true,
    files: globalFiles(G_ADR_ENTRY, G_ADR_USE, { link: globalLink('<GLOBAL-MISSING>') }),
    exit: 2,
    includes: ['CANNOT VERIFY: cannot reach the global repository', 'REASON: remote-unreachable'],
    excludes: ['DECOMPOSITION COMPLETE', 'DECOMPOSITION INCOMPLETE'],
  },
  {
    n: 105,
    name: 'global: a global entry on a story, and the source records "Global: none"',
    global: true,
    files: globalFiles(G_ADR_ENTRY, G_ADR_USE, { global: 'none' }),
    exit: 1,
    includes: [`and ${SOURCE_PATH} records "Global: none", so the feature reads no global release`],
  },
  {
    // The carry, compared by id: a global document that shaped a requirement binds a story.
    n: 106,
    name: 'global: the source cites a global record, and no story carries it',
    global: true,
    files: { ...globalFiles([]), [SOURCE_PATH]: source({ context: `${SOURCE_CONTEXT}, ${G_ADR_ENTRY}`, global: `v1.4.0 ${GC2}` }) },
    exit: 1,
    includes: [`${SOURCE_PATH} was written against "global.ADR-012", and no story's "Context:" line carries it`],
  },
  {
    // A bare id inside a file name names no record, as read-context.mjs reads it too.
    n: 107,
    name: 'a story with Context: none that names a file whose name holds a bare ADR id — must pass',
    files: valid({ [ITEM2_PATH]: item2({ uses: 'The ledger keeps its own notes in `docs/architecture/ADR-007-step-up-on-session.md`.' }) }),
    exit: 0,
    includes: ['DECOMPOSITION COMPLETE: 9 of 9 checks passed'],
    excludes: ['names ADR-007'],
  },
  {
    // read-context.mjs adds an always-on document to every line, whatever ids
    // it is given, so a story that does not use one is not a failure.
    n: 108,
    name: 'a story lists an always-on decision record it never names — must pass',
    files: valid({ [ALWAYS_PATH]: ALWAYS_BODY, [ITEM2_PATH]: item2({ context: `ADR-008@${gitBlob(ALWAYS_BODY).slice(0, 12)}:${ALWAYS_PATH}` }) }),
    exit: 0,
    includes: ['DECOMPOSITION COMPLETE: 9 of 9 checks passed'],
    excludes: ['named nowhere else'],
  },
  {
    // The script adds an always-on record only while it is in force.
    n: 109,
    name: 'a story lists an always-on decision record that is not Accepted, and never names it',
    files: valid({ [ALWAYS_PATH]: DEPRECATED_BODY, [ITEM2_PATH]: item2({ context: `ADR-008@${gitBlob(DEPRECATED_BODY).slice(0, 12)}:${ALWAYS_PATH}` }) }),
    exit: 1,
    includes: ['"ADR-008" is on the line and named nowhere else in the story'],
  },
  {
    n: 110,
    name: 'global: a story lists an always-on global record it never names — must pass',
    global: true,
    files: globalFiles(gEntry('global.ADR-015', G_ALWAYS_PATH)),
    exit: 0,
    includes: ['DECOMPOSITION COMPLETE: 9 of 9 checks passed'],
    excludes: ['named nowhere else'],
  },
  // The Hub commit: line on a story (PLDC-526): the trunk commit the hub's
  // documents were read at, beside the Context: line.
  {
    n: 111,
    name: 'hub commit: a story with no Hub commit: line',
    files: valid({ [ITEM2_PATH]: item2({ hubCommit: null }) }),
    exit: 1,
    includes: ['[FAIL] context documents', `${ITEM2_PATH} never says which hub commit its context documents were read at`, 'expected exactly one "Hub commit: <40-hex>", as scripts/read-context.mjs ledger-service --at <commit> --names prints it beside the Context: line'],
  },
  {
    n: 112,
    name: 'hub commit: a story with two Hub commit: lines',
    files: valid({ [ITEM2_PATH]: item2({ hubCommit: [HUB_COMMIT, 'a'.repeat(40)] }) }),
    exit: 1,
    includes: ['carries 2 "Hub commit:" lines', 'a story reads the hub at one commit'],
  },
  {
    n: 113,
    name: 'hub commit: not a full commit hash',
    files: valid({ [ITEM1_PATH]: item({ hubCommit: 'abcdef123456' }) }),
    exit: 1,
    includes: ['"Hub commit: abcdef123456" is not a full commit hash, 40 lowercase hex characters'],
  },
  {
    n: 114,
    name: 'hub commit: a commit the trunk does not hold',
    files: valid({ [ITEM1_PATH]: item({ hubCommit: 'a'.repeat(40) }) }),
    exit: 1,
    includes: [`"Hub commit: ${'a'.repeat(40)}" names a commit origin/main does not hold`, 'the story was written against a hub nobody merged', 'copy the Hub commit: and Context: lines it prints'],
  },
  {
    // Both lines are judged in one run: the Hub commit: finding does not hide
    // the Context: line's.
    n: 115,
    name: 'hub commit: a missing Hub commit: line and a bad Context: entry are both reported',
    files: valid({ [ITEM2_PATH]: item2({ hubCommit: null, context: 'see the handbook' }) }),
    exit: 1,
    includes: ['never says which hub commit its context documents were read at', '"see the handbook" is not a context entry'],
  },
  {
    // A table of the sources the planner ranked has a header that starts
    // "| Source |". A header names no document, so it is not a second Source row.
    n: 116,
    name: 'a second table whose header starts with Source — must pass',
    files: valid({ [RECORD_PATH]: record({ appendix: ['## Sources read', '', row(['Source', 'Rank', 'What it gave the cut']), sep(3), row([`\`${SOURCE_PATH}\``, '1', 'Every requirement and criterion'])].join('\n') }) }),
    exit: 0,
    includes: ['DECOMPOSITION COMPLETE: 9 of 9 checks passed'],
  },
  {
    // The stories /from-ticket takes from Jira sit under this slug, and another
    // check reads them. A decomposition may not take it.
    n: 117,
    name: 'the slug reserved for ticket stories',
    files: valid(),
    key: 'jira',
    exit: 1,
    includes: ['"jira" is reserved for stories taken from Jira tickets', 'DECOMPOSITION INCOMPLETE: the slug is reserved'],
  },
  {
    // PLDC-686: an edit removed a line break, so two Decisions rows were on one
    // line. GitHub drops the extra cells, and one decision disappears.
    n: 118,
    name: 'two Decisions rows on one line in a story',
    files: valid({ [ITEM1_PATH]: item().replace(DECISION_ROW, `${DECISION_ROW} ${row(['D-2', 'The cap is per account', 'The brief says per account', 'high', 'brief § Limits L52'])}`) }),
    exit: 1,
    includes: [`${ITEM1_PATH} line `, 'the table row has 11 cells and its header', 'has 5; write one row on one line, and a literal pipe in a cell as \\|'],
  },
  {
    n: 119,
    name: 'a Decisions row with fewer cells than its header',
    files: valid({ [ITEM1_PATH]: item().replace(DECISION_ROW, row(DECISION_CELLS.slice(0, 4))) }),
    exit: 1,
    includes: [`${ITEM1_PATH} line `, 'the table row has 4 cells and its header'],
  },
  {
    // A row with no closing pipe cannot be counted, and GitHub may still render
    // more cells than the header holds.
    n: 120,
    name: 'a Decisions row with no closing pipe',
    files: valid({ [ITEM1_PATH]: item().replace(DECISION_ROW, `${DECISION_ROW.slice(0, -2)} | D-2 | extra`) }),
    exit: 1,
    includes: [`${ITEM1_PATH} line `, 'the table row does not end with an unescaped |, so its cells cannot be counted against its header'],
    excludes: ['has 0 cells'],
  },
  {
    // A dropped row in a review can hide a finding.
    n: 121,
    name: 'two rows on one line in the review file',
    files: valid({ [REVIEW_PATH]: review().replace(`${REVIEW_ROW_1}\n${REVIEW_ROW_2}`, `${REVIEW_ROW_1} ${REVIEW_ROW_2}`) }),
    exit: 1,
    includes: [`${REVIEW_PATH} line `, 'the table row has 9 cells and its header'],
  },
  {
    // An escaped pipe is one cell. A pipe line in a code fence is not a row. Pipe
    // lines with no separator row are not a table.
    n: 122,
    name: 'an escaped pipe, a fenced pipe line, and pipe lines with no separator row — must pass',
    files: valid({
      [ITEM1_PATH]: item({
        appendix: [
          '## Notes',
          '',
          '```',
          '| a | b | c |',
          '```',
          '',
          '| one | two |',
          '| three |',
        ].join('\n'),
      }).replace('The brief names the ledger as the record', 'The brief names the ledger \\| the record'),
    }),
    exit: 0,
    includes: ['DECOMPOSITION COMPLETE: 9 of 9 checks passed'],
  },  {
    // GitHub renders a table directly under a paragraph line, with no blank line
    // between them, and drops the extra cells there too.
    n: 123,
    name: 'a Decisions table directly under a label line, with two rows on one line',
    files: valid({ [ITEM1_PATH]: item().replace('## Decisions\n\n', '## Decisions\n\nDecisions:\n').replace(DECISION_ROW, `${DECISION_ROW} ${DECISION_ROW}`) }),
    exit: 1,
    includes: [`${ITEM1_PATH} line `, 'the table row has 11 cells and its header'],
  },
  {
    // PLDC-702. A requirements pull request changes the source and cannot change
    // the record: /decompose reads a source on the trunk. The workflow says so
    // with HARNESS_SOURCE_AHEAD=1, and a retired criterion that a story still
    // carries is then a note. Fixture 68 is the same state without the variable.
    n: 98,
    name: 'the source is ahead of the record: a story carries a DEPRECATED criterion — must pass',
    files: valid({ [SOURCE_PATH]: source().replace(row(REQ1[1]), row(withCell(REQ1[1], 1, 'DEPRECATED — folded into REQ-1.AC-1 on 2026-09-12'))) }),
    env: { HARNESS_SOURCE_AHEAD: '1' },
    exit: 0,
    includes: [
      `note: ${ITEM1_PATH} line `,
      `AC-2 carries REQ-1.AC-2, which ${SOURCE_PATH} marks DEPRECATED`,
      `DECOMPOSITION BEHIND ITS SOURCE: 9 of 9 checks passed, and 1 note(s) say what the record does not carry yet. Merge the source, then run /decompose on ${SLUG}`,
    ],
    excludes: ['DECOMPOSITION COMPLETE'],
  },
  {
    // The second half of the same revision: a requirement the record does not
    // map yet. Fixture 11 is the same state without the variable.
    n: 99,
    name: 'the source is ahead of the record: a new requirement has no coverage row — must pass',
    files: valid({ [SOURCE_PATH]: source({ req3: true }) }),
    env: { HARNESS_SOURCE_AHEAD: '1' },
    exit: 0,
    includes: [`note: ${SOURCE_PATH} defines REQ-3 and ${RECORD_PATH} does not map it`, 'DECOMPOSITION BEHIND ITS SOURCE'],
  },
  {
    // A revision selects its context documents again, so the floor can move too.
    // Fixture 86 is the same state without the variable.
    n: 100,
    name: 'the source is ahead of the record: a source document reaches no story — must pass',
    files: valid({ [ITEM1_PATH]: item({ context: `${ADR_ENTRY}, ${CONTRACT_ENTRY}`, uses: 'The challenge runs on the same session, as ADR-007 decides, and keeps the transfer-api contract.' }) }),
    env: { HARNESS_SOURCE_AHEAD: '1' },
    exit: 0,
    includes: [`note: ${SOURCE_PATH} was written against "std-auth", and no story's "Context:" line carries it`, 'DECOMPOSITION BEHIND ITS SOURCE'],
  },
  {
    // The variable excuses what a newer source explains, and nothing else.
    n: 101,
    name: 'the source is ahead of the record, and the record has no review',
    files: valid({ [SOURCE_PATH]: source({ req3: true }), [REVIEW_PATH]: undefined }),
    env: { HARNESS_SOURCE_AHEAD: '1' },
    exit: 1,
    includes: [`"*.decomposition-review.md" for ${SLUG} on origin/main, found 0`, 'DECOMPOSITION INCOMPLETE: 1 of 9 checks failed'],
  },
  {
    // Only the value 1 is the workflow's. Any other value changes nothing.
    n: 102,
    name: 'HARNESS_SOURCE_AHEAD with a value other than 1 excuses nothing',
    files: valid({ [SOURCE_PATH]: source({ req3: true }) }),
    env: { HARNESS_SOURCE_AHEAD: 'true' },
    exit: 1,
    includes: ['defines REQ-3 and docs/backlog/step-up-authentication.decomposition.md does not map it'],
  },
  {
    // With the variable set and a record in step with its source, nothing changes.
    n: 103,
    name: 'HARNESS_SOURCE_AHEAD on a record in step with its source — must pass',
    files: valid(),
    env: { HARNESS_SOURCE_AHEAD: '1' },
    exit: 0,
    includes: ['DECOMPOSITION COMPLETE: 9 of 9 checks passed'],
  },
  {
    // PLDC-702, the cut after the merge. A story retires its own criterion as a
    // requirements document does: DEPRECATED first in the Criterion cell, the
    // number kept, because tests and designs name it. That row may carry a
    // criterion the source retired. Fixture 68 is the row left live.
    n: 104,
    name: 'a DEPRECATED item criterion carries a criterion the source marks DEPRECATED — must pass',
    files: valid({
      [SOURCE_PATH]: source().replace(row(REQ1[1]), row(withCell(REQ1[1], 1, 'DEPRECATED — folded into REQ-1.AC-1 on 2026-09-12'))),
      [ITEM1_PATH]: item({ criteria: [ITEM1_CRITERIA[0], withCell(ITEM1_CRITERIA[1], 1, 'DEPRECATED — REQ-1.AC-2 was retired on 2026-09-12'), ITEM1_CRITERIA[2]] }),
    }),
    exit: 0,
    includes: ['DECOMPOSITION COMPLETE: 9 of 9 checks passed'],
  },
  {
    // A retired row builds nothing, so it cannot be what makes a requirement Covered.
    n: 105,
    name: 'a requirement marked Covered that only DEPRECATED item criteria carry',
    files: valid({ [ITEM2_PATH]: item2({ criteria: ITEM2_CRITERIA.map((c) => withCell(c, 1, 'DEPRECATED — withdrawn on 2026-09-12')) }) }),
    exit: 1,
    includes: ['marks REQ-2 Covered, but no item criterion carries a REQ-2.AC-<m>'],
  },
  {
    // A requirement retired whole is excluded with that as its reason, and the
    // story that built it keeps its retired rows.
    n: 106,
    name: 'a requirement excluded as DEPRECATED whose story keeps DEPRECATED criteria — must pass',
    files: valid({
      [SOURCE_PATH]: REQ2.reduce((text, r) => text.replace(row(r), row(withCell(r, 1, 'DEPRECATED — the threshold is fixed, decided on 2026-09-12'))), source()),
      [RECORD_PATH]: record({ coverage: [COVERAGE[0], ['REQ-2 — the step-up threshold is a recorded value', 'L26-33', 'deliberately none', 'Out of scope', 'DEPRECATED in the source on 2026-09-12; product owner'], COVERAGE[2]] }),
      [ITEM2_PATH]: item2({ criteria: ITEM2_CRITERIA.map((c) => withCell(c, 1, 'DEPRECATED — REQ-2 was retired on 2026-09-12')) }),
    }),
    exit: 0,
    includes: ['DECOMPOSITION COMPLETE: 9 of 9 checks passed'],
  },
];

/* ---------------------------------------------------------------------- runner */

const COMMON = {
  'package.json': `${JSON.stringify({ name: 'decomposition-fixture', private: true, type: 'module' }, null, 2)}\n`,
  '.gitignore': 'node_modules\n',
  [ADR_PATH]: ADR_BODY,
  [STD_PATH]: STD_BODY,
};

function blobHash(content) {
  const body = Buffer.from(content, 'utf8');
  return createHash('sha1').update(`blob ${body.length}\0`).update(body).digest('hex');
}

function bind(files) {
  const record = files[RECORD_PATH];
  const hash = record === undefined ? '0'.repeat(40) : blobHash(record);
  const bound = {};
  for (const [rel, body] of Object.entries(files)) {
    if (body === undefined) continue;
    bound[rel] = typeof body === 'string' ? body.split(RECORD_REVISION).join(hash) : body;
  }
  return bound;
}

function buildRepo(root, fixture) {
  const remote = join(root, 'remote.git');
  const work = join(root, 'work');
  git(root, ['init', '--bare', '-q', 'remote.git']);
  git(root, ['--git-dir', 'remote.git', 'symbolic-ref', 'HEAD', 'refs/heads/main']);
  git(root, ['init', '-q', 'work']);
  git(work, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  git(work, ['config', 'user.name', 'Fixture Runner']);
  git(work, ['config', 'user.email', 'fixture@example.invalid']);
  git(work, ['config', 'commit.gpgsign', 'false']);
  git(work, ['remote', 'add', 'origin', remote]);

  // Commit 0: the hub's context documents, as /add-context lands them. Its hash
  // is what a story's Hub commit: line names, so it exists before the story does.
  writeFiles(work, COMMON);
  mkdirSync(join(work, 'scripts'), { recursive: true });
  copyFileSync(CHECK, join(work, 'scripts', 'check-decomposition.js'));
  // The global repository first, so its commits are known before the review
  // names the record's hash.
  const values = fixture.global ? buildGlobal(root) : null;
  const files = substitute(fixture.files === undefined ? valid() : fixture.files, values);
  const isHubDocument = (rel) => HUB_DOCUMENT_FOLDERS.some((folder) => rel.startsWith(folder));
  writeFiles(work, Object.fromEntries(Object.entries(files).filter(([rel]) => isHubDocument(rel))));
  git(work, ['add', '-A']);
  git(work, ['commit', '-q', '-m', 'hub documents', '--allow-empty']);
  const hubCommit = git(work, ['rev-parse', 'HEAD']).trim();
  const atHub = (set) => substitute(set, { [HUB_COMMIT]: hubCommit });

  // Commit 1: the estate and the decomposition land together, as the merge of
  // the decomposition pull request would land them on a hub that already had
  // its list and its source document.
  writeFiles(work, bind(atHub(Object.fromEntries(Object.entries(files).filter(([rel]) => !isHubDocument(rel))))));
  writeLinks(work, fixture.symlinks || {});
  git(work, ['add', '-A']);
  git(work, ['commit', '-q', '-m', 'decomposition merged', '--allow-empty']);

  for (const change of [].concat(fixture.thenChange || [])) {
    writeFiles(work, atHub(change));
    git(work, ['add', '-A']);
    git(work, ['commit', '-q', '-m', 'later revision']);
  }
  git(work, ['push', '-q', 'origin', 'main']);

  if (fixture.branch) {
    git(work, ['checkout', '-q', '-b', fixture.branch.name]);
    writeFiles(work, bind(atHub(fixture.branch.files)));
    git(work, ['add', '-A']);
    git(work, ['commit', '-q', '-m', 'record on a feature branch']);
    git(work, ['push', '-q', 'origin', fixture.branch.name]);
    git(work, ['checkout', '-q', 'main']);
  }

  if (fixture.breakRemote) {
    git(work, ['remote', 'set-url', 'origin', join(root, 'no-such-remote.git')]);
  }

  if (fixture.shallow) {
    const shallow = join(root, 'shallow');
    git(root, ['clone', '-q', '--depth', '1', `file://${remote}`, shallow]);
    return shallow;
  }
  return work;
}

function runFixture(fixture) {
  const root = mkdtempSync(join(tmpdir(), `decomposition-fx${String(fixture.n).padStart(2, '0')}-`));
  try {
    const work = buildRepo(root, fixture);
    const cwd = fixture.from ? join(work, fixture.from) : work;
    const script = fixture.from
      ? `${fixture.from.split('/').map(() => '..').join('/')}/scripts/check-decomposition.js`
      : 'scripts/check-decomposition.js';
    // Every fixture reads the global repository through its own bare cache.
    const cache = join(root, 'cache');
    const res = spawnSync(process.execPath, [script, fixture.key || SLUG], {
      cwd, env: { ...ENV, HARNESS_SPOKE_CACHE: cache, ...(fixture.env || {}) }, encoding: 'utf8',
    });
    const output = `${res.stdout || ''}${res.stderr || ''}`;
    const problems = [];
    if (res.status !== fixture.exit) {
      problems.push(`expected exit ${fixture.exit}, got ${res.status}`);
    }
    if (fixture.noGlobalRead && existsSync(join(cache, 'global.git'))) {
      problems.push('the check made a cache for the global repository, so it read it');
    }
    for (const needle of fixture.includes || []) {
      if (!output.includes(needle)) problems.push(`output does not contain: ${needle}`);
    }
    for (const needle of fixture.excludes || []) {
      if (output.includes(needle)) problems.push(`output should not contain: ${needle}`);
    }
    return { problems, output, root };
  } catch (err) {
    return { problems: [`fixture setup failed: ${err && err.message ? err.message : String(err)}`], output: '', root };
  } finally {
    if (!process.argv.includes('--keep')) rmSync(root, { recursive: true, force: true });
  }
}

function main() {
  const wanted = process.argv.slice(2).filter((a) => /^\d+$/.test(a)).map(Number);
  const selected = wanted.length ? FIXTURES.filter((f) => wanted.includes(f.n)) : FIXTURES;

  process.stdout.write(`\ncheck-decomposition fixture suite — ${selected.length} of ${FIXTURES.length} fixtures\n`);
  process.stdout.write(`check under test: ${CHECK}\n\n`);

  let failed = 0;
  for (const fixture of selected) {
    const { problems, output } = runFixture(fixture);
    const label = `${String(fixture.n).padStart(2, ' ')}. ${fixture.name} [exit ${fixture.exit}]`;
    if (problems.length === 0) {
      process.stdout.write(`  PASS  ${label}\n`);
    } else {
      failed += 1;
      process.stdout.write(`  FAIL  ${label}\n`);
      for (const p of problems) process.stdout.write(`          - ${p}\n`);
      process.stdout.write(`${output.split('\n').map((l) => `          | ${l}`).join('\n')}\n`);
    }
  }

  process.stdout.write(
    failed
      ? `\n${failed} of ${selected.length} fixtures FAILED. The check is not trustworthy until this is green.\n\n`
      : `\nAll ${selected.length} fixtures passed.\n\n`
  );
  rmSync(SANDBOX_HOME, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
}

main();

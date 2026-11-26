#!/usr/bin/env node
/**
 * run.mjs — the fixture suite for check-context.mjs.
 *
 *   usage:  node run.mjs            run every fixture
 *           node run.mjs 2 6        run only the numbered fixtures
 *           node run.mjs --keep     leave the throwaway repositories on disk
 *
 * A fixture is a REPOSITORY STATE: a throwaway hub on disk with its constitution,
 * rules, document folders, one merged requirements document with its review and
 * the estate overview, a real bare spoke remote with a commands file and a
 * contracts folder, a registry pointing at it, and the shipped script run from
 * the hub exactly as CI would run it. Exit code and report text are asserted.
 * Nothing is written: the folders are the fact, and the index a design reads is
 * the read-context suite's to prove. Fixture 1 is the valid control; most others
 * change exactly one thing.
 *
 * Node standard library only, plus git via child_process. No test framework.
 * Exit 0 if every fixture passes, 1 if any fails.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

const SCRIPT = [
  process.env.HARNESS_CHECK_CONTEXT,
  resolve(HERE, '..', '..', 'check-context.mjs'),
  resolve(HERE, '..', '..', 'scripts', 'check-context.mjs'),
].filter(Boolean).find((p) => existsSync(p));

if (!SCRIPT) {
  console.error('cannot locate check-context.mjs. Set HARNESS_CHECK_CONTEXT=/path/to/check-context.mjs.');
  process.exit(4);
}

/* ------------------------------------------------------------------ git helpers */

const SANDBOX_HOME = mkdtempSync(join(tmpdir(), 'context-home-'));
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
    if (body === null) {
      rmSync(abs, { force: true });
      continue;
    }
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

const CHECKS = (contractsIndex, trunkForHub = 'default') => [
  'FORMAT_COMMAND=none',
  'TEST_COMMAND=npm test',
  `TRUNK_FOR_HUB=${trunkForHub}`,
  ...(contractsIndex === undefined ? [] : [`CONTRACTS_INDEX=${contractsIndex}`]),
  'STORY_GATE_EXCEPTION=^harness/',
  '',
].join('\n');

const doc = ({ name, kind, description = `The ${name} document.`, globs = '[]', alwaysApply = false, owner = 'tech lead', revision = 'v3.2, 2026-08-01', origin = 'client, by e-mail, 2026-08-01', body = `# ${name}\n\nHow to call it.\n`, drop = [], status = null }) => {
  const lines = [
    `name: ${name}`, `description: ${description}`, `globs: ${globs}`, `alwaysApply: ${alwaysApply}`,
    `kind: ${kind}`, ...(status === null ? [] : [`status: ${status}`]), `owner: ${owner}`, `revision: ${revision}`, `origin: ${origin}`,
  ].filter((l) => !drop.some((k) => l.startsWith(`${k}:`)));
  return `---\n${lines.join('\n')}\n---\n\n${body}`;
};

const VENDOR_DOC = doc({ name: 'vendor-a-api', kind: 'vendor-doc', description: 'Acme Pay: how a charge is created and confirmed.', globs: '["src/payments/**"]', body: '# Acme Pay API\n\nPOST /charges creates a charge. Confirm within 15 minutes or it lapses.\n' });
const LEDGER_CONTRACT = doc({ name: 'ledger-write-api', kind: 'contract', description: 'The ledger write API this service calls.', revision: 'v2', origin: 'ledger-service, contracts/write.yaml' });

// A hub copy of a decision record kept where the client keeps its records: the
// shared header plus `status`, then the five sections an agent acts on. `name`
// may differ from `n` on purpose, and `drop` removes header lines by key.
const adr = ({ n = '004', name = `ADR-${n}`, title = 'Serve eligibility from a read model, not the ledger', status = 'Accepted', globs = '["services/eligibility/**"]', drop = [] } = {}) => {
  const lines = [
    `name: ${name}`, `description: ${title}`, `globs: ${globs}`, 'alwaysApply: false', 'kind: adr', `status: ${status}`,
    'owner: lead architect', 'revision: page version 7, 2026-08-20', `origin: https://wiki.example.invalid/architecture/ADR-${n}`,
  ].filter((l) => !drop.some((k) => l.startsWith(`${k}:`)));
  return `---\n${lines.join('\n')}\n---\n\n${[
    `# ADR-${n}: ${title}`, '',
    '## Decision', '', 'Eligibility is read from the read model.', '',
    '## Rules', '', '- MUST read eligibility from the projection.', '- MUST NOT query the ledger tables for eligibility.', '',
    '## Why', '', 'A read latency budget of 200ms at the 95th percentile — source: contract eligibility-api v2.', '',
    '## Rejected', '', '- Not reading the ledger directly — because it misses the latency budget.', '',
    '## Accepted costs', '', '- Up to 2 seconds of delay on reads.', '',
  ].join('\n')}`;
};

// A hub standard: the shared header, then the template's nine sections in
// order, every rule under an id of the standard's own name. `sections`
// replaces a section's lines by name (null drops it); `head` replaces the lines
// between the header and the first section; `name` may differ from `std-<topic>`
// on purpose.
const STANDARD_SECTIONS = {
  'Applies to': ['Every SQL file in the estate.'],
  Must: [`- **<ID>.01** MUST name tables in snake_case. *(Source: §2)*`, `- **<ID>.02** MUST NOT use SELECT * in application code. *(Source: §3)*`],
  Should: [`- **<ID>.03** SHOULD keep one statement per line. *(Source: §4)*`],
  Values: ['| Value | Setting | Applies to | Source |', '|---|---|---|---|', '| Line length | 120 | SQL files | §4 |'],
  'Checked by': [`- **<ID>.01** — review: a reviewer reads every table name.`],
  Relations: ['None.'],
  Exceptions: ['The data platform team grants one, recorded in the pull request.'],
  Unresolved: ['- UNRESOLVED — the migration tool. Owner: data platform team. Resolves: when the platform picks one.'],
  Origin: ['SQL style guide, page 812, revision 2026-03. Omitted: history and worked examples.'],
};
const standard = ({ topic = 'sql-style', name = `std-${topic}`, title = 'SQL style', description = 'How SQL is written across the estate.', globs = '["**/*.sql"]', alwaysApply = false, revision = '2026-03', origin = 'client data platform team', status = 'Active', head = null, sections = {} } = {}) => {
  const all = { ...STANDARD_SECTIONS, ...sections };
  const body = [
    ...(head || [`# std-${topic}: ${title}`, '']),
    ...Object.entries(all).filter(([, lines]) => lines !== null).flatMap(([h, lines]) => [`## ${h}`, '', ...lines.map((l) => l.replaceAll('<ID>', `std-${topic}`)), '']),
  ].join('\n');
  return doc({ name, kind: 'standard', status, description, globs, alwaysApply, revision, origin, body });
};
const SQL_STANDARD = 'docs/standards/std-sql-style.md';

// An always-on rule binds every path and carries no paths:. A path-scoped rule carries
// paths: equal to its globs:, because Claude Code reads only paths: (checkRulesScoped).
const RULE = (name, alwaysApply, { globs = alwaysApply ? '["**/*"]' : '["src/**"]', paths = alwaysApply ? null : globs } = {}) =>
  `---\nname: ${name}\ndescription: The ${name} rule.\nglobs: ${globs}\nalwaysApply: ${alwaysApply}\n${paths === null ? '' : `paths: ${paths}\n`}---\n\n# Rule — ${name}\n\n- One sentence.\n`;

// The requirements document /feature wrote and a person merged: the template's
// title and its §1 Document control table, read by label, then a short body. It
// carries no header -- the parser reads the document's own structure. `slugCell`
// is the whole Slug cell as written; `drop` removes rows by label; `h1: false`
// leaves the title out. The fenced row at the end must never be read: a fence
// is not content.
const REQUIREMENTS = ({ slug = 'onboarding', title = 'Onboarding: a new customer opens an account in one sitting', revision = 'r1', date = '2026-07-30', owner = 'product owner', slugCell = `\`${slug}\``, drop = [], h1 = true } = {}) => [
  ...(h1 ? [`# Requirements — ${title}`, ''] : []),
  '## 1. Document control',
  '',
  '| Field | Value |',
  '|---|---|',
  ...[
    ['Document revision', revision],
    ['Date', date],
    ['Owning role', owner],
    ['Review', '`requirements-review.md` — beside this document, bound to its bytes'],
    ['Slug', slugCell],
    ['Source locator convention', 'note identifiers for `interview.md`'],
  ].filter(([label]) => !drop.includes(label)).map(([label, value]) => `| ${label} | ${value} |`),
  '',
  '## 2. Purpose and business outcome',
  '',
  'A new customer opens an account without leaving the flow.',
  '',
  '```',
  '| Slug | not-a-slug |',
  '```',
  '',
].join('\n');
const REQ_DOC = REQUIREMENTS();

// The git blob hash of a text, without git: what `git hash-object` prints and
// what a review's `Document revision:` line names.
const blobHash = (text) => {
  const buf = Buffer.from(text, 'utf8');
  return createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');
};

// The critic's final round beside the document, in the shape the requirements
// gate reads: one verdict line, the mode, and `Document revision:` binding it to
// the bytes of `of` -- the document by default, other bytes on purpose.
const REVIEW = ({ slug = 'onboarding', verdict = '### VERDICT: APPROVED', of = REQ_DOC } = {}) => [
  `## Review: ${slug} — the requirements document against the brief`,
  '',
  verdict,
  'Cycle: 1 of 2',
  'Mode: feature-review',
  'Reviewer: pm-critic',
  `Document revision: ${blobHash(of)}`,
  '',
  '#### SUGGESTION',
  '- none',
  '',
].join('\n');
const REQ_REVIEW = REVIEW();

const CONSTITUTION = (imports) => [
  '# Constitution',
  '',
  'The always-on rules are imported here, by path.',
  '',
  ...imports.map((p) => `@${p}`),
  '',
  '## 4. Source of truth',
  '',
].join('\n');

const BRIEF = doc({ name: 'onboarding-20260730-0930-onboarding-brief', kind: 'requirements-source', description: 'The onboarding brief /feature was run on.', revision: 'v1.1, 2026-07-30', origin: 'product one-pager, wiki page 4412' });
// The one estate overview: one file at docs/estate/overview.md, one fixed id, never always on.
const OVERVIEW = ({ name = 'estate-overview', globs = '[]', alwaysApply = false } = {}) => doc({ name, kind: 'estate-overview', description: 'What the estate is, part by part, for a reader who has never seen it.', globs, alwaysApply, owner: 'lead architect', revision: '2026-09-01', origin: 'written by the lead architect, /add-context', body: '# The estate\n\nOne transfer service and one ledger.\n' });

const HUB = {
  'CLAUDE.md': CONSTITUTION(['.claude/rules/workflow.md', '.claude/rules/estate.md']),
  '.claude/rules/workflow.md': RULE('workflow', true),
  '.claude/rules/estate.md': RULE('estate', true),
  '.claude/rules/testing.md': RULE('testing', false),
  'docs/architecture/_TEMPLATE.adr.md': '# ADR-<NNN>: <state the decision>\n',
  'docs/architecture/README.md': '# Records\n',
  'docs/architecture/ADR-004-eligibility-read-model.md': adr({}),
  [SQL_STANDARD]: standard(),
  'docs/standards/std-handbook.md': standard({ topic: 'handbook', title: 'Client engineering handbook', description: 'The client handbook every design obeys.', globs: '[]', alwaysApply: true, revision: '2026 edition', origin: 'client intranet, copied 2026-09-01' }),
  'docs/standards/_TEMPLATE.standard.md': '---\nname: std-<topic>\n---\n\n# std-<topic>: <the topic, in a few words>\n',
  // The merged requirements document is one file per slug folder, its id the
  // slug; the review beside it approves its bytes, so it is `accepted`. A
  // requirements source is filed <slug>/runs/<yyyymmdd_hhmm>/<file>.md -- one folder
  // per requirements document, one per /feature run -- and its id is slug, stamp (the
  // underscore made a hyphen) and stem.
  'docs/requirements/onboarding/requirements.md': REQ_DOC,
  'docs/requirements/onboarding/requirements-review.md': REQ_REVIEW,
  'docs/requirements/onboarding/runs/20260730_0930/onboarding-brief.md': BRIEF,
  // The estate folder: the overview is the one document in it; the template and
  // /add-repo's drafts sit beside it and are not read.
  'docs/estate/overview.md': OVERVIEW(),
  'docs/estate/_TEMPLATE.overview.md': '---\nname: estate-overview\ndescription: <what this estate is>\n---\n',
  'docs/estate/drafts/ledger-service.checks.env': 'TEST_COMMAND=npm test\n',
};

const SPOKE = {
  'README.md': '# transfer-service\n\nMoves money between accounts.\n',
  'checks.env': CHECKS('contracts'),
  'contracts/vendor-a/api.md': VENDOR_DOC,
  'contracts/vendor-a/openapi.yaml': 'openapi: 3.1.0\n',
  'contracts/ledger-write-api.md': LEDGER_CONTRACT,
  'src/payments/charge.ts': 'export {};\n',
};

// The spoke's own decision record: numbered by the spoke, ADR-004 in its file, and
// transfer-service.ADR-004 everywhere else.
const RETRY_RECORD = adr({ n: '004', title: 'Retry a charge three times, then give up', globs: '["src/payments/**"]' });
const SPOKE_RECORDS = { 'checks.env': `${CHECKS('contracts')}DECISIONS_INDEX=decisions\n`, 'decisions/ADR-004-retry-budget.md': RETRY_RECORD };

const registry = (repositories) => JSON.stringify({ schema_version: 1, repositories }, null, 2);
const entry = (remote, checks = 'checks.env', readAt = remote.head, trunk = 'default') => ({ url: remote.url, checks, purpose: 'Moves money between accounts.', readAt, trunk });

const withHub = (overrides) => {
  const files = { ...HUB };
  for (const [k, v] of Object.entries(overrides)) {
    if (v === null) delete files[k];
    else files[k] = v;
  }
  return files;
};
const withSpoke = (overrides) => {
  const files = { ...SPOKE };
  for (const [k, v] of Object.entries(overrides)) {
    if (v === null) delete files[k];
    else files[k] = v;
  }
  return files;
};

/* ------------------------------------------------- the global repository */

// The global context repository: a plain git repository on disk, its history
// built commit by commit, and check-context.mjs --global run at its root as
// global-gate runs it. Each map in `commits` is written, a null value deleting
// the file, and committed.
function globalRepo(root, commits, { name = 'global-context' } = {}) {
  const dir = join(root, name);
  git(root, ['init', '-q', '--initial-branch', 'main', dir]);
  git(dir, ['config', 'user.name', 'Fixture Runner']);
  git(dir, ['config', 'user.email', 'fixture@example.invalid']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  commits.forEach((files, i) => {
    writeFiles(dir, files);
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-q', '--allow-empty', '-m', `commit ${i + 1}`]);
  });
  return dir;
}

// An exception in the shape of docs/proposals/global-context.md §9.3. `drop`
// removes header lines by key; `reason` replaces the Reason section's text.
const EXCEPTION = ({ n = '004', hubs = '["SIM"]', repositories = '["sim-desktop", "sim-content-pack"]', departs = '["ADR-012", "std-go.02"]', status = 'Active', reviewBy = '2027-04-01', reason = 'ADR-012 requires Redis for every cache. No Redis is reachable in an exam room.', drop = [] } = {}) => {
  const lines = [
    `name: EXC-${n}`, 'description: The desktop simulator keeps an in-process cache instead of Redis, because it runs offline.', 'kind: exception',
    `hubs: ${hubs}`, `repositories: ${repositories}`, `departs: ${departs}`, `status: ${status}`, `review-by: ${reviewBy}`,
    'owner: desktop simulator tech lead', 'approver: Global Architecture Board', 'revision: v1', 'origin: this repository',
  ].filter((l) => !drop.some((k) => l.startsWith(`${k}:`)));
  return `---\n${lines.join('\n')}\n---\n\n${[
    `# EXC-${n} — the desktop simulator's offline cache`, '',
    '## Reason', '', reason, '',
    '## Scope', '', 'Only the cache that holds item banks during a session.', '',
    '## Alternatives considered', '', '- Embedded Redis in the installer. Rejected: it adds 40 MB and a second process.', '',
    '## What the product does instead', '', 'SIM hub record ADR-031 states the decision.', '',
    '## Exit', '', 'The simulator gains a network mode in exam rooms.', '',
  ].join('\n')}`;
};

const GLOBAL_ADR = 'docs/architecture/ADR-012-redis-only.md';
const GLOBAL_GO = 'docs/standards/std-go.md';
const GLOBAL_SECURITY = 'docs/standards/std-security.md';
const GLOBAL_EXC = 'docs/exceptions/EXC-004-sim-offline-cache.md';
const REDIS_ONLY = adr({ n: '012', title: 'Use only Redis for caching', globs: '["**/cache/**"]' });
const GLOBAL_DOCS = {
  'README.md': '# Global context\n\nThe records, standards and exceptions every product follows.\n',
  'docs/architecture/_TEMPLATE.adr.md': '# ADR-<NNN>: <state the decision>\n',
  'docs/exceptions/_TEMPLATE.exception.md': '# EXC-<NNN> — <the departure>\n',
  [GLOBAL_ADR]: REDIS_ONLY,
  [GLOBAL_GO]: standard({ topic: 'go', title: 'Go', description: 'How Go is written in every product.', globs: '["**/*.go"]', origin: 'Global Architecture Board' }),
  [GLOBAL_SECURITY]: standard({ topic: 'security', title: 'Security baseline', description: 'The security baseline every product follows.', globs: '[]', alwaysApply: true, origin: 'Global Architecture Board' }),
  [GLOBAL_EXC]: EXCEPTION(),
};
const withGlobal = (overrides) => {
  const files = { ...GLOBAL_DOCS };
  for (const [k, v] of Object.entries(overrides)) {
    if (v === null) delete files[k];
    else files[k] = v;
  }
  return files;
};
// A fixture that runs --global at the root of a global repository built from `commits`.
const globalFixture = (n, name, commits, rest) => ({
  n,
  name,
  build: (root) => ({ registry: null, hub: {}, trunk: false, cwd: globalRepo(root, typeof commits === 'function' ? commits() : commits), args: ['--global'] }),
  ...rest,
});
// A record with a description near the 200-character cap, so a few dozen fill the index.
const longRecord = (i, status = 'Accepted') => {
  const n = String(i).padStart(3, '0');
  const title = `Decision ${n}: ${'keep each service boundary exactly as its published contract states it, '.repeat(3)}`.slice(0, 190).trim();
  return [`docs/architecture/ADR-${n}-boundary.md`, adr({ n, title, status, globs: '["**/boundary/**"]' })];
};
const manyRecords = (count, superseded = 0) => Object.fromEntries(Array.from({ length: count }, (_, i) => longRecord(i + 1, i < superseded ? `Superseded by ADR-${String(count).padStart(3, '0')}` : 'Accepted')));

/* ------------------------------------------------------------------- fixtures */

// `build(root)` returns { registry, hub, args, before?, expect? }. `hub` is
// written into the throwaway hub before the run; `before(hub, env)` runs after
// that and before the script; `expect(stdout, hub)` may return extra problems.
const FIXTURES = [
  {
    n: 1,
    name: 'valid control: a hub with a record, two standards, an accepted requirements document with its review, a source and the overview, a spoke with two contracts and a schema beside them; every document parses, the schema is not one, and the review is peeked at for the status alone',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [SPOKE] });
      return { registry: registry({ 'transfer-service': entry(a) }), hub: HUB, args: [] };
    },
    exit: 0,
    includes: ['context documents\n', '[PASS] hub', '6 document(s): 1 in docs/architecture, 2 in docs/standards, 2 in docs/requirements (1 requirements document(s), 1 requirements source(s)), 1 in docs/estate', 'docs/requirements/onboarding/requirements.md: accepted -- requirements-review.md approves its bytes', '[PASS] always-on rules    2 imported by CLAUDE.md', '[PASS] transfer-service   2 document(s) in contracts at', 'WELL FORMED: 8 context document(s); every always-on rule is imported.'],
    excludes: ['openapi.yaml', '_TEMPLATE', 'drafts', 'ledger ', 'context.json', 'requirements-review.md:', 'not-a-slug'],
  },
  {
    n: 2,
    name: 'a vendor document with no owner: the header is incomplete and the spoke fails',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [withSpoke({ 'contracts/vendor-a/api.md': doc({ name: 'vendor-a-api', kind: 'vendor-doc', drop: ['owner'] }) })] });
      return { registry: registry({ 'transfer-service': entry(a) }), hub: HUB, args: [] };
    },
    exit: 1,
    includes: ['[FAIL] transfer-service', 'contracts/vendor-a/api.md: frontmatter is missing "owner"', 'NOT WELL FORMED: a document is malformed, a rule binds nobody, or an id is doubled. Fix it where it lives.'],
  },
  {
    n: 3,
    name: 'a revision of TBD is a placeholder, not a revision',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [withSpoke({ 'contracts/vendor-a/api.md': doc({ name: 'vendor-a-api', kind: 'vendor-doc', revision: 'TBD' }) })] });
      return { registry: registry({ 'transfer-service': entry(a) }), hub: HUB, args: [] };
    },
    exit: 1,
    includes: ['revision is empty or a placeholder ("TBD")'],
  },
  {
    n: 4,
    name: 'a hub standard whose header says kind: contract: a contract lives in a spoke, not in docs/standards',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [SPOKE] });
      return {
        registry: registry({ 'transfer-service': entry(a) }),
        hub: withHub({ 'docs/standards/std-ledger-write-api.md': doc({ name: 'ledger-write-api', kind: 'contract' }) }),
        args: [],
      };
    },
    exit: 1,
    includes: ['[FAIL] hub', 'kind "contract" does not live in this folder; this folder holds standard and a contract lives in the spoke folder CONTRACTS_INDEX names (contracts/ by convention)'],
  },
  {
    n: 5,
    name: 'a record with no status line: the header is incomplete',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [SPOKE] });
      return {
        registry: registry({ 'transfer-service': entry(a) }),
        hub: withHub({ 'docs/architecture/ADR-004-eligibility-read-model.md': adr({ drop: ['status'] }) }),
        args: [],
      };
    },
    exit: 1,
    includes: ['docs/architecture/ADR-004-eligibility-read-model.md: frontmatter is missing "status"'],
  },
  {
    n: 6,
    name: 'a superseded record names the record that replaced it and is still a document',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [SPOKE] });
      return {
        registry: registry({ 'transfer-service': entry(a) }),
        hub: withHub({ 'docs/architecture/ADR-004-eligibility-read-model.md': adr({ status: 'Superseded by ADR-009' }) }),
        args: [],
      };
    },
    exit: 0,
    includes: ['[PASS] hub', '6 document(s): 1 in docs/architecture', 'WELL FORMED: 8 context document(s)'],
  },
  {
    n: 7,
    name: 'a markdown file in docs/architecture that is not a record and not the template',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [SPOKE] });
      return {
        registry: registry({ 'transfer-service': entry(a) }),
        hub: withHub({ 'docs/architecture/notes.md': '# Notes\n\nSome notes.\n' }),
        args: [],
      };
    },
    exit: 1,
    includes: ['docs/architecture/notes.md: is not a decision record file (ADR-<NNN>[-<slug>].md) and not the template'],
  },
  {
    n: 8,
    name: 'a record whose title numbers it differently from its file name',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [SPOKE] });
      return {
        registry: registry({ 'transfer-service': entry(a) }),
        hub: withHub({ 'docs/architecture/ADR-004-eligibility-read-model.md': adr({}).replace('# ADR-004:', '# ADR-005:') }),
        args: [],
      };
    },
    exit: 1,
    includes: ['title names ADR-005 and the name is ADR-004; one record, one number'],
  },
  {
    n: 9,
    name: 'an always-on rule the constitution does not import binds nobody',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [SPOKE] });
      return {
        registry: registry({ 'transfer-service': entry(a) }),
        hub: withHub({ 'CLAUDE.md': CONSTITUTION(['.claude/rules/workflow.md']) }),
        args: [],
      };
    },
    exit: 1,
    includes: ['[FAIL] always-on rules    1 imported by CLAUDE.md', '.claude/rules/estate.md: is alwaysApply: true and CLAUDE.md does not import it (no "@.claude/rules/estate.md" line); an always-on rule nothing loads binds nobody'],
  },
  {
    n: 10,
    name: 'one id used by a hub requirements document and a spoke contract: a design could not say which it read',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [withSpoke({ 'contracts/ledger-write-api.md': doc({ name: 'onboarding', kind: 'contract' }) })] });
      return { registry: registry({ 'transfer-service': entry(a) }), hub: HUB, args: [] };
    },
    exit: 1,
    includes: ['[FAIL] ids', 'id "onboarding" is both hub:docs/requirements/onboarding/requirements.md and transfer-service:contracts/ledger-write-api.md'],
  },
  {
    n: 11,
    name: 'CONTRACTS_INDEX=none: the spoke says on purpose that it has no contracts',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [{ 'README.md': '# x\n', 'checks.env': CHECKS('none') }] });
      return { registry: registry({ 'transfer-service': entry(a) }), hub: HUB, args: [] };
    },
    exit: 0,
    includes: ['[PASS] transfer-service   CONTRACTS_INDEX=none: no contracts, on purpose', 'WELL FORMED: 6 context document(s)'],
  },
  {
    n: 12,
    name: 'CONTRACTS_INDEX=UNRESOLVED: NOT CONFIGURED, reported and never a stop',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [{ 'README.md': '# x\n', 'checks.env': CHECKS('UNRESOLVED') }] });
      return { registry: registry({ 'transfer-service': entry(a) }), hub: HUB, args: [] };
    },
    exit: 0,
    includes: ['[PASS] transfer-service   CONTRACTS_INDEX NOT CONFIGURED: reported, never a stop'],
  },
  {
    n: 13,
    name: 'no CONTRACTS_INDEX key at all, even with a contracts/ folder on disk: NOT CONFIGURED, and the folder is not read until the spoke says so',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [{ 'README.md': '# x\n', 'checks.env': CHECKS(undefined), 'contracts/vendor-a.md': VENDOR_DOC }] });
      return { registry: registry({ 'transfer-service': entry(a) }), hub: HUB, args: [] };
    },
    exit: 0,
    includes: ['[PASS] transfer-service   CONTRACTS_INDEX NOT CONFIGURED: reported, never a stop', 'WELL FORMED: 6 context document(s)'],
    excludes: ['vendor-a-api'],
  },
  {
    n: 14,
    name: 'a declared CONTRACTS_INDEX folder that is not at the commit',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [{ 'README.md': '# x\n', 'checks.env': CHECKS('api/contracts') }] });
      return { registry: registry({ 'transfer-service': entry(a) }), hub: HUB, args: [] };
    },
    exit: 1,
    includes: ['[FAIL] transfer-service   missing folder', 'checks.env says CONTRACTS_INDEX=api/contracts, and api/contracts is not a folder at this commit'],
  },
  {
    n: 15,
    name: 'a declared CONTRACTS_INDEX folder elsewhere is read from where the commands file says',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [{ 'README.md': '# x\n', 'checks.env': CHECKS('api/contracts'), 'api/contracts/vendor-a.md': VENDOR_DOC }] });
      return { registry: registry({ 'transfer-service': entry(a) }), hub: HUB, args: [] };
    },
    exit: 0,
    includes: ['1 document(s) in api/contracts at', 'WELL FORMED: 7 context document(s)'],
  },
  {
    n: 16,
    name: 'readAt behind the trunk head: documents are read at readAt, the lag is reported, and nothing fails',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [SPOKE] });
      const pinned = a.head;
      return {
        registry: registry({ 'transfer-service': entry(a, 'checks.env', pinned) }),
        hub: HUB,
        before: () => {
          advance(a, { 'contracts/vendor-b.md': doc({ name: 'vendor-b-api', kind: 'vendor-doc' }) });
        },
        args: [],
        expect: (out) => (out.includes('vendor-b-api') ? ['the document added after readAt was read'] : []),
      };
    },
    exit: 0,
    includes: ['is behind the trunk head', 'documents were read at readAt. Run /add-repo', 'WELL FORMED: 8 context document(s)'],
  },
  {
    n: 17,
    name: 'the remote is unreachable: cannot verify, not a failure',
    build: (root) => ({
      registry: registry({ 'transfer-service': { url: join(root, 'no-such-remote.git'), checks: 'checks.env', purpose: 'Gone.', readAt: 'a'.repeat(40), trunk: 'default' } }),
      hub: HUB,
      args: [],
    }),
    exit: 2,
    includes: ['[CANNOT VERIFY] transfer-service   not reached', 'CANNOT VERIFY: at least one repository could not be reached', 'REASON: remote-unreachable'],
    excludes: ['WELL FORMED', 'NOT WELL FORMED'],
  },
  {
    n: 18,
    name: '--offline: the hub and its rules are checked, the list is read for shape, the spokes are counted and not asked, nothing is written, and the whole thing passes',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [SPOKE] });
      return { registry: registry({ 'transfer-service': entry(a) }), hub: HUB, args: ['--offline'], expect: (out, hub) => (existsSync(join(hub, 'docs', 'estate', 'context.json')) ? ['a file was written under docs/estate/'] : []) };
    },
    exit: 0,
    includes: ['context documents  (offline: remotes not asked)', '[PASS] hub', '[PASS] always-on rules    2 imported by CLAUDE.md', '[PASS] spokes             1 listed, remotes not asked', 'WELL FORMED: 6 context document(s); every always-on rule is imported.'],
    excludes: ['[PASS] transfer-service', 'vendor-a-api'],
  },
  {
    n: 19,
    name: 'no registry: cannot verify',
    build: () => ({ registry: null, hub: HUB, args: [] }),
    exit: 2,
    includes: ['CANNOT VERIFY: no registry at docs/estate/repositories.json', 'REASON: registry-missing'],
  },
  {
    n: 20,
    name: 'an unknown argument is a usage error',
    build: () => ({ registry: registry({}), hub: HUB, args: ['--trunk'] }),
    exit: 3,
    includes: ['unknown argument --trunk'],
  },
  {
    n: 21,
    name: 'an empty estate: no spokes listed, the hub alone passes',
    build: () => ({ registry: registry({}), hub: HUB, args: [] }),
    exit: 0,
    includes: ['[PASS] hub', 'WELL FORMED: 6 context document(s); every always-on rule is imported.'],
  },
  {
    n: 22,
    name: 'a hub document over the line cap is refused; the machine form stays beside it and only the prose is copied',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [SPOKE] });
      const long = doc({ name: 'onboarding-20260730-0930-onboarding-brief', kind: 'requirements-source', description: 'The onboarding brief /feature was run on.', body: `# Brief\n\n${'- A line.\n'.repeat(2100)}` });
      return { registry: registry({ 'transfer-service': entry(a) }), hub: withHub({ 'docs/requirements/onboarding/runs/20260730_0930/onboarding-brief.md': long }), args: [] };
    },
    exit: 1,
    includes: ['lines; the cap is 2000'],
  },
  {
    n: 23,
    name: '--local: a spoke checkout with a declared folder and two well-formed documents, no registry needed',
    build: (root) => {
      const dir = join(root, 'spoke-checkout');
      writeFiles(dir, SPOKE);
      return { registry: null, hub: {}, args: ['--local', dir] };
    },
    exit: 0,
    includes: ['context documents  (--local', '[PASS] contracts/ledger-write-api.md  (ledger-write-api, contract)', '[PASS] contracts/vendor-a/api.md  (vendor-a-api, vendor-doc)', 'WELL FORMED: 2 document(s) in contracts: ledger-write-api, vendor-a-api'],
  },
  {
    n: 24,
    name: '--local: one malformed document names the file and the set is refused',
    build: (root) => {
      const dir = join(root, 'spoke-checkout');
      writeFiles(dir, withSpoke({ 'contracts/vendor-a/api.md': doc({ name: 'vendor-a-api', kind: 'vendor-doc', owner: 'TBD' }) }));
      return { registry: null, hub: {}, args: ['--local', dir] };
    },
    exit: 1,
    includes: ['[PASS] contracts/ledger-write-api.md', '[FAIL] contracts', 'contracts/vendor-a/api.md: owner is empty or a placeholder ("TBD")', 'NOT WELL FORMED: 1 finding(s) in contracts'],
  },
  {
    n: 25,
    name: '--local --index: the folder named directly, for a checkout whose commands file has no key yet',
    build: (root) => {
      const dir = join(root, 'spoke-checkout');
      writeFiles(dir, withSpoke({ 'checks.env': CHECKS(undefined) }));
      return { registry: null, hub: {}, args: ['--local', dir, '--index', 'contracts'] };
    },
    exit: 0,
    includes: ['WELL FORMED: 2 document(s) in contracts'],
  },
  {
    n: 26,
    name: '--local: no key is NOT CONFIGURED, exit 0 and never a pass on documents',
    build: (root) => {
      const dir = join(root, 'spoke-checkout');
      writeFiles(dir, withSpoke({ 'checks.env': CHECKS(undefined) }));
      return { registry: null, hub: {}, args: ['--local', dir] };
    },
    exit: 0,
    includes: ['[NOT CONFIGURED] CONTRACTS_INDEX is missing, empty or UNRESOLVED', 'never a pass'],
    excludes: ['WELL FORMED'],
  },
  {
    n: 27,
    name: '--local with --offline is a usage error: one checkout, no other option',
    build: (root) => ({ registry: null, hub: {}, args: ['--local', join(root, 'x'), '--offline'] }),
    exit: 3,
    includes: ['--local checks one checkout and takes no other option'],
  },
  {
    n: 28,
    name: 'no commands file at readAt: a spoke listed before its install is NOT CONFIGURED, reported and never a stop, and counts no document',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [{ 'README.md': '# x\n', 'src/index.ts': 'export {};\n' }] });
      return { registry: registry({ 'transfer-service': entry(a) }), hub: HUB, args: [] };
    },
    exit: 0,
    includes: ['[PASS] transfer-service   commands file checks.env is not at', 'NOT CONFIGURED: reported, never a stop', 'WELL FORMED: 6 context document(s)'],
    excludes: ['[FAIL]'],
  },
  {
    n: 29,
    name: 'a file loose under docs/requirements/ is a finding that names the per-slug shape, never a row',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [SPOKE] });
      return {
        registry: registry({ 'transfer-service': entry(a) }),
        hub: withHub({ 'docs/requirements/onboarding-brief.md': doc({ name: 'onboarding-brief', kind: 'requirements-source' }) }),
        args: [],
      };
    },
    exit: 1,
    includes: ['[FAIL] hub', 'docs/requirements/onboarding-brief.md: is a loose file; a requirements document lives in its own folder as docs/requirements/<slug>/requirements.md, and a requirements source is filed docs/requirements/<slug>/runs/<yyyymmdd_hhmm>/<file>.md, one folder per /feature run'],
  },
  {
    n: 30,
    name: 'a folder under runs/ that is not a run stamp -- a word, or the day and minute joined with a hyphen -- is a finding',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [SPOKE] });
      return {
        registry: registry({ 'transfer-service': entry(a) }),
        hub: withHub({
          'docs/requirements/onboarding/runs/r2/onboarding-brief.md': doc({ name: 'onboarding-r2-onboarding-brief', kind: 'requirements-source' }),
          'docs/requirements/onboarding/runs/20260730-0930/onboarding-brief.md': BRIEF,
        }),
        args: [],
      };
    },
    exit: 1,
    includes: [
      'docs/requirements/onboarding/runs/r2: is not a run stamp (YYYYMMDD_HHMM); the folder under runs/ is the day and the minute /feature ran',
      'docs/requirements/onboarding/runs/20260730-0930: is not a run stamp (YYYYMMDD_HHMM); the folder under runs/ is the day and the minute /feature ran',
    ],
  },
  {
    n: 31,
    name: 'a first level that is not a slug is a finding',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [SPOKE] });
      return {
        registry: registry({ 'transfer-service': entry(a) }),
        hub: withHub({ 'docs/requirements/onboarding_v2/runs/20260730_0930/onboarding-brief.md': doc({ name: 'onboarding-v2-20260730-0930-onboarding-brief', kind: 'requirements-source' }) }),
        args: [],
      };
    },
    exit: 1,
    includes: ['docs/requirements/onboarding_v2: is not a slug (lowercase letters, digits and hyphens); the first level is the requirements document\'s slug'],
  },
  {
    n: 32,
    name: "a run file whose id is not <slug>-<yyyymmdd>-<hhmm>-<stem> is a finding that names the id it must carry -- the stamp's underscore is a hyphen in the id",
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [SPOKE] });
      return {
        registry: registry({ 'transfer-service': entry(a) }),
        hub: withHub({
          'docs/requirements/onboarding/runs/20260730_0930/onboarding-brief.md': doc({ name: 'onboarding-brief', kind: 'requirements-source' }),
          'docs/requirements/onboarding/runs/20260730_1615/onboarding-brief.md': doc({ name: 'onboarding-20260730_1615-onboarding-brief', kind: 'requirements-source' }),
        }),
        args: [],
      };
    },
    exit: 1,
    includes: [
      'docs/requirements/onboarding/runs/20260730_0930/onboarding-brief.md: id "onboarding-brief" must be "onboarding-20260730-0930-onboarding-brief" -- the slug, the run stamp with its underscore made a hyphen, and the file name -- so two runs never share an id',
      'docs/requirements/onboarding/runs/20260730_1615/onboarding-brief.md: name "onboarding-20260730_1615-onboarding-brief" must be lowercase letters, digits and hyphens',
    ],
  },
  {
    n: 33,
    name: 'three runs for one slug -- two on the same day, one in a folder stamped with the day alone as the library once wrote it -- and a second slug with runs and no document yet, each run with the interview record and a copied file: every file a document, none colliding; a schema beside the prose is not a document, the requirements document beside runs/ is one row of its own kind, and its review is nobody\'s',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [SPOKE] });
      return {
        registry: registry({ 'transfer-service': entry(a) }),
        hub: withHub({
          'docs/requirements/onboarding/runs/20260730_0930/interview.md': doc({ name: 'onboarding-20260730-0930-interview', kind: 'requirements-source', description: 'The interview /feature ran on the morning of 2026-07-30.', owner: 'product owner', revision: '2026-07-30', origin: 'interview with the product owner, /feature' }),
          'docs/requirements/onboarding/runs/20260730_1615/interview.md': doc({ name: 'onboarding-20260730-1615-interview', kind: 'requirements-source', description: 'The interview /feature ran on the afternoon of 2026-07-30, opening with the open clarifications from the morning.', owner: 'product owner', revision: '2026-07-30', origin: 'interview with the product owner, /feature' }),
          'docs/requirements/onboarding/runs/20260730_1615/limits.csv': 'tier,limit\nbasic,10\n',
          'docs/requirements/onboarding/runs/20260812/interview.md': doc({ name: 'onboarding-20260812-interview', kind: 'requirements-source', description: 'The interview /feature ran on 2026-08-12, in a folder stamped with the day alone.', owner: 'product owner', revision: '2026-08-12', origin: 'interview with the product owner, /feature' }),
          'docs/requirements/payments-cutover/runs/20260901_1100/interview.md': doc({ name: 'payments-cutover-20260901-1100-interview', kind: 'requirements-source', description: 'The interview /feature ran on 2026-09-01.', owner: 'payments lead', revision: '2026-09-01', origin: 'interview with the payments lead, /feature' }),
        }),
        args: [],
      };
    },
    exit: 0,
    includes: ['[PASS] hub', '10 document(s): 1 in docs/architecture, 2 in docs/standards, 6 in docs/requirements (1 requirements document(s), 5 requirements source(s)), 1 in docs/estate', 'docs/requirements/onboarding/requirements.md: accepted', 'WELL FORMED: 12 context document(s)'],
    excludes: ['limits.csv', 'requirements-review.md:', 'payments-cutover/requirements.md'],
  },
  {
    n: 34,
    name: "a stray folder and a stray .md beside a slug's requirements document are findings that name what may sit there; the document still parses as its own row, and its review is not one",
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [SPOKE] });
      return {
        registry: registry({ 'transfer-service': entry(a) }),
        hub: withHub({
          'docs/requirements/onboarding/notes.md': '# Notes nobody filed\n',
          'docs/requirements/onboarding/sources/20260730_0930/onboarding-brief.md': BRIEF,
        }),
        args: [],
      };
    },
    exit: 1,
    includes: [
      '[FAIL] hub',
      'docs/requirements/onboarding/notes.md: is not the requirements document, its review or a run folder; a requirements source is filed docs/requirements/<slug>/runs/<yyyymmdd_hhmm>/<file>.md, one folder per /feature run',
      'docs/requirements/onboarding/sources: is a folder; the only folder beside the requirements document is runs/, and a requirements source is filed docs/requirements/<slug>/runs/<yyyymmdd_hhmm>/<file>.md, one folder per /feature run',
      'docs/requirements/onboarding/requirements.md: accepted',
    ],
    excludes: ['docs/requirements/onboarding/requirements.md: has', 'docs/requirements/onboarding/requirements.md: line', 'docs/requirements/onboarding/requirements-review.md:'],
  },
  {
    n: 35,
    name: 'an estate overview marked always on is refused: it orients the interview and the planner, and never sits in every design\'s window',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [SPOKE] });
      return { registry: registry({ 'transfer-service': entry(a) }), hub: withHub({ 'docs/estate/overview.md': OVERVIEW({ alwaysApply: true }) }), args: [] };
    },
    exit: 1,
    includes: ['[FAIL] hub', 'docs/estate/overview.md: an estate overview is never alwaysApply: true'],
  },
  {
    n: 36,
    name: 'an estate overview with globs is refused: selection by path is a design\'s, and the overview is named or read by rule',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [SPOKE] });
      return { registry: registry({ 'transfer-service': entry(a) }), hub: withHub({ 'docs/estate/overview.md': OVERVIEW({ globs: '["src/**"]' }) }), args: [] };
    },
    exit: 1,
    includes: ['docs/estate/overview.md: an estate overview carries globs: []'],
  },
  {
    n: 37,
    name: 'an estate overview whose id is not estate-overview is refused: one overview, one fixed id',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [SPOKE] });
      return { registry: registry({ 'transfer-service': entry(a) }), hub: withHub({ 'docs/estate/overview.md': OVERVIEW({ name: 'overview' }) }), args: [] };
    },
    exit: 1,
    includes: ['docs/estate/overview.md: id "overview" must be "estate-overview" -- one estate-overview, one fixed id, so /feature, /decompose and a design can name it'],
  },
  {
    n: 38,
    name: 'no estate overview yet: the folder counts zero and nothing fails',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [SPOKE] });
      return { registry: registry({ 'transfer-service': entry(a) }), hub: withHub({ 'docs/estate/overview.md': null }), args: [] };
    },
    exit: 0,
    includes: ['[PASS] hub', '5 document(s): 1 in docs/architecture, 2 in docs/standards, 2 in docs/requirements (1 requirements document(s), 1 requirements source(s)), 0 in docs/estate', 'WELL FORMED: 7 context document(s)'],
    excludes: ['estate-overview'],
  },
  {
    n: 39,
    name: 'kind: estate-overview filed under docs/standards is refused, and the message names its one home',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [SPOKE] });
      return { registry: registry({ 'transfer-service': entry(a) }), hub: withHub({ 'docs/standards/std-overview.md': OVERVIEW() }), args: [] };
    },
    exit: 1,
    includes: ['docs/standards/std-overview.md: kind "estate-overview" does not live in this folder; this folder holds standard and an estate-overview lives in the hub\'s docs/estate/overview.md'],
  },
  {
    n: 40,
    name: 'a stray markdown file beside the overview in docs/estate is not read: the estate folder is not a document folder',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [SPOKE] });
      return { registry: registry({ 'transfer-service': entry(a) }), hub: withHub({ 'docs/estate/notes.md': '# Notes nobody filed\n' }), args: [] };
    },
    exit: 0,
    includes: ['[PASS] hub', '1 in docs/estate', 'WELL FORMED: 8 context document(s)'],
    excludes: ['notes.md', '_TEMPLATE', 'drafts'],
  },
  {
    n: 41,
    name: 'a hub standard whose description is over 200 characters is refused: the index prints the description, so it is one sentence',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [SPOKE] });
      const long = standard({ description: `${'How SQL is written across the estate, '.repeat(6)}and more.` });
      return { registry: registry({ 'transfer-service': entry(a) }), hub: withHub({ [SQL_STANDARD]: long }), args: [] };
    },
    exit: 1,
    includes: ['[FAIL] hub', 'docs/standards/std-sql-style.md: description is 237 characters; the cap is 200. A description says what the document is in one sentence, because the index prints it', 'NOT WELL FORMED'],
  },
  // The merged requirements document: one row per slug, its status derived from
  // the review beside it and never typed, its control table read by the labels the
  // requirements gate reads by name.
  {
    n: 42,
    name: 'a requirements document with no review beside it is proposed, not a failure: the status says why',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [SPOKE] });
      return { registry: registry({ 'transfer-service': entry(a) }), hub: withHub({ 'docs/requirements/onboarding/requirements-review.md': null }), args: [] };
    },
    exit: 0,
    includes: ['[PASS] hub', 'docs/requirements/onboarding/requirements.md: proposed -- no requirements-review.md beside it', 'WELL FORMED: 8 context document(s)'],
    excludes: ['accepted'],
  },
  {
    n: 43,
    name: 'a review whose verdict is CHANGES REQUESTED leaves the document proposed: the token is read literally',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [SPOKE] });
      return { registry: registry({ 'transfer-service': entry(a) }), hub: withHub({ 'docs/requirements/onboarding/requirements-review.md': REVIEW({ verdict: '### VERDICT: CHANGES REQUESTED' }) }), args: [] };
    },
    exit: 0,
    includes: ['[PASS] hub', 'docs/requirements/onboarding/requirements.md: proposed -- requirements-review.md says "### VERDICT: CHANGES REQUESTED", not "### VERDICT: APPROVED"', 'WELL FORMED: 8 context document(s)'],
  },
  {
    n: 44,
    name: 'a review whose Document revision: names other bytes leaves the document proposed: one changed byte unapproves it, exactly as the gate reads it',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [SPOKE] });
      return { registry: registry({ 'transfer-service': entry(a) }), hub: withHub({ 'docs/requirements/onboarding/requirements-review.md': REVIEW({ of: REQUIREMENTS({ revision: 'r2' }) }) }), args: [] };
    },
    exit: 0,
    includes: ['[PASS] hub', 'docs/requirements/onboarding/requirements.md: proposed -- requirements-review.md approves revision ', '; it changed after it was reviewed', 'WELL FORMED: 8 context document(s)'],
  },
  {
    n: 45,
    name: 'a Slug cell naming another slug is a finding that names the cell and the exact row expected: the document is filed under one slug and says it is another',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [SPOKE] });
      return { registry: registry({ 'transfer-service': entry(a) }), hub: withHub({ 'docs/requirements/onboarding/requirements.md': REQUIREMENTS({ slugCell: '`payments-onboarding`' }) }), args: [] };
    },
    exit: 1,
    includes: ['[FAIL] hub', 'docs/requirements/onboarding/requirements.md: line 11 has "`payments-onboarding`" in the Slug cell; expected "| Slug | `onboarding` |" and nothing else in the cell', 'NOT WELL FORMED'],
  },
  {
    n: 46,
    name: 'a requirements document with no title line is a finding: the index prints the title',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [SPOKE] });
      return { registry: registry({ 'transfer-service': entry(a) }), hub: withHub({ 'docs/requirements/onboarding/requirements.md': REQUIREMENTS({ h1: false }) }), args: [] };
    },
    exit: 1,
    includes: ['[FAIL] hub', 'docs/requirements/onboarding/requirements.md: has no title line; the template opens with "# <Feature name>: <what must become true>"'],
  },
  {
    n: 47,
    name: 'an Owning role still in angle brackets is a placeholder, not a role',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [SPOKE] });
      return { registry: registry({ 'transfer-service': entry(a) }), hub: withHub({ 'docs/requirements/onboarding/requirements.md': REQUIREMENTS({ owner: '<role>' }) }), args: [] };
    },
    exit: 1,
    includes: ['[FAIL] hub', 'docs/requirements/onboarding/requirements.md: Owning role is a placeholder ("<role>"); write the role accountable for the document'],
  },
  {
    n: 48,
    name: 'an Owning role of TBD is a placeholder too: the same list the gate refuses',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [SPOKE] });
      return { registry: registry({ 'transfer-service': entry(a) }), hub: withHub({ 'docs/requirements/onboarding/requirements.md': REQUIREMENTS({ owner: 'TBD' }) }), args: [] };
    },
    exit: 1,
    includes: ['docs/requirements/onboarding/requirements.md: Owning role is a placeholder ("TBD")'],
  },
  {
    n: 94,
    name: 'an Owning role still a backslashed fill-in token is a placeholder: the template writes it so a viewer shows it',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [SPOKE] });
      return { registry: registry({ 'transfer-service': entry(a) }), hub: withHub({ 'docs/requirements/onboarding/requirements.md': REQUIREMENTS({ owner: '\\<role — never a named individual>' }) }), args: [] };
    },
    exit: 1,
    includes: ['docs/requirements/onboarding/requirements.md: Owning role is a placeholder ("\\\\<role — never a named individual>")'],
  },
  {
    n: 49,
    name: 'a control table with no Date row is a finding: the revision the index prints is r<n> and the date together',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [SPOKE] });
      return { registry: registry({ 'transfer-service': entry(a) }), hub: withHub({ 'docs/requirements/onboarding/requirements.md': REQUIREMENTS({ drop: ['Date'] }) }), args: [] };
    },
    exit: 1,
    includes: ['[FAIL] hub', 'docs/requirements/onboarding/requirements.md: has no "| Date | YYYY-MM-DD |" row in its control table'],
  },
  {
    n: 50,
    name: 'a standard in the old shape, a copy under a lowercase name: an upgraded hub re-ingests it as a summary, and the finding says how',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [SPOKE] });
      return { registry: registry({ 'transfer-service': entry(a) }), hub: withHub({ 'docs/standards/onboarding.md': doc({ name: 'onboarding', kind: 'standard' }) }), args: [] };
    },
    exit: 1,
    includes: ['[FAIL] hub', 'docs/standards/onboarding.md: is not a standard file (std-<topic>.md) and not the template', 're-ingest it with /add-context --kind standard'],
  },
  {
    n: 51,
    name: 'the requirements template beside the slug folders is not read: a template is nobody\'s document',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [SPOKE] });
      return { registry: registry({ 'transfer-service': entry(a) }), hub: withHub({ 'docs/requirements/_TEMPLATE.requirements.md': '# Requirements — <SYSTEM OR CAPABILITY>: <one line stating what must become true>\n\n## 1. Document control\n\n| Field | Value |\n|---|---|\n| Owning role | <role — never a named individual> |\n| Slug | `<slug>` |\n' }), args: [] };
    },
    exit: 0,
    includes: ['[PASS] hub', '6 document(s): 1 in docs/architecture, 2 in docs/standards, 2 in docs/requirements (1 requirements document(s), 1 requirements source(s)), 1 in docs/estate', 'WELL FORMED: 8 context document(s)'],
    excludes: ['_TEMPLATE', 'SYSTEM OR CAPABILITY'],
  },
  // Accepted is merged: an approved review is a property of the text, and the
  // merge is the acceptance. The trunk is refs/remotes/origin/main, read and
  // never fetched.
  {
    n: 52,
    name: 'an amendment on its open branch: re-reviewed and approved, but the trunk carries the earlier bytes, so it is proposed, not accepted',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [SPOKE] });
      return { registry: registry({ 'transfer-service': entry(a) }), hub: HUB, args: [], before: (hub) => amendOnBranch(hub) };
    },
    exit: 0,
    includes: ['[PASS] hub', 'docs/requirements/onboarding/requirements.md: proposed -- approved, not merged: refs/remotes/origin/main has ', 'WELL FORMED: 8 context document(s)'],
    excludes: ['accepted'],
  },
  {
    n: 53,
    name: 'a first run on its open branch: approved, and the trunk has no copy of it, so it is proposed',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [SPOKE] });
      return {
        registry: registry({ 'transfer-service': entry(a) }),
        hub: withHub({ 'docs/requirements/onboarding/requirements.md': null, 'docs/requirements/onboarding/requirements-review.md': null }),
        args: [],
        before: (hub) => amendOnBranch(hub, { 'docs/requirements/onboarding/requirements.md': REQ_DOC, 'docs/requirements/onboarding/requirements-review.md': REQ_REVIEW }),
      };
    },
    exit: 0,
    includes: ['[PASS] hub', 'docs/requirements/onboarding/requirements.md: proposed -- approved, not merged: refs/remotes/origin/main has no copy of it'],
    excludes: ['accepted'],
  },
  {
    n: 54,
    name: 'a hub with no trunk to read: an approved document is proposed, and the status says why -- never accepted on a guess',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [SPOKE] });
      return { registry: registry({ 'transfer-service': entry(a) }), hub: HUB, args: [], trunk: false };
    },
    exit: 0,
    includes: ['[PASS] hub', 'docs/requirements/onboarding/requirements.md: proposed -- approved, but refs/remotes/origin/main could not be read, so it is not shown as merged'],
    excludes: ['accepted'],
  },
  {
    n: 55,
    name: 'a record with status Proposed: a proposed record is a draft beside its design, never a hub copy',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [SPOKE] });
      return { registry: registry({ 'transfer-service': entry(a) }), hub: withHub({ 'docs/architecture/ADR-004-eligibility-read-model.md': adr({ status: 'Proposed' }) }), args: [] };
    },
    exit: 1,
    includes: ['status "Proposed" is not one of Accepted, Superseded by ADR-<NNN>, Superseded by global.ADR-<NNN>, Deprecated'],
  },
  {
    n: 56,
    name: 'a record Superseded with no successor named',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [SPOKE] });
      return { registry: registry({ 'transfer-service': entry(a) }), hub: withHub({ 'docs/architecture/ADR-004-eligibility-read-model.md': adr({ status: 'Superseded' }) }), args: [] };
    },
    exit: 1,
    includes: ['a superseded record names the record that replaced it: "Superseded by ADR-<NNN>"'],
  },
  {
    n: 57,
    name: 'a record whose name numbers it differently from its file',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [SPOKE] });
      return { registry: registry({ 'transfer-service': entry(a) }), hub: withHub({ 'docs/architecture/ADR-004-eligibility-read-model.md': adr({ n: '005' }) }), args: [] };
    },
    exit: 1,
    includes: ['name is ADR-005 and the file is ADR-004; one record, one number'],
  },
  {
    n: 58,
    name: 'a record named in lowercase: its id is the number the record carries',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [SPOKE] });
      return { registry: registry({ 'transfer-service': entry(a) }), hub: withHub({ 'docs/architecture/ADR-004-eligibility-read-model.md': adr({ name: 'adr-004' }) }), args: [] };
    },
    exit: 1,
    includes: ['name "adr-004" must be ADR-<NNN>'],
  },
  {
    n: 59,
    name: 'a record with no origin: nobody could find the page it summarises',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [SPOKE] });
      return { registry: registry({ 'transfer-service': entry(a) }), hub: withHub({ 'docs/architecture/ADR-004-eligibility-read-model.md': adr({ drop: ['origin'] }) }), args: [] };
    },
    exit: 1,
    includes: ['frontmatter is missing "origin"'],
  },
  {
    n: 60,
    name: 'a record in the old shape, with no header: an upgraded hub rewrites it as a summary',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [SPOKE] });
      const old = '# ADR-004: Serve eligibility from a read model\n\n## Status\n\n`Accepted`\n\nDecided: 2026-08-20\n\nHuman approver: head of engineering\n';
      return { registry: registry({ 'transfer-service': entry(a) }), hub: withHub({ 'docs/architecture/ADR-004-eligibility-read-model.md': old }), args: [] };
    },
    exit: 1,
    includes: [
      'docs/architecture/ADR-004-eligibility-read-model.md: does not open with a frontmatter line "---" on line 1',
      '-- a decision record is now a summary for agents; rewrite it with /add-context --kind adr',
    ],
  },
  {
    n: 61,
    name: 'a comment above the title that looks like a title: comments are masked, the real title counts',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [SPOKE] });
      const text = adr({}).replace('# ADR-004:', '<!-- # ADR-005: wrong -->\n\n# ADR-004:');
      return { registry: registry({ 'transfer-service': entry(a) }), hub: withHub({ 'docs/architecture/ADR-004-eligibility-read-model.md': text }), args: [] };
    },
    exit: 0,
    includes: ['WELL FORMED:'],
  },
  {
    n: 62,
    name: 'a record that supersedes itself',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [SPOKE] });
      return { registry: registry({ 'transfer-service': entry(a) }), hub: withHub({ 'docs/architecture/ADR-004-eligibility-read-model.md': adr({ status: 'Superseded by ADR-004' }) }), args: [] };
    },
    exit: 1,
    includes: ['a record cannot supersede itself'],
  },
  // A standard is a summary written from the template, named std-<topic>. Each case breaks one rule of its shape; the control's two standards pass.
  ...[
    {
      name: 'a standard named without the prefix: its id is std-<topic>, the name its file and title carry',
      text: standard({ name: 'sql-style' }),
      includes: ['name "sql-style" must be std-<topic> (lowercase letters, digits and hyphens), the name the file and the title carry'],
    },
    {
      name: 'a standard whose name differs from its file',
      text: standard({ name: 'std-sql-rules' }),
      includes: ['name is std-sql-rules and the file is std-sql-style; one standard, one name'],
    },
    {
      name: 'a standard whose title names it differently from its name',
      text: standard({ head: ['# std-sql-rules: SQL style', ''] }),
      includes: ['title names std-sql-rules and the name is std-sql-style; one standard, one name'],
    },
    {
      name: 'a copied page under a new header: a second YAML block where the title belongs is a copy, not a summary',
      text: standard({ head: ['---', 'id: 812', 'title: SQL style', '---', '', '# std-sql-style: SQL style', ''] }),
      includes: ['the body opens with "---", not the title "# <name>: <the topic>"', 'rewrite it with /add-context --kind standard'],
    },
    {
      name: 'a standard with a section missing',
      text: standard({ sections: { Values: null } }),
      includes: ['sections are missing "Values"; a standard carries "Applies to", "Must", "Should", "Values"'],
    },
    {
      name: 'a standard with a heading of its own: the page\'s structure, not the template\'s',
      text: standard({ sections: { Must: ['### Naming', '', '- **<ID>.01** MUST name tables in snake_case. *(Source: §2)*'] } }),
      includes: ['heading "### Naming" is not one of the template\'s sections'],
    },
    {
      name: 'a standard with an empty section: nothing is written "None."',
      text: standard({ sections: { Relations: [] } }),
      includes: ['section "Relations"', 'is empty; write "None." where there is nothing'],
    },
    {
      name: 'a rule with no id: a critic cannot cite it',
      text: standard({ sections: { Must: ['- MUST name tables in snake_case.'] } }),
      includes: ['a rule under "Must" opens "- **<name>.<NN>** MUST | MUST NOT ..."'],
    },
    {
      name: 'a rule named under another standard',
      text: standard({ sections: { Must: ['- **std-sql-rules.01** MUST name tables in snake_case. *(Source: §2)*'] } }),
      includes: ["rule std-sql-rules.01 carries another standard's name; its rules are std-sql-style.<NN>"],
    },
    {
      name: 'two rules under one id',
      text: standard({ sections: { Should: ['- **<ID>.01** SHOULD keep one statement per line. *(Source: §4)*'] } }),
      includes: ['rule std-sql-style.01 is also line'],
    },
    {
      name: 'a SHOULD under Must: a recommendation read as a requirement',
      text: standard({ sections: { Must: ['- **<ID>.01** SHOULD name tables in snake_case. *(Source: §2)*'] } }),
      includes: ['SHOULD belongs under "Should", not "Must"'],
    },
    {
      name: 'a value nobody settled, written as a value: it is an UNRESOLVED line instead',
      text: standard({ sections: { Values: ['| Value | Setting | Applies to | Source |', '|---|---|---|---|', '| Coverage | 80% [to confirm] | changed lines | §5 |'] } }),
      includes: ['"[to confirm]" marks a value nobody settled; write it as an UNRESOLVED line'],
    },
    {
      name: 'an open point not in the pinned grammar',
      text: standard({ sections: { Unresolved: ['- The migration tool is open.'] } }),
      includes: ['an open point is "- UNRESOLVED — <what>. Owner: <role>. Resolves: <trigger>."'],
    },
    {
      name: 'a standard with no rule: a description of a system is not a standard',
      text: standard({ sections: { Must: ['None.'], Should: ['None.'], 'Checked by': ['None.'] } }),
      includes: ['carries no rule under "Must" or "Should"; a document with no rule is not a standard'],
    },
    {
      name: 'a standard over 200 lines: a summary of rules that needs more is two standards',
      text: standard({ sections: { Origin: Array(200).fill('A line of history.') } }),
      includes: ['the cap for a standard is 200'],
    },
  ].map((c, i) => ({
    n: 63 + i,
    name: c.name,
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [SPOKE] });
      return { registry: registry({ 'transfer-service': entry(a) }), hub: withHub({ [SQL_STANDARD]: c.text }), args: [] };
    },
    exit: 1,
    includes: ['[FAIL] hub', ...c.includes],
  })),
  // A standard's status: Active binds by its globs, Reserved only when named.
  {
    n: 78,
    name: 'a standard with no status: whether it binds by its globs is the person\'s to say, not a default',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [SPOKE] });
      return { registry: registry({ 'transfer-service': entry(a) }), hub: withHub({ [SQL_STANDARD]: standard({ status: null }) }), args: [] };
    },
    exit: 1,
    includes: ['[FAIL] hub', 'docs/standards/std-sql-style.md: frontmatter is missing "status"'],
  },
  {
    n: 79,
    name: 'a standard with a status that is neither Active nor Reserved',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [SPOKE] });
      return { registry: registry({ 'transfer-service': entry(a) }), hub: withHub({ [SQL_STANDARD]: standard({ status: 'Draft' }) }), args: [] };
    },
    exit: 1,
    includes: ['[FAIL] hub', 'status "Draft" is not one of Active, Reserved'],
  },
  {
    n: 80,
    name: 'a Reserved standard parses and is noted: held for later, it binds only a design that names it',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [SPOKE] });
      return { registry: registry({ 'transfer-service': entry(a) }), hub: withHub({ [SQL_STANDARD]: standard({ status: 'Reserved' }) }), args: [] };
    },
    exit: 0,
    includes: ['[PASS] hub', 'docs/standards/std-sql-style.md: Reserved -- binds only a design that names std-sql-style', 'std-sql-style reaches no listed repository', 'Reserved, so it binds only a design that names it', 'WELL FORMED:'],
  },
  {
    n: 81,
    name: 'a path-scoped standard whose globs match no path in any listed repository is a note, never a finding: a standard for a stack nobody uses yet waits',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [SPOKE] });
      return { registry: registry({ 'transfer-service': entry(a) }), hub: HUB, args: [] };
    },
    exit: 0,
    includes: ['[PASS] standards reach    1 of 1 repositories read', 'std-sql-style reaches no listed repository: its globs ["**/*.sql"] match no path in the 1 read; it binds the first design that touches a matching path', 'WELL FORMED:'],
    excludes: ['std-handbook reaches'],
  },
  {
    n: 82,
    name: 'a path-scoped standard whose globs match a path in a spoke at readAt names the repository it reaches',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [withSpoke({ 'db/migrations/001-accounts.sql': 'CREATE TABLE accounts (id BIGINT);\n' })] });
      return { registry: registry({ 'transfer-service': entry(a) }), hub: HUB, args: [] };
    },
    exit: 0,
    includes: ['std-sql-style reaches transfer-service'],
    excludes: ['std-sql-style reaches no listed repository'],
  },
  {
    n: 84,
    name: 'reach is reported for every well-formed standard even when another hub document is malformed: an old-shape copy beside the new standard does not hide it',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [SPOKE] });
      return { registry: registry({ 'transfer-service': entry(a) }), hub: withHub({ 'docs/standards/sql-style.md': '---\nname: sql-style\n---\n# SQL\n' }), args: [] };
    },
    exit: 1,
    includes: ['docs/standards/sql-style.md: is not a standard file', 'std-sql-style reaches no listed repository'],
  },
  // A standard is named std-<topic>, and the prefix is a standard's alone.
  {
    n: 85,
    name: 'a standard named by number, the form before std-<topic>: refused, and the finding names the rename',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [SPOKE] });
      return { registry: registry({ 'transfer-service': entry(a) }), hub: withHub({ [SQL_STANDARD]: null, 'docs/standards/STD-001-sql-style.md': standard({ name: 'STD-001' }) }), args: [] };
    },
    exit: 1,
    includes: ['[FAIL] hub', 'docs/standards/STD-001-sql-style.md: names a standard by number, the form before standards were named std-<topic>; rename it with /add-context --rename-standards'],
  },
  {
    n: 86,
    name: 'a spoke contract whose id starts with std-: the prefix names a standard, so a design that names it would name the wrong kind',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [withSpoke({ 'contracts/std-orders.md': doc({ name: 'std-orders', kind: 'contract' }) })] });
      return { registry: registry({ 'transfer-service': entry(a) }), hub: HUB, args: [] };
    },
    exit: 1,
    includes: ['id "std-orders" starts with "std-", which names a standard; give this document an id that does not'],
  },
  {
    n: 87,
    name: 'a requirements document whose slug starts with std-: its id is the slug, and the prefix names a standard',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [SPOKE] });
      return { registry: registry({ 'transfer-service': entry(a) }), hub: withHub({ 'docs/requirements/std-onboarding/requirements.md': REQUIREMENTS({ slug: 'std-onboarding' }) }), args: [] };
    },
    exit: 1,
    includes: ['[FAIL] hub', 'docs/requirements/std-onboarding/requirements.md: id "std-onboarding" starts with "std-", which names a standard'],
  },
  {
    n: 83,
    name: '--offline asks no remote, so it says nothing of reach',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [SPOKE] });
      return { registry: registry({ 'transfer-service': entry(a) }), hub: HUB, args: ['--offline'] };
    },
    exit: 0,
    includes: ['[PASS] spokes'],
    excludes: ['standards reach'],
  },
  {
    n: 88,
    name: "a spoke keeps its own decision record, ADR-004, beside the hub's ADR-004: its id carries the spoke, so the two never collide",
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [withSpoke(SPOKE_RECORDS)] });
      return { registry: registry({ 'transfer-service': entry(a) }), hub: HUB, args: [] };
    },
    exit: 0,
    includes: ['2 document(s) in contracts at', '1 document(s) in decisions at', 'WELL FORMED: 9 context document(s)'],
    excludes: ['[FAIL] ids'],
  },
  {
    n: 89,
    name: "a spoke's decision record in a file not named by its number is refused",
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [withSpoke({ ...SPOKE_RECORDS, 'decisions/ADR-004-retry-budget.md': null, 'decisions/retries.md': RETRY_RECORD })] });
      return { registry: registry({ 'transfer-service': entry(a) }), hub: HUB, args: [] };
    },
    exit: 1,
    includes: ['[FAIL] transfer-service', "decisions/retries.md: a decision record's file is ADR-<NNN>-<slug>.md, named by the number it carries"],
  },
  {
    n: 90,
    name: "a contract in the spoke's decision-record folder, and a record in its contracts folder: each refused, with the other folder named",
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [withSpoke({ ...SPOKE_RECORDS, 'decisions/ledger-write-api.md': LEDGER_CONTRACT, 'contracts/ledger-write-api.md': null, 'contracts/ADR-005-queues.md': adr({ n: '005' }) })] });
      return { registry: registry({ 'transfer-service': entry(a) }), hub: HUB, args: [] };
    },
    exit: 1,
    includes: ['decisions/ledger-write-api.md: kind "contract" does not live in this folder; this folder holds adr', "contracts/ADR-005-queues.md: kind \"adr\" does not live in this folder; this folder holds contract or vendor-doc and an adr lives in the hub's docs/architecture/, or the spoke folder DECISIONS_INDEX names (decisions/ by convention)"],
  },
  {
    n: 91,
    name: 'DECISIONS_INDEX=none: the spoke says on purpose that it keeps no decision records of its own',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [withSpoke({ 'checks.env': `${CHECKS('contracts')}DECISIONS_INDEX=none\n` })] });
      return { registry: registry({ 'transfer-service': entry(a) }), hub: HUB, args: [] };
    },
    exit: 0,
    includes: ['DECISIONS_INDEX=none: no decision records, on purpose'],
  },
  {
    n: 92,
    name: '--local: both folders of a spoke checkout are checked, each with its own verdict',
    build: (root) => {
      const dir = join(root, 'spoke-checkout');
      writeFiles(dir, withSpoke(SPOKE_RECORDS));
      return { registry: null, hub: {}, args: ['--local', dir] };
    },
    exit: 0,
    includes: ['[PASS] decisions/ADR-004-retry-budget.md  (ADR-004, adr)', 'WELL FORMED: 2 document(s) in contracts', 'WELL FORMED: 1 document(s) in decisions: ADR-004'],
  },
  {
    n: 93,
    name: '--local --decisions: the record folder named directly, for a checkout whose commands file has no key yet',
    build: (root) => {
      const dir = join(root, 'spoke-checkout');
      writeFiles(dir, withSpoke({ 'decisions/ADR-004-retry-budget.md': RETRY_RECORD }));
      return { registry: null, hub: {}, args: ['--local', dir, '--decisions', 'decisions'] };
    },
    exit: 0,
    includes: ['WELL FORMED: 1 document(s) in decisions: ADR-004'],
    excludes: ['in contracts'],
  },
  globalFixture(95, '--global, valid control: two records, an always-on standard, a standard with globs and an Active exception that departs from a record and a rule; templates and the README are not documents', [{ 'README.md': '# Global context\n' }, GLOBAL_DOCS], {
    exit: 0,
    includes: ['--global: the global repository at', '[PASS] global', '4 document(s): 1 in docs/architecture, 2 in docs/standards, 1 in docs/exceptions', '[PASS] successors', '[PASS] departs            1 exception(s)', '[PASS] ids', '[PASS] budget', '(1 document(s)); index lines', '(4 line(s))', 'WELL FORMED: 4 global document(s) at'],
    excludes: ['_TEMPLATE', 'README', 'hub ', 'always-on rules', 'spokes'],
  }),
  globalFixture(96, '--global, an exception whose Reason is empty: the Board cannot approve it, exit 1', [withGlobal({ [GLOBAL_EXC]: EXCEPTION({ reason: '' }) })], {
    exit: 1,
    includes: ['[FAIL] global', 'section "Reason" is empty or a placeholder', 'NOT WELL FORMED: fix every finding above before the Board merges.'],
  }),
  globalFixture(97, '--global, an exception that names no repository: exit 1', [withGlobal({ [GLOBAL_EXC]: EXCEPTION({ repositories: '[]' }) })], {
    exit: 1,
    includes: ['repositories must be a one-line JSON array of one or more strings'],
  }),
  globalFixture(98, '--global, an exception whose hub is not a key prefix, and one with no review-by date: both found in one run', [withGlobal({ [GLOBAL_EXC]: EXCEPTION({ hubs: '["sim"]' }), 'docs/exceptions/EXC-005-other.md': EXCEPTION({ n: '005', drop: ['review-by'] }) })], {
    exit: 1,
    includes: ['hubs: "sim" is not a key prefix', 'EXC-005-other.md: frontmatter is missing "review-by"'],
  }),
  globalFixture(99, '--global, a superseded record whose successor is not in the repository: exit 1, named', [withGlobal({ [GLOBAL_ADR]: adr({ n: '012', title: 'Use only Redis for caching', status: 'Superseded by ADR-013' }) })], {
    exit: 1,
    includes: ['[FAIL] successors', 'is superseded by ADR-013, and no well-formed record ADR-013 is at'],
  }),
  globalFixture(100, '--global, a superseded record and its successor: passes, and the superseded record leaves the index count', [withGlobal({ [GLOBAL_ADR]: adr({ n: '012', title: 'Use only Redis for caching', status: 'Superseded by ADR-013' }), 'docs/architecture/ADR-013-redis-or-valkey.md': adr({ n: '013', title: 'Use Redis or Valkey for caching' }), [GLOBAL_EXC]: EXCEPTION({ departs: '["ADR-013"]' }) })], {
    exit: 0,
    includes: ['[PASS] successors         1 superseded record(s)', '(4 line(s))', 'WELL FORMED: 5 global document(s)'],
  }),
  globalFixture(101, '--global, an exception that departs from a record the repository does not hold: exit 1', [withGlobal({ [GLOBAL_EXC]: EXCEPTION({ departs: '["ADR-099"]' }) })], {
    exit: 1,
    includes: ['[FAIL] departs', 'departs from ADR-099, and no well-formed record ADR-099 is at'],
  }),
  globalFixture(102, '--global, an exception that departs from a rule its standard does not define: exit 1, with the rules it does define', [withGlobal({ [GLOBAL_EXC]: EXCEPTION({ departs: '["std-go.09"]' }) })], {
    exit: 1,
    includes: ['departs from std-go.09, and std-go defines no rule std-go.09 at', 'Its rules are std-go.01, std-go.02, std-go.03'],
  }),
  globalFixture(103, '--global, an exception that departs from a rule of a standard the repository does not hold: exit 1', [withGlobal({ [GLOBAL_EXC]: EXCEPTION({ departs: '["std-php.01"]' }) })], {
    exit: 1,
    includes: ['departs from std-php.01, and no well-formed standard std-php is at'],
  }),
  globalFixture(104, '--global, an id the history removed and a later commit uses for another record: exit 1, with the commit that removed it', [GLOBAL_DOCS, { [GLOBAL_ADR]: null, [GLOBAL_EXC]: EXCEPTION({ departs: '["std-go.02"]' }) }, { 'docs/architecture/ADR-012-valkey.md': adr({ n: '012', title: 'Use Valkey for caching' }) }], {
    exit: 1,
    includes: ['[FAIL] ids', 'docs/architecture/ADR-012-valkey.md: id ADR-012 was removed at', 'and names other bytes again'],
  }),
  globalFixture(105, '--global, a record removed and then restored with the same bytes: not a reuse, passes', [GLOBAL_DOCS, { [GLOBAL_ADR]: null, [GLOBAL_EXC]: EXCEPTION({ departs: '["std-go.02"]' }) }, { [GLOBAL_ADR]: REDIS_ONLY, [GLOBAL_EXC]: EXCEPTION() }], {
    exit: 0,
    includes: ['[PASS] ids', 'WELL FORMED: 4 global document(s)'],
  }),
  globalFixture(106, '--global, a record renamed in one commit, and edited in a later one: never removed, passes', [GLOBAL_DOCS, { [GLOBAL_ADR]: null, 'docs/architecture/ADR-012-cache.md': REDIS_ONLY }, { 'docs/architecture/ADR-012-cache.md': adr({ n: '012', title: 'Use only Redis for every cache' }) }], {
    exit: 0,
    includes: ['[PASS] ids'],
  }),
  globalFixture(107, '--global, an always-on standard whose body is over 8 KB: exit 1, the largest named', [withGlobal({ [GLOBAL_SECURITY]: standard({ topic: 'security', title: 'Security baseline', description: 'The security baseline every product follows.', globs: '[]', alwaysApply: true, sections: { 'Applies to': ['Every product, every repository and every environment. '.repeat(160)] } }) })], {
    exit: 1,
    includes: ['[FAIL] budget', 'the always-on bodies are', 'and the cap is 8192 (rules/context-budget.md)', 'Largest: global.std-security ('],
  }),
  globalFixture(108, '--global, seventy records whose index lines pass 16 KB: exit 1, the cap and the lever named', [manyRecords(70)], {
    exit: 1,
    includes: ['[FAIL] budget', 'the index lines are', 'and the cap is 16384 (rules/context-budget.md)', 'Supersede the records that no longer bind'],
  }),
  globalFixture(109, '--global, the same seventy records with forty superseded: they leave the index, and the cap holds', [manyRecords(70, 40)], {
    exit: 0,
    includes: ['[PASS] budget', '(30 line(s))', 'WELL FORMED: 70 global document(s)'],
  }),
  {
    n: 110,
    name: '--global in a shallow clone: the history cannot be walked, exit 2, with the fix',
    build: (root) => {
      const full = globalRepo(root, [{ 'README.md': '# Global context\n' }, GLOBAL_DOCS]);
      const shallow = join(root, 'shallow');
      git(root, ['clone', '-q', '--depth', '1', `file://${full}`, shallow]);
      return { registry: null, hub: {}, trunk: false, cwd: shallow, args: ['--global'] };
    },
    exit: 2,
    includes: ['CANNOT VERIFY: the history is shallow', 'fetch-depth: 0', 'REASON: shallow-clone'],
  },
  {
    n: 111,
    name: '--global with an exception written and not committed: it reads HEAD, so exit 2, the file named',
    build: (root) => {
      const dir = globalRepo(root, [GLOBAL_DOCS]);
      writeFiles(dir, { 'docs/exceptions/EXC-005-other.md': EXCEPTION({ n: '005' }) });
      return { registry: null, hub: {}, trunk: false, cwd: dir, args: ['--global'] };
    },
    exit: 2,
    includes: ['are not committed: docs/exceptions/EXC-005-other.md', 'Commit them, or remove them', 'REASON: uncommitted-changes'],
  },
  {
    n: 112,
    name: '--global in a folder that is not a git repository: exit 2',
    build: (root) => {
      const dir = join(root, 'plain');
      writeFiles(dir, GLOBAL_DOCS);
      return { registry: null, hub: {}, trunk: false, cwd: dir, args: ['--global'] };
    },
    exit: 2,
    includes: ['CANNOT VERIFY: --global reads the commit HEAD names, and this directory is not a git repository with a commit'],
  },
  {
    n: 113,
    name: '--global beside --offline: usage, exit 3',
    build: (root) => ({ registry: null, hub: {}, trunk: false, cwd: globalRepo(root, [GLOBAL_DOCS]), args: ['--global', '--offline'] }),
    exit: 3,
    includes: ['--global checks the global context repository it runs in and takes no other option'],
  },
  {
    n: 114,
    name: 'a hub record superseded by a global record that now states it: well formed (docs/proposals/global-context.md §11.3)',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [SPOKE] });
      return {
        registry: registry({ 'transfer-service': entry(a) }),
        hub: withHub({ 'docs/architecture/ADR-004-eligibility-read-model.md': adr({ status: 'Superseded by global.ADR-012' }) }),
        args: ['--offline'],
      };
    },
    exit: 0,
    includes: ['[PASS] hub', '1 in docs/architecture', 'WELL FORMED'],
  },
  globalFixture(115, '--global, a record superseded by a successor named with the global. prefix: exit 1, because a file in the global repository carries no prefix', [withGlobal({ [GLOBAL_ADR]: adr({ n: '012', title: 'Use only Redis for caching', status: 'Superseded by global.ADR-013' }), 'docs/architecture/ADR-013-redis-or-valkey.md': adr({ n: '013', title: 'Use Redis or Valkey for caching' }) })], {
    exit: 1,
    includes: ['[FAIL] successors', 'is superseded by global.ADR-013, and a file in the global repository names a global record without "global.": "Superseded by ADR-013"'],
  }),
  {
    n: 115,
    name: 'a declared trunk: the documents are read on the declared branch, not on the default branch',
    build: (root) => {
      // The default branch says TRUNK_FOR_HUB=default and lacks the third document, so a read there fails.
      const a = makeRemote(root, 'transfer-service', {
        commits: [SPOKE],
        branch: { name: 'harness-main', commits: [{ 'checks.env': CHECKS('contracts', 'harness-main'), 'contracts/vendor-b.md': doc({ name: 'vendor-b-api', kind: 'vendor-doc' }) }] },
      });
      return { registry: registry({ 'transfer-service': entry(a, 'checks.env', a.branchHead, 'harness-main') }), hub: HUB, args: [] };
    },
    exit: 0,
    includes: ['[PASS] transfer-service', '3 document(s) in contracts at', 'WELL FORMED: 9 context document(s)'],
    excludes: ['is behind the trunk head', 'The two must agree'],
  },
  // The batch run of the global /add-context (accelerator/global/add-context.md, What it does -- a
  // batch) writes many documents and commits them once. The check reads that one commit as a whole.
  globalFixture(116, '--global, a batch of two records and two standards added in one commit: passes, every document counted', [GLOBAL_DOCS, {
    'docs/architecture/ADR-013-redis-or-valkey.md': adr({ n: '013', title: 'Use Redis or Valkey for caching', globs: '["**/cache/**"]' }),
    'docs/architecture/ADR-014-queue-naming.md': adr({ n: '014', title: 'Name every queue after its owner', globs: '["**/queue/**"]' }),
    'docs/standards/std-caching.md': standard({ topic: 'caching', title: 'Caching', description: 'How caches are written in every product.', globs: '["**/cache/**"]', origin: 'Global Architecture Board' }),
    'docs/standards/std-logging.md': standard({ topic: 'logging', title: 'Logging', description: 'How logs are written in every product.', globs: '["**/*.go"]', origin: 'Global Architecture Board' }),
  }], {
    exit: 0,
    includes: ['[PASS] global', '[PASS] ids', '[PASS] budget', 'WELL FORMED: 8 global document(s)'],
  }),
  globalFixture(117, '--global, a batch whose two files carry one record id: exit 1, the id and both files named', [GLOBAL_DOCS, {
    'docs/architecture/ADR-013-redis-or-valkey.md': adr({ n: '013', title: 'Use Redis or Valkey for caching' }),
    'docs/architecture/ADR-013-queue-naming.md': adr({ n: '013', title: 'Name every queue after its owner' }),
  }], {
    exit: 1,
    includes: ['[FAIL] global', 'ADR-013', 'ADR-013-redis-or-valkey.md', 'ADR-013-queue-naming.md'],
  }),
  globalFixture(118, '--global, a batch that adds a successor and a second record and changes the status line of the record it supersedes: passes', [GLOBAL_DOCS, {
    [GLOBAL_ADR]: adr({ n: '012', title: 'Use only Redis for caching', status: 'Superseded by ADR-013', globs: '["**/cache/**"]' }),
    'docs/architecture/ADR-013-redis-or-valkey.md': adr({ n: '013', title: 'Use Redis or Valkey for caching', globs: '["**/cache/**"]' }),
    'docs/architecture/ADR-014-queue-naming.md': adr({ n: '014', title: 'Name every queue after its owner', globs: '["**/queue/**"]' }),
    [GLOBAL_EXC]: EXCEPTION({ departs: '["ADR-013"]' }),
  }], {
    exit: 0,
    includes: ['[PASS] successors         1 superseded record(s)', 'WELL FORMED: 6 global document(s)'],
  }),
  globalFixture(119, '--global, a batch of seventy records added in one commit to a repository that already has documents: exit 1, the cap and the lever named', [withGlobal({ [GLOBAL_ADR]: null, [GLOBAL_EXC]: EXCEPTION({ departs: '["std-go.02"]' }) }), manyRecords(70)], {
    exit: 1,
    includes: ['[FAIL] budget', 'the index lines are', 'and the cap is 16384 (rules/context-budget.md)', 'Supersede the records that no longer bind'],
  }),
  {
    n: 120,
    name: '--global with a batch written and not committed: it reads HEAD, so exit 2, every file named',
    build: (root) => {
      const dir = globalRepo(root, [GLOBAL_DOCS]);
      writeFiles(dir, {
        'docs/architecture/ADR-013-redis-or-valkey.md': adr({ n: '013', title: 'Use Redis or Valkey for caching' }),
        'docs/standards/std-caching.md': standard({ topic: 'caching', title: 'Caching', description: 'How caches are written in every product.', globs: '["**/cache/**"]', origin: 'Global Architecture Board' }),
      });
      return { registry: null, hub: {}, trunk: false, cwd: dir, args: ['--global'] };
    },
    exit: 2,
    includes: ['2 change(s) under', 'docs/architecture/ADR-013-redis-or-valkey.md', 'docs/standards/std-caching.md', 'Commit them, or remove them'],
  },
  {
    n: 121,
    name: 'a path-scoped rule with no paths: loads in every session in Claude Code',
    build: () => ({ registry: registry({}), hub: withHub({ '.claude/rules/testing.md': RULE('testing', false, { paths: null }) }), args: ['--offline'] }),
    exit: 1,
    includes: ['[FAIL] path-scoped rules  0 scoped by paths:', '.claude/rules/testing.md: is alwaysApply: false and has no paths:, so Claude Code loads it in every session; add paths: with the same list as globs:'],
  },
  {
    n: 122,
    name: 'paths: and globs: that differ: two runtimes would load the rule for different files',
    build: () => ({ registry: registry({}), hub: withHub({ '.claude/rules/testing.md': RULE('testing', false, { paths: '["tests/**"]' }) }), args: ['--offline'] }),
    exit: 1,
    includes: ['.claude/rules/testing.md: paths ["tests/**"] and globs ["src/**"] differ'],
  },
  {
    n: 123,
    name: 'a path-scoped rule whose globs match every path is always on in all but name',
    build: () => ({ registry: registry({}), hub: withHub({ '.claude/rules/testing.md': RULE('testing', false, { globs: '["**/*"]' }) }), args: ['--offline'] }),
    exit: 1,
    includes: ['.claude/rules/testing.md: is path-scoped but a glob matches every path; a rule that binds every change is alwaysApply: true'],
  },
  {
    n: 124,
    name: 'an always-on rule with paths: loads only on a matching read',
    build: () => ({ registry: registry({}), hub: withHub({ '.claude/rules/estate.md': RULE('estate', true, { paths: '["src/**"]' }) }), args: ['--offline'] }),
    exit: 1,
    includes: ['.claude/rules/estate.md: is alwaysApply: true and has paths:, so Claude Code loads it only when a matching file is read; remove paths:'],
  },
  {
    n: 125,
    name: 'a file in the rules folder with no frontmatter loads in every session',
    build: () => ({ registry: registry({}), hub: withHub({ '.claude/rules/GUIDE.md': '# A guide for rule authors\n' }), args: ['--offline'] }),
    exit: 1,
    includes: ['.claude/rules/GUIDE.md: has no frontmatter, so Claude Code loads it in every session'],
  },
  {
    n: 94,
    name: 'a ticket copied in by /feature is a requirements source like any brief: its file in the run folder parses as a well-formed document',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [SPOKE] });
      return {
        registry: registry({ 'transfer-service': entry(a) }),
        hub: withHub({
          'docs/requirements/onboarding/runs/20260730_0930/jira-abc-12.md': doc({
            name: 'onboarding-20260730-0930-jira-abc-12',
            kind: 'requirements-source',
            description: 'Jira ticket ABC-12 and its comments, read by /feature.',
            owner: 'product owner',
            // The revision is the ticket's own `updated` value, copied unchanged.
            revision: '2026-07-30T09:12:44.512+0100',
            origin: 'https://example.atlassian.net/browse/ABC-12',
            body: [
              '# ABC-12 — Candidates download their report as a PDF', '',
              'Link: https://example.atlassian.net/browse/ABC-12. Type: Story. Status: To Do. Updated: 2026-07-30T09:12:44.512+0100.', '',
              '## Description', '', 'A candidate can download the report as a PDF from the results page.', '',
              '## Comments (2)', '',
              '### Comment 1 — A. Example, 2026-07-28T14:02:11.000+0100', '', 'The PDF must carry the same scores as the page.', '',
              '### Comment 2 — B. Example, 2026-07-29T10:30:00.000+0100', '', 'The download link sits under the score summary.', '',
            ].join('\n'),
          }),
        }),
        args: [],
      };
    },
    exit: 0,
    // The report counts documents and does not list ids: a second source and a ninth document show the file parsed.
    includes: ['[PASS] hub', '3 in docs/requirements (1 requirements document(s), 2 requirements source(s))', 'WELL FORMED: 9 context document(s)'],
    excludes: ['[FAIL]'],
  },
];

/**
 * Check out requirements/onboarding in the published hub and commit `files`
 * on it -- by default the document amended and a review approving the amended
 * bytes, as /feature leaves an amendment on its open pull request.
 */
function amendOnBranch(hub, files) {
  const amended = `${REQ_DOC}\nAmended: the assumption on the opening deposit is corrected.\n`;
  git(hub, ['checkout', '-q', '-b', 'requirements/onboarding']);
  writeFiles(hub, files || {
    'docs/requirements/onboarding/requirements.md': amended,
    'docs/requirements/onboarding/requirements-review.md': REVIEW({ of: amended }),
  });
  git(hub, ['add', '-A']);
  git(hub, ['commit', '-q', '-m', 'the amendment']);
}

/* ---------------------------------------------------------------------- runner */

function publishHub(root, hub) {
  const bare = join(root, 'hub.git');
  git(root, ['init', '--bare', '-q', '--initial-branch', 'main', bare]);
  git(hub, ['init', '-q', '--initial-branch', 'main']);
  git(hub, ['config', 'user.name', 'Fixture Runner']);
  git(hub, ['config', 'user.email', 'fixture@example.invalid']);
  git(hub, ['config', 'commit.gpgsign', 'false']);
  git(hub, ['add', '-A']);
  git(hub, ['commit', '-q', '--allow-empty', '-m', 'the hub trunk']);
  git(hub, ['remote', 'add', 'origin', bare]);
  git(hub, ['push', '-q', 'origin', 'main']);
}

function runFixture(fixture) {
  const root = mkdtempSync(join(tmpdir(), `context-fx${String(fixture.n).padStart(2, '0')}-`));
  try {
    const hub = join(root, 'hub');
    mkdirSync(join(hub, 'docs', 'estate'), { recursive: true });
    const built = fixture.build(root);
    if (built.registry !== null) writeFileSync(join(hub, 'docs', 'estate', 'repositories.json'), built.registry);
    if (built.hub) writeFiles(hub, built.hub);
    // The hub as a clone of its trunk: everything committed and pushed to a bare
    // origin, so refs/remotes/origin/main carries what the folder holds. A
    // requirements document is accepted only where that ref carries its bytes;
    // `trunk: false` leaves the hub a plain folder, with no trunk to read.
    if (built.trunk !== false) publishHub(root, hub);
    const env = { ...ENV, HARNESS_SPOKE_CACHE: join(root, 'cache') };
    if (built.before) built.before(hub, env);
    const res = spawnSync(process.execPath, [SCRIPT, ...built.args], { cwd: built.cwd || hub, env, encoding: 'utf8' });
    const output = `${res.stdout || ''}${res.stderr || ''}`;
    const problems = [];
    if (res.status !== fixture.exit) problems.push(`expected exit ${fixture.exit}, got ${res.status}`);
    for (const needle of fixture.includes || []) {
      if (!output.includes(needle)) problems.push(`output does not contain: ${JSON.stringify(needle)}`);
    }
    for (const needle of fixture.excludes || []) {
      if (output.includes(needle)) problems.push(`output should not contain: ${JSON.stringify(needle)}`);
    }
    if (built.expect) problems.push(...built.expect(res.stdout || '', hub));
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
    ? `\n${failed} of ${selected.length} fixtures FAILED. The context documents are not proven until this is green.\n`
    : `\nAll ${selected.length} fixtures passed.\n`);
  rmSync(SANDBOX_HOME, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
}

main();

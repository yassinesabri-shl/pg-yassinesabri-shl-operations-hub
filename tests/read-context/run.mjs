#!/usr/bin/env node
/**
 * run.mjs — the fixture suite for read-context.mjs.
 *
 *   usage:  node run.mjs            run every fixture
 *           node run.mjs 2 6        run only the numbered fixtures
 *           node run.mjs --keep     leave the throwaway repositories on disk
 *
 * A fixture is a REPOSITORY STATE: a throwaway hub on disk with its document
 * folders, a real bare spoke remote with a commands file and a contracts folder,
 * a registry pointing at it, and the shipped script run from the hub exactly as
 * the orchestrator would run it. Exit code, header lines and, where it matters,
 * the documents printed after the separator are asserted. Fixture 1 is the valid
 * control; most others change one thing. Fixtures 19 to 27 and 31 to 33 run
 * `--hub`, the hub-only read, and build no remote at all: that is the point of
 * them. The hub holds one merged requirements document with its approving
 * review, so the index carries a `requirements-document` line at rank 1.
 * Fixtures 46 to 66 run `--pinned`: the design's one `Context:` line read at the
 * bytes each entry pins, found on the hub's origin trunk or the spoke's trunk,
 * after the trunk has moved on where the fixture says so. Fixtures 78 to 91
 * read the global layer with `--global <commit>`, from a real bare global
 * remote: its index, its always-on bodies, `--names global.<id>`, the commit
 * asked for and not the global trunk head, and the refusals. Fixtures 92 to 97
 * put a global entry on a `--pinned` design's line: read at the release the
 * requirements document of the design's work item records, or refused.
 * Fixtures 129 to 139 read a hub with two features: the default index leaves
 * out every requirements source and counts them on its `Index:` line, while
 * `--names`, `--all` and `--sources <slug>` still reach a source.
 *
 * Node standard library only, plus git via child_process. No test framework.
 * Exit 0 if every fixture passes, 1 if any fails.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

const SCRIPT = [
  process.env.HARNESS_READ_CONTEXT,
  resolve(HERE, '..', '..', 'read-context.mjs'),
  resolve(HERE, '..', '..', 'scripts', 'read-context.mjs'),
].filter(Boolean).find((p) => existsSync(p));

if (!SCRIPT) {
  console.error('cannot locate read-context.mjs. Set HARNESS_READ_CONTEXT=/path/to/read-context.mjs.');
  process.exit(4);
}

/* ------------------------------------------------------------------ git helpers */

const SANDBOX_HOME = mkdtempSync(join(tmpdir(), 'readctx-home-'));
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

// A hub standard in the template's shape: the nine sections in order, one rule
// under the standard's own name. `rule` is the rule's text.
const standard = ({ topic, title, rule, status = 'Active', ...header }) => doc({ name: `std-${topic}`, kind: 'standard', status, ...header, body: [
  `# std-${topic}: ${title}`, '',
  '## Applies to', '', 'Every change it names.', '',
  '## Must', '', `- **std-${topic}.01** MUST ${rule} *(Source: §1)*`, '',
  ...['Should', 'Values', 'Checked by', 'Relations', 'Exceptions', 'Unresolved'].flatMap((h) => [`## ${h}`, '', 'None.', '']),
  '## Origin', '', `${title}, as the client keeps it.`, '',
].join('\n') });

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
const LEDGER_CONTRACT = doc({ name: 'ledger-write-api', kind: 'contract', description: 'The ledger write API this service calls.', revision: 'v2', origin: 'ledger-service, contracts/write.yaml', body: '# Ledger write API\n\nPOST /postings, double entry, idempotent on the request id.\n' });

// A hub copy of a decision record kept where the client keeps its records: the
// shared header plus `status`, then the five sections an agent acts on. `name`
// may differ from `n` on purpose, and `drop` removes header lines by key.
const adr = ({ n = '004', name = `ADR-${n}`, title = 'Serve eligibility from a read model, not the ledger', status = 'Accepted', globs = '["services/eligibility/**"]', alwaysApply = false, drop = [] } = {}) => {
  const lines = [
    `name: ${name}`, `description: ${title}`, `globs: ${globs}`, `alwaysApply: ${alwaysApply}`, 'kind: adr', `status: ${status}`,
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

const OVERVIEW = doc({ name: 'estate-overview', kind: 'estate-overview', description: 'What the estate is, part by part, for a reader who has never seen it.', owner: 'lead architect', revision: '2026-09-01', origin: 'written by the lead architect, /add-context', body: '# The estate\n\nOne transfer service and one ledger. Ask the tech lead about transfers.\n' });

// The requirements document /feature wrote and a person merged: the template's
// title and its §1 Document control table, read by label, then a short body. It
// carries no header -- the parser reads the document's own structure.
const REQUIREMENTS = ({ slug = 'onboarding', title = 'Onboarding: a new customer opens an account in one sitting', revision = 'r1', date = '2026-07-30', owner = 'product owner' } = {}) => [
  `# Requirements — ${title}`,
  '',
  '## 1. Document control',
  '',
  '| Field | Value |',
  '|---|---|',
  `| Document revision | ${revision} |`,
  `| Date | ${date} |`,
  `| Owning role | ${owner} |`,
  '| Review | `requirements-review.md` — beside this document, bound to its bytes |',
  `| Slug | \`${slug}\` |`,
  '| Source locator convention | note identifiers for `interview.md` |',
  '',
  '## 2. Purpose and business outcome',
  '',
  'A new customer opens an account without leaving the flow.',
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
// gate reads, its `Document revision:` binding it to the document's bytes.
const REVIEW = ({ slug = 'onboarding', verdict = '### VERDICT: APPROVED', of = REQ_DOC } = {}) => [
  `## Review: ${slug} — the requirements document against the brief`,
  '',
  verdict,
  'Cycle: 1 of 2',
  'Mode: feature-review',
  'Reviewer: pm-critic',
  `Document revision: ${blobHash(of)}`,
  '',
].join('\n');
const REQ_REVIEW = REVIEW();

const HUB = {
  'CLAUDE.md': '# Constitution\n',
  'docs/estate/overview.md': OVERVIEW,
  'docs/architecture/_TEMPLATE.adr.md': '# ADR-<NNN>: <state the decision>\n',
  'docs/architecture/ADR-004-eligibility-read-model.md': adr({}),
  'docs/standards/std-sql-style.md': standard({ topic: 'sql-style', title: 'SQL style', rule: 'write keywords in upper case. No SELECT *.', description: 'How SQL is written across the estate.', globs: '["**/*.sql"]', revision: '2026-03', origin: 'client data platform team' }),
  'docs/standards/std-handbook.md': standard({ topic: 'handbook', title: 'Client engineering handbook', rule: 'log the request in every service. Every service logs a correlation id.', description: 'The client handbook every design obeys.', alwaysApply: true, revision: '2026 edition', origin: 'client intranet, copied 2026-09-01' }),
  'docs/requirements/onboarding/runs/20260730_0930/onboarding-brief.md': doc({ name: 'onboarding-20260730-0930-onboarding-brief', kind: 'requirements-source', description: 'The onboarding brief /feature was run on.', revision: 'v1.1, 2026-07-30', origin: 'product one-pager, wiki page 4412' }),
  // The merged requirements document, id the slug, accepted because the review
  // beside it approves its bytes.
  'docs/requirements/onboarding/requirements.md': REQ_DOC,
  'docs/requirements/onboarding/requirements-review.md': REQ_REVIEW,
};

// A hub with two features, each with one requirements source: --sources must
// list the sources of the feature it names, and of no other.
const PAYMENTS_DOC = REQUIREMENTS({ slug: 'payments', title: 'Payments: a customer pays a bill from the account' });
const PAYMENTS_INTERVIEW_PATH = 'docs/requirements/payments/runs/20260901_1100/interview.md';
const TWO_FEATURES = {
  ...HUB,
  'docs/requirements/payments/requirements.md': PAYMENTS_DOC,
  'docs/requirements/payments/requirements-review.md': REVIEW({ slug: 'payments', of: PAYMENTS_DOC }),
  [PAYMENTS_INTERVIEW_PATH]: doc({ name: 'payments-20260901-1100-interview', kind: 'requirements-source', description: 'The interview record of the payments run.', revision: '2026-09-01', origin: '/feature' }),
};

const SPOKE = {
  'README.md': '# transfer-service\n\nMoves money between accounts.\n',
  'checks.env': CHECKS('contracts'),
  'contracts/vendor-a/api.md': VENDOR_DOC,
  'contracts/vendor-a/openapi.yaml': 'openapi: 3.1.0\n',
  'contracts/ledger-write-api.md': LEDGER_CONTRACT,
  'src/payments/charge.ts': 'export {};\n',
};

// A hub file that carries this token is written and committed after the hub is
// published, with the token replaced by the published trunk commit: a design's
// Hub commit: line names a commit that exists before the design does.
const HUB_COMMIT_TOKEN = '@HUB_COMMIT@';

const DESIGN = ({ paths = ['src/payments/charge.ts', 'README.md'], contracts = ['vendor-a-api'], traceability = 'Derives from: ADR-004 § Decision L17-17', rules = 'none', hubCommit = HUB_COMMIT_TOKEN, fenced = '' } = {}) => [
  '# LLD — TRF-7: create a charge with Acme Pay',
  '',
  '## 1. Traceability',
  '',
  'Work item: TRF-7',
  'Repository: transfer-service',
  `Rules: ${rules}`,
  ...(hubCommit === null ? [] : [`Hub commit: ${hubCommit}`]),
  traceability,
  '',
  '## 3. The design',
  '',
  '### 3.1 Components changed or added',
  '',
  '| Path | Change | Responsibility |',
  '|---|---|---|',
  ...paths.map((p) => `| \`${p}\` | modified | one line |`),
  '',
  '## 6. Cross-system contracts',
  '',
  '| Contract | Version | Direction | Change required |',
  '|---|---|---|---|',
  ...contracts.map((c) => `| ${c} | v3.2 | consumed | none |`),
  '',
  fenced,
  '',
].join('\n');

// One `Context:` entry as the script prints it: the id, the first twelve
// characters of the blob hash of the bytes read, and the path -- with the
// repository before it for a document kept in a spoke.
const pin = (id, path, body, repository = null) => `${id}@${blobHash(body).slice(0, 12)}:${repository === null ? '' : `${repository}:`}${path}`;
const HANDBOOK_PATH = 'docs/standards/std-handbook.md';
const HANDBOOK_ENTRY = pin('std-handbook', HANDBOOK_PATH, HUB[HANDBOOK_PATH]);
const ADR_PATH = 'docs/architecture/ADR-004-eligibility-read-model.md';
const REQ_PATH = 'docs/requirements/onboarding/requirements.md';

const registry = (repositories) => JSON.stringify({ schema_version: 1, repositories }, null, 2);
const entry = (remote, checks = 'checks.env', trunk = 'default') => ({ url: remote.url, checks, purpose: 'Moves money between accounts.', readAt: remote.head, trunk });

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

// The spoke's own decision record, ADR-004 in its file and transfer-service.ADR-004
// everywhere else, beside the hub's ADR-004. Its globs reach no path the fixtures name,
// so only a design that names it selects it.
const RETRY_RECORD = adr({ n: '004', title: 'Retry a charge three times, then give up', globs: '["src/refunds/**"]' });
const RECORD_PATH = 'decisions/ADR-004-retry-budget.md';
const SPOKE_RECORDS = withSpoke({ 'checks.env': `${CHECKS('contracts')}DECISIONS_INDEX=decisions\n`, [RECORD_PATH]: RETRY_RECORD });
const RECORD_ENTRY = pin('transfer-service.ADR-004', RECORD_PATH, RETRY_RECORD, 'transfer-service');

// A spoke rule in the rule template's shape, with the optional `overrides` key
// where a fixture asks for it.
const rule = ({ name, globs = '["**/*"]', alwaysApply = false, overrides = null, body = `# Rule — ${name}\n\n- One checkable sentence.\n` }) =>
  `---\nname: ${name}\ndescription: The ${name} rule.\nglobs: ${globs}\nalwaysApply: ${alwaysApply}\n${overrides === null ? '' : `overrides: ${overrides}\n`}---\n\n${body}`;

// The spoke with a rules folder: the always-on repository rule and a path-scoped
// SQL rule that, by default, overrides one rule of the hub's SQL standard.
const RULED_SPOKE = ({ repositoryOverrides = null, sqlOverrides = '["std-sql-style.01"]' } = {}) => withSpoke({
  'checks.env': `${CHECKS('contracts')}RULES_INDEX=docs/rules\n`,
  'docs/rules/repository.md': rule({ name: 'repository', alwaysApply: true, overrides: repositoryOverrides }),
  'docs/rules/sql.md': rule({ name: 'sql-house-style', globs: '["**/*.sql"]', overrides: sqlOverrides, body: '# SQL house style\n\n- Keywords in lower case; the formatter decides.\n' }),
});

// --pinned: a merged design whose one Context: line names documents by pin.
const DESIGN_PATH = 'docs/designs/TRF-7.lld.md';
const PINNED_DESIGN = (context) => `${DESIGN()}Context: ${context}\n`;
const pinOf = (text) => blobHash(text).slice(0, 12);
const ADR_ENTRY = pin('ADR-004', ADR_PATH, HUB[ADR_PATH]);
const VENDOR_PATH = 'contracts/vendor-a/api.md';
const VENDOR_ENTRY = pin('vendor-a-api', VENDOR_PATH, VENDOR_DOC, 'transfer-service');
const HANDBOOK_V2 = HUB[HANDBOOK_PATH].replace('Every service logs a correlation id.', 'Every service logs a trace id.');
const HANDBOOK_DRAFT = HUB[HANDBOOK_PATH].replace('Every service logs a correlation id.', 'Every service logs a request id.');
const VENDOR_V2 = VENDOR_DOC.replace('Confirm within 15 minutes', 'Confirm within 30 minutes');

/** Move the hub on after the design was written: commit, and push unless told not to. */
function hubCommit(hub, files, { push = true, branch = null } = {}) {
  if (branch !== null) git(hub, ['checkout', '-q', '-b', branch]);
  for (const [rel, body] of Object.entries(files)) {
    if (body === null) git(hub, ['rm', '-q', rel]);
    else writeFiles(hub, { [rel]: body });
  }
  git(hub, ['add', '-A']);
  git(hub, ['commit', '-q', '-m', 'the trunk moves on']);
  if (push) git(hub, ['push', '-q', 'origin', 'HEAD']);
}

// One --pinned fixture: a spoke remote, the hub with the design, and the run.
// `context` is the Context: value, or a function of the spoke remote returning
// the whole design. `before(hub, env, spoke)` moves a trunk after the design was
// written; `expect(stdout, spoke)` returns extra problems.
// `branch` adds a declared harness trunk to the spoke, and `trunk` names it in the registry.
const pinnedCase = (n, name, { context, spoke = SPOKE, before = null, expect = null, args = null, branch = null, trunk = 'default', exit, includes = [], excludes = [] }) => ({
  n,
  name,
  build: (root) => {
    const a = makeRemote(root, 'transfer-service', { commits: [spoke], branch });
    const built = {
      registry: registry({ 'transfer-service': entry(a, 'checks.env', trunk) }),
      hub: { ...HUB, [DESIGN_PATH]: typeof context === 'function' ? context(a) : PINNED_DESIGN(context) },
      args: args === null ? ['transfer-service', '--pinned', DESIGN_PATH] : args,
    };
    if (before) built.before = (hub, env) => before(hub, env, a);
    if (expect) built.expect = (out) => expect(out, a);
    return built;
  },
  exit,
  includes,
  excludes,
});

// The global context repository: the Board's records, standards and exceptions,
// at the hub's folder names, each file carrying its id without `global.`. Its
// ADR-004 sits at the same path as the hub's ADR-004 and says something else,
// so a read that mixed the two layers up would show.
const EXCEPTION = ({ n = '004', hubs = '["SIM"]', repositories = '["sim-desktop"]', departs = '["ADR-012"]', status = 'Active', reviewBy = '2027-04-01', reason = 'The simulator runs in exam rooms with no network, so no Redis is reachable during a session.', drop = [] } = {}) => {
  const lines = [
    `name: EXC-${n}`, 'description: The desktop simulator keeps an in-process cache instead of Redis, because it runs offline.', 'kind: exception',
    `hubs: ${hubs}`, `repositories: ${repositories}`, `departs: ${departs}`, `status: ${status}`, `review-by: ${reviewBy}`,
    'owner: desktop simulator tech lead', 'approver: Global Architecture Board', 'revision: v1', 'origin: this repository',
  ].filter((l) => !drop.some((k) => l.startsWith(`${k}:`)));
  return `---\n${lines.join('\n')}\n---\n\n${[
    `# EXC-${n} — the desktop simulator's offline cache`, '',
    '## Reason', '', reason, '',
    '## Scope', '', 'Only the cache that holds item banks during an assessment session.', '',
    '## Alternatives considered', '', '1. Embedded Redis in the installer. Rejected: 40 MB and a second process.', '',
    '## What the product does instead', '', 'SIM hub record ADR-031: an in-process cache, cleared at the end of every session.', '',
    '## Exit', '', 'The simulator gains a network mode in exam rooms.', '',
  ].join('\n')}`;
};
const GLOBAL_ADR_PATH = 'docs/architecture/ADR-012-redis-only.md';
const GLOBAL_SECURITY_PATH = 'docs/standards/std-security.md';
const GLOBAL_EXC_PATH = 'docs/exceptions/EXC-004-sim-offline-cache.md';
const GLOBAL = {
  'README.md': '# Global context\n',
  'docs/architecture/_TEMPLATE.adr.md': '# ADR-<NNN>: <state the decision>\n',
  [ADR_PATH]: adr({ n: '004', title: 'Log every eligibility decision for audit', globs: '[]' }),
  [GLOBAL_ADR_PATH]: adr({ n: '012', title: 'Use only Redis for caching', globs: '["**/cache/**"]' }),
  'docs/standards/std-go.md': standard({ topic: 'go', title: 'Go', rule: 'wrap every returned error with its context.', description: 'How Go is written in every product.', globs: '["**/*.go"]', owner: 'Global Architecture Board', revision: 'v1', origin: 'architecture board minutes' }),
  [GLOBAL_SECURITY_PATH]: standard({ topic: 'security', title: 'Security baseline', rule: 'encrypt every candidate record at rest.', description: 'The security baseline every product follows.', alwaysApply: true, owner: 'Global Architecture Board', revision: 'v1', origin: 'architecture board minutes' }),
  [GLOBAL_EXC_PATH]: EXCEPTION(),
};
const globalLink = (remote) => `${JSON.stringify({ schema_version: 1, url: remote.url }, null, 2)}\n`;
// A global entry pins the global commit, not the blob.
const globalPin = (id, path, commit) => `${id}@${commit.slice(0, 12)}:global:${path}`;

// One global fixture: a global remote whose first commit is `global`, the hub
// with its link file, and the run. `args(g)` builds the arguments from the
// global remote. `spoke` adds a spoke remote and its registry entry: `true` for
// the default spoke, or the spoke's files.
const globalCase = (n, name, { global = GLOBAL, hub = {}, link = true, spoke = false, args, before = null, expect = null, exit, includes = [], excludes = [] }) => ({
  n,
  name,
  build: (root) => {
    const g = makeRemote(root, 'global-context', { commits: [global] });
    const a = spoke ? makeRemote(root, 'transfer-service', { commits: [spoke === true ? SPOKE : spoke] }) : null;
    const built = {
      registry: registry(a ? { 'transfer-service': entry(a) } : {}),
      hub: withHub({ ...(link ? { 'docs/estate/global.json': typeof link === 'function' ? link(root) : globalLink(g) } : {}), ...hub }),
      args: args(g),
    };
    if (before) built.before = (h, env) => before(h, env, g);
    if (expect) built.expect = (out) => expect(out, g);
    return built;
  },
  exit,
  includes,
  excludes,
});

// One --pinned fixture with a global entry: a global remote, the hub with its
// link file, the work item of TRF-7 and the requirements document of its slug,
// which records the release at the global remote's head. `context(g)` is the
// design's Context: value, `global(g)` the requirements document's Global:
// value, and `link(root)` replaces the link file.
const PINNED_SLUG = 'card-charges';
const PINNED_REQ_PATH = `docs/requirements/${PINNED_SLUG}/requirements.md`;
const pinnedGlobalCase = (n, name, { context, global = (g) => `v1.4.0 ${g.head}`, link = null, before = null, expect = null, exit, includes = [], excludes = [] }) => ({
  n,
  name,
  build: (root) => {
    const g = makeRemote(root, 'global-context', { commits: [GLOBAL] });
    const a = makeRemote(root, 'transfer-service', { commits: [SPOKE] });
    const built = {
      registry: registry({ 'transfer-service': entry(a) }),
      hub: {
        ...HUB,
        'docs/estate/global.json': link === null ? globalLink(g) : link(root),
        [`docs/backlog/${PINNED_SLUG}/TRF-7.item.md`]: '# TRF-7 — create a charge\n\nKey: TRF-7\nRepository: transfer-service\n',
        [PINNED_REQ_PATH]: `${REQUIREMENTS({ slug: PINNED_SLUG, title: 'Card charges' })}\nGlobal: ${global(g)}\n`,
        [DESIGN_PATH]: PINNED_DESIGN(context(g)),
      },
      args: ['transfer-service', '--pinned', DESIGN_PATH],
    };
    if (before) built.before = (hub, env) => before(hub, env, g);
    if (expect) built.expect = (out) => expect(out, g);
    return built;
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

/* ------------------------------------------------------------------- fixtures */

// `build(root)` returns { registry, hub, args, before?, expect? }. `hub` is
// written into the throwaway hub before the run (documents, and a design to
// select by). `expect(stdout)` may return extra problems.
const FIXTURES = [
  {
    n: 1,
    name: 'valid control, selected by the design: the always-on handbook, the record the design cites, the vendor document it names in §6 and whose glob its §3.1 path matches; not the SQL standard, not the other contract, not the brief, not the requirements document it never names',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [SPOKE] });
      return {
        registry: registry({ 'transfer-service': entry(a) }),
        hub: { ...HUB, 'docs/designs/TRF-7.lld.md': DESIGN() },
        args: ['transfer-service', '--design', 'docs/designs/TRF-7.lld.md'],
        expect: (out) => {
          const problems = [];
          if (!out.includes(`Commit: ${a.head}`)) problems.push('header does not pin the trunk head');
          if (!out.includes(`Cite: transfer-service@${a.head.slice(0, 12)}:contracts/vendor-a/api.md`)) problems.push('the vendor document has no Cite line with the short commit');
          if (!out.includes('Cite: docs/architecture/ADR-004-eligibility-read-model.md')) problems.push('the hub record has no plain-path Cite line');
          if (out.includes('alwaysApply:')) problems.push('frontmatter leaked into a printed body');
          if (out.includes('No SELECT *')) problems.push('the SQL standard was selected though no .sql path is touched');
          if (out.includes('double entry')) problems.push('the ledger contract was selected though the design never names it');
          return problems;
        },
      };
    },
    exit: 0,
    includes: ['Repository: transfer-service', 'Trunk: main', 'Hub: 6 document(s)', 'Spoke: 2 document(s) in contracts', 'Paths: src/payments/charge.ts, README.md', 'Names: ADR-004, vendor-a-api', 'Selected: 3 of 8: std-handbook, ADR-004, vendor-a-api', `Context: ${HANDBOOK_ENTRY}, ${pin('ADR-004', ADR_PATH, HUB[ADR_PATH])}, ${pin('vendor-a-api', 'contracts/vendor-a/api.md', VENDOR_DOC, 'transfer-service')}`, 'Document: std-handbook', 'Kind: standard · Rank: unranked · Owner: tech lead', 'Document: ADR-004', 'Kind: adr · Rank: 3 · Owner: lead architect · Revision: page version 7, 2026-08-20 · Status: Accepted', 'Document: vendor-a-api', 'Kind: vendor-doc · Rank: 2', 'Confirm within 15 minutes'],
    excludes: ['Document: estate-overview', 'Document: onboarding'],
  },
  {
    n: 2,
    name: 'no selector: the index, one line per document in scope and no bodies',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [SPOKE] });
      return { registry: registry({ 'transfer-service': entry(a) }), hub: HUB, args: ['transfer-service'] };
    },
    exit: 0,
    includes: ['Index: 7 document(s) in scope; pass --design, --paths, --names or --all to select; 1 requirements source(s) left out, and --sources <slug> lists those of one feature', '- ADR-004 · adr · hub · rank 3 · Accepted · Serve eligibility from a read model, not the ledger', '- std-handbook · standard · hub · unranked · always on · Active · The client handbook every design obeys.', '- vendor-a-api · vendor-doc · transfer-service · rank 2 · Acme Pay: how a charge is created and confirmed.', '- onboarding · requirements-document · hub · rank 1 · accepted · Onboarding: a new customer opens an account in one sitting', '- estate-overview · estate-overview · hub · unranked · What the estate is, part by part'],
    excludes: ['Document:', 'Confirm within 15 minutes', 'Context:', 'without leaving the flow', 'requirements-source ·'],
  },
  {
    n: 3,
    name: '--paths alone: a glob match selects the vendor document without the design naming it; the always-on standard comes too',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [SPOKE] });
      return { registry: registry({ 'transfer-service': entry(a) }), hub: HUB, args: ['transfer-service', '--paths', 'src/payments/refund.ts'] };
    },
    exit: 0,
    includes: ['Names: (none given)', 'Selected: 2 of 8: std-handbook, vendor-a-api'],
    excludes: ['Document: ADR-004', 'Document: std-sql-style'],
  },
  {
    n: 4,
    name: '--names selects by id, and a hub glob matches a spoke path: the SQL standard binds a .sql file in the spoke',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [SPOKE] });
      return { registry: registry({ 'transfer-service': entry(a) }), hub: HUB, args: ['transfer-service', '--names', 'ledger-write-api', '--paths', 'migrations/0007_postings.sql'] };
    },
    exit: 0,
    includes: ['Selected: 3 of 8: std-handbook, std-sql-style, ledger-write-api', 'No SELECT *', 'double entry'],
  },
  {
    n: 5,
    name: '--names with an id that is not in scope is a usage error that lists what is',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [SPOKE] });
      return { registry: registry({ 'transfer-service': entry(a) }), hub: HUB, args: ['transfer-service', '--names', 'vendor-z-api'] };
    },
    exit: 3,
    includes: ['--names vendor-z-api: not a document in scope. In scope: ADR-004, estate-overview, onboarding, onboarding-20260730-0930-onboarding-brief, std-handbook, std-sql-style, ledger-write-api, vendor-a-api'],
  },
  {
    n: 6,
    name: '--all prints every document in scope with bodies',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [SPOKE] });
      return { registry: registry({ 'transfer-service': entry(a) }), hub: HUB, args: ['transfer-service', '--all'] };
    },
    exit: 0,
    includes: ['Selected: 8 of 8', 'Document: onboarding-20260730-0930-onboarding-brief', 'Document: onboarding\n', 'Kind: requirements-document · Rank: 1 · Owner: product owner · Revision: r1, 2026-07-30 · Status: accepted', 'Document: std-sql-style', 'Document: ledger-write-api', 'Document: vendor-a-api', 'Document: ADR-004'],
  },
  {
    n: 7,
    name: 'nothing matches and no document is always on: Context: none',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [SPOKE] });
      return {
        registry: registry({ 'transfer-service': entry(a) }),
        hub: withHub({ 'docs/standards/std-handbook.md': null, 'docs/designs/TRF-7.lld.md': DESIGN({ paths: ['README.md'], contracts: [], traceability: 'Derives from: the brief § 2' }) }),
        args: ['transfer-service', '--design', 'docs/designs/TRF-7.lld.md'],
      };
    },
    exit: 0,
    includes: ['Selected: 0 of 7', 'Context: none'],
    excludes: ['Document:'],
  },
  {
    n: 8,
    name: 'an id that appears only inside a code fence is not a name the design gives',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [SPOKE] });
      return {
        registry: registry({ 'transfer-service': entry(a) }),
        hub: { ...HUB, 'docs/designs/TRF-7.lld.md': DESIGN({ paths: ['README.md'], contracts: [], traceability: 'Derives from: the brief § 2', fenced: '```\nledger-write-api example\n```' }) },
        args: ['transfer-service', '--design', 'docs/designs/TRF-7.lld.md'],
      };
    },
    exit: 0,
    includes: ['Names: (none given)', 'Selected: 1 of 8: std-handbook'],
    excludes: ['Document: ledger-write-api'],
  },
  {
    n: 9,
    name: 'a malformed spoke document: the set binds nobody and nothing is selected',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [withSpoke({ 'contracts/vendor-a/api.md': doc({ name: 'vendor-a-api', kind: 'vendor-doc', drop: ['revision'] }) })] });
      return { registry: registry({ 'transfer-service': entry(a) }), hub: HUB, args: ['transfer-service', '--all'] };
    },
    exit: 1,
    includes: ['Status: NOT WELL FORMED: 1 finding(s)', 'FAIL: a document in scope is malformed, and a malformed set binds nobody', 'contracts/vendor-a/api.md: frontmatter is missing "revision"'],
    excludes: ['Document:'],
  },
  {
    n: 10,
    name: 'a malformed hub record: the same refusal, from the hub side',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [SPOKE] });
      return {
        registry: registry({ 'transfer-service': entry(a) }),
        hub: withHub({ 'docs/architecture/ADR-004-eligibility-read-model.md': adr({ status: 'Agreed' }) }),
        args: ['transfer-service', '--all'],
      };
    },
    exit: 1,
    includes: ['status "Agreed" is not one of Accepted, Superseded by ADR-<NNN>, Superseded by global.ADR-<NNN>, Deprecated'],
  },
  {
    n: 11,
    name: '--at reads the pinned commit after a document was added on the trunk',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [SPOKE] });
      const pinned = a.head;
      return {
        registry: registry({ 'transfer-service': entry(a) }),
        hub: HUB,
        before: (hub, env) => {
          const first = spawnSync(process.execPath, [SCRIPT, 'transfer-service'], { cwd: hub, env, encoding: 'utf8' });
          if (first.status !== 0) throw new Error(`warm-up read failed: ${first.stderr}`);
          advance(a, { 'contracts/vendor-b.md': doc({ name: 'vendor-b-api', kind: 'vendor-doc' }) });
        },
        args: ['transfer-service', '--all', '--at', pinned],
        expect: (out) => (out.includes(`Commit: ${pinned}`) ? [] : ['header does not name the pinned commit']),
      };
    },
    exit: 0,
    includes: ['Trunk: not asked', 'Spoke: 2 document(s) in contracts', 'Selected: 8 of 8'],
    excludes: ['vendor-b-api'],
  },
  {
    n: 12,
    name: 'CONTRACTS_INDEX=none: the spoke declares no contracts, and the hub documents are still in scope',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [{ 'README.md': '# x\n', 'checks.env': CHECKS('none') }] });
      return { registry: registry({ 'transfer-service': entry(a) }), hub: HUB, args: ['transfer-service', '--paths', 'src/server.ts'] };
    },
    exit: 0,
    includes: ['Spoke: none declared (CONTRACTS_INDEX=none)', 'Selected: 1 of 6: std-handbook'],
  },
  {
    n: 13,
    name: 'CONTRACTS_INDEX=UNRESOLVED: NOT CONFIGURED in the header, and a read all the same',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [{ 'README.md': '# x\n', 'checks.env': CHECKS('UNRESOLVED') }] });
      return { registry: registry({ 'transfer-service': entry(a) }), hub: HUB, args: ['transfer-service'] };
    },
    exit: 0,
    includes: ['Spoke: NOT CONFIGURED (CONTRACTS_INDEX missing or UNRESOLVED)', 'Index: 5 document(s) in scope'],
  },
  {
    n: 14,
    name: 'no CONTRACTS_INDEX key: NOT CONFIGURED, and a contracts/ folder on disk is not read until the spoke says so',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [{ 'README.md': '# x\n', 'checks.env': CHECKS(undefined), 'contracts/vendor-a.md': VENDOR_DOC }] });
      return { registry: registry({ 'transfer-service': entry(a) }), hub: HUB, args: ['transfer-service'] };
    },
    exit: 0,
    includes: ['Spoke: NOT CONFIGURED (CONTRACTS_INDEX missing or UNRESOLVED)', 'Index: 5 document(s) in scope'],
    excludes: ['vendor-a-api'],
  },
  {
    n: 15,
    name: 'the remote is unreachable',
    build: (root) => ({
      registry: registry({ 'transfer-service': { url: join(root, 'no-such-remote.git'), checks: 'checks.env', purpose: 'Gone.', readAt: 'a'.repeat(40), trunk: 'default' } }),
      hub: HUB,
      args: ['transfer-service'],
    }),
    exit: 2,
    includes: ['CANNOT VERIFY: cannot reach', 'REASON: remote-unreachable'],
  },
  {
    n: 16,
    name: 'two positional arguments are a usage error',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [SPOKE] });
      return { registry: registry({ 'transfer-service': entry(a) }), hub: HUB, args: ['transfer-service', 'contracts'] };
    },
    exit: 3,
    includes: ['expected exactly one argument'],
  },
  {
    n: 17,
    name: 'a repository id that is not in the list is a usage error',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [SPOKE] });
      return { registry: registry({ 'transfer-service': entry(a) }), hub: HUB, args: ['ledger-service'] };
    },
    exit: 3,
    includes: ['"ledger-service" is not in', 'Listed: transfer-service'],
  },
  {
    n: 18,
    name: 'two spokes: only the named repository\'s documents are in scope beside the hub\'s',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [SPOKE] });
      const b = makeRemote(root, 'ledger-service', { commits: [{ 'README.md': '# ledger\n', 'checks.env': CHECKS('contracts'), 'contracts/postings.md': doc({ name: 'postings-api', kind: 'contract', description: 'The postings API this service serves.' }) }] });
      return { registry: registry({ 'transfer-service': entry(a), 'ledger-service': entry(b) }), hub: HUB, args: ['ledger-service'] };
    },
    exit: 0,
    includes: ['Repository: ledger-service', 'Spoke: 1 document(s) in contracts', 'Index: 6 document(s) in scope', '- postings-api · contract · ledger-service · rank 2'],
    excludes: ['vendor-a-api'],
  },
  {
    n: 19,
    name: '--hub: the hub\'s index alone -- no repository named, no remote built, no Spoke line',
    build: () => ({ registry: registry({}), hub: HUB, args: ['--hub'] }),
    exit: 0,
    includes: ['Repository: hub', 'Commit: not asked', 'Trunk: not asked', 'Hub: 6 document(s)', 'Index: 5 document(s) in scope; pass --names or --all to select; 1 requirements source(s) left out, and --sources <slug> lists those of one feature', '- ADR-004 · adr · hub · rank 3', '- std-handbook · standard · hub · unranked · always on', '- std-sql-style · standard · hub · unranked', '- onboarding · requirements-document · hub · rank 1 · accepted', '- estate-overview · estate-overview · hub · unranked · What the estate is, part by part'],
    excludes: ['Spoke:', 'Document:', 'Context:', 'requirements-source ·'],
  },
  {
    n: 20,
    name: '--hub --names: a hub document by id, with the always-on standard beside it, cited by path',
    build: () => ({ registry: registry({}), hub: HUB, args: ['--hub', '--names', 'std-sql-style'] }),
    exit: 0,
    includes: ['Repository: hub', 'Paths: (none given)', 'Names: std-sql-style', 'Selected: 2 of 6: std-handbook, std-sql-style', `Context: ${HANDBOOK_ENTRY}, ${pin('std-sql-style', 'docs/standards/std-sql-style.md', HUB['docs/standards/std-sql-style.md'])}`, 'Document: std-sql-style', 'Cite: docs/standards/std-sql-style.md', 'No SELECT *'],
    excludes: ['Spoke:', 'Document: ADR-004', 'Cite: hub@'],
  },
  {
    n: 21,
    name: '--hub --all: every hub document with its body',
    build: () => ({ registry: registry({}), hub: HUB, args: ['--hub', '--all'] }),
    exit: 0,
    includes: ['Selected: 6 of 6', 'Document: ADR-004', 'Cite: docs/architecture/ADR-004-eligibility-read-model.md', 'Document: std-handbook', 'Document: std-sql-style', 'Document: onboarding-20260730-0930-onboarding-brief', 'Document: onboarding\n', 'Document: estate-overview'],
    excludes: ['Spoke:', 'transfer-service'],
  },
  {
    n: 22,
    name: '--hub beside a repository id is a usage error',
    build: () => ({ registry: registry({}), hub: HUB, args: ['--hub', 'transfer-service'] }),
    exit: 3,
    includes: ['--hub reads the hub\'s documents alone and takes no repository id; got "transfer-service"'],
  },
  {
    n: 23,
    name: '--hub beside --at is a usage error: the hub is read live, never at a commit',
    build: () => ({ registry: registry({}), hub: HUB, args: ['--hub', '--at', 'a'.repeat(40)] }),
    exit: 3,
    includes: ['--hub takes no --at'],
  },
  {
    n: 24,
    name: '--hub beside --paths is a usage error: selection by path belongs to a design',
    build: () => ({ registry: registry({}), hub: HUB, args: ['--hub', '--paths', 'src/payments/charge.ts'] }),
    exit: 3,
    includes: ['--hub takes no --design and no --paths'],
  },
  {
    n: 25,
    name: '--hub with a malformed hub record: the same refusal as a repository read',
    build: () => ({ registry: registry({}), hub: withHub({ 'docs/architecture/ADR-004-eligibility-read-model.md': adr({ status: 'Agreed' }) }), args: ['--hub'] }),
    exit: 1,
    includes: ['Repository: hub', 'Status: NOT WELL FORMED: 1 finding(s)', 'status "Agreed" is not one of Accepted, Superseded by ADR-<NNN>, Superseded by global.ADR-<NNN>, Deprecated'],
    excludes: ['Document:'],
  },
  {
    n: 26,
    name: '--hub with no registry file at all still reads: the registry is never opened',
    build: () => ({ registry: null, hub: HUB, args: ['--hub'] }),
    exit: 0,
    includes: ['Repository: hub', 'Index: 5 document(s) in scope'],
    excludes: ['CANNOT VERIFY', 'repositories.json'],
  },
  {
    n: 27,
    name: '--hub --names estate-overview: the overview by its fixed id, cited by path, with the always-on standard beside it -- what /feature opens after the index',
    build: () => ({ registry: registry({}), hub: HUB, args: ['--hub', '--names', 'estate-overview'] }),
    exit: 0,
    includes: ['Selected: 2 of 6: std-handbook, estate-overview', 'Document: estate-overview', 'Kind: estate-overview · Rank: unranked · Owner: lead architect · Revision: 2026-09-01', 'Cite: docs/estate/overview.md', 'Ask the tech lead about transfers'],
    excludes: ['Spoke:'],
  },
  {
    n: 28,
    name: 'a design that names estate-overview selects it, like any hub document; a design that does not never gets it',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [SPOKE] });
      return {
        registry: registry({ 'transfer-service': entry(a) }),
        hub: { ...HUB, 'docs/designs/TRF-7.lld.md': DESIGN({ paths: ['README.md'], contracts: [], traceability: 'Derives from: estate-overview § 2, the parts' }) },
        args: ['transfer-service', '--design', 'docs/designs/TRF-7.lld.md'],
      };
    },
    exit: 0,
    includes: ['Names: estate-overview', 'Selected: 2 of 8: std-handbook, estate-overview', 'Cite: docs/estate/overview.md'],
  },
  {
    n: 29,
    name: 'a description over 200 characters is a finding: the index prints it, so it is one sentence, and the set is refused until it is shortened',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [SPOKE] });
      const long = standard({ topic: 'sql-style', title: 'SQL style', rule: 'write keywords in upper case.', description: `${'How SQL is written across the estate, '.repeat(6)}and more.` });
      return { registry: registry({ 'transfer-service': entry(a) }), hub: withHub({ 'docs/standards/std-sql-style.md': long }), args: ['transfer-service', '--all'] };
    },
    exit: 1,
    includes: ['Status: NOT WELL FORMED: 1 finding(s)', 'docs/standards/std-sql-style.md: description is 237 characters; the cap is 200'],
    excludes: ['Document:'],
  },
  {
    n: 30,
    name: 'a spoke document with multi-byte characters reads back whole through the one cat-file --batch call, beside a second document',
    build: (root) => {
      const wide = doc({ name: 'fx-rates-api', kind: 'vendor-doc', description: 'Rates in € and £, quoted by the vendor.', body: '# FX rates\n\nUn taux en €: 1 € = 0,86 £. 汇率每日更新。\n\nLast line, no trailing newline.' });
      const a = makeRemote(root, 'transfer-service', { commits: [withSpoke({ 'contracts/fx-rates.md': wide })] });
      return { registry: registry({ 'transfer-service': entry(a) }), hub: HUB, args: ['transfer-service', '--all'] };
    },
    exit: 0,
    includes: ['Spoke: 3 document(s) in contracts', 'Selected: 9 of 9', 'Document: fx-rates-api', 'Un taux en €: 1 € = 0,86 £. 汇率每日更新。', 'Last line, no trailing newline.', 'Document: ledger-write-api', 'double entry', 'Confirm within 15 minutes'],
    excludes: ['INTERNAL'],
  },
  // The merged requirements document in the index and in a read: what /feature
  // reads to find an overlap with an intent without opening the corpus.
  {
    n: 31,
    name: '--hub: the requirements document is one index line with its status and its title, and no body -- the pre-digested list /feature reads before its interview',
    build: () => ({ registry: registry({}), hub: HUB, args: ['--hub'] }),
    exit: 0,
    includes: ['Hub: 6 document(s)', '- onboarding · requirements-document · hub · rank 1 · accepted · Onboarding: a new customer opens an account in one sitting\n'],
    excludes: ['Document:', 'without leaving the flow', 'Document control'],
  },
  {
    n: 32,
    name: '--hub --names <slug>: the one requirements document whose line overlapped the intent, opened with its status, its revision and a plain-path Cite line',
    build: () => ({ registry: registry({}), hub: HUB, args: ['--hub', '--names', 'onboarding'] }),
    exit: 0,
    includes: ['Names: onboarding', 'Selected: 2 of 6: std-handbook, onboarding', 'Document: onboarding\n', 'Kind: requirements-document · Rank: 1 · Owner: product owner · Revision: r1, 2026-07-30 · Status: accepted', 'Cite: docs/requirements/onboarding/requirements.md', '# Requirements — Onboarding: a new customer opens an account in one sitting', 'without leaving the flow', `Context: ${HANDBOOK_ENTRY}, ${pin('onboarding', REQ_PATH, REQ_DOC)}`],
    excludes: ['Spoke:', 'Document: onboarding-20260730-0930-onboarding-brief', 'Cite: hub@'],
  },
  {
    n: 33,
    name: '--hub with no review beside the document: proposed, rank 5, and still one line -- the status is derived from the review, never typed',
    build: () => ({ registry: registry({}), hub: withHub({ 'docs/requirements/onboarding/requirements-review.md': null }), args: ['--hub'] }),
    exit: 0,
    includes: ['- onboarding · requirements-document · hub · rank 5 · proposed · Onboarding: a new customer opens an account in one sitting'],
    excludes: ['accepted'],
  },
  {
    n: 34,
    name: 'a design that never names the slug does not select the requirements document, whatever paths it touches: it carries no globs and is never always on, so only its id selects it',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [SPOKE] });
      return {
        registry: registry({ 'transfer-service': entry(a) }),
        hub: { ...HUB, 'docs/designs/TRF-7.lld.md': DESIGN({ paths: ['src/payments/charge.ts', 'src/accounts/open.ts', 'README.md'], contracts: [], traceability: 'Derives from: the brief § 2' }) },
        args: ['transfer-service', '--design', 'docs/designs/TRF-7.lld.md'],
      };
    },
    exit: 0,
    includes: ['Names: (none given)', 'Selected: 2 of 8: std-handbook, vendor-a-api'],
    excludes: ['Document: onboarding'],
  },
  {
    n: 35,
    name: 'a design that names the slug selects the requirements document, like any hub document, cited by its plain path',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [SPOKE] });
      return {
        registry: registry({ 'transfer-service': entry(a) }),
        hub: { ...HUB, 'docs/designs/TRF-7.lld.md': DESIGN({ paths: ['README.md'], contracts: [], traceability: 'Derives from: onboarding § 6, REQ-3' }) },
        args: ['transfer-service', '--design', 'docs/designs/TRF-7.lld.md'],
      };
    },
    exit: 0,
    includes: ['Names: onboarding', 'Selected: 2 of 8: std-handbook, onboarding', `Context: ${HANDBOOK_ENTRY}, ${pin('onboarding', REQ_PATH, REQ_DOC)}`, 'Document: onboarding\n', 'Cite: docs/requirements/onboarding/requirements.md'],
    excludes: ['Document: onboarding-20260730-0930-onboarding-brief'],
  },
  {
    // A design's Context: line names each document by its path, and the line
    // splits on ", " and on ":". A file whose name carries a space, a comma or a
    // colon cannot stand in it, so the set is malformed until it is renamed.
    n: 36,
    name: 'a hub document whose path carries a space is refused: the Context: line names documents by path',
    build: () => ({
      registry: registry({}),
      hub: withHub({
        'docs/requirements/onboarding/runs/20260730_0930/onboarding-brief.md': null,
        'docs/requirements/onboarding/runs/20260730_0930/onboarding brief.md': doc({ name: 'onboarding-20260730-0930-onboarding-brief', kind: 'requirements-source', description: 'The onboarding brief /feature was run on.' }),
      }),
      args: ['--hub', '--names', 'onboarding'],
    }),
    exit: 1,
    includes: ['docs/requirements/onboarding/runs/20260730_0930/onboarding brief.md: the path carries a space, a comma or a colon', 'rename the file'],
    excludes: ['Selected:', 'Document:'],
  },
  // Accepted is merged. On the open branch of an amendment, the document the
  // run is fixing reads proposed, rank 5, though its review approves its bytes.
  {
    n: 37,
    name: '--hub on an amendment\'s open branch: the re-reviewed document is proposed, rank 5, because the trunk carries the earlier bytes',
    build: () => ({ registry: registry({}), hub: HUB, args: ['--hub'], before: (hub) => amendOnBranch(hub) }),
    exit: 0,
    includes: ['- onboarding · requirements-document · hub · rank 5 · proposed · Onboarding: a new customer opens an account in one sitting'],
    excludes: ['accepted'],
  },
  {
    n: 38,
    name: '--hub --names <slug> on an amendment\'s open branch: opened with Rank 5 and Status proposed',
    build: () => ({ registry: registry({}), hub: HUB, args: ['--hub', '--names', 'onboarding'], before: (hub) => amendOnBranch(hub) }),
    exit: 0,
    includes: ['Kind: requirements-document · Rank: 5 · Owner: product owner · Revision: r1, 2026-07-30 · Status: proposed', 'Amended: the assumption on the opening deposit is corrected.'],
    excludes: ['Status: accepted'],
  },
  {
    n: 39,
    name: 'a design that touches a record\'s path selects the record without naming it',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [SPOKE] });
      return {
        registry: registry({ 'transfer-service': entry(a) }),
        hub: { ...HUB, 'docs/designs/TRF-7.lld.md': DESIGN({ paths: ['services/eligibility/score.ts'], contracts: [], traceability: 'Derives from: none' }) },
        args: ['transfer-service', '--design', 'docs/designs/TRF-7.lld.md'],
      };
    },
    exit: 0,
    includes: ['Names: (none given)', 'Selected: 2 of 8: std-handbook, ADR-004', 'Document: ADR-004', 'MUST NOT query the ledger tables'],
  },
  {
    n: 40,
    name: 'a superseded record binds no path: the same design selects only the handbook',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [SPOKE] });
      return {
        registry: registry({ 'transfer-service': entry(a) }),
        hub: withHub({ [ADR_PATH]: adr({ status: 'Superseded by ADR-009' }), 'docs/designs/TRF-7.lld.md': DESIGN({ paths: ['services/eligibility/score.ts'], contracts: [], traceability: 'Derives from: none' }) }),
        args: ['transfer-service', '--design', 'docs/designs/TRF-7.lld.md'],
      };
    },
    exit: 0,
    includes: ['Selected: 1 of 8: std-handbook'],
    excludes: ['Document: ADR-004'],
  },
  {
    n: 41,
    name: 'the index lists a superseded record unranked, with the record that replaced it',
    build: () => ({ registry: registry({}), hub: withHub({ [ADR_PATH]: adr({ status: 'Superseded by ADR-009' }) }), args: ['--hub'] }),
    exit: 0,
    includes: ['- ADR-004 · adr · hub · unranked · Superseded by ADR-009 · Serve eligibility from a read model, not the ledger'],
  },
  {
    n: 42,
    name: 'a superseded record a design names is still opened, with its status',
    build: () => ({ registry: registry({}), hub: withHub({ [ADR_PATH]: adr({ status: 'Superseded by ADR-009' }) }), args: ['--hub', '--names', 'ADR-004'] }),
    exit: 0,
    includes: ['Document: ADR-004', 'Kind: adr · Rank: unranked · Owner: lead architect · Revision: page version 7, 2026-08-20 · Status: Superseded by ADR-009'],
  },
  {
    n: 43,
    name: 'a deprecated record binds no path: its glob matches the design and it is not selected',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [SPOKE] });
      return {
        registry: registry({ 'transfer-service': entry(a) }),
        hub: withHub({ [ADR_PATH]: adr({ status: 'Deprecated' }), 'docs/designs/TRF-7.lld.md': DESIGN({ paths: ['services/eligibility/score.ts'], contracts: [], traceability: 'Derives from: none' }) }),
        args: ['transfer-service', '--design', 'docs/designs/TRF-7.lld.md'],
      };
    },
    exit: 0,
    includes: ['Selected: 1 of 8: std-handbook'],
    excludes: ['Document: ADR-004'],
  },
  {
    n: 44,
    name: 'a superseded record that is always on is not selected for a design that does not name it',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [SPOKE] });
      return {
        registry: registry({ 'transfer-service': entry(a) }),
        hub: withHub({ [ADR_PATH]: adr({ status: 'Superseded by ADR-009', alwaysApply: true }), 'docs/designs/TRF-7.lld.md': DESIGN({ paths: ['services/eligibility/score.ts'], contracts: [], traceability: 'Derives from: none' }) }),
        args: ['transfer-service', '--design', 'docs/designs/TRF-7.lld.md'],
      };
    },
    exit: 0,
    includes: ['Selected: 1 of 8: std-handbook'],
    excludes: ['Document: ADR-004'],
  },
  {
    n: 45,
    name: 'a superseded record that is always on is selected for a design that names it',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [SPOKE] });
      return {
        registry: registry({ 'transfer-service': entry(a) }),
        hub: withHub({ [ADR_PATH]: adr({ status: 'Superseded by ADR-009', alwaysApply: true }), 'docs/designs/TRF-7.lld.md': DESIGN({ paths: ['services/eligibility/score.ts'], contracts: [], traceability: 'Derives from: none' }) }),
        args: ['transfer-service', '--design', 'docs/designs/TRF-7.lld.md', '--names', 'ADR-004'],
      };
    },
    exit: 0,
    includes: ['Document: ADR-004', 'Status: Superseded by ADR-009'],
  },
  pinnedCase(46, '--pinned, hub entries current: each document at its pinned bytes, a Pin: current and a Cite: with the commit, no spoke asked', {
    context: `${HANDBOOK_ENTRY}, ${ADR_ENTRY}`,
    exit: 0,
    includes: ['Repository: transfer-service', `Design: ${DESIGN_PATH}`, 'Hub trunk: main at ', 'Commit: not asked', `Context: ${HANDBOOK_ENTRY}, ${ADR_ENTRY}`, 'Pinned: 2 document(s): 2 current, 0 drift', 'Document: std-handbook', 'Pin: current', 'Every service logs a correlation id.', 'Document: ADR-004', 'MUST read eligibility from the projection.'],
    excludes: ['drift:'],
    expect: (out) => (out.match(/Cite: hub@[0-9a-f]{12}:docs\/standards\/std-handbook\.md/) ? [] : ['the handbook has no Cite: hub@<12-hex>:<path> line']),
  }),
  pinnedCase(47, '--pinned, a hub entry moved on the trunk: the pinned bytes are printed, never the new ones, and the Pin: line names both hashes', {
    context: HANDBOOK_ENTRY,
    before: (hub) => hubCommit(hub, { [HANDBOOK_PATH]: HANDBOOK_V2 }),
    exit: 0,
    includes: ['Pinned: 1 document(s): 0 current, 1 drift', `Pin: drift: ${pinOf(HUB[HANDBOOK_PATH])} → ${pinOf(HANDBOOK_V2)}`, 'Every service logs a correlation id.'],
    excludes: ['Every service logs a trace id.'],
  }),
  pinnedCase(48, '--pinned, a hub entry removed on the trunk: still printed at its pin, and the Pin: line says removed', {
    context: HANDBOOK_ENTRY,
    before: (hub) => hubCommit(hub, { [HANDBOOK_PATH]: null }),
    exit: 0,
    includes: ['Pinned: 1 document(s): 0 current, 1 drift', `Pin: drift: ${pinOf(HUB[HANDBOOK_PATH])} → removed`, 'Every service logs a correlation id.'],
  }),
  pinnedCase(49, '--pinned, a spoke entry current: read on the spoke trunk, the hub not asked', {
    context: VENDOR_ENTRY,
    exit: 0,
    includes: ['Hub trunk: main at ', 'Pinned: 1 document(s): 1 current, 0 drift', 'Document: vendor-a-api', 'Pin: current', 'Confirm within 15 minutes'],
    expect: (out, a) => [`Commit: ${a.head}`, `Cite: transfer-service@${a.head.slice(0, 12)}:${VENDOR_PATH}`].filter((s) => !out.includes(s)).map((s) => `output does not contain: ${JSON.stringify(s)}`),
  }),
  pinnedCase(50, '--pinned, a spoke entry moved on the spoke trunk: the pinned bytes from the older commit, drift with both hashes', {
    context: VENDOR_ENTRY,
    before: (hub, env, a) => { a.later = advance(a, { [VENDOR_PATH]: VENDOR_V2 }); },
    exit: 0,
    includes: ['Pinned: 1 document(s): 0 current, 1 drift', `Pin: drift: ${pinOf(VENDOR_DOC)} → ${pinOf(VENDOR_V2)}`, 'Confirm within 15 minutes'],
    excludes: ['Confirm within 30 minutes'],
    expect: (out, a) => [`Commit: ${a.later}`, `Cite: transfer-service@${a.head.slice(0, 12)}:${VENDOR_PATH}`].filter((s) => !out.includes(s)).map((s) => `output does not contain: ${JSON.stringify(s)}`),
  }),
  pinnedCase(51, '--pinned, Context: none: nothing read, nothing fetched, exit 0', {
    context: 'none',
    exit: 0,
    includes: ['Context: none', 'Hub trunk: main at ', 'Commit: not asked', 'Pinned: 0 document(s): 0 current, 0 drift'],
    excludes: ['Document:'],
  }),
  pinnedCase(52, '--pinned, a pin found only on an unmerged branch: the Hub commit: line names a trunk commit that holds other bytes, exit 1', {
    context: pin('std-handbook', HANDBOOK_PATH, HANDBOOK_DRAFT),
    before: (hub) => hubCommit(hub, { [HANDBOOK_PATH]: HANDBOOK_DRAFT }, { push: false, branch: 'draft' }),
    exit: 1,
    includes: ['Status: NOT READ: 1 finding(s)', `pins ${pinOf(HANDBOOK_DRAFT)} for ${HANDBOOK_PATH}`, `the commit the design's Hub commit: line names, holds ${pinOf(HUB[HANDBOOK_PATH])} there; the two lines were not copied from one run`, 'amend the merged design by pull request with a human, with a fresh review'],
    excludes: ['Document:'],
  }),
  {
    n: 118,
    name: 'the header carries a Hub commit: line naming the hub checkout\'s HEAD, in a repository read and in --hub, so an artefact copies it beside Context:',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [SPOKE] });
      return {
        registry: registry({ 'transfer-service': entry(a) }),
        hub: HUB,
        args: ['transfer-service', '--names', 'ADR-004'],
        expect: (out) => {
          const head = git(join(root, 'hub'), ['rev-parse', 'HEAD']).trim();
          return out.includes(`Hub: 6 document(s)\nHub commit: ${head}\n`) ? [] : [`the header does not carry "Hub commit: ${head}" after the Hub: line`];
        },
      };
    },
    exit: 0,
    includes: ['Selected: 2 of 8: std-handbook, ADR-004'],
  },
  {
    n: 119,
    name: '--hub: the Hub commit: line is printed too, with no remote asked',
    build: () => ({
      registry: registry({}),
      hub: HUB,
      args: ['--hub', '--names', 'ADR-004'],
      expect: (out) => (out.match(/\nHub commit: [0-9a-f]{40}\n/) ? [] : ['no Hub commit: <40-hex> line in the header']),
    }),
    exit: 0,
    includes: ['Repository: hub', 'Commit: not asked'],
  },
  {
    n: 120,
    name: 'a selected hub document edited on disk and not committed: exit 1, named, because the Hub commit: line would name a commit that never held the pinned bytes',
    build: () => ({
      registry: registry({}),
      hub: HUB,
      args: ['--hub', '--names', 'ADR-004'],
      before: (hub) => writeFiles(hub, { [ADR_PATH]: HUB[ADR_PATH].replace('MUST read eligibility from the projection.', 'MUST read eligibility from the ledger.') }),
    }),
    exit: 1,
    includes: ['Status: NOT COMMITTED: 1 finding(s)', `FAIL: a selected hub document is not the bytes at HEAD, so no Hub commit: line can pin it`, `${ADR_PATH} on disk is `, 'commit the change or discard it, then run again'],
    excludes: ['Context: ', 'Document: ADR-004'],
  },
  {
    n: 121,
    name: 'a hub document edited on disk that the selection does not touch: no finding, because only a pinned document must be at HEAD',
    build: () => ({
      registry: registry({}),
      hub: HUB,
      args: ['--hub', '--names', 'std-sql-style'],
      before: (hub) => writeFiles(hub, { [ADR_PATH]: HUB[ADR_PATH].replace('MUST read eligibility from the projection.', 'MUST read eligibility from the ledger.') }),
    }),
    exit: 0,
    includes: ['Selected: 2 of 6: std-handbook, std-sql-style'],
    excludes: ['NOT COMMITTED'],
  },
  pinnedCase(113, '--pinned, a design with no Hub commit: line: exit 1, and the finding says which lines to copy', {
    context: () => `${DESIGN({ hubCommit: null })}Context: ${HANDBOOK_ENTRY}\n`,
    exit: 1,
    includes: ['Hub commit: not read', 'Status: NOT READ: 1 finding(s)', 'the design carries no Hub commit: line', 'copy the Hub commit: and Context: lines it prints'],
    excludes: ['Document:'],
  }),
  pinnedCase(114, '--pinned, a Hub commit: line that is not a full commit hash: exit 1', {
    context: () => `${DESIGN({ hubCommit: 'abcdef123456' })}Context: ${HANDBOOK_ENTRY}\n`,
    exit: 1,
    includes: ['Hub commit: abcdef123456', 'Status: NOT READ: 1 finding(s)', '"Hub commit: abcdef123456" is not a full 40-character commit hash'],
  }),
  pinnedCase(115, '--pinned, a Hub commit: the hub\'s trunk does not hold: exit 1, named', {
    context: () => `${DESIGN({ hubCommit: 'a'.repeat(40) })}Context: ${HANDBOOK_ENTRY}\n`,
    exit: 1,
    includes: ['Status: NOT READ: 1 finding(s)', `the design's Hub commit: line names ${'a'.repeat(12)}, and the hub's trunk (main) does not hold that commit`],
    excludes: ['Document:'],
  }),
  pinnedCase(116, '--pinned, two Hub commit: lines: exit 1, the line is not read', {
    context: () => `${DESIGN()}Hub commit: ${'b'.repeat(40)}\nContext: ${HANDBOOK_ENTRY}\n`,
    exit: 1,
    includes: ['Hub commit: not read', 'the design carries 2 Hub commit: lines'],
  }),
  pinnedCase(117, '--pinned, the Hub commit: line names the commit the hub entries were read at: the Cite: line carries that commit', {
    context: `${HANDBOOK_ENTRY}, ${ADR_ENTRY}`,
    exit: 0,
    includes: ['Pinned: 2 document(s): 2 current, 0 drift'],
    expect: (out) => {
      const line = out.split('\n').find((l) => l.startsWith('Hub commit: '));
      if (!line) return ['no Hub commit: line in the header'];
      const commit = line.slice('Hub commit: '.length);
      return out.includes(`Cite: hub@${commit.slice(0, 12)}:${HANDBOOK_PATH}`) ? [] : [`the handbook's Cite: does not name the Hub commit ${commit.slice(0, 12)}`];
    },
  }),
  pinnedCase(53, '--pinned, a bare-id entry: no pin to read at, exit 1', {
    context: 'std-handbook',
    exit: 1,
    includes: ['Status: NOT READ: 1 finding(s)', '"std-handbook" names a document by id alone', 'amend the merged design by pull request with a human, with a fresh review'],
  }),
  pinnedCase(54, '--pinned, an entry kept in another repository: exit 1', {
    context: pin('vendor-a-api', VENDOR_PATH, VENDOR_DOC, 'ledger-service'),
    exit: 1,
    includes: ['Status: NOT READ: 1 finding(s)', 'is kept in "ledger-service"; this design lands in "transfer-service"'],
  }),
  pinnedCase(55, '--pinned, two Context: lines: exit 1, the line is not read', {
    context: () => `${PINNED_DESIGN(HANDBOOK_ENTRY)}Context: none\n`,
    exit: 1,
    includes: ['Context: not read', 'carries 2 Context: lines'],
  }),
  pinnedCase(56, '--pinned, every finding listed in one run: a bare id and an entry kept elsewhere together', {
    context: `std-handbook, ${pin('vendor-a-api', VENDOR_PATH, VENDOR_DOC, 'ledger-service')}`,
    exit: 1,
    includes: ['Status: NOT READ: 2 finding(s)', 'names a document by id alone', 'is kept in "ledger-service"'],
  }),
  pinnedCase(57, '--pinned beside --at, --all and --hub: usage, every refused option named', {
    context: HANDBOOK_ENTRY,
    args: ['transfer-service', '--pinned', DESIGN_PATH, '--at', 'a'.repeat(40), '--all', '--hub'],
    exit: 3,
    includes: ['it takes no --at, --all, --hub'],
  }),
  pinnedCase(58, '--pinned naming a design that is not there: usage', {
    context: HANDBOOK_ENTRY,
    args: ['transfer-service', '--pinned', 'docs/designs/NOPE-1.lld.md'],
    exit: 3,
    includes: ['cannot read --pinned docs/designs/NOPE-1.lld.md'],
  }),
  pinnedCase(59, '--pinned with a HARNESS_TRUNK the hub origin does not report: cannot verify', {
    context: HANDBOOK_ENTRY,
    before: (hub, env) => { env.HARNESS_TRUNK = 'develop'; },
    exit: 2,
    includes: ['CANNOT VERIFY: HARNESS_TRUNK is "develop", and the hub\'s origin reports its default branch as "main"'],
  }),
  pinnedCase(60, '--pinned, a design with no Context: line: exit 1, the line is not read', {
    context: () => DESIGN(),
    exit: 1,
    includes: ['Context: not read', 'Status: NOT READ: 1 finding(s)', 'the design carries no Context: line'],
    excludes: ['Document:'],
  }),
  pinnedCase(61, '--pinned, an item in the line that is not an entry: exit 1, named', {
    context: `${HANDBOOK_ENTRY}, see the handbook`,
    exit: 1,
    includes: ['Status: NOT READ: 1 finding(s)', '"see the handbook" is not a context entry'],
    excludes: ['Document:'],
  }),
  pinnedCase(62, '--pinned, an id named twice: exit 1, named once', {
    context: `${HANDBOOK_ENTRY}, ${HANDBOOK_ENTRY}`,
    exit: 1,
    includes: ['Status: NOT READ: 1 finding(s)', '"std-handbook" named more than once'],
    excludes: ['Document:'],
  }),
  pinnedCase(63, '--pinned, a spoke pin no commit on the spoke trunk ever held: exit 1', {
    context: pin('vendor-a-api', VENDOR_PATH, VENDOR_V2, 'transfer-service'),
    exit: 1,
    includes: ['Status: NOT READ: 1 finding(s)', `pins ${pinOf(VENDOR_V2)} for ${VENDOR_PATH}`, "no commit on transfer-service's trunk ever held those bytes"],
    excludes: ['Document:'],
  }),
  pinnedCase(64, '--pinned, a Context: line inside a fenced block and one real line: reads as one line, exit 0', {
    // A four-backtick fence holding a three-backtick one: the inner fence lines
    // close nothing, so the example line stays inside, as a renderer shows it.
    context: () => `${DESIGN({ fenced: '````markdown\n```\nContext: none\n```\n````' })}Context: ${HANDBOOK_ENTRY}\n`,
    exit: 0,
    includes: [`Context: ${HANDBOOK_ENTRY}`, 'Pinned: 1 document(s): 1 current, 0 drift', 'Document: std-handbook'],
    excludes: ['Context: lines'],
  }),
  pinnedCase(65, '--pinned, Context:<TAB>none: the spacing the gate accepts, exit 0', {
    context: () => `${DESIGN()}Context:\tnone\n`,
    exit: 0,
    includes: ['Context: none', 'Pinned: 0 document(s): 0 current, 0 drift'],
  }),
  pinnedCase(66, '--pinned, a Context: line inside an HTML comment and one real line: reads as one line, exit 0', {
    context: () => `${DESIGN({ fenced: '<!--\nContext: none\n-->' })}Context: ${HANDBOOK_ENTRY}\n`,
    exit: 0,
    includes: [`Context: ${HANDBOOK_ENTRY}`, 'Pinned: 1 document(s): 1 current, 0 drift'],
    excludes: ['Context: lines'],
  }),  {
    n: 67,
    name: 'a design that cites one rule of a standard by its id, std-sql-style.01, selects that standard: the rule id carries the standard\'s',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [SPOKE] });
      return {
        registry: registry({ 'transfer-service': entry(a) }),
        hub: { ...HUB, 'docs/designs/TRF-7.lld.md': DESIGN({ traceability: 'Derives from: ADR-004 § Decision L17-17; queries follow std-sql-style.01' }) },
        args: ['transfer-service', '--design', 'docs/designs/TRF-7.lld.md'],
      };
    },
    exit: 0,
    includes: ['Names: ADR-004, std-sql-style, vendor-a-api', 'Document: std-sql-style', 'No SELECT *'],
  },  {
    n: 68,
    name: 'a Reserved standard is not selected by its globs: a .sql path does not bind it, and the index shows it Reserved',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [SPOKE] });
      return { registry: registry({ 'transfer-service': entry(a) }), hub: withHub({ 'docs/standards/std-sql-style.md': standard({ topic: 'sql-style', title: 'SQL style', rule: 'write keywords in upper case. No SELECT *.', description: 'How SQL is written across the estate.', globs: '["**/*.sql"]', status: 'Reserved', revision: '2026-03', origin: 'client data platform team' }) }), args: ['transfer-service', '--paths', 'migrations/0007_postings.sql'] };
    },
    exit: 0,
    includes: ['Selected: 1 of 8: std-handbook'],
    excludes: ['Document: std-sql-style', 'No SELECT *'],
  },
  {
    n: 69,
    name: 'a Reserved standard a design names is selected: held for later, read when asked for, its status printed',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [SPOKE] });
      return { registry: registry({ 'transfer-service': entry(a) }), hub: withHub({ 'docs/standards/std-sql-style.md': standard({ topic: 'sql-style', title: 'SQL style', rule: 'write keywords in upper case. No SELECT *.', description: 'How SQL is written across the estate.', globs: '["**/*.sql"]', status: 'Reserved', revision: '2026-03', origin: 'client data platform team' }) }), args: ['transfer-service', '--names', 'std-sql-style'] };
    },
    exit: 0,
    includes: ['Selected: 2 of 8: std-handbook, std-sql-style', 'Document: std-sql-style', 'Status: Reserved', 'No SELECT *'],
  },
  {
    n: 70,
    name: 'the index prints a Reserved standard with its status',
    build: () => ({ registry: registry({}), hub: withHub({ 'docs/standards/std-sql-style.md': standard({ topic: 'sql-style', title: 'SQL style', rule: 'write keywords in upper case. No SELECT *.', description: 'How SQL is written across the estate.', globs: '["**/*.sql"]', status: 'Reserved', revision: '2026-03', origin: 'client data platform team' }) }), args: ['--hub'] }),
    exit: 0,
    includes: ['- std-sql-style · standard · hub · unranked · Reserved · How SQL is written across the estate.'],
  },
  pinnedCase(71, '--pinned, an entry that names a standard by number, the form before std-<topic>: exit 1, and the finding says so', {
    context: 'STD-002@0123456789ab:docs/standards/STD-002-client-engineering-handbook.md',
    exit: 1,
    includes: ['Status: NOT READ: 1 finding(s)', '"STD-002" names a standard by number, the form before standards were named std-<topic>', 'amend the merged design by pull request with a human, with a fresh review'],
    excludes: ['is not a context entry'],
  }),
  {
    n: 72,
    name: 'a design whose prose says the topic of a standard, not its std- name, does not select it: only the prefixed name is the id',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [SPOKE] });
      return {
        registry: registry({ 'transfer-service': entry(a) }),
        hub: { ...HUB, 'docs/designs/TRF-7.lld.md': DESIGN({ traceability: 'Derives from: the brief § 2; the sql-style guide does not apply' }) },
        args: ['transfer-service', '--design', 'docs/designs/TRF-7.lld.md'],
      };
    },
    exit: 0,
    excludes: ['Document: std-sql-style', 'No SELECT *'],
  },
  {
    n: 73,
    name: "the index lists the hub's ADR-004 and the spoke's own ADR-004 apart: the spoke's id carries the spoke",
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [SPOKE_RECORDS] });
      return { registry: registry({ 'transfer-service': entry(a) }), hub: HUB, args: ['transfer-service'] };
    },
    exit: 0,
    includes: ['Spoke: 2 document(s) in contracts', 'Spoke records: 1 document(s) in decisions', '- ADR-004 · adr · hub · rank 3', '- transfer-service.ADR-004 · adr · transfer-service · rank 3 · Accepted · Retry a charge three times, then give up'],
  },
  {
    n: 74,
    name: "a design that names the spoke's record selects it, and not the hub's record with the same number",
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [SPOKE_RECORDS] });
      return {
        registry: registry({ 'transfer-service': entry(a) }),
        hub: { ...HUB, 'docs/designs/TRF-7.lld.md': DESIGN({ traceability: 'Derives from: transfer-service.ADR-004 § Decision' }) },
        args: ['transfer-service', '--design', 'docs/designs/TRF-7.lld.md'],
      };
    },
    exit: 0,
    includes: ['Names: vendor-a-api, transfer-service.ADR-004', 'Selected: 3 of 9: std-handbook, vendor-a-api, transfer-service.ADR-004', RECORD_ENTRY, 'Document: transfer-service.ADR-004', `Cite: transfer-service@`, `:${RECORD_PATH}`],
    excludes: ['Document: ADR-004\n', `${ADR_ENTRY}`],
  },
  {
    n: 75,
    name: 'a spoke without DECISIONS_INDEX says its records are NOT CONFIGURED, and never stops',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [SPOKE] });
      return { registry: registry({ 'transfer-service': entry(a) }), hub: HUB, args: ['transfer-service'] };
    },
    exit: 0,
    includes: ['Spoke records: NOT CONFIGURED (DECISIONS_INDEX missing or UNRESOLVED)'],
  },
  pinnedCase(76, "--pinned, the spoke's own record at its pinned bytes: read from the spoke, current", {
    context: RECORD_ENTRY,
    spoke: SPOKE_RECORDS,
    exit: 0,
    includes: [`Context: ${RECORD_ENTRY}`, 'Pinned: 1 document(s): 1 current, 0 drift', 'Document: transfer-service.ADR-004', 'Pin: current'],
  }),
  pinnedCase(77, "--pinned, a spoke's record placed in the hub, and the hub's record placed in the spoke: both refused, in one run", {
    context: `${pin('transfer-service.ADR-004', RECORD_PATH, RETRY_RECORD)}, ${pin('ADR-004', ADR_PATH, HUB[ADR_PATH], 'transfer-service')}`,
    exit: 1,
    includes: ['Status: NOT READ: 2 finding(s)', 'is a decision record of "transfer-service" and the entry places it in the hub', `places the hub's decision record ADR-004 in "transfer-service"`],
  }),
  globalCase(78, '--hub --global <commit>: the index carries the global layer first, every id prefixed global., each with its status', {
    args: (g) => ['--hub', '--global', g.head],
    expect: (out, g) => (out.includes(`Global: 5 document(s) at ${g.head}`) ? [] : ['the header does not say how many global documents were read, at which commit']),
    exit: 0,
    includes: [
      'Hub: 6 document(s)', 'Index: 10 document(s) in scope',
      '- global.ADR-004 · adr · global · rank 3 · Accepted · Log every eligibility decision for audit',
      '- global.ADR-012 · adr · global · rank 3 · Accepted · Use only Redis for caching',
      '- global.EXC-004 · exception · global · rank 3 · Active · The desktop simulator keeps an in-process cache instead of Redis, because it runs offline.',
      '- global.std-go · standard · global · unranked · Active · How Go is written in every product.',
      '- global.std-security · standard · global · unranked · always on · Active · The security baseline every product follows.',
      '- ADR-004 · adr · hub · rank 3 · Accepted · Serve eligibility from a read model, not the ledger',
    ],
    excludes: ['Document:', '_TEMPLATE', 'Context:'],
  }),
  globalCase(79, '--hub --global <commit> --names \'\': the always-on bodies of both layers, the global one first, its entry pinned to the global commit', {
    args: (g) => ['--hub', '--global', g.head, '--names', ''],
    expect: (out, g) => {
      const problems = [];
      const entry = globalPin('global.std-security', GLOBAL_SECURITY_PATH, g.head);
      if (!out.includes(`Context: ${entry}, ${HANDBOOK_ENTRY}\n`)) problems.push(`the Context: line is not "${entry}, ${HANDBOOK_ENTRY}"`);
      if (!out.includes(`Cite: global@${g.head.slice(0, 12)}:${GLOBAL_SECURITY_PATH}`)) problems.push('the global document has no Cite line with the short global commit');
      if (out.indexOf('Document: global.std-security') > out.indexOf('Document: std-handbook')) problems.push('the global document does not come before the hub one');
      return problems;
    },
    exit: 0,
    includes: ['Selected: 2 of 11: global.std-security, std-handbook', 'Document: global.std-security', 'Kind: standard · Rank: unranked · Owner: Global Architecture Board · Revision: v1 · Status: Active', 'encrypt every candidate record at rest', 'Document: std-handbook'],
    excludes: ['Document: global.ADR-012', 'Document: global.std-go', 'Document: global.EXC-004'],
  }),
  globalCase(80, '--hub --global <commit> --names global.<id>: an exception and the record it departs from, opened by id', {
    args: (g) => ['--hub', '--global', g.head, '--names', 'global.EXC-004,global.ADR-012'],
    expect: (out, g) => {
      const want = `Context: ${globalPin('global.std-security', GLOBAL_SECURITY_PATH, g.head)}, ${HANDBOOK_ENTRY}, ${globalPin('global.ADR-012', GLOBAL_ADR_PATH, g.head)}, ${globalPin('global.EXC-004', GLOBAL_EXC_PATH, g.head)}`;
      return out.includes(`${want}\n`) ? [] : [`the Context: line is not ${JSON.stringify(want)}`];
    },
    exit: 0,
    includes: ['Names: global.EXC-004, global.ADR-012', 'Selected: 4 of 11: global.std-security, std-handbook, global.ADR-012, global.EXC-004', 'Document: global.EXC-004', 'Kind: exception · Rank: 3 · Owner: desktop simulator tech lead · Revision: v1 · Status: Active', 'no Redis is reachable during a session', 'Document: global.ADR-012', '# ADR-012: Use only Redis for caching'],
    excludes: ['name: EXC-004', 'Document: ADR-004'],
  }),
  globalCase(81, '--global reads the commit asked for, not the global trunk head: a later record and a later edit are not seen', {
    args: (g) => ['--hub', '--global', g.head, '--names', 'global.ADR-012'],
    before: (hub, env, g) => {
      g.later = advance(g, { [GLOBAL_ADR_PATH]: adr({ n: '012', title: 'Use Redis or Valkey for caching', globs: '["**/cache/**"]' }), 'docs/architecture/ADR-013-queues.md': adr({ n: '013', title: 'Use one queue broker' }) });
    },
    expect: (out, g) => (out.includes(`Global: 5 document(s) at ${g.head}`) && g.later !== g.head ? [] : ['the read did not stay at the commit asked for']),
    exit: 0,
    includes: ['# ADR-012: Use only Redis for caching'],
    excludes: ['Valkey', 'global.ADR-013'],
  }),
  globalCase(82, 'a repository with --global and --paths: a global standard binds by its glob, beside the hub and spoke documents, always-on documents first, then global, hub, spoke', {
    spoke: true,
    args: (g) => ['transfer-service', '--global', g.head, '--paths', 'src/payments/charge.go'],
    exit: 0,
    includes: ['Spoke: 2 document(s) in contracts', 'Selected: 4 of 13: global.std-security, std-handbook, global.std-go, vendor-a-api', 'Document: global.std-go', 'wrap every returned error with its context'],
    excludes: ['Document: global.ADR-012', 'Document: global.EXC-004'],
  }),
  globalCase(83, 'a design that names global.ADR-004 selects the global record and not the hub\'s ADR-004 at the same path, and each body comes from its own layer', {
    hub: { 'docs/designs/TRF-7.lld.md': DESIGN({ paths: ['README.md'], contracts: [], traceability: 'Derives from: global.ADR-004 § Decision' }) },
    spoke: true,
    args: (g) => ['transfer-service', '--global', g.head, '--design', 'docs/designs/TRF-7.lld.md'],
    exit: 0,
    includes: ['Names: global.ADR-004', 'Selected: 3 of 13: global.std-security, std-handbook, global.ADR-004', 'Document: global.ADR-004', '# ADR-004: Log every eligibility decision for audit', `Cite: global@`],
    excludes: ['Document: ADR-004\n', 'Serve eligibility from a read model'],
  }),
  globalCase(84, '--global in a hub with no docs/estate/global.json: exit 2, the hub has no global layer to read', {
    link: false,
    args: (g) => ['--hub', '--global', g.head],
    exit: 2,
    includes: ['CANNOT VERIFY: --global names ', 'and the hub has no docs/estate/global.json, so it has no global layer to read', 'REASON: global-missing'],
    excludes: ['Index:'],
  }),
  globalCase(85, '--global that is not a full commit hash: a usage error', {
    args: (g) => ['--hub', '--global', g.head.slice(0, 12)],
    exit: 3,
    includes: ['--global must be the full 40-character commit hash the feature\'s Global: line records'],
  }),
  globalCase(86, 'the global repository does not answer: exit 2', {
    link: (root) => `${JSON.stringify({ schema_version: 1, url: join(root, 'no-such-global.git') })}\n`,
    args: (g) => ['--hub', '--global', g.head],
    exit: 2,
    includes: ['CANNOT VERIFY: cannot fetch ', 'no-such-global.git', 'REASON: fetch-failed'],
  }),
  globalCase(87, 'a malformed global exception and a global record in the wrong folder: the set is refused whole, every finding listed', {
    global: { ...GLOBAL, [GLOBAL_EXC_PATH]: EXCEPTION({ hubs: '["sim"]', repositories: '["global"]', departs: '["global.ADR-012"]', reason: '<why the product cannot follow the record>', status: 'Proposed', drop: ['review-by'] }), 'docs/exceptions/ADR-020-misplaced.md': adr({ n: '020' }) },
    args: (g) => ['--hub', '--global', g.head],
    exit: 1,
    includes: [
      'Status: NOT WELL FORMED',
      `${GLOBAL_EXC_PATH}: frontmatter is missing "review-by"`,
      `${GLOBAL_EXC_PATH}: hubs: "sim" is not a key prefix`,
      `${GLOBAL_EXC_PATH}: repositories: "global" is a reserved id`,
      `${GLOBAL_EXC_PATH}: departs: "global.ADR-012" is not a record or a standard rule. An exception departs from a global record, ADR-<NNN>, or from one rule of a global standard, std-<topic>.<NN>, by the id it carries in the global repository`,
      `${GLOBAL_EXC_PATH}: status "Proposed" is not one of Active, Withdrawn`,
      `${GLOBAL_EXC_PATH}: section "Reason" is empty or a placeholder`,
      'docs/exceptions/ADR-020-misplaced.md: kind "adr" does not live in this folder; this folder holds exception',
    ],
    excludes: ['Index:'],
  }),
  globalCase(88, '--names global.<id> without --global: the global layer is not in scope, a usage error that lists what is', {
    args: () => ['--hub', '--names', 'global.ADR-012'],
    exit: 3,
    includes: ['--names global.ADR-012: not a document in scope. In scope: ADR-004,'],
    excludes: ['Global:'],
  }),
  globalCase(89, '--global at a commit the global repository does not have: exit 2', {
    args: () => ['--hub', '--global', 'f'.repeat(40)],
    exit: 2,
    includes: ['CANNOT VERIFY: cannot fetch ffffffffffffffffffffffffffffffffffffffff from ', 'REASON: fetch-failed'],
  }),
  globalCase(90, 'a superseded global record and a withdrawn exception: both leave the index, the Index line says so, and the record that replaced it stays', {
    global: { ...GLOBAL, [GLOBAL_ADR_PATH]: adr({ n: '012', title: 'Use only Redis for caching', status: 'Superseded by ADR-013', globs: '["**/cache/**"]' }), 'docs/architecture/ADR-013-redis-or-valkey.md': adr({ n: '013', title: 'Use Redis or Valkey for caching', globs: '["**/cache/**"]' }), [GLOBAL_EXC_PATH]: EXCEPTION({ status: 'Withdrawn' }) },
    args: (g) => ['--hub', '--global', g.head],
    exit: 0,
    includes: ['Index: 9 document(s) in scope; pass --names or --all to select; 2 global document(s) that no longer bind left out, and --names global.<id> opens one; 1 requirements source(s) left out, and --sources <slug> lists those of one feature', '- global.ADR-013 · adr · global · rank 3 · Accepted'],
    excludes: ['- global.ADR-012 ·', '- global.EXC-004 ·'],
  }),
  globalCase(91, 'a hub document that says kind: exception: refused, an exception lives in the global repository', {
    hub: { 'docs/standards/std-cache.md': standard({ topic: 'cache', title: 'Cache', rule: 'use Redis.' }).replace('kind: standard', 'kind: exception') },
    args: () => ['--hub'],
    exit: 1,
    includes: ['docs/standards/std-cache.md: kind "exception" does not live in this folder; this folder holds standard and an exception lives in the global repository\'s docs/exceptions/'],
  }),
  pinnedGlobalCase(92, '--pinned, a global entry at the release the feature records: read at that commit, its Pin: line names the release, a later global commit not seen', {
    context: (g) => `${HANDBOOK_ENTRY}, ${globalPin('global.ADR-012', GLOBAL_ADR_PATH, g.head)}`,
    before: (hub, env, g) => advance(g, { [GLOBAL_ADR_PATH]: adr({ n: '012', title: 'Use Redis or Valkey for caching' }) }),
    expect: (out, g) => {
      const problems = [];
      if (!out.includes(`Global: v1.4.0 ${g.head}`)) problems.push('the header does not name the recorded release');
      if (!out.includes(`Pin: release v1.4.0 at ${g.head.slice(0, 12)}`)) problems.push('the global document has no Pin: line naming the release');
      if (!out.includes(`Cite: global@${g.head.slice(0, 12)}:${GLOBAL_ADR_PATH}`)) problems.push('the global document has no Cite: line with the global commit');
      return problems;
    },
    exit: 0,
    includes: ['Pinned: 2 document(s): 1 current, 0 drift, 1 at the global release', 'Document: global.ADR-012', '# ADR-012: Use only Redis for caching', 'Document: std-handbook'],
    excludes: ['Valkey', 'NOT READ'],
  }),
  pinnedCase(93, '--pinned beside --global: a usage error', {
    context: HANDBOOK_ENTRY,
    args: ['transfer-service', '--pinned', DESIGN_PATH, '--global', 'a'.repeat(40)],
    exit: 3,
    includes: ['it takes no --global'],
  }),
  pinnedCase(94, '--pinned, a global id outside the global form and the global form around a hub id: both refused, in one run', {
    context: `global.ADR-012@${'a'.repeat(12)}:${GLOBAL_ADR_PATH}, std-handbook@${'a'.repeat(12)}:global:${HANDBOOK_PATH}, global.std-go@${'a'.repeat(12)}:transfer-service:docs/standards/std-go.md`,
    exit: 1,
    includes: ['Status: NOT READ: 3 finding(s)', 'is a global document and the entry places it in the hub. A global entry is <id>@<12-hex>:global:<path>', 'is a global document and the entry places it in "transfer-service"', 'places std-handbook in the global layer, and a global document\'s id starts with "global."'],
  }),
  pinnedGlobalCase(95, '--pinned, a global entry that pins another commit than the feature records: exit 1, named', {
    context: () => globalPin('global.ADR-012', GLOBAL_ADR_PATH, 'a'.repeat(40)),
    exit: 1,
    includes: ['Status: NOT READ: 1 finding(s)', 'pins the global commit aaaaaaaaaaaa, and the feature records v1.4.0 at '],
  }),
  pinnedGlobalCase(96, '--pinned, a global entry whose requirements document records "Global: none": exit 1, no release to read', {
    context: (g) => globalPin('global.ADR-012', GLOBAL_ADR_PATH, g.head),
    global: () => 'none',
    exit: 1,
    includes: ['Status: NOT READ: 1 finding(s)', `the design carries a global entry, and ${PINNED_REQ_PATH} records "Global: none", so no global release can be read`],
  }),
  pinnedGlobalCase(97, '--pinned, a global entry and a global repository that does not answer: exit 2', {
    context: (g) => globalPin('global.ADR-012', GLOBAL_ADR_PATH, g.head),
    link: (root) => `${JSON.stringify({ schema_version: 1, url: join(root, 'no-such-global.git') })}\n`,
    exit: 2,
    includes: ['CANNOT VERIFY: cannot fetch ', 'no-such-global.git', 'REASON: fetch-failed'],
  }),
  globalCase(98, 'a superseded global record left out of the index: --names global.<id> still opens it, with its status', {
    global: { ...GLOBAL, [GLOBAL_ADR_PATH]: adr({ n: '012', title: 'Use only Redis for caching', status: 'Superseded by ADR-013', globs: '["**/cache/**"]' }), 'docs/architecture/ADR-013-redis-or-valkey.md': adr({ n: '013', title: 'Use Redis or Valkey for caching', globs: '["**/cache/**"]' }) },
    args: (g) => ['--hub', '--global', g.head, '--names', 'global.ADR-012'],
    exit: 0,
    includes: ['Names: global.ADR-012', 'Document: global.ADR-012', 'Status: Superseded by global.ADR-013', '# ADR-012: Use only Redis for caching'],
  }),
  {
    n: 99,
    name: "a hub record and a spoke's own record, each superseded by a global record: the index names the global record once, with no repository before it",
    build: (root) => {
      const files = withSpoke({ 'checks.env': `${CHECKS('contracts')}DECISIONS_INDEX=decisions\n`, [RECORD_PATH]: adr({ n: '004', title: 'Retry a charge three times, then give up', globs: '["src/refunds/**"]', status: 'Superseded by global.ADR-020' }) });
      const a = makeRemote(root, 'transfer-service', { commits: [files] });
      return { registry: registry({ 'transfer-service': entry(a) }), hub: withHub({ [ADR_PATH]: adr({ status: 'Superseded by global.ADR-012' }) }), args: ['transfer-service'] };
    },
    exit: 0,
    includes: ['- ADR-004 · adr · hub · unranked · Superseded by global.ADR-012 · ', '- transfer-service.ADR-004 · adr · transfer-service · unranked · Superseded by global.ADR-020 · Retry a charge three times, then give up'],
    excludes: ['transfer-service.global.', 'NOT WELL FORMED'],
  },
  globalCase(100, '--hub --global <commit> --names global.<id>: an exception\'s block prints its hubs, departs, repositories, status and review-by on one line between the Kind: and Cite: lines; a global record\'s block has no such line', {
    global: { ...GLOBAL, [GLOBAL_EXC_PATH]: EXCEPTION({ hubs: '["SIM", "OPS"]', repositories: '["sim-desktop", "sim-web"]', departs: '["ADR-012", "std-security.01"]' }) },
    args: (g) => ['--hub', '--global', g.head, '--names', 'global.EXC-004,global.ADR-012'],
    expect: (out, g) => {
      const block = [
        'Document: global.EXC-004',
        'Kind: exception · Rank: 3 · Owner: desktop simulator tech lead · Revision: v1 · Status: Active',
        'Hubs: SIM, OPS · Departs: global.ADR-012, global.std-security.01 · Repositories: sim-desktop, sim-web · Status: Active · Review-by: 2027-04-01',
        `Cite: global@${g.head.slice(0, 12)}:${GLOBAL_EXC_PATH}`,
        '# EXC-004 — the desktop simulator\'s offline cache',
      ].join('\n');
      const record = out.search(/^Document: global\.ADR-012\nKind: [^\n]*\nCite: /m) !== -1;
      return [...(out.includes(block) ? [] : [`the exception's block is not:\n${block}`]), ...(record ? [] : ['a global record\'s block carries more than its Kind: and Cite: lines'])];
    },
    exit: 0,
    excludes: ['name: EXC-004', 'hubs: ['],
  }),
  pinnedGlobalCase(101, '--pinned, a global exception: its block prints the same line of header fields between the Pin: and Cite: lines', {
    context: (g) => `${globalPin('global.ADR-012', GLOBAL_ADR_PATH, g.head)}, ${globalPin('global.EXC-004', GLOBAL_EXC_PATH, g.head)}`,
    expect: (out, g) => {
      const block = [
        'Document: global.EXC-004',
        `Pin: release v1.4.0 at ${g.head.slice(0, 12)}`,
        'Hubs: SIM · Departs: global.ADR-012 · Repositories: sim-desktop · Status: Active · Review-by: 2027-04-01',
        `Cite: global@${g.head.slice(0, 12)}:${GLOBAL_EXC_PATH}`,
      ].join('\n');
      const record = `Document: global.ADR-012\nPin: release v1.4.0 at ${g.head.slice(0, 12)}\nCite: `;
      return [...(out.includes(block) ? [] : [`the exception's block is not:\n${block}`]), ...(out.includes(record) ? [] : ['a global record\'s block carries more than its Pin: and Cite: lines'])];
    },
    exit: 0,
    includes: ['Pinned: 2 document(s): 0 current, 0 drift, 2 at the global release'],
    excludes: ['NOT READ'],
  }),

  // Overrides: a spoke rule's `overrides` key names the hub or global standards,
  // or single standard rules, it replaces where it binds.
  {
    n: 102,
    name: 'a spoke rule that binds a .sql path overrides std-sql-style.01: the standard prints an Overridden: line naming the rule, and the header counts it',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [RULED_SPOKE()] });
      return { registry: registry({ 'transfer-service': entry(a) }), hub: HUB, args: ['transfer-service', '--paths', 'db/schema.sql'] };
    },
    exit: 0,
    includes: ['Spoke rules: 2 rule(s) in docs/rules', 'Selected: 2 of 8: std-handbook, std-sql-style', 'Overrides: 1 from 1 standard(s)', 'Document: std-sql-style\nKind: standard · Rank: unranked · Owner: tech lead · Revision: 2026-03 · Status: Active\nOverridden: std-sql-style.01 by transfer-service:sql-house-style\nCite: docs/standards/std-sql-style.md'],
    excludes: ['Note:', 'Document: std-handbook\nKind: standard · Rank: unranked · Owner: tech lead · Revision: 2026 edition · Status: Active\nOverridden'],
  },
  {
    n: 103,
    name: 'the always-on spoke rule overrides the whole of std-handbook: the Overridden: line names the standard itself',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [RULED_SPOKE({ repositoryOverrides: '["std-handbook"]' })] });
      return { registry: registry({ 'transfer-service': entry(a) }), hub: HUB, args: ['transfer-service', '--paths', 'README.md'] };
    },
    exit: 0,
    includes: ['Overrides: 1 from 1 standard(s)', 'Document: std-handbook\nKind: standard · Rank: unranked · Owner: tech lead · Revision: 2026 edition · Status: Active\nOverridden: std-handbook by transfer-service:repository\n'],
  },
  {
    n: 104,
    name: 'a spoke rule that no path selects overrides nothing here: the standard it names prints no Overridden: line',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [RULED_SPOKE()] });
      return { registry: registry({ 'transfer-service': entry(a) }), hub: HUB, args: ['transfer-service', '--names', 'std-sql-style'] };
    },
    exit: 0,
    includes: ['Overrides: none', 'Document: std-sql-style'],
    excludes: ['Overridden:'],
  },
  {
    n: 105,
    name: 'an override of a rule the standard does not define is a finding: exit 1, the rules the standard does define listed',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [RULED_SPOKE({ sqlOverrides: '["std-sql-style.09"]' })] });
      return { registry: registry({ 'transfer-service': entry(a) }), hub: HUB, args: ['transfer-service', '--paths', 'db/schema.sql'] };
    },
    exit: 1,
    includes: ['Status: NOT WELL FORMED: 1 finding(s)', 'docs/rules/sql.md: overrides std-sql-style.09, and std-sql-style defines no such rule; its rules are std-sql-style.01'],
    excludes: ['Document:'],
  },
  {
    n: 106,
    name: 'an override of a standard that is not in scope here is a Note: and no finding: a spoke in two hubs may name a standard only one of them holds',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [RULED_SPOKE({ sqlOverrides: '["std-php-services.02"]' })] });
      return { registry: registry({ 'transfer-service': entry(a) }), hub: HUB, args: ['transfer-service', '--paths', 'db/schema.sql'] };
    },
    exit: 0,
    includes: ['Overrides: none', 'Note: transfer-service:sql-house-style overrides std-php-services.02, and no standard std-php-services is in scope here; the override has no effect in this hub', 'Document: std-sql-style'],
    excludes: ['Overridden:'],
  },
  {
    n: 107,
    name: 'a malformed rules folder is a finding in the context read too: it binds nobody, and its overrides cannot be read',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [RULED_SPOKE({ sqlOverrides: '["ADR-004"]' })] });
      return { registry: registry({ 'transfer-service': entry(a) }), hub: HUB, args: ['transfer-service'] };
    },
    exit: 1,
    includes: ['Status: NOT WELL FORMED: 1 finding(s)', 'the spoke\'s rules: docs/rules/sql.md: overrides entry "ADR-004" is not a standard'],
  },
  globalCase(108, 'a spoke rule overrides one rule of a global standard: with --global, the global standard prints the Overridden: line', {
    spoke: RULED_SPOKE({ repositoryOverrides: '["global.std-security.01"]' }),
    args: (g) => ['transfer-service', '--global', g.head, '--paths', 'README.md'],
    exit: 0,
    includes: ['Overrides: 1 from 1 standard(s)', 'Document: global.std-security\nKind: standard · Rank: unranked · Owner: Global Architecture Board · Revision: v1 · Status: Active\nOverridden: global.std-security.01 by transfer-service:repository\n'],
  }),
  pinnedCase(109, '--pinned, the design cites the spoke\'s rules at a commit: the rules are read there, and the pinned handbook prints the Overridden: line', {
    spoke: RULED_SPOKE({ repositoryOverrides: '["std-handbook.01"]' }),
    context: (a) => `${DESIGN({ rules: `transfer-service@${a.head.slice(0, 12)}:docs/rules` })}Context: ${HANDBOOK_ENTRY}\n`,
    exit: 0,
    includes: ['Rules: transfer-service@', 'Pinned: 1 document(s): 1 current, 0 drift', 'Overrides: 1 from 1 standard(s)', 'Document: std-handbook\nPin: current\nOverridden: std-handbook.01 by transfer-service:repository\nCite: hub@'],
    expect: (out, a) => (out.includes(`Commit: ${a.head}`) ? [] : ['the spoke was not read for its rules']),
  }),
  pinnedCase(110, '--pinned, the design cites a rules commit the spoke\'s trunk does not hold: exit 1', {
    spoke: RULED_SPOKE(),
    context: () => `${DESIGN({ rules: 'transfer-service@abcdefabcdef:docs/rules' })}Context: ${HANDBOOK_ENTRY}\n`,
    exit: 1,
    includes: ['Status: NOT READ: 1 finding(s)', 'the design\'s Rules: line cites abcdefabcdef, and transfer-service\'s trunk does not hold that commit'],
  }),
  pinnedCase(111, '--pinned, a design with no Rules: line: exit 1, because the rules cannot be read at a commit the design does not cite', {
    context: () => `${DESIGN().replace('Rules: none\n', '')}Context: ${HANDBOOK_ENTRY}\n`,
    exit: 1,
    includes: ['Rules: not read', 'Status: NOT READ: 1 finding(s)', 'the design carries no Rules: line'],
  }),
  pinnedCase(112, '--pinned, Rules: none: no spoke is asked for rules, and nothing is overridden', {
    context: HANDBOOK_ENTRY,
    exit: 0,
    includes: ['Rules: none', 'Commit: not asked', 'Overrides: none'],
    excludes: ['Overridden:'],
  }),
  {
    n: 122,
    name: 'a declared trunk: the spoke documents are read on the declared branch, not on the default branch',
    build: (root) => {
      // Only the declared branch carries the second wording of the vendor document.
      const a = makeRemote(root, 'transfer-service', {
        commits: [SPOKE],
        branch: { name: 'harness-main', commits: [{ 'checks.env': CHECKS('contracts', 'harness-main'), [VENDOR_PATH]: VENDOR_V2 }] },
      });
      return {
        registry: registry({ 'transfer-service': entry(a, 'checks.env', 'harness-main') }),
        hub: HUB,
        args: ['transfer-service', '--names', 'vendor-a-api'],
        expect: (out) => (out.includes(`Commit: ${a.branchHead}`) ? [] : [`header does not pin the declared trunk's head ${a.branchHead}`]),
      };
    },
    exit: 0,
    includes: ['Trunk: harness-main', 'Document: vendor-a-api', 'Confirm within 30 minutes'],
    excludes: ['Confirm within 15 minutes'],
  },
  pinnedCase(123, '--pinned, a spoke pin held only on the declared trunk: read there, current, not on the default branch', {
    context: pin('vendor-a-api', VENDOR_PATH, VENDOR_V2, 'transfer-service'),
    branch: { name: 'harness-main', commits: [{ 'checks.env': CHECKS('contracts', 'harness-main'), [VENDOR_PATH]: VENDOR_V2 }] },
    trunk: 'harness-main',
    exit: 0,
    includes: ['Pinned: 1 document(s): 1 current, 0 drift', 'Document: vendor-a-api', 'Pin: current', 'Confirm within 30 minutes'],
    expect: (out, a) => (out.includes(`Commit: ${a.branchHead}`) ? [] : [`header does not pin the declared trunk's head ${a.branchHead}`]),
  }),
  {
    n: 124,
    name: '--at with the 12-character prefix of the trunk head reads that commit and prints the full commit',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [SPOKE] });
      return {
        registry: registry({ 'transfer-service': entry(a) }),
        hub: HUB,
        args: ['transfer-service', '--all', '--at', a.head.slice(0, 12)],
        expect: (out) => (out.includes(`\nCommit: ${a.head}\n`) ? [] : ['header does not name the full commit']),
      };
    },
    exit: 0,
    includes: ['Trunk: not asked', 'Spoke: 2 document(s) in contracts', 'Selected: 8 of 8'],
  },
  {
    n: 125,
    name: '--at with the prefix of an older commit after a document was added reads the old documents, prints what the full commit prints, and the cache gets no filter',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [SPOKE] });
      const pinned = a.head;
      let full = null;
      return {
        registry: registry({ 'transfer-service': entry(a) }),
        hub: HUB,
        before: (hub, env) => {
          advance(a, { 'contracts/vendor-b.md': doc({ name: 'vendor-b-api', kind: 'vendor-doc' }) });
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
    includes: ['Spoke: 2 document(s) in contracts'],
    excludes: ['vendor-b-api'],
  },
  {
    n: 126,
    name: '--at with a prefix that matches no commit on the trunk is exit 2, and the message names the prefix',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [SPOKE] });
      return { registry: registry({ 'transfer-service': entry(a) }), hub: HUB, args: ['transfer-service', '--at', '0123456789ab'] };
    },
    exit: 2,
    includes: ['CANNOT VERIFY: --at 0123456789ab matches no commit', 'REASON: commit-not-found'],
  },
  ...[['13 characters', 'abcdef0123456'], ['upper case', 'ABCDEF012345']].map(([label, value], i) => ({
    n: 127 + i,
    name: `a --at value of ${label} is a usage error`,
    build: (root) => ({
      registry: registry({ 'transfer-service': { url: join(root, 'never-asked.git'), checks: 'checks.env', purpose: 'Never asked.', readAt: 'a'.repeat(40), trunk: 'default' } }),
      hub: HUB,
      args: ['transfer-service', '--at', value],
    }),
    exit: 3,
    includes: ['--at must be a full 40-character commit hash or its first 12 characters', value],
  })),
  // The requirements sources leave the default index. Only the /feature runs of
  // one feature and the requirements gate read a source, both by its path, so
  // the line is cost with no reader. --names, --all and --sources still reach one.
  {
    n: 129,
    name: '--hub, two features: the default index lists no requirements source',
    build: () => ({ registry: registry({}), hub: TWO_FEATURES, args: ['--hub'] }),
    exit: 0,
    includes: ['- onboarding · requirements-document · hub · rank 1 · accepted', '- payments · requirements-document · hub · rank 1 · accepted'],
    excludes: ['requirements-source ·', 'onboarding-20260730-0930-onboarding-brief', 'payments-20260901-1100-interview', 'Document:'],
  },
  {
    n: 130,
    name: '<repo-id>, two features: the default index lists no requirements source',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [SPOKE] });
      return { registry: registry({ 'transfer-service': entry(a) }), hub: TWO_FEATURES, args: ['transfer-service'] };
    },
    exit: 0,
    includes: ['- vendor-a-api · vendor-doc · transfer-service · rank 2', '- payments · requirements-document · hub · rank 1 · accepted'],
    excludes: ['requirements-source ·', 'onboarding-20260730-0930-onboarding-brief', 'payments-20260901-1100-interview'],
  },
  {
    n: 131,
    name: 'the Index: line says how many requirements sources it left out, and how to list them',
    build: () => ({ registry: registry({}), hub: TWO_FEATURES, args: ['--hub'] }),
    exit: 0,
    includes: ['Hub: 8 document(s)', 'Index: 6 document(s) in scope; pass --names or --all to select; 2 requirements source(s) left out, and --sources <slug> lists those of one feature'],
  },
  {
    n: 132,
    name: '--names <source id> still opens a requirements source, with its Cite: line',
    build: () => ({ registry: registry({}), hub: TWO_FEATURES, args: ['--hub', '--names', 'payments-20260901-1100-interview'] }),
    exit: 0,
    includes: ['Selected: 2 of 8: std-handbook, payments-20260901-1100-interview', 'Document: payments-20260901-1100-interview', 'Kind: requirements-source · Rank: 5', `Cite: ${PAYMENTS_INTERVIEW_PATH}`, `${pin('payments-20260901-1100-interview', PAYMENTS_INTERVIEW_PATH, TWO_FEATURES[PAYMENTS_INTERVIEW_PATH])}`],
  },
  {
    n: 133,
    name: '--all still prints every requirements source',
    build: () => ({ registry: registry({}), hub: TWO_FEATURES, args: ['--hub', '--all'] }),
    exit: 0,
    includes: ['Selected: 8 of 8', 'Document: onboarding-20260730-0930-onboarding-brief', 'Document: payments-20260901-1100-interview'],
  },
  {
    n: 134,
    name: 'a hub with no requirements source: the Index: line carries no note about sources',
    build: () => ({ registry: registry({}), hub: withHub({ 'docs/requirements/onboarding/runs/20260730_0930/onboarding-brief.md': null }), args: ['--hub'] }),
    exit: 0,
    includes: ['Hub: 5 document(s)', 'Index: 5 document(s) in scope; pass --names or --all to select\n'],
    excludes: ['requirements source(s) left out', '--sources'],
  },
  {
    n: 135,
    name: '--hub --sources <slug>: the index lines of that feature\'s sources, and of no other feature',
    build: () => ({ registry: registry({}), hub: TWO_FEATURES, args: ['--hub', '--sources', 'payments'] }),
    exit: 0,
    includes: ['Repository: hub', 'Index: 1 requirements source(s) of payments; pass --names <id> to open one', '- payments-20260901-1100-interview · requirements-source · hub · rank 5 · The interview record of the payments run.'],
    excludes: ['onboarding-20260730-0930-onboarding-brief', '- payments · requirements-document', '- ADR-004', 'Document:', 'Context:'],
  },
  {
    n: 136,
    name: '<repo-id> --sources <slug>: the same lines, and no spoke document',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [SPOKE] });
      return { registry: registry({ 'transfer-service': entry(a) }), hub: TWO_FEATURES, args: ['transfer-service', '--sources', 'onboarding'] };
    },
    exit: 0,
    includes: ['Repository: transfer-service', 'Index: 1 requirements source(s) of onboarding; pass --names <id> to open one', '- onboarding-20260730-0930-onboarding-brief · requirements-source · hub · rank 5'],
    excludes: ['payments-20260901-1100-interview', 'vendor-a-api', 'Document:'],
  },
  {
    n: 137,
    name: '--sources of a slug that names no feature is a usage error that lists the features',
    build: () => ({ registry: registry({}), hub: TWO_FEATURES, args: ['--hub', '--sources', 'refunds'] }),
    exit: 3,
    includes: ['--sources refunds: no feature in scope has that slug. Features: onboarding, payments'],
  },
  {
    n: 138,
    name: '--sources beside a selector is a usage error: it lists one feature\'s sources and selects nothing',
    build: () => ({ registry: registry({}), hub: TWO_FEATURES, args: ['--hub', '--sources', 'payments', '--names', 'ADR-004'] }),
    exit: 3,
    includes: ['--sources lists the sources of one feature and selects nothing; it takes no --names'],
  },
  pinnedCase(139, '--pinned beside --sources is a usage error', {
    context: HANDBOOK_ENTRY,
    args: ['transfer-service', '--pinned', DESIGN_PATH, '--sources', 'onboarding'],
    exit: 3,
    includes: ['--pinned reads the documents a design already names, at the bytes it pinned; it takes no --sources'],
  }),
];

/**
 * Check out requirements/onboarding in the published hub and commit the
 * document amended and a review approving the amended bytes on it, as /feature
 * leaves an amendment on its open pull request.
 */
function amendOnBranch(hub) {
  const amended = `${REQ_DOC}\nAmended: the assumption on the opening deposit is corrected.\n`;
  git(hub, ['checkout', '-q', '-b', 'requirements/onboarding']);
  writeFiles(hub, {
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
  const root = mkdtempSync(join(tmpdir(), `readctx-fx${String(fixture.n).padStart(2, '0')}-`));
  try {
    const hub = join(root, 'hub');
    mkdirSync(join(hub, 'docs', 'estate'), { recursive: true });
    const built = fixture.build(root);
    if (built.registry !== null) writeFileSync(join(hub, 'docs', 'estate', 'repositories.json'), built.registry);
    const deferred = Object.entries(built.hub || {}).filter(([, body]) => typeof body === 'string' && body.includes(HUB_COMMIT_TOKEN));
    if (built.hub) writeFiles(hub, Object.fromEntries(Object.entries(built.hub).filter(([rel]) => !deferred.some(([d]) => d === rel))));
    // The hub as a clone of its trunk: everything committed and pushed to a bare
    // origin, so refs/remotes/origin/main carries what the folder holds. A
    // requirements document is accepted only where that ref carries its bytes;
    // `trunk: false` leaves the hub a plain folder, with no trunk to read.
    if (built.trunk !== false) publishHub(root, hub);
    // A file that names the hub commit is committed on top of that trunk.
    if (deferred.length) {
      const head = built.trunk === false ? 'none' : git(hub, ['rev-parse', 'HEAD']).trim();
      const files = Object.fromEntries(deferred.map(([rel, body]) => [rel, body.replaceAll(HUB_COMMIT_TOKEN, head)]));
      if (built.trunk === false) writeFiles(hub, files);
      else hubCommit(hub, files);
    }
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
    ? `\n${failed} of ${selected.length} fixtures FAILED. The context read is not trustworthy until this is green.\n`
    : `\nAll ${selected.length} fixtures passed.\n`);
  rmSync(SANDBOX_HOME, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
}

main();

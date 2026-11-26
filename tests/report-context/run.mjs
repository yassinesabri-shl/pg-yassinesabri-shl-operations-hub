#!/usr/bin/env node
/**
 * run.mjs — the fixture suite for report-context.mjs.
 *
 *   usage:  node run.mjs            run every fixture
 *           node run.mjs 2 6        run only the numbered fixtures
 *           node run.mjs --keep     leave the throwaway repositories on disk
 *
 * A fixture is a REPOSITORY STATE: a throwaway hub on disk, published to a bare
 * origin so that refs/remotes/origin/main is the trunk, with one artefact that
 * carries a `Context:` line and a `Hub commit:` line. The shipped script is run
 * from the hub exactly as a person would run it, and the exit code and the
 * printed lines are asserted. Fixture 1 is the valid control. Most others change
 * one thing. The hub's documents land in the first commit, and an artefact that
 * carries the token `@HUB_COMMIT@` is committed on top with the token replaced by
 * that commit, as a hub writes an artefact after the documents it reads.
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
  process.env.HARNESS_REPORT_CONTEXT,
  resolve(HERE, '..', '..', 'report-context.mjs'),
  resolve(HERE, '..', '..', 'scripts', 'report-context.mjs'),
].filter(Boolean).find((p) => existsSync(p));

if (!SCRIPT) {
  console.error('cannot locate report-context.mjs. Set HARNESS_REPORT_CONTEXT=/path/to/report-context.mjs.');
  process.exit(4);
}

/* ------------------------------------------------------------------ git helpers */

const SANDBOX_HOME = mkdtempSync(join(tmpdir(), 'reportctx-home-'));
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

/* -------------------------------------------------------------- the content */

const doc = ({ name, kind, description = `The ${name} document.`, globs = '[]', alwaysApply = false, owner = 'tech lead', revision = 'v3.2, 2026-08-01', origin = 'client, by e-mail, 2026-08-01', body = `# ${name}\n\nHow to call it.\n`, status = null }) => {
  const lines = [
    `name: ${name}`, `description: ${description}`, `globs: ${globs}`, `alwaysApply: ${alwaysApply}`,
    `kind: ${kind}`, ...(status === null ? [] : [`status: ${status}`]), `owner: ${owner}`, `revision: ${revision}`, `origin: ${origin}`,
  ];
  return `---\n${lines.join('\n')}\n---\n\n${body}`;
};

// A hub standard in the template's shape: the nine sections in order, one rule.
const standard = ({ topic, title, rule, status = 'Active', ...header }) => doc({ name: `std-${topic}`, kind: 'standard', status, ...header, body: [
  `# std-${topic}: ${title}`, '',
  '## Applies to', '', 'Every change it names.', '',
  '## Must', '', `- **std-${topic}.01** MUST ${rule} *(Source: §1)*`, '',
  ...['Should', 'Values', 'Checked by', 'Relations', 'Exceptions', 'Unresolved'].flatMap((h) => [`## ${h}`, '', 'None.', '']),
  '## Origin', '', `${title}, as the client keeps it.`, '',
].join('\n') });

// A hub copy of a decision record: the shared header plus `status`, then the
// five sections an agent acts on.
const adr = ({ n = '004', title = 'Serve eligibility from a read model, not the ledger', status = 'Accepted' } = {}) => `---\n${[
  `name: ADR-${n}`, `description: ${title}`, 'globs: ["services/eligibility/**"]', 'alwaysApply: false', 'kind: adr', `status: ${status}`,
  'owner: lead architect', 'revision: page version 7, 2026-08-20', `origin: https://wiki.example.invalid/architecture/ADR-${n}`,
].join('\n')}\n---\n\n${[
  `# ADR-${n}: ${title}`, '',
  '## Decision', '', 'Eligibility is read from the read model.', '',
  '## Rules', '', '- MUST read eligibility from the projection.', '',
  '## Why', '', 'A read latency budget of 200ms at the 95th percentile.', '',
  '## Rejected', '', '- Not reading the ledger directly — because it misses the latency budget.', '',
  '## Accepted costs', '', '- Up to 2 seconds of delay on reads.', '',
].join('\n')}`;

// The requirements document /feature wrote and a person merged: the template's
// title and its control table, read by label.
const REQUIREMENTS = ({ slug = 'onboarding', title = 'Onboarding: a new customer opens an account in one sitting', revision = 'r1', date = '2026-07-30', owner = 'product owner', tail = '' } = {}) => [
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
  ...(tail === '' ? [] : [tail, '']),
  '## 2. Purpose and business outcome',
  '',
  'A new customer opens an account without leaving the flow.',
  '',
].join('\n');
const REQ_DOC = REQUIREMENTS();

// The git blob hash of a text, without git.
const blobHash = (text) => {
  const buf = Buffer.from(text, 'utf8');
  return createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');
};
const pinOf = (text) => blobHash(text).slice(0, 12);

const REVIEW = ({ slug = 'onboarding', of = REQ_DOC } = {}) => [
  `## Review: ${slug} — the requirements document against the brief`,
  '',
  '### VERDICT: APPROVED',
  'Cycle: 1 of 2',
  'Mode: feature-review',
  'Reviewer: pm-critic',
  `Document revision: ${blobHash(of)}`,
  '',
].join('\n');

const HANDBOOK_PATH = 'docs/standards/std-handbook.md';
const ADR_PATH = 'docs/architecture/ADR-004-eligibility-read-model.md';
const REQ_PATH = 'docs/requirements/onboarding/requirements.md';
const HUB = {
  'CLAUDE.md': '# Constitution\n',
  [ADR_PATH]: adr({}),
  [HANDBOOK_PATH]: standard({ topic: 'handbook', title: 'Client engineering handbook', rule: 'log the request in every service. Every service logs a correlation id.', description: 'The client handbook every design obeys.', alwaysApply: true, revision: '2026 edition', origin: 'client intranet, copied 2026-09-01' }),
  [REQ_PATH]: REQ_DOC,
  'docs/requirements/onboarding/requirements-review.md': REVIEW(),
  'docs/backlog/onboarding/TRF-7.item.md': '# TRF-7 — create a charge\n\nKey: TRF-7\nRepository: transfer-service\n',
};
const HANDBOOK_V2 = HUB[HANDBOOK_PATH].replace('Every service logs a correlation id.', 'Every service logs a trace id.');

// One `Context:` entry as read-context.mjs prints it.
const pin = (id, path, body, repository = null) => `${id}@${pinOf(body)}:${repository === null ? '' : `${repository}:`}${path}`;
const HANDBOOK_ENTRY = pin('std-handbook', HANDBOOK_PATH, HUB[HANDBOOK_PATH]);
const ADR_ENTRY = pin('ADR-004', ADR_PATH, HUB[ADR_PATH]);
const REQ_ENTRY = pin('onboarding', REQ_PATH, REQ_DOC);
const VENDOR_ENTRY = `vendor-a-api@${'c'.repeat(12)}:transfer-service:contracts/vendor-a/api.md`;
// A global entry pins the global commit, not a blob.
const GLOBAL_COMMIT = '858de9f490f8e06a5f829fe70f0af256e3a70c72';
const GLOBAL_ADR_PATH = 'docs/architecture/ADR-012-redis-only.md';
const globalPin = (id, path, commit = GLOBAL_COMMIT) => `${id}@${commit.slice(0, 12)}:global:${path}`;
const GLOBAL_ENTRY = globalPin('global.ADR-012', GLOBAL_ADR_PATH);

// An artefact that carries this token is committed after the hub is published,
// with the token replaced by the published trunk commit.
const HUB_COMMIT_TOKEN = '@HUB_COMMIT@';

const DESIGN_PATH = 'docs/designs/TRF-7.lld.md';
const DESIGN = ({ context = `${HANDBOOK_ENTRY}, ${ADR_ENTRY}`, hubCommit = HUB_COMMIT_TOKEN, key = 'TRF-7' } = {}) => [
  '# LLD — TRF-7: create a charge with Acme Pay',
  '',
  '## 1. Traceability',
  '',
  `Ticket: ${key}`,
  'Repository: transfer-service',
  'Rules: none',
  ...(context === null ? [] : [`Context: ${context}`]),
  ...[].concat(hubCommit === null ? [] : hubCommit).map((value) => `Hub commit: ${value}`),
  'Supersedes: none',
  '',
  '## 3. The design',
  '',
  'One paragraph.',
  '',
].join('\n');

const STORY_PATH = 'docs/backlog/onboarding/TRF-8.item.md';
const STORY = ({ context = ADR_ENTRY, hubCommit = HUB_COMMIT_TOKEN } = {}) => [
  '# TRF-8 — confirm a charge',
  '',
  'Key: TRF-8',
  'Repository: transfer-service',
  `Context: ${context}`,
  `Hub commit: ${hubCommit}`,
  '',
  '## Acceptance criteria',
  '',
  '- AC-1: the charge is confirmed.',
  '',
].join('\n');

const REQ2_SLUG = 'card-charges';
const REQ2_PATH = `docs/requirements/${REQ2_SLUG}/requirements.md`;
const REQ2 = ({ context = `${GLOBAL_ENTRY}, ${ADR_ENTRY}`, hubCommit = HUB_COMMIT_TOKEN, global = `v1.4.0 ${GLOBAL_COMMIT}` } = {}) => REQUIREMENTS({
  slug: REQ2_SLUG,
  title: 'Card charges',
  tail: [`Context: ${context}`, `Hub commit: ${hubCommit}`, `Global: ${global}`].join('\n'),
});

/** Move the hub on after the artefact was written: commit, and push unless told not to. */
function hubCommit(hub, files, { push = true, branch = null } = {}) {
  if (branch !== null) git(hub, ['checkout', '-q', '-b', branch]);
  for (const [rel, body] of Object.entries(files)) {
    if (body === null) git(hub, ['rm', '-q', rel]);
    else writeFiles(hub, { [rel]: body });
  }
  git(hub, ['add', '-A']);
  git(hub, ['commit', '-q', '-m', 'the trunk moves on']);
  if (push) git(hub, ['push', '-q', 'origin', 'HEAD']);
  return git(hub, ['rev-parse', 'HEAD']).trim();
}

const DATE = /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} [+-]\d{4}/;

/* ------------------------------------------------------------------- fixtures */

// `build(root)` returns { hub, args, before?, expect?, trunk?, cwd? }. `hub` is
// written into the throwaway hub before it is published. `before(hub, env)`
// runs after the publish and returns nothing, or a new cwd for the run.
// `expect(stdout, hub)` may return extra problems.
const FIXTURES = [
  {
    n: 1,
    name: 'valid control: a design with two hub entries at the trunk head; each is held at the hub commit, current on the trunk, and printed with its kind, revision and status',
    build: () => ({
      hub: { ...HUB, [DESIGN_PATH]: DESIGN() },
      args: [DESIGN_PATH],
      expect: (out, hub) => {
        const problems = [];
        const first = git(hub, ['rev-list', '--max-parents=0', 'HEAD']).trim();
        const head = git(hub, ['rev-parse', 'HEAD']).trim();
        if (!out.includes(`Trunk: refs/remotes/origin/main at ${head}`)) problems.push('the header does not name the trunk head');
        if (!out.includes(`Hub commit: ${first} (${first.slice(0, 12)}, `)) problems.push('the header does not name the hub commit with its short form');
        if (out.search(DATE) === -1) problems.push('no commit date printed');
        if (!out.includes(`Pin: ${pinOf(HUB[ADR_PATH])} · held at ${first.slice(0, 12)}`)) problems.push('the record is not shown held at the hub commit');
        return problems;
      },
    }),
    exit: 0,
    includes: [`Artefact: ${DESIGN_PATH}`, 'Kind: design', 'Context: 2 document(s): 2 current, 0 drift', 'Status: READ', 'Document: std-handbook', 'Layer: hub · Kind: standard · Revision: 2026 edition · Status: Active', `Path: ${HANDBOOK_PATH}`, 'Trunk: current', 'Document: ADR-004', 'Layer: hub · Kind: adr · Revision: page version 7, 2026-08-20 · Status: Accepted'],
    excludes: ['FAIL', 'CANNOT VERIFY', 'drift:'],
  },
  {
    n: 2,
    name: 'the trunk moved a document after the design read it: drift, with both pins, and still exit 0',
    build: () => ({
      hub: { ...HUB, [DESIGN_PATH]: DESIGN() },
      args: [DESIGN_PATH],
      before: (hub) => { hubCommit(hub, { [HANDBOOK_PATH]: HANDBOOK_V2 }); },
    }),
    exit: 0,
    includes: ['Context: 2 document(s): 1 current, 1 drift', `Trunk: drift: ${pinOf(HUB[HANDBOOK_PATH])} → ${pinOf(HANDBOOK_V2)}`, 'Status: READ'],
    excludes: ['FAIL'],
  },
  {
    n: 3,
    name: 'the trunk removed a document after the design read it: drift to removed, exit 0',
    build: () => ({
      hub: { ...HUB, [DESIGN_PATH]: DESIGN() },
      args: [DESIGN_PATH],
      before: (hub) => { hubCommit(hub, { [ADR_PATH]: null }); },
    }),
    exit: 0,
    includes: [`Trunk: drift: ${pinOf(HUB[ADR_PATH])} → removed`, 'Context: 2 document(s): 1 current, 1 drift'],
  },
  {
    n: 4,
    name: 'a story: the kind is read from its path, and its one entry is reported the same way',
    build: () => ({ hub: { ...HUB, [STORY_PATH]: STORY() }, args: [STORY_PATH] }),
    exit: 0,
    includes: [`Artefact: ${STORY_PATH}`, 'Kind: story', 'Document: ADR-004', 'Trunk: current', 'Context: 1 document(s): 1 current, 0 drift'],
  },
  {
    n: 5,
    name: 'a requirements document with a global entry: the release comes from its own Global: line, and the entry pins that commit',
    build: () => ({ hub: { ...HUB, [REQ2_PATH]: REQ2() }, args: [REQ2_PATH] }),
    exit: 0,
    includes: ['Kind: requirements document', `Global: v1.4.0 ${GLOBAL_COMMIT}`, 'Document: global.ADR-012', `Layer: global · Kind: adr · Release: v1.4.0 at ${GLOBAL_COMMIT.slice(0, 12)}`, `Path: ${GLOBAL_ADR_PATH}`, 'Trunk: at the global release; a global commit never drifts', 'Context: 2 document(s): 1 current, 0 drift, 1 at the global release'],
  },
  {
    n: 6,
    name: 'a global entry whose pin is not the commit on the Global: line: exit 1',
    build: () => ({ hub: { ...HUB, [REQ2_PATH]: REQ2({ context: `${globalPin('global.ADR-012', GLOBAL_ADR_PATH, 'b'.repeat(40))}, ${ADR_ENTRY}` }) }, args: [REQ2_PATH] }),
    exit: 1,
    includes: ['Status: FAIL: 1 finding(s)', `"global.ADR-012" pins ${'b'.repeat(12)}, and the Global: line records ${GLOBAL_COMMIT.slice(0, 12)}`],
  },
  {
    n: 7,
    name: 'a design with a global entry: the release is read from the requirements document of its work item\'s slug, on the trunk',
    build: () => ({
      hub: { ...HUB, [REQ_PATH]: `${REQ_DOC}\nGlobal: v1.4.0 ${GLOBAL_COMMIT}\n`, 'docs/requirements/onboarding/requirements-review.md': REVIEW({ of: `${REQ_DOC}\nGlobal: v1.4.0 ${GLOBAL_COMMIT}\n` }), [DESIGN_PATH]: DESIGN({ context: `${GLOBAL_ENTRY}, ${ADR_ENTRY}` }) },
      args: [DESIGN_PATH],
    }),
    exit: 0,
    includes: [`Global: v1.4.0 ${GLOBAL_COMMIT}`, 'Document: global.ADR-012', 'Release: v1.4.0'],
  },
  {
    n: 8,
    name: 'a design with a global entry and no work item on the trunk: the release cannot be read, exit 2',
    build: () => ({
      hub: { ...HUB, [DESIGN_PATH]: DESIGN({ context: `${GLOBAL_ENTRY}, ${ADR_ENTRY}`, key: 'TRF-99' }) },
      args: [DESIGN_PATH],
    }),
    exit: 2,
    includes: ['Status: CANNOT VERIFY', 'CANNOT VERIFY: the artefact carries a global entry, and 0 work items TRF-99.item.md are under docs/backlog/ on the hub\'s trunk'],
  },
  {
    n: 9,
    name: 'no Hub commit: line: exit 1, and the hub entries are reported without a holding commit',
    build: () => ({ hub: { ...HUB, [DESIGN_PATH]: DESIGN({ hubCommit: null }) }, args: [DESIGN_PATH] }),
    exit: 1,
    includes: ['Hub commit: not read', 'carries no Hub commit: line', 'Status: FAIL: 1 finding(s)', 'Document: ADR-004', 'Pin: ', 'not placed: no hub commit to read'],
  },
  {
    n: 10,
    name: 'a pin the hub commit does not hold: the two lines were not copied from one run, exit 1',
    build: () => ({ hub: { ...HUB, [DESIGN_PATH]: DESIGN({ context: `${pin('std-handbook', HANDBOOK_PATH, HANDBOOK_V2)}, ${ADR_ENTRY}` }) }, args: [DESIGN_PATH] }),
    exit: 1,
    includes: [`"std-handbook" pins ${pinOf(HANDBOOK_V2)} for ${HANDBOOK_PATH}, and the hub at`, `holds ${pinOf(HUB[HANDBOOK_PATH])} there`, 'Status: FAIL: 1 finding(s)'],
  },
  {
    n: 11,
    name: 'a Hub commit: on a branch nobody merged: the commit exists and is not on the trunk, exit 1',
    build: () => ({
      hub: { ...HUB, [DESIGN_PATH]: DESIGN() },
      args: [DESIGN_PATH],
      before: (hub) => {
        const off = hubCommit(hub, { 'docs/notes.md': 'off the trunk\n' }, { push: false, branch: 'draft' });
        writeFiles(hub, { [DESIGN_PATH]: DESIGN({ hubCommit: off }) });
      },
    }),
    exit: 1,
    includes: ['not on the trunk', 'names a commit that is not on refs/remotes/origin/main', 'Status: FAIL: 1 finding(s)'],
  },
  {
    n: 12,
    name: 'a Hub commit: the full clone does not hold at all: exit 1',
    build: () => ({ hub: { ...HUB, [DESIGN_PATH]: DESIGN({ hubCommit: 'a'.repeat(40) }) }, args: [DESIGN_PATH] }),
    exit: 1,
    includes: ['names a commit the hub does not hold', 'Status: FAIL: 1 finding(s)'],
  },
  {
    n: 13,
    name: 'a shallow clone that cannot see the hub commit: exit 2, never a guess',
    build: (root) => ({
      hub: { ...HUB, [DESIGN_PATH]: DESIGN() },
      args: [DESIGN_PATH],
      before: (hub) => {
        const shallow = join(root, 'shallow');
        // A clone of a plain path ignores --depth; a file:// URL honours it.
        git(root, ['clone', '-q', '--depth', '1', `file://${join(root, 'hub.git')}`, shallow]);
        return shallow;
      },
    }),
    exit: 2,
    includes: ['Status: CANNOT VERIFY', 'this clone is shallow', 'REASON: shallow-clone'],
  },
  {
    n: 14,
    name: 'Context: none with a Hub commit: line: nothing to place, exit 0',
    build: () => ({ hub: { ...HUB, [DESIGN_PATH]: DESIGN({ context: 'none' }) }, args: [DESIGN_PATH] }),
    exit: 0,
    includes: ['Context: none', 'Status: READ'],
    excludes: ['Document:'],
  },
  {
    n: 15,
    name: 'a Context: line of bare ids, the form before the pin and the path: exit 1',
    build: () => ({ hub: { ...HUB, [DESIGN_PATH]: DESIGN({ context: 'ADR-004, std-handbook' }) }, args: [DESIGN_PATH] }),
    exit: 1,
    includes: ['names a document by id alone', 'Status: FAIL'],
  },
  {
    n: 16,
    name: 'the hub is a plain folder with no trunk ref: exit 2',
    build: () => ({ hub: { ...HUB, [DESIGN_PATH]: DESIGN({ hubCommit: 'a'.repeat(40) }) }, args: [DESIGN_PATH], trunk: false }),
    exit: 2,
    includes: ['Status: CANNOT VERIFY', 'refs/remotes/origin/main cannot be read from the hub'],
  },
  {
    n: 17,
    name: 'usage: no artefact path',
    build: () => ({ hub: HUB, args: [] }),
    exit: 3,
    includes: ['usage: node'],
  },
  {
    n: 18,
    name: 'usage: a path that cannot be read',
    build: () => ({ hub: HUB, args: ['docs/designs/NOPE-1.lld.md'] }),
    exit: 3,
    includes: ['cannot read docs/designs/NOPE-1.lld.md'],
  },
  {
    n: 19,
    name: 'a spoke entry is reported by its form alone: the report reads one repository, the hub',
    build: () => ({ hub: { ...HUB, [DESIGN_PATH]: DESIGN({ context: `${HANDBOOK_ENTRY}, ${VENDOR_ENTRY}` }) }, args: [DESIGN_PATH] }),
    exit: 0,
    includes: ['Document: vendor-a-api', 'Layer: transfer-service · Kind: not read here', 'Path: contracts/vendor-a/api.md', `Pin: ${'c'.repeat(12)}`, 'Trunk: not read here; scripts/read-context.mjs transfer-service --pinned reads the spoke', 'Context: 2 document(s): 1 current, 0 drift, 1 in a spoke'],
  },
  {
    n: 20,
    name: 'two Hub commit: lines: exit 1',
    build: () => ({ hub: { ...HUB, [DESIGN_PATH]: DESIGN({ hubCommit: [HUB_COMMIT_TOKEN, HUB_COMMIT_TOKEN] }) }, args: [DESIGN_PATH] }),
    exit: 1,
    includes: ['carries 2 Hub commit: lines', 'Status: FAIL: 1 finding(s)'],
  },
  {
    n: 21,
    name: 'a requirements document on a design\'s line: its kind, revision and status are read from the pinned bytes',
    build: () => ({ hub: { ...HUB, [DESIGN_PATH]: DESIGN({ context: `${HANDBOOK_ENTRY}, ${REQ_ENTRY}` }) }, args: [DESIGN_PATH] }),
    exit: 0,
    includes: ['Document: onboarding', 'Layer: hub · Kind: requirements-document · Revision: r1, 2026-07-30 · Status: accepted', `Path: ${REQ_PATH}`],
  },
  {
    n: 22,
    name: 'a Hub commit: value that is not a full hash: exit 1',
    build: () => ({ hub: { ...HUB, [DESIGN_PATH]: DESIGN({ hubCommit: 'abcdef123456' }) }, args: [DESIGN_PATH] }),
    exit: 1,
    includes: ['is not a full 40-character commit hash', 'Status: FAIL: 1 finding(s)'],
  },
];

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
  const root = mkdtempSync(join(tmpdir(), `reportctx-fx${String(fixture.n).padStart(2, '0')}-`));
  try {
    const hub = join(root, 'hub');
    mkdirSync(hub, { recursive: true });
    const built = fixture.build(root);
    const deferred = Object.entries(built.hub).filter(([, body]) => body.includes(HUB_COMMIT_TOKEN));
    writeFiles(hub, Object.fromEntries(Object.entries(built.hub).filter(([rel]) => !deferred.some(([d]) => d === rel))));
    if (built.trunk !== false) publishHub(root, hub);
    if (deferred.length) {
      const head = built.trunk === false ? 'a'.repeat(40) : git(hub, ['rev-parse', 'HEAD']).trim();
      const files = Object.fromEntries(deferred.map(([rel, body]) => [rel, body.replaceAll(HUB_COMMIT_TOKEN, head)]));
      if (built.trunk === false) writeFiles(hub, files);
      else hubCommit(hub, files);
    }
    const env = { ...ENV };
    let cwd = hub;
    if (built.before) {
      const moved = built.before(hub, env);
      if (typeof moved === 'string') {
        cwd = moved;
        // The artefact travels with the run: a shallow clone holds the trunk
        // head, and the artefact on disk names a commit it cannot see.
        writeFiles(cwd, Object.fromEntries(Object.entries(built.hub).filter(([rel]) => built.args.includes(rel)).map(([rel]) => [rel, git(hub, ['show', `HEAD:${rel}`])])));
      }
    }
    const res = spawnSync(process.execPath, [SCRIPT, ...built.args], { cwd, env, encoding: 'utf8' });
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
    ? `\n${failed} of ${selected.length} fixtures FAILED. The context report is not trustworthy until this is green.\n`
    : `\nAll ${selected.length} fixtures passed.\n`);
  rmSync(SANDBOX_HOME, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
}

main();

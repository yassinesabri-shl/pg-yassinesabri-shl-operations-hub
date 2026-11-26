#!/usr/bin/env node
/**
 * run.mjs — the fixture suite for check-requirements.js.
 *
 *   usage:  node run.mjs            run every fixture
 *           node run.mjs 9 11       run only the numbered fixtures
 *           node run.mjs --keep     leave the throwaway repositories on disk
 *
 * A fixture here is a REPOSITORY STATE, as in the pickup gate's suite. Each case
 * builds a throwaway git repository with a real bare `origin`, commits a
 * requirements document and its review to the default branch, copies the
 * shipped check to `scripts/check-requirements.js`, runs it exactly as CI would,
 * and asserts the exit code and the messages. The check is never imported and
 * never stubbed: the file under test is the file that ships.
 *
 * One placeholder is substituted when the repository is built, because the
 * review names a hash that does not exist until the document's bytes are fixed:
 * `<DOCUMENT-REVISION>` becomes the blob hash of the document as written -- the
 * value `git hash-object` prints for it. A fixture that changes the document in
 * a later commit is NOT re-substituted: the review keeps naming the revision it
 * really read, which is the whole point of that case.
 *
 * `run.mjs` is the list. Every fixture carries its number, its name, the expected
 * exit code and a comment saying why it exists.
 *
 * The suite also covers check-requirements-candidate.mjs, the check's local
 * candidate mode: a fixture marked `candidate: true` checks out the branch it
 * names and runs that script instead, which builds a bare candidate trunk from
 * HEAD and runs the committed check inside a clone of it. And it covers
 * check-requirements-amend.mjs, the start check of an amendment on an open
 * pull request: a fixture marked `amend: true` runs that script, and `setup`
 * moves the checkout or the remote first. All three scripts are copied into
 * the throwaway repository's scripts/ folder, as they are installed.
 *
 * A fixture marked `global` also builds a real bare global context repository
 * beside the hub: three commits on its trunk `main`, one commit on a branch
 * beside it, and the tags the fixture names. Four more placeholders are then
 * substituted before the review is bound: `<GLOBAL-URL>` and `<GLOBAL-MISSING>`
 * (a path where no repository is), and `<GLOBAL-C1>` to `<GLOBAL-C3>` and
 * `<GLOBAL-SIDE>`, the commits, and `<GLOBAL-P1>` and `<GLOBAL-P2>`, the
 * first twelve characters of two of them: a global Context: entry's pin. The
 * second commit also carries the Board's documents, which fixtures 120 to 135
 * cite. A fixture marked `noGlobalRead` asserts that the check made no cache
 * for the global repository. Every fixture reads the global repository
 * through its own bare cache (HARNESS_SPOKE_CACHE), so no fixture reads
 * another's.
 *
 * The hub's context documents land in a first commit of their own, and the
 * placeholder `<HUB-COMMIT>` in a document's `Hub commit:` line becomes that
 * commit before the document lands, so the line names a commit that exists
 * before the document does, as it does in a hub.
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

// Resolved, not assumed, for the same reason the gate's suite resolves the gate:
// this suite runs in the library and in an installed hub, and in a hub the check
// may carry the .mjs extension. HARNESS_CHECK=/path overrides; so does argument 1.
const CHECK_CANDIDATES = [
  process.env.HARNESS_CHECK,
  process.argv[2] && !/^\d+$/.test(process.argv[2]) && !process.argv[2].startsWith('--') ? process.argv[2] : undefined,
  resolve(HERE, '..', '..', 'scripts', 'check-requirements.js'),
  resolve(HERE, '..', '..', 'scripts', 'check-requirements.mjs'),
  resolve(HERE, '..', '..', 'check-requirements.js'),
  resolve(HERE, '..', '..', 'check-requirements.mjs'),
].filter(Boolean);

const CHECK = CHECK_CANDIDATES.find((p) => existsSync(p));

if (!CHECK) {
  console.error('cannot locate the check script. Looked in order:');
  for (const c of CHECK_CANDIDATES) console.error('  ' + c);
  console.error('\nSet HARNESS_CHECK=/path/to/check-requirements.js or pass the path as argument 1.');
  process.exit(4);
}

// The candidate runner sits beside the check in both layouts and is .mjs in both.
// HARNESS_CANDIDATE=/path overrides.
const CANDIDATE_CANDIDATES = [
  process.env.HARNESS_CANDIDATE,
  resolve(HERE, '..', '..', 'scripts', 'check-requirements-candidate.mjs'),
  resolve(HERE, '..', '..', 'check-requirements-candidate.mjs'),
].filter(Boolean);

const CANDIDATE = CANDIDATE_CANDIDATES.find((p) => existsSync(p));

if (!CANDIDATE) {
  console.error('cannot locate the candidate runner. Looked in order:');
  for (const c of CANDIDATE_CANDIDATES) console.error('  ' + c);
  console.error('\nSet HARNESS_CANDIDATE=/path/to/check-requirements-candidate.mjs.');
  process.exit(4);
}

// The amendment start check sits beside them too, .mjs in both layouts.
// HARNESS_AMEND=/path overrides.
const AMEND_CANDIDATES = [
  process.env.HARNESS_AMEND,
  resolve(HERE, '..', '..', 'scripts', 'check-requirements-amend.mjs'),
  resolve(HERE, '..', '..', 'check-requirements-amend.mjs'),
].filter(Boolean);

const AMEND = AMEND_CANDIDATES.find((p) => existsSync(p));

if (!AMEND) {
  console.error('cannot locate the amendment start check. Looked in order:');
  for (const c of AMEND_CANDIDATES) console.error('  ' + c);
  console.error('\nSet HARNESS_AMEND=/path/to/check-requirements-amend.mjs.');
  process.exit(4);
}

const SLUG = 'step-up-authentication';
// One folder per slug: the document, its review, and below runs/ the interview
// record and copied briefs the gate never reads.
const DOC_PATH = `docs/requirements/${SLUG}/requirements.md`;
const REVIEW_PATH = `docs/requirements/${SLUG}/requirements-review.md`;
const SOURCE = 'transfer-brief.md';

// The hub's context documents every fixture carries on the trunk: one decision
// record and one standard, as /add-context files them. The valid document names
// both on its Context: line, pinned to these bytes, and uses both on the page.
const ADR_PATH = 'docs/architecture/ADR-007-step-up.md';
const ADR_BODY = [
  '---',
  'name: ADR-007',
  'description: A transfer above the step-up threshold is confirmed by a second factor on the same session.',
  'globs: []',
  'alwaysApply: false',
  'kind: adr',
  'status: Accepted',
  'owner: Security architect',
  'revision: 2026-08-01',
  'origin: the architecture register, record 7',
  '---',
  '',
  '# ADR-007: step-up on the same session',
  '',
].join('\n');
const STD_PATH = 'docs/standards/std-auth.md';
const STD_BODY = [
  '---',
  'name: std-auth',
  'description: How a service challenges and records a second factor.',
  'globs: []',
  'alwaysApply: false',
  'kind: standard',
  'status: Active',
  'owner: Security architect',
  'revision: v3',
  'origin: the security standards space, page 12',
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
// A second requirements document, a context document of its own kind.
const OTHER_SLUG = 'transfer-limits';
const OTHER_PATH = `docs/requirements/${OTHER_SLUG}/requirements.md`;
const OTHER_BODY = '# Requirements — transfer limits\n\nThe daily limit per account.\n';

// The hub's link to the global context repository, and the commits of that
// repository, substituted when a fixture's global repository is built.
const LINK_PATH = 'docs/estate/global.json';
const link = (url = '<GLOBAL-URL>', extra = {}) => `${JSON.stringify({ schema_version: 1, url, ...extra }, null, 2)}\n`;
const C1 = '<GLOBAL-C1>';
const C2 = '<GLOBAL-C2>';
const C3 = '<GLOBAL-C3>';
const SIDE = '<GLOBAL-SIDE>';
// Commits the amendment fixtures name. The start check reads git only, so they
// need no repository behind them.
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

/* ------------------------------------------------------------------ git helpers */

const SANDBOX_HOME = mkdtempSync(join(tmpdir(), 'requirements-home-'));
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

/* ---------------------------------------------------------------- the document */

// The hash git gives a blob with these bytes: what `git hash-object` prints.
function blobHash(content) {
  const body = Buffer.from(content, 'utf8');
  return createHash('sha1').update(`blob ${body.length}\0`).update(body).digest('hex');
}

const pin = (body) => blobHash(body).slice(0, 12);
const ADR_ENTRY = `ADR-007@${pin(ADR_BODY)}:${ADR_PATH}`;
const STD_ENTRY = `std-auth@${pin(STD_BODY)}:${STD_PATH}`;
const OTHER_ENTRY = `${OTHER_SLUG}@${pin(OTHER_BODY)}:${OTHER_PATH}`;
const CONTEXT = `${ADR_ENTRY}, ${STD_ENTRY}`;
// The same two documents always on: read-context.mjs adds each to every line,
// so a page owes neither a use. Only one in force is added: an Accepted record.
const ALWAYS_ADR_BODY = ADR_BODY.replace('alwaysApply: false', 'alwaysApply: true');
const ALWAYS_STD_BODY = STD_BODY.replace('alwaysApply: false', 'alwaysApply: true');
const DEPRECATED_ADR_BODY = ALWAYS_ADR_BODY.replace('status: Accepted', 'status: Deprecated');
// The sentence that uses both documents where a reader sees them.
const USES = 'The challenge runs on the same session, as ADR-007 decides, and its outcome is recorded under std-auth.01.';

const row = (cells) => `| ${cells.map((c) => String(c)).join(' | ')} |`;
const sep = (n) => `|${'---|'.repeat(n)}`;

// A table that no rule reads by name, for the fixtures of PLDC-686.
const NOTE_ROWS = [
  row(['Scope', 'Transfers above the threshold', 'the brief']),
  row(['Timing', 'The challenge runs before the posting', 'ADR-007']),
];
const notesTable = (rows) => ['## Notes', '', row(['Topic', 'Note', 'Source']), sep(3), ...rows].join('\n');

// Two requirements with criteria, in the shipped template's shape. Everything
// the check reads is here; everything else is the format's.
const REQ1 = [
  ['REQ-1.AC-1', 'A transfer above the step-up threshold is refused until a second factor is presented.', 'positive', `\`${SOURCE}\` § Authentication L18-19`],
  ['REQ-1.AC-2', 'A read-only advisory view is served on the existing session, with no challenge.', 'positive', `\`${SOURCE}\` § Authentication L24`],
  ['REQ-1.AC-3', 'A transfer whose second factor fails writes no transfer record.', 'negative', `\`${SOURCE}\` § Authentication L31`],
];
const REQ2 = [
  ['REQ-2.AC-1', 'The step-up threshold is the value the product owner records, in the account currency.', 'positive', `\`${SOURCE}\` § Thresholds L40-41`],
  ['REQ-2.AC-2', 'A threshold change applies to transfers initiated after the change and to no earlier transfer.', 'negative', `\`${SOURCE}\` § Thresholds L43`],
];

function requirement(id, title, cite, criteria, headerCells = ['ID', 'Criterion', 'Type', 'Source']) {
  const rows = criteria.map((e) => (typeof e === 'string' ? e : row(e)));
  return [
    `### ${id} — ${title}`,
    '',
    `Derives from: \`${SOURCE}\` § ${cite}`,
    '',
    `The behaviour, in the business's terms.`,
    '',
    row(headerCells),
    sep(headerCells.length),
    ...rows,
    '',
  ];
}

function document(overrides = {}) {
  const s = {
    slugRow: SLUG,
    locator: 'line ranges',
    rank: '1',
    requirements: null,
    req1: REQ1,
    req2: REQ2,
    appendix: null,
    // A string is one Context: line, an array is several, null is none.
    context: CONTEXT,
    // The same for the Global: line. null, the default, is no line.
    global: null,
    // The Hub commit: line. The default token becomes the trunk commit the hub's
    // documents landed on; a string is one line as given, an array several,
    // null is no line.
    hubCommit: HUB_COMMIT,
    uses: USES,
    ...overrides,
  };
  const requirements = s.requirements || [
    ...requirement('REQ-1', 'A high-value transfer demands a second factor', 'Authentication L18-31', s.req1),
    ...requirement('REQ-2', 'The step-up threshold is a recorded value', 'Thresholds L40-43', s.req2),
  ];
  return [
    '# Requirements — step-up authentication: a high-value transfer is confirmed by a second factor',
    '',
    '## 1. Document control',
    '',
    row(['Field', 'Value']),
    sep(2),
    row(['Document revision', 'r1']),
    row(['Date', '2026-09-12']),
    row(['Owning role', 'Product owner']),
    ...(s.slugRow === null ? [] : [row(['Slug', s.slugRow])]),
    row(['Source locator convention', s.locator]),
    row(['Review', '`requirements-review.md`, beside this document']),
    '',
    ...[].concat(s.context === null ? [] : s.context).flatMap((value) => [`Context: ${value}`, '']),
    ...[].concat(s.hubCommit === null ? [] : s.hubCommit).flatMap((value) => [`Hub commit: ${value}`, '']),
    ...[].concat(s.global === null ? [] : s.global).flatMap((value) => [`Global: ${value}`, '']),
    '**Sources this document is written from**, ranked before reading:',
    '',
    row(['Source (the copy in this repository)', 'Copied from', 'Revision', 'Rank', 'What it contributed']),
    sep(5),
    // A bare number in the Rank column is a value, not a placeholder. Every
    // fixture carries this row, so the rule is exercised on every run.
    row([`\`${SOURCE}\``, 'the product brief, held in the programme space', 'version 2, 2026-09-01', s.rank, 'Every requirement and both open questions']),
    '',
    '## 2. Purpose and business outcome',
    '',
    'A transfer above a threshold is confirmed by a second factor before it is recorded.',
    '',
    ...(s.uses ? [s.uses, ''] : []),
    '## 6. Requirements',
    '',
    ...requirements,
    '## 8. Coverage map',
    '',
    row(['Source part', 'Locator', 'Requirements', 'Disposition', 'Reason and owner']),
    sep(5),
    row(['Authentication', 'L18-31', 'REQ-1', 'Represented', 'Fully carried; no exclusion to own']),
    row(['Thresholds', 'L40-43', 'REQ-2', 'Represented', 'Fully carried; no exclusion to own']),
    row(['Reporting', 'L50-58', 'deliberately none', 'Out of scope', 'Served by the existing reporting pack; product owner']),
    '',
    '## 9. Clarifications',
    '',
    row(['ID', 'Question', 'Source', 'Blocking', 'Routed to', 'Status', 'Resolution', 'Resolved']),
    sep(8),
    row(['CLAR-PAY-stepup-01', 'Does the advisory view include a pending-transfer list?', `\`${SOURCE}\` § Authentication L24`, 'no', 'Product owner', 'Open', '', '']),
    '',
    ...(s.appendix ? [s.appendix, ''] : []),
  ].join('\n');
}

/* ------------------------------------------------------------------ the review */

const DOCUMENT_REVISION = '<DOCUMENT-REVISION>';
// Replaced, in every file of a fixture, by the trunk commit the hub's context
// documents landed on: the commit a document's Hub commit: line names.
const HUB_COMMIT = '<HUB-COMMIT>';

function review(overrides = {}) {
  const s = {
    heading: `## Review: ${SLUG} — the requirements document against the brief`,
    verdict: '### VERDICT: APPROVED',
    cycle: 'Cycle: 1 of 2',
    mode: 'Mode: feature-review',
    reviewer: 'Reviewer: pm-critic',
    revision: `Document revision: ${DOCUMENT_REVISION}`,
    findingPath: `${DOC_PATH}:30`,
    extra: [],
    after: [],
    eol: '\n',
    ...overrides,
  };
  return [
    s.heading,
    '',
    ...(s.verdict === null ? [] : [s.verdict]),
    s.cycle,
    ...(s.mode === null ? [] : [s.mode]),
    s.reviewer,
    ...(s.revision === null ? [] : [s.revision]),
    ...s.extra,
    '',
    '#### SUGGESTION',
    `- [${s.findingPath}] REQ-2.AC-2 could name the clock the change is timed against → cite the brief's L43 wording`,
    '',
    '### Acceptance-criterion coverage',
    '',
    row(['AC', 'Criterion (short)', 'Covered where', 'Covered']),
    sep(4),
    row(['Authentication', 'the second factor', 'REQ-1', 'YES']),
    row(['Thresholds', 'the recorded value', 'REQ-2', 'YES']),
    '',
    'Derived AC count: 2 · Derived covered: 2 · Author declared: 2 / 2 · Match: YES',
    '',
    '### Citation spot-check',
    '',
    'Sampled 3 of 7 citations (minimum 30%) · fabricated or drifted: 0 · NONE',
    ...s.after,
    '',
  ].join(s.eol);
}

/** One row with one cell changed. */
const withCell = (r, i, value) => r.map((c, j) => (j === i ? value : c));

const valid = () => ({ [DOC_PATH]: document(), [REVIEW_PATH]: review() });

/** A hub linked to the global repository, and a document with these overrides. */
const linked = (overrides = {}, url = undefined) => ({ [LINK_PATH]: link(url), [DOC_PATH]: document(overrides), [REVIEW_PATH]: review() });


/* ------------------------------------------------------------ the global layer */

// The global documents the second commit of a fixture's global repository
// carries (docs/proposals/global-context.md §8), and the entries that cite them.
// `<GLOBAL-P1>` and `<GLOBAL-P2>` are the first twelve characters of the first
// and second commits, the pin a global entry carries. This hub's key prefix is
// PAY, and its exceptions cover transfer-service.
const HUB_PREFIX = 'PAY';
const GLOBAL_REPO = 'transfer-service';
const P1 = '<GLOBAL-P1>';
const P2 = '<GLOBAL-P2>';
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
const gEntry = (id, path, pin = P2) => `${id}@${pin}:global:${path}`;
const G_ADR_ENTRY = gEntry('global.ADR-012', G_ADR_PATH);
const G_STD_ENTRY = gEntry('global.std-go', G_STD_PATH);
const gExcEntry = (n) => gEntry(`global.EXC-${n}`, G_EXC_PATH(n));
// The sentences that use them where a reader sees them.
const G_ADR_USE = 'Every cache is Redis, as global.ADR-012 decides.';
const G_STD_USE = 'Every returned error is wrapped, as global.std-go.01 requires.';
const gExcUse = (n) => `The session cache stays in process under global.EXC-${n}, which departs from global.ADR-012.`;

const KEYS_FILE = 'docs/backlog/keys.json';
const REGISTRY_FILE = 'docs/estate/repositories.json';
// A hub linked to the global repository, its key ledger and its list of
// repositories, and a document with these global entries after the control's
// two, these sentences after its own, and the Global: line `global`.
const globalDoc = (entries, uses = '', { global = `v1.4.0 ${C2}`, url = undefined, withLink = true } = {}) => ({
  ...(withLink ? { [LINK_PATH]: link(url) } : {}),
  [KEYS_FILE]: `${JSON.stringify({ schema_version: 1, prefix: HUB_PREFIX, next: 1, blocks: [] }, null, 2)}\n`,
  [REGISTRY_FILE]: `${JSON.stringify({ schema_version: 1, repositories: { [GLOBAL_REPO]: { url: 'https://example.invalid/transfer-service.git', checks: 'checks.env', purpose: 'Moves money between accounts.', readAt: 'a'.repeat(40) } } }, null, 2)}\n`,
  [DOC_PATH]: document({ context: [CONTEXT, ...[].concat(entries)].join(', '), uses: `${USES} ${uses}`.trim(), global }),
  [REVIEW_PATH]: review(),
});

/* ------------------------------------------------------------------- fixtures */

const FIXTURES = [
  {
    n: 1,
    name: 'complete document, approved review bound to its hash',
    files: valid(),
    exit: 0,
    includes: ['DOCUMENT COMPLETE: 5 of 5 checks passed', '2 requirement(s), 5 criteria: REQ-1, REQ-2'],
  },
  {
    // The document is read from the trunk, never from a branch. On a pull request
    // CI builds a candidate trunk from the pull request's content.
    n: 2,
    name: 'no document on the trunk (document exists only on a feature branch)',
    files: {},
    branch: { name: `requirements/${SLUG}`, files: valid() },
    exit: 1,
    includes: [`expected exactly one ${DOC_PATH} on origin/main, found 0`, 'skipped: no readable requirements document'],
    excludes: ['DOCUMENT COMPLETE'],
  },
  {
    // The whole point of the review file. Before this check the verdict lived in a
    // temp file, and a document with no review at all merged like any other.
    n: 3,
    name: 'no review beside the document',
    files: { [DOC_PATH]: document() },
    exit: 1,
    includes: [`expected exactly one ${REVIEW_PATH} on origin/main, found 0`],
  },
  {
    n: 4,
    name: 'the review says CHANGES REQUESTED',
    files: { [DOC_PATH]: document(), [REVIEW_PATH]: review({ verdict: '### VERDICT: CHANGES REQUESTED' }) },
    exit: 1,
    includes: ['verdict is "### VERDICT: CHANGES REQUESTED"; the check opens only on "### VERDICT: APPROVED"'],
  },
  {
    // Tokens are literal. A nuance appended to the token is a failure.
    n: 5,
    name: 'the review says "Approved with comments"',
    files: { [DOC_PATH]: document(), [REVIEW_PATH]: review({ verdict: '### VERDICT: APPROVED with comments' }) },
    exit: 1,
    includes: ['verdict is "### VERDICT: APPROVED with comments"'],
  },
  {
    n: 6,
    name: 'two verdict lines in the review',
    files: { [DOC_PATH]: document(), [REVIEW_PATH]: review({ extra: ['### VERDICT: APPROVED'] }) },
    exit: 1,
    includes: ['must contain exactly one verdict line, found 2'],
  },
  {
    // A verdict inside a code fence is a quotation of the grammar, not a verdict.
    n: 7,
    name: 'the only verdict is inside a code fence',
    files: { [DOC_PATH]: document(), [REVIEW_PATH]: review({ verdict: null, after: ['', '```', '### VERDICT: APPROVED', '```'] }) },
    exit: 1,
    includes: ['must contain exactly one verdict line, found 0'],
  },
  {
    n: 8,
    name: 'the review never names the slug',
    files: { [DOC_PATH]: document(), [REVIEW_PATH]: review({ heading: '## Review: payments-v2 — a different document', findingPath: 'docs/requirements/payments-v2/requirements.md:30' }) },
    exit: 1,
    includes: [`never names ${SLUG}; a review is evidence about one document`],
  },
  {
    // A review with no revision line applies to a filename, not to a document.
    n: 9,
    name: 'the review carries no Document revision line',
    files: { [DOC_PATH]: document(), [REVIEW_PATH]: review({ revision: null }) },
    exit: 1,
    includes: ['carries no "Document revision: <hash>" line', 'git hash-object docs/requirements/step-up-authentication/requirements.md'],
  },
  {
    // The binding, and the case that makes it matter: the document was amended
    // after the critic approved it. The review is now about an older document.
    n: 10,
    name: 'the document changed on the trunk after it was reviewed',
    files: valid(),
    thenChange: { [DOC_PATH]: document({ appendix: 'Amended after review: the threshold moved.' }) },
    exit: 1,
    includes: ['the document changed after it was reviewed, so the current document is unreviewed'],
  },
  {
    // An abbreviated hash is a prefix of the real one, as for the gate.
    n: 11,
    name: 'a seven-character revision prefix — must pass',
    files: { [DOC_PATH]: document(), [REVIEW_PATH]: review({ revision: `Document revision: ${DOCUMENT_REVISION}` }) },
    shortRevision: true,
    exit: 0,
    includes: ['DOCUMENT COMPLETE: 5 of 5 checks passed'],
  },
  {
    n: 12,
    name: 'two Document revision lines',
    files: { [DOC_PATH]: document(), [REVIEW_PATH]: review({ extra: [`Document revision: ${DOCUMENT_REVISION}`] }) },
    exit: 1,
    includes: ['carries 2 "Document revision:" lines'],
  },
  {
    // REQ-01 and REQ-1 are two names for one thing, and the design will cite one.
    n: 13,
    name: 'a requirement identifier with a leading zero',
    files: {
      [DOC_PATH]: document({ requirements: [
        ...requirement('REQ-01', 'A high-value transfer demands a second factor', 'Authentication L18-31', REQ1.map((r) => withCell(r, 0, r[0].replace('REQ-1.', 'REQ-01.')))),
      ] }),
      [REVIEW_PATH]: review(),
    },
    exit: 1,
    includes: ['has identifier "REQ-01", which does not match REQ-<n> with no leading zeros'],
  },
  {
    n: 14,
    name: 'a requirement defined twice',
    files: {
      [DOC_PATH]: document({ requirements: [
        ...requirement('REQ-1', 'A high-value transfer demands a second factor', 'Authentication L18-31', REQ1),
        ...requirement('REQ-1', 'The same number again', 'Thresholds L40-43', REQ2.map((r) => withCell(r, 0, r[0].replace('REQ-2.', 'REQ-1.').replace('AC-1', 'AC-4').replace('AC-2', 'AC-5')))),
      ] }),
      [REVIEW_PATH]: review(),
    },
    exit: 1,
    includes: ['requirement REQ-1 is defined twice'],
  },
  {
    // A requirement with no criteria cannot be accepted, and nothing downstream
    // can carry it.
    n: 15,
    name: 'a requirement with no criteria table',
    files: {
      [DOC_PATH]: document({ requirements: [
        ...requirement('REQ-1', 'A high-value transfer demands a second factor', 'Authentication L18-31', REQ1),
        '### REQ-2 — The step-up threshold is a recorded value',
        '',
        `Derives from: \`${SOURCE}\` § Thresholds L40-43`,
        '',
        'The behaviour, with no table under it.',
        '',
      ] }),
      [REVIEW_PATH]: review(),
    },
    exit: 1,
    includes: ['requirement REQ-2 (line', 'has no criteria table'],
  },
  {
    n: 16,
    name: 'a criteria table with a header and no rows',
    files: {
      [DOC_PATH]: document({ requirements: [
        ...requirement('REQ-1', 'A high-value transfer demands a second factor', 'Authentication L18-31', REQ1),
        ...requirement('REQ-2', 'The step-up threshold is a recorded value', 'Thresholds L40-43', []),
      ] }),
      [REVIEW_PATH]: review(),
    },
    exit: 1,
    includes: ['the criteria table of REQ-2 (line', 'has no rows; at least one criterion per requirement'],
  },
  {
    // The compound identifier is scoped to its requirement. A REQ-2 criterion
    // written under REQ-1 is filed under the wrong requirement.
    n: 17,
    name: 'a criterion scoped to another requirement',
    files: { [DOC_PATH]: document({ req1: [REQ1[0], withCell(REQ1[1], 0, 'REQ-2.AC-9'), REQ1[2]] }), [REVIEW_PATH]: review() },
    exit: 1,
    includes: ['criterion REQ-2.AC-9 (line', 'sits under REQ-1; a criterion is scoped to the requirement it is written under'],
  },
  {
    n: 18,
    name: 'a criterion defined twice',
    files: { [DOC_PATH]: document({ req1: [REQ1[0], REQ1[1], withCell(REQ1[2], 0, 'REQ-1.AC-1')] }), [REVIEW_PATH]: review() },
    exit: 1,
    includes: ['criterion REQ-1.AC-1 is defined twice'],
  },
  {
    n: 19,
    name: 'a criterion identifier with a leading zero',
    files: { [DOC_PATH]: document({ req1: [withCell(REQ1[0], 0, 'REQ-1.AC-01'), REQ1[1], REQ1[2]] }), [REVIEW_PATH]: review() },
    exit: 1,
    includes: ['has identifier "REQ-1.AC-01", which does not match REQ-<n>.AC-<m> with no leading zeros'],
  },
  {
    // The two columns the check reads are the two the identifier grammar pins;
    // the rest of the header is the format's.
    n: 20,
    name: 'a criteria table whose header does not begin "| ID | Criterion |"',
    files: {
      [DOC_PATH]: document({ requirements: [
        ...requirement('REQ-1', 'A high-value transfer demands a second factor', 'Authentication L18-31', REQ1, ['Ref', 'Statement', 'Type', 'Source']),
        ...requirement('REQ-2', 'The step-up threshold is a recorded value', 'Thresholds L40-43', REQ2),
      ] }),
      [REVIEW_PATH]: review(),
    },
    exit: 1,
    includes: ['the "REQ-1" table header (line', 'must begin "| ID | Criterion |"'],
  },
  {
    // A dash in a Source cell is a criterion nobody cited.
    n: 21,
    name: 'placeholder cells: a dash, a TBD and a question mark',
    files: { [DOC_PATH]: document({ req1: [withCell(REQ1[0], 3, '-'), withCell(REQ1[1], 1, 'TBD'), withCell(REQ1[2], 2, '?')] }), [REVIEW_PATH]: review() },
    exit: 1,
    includes: ['has "-" in the "Source" column', 'has "TBD" in the "Criterion" column', 'has "?" in the "Type" column'],
  },
  {
    // An unfilled authoring token is a template nobody finished.
    n: 22,
    name: 'an authoring token left in a cell',
    files: { [DOC_PATH]: document({ locator: '<how citations in this document resolve>' }), [REVIEW_PATH]: review() },
    exit: 1,
    includes: ['in the "Value" column; a placeholder cell is an unknown nobody marked'],
  },
  {
    // The template writes a fill-in token with a backslash, so a markdown viewer
    // shows it. The cell then starts with "\", not "<", and is still unfinished.
    n: 93,
    name: 'a backslashed fill-in token left as a whole cell',
    files: { [DOC_PATH]: document({ locator: '\\<line ranges, timestamps or named headings>' }), [REVIEW_PATH]: review() },
    exit: 1,
    includes: ['carries "\\<line ranges, timestamps or named headings>", the template\'s fill-in token, left in place'],
  },
  {
    n: 94,
    name: 'a backslashed fill-in token left in part of a cell',
    files: { [DOC_PATH]: document({ rank: 'r\\<n>' }), [REVIEW_PATH]: review() },
    exit: 1,
    includes: ['carries "\\<n>", the template\'s fill-in token, left in place'],
  },
  {
    // Outside every table too: a sentence of the template nobody wrote. Every
    // token on the line is named, so one run lists everything to replace.
    n: 95,
    name: 'two backslashed fill-in tokens left in prose',
    files: { [DOC_PATH]: document({ uses: `${USES} \\<Two to four sentences.> for \\<role>.` }), [REVIEW_PATH]: review() },
    exit: 1,
    includes: ['carries "\\<Two to four sentences.>", "\\<role>", the template\'s fill-in tokens, left in place'],
  },
  {
    // A token quoted in a code span is written about, not left.
    n: 96,
    name: 'a backslashed fill-in token inside a code span — must pass',
    files: { [DOC_PATH]: document({ locator: 'line ranges; the template writes a token as `\\<like this>`' }), [REVIEW_PATH]: review() },
    exit: 0,
    includes: ['DOCUMENT COMPLETE: 5 of 5 checks passed'],
  },
  {
    // A heading that begins REQ- with a malformed identifier is a requirement with
    // a bad name, not a paragraph: it is found, failed, and its table still read.
    n: 50,
    name: 'a requirement heading with a malformed identifier is failed, not dropped',
    files: {
      [DOC_PATH]: document({ requirements: [
        ...requirement('REQ-1', 'A high-value transfer demands a second factor', 'Authentication L18-31', REQ1),
        ...requirement('REQ-3a', 'A malformed identifier', 'Thresholds L40-43', REQ2.map((r) => withCell(r, 0, r[0].replace('REQ-2.', 'REQ-3a.')))),
      ] }),
      [REVIEW_PATH]: review(),
    },
    exit: 1,
    includes: ['has identifier "REQ-3a", which does not match REQ-<n>', 'has identifier "REQ-3a.AC-1", which does not match REQ-<n>.AC-<m>'],
  },
  {
    n: 51,
    name: 'a requirement heading with a trailing full stop',
    files: {
      [DOC_PATH]: document({ requirements: [
        ...requirement('REQ-1.', 'A high-value transfer demands a second factor', 'Authentication L18-31', REQ1),
        ...requirement('REQ-2', 'The step-up threshold is a recorded value', 'Thresholds L40-43', REQ2),
      ] }),
      [REVIEW_PATH]: review(),
    },
    exit: 1,
    includes: ['has identifier "REQ-1.", which does not match REQ-<n>'],
  },
  {
    // Any heading level. A format that puts requirements at level five is not
    // failed for it.
    n: 52,
    name: 'requirements headed at level five — must pass',
    files: {
      [DOC_PATH]: document({ requirements: [
        ...requirement('REQ-1', 'A high-value transfer demands a second factor', 'Authentication L18-31', REQ1).map((l) => l.replace(/^### /, '##### ')),
        ...requirement('REQ-2', 'The step-up threshold is a recorded value', 'Thresholds L40-43', REQ2).map((l) => l.replace(/^### /, '##### ')),
      ] }),
      [REVIEW_PATH]: review(),
    },
    exit: 0,
    includes: ['2 requirement(s), 5 criteria: REQ-1, REQ-2'],
  },
  {
    // A one-character cell that is not a digit is still a placeholder: "x" is
    // the cheapest tick there is.
    n: 49,
    name: 'a single letter in a cell is a placeholder',
    files: { [DOC_PATH]: document({ rank: 'x' }), [REVIEW_PATH]: review() },
    exit: 1,
    includes: ['has "x" in the "Rank" column'],
  },
  {
    // NONE standing alone is the one literal the schema calls for.
    n: 23,
    name: 'NONE standing alone in a cell — must pass',
    files: { [DOC_PATH]: document({ locator: 'NONE' }), [REVIEW_PATH]: review() },
    exit: 0,
    includes: ['DOCUMENT COMPLETE: 5 of 5 checks passed'],
  },
  {
    n: 24,
    name: '"none" in lower case is a placeholder',
    files: { [DOC_PATH]: document({ locator: 'none' }), [REVIEW_PATH]: review() },
    exit: 1,
    includes: ['has "none" in the "Value" column'],
  },
  {
    // A retired criterion keeps its number and reads DEPRECATED.
    n: 25,
    name: 'a DEPRECATED criterion keeps its row — must pass',
    files: { [DOC_PATH]: document({ req1: [REQ1[0], REQ1[1], withCell(REQ1[2], 1, 'DEPRECATED — folded into REQ-1.AC-1 on 2026-09-12')] }), [REVIEW_PATH]: review() },
    exit: 0,
    includes: ['DOCUMENT COMPLETE: 5 of 5 checks passed'],
  },
  {
    // A blank line inside the table ends it on the page; the rows below render as
    // pipes in a paragraph, and a criterion nobody can see is not a criterion.
    n: 26,
    name: 'a blank line inside a criteria table',
    files: { [DOC_PATH]: document({ req1: [REQ1[0], '', REQ1[1], REQ1[2]] }), [REVIEW_PATH]: review() },
    exit: 1,
    includes: ['carries a row identified "REQ-1.AC-2"', 'that is not in the table the check reads'],
  },
  {
    n: 27,
    name: 'hidden markup in the document',
    files: { [DOC_PATH]: document({ appendix: '<details><summary>Notes</summary>REQ-3 was dropped.</details>' }), [REVIEW_PATH]: review() },
    exit: 1,
    includes: ['carries HTML <details> markup'],
  },
  {
    n: 28,
    name: 'hidden markup in the review',
    files: { [DOC_PATH]: document(), [REVIEW_PATH]: review({ after: ['', '<details><summary>Working notes</summary>REQ-2 was not really read.</details>'] }) },
    exit: 1,
    includes: ['carries HTML <details> markup'],
  },
  {
    // A decomposition review filed as a requirements review is a review of
    // something else.
    n: 29,
    name: 'the review carries the wrong mode',
    files: { [DOC_PATH]: document(), [REVIEW_PATH]: review({ mode: 'Mode: decomposition-review' }) },
    exit: 1,
    includes: ['carries "Mode: decomposition-review"; a requirements review is written in "Mode: feature-review"'],
  },
  {
    n: 30,
    name: 'the review carries no mode line',
    files: { [DOC_PATH]: document(), [REVIEW_PATH]: review({ mode: null }) },
    exit: 1,
    includes: ['must carry exactly one "Mode: feature-review" line, found 0'],
  },
  {
    // The slug in the control table and the slug in the filename are one name.
    n: 31,
    name: 'the Slug row disagrees with the filename',
    files: { [DOC_PATH]: document({ slugRow: 'payments-onboarding' }), [REVIEW_PATH]: review() },
    exit: 1,
    includes: ['has "payments-onboarding" in the Slug cell; expected "| Slug | `step-up-authentication` |" and nothing else in the cell'],
  },
  {
    // The cell is read literally. A writer following "every statement cites its
    // source" appended a citation to the slug; the critic approved; the check
    // failed the pull request. The message has to name the exact cell expected,
    // because fixing one cell after approval unbinds the review's hash.
    n: 53,
    name: 'the Slug cell carries the slug and a trailing citation',
    files: { [DOC_PATH]: document({ slugRow: `\`${SLUG}\` (interview.md § note 3)` }), [REVIEW_PATH]: review() },
    exit: 1,
    includes: [
      `has "\`${SLUG}\` (interview.md § note 3)" in the Slug cell`,
      `expected "| Slug | \`${SLUG}\` |" and nothing else in the cell`,
      'belongs on the line under the table, not in a cell the check reads literally',
    ],
  },
  {
    // The slug in backticks, alone, is the form the template asks for.
    n: 54,
    name: 'the Slug cell holds the slug in backticks — must pass',
    files: { [DOC_PATH]: document({ slugRow: `\`${SLUG}\`` }), [REVIEW_PATH]: review() },
    exit: 0,
    includes: ['DOCUMENT COMPLETE: 5 of 5 checks passed'],
  },
  {
    // Fixture 2's repository state, run through the candidate mode: the document
    // exists only on the branch, the plain check reports the trunk and fails, and
    // the candidate runner builds the trunk as it would read after the merge.
    n: 55,
    name: 'candidate mode: a document only on the branch passes from the branch',
    files: {},
    branch: { name: `requirements/${SLUG}`, files: valid() },
    checkout: `requirements/${SLUG}`,
    candidate: true,
    exit: 0,
    includes: ['candidate trunk: main as it would read after requirements/step-up-authentication', 'running scripts/check-requirements.js in a clone of it', 'DOCUMENT COMPLETE: 5 of 5 checks passed'],
  },
  {
    // The same report and the same exit code: nothing about the candidate mode
    // is looser than the workflow. Here the branch's review says CHANGES REQUESTED.
    n: 56,
    name: 'candidate mode: a defect on the branch is the check\'s own finding and exit code',
    files: {},
    branch: { name: `requirements/${SLUG}`, files: { [DOC_PATH]: document(), [REVIEW_PATH]: review({ verdict: '### VERDICT: CHANGES REQUESTED' }) } },
    checkout: `requirements/${SLUG}`,
    candidate: true,
    exit: 1,
    includes: ['verdict is "### VERDICT: CHANGES REQUESTED"; the check opens only on "### VERDICT: APPROVED"', 'DOCUMENT INCOMPLETE'],
  },
  {
    // An uncommitted document is not what would merge. The runner names the file
    // and refuses rather than checking the committed bytes behind the edit.
    n: 57,
    name: 'candidate mode: uncommitted changes under docs/requirements are refused by name',
    files: {},
    branch: { name: `requirements/${SLUG}`, files: valid() },
    checkout: `requirements/${SLUG}`,
    dirty: { [DOC_PATH]: document({ appendix: 'Edited in the working tree, not committed.' }), [`docs/requirements/${SLUG}/runs/20260919_0900/notes.md`]: 'an untracked file\n' },
    candidate: true,
    exit: 2,
    includes: ['CANNOT VERIFY', `${DOC_PATH} (modified, not committed)`, `docs/requirements/${SLUG}/runs/20260919_0900/notes.md (untracked)`, 'an uncommitted document is not what would merge'],
    excludes: ['DOCUMENT COMPLETE', 'DOCUMENT INCOMPLETE'],
  },
  {
    // The refusal is scoped to the requirements folder: an uncommitted file
    // elsewhere in the hub does not stop the check.
    n: 58,
    name: 'candidate mode: an uncommitted file outside docs/requirements does not block — must pass',
    files: {},
    branch: { name: `requirements/${SLUG}`, files: valid() },
    checkout: `requirements/${SLUG}`,
    dirty: { 'src/notes.md': 'work in progress\n' },
    candidate: true,
    exit: 0,
    includes: ['DOCUMENT COMPLETE: 5 of 5 checks passed'],
  },
  {
    // The same usage vocabulary as the check, before any candidate is built.
    n: 59,
    name: 'candidate mode: usage error on a slug that is not kebab-case',
    files: valid(),
    key: 'Step_Up',
    candidate: true,
    exit: 3,
    includes: ['usage:'],
    excludes: ['candidate trunk:'],
  },
  {
    // An amendment on an open pull request (feature.md § Amending an open pull
    // request): r1 is merged, the branch carries the amended document and a fresh
    // review bound to the new bytes. The candidate check passes on the branch;
    // the trunk's r1 is untouched until a person merges.
    n: 60,
    name: 'candidate mode: an amended document on the branch, re-reviewed, passes from the branch',
    files: valid(),
    branch: {
      name: `requirements/${SLUG}`,
      files: {
        [DOC_PATH]: document({ appendix: 'Amended: the assumption on second-factor timeouts is corrected.' }),
        [REVIEW_PATH]: review(),
        [`docs/requirements/${SLUG}/runs/20261003_1415/interview.md`]: 'the amendment run record\n',
      },
    },
    checkout: `requirements/${SLUG}`,
    candidate: true,
    exit: 0,
    includes: ['candidate trunk: main as it would read after requirements/step-up-authentication', 'DOCUMENT COMPLETE: 5 of 5 checks passed'],
  },
  {
    // check-requirements-amend.mjs: the valid control. The branch is pushed, the
    // checkout is on it and in step, the document and review are committed, and
    // the branch is not on the trunk.
    n: 61,
    name: 'amend start: an open, unmerged requirements branch may be amended',
    files: {},
    branch: { name: `requirements/${SLUG}`, files: valid() },
    checkout: `requirements/${SLUG}`,
    amend: true,
    exit: 0,
    includes: ['[PASS] branch', '[PASS] working tree', '[PASS] in step with the remote', '[PASS] document and review', '[PASS] not merged', 'start commit:', `document:     ${DOC_PATH} @ `, 'AMENDMENT START OK'],
  },
  {
    // A revision after the merge whose own pull request is still open is
    // amended the same way: the rule is "the branch is not merged", not "the
    // document is not on the trunk".
    n: 62,
    name: 'amend start: an open revision of a merged document may be amended',
    files: valid(),
    branch: { name: `requirements/${SLUG}`, files: { [DOC_PATH]: document({ appendix: 'Revision r2.' }), [REVIEW_PATH]: review() } },
    checkout: `requirements/${SLUG}`,
    amend: true,
    exit: 0,
    includes: ['AMENDMENT START OK'],
  },
  {
    // Started from the trunk, the run is a first run or a revision after the
    // merge -- never an amendment.
    n: 63,
    name: 'amend start: refused on the trunk, naming the branch to check out',
    files: {},
    branch: { name: `requirements/${SLUG}`, files: valid() },
    amend: true,
    exit: 1,
    includes: ['[FAIL] branch', `the checkout is on "main"; an amendment starts on "requirements/${SLUG}"`, 'skipped: the checkout is not on "requirements/step-up-authentication"', 'AMENDMENT REFUSED: 3 of 5 rules failed'],
    excludes: ['AMENDMENT START OK', 'is behind'],
  },
  {
    // The run commits what it writes and nothing else, so it starts clean --
    // anywhere in the tree, not only under docs/requirements.
    n: 64,
    name: 'amend start: refused on a dirty working tree, naming each file',
    files: {},
    branch: { name: `requirements/${SLUG}`, files: valid() },
    checkout: `requirements/${SLUG}`,
    dirty: { [DOC_PATH]: document({ appendix: 'A hand edit.' }), 'src/notes.md': 'work in progress\n' },
    amend: true,
    exit: 1,
    includes: ['[FAIL] working tree', `${DOC_PATH} (not committed)`, 'src/notes.md (untracked)'],
    excludes: ['AMENDMENT START OK'],
  },
  {
    // Someone pushed to the pull request since this checkout was pulled. The
    // amendment must start from what the reviewer read.
    n: 65,
    name: 'amend start: refused when the checkout is behind the remote branch',
    files: {},
    branch: { name: `requirements/${SLUG}`, files: valid() },
    checkout: `requirements/${SLUG}`,
    setup: (work) => {
      writeFiles(work, { [`docs/requirements/${SLUG}/runs/20261003_0900/interview.md`]: 'pushed by someone else\n' });
      git(work, ['add', '-A']);
      git(work, ['commit', '-q', '-m', 'a later push']);
      git(work, ['push', '-q', 'origin', `requirements/${SLUG}`]);
      git(work, ['reset', '-q', '--hard', 'HEAD~1']);
    },
    amend: true,
    exit: 1,
    includes: ['[FAIL] in step with the remote', `is behind origin/requirements/${SLUG}`, 'Pull first'],
    excludes: ['AMENDMENT START OK'],
  },
  {
    // A local commit nobody has seen in the pull request.
    n: 66,
    name: 'amend start: refused when the checkout is ahead of the remote branch',
    files: {},
    branch: { name: `requirements/${SLUG}`, files: valid() },
    checkout: `requirements/${SLUG}`,
    setup: (work) => {
      writeFiles(work, { 'notes.md': 'a local commit\n' });
      git(work, ['add', '-A']);
      git(work, ['commit', '-q', '-m', 'not pushed']);
    },
    amend: true,
    exit: 1,
    includes: ['[FAIL] in step with the remote', `is ahead of origin/requirements/${SLUG}`, 'Push them, or drop them'],
    excludes: ['AMENDMENT START OK'],
  },
  {
    // The pull request was merged: the document is accepted, and a change now
    // is a revision after the merge, from the trunk.
    n: 67,
    name: 'amend start: refused when the branch is already merged into the trunk',
    files: {},
    branch: { name: `requirements/${SLUG}`, files: valid() },
    checkout: `requirements/${SLUG}`,
    setup: (work) => {
      git(work, ['push', '-q', 'origin', `requirements/${SLUG}:main`]);
    },
    amend: true,
    exit: 1,
    includes: ['[FAIL] not merged', 'the pull request was merged, and the document is accepted', 'revision after the merge'],
    excludes: ['AMENDMENT START OK'],
  },
  {
    // A branch with no review never finished its run; there is no approved
    // document to amend.
    n: 68,
    name: 'amend start: refused when the branch carries no review',
    files: {},
    branch: { name: `requirements/${SLUG}`, files: { [DOC_PATH]: document() } },
    checkout: `requirements/${SLUG}`,
    amend: true,
    exit: 1,
    includes: ['[FAIL] document and review', `HEAD carries no ${REVIEW_PATH}`],
    excludes: ['AMENDMENT START OK'],
  },
  {
    // Every rule runs before the exit: on an unpushed branch that is also dirty,
    // both findings are listed.
    n: 69,
    name: 'amend start: an unpushed, dirty branch lists every finding',
    files: {},
    setup: (work) => {
      git(work, ['checkout', '-q', '-b', `requirements/${SLUG}`]);
      writeFiles(work, bind(valid(), {}));
      git(work, ['add', '-A']);
      git(work, ['commit', '-q', '-m', 'never pushed']);
      writeFiles(work, { 'scratch.md': 'left over\n' });
    },
    amend: true,
    exit: 1,
    includes: ['[FAIL] working tree', `origin has no branch "requirements/${SLUG}", so no pull request can be open from it`, 'AMENDMENT REFUSED: 2 of 5 rules failed'],
  },
  {
    // The shared exit vocabulary: an unreachable remote is "cannot verify".
    n: 70,
    name: 'amend start: an unreachable remote is exit 2',
    files: {},
    branch: { name: `requirements/${SLUG}`, files: valid() },
    checkout: `requirements/${SLUG}`,
    breakRemote: true,
    amend: true,
    exit: 2,
    includes: ['CANNOT VERIFY: could not reach origin', 'REASON: remote-unreachable'],
    excludes: ['AMENDMENT START OK', 'AMENDMENT REFUSED'],
  },
  {
    // The trunk is confirmed against the remote, as the check confirms it.
    n: 71,
    name: 'amend start: HARNESS_TRUNK that is not the remote default is exit 2',
    files: {},
    branch: { name: `requirements/${SLUG}`, files: valid() },
    checkout: `requirements/${SLUG}`,
    env: { HARNESS_TRUNK: 'develop' },
    amend: true,
    exit: 2,
    includes: ['CANNOT VERIFY', 'the check was pointed at "develop" but origin\'s default branch is "main"', 'REASON: trunk-mismatch'],
  },
  {
    n: 72,
    name: 'amend start: usage error on a slug that is not kebab-case',
    files: valid(),
    key: 'Step_Up',
    amend: true,
    exit: 3,
    includes: ['usage:'],
    excludes: ['amendment start'],
  },
  {
    // The format is the organisation's. A document with no Slug row is not failed
    // for a row it never had.
    n: 32,
    name: 'no Slug row — must pass',
    files: { [DOC_PATH]: document({ slugRow: null }), [REVIEW_PATH]: review() },
    exit: 0,
    includes: ['DOCUMENT COMPLETE: 5 of 5 checks passed'],
  },
  {
    n: 33,
    name: 'usage error: the slug is not kebab-case',
    files: valid(),
    key: 'Step_Up',
    exit: 3,
    includes: ['usage:'],
    excludes: ['requirements check  ('],
  },
  {
    // The difference between "I do not know" and "I know, and the answer is no".
    n: 34,
    name: 'the remote is unreachable — cannot verify',
    files: valid(),
    breakRemote: true,
    exit: 2,
    includes: ['CANNOT VERIFY'],
  },
  {
    n: 35,
    name: 'HARNESS_TRUNK names a branch that is not the remote\'s default — cannot verify',
    files: valid(),
    env: { HARNESS_TRUNK: 'develop' },
    exit: 2,
    includes: ['CANNOT VERIFY'],
  },
  {
    // The binding is by blob hash, so no history is needed: a shallow clone has
    // every blob on the trunk and the check answers.
    // The Hub commit: line names a commit before the document's own, and a
    // clone of depth 1 cannot see it: the check refuses rather than guess, as
    // check-validation.js does for a hub commit it cannot see.
    n: 36,
    name: 'a shallow clone cannot see the Hub commit — cannot verify',
    files: valid(),
    shallow: true,
    exit: 2,
    includes: ['CANNOT VERIFY', 'names a commit this clone cannot see, and this clone is shallow', 'fetch full history (fetch-depth: 0)', 'REASON: shallow-clone'],
  },
  {
    n: 37,
    name: 'a document and a review with CRLF line endings — must pass',
    files: { [DOC_PATH]: document().split('\n').join('\r\n'), [REVIEW_PATH]: review({ eol: '\r\n' }) },
    exit: 0,
    includes: ['DOCUMENT COMPLETE: 5 of 5 checks passed'],
  },
  {
    // A byte-order mark is not content. Anchored patterns must not see it, and
    // the hash the review names is the hash of the bytes as committed.
    n: 38,
    name: 'a document and a review that both start with a byte-order mark — must pass',
    files: { [DOC_PATH]: `\uFEFF${document()}`, [REVIEW_PATH]: `\uFEFF${review()}` },
    exit: 0,
    includes: ['DOCUMENT COMPLETE: 5 of 5 checks passed'],
  },
  {
    n: 39,
    name: 'run from a subdirectory — must pass',
    files: { ...valid(), 'src/README.md': 'source\n' },
    from: 'src',
    exit: 0,
    includes: ['DOCUMENT COMPLETE: 5 of 5 checks passed'],
  },
  {
    n: 40,
    // The flat path the library filed the document under before the slug had a
    // folder. A half-moved slug is two documents, reported, not one read at random.
    name: 'two documents for one slug: the folder and the old flat path',
    files: { ...valid(), [`docs/requirements/${SLUG}.requirements.md`]: document() },
    exit: 1,
    includes: [`expected exactly one ${DOC_PATH} on origin/main, found 2`, `docs/requirements/${SLUG}.requirements.md`],
  },
  {
    n: 41,
    name: 'the document is a symbolic link',
    files: { [REVIEW_PATH]: review(), [`docs/requirements/${SLUG}/other.md`]: document() },
    symlinks: { [DOC_PATH]: 'other.md' },
    exit: 1,
    includes: ['is a symbolic link on origin/main, not a requirements document'],
  },
  {
    n: 42,
    name: 'an empty document',
    files: { [DOC_PATH]: '\n', [REVIEW_PATH]: review() },
    exit: 1,
    includes: ['is empty on origin/main; an empty file is not a requirements document'],
  },
  {
    // A REQ heading quoted inside a fence is an example, not a requirement.
    n: 43,
    name: 'a requirement heading inside a code fence is not a requirement — must pass',
    files: { [DOC_PATH]: document({ appendix: ['```', '### REQ-9 — an example of the heading form', '```'].join('\n') }), [REVIEW_PATH]: review() },
    exit: 0,
    includes: ['2 requirement(s), 5 criteria: REQ-1, REQ-2'],
  },
  {
    n: 44,
    name: 'a document with no requirement heading at all',
    files: { [DOC_PATH]: document({ requirements: ['Two paragraphs of intent and no identifiers.', ''] }), [REVIEW_PATH]: review() },
    exit: 1,
    includes: ['no requirement heading in the document'],
  },
  {
    // A row with the wrong number of cells is recorded, and the requirement is
    // still collected: one defect, reported once.
    n: 45,
    name: 'a malformed criterion row',
    files: { [DOC_PATH]: document({ req1: [REQ1[0], '| REQ-1.AC-2 | only two cells |', REQ1[2]] }), [REVIEW_PATH]: review() },
    exit: 1,
    includes: ['criterion row under REQ-1 (line', 'is malformed: expected 4 cells, found 2'],
    excludes: ['defines no REQ-<n>.AC-<m> row'],
  },
  {
    // The heading may sit at any level from ## to ####. An organisation's format
    // that nests requirements one level deeper is not failed for it.
    n: 46,
    name: 'requirements headed at level four — must pass',
    files: {
      [DOC_PATH]: document({ requirements: [
        ...requirement('REQ-1', 'A high-value transfer demands a second factor', 'Authentication L18-31', REQ1).map((l) => l.replace(/^### /, '#### ')),
        ...requirement('REQ-2', 'The step-up threshold is a recorded value', 'Thresholds L40-43', REQ2).map((l) => l.replace(/^### /, '#### ')),
      ] }),
      [REVIEW_PATH]: review(),
    },
    exit: 0,
    includes: ['2 requirement(s), 5 criteria: REQ-1, REQ-2'],
  },
  {
    // A criterion row outside the table -- after a paragraph -- is on the page as
    // text, not as a criterion, and the check says which row it lost.
    n: 47,
    name: 'a criterion row after a paragraph, outside the table',
    files: { [DOC_PATH]: document({ req1: [REQ1[0], REQ1[1], '', 'A note between the rows.', '', REQ1[2]] }), [REVIEW_PATH]: review() },
    exit: 1,
    includes: ['carries a row identified "REQ-1.AC-3"', 'that is not in the table the check reads'],
  },
  {
    // The verdict inside an HTML comment is not on the page, in either direction.
    n: 48,
    name: 'a second verdict inside an HTML comment does not count — must pass',
    files: { [DOC_PATH]: document(), [REVIEW_PATH]: review({ after: ['', '<!-- earlier round: ### VERDICT: CHANGES REQUESTED -->'] }) },
    exit: 0,
    includes: ['DOCUMENT COMPLETE: 5 of 5 checks passed'],
  },

  /* ---------------------------------------------------- context documents */

  {
    // Without the line, a document that read nothing looks like one that read
    // everything, and nobody downstream can tell which decisions shaped it.
    n: 73,
    name: 'no Context: line',
    files: { [DOC_PATH]: document({ context: null, uses: null }), [REVIEW_PATH]: review() },
    exit: 1,
    includes: ['never says which context documents it was written against', 'as scripts/read-context.mjs --hub prints it'],
    excludes: ['DOCUMENT COMPLETE'],
  },
  {
    n: 74,
    name: 'two Context: lines',
    files: { [DOC_PATH]: document({ context: [CONTEXT, 'none'] }), [REVIEW_PATH]: review() },
    exit: 1,
    includes: ['carries 2 "Context:" lines', 'a document is written against one set of context documents'],
  },
  {
    // `none` is a claim: nothing binds, and the page cites nothing.
    n: 75,
    name: 'Context: none, and the page cites no document — must pass',
    files: { [DOC_PATH]: document({ context: 'none', uses: null }), [REVIEW_PATH]: review() },
    exit: 0,
    includes: ['DOCUMENT COMPLETE: 5 of 5 checks passed'],
  },
  {
    // The reverse rule: a document the page cites was read, so the line pins it.
    n: 76,
    name: 'Context: none, and the page cites a decision record and a rule of a standard',
    files: { [DOC_PATH]: document({ context: 'none' }), [REVIEW_PATH]: review() },
    exit: 1,
    includes: ['names ADR-007, and its "Context:" line does not list it', 'cites std-auth.01, and its "Context:" line does not list std-auth'],
  },
  {
    // The pinned form only: a requirements document has no older form to accept.
    n: 77,
    name: 'an entry by bare id, with no pin and no path',
    files: { [DOC_PATH]: document({ context: `ADR-007, ${STD_ENTRY}` }), [REVIEW_PATH]: review() },
    exit: 1,
    includes: ['"ADR-007" is not a context entry', 'copy the line scripts/read-context.mjs --hub prints'],
  },
  {
    n: 78,
    name: 'a placeholder for the line',
    files: { [DOC_PATH]: document({ context: 'TBD', uses: null }), [REVIEW_PATH]: review() },
    exit: 1,
    includes: ['"Context: TBD" is neither'],
  },
  {
    n: 79,
    name: '"none" beside a document id',
    files: { [DOC_PATH]: document({ context: `${CONTEXT}, none` }), [REVIEW_PATH]: review() },
    exit: 1,
    includes: ['lists "none" beside document ids'],
  },
  {
    n: 80,
    name: 'one document named twice',
    files: { [DOC_PATH]: document({ context: `${CONTEXT}, ${ADR_ENTRY}` }), [REVIEW_PATH]: review() },
    exit: 1,
    includes: ['names "ADR-007" more than once'],
  },
  {
    // A requirements document names no repository, so a spoke's contract is
    // not its to read: that is /decompose's and the design's.
    n: 81,
    name: 'an entry kept in a repository',
    files: { [DOC_PATH]: document({ context: `${CONTEXT}, ledger-api@0123456789ab:sample-service:contracts/ledger-api.md`, uses: `${USES} The ledger-api contract applies.` }), [REVIEW_PATH]: review() },
    exit: 1,
    includes: ['is kept in "sample-service"; a requirements document names no repository'],
  },
  {
    n: 82,
    name: 'an entry for a document that is not on the trunk',
    files: { [DOC_PATH]: document({ context: `${CONTEXT}, ADR-009@0123456789ab:docs/architecture/ADR-009-limits.md`, uses: `${USES} ADR-009 sets the limit.` }), [REVIEW_PATH]: review() },
    exit: 1,
    includes: ['"ADR-009" cites docs/architecture/ADR-009-limits.md, which is not on origin/main'],
  },
  {
    // The document moved after it was read: a fact to show, never a failure.
    n: 83,
    name: 'a context document changed after the document read it — must pass, with a drift note',
    files: valid(),
    thenChange: { [ADR_PATH]: `${ADR_BODY}A later paragraph.\n` },
    exit: 0,
    includes: ['note: context drift: "ADR-007" (docs/architecture/ADR-007-step-up.md) was', 'DOCUMENT COMPLETE: 5 of 5 checks passed'],
  },
  {
    n: 84,
    name: 'a pin the commit on the Hub commit: line does not hold',
    files: { [DOC_PATH]: document({ context: `ADR-007@0123456789ab:${ADR_PATH}, ${STD_ENTRY}` }), [REVIEW_PATH]: review() },
    exit: 1,
    includes: ['"ADR-007" pins 0123456789ab', 'the commit the Hub commit: line names, holds ', 'the two lines were not copied from one run', 'copy the Hub commit: and Context: lines it prints'],
  },
  {
    // A shallow clone cannot tell a moved document from bytes nobody merged.
    n: 85,
    name: 'a moved context document in a shallow clone — cannot verify',
    files: valid(),
    thenChange: { [ADR_PATH]: `${ADR_BODY}A later paragraph.\n` },
    shallow: true,
    exit: 2,
    includes: ['CANNOT VERIFY', 'this clone is shallow', 'REASON: shallow-clone'],
  },
  {
    // The line alone does not show that the document was read.
    n: 86,
    name: 'a decision record on the line and named nowhere on the page',
    files: { [DOC_PATH]: document({ uses: 'The outcome is recorded under std-auth.01.' }), [REVIEW_PATH]: review() },
    exit: 1,
    includes: ['"ADR-007" is on the line and named nowhere else in the document'],
  },
  {
    // A name inside a code fence is not on the page a reader sees.
    n: 87,
    name: 'a decision record named only inside a code fence',
    files: { [DOC_PATH]: document({ uses: 'The outcome is recorded under std-auth.01.', appendix: '```\nADR-007\n```' }), [REVIEW_PATH]: review() },
    exit: 1,
    includes: ['"ADR-007" is on the line and named nowhere else in the document'],
  },
  {
    // A standard is used by its rules: naming the standard is not enough.
    n: 88,
    name: 'a standard named, none of its rules cited',
    files: { [DOC_PATH]: document({ uses: 'The challenge runs on the same session, as ADR-007 decides, under std-auth.' }), [REVIEW_PATH]: review() },
    exit: 1,
    includes: ['"std-auth" is a standard, and the document cites none of its rules', 'std-auth.<NN>'],
  },
  {
    n: 89,
    name: 'a rule the standard does not define',
    files: { [DOC_PATH]: document({ uses: `${USES} A code expires under std-auth.09.` }), [REVIEW_PATH]: review() },
    exit: 1,
    includes: [`cites std-auth.09, which ${STD_PATH} on origin/main does not define`],
  },
  {
    n: 90,
    name: 'a rule of a standard the line does not list',
    files: { [DOC_PATH]: document({ uses: `${USES} Logs follow std-logging.02.` }), [REVIEW_PATH]: review() },
    exit: 1,
    includes: ['cites std-logging.02, and its "Context:" line does not list std-logging'],
  },
  {
    // An earlier requirements document is a context document, named by its slug.
    n: 91,
    name: 'an earlier requirements document on the line, named by its slug — must pass',
    files: {
      [OTHER_PATH]: OTHER_BODY,
      [DOC_PATH]: document({ context: `${CONTEXT}, ${OTHER_ENTRY}`, uses: `${USES} The daily limit stays as ${OTHER_SLUG} sets it.` }),
      [REVIEW_PATH]: review(),
    },
    exit: 0,
    includes: ['DOCUMENT COMPLETE: 5 of 5 checks passed'],
  },
  {
    // Bounded: a longer slug that begins with this one is not a mention of it.
    n: 92,
    name: 'an earlier requirements document named only inside a longer id',
    files: {
      [OTHER_PATH]: OTHER_BODY,
      [DOC_PATH]: document({ context: `${CONTEXT}, ${OTHER_ENTRY}`, uses: `${USES} See ${OTHER_SLUG}-v2.` }),
      [REVIEW_PATH]: review(),
    },
    exit: 1,
    includes: [`"${OTHER_SLUG}" is on the line and named nowhere else in the document`],
  },
  {
    // The Global: line (docs/proposals/global-context.md §6.4). A hub without
    // docs/estate/global.json has no global layer. Its document needs no line,
    // and the report is the one it was before the line existed.
    n: 97,
    name: 'global: no global.json and no Global: line — must pass, the report unchanged',
    files: valid(),
    exit: 0,
    includes: ['[PASS] context documents', 'DOCUMENT COMPLETE: 5 of 5 checks passed'],
    excludes: ['Global', 'global'],
  },
  {
    n: 98,
    name: 'global: no global.json and "Global: none" — must pass',
    files: { [DOC_PATH]: document({ global: 'none' }), [REVIEW_PATH]: review() },
    exit: 0,
    includes: ['DOCUMENT COMPLETE: 5 of 5 checks passed'],
  },
  {
    // A release named in a hub with no link is a release of nothing this hub reads.
    n: 99,
    name: 'global: no global.json and a release on the line',
    files: { [DOC_PATH]: document({ global: `v1.4.0 ${SHA_A}` }), [REVIEW_PATH]: review() },
    exit: 1,
    includes: ['[FAIL] context documents', `origin/main carries no ${LINK_PATH}, so this hub has no global layer, and the line is "Global: none" or absent`],
  },
  {
    // The valid control of the global layer: a release tag on the trunk, and the
    // commit it points at.
    n: 100,
    name: 'global: global.json and a release tag with its commit — must pass',
    global: { tags: { 'v1.3.0': 'C1', 'v1.4.0': 'C2' } },
    files: linked({ global: `v1.4.0 ${C2}` }),
    exit: 0,
    includes: ['[PASS] context documents', 'DOCUMENT COMPLETE: 5 of 5 checks passed'],
  },
  {
    // An annotated tag names a tag object. The remote lists it peeled to its commit.
    n: 101,
    name: 'global: an annotated release tag, compared by the commit it names — must pass',
    global: { tags: { 'v1.4.0': 'C2' }, annotated: ['v1.4.0'] },
    files: linked({ global: `v1.4.0 ${C2}` }),
    exit: 0,
    includes: ['DOCUMENT COMPLETE: 5 of 5 checks passed'],
  },
  {
    // The gate does not ask for the newest release. A later tag does not
    // unapprove a document written against an earlier one.
    n: 102,
    name: 'global: an older release while a newer one exists — must pass',
    global: { tags: { 'v1.3.0': 'C1', 'v1.4.0': 'C2' } },
    files: linked({ global: `v1.3.0 ${C1}` }),
    exit: 0,
    includes: ['DOCUMENT COMPLETE: 5 of 5 checks passed'],
  },
  {
    n: 103,
    name: 'global: global.json and "Global: none"',
    global: { tags: { 'v1.4.0': 'C2' } },
    files: linked({ global: 'none' }),
    exit: 1,
    includes: ['[FAIL] context documents', `${LINK_PATH} on origin/main links this hub to`, 'so the document records a release of it, not "none"'],
  },
  {
    n: 104,
    name: 'global: global.json and no Global: line',
    global: { tags: { 'v1.4.0': 'C2' } },
    files: linked(),
    exit: 1,
    includes: ['never says which release of the global repository it was written against', 'expected exactly one "Global: vX.Y.Z <40-hex>"'],
  },
  {
    // A pre-release lets the Board try a change without binding a product.
    n: 105,
    name: 'global: a pre-release tag on the line',
    global: { tags: { 'v1.4.0': 'C2', 'v1.5.0-rc.1': 'C3' } },
    files: linked({ global: `v1.5.0-rc.1 ${C3}` }),
    exit: 1,
    includes: ['"v1.5.0-rc.1" is not a release tag, vX.Y.Z'],
  },
  {
    // The commit binds and the tag is a label. The document recorded v1.4.0 at
    // C1, and the Board has since moved the tag to C2.
    n: 106,
    name: 'global: the tag moved to another commit after the document recorded it',
    global: { tags: { 'v1.4.0': 'C2' } },
    files: linked({ global: `v1.4.0 ${C1}` }),
    exit: 1,
    includes: ['the tag v1.4.0 points at', 'now, not at the recorded', 'a moved label makes the release ambiguous'],
    excludes: ['is not on main'],
  },
  {
    n: 107,
    name: 'global: the tag was deleted after the document recorded it',
    global: { tags: { 'v1.4.0': 'C2' } },
    files: linked({ global: `v1.2.0 ${C1}` }),
    exit: 1,
    includes: ['no longer has the tag v1.2.0', 'a deleted label leaves no release to read'],
    excludes: ['is not on main'],
  },
  {
    // A release tag on a commit the Board never merged to the trunk binds nothing.
    n: 108,
    name: 'global: the commit is not on the global trunk',
    global: { tags: { 'v1.4.0': 'C2', 'v1.5.0': 'SIDE' } },
    files: linked({ global: `v1.5.0 ${SIDE}` }),
    exit: 1,
    includes: ['is not on main, the trunk of', 'Only a commit the Board merged to the trunk and tagged binds'],
    excludes: ['no longer has the tag', 'points at'],
  },
  {
    // A global repository that does not answer is "cannot verify", never a pass
    // and never a failure of the document.
    n: 109,
    name: 'global: the global repository does not answer — exit 2',
    global: { tags: { 'v1.4.0': 'C2' } },
    files: linked({ global: `v1.4.0 ${C2}` }, '<GLOBAL-MISSING>'),
    exit: 2,
    includes: ['CANNOT VERIFY: cannot reach the global repository', 'REASON: remote-unreachable'],
    excludes: ['DOCUMENT COMPLETE', 'DOCUMENT INCOMPLETE'],
  },
  {
    n: 110,
    name: 'global: two Global: lines',
    global: { tags: { 'v1.3.0': 'C1', 'v1.4.0': 'C2' } },
    files: linked({ global: [`v1.3.0 ${C1}`, `v1.4.0 ${C2}`] }),
    exit: 1,
    includes: ['carries 2 "Global:" lines', 'a document is written against one release of the global repository'],
  },
  {
    // The line is read literally: the full commit, in lowercase, as the script prints it.
    n: 111,
    name: 'global: a short commit on the line',
    global: { tags: { 'v1.4.0': 'C2' } },
    files: linked({ global: 'v1.4.0 3f9c2a7e5b1d' }),
    exit: 1,
    includes: ['"3f9c2a7e5b1d" is not a full commit hash, 40 lowercase hex characters'],
  },
  {
    // The link holds the URL only. The version a feature reads is on its document.
    n: 112,
    name: 'global: a global.json that is not well formed',
    global: { tags: { 'v1.4.0': 'C2' } },
    files: { ...linked({ global: `v1.4.0 ${C2}` }), [LINK_PATH]: link('<GLOBAL-URL>', { tag: 'v1.4.0' }) },
    exit: 1,
    includes: [`${LINK_PATH} on origin/main is not well formed: unknown root field "tag"`],
  },
  {
    // On a pull request the check runs in a clone of the candidate trunk. The
    // clone reaches the global repository the same way, through the bare cache.
    n: 113,
    name: 'global: candidate mode, a branch that records a release — must pass',
    global: { tags: { 'v1.4.0': 'C2' } },
    files: { [LINK_PATH]: link() },
    branch: { name: `requirements/${SLUG}`, files: { [DOC_PATH]: document({ global: `v1.4.0 ${C2}` }), [REVIEW_PATH]: review() } },
    checkout: `requirements/${SLUG}`,
    candidate: true,
    exit: 0,
    includes: ['candidate trunk: main as it would read after requirements/step-up-authentication', 'DOCUMENT COMPLETE: 5 of 5 checks passed'],
  },
  {
    // check-requirements-amend.mjs --global: a move forward passes. The versions
    // are compared as numbers, so v1.10.0 is after v1.9.0.
    n: 114,
    name: 'amend start: --global moves the feature forward — must pass',
    files: {},
    branch: { name: `requirements/${SLUG}`, files: { [DOC_PATH]: document({ global: `v1.9.0 ${SHA_A}` }), [REVIEW_PATH]: review() } },
    checkout: `requirements/${SLUG}`,
    amend: true,
    args: ['--global', `Global: v1.10.0 ${SHA_B}`],
    exit: 0,
    includes: ['[PASS] global release', `global:       v1.9.0 -> v1.10.0 ${SHA_B}`, 'AMENDMENT START OK'],
  },
  {
    // A feature opened before the hub was linked records no release. Any release
    // is a move forward from none.
    n: 115,
    name: 'amend start: --global moves a feature with no Global: line to a release — must pass',
    files: {},
    branch: { name: `requirements/${SLUG}`, files: valid() },
    checkout: `requirements/${SLUG}`,
    amend: true,
    args: ['--global', `Global: v1.4.0 ${SHA_B}`],
    exit: 0,
    includes: ['[PASS] global release', `global:       "Global: none" -> v1.4.0 ${SHA_B}`, 'AMENDMENT START OK'],
  },
  {
    n: 116,
    name: 'amend start: --global to an equal version is refused',
    files: {},
    branch: { name: `requirements/${SLUG}`, files: { [DOC_PATH]: document({ global: `v1.4.0 ${SHA_A}` }), [REVIEW_PATH]: review() } },
    checkout: `requirements/${SLUG}`,
    amend: true,
    args: ['--global', `Global: v1.4.0 ${SHA_B}`],
    exit: 1,
    includes: ['[FAIL] global release', 'the document already records v1.4.0, and v1.4.0 is an equal version', 'AMENDMENT REFUSED: 1 of 6 rules failed'],
    excludes: ['AMENDMENT START OK'],
  },
  {
    n: 117,
    name: 'amend start: --global to an older version is refused',
    files: {},
    branch: { name: `requirements/${SLUG}`, files: { [DOC_PATH]: document({ global: `v1.4.0 ${SHA_A}` }), [REVIEW_PATH]: review() } },
    checkout: `requirements/${SLUG}`,
    amend: true,
    args: ['--global', `Global: v1.3.9 ${SHA_B}`],
    exit: 1,
    includes: ['[FAIL] global release', 'the document records v1.4.0, and v1.3.9 is an older version. A move goes forward only'],
    excludes: ['AMENDMENT START OK'],
  },
  {
    n: 118,
    name: 'amend start: --global back to "Global: none" is refused',
    files: {},
    branch: { name: `requirements/${SLUG}`, files: { [DOC_PATH]: document({ global: `v1.4.0 ${SHA_A}` }), [REVIEW_PATH]: review() } },
    checkout: `requirements/${SLUG}`,
    amend: true,
    args: ['--global', 'Global: none'],
    exit: 1,
    includes: ['[FAIL] global release', 'a move back to "Global: none" goes backward'],
    excludes: ['AMENDMENT START OK'],
  },
  {
    // read-global.mjs never prints a pre-release, so the value is not one of its lines.
    n: 119,
    name: 'amend start: a --global value that is not a line read-global.mjs prints — exit 3',
    files: {},
    branch: { name: `requirements/${SLUG}`, files: valid() },
    checkout: `requirements/${SLUG}`,
    amend: true,
    args: ['--global', `Global: v1.5.0-rc.1 ${SHA_B}`],
    exit: 3,
    includes: ['is not a line scripts/read-global.mjs --resolve prints', 'usage:'],
  },  // ---------------------------------------------------------- global entries
  // Fixtures 120 to 135: global Context: entries on the requirements document
  // (docs/proposals/global-context.md §8), pinned to the commit the document's
  // own Global: line records. globalDoc() links the hub and records v1.4.0.
  {
    // A hub without docs/estate/global.json sees no change, and nothing global is read.
    n: 120,
    name: 'global entries: a hub without global.json and no global entry — must pass, no global repository read',
    files: valid(),
    noGlobalRead: true,
    exit: 0,
    includes: ['DOCUMENT COMPLETE: 5 of 5 checks passed'],
  },
  {
    n: 121,
    name: 'global entries: a hub without global.json and a global entry',
    global: { tags: { 'v1.4.0': 'C2' } },
    files: globalDoc(G_ADR_ENTRY, G_ADR_USE, { withLink: false, global: null }),
    noGlobalRead: true,
    exit: 1,
    includes: ['"global.ADR-012" cites the global layer, and origin/main carries no docs/estate/global.json, so this hub has no global layer'],
  },
  {
    n: 122,
    name: 'global entries: a global record at the recorded commit, used on the page — must pass',
    global: { tags: { 'v1.4.0': 'C2' } },
    files: globalDoc(G_ADR_ENTRY, G_ADR_USE),
    exit: 0,
    includes: ['DOCUMENT COMPLETE: 5 of 5 checks passed'],
  },
  {
    n: 123,
    name: 'global entries: a global standard, cited by a rule it defines — must pass',
    global: { tags: { 'v1.4.0': 'C2' } },
    files: globalDoc(G_STD_ENTRY, G_STD_USE),
    exit: 0,
    includes: ['DOCUMENT COMPLETE: 5 of 5 checks passed'],
  },
  {
    n: 124,
    name: 'global entries: a global id in the hub form and in a repository form, and a hub id in the global form',
    global: { tags: { 'v1.4.0': 'C2' } },
    files: globalDoc([`global.ADR-012@${P2}:${G_ADR_PATH}`, `global.std-go@${P2}:transfer-service:${G_STD_PATH}`, `${OTHER_SLUG}@${P2}:global:${OTHER_PATH}`], `${G_ADR_USE} ${G_STD_USE} The limits follow ${OTHER_SLUG}.`),
    exit: 1,
    includes: [
      'is a global document and the entry places it in the hub. A global entry is <id>@<12-hex>:global:<path>',
      'is a global document and the entry places it in "transfer-service"',
      `places ${OTHER_SLUG} in the global layer, and a global document's id starts with "global."`,
    ],
  },
  {
    n: 125,
    name: 'global entries: an entry that pins another global commit than the Global: line records',
    global: { tags: { 'v1.3.0': 'C1', 'v1.4.0': 'C2' } },
    files: globalDoc(gEntry('global.ADR-012', G_ADR_PATH, P1), G_ADR_USE),
    exit: 1,
    includes: ['pins the global commit', `and ${DOC_PATH} records v1.4.0 at`],
  },
  {
    n: 126,
    name: 'global entries: a path that is not at the commit, and a header that names another id',
    global: { tags: { 'v1.4.0': 'C2' } },
    files: globalDoc([gEntry('global.ADR-099', 'docs/architecture/ADR-099-missing.md'), gEntry('global.ADR-013', G_ADR_PATH)], 'global.ADR-099 and global.ADR-013 apply.'),
    exit: 1,
    includes: ['"global.ADR-099" cites docs/architecture/ADR-099-missing.md, which is not in the global repository at v1.4.0', 'names "ADR-012", not "ADR-013"'],
  },
  {
    n: 127,
    name: 'global entries: global ids named on the page and missing from the line, and a global id on the line not used',
    global: { tags: { 'v1.4.0': 'C2' } },
    files: globalDoc(G_STD_ENTRY, `${G_ADR_USE} The session cache is covered by global.EXC-004.`),
    exit: 1,
    includes: ['names global.ADR-012, and its "Context:" line does not list it', 'names global.EXC-004, and its "Context:" line does not list it', '"global.std-go" is a global standard on the "Context:" line, and the document cites none of its rules'],
  },
  {
    n: 128,
    name: 'global entries: an Active exception for this hub, with the record it departs from on the line — must pass',
    global: { tags: { 'v1.4.0': 'C2' } },
    files: globalDoc([G_ADR_ENTRY, gExcEntry('004')], gExcUse('004')),
    exit: 0,
    includes: ['DOCUMENT COMPLETE: 5 of 5 checks passed'],
  },
  {
    n: 129,
    name: 'global entries: a Withdrawn exception',
    global: { tags: { 'v1.4.0': 'C2' } },
    files: globalDoc([G_ADR_ENTRY, gExcEntry('005')], gExcUse('005')),
    exit: 1,
    includes: ['"global.EXC-005" is Withdrawn in the global repository at v1.4.0'],
  },
  {
    n: 130,
    name: 'global entries: an exception for another hub',
    global: { tags: { 'v1.4.0': 'C2' } },
    files: globalDoc([G_ADR_ENTRY, gExcEntry('006')], gExcUse('006')),
    exit: 1,
    includes: [`"global.EXC-006" names the hubs SIM, not this hub, ${HUB_PREFIX}`],
  },
  {
    n: 131,
    name: 'global entries: an exception whose departed record is not on the line',
    global: { tags: { 'v1.4.0': 'C2' } },
    files: globalDoc(gExcEntry('004'), 'The session cache stays in process under global.EXC-004.'),
    exit: 1,
    includes: ['"global.EXC-004" departs from global.ADR-012, and global.ADR-012 is not on the line'],
  },
  {
    n: 132,
    name: 'global entries: an exception past its review-by date — must pass, with a note',
    global: { tags: { 'v1.4.0': 'C2' } },
    files: globalDoc([G_ADR_ENTRY, gExcEntry('007')], gExcUse('007')),
    exit: 0,
    includes: ['note: stale exception: "global.EXC-007" passed its review-by date, 2020-01-01', 'DOCUMENT COMPLETE: 5 of 5 checks passed'],
  },
  {
    n: 133,
    name: 'global entries: an exception that covers a shared spoke and does not name this hub',
    global: { tags: { 'v1.4.0': 'C2' } },
    files: globalDoc([G_ADR_ENTRY, gExcEntry('008')], gExcUse('008')),
    exit: 1,
    includes: [`"global.EXC-008" covers transfer-service, which this hub also lists in docs/estate/repositories.json, and names the hubs SIM, not ${HUB_PREFIX}`],
  },
  {
    n: 134,
    name: 'global entries: the global repository does not answer — exit 2',
    global: { tags: { 'v1.4.0': 'C2' } },
    files: globalDoc(G_ADR_ENTRY, G_ADR_USE, { url: '<GLOBAL-MISSING>' }),
    exit: 2,
    includes: ['CANNOT VERIFY: cannot reach the global repository', 'REASON: remote-unreachable'],
    excludes: ['DOCUMENT COMPLETE', 'DOCUMENT INCOMPLETE'],
  },
  {
    n: 135,
    name: 'global entries: a global entry, and the document records "Global: none"',
    global: { tags: { 'v1.4.0': 'C2' } },
    files: globalDoc(G_ADR_ENTRY, G_ADR_USE, { global: 'none' }),
    exit: 1,
    includes: [`and ${DOC_PATH} records "Global: none", so the feature reads no global release`],
  },
  {
    // A bare id inside a file name names no record, as read-context.mjs reads it too.
    n: 136,
    name: 'Context: none, and the page names a file whose name holds a bare ADR id — must pass',
    files: { [DOC_PATH]: document({ context: 'none', uses: 'The team keeps its notes in `docs/architecture/ADR-007-step-up-on-session.md`.' }), [REVIEW_PATH]: review() },
    exit: 0,
    includes: ['DOCUMENT COMPLETE: 5 of 5 checks passed'],
    excludes: ['names ADR-007'],
  },
  {
    // read-context.mjs adds an always-on document to every line, whatever ids
    // it is given, so a page that does not use one is not a failure.
    n: 137,
    name: 'an always-on decision record on the line and named nowhere on the page — must pass',
    files: { [ADR_PATH]: ALWAYS_ADR_BODY, [DOC_PATH]: document({ context: `ADR-007@${pin(ALWAYS_ADR_BODY)}:${ADR_PATH}, ${STD_ENTRY}`, uses: 'The outcome is recorded under std-auth.01.' }), [REVIEW_PATH]: review() },
    exit: 0,
    includes: ['DOCUMENT COMPLETE: 5 of 5 checks passed'],
    excludes: ['named nowhere else'],
  },
  {
    n: 138,
    name: 'an always-on standard on the line, none of its rules cited — must pass',
    files: { [STD_PATH]: ALWAYS_STD_BODY, [DOC_PATH]: document({ context: `${ADR_ENTRY}, std-auth@${pin(ALWAYS_STD_BODY)}:${STD_PATH}`, uses: 'The challenge runs on the same session, as ADR-007 decides.' }), [REVIEW_PATH]: review() },
    exit: 0,
    includes: ['DOCUMENT COMPLETE: 5 of 5 checks passed'],
    excludes: ['cites none of its rules'],
  },
  {
    // The script adds an always-on record only while it is in force.
    n: 139,
    name: 'an always-on decision record that is not Accepted, named nowhere on the page',
    files: { [ADR_PATH]: DEPRECATED_ADR_BODY, [DOC_PATH]: document({ context: `ADR-007@${pin(DEPRECATED_ADR_BODY)}:${ADR_PATH}, ${STD_ENTRY}`, uses: 'The outcome is recorded under std-auth.01.' }), [REVIEW_PATH]: review() },
    exit: 1,
    includes: ['"ADR-007" is on the line and named nowhere else in the document'],
  },
  {
    // The bytes the writer was handed decide, not the bytes on the trunk now.
    n: 140,
    name: 'an always-on record that is no longer always on after the document read it — must pass, with a drift note',
    files: { [ADR_PATH]: ALWAYS_ADR_BODY, [DOC_PATH]: document({ context: `ADR-007@${pin(ALWAYS_ADR_BODY)}:${ADR_PATH}, ${STD_ENTRY}`, uses: 'The outcome is recorded under std-auth.01.' }), [REVIEW_PATH]: review() },
    thenChange: { [ADR_PATH]: ADR_BODY },
    exit: 0,
    includes: ['note: context drift: "ADR-007"', 'DOCUMENT COMPLETE: 5 of 5 checks passed'],
  },
  {
    n: 141,
    name: 'global entries: an always-on global record on the line and named nowhere on the page — must pass',
    global: { tags: { 'v1.4.0': 'C2' } },
    files: globalDoc(gEntry('global.ADR-015', G_ALWAYS_PATH)),
    exit: 0,
    includes: ['DOCUMENT COMPLETE: 5 of 5 checks passed'],
    excludes: ['named nowhere else'],
  },
  // The Hub commit: line (PLDC-526): the trunk commit the hub's documents were
  // read at, beside the Context: line, so an architect can place each pinned
  // standard and decision record in the hub's history.
  {
    n: 142,
    name: 'hub commit: no Hub commit: line',
    files: { [DOC_PATH]: document({ hubCommit: null }), [REVIEW_PATH]: review() },
    exit: 1,
    includes: ['[FAIL] context documents', 'never says which hub commit its context documents were read at', 'expected exactly one "Hub commit: <40-hex>", as scripts/read-context.mjs --hub prints it beside the Context: line'],
  },
  {
    n: 143,
    name: 'hub commit: two Hub commit: lines',
    files: { [DOC_PATH]: document({ hubCommit: [HUB_COMMIT, 'a'.repeat(40)] }), [REVIEW_PATH]: review() },
    exit: 1,
    includes: ['carries 2 "Hub commit:" lines', 'a document reads the hub at one commit'],
  },
  {
    n: 144,
    name: 'hub commit: not a full commit hash',
    files: { [DOC_PATH]: document({ hubCommit: 'abcdef123456' }), [REVIEW_PATH]: review() },
    exit: 1,
    includes: ['"Hub commit: abcdef123456" is not a full commit hash, 40 lowercase hex characters'],
  },
  {
    n: 145,
    name: 'hub commit: a placeholder',
    files: { [DOC_PATH]: document({ hubCommit: 'TBD' }), [REVIEW_PATH]: review() },
    exit: 1,
    includes: ['"Hub commit: TBD" is not a full commit hash'],
  },
  {
    n: 146,
    name: 'hub commit: a commit the trunk does not hold',
    files: { [DOC_PATH]: document({ hubCommit: 'a'.repeat(40) }), [REVIEW_PATH]: review() },
    exit: 1,
    includes: [`"Hub commit: ${'a'.repeat(40)}" names a commit origin/main does not hold`, 'written against a hub nobody merged', 'copy the Hub commit: and Context: lines it prints'],
  },
  {
    // The commit exists, on a branch nobody merged: the line names it, the
    // trunk does not hold it.
    n: 147,
    name: 'hub commit: a commit on an unmerged branch',
    files: valid(),
    setup: (work) => {
      git(work, ['checkout', '-q', '-b', 'draft']);
      writeFiles(work, { [ADR_PATH]: `${ADR_BODY}A draft paragraph.\n` });
      git(work, ['add', '-A']);
      git(work, ['commit', '-q', '-m', 'a draft']);
      const draft = git(work, ['rev-parse', 'HEAD']).trim();
      git(work, ['checkout', '-q', 'main']);
      const doc = document({ hubCommit: draft });
      writeFiles(work, bind({ [DOC_PATH]: doc, [REVIEW_PATH]: review() }, {}));
      git(work, ['add', '-A']);
      git(work, ['commit', '-q', '-m', 'names the draft']);
      git(work, ['push', '-q', 'origin', 'main']);
    },
    exit: 1,
    includes: ['names a commit that is not on origin/main', 'written against a hub nobody merged'],
  },
  {
    // Context: none still records the commit the read was at: the line says
    // that no document bound at that commit.
    n: 148,
    name: 'hub commit: Context: none with a Hub commit: line — must pass',
    files: { [DOC_PATH]: document({ context: 'none', uses: null }), [REVIEW_PATH]: review() },
    exit: 0,
    includes: ['DOCUMENT COMPLETE: 5 of 5 checks passed'],
  },
  {
    // PLDC-686: GitHub drops the cells past the header's count, so the second
    // row of two on one line disappears from the rendered document.
    n: 149,
    name: 'two rows on one line in a table the check does not read by name',
    files: { [DOC_PATH]: document({ appendix: notesTable([`${NOTE_ROWS[0]} ${NOTE_ROWS[1]}`]) }), [REVIEW_PATH]: review() },
    exit: 1,
    includes: [`${DOC_PATH} line `, 'the table row has 7 cells and its header', 'has 3; write one row on one line, and a literal pipe in a cell as \\|'],
  },
  {
    n: 150,
    name: 'a row with fewer cells than its header',
    files: { [DOC_PATH]: document({ appendix: notesTable([NOTE_ROWS[0], row(['Risk', 'The cap may change'])]) }), [REVIEW_PATH]: review() },
    exit: 1,
    includes: [`${DOC_PATH} line `, 'the table row has 2 cells and its header'],
  },
  {
    // An escaped pipe is one cell, and a pipe line in a code fence is not a row.
    n: 151,
    name: 'an escaped pipe in a cell and a pipe line in a code fence — must pass',
    files: { [DOC_PATH]: document({ appendix: [notesTable([NOTE_ROWS[0], row(['Format', 'A value is written a \\| b', 'house style'])]), '', '```', '| a | b | c | d |', '```'].join('\n') }), [REVIEW_PATH]: review() },
    exit: 0,
    includes: ['DOCUMENT COMPLETE: 5 of 5 checks passed'],
  },
];

/* ---------------------------------------------------------------------- runner */

const COMMON = {
  'package.json': `${JSON.stringify({ name: 'requirements-fixture', private: true, type: 'module' }, null, 2)}\n`,
  '.gitignore': 'node_modules\n',
  [ADR_PATH]: ADR_BODY,
  [STD_PATH]: STD_BODY,
};

function bind(files, fixture) {
  const document = files[DOC_PATH];
  const hash = document === undefined ? '0'.repeat(40) : blobHash(document);
  const value = fixture.shortRevision ? hash.slice(0, 7) : hash;
  const bound = {};
  for (const [rel, body] of Object.entries(files)) {
    bound[rel] = typeof body === 'string' ? body.split(DOCUMENT_REVISION).join(value) : body;
  }
  return bound;
}

/**
 * The global context repository a fixture names: a bare remote whose HEAD is
 * `main`, three commits on it, one on the branch `draft` beside it, and the tags
 * `spec.tags` names, `{ <tag>: 'C1' | 'C2' | 'C3' | 'SIDE' }`, annotated where
 * `spec.annotated` lists them. Returns the placeholders and their values.
 */
function buildGlobal(root, spec) {
  const bare = join(root, 'global-context.git');
  const work = join(root, 'global-context-work');
  git(root, ['init', '--bare', '-q', bare]);
  git(root, ['--git-dir', bare, 'symbolic-ref', 'HEAD', 'refs/heads/main']);
  git(root, ['init', '-q', work]);
  git(work, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  git(work, ['config', 'user.name', 'Fixture Runner']);
  git(work, ['config', 'user.email', 'fixture@example.invalid']);
  git(work, ['config', 'commit.gpgsign', 'false']);
  git(work, ['config', 'tag.gpgsign', 'false']);
  const commits = {};
  for (const n of [1, 2, 3]) {
    writeFiles(work, { [`docs/architecture/ADR-00${n}-record.md`]: `# ADR-00${n}: record ${n}\n`, ...(n === 2 ? GLOBAL_DOCS : {}) });
    git(work, ['add', '-A']);
    git(work, ['commit', '-q', '-m', `record ${n}`]);
    commits[`C${n}`] = git(work, ['rev-parse', 'HEAD']).trim();
  }
  git(work, ['checkout', '-q', '-b', 'draft']);
  writeFiles(work, { 'docs/architecture/ADR-004-draft.md': '# ADR-004: a draft the Board never merged\n' });
  git(work, ['add', '-A']);
  git(work, ['commit', '-q', '-m', 'draft']);
  commits.SIDE = git(work, ['rev-parse', 'HEAD']).trim();
  git(work, ['checkout', '-q', 'main']);
  git(work, ['push', '-q', bare, 'main', 'draft']);
  for (const [name, at] of Object.entries(spec.tags || {})) {
    const annotated = (spec.annotated || []).includes(name);
    git(work, annotated ? ['tag', '-a', '-m', `release ${name}`, name, commits[at]] : ['tag', name, commits[at]]);
    git(work, ['push', '-q', bare, `refs/tags/${name}`]);
  }
  return {
    '<GLOBAL-URL>': bare,
    '<GLOBAL-MISSING>': join(root, 'no-such-global.git'),
    [C1]: commits.C1,
    [C2]: commits.C2,
    [C3]: commits.C3,
    [SIDE]: commits.SIDE,
    [P1]: commits.C1.slice(0, 12),
    [P2]: commits.C2.slice(0, 12),
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

function buildRepo(root, fixture) {
  const remote = join(root, 'remote.git');
  const values = fixture.global ? buildGlobal(root, fixture.global) : null;
  const work = join(root, 'work');
  git(root, ['init', '--bare', '-q', 'remote.git']);
  git(root, ['--git-dir', 'remote.git', 'symbolic-ref', 'HEAD', 'refs/heads/main']);
  git(root, ['init', '-q', 'work']);
  git(work, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  git(work, ['config', 'user.name', 'Fixture Runner']);
  git(work, ['config', 'user.email', 'fixture@example.invalid']);
  git(work, ['config', 'commit.gpgsign', 'false']);
  git(work, ['remote', 'add', 'origin', remote]);

  // Commit 0: the hub's context documents and everything of the fixture that
  // is not the requirements document or its review, as /add-context lands them.
  // Its hash is what a document's Hub commit: line names, so it exists before
  // the document does.
  const files = substitute(fixture.files === undefined ? valid() : fixture.files, values);
  const isDocument = (rel) => rel === DOC_PATH || rel === REVIEW_PATH;
  const hubFiles = Object.fromEntries(Object.entries(files).filter(([rel]) => !isDocument(rel)));
  const documentFiles = Object.fromEntries(Object.entries(files).filter(([rel]) => isDocument(rel)));
  writeFiles(work, COMMON);
  mkdirSync(join(work, 'scripts'), { recursive: true });
  copyFileSync(CHECK, join(work, 'scripts', 'check-requirements.js'));
  copyFileSync(CANDIDATE, join(work, 'scripts', 'check-requirements-candidate.mjs'));
  copyFileSync(AMEND, join(work, 'scripts', 'check-requirements-amend.mjs'));
  writeFiles(work, hubFiles);
  writeLinks(work, fixture.symlinks || {});
  git(work, ['add', '-A']);
  git(work, ['commit', '-q', '-m', 'hub documents', '--allow-empty']);
  const hubCommit = git(work, ['rev-parse', 'HEAD']).trim();
  const atHub = (set) => substitute(set, { [HUB_COMMIT]: hubCommit });

  // Commit 1: the document and its review land, as the requirements pull
  // request's merge would land them. The review names the document's hash.
  writeFiles(work, bind(atHub(documentFiles), fixture));
  git(work, ['add', '-A']);
  git(work, ['commit', '-q', '-m', 'requirements merged', '--allow-empty']);

  // Later commits, NOT re-bound: the review keeps naming the revision it read.
  for (const change of [].concat(fixture.thenChange || [])) {
    writeFiles(work, atHub(substitute(change, values)));
    git(work, ['add', '-A']);
    git(work, ['commit', '-q', '-m', 'later revision']);
  }
  git(work, ['push', '-q', 'origin', 'main']);

  if (fixture.branch) {
    git(work, ['checkout', '-q', '-b', fixture.branch.name]);
    writeFiles(work, bind(atHub(substitute(fixture.branch.files, values)), fixture));
    git(work, ['add', '-A']);
    git(work, ['commit', '-q', '-m', 'document on a feature branch']);
    git(work, ['push', '-q', 'origin', fixture.branch.name]);
    git(work, ['checkout', '-q', 'main']);
  }

  // The candidate fixtures run from the branch, as a person or /feature would,
  // and some leave uncommitted files in the working tree on purpose.
  if (fixture.checkout) git(work, ['checkout', '-q', fixture.checkout]);
  // The amendment fixtures move the checkout or the remote after the build:
  // a later push, a local commit, a merge.
  if (fixture.setup) fixture.setup(work);
  if (fixture.dirty) writeFiles(work, atHub(fixture.dirty));

  if (fixture.breakRemote) {
    git(work, ['remote', 'set-url', 'origin', join(root, 'no-such-remote.git')]);
  }

  // A shallow clone of the remote. `file://` is what makes --depth take effect
  // on a local path.
  if (fixture.shallow) {
    const shallow = join(root, 'shallow');
    git(root, ['clone', '-q', '--depth', '1', `file://${remote}`, shallow]);
    return shallow;
  }
  return work;
}

function runFixture(fixture) {
  const root = mkdtempSync(join(tmpdir(), `requirements-fx${String(fixture.n).padStart(2, '0')}-`));
  try {
    const work = buildRepo(root, fixture);
    const cwd = fixture.from ? join(work, fixture.from) : work;
    const file = fixture.amend ? 'check-requirements-amend.mjs' : fixture.candidate ? 'check-requirements-candidate.mjs' : 'check-requirements.js';
    const script = fixture.from
      ? `${fixture.from.split('/').map(() => '..').join('/')}/scripts/${file}`
      : `scripts/${file}`;
    const res = spawnSync(process.execPath, [script, fixture.key || SLUG, ...(fixture.args || [])], {
      cwd, env: { ...ENV, HARNESS_SPOKE_CACHE: join(root, 'cache'), ...(fixture.env || {}) }, encoding: 'utf8',
    });
    const output = `${res.stdout || ''}${res.stderr || ''}`;
    const problems = [];
    if (res.status !== fixture.exit) {
      problems.push(`expected exit ${fixture.exit}, got ${res.status}`);
    }
    if (fixture.noGlobalRead && existsSync(join(root, 'cache', 'global.git'))) {
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

  process.stdout.write(`\ncheck-requirements fixture suite — ${selected.length} of ${FIXTURES.length} fixtures\n`);
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

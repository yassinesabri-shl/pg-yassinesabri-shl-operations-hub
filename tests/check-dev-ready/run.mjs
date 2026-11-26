#!/usr/bin/env node
/**
 * run.mjs — the fixture suite for check-dev-ready.js.
 *
 *   usage:  node run.mjs            run every fixture
 *           node run.mjs 9 11       run only the numbered fixtures
 *           node run.mjs --keep     leave the throwaway repositories on disk
 *
 * A fixture here is a REPOSITORY STATE, not a unit mock. Each case builds a
 * throwaway git repository with a real bare `origin`, commits design files to
 * the default branch, copies the shipped gate to `scripts/check-dev-ready.js`,
 * runs it exactly as an agent would, and asserts the exit code and the failure
 * messages. The gate is never imported and never stubbed: the file under test
 * is the file that ships.
 *
 * A fixture may also set the environment the gate runs in, the directory it is
 * run from, commit a second revision, or commit a symbolic link, because some of
 * what the gate has to refuse is a property of the repository rather than of the
 * document.
 *
 * A fixture marked `global` also builds a real bare global context repository
 * beside the hub, with release tags, and the gate reads it through the
 * fixture's own bare cache (HARNESS_SPOKE_CACHE). Its commits are substituted
 * for placeholders before the review is bound (see buildGlobal). A fixture
 * marked `noGlobalRead` also asserts that the gate made no cache for the global
 * repository, so it read nothing outside the hub.
 *
 * The suite also covers check-design-amend.mjs, the start check of an amendment
 * on an open design pull request: a fixture marked `amend: true` checks out the
 * branch it names and runs that script instead, and `setup` moves the checkout
 * or the remote first. Both scripts are copied into the throwaway repository's
 * scripts/ folder, as they are installed.
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

// Resolve the gate rather than assume it. This suite runs in two layouts: the
// accelerator library, where the gate is a sibling two levels up, and an adopting
// repository, where the suite lands at tests/check-dev-ready/ and the gate at
// scripts/. Both filenames are possible -- a package that is not {"type":"module"}
// needs the .mjs extension. Searching removes any need to patch this file on
// install, and a patched test file is a test file nobody trusts.
//
// Override explicitly with HARNESS_GATE=/path/to/gate, or pass it as the first argument.
const GATE_CANDIDATES = [
  process.env.HARNESS_GATE,
  process.argv[2],
  resolve(HERE, '..', '..', 'scripts', 'check-dev-ready.js'),
  resolve(HERE, '..', '..', 'scripts', 'check-dev-ready.mjs'),
  resolve(HERE, '..', '..', 'check-dev-ready.js'),
  resolve(HERE, '..', '..', 'check-dev-ready.mjs'),
].filter(Boolean);

const GATE = GATE_CANDIDATES.find((p) => existsSync(p));

if (!GATE) {
  console.error('cannot locate the gate script. Looked in order:');
  for (const c of GATE_CANDIDATES) console.error('  ' + c);
  console.error('\nSet HARNESS_GATE=/path/to/check-dev-ready.js or pass the path as argument 1.');
  process.exit(4);
}

// The amendment start check sits beside the gate, .mjs in both layouts.
// HARNESS_AMEND=/path overrides.
const AMEND_CANDIDATES = [
  process.env.HARNESS_AMEND,
  resolve(HERE, '..', '..', 'scripts', 'check-design-amend.mjs'),
  resolve(HERE, '..', '..', 'check-design-amend.mjs'),
].filter(Boolean);

const AMEND = AMEND_CANDIDATES.find((p) => existsSync(p));

if (!AMEND) {
  console.error('cannot locate the amendment start check. Looked in order:');
  for (const c of AMEND_CANDIDATES) console.error('  ' + c);
  console.error('\nSet HARNESS_AMEND=/path/to/check-design-amend.mjs.');
  process.exit(4);
}

const KEY = 'PROJ-412';
// The repository the valid design says its code lands in. A fixture that asks as
// another repository uses a different id, so the two cannot be confused.
const REPO = 'transfer-service';
// The rules the valid design was written under: the repository's rules folder
// cited at a commit, as scripts/read-spoke-rules.mjs prints it. The gate checks
// the shape and the id, never the commit, so a fixed hash is a valid value.
const RULES = `${REPO}@0123456789ab:docs/rules`;
// Two synthetic Prime guardrail ids, in the form Prime's external_id takes.
const GUARDRAIL_A = '3e1c9a40-7b2d-5f61-9c08-2a4be6d1f0a7';
const GUARDRAIL_B = '9b04d7e2-1c3f-5a88-b6e0-47f2c9a31d12';
// The context documents the valid design was written against, as
// scripts/read-context.mjs prints them: a decision record the hub holds, pinned
// to the blob hash of its bytes and committed in every fixture so the gate finds
// it on the trunk, and a contract kept in the design's own repository, which the
// gate checks for shape and id only because it reads one remote. The control
// carries both forms of id and both forms of entry.
const ADR_PATH = 'docs/architecture/ADR-004-eligibility-read-model.md';
const ADR_BODY = '---\nname: ADR-004\ndescription: Eligibility is read from one model\nglobs: []\nalwaysApply: false\nkind: adr\nstatus: Accepted\nowner: lead architect\nrevision: page version 7\norigin: https://wiki.example.invalid/ADR-004\n---\n\n# ADR-004: eligibility is read from one model\n\n## Decision\n\nOne model.\n';
const gitBlob = (body) => createHash('sha1').update(`blob ${Buffer.byteLength(body)}\0`).update(body).digest('hex');
const ADR_ENTRY = `ADR-004@${gitBlob(ADR_BODY).slice(0, 12)}:${ADR_PATH}`;
const CONTRACT_ENTRY = `ledger-postings-api@0123456789ab:${REPO}:contracts/ledger-postings-api.md`;
const CONTEXT = `${ADR_ENTRY}, ${CONTRACT_ENTRY}`;
// Replaced, in every file of a fixture, by the trunk commit the hub's context
// documents landed on: the commit a design's Hub commit: line names. The hub's
// documents are the files under these folders.
const HUB_COMMIT = '<HUB-COMMIT>';
const HUB_DOCUMENT_FOLDERS = ['docs/architecture/', 'docs/standards/', 'docs/exceptions/'];
// A decision record the design's own repository keeps: its id names the repository.
const SPOKE_RECORD_ENTRY = `${REPO}.ADR-002@0123456789ab:${REPO}:decisions/ADR-002-retries.md`;
// The sentence that uses both documents where a reader sees them. A design uses
// each document on its line, and the gate reads that.
const USES = 'Eligibility is read from one model, as ADR-004 decides, and the ledger write keeps the ledger-postings-api contract.';
// The story's own line: the decision record /decompose selected for it. The
// design's line carries it, and adds the contract.
const ITEM_CONTEXT = ADR_ENTRY;
// A standard, committed by the fixtures that need one.
const STD_PATH = 'docs/standards/std-auth.md';
const STD_BODY = '---\nname: std-auth\nkind: standard\nstatus: Active\n---\n\n# std-auth: second-factor challenges\n\n## Must\n\n- **std-auth.01** MUST record the outcome of every second-factor challenge. *(Source: § 2.1)*\n';
const STD_ENTRY = `std-auth@${gitBlob(STD_BODY).slice(0, 12)}:${STD_PATH}`;
// A record and a standard always on: read-context.mjs adds each to every line,
// so a design owes neither a use. Only one in force is added: an Accepted
// record, an Active standard.
const ALWAYS_PATH = 'docs/architecture/ADR-008-utc-times.md';
const ALWAYS_BODY = '---\nname: ADR-008\nalwaysApply: true\nkind: adr\nstatus: Accepted\n---\n\n# ADR-008: every stored time is UTC\n';
const DEPRECATED_BODY = ALWAYS_BODY.replace('status: Accepted', 'status: Deprecated');
const alwaysEntry = (body) => `ADR-008@${gitBlob(body).slice(0, 12)}:${ALWAYS_PATH}`;
const ALWAYS_STD_BODY = STD_BODY.replace('kind: standard', 'alwaysApply: true\nkind: standard');
// The pin of an ADR-004 edit nobody merged (fixture 145).
const UNMERGED_ADR_PIN = gitBlob(`${ADR_BODY}\nDraft: never merged.\n`).slice(0, 12);

/* ------------------------------------------------------------------ git helpers */

// A private HOME so the developer's global gitconfig -- hooks, signing, a
// different default branch -- cannot change the result of a fixture.
const SANDBOX_HOME = mkdtempSync(join(tmpdir(), 'gate-home-'));
const ENV = {
  ...process.env,
  // Fixture repos are built with a `main` trunk. Pin it, so a HARNESS_TRUNK exported
  // in the developer's shell cannot fail a suite that is in fact fine.
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

/* ------------------------------------------------------- the design under test */

// The valid design. Every fixture is this document with one thing changed, so a
// failure names exactly one defect and the happy path is the control.
const BASE = {
  numbered: true,
  criteria: [
    ['AC-1', 'A transfer above the step-up threshold demands a second factor.', 'FSD Authentication L118'],
    ['AC-2', 'A read-only advisory view inherits the existing session.', 'FSD Authentication L124'],
    ['AC-3', 'A failed second factor writes no transfer record.', 'FSD Authentication L131'],
  ],
  tests: [
    ['AC-1', 'test_transfer::test_step_up_demanded', 'unit', 'the challenge is issued'],
    ['AC-2', 'test_advisory::test_session_inherited', 'integration', 'no challenge is issued'],
    ['AC-3', 'test_transfer::test_failed_factor_writes_nothing', 'unit', 'the ledger is untouched'],
  ],
  readiness: [
    ['Spec Quality', 'READY'],
    ['Open Gaps', '0'],
    ['AC count', '3'],
    ['AC covered by tests', '3'],
    ['Contracts referenced', '1'],
    ['Blocking CLAR', '0'],
    ['Codebase verified', 'YES'],
    ['Self-check verdict', 'GATE_PASS'],
  ],
  clar: [
    ['CLAR-PROJ-auth-01', 'Does step-up apply to read-only advisory views, or only to transactional views?',
      'FSD Authentication L118', 'no', 'Product owner', 'Answered',
      'Transactional views only; a read-only view inherits the session.', '2026-07-02'],
  ],
  contextExtra: '',
};

const CLAR_HEADER = ['ID', 'Question', 'Source', 'Blocking', 'Routed to', 'Status', 'Resolution', 'Resolved'];

const row = (cells) => `| ${cells.map((c) => String(c)).join(' | ')} |`;
const sep = (n) => `|${'---|'.repeat(n)}`;

// A table that no rule reads by name, for the fixtures of PLDC-686.
const NOTE_ROWS = [
  row(['Scope', 'Transfers above the threshold', 'the work item']),
  row(['Timing', 'The challenge runs before the posting', 'ADR-004']),
];
const notesTable = (rows) => ['## Notes', '', row(['Topic', 'Note', 'Source']), sep(3), ...rows].join('\n');

// The criteria table carries four columns: ID, Criterion, Requirement, Source.
// Fixtures written as three cells -- id, criterion, source -- predate the
// requirement column and still name exactly one defect each, so the requirement
// is filled in from the row's position rather than rewritten into every case. A
// row written with four cells is emitted as written, which is how a fixture about
// the requirement column itself controls the cell.
const AC_HEADER = ['ID', 'Criterion', 'Requirement', 'Source'];
const withRequirement = (cells, i) => (cells.length === 3 ? [cells[0], cells[1], `REQ-1.AC-${i + 1}`, cells[2]] : cells);
const criteriaRows = (entries) => entries.map((e, i) => (typeof e === 'string' ? e : row(withRequirement(e, i))));

// Every override that takes an array also accepts a raw string in place of a row,
// so a fixture can put a fence, a comment or a sub-heading inside a section without
// a second document builder. The four `*Block` overrides replace a whole section
// body, and `ticket`, `headExtra` and `appendix` reach the parts of the document
// that are not a section.
function design(overrides = {}) {
  const s = { ...BASE, ...overrides };
  const h = (n, t) => (s.numbered ? `## ${n}. ${t}` : `## ${t}`);
  const rows = (entries) => entries.map((e) => (typeof e === 'string' ? e : row(e)));
  const lines = (block) => (Array.isArray(block) ? block : [block]);

  return [
    `# LLD — ${KEY}: step-up authentication on high-value transfers`,
    '',
    ...(s.headExtra ? [s.headExtra, ''] : []),
    h(1, 'Traceability'),
    '',
    `Ticket: ${s.ticket === undefined ? KEY : s.ticket}`,
    // `repository` is the line's value; null drops the line; an array writes one
    // line per value, for the case where a design claims two homes.
    ...(s.repository === null
      ? []
      : [].concat(s.repository === undefined ? REPO : s.repository).map((r) => `Repository: ${r}`)),
    // `rules` is the line's value; null drops the line; an array writes one line
    // per value. The default cites the repository's rules folder at a commit.
    ...(s.rules === null
      ? []
      : [].concat(s.rules === undefined ? RULES : s.rules).map((r) => `Rules: ${r}`)),
    // `context` is the line's value; null drops the line; an array writes one
    // line per value. The default names two documents.
    ...(s.context === null
      ? []
      : [].concat(s.context === undefined ? CONTEXT : s.context).map((c) => `Context: ${c}`)),
    // `hubCommit` is the Hub commit: line's value; null drops the line; an array
    // writes one line per value. The default token becomes the trunk commit the
    // hub's documents landed on.
    ...(s.hubCommit === null
      ? []
      : [].concat(s.hubCommit === undefined ? HUB_COMMIT : s.hubCommit).map((c) => `Hub commit: ${c}`)),
    // `guardrails` is the Guardrails: line's value; the default writes no line,
    // which the gate reads as off. An array writes one line per value.
    ...(s.guardrails === undefined ? [] : [].concat(s.guardrails).map((g) => `Guardrails: ${g}`)),
    // `discovery` is the line's value. The default writes no line, as a design
    // written before /dev-spec wrote maps. An array writes one line per value.
    ...(s.discovery === undefined || s.discovery === null
      ? []
      : [].concat(s.discovery).map((d) => `Discovery: ${d}`)),
    '',
    h(2, 'Context and current state'),
    '',
    'The transfer service validates the session and writes the ledger entry in one call.',
    ...(s.contextExtra ? ['', s.contextExtra] : []),
    '',
    h(3, 'The design'),
    '',
    'A step-up challenge is issued by the transfer service before the ledger write.',
    '',
    // `uses` is the sentence that uses the context documents; null drops it.
    ...(s.uses === null ? [] : [s.uses === undefined ? USES : s.uses, '']),
    h(4, 'Acceptance criteria'),
    '',
    ...(s.criteriaBlock
      ? lines(s.criteriaBlock)
      : [row(AC_HEADER), sep(AC_HEADER.length), ...criteriaRows(s.criteria)]),
    '',
    h(5, 'Testing plan'),
    '',
    ...(s.testsBlock
      ? lines(s.testsBlock)
      : [row(['AC', 'Test name', 'Level', 'Asserts']), sep(4), ...rows(s.tests)]),
    '',
    'Coverage target for changed lines: 95%',
    '',
    ...(s.readinessBlock
      ? lines(s.readinessBlock)
      : [h(8, 'Readiness'), '', ...s.readiness.map((e) => (typeof e === 'string' ? e : `${e[0]}: ${e[1]}`))]),
    '',
    h(9, 'Clarifications'),
    '',
    ...(s.clarBlock
      ? lines(s.clarBlock)
      : (s.clar === 'NONE' ? ['NONE'] : [row(CLAR_HEADER), sep(8), ...rows(s.clar)])),
    '',
    ...(s.appendix ? [...lines(s.appendix), ''] : []),
  ].join('\n');
}

// The review names the revision of the design it approved. Hard-coding the hash
// in each fixture would mean re-editing the suite every time a design changes by a
// character, so the token below is substituted in buildRepo() with the blob hash
// git will store — which is exactly the value `git hash-object` prints to an author.
const REVISION_TOKEN = '<DESIGN-REVISION>';

function review(verdict = '### VERDICT: APPROVED', extra = [], revision = REVISION_TOKEN) {
  return [
    `# Design review — ${KEY}`,
    '',
    'Reviewed against the signed functional specification and the repository tree.',
    'Traceability, failure behaviour and the criterion-to-test map were all checked.',
    '',
    verdict,
    `Design revision: ${revision}`,
    ...extra,
    '',
  ].join('\n');
}

function blobHash(content) {
  const body = Buffer.from(content, 'utf8');
  return createHash('sha1').update(`blob ${body.length}\0`).update(body).digest('hex');
}

// The design pins the map it was written from, and the review pins the design.
// The map pin is therefore substituted first, so the design revision the review
// carries is the revision with the real pin in it.
function bindRevisions(input) {
  const map = input[MAP_PATH];
  const files = {};
  for (const [rel, body] of Object.entries(input)) {
    files[rel] = typeof body === 'string' && body.includes(MAP_TOKEN)
      ? body.split(MAP_TOKEN).join(map === undefined ? '0'.repeat(12) : blobHash(map).slice(0, 12))
      : body;
  }
  const design = files[DESIGN_PATH];
  const bound = {};
  for (const [rel, body] of Object.entries(files)) {
    bound[rel] = typeof body === 'string' && body.includes(REVISION_TOKEN)
      ? body.split(REVISION_TOKEN).join(design === undefined ? '0'.repeat(40) : blobHash(design))
      : body;
  }
  return bound;
}

/* --------------------------------------------- regions a reader does not read */

// The fence marker is a parameter because the marker is the point: a fix that
// handles ``` and not ~~~, or ``` and not ``````, has closed nothing.
const fenced = (text, marker = '```', info = '') => [marker + info, text, marker].join('\n');
const commented = (text) => ['<!--', text, '-->'].join('\n');

// A document whose whole body is an example under a disclaimer. It renders as one
// grey block: a reader sees a design that says it is not written, and before the
// mask the gate saw a complete design.
const quotedDesign = (marker = '```', info = '') => [
  `# LLD — ${KEY}: step-up authentication on high-value transfers`,
  '',
  'Not written yet. The block below is the shape this document has to take.',
  '',
  fenced(design(), marker, info),
  '',
].join('\n');

const quotedReview = (wrap) => [
  `# Design review — ${KEY}`,
  '',
  'Not reviewed yet. The verdict line is written exactly like this:',
  '',
  wrap('### VERDICT: APPROVED'),
  '',
].join('\n');

/** Swap one readiness pair for another value, keeping position. */
function readinessWith(label, value) {
  return BASE.readiness.map((e) => (e[0] === label ? [label, value] : e));
}

/** Drop one readiness pair entirely. */
function readinessWithout(label) {
  return BASE.readiness.filter((e) => e[0] !== label);
}

/** Swap several readiness values at once, keeping position. */
function readinessSet(changes) {
  return BASE.readiness.map((e) => (e[0] in changes ? [e[0], changes[e[0]]] : e));
}

/** The eight readiness lines on their own, for a fixture that relocates them. */
const READINESS_LINES = BASE.readiness.map((e) => `${e[0]}: ${e[1]}`);

const DESIGN_PATH = `docs/designs/${KEY}.lld.md`;
const REVIEW_PATH = `docs/designs/${KEY}.lld-review.md`;

const valid = () => ({ [DESIGN_PATH]: design(), [REVIEW_PATH]: review() });

// The work item the design was written from, as /decompose writes it. Every
// fixture repository carries this one on the trunk unless the fixture writes its
// own at the same path or sets `noItem`, so a case about something else is not
// failed by a missing trace. Its criteria are the control design's, each carrying
// the requirement criterion the design's Requirement column fills in from its
// position. `criteria` is a list of [id, carries] pairs; `block` replaces the
// whole section body; `heading` renames the section.
const ITEM_SLUG = 'payments-onboarding';
const ITEM_PATH = `docs/backlog/${ITEM_SLUG}/${KEY}.item.md`;
const ITEM_CRITERIA = BASE.criteria.map((c, i) => [c[0], `REQ-1.AC-${i + 1}`]);
const itemTable = (criteria) => [
  row(['ID', 'Criterion', 'Type', 'Carries', 'Source']),
  sep(5),
  ...criteria.map(([id, carries]) => row([id, `The criterion ${id} states.`, 'positive', carries, 'requirements § REQ-1 L80'])),
];

// The same story, taken from a Jira ticket by /from-ticket: filed under the
// reserved slug `jira`, each criterion carrying its own ticket's criterion, and a
// design whose Requirement column repeats them.
const TICKET_ITEM_PATH = `docs/backlog/jira/${KEY}.item.md`;
const TICKET_CRITERIA = BASE.criteria.map((c, i) => [c[0], `JIRA-${KEY}.AC-${i + 1}`]);
const TICKET_DESIGN_CRITERIA = BASE.criteria.map((c, i) => [c[0], c[1], `JIRA-${KEY}.AC-${i + 1}`, c[2]]);

// `context` is the story's Context: line value; null drops the line.
function workItem({ criteria = ITEM_CRITERIA, block = null, key = KEY, heading = 'Acceptance criteria', context = ITEM_CONTEXT } = {}) {
  return [
    `# ${key} — step-up authentication on high-value transfers`,
    '',
    `Key: ${key}`,
    `Repository: ${REPO}`,
    ...(context === null ? [] : [`Context: ${context}`]),
    '',
    `## ${heading}`,
    '',
    ...(block ? [].concat(block) : itemTable(criteria)),
    '',
  ].join('\n');
}

// The discovery map /dev-spec writes beside the design: the spoke files the seat
// read, the searches it ran, the paths it ruled out and the rows it reused from
// an earlier story's map. The design pins it with MAP_TOKEN, which
// bindRevisions() replaces with the first 12 characters of the map's blob hash.
const MAP_PATH = `docs/designs/${KEY}.discovery.md`;
const MAP_TOKEN = '<MAP-PIN>';
const MAP_LINE = `${KEY}.discovery.md@${MAP_TOKEN}`;
const MAP_COMMIT = '0123456789abcdef0123456789abcdef01234567';
const MAP_SEARCH = '`--grep postLedger --paths src/**`';
// The spoke file the valid mapped design cites, and the sentence that cites it.
const MAP_FILE = 'src/transfer/post.ts';
const MAP_CITE = `The posting call sits at ${REPO}@0123456789ab:${MAP_FILE} L10-24.`;
const MAP_FILES_READ = [[MAP_FILE, '1a2b3c4d5e6f', 'holds the posting call that the change wraps']];
const MAP_SEARCHES = [[MAP_SEARCH, '3', '1']];
const MAP_RULED_OUT = [['src/ledger/legacy.ts', '6f5e4d3c2b1a', MAP_SEARCH, 'dead code, no caller since the v2 router']];

// Each table override takes a list of rows or the literal 'NONE'. `head` sets
// the three lines at the top, by label; null drops a line.
function discoveryMap({
  key = KEY, ticket = KEY, repository = REPO, commit = MAP_COMMIT,
  filesRead = MAP_FILES_READ, searches = MAP_SEARCHES, ruledOut = MAP_RULED_OUT, reused = 'NONE',
} = {}) {
  const table = (header, rows) => (rows === 'NONE' ? ['NONE'] : [row(header), sep(header.length), ...rows.map(row)]);
  return [
    `# Discovery — ${key}`,
    '',
    ...(ticket === null ? [] : [`Ticket: ${ticket}`]),
    ...(repository === null ? [] : [`Repository: ${repository}`]),
    ...(commit === null ? [] : [`Commit: ${commit}`]),
    '',
    '## Files read',
    '',
    ...table(['Path', 'Blob', 'Why'], filesRead),
    '',
    '## Searches',
    '',
    ...table(['Search', 'Hits', 'Kept'], searches),
    '',
    '## Ruled out',
    '',
    ...table(['Path', 'Blob', 'Search', 'Reason'], ruledOut),
    '',
    '## Reused',
    '',
    ...table(['Map', 'Path', 'Pin'], reused),
    '',
  ].join('\n');
}

// The valid mapped design of fixture 210, with one thing changed: `d` overrides
// the design, `m` the map, and `extra` adds or replaces files.
function mapped({ d = {}, m = {}, extra = {} } = {}) {
  return {
    [DESIGN_PATH]: design({ discovery: MAP_LINE, contextExtra: MAP_CITE, ...d }),
    [REVIEW_PATH]: review(),
    [MAP_PATH]: discoveryMap(m),
    ...extra,
  };
}

// An earlier story's map on the trunk, which the two-story fixtures reuse.
const EARLIER_KEY = 'PROJ-411';
const EARLIER_MAP_PATH = `docs/designs/${EARLIER_KEY}.discovery.md`;
const EARLIER_MAP = discoveryMap({ key: EARLIER_KEY, ticket: EARLIER_KEY, filesRead: [['src/ledger/types.ts', 'aa11bb22cc33', 'holds the posting types'], ['src/ledger/client.ts', 'dd44ee55ff66', 'holds the ledger client']] });
const EARLIER_PIN = gitBlob(EARLIER_MAP).slice(0, 12);

// The branch /dev-spec cuts for the key, which the amendment fixtures start on.
const AMEND_BRANCH = `feature/${KEY}-step-up-auth`;

// The 1-based line a heading sits on in the design these overrides build. A
// fixture that asserts a line number derives it here, so a line added to the
// builder moves the number instead of breaking the case.
function headingLine(overrides, heading) {
  const no = design(overrides).split('\n').findIndex((l) => l === heading) + 1;
  if (no === 0) throw new Error(`headingLine: "${heading}" is not in the design these overrides build`);
  return no;
}

// A testing plan written as an indented code block, shared by fixture 60 and the
// line number it asserts.
const INDENTED_TESTS = {
  testsBlock: [
    `    ${row(['AC', 'Test name', 'Level', 'Asserts'])}`,
    `    ${sep(4)}`,
    ...BASE.tests.map((t) => `    ${row(t)}`),
  ],
};

/* ------------------------------------------------------------ the global layer */

// This hub's key prefix, and the repository the global exceptions cover.
const HUB_PREFIX = 'PROJ';
const GLOBAL_REPO = REPO;

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

// The hub's side of the global layer: a hub linked to the global repository -- its link file,
// the requirements document of the work item's slug recording v1.4.0 at the
// second global commit, its key ledger and its list of repositories.
const REQ_DOC_PATH = `docs/requirements/${ITEM_SLUG}/requirements.md`;
const requirementsDoc = (global) => `# Requirements — payments onboarding\n\n${global === null ? '' : `Global: ${global}\n`}`;
const globalHub = ({ link = globalLink(), global = `v1.4.0 ${GC2}` } = {}) => ({
  ...(link === null ? {} : { [GLOBAL_LINK_PATH]: link }),
  [REQ_DOC_PATH]: requirementsDoc(global),
  'docs/backlog/keys.json': `${JSON.stringify({ schema_version: 1, prefix: HUB_PREFIX, next: 413, blocks: [] }, null, 2)}\n`,
  'docs/estate/repositories.json': `${JSON.stringify({ schema_version: 1, repositories: { [REPO]: { url: 'https://example.invalid/transfer-service.git', checks: 'checks.env', purpose: 'Moves money between accounts.', readAt: 'a'.repeat(40) } } }, null, 2)}\n`,
});
// The control design with these global entries after its own two, and these
// sentences after its own.
const globalDesign = (entries, uses = '') => ({
  [DESIGN_PATH]: design({ context: [CONTEXT, ...[].concat(entries)].join(', '), uses: `${USES} ${uses}`.trim() }),
  [REVIEW_PATH]: review(),
});

/* ------------------------------------------------------------------- fixtures */

const FIXTURES = [
  {
    n: 1,
    name: 'valid design and approved review',
    files: valid(),
    exit: 0,
    includes: ['ELIGIBLE: 4 of 4 gates passed'],
  },
  {
    n: 2,
    name: 'no design on the trunk (design exists only on a feature branch)',
    files: {},
    branch: { name: `feature/${KEY}`, files: valid() },
    exit: 1,
    includes: [
      '"*.lld.md" for PROJ-412 on origin/main, found 0',
      '"*.lld-review.md" for PROJ-412 on origin/main, found 0',
      'skipped: no readable design document',
    ],
  },
  {
    n: 3,
    name: 'two design documents for the key',
    files: { ...valid(), [`docs/designs/superseded/${KEY}.lld.md`]: design() },
    exit: 1,
    includes: ['found 2:'],
  },
  {
    n: 4,
    name: 'design present, review file absent',
    files: { [DESIGN_PATH]: design() },
    exit: 1,
    includes: ['"*.lld-review.md" for PROJ-412 on origin/main, found 0'],
  },
  {
    n: 5,
    name: 'review verdict is CHANGES REQUESTED',
    files: { [DESIGN_PATH]: design(), [REVIEW_PATH]: review('### VERDICT: CHANGES REQUESTED') },
    exit: 1,
    includes: ['verdict is "### VERDICT: CHANGES REQUESTED"', 'the gate opens only on "### VERDICT: APPROVED"'],
  },
  {
    n: 6,
    name: 'readiness field appears twice',
    files: {
      [DESIGN_PATH]: design({ readiness: [...BASE.readiness, ['Open Gaps', '0']] }),
      [REVIEW_PATH]: review(),
    },
    exit: 1,
    includes: ['readiness field "Open Gaps" appears 2 times'],
  },
  {
    n: 7,
    name: 'readiness field outside the Readiness section',
    files: {
      [DESIGN_PATH]: design({
        readiness: readinessWithout('Codebase verified'),
        contextExtra: 'Codebase verified: YES',
      }),
      [REVIEW_PATH]: review(),
    },
    exit: 1,
    includes: ['readiness field "Codebase verified"', 'is outside the "## Readiness" section'],
  },
  {
    n: 8,
    name: 'readiness value is prose, not a pure token',
    files: {
      [DESIGN_PATH]: design({ readiness: readinessWith('Spec Quality', 'READY (see section 3)') }),
      [REVIEW_PATH]: review(),
    },
    exit: 1,
    includes: ['readiness field "Spec Quality" value "READY (see section 3)" is not a pure token'],
  },
  {
    n: 9,
    name: 'declared counts agree with each other but the testing plan is short',
    files: {
      [DESIGN_PATH]: design({ tests: [BASE.tests[0]] }),
      [REVIEW_PATH]: review(),
    },
    exit: 1,
    includes: [
      '"AC covered by tests: 3" but the testing plan covers 1: AC-1',
      'acceptance criteria with no named test in the testing plan: AC-2, AC-3',
      '(author wrote "GATE_PASS")',
    ],
  },
  {
    n: 10,
    name: 'testing plan cites a criterion that does not exist',
    files: {
      [DESIGN_PATH]: design({
        tests: [BASE.tests[0], BASE.tests[1], ['AC-9', 'test_transfer::test_reversal', 'unit', 'the reversal posts']],
      }),
      [REVIEW_PATH]: review(),
    },
    exit: 1,
    includes: [
      'the testing plan names AC-9, which the "Acceptance criteria" table does not define',
      'acceptance criteria with no named test in the testing plan: AC-3',
    ],
  },
  {
    n: 11,
    name: 'testing-plan row with an empty test name',
    files: {
      [DESIGN_PATH]: design({
        tests: [BASE.tests[0], BASE.tests[1], ['AC-3', '', 'unit', 'the ledger is untouched']],
      }),
      [REVIEW_PATH]: review(),
    },
    exit: 1,
    includes: [
      'has an empty test name; a criterion without a named test is not covered',
      'acceptance criteria with no named test in the testing plan: AC-3',
    ],
  },
  {
    n: 12,
    name: 'malformed clarification row (seven cells, not eight)',
    files: {
      [DESIGN_PATH]: design({
        clar: ['| CLAR-PROJ-auth-01 | Does step-up apply to advisory views? | FSD Authentication L118 | no | Product owner | Closed | Transactional views only. |'],
      }),
      [REVIEW_PATH]: review(),
    },
    exit: 1,
    includes: ['is malformed: expected 8 cells, found 7'],
  },
  {
    n: 13,
    name: 'blocking clarification at Answered (a chat reply, never written back)',
    files: {
      [DESIGN_PATH]: design({
        clar: [['CLAR-PROJ-auth-01', 'Does step-up apply to read-only advisory views?', 'FSD Authentication L118',
          'yes', 'Product owner', 'Answered', 'Chat reply only; the specification is not yet amended.', '2026-07-02']],
      }),
      [REVIEW_PATH]: review(),
    },
    exit: 1,
    includes: [
      'is blocking and still Answered; a blocking row releases only at Closed or Withdrawn',
      '"Blocking CLAR: 0" but the table has 1 blocking row(s) not yet Closed or Withdrawn',
    ],
  },
  {
    n: 14,
    name: 'blocking clarification at Closed, unnumbered headings — must pass',
    files: {
      [DESIGN_PATH]: design({
        numbered: false,
        clar: [['CLAR-PROJ-auth-01', 'Does step-up apply to read-only advisory views?', 'FSD Authentication L118',
          'yes', 'Product owner', 'Closed', 'Transactional views only; FSD L118 amended.', '2026-07-02']],
      }),
      [REVIEW_PATH]: review(),
    },
    exit: 0,
    includes: ['ELIGIBLE: 4 of 4 gates passed'],
  },
  {
    n: 15,
    name: 'remote unreachable — cannot verify',
    files: valid(),
    breakRemote: true,
    exit: 2,
    includes: ['CANNOT VERIFY', 'could not fetch origin/main', 'Refusing to gate against unverified state', 'REASON: fetch-failed'],
  },
  {
    // The declared counts, the derived counts and the two sets all agree, and not
    // one test is named. A placeholder in the test-name column is the cheapest
    // escape available to a worker at a revision cap, so it is a gate failure.
    n: 16,
    name: 'every test name is a placeholder — counts agree, nothing is covered',
    files: {
      [DESIGN_PATH]: design({
        tests: [
          ['AC-1', '-', 'unit', 'the challenge is issued'],
          ['AC-2', 'TBD', 'unit', 'no challenge is issued'],
          ['AC-3', 'n/a', 'unit', 'the ledger is untouched'],
        ],
      }),
      [REVIEW_PATH]: review(),
    },
    exit: 1,
    includes: [
      'has "-" in the test-name column, which is a placeholder and not a named test',
      'has "TBD" in the test-name column',
      'has "n/a" in the test-name column',
      '"AC covered by tests: 3" but the testing plan covers 0',
      'acceptance criteria with no named test in the testing plan: AC-1, AC-2, AC-3',
    ],
    excludes: ['ELIGIBLE: 4 of 4 gates passed'],
  },
  {
    n: 17,
    name: 'acceptance-criteria row is an identifier with no criterion',
    files: {
      [DESIGN_PATH]: design({
        criteria: [BASE.criteria[0], BASE.criteria[1], ['AC-3', '', 'FSD Authentication L131']],
      }),
      [REVIEW_PATH]: review(),
    },
    exit: 1,
    includes: [
      'acceptance criterion AC-3',
      'has an empty criterion statement; the second cell is the criterion and an identifier alone is not a criterion',
    ],
    excludes: ['ELIGIBLE: 4 of 4 gates passed'],
  },
  {
    n: 18,
    name: 'acceptance-criteria statement is a placeholder',
    files: {
      [DESIGN_PATH]: design({
        criteria: [BASE.criteria[0], BASE.criteria[1], ['AC-3', 'TBD', 'FSD Authentication L131']],
      }),
      [REVIEW_PATH]: review(),
    },
    exit: 1,
    includes: ['has "TBD" as its criterion statement, which is a placeholder and not an observable, testable statement'],
    excludes: ['ELIGIBLE: 4 of 4 gates passed'],
  },
  {
    // The escape CLAR-log.template.md documents. A cell may carry a pipe when it
    // is written \| , the cell count is unchanged, and the row parses.
    n: 19,
    name: 'clarification cell carries an escaped pipe — must pass',
    files: {
      [DESIGN_PATH]: design({
        clar: [['CLAR-PROJ-auth-01', 'Does A \\| B apply to read-only advisory views?',
          'FSD Authentication L118', 'no', 'Product owner', 'Answered',
          'A \\| B applies to transactional views only.', '2026-07-02']],
      }),
      [REVIEW_PATH]: review(),
    },
    exit: 0,
    includes: ['ELIGIBLE: 4 of 4 gates passed'],
    excludes: ['is malformed: expected 8 cells'],
  },
  {
    // The other escape the template documents: no clarifications needs no table.
    n: 20,
    name: 'no clarifications — the literal token NONE, no table — must pass',
    files: {
      [DESIGN_PATH]: design({ clar: 'NONE' }),
      [REVIEW_PATH]: review(),
    },
    exit: 0,
    includes: ['ELIGIBLE: 4 of 4 gates passed'],
    excludes: ['clarification section has neither a table nor the literal token NONE'],
  },
  {
    // The design template, renamed and never filled in. Every criterion cell and
    // every test-name cell is the template's own authoring guidance, the counts
    // agree with the row counts, and the author's self-check says GATE_PASS. The
    // gate has to refuse it: a shape check that accepts an empty template
    // declares an item eligible for build with no content behind it.
    n: 21,
    name: 'the untouched design template — angle-bracket authoring tokens in every cell',
    files: {
      [DESIGN_PATH]: design({
        criteria: [
          ['AC-1', '<observable, testable statement>', 'REQ-<n>.AC-<m>', 'FSD <§ title> L<n>'],
          ['AC-2', '<observable, testable statement>', 'REQ-<n>.AC-<m>', 'DSD <§ title> L<n>'],
          ['AC-3', '<negative case: what must NOT happen>', 'REQ-<n>.AC-<m>', '<source>'],
        ],
        tests: [
          ['AC-1', '<test_module::test_name>', 'unit', '<the assertion>'],
          ['AC-2', '<test_module::test_name>', 'integration', '<the assertion>'],
          ['AC-3', '<test_module::test_name>', 'unit', '<the rejection>'],
        ],
      }),
      [REVIEW_PATH]: review(),
    },
    exit: 1,
    includes: [
      'has "<observable, testable statement>" as its criterion statement, which is a placeholder',
      'names requirement "REQ-<n>.AC-<m>", which is not one REQ-<n>.AC-<m>',
      'has "<test_module::test_name>" in the test-name column, which is a placeholder',
      '"AC covered by tests: 3" but the testing plan covers 0',
    ],
    excludes: ['ELIGIBLE: 4 of 4 gates passed'],
  },

  /* -- Regions a reader does not read ------------------------------------- */

  {
    // The whole document body inside a code fence, in both files. It renders as
    // one grey block under a disclaimer saying the design is not written, and
    // every line inside it is at column zero, which is all the parsers ever asked
    // for. This is the input class the mask exists for.
    n: 22,
    name: 'the whole design body and the verdict inside code fences',
    files: { [DESIGN_PATH]: quotedDesign(), [REVIEW_PATH]: quotedReview((v) => fenced(v)) },
    exit: 1,
    includes: [
      'must contain exactly one verdict line, found 0',
      `never names ${KEY} on a line of its own`,
      'readiness field missing: "Spec Quality"',
      'no "## Acceptance criteria" section in the design document',
    ],
    excludes: ['ELIGIBLE: 4 of 4 gates passed'],
  },
  {
    // A tilde fence. Here so that a fix which looks for backticks fails the suite.
    n: 23,
    name: 'the whole design body inside a tilde fence',
    files: { [DESIGN_PATH]: quotedDesign('~~~'), [REVIEW_PATH]: review() },
    exit: 1,
    includes: [
      'readiness field missing: "Spec Quality"',
      'no "## Clarifications" section in the design document',
    ],
    excludes: ['ELIGIBLE: 4 of 4 gates passed'],
  },
  {
    // Six backticks and a language tag. Here so that a fix which looks for exactly
    // three backticks, or for a bare marker, fails the suite.
    n: 24,
    name: 'the whole design body inside a six-backtick fence with a language tag',
    files: { [DESIGN_PATH]: quotedDesign('``````', 'markdown'), [REVIEW_PATH]: review() },
    exit: 1,
    includes: ['readiness field missing: "Spec Quality"'],
    excludes: ['ELIGIBLE: 4 of 4 gates passed'],
  },
  {
    // Three fenced lines fabricate a section. The eight fields sit under a Notes
    // heading a reader can see, and the Readiness heading the gate located is
    // inside a code block. Delete the fenced heading and the same eight fields
    // fail as "outside the section" — which is what they are.
    n: 25,
    name: 'a fenced heading fabricates a Readiness section that is not in the document',
    files: {
      [DESIGN_PATH]: design({
        readinessBlock: [
          '## 7. Notes',
          '',
          'The block below is the machine surface.',
          '',
          fenced('## 8. Readiness'),
          '',
          ...READINESS_LINES,
        ],
      }),
      [REVIEW_PATH]: review(),
    },
    exit: 1,
    includes: [
      'readiness field "Spec Quality"',
      'is outside the "## Readiness" section',
      'readiness field "Self-check verdict"',
    ],
    excludes: ['ELIGIBLE: 4 of 4 gates passed'],
  },
  {
    // The same trick pointed the other way: a fenced heading ends the section
    // early, so every row below it leaves the table the gate reads while staying
    // in the table the reader reads. The hidden row is an open blocking
    // clarification, which is the row the gate exists to catch. Masking the fence
    // also breaks the table in two, so the row is refused for standing outside the
    // log rather than parsed and refused for being open — either way it is named
    // and the work item does not move.
    n: 26,
    name: 'a fenced heading truncates the clarification table and hides a blocking row',
    files: {
      [DESIGN_PATH]: design({
        clarBlock: [
          row(CLAR_HEADER),
          sep(8),
          row(['CLAR-PROJ-auth-01', 'Does step-up apply to read-only advisory views?',
            'FSD Authentication L118', 'no', 'Product owner', 'Answered',
            'Transactional views only.', '2026-07-02']),
          '',
          fenced('## z'),
          '',
          row(['CLAR-PROJ-auth-02', 'Which ledger absorbs a reversed step-up?',
            'FSD Ledger L44', 'yes', 'Unassigned', 'Open', '', '']),
        ],
      }),
      [REVIEW_PATH]: review(),
    },
    exit: 1,
    includes: ['carries a row identified "CLAR-PROJ-auth-02"'],
    excludes: ['ELIGIBLE: 4 of 4 gates passed'],
  },
  {
    // An opening fence with no closer. A renderer swallows the rest of the file
    // into one code block, so the mask has to run to end of file as well.
    n: 27,
    name: 'an unclosed fence after the title',
    files: { [DESIGN_PATH]: design({ headExtra: '```markdown' }), [REVIEW_PATH]: review() },
    exit: 1,
    includes: [
      'readiness field missing: "Spec Quality"',
      'no "## Acceptance criteria" section in the design document',
    ],
    excludes: ['ELIGIBLE: 4 of 4 gates passed'],
  },
  {
    // The review says the design is rejected. The only verdict line in the file is
    // in a comment, so the rendered page carries no verdict at all.
    n: 28,
    name: 'the review verdict is inside an HTML comment',
    files: {
      [DESIGN_PATH]: design(),
      [REVIEW_PATH]: [
        `# Design review — ${KEY}`,
        '',
        'Rejected. The failure behaviour is unspecified and AC-3 has no observable assertion.',
        'The author must revise before pickup.',
        '',
        commented('### VERDICT: APPROVED'),
        '',
      ].join('\n'),
    },
    exit: 1,
    includes: ['must contain exactly one verdict line, found 0'],
    excludes: ['ELIGIBLE: 4 of 4 gates passed'],
  },
  {
    // One line, at column zero, and the rendered document is a title and nothing
    // else. Every gate used to pass on it.
    n: 29,
    name: 'an unclosed HTML comment hides the whole design',
    files: { [DESIGN_PATH]: design({ headExtra: '<!--' }), [REVIEW_PATH]: review() },
    exit: 1,
    includes: [
      'readiness field missing: "Spec Quality"',
      'no "## Acceptance criteria" section in the design document',
    ],
    excludes: ['ELIGIBLE: 4 of 4 gates passed'],
  },
  {
    // Two of the three testing-plan rows are commented out. The rendered plan has
    // one row; the derived covered set used to have three.
    n: 30,
    name: 'testing-plan rows inside an HTML comment count as coverage',
    files: {
      [DESIGN_PATH]: design({
        tests: [BASE.tests[0], commented([row(BASE.tests[1]), row(BASE.tests[2])].join('\n'))],
      }),
      [REVIEW_PATH]: review(),
    },
    exit: 1,
    includes: [
      '"AC covered by tests: 3" but the testing plan covers 1: AC-1',
      'acceptance criteria with no named test in the testing plan: AC-2, AC-3',
    ],
    excludes: ['ELIGIBLE: 4 of 4 gates passed'],
  },
  {
    // The eight-field attestation, made where nobody can read it. The rendered
    // Readiness section is empty.
    n: 31,
    name: 'the readiness contract is satisfied entirely from inside an HTML comment',
    files: {
      [DESIGN_PATH]: design({
        readinessBlock: ['## 8. Readiness', '', commented(READINESS_LINES.join('\n'))],
      }),
      [REVIEW_PATH]: review(),
    },
    exit: 1,
    includes: [
      'readiness field missing: "Spec Quality"',
      'readiness field missing: "Self-check verdict"',
    ],
    excludes: ['ELIGIBLE: 4 of 4 gates passed'],
  },
  {
    // The inverse: the gate reads LESS than the reader sees. Two open blocking
    // clarifications on the page in an HTML table, and the NONE that released them
    // in a comment. Masking removes the NONE; the HTML table is real content, so
    // it is refused rather than read.
    n: 32,
    name: 'an HTML table of blocking clarifications, released by a NONE in a comment',
    files: {
      [DESIGN_PATH]: design({
        clarBlock: [
          '<table>',
          '<tr><th>ID</th><th>Question</th><th>Blocking</th><th>Status</th></tr>',
          '<tr><td>CLAR-PROJ-auth-01</td><td>Which ledger absorbs a reversed step-up?</td><td>yes</td><td>Open</td></tr>',
          '</table>',
          '',
          commented('NONE'),
        ],
      }),
      [REVIEW_PATH]: review(),
    },
    exit: 1,
    includes: [
      'carries HTML <table> markup',
      'clarification section has neither a table nor the literal token NONE',
    ],
    excludes: ['ELIGIBLE: 4 of 4 gates passed'],
  },
  {
    // An MDX comment. On any MDX surface this hides its contents as completely as
    // an HTML comment does, so a fix that knows only about `<!--` leaves the same
    // hole open.
    n: 33,
    name: 'the readiness contract inside an MDX comment',
    files: {
      [DESIGN_PATH]: design({
        readinessBlock: ['## 8. Readiness', '', '{/*', ...READINESS_LINES, '*/}'],
      }),
      [REVIEW_PATH]: review(),
    },
    exit: 1,
    includes: ['readiness field missing: "Spec Quality"'],
    excludes: ['ELIGIBLE: 4 of 4 gates passed'],
  },
  {
    // `<details>` is not masked, because its contents are real rendered content —
    // blanking them would be the gate refusing to read a document that says what
    // it says. It is refused instead: a section the gate parses is not collapsed
    // behind a summary line that tells the reader to ignore it.
    n: 34,
    name: 'the readiness contract collapsed inside <details>',
    files: {
      [DESIGN_PATH]: design({
        readinessBlock: [
          '## 8. Readiness',
          '',
          '<details>',
          '<summary>Appendix — machine block, ignore</summary>',
          '',
          ...READINESS_LINES,
          '',
          '</details>',
        ],
      }),
      [REVIEW_PATH]: review(),
    },
    exit: 1,
    includes: ['carries HTML <details> markup'],
    excludes: ['ELIGIBLE: 4 of 4 gates passed'],
  },
  {
    // `<pre>` is masked, because a renderer shows its contents as characters
    // rather than reading them as markdown: the rows inside are not a table to
    // anyone but the parser.
    n: 35,
    name: 'the clarification table inside a <pre> block',
    files: {
      [DESIGN_PATH]: design({
        clarBlock: [
          '<pre>',
          row(CLAR_HEADER),
          sep(8),
          row(['CLAR-PROJ-auth-01', 'Which ledger absorbs a reversed step-up?', 'FSD Ledger L44',
            'no', 'Product owner', 'Closed', 'The originating ledger.', '2026-07-02']),
          '</pre>',
        ],
      }),
      [REVIEW_PATH]: review(),
    },
    exit: 1,
    includes: ['clarification section has neither a table nor the literal token NONE'],
    excludes: ['ELIGIBLE: 4 of 4 gates passed'],
  },
  {
    // A comment wrapping a fence wrapping a table. Nesting is here so that a fix
    // cannot handle one region and treat the other as already excluded.
    n: 36,
    name: 'a clarification table two regions deep — a comment around a fence',
    files: {
      [DESIGN_PATH]: design({
        clarBlock: [
          commented(fenced([
            row(CLAR_HEADER),
            sep(8),
            row(['CLAR-PROJ-auth-01', 'Which ledger absorbs a reversed step-up?', 'FSD Ledger L44',
              'no', 'Product owner', 'Closed', 'The originating ledger.', '2026-07-02']),
          ].join('\n'), '```', 'markdown')),
        ],
      }),
      [REVIEW_PATH]: review(),
    },
    exit: 1,
    includes: ['clarification section has neither a table nor the literal token NONE'],
    excludes: ['ELIGIBLE: 4 of 4 gates passed'],
  },
  {
    // The sharpest form of the fenced verdict. The reviewer's real finding is
    // pull-quoted, which the line-anchored match has never counted, and the only
    // line the gate did count was the fenced example beneath it. A reader sees
    // CHANGES REQUESTED at the top of the page; the gate reported approved.
    // Masking leaves no verdict at all, which is the honest answer.
    n: 37,
    name: 'the review pull-quotes CHANGES REQUESTED and fences an APPROVED example',
    files: {
      [DESIGN_PATH]: design(),
      [REVIEW_PATH]: [
        `# Design review — ${KEY}`,
        '',
        "The reviewer's finding:",
        '',
        '> ### VERDICT: CHANGES REQUESTED',
        '',
        'Format reference:',
        '',
        fenced('### VERDICT: APPROVED'),
        '',
      ].join('\n'),
    },
    exit: 1,
    includes: ['must contain exactly one verdict line, found 0'],
    excludes: ['ELIGIBLE: 4 of 4 gates passed'],
  },

  /* -- The same defect pointed at an honest author ------------------------- */

  {
    // A complete, honest design that also shows the block it has to carry. Before
    // the mask this was eight duplicate-field failures pointing at a code sample,
    // and an author had no way to tell that from a real double declaration.
    n: 38,
    name: 'a design that quotes the readiness block in a fence — must pass',
    files: {
      [DESIGN_PATH]: design({
        appendix: [
          '## Appendix — the block this document has to carry',
          '',
          fenced(READINESS_LINES.join('\n')),
        ],
      }),
      [REVIEW_PATH]: review(),
    },
    exit: 0,
    includes: ['ELIGIBLE: 4 of 4 gates passed'],
    excludes: ['must appear exactly once'],
  },
  {
    // The same for the review. The shipped review template tells authors to indent
    // a second verdict by hand to work around this; they no longer have to.
    n: 39,
    name: 'a review that quotes the verdict grammar in a fence — must pass',
    files: {
      [DESIGN_PATH]: design(),
      [REVIEW_PATH]: review(
        fenced('### VERDICT: <APPROVED | CHANGES REQUESTED>'),
        ['', '### VERDICT: APPROVED'],
      ),
    },
    exit: 0,
    includes: ['ELIGIBLE: 4 of 4 gates passed'],
    excludes: ['must contain exactly one verdict line'],
  },
  {
    // Commenting a row out is how an author removes it. The gate used to keep
    // counting it and then accuse the author of a count error they did not make.
    n: 40,
    name: 'a retired acceptance-criteria row commented out in place — must pass',
    files: {
      [DESIGN_PATH]: design({
        criteria: [
          ...BASE.criteria,
          commented('| AC-4 | The old single-factor path stays available. | FSD Authentication L140 |'),
        ],
      }),
      [REVIEW_PATH]: review(),
    },
    exit: 0,
    includes: ['ELIGIBLE: 4 of 4 gates passed'],
    excludes: ['table defines 4'],
  },
  {
    // An authoring note inside the readiness section, carrying a heading. The
    // section used to end at that heading and evict the seven fields below it,
    // which are visibly inside the section on the page.
    n: 41,
    name: 'an authoring note with a heading inside the readiness section — must pass',
    files: {
      [DESIGN_PATH]: design({
        readiness: [
          BASE.readiness[0],
          commented('## 8b. Notes for the next author\nKeep the block above in sync with sections 4 and 5.'),
          ...BASE.readiness.slice(1),
        ],
      }),
      [REVIEW_PATH]: review(),
    },
    exit: 0,
    includes: ['ELIGIBLE: 4 of 4 gates passed'],
    excludes: ['is outside the "## Readiness" section'],
  },
  {
    // The example row used to be collected as the table's header row, so the gate
    // named a line the author reads as correct and never looked at the real
    // header two lines below it.
    n: 42,
    name: 'an example clarification row in a fence above the real table — must pass',
    files: {
      [DESIGN_PATH]: design({
        clarBlock: [
          'Rows follow the schema of record:',
          '',
          fenced('| CLAR-<SYSTEM>-<section>-<nn> | <question> | <source> | yes | <role> | Open | | |'),
          '',
          row(CLAR_HEADER),
          sep(8),
          row(BASE.clar[0]),
        ],
      }),
      [REVIEW_PATH]: review(),
    },
    exit: 0,
    includes: ['ELIGIBLE: 4 of 4 gates passed'],
    excludes: ['clarification header'],
  },

  /* -- Columns, cells and sections ----------------------------------------- */

  {
    // The gate reads the test name out of column two by position. A plan with no
    // test-name column at all used to satisfy the criterion-to-test map from
    // whatever happened to be in that position.
    n: 43,
    name: 'a testing plan with no test-name column',
    files: {
      [DESIGN_PATH]: design({
        testsBlock: [
          row(['AC', 'Status']),
          sep(2),
          row(['AC-1', 'planned']),
          row(['AC-2', 'planned']),
          row(['AC-3', 'planned']),
        ],
      }),
      [REVIEW_PATH]: review(),
    },
    exit: 1,
    includes: ['"Testing plan" table header', 'must begin "| AC | Test name |"'],
    excludes: ['ELIGIBLE: 4 of 4 gates passed'],
  },
  {
    // Four spaces after a blank line is a code block. No comment syntax, no fence
    // marker: the row is simply not in the document a reader reads.
    n: 44,
    name: 'a testing-plan row hidden by a four-space indent',
    files: {
      [DESIGN_PATH]: design({
        tests: [BASE.tests[0], BASE.tests[1], '', `    ${row(BASE.tests[2])}`],
      }),
      [REVIEW_PATH]: review(),
    },
    exit: 1,
    includes: [
      '"AC covered by tests: 3" but the testing plan covers 2',
      'acceptance criteria with no named test in the testing plan: AC-3',
    ],
    excludes: ['ELIGIBLE: 4 of 4 gates passed'],
  },
  {
    // The table renders normally inside a blockquote and carries an open blocking
    // row. The parser collected no rows at all, so the NONE beneath it released
    // the work item. NONE means no clarifications, not "none the parser could
    // read".
    n: 45,
    name: 'blockquoted clarification rows with the token NONE beneath them',
    files: {
      [DESIGN_PATH]: design({
        clarBlock: [
          `> ${row(CLAR_HEADER)}`,
          `> ${sep(8)}`,
          `> ${row(['CLAR-PROJ-auth-01', 'Which ledger absorbs a reversed step-up?', 'FSD Ledger L44',
            'yes', 'Unassigned', 'Open', '', ''])}`,
          '',
          'NONE',
        ],
      }),
      [REVIEW_PATH]: review(),
    },
    exit: 1,
    includes: ['carries a row the gate cannot read'],
    excludes: ['ELIGIBLE: 4 of 4 gates passed'],
  },
  {
    // A zero-width space renders as a blank cell and survives String.trim(), so
    // it satisfied every empty-cell test. This is fixture 17 and fixture 11's
    // input, one invisible character apart.
    n: 46,
    name: 'a zero-width space as the criterion and as the test name',
    files: {
      [DESIGN_PATH]: design({
        criteria: [['AC-1', '\u200B', 'FSD Authentication L118']],
        tests: [['AC-1', '\u200B', 'unit', 'the challenge is issued']],
        readiness: readinessSet({ 'AC count': '1', 'AC covered by tests': '1' }),
      }),
      [REVIEW_PATH]: review(),
    },
    exit: 1,
    includes: [
      'has an empty criterion statement',
      'has an empty test name; a criterion without a named test is not covered',
    ],
    excludes: ['ELIGIBLE: 4 of 4 gates passed'],
  },
  {
    // Two sections of the same name. The gate reads the first, so putting the
    // decoy first hid an open blocking clarification the reader can see in the
    // second. Which one is read must not be decided by their order.
    n: 47,
    name: 'a second Clarifications section shadowed by the first',
    files: {
      [DESIGN_PATH]: design({
        clar: 'NONE',
        appendix: [
          '## 9. Clarifications',
          '',
          row(CLAR_HEADER),
          sep(8),
          row(['CLAR-PROJ-auth-01', 'Which ledger absorbs a reversed step-up?', 'FSD Ledger L44',
            'yes', 'Unassigned', 'Open', '', '']),
        ],
      }),
      [REVIEW_PATH]: review(),
    },
    exit: 1,
    includes: ['"## Clarifications" appears 2 times'],
    excludes: ['ELIGIBLE: 4 of 4 gates passed'],
  },
  {
    // Placeholders wearing punctuation. `n / a` is the token fixture 16 rejects
    // with two spaces added, `TBD.` is a full stop away from it, and the doubled
    // angle brackets are the template's own guidance wrapped rather than replaced.
    n: 48,
    name: 'placeholder cells decorated to slip past the token list',
    files: {
      [DESIGN_PATH]: design({
        criteria: [
          ['AC-1', '.', 'FSD Authentication L118'],
          ['AC-2', 'n / a', 'FSD Authentication L119'],
          ['AC-3', 'TBD.', 'FSD Authentication L120'],
          ['AC-4', '<<observable, testable statement>>', 'FSD Authentication L121'],
          ['AC-5', 'x', 'FSD Authentication L122'],
        ],
        tests: [
          ['AC-1', '…', 'unit', 'the challenge is issued'],
          ['AC-2', 'n / a', 'unit', 'no challenge is issued'],
          ['AC-3', 'TBD.', 'unit', 'the ledger is untouched'],
          ['AC-4', '<test_module::<test_name>>', 'unit', 'the assertion'],
          ['AC-5', 'x', 'unit', 'the assertion'],
        ],
        readiness: readinessSet({ 'AC count': '5', 'AC covered by tests': '5' }),
      }),
      [REVIEW_PATH]: review(),
    },
    exit: 1,
    includes: [
      'has "n / a" as its criterion statement, which is a placeholder',
      'has "TBD." as its criterion statement, which is a placeholder',
      'has "x" as its criterion statement, which is a placeholder',
      'has "<test_module::<test_name>>" in the test-name column',
      '"AC covered by tests: 5" but the testing plan covers 0',
    ],
    excludes: ['ELIGIBLE: 4 of 4 gates passed'],
  },
  {
    // AC-01 and AC-1 are one criterion written two ways. Compared as strings they
    // are two identifiers, so the same criterion is counted twice and the same
    // test is counted twice as coverage.
    n: 49,
    name: 'a leading-zero identifier duplicating a criterion',
    files: {
      [DESIGN_PATH]: design({
        criteria: [
          BASE.criteria[0],
          ['AC-01', BASE.criteria[0][1], BASE.criteria[0][2]],
          BASE.criteria[1],
          BASE.criteria[2],
        ],
        tests: [
          BASE.tests[0],
          ['AC-01', BASE.tests[0][1], 'unit', 'the challenge is issued'],
          BASE.tests[1],
          BASE.tests[2],
        ],
        readiness: readinessSet({ 'AC count': '4', 'AC covered by tests': '4' }),
      }),
      [REVIEW_PATH]: review(),
    },
    exit: 1,
    includes: ['identifier "AC-01" does not match AC-<n>'],
    excludes: ['ELIGIBLE: 4 of 4 gates passed'],
  },
  {
    // Closed is the release bar and the date is the only evidence the gate asks
    // for that the answer was written back. A shape check accepts a date that
    // never happened.
    n: 50,
    name: 'a blocking clarification released by a date that does not exist',
    files: {
      [DESIGN_PATH]: design({
        clar: [['CLAR-PROJ-auth-01', 'Which ledger absorbs a reversed step-up?', 'FSD Ledger L44',
          'yes', 'Product owner', 'Closed', 'Not actually answered.', '0000-00-00']],
      }),
      [REVIEW_PATH]: review(),
    },
    exit: 1,
    includes: ['is Closed with Resolved "0000-00-00"', 'a YYYY-MM-DD date that exists and has passed'],
    excludes: ['ELIGIBLE: 4 of 4 gates passed'],
  },
  {
    // Scoping an out-of-scope list under section 4 is ordinary authoring. The
    // section used to run past the sub-heading, so its two-column table was read
    // as criterion rows and the author was sent to fix rows that were correct.
    n: 51,
    name: 'a sub-table under a sub-heading in the criteria section — must pass',
    files: {
      [DESIGN_PATH]: design({
        criteria: [
          ...BASE.criteria,
          '',
          '### Out of scope',
          '',
          row(['Item', 'Reason']),
          sep(2),
          row(['Bulk payment files', 'Handled by the batch service.']),
        ],
      }),
      [REVIEW_PATH]: review(),
    },
    exit: 0,
    includes: ['ELIGIBLE: 4 of 4 gates passed'],
    excludes: ['is malformed: expected 4 cells'],
  },

  /* -- What the repository says, not what the environment says ------------- */

  {
    // No file is changed. The design is on the author's own branch and the
    // environment names that branch as the trunk. The gate asks the remote which
    // branch is the trunk, and refuses when the answer disagrees — exit 2, not a
    // pass, because it did not verify anything.
    n: 52,
    name: 'HARNESS_TRUNK points the gate at the author\'s own branch',
    files: {},
    branch: { name: `feature/${KEY}`, files: valid() },
    env: { HARNESS_TRUNK: `feature/${KEY}` },
    exit: 2,
    includes: [
      'CANNOT VERIFY',
      `the gate was pointed at "feature/${KEY}"`,
      "origin's default branch is \"main\"",
      'Refusing to gate against unverified state',
    ],
    excludes: ['ELIGIBLE: 4 of 4 gates passed'],
  },
  {
    // The review is approved and untouched. The design under it was rewritten
    // afterwards, reversing its own decision. A review approves a revision, not a
    // filename.
    n: 53,
    name: 'the design was rewritten after the review approved it',
    files: valid(),
    thenChange: {
      [DESIGN_PATH]: design({
        criteria: [['AC-1', 'The step-up challenge is removed entirely for all transfer sizes.', 'FSD Authentication L118']],
        tests: [['AC-1', 'test_transfer::test_no_challenge_ever', 'unit', 'no challenge is issued']],
        readiness: readinessSet({ 'AC count': '1', 'AC covered by tests': '1' }),
      }),
    },
    exit: 1,
    includes: ['the design changed after it was reviewed', 'so the current design is unreviewed'],
    excludes: ['ELIGIBLE: 4 of 4 gates passed'],
  },
  {
    // The filename says one work item and the document says another. The key used
    // to select a filename and nothing else, so renaming a design carried a
    // review of different work.
    n: 54,
    name: 'the design names a different work item than its filename',
    files: { [DESIGN_PATH]: design({ ticket: 'PROJ-999' }), [REVIEW_PATH]: review() },
    exit: 1,
    includes: [`never names ${KEY} on a line of its own`],
    excludes: ['ELIGIBLE: 4 of 4 gates passed'],
  },
  {
    // The same the other way round: a review of unrelated work, renamed.
    n: 55,
    name: 'the review names a different work item than its filename',
    files: {
      [DESIGN_PATH]: design(),
      [REVIEW_PATH]: [
        '# Design review — PROJ-999 (unrelated work item)',
        '',
        'Reviewed against the signed functional specification and the repository tree.',
        '',
        '### VERDICT: APPROVED',
        '',
      ].join('\n'),
    },
    exit: 1,
    includes: [`never names ${KEY}; a review is evidence about one work item`],
    excludes: ['ELIGIBLE: 4 of 4 gates passed'],
  },
  {
    // A trunk that passes, run from a subdirectory. The pathspec used to resolve
    // against the working directory, so the gate reported the design as never
    // merged — confidently, and wrongly, sending the author to re-push an
    // artefact that is already on the trunk.
    n: 56,
    name: 'the gate is run from a subdirectory — must pass',
    files: valid(),
    from: 'scripts',
    exit: 0,
    includes: ['ELIGIBLE: 4 of 4 gates passed'],
    excludes: ['found 0'],
  },
  {
    // Present in the tree is not the same as readable. The verdict was already
    // right here; the diagnosis was not — an empty file produced a page of
    // findings about sections that were missing because there was no document.
    n: 57,
    name: 'the design is committed as an empty file',
    files: { [DESIGN_PATH]: '', [REVIEW_PATH]: review() },
    exit: 1,
    includes: ['is empty on origin/main', 'skipped: no readable design document'],
    excludes: ['ELIGIBLE: 4 of 4 gates passed'],
  },
  {
    // A symlink's bytes are its target's name, so `git show` returns a one-line
    // document and the gate used to report eight missing readiness fields.
    n: 58,
    name: 'the design is committed as a symbolic link',
    files: { 'docs/real/PROJ-412.lld.md': design(), [REVIEW_PATH]: review() },
    symlinks: { [DESIGN_PATH]: '../real/PROJ-412.lld.md' },
    exit: 1,
    includes: ['is a symbolic link on origin/main', 'skipped: no readable design document'],
    excludes: ['ELIGIBLE: 4 of 4 gates passed'],
  },
  {
    // Which repository `origin` resolves to is local configuration, and a
    // repointed remote produces a pass that is byte-identical to an honest one.
    // The gate cannot stop that; it can refuse to leave it out of the transcript.
    n: 59,
    name: 'the header names the remote the verdict was read from — must pass',
    files: valid(),
    exit: 0,
    includes: ['ELIGIBLE: 4 of 4 gates passed', 'origin -> ', 'remote.git'],
  },

  /* -- Where the mask stops looking like a renderer ------------------------ */

  {
    // No blank line after the heading. A heading closes, so the next four-space
    // line opens a code block whatever came before it — the mask required a blank
    // line and read a grey code block as the criterion-to-test map.
    n: 60,
    name: 'an indented code block opening straight after a heading',
    files: { [DESIGN_PATH]: design(INDENTED_TESTS), [REVIEW_PATH]: review() },
    exit: 1,
    includes: [`the "Testing plan" section (line ${headingLine(INDENTED_TESTS, '## 5. Testing plan')}) has no test table`],
    excludes: ['ELIGIBLE: 4 of 4 gates passed'],
  },
  {
    // Four spaces are counted from the list item's content column, not from the
    // margin. Exempting list items outright made every depth of list a place to
    // put a table that renders as a code sample.
    n: 61,
    name: 'an indented code block under a list item at the item content column plus four',
    files: {
      [DESIGN_PATH]: design({
        criteriaBlock: [
          '- Example only, not the real criteria:',
          '',
          `      ${row(AC_HEADER)}`,
          `      ${sep(AC_HEADER.length)}`,
          ...criteriaRows(BASE.criteria).map((c) => `      ${c}`),
        ],
      }),
      [REVIEW_PATH]: review(),
    },
    exit: 1,
    includes: ['has no criterion table'],
    excludes: ['ELIGIBLE: 4 of 4 gates passed'],
  },
  {
    // A link reference definition renders as nothing, and its title runs over as
    // many lines as it likes. Eight readiness fields fit inside one.
    n: 62,
    name: 'a link reference definition title carrying the whole readiness contract',
    files: {
      [DESIGN_PATH]: design({
        readinessBlock: [
          '## 8. Readiness',
          '',
          '[ref]: https://example.invalid "',
          ...READINESS_LINES,
          '"',
        ],
      }),
      [REVIEW_PATH]: review(),
    },
    exit: 1,
    includes: ['readiness field missing: "Spec Quality"', 'readiness field missing: "Self-check verdict"'],
    excludes: ['ELIGIBLE: 4 of 4 gates passed'],
  },
  {
    // An HTML block ends with the LINE that closes it, so text after `-->` is raw
    // HTML, not a heading. Removing the comment span by span put a fabricated
    // heading at column zero and truncated the clarification table under it.
    n: 63,
    name: 'a fabricated heading on the line that closes an HTML comment',
    files: {
      [DESIGN_PATH]: design({
        clarBlock: [
          row(CLAR_HEADER),
          sep(8),
          row(BASE.clar[0]),
          '',
          '<!--',
          'internal note',
          '-->## z',
          '',
          row(['CLAR-PROJ-auth-02', 'Which ledger absorbs a reversed step-up?',
            'FSD Ledger L44', 'yes', 'Unassigned', 'Open', '', '']),
        ],
      }),
      [REVIEW_PATH]: review(),
    },
    exit: 1,
    includes: ['carries a row identified "CLAR-PROJ-auth-02"'],
    excludes: ['ELIGIBLE: 4 of 4 gates passed'],
  },
  {
    // The review is the one file whose whole content is a token. Collapsing the
    // verdict behind a disclosure widget was refused in the design and read in the
    // review, which is the file it matters most in.
    n: 64,
    name: 'the review verdict collapsed inside <details>',
    files: {
      [DESIGN_PATH]: design(),
      [REVIEW_PATH]: [
        `# Design review — ${KEY}`,
        '',
        'Rejected. AC-3 has no observable assertion.',
        '',
        '<details>',
        '<summary>machine block</summary>',
        '',
        '### VERDICT: APPROVED',
        '',
        '</details>',
        '',
      ].join('\n'),
    },
    exit: 1,
    includes: ['carries HTML <details> markup'],
    excludes: ['ELIGIBLE: 4 of 4 gates passed'],
  },
  {
    // `display:none` hides an element without collapsing it, so a tag list that
    // knows only about <details> leaves the same hole open one attribute over.
    n: 65,
    name: 'the design body wrapped in a div that is styled out of the page',
    files: {
      [DESIGN_PATH]: [
        `# LLD — ${KEY}: step-up authentication on high-value transfers`,
        '',
        'Not written yet.',
        '',
        '<div style="display:none">',
        '',
        design(),
        '',
        '</div>',
        '',
      ].join('\n'),
      [REVIEW_PATH]: review(),
    },
    exit: 1,
    includes: ['carries HTML a hidden <div> markup'],
    excludes: ['ELIGIBLE: 4 of 4 gates passed'],
  },
  {
    // Fixture 45 with one real row left standing. The unreadable-row check used to
    // run only when the parser had found nothing at all, so keeping one row beside
    // the blockquoted one walked straight past it.
    n: 66,
    name: 'a blockquoted clarification row standing beside a readable one',
    files: {
      [DESIGN_PATH]: design({
        clarBlock: [
          row(CLAR_HEADER),
          sep(8),
          row(BASE.clar[0]),
          '',
          `> ${row(['CLAR-PROJ-auth-02', 'Which ledger absorbs a reversed step-up?',
            'FSD Ledger L44', 'yes', 'Unassigned', 'Open', '', ''])}`,
        ],
      }),
      [REVIEW_PATH]: review(),
    },
    exit: 1,
    includes: ['carries a row the gate cannot read'],
    excludes: ['ELIGIBLE: 4 of 4 gates passed'],
  },
  {
    // An ordinary, visible sub-heading — no fence, no comment, no indentation.
    // Ending the section at any heading of any level put this row outside the
    // gate's sight and left it in plain view on the page.
    n: 67,
    name: 'a second clarification table under a visible sub-heading',
    files: {
      [DESIGN_PATH]: design({
        clarBlock: [
          row(CLAR_HEADER),
          sep(8),
          row(BASE.clar[0]),
          '',
          '### Deferred to the next increment',
          '',
          row(CLAR_HEADER),
          sep(8),
          row(['CLAR-PROJ-auth-02', 'Which ledger absorbs a reversed step-up?',
            'FSD Ledger L44', 'yes', 'Unassigned', 'Open', '', '']),
        ],
      }),
      [REVIEW_PATH]: review(),
    },
    exit: 1,
    includes: ['carries 2 tables with the same header'],
    excludes: ['ELIGIBLE: 4 of 4 gates passed'],
  },
  {
    // The same defect in section 4, and the rows carry no header of their own, so
    // an ambiguity check alone would miss them. A row identified AC-<n> belongs to
    // the criterion table wherever it is written.
    n: 68,
    name: 'placeholder criterion rows under a visible sub-heading in the criteria section',
    files: {
      [DESIGN_PATH]: design({
        criteria: [
          ...BASE.criteria,
          '',
          '### Still to be written',
          '',
          row(['AC-4', 'TBD', 'TBD']),
          row(['AC-5', '-', '-']),
        ],
      }),
      [REVIEW_PATH]: review(),
    },
    exit: 1,
    includes: [
      'carries a row identified "AC-4"',
      'carries a row identified "AC-5"',
    ],
    excludes: ['ELIGIBLE: 4 of 4 gates passed'],
  },
  {
    // The identity check used to be satisfied by one matching line anywhere in the
    // document, so a Traceability section naming a different work item was cured
    // by an appendix naming the right one.
    n: 69,
    name: 'the design names one work item in Traceability and another in an appendix',
    files: {
      [DESIGN_PATH]: design({
        ticket: 'PROJ-999',
        appendix: ['## Appendix — provenance', '', `Ticket: ${KEY}`],
      }),
      [REVIEW_PATH]: review(),
    },
    exit: 1,
    includes: ['carries a "Ticket:" line naming "PROJ-999"'],
    excludes: ['ELIGIBLE: 4 of 4 gates passed'],
  },
  {
    // A substring test says a review naming PROJ-4120 names PROJ-412.
    n: 70,
    name: 'the review names a key the work-item key is a prefix of',
    files: {
      [DESIGN_PATH]: design(),
      [REVIEW_PATH]: [
        '# Design review — PROJ-4120',
        '',
        'Reviewed against the signed functional specification.',
        '',
        '### VERDICT: APPROVED',
        `Design revision: ${REVISION_TOKEN}`,
        '',
      ].join('\n'),
    },
    exit: 1,
    includes: [`never names ${KEY}; a review is evidence about one work item`],
    excludes: ['ELIGIBLE: 4 of 4 gates passed'],
  },
  {
    // The design is rewritten and the review is touched in the SAME commit, so
    // the two share a hash and any ancestry test passes. The revision the review
    // names is still the one it read.
    n: 71,
    name: 'the design is rewritten and the review touched in the same commit',
    files: valid(),
    thenChange: {
      [DESIGN_PATH]: design({
        criteria: [['AC-1', 'The step-up challenge is removed entirely for all transfer sizes.', 'FSD Authentication L118']],
        tests: [['AC-1', 'test_transfer::test_no_challenge_ever', 'unit', 'no challenge is issued']],
        readiness: readinessSet({ 'AC count': '1', 'AC covered by tests': '1' }),
      }),
      [REVIEW_PATH]: `${review('### VERDICT: APPROVED', [], blobHash(design()))}\n`,
    },
    exit: 1,
    includes: ['the design changed after it was reviewed'],
    excludes: ['ELIGIBLE: 4 of 4 gates passed'],
  },
  {
    // And the other order: rewrite the design, then touch the review in a later
    // commit so the design's commit is an ancestor of the review's.
    n: 72,
    name: 'the review is touched in a commit after the design was rewritten',
    files: valid(),
    thenChange: [
      {
        [DESIGN_PATH]: design({
          criteria: [['AC-1', 'The step-up challenge is removed entirely for all transfer sizes.', 'FSD Authentication L118']],
          tests: [['AC-1', 'test_transfer::test_no_challenge_ever', 'unit', 'no challenge is issued']],
          readiness: readinessSet({ 'AC count': '1', 'AC covered by tests': '1' }),
        }),
      },
      { [REVIEW_PATH]: `${review('### VERDICT: APPROVED', [], blobHash(design()))}\n\n` },
    ],
    exit: 1,
    includes: ['the design changed after it was reviewed'],
    excludes: ['ELIGIBLE: 4 of 4 gates passed'],
  },
  {
    // A review that names no revision approves no revision.
    n: 73,
    name: 'the review carries no design revision',
    files: {
      [DESIGN_PATH]: design(),
      [REVIEW_PATH]: [
        `# Design review — ${KEY}`,
        '',
        'Reviewed against the signed functional specification.',
        '',
        '### VERDICT: APPROVED',
        '',
      ].join('\n'),
    },
    exit: 1,
    includes: ['carries no "Design revision: <hash>" line'],
    excludes: ['ELIGIBLE: 4 of 4 gates passed'],
  },

  /* -- The same defect pointed at an honest author, again ------------------ */

  {
    // An unterminated `<!--` inside a code span is text about a comment marker, not
    // a comment. Treating it as one opened a region that ran to end of file and
    // took the review's own verdict with it — and the message named the wrong
    // cause, so the author had nothing to go on.
    n: 74,
    name: 'a review whose prose quotes the comment marker in a code span — must pass',
    files: {
      [DESIGN_PATH]: design(),
      [REVIEW_PATH]: [
        `# Design review — ${KEY}`,
        '',
        'Reviewed against the signed functional specification.',
        'The author must not hide findings behind `<!--`; the verdict grammar is:',
        '',
        fenced('### VERDICT: <APPROVED | CHANGES REQUESTED>'),
        '',
        '### VERDICT: APPROVED',
        `Design revision: ${REVISION_TOKEN}`,
        '',
      ].join('\n'),
    },
    exit: 0,
    includes: ['ELIGIBLE: 4 of 4 gates passed'],
    excludes: ['must contain exactly one verdict line'],
  },
  {
    // The same defect in the design, where it swallowed everything below the
    // sentence that mentioned the marker.
    n: 75,
    name: 'a design whose criterion quotes the comment marker in a code span — must pass',
    files: {
      [DESIGN_PATH]: design({
        criteria: [
          ['AC-1', 'The audit exporter drops any line that begins `<!--`.', 'FSD Authentication L118'],
          BASE.criteria[1],
          BASE.criteria[2],
        ],
      }),
      [REVIEW_PATH]: review(),
    },
    exit: 0,
    includes: ['ELIGIBLE: 4 of 4 gates passed'],
    excludes: ['readiness field missing'],
  },
  {
    // A criterion about HTML, written the way a criterion about HTML is written.
    // The refusal was a raw substring scan, so a design for anything that renders
    // markup could not state its own criteria.
    n: 76,
    name: 'a criterion naming an HTML element in a code span — must pass',
    files: {
      [DESIGN_PATH]: design({
        criteria: [
          BASE.criteria[0],
          ['AC-2', 'The advisory view renders results as an HTML `<table>` with one row per transfer.', 'FSD Authentication L124'],
          BASE.criteria[2],
        ],
      }),
      [REVIEW_PATH]: review(),
    },
    exit: 0,
    includes: ['ELIGIBLE: 4 of 4 gates passed'],
    excludes: ['carries HTML'],
  },
  {
    // The same words UNQUOTED are a real open tag. A browser collapses the rest of
    // the cell behind it, so the refusal stands and the fix is backticks.
    n: 77,
    name: 'a criterion naming an HTML element with no backticks',
    files: {
      [DESIGN_PATH]: design({
        criteria: [
          BASE.criteria[0],
          ['AC-2', 'The advisory view collapses the audit trail behind a <details> element.', 'FSD Authentication L124'],
          BASE.criteria[2],
        ],
      }),
      [REVIEW_PATH]: review(),
    },
    exit: 1,
    includes: ['carries HTML <details> markup'],
    excludes: ['ELIGIBLE: 4 of 4 gates passed'],
  },
  {
    // A table cannot interrupt a paragraph: with no blank line above it a renderer
    // prints the pipes as running text. The gate read a table where the page has
    // none, which is the same divergence as a fence, wearing no marker at all.
    n: 78,
    name: 'a criterion table that interrupts a paragraph instead of starting one',
    files: {
      [DESIGN_PATH]: design({
        criteriaBlock: [
          'Example only, not the real criteria:',
          row(AC_HEADER),
          sep(AC_HEADER.length),
          ...criteriaRows(BASE.criteria),
        ],
      }),
      [REVIEW_PATH]: review(),
    },
    exit: 1,
    includes: ['does not start a block'],
    excludes: ['ELIGIBLE: 4 of 4 gates passed'],
  },
  {
    // Nothing in the four gates reads code, so nothing but this line says which
    // repository a design is for. Without it a design written for one repository
    // passed for any other.
    n: 79,
    name: 'the design never says which repository its code lands in',
    files: { [DESIGN_PATH]: design({ repository: null }), [REVIEW_PATH]: review() },
    exit: 1,
    includes: ['never says which repository its code lands in', 'expected exactly one "Repository: <repository-id>" line'],
    excludes: ['ELIGIBLE: 4 of 4 gates passed'],
  },
  {
    // Two homes is no home. A story is atomic to one repository, and a design that
    // names two is two designs wearing one key.
    n: 80,
    name: 'the design names two repositories',
    files: { [DESIGN_PATH]: design({ repository: [REPO, 'ledger-service'] }), [REVIEW_PATH]: review() },
    exit: 1,
    includes: ['carries 2 "Repository:" lines', `"${REPO}" on line`, '"ledger-service" on line', 'lands in exactly one repository'],
    excludes: ['ELIGIBLE: 4 of 4 gates passed'],
  },
  {
    // The template's own placeholder, left in. Angle brackets are not an id, and
    // neither is a URL: the value is the repository's bare name, nothing more.
    n: 81,
    name: 'the repository line still carries the template placeholder',
    files: { [DESIGN_PATH]: design({ repository: '<REPOSITORY-ID>' }), [REVIEW_PATH]: review() },
    exit: 1,
    includes: ['"Repository: <REPOSITORY-ID>" is not a repository id'],
    excludes: ['ELIGIBLE: 4 of 4 gates passed'],
  },
  {
    // The value is set but it is a clone URL, which is how a reader who has just
    // added the repository would naturally write it.
    n: 82,
    name: 'the repository line carries a URL instead of an id',
    files: { [DESIGN_PATH]: design({ repository: `https://example.invalid/acme/${REPO}.git` }), [REVIEW_PATH]: review() },
    exit: 1,
    includes: ['is not a repository id', 'expected the repository\'s bare name'],
    excludes: ['ELIGIBLE: 4 of 4 gates passed'],
  },
  {
    // Another repository's CI asks about this key, and the design is for it.
    // The header records who asked.
    n: 83,
    name: 'another repository asks with HARNESS_REPO and the design is written for it — must pass',
    files: valid(),
    env: { HARNESS_REPO: REPO },
    exit: 0,
    includes: ['ELIGIBLE: 4 of 4 gates passed', `asked by ${REPO}`],
  },
  {
    // The live bug this line exists to close: a design for one repository, and a
    // code pull request in another. Every other gate passes; only this one can
    // tell them apart.
    n: 84,
    name: 'another repository asks with HARNESS_REPO and the design is written for a different one',
    files: valid(),
    env: { HARNESS_REPO: 'ledger-service' },
    exit: 1,
    includes: [`this design is written for "${REPO}"; "ledger-service" is asking`],
    excludes: ['ELIGIBLE: 4 of 4 gates passed'],
  },
  {
    // Whitespace is unset. A workflow that expands an empty variable has not named
    // a repository, and the hub asking about its own design must still pass.
    n: 85,
    name: 'HARNESS_REPO set to whitespace is the same as unset — must pass',
    files: valid(),
    env: { HARNESS_REPO: '   ' },
    exit: 0,
    includes: ['ELIGIBLE: 4 of 4 gates passed'],
    excludes: ['asked by'],
  },
  {
    // The caller's own value is malformed. That is a usage error, exit 3, before
    // any gate runs: the design is not the thing that is wrong.
    n: 86,
    name: 'HARNESS_REPO is not a repository id — usage error',
    files: valid(),
    env: { HARNESS_REPO: 'acme/ledger-service' },
    exit: 3,
    includes: ['HARNESS_REPO must be a repository id'],
    excludes: ['ELIGIBLE: 4 of 4 gates passed', 'pickup gate  ('],
  },
  {
    // The line inside a fence is an example, not a claim. The mask blanks it, so
    // the gate reports the line as missing rather than reading the sample.
    n: 87,
    name: 'the only repository line is inside a code fence',
    files: {
      [DESIGN_PATH]: design({ repository: null, appendix: fenced(`Repository: ${REPO}`) }),
      [REVIEW_PATH]: review(),
    },
    exit: 1,
    includes: ['never says which repository its code lands in'],
    excludes: ['ELIGIBLE: 4 of 4 gates passed'],
  },
  {
    // The requirement id used to stop at the work item. Without this column the
    // validation report has nothing to repeat, and no script can say which
    // requirement a passing criterion satisfied.
    n: 88,
    name: 'a criteria table with no Requirement column',
    files: {
      [DESIGN_PATH]: design({
        criteriaBlock: [row(['ID', 'Criterion', 'Source']), sep(3), ...BASE.criteria.map((c) => row(c))],
      }),
      [REVIEW_PATH]: review(),
    },
    exit: 1,
    includes: ['has no "Requirement" column'],
    excludes: ['ELIGIBLE: 4 of 4 gates passed'],
  },
  {
    // A requirement without its criterion is half an id. `REQ-1` names a
    // requirement; the report has to say which of its criteria was satisfied.
    n: 89,
    name: 'a requirement cell naming a requirement but no criterion of it',
    files: {
      [DESIGN_PATH]: design({
        criteria: [BASE.criteria[0], BASE.criteria[1], ['AC-3', BASE.criteria[2][1], 'REQ-1', BASE.criteria[2][2]]],
      }),
      [REVIEW_PATH]: review(),
    },
    exit: 1,
    includes: ['acceptance criterion AC-3', 'names requirement "REQ-1", which is not one REQ-<n>.AC-<m>'],
    excludes: ['ELIGIBLE: 4 of 4 gates passed', 'trace check failed'],
  },
  {
    // An empty cell is not "carries nothing"; it is a link nobody wrote down.
    n: 90,
    name: 'an empty requirement cell',
    files: {
      [DESIGN_PATH]: design({
        criteria: [BASE.criteria[0], ['AC-2', BASE.criteria[1][1], '', BASE.criteria[1][2]], BASE.criteria[2]],
      }),
      [REVIEW_PATH]: review(),
    },
    exit: 1,
    includes: ['acceptance criterion AC-2', 'has an empty "Requirement" cell'],
    excludes: ['ELIGIBLE: 4 of 4 gates passed', 'trace check failed'],
  },
  {
    // Two columns with the same name is two answers to one question, and which
    // one the gate reads must not be decided by their order.
    n: 91,
    name: 'two Requirement columns',
    files: {
      [DESIGN_PATH]: design({
        criteriaBlock: [
          row(['ID', 'Criterion', 'Requirement', 'Requirement', 'Source']),
          sep(5),
          ...BASE.criteria.map((c, i) => row([c[0], c[1], `REQ-1.AC-${i + 1}`, `REQ-2.AC-${i + 1}`, c[2]])),
        ],
      }),
      [REVIEW_PATH]: review(),
    },
    exit: 1,
    includes: ['carries 2 "Requirement" columns'],
    excludes: ['ELIGIBLE: 4 of 4 gates passed'],
  },
  {
    // The column is found by name, so a team that puts it last is not failed for
    // its column order.
    n: 92,
    name: 'the Requirement column in a different position — must pass',
    files: {
      [DESIGN_PATH]: design({
        criteriaBlock: [
          row(['ID', 'Criterion', 'Source', 'Requirement']),
          sep(4),
          ...BASE.criteria.map((c, i) => row([c[0], c[1], c[2], `REQ-1.AC-${i + 1}`])),
        ],
      }),
      [REVIEW_PATH]: review(),
    },
    exit: 0,
    includes: ['ELIGIBLE: 4 of 4 gates passed'],
  },
  {
    // `REQ-01.AC-1` and `REQ-1.AC-1` are one requirement criterion written two
    // ways, and string comparison in the report makes them two.
    n: 93,
    name: 'a requirement id with a leading zero',
    files: {
      [DESIGN_PATH]: design({
        criteria: [['AC-1', BASE.criteria[0][1], 'REQ-01.AC-1', BASE.criteria[0][2]], BASE.criteria[1], BASE.criteria[2]],
      }),
      [REVIEW_PATH]: review(),
    },
    exit: 1,
    includes: ['names requirement "REQ-01.AC-1", which is not one REQ-<n>.AC-<m>'],
    excludes: ['ELIGIBLE: 4 of 4 gates passed'],
  },
  {
    // Several design criteria may carry the same requirement criterion: a
    // requirement is often refined into more than one observable behaviour. What
    // a cell may not hold is two of them.
    n: 94,
    name: 'two criteria carrying the same requirement pass; a cell carrying two requirements fails',
    files: {
      [DESIGN_PATH]: design({
        criteria: [
          ['AC-1', BASE.criteria[0][1], 'REQ-2.AC-1', BASE.criteria[0][2]],
          ['AC-2', BASE.criteria[1][1], 'REQ-2.AC-1', BASE.criteria[1][2]],
          ['AC-3', BASE.criteria[2][1], 'REQ-2.AC-1, REQ-2.AC-2', BASE.criteria[2][2]],
        ],
      }),
      [REVIEW_PATH]: review(),
    },
    exit: 1,
    includes: ['acceptance criterion AC-3', 'names requirement "REQ-2.AC-1, REQ-2.AC-2", which is not one REQ-<n>.AC-<m>'],
    excludes: ['acceptance criterion AC-2 (', 'ELIGIBLE: 4 of 4 gates passed'],
  },

  /* -- The rules a design was written under ---------------------------------- */
  {
    // A design that read no rules looks like a design for a repository with none.
    // The line makes the difference visible, and the sprint reads it back to
    // report whether the rules have moved since.
    n: 95,
    name: 'the design never says which rules it was written under',
    files: { [DESIGN_PATH]: design({ rules: null }), [REVIEW_PATH]: review() },
    exit: 1,
    includes: ['never says which rules it was written under', 'expected exactly one "Rules: none" or "Rules: <repository-id>@<12-hex>:<path>" line'],
    excludes: ['ELIGIBLE: 4 of 4 gates passed'],
  },
  {
    n: 96,
    name: 'the design carries two rules lines',
    files: { [DESIGN_PATH]: design({ rules: [RULES, 'none'] }), [REVIEW_PATH]: review() },
    exit: 1,
    includes: ['carries 2 "Rules:" lines', `"${RULES}" on line`, '"none" on line', 'written under one set of rules'],
  },
  {
    n: 97,
    name: 'the rules line still carries the template placeholder',
    files: { [DESIGN_PATH]: design({ rules: '<none | REPOSITORY-ID@12-hex:path>' }), [REVIEW_PATH]: review() },
    exit: 1,
    includes: ['"Rules: <none | REPOSITORY-ID@12-hex:path>" is neither', 'copy the line scripts/read-spoke-rules.mjs prints'],
  },
  {
    // Prose is not a citation. "the usual conventions" names nothing a sprint can
    // re-read, so the gate refuses it as it refuses "approved ✅".
    n: 98,
    name: 'the rules line is prose, not none or a citation',
    files: { [DESIGN_PATH]: design({ rules: 'the usual conventions' }), [REVIEW_PATH]: review() },
    exit: 1,
    includes: ['"Rules: the usual conventions" is neither'],
  },
  {
    // A citation into another repository's rules is the wrong-repository bug in
    // a second place: the design would be built to conventions its code never
    // meets.
    n: 99,
    name: 'the rules line cites a different repository from the Repository line',
    files: { [DESIGN_PATH]: design({ rules: 'ledger-service@0123456789ab:docs/rules' }), [REVIEW_PATH]: review() },
    exit: 1,
    includes: ['"Rules:" cites "ledger-service"', `this design lands in "${REPO}"`, "written under its own repository's rules"],
  },
  {
    // Seven hex characters is a git abbreviation, not the grammar. The reader
    // prints twelve, and a copied line has twelve.
    n: 100,
    name: 'the rules citation carries a short commit',
    files: { [DESIGN_PATH]: design({ rules: `${REPO}@0123456:docs/rules` }), [REVIEW_PATH]: review() },
    exit: 1,
    includes: [`"Rules: ${REPO}@0123456:docs/rules" is neither`],
  },
  {
    // A repository that declares RULES_INDEX=none, or has not configured it, has
    // no folder to cite. `none` is the literal token for that, and it passes.
    n: 101,
    name: 'the rules line is the literal none — must pass',
    files: { [DESIGN_PATH]: design({ rules: 'none' }), [REVIEW_PATH]: review() },
    exit: 0,
    includes: ['ELIGIBLE: 4 of 4 gates passed'],
  },
  {
    // The same mask that blanks a fenced Repository line blanks a fenced Rules
    // line: an example in a code block is not a claim about the design.
    n: 102,
    name: 'the only rules line is inside a code fence',
    files: {
      [DESIGN_PATH]: design({ rules: null, appendix: fenced(`Rules: ${RULES}`) }),
      [REVIEW_PATH]: review(),
    },
    exit: 1,
    includes: ['never says which rules it was written under'],
    excludes: ['ELIGIBLE: 4 of 4 gates passed'],
  },
  /* -- The context documents a design was written against -------------------- */
  {
    // A design that read no context documents looks like a design for which none
    // bind. The line makes the difference visible, and a reviewer can trace which
    // contract or decision shaped it.
    n: 103,
    name: 'the design never says which context documents it was written against',
    files: { [DESIGN_PATH]: design({ context: null }), [REVIEW_PATH]: review() },
    exit: 1,
    includes: ['never says which context documents it was written against', 'expected exactly one "Context: none" or "Context: <id>@<12-hex>:<path>, <id>@<12-hex>:<repository-id>:<path>" line'],
    excludes: ['ELIGIBLE: 4 of 4 gates passed'],
  },
  {
    n: 104,
    name: 'the design carries two context lines',
    files: { [DESIGN_PATH]: design({ context: [CONTEXT, 'none'] }), [REVIEW_PATH]: review() },
    exit: 1,
    includes: ['carries 2 "Context:" lines', `"${CONTEXT}" on line`, '"none" on line', 'written against one set of context documents'],
  },
  {
    n: 105,
    name: 'the context line still carries the template placeholder',
    files: { [DESIGN_PATH]: design({ context: '<none | id, id>' }), [REVIEW_PATH]: review() },
    exit: 1,
    includes: ['"Context: <none | id, id>" is neither', 'copy the line scripts/read-context.mjs prints'],
    excludes: ['is not a context entry'],
  },
  {
    // Prose is not a list of ids. "the usual contracts" names nothing a reviewer
    // can open, so the gate refuses it and says which words are not ids.
    n: 106,
    name: 'the context line is prose, not none or a list of ids',
    files: { [DESIGN_PATH]: design({ context: 'the usual contracts' }), [REVIEW_PATH]: review() },
    exit: 1,
    includes: ['"Context: the usual contracts" is neither', '"the usual contracts" is not a context entry'],
  },
  {
    // The script joins ids with ", ". A list typed with a bare comma is a line
    // somebody typed, not the one the script printed.
    n: 107,
    name: 'the context ids are joined by a bare comma',
    files: { [DESIGN_PATH]: design({ context: 'ledger-postings-api,ADR-004' }), [REVIEW_PATH]: review() },
    exit: 1,
    includes: ['"ledger-postings-api,ADR-004" is not a context entry'],
  },
  {
    // A document name is lowercase. "Ledger-API" is a title somebody wrote, not
    // an id the script selected; the one uppercase form is a decision record's.
    n: 108,
    name: 'the context line names an id in capitals',
    files: { [DESIGN_PATH]: design({ context: 'Ledger-API, ADR-004' }), [REVIEW_PATH]: review() },
    exit: 1,
    includes: ['"Ledger-API" is not a context entry'],
    excludes: ['"ADR-004" is not'],
  },
  {
    n: 109,
    name: 'the context line lists none beside a document id',
    files: { [DESIGN_PATH]: design({ context: 'none, ADR-004' }), [REVIEW_PATH]: review() },
    exit: 1,
    includes: ['lists "none" beside document ids', 'stands alone'],
  },
  {
    n: 110,
    name: 'the context line names one document twice',
    files: { [DESIGN_PATH]: design({ context: 'ADR-004, ledger-postings-api, ADR-004' }), [REVIEW_PATH]: review() },
    exit: 1,
    includes: ['names "ADR-004" more than once'],
  },
  {
    // When nothing binds, the script prints `Context: none`, and that passes.
    n: 111,
    name: 'the context line is the literal none — must pass',
    files: { [DESIGN_PATH]: design({ context: 'none', uses: null }), [REVIEW_PATH]: review(), [ITEM_PATH]: workItem({ context: 'none' }) },
    exit: 0,
    includes: ['ELIGIBLE: 4 of 4 gates passed'],
  },
  {
    // The same mask that blanks a fenced Rules line blanks a fenced Context line:
    // an example in a code block is not a claim about the design.
    n: 112,
    name: 'the only context line is inside a code fence',
    files: {
      [DESIGN_PATH]: design({ context: null, appendix: fenced(`Context: ${CONTEXT}`) }),
      [REVIEW_PATH]: review(),
    },
    exit: 1,
    includes: ['never says which context documents it was written against'],
    excludes: ['ELIGIBLE: 4 of 4 gates passed'],
  },
  /* -- Each context entry pins the bytes it read and says where the file is --- */
  {
    // The form before the pin and the path. A design approved under it must not
    // be refused by an upgrade, so it passes -- with a note that says what is
    // missing and how to get it.
    n: 113,
    name: 'the context line names documents by id alone, the earlier form — passes with a note',
    files: { [DESIGN_PATH]: design({ context: 'ADR-004, ledger-postings-api' }), [REVIEW_PATH]: review() },
    exit: 0,
    includes: ['ELIGIBLE: 4 of 4 gates passed', 'note:', 'names its documents by id alone', 're-run scripts/read-context.mjs'],
  },
  {
    // One line is one run of the script, which prints one form. A line that
    // carries both was edited by hand.
    n: 114,
    name: 'the context line mixes a pinned entry with a bare id',
    files: { [DESIGN_PATH]: design({ context: `${ADR_ENTRY}, ledger-postings-api` }), [REVIEW_PATH]: review() },
    exit: 1,
    includes: ['mixes entries with a pin and a path and bare ids ("ledger-postings-api")'],
  },
  {
    // A hub document the trunk does not hold was read from somebody's branch,
    // or never existed. Either way nobody merged what the design was written
    // against.
    n: 115,
    name: 'a hub entry cites a path that is not on the trunk',
    files: {
      [DESIGN_PATH]: design({ context: `std-sql-style@0123456789ab:docs/standards/std-sql-style.md` }),
      [REVIEW_PATH]: review(),
    },
    exit: 1,
    includes: ['"std-sql-style" cites docs/standards/std-sql-style.md, which is not on origin/main', 'merge the document first'],
  },
  {
    // The decision record changed after the design read it. That is a fact the
    // person picking the work up must see, and it is not the gate's to judge:
    // a note, and the gate still passes.
    n: 116,
    name: 'a hub document moved after the design read it — passes with a context-drift note',
    files: { [DESIGN_PATH]: design(), [REVIEW_PATH]: review() },
    thenChange: { [ADR_PATH]: `${ADR_BODY}\nAmended: the read model is cached.\n` },
    exit: 0,
    includes: [
      'ELIGIBLE: 4 of 4 gates passed',
      `note: context drift: "ADR-004" (${ADR_PATH}) was ${gitBlob(ADR_BODY).slice(0, 12)} when the design read it and is ${gitBlob(`${ADR_BODY}\nAmended: the read model is cached.\n`).slice(0, 12)} on origin/main now`,
    ],
  },
  {
    // A design reads the hub's documents and its own repository's. A contract
    // kept in another repository was not in its window.
    n: 117,
    name: 'a repository entry names a repository other than the design\'s own',
    files: {
      [DESIGN_PATH]: design({ context: `${ADR_ENTRY}, ledger-postings-api@0123456789ab:ledger-service:contracts/ledger-postings-api.md` }),
      [REVIEW_PATH]: review(),
    },
    exit: 1,
    includes: ['is kept in "ledger-service"; this design lands in "transfer-service"'],
  },
  {
    // The pin is exactly twelve lowercase hex characters, as the script prints
    // it. A shorter pin, or one in capitals, was typed.
    n: 118,
    name: 'a context entry carries a short pin',
    files: { [DESIGN_PATH]: design({ context: `ADR-004@0123abc:${ADR_PATH}` }), [REVIEW_PATH]: review() },
    exit: 1,
    includes: [`"ADR-004@0123abc:${ADR_PATH}" is not a context entry`],
  },
  {
    // A path that climbs out of the repository names no document in it.
    n: 119,
    name: 'a context entry path climbs out of the repository',
    files: { [DESIGN_PATH]: design({ context: 'ADR-004@0123456789ab:docs/../../etc/passwd' }), [REVIEW_PATH]: review() },
    exit: 1,
    includes: ['"ADR-004@0123456789ab:docs/../../etc/passwd" is not a context entry'],
  },
  {
    // A folder is not a document. The entry names a file, as the script prints it.
    n: 120,
    name: 'a hub entry cites a folder, not a document',
    files: { [DESIGN_PATH]: design({ context: 'ADR-004@0123456789ab:docs/architecture' }), [REVIEW_PATH]: review() },
    exit: 1,
    includes: ['"ADR-004" cites docs/architecture, which is a tree on origin/main, not a document'],
  },
  {
    // check-design-amend.mjs: the valid control. The design and its review are
    // on the pushed branch /dev-spec cut, the checkout is on it and in step, and
    // nothing of it is on the trunk.
    n: 121,
    name: 'amend start: an open, unmerged design branch may be amended',
    files: {},
    branch: { name: AMEND_BRANCH, files: valid() },
    checkout: AMEND_BRANCH,
    amend: true,
    exit: 0,
    includes: ['[PASS] branch', '[PASS] working tree', '[PASS] in step with the remote', '[PASS] design and review', '[PASS] not merged', 'start commit:', `design:       ${DESIGN_PATH} @ `, 'AMENDMENT START OK'],
  },
  {
    // Started from the trunk, the run is a first design, never an amendment.
    // The refusal names the branch to check out, read from the remote.
    n: 122,
    name: 'amend start: refused on the trunk, naming the branch to check out',
    files: {},
    branch: { name: AMEND_BRANCH, files: valid() },
    amend: true,
    exit: 1,
    includes: ['[FAIL] branch', `the checkout is on "main"; an amendment starts on the branch the open design pull request is from. Check out "${AMEND_BRANCH}" and re-run`, `skipped: the checkout is not on a feature/${KEY}-<branch-slug> branch`, 'AMENDMENT REFUSED: 3 of 5 rules failed'],
    excludes: ['AMENDMENT START OK', 'is behind'],
  },
  {
    // A branch cut for another work item is not this design's branch, and the
    // remote has none for this key to name.
    n: 123,
    name: 'amend start: refused on another work item\'s branch',
    files: {},
    branch: { name: 'feature/PROJ-413-audit-trail', files: valid() },
    checkout: 'feature/PROJ-413-audit-trail',
    amend: true,
    exit: 1,
    includes: ['[FAIL] branch', `origin has no branch feature/${KEY}-<branch-slug>, so no design pull request can be open for ${KEY}`],
    excludes: ['AMENDMENT START OK'],
  },
  {
    // The run commits what it writes and nothing else, so it starts clean --
    // anywhere in the tree, a hand edit to the design included.
    n: 124,
    name: 'amend start: refused on a dirty working tree, naming each file',
    files: {},
    branch: { name: AMEND_BRANCH, files: valid() },
    checkout: AMEND_BRANCH,
    dirty: { [DESIGN_PATH]: design({ appendix: 'A hand edit.' }), 'notes/answers.md': 'answers typed somewhere\n' },
    amend: true,
    exit: 1,
    includes: ['[FAIL] working tree', `${DESIGN_PATH} (not committed)`, 'notes/answers.md (untracked)'],
    excludes: ['AMENDMENT START OK'],
  },
  {
    // Someone pushed to the pull request since this checkout was pulled. The
    // amendment must start from what the reviewer read.
    n: 125,
    name: 'amend start: refused when the checkout is behind the remote branch',
    files: {},
    branch: { name: AMEND_BRANCH, files: valid() },
    checkout: AMEND_BRANCH,
    setup: (work) => {
      writeFiles(work, { 'docs/designs/CLAR-log.md': 'a later push\n' });
      git(work, ['add', '-A']);
      git(work, ['commit', '-q', '-m', 'a later push']);
      git(work, ['push', '-q', 'origin', AMEND_BRANCH]);
      git(work, ['reset', '-q', '--hard', 'HEAD~1']);
    },
    amend: true,
    exit: 1,
    includes: ['[FAIL] in step with the remote', `is behind origin/${AMEND_BRANCH}`, 'Pull first'],
    excludes: ['AMENDMENT START OK'],
  },
  {
    // A local commit nobody has seen in the pull request.
    n: 126,
    name: 'amend start: refused when the checkout is ahead of the remote branch',
    files: {},
    branch: { name: AMEND_BRANCH, files: valid() },
    checkout: AMEND_BRANCH,
    setup: (work) => {
      writeFiles(work, { 'docs/designs/CLAR-log.md': 'a local commit\n' });
      git(work, ['add', '-A']);
      git(work, ['commit', '-q', '-m', 'a local commit']);
    },
    amend: true,
    exit: 1,
    includes: ['[FAIL] in step with the remote', `is ahead of origin/${AMEND_BRANCH}`, 'Push them, or drop them'],
    excludes: ['AMENDMENT START OK'],
  },
  {
    // A local commit on one side, a pushed one on the other.
    n: 127,
    name: 'amend start: refused when the checkout and the remote branch have gone apart',
    files: {},
    branch: { name: AMEND_BRANCH, files: valid() },
    checkout: AMEND_BRANCH,
    setup: (work) => {
      writeFiles(work, { 'docs/designs/CLAR-log.md': 'pushed by someone else\n' });
      git(work, ['add', '-A']);
      git(work, ['commit', '-q', '-m', 'a push']);
      git(work, ['push', '-q', 'origin', AMEND_BRANCH]);
      git(work, ['reset', '-q', '--hard', 'HEAD~1']);
      writeFiles(work, { 'docs/designs/CLAR-log.md': 'a local commit\n' });
      git(work, ['add', '-A']);
      git(work, ['commit', '-q', '-m', 'a local commit']);
    },
    amend: true,
    exit: 1,
    includes: ['[FAIL] in step with the remote', 'have gone apart'],
    excludes: ['AMENDMENT START OK'],
  },
  {
    // A branch pushed nowhere has no pull request.
    n: 128,
    name: 'amend start: refused when the branch is not on the remote',
    files: {},
    setup: (work) => {
      git(work, ['checkout', '-q', '-b', AMEND_BRANCH]);
      writeFiles(work, bindRevisions(valid()));
      git(work, ['add', '-A']);
      git(work, ['commit', '-q', '-m', 'design never pushed']);
    },
    amend: true,
    exit: 1,
    includes: ['[FAIL] in step with the remote', `origin has no branch "${AMEND_BRANCH}", so no pull request can be open from it`],
    excludes: ['AMENDMENT START OK'],
  },
  {
    // The design without its review is a first run that stopped early.
    n: 129,
    name: 'amend start: refused when the branch carries no review',
    files: {},
    branch: { name: AMEND_BRANCH, files: { [DESIGN_PATH]: design() } },
    checkout: AMEND_BRANCH,
    amend: true,
    exit: 1,
    includes: ['[FAIL] design and review', `HEAD carries no ${REVIEW_PATH}`, 'finish the first run of /dev-spec'],
    excludes: ['AMENDMENT START OK'],
  },
  {
    n: 130,
    name: 'amend start: refused when the branch carries no design',
    files: {},
    branch: { name: AMEND_BRANCH, files: { [REVIEW_PATH]: review() } },
    checkout: AMEND_BRANCH,
    amend: true,
    exit: 1,
    includes: ['[FAIL] design and review', `HEAD carries no ${DESIGN_PATH}; there is nothing to amend`],
    excludes: ['AMENDMENT START OK'],
  },
  {
    // Merged with a merge commit: the branch's tip is on the trunk.
    n: 131,
    name: 'amend start: refused when the pull request was merged',
    files: {},
    branch: { name: AMEND_BRANCH, files: valid() },
    checkout: AMEND_BRANCH,
    setup: (work) => {
      git(work, ['checkout', '-q', 'main']);
      git(work, ['merge', '-q', '--no-ff', '-m', 'merge the design', AMEND_BRANCH]);
      git(work, ['push', '-q', 'origin', 'main']);
      git(work, ['checkout', '-q', AMEND_BRANCH]);
    },
    amend: true,
    exit: 1,
    includes: ['[FAIL] not merged', `is already on origin/main: the pull request was merged`, 'a merged design changes only by a human amendment on the trunk'],
    excludes: ['AMENDMENT START OK'],
  },
  {
    // Squash-merged: no commit is shared, and the design on the trunk is what
    // shows it. There is one design per work item.
    n: 132,
    name: 'amend start: refused when the pull request was squash-merged',
    files: {},
    branch: { name: AMEND_BRANCH, files: valid() },
    checkout: AMEND_BRANCH,
    setup: (work) => {
      git(work, ['checkout', '-q', 'main']);
      git(work, ['merge', '-q', '--squash', AMEND_BRANCH]);
      git(work, ['commit', '-q', '-m', 'docs(PROJ-412): design (#16)']);
      git(work, ['push', '-q', 'origin', 'main']);
      git(work, ['checkout', '-q', AMEND_BRANCH]);
    },
    amend: true,
    exit: 1,
    includes: ['[FAIL] not merged', `origin/main already carries ${DESIGN_PATH}, and there is one design per work item`],
    excludes: ['AMENDMENT START OK', 'is already on origin/main'],
  },
  {
    // The key is the whole argument, in the gate's grammar.
    n: 133,
    name: 'amend start: a malformed key is a usage error',
    files: {},
    branch: { name: AMEND_BRANCH, files: valid() },
    checkout: AMEND_BRANCH,
    amend: true,
    args: ['proj-412'],
    exit: 3,
    includes: ['"proj-412" is not a work-item key', 'usage:'],
    excludes: ['AMENDMENT START OK'],
  },
  {
    // An unreachable remote is a refusal to judge, not a finding.
    n: 134,
    name: 'amend start: an unreachable remote cannot be verified',
    files: {},
    branch: { name: AMEND_BRANCH, files: valid() },
    checkout: AMEND_BRANCH,
    breakRemote: true,
    amend: true,
    exit: 2,
    includes: ['CANNOT VERIFY: could not reach origin', 'REASON: remote-unreachable'],
    excludes: ['AMENDMENT START OK'],
  },
  {
    // The trunk named must be the remote's default branch.
    n: 135,
    name: 'amend start: a trunk that is not the remote\'s default branch cannot be verified',
    files: {},
    branch: { name: AMEND_BRANCH, files: valid() },
    checkout: AMEND_BRANCH,
    env: { HARNESS_TRUNK: 'develop' },
    amend: true,
    exit: 2,
    includes: ['CANNOT VERIFY: the check was pointed at "develop" but origin\'s default branch is "main"', 'REASON: trunk-mismatch'],
    excludes: ['AMENDMENT START OK'],
  },
  {
    // Run from inside the tree, as from the designs folder of the hub checkout.
    n: 136,
    name: 'amend start: run from a subdirectory, the same answer',
    files: {},
    branch: { name: AMEND_BRANCH, files: valid() },
    checkout: AMEND_BRANCH,
    from: 'docs/designs',
    amend: true,
    exit: 0,
    includes: ['AMENDMENT START OK'],
  },
  // ------------------------------------------------- the trace to the work item
  //
  // Every design criterion is one the work item defines, and every Requirement
  // id is one the work item's Carries column holds. The work item's ids were
  // resolved against the requirements document when the decomposition merged, so
  // these cases are what stops an id nobody defined from reaching the report.
  {
    // A well-formed id nobody defined. Before the trace, shape was all the gate
    // read, so this passed and the validation report repeated it as fact.
    n: 137,
    name: 'a requirement id the work item does not carry (made up)',
    files: {
      [DESIGN_PATH]: design({
        criteria: [BASE.criteria[0], ['AC-2', BASE.criteria[1][1], 'REQ-999.AC-1', BASE.criteria[1][2]], BASE.criteria[2]],
      }),
      [REVIEW_PATH]: review(),
    },
    exit: 1,
    includes: [`AC-2 names REQ-999.AC-1, but ${ITEM_PATH} gives AC-2 REQ-1.AC-2`, 'Copy the requirement id from the work item'],
    excludes: ['ELIGIBLE: 4 of 4 gates passed', 'AC-1 names', 'AC-3 names'],
  },
  {
    // A criterion of the design's own, with its test and its counts in order, so
    // the trace is the only finding: no requirement asked for it.
    n: 138,
    name: 'a design criterion the work item does not have',
    files: {
      [DESIGN_PATH]: design({
        criteria: [...BASE.criteria, ['AC-4', 'A transfer below the threshold demands no second factor.', 'REQ-1.AC-3', 'FSD Authentication L119']],
        tests: [...BASE.tests, ['AC-4', 'test_transfer::test_no_step_up_below_threshold', 'unit', 'no challenge is issued']],
        readiness: readinessSet({ 'AC count': '4', 'AC covered by tests': '4' }),
      }),
      [REVIEW_PATH]: review(),
    },
    exit: 1,
    includes: [`AC-4 is not in the work item ${ITEM_PATH}`, "Use the work item's criterion ids"],
    excludes: ['ELIGIBLE: 4 of 4 gates passed', 'integrity check failed', 'AC-4 names'],
  },
  {
    // A design with nothing to trace to is untraced, not traced by default.
    n: 139,
    name: 'no work item on the trunk',
    files: valid(),
    noItem: true,
    exit: 1,
    includes: [`trace check failed: work item ${KEY}.item.md not found under docs/backlog/ on origin/main`, 'Merge the work item first'],
    excludes: ['ELIGIBLE: 4 of 4 gates passed'],
  },
  {
    // Markup that keeps content in the file and off the page is refused in the
    // work item as it is in the design.
    n: 140,
    name: 'a work item whose criteria are collapsed inside <details>',
    files: {
      ...valid(),
      [ITEM_PATH]: workItem({ block: ['<details>', '', ...itemTable(ITEM_CRITERIA), '', '</details>'] }),
    },
    exit: 1,
    includes: [`${ITEM_PATH} carries HTML <details> markup`],
    excludes: ['ELIGIBLE: 4 of 4 gates passed'],
  },

  {
    // Two real ids swapped between two criteria. Each id is in the work item, so
    // only a comparison with the row's own criterion sees it.
    n: 141,
    name: 'two criteria with their requirement ids swapped',
    files: {
      [DESIGN_PATH]: design({
        criteria: [
          ['AC-1', BASE.criteria[0][1], 'REQ-1.AC-2', BASE.criteria[0][2]],
          ['AC-2', BASE.criteria[1][1], 'REQ-1.AC-1', BASE.criteria[1][2]],
          BASE.criteria[2],
        ],
      }),
      [REVIEW_PATH]: review(),
    },
    exit: 1,
    includes: [
      `AC-1 names REQ-1.AC-2, but ${ITEM_PATH} gives AC-1 REQ-1.AC-1`,
      `AC-2 names REQ-1.AC-1, but ${ITEM_PATH} gives AC-2 REQ-1.AC-2`,
    ],
    excludes: ['ELIGIBLE: 4 of 4 gates passed', 'AC-3 names'],
  },
  {
    // A work item with no Carries column names no requirement for any criterion,
    // so the design's ids cannot be traced: a failure, not a pass.
    n: 142,
    name: 'a work item with no Carries column',
    files: {
      ...valid(),
      [ITEM_PATH]: workItem({
        block: [row(['ID', 'Criterion', 'Type', 'Source']), sep(4), ...ITEM_CRITERIA.map(([id]) => row([id, `The criterion ${id} states.`, 'positive', 'requirements § REQ-1 L80']))],
      }),
    },
    exit: 1,
    includes: [`trace check failed: ${ITEM_PATH}: the "Acceptance criteria" table`, 'has 0 "Carries" columns, not one'],
    excludes: ['ELIGIBLE: 4 of 4 gates passed'],
  },
  {
    // A work item whose criteria section is renamed has no criteria the gate can
    // read, so nothing in the design can be traced: a failure, not a pass.
    n: 143,
    name: 'a work item whose criteria section is renamed',
    files: {
      ...valid(),
      [ITEM_PATH]: workItem({ heading: 'Criteria' }),
    },
    exit: 1,
    includes: [`trace check failed: ${ITEM_PATH}: no "## Acceptance criteria" section`],
    excludes: ['ELIGIBLE: 4 of 4 gates passed'],
  },
  {
    // The design drops one of the work item's criteria and keeps its own tables
    // and counts in step, so only the trace sees the criterion that went missing.
    n: 144,
    name: "a design that drops one of the work item's criteria",
    files: {
      [DESIGN_PATH]: design({
        criteria: BASE.criteria.slice(0, 2),
        tests: BASE.tests.slice(0, 2),
        readiness: readinessSet({ 'AC count': '2', 'AC covered by tests': '2' }),
      }),
      [REVIEW_PATH]: review(),
    },
    exit: 1,
    includes: [`trace check failed: AC-3 in ${ITEM_PATH} is not in ${DESIGN_PATH}. Carry every work item criterion into the design`],
    excludes: ['ELIGIBLE: 4 of 4 gates passed', 'integrity check failed'],
  },
  {
    // The design pins bytes of a document the trunk holds, but the commit its
    // Hub commit: line names holds other bytes there: it was written from
    // somebody's unmerged edit. A drift note would let it through to
    // /dev-sprint, which stops it there.
    n: 145,
    name: 'a hub entry pins bytes the commit on the Hub commit: line does not hold',
    files: {
      [DESIGN_PATH]: design({ context: `ADR-004@${UNMERGED_ADR_PIN}:${ADR_PATH}` }),
      [REVIEW_PATH]: review(),
    },
    exit: 1,
    includes: [`"ADR-004" pins ${UNMERGED_ADR_PIN} for ${ADR_PATH}, and the hub at `, 'the commit the Hub commit: line names, holds ', 'the two lines were not copied from one run', 'copy the Hub commit: and Context: lines it prints'],
    excludes: ['ELIGIBLE: 4 of 4 gates passed', 'note: context drift'],
  },
  {
    // The document moved after the design read it, and the clone is shallow:
    // the gate cannot tell drift from bytes nobody merged, so it does not judge.
    n: 146,
    name: 'a hub document moved after the design read it, in a shallow clone — cannot verify',
    files: { [DESIGN_PATH]: design(), [REVIEW_PATH]: review() },
    thenChange: { [ADR_PATH]: `${ADR_BODY}\nAmended: the read model is cached.\n` },
    shallow: true,
    exit: 2,
    includes: ['CANNOT VERIFY', 'this clone is shallow', 'REASON: shallow-clone'],
  },
  {
    // A standard is named std-<topic>. An entry that names one by the number it
    // carried before cites a file that has left the trunk, so the gate says how
    // to write a fresh line rather than calling it a malformed entry.
    n: 147,
    name: 'the context line names a standard by number, the form before std-<topic>',
    files: {
      [DESIGN_PATH]: design({ context: `${ADR_ENTRY}, STD-001@0123456789ab:docs/standards/STD-001-sql-style.md` }),
      [REVIEW_PATH]: review(),
    },
    exit: 1,
    includes: ['names "STD-001", a standard by number, the form before standards were named std-<topic>', 're-run scripts/read-context.mjs'],
    excludes: ['is not a context entry'],
  },

  /* ------------------------------------- context documents: use, and the story */

  {
    // A line alone does not show that a document was read.
    n: 148,
    name: 'the design lists a contract it never names',
    files: { [DESIGN_PATH]: design({ uses: 'Eligibility is read from one model, as ADR-004 decides.' }), [REVIEW_PATH]: review() },
    exit: 1,
    includes: ['"ledger-postings-api" is on the "Context:" line and named nowhere else in the design'],
  },
  {
    // The reverse: a decision record the design names, it read, so the line pins it.
    n: 149,
    name: 'the design names a decision record its line does not list',
    files: {
      [DESIGN_PATH]: design({ context: CONTRACT_ENTRY }),
      [REVIEW_PATH]: review(),
      [ITEM_PATH]: workItem({ context: 'none' }),
    },
    exit: 1,
    includes: ['names ADR-004, and its "Context:" line does not list it'],
  },
  {
    // A standard is used by its rules: naming it is not enough.
    n: 150,
    name: 'a standard on the line, none of its rules cited',
    files: {
      [STD_PATH]: STD_BODY,
      [DESIGN_PATH]: design({ context: `${CONTEXT}, ${STD_ENTRY}`, uses: `${USES} The challenge follows std-auth.` }),
      [REVIEW_PATH]: review(),
    },
    exit: 1,
    includes: ['"std-auth" is a standard on the "Context:" line, and the design cites none of its rules', 'std-auth.<NN>'],
  },
  {
    n: 151,
    name: 'the design cites a rule the standard does not define',
    files: {
      [STD_PATH]: STD_BODY,
      [DESIGN_PATH]: design({ context: `${CONTEXT}, ${STD_ENTRY}`, uses: `${USES} The outcome is recorded under std-auth.01, and a code expires under std-auth.09.` }),
      [REVIEW_PATH]: review(),
    },
    exit: 1,
    includes: [`cites std-auth.09, which ${STD_PATH} on origin/main does not define`],
    excludes: ['cites std-auth.01,'],
  },
  {
    n: 152,
    name: 'the design cites a rule of a standard its line does not list',
    files: { [DESIGN_PATH]: design({ uses: `${USES} Logs follow std-logging.02.` }), [REVIEW_PATH]: review() },
    exit: 1,
    includes: ['cites std-logging.02, and its "Context:" line does not list std-logging'],
  },
  {
    n: 153,
    name: 'a standard on the line, cited by a rule it defines — must pass',
    files: {
      [STD_PATH]: STD_BODY,
      [DESIGN_PATH]: design({ context: `${CONTEXT}, ${STD_ENTRY}`, uses: `${USES} The outcome is recorded under std-auth.01.` }),
      [REVIEW_PATH]: review(),
    },
    exit: 0,
    includes: ['ELIGIBLE: 4 of 4 gates passed'],
  },
  {
    // The story's documents are a floor: the design was written against at
    // least what its story was.
    n: 154,
    name: 'a document on the story\'s line is missing from the design\'s',
    files: {
      [STD_PATH]: STD_BODY,
      [DESIGN_PATH]: design(),
      [REVIEW_PATH]: review(),
      [ITEM_PATH]: workItem({ context: `${ADR_ENTRY}, ${STD_ENTRY}` }),
    },
    exit: 1,
    includes: [`${ITEM_PATH} carries "std-auth" on its "Context:" line, and ${DESIGN_PATH} does not`],
    excludes: ['carries "ADR-004" on its'],
  },
  {
    n: 155,
    name: 'the story carries no Context: line',
    files: { [DESIGN_PATH]: design(), [REVIEW_PATH]: review(), [ITEM_PATH]: workItem({ context: null }) },
    exit: 1,
    includes: [`${ITEM_PATH} carries no single well-formed "Context:" line`],
  },
  {
    // Compared by id: the design may read a document at newer bytes than the
    // story did, and that is the design's to weigh, not a failure.
    n: 156,
    name: 'the story pinned older bytes of a document the design carries — must pass',
    files: { [DESIGN_PATH]: design(), [REVIEW_PATH]: review(), [ITEM_PATH]: workItem({ context: `ADR-004@${UNMERGED_ADR_PIN}:${ADR_PATH}` }) },
    exit: 0,
    includes: ['ELIGIBLE: 4 of 4 gates passed'],
  },
  {
    // A repository keeps decision records of its own: <repository-id>.ADR-<NNN>,
    // kept in the repository, checked for shape and id as its contracts are.
    n: 157,
    name: "the design's own repository's decision record, on the line and cited in full — must pass",
    files: { [DESIGN_PATH]: design({ context: `${CONTEXT}, ${SPOKE_RECORD_ENTRY}`, uses: `${USES} A charge is retried as ${REPO}.ADR-002 decides, within ADR-004.` }), [REVIEW_PATH]: review() },
    exit: 0,
    includes: ['ELIGIBLE: 4 of 4 gates passed'],
  },
  {
    n: 158,
    name: "the design cites its repository's decision record, and its line does not list it",
    files: { [DESIGN_PATH]: design({ uses: `${USES} A charge is retried as ${REPO}.ADR-002 decides.` }), [REVIEW_PATH]: review() },
    exit: 1,
    includes: [`names ${REPO}.ADR-002, and its "Context:" line does not list it`],
  },
  {
    // The id says where the record is kept, and the entry must agree with it.
    n: 159,
    name: "a repository's decision record placed in the hub, and the hub's record placed in the repository",
    files: {
      [DESIGN_PATH]: design({ context: `${CONTEXT}, ${REPO}.ADR-002@0123456789ab:decisions/ADR-002-retries.md, ADR-009@0123456789ab:${REPO}:decisions/ADR-009-queues.md`, uses: `${USES} ${REPO}.ADR-002 and ADR-009 apply.` }),
      [REVIEW_PATH]: review(),
    },
    exit: 1,
    includes: [`is a decision record of "${REPO}" and the entry places it in the hub`, `places the hub's decision record ADR-009 in "${REPO}"`],
  },
  {
    // A dot joins a record's number to its repository: the spoke's ADR-004 is not
    // a use of the hub's ADR-004.
    n: 160,
    name: "the design names only the repository's ADR-004, and its line lists only the hub's ADR-004",
    files: { [DESIGN_PATH]: design({ uses: `The ledger write keeps the ledger-postings-api contract, and retries follow ${REPO}.ADR-004.` }), [REVIEW_PATH]: review() },
    exit: 1,
    includes: ['"ADR-004" is on the "Context:" line and named nowhere else in the design', `names ${REPO}.ADR-004, and its "Context:" line does not list it`],
  },
  // ---------------------------------------------------------- the global layer
  // Fixtures 161 to 182: global Context: entries (docs/proposals/global-context.md
  // §8). Each builds a real bare global repository with release tags, and reads
  // it through its own bare cache. The hub's link file, key ledger, list of
  // repositories and the requirements document of the work item's slug come
  // from globalHub().
  {
    // A hub without docs/estate/global.json sees no change, and nothing global is read.
    n: 161,
    name: 'global: a hub without global.json and no global entry — must pass, no global repository read',
    files: valid(),
    noGlobalRead: true,
    exit: 0,
    includes: ['ELIGIBLE: 4 of 4 gates passed'],
  },
  {
    n: 162,
    name: 'global: a hub without global.json and a global entry',
    global: true,
    files: { ...globalHub({ link: null }), ...globalDesign(G_ADR_ENTRY, G_ADR_USE) },
    noGlobalRead: true,
    exit: 1,
    includes: ['"global.ADR-012" cites the global layer, and origin/main carries no docs/estate/global.json, so this hub has no global layer'],
  },
  {
    n: 163,
    name: 'global: a global record at the recorded commit, used on the page — must pass',
    global: true,
    files: { ...globalHub(), ...globalDesign(G_ADR_ENTRY, G_ADR_USE) },
    exit: 0,
    includes: ['ELIGIBLE: 4 of 4 gates passed'],
    // The design pins no discovery map, so the gate's note on that is expected.
    // No note on the global entries is.
    excludes: ['global entr', 'checked for form and release only'],
  },
  {
    n: 164,
    name: 'global: a global standard, cited by a rule it defines — must pass',
    global: true,
    files: { ...globalHub(), ...globalDesign(G_STD_ENTRY, G_STD_USE) },
    exit: 0,
    includes: ['ELIGIBLE: 4 of 4 gates passed'],
  },
  {
    n: 165,
    name: 'global: a global standard cited by a rule it does not define',
    global: true,
    files: { ...globalHub(), ...globalDesign(G_STD_ENTRY, 'Every error is logged, as global.std-go.07 requires.') },
    exit: 1,
    includes: [`cites global.std-go.07, which ${G_STD_PATH} does not define in the global repository`],
  },
  {
    // Rule 1: a global id only in the global form, the global form only around a global id.
    n: 166,
    name: 'global: a global id in the hub form and in the spoke form, and a hub id in the global form',
    global: true,
    files: {
      ...globalHub(),
      ...globalDesign([`global.ADR-012@${GP2}:${G_ADR_PATH}`, `global.std-go@${GP2}:${REPO}:${G_STD_PATH}`, `std-auth@${GP2}:global:${STD_PATH}`], `${G_ADR_USE} ${G_STD_USE} Its outcome is recorded under std-auth.01.`),
    },
    exit: 1,
    includes: [
      'is a global document and the entry places it in the hub. A global entry is <id>@<12-hex>:global:<path>',
      `is a global document and the entry places it in "${REPO}"`,
      'places std-auth in the global layer, and a global document\'s id starts with "global."',
    ],
  },
  {
    // Rule 2: a design cites the global release its feature records, never another.
    n: 167,
    name: 'global: an entry that pins another global commit than the Global: line records',
    global: true,
    files: { ...globalHub(), ...globalDesign(gEntry('global.ADR-012', G_ADR_PATH, GP1), G_ADR_USE) },
    exit: 1,
    includes: ['pins the global commit', `and ${`docs/requirements/${ITEM_SLUG}/requirements.md`} records v1.4.0 at`, 'An artefact cites the global release its feature records'],
  },
  {
    // Rule 3: the path is at the commit, and its header names the entry's id.
    n: 168,
    name: 'global: a path that is not at the commit, and a header that names another id',
    global: true,
    files: {
      ...globalHub(),
      ...globalDesign([gEntry('global.ADR-099', 'docs/architecture/ADR-099-missing.md'), gEntry('global.ADR-013', G_ADR_PATH)], 'global.ADR-099 and global.ADR-013 apply.'),
    },
    exit: 1,
    includes: ['"global.ADR-099" cites docs/architecture/ADR-099-missing.md, which is not in the global repository at v1.4.0', `"global.ADR-013" cites ${G_ADR_PATH}, and its header in the global repository at v1.4.0`, 'names "ADR-012", not "ADR-013"'],
  },
  {
    // Rule 4: each global record, standard rule and exception the page cites is on the line.
    n: 169,
    name: 'global: global ids named on the page and missing from the line',
    global: true,
    files: { ...globalHub(), ...globalDesign([], `${G_ADR_USE} ${G_STD_USE} The session cache is covered by global.EXC-004.`) },
    exit: 1,
    includes: ['names global.ADR-012, and its "Context:" line does not list it', 'cites global.std-go.01, and its "Context:" line does not list global.std-go', 'names global.EXC-004, and its "Context:" line does not list it'],
  },
  {
    // Rule 4: each global id on the line is named on the page, a standard by a rule.
    n: 170,
    name: 'global: global ids on the line and not used on the page',
    global: true,
    files: { ...globalHub(), ...globalDesign([G_ADR_ENTRY, G_STD_ENTRY]) },
    exit: 1,
    includes: ['"global.ADR-012" is on the "Context:" line and named nowhere else in the design', '"global.std-go" is a global standard on the "Context:" line, and the design cites none of its rules'],
  },
  {
    // Rule 5: an Active exception for this hub, beside the record it departs from.
    n: 171,
    name: 'global: an Active exception for this hub, with the record it departs from on the line — must pass',
    global: true,
    files: { ...globalHub(), ...globalDesign([G_ADR_ENTRY, gExcEntry('004')], gExcUse('004')) },
    exit: 0,
    includes: ['ELIGIBLE: 4 of 4 gates passed'],
    excludes: ['stale exception'],
  },
  {
    n: 172,
    name: 'global: a Withdrawn exception',
    global: true,
    files: { ...globalHub(), ...globalDesign([G_ADR_ENTRY, gExcEntry('005')], gExcUse('005')) },
    exit: 1,
    includes: ['"global.EXC-005" is Withdrawn in the global repository at v1.4.0', 'only an Active exception has effect'],
  },
  {
    n: 173,
    name: 'global: an exception for another hub',
    global: true,
    files: { ...globalHub(), ...globalDesign([G_ADR_ENTRY, gExcEntry('006')], gExcUse('006')) },
    exit: 1,
    includes: [`"global.EXC-006" names the hubs SIM, not this hub, ${HUB_PREFIX}`],
    excludes: ['shared spoke'],
  },
  {
    n: 174,
    name: 'global: an exception whose departed record is not on the line',
    global: true,
    files: { ...globalHub(), ...globalDesign(gExcEntry('004'), 'The session cache stays in process under global.EXC-004.') },
    exit: 1,
    includes: ['"global.EXC-004" departs from global.ADR-012, and global.ADR-012 is not on the line'],
  },
  {
    // D13: past its review date, the exception is reported stale and still has effect.
    n: 175,
    name: 'global: an exception past its review-by date — must pass, with a note',
    global: true,
    files: { ...globalHub(), ...globalDesign([G_ADR_ENTRY, gExcEntry('007')], gExcUse('007')) },
    exit: 0,
    includes: ['note: stale exception: "global.EXC-007" passed its review-by date, 2020-01-01', 'ELIGIBLE: 4 of 4 gates passed'],
  },
  {
    // §9.1: the exception covers a repository this hub also lists, and does not name this hub.
    n: 176,
    name: 'global: an exception that covers a shared spoke and does not name this hub',
    global: true,
    files: { ...globalHub(), ...globalDesign([G_ADR_ENTRY, gExcEntry('008')], gExcUse('008')) },
    exit: 1,
    includes: [`"global.EXC-008" covers ${REPO}, which this hub also lists in docs/estate/repositories.json, and names the hubs SIM, not ${HUB_PREFIX}`, 'An exception that covers a shared spoke names every hub that owns it'],
  },
  {
    // An exception that departs from a rule of a standard sits beside the standard.
    n: 177,
    name: 'global: an exception that departs from a global standard rule, with the standard on the line — must pass',
    global: true,
    files: { ...globalHub(), ...globalDesign([G_STD_ENTRY, gExcEntry('009')], `${G_STD_USE} One error path is left bare under global.EXC-009.`) },
    exit: 0,
    includes: ['ELIGIBLE: 4 of 4 gates passed'],
  },
  {
    // The story-gate mode: a spoke asks with a credential that cannot read the
    // global repository (D8). The link points where no repository is, so a read
    // would exit 2, and no cache is made.
    n: 178,
    name: 'global: story-gate mode, HARNESS_REPO set, a valid global entry — must pass, no global repository read',
    global: true,
    files: { ...globalHub({ link: globalLink('<GLOBAL-MISSING>') }), ...globalDesign([G_ADR_ENTRY, gExcEntry('004')], gExcUse('004')) },
    env: { HARNESS_REPO: REPO },
    noGlobalRead: true,
    exit: 0,
    includes: [`asked by ${REPO}`, `2 global entries checked for form and release only, as ${REPO} asks without the global repository`, 'ELIGIBLE: 4 of 4 gates passed'],
  },
  {
    n: 179,
    name: 'global: story-gate mode, an entry that pins another commit than the Global: line — no global repository read',
    global: true,
    files: { ...globalHub({ link: globalLink('<GLOBAL-MISSING>') }), ...globalDesign(gEntry('global.ADR-012', G_ADR_PATH, GP1), G_ADR_USE) },
    env: { HARNESS_REPO: REPO },
    noGlobalRead: true,
    exit: 1,
    includes: ['pins the global commit', 'records v1.4.0 at'],
    excludes: ['CANNOT VERIFY'],
  },
  {
    // Rule 6: a global repository that does not answer is exit 2, never a guess.
    n: 180,
    name: 'global: the global repository does not answer — exit 2',
    global: true,
    files: { ...globalHub({ link: globalLink('<GLOBAL-MISSING>') }), ...globalDesign(G_ADR_ENTRY, G_ADR_USE) },
    exit: 2,
    includes: ['CANNOT VERIFY: cannot reach the global repository', 'REASON: remote-unreachable'],
    excludes: ['ELIGIBLE', 'NOT ELIGIBLE'],
  },
  {
    n: 181,
    name: 'global: a global entry, and the requirements document records "Global: none"',
    global: true,
    files: { ...globalHub({ global: 'none' }), ...globalDesign(G_ADR_ENTRY, G_ADR_USE) },
    exit: 1,
    includes: [`and docs/requirements/${ITEM_SLUG}/requirements.md records "Global: none", so the feature reads no global release`],
  },
  {
    // The global layer came after the pin and the path: no bare global id was ever approved.
    n: 182,
    name: 'global: a global id named by id alone',
    global: true,
    files: { ...globalHub(), [DESIGN_PATH]: design({ context: 'ADR-004, global.ADR-012', uses: `${USES} ${G_ADR_USE}` }), [REVIEW_PATH]: review() },
    exit: 1,
    includes: ['names "global.ADR-012" by id alone. A global entry is <id>@<12-hex>:global:<path>'],
  },
  {
    // A global record listed by its path, as the template asks: the path holds a bare
    // ADR-012, which names no hub record, as read-context.mjs reads it too.
    n: 183,
    name: 'global: a global record listed by its path and its id, the bare id inside the file name',
    global: true,
    files: { ...globalHub(), ...globalDesign(G_ADR_ENTRY, `${G_ADR_USE} Read \`${G_ADR_PATH}\` (\`global.ADR-012\`), in the global repository.`) },
    exit: 0,
    includes: ['ELIGIBLE'],
    excludes: ['names ADR-012'],
  },

  /* --------------------------------------------- context documents: always on */

  {
    // read-context.mjs adds an always-on document to every line, whatever ids
    // it is given, so a design that does not use one is not a failure.
    n: 184,
    name: 'an always-on decision record on the line and named nowhere in the design — must pass',
    files: { [ALWAYS_PATH]: ALWAYS_BODY, [DESIGN_PATH]: design({ context: `${CONTEXT}, ${alwaysEntry(ALWAYS_BODY)}` }), [REVIEW_PATH]: review() },
    exit: 0,
    includes: ['ELIGIBLE: 4 of 4 gates passed'],
    excludes: ['named nowhere else'],
  },
  {
    n: 185,
    name: 'an always-on standard on the line, none of its rules cited — must pass',
    files: { [STD_PATH]: ALWAYS_STD_BODY, [DESIGN_PATH]: design({ context: `${CONTEXT}, std-auth@${gitBlob(ALWAYS_STD_BODY).slice(0, 12)}:${STD_PATH}` }), [REVIEW_PATH]: review() },
    exit: 0,
    includes: ['ELIGIBLE: 4 of 4 gates passed'],
    excludes: ['cites none of its rules'],
  },
  {
    // The script adds an always-on record only while it is in force.
    n: 186,
    name: 'an always-on decision record that is not Accepted, named nowhere in the design',
    files: { [ALWAYS_PATH]: DEPRECATED_BODY, [DESIGN_PATH]: design({ context: `${CONTEXT}, ${alwaysEntry(DEPRECATED_BODY)}` }), [REVIEW_PATH]: review() },
    exit: 1,
    includes: ['"ADR-008" is on the "Context:" line and named nowhere else in the design'],
  },
  {
    // The bytes the design was written against decide, not the bytes on the trunk now.
    n: 187,
    name: 'an always-on record that is no longer always on after the design read it — must pass, with a drift note',
    files: { [ALWAYS_PATH]: ALWAYS_BODY, [DESIGN_PATH]: design({ context: `${CONTEXT}, ${alwaysEntry(ALWAYS_BODY)}` }), [REVIEW_PATH]: review() },
    thenChange: { [ALWAYS_PATH]: ALWAYS_BODY.replace('alwaysApply: true', 'alwaysApply: false') },
    exit: 0,
    includes: ['context drift: "ADR-008"', 'ELIGIBLE: 4 of 4 gates passed'],
  },
  {
    n: 188,
    name: 'global: an always-on global record on the line and named nowhere in the design — must pass',
    global: true,
    files: { ...globalHub(), ...globalDesign(gEntry('global.ADR-015', G_ALWAYS_PATH)) },
    exit: 0,
    includes: ['ELIGIBLE: 4 of 4 gates passed'],
    excludes: ['named nowhere else'],
  },
  {
    // design-gate proved the use of each global entry; story-gate cannot read
    // the global repository, so it cannot tell an always-on record from another.
    n: 189,
    name: 'global: story-gate mode, an always-on global record named nowhere in the design — must pass, no global repository read',
    global: true,
    files: { ...globalHub({ link: globalLink('<GLOBAL-MISSING>') }), ...globalDesign(gEntry('global.ADR-015', G_ALWAYS_PATH)) },
    env: { HARNESS_REPO: REPO },
    noGlobalRead: true,
    exit: 0,
    includes: ['1 global entry checked for form and release only', 'ELIGIBLE: 4 of 4 gates passed'],
    excludes: ['named nowhere else'],
  },
  // The Hub commit: line on a design (PLDC-526): the trunk commit the hub's
  // documents were read at, beside the Context: line.
  {
    n: 190,
    name: 'hub commit: no Hub commit: line',
    files: { [DESIGN_PATH]: design({ hubCommit: null }), [REVIEW_PATH]: review() },
    exit: 1,
    includes: ['[FAIL] design document', 'never says which hub commit its context documents were read at', 'expected exactly one "Hub commit: <40-hex>", as scripts/read-context.mjs prints it beside the Context: line'],
    excludes: ['ELIGIBLE: 4 of 4 gates passed'],
  },
  {
    n: 191,
    name: 'hub commit: two Hub commit: lines',
    files: { [DESIGN_PATH]: design({ hubCommit: [HUB_COMMIT, 'a'.repeat(40)] }), [REVIEW_PATH]: review() },
    exit: 1,
    includes: ['carries 2 "Hub commit:" lines', 'a design reads the hub at one commit'],
  },
  {
    n: 192,
    name: 'hub commit: not a full commit hash',
    files: { [DESIGN_PATH]: design({ hubCommit: 'abcdef123456' }), [REVIEW_PATH]: review() },
    exit: 1,
    includes: ['"Hub commit: abcdef123456" is not a full commit hash, 40 lowercase hex characters'],
  },
  {
    n: 193,
    name: 'hub commit: a commit the trunk does not hold',
    files: { [DESIGN_PATH]: design({ hubCommit: 'a'.repeat(40) }), [REVIEW_PATH]: review() },
    exit: 1,
    includes: [`"Hub commit: ${'a'.repeat(40)}" names a commit origin/main does not hold`, 'the design was written against a hub nobody merged', 'copy the Hub commit: and Context: lines it prints'],
  },
  {
    // A clone of depth 1 cannot see the commit before the design's own: the
    // gate refuses rather than guess.
    n: 194,
    name: 'hub commit: a shallow clone cannot see the Hub commit — cannot verify',
    files: { [DESIGN_PATH]: design(), [REVIEW_PATH]: review() },
    shallow: true,
    exit: 2,
    includes: ['CANNOT VERIFY', 'names a commit this clone cannot see, and this clone is shallow', 'fetch full history (fetch-depth: 0)', 'REASON: shallow-clone'],
  },
  {
    // A design that reads no hub document still records the commit it read the
    // hub at: the line says that nothing bound at that commit.
    n: 195,
    name: 'hub commit: Context: none beside a Hub commit: line — must pass',
    files: { [DESIGN_PATH]: design({ context: 'none', uses: null }), [REVIEW_PATH]: review(), [ITEM_PATH]: workItem({ context: 'none' }) },
    exit: 0,
    includes: ['ELIGIBLE: 4 of 4 gates passed'],
  },

  /* ---- a story taken from a Jira ticket: docs/backlog/jira/, JIRA-<KEY>.AC-<m> ---- */

  {
    // The control for a ticket story: the item sits under the reserved slug and
    // carries its own ticket's criteria, and the design repeats them.
    n: 196,
    name: 'a story taken from a ticket, traced to its own criteria — must pass',
    noItem: true,
    files: {
      [DESIGN_PATH]: design({ criteria: TICKET_DESIGN_CRITERIA }),
      [REVIEW_PATH]: review(),
      [TICKET_ITEM_PATH]: workItem({ criteria: TICKET_CRITERIA }),
    },
    exit: 0,
    includes: ['ELIGIBLE: 4 of 4 gates passed'],
  },
  {
    // Under the ticket slug, a requirements document's criterion is not this
    // story's: nothing proved it exists.
    n: 197,
    name: 'a ticket story carrying REQ ids',
    noItem: true,
    files: { ...valid(), [TICKET_ITEM_PATH]: workItem() },
    exit: 1,
    includes: [`trace check failed: ${TICKET_ITEM_PATH}: line`, `carries "REQ-1.AC-1", which is not one JIRA-${KEY}.AC-<m>`],
    excludes: ['ELIGIBLE: 4 of 4 gates passed'],
  },
  {
    n: 198,
    name: "a ticket story carrying another ticket's criteria",
    noItem: true,
    files: {
      [DESIGN_PATH]: design({ criteria: BASE.criteria.map((c, i) => [c[0], c[1], `JIRA-PROJ-9.AC-${i + 1}`, c[2]]) }),
      [REVIEW_PATH]: review(),
      [TICKET_ITEM_PATH]: workItem({ criteria: TICKET_CRITERIA.map(([id], i) => [id, `JIRA-PROJ-9.AC-${i + 1}`]) }),
    },
    exit: 1,
    includes: [`carries "JIRA-PROJ-9.AC-1", which is not one JIRA-${KEY}.AC-<m>`],
    excludes: ['ELIGIBLE: 4 of 4 gates passed'],
  },
  {
    // A decomposed story carries a requirements document's criteria only.
    n: 199,
    name: 'a decomposed story carrying ticket ids',
    files: {
      [DESIGN_PATH]: design({ criteria: TICKET_DESIGN_CRITERIA }),
      [REVIEW_PATH]: review(),
      [ITEM_PATH]: workItem({ criteria: TICKET_CRITERIA }),
    },
    exit: 1,
    includes: [`carries "JIRA-${KEY}.AC-1", which is not one REQ-<n>.AC-<m>`],
    excludes: ['ELIGIBLE: 4 of 4 gates passed'],
  },
  {
    // Two stories wearing one key. The gate used to trace to neither and say
    // nothing; it now says so.
    n: 200,
    name: 'two work items for one key',
    files: { ...valid(), [TICKET_ITEM_PATH]: workItem({ criteria: TICKET_CRITERIA }) },
    exit: 1,
    includes: [`trace check failed: 2 work items are filed as ${KEY}.item.md`],
    excludes: ['ELIGIBLE: 4 of 4 gates passed'],
  },
  {
    // PLDC-686: GitHub drops the cells past the header's count, so the second
    // row of two on one line disappears from the rendered design.
    n: 201,
    name: 'two rows on one line in a table of the design that the gate does not read by name',
    files: { [DESIGN_PATH]: design({ appendix: notesTable([`${NOTE_ROWS[0]} ${NOTE_ROWS[1]}`]) }), [REVIEW_PATH]: review() },
    exit: 1,
    includes: [`${DESIGN_PATH} line `, 'the table row has 7 cells and its header', 'has 3; write one row on one line, and a literal pipe in a cell as \\|'],
    excludes: ['ELIGIBLE: 4 of 4 gates passed'],
  },
  {
    n: 202,
    name: 'a row of the work item with fewer cells than its header',
    files: { ...valid(), [ITEM_PATH]: workItem({ block: [...itemTable(ITEM_CRITERIA), '', notesTable([NOTE_ROWS[0], row(['Risk', 'The cap may change'])])] }) },
    exit: 1,
    includes: [`${ITEM_PATH} line `, 'the table row has 2 cells and its header'],
    excludes: ['ELIGIBLE: 4 of 4 gates passed'],
  },
  {
    // An escaped pipe is one cell, and a pipe line in a code fence is not a row.
    n: 203,
    name: 'an escaped pipe in a cell and a pipe line in a code fence — must pass',
    files: { [DESIGN_PATH]: design({ appendix: [notesTable([NOTE_ROWS[0], row(['Format', 'A value is written a \\| b', 'house style'])]), '', '```', '| a | b | c | d |', '```'].join('\n') }), [REVIEW_PATH]: review() },
    exit: 0,
    includes: ['ELIGIBLE: 4 of 4 gates passed'],
  },

  /* -- The Prime Security guardrails a design chose ----------------------------- */
  {
    // The citation prime.mjs choose prints: the fingerprint, then the ids.
    n: 204,
    name: 'a design that chose two Prime guardrails passes',
    files: { [DESIGN_PATH]: design({ guardrails: `prime@a83f0c51d9e2:${GUARDRAIL_A}, ${GUARDRAIL_B}` }), [REVIEW_PATH]: review() },
    exit: 0,
    includes: ['ELIGIBLE: 4 of 4 gates passed'],
  },
  {
    // The words off, none and unchecked are one list in the gate. unchecked is the
    // one that matters most: a skipped check is said, never hidden.
    n: 205,
    name: 'Guardrails: unchecked passes',
    files: { [DESIGN_PATH]: design({ guardrails: 'unchecked' }), [REVIEW_PATH]: review() },
    exit: 0,
    includes: ['ELIGIBLE: 4 of 4 gates passed'],
  },
  {
    n: 206,
    name: 'the guardrails line is prose, not a word or a citation',
    files: { [DESIGN_PATH]: design({ guardrails: 'the usual OWASP ones' }), [REVIEW_PATH]: review() },
    exit: 1,
    includes: ['"Guardrails: the usual OWASP ones" is not off, none, unchecked or prime@<12-hex>:<id>, <id>', 'copy the line scripts/prime.mjs choose prints'],
    excludes: ['ELIGIBLE: 4 of 4 gates passed'],
  },
  {
    // A guardrail named by its title is the bug the ids prevent: Prime renames titles.
    n: 207,
    name: 'the guardrails citation names a title, not a Prime id',
    files: { [DESIGN_PATH]: design({ guardrails: `prime@a83f0c51d9e2:${GUARDRAIL_A}, Secure Cookie Attribute Required` }), [REVIEW_PATH]: review() },
    exit: 1,
    includes: ['names "Secure Cookie Attribute Required", which is not a Prime guardrail id'],
  },
  {
    n: 208,
    name: 'the design carries two guardrails lines',
    files: { [DESIGN_PATH]: design({ guardrails: ['none', 'off'] }), [REVIEW_PATH]: review() },
    exit: 1,
    includes: ['carries 2 "Guardrails:" lines', 'a design chooses its guardrails once'],
  },
  {
    n: 209,
    name: 'the guardrails citation names one id twice',
    files: { [DESIGN_PATH]: design({ guardrails: `prime@a83f0c51d9e2:${GUARDRAIL_A}, ${GUARDRAIL_A}` }), [REVIEW_PATH]: review() },
    exit: 1,
    includes: [`names ${GUARDRAIL_A} more than once`],
  },
  {
    // The control of the discovery map: the design pins its map, the map is on
    // the trunk at those bytes, and the one spoke path the design cites is read.
    n: 210,
    name: 'a design that pins a valid discovery map — must pass',
    files: mapped(),
    exit: 0,
    includes: ['ELIGIBLE: 4 of 4 gates passed'],
    excludes: ['no discovery map'],
  },
  {
    // A design written before /dev-spec wrote maps: no line and no map passes,
    // with a note, so an installed hub's approved designs stay eligible.
    n: 211,
    name: 'no discovery line and no map — passes with a note',
    files: valid(),
    exit: 0,
    includes: ['ELIGIBLE: 4 of 4 gates passed', `note: no discovery map for ${KEY}. The design was written before /dev-spec wrote maps. A new design pins one.`],
  },
  {
    n: 212,
    name: 'no discovery line, and a map for the key on the trunk',
    files: mapped({ d: { discovery: null } }),
    exit: 1,
    includes: [`${DESIGN_PATH} carries no "Discovery:" line, and ${MAP_PATH} is on origin/main`, 'pin it from the design'],
    excludes: ['ELIGIBLE: 4 of 4 gates passed', 'no discovery map for'],
  },
  {
    // The map moved after the design pinned it: the design was written from
    // bytes that are no longer the map.
    n: 213,
    name: 'the map changed after the design pinned it',
    files: mapped(),
    thenChange: { [MAP_PATH]: discoveryMap({ filesRead: [...MAP_FILES_READ, ['src/transfer/limits.ts', '0f1e2d3c4b5a', 'holds the threshold']] }) },
    exit: 1,
    includes: ["the map changed after the design pinned it. Copy the first 12 characters of the map's new `git hash-object` value into the design. Then the design needs a new review."],
    excludes: ['ELIGIBLE: 4 of 4 gates passed'],
  },
  {
    n: 214,
    name: "the discovery line pins another story's map",
    files: mapped({ d: { discovery: `${EARLIER_KEY}.discovery.md@${MAP_TOKEN}` } }),
    exit: 1,
    includes: [`"Discovery: ${EARLIER_KEY}.discovery.md@`, `pins the map of ${EARLIER_KEY}`],
    excludes: ['ELIGIBLE: 4 of 4 gates passed'],
  },
  {
    n: 215,
    name: 'two discovery lines',
    files: mapped({ d: { discovery: [MAP_LINE, MAP_LINE] } }),
    exit: 1,
    includes: [`${DESIGN_PATH} carries 2 "Discovery:" lines`],
    excludes: ['ELIGIBLE: 4 of 4 gates passed'],
  },
  {
    n: 216,
    name: 'a discovery line whose value is not a pin',
    files: mapped({ d: { discovery: 'see the map' } }),
    exit: 1,
    includes: ['"Discovery: see the map" is not "Discovery: PROJ-412.discovery.md@<12-hex>"'],
    excludes: ['ELIGIBLE: 4 of 4 gates passed'],
  },
  {
    n: 217,
    name: "the map's Ticket line names another key",
    files: mapped({ m: { ticket: EARLIER_KEY } }),
    exit: 1,
    includes: [`${MAP_PATH} line 3: "Ticket: ${EARLIER_KEY}" is not ${KEY}`],
    excludes: ['ELIGIBLE: 4 of 4 gates passed'],
  },
  {
    n: 218,
    name: "the map's Repository line names another repository",
    files: mapped({ m: { repository: 'ledger-service' } }),
    exit: 1,
    includes: [`${MAP_PATH} line 4: "Repository: ledger-service" is not ${REPO}`],
    excludes: ['ELIGIBLE: 4 of 4 gates passed'],
  },
  {
    // The design read the rules at one commit and the code at another.
    n: 219,
    name: "the map's commit does not start with the design's Rules: commit",
    files: mapped({ m: { commit: 'fedcba9876543210fedcba9876543210fedcba98' } }),
    exit: 1,
    includes: [`${MAP_PATH} line 5: "Commit: fedcba9876543210fedcba9876543210fedcba98" does not start with 0123456789ab`],
    excludes: ['ELIGIBLE: 4 of 4 gates passed'],
  },
  {
    n: 220,
    name: 'the map reads no files: Files read is NONE',
    files: mapped({ m: { filesRead: 'NONE' } }),
    exit: 1,
    includes: [`${MAP_PATH}: the "Files read" section is NONE`],
    excludes: ['ELIGIBLE: 4 of 4 gates passed'],
  },
  {
    n: 221,
    name: 'a Why cell that is a placeholder',
    files: mapped({ m: { filesRead: [[MAP_FILE, '1a2b3c4d5e6f', 'TBD']] } }),
    exit: 1,
    includes: [`${MAP_PATH} line 11: the "Why" cell "TBD" is empty or a placeholder`],
    excludes: ['ELIGIBLE: 4 of 4 gates passed'],
  },
  {
    n: 222,
    name: 'a blob of 11 characters',
    files: mapped({ m: { filesRead: [[MAP_FILE, '1a2b3c4d5e6', 'holds the posting call']] } }),
    exit: 1,
    includes: [`${MAP_PATH} line 11: the blob "1a2b3c4d5e6" is not 12 lowercase hex characters`],
    excludes: ['ELIGIBLE: 4 of 4 gates passed'],
  },
  {
    // One finding for each path, and the path is judged by its shape alone.
    n: 223,
    name: 'a path with a .. segment and a path with a space',
    files: mapped({ m: { filesRead: [...MAP_FILES_READ, ['../secrets.ts', '0f1e2d3c4b5a', 'read by mistake'], ['src/a b.ts', '0f1e2d3c4b5b', 'read for the layout']] } }),
    exit: 1,
    includes: [
      `${MAP_PATH} line 12: the path "../secrets.ts" is not a relative path in the repository`,
      `${MAP_PATH} line 13: the path "src/a b.ts" is not a relative path in the repository`,
    ],
    excludes: ['ELIGIBLE: 4 of 4 gates passed', 'is not on origin/main', 'a citation needs a read'],
  },
  {
    n: 224,
    name: 'a search that is not a read-spoke.mjs search',
    files: mapped({ m: { searches: [...MAP_SEARCHES, ['`grep -r postLedger src`', '2', '0']] } }),
    exit: 1,
    includes: [`${MAP_PATH} line 18: the search "grep -r postLedger src" is not a scripts/read-spoke.mjs search`],
    excludes: ['ELIGIBLE: 4 of 4 gates passed'],
  },
  {
    n: 225,
    name: 'a search that keeps more hits than it found',
    files: mapped({ m: { searches: [[MAP_SEARCH, '3', '4']] } }),
    exit: 1,
    includes: [`${MAP_PATH} line 17: "Kept" is 4 and "Hits" is 3`],
    excludes: ['ELIGIBLE: 4 of 4 gates passed'],
  },
  {
    n: 226,
    name: 'a path ruled out by a search the map does not list',
    files: mapped({ m: { ruledOut: [['src/ledger/legacy.ts', '6f5e4d3c2b1a', '`--grep legacyPost --paths src/**`', 'dead code']] } }),
    exit: 1,
    includes: [`${MAP_PATH} line 23: the search "--grep legacyPost --paths src/**" is not in the "Searches" table`],
    excludes: ['ELIGIBLE: 4 of 4 gates passed'],
  },
  {
    n: 227,
    name: 'the design cites a spoke path the map does not read',
    files: mapped({ d: { appendix: `The limit check sits at ${REPO}@0123456789ab:src/other.ts L1-4.` } }),
    exit: 1,
    includes: [`cites ${REPO}@0123456789ab:src/other.ts, and ${MAP_PATH} does not list src/other.ts under "Files read"`, 'a citation needs a read at this commit'],
    excludes: ['ELIGIBLE: 4 of 4 gates passed', `does not list ${MAP_FILE}`],
  },
  {
    // Two stories in one area: the second map reuses the first map's rows. One
    // file is the same, and one moved, so the second story read it again.
    n: 228,
    name: "a map that reuses an earlier story's map, one row current and one drifted — must pass",
    files: mapped({
      m: {
        filesRead: [...MAP_FILES_READ, ['src/ledger/client.ts', 'ab12cd34ef56', 'the ledger client moved since PROJ-411 read it']],
        reused: [
          [`${EARLIER_KEY}.discovery.md@${EARLIER_PIN}`, 'src/ledger/types.ts', 'current'],
          [`${EARLIER_KEY}.discovery.md@${EARLIER_PIN}`, 'src/ledger/client.ts', 'drift: dd44ee55ff66 → ab12cd34ef56'],
        ],
      },
      extra: { [EARLIER_MAP_PATH]: EARLIER_MAP },
    }),
    exit: 0,
    includes: ['ELIGIBLE: 4 of 4 gates passed'],
  },
  {
    n: 229,
    name: 'a reused map pin that no commit on the trunk held',
    files: mapped({
      m: { reused: [[`${EARLIER_KEY}.discovery.md@0badc0ffee00`, 'src/ledger/types.ts', 'current']] },
      extra: { [EARLIER_MAP_PATH]: EARLIER_MAP },
    }),
    exit: 1,
    includes: [`no commit on origin/main ever held ${EARLIER_MAP_PATH} at 0badc0ffee00`],
    excludes: ['ELIGIBLE: 4 of 4 gates passed'],
  },
  {
    n: 230,
    name: 'a drifted reused row whose path the map does not read again',
    files: mapped({
      m: { reused: [[`${EARLIER_KEY}.discovery.md@${EARLIER_PIN}`, 'src/ledger/client.ts', 'drift: dd44ee55ff66 → ab12cd34ef56']] },
      extra: { [EARLIER_MAP_PATH]: EARLIER_MAP },
    }),
    exit: 1,
    includes: ['src/ledger/client.ts drifted to ab12cd34ef56', 'a file that moved is read again'],
    excludes: ['ELIGIBLE: 4 of 4 gates passed'],
  },
  {
    // One run lists everything to fix.
    n: 231,
    name: 'every map finding at once',
    files: mapped({
      d: { appendix: `The limit check sits at ${REPO}@0123456789ab:src/other.ts L1-4.` },
      m: {
        ticket: EARLIER_KEY,
        repository: 'ledger-service',
        commit: 'fedcba9876543210fedcba9876543210fedcba98',
        filesRead: [[MAP_FILE, '1a2b3c4d5e6', 'TBD'], ['../secrets.ts', '0f1e2d3c4b5a', 'read by mistake']],
        searches: [[MAP_SEARCH, '3', '4'], ['`grep -r postLedger src`', '2', '0']],
        ruledOut: [['src/ledger/legacy.ts', '6f5e4d3c2b1a', '`--grep legacyPost --paths src/**`', 'dead code']],
        reused: [
          [`${EARLIER_KEY}.discovery.md@0badc0ffee00`, 'src/ledger/types.ts', 'current'],
          [`${EARLIER_KEY}.discovery.md@${EARLIER_PIN}`, 'src/ledger/client.ts', 'drift: dd44ee55ff66 → ab12cd34ef56'],
          [`${EARLIER_KEY}.discovery.md@${EARLIER_PIN}`, 'src/ledger/types.ts', 'moved'],
        ],
      },
      extra: { [EARLIER_MAP_PATH]: EARLIER_MAP },
    }),
    exit: 1,
    includes: [
      `"Ticket: ${EARLIER_KEY}" is not ${KEY}`,
      '"Repository: ledger-service" is not transfer-service',
      'does not start with 0123456789ab',
      'the blob "1a2b3c4d5e6" is not 12 lowercase hex characters',
      'the "Why" cell "TBD" is empty or a placeholder',
      'the path "../secrets.ts" is not a relative path in the repository',
      '"Kept" is 4 and "Hits" is 3',
      'the search "grep -r postLedger src" is not a scripts/read-spoke.mjs search',
      'the search "--grep legacyPost --paths src/**" is not in the "Searches" table',
      `no commit on origin/main ever held ${EARLIER_MAP_PATH} at 0badc0ffee00`,
      'src/ledger/client.ts drifted to ab12cd34ef56',
      'the pin "moved" is not',
      `does not list src/other.ts under "Files read"`,
    ],
    excludes: ['ELIGIBLE: 4 of 4 gates passed'],
  },
  {
    // The state of 229 in a shallow clone: the trunk does not carry the reused
    // pin now, and only the history can say whether a commit held it.
    n: 232,
    name: 'a reused map pin the trunk does not carry now, in a shallow clone — cannot verify',
    files: mapped({
      m: { reused: [[`${EARLIER_KEY}.discovery.md@0badc0ffee00`, 'src/ledger/types.ts', 'current']] },
      extra: { [EARLIER_MAP_PATH]: EARLIER_MAP },
    }),
    shallow: 2,
    exit: 2,
    includes: ['CANNOT VERIFY', `reuses ${EARLIER_MAP_PATH} at 0badc0ffee00`, 'this clone is shallow'],
    excludes: ['ELIGIBLE: 4 of 4 gates passed'],
  },
  {
    // The state of 228 in a shallow clone: the trunk carries the reused pin
    // now, so the gate does not ask the history.
    n: 233,
    name: 'a reused map pin the trunk carries now, in a shallow clone — must pass',
    files: mapped({
      m: {
        filesRead: [...MAP_FILES_READ, ['src/ledger/client.ts', 'ab12cd34ef56', 'the ledger client moved since PROJ-411 read it']],
        reused: [
          [`${EARLIER_KEY}.discovery.md@${EARLIER_PIN}`, 'src/ledger/types.ts', 'current'],
          [`${EARLIER_KEY}.discovery.md@${EARLIER_PIN}`, 'src/ledger/client.ts', 'drift: dd44ee55ff66 → ab12cd34ef56'],
        ],
      },
      extra: { [EARLIER_MAP_PATH]: EARLIER_MAP },
    }),
    shallow: 2,
    exit: 0,
    includes: ['ELIGIBLE: 4 of 4 gates passed'],
    excludes: ['CANNOT VERIFY'],
  },
  {
    // A path in a form other than the one `git ls-tree --full-name` prints names
    // the same file, and every comparison of path cells would miss it.
    n: 234,
    name: 'a map path in a form other than the one git prints (./x, a doubled slash, a ./ segment, a trailing slash)',
    files: mapped({
      m: {
        filesRead: [
          ...MAP_FILES_READ,
          ['./src/transfer/limits.ts', '0f1e2d3c4b5a', 'holds the threshold'],
          ['src//transfer/fees.ts', '1f1e2d3c4b5a', 'holds the fee table'],
          ['src/./transfer/rates.ts', '2f1e2d3c4b5a', 'holds the rate table'],
          ['src/transfer/', '3f1e2d3c4b5a', 'holds the transfer folder'],
        ],
      },
    }),
    exit: 1,
    includes: [
      'the path "./src/transfer/limits.ts" is not a relative path in the repository',
      'the path "src//transfer/fees.ts" is not a relative path in the repository',
      'the path "src/./transfer/rates.ts" is not a relative path in the repository',
      'the path "src/transfer/" is not a relative path in the repository',
    ],
    excludes: ['ELIGIBLE: 4 of 4 gates passed'],
  },
  {
    // The bare form of a citation: no line range after the path, and the full
    // stop that ends the sentence is not part of the path.
    n: 235,
    name: 'the design cites a spoke path in the bare form, with no line range, and the map does not read it',
    files: mapped({ d: { appendix: `The limit check sits in ${REPO}@0123456789ab:src/other.ts.` } }),
    exit: 1,
    includes: [`cites ${REPO}@0123456789ab:src/other.ts, and ${MAP_PATH} does not list src/other.ts under "Files read"`],
    excludes: ['ELIGIBLE: 4 of 4 gates passed', 'src/other.ts.,', `does not list ${MAP_FILE}`],
  },
  {
    // The state of 228, and then the earlier story's map changes on the trunk.
    // The trunk no longer carries the reused pin, and its history still does.
    n: 236,
    name: "a reused map pin that the earlier map moved away from after the reuse — must pass",
    files: mapped({
      m: {
        filesRead: [...MAP_FILES_READ, ['src/ledger/client.ts', 'ab12cd34ef56', 'the ledger client moved since PROJ-411 read it']],
        reused: [
          [`${EARLIER_KEY}.discovery.md@${EARLIER_PIN}`, 'src/ledger/types.ts', 'current'],
          [`${EARLIER_KEY}.discovery.md@${EARLIER_PIN}`, 'src/ledger/client.ts', 'drift: dd44ee55ff66 → ab12cd34ef56'],
        ],
      },
      extra: { [EARLIER_MAP_PATH]: EARLIER_MAP },
    }),
    thenChange: { [EARLIER_MAP_PATH]: discoveryMap({ key: EARLIER_KEY, ticket: EARLIER_KEY, filesRead: [['src/ledger/types.ts', 'aa11bb22cc33', 'holds the posting types and the fee type']] }) },
    exit: 0,
    includes: ['ELIGIBLE: 4 of 4 gates passed'],
    excludes: ['no commit on origin/main ever held'],
  },
];

/* ---------------------------------------------------------------------- runner */

const COMMON = {
  [ADR_PATH]: ADR_BODY,
  'package.json': `${JSON.stringify({ name: 'gate-fixture', private: true, type: 'module' }, null, 2)}\n`,
  '.gitignore': 'node_modules\n',
};

function buildRepo(root, fixture) {
  const remote = join(root, 'remote.git');
  const work = join(root, 'work');
  git(root, ['init', '--bare', '-q', 'remote.git']);
  // The bare repository's own default branch. The gate asks the remote which
  // branch is the trunk instead of trusting the environment, so a fixture remote
  // that never answers would refuse every case for the wrong reason.
  git(root, ['--git-dir', 'remote.git', 'symbolic-ref', 'HEAD', 'refs/heads/main']);
  git(root, ['init', '-q', 'work']);
  git(work, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  git(work, ['config', 'user.name', 'Fixture Runner']);
  git(work, ['config', 'user.email', 'fixture@example.invalid']);
  git(work, ['config', 'commit.gpgsign', 'false']);
  git(work, ['remote', 'add', 'origin', remote]);

  // Commit 0: the hub's context documents, as /add-context lands them. Its hash
  // is what a design's Hub commit: line names, so it exists before the design.
  writeFiles(work, COMMON);
  mkdirSync(join(work, 'scripts'), { recursive: true });
  copyFileSync(GATE, join(work, 'scripts', 'check-dev-ready.js'));
  copyFileSync(AMEND, join(work, 'scripts', 'check-design-amend.mjs'));
  // The global repository first, so its commits are known before the review
  // names the design's hash.
  const values = fixture.global ? buildGlobal(root) : null;
  const files = substitute(fixture.files || {}, values);
  const isHubDocument = (rel) => HUB_DOCUMENT_FOLDERS.some((folder) => rel.startsWith(folder));
  writeFiles(work, Object.fromEntries(Object.entries(files).filter(([rel]) => isHubDocument(rel))));
  git(work, ['add', '-A']);
  git(work, ['commit', '-q', '-m', 'hub documents']);
  const hubCommit = git(work, ['rev-parse', 'HEAD']).trim();
  const atHub = (set) => substitute(set, { [HUB_COMMIT]: hubCommit });

  // Commit 1: the work item, the design and the review, as their merges land them.
  if (!fixture.noItem) writeFiles(work, { [ITEM_PATH]: workItem() });
  writeFiles(work, bindRevisions(atHub(Object.fromEntries(Object.entries(files).filter(([rel]) => !isHubDocument(rel))))));
  writeLinks(work, fixture.symlinks || {});
  git(work, ['add', '-A']);
  git(work, ['commit', '-q', '-m', 'trunk state', '--allow-empty']);

  // Further commits on the trunk, for the cases where one artefact was changed
  // after the other was written. These are NOT rebound: the whole point of the
  // case is that the review still names the revision it actually read.
  for (const change of [].concat(fixture.thenChange || [])) {
    writeFiles(work, atHub(change));
    git(work, ['add', '-A']);
    git(work, ['commit', '-q', '-m', 'later revision']);
  }
  git(work, ['push', '-q', 'origin', 'main']);

  // A second branch, for the case where the design was never merged.
  if (fixture.branch) {
    git(work, ['checkout', '-q', '-b', fixture.branch.name]);
    writeFiles(work, bindRevisions(atHub(fixture.branch.files)));
    git(work, ['add', '-A']);
    git(work, ['commit', '-q', '-m', 'design on a feature branch']);
    git(work, ['push', '-q', 'origin', fixture.branch.name]);
    git(work, ['checkout', '-q', 'main']);
  }

  // The amendment fixtures run from a branch, as /dev-spec would, then move
  // the checkout or the remote: a later push, a local commit, a merge. Some
  // leave uncommitted files in the working tree on purpose.
  if (fixture.checkout) git(work, ['checkout', '-q', fixture.checkout]);
  if (fixture.setup) fixture.setup(work);
  if (fixture.dirty) writeFiles(work, atHub(fixture.dirty));

  // Unverifiable remote state: the ref the gate must read is unreachable.
  if (fixture.breakRemote) {
    git(work, ['remote', 'set-url', 'origin', join(root, 'no-such-remote.git')]);
  }

  // A shallow clone of the remote, for the case where history is missing on
  // purpose. `file://` is what makes --depth take effect on a local path.
  // `shallow: 2` keeps the hub-documents commit, which the Hub commit: line
  // names, so a case can reach the checks after that line.
  if (fixture.shallow) {
    const shallow = join(root, 'shallow');
    git(root, ['clone', '-q', '--depth', String(fixture.shallow === true ? 1 : fixture.shallow), `file://${remote}`, shallow]);
    return shallow;
  }
  return work;
}

function runFixture(fixture) {
  const root = mkdtempSync(join(tmpdir(), `gate-fx${String(fixture.n).padStart(2, '0')}-`));
  try {
    const work = buildRepo(root, fixture);
    // `from` runs the gate out of a subdirectory, with the path to the script
    // adjusted the way a caller in that directory would write it.
    const cwd = fixture.from ? join(work, fixture.from) : work;
    const file = fixture.amend ? 'check-design-amend.mjs' : 'check-dev-ready.js';
    const script = fixture.from
      ? `${fixture.from.split('/').map(() => '..').join('/')}/scripts/${file}`
      : `scripts/${file}`;
    // Every fixture reads the global repository through its own bare cache.
    const cache = join(root, 'cache');
    const res = spawnSync(process.execPath, [script, ...(fixture.args || [KEY])], {
      cwd, env: { ...ENV, HARNESS_SPOKE_CACHE: cache, ...(fixture.env || {}) }, encoding: 'utf8',
    });
    const output = `${res.stdout || ''}${res.stderr || ''}`;
    const problems = [];
    if (res.status !== fixture.exit) {
      problems.push(`expected exit ${fixture.exit}, got ${res.status}`);
    }
    if (fixture.noGlobalRead && existsSync(join(cache, 'global.git'))) {
      problems.push('the gate made a cache for the global repository, so it read it');
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

  process.stdout.write(`\ncheck-dev-ready fixture suite — ${selected.length} of ${FIXTURES.length} fixtures\n`);
  process.stdout.write(`gate under test: ${GATE}\n\n`);

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
      ? `\n${failed} of ${selected.length} fixtures FAILED. The gate is not trustworthy until this is green.\n\n`
      : `\nAll ${selected.length} fixtures passed.\n\n`
  );
  rmSync(SANDBOX_HOME, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
}

main();

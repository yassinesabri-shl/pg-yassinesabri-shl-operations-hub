#!/usr/bin/env node
/**
 * run.mjs — the fixture suite for check-validation.js.
 *
 *   usage:  node run.mjs            run every fixture
 *           node run.mjs 9 11       run only the numbered fixtures
 *           node run.mjs --keep     leave the throwaway repositories on disk
 *
 * A fixture here is a REPOSITORY STATE, as in the pickup gate's suite. Each case
 * builds a throwaway git repository with a real bare `origin`, commits a design to
 * the default branch, then commits a validation report that names the commit the
 * design landed in, copies the shipped check to `scripts/check-validation.js`,
 * runs it exactly as CI would, and asserts the exit code and the messages. The
 * check is never imported and never stubbed: the file under test is the file that
 * ships.
 *
 * Two placeholders are substituted when the repository is built, because the
 * report names commits that do not exist until then: `<DESIGN-COMMIT>` becomes
 * the commit the design landed in, and `<SIDE-COMMIT>` the commit a fixture put
 * on a side branch. A fixture that changes the design in a later commit is NOT
 * re-substituted: the report keeps naming the commit it really read, which is
 * the whole point of that case.
 *
 * `run.mjs` is the list. Every fixture carries its number, its name, the expected
 * exit code and a comment saying why it exists.
 *
 * Node standard library only, plus git via child_process. No test framework.
 * Exit 0 if every fixture passes, 1 if any fails.
 */

import { execFileSync, spawnSync } from 'node:child_process';
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
  resolve(HERE, '..', '..', 'scripts', 'check-validation.js'),
  resolve(HERE, '..', '..', 'scripts', 'check-validation.mjs'),
  resolve(HERE, '..', '..', 'check-validation.js'),
  resolve(HERE, '..', '..', 'check-validation.mjs'),
].filter(Boolean);

const CHECK = CHECK_CANDIDATES.find((p) => existsSync(p));

if (!CHECK) {
  console.error('cannot locate the check script. Looked in order:');
  for (const c of CHECK_CANDIDATES) console.error('  ' + c);
  console.error('\nSet HARNESS_CHECK=/path/to/check-validation.js or pass the path as argument 1.');
  process.exit(4);
}

const KEY = 'PROJ-412';
const REPO = 'transfer-service';
const TITLE = 'step-up authentication on high-value transfers';
const DESIGN_PATH = `docs/designs/${KEY}.lld.md`;
const REPORT_PATH = `docs/designs/${KEY}.validation.md`;

/* ------------------------------------------------------------------ git helpers */

const SANDBOX_HOME = mkdtempSync(join(tmpdir(), 'validation-home-'));
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

/* ------------------------------------------------------------------ the design */

const row = (cells) => `| ${cells.map((c) => String(c)).join(' | ')} |`;
const sep = (n) => `|${'---|'.repeat(n)}`;

// A table that no rule reads by name, for the fixtures of PLDC-686.
const NOTE_ROWS = [
  row(['Scope', 'Transfers above the threshold', 'the ticket']),
  row(['Timing', 'The challenge runs before the posting', 'the design']),
];
const notesTable = (rows) => ['## Notes', '', row(['Topic', 'Note', 'Source']), sep(3), ...rows].join('\n');

// A design the pickup gate would pass: the shape the report is checked against.
const CRITERIA = [
  ['AC-1', 'A transfer above the step-up threshold demands a second factor.', 'REQ-1.AC-1', 'FSD Authentication L118'],
  ['AC-2', 'A read-only advisory view inherits the existing session.', 'REQ-1.AC-2', 'FSD Authentication L124'],
  ['AC-3', 'A failed second factor writes no transfer record.', 'REQ-2.AC-1', 'FSD Authentication L131'],
];
const TESTS = [
  ['AC-1', 'test_transfer::test_step_up_demanded', 'unit', 'the challenge is issued'],
  ['AC-2', 'test_advisory::test_session_inherited', 'integration', 'no challenge is issued'],
  ['AC-3', 'test_transfer::test_failed_factor_writes_nothing', 'unit', 'the ledger is untouched'],
];

function design(overrides = {}) {
  const s = {
    heading: `# LLD — ${KEY}: ${TITLE}`,
    repository: REPO,
    criteria: CRITERIA,
    criteriaBlock: null,
    appendix: null,
    ...overrides,
  };
  const rows = (entries) => entries.map((e) => (typeof e === 'string' ? e : row(e)));
  return [
    s.heading,
    '',
    '## 1. Traceability',
    '',
    `Ticket: ${KEY}`,
    ...(s.repository === null ? [] : [`Repository: ${s.repository}`]),
    '',
    '## 2. Context and current state',
    '',
    'The transfer service validates the session and writes the ledger entry in one call.',
    '',
    '## 3. The design',
    '',
    'A step-up challenge is issued by the transfer service before the ledger write.',
    '',
    '## 4. Acceptance criteria',
    '',
    ...(s.criteriaBlock
      ? s.criteriaBlock
      : [row(['ID', 'Criterion', 'Requirement', 'Source']), sep(4), ...rows(s.criteria)]),
    '',
    '## 5. Testing plan',
    '',
    row(['AC', 'Test name', 'Level', 'Asserts']),
    sep(4),
    ...rows(TESTS),
    '',
    '## 8. Readiness',
    '',
    'Spec Quality: READY',
    'Open Gaps: 0',
    `AC count: ${s.criteria.length}`,
    `AC covered by tests: ${TESTS.length}`,
    'Contracts referenced: 1',
    'Blocking CLAR: 0',
    'Codebase verified: YES',
    'Self-check verdict: GATE_PASS',
    '',
    '## 9. Clarifications',
    '',
    'NONE',
    '',
    ...(s.appendix ? [s.appendix, ''] : []),
  ].join('\n');
}

/* ------------------------------------------------------------------ the report */

const DESIGN_COMMIT = '<DESIGN-COMMIT>';
const SIDE_COMMIT = '<SIDE-COMMIT>';
const SPOKE = '3f2a9c1e7b4d6a0f8e5c2b9d1a7f4e6c3b8d0a25';
const HEADER = ['AC', 'Criterion (short)', 'Requirement', 'Verdict', 'Evidence'];

const ROWS = [
  ['AC-1', 'Step-up demanded above the threshold', 'REQ-1.AC-1', 'PASS', 'test_transfer::test_step_up_demanded · src/transfer.py:88 · the challenge is issued before the ledger write'],
  ['AC-2', 'Advisory view inherits the session', 'REQ-1.AC-2', 'PASS', 'test_advisory::test_session_inherited · src/advisory.py:41 · no challenge on a read-only view'],
  ['AC-3', 'A failed factor writes nothing', 'REQ-2.AC-1', 'PASS', 'test_transfer::test_failed_factor_writes_nothing · src/transfer.py:102 · the ledger is untouched'],
];

// The closing line, derived from the rows the way the check derives it. A fixture
// about the closing line passes its own.
function closing(rows, defects) {
  const cells = rows.filter((r) => Array.isArray(r));
  const pass = cells.filter((r) => r[3] === 'PASS').length;
  const fail = cells.filter((r) => r[3] === 'FAIL').length;
  return `Criteria: ${cells.length} · PASS ${pass} · FAIL ${fail} · defects raised: ${defects === undefined ? 'NONE' : defects}`;
}

/** One row with one cell changed. */
const withCell = (r, i, value) => r.map((c, j) => (j === i ? value : c));

// Every override takes the place of one part of the fixed shape; `spoke: null`
// drops the line, `before` and `after` add lines around the table, and a raw
// string in `rows` is written as it is.
function report(overrides = {}) {
  const s = {
    heading: `# Validation — ${KEY}: ${TITLE}`,
    designLine: `Design: ${DESIGN_PATH} at ${DESIGN_COMMIT}`,
    repository: REPO,
    spoke: SPOKE,
    header: row(HEADER),
    blankAboveTable: true,
    rows: ROWS,
    closing: undefined,
    defects: undefined,
    before: [],
    after: [],
    eol: '\n',
    ...overrides,
  };
  const rows = s.rows.map((e) => (typeof e === 'string' ? e : row(e)));
  return [
    s.heading,
    '',
    s.designLine,
    `Repository: ${s.repository}`,
    ...(s.spoke === null ? [] : [`Spoke commit: ${s.spoke}`]),
    ...(s.blankAboveTable ? [''] : []),
    ...s.before,
    s.header,
    sep(HEADER.length),
    ...rows,
    '',
    s.closing === undefined ? closing(s.rows, s.defects) : s.closing,
    ...s.after,
    '',
  ].join(s.eol);
}

const valid = () => ({ [REPORT_PATH]: report() });

/* ------------------------------------------------------------------- fixtures */

const FIXTURES = [
  {
    n: 1,
    name: 'complete report, every criterion PASS',
    files: valid(),
    exit: 0,
    includes: ['REPORT COMPLETE: 4 of 4 checks passed', 'shape checked only'],
  },
  {
    // QA runs before the code merge, and a failing criterion goes back to
    // /dev-sprint on the same branch. A report on the hub's trunk is therefore a
    // passing report, and a FAIL row in one is a finding.
    n: 2,
    name: 'one FAIL row',
    files: { [REPORT_PATH]: report({ rows: [ROWS[0], ROWS[1], withCell(ROWS[2], 3, 'FAIL')] }) },
    exit: 1,
    includes: ['report row AC-3 (line 11) is FAIL; a report reaches the hub only when every criterion passes', 'go back to /dev-sprint as a fix round on the same branch', 'REPORT INCOMPLETE'],
  },
  {
    // A deprecated criterion keeps its row, its number and its requirement, and
    // N/A is a verdict against it. Nothing else may be N/A.
    n: 3,
    name: 'N/A against a criterion the design marks DEPRECATED — must pass',
    design: { [DESIGN_PATH]: design({ criteria: [CRITERIA[0], CRITERIA[1], withCell(CRITERIA[2], 1, 'DEPRECATED — superseded by the ledger write guard in AC-1')] }) },
    files: { [REPORT_PATH]: report({ rows: [ROWS[0], ROWS[1], withCell(withCell(ROWS[2], 3, 'N/A'), 1, 'Deprecated in the design')] }) },
    exit: 0,
    includes: ['REPORT COMPLETE: 4 of 4 checks passed'],
  },
  {
    // The report is read from the trunk, never from a branch. On a pull request
    // CI builds a candidate trunk from the pull request's content; nothing else
    // makes a branch readable.
    n: 4,
    name: 'no report on the trunk (report exists only on a feature branch)',
    files: {},
    branch: { name: `validation/${KEY}`, files: valid() },
    exit: 1,
    includes: ['"*.validation.md" for PROJ-412 on origin/main, found 0'],
    excludes: ['REPORT COMPLETE'],
  },
  {
    n: 5,
    name: 'no design on the trunk',
    design: {},
    files: valid(),
    exit: 1,
    includes: ['"*.lld.md" for PROJ-412 on origin/main, found 0', 'skipped: no readable design criteria'],
  },
  {
    // The whole point. A criterion with no row is a criterion nobody validated,
    // and before this check it moved to DONE with the others.
    n: 6,
    name: 'a criterion in the design with no row in the report',
    files: { [REPORT_PATH]: report({ rows: [ROWS[0], ROWS[1]] }) },
    exit: 1,
    includes: ['no row for AC-3'],
    excludes: ['REPORT COMPLETE'],
  },
  {
    n: 7,
    name: 'a row for a criterion the design does not define',
    files: { [REPORT_PATH]: report({ rows: [...ROWS, withCell(ROWS[0], 0, 'AC-4')] }) },
    exit: 1,
    includes: ['records AC-4, which the design\'s "Acceptance criteria" table does not define'],
  },
  {
    n: 8,
    name: 'a criterion recorded twice',
    files: { [REPORT_PATH]: report({ rows: [ROWS[0], ROWS[1], ROWS[1], ROWS[2]] }) },
    exit: 1,
    includes: ['records AC-2 a second time; every criterion has exactly one row'],
  },
  {
    // The requirement id travels: work item, design, report. A report that names
    // a different one has broken the link this column exists to carry.
    n: 9,
    name: 'a requirement that differs from the design\'s',
    files: { [REPORT_PATH]: report({ rows: [ROWS[0], withCell(ROWS[1], 2, 'REQ-9.AC-9'), ROWS[2]] }) },
    exit: 1,
    includes: ['report row AC-2', 'names requirement "REQ-9.AC-9" but the design\'s row carries "REQ-1.AC-2"'],
  },
  {
    // Tokens are literal. `pass`, `Passed` and `PASS ✓` are three variants and
    // none of them is a verdict.
    n: 10,
    name: 'a verdict outside the set',
    files: { [REPORT_PATH]: report({ rows: [withCell(ROWS[0], 3, 'pass'), withCell(ROWS[1], 3, 'Passed'), withCell(ROWS[2], 3, 'PASS ✓')] }) },
    exit: 1,
    includes: ['has verdict "pass"; the whole verdict set is PASS / FAIL / N/A', 'has verdict "Passed"', 'has verdict "PASS ✓"'],
  },
  {
    n: 11,
    name: 'N/A against a live criterion',
    files: { [REPORT_PATH]: report({ rows: [withCell(ROWS[0], 3, 'N/A'), ROWS[1], ROWS[2]] }) },
    exit: 1,
    includes: ['report row AC-1', 'is N/A but the design does not mark AC-1 DEPRECATED'],
  },
  {
    // A dash in the evidence column is the cheapest way to fill a row. It is an
    // unvalidated criterion wearing a tick.
    n: 12,
    name: 'placeholder evidence',
    files: { [REPORT_PATH]: report({ rows: [withCell(ROWS[0], 4, '-'), withCell(ROWS[1], 4, 'TBD'), withCell(ROWS[2], 4, '')] }) },
    exit: 1,
    includes: ['report row AC-1', 'has "-" in the evidence column', 'has "TBD" in the evidence column', 'report row AC-3', 'has nothing in the evidence column'],
  },
  {
    n: 13,
    name: 'placeholder in the criterion column',
    files: { [REPORT_PATH]: report({ rows: [ROWS[0], withCell(ROWS[1], 1, 'TBD'), ROWS[2]] }) },
    exit: 1,
    includes: ['report row AC-2', 'has "TBD" in the criterion column'],
  },
  {
    // A file and line with no commit is a pointer into a moving branch.
    n: 14,
    name: 'no Spoke commit line',
    files: { [REPORT_PATH]: report({ spoke: null }) },
    exit: 1,
    includes: ['should be the "Spoke commit: <40-character commit>" line'],
  },
  {
    // Forty characters, not seven: an abbreviation is unique today and ambiguous
    // in a year, and this line is what every file and line in the table hangs on.
    n: 15,
    name: 'an abbreviated spoke commit',
    files: { [REPORT_PATH]: report({ spoke: SPOKE.slice(0, 7) }) },
    exit: 1,
    includes: ['should be the "Spoke commit: <40-character commit>" line'],
  },
  {
    n: 16,
    name: 'the report names a repository the design does not',
    files: { [REPORT_PATH]: report({ repository: 'other-service' }) },
    exit: 1,
    includes: ['names repository "other-service" but the design names "transfer-service"'],
  },
  {
    n: 17,
    name: 'the Design line names another design\'s path',
    files: { [REPORT_PATH]: report({ designLine: `Design: docs/designs/PROJ-999.lld.md at ${DESIGN_COMMIT}` }) },
    exit: 1,
    includes: ['names docs/designs/PROJ-999.lld.md, but the design for PROJ-412 is docs/designs/PROJ-412.lld.md'],
  },
  {
    // A commit the repository has never seen is not a commit the design was
    // read at. In a full clone that is a finding about the report.
    n: 18,
    name: 'the Design line names a commit this repository does not have',
    files: { [REPORT_PATH]: report({ designLine: `Design: ${DESIGN_PATH} at ${'f'.repeat(40)}` }) },
    exit: 1,
    includes: ['names hub commit ffffffffffffffffffffffffffffffffffffffff, which this repository does not have'],
  },
  {
    // The report's binding to the design, and the case that makes it matter: the
    // design was amended after the report was written. The report is now about
    // an older design, exactly as a review is after the design changes.
    n: 19,
    name: 'the design changed on the trunk after the report was written',
    files: valid(),
    thenChange: { [DESIGN_PATH]: design({ appendix: 'Amended after validation: the threshold moved.' }) },
    exit: 1,
    includes: ['the design changed after it was validated, so the report is about an older design'],
  },
  {
    // A commit on a side branch is a commit the repository has, and is still not
    // a commit of the trunk. A report written against the design's pull-request
    // branch before it merged names one of these.
    n: 20,
    name: 'the Design line names a commit that is not on the trunk',
    side: { [DESIGN_PATH]: design({ appendix: 'A draft on a side branch.' }) },
    files: { [REPORT_PATH]: report({ designLine: `Design: ${DESIGN_PATH} at ${SIDE_COMMIT}` }) },
    exit: 1,
    includes: ['which is not on origin/main; the design was read from a branch, not from the trunk'],
  },
  {
    // The counts on the closing line are checked against the table, never against
    // each other. Three numbers the same author typed agreeing is not evidence.
    n: 21,
    name: 'the closing line\'s criteria count is not the table\'s',
    files: { [REPORT_PATH]: report({ closing: 'Criteria: 4 · PASS 3 · FAIL 0 · defects raised: NONE' }) },
    exit: 1,
    includes: ['says "Criteria: 4" but the table has 3 row(s)'],
  },
  {
    n: 22,
    name: 'the closing line\'s PASS count is not the table\'s',
    files: { [REPORT_PATH]: report({ closing: 'Criteria: 3 · PASS 2 · FAIL 0 · defects raised: NONE' }) },
    exit: 1,
    includes: ['says "PASS 2" but the table records 3'],
  },
  {
    // The closing line is true to the table, and the only finding is the FAIL
    // row itself. NONE is the legal value, so the defect rule says nothing.
    n: 23,
    name: 'a FAIL row with a true closing line and no defect raised',
    files: { [REPORT_PATH]: report({ rows: [ROWS[0], ROWS[1], withCell(ROWS[2], 3, 'FAIL')], defects: 'NONE' }) },
    exit: 1,
    includes: ['report row AC-3 (line 11) is FAIL'],
    excludes: ['defects raised: NONE"', '[FAIL] closing counts'],
  },
  {
    // The `defects raised:` field stays in the grammar so that older reports
    // still read, and its one legal value is NONE.
    n: 24,
    name: 'a defect key raised over an all-PASS table',
    files: { [REPORT_PATH]: report({ defects: 'PROJ-501' }) },
    exit: 1,
    includes: ['says "defects raised: PROJ-501"; the one legal value is NONE'],
  },
  {
    n: 25,
    name: 'the closing line says FAIL 1 over an all-PASS table',
    files: { [REPORT_PATH]: report({ closing: 'Criteria: 3 · PASS 3 · FAIL 1 · defects raised: NONE' }) },
    exit: 1,
    includes: ['says "FAIL 1" but the table records 0'],
  },
  {
    // Matched literally, as every token the scripts read.
    n: 26,
    name: 'defects raised written as "none" in lower case',
    files: { [REPORT_PATH]: report({ defects: 'none' }) },
    exit: 1,
    includes: ['says "defects raised: none"; the one legal value is NONE'],
  },
  {
    // Every check runs before the exit, so one run lists every failing row.
    n: 27,
    name: 'two FAIL rows, both listed',
    files: { [REPORT_PATH]: report({ rows: [ROWS[0], withCell(ROWS[1], 3, 'FAIL'), withCell(ROWS[2], 3, 'FAIL')] }) },
    exit: 1,
    includes: ['report row AC-2 (line 10) is FAIL', 'report row AC-3 (line 11) is FAIL'],
  },
  {
    // A deprecated criterion is N/A or PASS. It is withdrawn, not failed.
    n: 28,
    name: 'FAIL against a criterion the design marks DEPRECATED',
    design: { [DESIGN_PATH]: design({ criteria: [CRITERIA[0], CRITERIA[1], withCell(CRITERIA[2], 1, 'DEPRECATED — superseded by the ledger write guard in AC-1')] }) },
    files: { [REPORT_PATH]: report({ rows: [ROWS[0], ROWS[1], withCell(ROWS[2], 3, 'FAIL')] }) },
    exit: 1,
    includes: ['report row AC-3 (line 11) is FAIL'],
  },
  {
    // The shape has no room for prose. A paragraph after the table is a place to
    // put "AC-3 was not really checked" where the script does not read it.
    n: 29,
    name: 'prose after the closing line',
    files: { [REPORT_PATH]: report({ after: ['', 'Note: AC-3 was checked by reading the code only; no test exists yet.'] }) },
    exit: 1,
    includes: ['comes after the closing line; the report ends there'],
  },
  {
    n: 30,
    name: 'a line that is neither a row nor the closing line, inside the table',
    files: { [REPORT_PATH]: report({ rows: [ROWS[0], 'AC-2 pending a fixture.', ROWS[1], ROWS[2]] }) },
    exit: 1,
    includes: ['is not a row of the table and not the closing line'],
  },
  {
    n: 31,
    name: 'the heading names another work item',
    files: { [REPORT_PATH]: report({ heading: `# Validation — PROJ-413: ${TITLE}` }) },
    exit: 1,
    includes: ['is headed as PROJ-413, not PROJ-412'],
  },
  {
    // The title is the design's, repeated. A report written for one design and
    // filed under another key is caught by the words as well as the key.
    n: 32,
    name: 'the heading carries a title that is not the design\'s',
    files: { [REPORT_PATH]: report({ heading: `# Validation — ${KEY}: something else entirely` }) },
    exit: 1,
    includes: ['carries the title "something else entirely" but the design is titled "step-up authentication on high-value transfers"'],
  },
  {
    // The old four-column table. Without the requirement column the report
    // cannot say which requirement each verdict is about.
    n: 33,
    name: 'a table header without the Requirement column',
    files: {
      [REPORT_PATH]: report({
        header: row(['AC', 'Criterion (short)', 'Verdict', 'Evidence']),
        rows: ROWS.map((r) => [r[0], r[1], r[3], r[4]]),
      }),
    },
    exit: 1,
    includes: ['should be the table header "| AC | Criterion (short) | Requirement | Verdict | Evidence |"'],
  },
  {
    n: 34,
    name: 'hidden markup in the report',
    files: { [REPORT_PATH]: report({ after: ['', '<details><summary>Working notes</summary>AC-3 was not run.</details>'] }) },
    exit: 1,
    includes: ['carries HTML <details> markup'],
  },
  {
    // The design side of the same column. A design without it passed the gate
    // before this package; the check says what is missing, once, and does not
    // repeat it as three requirement mismatches or as "the design does not
    // define" the criteria it plainly lists.
    n: 35,
    name: 'a design whose criteria table has no Requirement column',
    design: { [DESIGN_PATH]: design({ criteriaBlock: [row(['ID', 'Criterion', 'Source']), sep(3), ...CRITERIA.map((c) => row([c[0], c[1], c[3]]))] }) },
    files: valid(),
    exit: 1,
    includes: ['must carry exactly one "Requirement" column, found 0', '[PASS] criterion verdicts'],
    excludes: ['does not define', 'names requirement'],
  },
  {
    n: 36,
    name: 'usage error: the key is not a work-item key',
    files: valid(),
    key: 'proj-412',
    exit: 3,
    includes: ['usage:'],
    excludes: ['validation check  ('],
  },
  {
    // The difference between "I do not know" and "I know, and the answer is no".
    n: 37,
    name: 'the remote is unreachable — cannot verify',
    files: valid(),
    breakRemote: true,
    exit: 2,
    includes: ['CANNOT VERIFY'],
  },
  {
    // A shallow clone does not have the commit the design landed in. That is a
    // fact about the clone, not about the report, and it is exit 2, not exit 1.
    n: 38,
    name: 'a shallow clone that does not have the design\'s commit — cannot verify',
    files: valid(),
    shallow: true,
    exit: 2,
    includes: ['CANNOT VERIFY', 'shallow clone does not have', 'REASON: shallow-clone'],
  },
  {
    n: 39,
    name: 'HARNESS_TRUNK names a branch that is not the remote\'s default — cannot verify',
    files: valid(),
    env: { HARNESS_TRUNK: 'develop' },
    exit: 2,
    includes: ['CANNOT VERIFY'],
  },
  {
    // CR, LF and CRLF are all line endings.
    n: 40,
    name: 'a report with CRLF line endings — must pass',
    files: { [REPORT_PATH]: report({ eol: '\r\n' }) },
    exit: 0,
    includes: ['REPORT COMPLETE: 4 of 4 checks passed'],
  },
  {
    // The pathspec is anchored to the repository root, so the check gives the
    // same answer from any directory.
    n: 41,
    name: 'run from a subdirectory — must pass',
    files: { ...valid(), 'src/README.md': 'source\n' },
    from: 'src',
    exit: 0,
    includes: ['REPORT COMPLETE: 4 of 4 checks passed'],
  },
  {
    n: 42,
    name: 'two reports for one key',
    files: { ...valid(), [`docs/designs/${KEY}.rerun.validation.md`]: report() },
    exit: 1,
    includes: ['"*.validation.md" for PROJ-412 on origin/main, found 2'],
  },
  {
    n: 43,
    name: 'the report is a symbolic link',
    files: {},
    symlinks: { [REPORT_PATH]: `${KEY}.lld.md` },
    exit: 1,
    includes: ['is a symbolic link on origin/main, not a validation report'],
  },
  {
    // The report's Repository line is checked against the design's. A design
    // that names none gives it nothing to be checked against, and says so.
    n: 44,
    name: 'a design with no Repository line',
    design: { [DESIGN_PATH]: design({ repository: null }) },
    files: valid(),
    exit: 1,
    includes: ['must carry exactly one "Repository: <id>" line, found 0'],
  },
  {
    // A table with no blank line above it interrupts the paragraph before it, and
    // a renderer prints its pipes as text.
    n: 45,
    name: 'no blank line above the table header',
    files: { [REPORT_PATH]: report({ blankAboveTable: false }) },
    exit: 1,
    includes: ['does not start a block'],
  },
  {
    // A complete inline comment is not shown on the page, so the reader sees
    // PASS and the check reads PASS. The verdict a reader sees is the verdict.
    n: 46,
    name: 'an inline comment inside a verdict cell is not part of the verdict — must pass',
    files: { [REPORT_PATH]: report({ rows: [withCell(ROWS[0], 3, 'PASS <!-- re-run before release -->'), ROWS[1], ROWS[2]], closing: closing(ROWS) }) },
    exit: 0,
    includes: ['REPORT COMPLETE: 4 of 4 checks passed'],
  },
  {
    // An empty report is not a report.
    n: 47,
    name: 'an empty report file',
    files: { [REPORT_PATH]: '\n' },
    exit: 1,
    includes: ['is empty on origin/main; an empty file is not a validation report'],
  },
  {
    // The three header lines are read in order and each says what it should be.
    n: 48,
    name: 'the header lines in the wrong order',
    files: {
      [REPORT_PATH]: [
        `# Validation — ${KEY}: ${TITLE}`,
        '',
        `Repository: ${REPO}`,
        `Design: ${DESIGN_PATH} at ${DESIGN_COMMIT}`,
        `Spoke commit: ${SPOKE}`,
        '',
        row(HEADER), sep(HEADER.length), ...ROWS.map((r) => row(r)),
        '',
        closing(ROWS),
        '',
      ].join('\n'),
    },
    exit: 1,
    includes: ['should be the "Design: docs/designs/<KEY>.lld.md at <40-character hub commit>" line; found "Repository: transfer-service"'],
  },
  {
    // A blank line inside the table ends it on the page. The rows below render as
    // pipes in a paragraph, and a check that skipped blank lines read them as rows.
    n: 49,
    name: 'a blank line inside the table',
    files: { [REPORT_PATH]: report({ rows: [ROWS[0], ROWS[1], '', ROWS[2]], closing: closing(ROWS) }) },
    exit: 1,
    includes: ['a blank line inside the table', 'render as text below the table'],
  },
  {
    // With no blank line between, the closing line is one more row to a renderer.
    n: 50,
    name: 'the closing line glued to the last row',
    files: {
      [REPORT_PATH]: [
        `# Validation — ${KEY}: ${TITLE}`,
        '',
        `Design: ${DESIGN_PATH} at ${DESIGN_COMMIT}`,
        `Repository: ${REPO}`,
        `Spoke commit: ${SPOKE}`,
        '',
        row(HEADER), sep(HEADER.length), ...ROWS.map((r) => row(r)),
        closing(ROWS),
        '',
      ].join('\n'),
    },
    exit: 1,
    includes: ['leave a blank line above the closing line'],
  },
  {
    // The gate does not check the design's heading, so a merged design may not
    // carry the template's form. The title comparison is then skipped, not failed:
    // a report cannot be made impossible by a design nothing else objected to.
    n: 51,
    name: 'a design whose heading is not in the template\'s form — must pass',
    design: { [DESIGN_PATH]: design({ heading: `# LLD - ${KEY}: ${TITLE}` }) },
    files: valid(),
    exit: 0,
    includes: ['REPORT COMPLETE: 4 of 4 checks passed'],
  },
  {
    // The design's own requirement cell is refused in check 1, and the criterion is
    // still a criterion: the report still owes it a row, and the refusal is not
    // repeated as a false "the design does not define AC-3".
    n: 52,
    name: 'a bad requirement cell in the design, and the report omits that criterion',
    design: { [DESIGN_PATH]: design({ criteria: [CRITERIA[0], CRITERIA[1], withCell(CRITERIA[2], 2, 'REQ-2')] }) },
    files: { [REPORT_PATH]: report({ rows: [ROWS[0], ROWS[1]] }) },
    exit: 1,
    includes: ['names requirement "REQ-2", which is not one REQ-<n>.AC-<m>', 'no row for AC-3'],
    excludes: ['does not define'],
  },
  {
    // A byte-order mark is not content. Anchored patterns must not see it.
    n: 53,
    name: 'a report and a design that both start with a byte-order mark — must pass',
    design: { [DESIGN_PATH]: `\uFEFF${design()}` },
    files: { [REPORT_PATH]: `\uFEFF${report()}` },
    exit: 0,
    includes: ['REPORT COMPLETE: 4 of 4 checks passed'],
  },
  {
    // A story taken from a Jira ticket carries its ticket's criteria, and the
    // report repeats them as it repeats a requirements document's.
    n: 54,
    name: 'a design and a report that carry ticket criteria \u2014 must pass',
    design: { [DESIGN_PATH]: design({ criteria: CRITERIA.map((c, i) => withCell(c, 2, `JIRA-${KEY}.AC-${i + 1}`)) }) },
    files: { [REPORT_PATH]: report({ rows: ROWS.map((r, i) => withCell(r, 2, `JIRA-${KEY}.AC-${i + 1}`)) }) },
    exit: 0,
    includes: ['REPORT COMPLETE: 4 of 4 checks passed'],
  },
  {
    n: 55,
    name: 'a ticket criterion with no key in the design',
    design: { [DESIGN_PATH]: design({ criteria: [CRITERIA[0], CRITERIA[1], withCell(CRITERIA[2], 2, 'JIRA-AC-3')] }) },
    files: valid(),
    exit: 1,
    includes: ['names requirement "JIRA-AC-3", which is not one REQ-<n>.AC-<m> or JIRA-<KEY>.AC-<m>'],
  },
  {
    // PLDC-686: GitHub drops the cells past the header's count, so the second
    // row of two on one line disappears from the rendered report.
    n: 56,
    name: 'two report rows on one line',
    files: { [REPORT_PATH]: report({ rows: [ROWS[0], `${row(ROWS[1])} ${row(ROWS[2])}`, ...ROWS.slice(3)] }) },
    exit: 1,
    includes: [`${REPORT_PATH} line `, 'the table row has 11 cells and its header', 'has 5; write one row on one line, and a literal pipe in a cell as \\|'],
  },
  {
    n: 57,
    name: 'a row of the design with fewer cells than its header, in a table the check does not read by name',
    design: { [DESIGN_PATH]: design({ appendix: notesTable([NOTE_ROWS[0], row(['Risk', 'The cap may change'])]) }) },
    files: valid(),
    exit: 1,
    includes: [`${DESIGN_PATH} line `, 'the table row has 2 cells and its header'],
  },
  {
    // An escaped pipe is one cell, and a pipe line in a code fence is not a row.
    // The report's fixed shape has no room for either, so the design carries them.
    n: 58,
    name: 'an escaped pipe in a cell and a pipe line in a code fence in the design — must pass',
    design: { [DESIGN_PATH]: design({ appendix: [notesTable([NOTE_ROWS[0], row(['Format', 'A value is written a \\| b', 'house style'])]), '', '```', '| a | b | c | d |', '```'].join('\n') }) },
    files: valid(),
    exit: 0,
    includes: ['REPORT COMPLETE: 4 of 4 checks passed'],
  },
];

/* ---------------------------------------------------------------------- runner */

const COMMON = {
  'package.json': `${JSON.stringify({ name: 'validation-fixture', private: true, type: 'module' }, null, 2)}\n`,
  '.gitignore': 'node_modules\n',
};

function bind(files, tokens) {
  const bound = {};
  for (const [rel, body] of Object.entries(files)) {
    let text = body;
    if (typeof text === 'string') {
      for (const [token, value] of Object.entries(tokens)) text = text.split(token).join(value);
    }
    bound[rel] = text;
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

  // Commit 1: the design lands, as the design pull request's merge would land it.
  writeFiles(work, COMMON);
  mkdirSync(join(work, 'scripts'), { recursive: true });
  copyFileSync(CHECK, join(work, 'scripts', 'check-validation.js'));
  writeFiles(work, fixture.design === undefined ? { [DESIGN_PATH]: design() } : fixture.design);
  git(work, ['add', '-A']);
  git(work, ['commit', '-q', '-m', 'design merged']);
  const designCommit = git(work, ['rev-parse', 'HEAD']).trim();

  // A commit on a side branch, for the case where the report names one.
  let sideCommit = '0'.repeat(40);
  if (fixture.side) {
    git(work, ['checkout', '-q', '-b', 'side']);
    writeFiles(work, fixture.side);
    git(work, ['add', '-A']);
    git(work, ['commit', '-q', '-m', 'a draft on a side branch']);
    sideCommit = git(work, ['rev-parse', 'HEAD']).trim();
    git(work, ['push', '-q', 'origin', 'side']);
    git(work, ['checkout', '-q', 'main']);
  }
  const tokens = { [DESIGN_COMMIT]: designCommit, [SIDE_COMMIT]: sideCommit };

  // Commit 2: the report, naming the commit the design landed in.
  writeFiles(work, bind(fixture.files === undefined ? valid() : fixture.files, tokens));
  writeLinks(work, fixture.symlinks || {});
  git(work, ['add', '-A']);
  git(work, ['commit', '-q', '-m', 'validation report', '--allow-empty']);

  // Later commits, NOT re-bound: the report keeps naming the commit it read.
  for (const change of [].concat(fixture.thenChange || [])) {
    writeFiles(work, change);
    git(work, ['add', '-A']);
    git(work, ['commit', '-q', '-m', 'later revision']);
  }
  git(work, ['push', '-q', 'origin', 'main']);

  if (fixture.branch) {
    git(work, ['checkout', '-q', '-b', fixture.branch.name]);
    writeFiles(work, bind(fixture.branch.files, tokens));
    git(work, ['add', '-A']);
    git(work, ['commit', '-q', '-m', 'report on a feature branch']);
    git(work, ['push', '-q', 'origin', fixture.branch.name]);
    git(work, ['checkout', '-q', 'main']);
  }

  if (fixture.breakRemote) {
    git(work, ['remote', 'set-url', 'origin', join(root, 'no-such-remote.git')]);
  }

  // A shallow clone of the remote, for the case where history is missing on
  // purpose. `file://` is what makes --depth take effect on a local path.
  if (fixture.shallow) {
    const shallow = join(root, 'shallow');
    git(root, ['clone', '-q', '--depth', '1', `file://${remote}`, shallow]);
    return shallow;
  }
  return work;
}

function runFixture(fixture) {
  const root = mkdtempSync(join(tmpdir(), `validation-fx${String(fixture.n).padStart(2, '0')}-`));
  try {
    const work = buildRepo(root, fixture);
    const cwd = fixture.from ? join(work, fixture.from) : work;
    const script = fixture.from
      ? `${fixture.from.split('/').map(() => '..').join('/')}/scripts/check-validation.js`
      : 'scripts/check-validation.js';
    const res = spawnSync(process.execPath, [script, fixture.key || KEY], {
      cwd, env: { ...ENV, ...(fixture.env || {}) }, encoding: 'utf8',
    });
    const output = `${res.stdout || ''}${res.stderr || ''}`;
    const problems = [];
    if (res.status !== fixture.exit) {
      problems.push(`expected exit ${fixture.exit}, got ${res.status}`);
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

  process.stdout.write(`\ncheck-validation fixture suite — ${selected.length} of ${FIXTURES.length} fixtures\n`);
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

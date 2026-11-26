#!/usr/bin/env node
/**
 * run.mjs — the fixture suite for check-intake.js.
 *
 *   usage:  node run.mjs            run every fixture
 *           node run.mjs 9 11       run only the numbered fixtures
 *           node run.mjs --keep     leave the throwaway repositories on disk
 *
 * A fixture here is a REPOSITORY STATE, as in the pickup gate's suite. Each case
 * builds a throwaway hub with a real bare `origin`: the list of repositories, the
 * key ledger, a decision record, and the three files /from-ticket writes under
 * docs/backlog/jira/ -- the ticket snapshot, the work item and the review -- all
 * on the default branch. It copies the shipped check to `scripts/check-intake.js`,
 * runs it exactly as CI would, and asserts the exit code and the messages. The
 * check is never imported and never stubbed. The `--draft` fixtures write one
 * snapshot to a file outside the repository and run the check on it.
 *
 * Two placeholders are substituted when the repository is built:
 * `<TICKET-REVISION>` and `<ITEM-REVISION>` become the blob hashes of the snapshot
 * and the item as written -- the values `git hash-object` prints for them. A
 * fixture that changes a file in a later commit is NOT re-substituted: the review
 * keeps naming the revision it really read.
 *
 * Every ticket here is synthetic. No text from a real ticket is copied.
 *
 * `run.mjs` is the list. Every fixture carries its number, its name, the expected
 * exit code and a comment saying why it exists.
 *
 * Node standard library only, plus git via child_process. No test framework.
 * Exit 0 if every fixture passes, 1 if any fails.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

const CHECK_CANDIDATES = [
  process.env.HARNESS_CHECK,
  process.argv[2] && process.argv[2].search(/^\d+$/) !== 0 && !process.argv[2].startsWith('--') ? process.argv[2] : undefined,
  resolve(HERE, '..', '..', 'scripts', 'check-intake.js'),
  resolve(HERE, '..', '..', 'scripts', 'check-intake.mjs'),
  resolve(HERE, '..', '..', 'check-intake.js'),
  resolve(HERE, '..', '..', 'check-intake.mjs'),
].filter(Boolean);

const CHECK = CHECK_CANDIDATES.find((p) => existsSync(p));

if (!CHECK) {
  console.error('cannot locate the check script. Looked in order:');
  for (const c of CHECK_CANDIDATES) console.error('  ' + c);
  console.error('\nSet HARNESS_CHECK=/path/to/check-intake.js or pass the path as argument 1.');
  process.exit(4);
}

const KEY = 'TKT-42';
const DIR = 'docs/backlog/jira';
const TICKET_PATH = `${DIR}/${KEY}.ticket.md`;
const ITEM_PATH = `${DIR}/${KEY}.item.md`;
const REVIEW_PATH = `${DIR}/${KEY}.ticket-review.md`;
const KEYS_PATH = 'docs/backlog/keys.json';
const REGISTRY_PATH = 'docs/estate/repositories.json';
const LINKS_DIR = 'docs/estate/tracker-links';
const REPOS = ['player-service', 'session-service'];
const TICKET_REVISION = '<TICKET-REVISION>';
const ITEM_REVISION = '<ITEM-REVISION>';

const ADR_PATH = 'docs/architecture/ADR-003-session-timeouts.md';
const ADR_BODY = '---\nname: ADR-003\nkind: adr\nstatus: Accepted\n---\n\n# ADR-003: one timer per session\n';

function gitBlob(content) {
  const body = Buffer.from(content, 'utf8');
  return createHash('sha1').update(`blob ${body.length}\0`).update(body).digest('hex');
}

const ADR_ENTRY = `ADR-003@${gitBlob(ADR_BODY).slice(0, 12)}:${ADR_PATH}`;

/* ------------------------------------------------------------------ git helpers */

const SANDBOX_HOME = mkdtempSync(join(tmpdir(), 'intake-home-'));
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

const row = (cells) => `| ${cells.map((c) => String(c)).join(' | ')} |`;
const sep = (n) => `|${'---|'.repeat(n)}`;
// A table that no rule reads by name, for the fixtures of PLDC-686. It starts
// with a blank line, so it does not join the table above it.
const NOTE_ROWS = [
  row(['Scope', 'Timed questions only', 'the ticket']),
  row(['Timing', 'One timer per session', 'ADR-003']),
];
const notesTable = (rows) => ['', '## Notes', '', row(['Topic', 'Note', 'Source']), sep(3), ...rows].join('\n');
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
  return json({ schema_version: 1, prefix: 'PAY', next: 203, blocks: [{ from: 201, to: 202, taken_by: 'decomposition', slug: 'step-up' }], ...overrides });
}

/* ------------------------------------------------------------------ the ticket */

const CRITERIA = [
  ['Warn on screen', 'A candidate is answering a question', 'The candidate is silent for 20 seconds', 'A notice reads "Are you still there?"'],
  ['Clear the notice', 'The notice is showing', 'The candidate speaks', 'The notice closes and the 20-second timer starts again'],
  ['End the session', 'The notice has shown for 40 seconds', 'The candidate is still silent', 'The session ends, the answers so far are saved, and no answer is recorded for the open question'],
];

function snapshot({
  key = KEY,
  criteria = CRITERIA,
  header = ['ID', 'Scenario', 'Given', 'When', 'Then'],
  ids = null,
  head = null,
  scope = '- The time limits of timed questions do not change.',
  design = '- https://design.example.invalid/frames/inactivity',
  extra = '',
} = {}) {
  const lines = head || [
    `Key: ${key}`,
    `Source: https://tracker.example.invalid/browse/${key}`,
    `Fetched: ${key}@2026-11-04T09:15:00.000+0000`,
    'Parent: TKT-7',
  ];
  return [
    `# ${key} — Warn a silent candidate before the session ends`,
    '',
    ...lines,
    '',
    '## Description',
    '',
    'As a candidate who stops answering, I want a warning before my session ends, so that I can carry on.',
    '',
    '## Acceptance criteria',
    '',
    row(header),
    sep(header.length),
    ...criteria.map((c, i) => row([ids ? ids[i] : `JIRA-${key}.AC-${i + 1}`, ...c])),
    '',
    '## Out of scope',
    '',
    scope,
    '',
    '## Design',
    '',
    design,
    extra,
  ].join('\n') + '\n';
}

/* -------------------------------------------------------------------- the item */

const ITEM_ROWS = [
  ['AC-1', 'After 20 seconds of silence on an open question, the screen shows "Are you still there?"', 'positive', `JIRA-${KEY}.AC-1`, 'ticket § Acceptance criteria L13'],
  ['AC-2', 'Speech while the notice shows closes it and restarts the 20-second timer', 'positive', `JIRA-${KEY}.AC-2`, 'ticket § Acceptance criteria L14'],
  ['AC-3', 'After 40 more seconds of silence the session ends, keeps the answers so far, and records no answer for the open question', 'negative', `JIRA-${KEY}.AC-3`, 'ticket § Acceptance criteria L15'],
];

function item({ key = KEY, repository = 'player-service', context = ADR_ENTRY, rows = ITEM_ROWS, extra = '' } = {}) {
  return [
    `# ${key} — Warn a silent candidate before the session ends`,
    '',
    `Key: ${key}`,
    `Repository: ${repository}`,
    `Context: ${context}`,
    `Tracker key: https://tracker.example.invalid/browse/${key}`,
    '',
    '## Traceability',
    '',
    `Derives from: \`${TICKET_PATH}\` § Acceptance criteria L13-15`,
    '',
    'The session keeps one timer, as ADR-003 decides.',
    '',
    '## Acceptance criteria',
    '',
    row(['ID', 'Criterion', 'Type', 'Carries', 'Source']),
    sep(5),
    ...rows.map(row),
    extra,
    '',
    '## Dependencies',
    '',
    'None.',
    '',
  ].join('\n');
}

function review({ verdict = '### VERDICT: APPROVED', mode = 'Mode: ticket-review', ticketRev = `Ticket revision: ${TICKET_REVISION}`, itemRev = `Item revision: ${ITEM_REVISION}`, key = KEY } = {}) {
  return [
    `## Review: ${key} — ticket intake`,
    '',
    verdict,
    'Cycle: 1 of 2',
    mode,
    'Reviewer: pm-critic',
    ticketRev,
    itemRev,
    '',
    '### CRITICAL',
    '',
    'None.',
    '',
  ].filter((l) => l !== null).join('\n');
}

function valid(overrides = {}) {
  return {
    [REGISTRY_PATH]: registry(),
    [KEYS_PATH]: keys(),
    [TICKET_PATH]: snapshot(),
    [ITEM_PATH]: item(),
    [REVIEW_PATH]: review(),
    ...overrides,
  };
}

/* -------------------------------------------------------------------- fixtures */

const FIXTURES = [
  {
    n: 1,
    name: 'valid control: snapshot, item and review agree',
    files: valid(),
    exit: 0,
    includes: ['INTAKE COMPLETE: 6 of 6 checks passed'],
  },
  {
    // The snapshot says which version of the ticket it copies.
    n: 2,
    name: 'snapshot with no Fetched: line',
    files: valid({ [TICKET_PATH]: snapshot({ head: [`Key: ${KEY}`, `Source: https://tracker.example.invalid/browse/${KEY}`, 'Parent: none'] }) }),
    exit: 1,
    includes: ['must carry exactly one "Fetched: <KEY>@<updated>" line, found 0'],
  },
  {
    n: 3,
    name: 'Fetched: line without an ISO time',
    files: valid({ [TICKET_PATH]: snapshot({ head: [`Key: ${KEY}`, `Source: https://tracker.example.invalid/browse/${KEY}`, `Fetched: ${KEY}@yesterday`, 'Parent: none'] }) }),
    exit: 1,
    includes: [`"Fetched: ${KEY}@yesterday" is not <KEY>@<the ticket's updated time in ISO 8601>`],
  },
  {
    n: 4,
    name: 'snapshot criteria table has no Then column',
    files: valid({ [TICKET_PATH]: snapshot({ header: ['ID', 'Scenario', 'Given', 'When', 'Outcome'] }) }),
    exit: 1,
    includes: ['must carry exactly one "Then" column, found 0'],
  },
  {
    // A value nobody decided, written as TBC, is the defect the bar exists for.
    n: 5,
    name: 'a TBC cell in the snapshot criteria',
    files: valid({ [TICKET_PATH]: snapshot({ criteria: [CRITERIA[0], CRITERIA[1], ['End the session', 'The notice has shown', 'The candidate is still silent', 'TBC']] }) }),
    exit: 1,
    includes: ['has "TBC" in the "Then" column'],
  },
  {
    n: 6,
    name: 'a cell that only points at the designs',
    files: valid({ [TICKET_PATH]: snapshot({ criteria: [CRITERIA[0], ['Clear the notice', 'The notice is showing', 'The candidate speaks', 'See designs'], CRITERIA[2]] }) }),
    exit: 1,
    includes: ['has "See designs" in the "Then" column'],
  },
  {
    n: 7,
    name: 'an empty When cell',
    files: valid({ [TICKET_PATH]: snapshot({ criteria: [CRITERIA[0], ['Clear the notice', 'The notice is showing', '', 'The notice closes'], CRITERIA[2]] }) }),
    exit: 1,
    includes: [`JIRA-${KEY}.AC-2 has nothing in the "When" column`],
  },
  {
    // Numbered in the ticket's order, from 1, with no gap.
    n: 8,
    name: 'snapshot criteria numbered out of order',
    files: valid({ [TICKET_PATH]: snapshot({ ids: [`JIRA-${KEY}.AC-1`, `JIRA-${KEY}.AC-3`, `JIRA-${KEY}.AC-2`] }) }),
    exit: 1,
    includes: [`criterion "JIRA-${KEY}.AC-3" is not JIRA-${KEY}.AC-2`],
  },
  {
    n: 9,
    name: 'no out-of-scope section',
    files: valid({ [TICKET_PATH]: snapshot().replace('## Out of scope', '## Notes') }),
    exit: 1,
    includes: [`${TICKET_PATH} has no "## Out of scope" section`],
  },
  {
    n: 10,
    name: 'an empty design section',
    files: valid({ [TICKET_PATH]: snapshot({ design: '' }) }),
    exit: 1,
    includes: ['the "## Design" section is empty'],
  },
  {
    n: 11,
    name: 'no review',
    files: valid({ [REVIEW_PATH]: undefined }),
    exit: 1,
    includes: [`no ${REVIEW_PATH} on origin/main`],
  },
  {
    n: 12,
    name: 'review requests changes',
    files: valid({ [REVIEW_PATH]: review({ verdict: '### VERDICT: CHANGES REQUESTED' }) }),
    exit: 1,
    includes: ['verdict is "### VERDICT: CHANGES REQUESTED"'],
  },
  {
    n: 13,
    name: 'review written in another mode',
    files: valid({ [REVIEW_PATH]: review({ mode: 'Mode: decomposition-review' }) }),
    exit: 1,
    includes: ['carries "Mode: decomposition-review"; a ticket intake is reviewed in "Mode: ticket-review"'],
  },
  {
    // One changed byte in the snapshot after the review unapproves the intake.
    n: 14,
    name: 'snapshot changed after the review',
    files: valid(),
    thenChange: { [TICKET_PATH]: snapshot({ scope: '- The time limits of timed questions do not change. Nothing else.' }) },
    exit: 1,
    includes: [`approves revision`, `of ${TICKET_PATH}, but origin/main carries`],
  },
  {
    n: 15,
    name: 'item changed after the review',
    files: valid(),
    thenChange: { [ITEM_PATH]: item({ extra: '\nOne more sentence.' }) },
    exit: 1,
    includes: [`of ${ITEM_PATH}, but origin/main carries`],
  },
  {
    n: 16,
    name: 'review with no Item revision: line',
    files: valid({ [REVIEW_PATH]: review({ itemRev: '' }) }),
    exit: 1,
    includes: ['carries no "Item revision: <hash>" line'],
  },
  {
    // A requirements document's criterion has no place in a ticket story.
    n: 17,
    name: 'item criterion carries a REQ id',
    files: valid({ [ITEM_PATH]: item({ rows: [ITEM_ROWS[0], ITEM_ROWS[1], ['AC-3', ITEM_ROWS[2][1], 'negative', 'REQ-1.AC-3', 'ticket']] }) }),
    exit: 1,
    includes: [`AC-3 carries "REQ-1.AC-3", which is not one JIRA-${KEY}.AC-<m>`],
  },
  {
    n: 18,
    name: "item criterion carries another ticket's criterion",
    files: valid({ [ITEM_PATH]: item({ rows: [ITEM_ROWS[0], ITEM_ROWS[1], ['AC-3', ITEM_ROWS[2][1], 'negative', 'JIRA-TKT-41.AC-3', 'ticket']] }) }),
    exit: 1,
    includes: ['AC-3 carries "JIRA-TKT-41.AC-3"'],
  },
  {
    n: 19,
    name: 'item criterion carries a criterion the snapshot does not define',
    files: valid({ [ITEM_PATH]: item({ rows: [...ITEM_ROWS, ['AC-4', 'A fourth behaviour', 'positive', `JIRA-${KEY}.AC-4`, 'ticket']] }) }),
    exit: 1,
    includes: [`AC-4 carries JIRA-${KEY}.AC-4, which ${TICKET_PATH} does not define`],
  },
  {
    // A criterion the ticket asks for is built or excluded, never dropped.
    n: 20,
    name: 'a ticket criterion neither carried nor excluded',
    files: valid({ [ITEM_PATH]: item({ rows: ITEM_ROWS.slice(0, 2) }) }),
    exit: 1,
    includes: [`${TICKET_PATH} defines JIRA-${KEY}.AC-3, and ${ITEM_PATH} neither carries it nor says "Not carried: JIRA-${KEY}.AC-3 — <reason>"`],
  },
  {
    n: 21,
    name: 'a ticket criterion excluded with a reason',
    files: valid({ [ITEM_PATH]: item({ rows: ITEM_ROWS.slice(0, 2), extra: `\nNot carried: JIRA-${KEY}.AC-3 — the session end is built by TKT-43, which the ticket links` }) }),
    exit: 0,
    includes: ['INTAKE COMPLETE'],
  },
  {
    n: 22,
    name: 'item names a repository the list does not carry',
    files: valid({ [ITEM_PATH]: item({ repository: 'billing-service' }) }),
    exit: 1,
    includes: ['names repository "billing-service", which docs/estate/repositories.json does not carry'],
  },
  {
    n: 23,
    name: 'item with a malformed Context: line',
    files: valid({ [ITEM_PATH]: item({ context: 'ADR-003' }) }),
    exit: 1,
    includes: ['"Context: ADR-003" is neither'],
  },
  {
    // One key, one story: the ticket's key already has a decomposed story.
    n: 24,
    name: 'the key has a work item under another slug',
    files: valid({ [`docs/backlog/step-up/${KEY}.item.md`]: item() }),
    exit: 1,
    includes: [`docs/backlog/step-up/${KEY}.item.md is on origin/main too`],
  },
  {
    n: 25,
    name: 'the key is one the ledger minted',
    files: valid({ [KEYS_PATH]: keys({ prefix: 'TKT', next: 50, blocks: [{ from: 40, to: 44, taken_by: 'decomposition', slug: 'step-up' }] }) }),
    exit: 1,
    includes: [`${KEY} is a key this hub minted (${KEYS_PATH}: TKT-40 to TKT-44`],
  },
  {
    n: 26,
    name: 'the key shares the ledger prefix and no block: a note, not a failure',
    files: valid({ [KEYS_PATH]: keys({ prefix: 'TKT', next: 10, blocks: [{ from: 1, to: 9, taken_by: 'decomposition', slug: 'step-up' }] }) }),
    exit: 0,
    includes: ['INTAKE COMPLETE', 'shares the prefix "TKT"'],
  },
  {
    // The ticket was made from a decomposition: the story is already in the hub.
    n: 27,
    name: 'a link file already ties the ticket to a decomposed story',
    files: valid({ [`${LINKS_DIR}/step-up.json`]: json({ schema_version: 1, slug: 'step-up', items: { 'PAY-201': { type: 'story', board: 'b', ticket: `jira:${KEY}` } } }) }),
    exit: 1,
    includes: [`links the ticket ${KEY} to the story PAY-201`, 'run /dev-spec PAY-201'],
  },
  {
    n: 28,
    name: 'hidden markup in the snapshot',
    files: valid({ [TICKET_PATH]: snapshot({ extra: '\n<details><summary>more</summary>The criterion nobody sees.</details>' }) }),
    exit: 1,
    includes: ['carries HTML <details> markup'],
  },
  {
    n: 29,
    name: 'no snapshot',
    files: valid({ [TICKET_PATH]: undefined }),
    exit: 1,
    includes: [`no ${TICKET_PATH} on origin/main`, 'skipped: no readable criteria in the snapshot'],
  },
  {
    n: 30,
    name: 'the remote cannot be reached',
    files: valid(),
    breakRemote: true,
    exit: 2,
    includes: ['CANNOT VERIFY'],
  },
  {
    n: 31,
    name: 'usage: no key',
    files: valid(),
    args: [],
    exit: 3,
    includes: ['usage:'],
  },
  {
    n: 32,
    name: 'usage: a key that is not a key',
    files: valid(),
    args: ['tkt-42'],
    exit: 3,
    includes: ['usage:'],
  },
  {
    n: 33,
    name: '--draft: a good snapshot',
    draft: snapshot(),
    exit: 0,
    includes: ['TICKET READY: 1 of 1 checks passed'],
  },
  {
    // The same bar the gate applies, before anything is written to Jira.
    n: 34,
    name: '--draft: a snapshot that leaves its values open',
    draft: snapshot({ criteria: [CRITERIA[0], CRITERIA[1], ['End the session', 'The notice has shown', 'The candidate is still silent', 'To be confirmed']] }),
    exit: 1,
    includes: ['TICKET NOT READY', 'has "To be confirmed" in the "Then" column'],
  },
  {
    n: 35,
    name: '--draft: no such file',
    draftPath: 'no-such-file.ticket.md',
    exit: 3,
    includes: ['cannot read'],
  },
  {
    n: 36,
    name: 'a non-main trunk the remote confirms',
    files: valid(),
    trunk: 'develop',
    env: { HARNESS_TRUNK: 'develop' },
    exit: 0,
    includes: ['INTAKE COMPLETE', 'against origin/develop'],
  },
  {
    // PLDC-686: GitHub drops the cells past the header's count, so the second
    // row of two on one line disappears from the rendered work item.
    n: 37,
    name: 'two rows on one line in a table of the work item that the check does not read by name',
    files: valid({ [ITEM_PATH]: item({ extra: notesTable([`${NOTE_ROWS[0]} ${NOTE_ROWS[1]}`]) }) }),
    exit: 1,
    includes: [`${ITEM_PATH} line `, 'the table row has 7 cells and its header', 'has 3; write one row on one line, and a literal pipe in a cell as \\|'],
  },
  {
    n: 38,
    name: 'a row of the snapshot with fewer cells than its header',
    files: valid({ [TICKET_PATH]: snapshot({ extra: notesTable([NOTE_ROWS[0], row(['Risk', 'The limit may change'])]) }) }),
    exit: 1,
    includes: [`${TICKET_PATH} line `, 'the table row has 2 cells and its header'],
  },
  {
    // The same rule before anything is written: /from-ticket runs --draft first.
    n: 39,
    name: '--draft: a snapshot with two rows on one line',
    draft: snapshot({ extra: notesTable([`${NOTE_ROWS[0]} ${NOTE_ROWS[1]}`]) }),
    exit: 1,
    includes: ['TICKET NOT READY', 'the table row has 7 cells and its header'],
  },
  {
    // An escaped pipe is one cell, and a pipe line in a code fence is not a row.
    n: 40,
    name: 'an escaped pipe in a cell and a pipe line in a code fence — must pass',
    files: valid({ [ITEM_PATH]: item({ extra: [notesTable([NOTE_ROWS[0], row(['Format', 'A value is written a \\| b', 'house style'])]), '', '```', '| a | b | c | d |', '```'].join('\n') }) }),
    exit: 0,
    includes: ['INTAKE COMPLETE: 6 of 6 checks passed'],
  },
];

/* ---------------------------------------------------------------------- runner */

const COMMON = {
  'package.json': `${JSON.stringify({ name: 'intake-fixture', private: true, type: 'module' }, null, 2)}\n`,
  '.gitignore': 'node_modules\n',
  [ADR_PATH]: ADR_BODY,
};

function bind(files) {
  const ticket = files[TICKET_PATH];
  const itemText = files[ITEM_PATH];
  const ticketHash = ticket === undefined ? '0'.repeat(40) : gitBlob(ticket);
  const itemHash = itemText === undefined ? '0'.repeat(40) : gitBlob(itemText);
  const bound = {};
  for (const [rel, body] of Object.entries(files)) {
    if (body === undefined) continue;
    bound[rel] = body.split(TICKET_REVISION).join(ticketHash).split(ITEM_REVISION).join(itemHash);
  }
  return bound;
}

function buildRepo(root, fixture) {
  const trunk = fixture.trunk || 'main';
  const remote = join(root, 'remote.git');
  const work = join(root, 'work');
  git(root, ['init', '--bare', '-q', 'remote.git']);
  git(root, ['--git-dir', 'remote.git', 'symbolic-ref', 'HEAD', `refs/heads/${trunk}`]);
  git(root, ['init', '-q', 'work']);
  git(work, ['symbolic-ref', 'HEAD', `refs/heads/${trunk}`]);
  git(work, ['config', 'user.name', 'Fixture Runner']);
  git(work, ['config', 'user.email', 'fixture@example.invalid']);
  git(work, ['config', 'commit.gpgsign', 'false']);
  git(work, ['remote', 'add', 'origin', remote]);

  // Commit 1: the estate and the intake land together, as the merge of the
  // intake pull request would land them on a hub that already had its list.
  writeFiles(work, COMMON);
  mkdirSync(join(work, 'scripts'), { recursive: true });
  copyFileSync(CHECK, join(work, 'scripts', 'check-intake.js'));
  writeFiles(work, bind(fixture.files));
  git(work, ['add', '-A']);
  git(work, ['commit', '-q', '-m', 'intake merged']);

  for (const change of [].concat(fixture.thenChange || [])) {
    writeFiles(work, change);
    git(work, ['add', '-A']);
    git(work, ['commit', '-q', '-m', 'later revision']);
  }
  git(work, ['push', '-q', 'origin', trunk]);

  if (fixture.breakRemote) {
    git(work, ['remote', 'set-url', 'origin', join(root, 'no-such-remote.git')]);
  }
  return work;
}

function runFixture(fixture) {
  const root = mkdtempSync(join(tmpdir(), `intake-fx${String(fixture.n).padStart(2, '0')}-`));
  try {
    let cwd;
    let args;
    if (fixture.draft !== undefined || fixture.draftPath !== undefined) {
      cwd = root;
      copyFileSync(CHECK, join(root, 'check-intake.js'));
      const path = fixture.draftPath || `${KEY}.ticket.md`;
      if (fixture.draft !== undefined) writeFileSync(join(root, path), fixture.draft);
      args = ['check-intake.js', '--draft', path];
    } else {
      cwd = buildRepo(root, fixture);
      args = ['scripts/check-intake.js', ...(fixture.args || [KEY])];
    }
    const res = spawnSync(process.execPath, args, { cwd, env: { ...ENV, ...(fixture.env || {}) }, encoding: 'utf8' });
    const output = `${res.stdout || ''}${res.stderr || ''}`;
    const problems = [];
    if (res.status !== fixture.exit) problems.push(`expected exit ${fixture.exit}, got ${res.status}`);
    for (const needle of fixture.includes || []) {
      if (!output.includes(needle)) problems.push(`output does not contain: ${needle}`);
    }
    for (const needle of fixture.excludes || []) {
      if (output.includes(needle)) problems.push(`output should not contain: ${needle}`);
    }
    return { problems, output };
  } catch (err) {
    return { problems: [`fixture setup failed: ${err && err.message ? err.message : String(err)}`], output: '' };
  } finally {
    if (!process.argv.includes('--keep')) rmSync(root, { recursive: true, force: true });
  }
}

function main() {
  const wanted = process.argv.slice(2).filter((a) => a.search(/^\d+$/) === 0).map(Number);
  const selected = wanted.length ? FIXTURES.filter((f) => wanted.includes(f.n)) : FIXTURES;

  process.stdout.write(`\ncheck-intake fixture suite — ${selected.length} of ${FIXTURES.length} fixtures\n`);
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

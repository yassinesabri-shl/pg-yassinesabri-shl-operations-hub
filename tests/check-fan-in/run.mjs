#!/usr/bin/env node
/**
 * run.mjs — the fixture suite for check-fan-in.mjs.
 *
 *   usage:  node run.mjs            run every fixture
 *           node run.mjs 3 7        run only the numbered fixtures
 *           node run.mjs --keep     leave the throwaway repositories on disk
 *
 * A fixture is an ESTATE STATE: a throwaway hub with a real bare `origin`, one
 * or more real bare spoke remotes on disk, the hub's list pointing at them, and
 * the shipped script run in the hub checkout exactly as `make fan-in SLUG=` runs
 * it. The hub gets the four scripts the install copies in -- the gate, the
 * validation check, spoke-remote.mjs and check-fan-in.mjs -- under scripts/, so
 * the `./spoke-remote.mjs` import and the beside-itself sibling lookup are
 * exercised in the layout they ship in. Nothing is imported and nothing is
 * stubbed. Exit code and messages are asserted.
 *
 * Each fixture builds its estate in code: spokes first, then the hub commit that
 * lands the designs (whose hash the reports need), then the reports naming that
 * commit and a real spoke commit. Nothing is substituted after the fact.
 *
 * Node standard library only, plus git via child_process. No test framework.
 * Exit 0 if every fixture passes, 1 if any fails.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

// Two layouts. The library: this suite at accelerator/gate/tests/check-fan-in/,
// the script and the two checks at accelerator/gate/, spoke-remote.mjs at
// accelerator/scripts/. An installed hub: this suite at tests/check-fan-in/ and
// all four scripts at scripts/, the checks under either extension.
function locate(label, candidates, override) {
  const found = [override, ...candidates].filter(Boolean).find((p) => existsSync(p));
  if (!found) {
    console.error(`cannot locate ${label}. Looked in order:`);
    for (const c of candidates) console.error(`  ${c}`);
    console.error(`\nSet HARNESS_${label.toUpperCase().replace(/[^A-Z]/g, '_')}=/path to override.`);
    process.exit(4);
  }
  return found;
}
const LIB_GATE = resolve(HERE, '..', '..');
const HUB_SCRIPTS = resolve(HERE, '..', '..', 'scripts');
const SCRIPT = locate('check-fan-in', [join(LIB_GATE, 'check-fan-in.mjs'), join(HUB_SCRIPTS, 'check-fan-in.mjs')], process.env.HARNESS_CHECK_FAN_IN);
const SPOKE_REMOTE = locate('spoke-remote', [resolve(LIB_GATE, '..', 'scripts', 'spoke-remote.mjs'), join(HUB_SCRIPTS, 'spoke-remote.mjs')], process.env.HARNESS_SPOKE_REMOTE);
const STORY_DONE = locate('story-done', [resolve(LIB_GATE, '..', 'scripts', 'story-done.mjs'), join(HUB_SCRIPTS, 'story-done.mjs')], process.env.HARNESS_STORY_DONE);
const GATE = locate('check-dev-ready', [join(LIB_GATE, 'check-dev-ready.js'), join(HUB_SCRIPTS, 'check-dev-ready.js'), join(HUB_SCRIPTS, 'check-dev-ready.mjs')], process.env.HARNESS_GATE);
const VALIDATION = locate('check-validation', [join(LIB_GATE, 'check-validation.js'), join(HUB_SCRIPTS, 'check-validation.js'), join(HUB_SCRIPTS, 'check-validation.mjs')], process.env.HARNESS_CHECK);
// Installed under the names a module hub uses, whatever the suite found them
// as: the fixture hub declares "type": "module", and the messages the fixtures
// pin name the sibling by the name it has there.
const ESCALATION_RECORD = locate('escalation-record', [resolve(LIB_GATE, '..', 'scripts', 'escalation-record.mjs'), join(HUB_SCRIPTS, 'escalation-record.mjs')], process.env.HARNESS_ESCALATION_RECORD);
const ESCALATION_STORE = locate('escalation-store', [resolve(LIB_GATE, '..', 'scripts', 'escalation-store.mjs'), join(HUB_SCRIPTS, 'escalation-store.mjs')], process.env.HARNESS_ESCALATION_STORE);
// The fake GitHub that holds the hub's [shl-harness] issues, shared with the escalation suite.
const FAKE_GH = locate('fake-gh', [resolve(LIB_GATE, '..', 'scripts', 'tests', 'escalation', 'fake-gh.mjs'), resolve(HERE, '..', 'escalation', 'fake-gh.mjs')], process.env.HARNESS_FAKE_GH);
const ESCALATION_POINTS = locate('escalation-points', [resolve(LIB_GATE, '..', 'governance', 'escalation-points.json'), resolve(HUB_SCRIPTS, '..', 'governance', 'escalation-points.json')], process.env.HARNESS_ESCALATION_POINTS);
const INSTALLED = [[SCRIPT, 'check-fan-in.mjs'], [SPOKE_REMOTE, 'spoke-remote.mjs'], [STORY_DONE, 'story-done.mjs'], [GATE, 'check-dev-ready.js'], [VALIDATION, 'check-validation.js'], [ESCALATION_RECORD, 'escalation-record.mjs'], [ESCALATION_STORE, 'escalation-store.mjs']];

/* ------------------------------------------------------------------ git helpers */

const SANDBOX_HOME = mkdtempSync(join(tmpdir(), 'fan-in-home-'));
const ENV = {
  ...process.env,
  HARNESS_TRUNK: 'main',
  HOME: SANDBOX_HOME,
  XDG_CONFIG_HOME: join(SANDBOX_HOME, '.config'),
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
  GIT_ASKPASS: 'true',
};
delete ENV.HARNESS_REPO;
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

function identity(work) {
  git(work, ['config', 'user.name', 'Fixture Runner']);
  git(work, ['config', 'user.email', 'fixture@example.invalid']);
  git(work, ['config', 'commit.gpgsign', 'false']);
}

/**
 * A bare spoke remote with a trunk of the given name and one commit per entry in
 * `commits`. `side` puts one more commit on a branch called `side`, pushed, so a
 * report can name a commit the spoke has that is not on its trunk. Returns the
 * URL (a plain path), the trunk commits oldest first, the head, and the side
 * commit if any.
 */
function spoke(root, name, { trunk = 'main', commits = [{ 'README.md': `# ${name}\n`, 'checks.env': 'TEST_COMMAND=npm test\nTRUNK_FOR_HUB=default\n' }], side = null, allowAnySha = true, branch = null } = {}) {
  const bare = join(root, `${name}.git`);
  const work = join(root, `${name}-work`);
  git(root, ['init', '--bare', '-q', '--initial-branch', trunk, bare]);
  git(root, ['--git-dir', bare, 'symbolic-ref', 'HEAD', `refs/heads/${trunk}`]);
  if (allowAnySha) git(root, ['--git-dir', bare, 'config', 'uploadpack.allowAnySHA1InWant', 'true']);
  git(root, ['init', '-q', '--initial-branch', trunk, work]);
  identity(work);
  const shas = [];
  commits.forEach((files, i) => {
    writeFiles(work, files);
    git(work, ['add', '-A']);
    git(work, ['commit', '-q', '-m', `commit ${i + 1}`]);
    shas.push(git(work, ['rev-parse', 'HEAD']).trim());
  });
  git(work, ['push', '-q', bare, trunk]);
  let sideSha = null;
  if (side) {
    git(work, ['checkout', '-q', '-b', 'side']);
    writeFiles(work, side);
    git(work, ['add', '-A']);
    git(work, ['commit', '-q', '-m', 'a draft on a side branch']);
    sideSha = git(work, ['rev-parse', 'HEAD']).trim();
    git(work, ['push', '-q', bare, 'side']);
    git(work, ['checkout', '-q', trunk]);
  }
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
  return { id: name, url: bare, shas, head: shas[shas.length - 1], trunk, side: sideSha, branchHead };
}

/**
 * The hub: a bare `origin` on `main` and a working clone with the four scripts
 * installed under scripts/ and committed, as the hub install leaves them.
 * `commit(files, message)` writes, commits and pushes, and returns the commit.
 */
function hub(root) {
  const bare = join(root, 'hub.git');
  const work = join(root, 'hub');
  git(root, ['init', '--bare', '-q', '--initial-branch', 'main', bare]);
  git(root, ['--git-dir', bare, 'symbolic-ref', 'HEAD', 'refs/heads/main']);
  git(root, ['init', '-q', '--initial-branch', 'main', work]);
  identity(work);
  git(work, ['remote', 'add', 'origin', bare]);
  writeFiles(work, {
    'package.json': `${JSON.stringify({ name: 'fan-in-fixture', private: true, type: 'module' }, null, 2)}\n`,
    '.gitignore': 'node_modules\n',
  });
  mkdirSync(join(work, 'scripts'), { recursive: true });
  for (const [src, name] of INSTALLED) copyFileSync(src, join(work, 'scripts', name));
  // escalation-record.mjs reads the list of stop points from governance/, beside scripts/.
  mkdirSync(join(work, 'governance'), { recursive: true });
  copyFileSync(ESCALATION_POINTS, join(work, 'governance', 'escalation-points.json'));
  const h = {
    bare,
    work,
    // The trunk commit a design's or a story's Hub commit: line names: the
    // install commit, which holds every hub document these fixtures have (none).
    installed: null,
    commit(files, message) {
      const pinned = Object.fromEntries(Object.entries(files).map(([rel, body]) => [rel, typeof body === 'string' && h.installed ? body.replaceAll(HUB_COMMIT, h.installed) : body]));
      // A review binds the design's bytes, and the pin above changed them.
      for (const [rel, body] of Object.entries(pinned)) {
        const designRel = rel.replace(/\.lld-review\.md$/, '.lld.md');
        if (designRel !== rel && typeof pinned[designRel] === 'string') pinned[rel] = body.replace(/^Design revision: [0-9a-f]{40}$/m, `Design revision: ${blobHash(pinned[designRel])}`);
      }
      writeFiles(work, pinned);
      git(work, ['add', '-A']);
      git(work, ['commit', '-q', '--allow-empty', '-m', message]);
      git(work, ['push', '-q', 'origin', 'main']);
      return git(work, ['rev-parse', 'HEAD']).trim();
    },
  };
  h.installed = h.commit({}, 'chore: install the harness scripts');
  h.github = join(root, 'github.json');
  writeFileSync(h.github, JSON.stringify({ repo: 'acme/hub', next: 1, issues: [], labels: [], pulls: [] }));
  const bin = join(root, 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'gh'), `#!/bin/sh\nexec "${process.execPath}" "${FAKE_GH}" "$@"\n`);
  chmodSync(join(bin, 'gh'), 0o755);
  h.env = { PATH: `${bin}:${process.env.PATH}`, FAKE_GH_STATE: h.github, GH_REPO: 'acme/hub' };
  return h;
}

/* ------------------------------------------------------------ the artefacts */

const SLUG = 'payments-onboarding';
// Replaced by the hub's install commit when a file is committed: the trunk commit
// a Hub commit: line names.
const HUB_COMMIT = '<HUB-COMMIT>';
const A = { key: 'PROJ-412', repo: 'transfer-service', title: 'step-up authentication on high-value transfers' };
const B = { key: 'PROJ-413', repo: 'ledger-service', title: 'the ledger records the step-up outcome' };

/* ------------------------------------------------- the escalation record, written by hand */

const raisedLine = (owner, number = 1) => ({
  schema_version: 1, id: `ESC-${owner}-${String(number).padStart(2, '0')}`, seq: 1, event: 'raised', at: '2026-10-29T14:02:11Z',
  by: { kind: 'seat', name: 'sprint-orchestrator' }, trigger: 'revision-cap', point: 'dev-sprint.code-review-cap', path: 'review-cap',
  work_item: owner === SLUG ? null : owner, slug: SLUG, repository: 'transfer-service', runner: 'dev-one',
  route: { first: 'runner', next: 'engineering lead' }, parked: null, question: 'Does a partial refund post one ledger line or two?',
  findings: null, links: { design: null, iteration_run: null }, hub_commit: '8a1d0e4c9b2f',
});
const stoppedLine = (owner, seq, number = 1) => ({
  schema_version: 1, id: `ESC-${owner}-${String(number).padStart(2, '0')}`, seq, event: 'stopped', at: '2026-10-30T11:20:00Z',
  by: { kind: 'person', role: 'engineering lead' }, reason: 'We dropped the refund ledger work.',
});

/** Put lines on the hub's GitHub, as another writer would: one [shl-harness] issue for each id. */
function pushRecord(h, owner, lines) {
  const state = JSON.parse(readFileSync(h.github, 'utf8'));
  const ids = [...new Set(lines.map((l) => l.id))];
  for (const id of ids) {
    const mine = lines.filter((l) => l.id === id);
    const fence = mine.map((l) => JSON.stringify(l)).join('\n');
    state.issues.push({
      number: state.next++, title: `[shl-harness] ${owner} · dev-sprint.code-review-cap`, body: `A record.\n\n<!-- shl-escalation id=${id} -->\nGenerated-by: SHL Agentic Harness\n`,
      state: 'open', state_reason: null, labels: [], user: 'dev-one', created_at: '2026-10-29T14:02:11Z',
      comments: mine.map((l, k) => ({ id: 1000 + state.next * 10 + k, body: `A line.\n\n\`\`\`json\n${JSON.stringify(l)}\n\`\`\`\n\n<!-- shl-escalation-line id=${id} seq=${l.seq} -->\nGenerated-by: SHL Agentic Harness\n`, user: { login: 'dev-one' }, author_association: 'COLLABORATOR', created_at: l.at })),
      artifacts: [{ number: 1, type: 'generic', name: 'escalation-record.jsonl', versions: [{ version: 1, body: `A note.\n\n\`\`\`jsonl\n${fence}\n\`\`\`\n`, actor: 'dev-one', created_at: '2026-10-29T14:02:11Z' }] }],
    });
  }
  writeFileSync(h.github, JSON.stringify(state, null, 2));
}

const row = (cells) => `| ${cells.map((c) => String(c)).join(' | ')} |`;
const sep = (n) => `|${'---|'.repeat(n)}`;

const entry = (remote, overrides = {}) => ({
  url: remote.url,
  checks: 'checks.env',
  purpose: `What ${remote.id} does, in one sentence, for ranking and nothing else.`,
  readAt: remote.head,
  trunk: 'default',
  ...overrides,
});
const registry = (repositories) => ({ 'docs/estate/repositories.json': `${JSON.stringify({ schema_version: 1, repositories }, null, 2)}\n` });

// The record: fan-in checks it is there and reads the stories from the item
// files, so the record is the shape's minimum. check-decomposition proves the rest.
function record(stories) {
  return {
    [`docs/backlog/${SLUG}.decomposition.md`]: [
      `# Decomposition — ${SLUG}`,
      '',
      '## Items',
      '',
      row(['Key', 'Title', 'Repository', 'Carries']),
      sep(4),
      ...stories.map((s) => row([s.key, s.title, `\`${s.repo}\``, 'REQ-1.AC-1'])),
      '',
    ].join('\n'),
  };
}

// The item carries the criteria the design below traces to: the pickup gate
// reads this table, and each Carries cell is the design's Requirement cell.
function item(story, overrides = {}) {
  const s = { key: story.key, repo: story.repo, ...overrides };
  return {
    [`docs/backlog/${SLUG}/${story.key}.item.md`]: [
      `# ${story.key} — ${story.title}`,
      '',
      ...(s.key === null ? [] : [`Key: ${s.key}`]),
      ...(s.repo === null ? [] : [`Repository: ${s.repo}`]),
      // No context document binds these stories, as none binds their designs.
      'Context: none',
      `Hub commit: ${HUB_COMMIT}`,
      '',
      '## Acceptance criteria',
      '',
      row(['ID', 'Criterion', 'Type', 'Carries', 'Source']),
      sep(5),
      ...CRITERIA.map(([id, criterion, carries, source]) => row([id, criterion, 'positive', carries, source])),
      '',
    ].join('\n'),
  };
}

// A design the pickup gate passes: the gate suite's control document, with the
// key, the title and the repository as parameters. `deprecated` marks the third
// criterion DEPRECATED so a report may carry N/A against it.
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

function design(story, { repository = story.repo, deprecated = false } = {}) {
  const criteria = deprecated
    ? [CRITERIA[0], CRITERIA[1], ['AC-3', 'DEPRECATED — superseded by REQ-2 revision 2', 'REQ-2.AC-1', 'FSD Authentication L131']]
    : CRITERIA;
  return [
    `# LLD — ${story.key}: ${story.title}`,
    '',
    '## 1. Traceability',
    '',
    `Ticket: ${story.key}`,
    `Repository: ${repository}`,
    // The gate reads a Rules: line too; these spokes declare no rules folder.
    'Rules: none',
    // And a Context: line; no context document binds these designs. The Hub
    // commit: line beside it names the trunk commit the hub was read at.
    'Context: none',
    `Hub commit: ${HUB_COMMIT}`,
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
    row(['ID', 'Criterion', 'Requirement', 'Source']),
    sep(4),
    ...criteria.map(row),
    '',
    '## 5. Testing plan',
    '',
    row(['AC', 'Test name', 'Level', 'Asserts']),
    sep(4),
    ...TESTS.map(row),
    '',
    'Coverage target for changed lines: 95%',
    '',
    '## 8. Readiness',
    '',
    'Spec Quality: READY',
    'Open Gaps: 0',
    'AC count: 3',
    'AC covered by tests: 3',
    'Contracts referenced: 1',
    'Blocking CLAR: 0',
    'Codebase verified: YES',
    'Self-check verdict: GATE_PASS',
    '',
    '## 9. Clarifications',
    '',
    'NONE',
    '',
  ].join('\n');
}

function blobHash(content) {
  const body = Buffer.from(content, 'utf8');
  return createHash('sha1').update(`blob ${body.length}\0`).update(body).digest('hex');
}

function review(story, designText) {
  return [
    `# Design review — ${story.key}`,
    '',
    'Reviewed against the signed functional specification and the repository tree.',
    '',
    '### VERDICT: APPROVED',
    `Design revision: ${blobHash(designText)}`,
    '',
  ].join('\n');
}

/** The design and the review that approves it, bound by the design's blob hash. `review: false` leaves the review out. */
function designPair(story, opts = {}) {
  const text = design(story, opts);
  const files = { [`docs/designs/${story.key}.lld.md`]: text };
  if (opts.review !== false) files[`docs/designs/${story.key}.lld-review.md`] = review(story, text);
  return files;
}

// The report, in the one shape check-validation reads. `verdicts` is one word
// per criterion; the closing line is derived from them the way the check derives
// it. `defects raised` is NONE, the one value check-validation accepts.
const HEADER = ['AC', 'Criterion (short)', 'Requirement', 'Verdict', 'Evidence'];
const SHORT = ['Step-up demanded above the threshold', 'Advisory view inherits the session', 'A failed factor writes nothing'];

// `verdicts` is one cell per criterion, written into the report as given; the
// closing line counts the token that remains once check-validation has stripped
// a comment from the cell, which is how the check reads it. `header` replaces
// the header row for a fixture about how it is read.
function report(story, { designCommit, spokeCommit, repository = story.repo, verdicts = ['PASS', 'PASS', 'PASS'], header = row(HEADER) }) {
  const rows = CRITERIA.map((c, i) => row([c[0], SHORT[i], c[2], verdicts[i], `${TESTS[i][1]} · src/transfer.py:${88 + i} · ${TESTS[i][3]}`]));
  const token = (v) => v.replace(/<!--[\s\S]*?-->/g, '').trim();
  const pass = verdicts.filter((v) => token(v) === 'PASS').length;
  const fail = verdicts.filter((v) => token(v) === 'FAIL').length;
  return {
    [`docs/designs/${story.key}.validation.md`]: [
      `# Validation — ${story.key}: ${story.title}`,
      '',
      `Design: docs/designs/${story.key}.lld.md at ${designCommit}`,
      `Repository: ${repository}`,
      `Spoke commit: ${spokeCommit}`,
      '',
      header,
      sep(HEADER.length),
      ...rows,
      '',
      `Criteria: ${verdicts.length} · PASS ${pass} · FAIL ${fail} · defects raised: NONE`,
      '',
    ].join('\n'),
  };
}

/* ------------------------------------------------------------------- fixtures */

// Each fixture's `build(root, hub)` makes the spokes and commits the hub's
// content; a fixture that needs no estate leaves it out. `args` replaces the
// default argument list; `env` adds to the environment the script sees.
// The story's branch is a side branch of one commit, which the report names.
// Another team's commit lands on the trunk after QA, and then a squash merge
// writes `feature` into src/feature.ts on the newer trunk. The text QA read is
// 'export const f = 1;'.
function squashBehind(root, h, feature) {
  const a = spoke(root, A.repo, { side: { 'src/feature.ts': 'export const f = 1;\n' } });
  const work = join(root, `${A.repo}-work`);
  writeFiles(work, { 'src/other.ts': 'export const o = 1;\n' });
  git(work, ['add', '-A']);
  git(work, ['commit', '-q', '-m', 'feat: another team\'s change']);
  writeFiles(work, { 'src/feature.ts': feature });
  git(work, ['add', '-A']);
  git(work, ['commit', '-q', '-m', `feat(${A.key}): the story, squashed`]);
  git(work, ['push', '-q', a.url, a.trunk]);
  const squashed = git(work, ['rev-parse', 'HEAD']).trim();
  const d = h.commit({ ...registry({ [A.repo]: entry(a, { readAt: squashed }) }), ...record([A]), ...item(A), ...designPair(A) }, 'design merged');
  h.commit(report(A, { designCommit: d, spokeCommit: a.side }), 'validation report merged');
}

const FIXTURES = [
  {
    n: 1,
    name: 'one story, one repository, everything done',
    build: (root, h) => {
      const a = spoke(root, A.repo);
      const d = h.commit({ ...registry({ [A.repo]: entry(a) }), ...record([A]), ...item(A), ...designPair(A) }, 'design merged');
      h.commit(report(A, { designCommit: d, spokeCommit: a.head }), 'validation report merged');
    },
    exit: 0,
    includes: ['[OK] transfer-service', 'trunk main at', '[PASS] PROJ-412  transfer-service', '1. design on the trunk and the pickup gate passes: yes', '2. validation report on the trunk and complete: yes', '3. every verdict PASS: yes (3 PASS)', "4. spoke commit on the repository's trunk: yes:", "is on transfer-service's trunk main", 'FEATURE DONE: 1 of 1 story passed'],
  },
  {
    // The estate the plan is about: two stories, two repositories, one of them on
    // a trunk that is not `main`, read from the remote and never assumed.
    n: 2,
    name: 'two stories in two repositories, one trunk called master, everything done',
    build: (root, h) => {
      const a = spoke(root, A.repo);
      const b = spoke(root, B.repo, { trunk: 'master' });
      const d = h.commit({ ...registry({ [A.repo]: entry(a), [B.repo]: entry(b) }), ...record([A, B]), ...item(A), ...item(B), ...designPair(A), ...designPair(B) }, 'designs merged');
      h.commit({ ...report(A, { designCommit: d, spokeCommit: a.head }), ...report(B, { designCommit: d, spokeCommit: b.head }) }, 'validation reports merged');
    },
    exit: 0,
    includes: ['[OK] ledger-service', 'trunk master at', '[PASS] PROJ-412  transfer-service', '[PASS] PROJ-413  ledger-service', "is on ledger-service's trunk master", 'FEATURE DONE: 2 of 2 stories passed'],
  },
  {
    n: 3,
    name: 'a story with no design on the trunk',
    build: (root, h) => {
      const a = spoke(root, A.repo);
      h.commit({ ...registry({ [A.repo]: entry(a) }), ...record([A]), ...item(A) }, 'stories cut, nothing designed');
    },
    exit: 1,
    includes: ['[FAIL] PROJ-412  transfer-service', '1. design on the trunk and the pickup gate passes: no: no docs/designs/PROJ-412.lld.md on origin/main; the design is not merged', '2. validation report on the trunk and complete: no: no docs/designs/PROJ-412.validation.md on origin/main', '3. every verdict PASS: not asked: needs 2', "4. spoke commit on the repository's trunk: not asked: needs 2", 'FEATURE NOT DONE: 0 of 1 story passed'],
    excludes: ['FEATURE DONE'],
  },
  {
    n: 4,
    name: 'design merged and eligible, report absent',
    build: (root, h) => {
      const a = spoke(root, A.repo);
      h.commit({ ...registry({ [A.repo]: entry(a) }), ...record([A]), ...item(A), ...designPair(A) }, 'design merged');
    },
    exit: 1,
    includes: ['1. design on the trunk and the pickup gate passes: yes', '2. validation report on the trunk and complete: no: no docs/designs/PROJ-412.validation.md on origin/main; /qa-sprint has not run, or its pull request is not merged', 'FEATURE NOT DONE: 0 of 1 story passed'],
  },
  {
    // check-validation refuses a report with a FAIL row, because a failing
    // criterion goes back to /dev-sprint before the merge. Fan-in reports it at
    // question 2 and asks nothing that reads the report's content.
    n: 5,
    name: 'a report with one FAIL',
    build: (root, h) => {
      const a = spoke(root, A.repo);
      const d = h.commit({ ...registry({ [A.repo]: entry(a) }), ...record([A]), ...item(A), ...designPair(A) }, 'design merged');
      h.commit(report(A, { designCommit: d, spokeCommit: a.head, verdicts: ['PASS', 'PASS', 'FAIL'] }), 'validation report merged');
    },
    exit: 1,
    includes: ['2. validation report on the trunk and complete: no: the validation check says "REPORT INCOMPLETE', '3. every verdict PASS: not asked: needs 2', 'FEATURE NOT DONE'],
  },
  {
    // The commit exists in the spoke, on a branch that never merged. The report
    // read code that is not the code on the trunk.
    n: 6,
    name: "the report's spoke commit is on a side branch of the spoke, not its trunk",
    build: (root, h) => {
      const a = spoke(root, A.repo, { side: { 'src/draft.ts': 'export {};\n' } });
      const d = h.commit({ ...registry({ [A.repo]: entry(a) }), ...record([A]), ...item(A), ...designPair(A) }, 'design merged');
      h.commit(report(A, { designCommit: d, spokeCommit: a.side }), 'validation report merged');
    },
    exit: 1,
    includes: ['3. every verdict PASS: yes', "4. spoke commit on the repository's trunk: no:", 'is a commit of transfer-service but not on its trunk main', 'the code the report read is not the code on the trunk', 'FEATURE NOT DONE'],
  },
  {
    n: 7,
    name: "the report's spoke commit is one the spoke does not have",
    build: (root, h) => {
      const a = spoke(root, A.repo);
      const d = h.commit({ ...registry({ [A.repo]: entry(a) }), ...record([A]), ...item(A), ...designPair(A) }, 'design merged');
      h.commit(report(A, { designCommit: d, spokeCommit: 'd'.repeat(40) }), 'validation report merged');
    },
    exit: 1,
    includes: ["4. spoke commit on the repository's trunk: no: dddddddddddd is not a commit transfer-service knows", 'either way it is not on main', 'FEATURE NOT DONE'],
  },
  {
    // One repository down is exit 2 for the whole run. The other story is done,
    // and that is not reported: "one of two" would be a verdict about a feature
    // nothing can see all of.
    n: 8,
    name: 'one spoke unreachable: exit 2, and no story is reported as passed',
    build: (root, h) => {
      const a = spoke(root, A.repo);
      const d = h.commit({
        ...registry({ [A.repo]: entry(a), [B.repo]: entry({ id: B.repo, url: join(root, 'no-such-remote.git'), head: 'b'.repeat(40) }) }),
        ...record([A, B]), ...item(A), ...item(B), ...designPair(A), ...designPair(B),
      }, 'designs merged');
      h.commit(report(A, { designCommit: d, spokeCommit: a.head }), 'one validation report merged');
    },
    exit: 2,
    includes: ['[OK] transfer-service', '[CANNOT VERIFY] ledger-service', 'cannot reach', 'CANNOT VERIFY: 1 of 2 repositories could not be reached (ledger-service)', 'no story is reported', 'REASON: remote-unreachable'],
    excludes: ['[PASS]', '[FAIL] PROJ', 'FEATURE'],
  },
  {
    n: 9,
    name: 'a slug with no decomposition record on the trunk',
    build: (root, h) => {
      const a = spoke(root, A.repo);
      h.commit(registry({ [A.repo]: entry(a) }), 'a list and nothing else');
    },
    exit: 1,
    includes: ['FAIL: no decomposition record for "payments-onboarding" on origin/main (docs/backlog/payments-onboarding.decomposition.md); run /decompose'],
  },
  {
    n: 10,
    name: 'usage: no slug',
    args: [],
    exit: 3,
    includes: ['expected exactly one argument', 'usage: node'],
  },
  {
    n: 11,
    name: 'usage: not a slug',
    args: ['Payments_Onboarding'],
    exit: 3,
    includes: ['"Payments_Onboarding" is not a slug'],
  },
  {
    // The design is there and its review is not: the gate fails, and fan-in quotes
    // the gate's own summary rather than re-judging the design.
    n: 12,
    name: 'design on the trunk without an approved review: the pickup gate fails',
    build: (root, h) => {
      const a = spoke(root, A.repo);
      h.commit({ ...registry({ [A.repo]: entry(a) }), ...record([A]), ...item(A), ...designPair(A, { review: false }) }, 'design merged, no review');
    },
    exit: 1,
    includes: ['1. design on the trunk and the pickup gate passes: no: the pickup gate says "NOT ELIGIBLE:', 'node scripts/check-dev-ready.js PROJ-412, as transfer-service', 'FEATURE NOT DONE'],
  },
  {
    // Asked as the story's repository, so a design that names the other one fails
    // here with the gate's own words.
    n: 13,
    name: "a design written for the other spoke: the gate fails with 'is asking'",
    build: (root, h) => {
      const a = spoke(root, A.repo);
      const b = spoke(root, B.repo);
      h.commit({ ...registry({ [A.repo]: entry(a), [B.repo]: entry(b) }), ...record([A]), ...item(A), ...designPair(A, { repository: B.repo }) }, 'design merged for the wrong repository');
    },
    exit: 1,
    includes: ['1. design on the trunk and the pickup gate passes: no: the pickup gate says "NOT ELIGIBLE:', 'FEATURE NOT DONE'],
  },
  {
    // The design and the report agree with each other and both name the other
    // spoke, so check-validation passes the report; the story is the one that
    // disagrees. The gate fails asked as the story's repository, and question 4
    // says which line is wrong rather than asking the wrong trunk.
    n: 14,
    name: "the design and the report both name the other spoke; the story names this one",
    build: (root, h) => {
      const a = spoke(root, A.repo);
      const b = spoke(root, B.repo);
      const d = h.commit({ ...registry({ [A.repo]: entry(a), [B.repo]: entry(b) }), ...record([A]), ...item(A), ...designPair(A, { repository: B.repo }) }, 'design merged');
      h.commit(report(A, { designCommit: d, spokeCommit: b.head, repository: B.repo }), 'validation report merged');
    },
    exit: 1,
    includes: ['1. design on the trunk and the pickup gate passes: no: the pickup gate says "NOT ELIGIBLE:', '2. validation report on the trunk and complete: yes', "4. spoke commit on the repository's trunk: no: the report says Repository: ledger-service and the story says transfer-service", 'FEATURE NOT DONE'],
  },
  {
    n: 15,
    name: 'a story naming a repository the list does not carry',
    build: (root, h) => {
      const a = spoke(root, A.repo);
      const d = h.commit({ ...registry({ [A.repo]: entry(a) }), ...record([A, B]), ...item(A), ...item(B), ...designPair(A), ...designPair(B) }, 'designs merged');
      h.commit({ ...report(A, { designCommit: d, spokeCommit: a.head }), ...report(B, { designCommit: d, spokeCommit: a.head }) }, 'validation reports merged');
    },
    exit: 1,
    includes: ['[FAIL] ledger-service', 'not in docs/estate/repositories.json', '[PASS] PROJ-412  transfer-service', '[FAIL] PROJ-413  ledger-service', '"ledger-service" is not in docs/estate/repositories.json; check-decomposition refuses this story', 'FEATURE NOT DONE: 1 of 2 stories passed'],
  },
  {
    // HARNESS_TRUNK names the trunk; it does not choose one.
    n: 16,
    name: "HARNESS_TRUNK names a branch that is not the hub's default: exit 2",
    env: { HARNESS_TRUNK: 'develop' },
    build: (root, h) => {
      const a = spoke(root, A.repo);
      h.commit({ ...registry({ [A.repo]: entry(a) }), ...record([A]), ...item(A) }, 'stories cut');
      git(h.work, ['push', '-q', 'origin', 'main:develop']);
    },
    exit: 2,
    includes: ['CANNOT VERIFY: this check was pointed at "develop" but origin\'s default branch is "main"', 'REASON: trunk-mismatch'],
  },
  {
    n: 17,
    name: 'a record with no item files under it',
    build: (root, h) => {
      const a = spoke(root, A.repo);
      h.commit({ ...registry({ [A.repo]: entry(a) }), ...record([]) }, 'an empty record');
    },
    exit: 1,
    includes: ['FAIL: the record for "payments-onboarding" is on origin/main but docs/backlog/payments-onboarding/ holds no *.item.md'],
  },
  {
    // N/A against a DEPRECATED criterion is not a failed verdict. check-validation
    // has already refused it anywhere else.
    n: 18,
    name: 'a report with N/A against a deprecated criterion, the rest PASS: done',
    build: (root, h) => {
      const a = spoke(root, A.repo);
      const d = h.commit({ ...registry({ [A.repo]: entry(a) }), ...record([A]), ...item(A), ...designPair(A, { deprecated: true }) }, 'design merged');
      h.commit(report(A, { designCommit: d, spokeCommit: a.head, verdicts: ['PASS', 'PASS', 'N/A'] }), 'validation report merged');
    },
    exit: 0,
    includes: ['3. every verdict PASS: yes (2 PASS, 1 N/A against a deprecated criterion)', 'FEATURE DONE: 1 of 1 story passed'],
  },
  {
    n: 19,
    name: 'no list of repositories on the trunk: exit 2',
    build: (root, h) => {
      h.commit({ ...record([A]), ...item(A), ...designPair(A) }, 'stories and a design, no list');
    },
    exit: 2,
    includes: ['CANNOT VERIFY: no list of repositories at docs/estate/repositories.json on origin/main; run /add-repo', 'REASON: registry-missing'],
  },
  {
    n: 20,
    name: 'one story done and one not: the feature is not done',
    build: (root, h) => {
      const a = spoke(root, A.repo);
      const b = spoke(root, B.repo, { trunk: 'master' });
      const d = h.commit({ ...registry({ [A.repo]: entry(a), [B.repo]: entry(b) }), ...record([A, B]), ...item(A), ...item(B), ...designPair(A), ...designPair(B) }, 'designs merged');
      h.commit(report(A, { designCommit: d, spokeCommit: a.head }), 'one validation report merged');
    },
    exit: 1,
    includes: ['[PASS] PROJ-412  transfer-service', '[FAIL] PROJ-413  ledger-service', 'no docs/designs/PROJ-413.validation.md on origin/main', 'FEATURE NOT DONE: 1 of 2 stories passed'],
    excludes: ['FEATURE DONE'],
  },
  {
    // The install puts the gate, the two checks and this script in one directory.
    // A missing sibling is an install fault, and "cannot verify" is the honest code.
    n: 21,
    name: 'check-validation is not installed beside the script: exit 2',
    build: (root, h) => {
      const a = spoke(root, A.repo);
      h.commit({ ...registry({ [A.repo]: entry(a) }), ...record([A]), ...item(A) }, 'stories cut');
      rmSync(join(h.work, 'scripts', 'check-validation.js'));
    },
    exit: 2,
    includes: ['CANNOT VERIFY: check-validation.js (or .mjs) is not beside check-fan-in.mjs', 'REASON: script-missing'],
  },
  {
    // A side-branch commit already in the cache from an earlier run must not read
    // as "on the trunk": the ancestry question is asked of the trunk head, not of
    // the cache's contents.
    n: 22,
    name: 'a side-branch commit already in the spoke cache is still not on the trunk',
    build: (root, h) => {
      const a = spoke(root, A.repo, { side: { 'src/draft.ts': 'export {};\n' } });
      const cache = join(root, 'cache', `${A.repo}.git`);
      mkdirSync(join(root, 'cache'), { recursive: true });
      git(root, ['init', '--bare', '--quiet', cache]);
      git(root, ['--git-dir', cache, 'fetch', '--quiet', '--no-tags', a.url, 'side']);
      const d = h.commit({ ...registry({ [A.repo]: entry(a) }), ...record([A]), ...item(A), ...designPair(A) }, 'design merged');
      h.commit(report(A, { designCommit: d, spokeCommit: a.side }), 'validation report merged');
    },
    exit: 1,
    includes: ['is a commit of transfer-service but not on its trunk main', 'FEATURE NOT DONE'],
  },
  {
    // A malformed item file is a story under this slug, and it fails with its
    // fault named rather than dropping out of the list.
    n: 23,
    name: 'an item file with no Repository line is listed and fails',
    build: (root, h) => {
      const a = spoke(root, A.repo);
      const d = h.commit({ ...registry({ [A.repo]: entry(a) }), ...record([A]), ...item(A, { repo: null }), ...designPair(A) }, 'design merged');
      h.commit(report(A, { designCommit: d, spokeCommit: a.head }), 'validation report merged');
    },
    exit: 1,
    includes: ['[FAIL] PROJ-412  (repository unknown)', 'item file: the item file has no "Repository: <id>" line', "4. spoke commit on the repository's trunk: no: the story names no repository", 'FEATURE NOT DONE'],
  },
  {
    // The hub's trunk moved on after the report: a later commit to the hub that
    // does not touch the design leaves the report bound and the feature done.
    n: 24,
    name: 'later unrelated hub commits after the report: still done',
    build: (root, h) => {
      const a = spoke(root, A.repo);
      const d = h.commit({ ...registry({ [A.repo]: entry(a) }), ...record([A]), ...item(A), ...designPair(A) }, 'design merged');
      h.commit(report(A, { designCommit: d, spokeCommit: a.head }), 'validation report merged');
      h.commit({ 'docs/notes.md': 'A note that touches nothing the checks read.\n' }, 'later hub commit');
    },
    exit: 0,
    includes: ['FEATURE DONE: 1 of 1 story passed'],
  },
  {
    // The spoke's trunk moved on after the report: the commit the report read is
    // an ancestor of the new head, and that is what "on the trunk" means.
    n: 25,
    name: 'the spoke trunk moved on after the report: the read commit is an ancestor, still done',
    build: (root, h) => {
      const a = spoke(root, A.repo, { commits: [{ 'README.md': '# transfer-service\n', 'checks.env': 'TEST_COMMAND=npm test\nTRUNK_FOR_HUB=default\n' }, { 'src/app.ts': 'export {};\n' }] });
      const d = h.commit({ ...registry({ [A.repo]: entry(a) }), ...record([A]), ...item(A), ...designPair(A) }, 'design merged');
      h.commit(report(A, { designCommit: d, spokeCommit: a.shas[0] }), 'validation report merged');
    },
    exit: 0,
    includes: ["is on transfer-service's trunk main (head", 'FEATURE DONE: 1 of 1 story passed'],
  },
  {
    // The cache is shared with the depth-1 readers. A depth-1 fetch of the trunk
    // head leaves a shallow boundary, and a plain fetch never deepens past it; an
    // older trunk commit then looks like "not on the trunk". The full fetch must
    // unshallow, so the ancestry question is asked of the real history.
    n: 26,
    name: 'a shallow spoke cache from an earlier depth-1 read: an older trunk commit is still on the trunk',
    build: (root, h) => {
      const a = spoke(root, A.repo, { commits: [{ 'README.md': '# transfer-service\n', 'checks.env': 'TEST_COMMAND=npm test\nTRUNK_FOR_HUB=default\n' }, { 'src/app.ts': 'export {};\n' }, { 'src/more.ts': 'export {};\n' }] });
      const cache = join(root, 'cache', `${A.repo}.git`);
      mkdirSync(join(root, 'cache'), { recursive: true });
      git(root, ['init', '--bare', '--quiet', cache]);
      git(root, ['--git-dir', cache, 'fetch', '--quiet', '--depth', '1', '--no-tags', a.url, 'main']);
      const d = h.commit({ ...registry({ [A.repo]: entry(a) }), ...record([A]), ...item(A), ...designPair(A) }, 'design merged');
      h.commit(report(A, { designCommit: d, spokeCommit: a.shas[0] }), 'validation report merged');
    },
    exit: 0,
    includes: ["is on transfer-service's trunk main (head", 'FEATURE DONE: 1 of 1 story passed'],
  },
  {
    // check-validation strips a comment from a cell before it reads the verdict,
    // so this report is complete and passing. Fan-in must read the cell the same
    // way, or check-validation passes a report whose table fan-in cannot read.
    n: 27,
    name: 'a PASS verdict with an inline comment beside it is still a PASS',
    build: (root, h) => {
      const a = spoke(root, A.repo);
      const d = h.commit({ ...registry({ [A.repo]: entry(a) }), ...record([A]), ...item(A), ...designPair(A) }, 'design merged');
      h.commit(report(A, { designCommit: d, spokeCommit: a.head, verdicts: ['PASS', 'PASS', 'PASS <!-- re-run before release -->'] }), 'validation report merged');
    },
    exit: 0,
    includes: ['2. validation report on the trunk and complete: yes', '3. every verdict PASS: yes (3 PASS)', 'FEATURE DONE'],
  },
  {
    // A file name that is not a key is a story under the slug, listed with its
    // fault; the two checks would exit 3 on it, so they are not asked.
    n: 28,
    name: 'an item file whose name is not a work-item key is listed, fails, and asks nothing',
    build: (root, h) => {
      const a = spoke(root, A.repo);
      h.commit({ ...registry({ [A.repo]: entry(a) }), ...record([A]), ...item(A), [`docs/backlog/${SLUG}/PROJ-412.v2.item.md`]: `# PROJ-412.v2\n\nKey: PROJ-412.v2\nRepository: ${A.repo}\n`, ...designPair(A) }, 'stories cut');
    },
    exit: 1,
    includes: ['[FAIL] PROJ-412.v2  transfer-service', 'item file: the file name "PROJ-412.v2.item.md" is not <KEY>.item.md', '1. design on the trunk and the pickup gate passes: not asked: the file name is not a work-item key', 'FEATURE NOT DONE: 0 of 2 stories passed'],
    excludes: ['INTERNAL'],
  },
  {
    // Invisible characters are not content to check-validation, whose header
    // match strips them; the same report must not read as "no table" here.
    n: 29,
    name: 'a soft hyphen inside the header row: the table is still read',
    build: (root, h) => {
      const a = spoke(root, A.repo);
      const d = h.commit({ ...registry({ [A.repo]: entry(a) }), ...record([A]), ...item(A), ...designPair(A) }, 'design merged');
      h.commit(report(A, { designCommit: d, spokeCommit: a.head, header: row(['AC', 'Crit\u00ADerion (short)', 'Requirement', 'Verdict', 'Evidence']) }), 'validation report merged');
    },
    exit: 0,
    includes: ['3. every verdict PASS: yes (3 PASS)', 'FEATURE DONE: 1 of 1 story passed'],
  },
  {
    // The hub checkout on a CI runner carries the runner's own credential in its
    // local git configuration, for every address on the forge, and git sends
    // that in preference to a token in the address. A spoke asked from inside
    // the hub would be answered as the hub, and a private one is "not found".
    // Here the hub's local configuration rewrites the spoke's address to
    // nowhere; the check must not notice.
    n: 30,
    name: "a spoke is asked from its cache, never from the hub checkout, so the hub's local git configuration cannot reach it",
    build: (root, h) => {
      const a = spoke(root, A.repo);
      git(h.work, ['config', '--local', 'url.file:///nonexistent/.insteadOf', a.url]);
      const d = h.commit({ ...registry({ [A.repo]: entry(a) }), ...record([A]), ...item(A), ...designPair(A) }, 'design merged');
      h.commit(report(A, { designCommit: d, spokeCommit: a.head }), 'validation report merged');
    },
    exit: 0,
    includes: ['[OK] transfer-service', 'FEATURE DONE: 1 of 1 story passed'],
    excludes: ['cannot reach'],
  },
  {
    // The spoke commit is only on harness-main, so a read of the default branch fails question 4.
    n: 31,
    name: 'a spoke with a declared trunk: question 4 is asked of harness-main, not the default branch',
    build: (root, h) => {
      const a = spoke(root, A.repo, {
        commits: [{ 'README.md': '# transfer-service\n' }, { 'src/bau.ts': 'export {};\n' }],
        branch: { name: 'harness-main', commits: [{ 'checks.env': 'TEST_COMMAND=npm test\nTRUNK_FOR_HUB=harness-main\n', 'src/app.ts': 'export {};\n' }] },
      });
      const d = h.commit({ ...registry({ [A.repo]: entry(a, { trunk: 'harness-main', readAt: a.branchHead }) }), ...record([A]), ...item(A), ...designPair(A) }, 'design merged');
      h.commit(report(A, { designCommit: d, spokeCommit: a.branchHead }), 'validation report merged');
    },
    exit: 0,
    includes: ['[OK] transfer-service', 'trunk harness-main at', "is on transfer-service's trunk harness-main", 'FEATURE DONE: 1 of 1 story passed'],
    excludes: ['trunk main at'],
  },
  {
    // /qa-sprint validated the head of the pull request; a squash merge wrote a new
    // trunk commit with the same tree, because the branch was up to date.
    n: 32,
    name: 'a squash merge of an up-to-date branch: the trunk commit has the tree the report read',
    build: (root, h) => {
      const a = spoke(root, A.repo, { side: { 'src/feature.ts': 'export const f = 1;\n' } });
      const work = join(root, `${A.repo}-work`);
      writeFiles(work, { 'src/feature.ts': 'export const f = 1;\n' });
      git(work, ['add', '-A']);
      git(work, ['commit', '-q', '-m', 'feat: the story, squashed']);
      git(work, ['push', '-q', a.url, a.trunk]);
      const squashed = git(work, ['rev-parse', 'HEAD']).trim();
      const d = h.commit({ ...registry({ [A.repo]: entry(a, { readAt: squashed }) }), ...record([A]), ...item(A), ...designPair(A) }, 'design merged');
      h.commit(report(A, { designCommit: d, spokeCommit: a.side }), 'validation report merged');
    },
    exit: 0,
    includes: ["merged into transfer-service's trunk main as", 'with the same tree (a squash or a rebase merge)', 'FEATURE DONE: 1 of 1 story passed'],
  },
  {
    // The trunk moved on before the squash, so no trunk commit has the tree QA
    // read. The squash commit holds the change QA validated, on a newer trunk.
    n: 33,
    name: 'a squash merge of a branch behind the trunk: the trunk commit has the change the report read',
    build: (root, h) => squashBehind(root, h, 'export const f = 1;\n'),
    exit: 0,
    includes: ['with the same change on a newer trunk (a squash or a rebase merge of a branch behind the trunk); QA did not read the merged tree', 'FEATURE DONE: 1 of 1 story passed'],
  },
  {
    // A stopped story stays in the backlog. The record says so, and fan-in names it.
    n: 34,
    name: 'a story whose escalation ended in stopped is named, with the person, the time and their words, and the verdict does not change',
    build: (root, h) => {
      const a = spoke(root, A.repo);
      h.commit({ ...registry({ [A.repo]: entry(a) }), ...record([A]), ...item(A), ...designPair(A) }, 'design merged');
      pushRecord(h, A.key, [raisedLine(A.key), stoppedLine(A.key, 2)]);
    },
    exit: 1,
    includes: ['[FAIL] PROJ-412  transfer-service', 'escalation: [STOPPED] ESC-PROJ-412-01 at dev-sprint.code-review-cap, 2026-10-30T11:20:00Z, by engineering lead: We dropped the refund ledger work.', '1 story was stopped by a person (PROJ-412)', 'FEATURE NOT DONE'],
  },
  {
    n: 35,
    name: 'an escalation that is still open, or that a newer one follows, is not reported as stopped',
    build: (root, h) => {
      const a = spoke(root, A.repo);
      h.commit({ ...registry({ [A.repo]: entry(a) }), ...record([A]), ...item(A), ...designPair(A) }, 'design merged');
      pushRecord(h, A.key, [raisedLine(A.key), stoppedLine(A.key, 2), raisedLine(A.key, 2)]);
    },
    exit: 1,
    includes: ['FEATURE NOT DONE'],
    excludes: ['STOPPED', 'was stopped'],
  },
  {
    n: 36,
    name: 'a feature whose own escalation ended in stopped is named before its stories',
    build: (root, h) => {
      const a = spoke(root, A.repo);
      h.commit({ ...registry({ [A.repo]: entry(a) }), ...record([A]), ...item(A), ...designPair(A) }, 'design merged');
      pushRecord(h, SLUG, [raisedLine(SLUG), stoppedLine(SLUG, 2)]);
    },
    exit: 1,
    includes: ['escalation of the feature', '[STOPPED] ESC-payments-onboarding-01 at dev-sprint.code-review-cap'],
  },
  {
    n: 37,
    name: 'an escalation record that cannot be read is exit 2, never "no escalation"',
    build: (root, h) => {
      const a = spoke(root, A.repo);
      h.commit({ ...registry({ [A.repo]: entry(a) }), ...record([A]), ...item(A), ...designPair(A) }, 'design merged');
      pushRecord(h, A.key, [raisedLine(A.key), { ...stoppedLine(A.key, 2), seq: 5 }]);
    },
    exit: 2,
    includes: ['the escalation record cannot be read', 'PROJ-412', 'a line is missing', 'REASON: record-unreadable'],
  },
  {
    n: 38,
    name: 'a hub with no harness issue yet reports nothing about escalations and the run is as before',
    build: (root, h) => {
      const a = spoke(root, A.repo);
      const d = h.commit({ ...registry({ [A.repo]: entry(a) }), ...record([A]), ...item(A), ...designPair(A) }, 'design merged');
      h.commit(report(A, { designCommit: d, spokeCommit: a.head }), 'validation report merged');
    },
    exit: 0,
    includes: ['FEATURE DONE: 1 of 1 story passed'],
    excludes: ['escalation'],
  },
  {
    // The squash commit changed the code QA read, so the trunk holds neither its
    // tree nor its change.
    n: 39,
    name: 'a squash merge of a branch behind the trunk, with another change: no trunk commit has the tree or the change the report read',
    build: (root, h) => squashBehind(root, h, 'export const f = 2;\n'),
    exit: 1,
    includes: ['and no trunk commit since the two lines parted has its tree or its change; the code the report read is not the code on the trunk', 'names PROJ-412 in its message', 'FEATURE NOT DONE'],
  },
];

/* ---------------------------------------------------------------------- runner */

function runFixture(fixture) {
  const root = mkdtempSync(join(tmpdir(), `fan-in-fx${String(fixture.n).padStart(2, '0')}-`));
  try {
    const h = hub(root);
    if (fixture.build) fixture.build(root, h);
    const res = spawnSync(process.execPath, [join(h.work, 'scripts', 'check-fan-in.mjs'), ...(fixture.args || [SLUG])], {
      cwd: h.work,
      env: { ...ENV, HARNESS_SPOKE_CACHE: join(root, 'cache'), ...h.env, ...(fixture.env || {}) },
      encoding: 'utf8',
    });
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
  const wanted = process.argv.slice(2).filter((a) => /^\d+$/.test(a)).map(Number);
  const selected = wanted.length ? FIXTURES.filter((f) => wanted.includes(f.n)) : FIXTURES;
  process.stdout.write(`\ncheck under test: ${SCRIPT}\n${selected.length} of ${FIXTURES.length} fixtures\n\n`);
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
    ? `\n${failed} of ${selected.length} fixtures FAILED. The fan-in check is not trustworthy until this is green.\n`
    : `\nAll ${selected.length} fixtures passed.\n`);
  rmSync(SANDBOX_HOME, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
}

main();

#!/usr/bin/env node
/**
 * run.mjs — the fixture suite for check-dependencies.mjs.
 *
 *   usage:  node run.mjs            run every fixture
 *           node run.mjs 3 7        run only the numbered fixtures
 *           node run.mjs --keep     leave the throwaway repositories on disk
 *
 * A fixture is a HUB STATE: a throwaway hub with a real bare `origin`, and the
 * shipped script run in the hub checkout exactly as a command runs it. The hub
 * gets the scripts the install copies in -- the gate, the validation check,
 * spoke-remote.mjs, story-done.mjs and check-dependencies.mjs -- under scripts/,
 * so the imports and the beside-itself sibling lookup run in the layout they
 * ship in. Nothing is imported and nothing is stubbed. The exit code and the
 * text are asserted.
 *
 * The design step reads no spoke. The code step reads one bare spoke remote for
 * each dependency, which the `spoke` builder makes. A fixture that needs a real
 * `Hub commit:` builds the hub in several commits, and a later design names an
 * earlier commit.
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

// Two layouts. The library: this suite at accelerator/gate/tests/check-dependencies/,
// the script and the two checks at accelerator/gate/, spoke-remote.mjs and
// story-done.mjs at accelerator/scripts/. An installed hub: this suite at
// tests/check-dependencies/ and every script at scripts/, the checks under
// either extension.
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
const SCRIPT = locate('check-dependencies', [join(LIB_GATE, 'check-dependencies.mjs'), join(HUB_SCRIPTS, 'check-dependencies.mjs')], process.env.HARNESS_CHECK_DEPENDENCIES);
const SPOKE_REMOTE = locate('spoke-remote', [resolve(LIB_GATE, '..', 'scripts', 'spoke-remote.mjs'), join(HUB_SCRIPTS, 'spoke-remote.mjs')], process.env.HARNESS_SPOKE_REMOTE);
const STORY_DONE = locate('story-done', [resolve(LIB_GATE, '..', 'scripts', 'story-done.mjs'), join(HUB_SCRIPTS, 'story-done.mjs')], process.env.HARNESS_STORY_DONE);
const GATE = locate('check-dev-ready', [join(LIB_GATE, 'check-dev-ready.js'), join(HUB_SCRIPTS, 'check-dev-ready.js'), join(HUB_SCRIPTS, 'check-dev-ready.mjs')], process.env.HARNESS_GATE);
const VALIDATION = locate('check-validation', [join(LIB_GATE, 'check-validation.js'), join(HUB_SCRIPTS, 'check-validation.js'), join(HUB_SCRIPTS, 'check-validation.mjs')], process.env.HARNESS_CHECK);
// Installed under the names a module hub uses, whatever the suite found them
// as: the fixture hub declares "type": "module", and the messages the fixtures
// pin name the sibling by the name it has there.
const INSTALLED = [[SCRIPT, 'check-dependencies.mjs'], [SPOKE_REMOTE, 'spoke-remote.mjs'], [STORY_DONE, 'story-done.mjs'], [GATE, 'check-dev-ready.js'], [VALIDATION, 'check-validation.js']];

/* ------------------------------------------------------------------ git helpers */

const SANDBOX_HOME = mkdtempSync(join(tmpdir(), 'dependencies-home-'));
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
 * report can name a commit that the spoke has and the trunk has not. Copied from
 * the check-fan-in suite. Returns the URL (a plain path), the head, and the side
 * commit if any.
 */
function spoke(root, name, { trunk = 'main', side = null } = {}) {
  const bare = join(root, `${name}.git`);
  const work = join(root, `${name}-work`);
  git(root, ['init', '--bare', '-q', '--initial-branch', trunk, bare]);
  git(root, ['--git-dir', bare, 'symbolic-ref', 'HEAD', `refs/heads/${trunk}`]);
  git(root, ['--git-dir', bare, 'config', 'uploadpack.allowAnySHA1InWant', 'true']);
  git(root, ['init', '-q', '--initial-branch', trunk, work]);
  identity(work);
  writeFiles(work, { 'README.md': `# ${name}\n`, 'checks.env': 'TEST_COMMAND=npm test\nTRUNK_FOR_HUB=default\n' });
  git(work, ['add', '-A']);
  git(work, ['commit', '-q', '-m', 'commit 1']);
  git(work, ['push', '-q', bare, trunk]);
  const head = git(work, ['rev-parse', 'HEAD']).trim();
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
  return { id: name, url: bare, work, head, trunk, side: sideSha };
}

/**
 * The hub: a bare `origin` on `main` and a working clone with the scripts
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
    'package.json': `${JSON.stringify({ name: 'dependencies-fixture', private: true, type: 'module' }, null, 2)}\n`,
    '.gitignore': 'node_modules\n',
  });
  mkdirSync(join(work, 'scripts'), { recursive: true });
  for (const [src, name] of INSTALLED) copyFileSync(src, join(work, 'scripts', name));
  const h = {
    bare,
    work,
    // The trunk commit a design's or a story's Hub commit: line names by
    // default: the install commit, which holds no hub document.
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
  return h;
}

/* ------------------------------------------------------------ the artefacts */

const SLUG = 'menu-pricing';
// Replaced by the hub's install commit when a file is committed.
const HUB_COMMIT = '<HUB-COMMIT>';
const S1 = { key: 'SHOP-1', repo: 'catalogue-api', title: 'the catalogue exposes a price per item' };
const S2 = { key: 'SHOP-2', repo: 'menu-web', title: 'the menu shows the price of each item' };
const S3 = { key: 'SHOP-3', repo: 'orders-api', title: 'an order records the price it was placed at' };

const row = (cells) => `| ${cells.map((c) => String(c)).join(' | ')} |`;
const sep = (n) => `|${'---|'.repeat(n)}`;

// The record: the check reads only its dependency map, one row per edge.
function record(stories, edges, slug = SLUG) {
  return {
    [`docs/backlog/${slug}.decomposition.md`]: [
      `# Decomposition — ${slug}`,
      '',
      '## Items',
      '',
      row(['Key', 'Title', 'Repository', 'Carries']),
      sep(4),
      ...stories.map((s) => row([s.key, s.title, `\`${s.repo}\``, 'REQ-1.AC-1'])),
      '',
      '## Dependency map',
      '',
      row(['From', 'To', 'Type', 'Why']),
      sep(4),
      ...edges.map(([from, to, type]) => row([from, to, type, `${from} reads what ${to} builds`])),
      '',
    ].join('\n'),
  };
}

// The item carries the criteria the design below traces to: the pickup gate
// reads this table, and each Carries cell is the design's Requirement cell.
function item(story, { slug = SLUG } = {}) {
  return {
    [`docs/backlog/${slug}/${story.key}.item.md`]: [
      `# ${story.key} — ${story.title}`,
      '',
      `Key: ${story.key}`,
      `Repository: ${story.repo}`,
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

const CRITERIA = [
  ['AC-1', 'An item in the catalogue carries a price in pence.', 'REQ-1.AC-1', 'FSD Pricing L118'],
  ['AC-2', 'An item with no price is not shown.', 'REQ-1.AC-2', 'FSD Pricing L124'],
  ['AC-3', 'A price change applies to the next request.', 'REQ-2.AC-1', 'FSD Pricing L131'],
];
const TESTS = [
  ['AC-1', 'test_price::test_price_in_pence', 'unit', 'the price is an integer'],
  ['AC-2', 'test_price::test_no_price_hidden', 'integration', 'the item is absent'],
  ['AC-3', 'test_price::test_change_applies', 'unit', 'the new price is served'],
];

const CLAR_COLUMNS = ['ID', 'Question', 'Source', 'Blocking', 'Routed to', 'Status', 'Resolution', 'Resolved'];

// A design the pickup gate passes. `hubCommit` is the trunk commit the design
// was written against. `clarifications` is a list of [status, resolution,
// resolved] rows for §9, each naming SHOP-1's design in its Source cell. A
// fourth entry in a row replaces the usual Source cell.
// `amended` changes one sentence, as an amendment does.
function design(story, { hubCommit = HUB_COMMIT, clarifications = null, amended = false } = {}) {
  const clar = clarifications === null
    ? ['NONE']
    : [
      row(CLAR_COLUMNS),
      sep(CLAR_COLUMNS.length),
      ...clarifications.map(([status, resolution, resolved, source = '`docs/designs/SHOP-1.lld.md` § 4 L12'], i) => row([
        `CLAR-SHOP-menu-${String(i + 1).padStart(2, '0')}`,
        'Which field carries the price?',
        source,
        'no',
        'catalogue team',
        status,
        resolution,
        resolved,
      ])),
    ];
  return [
    `# LLD — ${story.key}: ${story.title}`,
    '',
    '## 1. Traceability',
    '',
    `Ticket: ${story.key}`,
    `Repository: ${story.repo}`,
    'Rules: none',
    'Context: none',
    `Hub commit: ${hubCommit}`,
    '',
    '## 2. Context and current state',
    '',
    'The service reads the item table and returns it unchanged.',
    '',
    '## 3. The design',
    '',
    amended ? 'The service adds the price in pence and a currency code to each item.' : 'The service adds the price in pence to each item.',
    '',
    '## 4. Acceptance criteria',
    '',
    row(['ID', 'Criterion', 'Requirement', 'Source']),
    sep(4),
    ...CRITERIA.map(row),
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
    ...clar,
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

// The usual estate: the record with SHOP-2 blocks SHOP-1, and both items.
const cut = (edges = [['SHOP-2', 'SHOP-1', 'blocks']], stories = [S1, S2]) => ({
  ...record(stories, edges),
  ...Object.assign({}, ...stories.map((s) => item(s))),
});

// The control's history: SHOP-1's design merges, then SHOP-2's design merges
// written against that commit. `clarifications` goes into SHOP-2's §9.
function control(h, clarifications = null) {
  const first = h.commit({ ...cut(), ...designPair(S1) }, 'SHOP-1 design merged');
  h.commit(designPair(S2, { hubCommit: first, clarifications }), 'SHOP-2 design merged');
}

const registry = (...remotes) => ({
  'docs/estate/repositories.json': `${JSON.stringify({
    schema_version: 1,
    repositories: Object.fromEntries(remotes.map((r) => [r.id, {
      url: r.url,
      checks: 'checks.env',
      purpose: `What ${r.id} does, in one sentence, for ranking and nothing else.`,
      readAt: r.head,
      trunk: 'default',
    }])),
  }, null, 2)}\n`,
});

// The report, in the one shape check-validation reads. `verdicts` is one word
// per criterion. Copied from the check-fan-in suite.
const REPORT_HEADER = ['AC', 'Criterion (short)', 'Requirement', 'Verdict', 'Evidence'];
const SHORT = ['A price in pence', 'An item with no price is hidden', 'A price change applies next'];
function report(story, { designCommit, spokeCommit, verdicts = ['PASS', 'PASS', 'PASS'] }) {
  const rows = CRITERIA.map((c, i) => row([c[0], SHORT[i], c[2], verdicts[i], `${TESTS[i][1]} · src/price.py:${88 + i} · ${TESTS[i][3]}`]));
  const pass = verdicts.filter((v) => v === 'PASS').length;
  const fail = verdicts.filter((v) => v === 'FAIL').length;
  return {
    [`docs/designs/${story.key}.validation.md`]: [
      `# Validation — ${story.key}: ${story.title}`,
      '',
      `Design: docs/designs/${story.key}.lld.md at ${designCommit}`,
      `Repository: ${story.repo}`,
      `Spoke commit: ${spokeCommit}`,
      '',
      row(REPORT_HEADER),
      sep(REPORT_HEADER.length),
      ...rows,
      '',
      `Criteria: ${verdicts.length} · PASS ${pass} · FAIL ${fail} · defects raised: NONE`,
      '',
    ].join('\n'),
  };
}

const CLOSED = ['Closed', 'The price is the field `amount`, in pence.', '2026-10-01'];

// SHOP-2 in SHOP-1's spoke, catalogue-api, for rule 6. SHOP-1's code lands on
// the trunk, and SHOP-2's branch `feature/SHOP-2` adds one commit. `behind`
// starts the branch before SHOP-1's code lands. `squash` puts SHOP-1's code on
// a side branch, which the report names, and merges it with a squash merge.
// Returns the spoke, the head of SHOP-2's branch and the code-step run with it.
const S2_SAME = { ...S2, repo: S1.repo };
function sameSpoke(root, h, { behind = false, squash = false } = {}) {
  const code = { 'src/price.ts': 'export const p = 1;\n' };
  const a = spoke(root, S1.repo, squash ? { side: code } : {});
  const commitOn = (branch, files, message) => {
    git(a.work, ['checkout', '-q', branch]);
    writeFiles(a.work, files);
    git(a.work, ['add', '-A']);
    git(a.work, ['commit', '-q', '-m', message]);
    return git(a.work, ['rev-parse', 'HEAD']).trim();
  };
  if (behind) git(a.work, ['branch', 'feature/SHOP-2', a.trunk]);
  const landed = commitOn(a.trunk, code, squash ? 'feat(SHOP-1): the price, squashed' : 'feat(SHOP-1): the price');
  git(a.work, ['push', '-q', a.url, a.trunk]);
  if (!behind) git(a.work, ['branch', 'feature/SHOP-2', a.trunk]);
  const head = commitOn('feature/SHOP-2', { 'src/menu.ts': 'export const m = 2;\n' }, 'feat(SHOP-2): the menu');
  git(a.work, ['push', '-q', a.url, 'feature/SHOP-2']);
  git(a.work, ['checkout', '-q', a.trunk]);
  const d = h.commit({ ...registry(a), ...cut([['SHOP-2', 'SHOP-1', 'blocks']], [S1, S2_SAME]), ...designPair(S1) }, 'SHOP-1 design merged');
  h.commit({ ...designPair(S2_SAME, { hubCommit: d }), ...report(S1, { designCommit: d, spokeCommit: squash ? a.side : landed }) }, 'SHOP-2 design and the SHOP-1 report merged');
  return { a, head, run: [...CODE, '--head', head, '--head-repo', a.work] };
}

// SHOP-1 merged by the forge's squash or rebase merge, as GitHub writes them.
// SHOP-1's branch has two commits: one adds src/price.ts and changes line 4 of
// src/config.ts, one adds a test. /qa-sprint validated its head, which the
// report names. `behind` lands another story's commit on the trunk after QA. It
// changes line 1 of src/config.ts, inside the context lines of SHOP-1's change,
// so a patch-id with context lines would differ. `differ` changes src/price.ts
// in the squash commit, as a conflict resolution or an edit at merge time does.
// `same` puts SHOP-2 in catalogue-api, with a branch cut after the merge, and
// returns the code-step run with --head.
const CONFIG_LINES = (first, fourth) => ['export const a1 = 1;', 'export const a2 = 2;', 'export const a3 = 3;', 'export const a4 = 4;', 'export const a5 = 5;', 'export const a6 = 6;']
  .map((l, i) => (i === 0 && first ? first : i === 3 && fourth ? fourth : l)).join('\n') + '\n';
function forgeMerge(root, h, { method, behind = false, differ = false, same = false }) {
  const a = spoke(root, S1.repo);
  const commit = (files, message) => {
    writeFiles(a.work, files);
    git(a.work, ['add', '-A']);
    git(a.work, ['commit', '-q', '-m', message]);
    return git(a.work, ['rev-parse', 'HEAD']).trim();
  };
  commit({ 'src/config.ts': CONFIG_LINES() }, 'chore: the configuration');
  git(a.work, ['push', '-q', a.url, a.trunk]);
  git(a.work, ['checkout', '-q', '-b', 'feature/SHOP-1']);
  commit({ 'src/price.ts': 'export const p = 1;\n', 'src/config.ts': CONFIG_LINES(null, 'export const a4 = 40;') }, 'feat(SHOP-1): the price');
  const validated = commit({ 'src/price.test.ts': 'test("p", () => {});\n' }, 'test(SHOP-1): the price');
  git(a.work, ['push', '-q', a.url, 'feature/SHOP-1']);
  git(a.work, ['checkout', '-q', a.trunk]);
  if (behind) {
    commit({ 'src/stock.ts': 'export const s = 1;\n', 'src/config.ts': CONFIG_LINES('export const a1 = 10;') }, 'feat(SHOP-9): the stock (#11)');
  }
  if (method === 'squash') {
    git(a.work, ['merge', '--squash', '-q', 'feature/SHOP-1']);
    if (differ) writeFiles(a.work, { 'src/price.ts': 'export const p = 2;\n' });
    git(a.work, ['add', '-A']);
    git(a.work, ['commit', '-q', '-m', 'feat(SHOP-1): the price (#12)']);
  } else {
    // GitHub's rebase merge writes new commits even when the branch is up to date.
    git(a.work, ['checkout', '-q', '-b', 'rebased', 'feature/SHOP-1']);
    git(a.work, ['-c', 'user.name=GitHub', 'rebase', '-q', '--force-rebase', a.trunk]);
    git(a.work, ['checkout', '-q', a.trunk]);
    git(a.work, ['merge', '-q', '--ff-only', 'rebased']);
  }
  const merged = git(a.work, ['rev-parse', 'HEAD']).trim();
  git(a.work, ['push', '-q', a.url, a.trunk]);
  const s2 = same ? S2_SAME : S2;
  const d = h.commit({ ...registry(a), ...cut([['SHOP-2', 'SHOP-1', 'blocks']], [S1, s2]), ...designPair(S1) }, 'SHOP-1 design merged');
  h.commit({ ...designPair(s2, { hubCommit: d }), ...report(S1, { designCommit: d, spokeCommit: validated }) }, 'SHOP-2 design and the SHOP-1 report merged');
  if (!same) return { a, validated, merged, run: CODE };
  git(a.work, ['checkout', '-q', '-b', 'feature/SHOP-2']);
  const head = commit({ 'src/menu.ts': 'export const m = 2;\n' }, 'feat(SHOP-2): the menu');
  git(a.work, ['push', '-q', a.url, 'feature/SHOP-2']);
  git(a.work, ['checkout', '-q', a.trunk]);
  return { a, validated, merged, run: [...CODE, '--head', head, '--head-repo', a.work] };
}

/* ------------------------------------------------------------------- fixtures */

// Each fixture's `build(root, hub)` commits the hub's content. It may return
// { cwd } to run the check in another checkout, and { runs } in place of the
// fixture's `runs`. The hub's working clone is the default. `runs` lists the
// argument lists to run, each with the same exit. `also` lists runs with their own exit. An `includes` entry is a string
// the output carries, or a list of strings that one output line carries.
const DESIGN = ['SHOP-2', '--step', 'design'];
const CODE = ['SHOP-2', '--step', 'code'];
const FIXTURES = [
  {
    n: 1,
    name: 'control: SHOP-2 blocks SHOP-1, SHOP-1 merged first, SHOP-2 written against it',
    build: (root, h) => control(h),
    exit: 0,
    includes: [
      'SHOP-2 dependencies, step design  (against main at',
      '[PASS] SHOP-1  catalogue-api',
      '1. design on the trunk and the pickup gate passes: yes',
      "pin: SHOP-1's design at SHOP-2's Hub commit, unchanged since: yes",
      'clarifications: no open row names SHOP-1.lld.md: yes',
      'DEPENDENCIES DONE: 1 of 1',
    ],
    excludes: ['NOT DONE'],
  },
  {
    n: 2,
    name: 'the dependency map has no row for SHOP-2',
    build: (root, h) => h.commit({ ...cut([]), ...designPair(S1), ...designPair(S2) }, 'designs merged'),
    exit: 0,
    includes: ['DEPENDENCIES DONE: SHOP-2 has no blocks row in the dependency map.'],
  },
  {
    n: 3,
    name: 'the only row is a shares a contract row',
    build: (root, h) => h.commit({ ...cut([['SHOP-2', 'SHOP-1', 'shares a contract']]), ...designPair(S2) }, 'SHOP-2 design merged'),
    exit: 0,
    includes: ['has no blocks row'],
  },
  {
    n: 4,
    name: "SHOP-1's design is not on the trunk",
    build: (root, h) => h.commit({ ...cut(), ...designPair(S2) }, 'SHOP-2 design merged'),
    exit: 1,
    includes: [
      '[FAIL] SHOP-1  catalogue-api',
      ['SHOP-1: ', 'the design is not merged'],
      "pin: SHOP-1's design at SHOP-2's Hub commit, unchanged since: not asked: needs 1",
      'DEPENDENCIES NOT DONE: 0 of 1 dependency is done for the design step.',
      ["SHOP-2's design can merge after SHOP-1's design merges.", 'On the design pull request, after the fix merges, push a commit or close and reopen the pull request, so that design-gate reads the new trunk. A re-run of the failed job reads the old trunk.'],
    ],
    excludes: ['DEPENDENCIES DONE'],
  },
  {
    n: 5,
    name: "SHOP-1's design is on the trunk without its review, so the gate fails it",
    build: (root, h) => {
      const first = h.commit({ ...cut(), ...designPair(S1, { review: false }) }, 'SHOP-1 design merged, no review');
      h.commit(designPair(S2, { hubCommit: first }), 'SHOP-2 design merged');
    },
    exit: 1,
    includes: [['1. design on the trunk and the pickup gate passes: no: ', 'the pickup gate says'], ['SHOP-1: ', 'the pickup gate says']],
  },
  {
    n: 6,
    name: "SHOP-1's design merged after SHOP-2's Hub commit",
    build: (root, h) => {
      const cutCommit = h.commit(cut(), 'stories cut');
      h.commit(designPair(S1), 'SHOP-1 design merged');
      h.commit(designPair(S2, { hubCommit: cutCommit }), 'SHOP-2 design merged');
    },
    exit: 1,
    includes: [["pin: SHOP-1's design at SHOP-2's Hub commit, unchanged since: no: ", "is not on the trunk at SHOP-2's Hub commit"], ['SHOP-1: ', "is not on the trunk at SHOP-2's Hub commit", "SHOP-2's design must read SHOP-1's merged design. While SHOP-2's design pull request is open, run /dev-spec SHOP-2 again. After it merges, amend SHOP-2's design by pull request with a fresh review, as /dev-sprint precondition 9 says."]],
  },
  {
    n: 7,
    name: "SHOP-1's design amended after SHOP-2's Hub commit",
    build: (root, h) => {
      control(h);
      h.commit(designPair(S1, { amended: true }), 'SHOP-1 design amended');
    },
    exit: 1,
    includes: ["SHOP-1: its design changed after SHOP-2's Hub commit. While SHOP-2's design pull request is open, run /dev-spec SHOP-2 again. After it merges, amend SHOP-2's design by pull request with a fresh review, as /dev-sprint precondition 9 says."],
    excludes: ['Run /dev-spec SHOP-2 again'],
  },
  {
    n: 8,
    name: "an Open clarification in SHOP-2's design names SHOP-1's design",
    build: (root, h) => control(h, [['Open', '', '']]),
    exit: 1,
    includes: [
      ['clarifications: no open row names SHOP-1.lld.md: no: ', 'CLAR-SHOP-menu-01 is Open and names SHOP-1.lld.md'],
      "SHOP-1: CLAR-SHOP-menu-01 is Open and names SHOP-1.lld.md. Close it from SHOP-1's merged design. While SHOP-2's design pull request is open, run /dev-spec SHOP-2 again. After it merges, amend SHOP-2's design by pull request with a fresh review, as /dev-sprint precondition 9 says.",
    ],
  },
  {
    n: 9,
    name: 'the same clarification, Closed with a resolution',
    build: (root, h) => control(h, [CLOSED]),
    exit: 0,
    includes: ['DEPENDENCIES DONE'],
    excludes: ['NOT DONE'],
  },
  {
    n: 10,
    name: 'the same clarification, Withdrawn',
    build: (root, h) => control(h, [['Withdrawn', 'The question is not real.', '']]),
    exit: 0,
    includes: ['DEPENDENCIES DONE'],
    excludes: ['NOT DONE'],
  },
  {
    n: 11,
    name: 'SHOP-2 blocks SHOP-1 and SHOP-3, and neither design is merged',
    build: (root, h) => h.commit({ ...cut([['SHOP-2', 'SHOP-1', 'blocks'], ['SHOP-2', 'SHOP-3', 'blocks']], [S1, S2, S3]), ...designPair(S2) }, 'SHOP-2 design merged'),
    exit: 1,
    includes: [
      '[FAIL] SHOP-1  catalogue-api',
      '[FAIL] SHOP-3  orders-api',
      ['SHOP-1: ', 'the design is not merged'],
      ['SHOP-3: ', 'the design is not merged'],
      'DEPENDENCIES NOT DONE: 0 of 2 dependencies are done for the design step.',
    ],
  },
  {
    n: 12,
    name: "SHOP-2's own design is not on the trunk, and SHOP-1 is done",
    build: (root, h) => h.commit({ ...cut(), ...designPair(S1) }, 'SHOP-1 design merged'),
    exit: 0,
    includes: [
      "pin: SHOP-1's design at SHOP-2's Hub commit, unchanged since: not asked: SHOP-2 has no design on the trunk yet",
      'clarifications: no open row names SHOP-1.lld.md: not asked: SHOP-2 has no design on the trunk yet',
      'DEPENDENCIES DONE: 1 of 1',
    ],
  },
  {
    n: 13,
    name: "SHOP-1's and SHOP-2's designs land in the same commit",
    build: (root, h) => h.commit({ ...cut(), ...designPair(S1), ...designPair(S2) }, 'both designs merged at once'),
    exit: 1,
    includes: [['SHOP-1: ', "merge SHOP-1's design first. While SHOP-2's design pull request is open, run /dev-spec SHOP-2 again. After it merges, amend SHOP-2's design by pull request with a fresh review, as /dev-sprint precondition 9 says."]],
  },
  {
    n: 14,
    name: 'the To key SHOP-9 has no item file on the trunk',
    build: (root, h) => h.commit({ ...cut([['SHOP-2', 'SHOP-9', 'blocks']]), ...designPair(S2) }, 'SHOP-2 design merged'),
    exit: 1,
    includes: ['[FAIL] SHOP-9  (repository unknown)', 'SHOP-9 has no item file on main'],
  },
  {
    n: 15,
    name: 'the To key is an item of another slug, and done',
    build: (root, h) => {
      const first = h.commit({ ...record([S1], [], 'catalogue-pricing'), ...item(S1, { slug: 'catalogue-pricing' }), ...designPair(S1) }, 'SHOP-1 cut and designed');
      h.commit({ ...record([S2], [['SHOP-2', 'SHOP-1', 'blocks']]), ...item(S2), ...designPair(S2, { hubCommit: first }) }, 'SHOP-2 cut and designed');
    },
    exit: 0,
    includes: ['[PASS] SHOP-1  catalogue-api', 'DEPENDENCIES DONE: 1 of 1'],
  },
  {
    n: 16,
    name: 'usage: no argument, a malformed key, no --step, --step deploy',
    build: (root, h) => control(h),
    runs: [[], ['shop-2', '--step', 'design'], ['SHOP-2'], ['SHOP-2', '--step', 'deploy']],
    exit: 3,
    includes: ['usage:'],
  },
  {
    // A depth-1 clone holds the trunk's tip and not the Hub commit: SHOP-2's
    // design names. A check that judged it would call that commit off the trunk.
    n: 17,
    name: 'the control hub, read from a shallow clone',
    build: (root, h) => {
      control(h);
      const shallow = join(root, 'shallow');
      git(root, ['clone', '-q', '--depth', '1', '--branch', 'main', `file://${h.bare}`, shallow]);
      return { cwd: shallow };
    },
    exit: 2,
    includes: ['CANNOT VERIFY: this clone is shallow.', 'REASON: shallow-clone'],
    excludes: ['DEPENDENCIES DONE', 'DEPENDENCIES NOT DONE'],
  },
  {
    n: 18,
    name: "code step control: SHOP-1's report passes and its spoke commit is on catalogue-api's trunk",
    build: (root, h) => {
      const a = spoke(root, S1.repo);
      const d = h.commit({ ...registry(a), ...cut(), ...designPair(S1) }, 'SHOP-1 design merged');
      h.commit({ ...designPair(S2, { hubCommit: d }), ...report(S1, { designCommit: d, spokeCommit: a.head }) }, 'SHOP-2 design and the SHOP-1 report merged');
    },
    runs: [CODE],
    also: [{ args: DESIGN, exit: 0 }],
    exit: 0,
    includes: [
      'SHOP-2 dependencies, step code  (against main at',
      "head: not asked. No --head was given, so the check does not ask that SHOP-2's head holds the code of a dependency in its own spoke.",
      '[OK] catalogue-api',
      '[PASS] SHOP-1  catalogue-api',
      '1. design on the trunk and the pickup gate passes: yes',
      '2. validation report on the trunk and complete: yes',
      '3. every verdict PASS: yes (3 PASS)',
      "4. spoke commit on the repository's trunk: yes:",
      "pin: SHOP-1's design at SHOP-2's Hub commit, unchanged since: yes",
      'clarifications: no open row names SHOP-1.lld.md: yes',
      'DEPENDENCIES DONE: 1 of 1 dependency is done for the code step.',
    ],
    excludes: ['NOT DONE'],
  },
  {
    n: 19,
    name: "SHOP-1's design is merged and no report is",
    build: (root, h) => {
      const a = spoke(root, S1.repo);
      const d = h.commit({ ...registry(a), ...cut(), ...designPair(S1) }, 'SHOP-1 design merged');
      h.commit(designPair(S2, { hubCommit: d }), 'SHOP-2 design merged');
    },
    runs: [CODE],
    exit: 1,
    includes: [
      ['2. validation report on the trunk and complete: no: ', '/qa-sprint has not run'],
      '3. every verdict PASS: not asked: needs 2',
      ['SHOP-1: ', '/qa-sprint has not run'],
      'DEPENDENCIES NOT DONE: 0 of 1 dependency is done for the code step.',
    ],
    excludes: ['design-gate reads the new trunk'],
  },
  {
    n: 20,
    name: "SHOP-1's report passes and its spoke commit is on a branch only",
    build: (root, h) => {
      const a = spoke(root, S1.repo, { side: { 'src/price.ts': 'export const p = 1;\n' } });
      const d = h.commit({ ...registry(a), ...cut(), ...designPair(S1) }, 'SHOP-1 design merged');
      h.commit({ ...designPair(S2, { hubCommit: d }), ...report(S1, { designCommit: d, spokeCommit: a.side }) }, 'SHOP-2 design and the SHOP-1 report merged');
    },
    runs: [CODE],
    also: [{ args: DESIGN, exit: 0 }],
    exit: 1,
    includes: [
      ["4. spoke commit on the repository's trunk: no: ", 'is a commit of catalogue-api but not on its trunk main'],
      ['SHOP-1: ', 'Run this check again after SHOP-1 merges.'],
    ],
  },
  {
    // /qa-sprint validated the head of the pull request. A squash merge wrote a
    // new trunk commit with the same tree.
    n: 21,
    name: "SHOP-1's spoke commit is merged with a squash merge",
    build: (root, h) => {
      const a = spoke(root, S1.repo, { side: { 'src/price.ts': 'export const p = 1;\n' } });
      writeFiles(a.work, { 'src/price.ts': 'export const p = 1;\n' });
      git(a.work, ['add', '-A']);
      git(a.work, ['commit', '-q', '-m', 'feat: the story, squashed']);
      git(a.work, ['push', '-q', a.url, a.trunk]);
      const d = h.commit({ ...registry(a), ...cut(), ...designPair(S1) }, 'SHOP-1 design merged');
      h.commit({ ...designPair(S2, { hubCommit: d }), ...report(S1, { designCommit: d, spokeCommit: a.side }) }, 'SHOP-2 design and the SHOP-1 report merged');
    },
    runs: [CODE],
    exit: 0,
    includes: ['with the same tree (a squash or a rebase merge)', 'DEPENDENCIES DONE: 1 of 1'],
  },
  {
    // check-validation refuses a report with a FAIL row, so question 2 reports it
    // and question 3 is not asked.
    n: 22,
    name: "SHOP-1's report has a FAIL verdict",
    build: (root, h) => {
      const a = spoke(root, S1.repo);
      const d = h.commit({ ...registry(a), ...cut(), ...designPair(S1) }, 'SHOP-1 design merged');
      h.commit({ ...designPair(S2, { hubCommit: d }), ...report(S1, { designCommit: d, spokeCommit: a.head, verdicts: ['PASS', 'PASS', 'FAIL'] }) }, 'SHOP-2 design and the SHOP-1 report merged');
    },
    runs: [CODE],
    exit: 1,
    includes: [
      ['2. validation report on the trunk and complete: no: ', 'REPORT INCOMPLETE'],
      '3. every verdict PASS: not asked: needs 2',
      ["SHOP-1: SHOP-1's validation report does not pass check-validation", "SHOP-1 must pass QA before SHOP-2's code can merge."],
    ],
    excludes: ['Run /qa-sprint'],
  },
  {
    n: 23,
    name: 'SHOP-3 blocks SHOP-1 and SHOP-2, both in catalogue-api, both done',
    build: (root, h) => {
      const a = spoke(root, S1.repo);
      const s2 = { ...S2, repo: S1.repo };
      const d = h.commit({
        ...registry(a),
        ...cut([['SHOP-3', 'SHOP-1', 'blocks'], ['SHOP-3', 'SHOP-2', 'blocks']], [S1, s2, S3]),
        ...designPair(S1),
        ...designPair(s2),
      }, 'SHOP-1 and SHOP-2 designs merged');
      h.commit({ ...report(S1, { designCommit: d, spokeCommit: a.head }), ...report(s2, { designCommit: d, spokeCommit: a.head }) }, 'reports merged');
    },
    runs: [['SHOP-3', '--step', 'code']],
    exit: 0,
    includes: ['[PASS] SHOP-1  catalogue-api', '[PASS] SHOP-2  catalogue-api', 'DEPENDENCIES DONE: 2 of 2 dependencies are done for the code step.'],
  },
  {
    n: 24,
    name: "catalogue-api's remote is deleted",
    build: (root, h) => {
      const a = spoke(root, S1.repo);
      const d = h.commit({ ...registry(a), ...cut(), ...designPair(S1) }, 'SHOP-1 design merged');
      h.commit({ ...designPair(S2, { hubCommit: d }), ...report(S1, { designCommit: d, spokeCommit: a.head }) }, 'SHOP-2 design and the SHOP-1 report merged');
      rmSync(a.url, { recursive: true, force: true });
    },
    runs: [CODE],
    exit: 2,
    includes: [
      ['CANNOT VERIFY: catalogue-api could not be reached', 'SPOKE_READ_TOKEN_SECRET'],
    ],
    excludes: ['DEPENDENCIES DONE', 'DEPENDENCIES NOT DONE'],
  },
  {
    n: 25,
    name: "fixture 4 with the code step: SHOP-1's design is not merged, so questions 2 to 4 are not asked",
    build: (root, h) => {
      const a = spoke(root, S1.repo);
      h.commit({ ...registry(a), ...cut(), ...designPair(S2) }, 'SHOP-2 design merged');
    },
    runs: [CODE],
    exit: 1,
    includes: [
      ['1. design on the trunk and the pickup gate passes: no: ', 'the design is not merged'],
      '2. validation report on the trunk and complete: not asked: needs 1',
      '3. every verdict PASS: not asked: needs 1',
      "4. spoke commit on the repository's trunk: not asked: needs 1",
      ['SHOP-1: ', 'the design is not merged', "Run this check again after SHOP-1's design merges and its code is on its trunk."],
    ],
    excludes: ['can merge after'],
  },
  {
    // check-decomposition.js does not read the Type column. A row typed
    // "Blocks" must not read as no dependency, or SHOP-2 merges before SHOP-1.
    n: 26,
    name: 'the row from SHOP-2 is typed Blocks, not blocks',
    build: (root, h) => h.commit({ ...cut([['SHOP-2', 'SHOP-1', 'Blocks']]), ...designPair(S2) }, 'SHOP-2 design merged'),
    runs: [DESIGN, CODE],
    exit: 1,
    includes: [
      ['FAIL: the dependency map in docs/backlog/menu-pricing.decomposition.md has a Type that the check cannot read'],
      ['line 14: the row SHOP-2 -> SHOP-1 has the Type "Blocks", which is not "blocks" or "shares a contract"'],
    ],
    excludes: ['DEPENDENCIES DONE', 'has no blocks row'],
  },
  {
    // Fixture 5 with the code step: the design is merged, so the next step is
    // the pickup gate, not a merge.
    n: 27,
    name: "fixture 5 with the code step: SHOP-1's design is merged without its review",
    build: (root, h) => {
      const a = spoke(root, S1.repo);
      const first = h.commit({ ...registry(a), ...cut(), ...designPair(S1, { review: false }) }, 'SHOP-1 design merged, no review');
      h.commit(designPair(S2, { hubCommit: first }), 'SHOP-2 design merged');
    },
    runs: [CODE],
    exit: 1,
    includes: [
      ['1. design on the trunk and the pickup gate passes: no: ', 'the pickup gate says'],
      ['SHOP-1: ', "Run this check again after SHOP-1's design passes the pickup gate and its code is on its trunk."],
    ],
    excludes: ["after SHOP-1's design merges"],
  },
  {
    // A Source cell can name the design as a markdown link. The link target is
    // the path, and the check must still see the open row.
    n: 28,
    name: "Open clarifications name SHOP-1's design as a markdown link, in brackets and with a colon, and one names SHOP-10's",
    build: (root, h) => control(h, [
      ['Open', '', '', '[SHOP-1](docs/designs/SHOP-1.lld.md) § 4 L12'],
      ['Open', '', '', '[SHOP-1.lld.md] § 4 L12'],
      ['Open', '', '', 'docs/designs/SHOP-1.lld.md: § 4 L12'],
      ['Open', '', '', 'docs/designs/SHOP-10.lld.md § 4 L12'],
    ]),
    exit: 1,
    includes: [
      "SHOP-1: CLAR-SHOP-menu-01 is Open and names SHOP-1.lld.md. Close it from SHOP-1's merged design.",
      "SHOP-1: CLAR-SHOP-menu-02 is Open and names SHOP-1.lld.md. Close it from SHOP-1's merged design.",
      "SHOP-1: CLAR-SHOP-menu-03 is Open and names SHOP-1.lld.md. Close it from SHOP-1's merged design.",
    ],
    excludes: ['DEPENDENCIES DONE', 'CLAR-SHOP-menu-04 is Open'],
  },
  {
    // Rule 6. A fixture's build returns its runs, because the head is a commit it makes.
    n: 29,
    name: "SHOP-2 is in SHOP-1's spoke, and SHOP-2's head holds SHOP-1's merged code",
    build: (root, h) => ({ runs: [sameSpoke(root, h).run] }),
    exit: 0,
    includes: [
      ['  head: ', 'the checkout of SHOP-2\'s spoke catalogue-api'],
      ["head: SHOP-2's head ", "holds SHOP-1's merged code: yes: ", 'on the trunk main is an ancestor of'],
      'DEPENDENCIES DONE: 1 of 1 dependency is done for the code step.',
    ],
    excludes: ['NOT DONE', 'head: not asked'],
  },
  {
    n: 30,
    name: "SHOP-2 is in SHOP-1's spoke, and SHOP-2's branch starts before SHOP-1's code lands",
    build: (root, h) => ({ runs: [sameSpoke(root, h, { behind: true }).run] }),
    exit: 1,
    includes: [
      ["head: SHOP-2's head ", "holds SHOP-1's merged code: no: ", 'on the trunk main is not an ancestor of'],
      ["SHOP-1: SHOP-2's head ", "does not hold SHOP-1's merged code, ", 'on the trunk main of catalogue-api. Bring SHOP-2\'s branch up to the trunk: run /dev-sprint SHOP-2 again before the pull request opens, or use the forge\'s "Update branch". The head then moves, so run /qa-sprint SHOP-2 on the new head, and then run qa-gate again.'],
      "4. spoke commit on the repository's trunk: yes:",
      'DEPENDENCIES NOT DONE: 0 of 1 dependency is done for the code step. Each failure line above names the next step.',
    ],
    excludes: ['DEPENDENCIES DONE', 'CANNOT VERIFY'],
  },
  {
    // The report names the side commit QA read. The head holds the squash commit
    // on the trunk, not the side commit, and rule 6 reads the squash commit.
    n: 31,
    name: "SHOP-1's code merged with a squash merge, and SHOP-2's head holds the squash commit",
    build: (root, h) => ({ runs: [sameSpoke(root, h, { squash: true }).run] }),
    exit: 0,
    includes: [
      'with the same tree (a squash or a rebase merge)',
      ["holds SHOP-1's merged code: yes: ", 'is an ancestor of'],
      'DEPENDENCIES DONE: 1 of 1',
    ],
  },
  {
    n: 32,
    name: 'fixture 18 with --head: SHOP-1 is in catalogue-api and SHOP-2 in menu-web, so rule 6 is not asked',
    build: (root, h) => {
      const a = spoke(root, S1.repo);
      const b = spoke(root, S2.repo);
      const d = h.commit({ ...registry(a), ...cut(), ...designPair(S1) }, 'SHOP-1 design merged');
      h.commit({ ...designPair(S2, { hubCommit: d }), ...report(S1, { designCommit: d, spokeCommit: a.head }) }, 'SHOP-2 design and the SHOP-1 report merged');
      return { runs: [[...CODE, '--head', b.head, '--head-repo', b.work]] };
    },
    exit: 0,
    includes: [
      ["holds SHOP-1's merged code: not asked: SHOP-1 is in catalogue-api and SHOP-2 is in menu-web, so SHOP-2's head cannot hold SHOP-1's code"],
      'DEPENDENCIES DONE: 1 of 1',
    ],
  },
  {
    n: 33,
    name: 'usage: --head without --head-repo, --head-repo without --head, --head with --step design, a short head',
    build: (root, h) => control(h),
    runs: [
      [...CODE, '--head', 'a'.repeat(40)],
      [...CODE, '--head-repo', '.'],
      [...DESIGN, '--head', 'a'.repeat(40), '--head-repo', '.'],
      [...CODE, '--head', 'abc1234', '--head-repo', '.'],
    ],
    exit: 3,
    includes: ['usage:'],
  },
  {
    n: 34,
    name: 'fixture 29 with a head commit that is not in the checkout',
    build: (root, h) => {
      const { a } = sameSpoke(root, h);
      return { runs: [[...CODE, '--head', 'deadbeef'.repeat(5), '--head-repo', a.work]] };
    },
    exit: 2,
    includes: ['CANNOT VERIFY: the head deadbeefdeadbeefdeadbeefdeadbeefdeadbeef is not a commit in --head-repo', "Fetch the pull request's head into that checkout, and run again"],
    excludes: ['DEPENDENCIES DONE', 'DEPENDENCIES NOT DONE'],
  },
  {
    n: 35,
    name: 'fixture 29 with a shallow clone, and with a directory that is not a git checkout',
    build: (root, h) => {
      const { a, head } = sameSpoke(root, h);
      const shallow = join(root, 'spoke-shallow');
      git(root, ['clone', '-q', '--depth', '1', '--branch', 'feature/SHOP-2', `file://${a.url}`, shallow]);
      const plain = join(root, 'not-a-checkout');
      mkdirSync(plain);
      return { runs: [[...CODE, '--head', head, '--head-repo', shallow], [...CODE, '--head', head, '--head-repo', plain]] };
    },
    exit: 2,
    includes: ['CANNOT VERIFY: --head-repo '],
    excludes: ['DEPENDENCIES DONE', 'DEPENDENCIES NOT DONE'],
  },
  {
    // Another story merged after QA, and the spoke does not require an
    // up-to-date branch. No trunk commit has the tree QA read. The squash commit
    // holds the change QA validated, on a newer trunk.
    n: 36,
    name: "SHOP-1's branch is behind the trunk and merged with a squash merge",
    build: (root, h) => ({ runs: [forgeMerge(root, h, { method: 'squash', behind: true }).run] }),
    exit: 0,
    includes: [
      ["4. spoke commit on the repository's trunk: yes: ", "merged into catalogue-api's trunk main as", 'with the same change on a newer trunk (a squash or a rebase merge of a branch behind the trunk); QA did not read the merged tree'],
      'DEPENDENCIES DONE: 1 of 1',
    ],
    excludes: ['NOT DONE', 'with the same tree'],
  },
  {
    n: 37,
    name: "SHOP-1's branch is up to date and merged with a rebase merge",
    build: (root, h) => ({ runs: [forgeMerge(root, h, { method: 'rebase' }).run] }),
    exit: 0,
    includes: ['with the same tree (a squash or a rebase merge)', 'DEPENDENCIES DONE: 1 of 1'],
    excludes: ['NOT DONE'],
  },
  {
    // A rebase merge writes one trunk commit for each commit of the branch. The
    // two commits together hold the change QA validated.
    n: 38,
    name: "SHOP-1's branch is behind the trunk and merged with a rebase merge",
    build: (root, h) => ({ runs: [forgeMerge(root, h, { method: 'rebase', behind: true }).run] }),
    exit: 0,
    includes: [
      ["4. spoke commit on the repository's trunk: yes: ", 'as the 2 trunk commits ', 'with the same change on a newer trunk'],
      'DEPENDENCIES DONE: 1 of 1',
    ],
    excludes: ['NOT DONE'],
  },
  {
    // The squash commit names SHOP-1, but its change is not the change QA
    // validated. Waiting does not fix that, so the next step is not "run again".
    n: 39,
    name: "SHOP-1's branch is behind the trunk, and its squash commit changes the code QA validated",
    build: (root, h) => ({ runs: [forgeMerge(root, h, { method: 'squash', behind: true, differ: true }).run] }),
    exit: 1,
    includes: [
      ["4. spoke commit on the repository's trunk: no: ", 'is a commit of catalogue-api but not on its trunk main', 'no trunk commit since the two lines parted has its tree or its change'],
      ['SHOP-1: ', 'names SHOP-1 in its message, but no trunk commit holds the change QA validated at', 'The code on the trunk is not the code QA validated. A person compares the two commits, and then reverts the merge, or opens a new pull request for SHOP-1 with /dev-sprint SHOP-1 and runs /qa-sprint SHOP-1 on its head.'],
      'DEPENDENCIES NOT DONE: 0 of 1',
    ],
    excludes: ['DEPENDENCIES DONE', 'Run this check again after SHOP-1'],
  },
  {
    // Rule 6 reads the trunk commit that question 4 found: the squash commit.
    n: 40,
    name: "fixture 36 with SHOP-2 in SHOP-1's spoke, and SHOP-2's head holds the squash commit",
    build: (root, h) => ({ runs: [forgeMerge(root, h, { method: 'squash', behind: true, same: true }).run] }),
    exit: 0,
    includes: [
      'with the same change on a newer trunk',
      ["holds SHOP-1's merged code: yes: ", 'is an ancestor of'],
      'DEPENDENCIES DONE: 1 of 1',
    ],
  },
  {
    // The pin and clarification rules bind the code step too. Questions 2 to 4
    // pass here, so the one failure is the rule under test.
    n: 41,
    name: "fixture 6 with the code step: SHOP-1's design merged after SHOP-2's Hub commit, and SHOP-1's code is done",
    build: (root, h) => {
      const a = spoke(root, S1.repo);
      const cutCommit = h.commit({ ...registry(a), ...cut() }, 'stories cut');
      const d = h.commit(designPair(S1), 'SHOP-1 design merged');
      h.commit({ ...designPair(S2, { hubCommit: cutCommit }), ...report(S1, { designCommit: d, spokeCommit: a.head }) }, 'SHOP-2 design and the SHOP-1 report merged');
    },
    runs: [CODE],
    exit: 1,
    includes: [
      "4. spoke commit on the repository's trunk: yes:",
      ["pin: SHOP-1's design at SHOP-2's Hub commit, unchanged since: no: ", "is not on the trunk at SHOP-2's Hub commit"],
      'DEPENDENCIES NOT DONE: 0 of 1 dependency is done for the code step.',
    ],
  },
  {
    n: 42,
    name: "fixture 7 with the code step: SHOP-1's design amended after SHOP-2's Hub commit, and SHOP-1's code is done",
    build: (root, h) => {
      const a = spoke(root, S1.repo);
      const d = h.commit({ ...registry(a), ...cut(), ...designPair(S1) }, 'SHOP-1 design merged');
      h.commit(designPair(S2, { hubCommit: d }), 'SHOP-2 design merged');
      // QA validates SHOP-1 against its amended design, so the report names the amendment.
      const amended = h.commit(designPair(S1, { amended: true }), 'SHOP-1 design amended');
      h.commit(report(S1, { designCommit: amended, spokeCommit: a.head }), 'SHOP-1 report merged');
    },
    runs: [CODE],
    exit: 1,
    includes: [
      "4. spoke commit on the repository's trunk: yes:",
      "SHOP-1: its design changed after SHOP-2's Hub commit.",
      'DEPENDENCIES NOT DONE: 0 of 1 dependency is done for the code step.',
    ],
  },
  {
    n: 43,
    name: "fixture 8 with the code step: an Open clarification names SHOP-1's design, and SHOP-1's code is done",
    build: (root, h) => {
      const a = spoke(root, S1.repo);
      const d = h.commit({ ...registry(a), ...cut(), ...designPair(S1) }, 'SHOP-1 design merged');
      h.commit({ ...designPair(S2, { hubCommit: d, clarifications: [['Open', '', '']] }), ...report(S1, { designCommit: d, spokeCommit: a.head }) }, 'SHOP-2 design and the SHOP-1 report merged');
    },
    runs: [CODE],
    exit: 1,
    includes: [
      "4. spoke commit on the repository's trunk: yes:",
      ['clarifications: no open row names SHOP-1.lld.md: no: ', 'CLAR-SHOP-menu-01 is Open and names SHOP-1.lld.md'],
      'DEPENDENCIES NOT DONE: 0 of 1 dependency is done for the code step.',
    ],
  },
  {
    // git merge-base exits 128 for a commit the hub does not have. The check asks
    // for the commit first, so this is a finding (1), not a fault of the run (4).
    n: 44,
    name: "SHOP-2's Hub commit is a full hash that the hub does not have",
    build: (root, h) => {
      h.commit({ ...cut(), ...designPair(S1) }, 'SHOP-1 design merged');
      h.commit(designPair(S2, { hubCommit: 'deadbeef'.repeat(5) }), 'SHOP-2 design merged');
    },
    exit: 1,
    includes: ['"Hub commit: deadbeefdead", which is not a commit on main'],
    excludes: ['merge-base --is-ancestor failed'],
  },
];

/* --------------------------------------------------------------------- runner */

function runOnce(cwd, root, args) {
  const res = spawnSync(process.execPath, [join(cwd, 'scripts', 'check-dependencies.mjs'), ...args], {
    cwd,
    env: { ...ENV, HARNESS_SPOKE_CACHE: join(root, 'cache') },
    encoding: 'utf8',
  });
  return { status: res.status, output: `${res.stdout || ''}${res.stderr || ''}` };
}

function carries(output, needle) {
  if (typeof needle === 'string') return output.includes(needle);
  return output.split('\n').some((line) => needle.every((part) => line.includes(part)));
}

function runFixture(fixture) {
  const root = mkdtempSync(join(tmpdir(), `dependencies-fx${String(fixture.n).padStart(2, '0')}-`));
  try {
    const h = hub(root);
    const built = fixture.build ? fixture.build(root, h) : null;
    const cwd = (built && built.cwd) || h.work;
    const problems = [];
    const outputs = [];
    const runs = (built && built.runs) || fixture.runs;
    for (const args of runs || [DESIGN]) {
      const { status, output } = runOnce(cwd, root, args);
      outputs.push(`$ check-dependencies.mjs ${args.join(' ')}\n${output}`);
      const label = runs ? ` (args: ${args.join(' ') || 'none'})` : '';
      if (status !== fixture.exit) problems.push(`expected exit ${fixture.exit}, got ${status}${label}`);
      for (const needle of fixture.includes || []) {
        if (!carries(output, needle)) problems.push(`output does not contain: ${[].concat(needle).join(' … ')}${label}`);
      }
      for (const needle of fixture.excludes || []) {
        if (output.includes(needle)) problems.push(`output should not contain: ${needle}${label}`);
      }
    }
    // A run of its own, with its own exit: the design step on an estate that the
    // code step judges.
    for (const { args, exit } of fixture.also || []) {
      const { status, output } = runOnce(cwd, root, args);
      outputs.push(`$ check-dependencies.mjs ${args.join(' ')}\n${output}`);
      if (status !== exit) problems.push(`expected exit ${exit}, got ${status} (args: ${args.join(' ')})`);
    }
    return { problems, output: outputs.join('\n') };
  } catch (err) {
    return { problems: [`fixture setup failed: ${err && err.message ? err.message : String(err)}`], output: '' };
  } finally {
    if (!process.argv.includes('--keep')) rmSync(root, { recursive: true, force: true });
  }
}

function main() {
  const wanted = process.argv.slice(2).filter((a) => a.search(/^\d+$/) === 0).map(Number);
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
    ? `\n${failed} of ${selected.length} fixtures FAILED. The dependency check is not trustworthy until this is green.\n`
    : `\n${selected.length} of ${selected.length} fixtures passed.\n`);
  rmSync(SANDBOX_HOME, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
}

main();

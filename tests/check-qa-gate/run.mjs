#!/usr/bin/env node
/**
 * run.mjs — the fixture suite for check-qa-gate.mjs.
 *
 *   usage:  node run.mjs            run every fixture
 *           node run.mjs 4 7        run only the numbered fixtures
 *           node run.mjs --keep     leave the throwaway repositories on disk
 *
 * A fixture is a HUB STATE: a throwaway hub with a real bare `origin`, the design
 * of one story on its trunk, and, where the fixture says so, the validation
 * report /qa-sprint writes, merged to the trunk or left on its `validation/<KEY>`
 * branch. The hub gets the three scripts the install copies in -- the validation
 * check, spoke-remote.mjs and check-qa-gate.mjs -- under scripts/, so the
 * `./spoke-remote.mjs` import and the beside-itself sibling lookup are exercised
 * in the layout they ship in. The script is run in the hub checkout exactly as
 * the spoke's qa-gate job runs it, with HARNESS_REPO and --head. Nothing is
 * imported and nothing is stubbed. Exit code and messages are asserted.
 *
 * The head commit is a fixed 40-character value. This check reads one remote,
 * the hub, and takes the head commit from the pull-request event, so no spoke
 * repository is needed to judge it.
 *
 * Node standard library only, plus git via child_process. No test framework.
 * Exit 0 if every fixture passes, 1 if any fails.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

// Two layouts. The library: this suite at accelerator/gate/tests/check-qa-gate/,
// the script and the validation check at accelerator/gate/, spoke-remote.mjs at
// accelerator/scripts/. An installed hub: this suite at tests/check-qa-gate/ and
// all three scripts at scripts/, the validation check under either extension.
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
const SCRIPT = locate('check-qa-gate', [join(LIB_GATE, 'check-qa-gate.mjs'), join(HUB_SCRIPTS, 'check-qa-gate.mjs')], process.env.HARNESS_CHECK_QA_GATE);
const SPOKE_REMOTE = locate('spoke-remote', [resolve(LIB_GATE, '..', 'scripts', 'spoke-remote.mjs'), join(HUB_SCRIPTS, 'spoke-remote.mjs')], process.env.HARNESS_SPOKE_REMOTE);
const VALIDATION = locate('check-validation', [join(LIB_GATE, 'check-validation.js'), join(HUB_SCRIPTS, 'check-validation.js'), join(HUB_SCRIPTS, 'check-validation.mjs')], process.env.HARNESS_CHECK);

/* ------------------------------------------------------------------ git helpers */

const SANDBOX_HOME = mkdtempSync(join(tmpdir(), 'qa-gate-home-'));
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

/**
 * The hub: a bare `origin` on `main` and a working clone with the three scripts
 * installed under scripts/ and committed, as the hub install leaves them.
 * `module: false` is a hub whose package.json is not "type": "module", where the
 * install renames check-validation.js to .mjs. `without` leaves one script out.
 * `commit(files, message)` writes, commits and pushes, and returns the commit.
 */
function hub(root, { module = true, without = null } = {}) {
  const bare = join(root, 'hub.git');
  const work = join(root, 'hub');
  git(root, ['init', '--bare', '-q', '--initial-branch', 'main', bare]);
  git(root, ['--git-dir', bare, 'symbolic-ref', 'HEAD', 'refs/heads/main']);
  git(root, ['init', '-q', '--initial-branch', 'main', work]);
  git(work, ['config', 'user.name', 'Fixture Runner']);
  git(work, ['config', 'user.email', 'fixture@example.invalid']);
  git(work, ['config', 'commit.gpgsign', 'false']);
  git(work, ['remote', 'add', 'origin', bare]);
  writeFiles(work, {
    'package.json': `${JSON.stringify({ name: 'qa-gate-fixture', private: true, ...(module ? { type: 'module' } : {}) }, null, 2)}\n`,
  });
  mkdirSync(join(work, 'scripts'), { recursive: true });
  const installed = [[SCRIPT, 'check-qa-gate.mjs'], [SPOKE_REMOTE, 'spoke-remote.mjs'], [VALIDATION, module ? 'check-validation.js' : 'check-validation.mjs']];
  for (const [src, name] of installed) {
    if (name !== without) copyFileSync(src, join(work, 'scripts', name));
  }
  const h = {
    bare,
    work,
    commit(files, message) {
      writeFiles(work, files);
      git(work, ['add', '-A']);
      git(work, ['commit', '-q', '--allow-empty', '-m', message]);
      git(work, ['push', '-q', 'origin', 'main']);
      return git(work, ['rev-parse', 'HEAD']).trim();
    },
    // The report on its own branch, pushed, and the checkout back on the trunk:
    // the state between /qa-sprint opening the hub pull request and its merge.
    branch(name, files, message) {
      git(work, ['checkout', '-q', '-b', name]);
      writeFiles(work, files);
      git(work, ['add', '-A']);
      git(work, ['commit', '-q', '-m', message]);
      git(work, ['push', '-q', 'origin', name]);
      git(work, ['checkout', '-q', 'main']);
    },
  };
  h.commit({}, 'chore: install the harness scripts');
  return h;
}

/* ------------------------------------------------------------ the artefacts */

const KEY = 'PROJ-412';
const REPO = 'transfer-service';
const TITLE = 'step-up authentication on high-value transfers';
const HEAD = '3f2a9c1e7b4d6a0f8e5c2b9d1a7f4e6c3b8d0a25';
const OTHER = '9b1d7e3c5a2f8d4e6b0c1a9f3e7d5b2c8a4f6e10';
const DESIGN_PATH = `docs/designs/${KEY}.lld.md`;
const REPORT_PATH = `docs/designs/${KEY}.validation.md`;

const row = (cells) => `| ${cells.map((c) => String(c)).join(' | ')} |`;
const sep = (n) => `|${'---|'.repeat(n)}`;

const CRITERIA = [
  ['AC-1', 'A transfer above the step-up threshold demands a second factor.', 'REQ-1.AC-1', 'FSD Authentication L118'],
  ['AC-2', 'A read-only advisory view inherits the existing session.', 'REQ-1.AC-2', 'FSD Authentication L124'],
  ['AC-3', 'A failed second factor writes no transfer record.', 'REQ-2.AC-1', 'FSD Authentication L131'],
];
const SHORT = ['Step-up demanded above the threshold', 'Advisory view inherits the session', 'A failed factor writes nothing'];

// The design check-validation reads: the heading, the Repository: line and the
// criteria table. `deprecated` marks the third criterion DEPRECATED, so a report
// may carry N/A against it; `extra` adds a line, for a design changed later.
function design({ deprecated = false, extra = null } = {}) {
  const criteria = deprecated
    ? [CRITERIA[0], CRITERIA[1], ['AC-3', 'DEPRECATED — superseded by REQ-2 revision 2', 'REQ-2.AC-1', 'FSD Authentication L131']]
    : CRITERIA;
  return {
    [DESIGN_PATH]: [
      `# LLD — ${KEY}: ${TITLE}`,
      '',
      '## 1. Traceability',
      '',
      `Ticket: ${KEY}`,
      `Repository: ${REPO}`,
      '',
      '## 4. Acceptance criteria',
      '',
      row(['ID', 'Criterion', 'Requirement', 'Source']),
      sep(4),
      ...criteria.map(row),
      '',
      ...(extra ? [extra, ''] : []),
    ].join('\n'),
  };
}

// The report, in the one shape check-validation reads. `verdicts` is one cell per
// criterion; `rows` leaves the last rows out; the closing line counts the rows.
function report({ designCommit, spokeCommit = HEAD, repository = REPO, verdicts = ['PASS', 'PASS', 'PASS'], rows = 3 }) {
  const table = CRITERIA.slice(0, rows).map((c, i) => row([c[0], SHORT[i], c[2], verdicts[i], `test_${i + 1} · src/transfer.py:${88 + i} · the behaviour is asserted`]));
  const pass = verdicts.slice(0, rows).filter((v) => v === 'PASS').length;
  const fail = verdicts.slice(0, rows).filter((v) => v === 'FAIL').length;
  return {
    [REPORT_PATH]: [
      `# Validation — ${KEY}: ${TITLE}`,
      '',
      `Design: ${DESIGN_PATH} at ${designCommit}`,
      `Repository: ${repository}`,
      `Spoke commit: ${spokeCommit}`,
      '',
      row(['AC', 'Criterion (short)', 'Requirement', 'Verdict', 'Evidence']),
      sep(5),
      ...table,
      '',
      `Criteria: ${rows} · PASS ${pass} · FAIL ${fail} · defects raised: NONE`,
      '',
    ].join('\n'),
  };
}

// The design merged, then the report naming that commit merged after it.
function merged(h, { designOpts = {}, reportOpts = {} } = {}) {
  const d = h.commit(design(designOpts), 'docs(PROJ-412): design merged');
  h.commit(report({ designCommit: d, ...reportOpts }), 'docs(PROJ-412): validation report merged');
  return d;
}

/* ------------------------------------------------------------------ fixtures */

const ARGS = [KEY, '--head', HEAD];
const AS_SPOKE = { HARNESS_REPO: REPO };

const FIXTURES = [
  {
    n: 1,
    name: 'the merged report names this repository and this head, every criterion PASS',
    build: (root, h) => merged(h),
    exit: 0,
    includes: ['[PASS] validation report on the trunk', '[PASS] report complete and every criterion passed', '[PASS] report names this repository', '[PASS] report names this head commit', 'QA PASSED: PROJ-412 validated at 3f2a9c1e7b4d'],
  },
  {
    // The pull request is open and nobody has run QA yet.
    n: 2,
    name: 'no report on the trunk',
    build: (root, h) => h.commit(design(), 'docs(PROJ-412): design merged'),
    exit: 1,
    includes: ['no docs/designs/PROJ-412.validation.md on origin/main; run /qa-sprint PROJ-412 on this pull request', 'skipped: no report', 'QA NOT PASSED: 4 of 4 checks failed'],
  },
  {
    // QA passed and the hub pull request is open: the person needs the merge, not
    // another QA run.
    n: 3,
    name: 'the report only on validation/PROJ-412, not merged',
    build: (root, h) => {
      const d = h.commit(design(), 'docs(PROJ-412): design merged');
      h.branch(`validation/${KEY}`, report({ designCommit: d }), 'docs(PROJ-412): validation report');
    },
    exit: 1,
    includes: ['but validation/PROJ-412 exists on origin; merge the hub\'s validation pull request, then run this job again'],
    excludes: ['QA PASSED'],
  },
  {
    // The reason the report names a commit: a push after QA is code QA never read.
    n: 4,
    name: 'a commit landed on the branch after QA',
    build: (root, h) => merged(h, { reportOpts: { spokeCommit: OTHER } }),
    exit: 1,
    includes: ['[PASS] report complete and every criterion passed', 'names spoke commit 9b1d7e3c5a2f, but this pull request\'s head is 3f2a9c1e7b4d; a commit landed after QA, so run /qa-sprint PROJ-412 on this pull request again'],
  },
  {
    n: 5,
    name: 'the report validated another repository',
    build: (root, h) => merged(h),
    env: { HARNESS_REPO: 'ledger-service' },
    exit: 1,
    includes: ['names repository "transfer-service", not "ledger-service"'],
  },
  {
    // Every check runs before the exit: the incomplete report is named, and the
    // two header lines are still compared.
    n: 6,
    name: 'an incomplete report, one criterion with no row',
    build: (root, h) => merged(h, { reportOpts: { rows: 2 } }),
    exit: 1,
    includes: ['the validation check says "REPORT INCOMPLETE', '[PASS] report names this head commit'],
  },
  {
    // check-validation refuses a FAIL row, so a failing report can never open the
    // code merge, whoever merged it into the hub.
    n: 7,
    name: 'a report with a FAIL row, merged into the hub anyway',
    build: (root, h) => merged(h, { reportOpts: { verdicts: ['PASS', 'PASS', 'FAIL'] } }),
    exit: 1,
    includes: ['[FAIL] report complete and every criterion passed', 'REPORT INCOMPLETE'],
    excludes: ['QA PASSED'],
  },
  {
    n: 8,
    name: 'N/A against a criterion the design marks DEPRECATED — must pass',
    build: (root, h) => merged(h, { designOpts: { deprecated: true }, reportOpts: { verdicts: ['PASS', 'PASS', 'N/A'] } }),
    exit: 0,
    includes: ['QA PASSED'],
  },
  {
    // The report is about an older design. check-validation says so, and this
    // check quotes it.
    n: 9,
    name: 'the design changed after the report merged',
    build: (root, h) => {
      merged(h);
      h.commit(design({ extra: 'A later amendment nobody validated.' }), 'docs(PROJ-412): amend the design');
    },
    exit: 1,
    includes: ['[FAIL] report complete and every criterion passed', 'REPORT INCOMPLETE'],
  },
  {
    n: 10,
    name: 'the report writes the spoke commit in upper case — must pass',
    build: (root, h) => merged(h, { reportOpts: { spokeCommit: HEAD.toUpperCase() } }),
    exit: 0,
    includes: ['QA PASSED'],
  },
  {
    n: 11,
    name: '--head given in upper case — must pass',
    build: (root, h) => merged(h),
    args: [KEY, '--head', HEAD.toUpperCase()],
    exit: 0,
    includes: ['QA PASSED'],
  },
  {
    n: 12,
    name: 'usage error: HARNESS_REPO is not set',
    build: (root, h) => merged(h),
    env: { HARNESS_REPO: '' },
    exit: 3,
    includes: ['HARNESS_REPO is not set'],
  },
  {
    n: 13,
    name: 'usage error: --head is an abbreviated commit',
    build: (root, h) => merged(h),
    args: [KEY, '--head', HEAD.slice(0, 12)],
    exit: 3,
    includes: ['is not a full 40-character commit'],
  },
  {
    n: 14,
    name: 'usage error: the key is not a work-item key',
    build: (root, h) => merged(h),
    args: ['proj-412', '--head', HEAD],
    exit: 3,
    includes: ['"proj-412" is not a work-item key'],
  },
  {
    n: 15,
    name: 'usage error: no --head',
    build: (root, h) => merged(h),
    args: [KEY],
    exit: 3,
    includes: ['expected --head'],
  },
  {
    n: 16,
    name: 'the hub\'s remote is unreachable — cannot verify',
    build: (root, h) => {
      merged(h);
      git(h.work, ['remote', 'set-url', 'origin', join(root, 'gone.git')]);
    },
    exit: 2,
    includes: ['CANNOT VERIFY: could not fetch origin/main', 'REASON: fetch-failed'],
  },
  {
    n: 17,
    name: 'HARNESS_TRUNK names a branch that is not the remote\'s default — cannot verify',
    build: (root, h) => {
      merged(h);
      git(h.work, ['push', '-q', 'origin', 'main:develop']);
    },
    env: { HARNESS_TRUNK: 'develop' },
    exit: 2,
    includes: ['this check was pointed at "develop" but origin\'s default branch is "main"', 'REASON: trunk-mismatch'],
  },
  {
    n: 18,
    name: 'check-validation is not installed beside it — cannot verify',
    hub: { without: 'check-validation.js' },
    build: (root, h) => merged(h),
    exit: 2,
    includes: ['check-validation.js (or .mjs) is not beside', 'REASON: script-missing'],
  },
  {
    // A hub whose package.json is not "type": "module" carries the check as
    // check-validation.mjs; this file is .mjs in both layouts.
    n: 19,
    name: 'the validation check installed as check-validation.mjs — must pass',
    hub: { module: false },
    build: (root, h) => merged(h),
    exit: 0,
    includes: ['QA PASSED'],
  },
  {
    // A shallow clone cannot prove the report's Design: commit is on the trunk;
    // check-validation refuses to judge, and so does this check.
    n: 20,
    name: 'a shallow hub clone that lacks the design\'s commit — cannot verify',
    build: (root, h) => {
      merged(h);
      const shallow = join(root, 'shallow');
      git(root, ['clone', '-q', '--depth', '1', `file://${h.bare}`, shallow]);
      h.cwd = shallow;
    },
    exit: 2,
    includes: ['CANNOT VERIFY: check-validation.js PROJ-412'],
  },
];

/* ---------------------------------------------------------------------- runner */

function runFixture(fixture) {
  const root = mkdtempSync(join(tmpdir(), `qa-gate-fx${String(fixture.n).padStart(2, '0')}-`));
  try {
    const h = hub(root, fixture.hub || {});
    if (fixture.build) fixture.build(root, h);
    // A fixture may move the run into another clone of the hub, as the shallow
    // one does; the scripts are then the ones that clone carries.
    const cwd = h.cwd || h.work;
    const script = existsSync(join(cwd, 'scripts', 'check-qa-gate.mjs')) ? join(cwd, 'scripts', 'check-qa-gate.mjs') : join(h.work, 'scripts', 'check-qa-gate.mjs');
    const res = spawnSync(process.execPath, [script, ...(fixture.args || ARGS)], {
      cwd,
      env: { ...ENV, ...AS_SPOKE, ...(fixture.env || {}) },
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
  const wanted = process.argv.slice(2).filter((a) => a.match(/^\d+$/)).map(Number);
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
    ? `\n${failed} of ${selected.length} fixtures FAILED. The QA gate is not trustworthy until this is green.\n`
    : `\nAll ${selected.length} fixtures passed.\n`);
  rmSync(SANDBOX_HOME, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
}

main();

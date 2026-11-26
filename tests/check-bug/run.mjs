#!/usr/bin/env node
/**
 * run.mjs — the fixture suite for check-bug.mjs.
 *
 *   usage:  node run.mjs            run every fixture
 *           node run.mjs 9 11       run only the numbered fixtures
 *           node run.mjs --keep     leave the throwaway repositories on disk
 *
 * A fixture here is a HUB STATE. Each case builds a throwaway hub with a real bare `origin`: the
 * list of repositories, and the two files /bugfix writes under docs/bugs/ -- the bug record and
 * the critic's review of it -- on the default branch. The hub gets the two scripts the install
 * copies in, check-bug.mjs and spoke-remote.mjs, under scripts/, so the `./spoke-remote.mjs` import
 * runs in the layout it ships in. The check runs in the hub checkout exactly as the hub's bug-gate
 * job and the spoke's run_bug step run it. Nothing is imported and nothing is stubbed. The exit
 * code and the failure text are asserted.
 *
 * One placeholder is substituted when the repository is built: `<RECORD-REVISION>` becomes the
 * blob hash of the record as written, the value `git hash-object` prints. A fixture that changes
 * the record in a later commit is NOT re-substituted: the review keeps naming the revision it read.
 *
 * Every bug here is synthetic. No text from a real ticket is copied.
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

// Two layouts. The library: this suite at accelerator/gate/tests/check-bug/, the check at
// accelerator/gate/, spoke-remote.mjs at accelerator/scripts/. An installed hub: this suite at
// tests/check-bug/ and both scripts at scripts/.
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
const SCRIPT = locate('check-bug', [join(LIB_GATE, 'check-bug.mjs'), join(HUB_SCRIPTS, 'check-bug.mjs')], process.env.HARNESS_CHECK);
const SPOKE_REMOTE = locate('spoke-remote', [resolve(LIB_GATE, '..', 'scripts', 'spoke-remote.mjs'), join(HUB_SCRIPTS, 'spoke-remote.mjs')], process.env.HARNESS_SPOKE_REMOTE);

/* ------------------------------------------------------------------ git helpers */

const SANDBOX_HOME = mkdtempSync(join(tmpdir(), 'check-bug-home-'));
const ENV = {
  ...process.env,
  HOME: SANDBOX_HOME,
  XDG_CONFIG_HOME: join(SANDBOX_HOME, '.config'),
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
  GIT_ASKPASS: 'true',
};
delete ENV.HARNESS_TRUNK;
delete ENV.HARNESS_REPO;

function git(cwd, args, input) {
  return execFileSync('git', args, { cwd, env: ENV, encoding: 'utf8', input, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
}

function writeFiles(root, files) {
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }
}

const blobOf = (text) => git(process.cwd(), ['hash-object', '--stdin'], text).trim();

/** A hub with a bare origin on `main`, the two scripts installed under scripts/, and `commit()`. */
function hub(root, { noOrigin = false } = {}) {
  const bare = join(root, 'hub.git');
  const work = join(root, 'hub');
  git(root, ['init', '--bare', '-q', '--initial-branch', 'main', bare]);
  git(root, ['--git-dir', bare, 'symbolic-ref', 'HEAD', 'refs/heads/main']);
  git(root, ['init', '-q', '--initial-branch', 'main', work]);
  git(work, ['config', 'user.name', 'Fixture Runner']);
  git(work, ['config', 'user.email', 'fixture@example.invalid']);
  git(work, ['config', 'commit.gpgsign', 'false']);
  if (!noOrigin) git(work, ['remote', 'add', 'origin', bare]);
  writeFiles(work, { 'package.json': `${JSON.stringify({ name: 'check-bug-fixture', private: true, type: 'module' }, null, 2)}\n` });
  mkdirSync(join(work, 'scripts'), { recursive: true });
  copyFileSync(SCRIPT, join(work, 'scripts', 'check-bug.mjs'));
  copyFileSync(SPOKE_REMOTE, join(work, 'scripts', 'spoke-remote.mjs'));
  const h = {
    bare,
    work,
    commit(files, message) {
      writeFiles(work, files);
      git(work, ['add', '-A']);
      git(work, ['commit', '-q', '--allow-empty', '-m', message]);
      if (!noOrigin) git(work, ['push', '-q', 'origin', 'main']);
    },
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

const KEY = 'PLDC-731';
const REPO = 'transfer-service';
const OTHER_REPO = 'ledger-service';
const COMMIT = '3f2a9c1e7b4d';
const RECORD_PATH = `docs/bugs/${KEY}.bug.md`;
const REVIEW_PATH = `docs/bugs/${KEY}.bug-review.md`;

const registry = (ids = [REPO, OTHER_REPO]) => `${JSON.stringify({
  repositories: Object.fromEntries(ids.map((id) => [id, { url: `https://example.invalid/${id}.git`, trunk: 'default', purpose: `The synthetic ${id}.` }])),
}, null, 2)}\n`;

const row = (cells) => `| ${cells.join(' | ')} |`;

/**
 * The bug record /bugfix writes. Each option changes one thing. `replace` swaps a whole section's
 * body, `drop` removes a section, and `header` / `snapshot` replace their lines.
 */
function record(o = {}) {
  const header = o.header || [`Key: ${KEY}`, `Repository: ${REPO}`, 'Verdict: Bug', 'Size: one-fix'];
  const snapshot = o.snapshot || [
    `Source: https://example.invalid/browse/${KEY}`,
    `Fetched: ${KEY}@2026-11-10T09:30:00Z`,
    'Type: Bug',
    '',
    '### Description',
    '',
    'The transfer total ignores the fee when the amount has two decimals.',
  ];
  const chain = o.chain || [
    row(['Link', 'Location', 'What happens']),
    row(['---', '---', '---']),
    row(['1', `${REPO}@${COMMIT}:src/transfer/total.ts:42`, 'The total adds the amount and drops the fee.']),
    row(['2', `${REPO}@${COMMIT}:src/transfer/fee.ts:17`, 'The fee is rounded to zero before it is returned.']),
  ];
  const sections = {
    'Ticket snapshot': snapshot,
    Claim: o.claim || ['Observed: the total shows 10.00 for an amount of 10.00 and a fee of 0.50.', 'Expected: the total shows 10.50.'],
    'Pinned commit': o.pinned || [`Pinned: ${REPO}@${COMMIT}`],
    Chain: chain,
    Reproduction: o.reproduction || ['Layer: unit', 'File: tests/transfer/total.test.ts'],
    'Files to change': o.files || ['- src/transfer/fee.ts', '- src/transfer/total.ts'],
    'Clash report': o.clash || ['none'],
  };
  for (const name of o.drop || []) delete sections[name];
  const body = Object.entries(sections).map(([name, lines]) => [`## ${name}`, '', ...lines, ''].join('\n')).join('\n');
  return `# ${KEY} — Transfer total ignores the fee\n\n${header.join('\n')}\n\n${body}${o.extra || ''}`;
}

function review(o = {}) {
  return [
    `# Review — ${KEY}`,
    '',
    `Mode: ${o.mode || 'bug-review'}`,
    ...(o.noRevision ? [] : [`Record revision: ${o.revision || '<RECORD-REVISION>'}`]),
    '',
    `The chain of ${KEY} reaches the fee rounding, and the reproducing test fails on the pinned commit.`,
    '',
    o.verdict || '### VERDICT: APPROVED',
    '',
  ].join('\n');
}

/** The default state: a registry, the record and its review, all on the trunk. */
function files(o = {}) {
  const text = o.recordText === undefined ? record(o.record) : o.recordText;
  const out = { 'docs/estate/repositories.json': o.registry === undefined ? registry() : o.registry };
  if (o.registry === null) delete out['docs/estate/repositories.json'];
  if (text !== null) out[RECORD_PATH] = text;
  if (o.review !== null) out[REVIEW_PATH] = review({ revision: blobOf(text === null ? '' : text), ...o.review }).replace('<RECORD-REVISION>', blobOf(text === null ? '' : text));
  return out;
}

/* -------------------------------------------------------------------- the runner */

const results = [];
const ONLY = process.argv.slice(2).filter((a) => a.search(/^\d+$/) === 0).map(Number);
const KEEP = process.argv.includes('--keep');

/**
 * A fixture: its number, its name, the exit code, the text the output must hold (`say`) and the
 * text it must not (`not`), the files it builds, and how it runs the check.
 */
function fixture(n, name, expect, build, { say = [], not = [], repo, env = {}, args = [KEY], setup } = {}) {
  if (ONLY.length && !ONLY.includes(n)) return;
  const root = mkdtempSync(join(tmpdir(), `check-bug-${n}-`));
  let detail = '';
  let ok = false;
  try {
    const h = hub(root, { noOrigin: !!env.NO_ORIGIN });
    h.commit(build(), 'docs: the bug record');
    if (setup) setup(h);
    const runEnv = { ...ENV, ...env };
    delete runEnv.NO_ORIGIN;
    if (repo) runEnv.HARNESS_REPO = repo;
    const res = spawnSync(process.execPath, ['scripts/check-bug.mjs', ...args], { cwd: h.work, env: runEnv, encoding: 'utf8' });
    const out = `${res.stdout}\n${res.stderr}`;
    const problems = [];
    if (res.status !== expect) problems.push(`exit ${res.status}, expected ${expect}`);
    for (const s of say) if (!out.includes(s)) problems.push(`output lacks "${s}"`);
    for (const s of not) if (out.includes(s)) problems.push(`output holds "${s}"`);
    ok = problems.length === 0;
    detail = ok ? '' : `${problems.join('; ')}\n${out.trim().split('\n').map((l) => `      | ${l}`).join('\n')}`;
  } catch (err) {
    detail = `fixture crashed: ${err.message}`;
  } finally {
    if (!KEEP) rmSync(root, { recursive: true, force: true });
  }
  results.push({ n, name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${String(n).padStart(2)}  ${name}${detail ? `\n${detail}` : ''}`);
}

/* ------------------------------------------------------------------- the fixtures */

// 1 is the valid control. Every other fixture changes exactly one thing in it.
fixture(1, 'the valid control: a complete, reviewed record', 0, () => files(), { say: ['BUG RECORD COMPLETE'] });
fixture(2, 'the same record, judged for the repository it names', 0, () => files(), { repo: REPO, say: ['BUG RECORD COMPLETE'] });

// The record
fixture(3, 'no record on the trunk', 1, () => files({ recordText: null, review: null }), { say: [`no ${RECORD_PATH}`, `/bugfix ${KEY}`] });
fixture(4, 'the record is only on its bugfix branch, not on the trunk', 1, () => ({ 'docs/estate/repositories.json': registry() }), {
  setup: (h) => h.branch(`bugfix/${KEY}`, { [RECORD_PATH]: record() }, 'docs: the bug record'),
  say: [`no ${RECORD_PATH}`, `bugfix/${KEY} exists`, 'merge the hub'],
});
fixture(5, 'the Key line names another ticket', 1, () => files({ record: { header: ['Key: PLDC-999', `Repository: ${REPO}`, 'Verdict: Bug', 'Size: one-fix'] } }), { say: ['Key: PLDC-999', `not ${KEY}`] });
fixture(6, 'the verdict is not Bug', 1, () => files({ record: { header: [`Key: ${KEY}`, `Repository: ${REPO}`, 'Verdict: Not a bug', 'Size: one-fix'] } }), { say: ['Verdict: Not a bug', 'only a Bug has a record'] });
fixture(7, 'the size is too-large', 1, () => files({ record: { header: [`Key: ${KEY}`, `Repository: ${REPO}`, 'Verdict: Bug', 'Size: too-large'] } }), { say: ['Size: too-large', '/feature'] });
fixture(8, 'a section is missing: the claim', 1, () => files({ record: { drop: ['Claim'] } }), { say: ['## Claim'] });
fixture(9, 'a section is empty: the clash report', 1, () => files({ record: { clash: [] } }), { say: ['"Clash report" is empty'] });
fixture(10, 'a placeholder in the claim', 1, () => files({ record: { claim: ['Observed: <what the reporter saw>', 'Expected: the total shows 10.50.'] } }), { say: ['placeholder'] });
fixture(11, 'the files to change are empty', 1, () => files({ record: { files: ['none'] } }), { say: ['names no file to change'] });
fixture(12, 'a file to change climbs out of the repository', 1, () => files({ record: { files: ['- ../outside/secret.ts'] } }), { say: ['../outside/secret.ts'] });
fixture(13, 'the reproduction layer is not a layer', 1, () => files({ record: { reproduction: ['Layer: manual', 'File: tests/transfer/total.test.ts'] } }), { say: ['Layer: manual'] });
fixture(14, 'the reproduction names no file', 1, () => files({ record: { reproduction: ['Layer: unit'] } }), { say: ['File:'] });
fixture(15, 'the pinned commit is not 12 hex characters', 1, () => files({ record: { pinned: [`Pinned: ${REPO}@3f2a9c1`] } }), { say: ['Pinned:'] });
fixture(16, 'a section appears twice', 1, () => files({ record: { extra: '\n## Claim\n\nObserved again.\n' } }), { say: ['"## Claim" appears 2 times'] });
fixture(17, 'hidden markup in the claim', 1, () => files({ record: { claim: ['<details><summary>Observed</summary>the total drops the fee</details>'] } }), { say: ['<details>', 'markup'] });

// The ticket snapshot
const snap = (lines) => ({ snapshot: lines });
const description = ['', '### Description', '', 'The transfer total ignores the fee.'];
fixture(18, 'the snapshot source is not an https address', 1, () => files({ record: snap([`Source: ${KEY}`, `Fetched: ${KEY}@2026-11-10T09:30:00Z`, 'Type: Bug', ...description]) }), { say: ['Source:'] });
fixture(19, 'the snapshot was fetched from another ticket', 1, () => files({ record: snap([`Source: https://example.invalid/browse/${KEY}`, 'Fetched: PLDC-999@2026-11-10T09:30:00Z', 'Type: Bug', ...description]) }), { say: ['Fetched: PLDC-999@', `not ${KEY}`] });
fixture(20, 'the snapshot has no fetch time', 1, () => files({ record: snap([`Source: https://example.invalid/browse/${KEY}`, `Fetched: ${KEY}`, 'Type: Bug', ...description]) }), { say: ['Fetched:'] });
fixture(21, 'the ticket is not a Bug', 1, () => files({ record: snap([`Source: https://example.invalid/browse/${KEY}`, `Fetched: ${KEY}@2026-11-10T09:30:00Z`, 'Type: Story', ...description]) }), { say: ['Type: Story', '/from-ticket'] });
fixture(22, 'the snapshot keeps no description of the ticket', 1, () => files({ record: snap([`Source: https://example.invalid/browse/${KEY}`, `Fetched: ${KEY}@2026-11-10T09:30:00Z`, 'Type: Bug', '', '### Description', '']) }), { say: ['Description'] });

// The chain
const chainOf = (...locations) => [
  row(['Link', 'Location', 'What happens']),
  row(['---', '---', '---']),
  ...locations.map((l, i) => row([String(i + 1), l, 'The total drops the fee.'])),
];
fixture(23, 'the chain has no link', 1, () => files({ record: { chain: chainOf() } }), { say: ['names no link'] });
fixture(24, 'a chain link has an 11-character commit', 1, () => files({ record: { chain: chainOf(`${REPO}@3f2a9c1e7b4:src/transfer/total.ts:42`) } }), { say: ['3f2a9c1e7b4', '<repo>@<12-hex>:<path>:<line>'] });
fixture(25, 'a chain link has line 0', 1, () => files({ record: { chain: chainOf(`${REPO}@${COMMIT}:src/transfer/total.ts:0`) } }), { say: ['total.ts:0'] });
fixture(26, 'a chain link path climbs out of the repository', 1, () => files({ record: { chain: chainOf(`${REPO}@${COMMIT}:../etc/passwd:3`) } }), { say: ['../etc/passwd'] });
fixture(27, 'a chain link names a repository outside the list', 1, () => files({ record: { chain: chainOf(`${REPO}@${COMMIT}:src/transfer/total.ts:42`, `ghost-service@${COMMIT}:src/a.ts:1`) } }), { say: ['ghost-service', 'repositories.json'] });
fixture(28, 'no chain link is in the record\'s own repository', 1, () => files({ record: { chain: chainOf(`${OTHER_REPO}@${COMMIT}:src/ledger.ts:9`) } }), { say: [`no link of the chain is in ${REPO}`] });
fixture(29, 'a chain row that sits in a code fence does not count', 1, () => files({ record: { chain: ['```', ...chainOf(`${REPO}@${COMMIT}:src/transfer/total.ts:42`), '```'] } }), { say: ['names no link'] });

// The repository
fixture(30, 'the repository is not in the list', 1, () => files({ record: { header: [`Key: ${KEY}`, 'Repository: ghost-service', 'Verdict: Bug', 'Size: one-fix'] } }), { say: ['ghost-service', 'repositories.json'] });
fixture(31, 'the record names another repository than the pull request', 1, () => files(), { repo: OTHER_REPO, say: [`names repository "${REPO}", not "${OTHER_REPO}"`] });
fixture(32, 'the pinned commit is in another repository than the record names', 1, () => files({ record: { pinned: [`Pinned: ${OTHER_REPO}@${COMMIT}`] } }), { say: [`Pinned: ${OTHER_REPO}@`, REPO] });
fixture(33, 'the hub has no list of repositories', 1, () => files({ registry: null }), { say: ['repositories.json'] });

// The review
fixture(34, 'no review on the trunk', 1, () => files({ review: null }), { say: [`no ${REVIEW_PATH}`] });
fixture(35, 'the verdict is CHANGES REQUESTED', 1, () => files({ review: { verdict: '### VERDICT: CHANGES REQUESTED' } }), { say: ['CHANGES REQUESTED', '### VERDICT: APPROVED'] });
fixture(36, 'the review is in another mode', 1, () => files({ review: { mode: 'design-review' } }), { say: ['Mode: design-review', 'bug-review'] });
fixture(37, 'the review names no revision of the record', 1, () => files({ review: { noRevision: true } }), { say: ['Record revision:'] });
fixture(38, 'the review approves another revision of the record', 1, () => files({ review: { revision: 'abcdef1234567' } }), { say: ['abcdef1234567', 'unreviewed'] });
fixture(39, 'the record changed one byte after the review', 1, () => files(), {
  setup: (h) => h.commit({ [RECORD_PATH]: `${record()}\n.` }, 'docs: edit the record after its review'),
  say: ['unreviewed'],
});

// Every rule runs before the exit
fixture(40, 'three faults at once are all listed', 1, () => files({ record: { header: ['Key: PLDC-999', `Repository: ${REPO}`, 'Verdict: Not a bug', 'Size: one-fix'], reproduction: ['Layer: manual', 'File: a.test.ts'] }, review: { verdict: '### VERDICT: CHANGES REQUESTED' } }), {
  say: ['Key: PLDC-999', 'Verdict: Not a bug', 'Layer: manual', 'CHANGES REQUESTED'],
});

// Cannot verify, and usage
fixture(41, 'the trunk name the remote does not confirm', 2, () => files(), { env: { HARNESS_TRUNK: 'trunk-x' }, say: ['CANNOT VERIFY'] });
fixture(42, 'a checkout with no origin', 2, () => files(), { env: { NO_ORIGIN: '1' }, say: ['CANNOT VERIFY', 'no remote called origin'] });
fixture(43, 'no key', 3, () => files(), { args: [], say: ['usage:'] });
fixture(44, 'a key that is not a key', 3, () => files(), { args: ['pldc-731'], say: ['usage:'] });
fixture(45, 'HARNESS_REPO is not a repository id', 3, () => files(), { env: { HARNESS_REPO: '-bad id' }, say: ['HARNESS_REPO'] });

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} of ${results.length} fixtures passed.`);
rmSync(SANDBOX_HOME, { recursive: true, force: true });
process.exit(failed.length ? 1 : 0);

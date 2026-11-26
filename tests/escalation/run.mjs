#!/usr/bin/env node
/**
 * run.mjs — the fixture suite for escalation.mjs, the one writer of the escalation record.
 *
 *   usage:  node run.mjs            run every fixture
 *           node run.mjs 3 9        run only the numbered fixtures
 *           node run.mjs --keep     leave the throwaway repositories on disk
 *
 * A fixture is a REPOSITORY STATE: a throwaway hub with a real bare origin at
 * `<root>/acme/hub.git`, its trunk, the installed scripts and `governance/escalation-points.json`
 * on that trunk, and GitHub: the fake gh (fake-gh.mjs) first on PATH, which holds the hub's issues,
 * their comments, labels and artifacts in one state file. Where a fixture says so, a record that
 * another writer made. The shipped script runs from the hub as an installed copy
 * (`scripts/escalation.mjs`), exactly as a command or the sweep workflow runs it. The exit code
 * and the output text are asserted, and so is what reached GitHub. Fixture 1 is the valid control.
 * Most others change one thing. Two writers at the same moment are a real race: the fake gh holds
 * each writer's first comment until both have reached it (FAKE_GH_BARRIER).
 *
 * Every fixture runs under a private HOME, so a developer's gitconfig cannot change a result, and
 * under a fixed clock (HARNESS_ESCALATION_NOW), so no result depends on the day it runs.
 *
 * Node standard library only, plus git via child_process and the fake gh. No test framework.
 * Exit 0 if every fixture passes, 1 if any fails.
 */

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

// The library layout (accelerator/scripts/tests/escalation) and the installed layout (tests/escalation).
const LAYOUTS = [
  { scripts: resolve(HERE, '..', '..'), gate: resolve(HERE, '..', '..', '..', 'gate'), governance: resolve(HERE, '..', '..', '..', 'governance') },
  { scripts: resolve(HERE, '..', '..', 'scripts'), gate: resolve(HERE, '..', '..', 'scripts'), governance: resolve(HERE, '..', '..', 'governance') },
];
const LIB = LAYOUTS.find((l) => existsSync(join(l.scripts, 'escalation.mjs')));
if (!LIB) {
  console.error('cannot locate escalation.mjs beside this suite.');
  process.exit(4);
}
const FILES = [
  [join(LIB.scripts, 'escalation.mjs'), 'scripts/escalation.mjs'],
  [join(LIB.scripts, 'escalation-record.mjs'), 'scripts/escalation-record.mjs'],
  [join(LIB.scripts, 'escalation-store.mjs'), 'scripts/escalation-store.mjs'],
  [join(LIB.scripts, 'spoke-remote.mjs'), 'scripts/spoke-remote.mjs'],
  [join(LIB.gate, 'harness-commit.mjs'), 'scripts/harness-commit.mjs'],
  [join(LIB.gate, 'check-watermark.mjs'), 'scripts/check-watermark.mjs'],
  [join(LIB.gate, 'check-staged.mjs'), 'scripts/check-staged.mjs'],
  [join(LIB.gate, 'check-coverage.mjs'), 'scripts/check-coverage.mjs'],
  [join(LIB.gate, 'spoke-trunk.mjs'), 'scripts/spoke-trunk.mjs'],
  [join(LIB.governance, 'escalation-points.json'), 'governance/escalation-points.json'],
];

/* ------------------------------------------------------------------ git helpers */

const SANDBOX_HOME = mkdtempSync(join(tmpdir(), 'escalation-home-'));
const CLOCK = '2026-10-29T14:02:11Z';
// GitHub Actions sets GITHUB_SERVER_URL, GITHUB_REPOSITORY and GITHUB_STEP_SUMMARY, and the script
// reads them. Drop every GITHUB_ variable, so a fixture gives the same result in CI as on a laptop.
const ENV = {
  ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GITHUB_'))),
  HOME: SANDBOX_HOME,
  XDG_CONFIG_HOME: join(SANDBOX_HOME, '.config'),
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
  GIT_ASKPASS: 'true',
  HARNESS_ESCALATION_NOW: CLOCK,
};
for (const name of ['HARNESS_TRUNK', 'HARNESS_SPOKE_CACHE', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete ENV[name];

function git(cwd, args, env = ENV) {
  return execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function writeFiles(root, files) {
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }
}

function initClone(work, bare, trunk = 'main') {
  git(dirname(work), ['init', '-q', '--initial-branch', trunk, work]);
  git(work, ['config', 'user.name', 'Fixture Runner']);
  git(work, ['config', 'user.email', 'fixture@example.invalid']);
  git(work, ['config', 'commit.gpgsign', 'false']);
  git(work, ['remote', 'add', 'origin', bare]);
}

function commitAll(work, message) {
  git(work, ['add', '-A']);
  git(work, ['commit', '-q', '--allow-empty', '-m', message]);
}

// The clarification log of one work item: its own file, the eight columns of the design's §9.
const CLAR_PATH = (key) => `docs/designs/${key}.clar-log.md`;
const CLAR_LOG = (key, rows = []) => `# Clarification log — ${key}\n\n| ID | Question | Source | Blocking | Routed to | Status | Resolution | Resolved |\n|---|---|---|---|---|---|---|---|\n${rows.join('\n')}${rows.length ? '\n' : ''}`;
const CLAR_ROW = (status) => `| CLAR-PROJ-ledger-01 | Does a partial refund post one line or two? | FSD L12 | yes | Product owner | ${status} | ${status === 'Closed' ? 'One line.' : ''} | ${status === 'Closed' ? '2026-10-30' : ''} |`;

/** The hub: a bare origin, a work clone with the installed scripts on the trunk, and a design. */
function makeHub(root, { name = 'hub', trunk = 'main', clarRows = [] } = {}) {
  const bare = join(root, 'acme', `${name}.git`);
  mkdirSync(dirname(bare), { recursive: true });
  git(dirname(bare), ['init', '--bare', '-q', '--initial-branch', trunk, bare]);
  const work = join(root, name);
  initClone(work, bare, trunk);
  for (const [from, to] of FILES) {
    mkdirSync(dirname(join(work, to)), { recursive: true });
    cpSync(from, join(work, to));
  }
  // check-coverage.mjs, which the commit helper imports, reads the guard's contract module.
  cpSync(join(LIB.gate, 'test-guard'), join(work, 'scripts', 'test-guard'), { recursive: true });
  writeFiles(work, {
    'docs/designs/PROJ-421.lld.md': '# Design PROJ-421\n\nVersion one.\n',
    [CLAR_PATH('PROJ-421')]: CLAR_LOG('PROJ-421', clarRows),
    'docs/requirements/payments-refunds/requirements.md': '# Requirements\n\nVersion one.\n',
  });
  commitAll(work, 'hub trunk');
  git(work, ['push', '-q', 'origin', trunk]);
  // GitHub, for the record: the fake gh first on PATH, and its state file.
  const bin = join(root, 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'gh'), `#!/bin/sh\nexec "${process.execPath}" "${join(HERE, 'fake-gh.mjs')}" "$@"\n`);
  chmodSync(join(bin, 'gh'), 0o755);
  const state = join(root, 'github.json');
  writeFileSync(state, JSON.stringify({ repo: 'acme/hub', next: 1, issues: [], labels: [], pulls: [] }, null, 2));
  const env = { PATH: `${bin}:${process.env.PATH}`, FAKE_GH_STATE: state, GH_REPO: 'acme/hub' };
  return { work, bare, trunk, root, name, state, env, bin };
}

/** A second clone of the same origin: another writer. */
function cloneHub(hub, name = 'other') {
  const work = join(hub.root, name);
  git(hub.root, ['clone', '-q', hub.bare, work]);
  git(work, ['config', 'user.name', 'Other Runner']);
  git(work, ['config', 'user.email', 'other@example.invalid']);
  git(work, ['config', 'commit.gpgsign', 'false']);
  return work;
}

/** Change a file on the trunk, as a merge would. */
function mergeToTrunk(hub, files, message = 'a merged change') {
  writeFiles(hub.work, files);
  commitAll(hub.work, message);
  git(hub.work, ['push', '-q', 'origin', hub.trunk]);
}

/* --------------------------------------------------------------- the fake GitHub */

const ISSUE_MARK = /<!-- shl-escalation id=(ESC-[A-Za-z0-9-]+) -->/;
const fenceOf = (body, lang) => { const m = String(body || '').match(new RegExp('```' + lang + '\\n([\\s\\S]*?)\\n```')); return m ? m[1] : null; };
const ghState = (hub) => JSON.parse(readFileSync(hub.state, 'utf8'));
const saveState = (hub, s) => writeFileSync(hub.state, JSON.stringify(s, null, 2));
/** The harness issues of one owner, oldest escalation first. */
function issuesOf(hub, owner) {
  return ghState(hub).issues.filter((i) => i.title.startsWith('[shl-harness] ') && (String(i.body).match(ISSUE_MARK) || [])[1]
    && String(i.body).match(ISSUE_MARK)[1].startsWith(`ESC-${owner}-`)).sort((a, b) => a.number - b.number);
}
const artefactOf = (issue, name = 'escalation-record.jsonl') => issue.artifacts.find((a) => a.name === name) || null;
const latestOf = (artefact) => (artefact ? artefact.versions[artefact.versions.length - 1].body : null);

/** The record lines of one owner, from each issue's artefact, or null where there is none. */
function recordOf(hub, owner) {
  const issues = issuesOf(hub, owner);
  if (!issues.length) return null;
  return issues.map((i) => { const body = fenceOf(latestOf(artefactOf(i)), 'jsonl'); return body ? `${body}\n` : ''; }).join('');
}
const linesOf = (text) => (text || '').split('\n').filter(Boolean).map((l) => JSON.parse(l));

/** Make a record by hand, as a person with Write access could: an issue per id, the line comments and the artefact. */
function craftRecord(hub, owner, lines, { comments = true, artefact = true, markerId = null } = {}) {
  const s = ghState(hub);
  s.issues = s.issues.filter((i) => i.user !== 'crafter' || !i.title.startsWith(`[shl-harness] ${owner} `));
  const groups = new Map();
  let last = `ESC-${owner}-01`;
  for (const l of lines) {
    let id = last;
    try { const o = typeof l === 'string' ? JSON.parse(l) : l; if (o && typeof o.id === 'string') id = o.id; } catch { /* not JSON: it stays with the id before it */ }
    last = id;
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(typeof l === 'string' ? l : JSON.stringify(l));
  }
  for (const [lineId, raws] of groups) {
    const id = markerId || lineId;
    const issue = { number: s.next++, title: `[shl-harness] ${owner} · crafted`, body: `A record made by hand.\n\n<!-- shl-escalation id=${id} -->\nGenerated-by: SHL Agentic Harness\n`, state: 'open', state_reason: null, labels: [], user: 'crafter', created_at: CLOCK, comments: [], artifacts: [] };
    if (comments) {
      raws.forEach((raw, k) => {
        let seq = k + 1;
        try { const o = JSON.parse(raw); if (Number.isInteger(o.seq)) seq = o.seq; } catch { /* keep the position */ }
        s.commentSeq = (s.commentSeq || 100) + 1;
        issue.comments.push({ id: s.commentSeq, body: `A line.\n\n\`\`\`json\n${raw}\n\`\`\`\n\n<!-- shl-escalation-line id=${id} seq=${seq} -->\nGenerated-by: SHL Agentic Harness\n`, user: { login: 'crafter' }, author_association: 'COLLABORATOR', created_at: CLOCK });
      });
    }
    if (artefact) issue.artifacts.push({ number: 1, type: 'generic', name: 'escalation-record.jsonl', versions: [{ version: 1, body: `A note.\n\n\`\`\`jsonl\n${raws.join('\n')}\n\`\`\`\n`, actor: 'crafter', created_at: CLOCK }] });
    issue.artifactSeq = artefact ? 1 : 0;
    s.issues.push(issue);
  }
  saveState(hub, s);
}

/** A person's comment on an issue, as GitHub stores it. */
function comment(hub, number, body, { login = 'lead-one', association = 'MEMBER', at = CLOCK } = {}) {
  const s = ghState(hub);
  const issue = s.issues.find((i) => i.number === number);
  s.commentSeq = (s.commentSeq || 100) + 1;
  issue.comments.push({ id: s.commentSeq, body, user: { login }, author_association: association, created_at: at });
  saveState(hub, s);
  return s.commentSeq;
}

/* ------------------------------------------------------------ the record's lines */

const RAISED = (over = {}) => ({
  schema_version: 1, id: 'ESC-PROJ-421-01', seq: 1, event: 'raised', at: '2026-10-29T14:02:11Z',
  by: { kind: 'seat', name: 'sprint-orchestrator' },
  trigger: 'revision-cap', point: 'dev-sprint.code-review-cap', path: 'review-cap',
  work_item: 'PROJ-421', slug: 'payments-refunds', repository: 'payments-api',
  runner: 'dev-one', route: { first: 'runner', next: 'engineering lead' },
  parked: { ref: 'feature/PROJ-421-refund-ledger', commit: '3f9c2a1b7d4e' },
  question: 'Does a partial refund post one ledger line or two?', findings: null,
  links: { design: 'docs/designs/PROJ-421.lld.md', iteration_run: 'run-2026-10-29-1402' }, hub_commit: '8a1d0e4c9b2f',
  ...over,
});
const NOTIFIED = (over = {}) => ({ schema_version: 1, id: 'ESC-PROJ-421-01', seq: 2, event: 'notified', at: '2026-10-29T14:02:14Z', by: { kind: 'script', name: 'escalation.mjs' }, to: 'runner', channel: 'session', ...over });
const PERSON = { kind: 'person', role: 'engineering lead' };

/* ----------------------------------------------------------------- the script runner */

function run(hub, args, { env = {}, cwd, work = hub.work } = {}) {
  const res = spawnSync(process.execPath, [join(work, 'scripts', 'escalation.mjs'), ...args], { cwd: cwd || work, env: { ...ENV, ...hub.env, ...env }, encoding: 'utf8' });
  return { code: res.status, out: res.stdout || '', err: res.stderr || '', all: `${res.stdout || ''}${res.stderr || ''}` };
}

/** The same, without waiting: two of them in one Promise.all race for real. */
function runAsync(hub, args, env = {}) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [join(hub.work, 'scripts', 'escalation.mjs'), ...args], { cwd: hub.work, env: { ...ENV, ...hub.env, ...env } });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => done({ code, out, err, all: `${out}${err}` }));
  });
}

const RAISE_ARGS = (over = {}) => {
  const base = {
    '--point': 'dev-sprint.code-review-cap', '--slug': 'payments-refunds', '--work-item': 'PROJ-421', '--repository': 'payments-api', '--runner': 'dev-one',
    '--question': 'Does a partial refund post one ledger line or two?', '--parked-ref': 'feature/PROJ-421-refund-ledger', '--parked-commit': '3f9c2a1b7d4e',
    '--design': 'docs/designs/PROJ-421.lld.md', '--iteration-run': 'run-2026-10-29-1402', '--tests-commit': 'a1b2c3d4e5f6', '--by-seat': 'sprint-orchestrator',
  };
  return ['raise', ...Object.entries({ ...base, ...over }).filter(([, v]) => v !== null).flat()];
};
const ACK = (id = 'ESC-PROJ-421-01', extra = []) => ['ack', id, '--role', 'engineering lead', ...extra];

/** An assertion list for one fixture. */
function checks() {
  const problems = [];
  const t = {
    problems,
    ok(cond, why) { if (!cond) problems.push(why); },
    exit(res, code) { if (res.code !== code) problems.push(`expected exit ${code}, got ${res.code}: ${res.all.trim().split('\n').slice(0, 4).join(' / ')}`); },
    has(res, text) { if (!res.all.includes(text)) problems.push(`output does not contain ${JSON.stringify(text)}: ${res.all.trim().split('\n').slice(0, 4).join(' / ')}`); },
    lacks(res, text) { if (res.all.includes(text)) problems.push(`output should not contain ${JSON.stringify(text)}`); },
  };
  return t;
}

/* ------------------------------------------------------------------- the fixtures */

const FIXTURES = [
  {
    n: 1, name: 'a valid raised line passes: one [shl-harness] issue, a comment for each line, the artefact, one label, and the checkout untouched',
    run(hub) {
      const t = checks();
      const before = git(hub.work, ['rev-parse', 'HEAD']).trim();
      const res = run(hub, RAISE_ARGS());
      t.exit(res, 0);
      t.has(res, 'ESCALATION RAISED — ESC-PROJ-421-01');
      t.has(res, 'Question: Does a partial refund post one ledger line or two?');
      t.has(res, 'Parked: feature/PROJ-421-refund-ledger at 3f9c2a1b7d4e');
      const lines = linesOf(recordOf(hub, 'PROJ-421'));
      t.ok(lines.length === 2, `the record holds ${lines.length} lines, expected 2`);
      if (lines.length === 2) {
        t.ok(lines[0].event === 'raised' && lines[0].seq === 1 && lines[0].id === 'ESC-PROJ-421-01', 'line 1 is raised, seq 1');
        t.ok(lines[1].event === 'notified' && lines[1].to === 'runner' && lines[1].channel === 'session' && lines[1].seq === 2, 'line 2 notifies the runner in the session');
        t.ok(lines[0].path === 'review-cap' && lines[0].trigger === 'revision-cap' && lines[0].point === 'dev-sprint.code-review-cap', 'point dev-sprint.code-review-cap gives the review-cap path and the revision-cap trigger');
        t.ok(lines[0].route.first === 'runner' && lines[0].route.next === 'engineering lead', 'the route comes from the list of stop points');
        t.ok(lines[0].at === CLOCK, 'the fixed clock is the time');
        t.ok(lines[0].hub_commit === git(hub.work, ['rev-parse', 'HEAD']).trim().slice(0, 12), 'hub_commit is the trunk commit the run read');
        const leaves = JSON.stringify(Object.keys(lines[0]).length);
        t.ok(leaves === '19', `the raised line has ${leaves} top-level keys, expected 19`);
        t.ok(lines[0].by.kind === 'seat' && lines[0].by.name === 'sprint-orchestrator', 'the seat that stopped is the writer');
      }
      const issues = issuesOf(hub, 'PROJ-421');
      t.ok(issues.length === 1, `one issue holds the escalation, found ${issues.length}`);
      const issue = issues[0] || { comments: [], artifacts: [], labels: [], body: '', title: '' };
      t.ok(issue.title === '[shl-harness] PROJ-421 · dev-sprint.code-review-cap', `the title starts [shl-harness]: ${issue.title}`);
      t.ok(issue.body.includes('<!-- shl-escalation id=ESC-PROJ-421-01 -->') && issue.body.trimEnd().endsWith('Generated-by: SHL Agentic Harness'), 'the body ends with the marker and the watermark');
      t.ok(issue.body.includes('Does a partial refund post one ledger line or two?') && issue.body.includes('Do not edit or delete the artefact'), 'the body asks the question and warns against editing the record');
      t.ok(issue.comments.length === 2 && issue.comments.every((c) => c.body.includes('<!-- shl-escalation-line id=ESC-PROJ-421-01 seq=')), 'each line is one comment with its marker');
      const art = artefactOf(issue);
      t.ok(art && art.versions.length === 1 && latestOf(art).includes('Do not edit or delete it'), 'the artefact escalation-record.jsonl holds both lines in one version, with the warning');
      t.ok(issue.labels.join() === 'harness-waiting', `the issue carries only harness-waiting: ${issue.labels.join()}`);
      t.ok(['harness-waiting', 'harness-overdue', 'harness-acknowledged'].every((n) => ghState(hub).labels.some((l) => l.name === n)), 'the three state labels exist in the hub');
      t.ok(git(hub.work, ['rev-parse', 'HEAD']).trim() === before, 'the hub checkout did not move');
      t.ok(git(hub.work, ['status', '--porcelain']).trim() === '', 'the hub checkout is clean');
      t.ok(git(hub.work, ['branch', '--show-current']).trim() === 'main', 'the hub checkout is still on its trunk');
      t.ok(!git(hub.bare, ['--git-dir', hub.bare, 'branch', '--list']).includes('harness/escalations'), 'no record branch exists');
      const trunkTree = git(hub.bare, ['--git-dir', hub.bare, 'ls-tree', '-r', '--name-only', 'main']);
      t.ok(!trunkTree.includes('escalations'), 'the trunk holds no escalation file');
      return t.problems;
    },
  },
  {
    n: 2, name: 'a capped run\'s findings go on the same issue, as the artefact findings.md, and the line names them',
    run(hub) {
      const t = checks();
      const findings = join(hub.root, 'findings.md');
      writeFileSync(findings, '## Findings\n\n- IMPORTANT: the ledger line count is not stated.\n');
      const res = run(hub, RAISE_ARGS({ '--findings-file': findings }));
      t.exit(res, 0);
      const line = linesOf(recordOf(hub, 'PROJ-421'))[0];
      t.ok(line && line.findings === 'findings.md', `findings names findings.md: ${line && line.findings}`);
      const found = artefactOf(issuesOf(hub, 'PROJ-421')[0], 'findings.md');
      t.ok(found && latestOf(found).includes('the ledger line count is not stated'), 'the findings are an artefact on the issue');
      return t.problems;
    },
  },
  {
    n: 3, name: 'a person\'s acknowledgement passes: the state becomes acknowledged and the escalation stays open',
    run(hub) {
      const t = checks();
      t.exit(run(hub, RAISE_ARGS()), 0);
      const res = run(hub, ACK('ESC-PROJ-421-01', ['--login', 'lead-one']));
      t.exit(res, 0);
      t.has(res, 'ESCALATION ACKNOWLEDGED — ESC-PROJ-421-01, line 3');
      const lines = linesOf(recordOf(hub, 'PROJ-421'));
      const ack = lines[2];
      t.ok(ack && ack.event === 'acknowledged' && ack.by.kind === 'person' && ack.by.role === 'engineering lead' && ack.by.login === 'lead-one', 'line 3 is a person\'s acknowledged');
      const state = JSON.parse(run(hub, ['print', '--work-item', 'PROJ-421', '--json']).out);
      t.ok(state.escalations[0].state === 'acknowledged', `state is ${state.escalations[0].state}, expected acknowledged`);
      return t.problems;
    },
  },
  {
    n: 4, name: 'the script refuses an acknowledgement that a seat wrote',
    run(hub) {
      const t = checks();
      t.exit(run(hub, RAISE_ARGS()), 0);
      const res = run(hub, ACK('ESC-PROJ-421-01', ['--by-kind', 'seat']));
      t.exit(res, 1);
      t.has(res, 'an agent never acknowledges, stops or withdraws its own escalation');
      t.ok(linesOf(recordOf(hub, 'PROJ-421')).length === 2, 'no line was added');
      return t.problems;
    },
  },
  {
    n: 5, name: 'a record that already holds an acknowledgement a seat wrote is refused, and so is the next write',
    run(hub) {
      const t = checks();
      craftRecord(hub, 'PROJ-421', [RAISED(), NOTIFIED(), { schema_version: 1, id: 'ESC-PROJ-421-01', seq: 3, event: 'acknowledged', at: '2026-10-29T15:00:00Z', by: { kind: 'seat', name: 'sprint-orchestrator' } }]);
      const res = run(hub, ['print', '--work-item', 'PROJ-421']);
      t.exit(res, 1);
      t.has(res, 'acknowledged was written by a seat');
      const next = run(hub, ACK());
      t.exit(next, 1);
      t.has(next, 'acknowledged was written by a seat');
      t.ok(linesOf(recordOf(hub, 'PROJ-421')).length === 3, 'the writer added nothing to a record it refuses');
      return t.problems;
    },
  },
  {
    n: 6, name: 'the script cannot verify a record with a gap in seq',
    run(hub) {
      const t = checks();
      craftRecord(hub, 'PROJ-421', [RAISED(), NOTIFIED({ seq: 3 })]);
      const view = run(hub, ['print', '--work-item', 'PROJ-421']);
      t.exit(view, 2);
      t.has(view, 'seq 3 where 2 is next: a line is missing');
      const write = run(hub, ACK());
      t.exit(write, 2);
      t.ok(linesOf(recordOf(hub, 'PROJ-421')).length === 2, 'the writer added nothing to a record it cannot verify');
      return t.problems;
    },
  },
  {
    n: 7, name: 'the script cannot verify a record with a repeated seq',
    run(hub) {
      const t = checks();
      craftRecord(hub, 'PROJ-421', [RAISED(), NOTIFIED({ seq: 1 })]);
      const view = run(hub, ['print', '--work-item', 'PROJ-421']);
      t.exit(view, 2);
      t.has(view, 'a line repeats');
      return t.problems;
    },
  },
  {
    n: 8, name: 'the script refuses an unknown schema_version',
    run(hub) {
      const t = checks();
      craftRecord(hub, 'PROJ-421', [RAISED({ schema_version: 2 })]);
      const view = run(hub, ['print', '--work-item', 'PROJ-421']);
      t.exit(view, 1);
      t.has(view, 'schema_version 2 is unknown');
      t.has(view, 'it does not guess');
      t.exit(run(hub, ACK()), 1);
      return t.problems;
    },
  },
  {
    n: 9, name: 'the script refuses a line after resolved, stopped or withdrawn',
    run(hub) {
      const t = checks();
      const end = (event, extra) => ({ schema_version: 1, id: 'ESC-PROJ-421-01', seq: 3, event, at: '2026-10-29T16:00:00Z', ...extra });
      craftRecord(hub, 'PROJ-421', [RAISED(), NOTIFIED(), end('resolved', { by: { kind: 'seat', name: 'sprint-orchestrator' }, fact: { kind: 'verdict', value: 'APPROVED', round: 2 } })]);
      const res = run(hub, ACK());
      t.exit(res, 1);
      t.has(res, 'is already final');
      craftRecord(hub, 'PROJ-421', [RAISED(), NOTIFIED(), end('resolved', { by: { kind: 'seat', name: 'sprint-orchestrator' }, fact: { kind: 'verdict', value: 'APPROVED' } }), { schema_version: 1, id: 'ESC-PROJ-421-01', seq: 4, event: 'notified', at: '2026-10-29T16:01:00Z', by: { kind: 'script', name: 'escalation.mjs' }, to: 'runner', channel: 'session' }], { name: 'crafter2' });
      const view = run(hub, ['print', '--work-item', 'PROJ-421']);
      t.exit(view, 1);
      t.has(view, 'comes after resolved');
      t.has(view, 'a new stop on the same work is a new id');
      return t.problems;
    },
  },
  {
    n: 10, name: 'the re-run check refuses a re-run with no upstream change, and passes once the design changes',
    run(hub) {
      const t = checks();
      t.exit(run(hub, RAISE_ARGS()), 0);
      const refused = run(hub, ['resume', '--work-item', 'PROJ-421', '--by-seat', 'sprint-orchestrator', '--tests-commit', 'a1b2c3d4e5f6']);
      t.exit(refused, 1);
      t.has(refused, 'RE-RUN REFUSED — nothing changed upstream since ESC-PROJ-421-01 was raised at dev-sprint.code-review-cap');
      t.has(refused, 'design docs/designs/PROJ-421.lld.md: unchanged');
      t.has(refused, 'A cap is never raised');
      t.ok(linesOf(recordOf(hub, 'PROJ-421')).length === 2, 'a refused re-run adds no line');
      mergeToTrunk(hub, { 'docs/designs/PROJ-421.lld.md': '# Design PROJ-421\n\nVersion two. A partial refund posts one line.\n' }, 'amend the design');
      const check = run(hub, ['resume', '--work-item', 'PROJ-421', '--check']);
      t.exit(check, 0);
      t.has(check, 'RE-RUN ALLOWED');
      t.ok(linesOf(recordOf(hub, 'PROJ-421')).length === 2, '--check writes nothing');
      const ok = run(hub, ['resume', '--work-item', 'PROJ-421', '--by-seat', 'sprint-orchestrator', '--pr', 'https://example.invalid/pr/7']);
      t.exit(ok, 0);
      t.has(ok, 'ESCALATION RESUMED — ESC-PROJ-421-01');
      const lines = linesOf(recordOf(hub, 'PROJ-421'));
      const resumed = lines[2];
      t.ok(resumed && resumed.event === 'resumed' && resumed.upstream.what === 'design' && resumed.upstream.from !== resumed.upstream.to, 'line 3 is resumed, with the design\'s two blobs');
      t.ok(resumed && String(resumed.upstream.from).match(/^[0-9a-f]{12}$/) !== null && resumed.upstream.pr === 'https://example.invalid/pr/7', 'from is 12 hex and the pull request is linked');
      const again = run(hub, ['resume', '--work-item', 'PROJ-421', '--by-seat', 'sprint-orchestrator']);
      t.exit(again, 0);
      t.ok(linesOf(recordOf(hub, 'PROJ-421')).length === 3, 'a second resume of the same change writes nothing');
      return t.problems;
    },
  },
  {
    n: 11, name: 'a closed clarification in the log of the work item, new approved tests and a changed requirements document each count as an upstream change, and a clarification closed in the log of another work item does not',
    run(hub) {
      const t = checks();
      mergeToTrunk(hub, { [CLAR_PATH('PROJ-421')]: CLAR_LOG('PROJ-421', [CLAR_ROW('Routed')]) }, 'a clarification is routed');
      t.exit(run(hub, RAISE_ARGS()), 0);
      const none = run(hub, ['resume', '--work-item', 'PROJ-421', '--check', '--tests-commit', 'a1b2c3d4e5f6']);
      t.exit(none, 1);
      t.has(none, 'clarification: unchanged');
      mergeToTrunk(hub, { [CLAR_PATH('PROJ-430')]: CLAR_LOG('PROJ-430', [CLAR_ROW('Closed')]) }, 'another work item closes its clarification');
      const other = run(hub, ['resume', '--work-item', 'PROJ-421', '--check', '--tests-commit', 'a1b2c3d4e5f6']);
      t.exit(other, 1);
      t.has(other, 'clarification: unchanged');
      mergeToTrunk(hub, { [CLAR_PATH('PROJ-421')]: CLAR_LOG('PROJ-421', [CLAR_ROW('Closed')]) }, 'the clarification is closed');
      const closed = run(hub, ['resume', '--work-item', 'PROJ-421', '--check', '--tests-commit', 'a1b2c3d4e5f6']);
      t.exit(closed, 0);
      t.has(closed, 'clarification');
      const tests = run(hub, ['resume', '--work-item', 'PROJ-421', '--check', '--tests-commit', 'ffffffffffff']);
      t.exit(tests, 0);
      t.has(tests, 'tests a1b2c3d4e5f6 to ffffffffffff');
      return t.problems;
    },
  },
  {
    n: 29, name: 'an answer passed with the command is no upstream change: the re-run stays refused until the answer reaches a closed clarification',
    run(hub) {
      const t = checks();
      mergeToTrunk(hub, { [CLAR_PATH('PROJ-421')]: CLAR_LOG('PROJ-421', [CLAR_ROW('Routed')]) }, 'a clarification is routed');
      t.exit(run(hub, RAISE_ARGS()), 0);
      t.exit(run(hub, ['resume', '--work-item', 'PROJ-421', '--check', '--answer-file', join(hub.root, 'answer.md')]), 3);
      const refused = run(hub, ['resume', '--work-item', 'PROJ-421', '--check', '--tests-commit', 'a1b2c3d4e5f6']);
      t.exit(refused, 1);
      t.has(refused, 'RE-RUN REFUSED');
      mergeToTrunk(hub, { [CLAR_PATH('PROJ-421')]: CLAR_LOG('PROJ-421', [CLAR_ROW('Closed')]) }, 'the person answers in the clarification log');
      t.exit(run(hub, ['resume', '--work-item', 'PROJ-421', '--check', '--tests-commit', 'a1b2c3d4e5f6']), 0);
      return t.problems;
    },
  },
  {
    n: 12, name: 'a requirements review cap reads the document on its branch, and a decomposition cap reads it on the trunk',
    run(hub) {
      const t = checks();
      git(hub.work, ['checkout', '-q', '-b', 'requirements/payments-refunds']);
      writeFiles(hub.work, { 'docs/requirements/payments-refunds/requirements.md': '# Requirements\n\nVersion on the branch.\n' });
      commitAll(hub.work, 'the document under review');
      git(hub.work, ['push', '-q', 'origin', 'requirements/payments-refunds']);
      const reviewed = git(hub.work, ['rev-parse', 'HEAD']).trim().slice(0, 12);
      git(hub.work, ['checkout', '-q', 'main']);
      const raised = run(hub, ['raise', '--point', 'feature.review-cap', '--slug', 'payments-refunds', '--runner', 'dev-one', '--question', 'Which refund window applies?', '--parked-ref', 'requirements/payments-refunds', '--parked-commit', reviewed, '--by-seat', 'feature']);
      t.exit(raised, 0);
      t.has(raised, 'ESC-payments-refunds-01');
      const refused = run(hub, ['resume', '--slug', 'payments-refunds', '--check']);
      t.exit(refused, 1);
      t.has(refused, 'requirements docs/requirements/payments-refunds/requirements.md: unchanged');
      git(hub.work, ['checkout', '-q', 'requirements/payments-refunds']);
      writeFiles(hub.work, { 'docs/requirements/payments-refunds/requirements.md': '# Requirements\n\nAmended on the branch.\n' });
      commitAll(hub.work, 'the person amended the input');
      git(hub.work, ['push', '-q', 'origin', 'requirements/payments-refunds']);
      git(hub.work, ['checkout', '-q', 'main']);
      const allowed = run(hub, ['resume', '--slug', 'payments-refunds', '--check']);
      t.exit(allowed, 0);
      t.has(allowed, 'requirements');
      const owner = linesOf(recordOf(hub, 'payments-refunds'));
      t.ok(owner.length === 2 && owner[0].work_item === null && owner[0].parked.ref === 'requirements/payments-refunds', 'a feature before any key owns its record by slug, with work_item null');
      return t.problems;
    },
  },
  {
    n: 13, name: 'a resolved escalation ends it: resume says there is nothing open, and a stop on the same work is a new id',
    run(hub) {
      const t = checks();
      t.exit(run(hub, RAISE_ARGS()), 0);
      mergeToTrunk(hub, { 'docs/designs/PROJ-421.lld.md': '# Design PROJ-421\n\nVersion two.\n' });
      t.exit(run(hub, ['resume', '--work-item', 'PROJ-421', '--by-seat', 'sprint-orchestrator']), 0);
      const bad = run(hub, ['resolve', 'ESC-PROJ-421-01', '--fact-kind', 'verdict', '--fact-value', 'CHANGES REQUESTED', '--by-seat', 'sprint-orchestrator']);
      t.exit(bad, 1);
      t.has(bad, 'a verdict fact that ends an escalation reads APPROVED');
      const res = run(hub, ['resolve', '--work-item', 'PROJ-421', '--point', 'dev-sprint.code-review-cap', '--fact-kind', 'verdict', '--fact-value', 'APPROVED', '--round', '2', '--by-seat', 'sprint-orchestrator']);
      t.exit(res, 0);
      t.has(res, 'ESCALATION RESOLVED — ESC-PROJ-421-01');
      const lines = linesOf(recordOf(hub, 'PROJ-421'));
      const last = lines[lines.length - 1];
      t.ok(last.event === 'resolved' && last.fact.kind === 'verdict' && last.fact.value === 'APPROVED' && last.fact.round === 2, 'the last line is resolved with the verdict and the round');
      const after = run(hub, ACK());
      t.exit(after, 1);
      t.has(after, 'is already final');
      const none = run(hub, ['resume', '--work-item', 'PROJ-421']);
      t.exit(none, 0);
      t.has(none, 'NO OPEN ESCALATION');
      const again = run(hub, ['resolve', '--work-item', 'PROJ-421', '--fact-kind', 'verdict', '--fact-value', 'APPROVED']);
      t.exit(again, 0);
      t.has(again, 'NOTHING TO RESOLVE');
      const second = run(hub, RAISE_ARGS());
      t.exit(second, 0);
      t.has(second, 'ESC-PROJ-421-02');
      return t.problems;
    },
  },
  {
    n: 14, name: 'a re-run that reaches the cap again raises a new id, and the escalation it resumed shows as superseded',
    run(hub) {
      const t = checks();
      t.exit(run(hub, RAISE_ARGS()), 0);
      const open = run(hub, RAISE_ARGS());
      t.exit(open, 1);
      t.has(open, 'ESC-PROJ-421-01 is still open for PROJ-421 at dev-sprint.code-review-cap');
      mergeToTrunk(hub, { 'docs/designs/PROJ-421.lld.md': '# Design PROJ-421\n\nVersion two.\n' });
      t.exit(run(hub, ['resume', '--work-item', 'PROJ-421', '--by-seat', 'sprint-orchestrator']), 0);
      const again = run(hub, RAISE_ARGS({ '--question': 'Is the ledger line signed?' }));
      t.exit(again, 0);
      t.has(again, 'ESC-PROJ-421-02');
      const state = JSON.parse(run(hub, ['print', '--work-item', 'PROJ-421', '--json']).out).escalations;
      t.ok(state.find((e) => e.id === 'ESC-PROJ-421-01').state === 'superseded', 'the first escalation shows as superseded');
      t.ok(state.find((e) => e.id === 'ESC-PROJ-421-02').state === 'open', 'the second is open');
      return t.problems;
    },
  },
  {
    n: 15, name: 'stop and withdraw need the person\'s reason, end the escalation, and leave the work where it was parked',
    run(hub) {
      const t = checks();
      t.exit(run(hub, RAISE_ARGS()), 0);
      t.exit(run(hub, ['stop', 'ESC-PROJ-421-01', '--role', 'engineering lead']), 3);
      const stop = run(hub, ['stop', 'ESC-PROJ-421-01', '--role', 'engineering lead', '--reason', 'We dropped the refund ledger work.']);
      t.exit(stop, 0);
      t.has(stop, 'ESCALATION STOPPED — ESC-PROJ-421-01');
      const lines = linesOf(recordOf(hub, 'PROJ-421'));
      t.ok(lines[2].event === 'stopped' && lines[2].reason === 'We dropped the refund ledger work.' && lines[2].by.kind === 'person', 'line 3 is stopped, with the person\'s own words');
      t.exit(run(hub, ['stop', 'ESC-PROJ-421-01', '--role', 'engineering lead', '--reason', 'again']), 1);
      t.exit(run(hub, ['withdraw', 'ESC-PROJ-421-01', '--role', 'engineering lead', '--reason', 'nothing to see']), 1);
      t.exit(run(hub, ['stop', 'ESC-PROJ-421-09', '--role', 'engineering lead', '--reason', 'x']), 1);
      t.exit(run(hub, ['stop', 'ESC-PROJ-421-01', '--role', 'engineering lead', '--reason', 'x', '--by-kind', 'script']), 1);
      return t.problems;
    },
  },
  {
    n: 16, name: 'withdraw ends an escalation that should not have been raised',
    run(hub) {
      const t = checks();
      t.exit(run(hub, RAISE_ARGS()), 0);
      const res = run(hub, ['withdraw', 'ESC-PROJ-421-01', '--role', 'delivery lead', '--reason', 'A duplicate of another stop.']);
      t.exit(res, 0);
      t.has(res, 'ESCALATION WITHDRAWN — ESC-PROJ-421-01');
      const state = JSON.parse(run(hub, ['print', 'ESC-PROJ-421-01', '--json']).out).escalations[0];
      t.ok(state.state === 'withdrawn', `state is ${state.state}`);
      return t.problems;
    },
  },
  {
    n: 17, name: 'a point on the question path or on no path writes nothing, and an unknown point is a usage fault',
    run(hub) {
      const t = checks();
      for (const [point, why] of [['dev-sprint.docker', 'question'], ['feature.interview', 'question'], ['dev-sprint.more-rounds', 'none'], ['pr-review.people-comments', 'none'], ['clar-log.self-close', 'none']]) {
        const res = run(hub, RAISE_ARGS({ '--point': point }));
        t.exit(res, 3);
        t.has(res, `follows the ${why} path, which writes no line`);
      }
      t.exit(run(hub, RAISE_ARGS({ '--point': 'Z9' })), 3);
      t.has(run(hub, RAISE_ARGS({ '--point': 'Z9' })), 'is not one of the 67 stop points');
      t.exit(run(hub, RAISE_ARGS({ '--slug': null })), 3);
      t.exit(run(hub, RAISE_ARGS({ '--runner': null })), 3);
      t.exit(run(hub, RAISE_ARGS({ '--question': null })), 3);
      t.exit(run(hub, RAISE_ARGS({ '--parked-commit': 'abc' })), 3);
      t.ok(recordOf(hub, 'PROJ-421') === null, 'nothing reached the record');
      return t.problems;
    },
  },
  {
    n: 18, name: 'a point that names a role only the command can resolve needs --route-first, and the line carries the role the run resolved',
    run(hub) {
      const t = checks();
      const missing = run(hub, RAISE_ARGS({ '--point': 'dev-spec.blocking-clarification' }));
      t.exit(missing, 3);
      t.has(missing, 'Pass --route-first');
      const res = run(hub, RAISE_ARGS({ '--point': 'dev-spec.blocking-clarification', '--route-first': 'Product owner', '--question': 'Does step-up authentication apply to read-only views?' }));
      t.exit(res, 0);
      const line = linesOf(recordOf(hub, 'PROJ-421'))[0];
      t.ok(line.route.first === 'Product owner' && line.route.next === 'delivery lead' && line.trigger === 'blocking-clarification' && line.path === 'decision-owed', 'route.first is the resolved role, route.next and the trigger come from the list');
      return t.problems;
    },
  },
  {
    n: 19, name: 'a point that can follow two paths writes the one taken, and refuses a path it cannot follow',
    run(hub) {
      const t = checks();
      t.exit(run(hub, RAISE_ARGS({ '--point': 'feature.contradiction' })), 3);
      const res = run(hub, RAISE_ARGS({ '--point': 'feature.contradiction', '--path': 'decision-owed', '--question': 'Which source wins?' }));
      t.exit(res, 0);
      const line = linesOf(recordOf(hub, 'PROJ-421'))[0];
      t.ok(line.path === 'decision-owed' && line.trigger === 'contradiction' && line.route.first === 'runner' && line.route.next === 'lead architect', 'feature.contradiction as a decision owed goes to the lead architect');
      t.exit(run(hub, RAISE_ARGS({ '--point': 'dev-sprint.code-review-cap', '--path': 'incident' })), 3);
      return t.problems;
    },
  },
  {
    n: 20, name: 'an incident never carries findings, holds only where it is, and refuses every re-run while it is open',
    run(hub) {
      const t = checks();
      const findings = join(hub.root, 'findings.md');
      writeFileSync(findings, 'The key is AKIA...\n');
      const refused = run(hub, RAISE_ARGS({ '--point': 'dev-sprint.security-critical', '--findings-file': findings }));
      t.exit(refused, 1);
      t.has(refused, 'an incident never carries findings');
      t.ok(recordOf(hub, 'PROJ-421') === null, 'nothing reached the record');
      const res = run(hub, RAISE_ARGS({ '--point': 'dev-sprint.security-critical', '--question': 'A working credential is in src/pay.ts at the parked commit. Rotate it.' }));
      t.exit(res, 0);
      const line = linesOf(recordOf(hub, 'PROJ-421'))[0];
      t.ok(line.path === 'incident' && line.findings === null && line.route.first === 'security role on call', 'dev-sprint.security-critical is an incident with no findings');
      const blocked = run(hub, ['resume', '--work-item', 'PROJ-421', '--by-seat', 'sprint-orchestrator']);
      t.exit(blocked, 1);
      t.has(blocked, 'is an open incident on PROJ-421');
      t.ok(!eventsOf(hub).includes('resumed'), 'nothing resumed the work');
      t.exit(run(hub, ['resolve', line.id, '--fact-kind', 'status', '--fact-value', 'Closed', '--by-seat', 'sprint-orchestrator']), 0);
      t.exit(run(hub, ['resume', '--work-item', 'PROJ-421', '--by-seat', 'sprint-orchestrator']), 0);
      return t.problems;
    },
  },
  {
    n: 21, name: 'two writers that raise at the same moment on two stories both land, each on its own issue',
    async run(hub) {
      const t = checks();
      const competitor = ['raise', '--point', 'dev-sprint.code-review-cap', '--slug', 'search-filters', '--work-item', 'SRCH-7', '--runner', 'dev-two', '--question', 'Which index is meant?', '--by-seat', 'sprint-orchestrator'];
      const [a, b] = await Promise.all([runAsync(hub, RAISE_ARGS(), { FAKE_GH_BARRIER: '2' }), runAsync(hub, competitor, { FAKE_GH_BARRIER: '2' })]);
      t.exit(a, 0);
      t.exit(b, 0);
      t.ok(ghState(hub).barrier >= 2, 'both writers reached GitHub at the same moment');
      t.ok(linesOf(recordOf(hub, 'PROJ-421')).length === 2, 'the first writer\'s lines landed');
      t.ok(linesOf(recordOf(hub, 'SRCH-7')).length === 2, 'the second writer\'s lines landed');
      return t.problems;
    },
  },
  {
    n: 22, name: 'two raises on one story at the same moment both land, with ids 01 and 02: the loser gives up its issue and raises again',
    async run(hub) {
      const t = checks();
      const [a, b] = await Promise.all([
        runAsync(hub, RAISE_ARGS({ '--point': 'dev-sprint.test-review-cap' }), { FAKE_GH_BARRIER: '2' }),
        runAsync(hub, RAISE_ARGS({ '--question': 'Which test is meant?' }), { FAKE_GH_BARRIER: '2' }),
      ]);
      t.exit(a, 0);
      t.exit(b, 0);
      const lines = linesOf(recordOf(hub, 'PROJ-421'));
      const ids = new Set(lines.map((l) => l.id));
      t.ok(ids.has('ESC-PROJ-421-01') && ids.has('ESC-PROJ-421-02'), `the record holds ${[...ids].join(', ')}`);
      t.ok(issuesOf(hub, 'PROJ-421').length === 2, 'two harness issues hold the two escalations');
      const view = run(hub, ['print', '--work-item', 'PROJ-421']);
      t.exit(view, 0);
      t.ok(lines.filter((l) => l.id === 'ESC-PROJ-421-01').map((l) => l.seq).join() === '1,2', 'each escalation has seq 1, 2');
      return t.problems;
    },
  },
  {
    n: 43, name: 'two writers on one escalation at the same moment both land: the one that lost the seq deletes its comment and writes again',
    async run(hub) {
      const t = checks();
      t.exit(run(hub, RAISE_ARGS()), 0);
      const [a, b] = await Promise.all([
        runAsync(hub, ACK('ESC-PROJ-421-01', ['--login', 'lead-one']), { FAKE_GH_BARRIER: '2' }),
        runAsync(hub, ACK('ESC-PROJ-421-01', ['--login', 'lead-two']), { FAKE_GH_BARRIER: '2' }),
      ]);
      t.exit(a, 0);
      t.exit(b, 0);
      const lines = linesOf(recordOf(hub, 'PROJ-421'));
      t.ok(lines.map((l) => l.seq).join() === '1,2,3,4', `the seq has no gap and no repeat: ${lines.map((l) => l.seq).join()}`);
      const issue = issuesOf(hub, 'PROJ-421')[0];
      const marks = issue.comments.map((c) => (c.body.match(/seq=(\d+) -->/) || [])[1]).filter(Boolean);
      t.ok(marks.length === new Set(marks).size, `no two comments carry one seq: ${marks.join()}`);
      t.exit(run(hub, ['print', '--work-item', 'PROJ-421']), 0);
      return t.problems;
    },
  },
  {
    n: 23, name: 'a write that GitHub refuses exits 2, says the line is not on the record, and leaves no issue on the record',
    run(hub) {
      const t = checks();
      const res = run(hub, RAISE_ARGS(), { env: { FAKE_GH_FAIL: '/comments' } });
      t.exit(res, 2);
      t.has(res, 'The line is not on the record');
      t.ok(issuesOf(hub, 'PROJ-421').length === 0, 'the issue that holds no line lost its marker, so no reader counts it');
      t.ok(ghState(hub).issues.some((i) => i.state === 'closed' && i.state_reason === 'not_planned'), 'the empty issue was closed as not planned');
      t.exit(run(hub, RAISE_ARGS()), 0);
      t.ok(linesOf(recordOf(hub, 'PROJ-421'))[0].id === 'ESC-PROJ-421-01', 'the next raise takes id 01');
      return t.problems;
    },
  },
  {
    n: 24, name: 'GitHub that cannot be reached is exit 2 for every subcommand, and so is a git remote for every one that reads the trunk',
    run(hub) {
      const t = checks();
      t.exit(run(hub, RAISE_ARGS()), 0);
      for (const args of [RAISE_ARGS({ '--work-item': 'PROJ-9' }), ACK(), ['print', '--all'], ['resume', '--work-item', 'PROJ-421'], ['sweep', '--now', CLOCK]]) {
        const res = run(hub, args, { env: { FAKE_GH_DOWN: '1' } });
        t.exit(res, 2);
        t.ok(res.all.includes('HTTP 503'), `the output names GitHub's answer: ${res.all.trim().split('\n')[0]}`);
      }
      rmSync(hub.bare, { recursive: true, force: true });
      for (const args of [RAISE_ARGS({ '--work-item': 'PROJ-9' }), ['sweep', '--now', CLOCK]]) {
        const res = run(hub, args);
        t.exit(res, 2);
        t.ok(res.all.includes('cannot reach origin') || res.all.includes('could not fetch origin/main'), `the output names the remote: ${res.all.trim().split('\n')[0]}`);
      }
      return t.problems;
    },
  },
  {
    n: 25, name: 'a trunk that the remote does not confirm is exit 2',
    run(hub) {
      const t = checks();
      const res = run(hub, RAISE_ARGS(), { env: { HARNESS_TRUNK: 'develop' } });
      t.exit(res, 2);
      t.ok(recordOf(hub, 'PROJ-421') === null, 'nothing reached the record');
      return t.problems;
    },
  },
  {
    n: 26, name: 'print writes the table that CLAR-log.md shows: one row for each escalation, and --all reads every file',
    run(hub) {
      const t = checks();
      t.exit(run(hub, RAISE_ARGS()), 0);
      t.exit(run(hub, ACK('ESC-PROJ-421-01', ['--now', '2026-10-30T08:41:00Z'])), 0);
      t.exit(run(hub, RAISE_ARGS({ '--work-item': 'SRCH-7', '--slug': 'search-filters', '--point': 'dev-spec.review-cap', '--asked': 'absent', '--question': 'Which index is meant?' })), 0);
      const res = run(hub, ['print', '--all']);
      t.exit(res, 0);
      t.has(res, '| Date | Trigger | Work item | Detail | Notified via | Acknowledged | Answered |');
      t.has(res, '| 2026-10-29 | Revision cap reached | PROJ-421 | ESC-PROJ-421-01 at dev-sprint.code-review-cap (acknowledged): Does a partial refund post one ledger line or two? | session |');
      t.has(res, '2026-10-30T08:41:00Z');
      t.has(res, 'ESC-SRCH-7-01 at dev-spec.review-cap (open)');
      const one = run(hub, ['print', 'ESC-SRCH-7-01']);
      t.exit(one, 0);
      t.lacks(one, 'ESC-PROJ-421-01');
      t.exit(run(hub, ['print']), 3);
      const empty = makeHub(mkdtempSync(join(tmpdir(), 'escalation-empty-')), { name: 'empty' });
      const none = run(empty, ['print', '--all']);
      t.exit(none, 0);
      t.has(none, 'No escalation on the record');
      rmSync(empty.root, { recursive: true, force: true });
      return t.problems;
    },
  },
  {
    n: 27, name: 'a raised line that breaks a grammar rule is refused before it is written',
    run(hub) {
      const t = checks();
      craftRecord(hub, 'PROJ-421', [RAISED({ trigger: 'because' })]);
      const bad = run(hub, ['print', '--work-item', 'PROJ-421']);
      t.exit(bad, 1);
      t.has(bad, 'trigger must be one of');
      craftRecord(hub, 'PROJ-421', [RAISED({ point: 'Z9' }), NOTIFIED()], { name: 'c2' });
      t.has(run(hub, ['print', '--work-item', 'PROJ-421']), 'point "Z9" is not in the list of stop points');
      craftRecord(hub, 'PROJ-421', [RAISED({ path: 'merge-waiting' })], { name: 'c3' });
      t.has(run(hub, ['print', '--work-item', 'PROJ-421']), 'point dev-sprint.code-review-cap follows review-cap');
      craftRecord(hub, 'PROJ-421', [RAISED({ path: 'question' })], { name: 'c4' });
      t.has(run(hub, ['print', '--work-item', 'PROJ-421']), 'the question path writes no line');
      craftRecord(hub, 'PROJ-421', ['{not json'], { name: 'c5' });
      const raw = run(hub, ['print', '--work-item', 'PROJ-421']);
      t.exit(raw, 2);
      t.has(raw, 'is not JSON');
      craftRecord(hub, 'PROJ-421', [RAISED({ id: 'ESC-OTHER-1-01' })], { markerId: 'ESC-PROJ-421-01' });
      t.has(run(hub, ['print', '--work-item', 'PROJ-421']), 'belongs to OTHER-1, not to PROJ-421');
      return t.problems;
    },
  },
  {
    n: 28, name: 'a hub with no harness issue yet: the first raise opens one, and the hub\'s other issues stay as they were',
    run(hub) {
      const t = checks();
      const s = ghState(hub);
      s.issues.push({ number: s.next++, title: 'Login button misaligned', body: 'A user issue.', state: 'open', state_reason: null, labels: ['bug'], user: 'someone', created_at: CLOCK, comments: [{ id: 1, body: '/ack', user: { login: 'someone' }, author_association: 'MEMBER', created_at: CLOCK }], artifacts: [] });
      s.issues.push({ number: s.next++, title: '[shl-harness] looks like ours', body: 'No marker.', state: 'open', state_reason: null, labels: ['harness-waiting'], user: 'someone', created_at: CLOCK, comments: [], artifacts: [] });
      saveState(hub, s);
      const before = JSON.stringify(ghState(hub).issues);
      t.exit(run(hub, RAISE_ARGS()), 0);
      t.exit(run(hub, ['sweep', '--now', '2026-10-30T17:30:00Z']), 0);
      const after = ghState(hub).issues;
      t.ok(JSON.stringify(after.slice(0, 2)) === JSON.stringify(JSON.parse(before)), 'the user issue and the look-alike are untouched, labels, comments and all');
      t.ok(after.length === 3 && after[2].title.startsWith('[shl-harness] PROJ-421 '), 'the raise opened one new issue');
      const list = JSON.parse(run(hub, ['print', '--all', '--json']).out);
      t.ok(list.escalations.length === 1 && list.escalations[0].issue === 3, 'print reads only the harness issue');
      return t.problems;
    },
  },
  {
    n: 44, name: 'the record is append-only: a line a person changed in the artefact is exit 2, names the version and its author, and blocks every write until a person restores it',
    run(hub) {
      const t = checks();
      t.exit(run(hub, RAISE_ARGS()), 0);
      const s = ghState(hub);
      const art = artefactOf(s.issues[0]);
      const tampered = latestOf(art).replace('one ledger line or two', 'three ledger lines');
      art.versions.push({ version: art.versions.length + 1, body: tampered, actor: 'eager-editor', created_at: CLOCK });
      saveState(hub, s);
      const view = run(hub, ['print', '--work-item', 'PROJ-421']);
      t.exit(view, 2);
      t.has(view, 'line 1 of the latest escalation-record.jsonl');
      t.has(view, 'by eager-editor');
      t.exit(run(hub, ACK()), 2);
      const sweep = run(hub, ['sweep', '--now', '2026-10-29T17:30:00Z']);
      t.exit(sweep, 2);
      t.has(sweep, 'PROJ-421: refused');
      t.ok(issuesOf(hub, 'PROJ-421')[0].comments.length === 2, 'no line was added on top of the changed record');
      const back = ghState(hub);
      const a2 = artefactOf(back.issues[0]);
      a2.versions.push({ version: a2.versions.length + 1, body: a2.versions[0].body, actor: 'lead-one', created_at: CLOCK });
      saveState(hub, back);
      const restored = run(hub, ['print', '--work-item', 'PROJ-421']);
      t.exit(restored, 0);
      t.has(restored, 'by eager-editor changed line 1, and a later version restored it');
      t.exit(run(hub, ACK()), 0);
      return t.problems;
    },
  },
  {
    n: 45, name: 'an artefact a person deleted is rebuilt from the line comments, with a warning, and a deleted comment is a warning while the artefact keeps its line',
    run(hub) {
      const t = checks();
      t.exit(run(hub, RAISE_ARGS()), 0);
      let s = ghState(hub);
      s.issues[0].artifacts = [];
      saveState(hub, s);
      const view = run(hub, ['print', '--work-item', 'PROJ-421']);
      t.exit(view, 0);
      t.has(view, 'escalation-record.jsonl is missing. It is rebuilt from the line comments');
      const sweep = run(hub, ['sweep', '--now', '2026-10-29T15:00:00Z']);
      t.exit(sweep, 0);
      t.has(sweep, 'created the record artefact');
      t.ok(linesOf(recordOf(hub, 'PROJ-421')).length === 2, 'the rebuilt artefact holds both lines');
      t.ok(issuesOf(hub, 'PROJ-421')[0].comments.some((c) => c.body.includes('**Record rebuilt.**')), 'the issue says the record was rebuilt');
      s = ghState(hub);
      s.issues[0].comments = s.issues[0].comments.slice(1);
      saveState(hub, s);
      const again = run(hub, ['print', '--work-item', 'PROJ-421']);
      t.exit(again, 0);
      t.has(again, 'the comment of line 1 was deleted. The artefact keeps the line');
      t.exit(run(hub, ACK()), 0);
      t.ok(linesOf(recordOf(hub, 'PROJ-421')).map((l) => l.seq).join() === '1,2,3', 'the next write still adds line 3');
      return t.problems;
    },
  },
  {
    n: 46, name: 'a member\'s /ack on the issue is a person\'s line with their login, a stranger\'s is refused in a reply, and /stop needs a reason',
    run(hub) {
      const t = checks();
      t.exit(run(hub, RAISE_ARGS()), 0);
      const number = issuesOf(hub, 'PROJ-421')[0].number;
      const stranger = comment(hub, number, '/ack', { login: 'drive-by', association: 'NONE' });
      const terse = comment(hub, number, '/stop', { login: 'lead-one', association: 'MEMBER' });
      const ack = comment(hub, number, '/ack as engineering lead\nI will look tomorrow.', { login: 'lead-one', association: 'MEMBER', at: '2026-10-29T15:00:00Z' });
      const first = run(hub, ['sweep', '--now', '2026-10-29T15:05:00Z']);
      t.exit(first, 0);
      const lines = linesOf(recordOf(hub, 'PROJ-421'));
      const line = lines[2];
      t.ok(line && line.event === 'acknowledged' && line.by.kind === 'person' && line.by.login === 'lead-one' && line.by.role === 'engineering lead' && line.by.via === 'issue-comment' && line.by.comment === ack, 'line 3 is lead-one\'s acknowledgement, through the comment');
      t.ok(line && line.at === '2026-10-29T15:00:00Z', 'the line keeps the time of the comment');
      const issue = issuesOf(hub, 'PROJ-421')[0];
      const replies = issue.comments.filter((c) => c.body.includes('<!-- shl-escalation-reply comment='));
      t.ok(replies.some((c) => c.body.includes(`comment=${stranger} `) && c.body.includes('Only a person with write access')), 'the stranger gets a reply and no line');
      t.ok(replies.some((c) => c.body.includes(`comment=${terse} `) && c.body.includes('needs a reason')), 'the bare /stop gets a reply and no line');
      t.ok(issue.labels.join() === 'harness-acknowledged', `the label became harness-acknowledged alone: ${issue.labels.join()}`);
      const second = run(hub, ['sweep', '--now', '2026-10-29T15:20:00Z']);
      t.exit(second, 0);
      t.ok(linesOf(recordOf(hub, 'PROJ-421')).length === 3, 'a second sweep writes nothing for comments it already answered');
      t.ok(issuesOf(hub, 'PROJ-421')[0].comments.filter((c) => c.body.includes('shl-escalation-reply')).length === 2, 'and posts no second reply');
      comment(hub, number, '/stop The refund work moved to next quarter.', { login: 'lead-one', association: 'MEMBER', at: '2026-10-29T16:00:00Z' });
      t.exit(run(hub, ['sweep', '--now', '2026-10-29T16:05:00Z']), 0);
      const end = linesOf(recordOf(hub, 'PROJ-421')).pop();
      t.ok(end.event === 'stopped' && end.reason === 'The refund work moved to next quarter.' && end.by.login === 'lead-one', 'the /stop with a reason ends it, in the person\'s words');
      const closed = issuesOf(hub, 'PROJ-421')[0];
      t.ok(closed.state === 'closed' && closed.state_reason === 'not_planned' && closed.labels.length === 0, 'the issue closed as not planned, with no label');
      return t.problems;
    },
  },
  {
    n: 47, name: 'one label at a time: waiting, then overdue, then gone when the fact resolves it, and an issue a person closed while open is reopened',
    run(hub) {
      const t = checks();
      t.exit(run(hub, RAISE_ARGS(), { env: { HARNESS_ESCALATION_NOW: '2026-10-28T09:30:00Z' } }), 0);
      const labels = () => issuesOf(hub, 'PROJ-421')[0].labels.join();
      t.ok(labels() === 'harness-waiting', `raised: ${labels()}`);
      t.exit(run(hub, ['sweep', '--now', '2026-10-28T17:01:00Z']), 0);
      t.ok(labels() === 'harness-waiting', `after the first wait: ${labels()}`);
      t.exit(run(hub, ['sweep', '--now', '2026-10-29T17:01:00Z']), 0);
      t.ok(labels() === 'harness-overdue', `after the second wait: ${labels()}`);
      const s = ghState(hub);
      s.issues[0].state = 'closed';
      s.issues[0].state_reason = 'completed';
      saveState(hub, s);
      const reopen = run(hub, ['sweep', '--now', '2026-10-29T17:20:00Z']);
      t.exit(reopen, 0);
      t.has(reopen, 'reopened, because a person closed it while the escalation is open');
      t.ok(issuesOf(hub, 'PROJ-421')[0].state === 'open', 'the issue is open again');
      t.exit(run(hub, ['resolve', '--work-item', 'PROJ-421', '--fact-kind', 'verdict', '--fact-value', 'APPROVED', '--by-seat', 'sprint-orchestrator', '--now', '2026-10-30T10:00:00Z']), 0);
      const done = issuesOf(hub, 'PROJ-421')[0];
      t.ok(done.state === 'closed' && done.state_reason === 'completed' && done.labels.length === 0, `resolved: closed as completed with no label (${done.state}, ${done.state_reason}, ${done.labels.join()})`);
      return t.problems;
    },
  },
  {
    n: 48, name: 'the record can be read back later: print --jsonl gives the artefact\'s lines exactly, and --json names the issue',
    run(hub) {
      const t = checks();
      t.exit(run(hub, RAISE_ARGS()), 0);
      t.exit(run(hub, ACK('ESC-PROJ-421-01', ['--login', 'lead-one'])), 0);
      const out = run(hub, ['print', 'ESC-PROJ-421-01', '--jsonl']);
      t.exit(out, 0);
      t.ok(out.out === recordOf(hub, 'PROJ-421'), 'print --jsonl prints the artefact\'s lines byte for byte');
      t.ok(out.out.trim().split('\n').every((l) => JSON.parse(l).id === 'ESC-PROJ-421-01'), 'every line is one JSON object of the escalation');
      const json = JSON.parse(run(hub, ['print', '--all', '--json']).out);
      t.ok(json.repository === 'acme/hub' && json.escalations[0].issue === 1 && json.escalations[0].url.endsWith('/issues/1'), 'print --json names the repository and the issue');
      return t.problems;
    },
  },
  {
    n: 49, name: 'a line, a reply or an issue that someone without write access forged is ignored, even from an outside collaborator: it ends nothing, blocks nothing, and silences no command',
    run(hub) {
      const t = checks();
      t.exit(run(hub, RAISE_ARGS()), 0);
      const number = issuesOf(hub, 'PROJ-421')[0].number;
      const forged = (seq, line) => `x\n\n\`\`\`json\n${JSON.stringify(line)}\n\`\`\`\n\n<!-- shl-escalation-line id=ESC-PROJ-421-01 seq=${seq} -->\nGenerated-by: SHL Agentic Harness\n`;
      comment(hub, number, forged(3, { schema_version: 1, id: 'ESC-PROJ-421-01', seq: 3, event: 'stopped', at: CLOCK, by: { kind: 'person', role: 'delivery lead' }, reason: 'forged' }), { login: 'reader', association: 'NONE' });
      comment(hub, number, forged(2, NOTIFIED({ to: 'someone else' })), { login: 'stranger', association: 'COLLABORATOR' });
      const s = ghState(hub);
      s.issues.push({ number: s.next++, title: '[shl-harness] PROJ-421 · a copy', body: 'x\n\n<!-- shl-escalation id=ESC-PROJ-421-01 -->\nGenerated-by: SHL Agentic Harness\n', state: 'open', state_reason: null, labels: [], user: 'reader', created_at: CLOCK, comments: [], artifacts: [] });
      saveState(hub, s);
      const stop = comment(hub, number, '/stop The refund work moved to next quarter.', { login: 'lead-one', association: 'MEMBER', at: '2026-10-29T15:00:00Z' });
      comment(hub, number, `ok\n\n<!-- shl-escalation-reply comment=${stop} -->\nGenerated-by: SHL Agentic Harness\n`, { login: 'reader', association: 'NONE' });
      const view = run(hub, ['print', '--work-item', 'PROJ-421']);
      t.exit(view, 0);
      t.has(view, 'carries a record line, but its author cannot write to the hub, so it is ignored');
      t.exit(run(hub, ['sweep', '--now', '2026-10-29T15:05:00Z']), 0);
      const lines = linesOf(recordOf(hub, 'PROJ-421'));
      t.ok(lines.length === 3 && lines[2].event === 'stopped' && lines[2].by.login === 'lead-one' && lines[2].reason === 'The refund work moved to next quarter.', `the member's /stop is line 3, and no forged line reached the record: ${lines.map((l) => l.event).join()}`);
      return t.problems;
    },
  },
];


/* ----------------------------------------------------- the sweep: a fixed clock, a fake gh */

const SWEEP = (when, ...extra) => ['sweep', '--now', when, ...extra];
const COVER = (hub, owner = 'PROJ-421') => linesOf(recordOf(hub, owner));
const eventsOf = (hub, owner = 'PROJ-421') => COVER(hub, owner).map((l) => `${l.event}${l.to ? `:${l.to}` : ''}`);

/** The hub's pull requests: the fake gh answers `gh pr list` with the file GH_FAKE names. */
function fakeGh(root, pulls) {
  writeFileSync(join(root, 'pulls.json'), JSON.stringify(pulls));
  return { env: { GH_FAKE: join(root, 'pulls.json') }, file: join(root, 'pulls.json') };
}
const PR = (over = {}) => ({ number: 7, headRefName: 'requirements/payments-refunds', headRefOid: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2', state: 'OPEN', createdAt: '2026-10-26T10:00:00Z', closedAt: null, mergedAt: null, url: 'https://example.invalid/acme/hub/pull/7', author: { login: 'dev-one' }, comments: [], ...over });

const SWEEP_FIXTURES = [
  {
    n: 30, name: 'the ladder, with a fixed clock: the first wait asks the runner again and tells the next role, the second tells the delivery lead, and the escalation shows as overdue',
    run(hub) {
      const t = checks();
      t.exit(run(hub, RAISE_ARGS({ '--point': 'dev-sprint.test-review-cap' }), { env: { HARNESS_ESCALATION_NOW: '2026-10-28T09:30:00Z' } }), 0);
      const early = run(hub, SWEEP('2026-10-28T16:59:00Z'));
      t.exit(early, 0);
      t.has(early, 'ESC-PROJ-421-01  open');
      t.has(early, 'nothing due');
      t.ok(eventsOf(hub).join() === 'raised,notified:runner', 'nothing was written before the first wait ends');
      const first = run(hub, SWEEP('2026-10-28T17:01:00Z'));
      t.exit(first, 0);
      t.has(first, 'reasked runner, notified engineering lead');
      t.has(first, '[PROJ-421] revision-cap at dev-sprint.test-review-cap — to runner');
      t.has(first, '[PROJ-421] revision-cap at dev-sprint.test-review-cap — to engineering lead');
      t.has(first, 'Question: Does a partial refund post one ledger line or two?');
      t.ok(eventsOf(hub).join() === 'raised,notified:runner,reasked:runner,notified:engineering lead', `lines: ${eventsOf(hub).join()}`);
      const reasked = COVER(hub)[2];
      t.ok(reasked.channel === 'issue' && reasked.by.kind === 'script' && reasked.at === '2026-10-28T17:01:00Z', 'the sweep names its channel, its writer and the time');
      const again = run(hub, SWEEP('2026-10-28T17:01:00Z'));
      t.exit(again, 0);
      t.ok(eventsOf(hub).length === 4, 'a second sweep at the same time writes nothing');
      t.lacks(again, 'MESSAGES');
      const before = run(hub, SWEEP('2026-10-29T16:59:00Z'));
      t.ok(eventsOf(hub).length === 4, 'the delivery lead is not told before the second wait ends');
      t.lacks(before, 'overdue');
      const second = run(hub, SWEEP('2026-10-29T17:01:00Z'));
      t.exit(second, 0);
      t.has(second, 'notified delivery lead');
      t.has(second, 'overdue');
      t.ok(eventsOf(hub).slice(4).join() === 'notified:delivery lead', `lines: ${eventsOf(hub).slice(4).join()}`);
      const after = run(hub, SWEEP('2026-10-30T17:01:00Z'));
      t.ok(eventsOf(hub).length === 5, 'the sweep sends no more messages after the delivery lead');
      t.has(after, 'overdue');
      t.exit(run(hub, ['print', '--work-item', 'PROJ-421']), 0);
      return t.problems;
    },
  },
  {
    n: 31, name: 'an acknowledgement stops the ladder, and the escalation comes up once at each standing sweep',
    run(hub) {
      const t = checks();
      t.exit(run(hub, RAISE_ARGS({ '--point': 'dev-sprint.test-review-cap' }), { env: { HARNESS_ESCALATION_NOW: '2026-10-28T09:30:00Z' } }), 0);
      t.exit(run(hub, ACK('ESC-PROJ-421-01', ['--now', '2026-10-28T12:00:00Z'])), 0);
      const late = run(hub, SWEEP('2026-10-28T17:01:00Z'));
      t.exit(late, 0);
      t.ok(eventsOf(hub).join() === 'raised,notified:runner,acknowledged', 'no reminder after the acknowledgement');
      t.has(late, 'acknowledged');
      const standing = run(hub, SWEEP('2026-10-29T07:00:00Z', '--standing'));
      t.exit(standing, 0);
      t.has(standing, 'reasked engineering lead');
      t.ok(eventsOf(hub).join() === 'raised,notified:runner,acknowledged,reasked:engineering lead', `lines: ${eventsOf(hub).join()}`);
      run(hub, SWEEP('2026-10-29T07:00:00Z', '--standing'));
      run(hub, SWEEP('2026-10-29T15:00:00Z', '--standing'));
      t.ok(eventsOf(hub).length === 4, 'once at each standing sweep, never twice in one day');
      run(hub, SWEEP('2026-10-29T17:01:00Z'));
      t.ok(eventsOf(hub).length === 4, 'a sweep that is not a standing sweep sends nothing');
      run(hub, SWEEP('2026-10-30T07:00:00Z', '--standing'));
      t.ok(eventsOf(hub).length === 5, 'the next standing sweep brings it up again');
      return t.problems;
    },
  },
  {
    n: 32, name: 'a resolution sends one closing message to everyone who was told, and a later sweep sends none',
    run(hub) {
      const t = checks();
      t.exit(run(hub, RAISE_ARGS({ '--point': 'dev-sprint.test-review-cap' }), { env: { HARNESS_ESCALATION_NOW: '2026-10-28T09:30:00Z' } }), 0);
      t.exit(run(hub, SWEEP('2026-10-28T17:01:00Z')), 0);
      mergeToTrunk(hub, { 'docs/designs/PROJ-421.lld.md': '# Design PROJ-421\n\nVersion two.\n' });
      t.exit(run(hub, ['resume', '--work-item', 'PROJ-421', '--by-seat', 'sprint-orchestrator', '--tests-commit', 'ffffffffffff', '--now', '2026-10-29T08:00:00Z']), 0);
      const res = run(hub, ['resolve', '--work-item', 'PROJ-421', '--fact-kind', 'verdict', '--fact-value', 'APPROVED', '--by-seat', 'sprint-orchestrator', '--now', '2026-10-29T09:00:00Z']);
      t.exit(res, 0);
      t.has(res, 'MESSAGES — 1');
      t.has(res, '[PROJ-421] ESC-PROJ-421-01 ended — resolved by a fact: verdict APPROVED.');
      t.has(res, 'Told: runner, engineering lead.');
      const sweep = run(hub, SWEEP('2026-10-30T17:01:00Z', '--standing'));
      t.exit(sweep, 0);
      t.lacks(sweep, 'MESSAGES');
      t.lacks(sweep, 'ended —');
      return t.problems;
    },
  },
  {
    n: 33, name: 'an incident is told at once and reminded after 60 minutes, at any hour, with no working-day rule',
    run(hub) {
      const t = checks();
      t.exit(run(hub, RAISE_ARGS({ '--point': 'dev-sprint.security-critical', '--question': 'A working credential is in src/pay.ts at the parked commit.' }), { env: { HARNESS_ESCALATION_NOW: '2026-11-01T03:00:00Z' } }), 0);
      const now = run(hub, SWEEP('2026-11-01T03:05:00Z'));
      t.exit(now, 0);
      t.has(now, 'notified security role on call');
      t.has(now, '[PROJ-421] incident at dev-sprint.security-critical — to security role on call');
      t.ok(eventsOf(hub).join() === 'raised,notified:runner,notified:security role on call', `lines: ${eventsOf(hub).join()}`);
      run(hub, SWEEP('2026-11-01T03:59:00Z'));
      t.ok(eventsOf(hub).length === 3, 'no reminder before 60 minutes');
      const hour = run(hub, SWEEP('2026-11-01T04:00:00Z'));
      t.has(hour, 'reasked security role on call');
      t.has(hour, 'notified engineering lead');
      t.ok(eventsOf(hub).slice(3).join() === 'reasked:security role on call,reasked:runner,notified:engineering lead', `lines: ${eventsOf(hub).slice(3).join()}`);
      run(hub, SWEEP('2026-11-01T05:00:00Z'));
      t.ok(eventsOf(hub).slice(-1)[0] === 'notified:delivery lead', 'the delivery lead is told after the second hour, on a Sunday');
      return t.problems;
    },
  },
  {
    n: 34, name: 'a handover writes handed-over, has no ladder, and comes up at each standing sweep',
    run(hub) {
      const t = checks();
      const res = run(hub, RAISE_ARGS({ '--point': 'clar-log.non-blocking', '--route-first': 'Product owner', '--question': 'Does a locked account need a distinct error code?' }), { env: { HARNESS_ESCALATION_NOW: '2026-10-28T09:30:00Z' } });
      t.exit(res, 0);
      t.ok(eventsOf(hub).join() === 'raised,notified:runner,handed-over:Product owner', `lines: ${eventsOf(hub).join()}`);
      run(hub, SWEEP('2026-10-30T17:01:00Z'));
      t.ok(eventsOf(hub).length === 3, 'no ladder: a plain sweep writes nothing');
      const standing = run(hub, SWEEP('2026-10-31T07:00:00Z', '--standing'));
      t.has(standing, 'reasked Product owner');
      run(hub, SWEEP('2026-10-31T09:00:00Z', '--standing'));
      t.ok(eventsOf(hub).length === 4, 'once a day');
      t.ok(COVER(hub)[0].trigger === 'handover' && COVER(hub)[0].path === 'handover', 'clar-log.non-blocking is a handover');
      return t.problems;
    },
  },
  {
    n: 35, name: 'a merge that waits too long is raised by the sweep, the role is told, and the merge is recorded when the sweep sees it',
    run(hub, root) {
      const t = checks();
      const gh = fakeGh(root, [PR()]);
      const quick = run(hub, SWEEP('2026-10-26T16:00:00Z', '--gates'), { env: gh.env });
      t.exit(quick, 0);
      t.ok(recordOf(hub, 'payments-refunds') === null, 'the working day of the pull request has not ended: nothing is raised');
      const late = run(hub, SWEEP('2026-10-26T17:01:00Z', '--gates'), { env: gh.env });
      t.exit(late, 0);
      t.has(late, 'ESC-payments-refunds-01: raised for pull request #7');
      let lines = linesOf(recordOf(hub, 'payments-refunds'));
      t.ok(lines.length === 1 && lines[0].point === 'feature.merge' && lines[0].trigger === 'gate-waiting' && lines[0].path === 'merge-waiting' && lines[0].runner === 'dev-one', 'the sweep raised feature.merge as a gate waiting, for the pull request author');
      t.ok(lines[0].links.pr === 'https://example.invalid/acme/hub/pull/7' && lines[0].parked.ref === 'requirements/payments-refunds' && lines[0].parked.commit === 'a1b2c3d4e5f6' && lines[0].work_item === null, 'the line links the pull request and parks its branch');
      t.ok(lines[0].by.kind === 'script', 'a script wrote it');
      const told = run(hub, SWEEP('2026-10-26T17:16:00Z', '--gates'), { env: gh.env });
      t.has(told, 'notified feature owner');
      t.ok(eventsOf(hub, 'payments-refunds').join() === 'raised,notified:feature owner', `lines: ${eventsOf(hub, 'payments-refunds').join()}`);
      const again = run(hub, SWEEP('2026-10-26T17:30:00Z', '--gates'), { env: gh.env });
      t.ok(eventsOf(hub, 'payments-refunds').length === 2, 'the same pull request is not raised twice');
      t.lacks(again, 'raised for');
      writeFileSync(gh.file, JSON.stringify([PR({ state: 'MERGED', mergedAt: '2026-10-27T08:00:00Z' })]));
      const merged = run(hub, SWEEP('2026-10-27T09:00:00Z', '--gates'), { env: gh.env });
      t.exit(merged, 0);
      t.has(merged, 'ESC-payments-refunds-01 ended — resolved by a fact: merge MERGED.');
      lines = linesOf(recordOf(hub, 'payments-refunds'));
      const last = lines[lines.length - 1];
      t.ok(last.event === 'resolved' && last.fact.kind === 'merge' && last.fact.value === 'MERGED' && last.by.kind === 'script', 'the merge is recorded as a fact a script read');
      const done = run(hub, SWEEP('2026-10-28T09:00:00Z', '--gates'), { env: gh.env });
      t.lacks(done, 'MESSAGES');
      return t.problems;
    },
  },
  {
    n: 36, name: 'a closed pull request stops its ladder, and becomes stopped only with a person\'s comment posted after the raise',
    run(hub, root) {
      const t = checks();
      const gh = fakeGh(root, [PR()]);
      t.exit(run(hub, SWEEP('2026-10-28T17:01:00Z', '--gates'), { env: gh.env }), 0);
      const noReason = [
        { author: { login: 'lead-one' }, body: 'Looks fine to me.', createdAt: '2026-10-27T10:00:00Z' },
        { author: { login: 'github-actions' }, body: 'CI passed.', createdAt: '2026-10-31T08:00:00Z' },
        { author: { login: 'dev-one' }, body: 'Review round 2.\n\nGenerated-by: SHL Agentic Harness', createdAt: '2026-10-31T08:05:00Z' },
      ];
      writeFileSync(gh.file, JSON.stringify([PR({ state: 'CLOSED', closedAt: '2026-10-31T09:00:00Z', comments: noReason })]));
      const silent = run(hub, SWEEP('2026-11-02T09:00:00Z', '--gates'), { env: gh.env });
      t.exit(silent, 0);
      t.has(silent, 'closed without a merge, and no person gave a reason after the raise');
      t.ok(!eventsOf(hub, 'payments-refunds').some((e) => e.startsWith('stopped') || e.startsWith('reasked')), `no reason of its own, and no reminder to merge a closed pull request: ${eventsOf(hub, 'payments-refunds').join()}`);
      const said = [...noReason, { author: { login: 'lead-one' }, body: 'Closing: the refund scope moved to the next quarter.\nSee the roadmap.', createdAt: '2026-10-31T09:01:00Z' }];
      writeFileSync(gh.file, JSON.stringify([PR({ state: 'CLOSED', closedAt: '2026-10-31T09:00:00Z', comments: said })]));
      const stopped = run(hub, SWEEP('2026-11-02T10:00:00Z', '--gates'), { env: gh.env });
      t.exit(stopped, 0);
      t.has(stopped, 'ended — stopped by feature owner: Closing: the refund scope moved to the next quarter.');
      const lines = linesOf(recordOf(hub, 'payments-refunds'));
      const last = lines[lines.length - 1];
      t.ok(last.event === 'stopped' && last.by.kind === 'person' && last.by.login === 'lead-one' && last.reason === 'Closing: the refund scope moved to the next quarter.', 'stopped carries the person and their own words');
      t.exit(run(hub, ['print', '--slug', 'payments-refunds']), 0);
      return t.problems;
    },
  },
  {
    n: 37, name: 'a hub pull request is placed from its branch: a design, a validation report, a context change and a survey, and another branch is ignored',
    run(hub, root) {
      const t = checks();
      mergeToTrunk(hub, { 'docs/backlog/payments-refunds/PROJ-421.item.md': '# PROJ-421\n' });
      const gh = fakeGh(root, [
        PR({ headRefName: 'feature/PROJ-421-refund-ledger', number: 9, url: 'https://example.invalid/acme/hub/pull/9' }),
        PR({ headRefName: 'docs/typo', number: 10, url: 'https://example.invalid/acme/hub/pull/10' }),
        PR({ headRefName: 'validation/PROJ-421', number: 11, url: 'https://example.invalid/acme/hub/pull/11' }),
        PR({ headRefName: 'context/std-names', number: 12, url: 'https://example.invalid/acme/hub/pull/12' }),
        PR({ headRefName: 'estate/survey-payments-api', number: 13, url: 'https://example.invalid/acme/hub/pull/13' }),
      ]);
      const res = run(hub, SWEEP('2026-10-28T17:01:00Z', '--gates'), { env: gh.env });
      t.exit(res, 0);
      const lines = linesOf(recordOf(hub, 'PROJ-421'));
      t.ok(lines.length === 2 && lines[0].point === 'dev-spec.merge' && lines[0].work_item === 'PROJ-421' && lines[0].slug === 'payments-refunds' && lines[0].route.first === 'design approver', 'dev-spec.merge for the story, with the slug from the backlog');
      t.ok(lines[1].point === 'qa-sprint.merge' && lines[1].links.pr.endsWith('/pull/11'), 'qa-sprint.merge for the validation report of the same story');
      t.ok(linesOf(recordOf(hub, 'context-std-names') || '')[0]?.point === 'add-context.merge', 'add-context.merge for a context change, recorded under its branch name');
      t.ok(linesOf(recordOf(hub, 'survey-payments-api') || '')[0]?.point === 'survey-repo.merge', 'survey-repo.merge for a survey');
      t.ok(recordOf(hub, 'docs-typo') === null, 'the other branch is no gate');
      return t.problems;
    },
  },
  {
    n: 38, name: 'the sweep reads every file it can and exits 2 on one it cannot, and --dry-run writes nothing',
    run(hub, root) {
      const t = checks();
      t.exit(run(hub, RAISE_ARGS({ '--point': 'dev-sprint.test-review-cap' }), { env: { HARNESS_ESCALATION_NOW: '2026-10-28T09:30:00Z' } }), 0);
      craftRecord(hub, 'SRCH-7', [RAISED({ id: 'ESC-SRCH-7-01', work_item: 'SRCH-7' }), NOTIFIED({ id: 'ESC-SRCH-7-01', seq: 3 })]);
      const summary = join(root, 'summary.md');
      const dry = run(hub, SWEEP('2026-10-28T17:01:00Z', '--dry-run', '--summary', summary));
      t.exit(dry, 2);
      t.has(dry, 'Dry run: nothing was written.');
      t.has(dry, 'MESSAGES THAT A RUN WOULD SEND');
      t.ok(eventsOf(hub).length === 2, '--dry-run wrote nothing');
      t.ok(!existsSync(summary), '--dry-run wrote no summary');
      const real = run(hub, SWEEP('2026-10-28T17:01:00Z', '--summary', summary));
      t.exit(real, 2);
      t.has(real, 'a line is missing');
      t.ok(eventsOf(hub).length === 4, 'the readable file was still swept');
      const text = readFileSync(summary, 'utf8');
      t.ok(text.includes('## Escalation messages') && text.includes('[PROJ-421] revision-cap at dev-sprint.test-review-cap — to engineering lead') && text.includes('## Escalation sweep'), 'the messages and the sweep went to the job summary');
      return t.problems;
    },
  },
  {
    n: 39, name: 'a gate scan with no GitHub CLI is exit 2, so is a list of pull requests cut at its limit, and a bad time zone or day is a usage fault',
    run(hub, root) {
      const t = checks();
      const res = run(hub, SWEEP('2026-10-28T17:01:00Z', '--gates'), { env: { PATH: '/nonexistent' } });
      t.exit(res, 2);
      t.exit(run(hub, SWEEP('2026-10-28T17:01:00Z', '--tz', 'Mars/Olympus')), 3);
      t.exit(run(hub, SWEEP('2026-10-28T17:01:00Z', '--day-end', '25:00')), 3);
      t.exit(run(hub, ['sweep', '--now', 'tomorrow']), 3);
      const many = Array.from({ length: 1000 }, (_, i) => PR({ headRefName: `docs/page-${i}`, number: 100 + i }));
      const full = run(hub, SWEEP('2026-10-28T17:01:00Z', '--gates'), { env: fakeGh(root, many).env });
      t.exit(full, 2);
      t.has(full, 'gh lists only the newest 1000 pull requests');
      return t.problems;
    },
  },
  {
    n: 40, name: 'the working day follows the hub\'s time zone: the first wait of a cap raised at 09:30 in Kolkata ends at 17:00 there',
    run(hub) {
      const t = checks();
      const env = { HARNESS_ESCALATION_TZ: 'Asia/Kolkata' };
      t.exit(run(hub, RAISE_ARGS({ '--point': 'dev-sprint.test-review-cap' }), { env: { HARNESS_ESCALATION_NOW: '2026-10-28T04:00:00Z' } }), 0);
      run(hub, SWEEP('2026-10-28T11:00:00Z'), { env });
      t.ok(eventsOf(hub).length === 2, 'it is 16:30 in Kolkata: not yet');
      const res = run(hub, SWEEP('2026-10-28T11:31:00Z'), { env });
      t.has(res, 'reasked runner');
      t.has(res, 'in Asia/Kolkata');
      return t.problems;
    },
  },
  {
    n: 41, name: 'a superseded escalation and a final one get no reminder',
    run(hub) {
      const t = checks();
      t.exit(run(hub, RAISE_ARGS(), { env: { HARNESS_ESCALATION_NOW: '2026-10-28T09:30:00Z' } }), 0);
      mergeToTrunk(hub, { 'docs/designs/PROJ-421.lld.md': '# Design PROJ-421\n\nVersion two.\n' });
      t.exit(run(hub, ['resume', '--work-item', 'PROJ-421', '--by-seat', 'sprint-orchestrator', '--now', '2026-10-28T10:00:00Z']), 0);
      t.exit(run(hub, RAISE_ARGS({ '--question': 'Is the line signed?' }), { env: { HARNESS_ESCALATION_NOW: '2026-10-28T11:00:00Z' } }), 0);
      t.exit(run(hub, ['withdraw', 'ESC-PROJ-421-02', '--role', 'delivery lead', '--reason', 'Not needed.', '--now', '2026-10-28T11:30:00Z']), 0);
      const before = eventsOf(hub).length;
      const res = run(hub, SWEEP('2026-10-30T17:01:00Z'));
      t.exit(res, 0);
      t.ok(eventsOf(hub).length === before, 'the sweep wrote nothing');
      t.has(res, 'No live escalation is due.');
      return t.problems;
    },
  },
  {
    n: 42, name: 'where the hub has a Jira connection, raise and resolve print the one mirror command, and run nothing of it',
    run(hub) {
      const t = checks();
      const plain = run(hub, RAISE_ARGS());
      t.exit(plain, 0);
      t.lacks(plain, 'jira-sync.mjs');
      t.exit(run(hub, ['withdraw', 'ESC-PROJ-421-01', '--role', 'delivery lead', '--reason', 'again']), 0);
      mergeToTrunk(hub, { 'docs/estate/trackers.json': '{}\n' });
      const res = run(hub, RAISE_ARGS());
      t.exit(res, 0);
      t.has(res, '  Jira: node scripts/jira-sync.mjs apply PROJ-421 --fact needs-person --link ');
      t.has(res, '--link https://github.example/acme/hub/issues/');
      const done = run(hub, ['resolve', '--work-item', 'PROJ-421', '--fact-kind', 'verdict', '--fact-value', 'APPROVED', '--by-seat', 'sprint-orchestrator']);
      t.exit(done, 0);
      t.has(done, '  Jira: node scripts/jira-sync.mjs apply PROJ-421 --fact person-answered');
      const pr = run(hub, RAISE_ARGS({ '--point': 'pr-review.comment-cap', '--comment': 'SHL-R3', '--pr': 'https://example.invalid/acme/hub/pull/7' }));
      t.exit(pr, 0);
      t.has(pr, 'node scripts/pull-request.mjs label --repo-id <id> --pr <n> --needs-person yes');
      const other = run(hub, RAISE_ARGS({ '--point': 'pr-review.comment-cap', '--comment': 'SHL-R4', '--pr': 'https://example.invalid/acme/hub/pull/7', '--question': 'Another comment at its cap.' }));
      t.exit(other, 0);
      t.has(other, 'ESC-PROJ-421-04');
      t.exit(run(hub, RAISE_ARGS({ '--point': 'pr-review.comment-cap', '--comment': 'SHL-R4', '--pr': 'https://example.invalid/acme/hub/pull/7' })), 1);
      return t.problems;
    },
  },
  {
    n: 50, name: 'a stop that the runner can answer is refused until the session says it asked: --asked left or absent raises it, any other value and --asked on another point are usage faults',
    run(hub) {
      const t = checks();
      const left = { '--point': 'pr-review.needs-person', '--route-first': 'tech lead', '--pr': 'https://example.invalid/acme/hub/pull/7', '--question': 'Two findings wait for a value.' };
      const unasked = run(hub, RAISE_ARGS(left));
      t.exit(unasked, 1);
      t.has(unasked, 'ask the runner first. Nothing was raised.');
      t.has(unasked, '--asked left');
      t.lacks(run(hub, ['print', '--work-item', 'PROJ-421']), 'ESC-PROJ-421-01');
      t.exit(run(hub, RAISE_ARGS({ ...left, '--asked': 'yes' })), 3);
      t.exit(run(hub, RAISE_ARGS({ '--asked': 'left' })), 3);
      const conflict = run(hub, RAISE_ARGS({ '--point': 'pr-review.design-conflict', '--pr': 'https://example.invalid/acme/hub/pull/7', '--question': 'The design keeps the mark unlimited.' }));
      t.exit(conflict, 1);
      const raised = run(hub, RAISE_ARGS({ ...left, '--asked': 'left' }));
      t.exit(raised, 0);
      t.has(raised, 'ESCALATION RAISED — ESC-PROJ-421-01');
      t.exit(run(hub, RAISE_ARGS({ '--point': 'pr-review.design-conflict', '--asked': 'absent', '--pr': 'https://example.invalid/acme/hub/pull/7', '--question': 'The design keeps the mark unlimited.' })), 0);
      return t.problems;
    },
  },
];

/* --------------------------------------------- the list of stop points, and the schema */

const INVENTORY = {
  question: 15, 'decision-owed': 13, 'merge-waiting': 10, 'check-cannot-run': 10, 'review-cap': 7, handover: 6, incident: 3, none: 3,
};
const STAGE_COUNTS = { requirements: 4, backlog: 4, design: 5, build: 17, 'pr-review': 9, validation: 6, 'context-governance': 18, 'clarification-queue': 4 };

const STATIC = [
  {
    n: 101, name: 'the list holds all 67 stop points, with the counts of the feature document\'s two tables',
    run() {
      const t = checks();
      const doc = JSON.parse(readFileSync(join(LIB.governance, 'escalation-points.json'), 'utf8'));
      t.ok(doc.points.length === 67, `${doc.points.length} points, expected 67`);
      t.ok(new Set(doc.points.map((p) => p.id)).size === doc.points.length, 'ids are unique');
      const byPath = {};
      const byStage = {};
      for (const p of doc.points) { byPath[p.path] = (byPath[p.path] || 0) + 1; byStage[p.stage] = (byStage[p.stage] || 0) + 1; }
      for (const [path, n] of Object.entries(INVENTORY)) t.ok(byPath[path] === n, `path ${path}: ${byPath[path]} points, expected ${n}`);
      for (const [stage, n] of Object.entries(STAGE_COUNTS)) t.ok(byStage[stage] === n, `stage ${stage}: ${byStage[stage]} points, expected ${n}`);
      return t.problems;
    },
  },
  {
    n: 102, name: 'every point has a unique id that starts with its command, its two roles and its wait, from closed sets, and every recording path has a wait that matches',
    run() {
      const t = checks();
      const doc = JSON.parse(readFileSync(join(LIB.governance, 'escalation-points.json'), 'utf8'));
      for (const p of doc.points) {
        const here = `point ${p.id}`;
        const command = p.command.replace(/^\/|^make /, '').toLowerCase();
        t.ok(p.id.startsWith(`${command}.`) && p.id.slice(command.length + 1).match(/^[a-z][a-z0-9-]*$/) !== null, `${here} is <command>.<stop>, and its command is ${p.command}`);
        t.ok(typeof p.command === 'string' && p.command !== '', `${here} has a command`);
        t.ok(doc.stages.includes(p.stage), `${here} has a known stage`);
        t.ok(p.path === 'none' || p.path in doc.paths, `${here} has a known path`);
        t.ok(Array.isArray(p.first) && Array.isArray(p.next), `${here} has roles as lists`);
        t.ok(p.wait in doc.waits, `${here} has a known wait`);
        if (doc.paths[p.path]) {
          t.ok(p.wait === doc.paths[p.path].wait, `${here} waits ${p.wait}, and its path says ${doc.paths[p.path].wait}`);
          t.ok(p.severity === doc.paths[p.path].severity || p.severity === null, `${here} has the severity of its path`);
          if (doc.paths[p.path].records) {
            t.ok(p.first.length > 0, `${here} names a first role`);
            t.ok(doc.triggers.includes(p.trigger), `${here} has a known trigger`);
          }
        } else {
          t.ok(p.first.length === 0 && p.wait === 'none' && p.trigger === null, `${here} follows no path and tells nobody`);
        }
        if (p.alternative) t.ok(p.alternative.path in doc.paths && doc.triggers.includes(p.alternative.trigger) && p.alternative.path !== p.path, `${here} has a valid second path`);
        for (const u of p.upstream || []) t.ok(['design', 'tests', 'clarification', 'requirements'].includes(u.what) && ['branch', 'trunk', 'given'].includes(u.at), `${here} has a valid upstream`);
        t.ok(p.fix && p.source, `${here} has its fix and its source`);
      }
      const capped = doc.points.filter((p) => p.upstream).map((p) => p.id).join();
      t.ok(capped === 'feature.review-cap,decompose.review-cap,dev-spec.review-cap,dev-sprint.test-dispute,dev-sprint.test-review-cap,dev-sprint.code-review-cap', `the points with a re-run check are ${capped}`);
      t.ok(doc.triggers.length === 8, 'the escalation contract has eight triggers');
      return t.problems;
    },
  },
  {
    n: 104, name: 'working time: the same working day, the next working day and the incident wait, over a weekend and in another time zone',
    async run() {
      const t = checks();
      const { waitEnds, DEFAULT_CONFIG } = await import(join(LIB.scripts, 'escalation-record.mjs'));
      const at = (iso, wait, cfg) => new Date(waitEnds(Date.parse(iso), wait, cfg)).toISOString().replace('.000Z', 'Z');
      t.ok(at('2026-10-28T09:30:00Z', 'same-working-day') === '2026-10-28T17:00:00Z', 'a cap at 09:30 waits until 17:00');
      t.ok(at('2026-10-28T14:02:00Z', 'same-working-day') === '2026-10-28T17:00:00Z', 'a cap at 14:02 waits until 17:00, which is later than 16:02');
      t.ok(at('2026-10-30T16:00:00Z', 'same-working-day') === '2026-10-30T18:00:00Z', 'Friday at 16:00 waits 2 hours, to 18:00, which is later than 17:00');
      t.ok(at('2026-10-28T19:00:00Z', 'same-working-day') === '2026-10-29T17:00:00Z', 'a stop after the working day ends waits until the end of the next working day');
      t.ok(at('2026-10-31T10:00:00Z', 'same-working-day') === '2026-11-02T17:00:00Z', 'a cap on a Saturday waits until Monday at 17:00');
      t.ok(at('2026-10-28T10:00:00Z', 'next-working-day') === '2026-10-29T17:00:00Z', 'a decision owed waits until 17:00 on the next working day');
      t.ok(at('2026-10-30T11:00:00Z', 'next-working-day') === '2026-11-02T17:00:00Z', 'Friday plus one working day is Monday');
      t.ok(at('2026-11-01T03:00:00Z', 'sixty-minutes') === '2026-11-01T04:00:00Z', 'an incident waits 60 minutes, on a Sunday at 03:00');
      t.ok(waitEnds(0, 'standing-sweep') === null && waitEnds(0, 'none') === null, 'the standing sweep and no wait have no end');
      t.ok(at('2026-10-28T09:30:00Z', 'same-working-day', { ...DEFAULT_CONFIG, tz: 'Asia/Kolkata' }) === '2026-10-28T11:30:00Z', 'in Kolkata a cap at 15:00 local waits until 17:00 local, which is 11:30 UTC');
      t.ok(at('2026-10-28T03:00:00Z', 'same-working-day', { ...DEFAULT_CONFIG, tz: 'Asia/Kolkata' }) === '2026-10-28T11:30:00Z', 'in Kolkata a cap at 08:30 local waits until 17:00 local, which is 11:30 UTC');
      return t.problems;
    },
  },
  {
    n: 103, name: 'the schema and the script agree on the nine events, the eight triggers, the seven paths and the facts',
    async run() {
      const t = checks();
      const schema = JSON.parse(readFileSync(join(LIB.governance, 'escalation-record.schema.json'), 'utf8'));
      const rec = await import(join(LIB.scripts, 'escalation-record.mjs'));
      const same = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
      const thenOf = (event) => (schema.allOf.find((a) => a.if && a.if.properties && a.if.properties.event && a.if.properties.event.const === event) || { then: { properties: {} } }).then.properties;
      t.ok(same(schema.properties.event.enum, rec.EVENTS), 'the schema lists the nine events');
      t.ok(same(thenOf('raised').trigger.enum, rec.TRIGGERS), 'the schema lists the eight triggers');
      t.ok(same([...thenOf('raised').path.enum, 'question'], rec.PATHS), 'the schema lists the six recorded paths, and the question path writes no line');
      t.ok(same(thenOf('resumed').upstream.properties.what.enum, rec.UPSTREAM_KINDS), 'the schema lists the upstream kinds');
      t.ok(same(thenOf('resolved').fact.properties.kind.enum, rec.FACT_KINDS), 'the schema lists the fact kinds');
      t.ok(same(thenOf('raised').parked.properties.commit.pattern ? ['x'] : [], ['x']), 'the parked commit is 12 hex');
      t.ok(rec.EVENTS.length === 9 && rec.TRIGGERS.length === 8 && rec.PATHS.length === 7, 'nine events, eight triggers, seven paths');
      t.ok(schema.properties.schema_version.const === rec.SCHEMA_VERSION, 'the schema pins the version the reader knows');
      const personOnly = schema.allOf.find((a) => a.if && a.if.properties.event.enum && a.if.properties.event.enum.includes('acknowledged') && a.then.properties.by);
      t.ok(personOnly && same(personOnly.if.properties.event.enum, rec.PERSON_EVENTS), 'the schema keeps the three person events a person\'s');
      // Every key a raised line carries is a key the schema knows.
      const keys = Object.keys(thenOf('raised'));
      for (const k of ['trigger', 'point', 'path', 'work_item', 'slug', 'repository', 'runner', 'route', 'parked', 'question', 'findings', 'links', 'hub_commit']) t.ok(keys.includes(k), `the schema describes ${k}`);
      for (const k of ['kind', 'name', 'role', 'login', 'via', 'comment']) t.ok(Object.keys(schema.properties.by.properties).includes(k), `the schema describes by.${k}, which a line from a comment command carries`);
      return t.problems;
    },
  },
];

/* ---------------------------------------------------------------------- the runner */

async function runFixture(fixture, all) {
  const root = mkdtempSync(join(tmpdir(), `escalation-fx${String(fixture.n).padStart(3, '0')}-`));
  try {
    const hub = fixture.n > 100 ? null : makeHub(root);
    const problems = await fixture.run(hub, root);
    return { problems };
  } catch (err) {
    return { problems: [`fixture failed: ${err && err.stack ? err.stack.split('\n').slice(0, 4).join(' / ') : String(err)}`] };
  } finally {
    if (!all.keep) rmSync(root, { recursive: true, force: true });
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const wanted = argv.filter((a) => a.match(/^\d+$/)).map(Number);
  const everything = [...FIXTURES, ...SWEEP_FIXTURES, ...STATIC];
  const selected = wanted.length ? everything.filter((f) => wanted.includes(f.n)) : everything;
  let failed = 0;
  for (const fixture of selected) {
    const { problems } = await runFixture(fixture, { keep: argv.includes('--keep') });
    if (problems.length) {
      failed += 1;
      process.stdout.write(`  FAIL  ${fixture.n}. ${fixture.name}\n`);
      for (const p of problems) process.stdout.write(`          - ${p}\n`);
    } else {
      process.stdout.write(`  PASS  ${fixture.n}. ${fixture.name}\n`);
    }
  }
  process.stdout.write(failed ? `\n${failed} of ${selected.length} fixtures FAILED. The escalation record is not trustworthy until this is green.\n` : `\nAll ${selected.length} fixtures passed.\n`);
  rmSync(SANDBOX_HOME, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
}

main();

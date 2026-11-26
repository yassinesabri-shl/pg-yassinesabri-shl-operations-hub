#!/usr/bin/env node
// Part of the harness asset library c6f3b4427d58f7c3 (see VERSION.json) · 2026-11-12
/**
 * run.mjs — the fixture suite for the gate records (observability-gate.mjs): the script that the
 * hub's `observability-gates` workflow runs at each merge of a human gate.
 *
 *   usage:  node run.mjs            run every fixture
 *           node run.mjs 3 7        run only the numbered fixtures
 *           node run.mjs --keep     leave the throwaway hubs on disk
 *
 * A fixture is a HUB STATE: a throwaway hub with a real bare origin, its connection, its registry
 * and a story's design on its trunk, and an event file as GitHub Actions writes one. A fake `gh`
 * first on PATH answers from a file that the fixture writes, so no fixture reaches GitHub. A fake
 * observability platform listens on this laptop. The shipped script runs in the hub as the workflow
 * runs it.
 *
 * Fixture 1 is the full control. Every other fixture changes one thing.
 *
 * Node standard library only. No test framework.
 * Exit 0 if every fixture passes, 1 if any fails, 4 if the script under test cannot be found.
 */

import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

// Two layouts: the library, where the script sits at ../../observability-gate.mjs; and an adopting
// hub, where this suite lands at tests/observability-gate/ and the script at scripts/.
const SCRIPT = [
  process.env.HARNESS_OBSERVABILITY_GATE,
  resolve(HERE, '..', '..', 'observability-gate.mjs'),
  resolve(HERE, '..', '..', 'scripts', 'observability-gate.mjs'),
].filter(Boolean).find((p) => existsSync(p));
if (!SCRIPT) {
  console.error('cannot locate observability-gate.mjs. Set HARNESS_OBSERVABILITY_GATE=/path/to/scripts/observability-gate.mjs.');
  process.exit(4);
}
const record = await import(pathToFileURL(join(dirname(SCRIPT), 'observability', 'record.mjs')).href);

const KEEP = process.argv.includes('--keep');
const TOKEN = 'token-for-fixtures-only';
const T0 = Date.parse('2026-11-02T10:00:00Z');
const at = (s) => new Date(T0 + s * 1000).toISOString();
const SHA = (c) => c.repeat(40);
const RECEIPT = { schema_version: 1, library: { harnessVersion: '0.9.15', libraryCommit: 'c15a998e0f1d2c3b4a5968778695a4b3c2d1e0f9' }, files: {} };
const SPOKE_URL = 'https://github.com/example/catalogue-api.git';
/** The Jira connection and the feature's link file, as /connect-jira and jira-sync.mjs write them. */
const TRACKERS = { schema_version: 1, instances: { acme: { kind: 'jira-cloud', site: 'acme.atlassian.net', auth: { method: 'api-token', user_env: 'JIRA_USER', token_env: 'JIRA_API_TOKEN' } } }, default_board: 'platform' };
const LINKS = { schema_version: 1, slug: 'service-version-endpoint', epic: 'acme:PLAT-10', items: { 'PROJ-102': { type: 'story', board: 'platform', ticket: 'acme:PLAT-345' } } };

/* ---------------------------------------------------------------------- the fake observability platform */

function fakePlatform(plan = [{ status: 204 }]) {
  const seen = [];
  const sockets = new Set();
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push({ url: req.url, headers: req.headers, body });
      const step = plan[Math.min(seen.length - 1, plan.length - 1)];
      res.writeHead(step.status, { 'content-type': 'text/plain' });
      res.end(step.answer || '');
    });
  });
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  return new Promise((done) => server.listen(0, '127.0.0.1', () => done({
    seen,
    url: `http://127.0.0.1:${server.address().port}`,
    lines: () => seen.flatMap((r) => r.body.split('\n').filter(Boolean)).map((l) => JSON.parse(l)),
    close: () => new Promise((d) => { for (const s of sockets) s.destroy(); server.close(() => d()); }),
  })));
}

/* --------------------------------------------------------------------------------- the hub */

function write(root, rel, text) {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, text);
}

function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
}

/** git with the committer and author times at `s` seconds after T0. */
function gitAt(cwd, s, ...args) {
  const date = `@${Math.floor((T0 + s * 1000) / 1000)} +0000`;
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_COMMITTER_DATE: date, GIT_AUTHOR_DATE: date } });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
}

/**
 * A hub with a bare origin, as actions/checkout leaves it: the connection, the receipt, PROJ-102's
 * item and design naming catalogue-api, and the registry. `validationAt` merges the story's
 * validation report on the trunk at that second.
 */
function makeHub(root, { url, registry = true, designRepo = 'catalogue-api', validationAt = null, auth, jira = false } = {}) {
  const origin = join(root, 'origin.git');
  const hub = join(root, 'hub');
  mkdirSync(root, { recursive: true });
  git(root, 'init', '-q', '--bare', '-b', 'main', origin);
  git(root, 'init', '-q', '-b', 'main', hub);
  write(hub, '.gitignore', '.worktrees/\n.harness/\n');
  write(hub, 'docs/estate/observability.json', `${JSON.stringify({ schema_version: 1, hub: 'example-hub', platform: 'cubeapm', url, ...(auth ? { auth } : {}) }, null, 2)}\n`);
  write(hub, 'governance/agent-registry.json', '[]\n');
  write(hub, 'docs/harness-install.json', `${JSON.stringify(RECEIPT)}\n`);
  write(hub, 'docs/backlog/service-version-endpoint/PROJ-102.item.md', '# PROJ-102\n');
  write(hub, 'docs/designs/PROJ-102.lld.md', `# PROJ-102\n\nRepository: ${designRepo}\n`);
  if (jira) {
    write(hub, 'docs/estate/trackers.json', `${JSON.stringify(TRACKERS, null, 2)}\n`);
    write(hub, 'docs/estate/tracker-links/service-version-endpoint.json', `${JSON.stringify(LINKS, null, 2)}\n`);
  }
  if (registry) {
    const entry = { url: SPOKE_URL, checks: 'checks.env', purpose: 'The spoke of the fixtures.', readAt: '0'.repeat(40), trunk: 'default' };
    write(hub, 'docs/estate/repositories.json', `${JSON.stringify({ schema_version: 1, repositories: { 'catalogue-api': entry } }, null, 2)}\n`);
  }
  gitAt(hub, -100000, 'add', '-A');
  gitAt(hub, -100000, 'commit', '-q', '-m', 'hub');
  if (validationAt !== null) {
    write(hub, 'docs/designs/PROJ-102.validation.md', '# PROJ-102 validation\n');
    gitAt(hub, validationAt, 'add', '-A');
    gitAt(hub, validationAt, 'commit', '-q', '-m', 'docs(PROJ-102): the validation report (#9)');
  }
  git(hub, 'remote', 'add', 'origin', origin);
  git(hub, 'push', '-q', 'origin', 'main');
  git(hub, 'fetch', '-q', 'origin');
  return hub;
}

/** A pull request as GitHub's API and its events give one. */
function pr({ number = 2, created = 0, merged = 1200, base = 'main', head = 'feature/PROJ-102-endpoint', sha = SHA('a'), defaultBranch = 'main' } = {}) {
  return {
    number, created_at: at(created), merged_at: merged === null ? null : at(merged), merged: merged !== null,
    base: { ref: base, repo: { default_branch: defaultBranch } }, head: { ref: head, sha },
  };
}
const commit = (s) => ({ commit: { committer: { date: at(s) } } });

/**
 * What the fake gh answers, by api path: { json } or { out }, or { fail } for an exit 1. `calls`
 * collects each call's arguments, its GH_TOKEN and its GH_HOST.
 */
function ghAnswers(root, answers) {
  const data = join(root, 'gh-answers.json');
  writeFileSync(data, JSON.stringify(answers));
  return data;
}

/** Runs the shipped script in the hub, as the workflow runs it. */
function run(hub, args, { gh = {}, root, env = {}, token = TOKEN } = {}) {
  return new Promise((done) => {
    const calls = join(root, 'gh-calls.jsonl');
    const e = {
      ...process.env, GITHUB_REPOSITORY: 'example/hub', FAKE_GH_DATA: ghAnswers(root, gh), FAKE_GH_CALLS: calls,
      HARNESS_OBSERVABILITY_NOW: at(3600), GH_TOKEN: 'gh-token-for-fixtures', ...env,
    };
    if (token) e.HARNESS_OBSERVABILITY_TOKEN = token;
    else delete e.HARNESS_OBSERVABILITY_TOKEN;
    const p = spawn(process.execPath, [SCRIPT, ...args], { cwd: hub, env: e });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    const timer = setTimeout(() => p.kill('SIGKILL'), 30000);
    p.on('close', (code) => {
      clearTimeout(timer);
      const seen = existsSync(calls) ? readFileSync(calls, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
      done({ code, out, calls: seen });
    });
  });
}

/** The event file of a hub pull request that closed, as GitHub Actions writes it. */
function eventFile(root, pull) {
  const path = join(root, 'event.json');
  writeFileSync(path, JSON.stringify({ action: 'closed', pull_request: pull }));
  return path;
}

/** The answers of a hub pull request that changed `files`, with its last commit at `commitAt`. */
const hubGh = (pull, files, commitAt) => ({
  [`repos/example/hub/pulls/${pull.number}/files?per_page=100`]: { out: files.map((f) => `${f}\n`).join('') },
  [`repos/example/hub/pulls/${pull.number}`]: { json: pull },
  [`repos/example/hub/commits/${pull.head.sha}`]: { json: commit(commitAt) },
});
/** The answers of a spoke's pull request, with its last commit at `commitAt`. */
const spokeGh = (pull, commitAt) => ({
  [`repos/example/catalogue-api/pulls/${pull.number}`]: { json: pull },
  [`repos/example/catalogue-api/commits/${pull.head.sha}`]: { json: commit(commitAt) },
});
const valid = (l) => record.validateRecord(Object.fromEntries(Object.entries(l).filter(([k]) => !['_time', '_msg', 'service.name'].includes(k)))).length === 0;

/* ---------------------------------------------------------------------------------- fixtures */

const FIXTURES = [
  {
    n: 1, name: 'the control: a merged design pull request gives one design-merge record, from its last commit to its merge, sent to CubeAPM',
    run: async ({ root, platform }) => {
      const hub = makeHub(root, { url: platform.url });
      const pull = pr({ created: 0, merged: 1200 });
      const r = await run(hub, ['--event', eventFile(root, pull)], { root, gh: hubGh(pull, ['docs/designs/PROJ-102.lld.md', 'docs/designs/PROJ-102.lld-review.md'], 650) });
      const l = platform.lines()[0] || {};
      return [
        r.code === 0 || `exit ${r.code}: ${r.out}`,
        platform.lines().length === 1 || `${platform.lines().length} records sent, expected 1`,
        l.type === 'gate' && l.gate === 'design-merge' && l.story === 'PROJ-102' && l.feature === 'service-version-endpoint' && l.scope === 'story' || `the record is ${l.type} ${l.gate} on ${l.story} (${l.feature})`,
        l.opened_at === at(0) && l.handoff_at === at(650) && l.started_at === at(650) && l.merged_at === at(1200) && l.gate_s === 550 || `the times are ${l.opened_at}, ${l.handoff_at}, ${l.started_at}, ${l.merged_at}, ${l.gate_s} s`,
        l.repository === 'example-hub' && l.pull_request === 2 && l.key_from === 'pull-request' && l.command === null && l.run_id === null || 'the record does not name the hub\'s pull request',
        l.runtime === 'github-actions' && l.collector === 'github-gate/1' && l.harness === 'c15a998e0f1d' && l.hub === 'example-hub' || 'the source fields are wrong',
        l['service.name'] === 'harness' && l._msg === 'gate design-merge PROJ-102' || `the CubeAPM line is ${l['service.name']} / ${l._msg}`,
        valid(l) || 'the record breaks the record rules',
        (platform.seen[0]?.headers.authorization) === `Bearer ${TOKEN}` || 'the write token is not in the Authorization header',
        r.calls.every((c) => c.token === 'gh-token-for-fixtures') || 'gh was not given the workflow\'s token',
        r.out.includes('Gate: design-merge PROJ-102 example-hub#2: gate wait 550 s') && r.out.includes('Sent 1 gate record(s).') || `the report is: ${r.out}`,
      ];
    },
  },
  {
    n: 2, name: 'a pull request that changes no gate file: no record, exit 0',
    run: async ({ root, platform }) => {
      const hub = makeHub(root, { url: platform.url });
      const pull = pr();
      const r = await run(hub, ['--event', eventFile(root, pull)], { root, gh: hubGh(pull, ['README.md', 'docs/backlog/jira/PROJ-9.ticket.md'], 650) });
      return [
        r.code === 0 && r.out.includes('merged no gate') && r.out.includes('No gate record to send.') || `exit ${r.code}: ${r.out}`,
        platform.seen.length === 0 || 'something was sent',
      ];
    },
  },
  {
    n: 3, name: 'one pull request that merges the requirements and the decomposition of a feature: two records, each with its own gate, and the requirements routed to the feature owner',
    run: async ({ root, platform }) => {
      const hub = makeHub(root, { url: platform.url });
      const pull = pr({ head: 'requirements/service-version-endpoint' });
      const files = ['docs/requirements/service-version-endpoint/requirements.md', 'docs/backlog/service-version-endpoint/decomposition.md', 'docs/backlog/service-version-endpoint/PROJ-102.item.md'];
      const r = await run(hub, ['--event', eventFile(root, pull)], { root, gh: hubGh(pull, files, 650) });
      const lines = platform.lines();
      const of = (g) => lines.find((l) => l.gate === g) || {};
      return [
        r.code === 0 || `exit ${r.code}: ${r.out}`,
        lines.length === 2 || `${lines.length} records, expected 2`,
        of('requirements-merge').routed_to === 'feature-owner' && of('decomposition-merge').routed_to === null || 'the roles are wrong',
        lines.every((l) => l.scope === 'feature' && l.feature === 'service-version-endpoint' && l.story === null && valid(l)) || 'a feature record has the wrong key or breaks the rules',
        new Set(lines.map((l) => l.record_id)).size === 2 || 'the two gates share a record id',
      ];
    },
  },
  {
    n: 4, name: 'a pull request that closed without a merge, and one that merged into another branch: no record, exit 0',
    run: async ({ root, platform }) => {
      const hub = makeHub(root, { url: platform.url });
      const closed = pr({ merged: null });
      const a = await run(hub, ['--event', eventFile(root, closed)], { root, gh: hubGh(closed, ['docs/designs/PROJ-102.lld.md'], 650) });
      const other = pr({ base: 'release/0.9' });
      const b = await run(hub, ['--event', eventFile(root, other)], { root, gh: hubGh(other, ['docs/designs/PROJ-102.lld.md'], 650) });
      return [
        a.code === 0 && a.out.includes('closed without a merge') || `the unmerged pull request: exit ${a.code}: ${a.out}`,
        b.code === 0 && b.out.includes('not the trunk') || `the other branch: exit ${b.code}: ${b.out}`,
        platform.seen.length === 0 || 'something was sent',
      ];
    },
  },
  {
    n: 5, name: 'a hub pull request sent again by its number gives the same record, with the same id, as its event',
    run: async ({ root, platform }) => {
      const hub = makeHub(root, { url: platform.url });
      const pull = pr();
      const gh = hubGh(pull, ['docs/designs/PROJ-102.lld.md'], 650);
      await run(hub, ['--event', eventFile(root, pull)], { root, gh });
      const r = await run(hub, ['--pull-request', '2'], { root, gh });
      const [first, second] = platform.lines();
      return [
        r.code === 0 || `exit ${r.code}: ${r.out}`,
        first && second && first.record_id === second.record_id && first.gate_s === second.gate_s || 'the second send gave another record',
      ];
    },
  },
  {
    n: 6, name: 'a spoke\'s signal: the hub reads the story\'s code merge from the spoke\'s API, and the gate wait starts at the validation report\'s merge, after the last commit',
    run: async ({ root, platform }) => {
      const hub = makeHub(root, { url: platform.url, validationAt: 900 });
      const pull = pr({ number: 3, created: 100, merged: 1500, sha: SHA('b') });
      const r = await run(hub, ['--pull-request', '3', '--spoke', 'catalogue-api'], { root, gh: spokeGh(pull, 700) });
      const l = platform.lines()[0] || {};
      return [
        r.code === 0 || `exit ${r.code}: ${r.out}`,
        l.gate === 'story-merge' && l.story === 'PROJ-102' && l.feature === 'service-version-endpoint' && l.repository === 'catalogue-api' && l.pull_request === 3 || `the record is ${l.gate} ${l.story} ${l.repository}#${l.pull_request}`,
        l.handoff_at === at(700) && l.started_at === at(900) && l.merged_at === at(1500) && l.gate_s === 600 || `the times are ${l.handoff_at}, ${l.started_at}, ${l.merged_at}, ${l.gate_s} s`,
        valid(l) || 'the record breaks the record rules',
        r.calls.some((c) => c.path === 'repos/example/catalogue-api/pulls/3') || 'the hub did not read the pull request from the spoke',
      ];
    },
  },
  {
    n: 7, name: 'a story merge whose last commit came after the validation merge: the gate wait starts at the last commit',
    run: async ({ root, platform }) => {
      const hub = makeHub(root, { url: platform.url, validationAt: 300 });
      const pull = pr({ number: 3, created: 100, merged: 1500, sha: SHA('b') });
      const r = await run(hub, ['--pull-request', '3', '--spoke', 'catalogue-api'], { root, gh: spokeGh(pull, 700) });
      const l = platform.lines()[0] || {};
      return [
        r.code === 0 || `exit ${r.code}: ${r.out}`,
        l.started_at === at(700) && l.gate_s === 800 || `the gate wait starts ${l.started_at}, ${l.gate_s} s`,
      ];
    },
  },
  {
    n: 8, name: 'a signal for a story whose design names another spoke, and one from a branch that names no story: no record, exit 0',
    run: async ({ root, platform }) => {
      const hub = makeHub(root, { url: platform.url, designRepo: 'orders-api' });
      const pull = pr({ number: 3, sha: SHA('b') });
      const a = await run(hub, ['--pull-request', '3', '--spoke', 'catalogue-api'], { root, gh: spokeGh(pull, 700) });
      const sync = pr({ number: 4, head: 'sync/main', sha: SHA('c') });
      const b = await run(hub, ['--pull-request', '4', '--spoke', 'catalogue-api'], { root, gh: spokeGh(sync, 700) });
      return [
        a.code === 0 && a.out.includes('names orders-api, not catalogue-api') || `another spoke's story: exit ${a.code}: ${a.out}`,
        b.code === 0 && b.out.includes('which names no story') || `a sync branch: exit ${b.code}: ${b.out}`,
        platform.seen.length === 0 || 'something was sent',
      ];
    },
  },
  {
    n: 9, name: 'a signal from a spoke that the hub\'s registry does not list: exit 1, REASON not-registered, nothing asked of GitHub',
    run: async ({ root, platform }) => {
      const hub = makeHub(root, { url: platform.url });
      const r = await run(hub, ['--pull-request', '3', '--spoke', 'unknown-api'], { root, gh: {} });
      return [
        r.code === 1 && r.out.includes('does not list unknown-api') && r.out.includes('REASON: not-registered') || `exit ${r.code}: ${r.out}`,
        r.calls.length === 0 || 'gh was asked for a spoke that the hub does not know',
        platform.seen.length === 0 || 'something was sent',
      ];
    },
  },
  {
    n: 10, name: 'a story merge into a branch that is not the spoke\'s harness trunk: no record',
    run: async ({ root, platform }) => {
      const hub = makeHub(root, { url: platform.url });
      // A BAU pull request: it merges into main, and the default branch of a shared spoke is bcg_main.
      const pull = pr({ number: 3, sha: SHA('b'), base: 'main', defaultBranch: 'bcg_main' });
      const r = await run(hub, ['--pull-request', '3', '--spoke', 'catalogue-api'], { root, gh: spokeGh(pull, 700) });
      return [
        r.code === 0 && r.out.includes('not the harness trunk bcg_main') || `exit ${r.code}: ${r.out}`,
        platform.seen.length === 0 || 'something was sent',
      ];
    },
  },
  {
    n: 11, name: 'the observability platform refuses the record: exit 1',
    plan: [{ status: 400, answer: 'bad record' }],
    run: async ({ root, platform }) => {
      const hub = makeHub(root, { url: platform.url });
      const pull = pr();
      const r = await run(hub, ['--event', eventFile(root, pull)], { root, gh: hubGh(pull, ['docs/designs/PROJ-102.lld.md'], 650) });
      return [r.code === 1 && r.out.includes('Refused: the observability platform answered 400: bad record') || `exit ${r.code}: ${r.out}`];
    },
  },
  {
    n: 12, name: 'an observability platform that does not answer: exit 2, REASON platform-unreachable, and the HARNESS EXIT line',
    run: async ({ root }) => {
      const hub = makeHub(root, { url: 'http://127.0.0.1:9' });
      const pull = pr();
      const r = await run(hub, ['--event', eventFile(root, pull)], { root, gh: hubGh(pull, ['docs/designs/PROJ-102.lld.md'], 650), env: { HARNESS_OBSERVABILITY_TIMEOUT_MS: '2000' } });
      return [
        r.code === 2 && r.out.includes('CANNOT VERIFY: the observability platform could not be reached') || `exit ${r.code}: ${r.out}`,
        r.out.includes('REASON: platform-unreachable') && r.out.trimEnd().endsWith('HARNESS EXIT: observability-gate 2') || `the last lines are: ${r.out.trimEnd().split('\n').slice(-2).join(' | ')}`,
      ];
    },
  },
  {
    n: 13, name: 'gh cannot read the pull request: exit 2, REASON gh-failed, nothing sent',
    run: async ({ root, platform }) => {
      const hub = makeHub(root, { url: platform.url });
      const pull = pr();
      const r = await run(hub, ['--event', eventFile(root, pull)], { root, gh: { [`repos/example/hub/pulls/2/files?per_page=100`]: { fail: 'HTTP 401: Bad credentials' } } });
      return [
        r.code === 2 && r.out.includes('HTTP 401: Bad credentials') && r.out.includes('REASON: gh-failed') || `exit ${r.code}: ${r.out}`,
        platform.seen.length === 0 || 'something was sent',
      ];
    },
  },
  {
    n: 14, name: 'no HARNESS_OBSERVABILITY_TOKEN for a hub that uses bearer: exit 2, REASON credential-missing. With "auth": "none", the record leaves with no Authorization header',
    run: async ({ root, platform }) => {
      const bearer = makeHub(join(root, 'bearer'), { url: platform.url });
      const pull = pr();
      const a = await run(bearer, ['--event', eventFile(root, pull)], { root, gh: hubGh(pull, ['docs/designs/PROJ-102.lld.md'], 650), token: null });
      const none = makeHub(join(root, 'none'), { url: platform.url, auth: 'none' });
      const b = await run(none, ['--event', eventFile(root, pull)], { root, gh: hubGh(pull, ['docs/designs/PROJ-102.lld.md'], 650) });
      return [
        a.code === 2 && a.out.includes('REASON: credential-missing') || `bearer with no token: exit ${a.code}: ${a.out}`,
        b.code === 0 && platform.seen.length === 1 && !platform.seen[0].headers.authorization || `"auth": "none": exit ${b.code}, ${platform.seen.length} request(s)`,
      ];
    },
  },
  {
    n: 15, name: '--dry-run prints the records and sends nothing',
    run: async ({ root, platform }) => {
      const hub = makeHub(root, { url: platform.url });
      const pull = pr();
      const r = await run(hub, ['--event', eventFile(root, pull), '--dry-run'], { root, gh: hubGh(pull, ['docs/designs/PROJ-102.lld.md'], 650) });
      return [
        r.code === 0 && r.out.includes('Dry run: 1 record(s), nothing sent.') && r.out.includes('"type":"gate"') || `exit ${r.code}: ${r.out}`,
        platform.seen.length === 0 || 'a dry run sent something',
      ];
    },
  },
  {
    n: 16, name: 'a usage error: exit 3 and the usage, with no record',
    run: async ({ root, platform }) => {
      const hub = makeHub(root, { url: platform.url });
      const a = await run(hub, ['--spoke', 'catalogue-api'], { root });
      const b = await run(hub, ['--event', join(root, 'event.json'), '--pull-request', '2'], { root });
      return [
        a.code === 3 && a.out.includes('usage: node scripts/observability-gate.mjs') || `--spoke alone: exit ${a.code}: ${a.out}`,
        b.code === 3 && b.out.includes('give one of --event or --pull-request') || `--event with --pull-request: exit ${b.code}: ${b.out}`,
        platform.seen.length === 0 || 'something was sent',
      ];
    },
  },
  {
    n: 17, name: 'a hub with Jira: a story\'s gate names its ticket and its feature\'s Epic, and a feature\'s gate names the Epic and no ticket',
    run: async ({ root, platform }) => {
      const hub = makeHub(root, { url: platform.url, jira: true, validationAt: 900 });
      const design = pr();
      const a = await run(hub, ['--event', eventFile(root, design)], { root, gh: hubGh(design, ['docs/designs/PROJ-102.lld.md'], 650) });
      const req = pr({ number: 5, head: 'requirements/service-version-endpoint', sha: SHA('e') });
      const b = await run(hub, ['--event', eventFile(root, req)], { root, gh: hubGh(req, ['docs/requirements/service-version-endpoint/requirements.md'], 650) });
      const code = pr({ number: 3, created: 100, merged: 1500, sha: SHA('b') });
      const c = await run(hub, ['--pull-request', '3', '--spoke', 'catalogue-api'], { root, gh: spokeGh(code, 700) });
      const of = (g) => platform.lines().find((l) => l.gate === g) || {};
      const ticket = 'https://acme.atlassian.net/browse/PLAT-345';
      const epic = 'https://acme.atlassian.net/browse/PLAT-10';
      return [
        a.code === 0 && b.code === 0 && c.code === 0 || `exits ${a.code}, ${b.code}, ${c.code}: ${a.out} ${b.out} ${c.out}`,
        of('design-merge').ticket_url === ticket && of('design-merge').epic === 'PLAT-10' && of('design-merge').epic_url === epic || `the design's links are ${of('design-merge').ticket_url}, ${of('design-merge').epic}`,
        of('story-merge').ticket_url === ticket && of('story-merge').epic_url === epic || `the code merge's links are ${of('story-merge').ticket_url}, ${of('story-merge').epic_url}`,
        of('requirements-merge').ticket_url === null && of('requirements-merge').epic === 'PLAT-10' || `the requirements' links are ${of('requirements-merge').ticket_url}, ${of('requirements-merge').epic}`,
        platform.lines().every(valid) || 'a record breaks the record rules',
      ];
    },
  },
];

/* ------------------------------------------------------------------------------------ runner */

/** A fake gh first on PATH: it answers each api path from FAKE_GH_DATA and writes one line for each call to FAKE_GH_CALLS. */
function fakeGh(sandbox) {
  const bin = join(sandbox, 'bin');
  mkdirSync(bin, { recursive: true });
  const script = join(bin, 'fake-gh.mjs');
  writeFileSync(script, [
    "import { appendFileSync, readFileSync } from 'node:fs';",
    'const args = process.argv.slice(2);',
    'const path = args.at(-1);',
    "appendFileSync(process.env.FAKE_GH_CALLS, `${JSON.stringify({ args, path, token: process.env.GH_TOKEN ?? null, host: process.env.GH_HOST ?? null })}\\n`);",
    "const answers = JSON.parse(readFileSync(process.env.FAKE_GH_DATA, 'utf8'));",
    'const a = answers[path];',
    "if (!a) { process.stderr.write(`gh: Not Found (HTTP 404) for ${path}\\n`); process.exit(1); }",
    "if (a.fail) { process.stderr.write(`gh: ${a.fail}\\n`); process.exit(1); }",
    "process.stdout.write(a.out ?? JSON.stringify(a.json));",
  ].join('\n'));
  writeFileSync(join(bin, 'gh'), `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
  chmodSync(join(bin, 'gh'), 0o755);
  process.env.PATH = `${bin}${delimiter}${process.env.PATH}`;
}

async function runFixture(f, sandbox) {
  const root = mkdtempSync(join(sandbox, `f${f.n}-`));
  const platform = await fakePlatform(f.plan);
  try {
    const results = await f.run({ root, platform });
    return results.filter((p) => p !== true).map(String);
  } catch (err) {
    return [`the fixture threw: ${err && err.stack ? err.stack.split('\n').slice(0, 3).join(' | ') : String(err)}`];
  } finally {
    await platform.close();
    if (!KEEP) rmSync(root, { recursive: true, force: true });
  }
}

async function main() {
  const sandbox = mkdtempSync(join(tmpdir(), 'observability-gate-'));
  // A private HOME, so a developer's gitconfig cannot change a result.
  Object.assign(process.env, {
    HOME: sandbox, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
  });
  for (const k of ['HARNESS_OBSERVABILITY_NOW', 'HARNESS_OBSERVABILITY_TIMEOUT_MS', 'HARNESS_TRUNK', 'HARNESS_OBSERVABILITY_TOKEN', 'GH_HOST', 'GITHUB_TOKEN']) delete process.env[k];
  fakeGh(sandbox);
  const wanted = process.argv.slice(2).filter((a) => a.search(/^\d+$/) === 0).map(Number);
  const selected = wanted.length ? FIXTURES.filter((f) => wanted.includes(f.n)) : FIXTURES;
  let failed = 0;
  for (const f of selected) {
    const problems = await runFixture(f, sandbox);
    if (problems.length) {
      failed += 1;
      process.stdout.write(`  FAIL  ${f.n}. ${f.name}\n`);
      for (const p of problems) process.stdout.write(`          - ${p}\n`);
    } else {
      process.stdout.write(`  PASS  ${f.n}. ${f.name}\n`);
    }
  }
  if (!KEEP) rmSync(sandbox, { recursive: true, force: true });
  else process.stdout.write(`\nThe throwaway hubs are kept under ${sandbox}\n`);
  process.stdout.write(failed
    ? `\n${failed} of ${selected.length} fixtures FAILED. The gate records are not trustworthy until this is green.\n`
    : `\nAll ${selected.length} fixtures passed.\n`);
  process.exit(failed ? 1 : 0);
}

await main();

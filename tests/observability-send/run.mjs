#!/usr/bin/env node
// Part of the harness asset library c6f3b4427d58f7c3 (see VERSION.json) · 2026-10-26
/**
 * run.mjs — the fixture suite for the sender (observability-send.mjs), the platform adapters and
 * the status command (observability-status.mjs).
 *
 *   usage:  node run.mjs            run every fixture
 *           node run.mjs 3 7        run only the numbered fixtures
 *           node run.mjs --keep     leave the throwaway hubs on disk
 *
 * A fixture is a HUB STATE: a throwaway hub with a real bare origin, a story's item file on its
 * trunk, and records in its queue that the collection core put there. A fake observability platform
 * listens on this laptop and answers as each fixture says. The shipped sender and status command
 * run in the hub as a person runs them. No fixture reaches the network.
 *
 * Fixture 1 is the full control. Every other fixture changes one thing.
 *
 * Reads the whole tree it is installed in. scripts/upgrade.mjs reads that line literally: the
 * modules under scripts/observability/ are not scripts it can trace, so this suite runs on every
 * upgrade.
 *
 * Node standard library only. No test framework.
 * Exit 0 if every fixture passes, 1 if any fails, 4 if the code under test cannot be found.
 */

import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

// Two layouts: the library, where the modules sit at ../../observability/; and an adopting hub,
// where this suite lands at tests/observability-send/ and the modules at scripts/observability/.
const first = (...c) => c.filter(Boolean).find((p) => existsSync(join(p, 'sender.mjs')));
const CORE = first(
  process.env.HARNESS_OBSERVABILITY_DIR,
  resolve(HERE, '..', '..', 'observability'),
  resolve(HERE, '..', '..', 'scripts', 'observability'),
);
if (!CORE) {
  console.error('cannot locate the observability modules. Set HARNESS_OBSERVABILITY_DIR=/path/to/scripts/observability.');
  process.exit(4);
}
// The two commands and the hook sit beside the modules' folder in both layouts.
const SENDER = resolve(CORE, '..', 'observability-send.mjs');
const STATUS = resolve(CORE, '..', 'observability-status.mjs');
const HOOK = resolve(CORE, '..', 'observability-hook.mjs');
const LIBRARY_LAYOUT = CORE === resolve(HERE, '..', '..', 'observability');
const GOVERNANCE = resolve(HERE, '..', '..', '..', 'governance');

const KEEP = process.argv.includes('--keep');
const load = (name) => import(pathToFileURL(join(CORE, name)).href);
const core = {
  collect: await load('collect.mjs'),
  common: await load('common.mjs'),
  config: await load('config.mjs'),
  prices: await load('prices.mjs'),
  record: await load('record.mjs'),
  runs: await load('runs.mjs'),
  sender: await load('sender.mjs'),
  state: await load('state.mjs'),
};

const TOKEN = 'token-for-fixtures-only';
const T0 = Date.parse('2026-10-26T10:00:00Z');
const REGISTRY = [{ agent_id: 'engineer' }];
const RECEIPT = { schema_version: 1, library: { harnessVersion: '0.9.4', libraryCommit: 'c15a998e0f1d2c3b4a5968778695a4b3c2d1e0f9' }, files: {} };

/* ---------------------------------------------------------------------- the fake observability platform */

/**
 * An observability platform on this laptop. `plan` says how it answers each request in turn: { status,
 * answer, type, hang }. A fixture can set `onRequest(n)`, which runs before the answer to request n.
 */
function fakePlatform(plan = [{ status: 204 }]) {
  const seen = [];
  const sockets = new Set();
  const api = { seen, onRequest: null };
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      if (api.onRequest) api.onRequest(seen.length);
      const step = plan[Math.min(seen.length - 1, plan.length - 1)];
      if (step.hang) return;
      res.writeHead(step.status, { 'content-type': step.type || 'text/plain' });
      res.end(step.answer || '');
    });
  });
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  return new Promise((done) => server.listen(0, '127.0.0.1', () => done(Object.assign(api, {
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((d) => {
      for (const s of sockets) { s.destroy(); }
      server.close(() => d());
    }),
  }))));
}

/** A port on this laptop where nothing listens: a server takes it, then closes. */
function closedPort() {
  const server = createServer();
  return new Promise((done) => server.listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    server.close(() => done(port));
  }));
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

/** A hub with a bare origin, PROJ-102's item file under its feature on the trunk, and observability.json naming `url`. */
function makeHub(root, { url, platform = 'cubeapm', connection } = {}) {
  const origin = join(root, 'origin.git');
  const hub = join(root, 'hub');
  mkdirSync(root, { recursive: true });
  git(root, 'init', '-q', '--bare', origin);
  git(root, 'init', '-q', hub);
  git(hub, 'checkout', '-q', '-b', 'main');
  write(hub, '.gitignore', '.worktrees/\n.harness/\n');
  write(hub, 'docs/estate/observability.json', `${JSON.stringify(connection ?? { schema_version: 1, hub: 'example-hub', platform, url }, null, 2)}\n`);
  write(hub, 'governance/agent-registry.json', `${JSON.stringify(REGISTRY)}\n`);
  write(hub, 'docs/harness-install.json', `${JSON.stringify(RECEIPT)}\n`);
  write(hub, 'docs/backlog/service-version-endpoint/PROJ-102.item.md', '# PROJ-102\n');
  git(hub, 'add', '-A');
  git(hub, 'commit', '-q', '-m', 'hub');
  git(hub, 'remote', 'add', 'origin', origin);
  git(hub, 'push', '-q', 'origin', 'main');
  return hub;
}

/** Commits `files` on the hub's main and pushes it, so `origin/main` holds them. With `push: false` the commit stays local. */
function onTrunk(hub, files, { push = true } = {}) {
  for (const [rel, text] of Object.entries(files)) write(hub, rel, typeof text === 'string' ? text : `${JSON.stringify(text, null, 2)}\n`);
  git(hub, 'add', '-A');
  git(hub, 'commit', '-q', '-m', 'trunk files');
  if (push) git(hub, 'push', '-q', 'origin', 'main');
}

/** The Jira connection: one instance on acme.atlassian.net, as /connect-jira writes it. */
const TRACKERS = { schema_version: 1, instances: { acme: { kind: 'jira-cloud', site: 'Acme.Atlassian.net', auth: { method: 'api-token', user_env: 'JIRA_USER', token_env: 'JIRA_API_TOKEN' } } }, default_board: 'platform' };
/** The link file of service-version-endpoint: PROJ-102's ticket PLAT-345 under the Epic PLAT-10, and a defect's sub-task. */
const LINKS = {
  schema_version: 1, slug: 'service-version-endpoint', epic: 'acme:PLAT-10',
  items: {
    'PROJ-102': { type: 'story', board: 'platform', ticket: 'acme:PLAT-345' },
    'PROJ-103': { type: 'defect', board: 'platform', ticket: 'acme:PLAT-346', parent: 'PROJ-102' },
  },
};
const LINKS_PATH = 'docs/estate/tracker-links/service-version-endpoint.json';
const STORY_URL = 'https://acme.atlassian.net/browse/PLAT-345';
const EPIC_URL = 'https://acme.atlassian.net/browse/PLAT-10';

const counts = (c = {}) => core.common.cleanCounts({ input: 10, cache_read: 1000, cache_write: 100, cache_write_5m: 100, cache_write_1h: 0, output: 50, ...c });

/** Queues records through the collection core: one run opened at T0 by `prompt`, then one call per model. */
function queue(hub, { prompt = '/dev-sprint PROJ-102', models = ['claude-opus-5-5'], logs = 1, person = null } = {}) {
  const ctx = core.config.hubContext(hub);
  const key = core.state.bindingKey('claude-code', 's-1');
  const binding = core.state.loadBinding(ctx.dir, key);
  core.runs.openRun(binding, { ...core.runs.parseCommand(prompt), person }, T0);
  core.state.saveBinding(ctx.dir, key, binding);
  for (let l = 0; l < logs; l += 1) {
    const calls = models.map((model, i) => ({ id: `m-${l}-${i}`, ms: T0 + 1000 + i, model, provider: 'anthropic', counts: counts() }));
    core.collect.collect({ ctx, runtime: 'claude-code', collector: 'claude-code/1', session: 's-1', logRef: `log-${l}`, synthetic: true, read: () => ({ calls }) });
  }
  return ctx;
}

/**
 * Queues the work time of one turn of /dev-sprint PROJ-102 through the collection core: two pieces of
 * work around a question of 60 s, the question's wait, and the run's command record once it ends.
 */
function queueTime(hub, { person = null } = {}) {
  const ctx = core.config.hubContext(hub);
  const key = core.state.bindingKey('claude-code', 's-1');
  const binding = core.state.loadBinding(ctx.dir, key);
  core.runs.openRun(binding, { ...core.runs.parseCommand('/dev-sprint PROJ-102'), person }, T0);
  core.state.saveBinding(ctx.dir, key, binding);
  const at = (s) => T0 + s * 1000;
  const events = [
    { at: at(0), kind: 'prompt', by: 'human' }, { at: at(0.5), kind: 'request', id: 'r1' },
    { at: at(3), kind: 'answer', ref: 'r1', tools: [{ id: 'q1', name: 'AskUserQuestion' }] },
    { at: at(63), kind: 'result', ids: ['q1'], byPerson: true }, { at: at(63.5), kind: 'request', id: 'r2' },
    { at: at(70), kind: 'answer', ref: 'r2', tools: [] }, { at: at(71), kind: 'turn-end' },
  ];
  const time = { ctx, runtime: 'claude-code', collector: 'claude-code-time/1', session: 's-1', synthetic: true };
  core.collect.collectTime({ ...time, logRef: 'log-main', readTime: () => ({ events, offset: 1, runtimeVersion: '2.1.308' }) });
  const ended = core.state.loadBinding(ctx.dir, key);
  core.runs.endSession(ended, at(80));
  core.state.saveBinding(ctx.dir, key, ended);
  core.collect.finishRuns(time);
  return ctx;
}

/**
 * One run of `prompt` in its own session, with one turn of work from `from` to `to` seconds after
 * T0, through the collection core. The session then ends, so the run's command record is written.
 */
function runWithTurn(hub, { session, prompt, from, to, reply = null, declined = null }) {
  const ctx = core.config.hubContext(hub);
  const key = core.state.bindingKey('claude-code', session);
  const binding = core.state.loadBinding(ctx.dir, key);
  core.runs.openRun(binding, core.runs.parseCommand(prompt), T0 + from * 1000);
  core.state.saveBinding(ctx.dir, key, binding);
  const at = (s) => T0 + s * 1000;
  const turn = (a, b, ref) => [{ at: at(a), kind: 'prompt', by: 'human' }, { at: at(a + 1), kind: 'request', id: ref }, { at: at(b), kind: 'answer', ref, tools: [] }, { at: at(b + 1), kind: 'turn-end' }];
  // With `declined`, the turn asks the person a question at `to`, and the person declines it then.
  const asked = (a, b, ref) => [
    { at: at(a), kind: 'prompt', by: 'human' }, { at: at(a + 1), kind: 'request', id: ref }, { at: at(b), kind: 'answer', ref, tools: [{ id: `${ref}-q`, name: 'AskUserQuestion' }] },
    { at: at(declined), kind: 'result', ids: [`${ref}-q`] }, { at: at(declined) + 5, kind: 'turn-end' },
  ];
  // With `reply`, the person answers at `reply.at`, and a second turn runs to `reply.to`.
  const events = [...(declined ? asked : turn)(from, to, `${session}-1`), ...(reply ? turn(reply.at, reply.to, `${session}-2`) : [])];
  const time = { ctx, runtime: 'claude-code', collector: 'claude-code-time/1', session, synthetic: true };
  core.collect.collectTime({ ...time, logRef: `log-${session}`, readTime: () => ({ events, offset: 1, runtimeVersion: '2.1.308' }) });
  return {
    ctx,
    end: (s) => {
      const ended = core.state.loadBinding(ctx.dir, key);
      core.runs.endSession(ended, at(s));
      core.state.saveBinding(ctx.dir, key, ended);
      core.collect.finishRuns(time);
    },
  };
}
const endedRun = (hub, opts) => { const r = runWithTurn(hub, opts); r.end((opts.reply?.to ?? opts.declined ?? opts.to) + 2); return r.ctx; };

/** git with the committer and author times at `s` seconds after T0. */
function gitAt(cwd, s, ...args) {
  const date = `@${Math.floor((T0 + s * 1000) / 1000)} +0000`;
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_COMMITTER_DATE: date, GIT_AUTHOR_DATE: date } });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
}

/**
 * A pull request merged into the hub's main and pushed: its branch's last commit at `commitAt`, and
 * the merge at `mergeAt`, as GitHub's merge commit or as a squash with its number in the subject.
 * A squash keeps the branch's head under refs/pull/<n>/head, as GitHub does.
 */
function mergePullRequest(repo, { branch, files, commitAt, mergeAt, number, squash = false, subject = 'the change' }) {
  git(repo, 'checkout', '-q', '-b', branch, 'main');
  for (const [rel, text] of Object.entries(files)) write(repo, rel, text);
  gitAt(repo, commitAt, 'add', '-A');
  gitAt(repo, commitAt, 'commit', '-q', '-m', subject);
  const head = git(repo, 'rev-parse', 'HEAD').trim();
  git(repo, 'checkout', '-q', 'main');
  if (squash) {
    gitAt(repo, mergeAt, 'merge', '-q', '--squash', branch);
    gitAt(repo, mergeAt, 'commit', '-q', '-m', `${subject} (#${number})\n\n* ${subject}`);
    git(repo, 'push', '-q', 'origin', `${head}:refs/pull/${number}/head`);
  } else {
    gitAt(repo, mergeAt, 'merge', '-q', '--no-ff', '-m', `Merge pull request #${number} from example/${branch}`, branch);
  }
  git(repo, 'push', '-q', 'origin', 'main');
  git(repo, 'fetch', '-q', 'origin');
}

/** The command record of `command` that the fake platform received, or {}. */
const commandLine = (platform, command) => sentLines(platform).find((l) => l.type === 'command' && l.command === command) || {};
/** A line as the record it carries: without the fields that the CubeAPM adapter adds. */
const asRecord = (l) => Object.fromEntries(Object.entries(l).filter(([k]) => !['_time', '_msg', 'service.name'].includes(k)));
const rulesOk = (l) => core.record.validateRecord(asRecord(l)).length === 0;
const atIso = (s) => new Date(T0 + s * 1000).toISOString();

/** Runs a shipped script in the hub, with the clock at `at` seconds after T0. */
function run(script, hub, { at = 10, token = TOKEN, args = [], env = {} } = {}) {
  return new Promise((done) => {
    const e = { ...process.env, HARNESS_OBSERVABILITY_NOW: new Date(T0 + at * 1000).toISOString(), ...env };
    if (token) e.HARNESS_OBSERVABILITY_TOKEN = token;
    else delete e.HARNESS_OBSERVABILITY_TOKEN;
    const p = spawn(process.execPath, [script, '--hub', hub, ...args], { cwd: hub, env: e });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    const timer = setTimeout(() => p.kill('SIGKILL'), 30000);
    p.on('close', (code) => { clearTimeout(timer); done({ code, out }); });
  });
}

const dirOf = (hub) => join(hub, '.harness', 'observability');
const names = (dir) => (existsSync(dir) ? readdirSync(dir) : []);
const sentLines = (platform) => platform.seen.flatMap((r) => r.body.split('\n').filter(Boolean)).map((l) => JSON.parse(l));

/* ---------------------------------------------------------------------------------- fixtures */

const FIXTURES = [
  {
    n: 1, name: 'the control: two records sent to CubeAPM as JSON lines, priced, with the story\'s feature',
    run: async ({ root, platform }) => {
      const hub = makeHub(root, { url: platform.url });
      queue(hub, { models: ['claude-opus-5-5', 'claude-sonnet-5-5'] });
      const r = await run(SENDER, hub);
      const req = platform.seen[0] || { headers: {} };
      const lines = sentLines(platform);
      return [
        r.code === 0 || `exit ${r.code}: ${r.out}`,
        platform.seen.length === 1 || `${platform.seen.length} requests, expected 1`,
        req.method === 'POST' && req.url === '/api/logs/insert/jsonline?_stream_fields=service.name' || `the request went to ${req.method} ${req.url}`,
        req.headers['content-type'] === 'application/stream+json' || 'the content type is not application/stream+json',
        req.headers.authorization === `Bearer ${TOKEN}` || 'the write token is not in the Authorization header',
        lines.length === 2 || `${lines.length} lines, expected 2`,
        lines.every((l) => l._time === new Date(T0 + 10000).toISOString()) || '_time is not the send time',
        lines.every((l) => l['service.name'] === 'harness' && l.hub === 'example-hub' && l._msg === 'orchestrator PROJ-102') || 'the stream field, the hub or _msg is wrong',
        lines.every((l) => !('env' in l)) || 'a line carries env, which CubeAPM does not keep',
        lines.every((l) => l.story === 'PROJ-102' && l.feature === 'service-version-endpoint') || 'the feature was not found on the trunk',
        lines.every((l) => l.price_table === core.prices.loadPrices().version && typeof l.cost_usd === 'number' && l.cost_usd > 0) || 'a line is not priced',
        lines.every((l) => !('local' in l)) || 'the local part of a queue file left the laptop',
        names(join(dirOf(hub), 'queue')).length === 0 || 'the queue is not empty',
        names(join(dirOf(hub), 'sent')).length === 2 || 'sent/ does not hold the two records',
      ];
    },
  },
  {
    n: 2, name: 'Grafana: one push to its Loki collector, of streams labelled job, hub and type, each record a line',
    run: async ({ root, platform }) => {
      const hub = makeHub(root, { url: platform.url, platform: 'grafana' });
      queue(hub);
      const r = await run(SENDER, hub);
      const req = platform.seen[0] || { headers: {}, body: '{}' };
      const body = JSON.parse(req.body);
      const s = (body.streams || [])[0] || { stream: {}, values: [] };
      const line = s.values[0] ? JSON.parse(s.values[0][1]) : {};
      return [
        r.code === 0 || `exit ${r.code}: ${r.out}`,
        req.url === '/loki/api/v1/push' && req.headers['content-type'] === 'application/json' || 'not a Loki push',
        JSON.stringify(s.stream) === JSON.stringify({ job: 'harness', hub: 'example-hub', type: 'tokens' }) || `the labels are ${JSON.stringify(s.stream)}`,
        s.values[0] && s.values[0][0] === `${BigInt(T0 + 10000) * 1000000n}` || 'the timestamp is not the send time in nanoseconds',
        line.story === 'PROJ-102' && typeof line.run_id === 'string' || 'the line is not the record',
      ];
    },
  },
  {
    n: 3, name: 'no auth field and no HARNESS_OBSERVABILITY_TOKEN: exit 2, nothing sent, the records wait, and the reason offers "auth": "none"',
    run: async ({ root, platform }) => {
      const hub = makeHub(root, { url: platform.url });
      queue(hub);
      const r = await run(SENDER, hub, { token: null });
      const again = await run(SENDER, hub, { token: null, at: 20 });
      const log = existsSync(join(dirOf(hub), 'observability.log')) ? readFileSync(join(dirOf(hub), 'observability.log'), 'utf8') : '';
      const warned = log.split('\n').filter((l) => l.includes('WARN') && l.includes('HARNESS_OBSERVABILITY_TOKEN is not set'));
      return [
        r.code === 2 && again.code === 2 || `exit ${r.code}, then ${again.code}`,
        warned.length === 1 || `observability.log holds ${warned.length} WARN lines about the token, expected 1`,
        !log.includes(TOKEN) || 'the token reached observability.log',
        r.out.includes('HARNESS_OBSERVABILITY_TOKEN is not set') || 'the output does not name HARNESS_OBSERVABILITY_TOKEN',
        r.out.includes('If the receiver needs no key, set "auth": "none" in docs/estate/observability.json') || `the reason does not offer "auth": "none": ${r.out}`,
        platform.seen.length === 0 || 'a request was made',
        names(join(dirOf(hub), 'queue')).length === 1 || 'the record left the queue',
      ];
    },
  },
  {
    n: 4, name: 'a server error keeps the records, and the next try waits: 30 s, then it sends',
    plan: [{ status: 503 }, { status: 204 }],
    run: async ({ root, platform }) => {
      const hub = makeHub(root, { url: platform.url });
      queue(hub);
      const a = await run(SENDER, hub, { at: 10 });
      const st = JSON.parse(readFileSync(join(dirOf(hub), 'send-state.json'), 'utf8'));
      const b = await run(SENDER, hub, { at: 20 });
      const afterB = platform.seen.length;
      const c = await run(SENDER, hub, { at: 41 });
      return [
        a.code === 2 || `the first run exited ${a.code}`,
        st.failures === 1 && st.next_ms === T0 + 40000 || `the wait is wrong: ${JSON.stringify(st)}`,
        b.code === 0 && afterB === 1 || 'the second run did not wait',
        c.code === 0 && platform.seen.length === 2 || 'the third run did not send',
        names(join(dirOf(hub), 'queue')).length === 0 || 'the record is still queued',
        JSON.parse(readFileSync(join(dirOf(hub), 'send-state.json'), 'utf8')).failures === 0 || 'the failures were not reset',
      ];
    },
  },
  {
    n: 5, name: 'a refusal moves the records to refused/ with the observability platform\'s answer, exit 1',
    plan: [{ status: 400, answer: 'field tokens_input is not allowed' }],
    run: async ({ root, platform }) => {
      const hub = makeHub(root, { url: platform.url });
      queue(hub);
      const r = await run(SENDER, hub);
      const refused = names(join(dirOf(hub), 'refused'));
      const entry = refused[0] ? JSON.parse(readFileSync(join(dirOf(hub), 'refused', refused[0]), 'utf8')) : {};
      const s = await run(STATUS, hub);
      return [
        r.code === 1 || `exit ${r.code}`,
        refused.length === 1 && entry.status === 400 && entry.answer === 'field tokens_input is not allowed' || 'refused/ does not hold the record with its answer',
        names(join(dirOf(hub), 'queue')).length === 0 || 'the record is still queued',
        s.code === 1 && s.out.includes('Refused by the observability platform: 1.') || `the status did not report the refusal: ${s.out}`,
      ];
    },
  },
  {
    n: 6, name: 'a request that never answers stops at its time limit, and the records wait',
    plan: [{ hang: true }],
    run: async ({ root, platform }) => {
      const hub = makeHub(root, { url: platform.url });
      queue(hub);
      const started = Date.now();
      const r = await run(SENDER, hub, { env: { HARNESS_OBSERVABILITY_TIMEOUT_MS: '400' } });
      const log = readFileSync(join(dirOf(hub), 'observability.log'), 'utf8');
      return [
        r.code === 2 || `exit ${r.code}`,
        Date.now() - started < 15000 || 'the sender did not stop at its time limit',
        log.includes('time limit') || 'observability.log does not say the request reached its time limit',
        names(join(dirOf(hub), 'queue')).length === 1 || 'the record left the queue',
      ];
    },
  },
  {
    n: 7, name: 'a /feature record waits for its slug, then leaves with it',
    run: async ({ root, platform }) => {
      const hub = makeHub(root, { url: platform.url });
      const ctx = queue(hub, { prompt: '/feature build a version endpoint' });
      const a = await run(SENDER, hub, { at: 20 });
      const key = core.state.bindingKey('claude-code', 's-1');
      const binding = core.state.loadBinding(ctx.dir, key);
      core.runs.fillKey(binding.runs[0], { feature: 'service-version-endpoint' });
      core.state.saveBinding(ctx.dir, key, binding);
      const b = await run(SENDER, hub, { at: 30 });
      const lines = sentLines(platform);
      return [
        a.code === 0 && a.out.includes('Waiting for a key: 1') || `the record did not wait: ${a.out}`,
        b.code === 0 && lines.length === 1 && lines[0].feature === 'service-version-endpoint' && lines[0].story === null || 'the record did not leave with its slug',
        lines.length === 1 && lines[0].scope === 'feature' && lines[0].key_from === 'branch' || `the record left in the bucket ${lines[0]?.scope}, ${lines[0]?.key_from}`,
      ];
    },
  },
  {
    n: 8, name: 'a record waits for its key 24 hours at most, then leaves without it',
    run: async ({ root, platform }) => {
      const hub = makeHub(root, { url: platform.url });
      queue(hub, { prompt: '/feature build a version endpoint' });
      const created = JSON.parse(readFileSync(join(dirOf(hub), 'queue', names(join(dirOf(hub), 'queue'))[0]), 'utf8')).local.created_ms;
      const at = (created - T0) / 1000 + 24 * 3600 + 1;
      const r = await run(SENDER, hub, { at });
      const lines = sentLines(platform);
      return [
        r.code === 0 || `exit ${r.code}`,
        lines.length === 1 && lines[0].feature === null && lines[0].command === 'feature' || 'the record did not leave without its key',
        lines.length === 1 && lines[0].scope === 'none' && lines[0].key_from === null || `the record left in the bucket ${lines[0]?.scope}, ${lines[0]?.key_from}`,
      ];
    },
  },
  {
    n: 9, name: 'a story with no item file on the trunk leaves with no feature, never a guess',
    run: async ({ root, platform }) => {
      const hub = makeHub(root, { url: platform.url });
      queue(hub, { prompt: '/dev-sprint PROJ-999' });
      await run(SENDER, hub);
      const lines = sentLines(platform);
      return [lines.length === 1 && lines[0].story === 'PROJ-999' && lines[0].feature === null || 'the feature was guessed'];
    },
  },
  {
    n: 10, name: 'a model with no list price leaves with no cost, and observability.log names the model',
    run: async ({ root, platform }) => {
      const hub = makeHub(root, { url: platform.url });
      queue(hub, { models: ['claude-unknown-9'] });
      await run(SENDER, hub);
      const lines = sentLines(platform);
      const log = readFileSync(join(dirOf(hub), 'observability.log'), 'utf8');
      return [lines.length === 1 && lines[0].cost_usd === null || 'the record has a cost', log.includes('no list price for anthropic/claude-unknown-9') || 'observability.log does not name the model'];
    },
  },
  {
    n: 11, name: 'a second sender while one runs returns at once, and sends nothing',
    run: async ({ root, platform }) => {
      const hub = makeHub(root, { url: platform.url });
      queue(hub);
      writeFileSync(join(dirOf(hub), 'send.lock'), '99999\n');
      const r = await run(SENDER, hub);
      return [r.code === 0 && r.out.includes('Another sender') || `the sender did not step aside: ${r.out}`, platform.seen.length === 0 || 'a request was made'];
    },
  },
  {
    n: 12, name: 'sent/ keeps 30 days: an older file is removed, a newer one stays',
    run: async ({ root, platform }) => {
      const hub = makeHub(root, { url: platform.url });
      queue(hub);
      const sent = join(dirOf(hub), 'sent');
      mkdirSync(sent, { recursive: true });
      writeFileSync(join(sent, 'old.json'), '{}\n');
      writeFileSync(join(sent, 'recent.json'), '{}\n');
      const day = 24 * 3600;
      utimesSync(join(sent, 'old.json'), Date.now() / 1000 - 31 * day, Date.now() / 1000 - 31 * day);
      utimesSync(join(sent, 'recent.json'), Date.now() / 1000 - day, Date.now() / 1000 - day);
      await run(SENDER, hub);
      const left = names(sent);
      return [!left.includes('old.json') || 'the old file was kept', left.includes('recent.json') || 'the recent file was removed'];
    },
  },
  {
    n: 13, name: 'more records than one batch go in several requests of 50 at most',
    run: async ({ root, platform }) => {
      const hub = makeHub(root, { url: platform.url });
      queue(hub, { logs: 120 });
      const r = await run(SENDER, hub);
      const sizes = platform.seen.map((x) => x.body.split('\n').filter(Boolean).length);
      return [r.code === 0 || `exit ${r.code}`, JSON.stringify(sizes) === '[50,50,20]' || `the batches are ${JSON.stringify(sizes)}`];
    },
  },
  {
    n: 14, name: 'the status: counts, exit 0, and the token never printed',
    run: async ({ root, platform }) => {
      const hub = makeHub(root, { url: platform.url });
      queue(hub, { models: ['claude-opus-5-5', 'claude-sonnet-5-5'] });
      const r = await run(STATUS, hub);
      return [r.code === 0 || `exit ${r.code}`, r.out.includes('Queue: 2 ready to send, 0 waiting for a key, 0 pending.') || `the counts are wrong: ${r.out}`, r.out.includes('Authorisation: bearer. HARNESS_OBSERVABILITY_TOKEN: set.') || 'the bearer mode and the token are not reported', !r.out.includes(TOKEN) || 'the token was printed'];
    },
  },
  {
    n: 15, name: 'the status of a hub without observability.json is exit 2, names /connect-observability-platform, its reason and its exit line, and an unknown argument exit 3',
    run: async ({ root, platform }) => {
      const hub = makeHub(root, { url: platform.url });
      rmSync(join(hub, 'docs', 'estate', 'observability.json'));
      const a = await run(STATUS, hub);
      const b = await run(STATUS, hub, { args: ['--verbose'] });
      return [
        a.code === 2 && a.out.includes('CANNOT VERIFY: docs/estate/observability.json is missing') || `exit ${a.code}: ${a.out}`,
        a.out.includes('Run /connect-observability-platform to connect it.') || `the line does not name /connect-observability-platform: ${a.out}`,
        a.out.includes('\nREASON: config-invalid\n') && a.out.includes('\nHARNESS EXIT: observability-status 2\n') || `the reason or the exit line is missing: ${a.out}`,
        b.code === 3 || `an unknown argument exited ${b.code}`,
      ];
    },
  },
  {
    n: 16, name: 'the example observability.json is valid, and the schema agrees with config.mjs',
    run: () => {
      if (!LIBRARY_LAYOUT) return [true];
      const example = JSON.parse(readFileSync(join(GOVERNANCE, 'observability.example.json'), 'utf8'));
      const schema = JSON.parse(readFileSync(join(GOVERNANCE, 'observability.schema.json'), 'utf8'));
      return [
        core.config.validateConnection(example).length === 0 || `the example is invalid: ${core.config.validateConnection(example).join(' · ')}`,
        JSON.stringify(schema.properties.platform.enum) === JSON.stringify(core.config.PLATFORMS) || 'the schema\'s platforms differ from config.mjs',
        JSON.stringify(schema.properties.auth.enum) === JSON.stringify(core.config.AUTHS) && schema.properties.auth.default === 'bearer' || 'the schema\'s auth differs from config.mjs, or its default is not bearer',
        JSON.stringify(schema.required) === JSON.stringify(['schema_version', 'hub', 'platform', 'url']) || 'the schema\'s required fields changed',
      ];
    },
  },
  {
    n: 17, name: 'observability.json may name http only on this laptop: http to another host is refused',
    run: () => {
      const ok = (url) => core.config.validateConnection({ schema_version: 1, hub: 'h', platform: 'grafana', url }).length === 0;
      return [
        ok('https://grafana.example.invalid') || 'https was refused',
        ok('http://127.0.0.1:3100') && ok('http://localhost:3130') || 'http to this laptop was refused',
        !ok('http://grafana.example.invalid') || 'http to another host was allowed',
        !ok('https://user:pw@grafana.example.invalid') || 'a URL with a credential was allowed',
      ];
    },
  },
  {
    n: 18, name: 'end to end: the hook queues a Claude Code turn and starts the sender, and the record reaches the observability platform',
    run: async ({ root, platform }) => {
      const hub = makeHub(root, { url: platform.url });
      const transcript = join(root, 'transcripts', 's-e2e.jsonl');
      const at = (s) => new Date(T0 + s * 1000).toISOString();
      const usage = { input_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 100, output_tokens: 50 };
      write(root, 'transcripts/s-e2e.jsonl', `${JSON.stringify({ type: 'assistant', isSidechain: false, sessionId: 's-e2e', version: '2.1.308', timestamp: at(2), message: { id: 'msg_e2e_1', role: 'assistant', model: 'claude-opus-5-5', usage } })}\n`);
      const env = { ...process.env, CLAUDE_PROJECT_DIR: hub, HARNESS_OBSERVABILITY_TOKEN: TOKEN };
      delete env.HARNESS_OBSERVABILITY_SENDER;
      const hook = (s, event) => spawnSync(process.execPath, [HOOK, 'claude-code'], {
        input: JSON.stringify({ session_id: 's-e2e', transcript_path: transcript, cwd: hub, ...event }),
        encoding: 'utf8', timeout: 30000, env: { ...env, HARNESS_OBSERVABILITY_NOW: at(s) },
      });
      const a = hook(1, { hook_event_name: 'UserPromptSubmit', prompt: '/dev-sprint PROJ-102' });
      const b = hook(3, { hook_event_name: 'Stop' });
      // The hook starts the sender in the background and returns at once, so the fixture waits until the
      // sender has finished: a record in sent/, and its lock released. It writes nothing after that.
      const deadline = Date.now() + 15000;
      const busy = () => names(join(dirOf(hub), 'sent')).length === 0 || existsSync(join(dirOf(hub), 'send.lock'));
      while (busy() && Date.now() < deadline) await new Promise((d) => setTimeout(d, 100));
      const lines = sentLines(platform);
      return [
        a.status === 0 && b.status === 0 && `${a.stdout}${a.stderr}${b.stdout}${b.stderr}` === '' || 'the hook did not exit 0 in silence',
        lines.length === 1 || `the observability platform received ${lines.length} records, expected 1`,
        lines.length !== 1 || (lines[0].story === 'PROJ-102' && lines[0].feature === 'service-version-endpoint' && lines[0].agent === 'orchestrator' && lines[0].tokens_cache_read === 1000) || `the record is wrong: ${JSON.stringify(lines[0])}`,
        names(join(dirOf(hub), 'queue')).length === 0 || 'the queue is not empty',
      ];
    },
  },
  {
    n: 19, name: 'the status of a hub whose observability.json is not JSON says so, exit 2, and does not offer /connect-observability-platform',
    run: async ({ root, platform }) => {
      const hub = makeHub(root, { url: platform.url });
      writeFileSync(join(hub, 'docs', 'estate', 'observability.json'), '{ not json');
      const r = await run(STATUS, hub);
      return [
        r.code === 2 && r.out.includes('CANNOT VERIFY: docs/estate/observability.json is not valid JSON') || `exit ${r.code}: ${r.out}`,
        !r.out.includes('/connect-observability-platform') || 'a file that is there but broken was sent to /connect-observability-platform',
      ];
    },
  },
  {
    n: 20, name: 'a 200 with a web page is not accepted: exit 2, the records wait, and the status names the reason',
    plan: [{ status: 200, type: 'text/html; charset=utf-8', answer: '<!doctype html><html><head><title>Sign in</title></head><body></body></html>' }],
    run: async ({ root, platform }) => {
      const hub = makeHub(root, { url: platform.url });
      queue(hub);
      const r = await run(SENDER, hub);
      const st = JSON.parse(readFileSync(join(dirOf(hub), 'send-state.json'), 'utf8'));
      const s = await run(STATUS, hub);
      const reason = 'the URL in docs/estate/observability.json answered with a web page, so it does not lead to the observability platform\'s receiver';
      return [
        r.code === 2 || `exit ${r.code}: ${r.out}`,
        r.out.includes(`CANNOT VERIFY: ${reason}.`) || `the output does not give the reason: ${r.out}`,
        platform.seen.length === 1 || `${platform.seen.length} requests, expected 1`,
        names(join(dirOf(hub), 'sent')).length === 0 || 'a record was moved to sent/',
        names(join(dirOf(hub), 'refused')).length === 0 || 'a record was moved to refused/',
        names(join(dirOf(hub), 'queue')).length === 1 || 'the record left the queue',
        st.failures === 1 && st.next_ms === T0 + 40000 || `the next try does not wait: ${JSON.stringify(st)}`,
        s.out.includes(`The last failure: ${reason}.`) || `the status does not name the reason: ${s.out}`,
      ];
    },
  },
  {
    n: 21, name: 'a 401 is a wrong key, not a refusal: exit 2, the records wait, and the reason names the token',
    plan: [{ status: 401, answer: '{"status":"error","errorType":401,"error":"401 Unauthorized"}', type: 'application/json' }],
    run: async ({ root, platform }) => {
      const hub = makeHub(root, { url: platform.url });
      queue(hub);
      const r = await run(SENDER, hub);
      const reason = 'the observability platform answered 401, so it did not accept the request\'s authorisation';
      return [
        r.code === 2 || `exit ${r.code}: ${r.out}`,
        r.out.includes(`CANNOT VERIFY: ${reason}.`) && r.out.includes('HARNESS_OBSERVABILITY_TOKEN') || `the output does not give the reason: ${r.out}`,
        r.out.includes('Check "auth" in docs/estate/observability.json') || `the reason does not point at auth: ${r.out}`,
        names(join(dirOf(hub), 'refused')).length === 0 || 'a record was moved to refused/',
        names(join(dirOf(hub), 'queue')).length === 1 || 'the record left the queue',
      ];
    },
  },
  {
    n: 22, name: 'a 404 is a wrong URL, not a refusal: exit 2, the records wait, and the reason names observability.json',
    plan: [{ status: 404, answer: 'not found' }],
    run: async ({ root, platform }) => {
      const hub = makeHub(root, { url: platform.url });
      queue(hub);
      const r = await run(SENDER, hub);
      const reason = 'the URL in docs/estate/observability.json answered 404, so it does not lead to the observability platform\'s receiver';
      return [
        r.code === 2 || `exit ${r.code}: ${r.out}`,
        r.out.includes(`CANNOT VERIFY: ${reason}.`) || `the output does not give the reason: ${r.out}`,
        names(join(dirOf(hub), 'refused')).length === 0 || 'a record was moved to refused/',
        names(join(dirOf(hub), 'queue')).length === 1 || 'the record left the queue',
      ];
    },
  },
  {
    n: 23, name: 'CubeAPM\'s 400 "unsupported path requested" is a wrong URL: exit 2, and the records wait',
    plan: [{ status: 400, answer: 'unsupported path requested: "/api/logs/insert/jsonline"' }],
    run: async ({ root, platform }) => {
      const hub = makeHub(root, { url: platform.url });
      queue(hub);
      const r = await run(SENDER, hub);
      const reason = 'the URL in docs/estate/observability.json answered 400, so it does not lead to the observability platform\'s receiver';
      return [
        r.code === 2 || `exit ${r.code}: ${r.out}`,
        r.out.includes(`CANNOT VERIFY: ${reason}.`) || `the output does not give the reason: ${r.out}`,
        names(join(dirOf(hub), 'refused')).length === 0 || 'a record was moved to refused/',
        names(join(dirOf(hub), 'queue')).length === 1 || 'the record left the queue',
      ];
    },
  },
  {
    n: 24, name: 'the same 400 from Grafana stays a refusal: the wrong-path rule is the CubeAPM adapter\'s own',
    plan: [{ status: 400, answer: 'unsupported path requested: "/loki/api/v1/push"' }],
    run: async ({ root, platform }) => {
      const hub = makeHub(root, { url: platform.url, platform: 'grafana' });
      queue(hub);
      const r = await run(SENDER, hub);
      return [
        r.code === 1 || `exit ${r.code}: ${r.out}`,
        names(join(dirOf(hub), 'refused')).length === 1 || 'the record was not moved to refused/',
        names(join(dirOf(hub), 'queue')).length === 0 || 'the record is still queued',
      ];
    },
  },
  {
    n: 25, name: 'a connection that nothing answers names its cause: exit 2, ECONNREFUSED, and the records wait',
    run: async ({ root }) => {
      const hub = makeHub(root, { url: `http://127.0.0.1:${await closedPort()}` });
      queue(hub);
      const r = await run(SENDER, hub);
      return [
        r.code === 2 || `exit ${r.code}: ${r.out}`,
        r.out.includes('CANNOT VERIFY: the observability platform could not be reached: ECONNREFUSED.') || `the output does not name the cause: ${r.out}`,
        names(join(dirOf(hub), 'queue')).length === 1 || 'the record left the queue',
      ];
    },
  },
  {
    n: 26, name: 'a certificate chain that Node does not trust names its cause and NODE_USE_SYSTEM_CA=1, and the records wait',
    run: async ({ root, platform }) => {
      const hub = makeHub(root, { url: platform.url });
      queue(hub);
      // fetch fails this way when a TLS inspection proxy re-signs the connection with its own authority.
      const failure = new TypeError('fetch failed');
      failure.cause = Object.assign(new Error('self-signed certificate in certificate chain'), { code: 'SELF_SIGNED_CERT_IN_CHAIN' });
      process.env.HARNESS_OBSERVABILITY_NOW = new Date(T0 + 10000).toISOString();
      let r;
      try {
        r = await core.sender.drain({ start: hub, token: TOKEN, fetchImpl: async () => { throw failure; } });
      } finally {
        delete process.env.HARNESS_OBSERVABILITY_NOW;
      }
      const s = await run(STATUS, hub);
      const reason = 'the observability platform could not be reached: SELF_SIGNED_CERT_IN_CHAIN. Node does not trust the certificate chain. Behind a TLS inspection proxy, the sender needs NODE_USE_SYSTEM_CA=1';
      return [
        r.code === 2 || `drain returned ${r.code}`,
        r.why === reason || `the reason is: ${r.why}`,
        platform.seen.length === 0 || 'a request reached the observability platform',
        names(join(dirOf(hub), 'queue')).length === 1 || 'the record left the queue',
        s.out.includes(`The last failure: ${reason}.`) || `the status does not name the reason: ${s.out}`,
      ];
    },
  },
  {
    n: 27, name: '"auth": "none" and no HARNESS_OBSERVABILITY_TOKEN: the record is sent with no Authorization header, exit 0, and the status says so',
    run: async ({ root, platform }) => {
      const hub = makeHub(root, { connection: { schema_version: 1, hub: 'example-hub', platform: 'cubeapm', url: platform.url, auth: 'none' } });
      queue(hub);
      const r = await run(SENDER, hub, { token: null });
      const req = platform.seen[0] || { headers: {} };
      const s = await run(STATUS, hub, { token: null });
      return [
        r.code === 0 || `exit ${r.code}: ${r.out}`,
        platform.seen.length === 1 && sentLines(platform).length === 1 || `${platform.seen.length} requests, expected 1 with one record`,
        !('authorization' in req.headers) || 'the request carries an Authorization header',
        names(join(dirOf(hub), 'sent')).length === 1 || 'sent/ does not hold the record',
        s.out.includes('Authorisation: none. Records go without authorisation, and HARNESS_OBSERVABILITY_TOKEN is not used.') || `the status does not show the mode: ${s.out}`,
      ];
    },
  },
  {
    n: 28, name: '"auth": "none" with HARNESS_OBSERVABILITY_TOKEN set: the token never leaves the laptop',
    run: async ({ root, platform }) => {
      const hub = makeHub(root, { connection: { schema_version: 1, hub: 'example-hub', platform: 'cubeapm', url: platform.url, auth: 'none' } });
      queue(hub);
      const r = await run(SENDER, hub);
      const req = platform.seen[0] || { headers: {}, body: '' };
      return [
        r.code === 0 || `exit ${r.code}: ${r.out}`,
        platform.seen.length === 1 || `${platform.seen.length} requests, expected 1`,
        !('authorization' in req.headers) || 'the request carries an Authorization header',
        !JSON.stringify(platform.seen).includes(TOKEN) || 'the token reached the observability platform',
      ];
    },
  },
  {
    n: 29, name: '"auth": "none" with Grafana: the push carries no Authorization header either',
    run: async ({ root, platform }) => {
      const hub = makeHub(root, { connection: { schema_version: 1, hub: 'example-hub', platform: 'grafana', url: platform.url, auth: 'none' } });
      queue(hub);
      const r = await run(SENDER, hub);
      const req = platform.seen[0] || { headers: {}, url: '' };
      return [
        r.code === 0 || `exit ${r.code}: ${r.out}`,
        req.url === '/loki/api/v1/push' || `the request went to ${req.url}`,
        !('authorization' in req.headers) || 'the push carries an Authorization header',
      ];
    },
  },
  {
    n: 30, name: '"auth": "basic" is refused: the finding names it, the status and the sender exit 2, and nothing is sent',
    run: async ({ root, platform }) => {
      const hub = makeHub(root, { connection: { schema_version: 1, hub: 'example-hub', platform: 'cubeapm', url: platform.url, auth: 'basic' } });
      const base = { schema_version: 1, hub: 'h', platform: 'cubeapm', url: 'https://cubeapm.example.invalid' };
      const s = await run(STATUS, hub);
      const r = await run(SENDER, hub);
      return [
        core.config.validateConnection({ ...base, auth: 'basic' }).includes('auth must be bearer or none') || 'the finding does not name auth',
        core.config.validateConnection({ ...base, auth: 'bearer' }).length === 0 && core.config.validateConnection({ ...base, auth: 'none' }).length === 0 || 'bearer or none was refused',
        s.code === 2 && s.out.includes('CANNOT VERIFY: docs/estate/observability.json: auth must be bearer or none.') || `the status did not refuse it: ${s.out}`,
        r.code === 2 || `the sender exited ${r.code}`,
        platform.seen.length === 0 || 'a request was made',
      ];
    },
  },
  {
    n: 31, name: 'a record queued in another record form never leaves: it moves to refused/ with the rules it breaks, and the other record leaves in field order',
    run: async ({ root, platform }) => {
      const hub = makeHub(root, { url: platform.url });
      queue(hub, { logs: 2 });
      // One queue file as an older form wrote it: another schema, and `kind` where the record has `type`.
      const dir = join(dirOf(hub), 'queue');
      const [stale, fresh] = names(dir).filter((n) => n.endsWith('.json')).map((n) => ({ file: join(dir, n), entry: JSON.parse(readFileSync(join(dir, n), 'utf8')) }));
      const { type, ...rest } = stale.entry.record;
      writeFileSync(stale.file, JSON.stringify({ ...stale.entry, record: { ...rest, schema: 'harness-obs/3', kind: 'agent' } }));
      const r = await run(SENDER, hub);
      const lines = sentLines(platform);
      const line = lines[0] || {};
      const order = Object.keys(line).filter((k) => k !== '_time' && k !== '_msg' && k !== 'service.name');
      const refused = names(join(dirOf(hub), 'refused')).map((n) => JSON.parse(readFileSync(join(dirOf(hub), 'refused', n), 'utf8')));
      const answer = (refused[0] && refused[0].answer) || '';
      return [
        type === 'tokens' || 'the record was not queued with its type',
        r.code === 1 || `exit ${r.code}: ${r.out}`,
        lines.length === 1 || `${lines.length} records sent, expected 1`,
        line.record_id === fresh.entry.record.record_id && line.tokens_cache_read === fresh.entry.record.tokens_cache_read || 'the record that left is not the one in the current form, or its counts changed',
        line.schema === 'harness-observability/1' && line.type === 'tokens' && line.scope === 'story' && line.key_from === 'command' || `the record left as ${line.schema}, type ${line.type}, in the bucket ${line.scope}, ${line.key_from}`,
        JSON.stringify(order) === JSON.stringify(core.record.FIELDS.filter((f) => f in line)) || 'the record did not leave in field order',
        refused.length === 1 && refused[0].record.record_id === stale.entry.record.record_id || `${refused.length} records in refused/, expected the one in the older form`,
        answer.includes('field kind is not allowed on a record') && answer.includes('field schema has a value of the wrong shape') || `the reason does not name the rules it breaks: ${answer}`,
      ];
    },
  },
  {
    n: 32, name: 'a /dev-sprint record with no key waits, then leaves with the story its work gave the run, and that story\'s feature',
    run: async ({ root, platform }) => {
      const hub = makeHub(root, { url: platform.url });
      const ctx = queue(hub, { prompt: '/dev-sprint' });
      const a = await run(SENDER, hub, { at: 20 });
      const key = core.state.bindingKey('claude-code', 's-1');
      const binding = core.state.loadBinding(ctx.dir, key);
      const took = core.runs.takeWorkKey(binding, 'PROJ-102', T0 + 25000);
      core.state.saveBinding(ctx.dir, key, binding);
      const b = await run(SENDER, hub, { at: 30 });
      const line = sentLines(platform)[0] || {};
      return [
        a.code === 0 && a.out.includes('Waiting for a key: 1') || `the record did not wait: ${a.out}`,
        took === true && binding.runs.length === 1 || 'the work did not give the run its key in place',
        b.code === 0 && line.story === 'PROJ-102' && line.feature === 'service-version-endpoint' || `the record left with ${line.story}, ${line.feature}`,
        line.scope === 'story' && line.key_from === 'work' || `the record left in the bucket ${line.scope}, ${line.key_from}`,
      ];
    },
  },
  {
    n: 33, name: 'the same command typed again with its key: the waiting record of the run before it leaves with that key, never without it',
    run: async ({ root, platform }) => {
      const hub = makeHub(root, { url: platform.url });
      const ctx = queue(hub, { prompt: '/dev-sprint' });
      const a = await run(SENDER, hub, { at: 20 });
      // What the hook does at the prompt, under one lock: the new run ends the one before it and gives it the key.
      const key = core.state.bindingKey('claude-code', 's-1');
      const binding = core.state.loadBinding(ctx.dir, key);
      const next = core.runs.openRun(binding, core.runs.parseCommand('/dev-sprint PROJ-102'), T0 + 60000);
      const took = core.runs.keyFromNextCommand(binding, next);
      core.state.saveBinding(ctx.dir, key, binding);
      const b = await run(SENDER, hub, { at: 70 });
      const line = sentLines(platform)[0] || {};
      return [
        a.code === 0 && a.out.includes('Waiting for a key: 1') || `the record did not wait: ${a.out}`,
        took === true || 'the run before did not take the key',
        b.code === 0 && line.story === 'PROJ-102' && line.scope === 'story' && line.key_from === 'next-command' || `the record left as ${line.story}, ${line.scope}, ${line.key_from}`,
      ];
    },
  },
  {
    n: 34, name: 'work-time records leave with their clock times and no price, and CubeAPM\'s _msg names each record\'s type',
    run: async ({ root, platform }) => {
      const hub = makeHub(root, { url: platform.url });
      queueTime(hub);
      const r = await run(SENDER, hub);
      const lines = sentLines(platform);
      const of = (type) => lines.filter((l) => l.type === type);
      const record = (l) => Object.fromEntries(Object.entries(l).filter(([k]) => !['_time', '_msg', 'service.name'].includes(k)));
      const problems = lines.flatMap((l) => core.record.validateRecord(record(l)));
      return [
        r.code === 0 || `exit ${r.code}: ${r.out}`,
        lines.length === 4 && of('work').length === 2 && of('wait-in-session').length === 1 && of('command').length === 1 || `the lines are ${lines.map((l) => l.type).join(', ')}`,
        problems.length === 0 || `a line breaks the record rules: ${problems.join(' · ')}`,
        of('work').every((l) => l._msg === 'work orchestrator PROJ-102') && of('wait-in-session')[0]?._msg === 'wait-in-session question PROJ-102' && of('command')[0]?._msg === 'command PROJ-102' || `the messages are ${lines.map((l) => l._msg).join(' | ')}`,
        lines.every((l) => l.started_at && l.ended_at) && of('command')[0]?.started_at === new Date(T0).toISOString() || 'a line left without its clock times',
        lines.every((l) => !('cost_usd' in l) && !('price_table' in l)) || 'a work-time line carries a price',
        lines.every((l) => l.feature === 'service-version-endpoint' && l['service.name'] === 'harness') || 'a line has the wrong feature or stream field',
        of('command')[0]?.wait_s === 60 && of('command')[0]?.busy_s === 10 || `the command's figures are busy ${of('command')[0]?.busy_s}, wait ${of('command')[0]?.wait_s}`,
      ];
    },
  },
  {
    n: 35, name: 'Grafana: each type of work time goes in its own stream, labelled with its type, and no other label',
    run: async ({ root, platform }) => {
      const hub = makeHub(root, { url: platform.url, platform: 'grafana' });
      queueTime(hub);
      const r = await run(SENDER, hub);
      const streams = JSON.parse((platform.seen[0] || { body: '{}' }).body).streams || [];
      const types = streams.map((s) => s.stream.type).sort();
      const count = (type) => (streams.find((s) => s.stream.type === type)?.values || []).length;
      return [
        r.code === 0 || `exit ${r.code}: ${r.out}`,
        JSON.stringify(types) === JSON.stringify(['command', 'wait-in-session', 'work']) || `the streams are labelled ${types.join(', ')}`,
        count('work') === 2 && count('wait-in-session') === 1 && count('command') === 1 || 'a stream holds the wrong number of lines',
        streams.every((s) => Object.keys(s.stream).join() === 'job,hub,type') || 'a stream has a label other than job, hub and type',
      ];
    },
  },
  {
    n: 36, name: 'a /dev-sprint after the design\'s merge: its command record carries the pickup from the merge, no wait record leaves, and no gap state is kept',
    run: async ({ root, platform }) => {
      const hub = makeHub(root, { url: platform.url });
      endedRun(hub, { session: 's-1', prompt: '/dev-spec PROJ-102', from: 0, to: 600 });
      mergePullRequest(hub, { branch: 'feature/PROJ-102-endpoint', files: { 'docs/designs/PROJ-102.lld.md': '# PROJ-102\n' }, commitAt: 650, mergeAt: 1200, number: 2, subject: 'docs(PROJ-102): the design' });
      endedRun(hub, { session: 's-2', prompt: '/dev-sprint PROJ-102', from: 3600, to: 4000 });
      const r = await run(SENDER, hub, { at: 4100 });
      const sprint = commandLine(platform, 'dev-sprint');
      const spec = commandLine(platform, 'dev-spec');
      return [
        r.code === 0 || `exit ${r.code}: ${r.out}`,
        sprint.previous_gate === 'design-merge' && sprint.previous_gate_merged_at === atIso(1200) && sprint.pickup_s === 2400 || `the /dev-sprint pickup is ${sprint.previous_gate}, ${sprint.previous_gate_merged_at}, ${sprint.pickup_s} s`,
        spec.previous_gate === null && spec.previous_gate_merged_at === null && spec.pickup_s === null || 'the /dev-spec found a decomposition merge that the trunk does not hold',
        sprint.gate_wait_s === 0 && spec.gate_wait_s === 0 || `a command with no merge inside it has a gate wait: ${sprint.gate_wait_s}, ${spec.gate_wait_s}`,
        rulesOk(sprint) && rulesOk(spec) || 'a command record breaks the record rules',
        sentLines(platform).every((l) => l.type !== 'wait') || 'a wait record left the laptop',
        !existsSync(join(dirOf(hub), 'time', 'gaps.json')) || 'the sender kept gap state',
      ];
    },
  },
  {
    n: 37, name: 'a squash merge: the pickup runs from the squash commit, and the sender fetches nothing',
    run: async ({ root, platform }) => {
      const hub = makeHub(root, { url: platform.url });
      mergePullRequest(hub, { branch: 'feature/PROJ-102-endpoint', files: { 'docs/designs/PROJ-102.lld.md': '# PROJ-102\n' }, commitAt: 650, mergeAt: 1200, number: 7, squash: true, subject: 'docs(PROJ-102): the design' });
      endedRun(hub, { session: 's-2', prompt: '/dev-sprint PROJ-102', from: 3600, to: 4000 });
      const cache = join(root, 'cache');
      const r = await run(SENDER, hub, { at: 4100, env: { HARNESS_SPOKE_CACHE: cache } });
      const c = commandLine(platform, 'dev-sprint');
      return [
        r.code === 0 || `exit ${r.code}: ${r.out}`,
        c.previous_gate === 'design-merge' && c.previous_gate_merged_at === atIso(1200) && c.pickup_s === 2400 || `the pickup after a squash is ${c.previous_gate}, ${c.previous_gate_merged_at}, ${c.pickup_s} s`,
        !existsSync(cache) || 'the sender fetched a pull request\'s head into a cache',
      ];
    },
  },
  {
    n: 38, name: 'a command with no merge before it, and a command that follows no gate: the three pickup fields are empty',
    run: async ({ root, platform }) => {
      const hub = makeHub(root, { url: platform.url });
      endedRun(hub, { session: 's-1', prompt: '/dev-sprint PROJ-102', from: 0, to: 600 });
      mergePullRequest(hub, { branch: 'validation/PROJ-102', files: { 'docs/designs/PROJ-102.validation.md': '# PROJ-102\n' }, commitAt: 700, mergeAt: 1200, number: 9, subject: 'docs(PROJ-102): the validation report' });
      endedRun(hub, { session: 's-2', prompt: '/qa-sprint PROJ-102', from: 3600, to: 4000 });
      const r = await run(SENDER, hub, { at: 4100 });
      const empty = (c) => c.previous_gate === null && c.previous_gate_merged_at === null && c.pickup_s === null;
      return [
        r.code === 0 || `exit ${r.code}: ${r.out}`,
        empty(commandLine(platform, 'dev-sprint')) || 'a /dev-sprint with no design merge before it has a pickup',
        empty(commandLine(platform, 'qa-sprint')) || '/qa-sprint, which follows no gate, has a pickup',
        sentLines(platform).filter((l) => l.type === 'command').every(rulesOk) || 'a command record breaks the record rules',
      ];
    },
  },
  {
    n: 39, name: 'a trunk that git cannot read: the command leaves at once with empty pickup fields and an unknown gate wait, and nothing waits to be asked again',
    run: async ({ root, platform }) => {
      const hub = makeHub(root, { url: platform.url });
      mergePullRequest(hub, { branch: 'feature/PROJ-102-endpoint', files: { 'docs/designs/PROJ-102.lld.md': '# PROJ-102\n' }, commitAt: 650, mergeAt: 1200, number: 2, subject: 'docs(PROJ-102): the design' });
      endedRun(hub, { session: 's-2', prompt: '/dev-sprint PROJ-102', from: 3600, to: 4000, reply: { at: 4500, to: 4800 } });
      const r = await run(SENDER, hub, { at: 4900, env: { HARNESS_TRUNK: 'no-such-trunk' } });
      const c = commandLine(platform, 'dev-sprint');
      const reply = sentLines(platform).find((l) => l.type === 'wait-in-session') || {};
      return [
        r.code === 0 || `exit ${r.code}: ${r.out}`,
        c.previous_gate === null && c.pickup_s === null && c.gate_wait_s === null && c.wait_s === 500 || `with no trunk the command carries ${c.previous_gate}, ${c.pickup_s}, gate wait ${c.gate_wait_s}, wait ${c.wait_s}`,
        reply.gate_wait_s === null || `with no trunk the reply wait's gate wait is ${reply.gate_wait_s}`,
        rulesOk(c) || 'the command record breaks the record rules',
        names(join(dirOf(hub), 'queue')).length === 0 || 'a record waits in the queue',
      ];
    },
  },
  {
    n: 40, name: 'two runs after one merge, each on its own session: both carry the pickup from that merge, and the first carries the smaller one',
    run: async ({ root, platform }) => {
      const hub = makeHub(root, { url: platform.url });
      mergePullRequest(hub, { branch: 'feature/PROJ-102-endpoint', files: { 'docs/designs/PROJ-102.lld.md': '# PROJ-102\n' }, commitAt: 650, mergeAt: 1200, number: 2, subject: 'docs(PROJ-102): the design' });
      endedRun(hub, { session: 's-1', prompt: '/dev-sprint PROJ-102', from: 3600, to: 4000 });
      endedRun(hub, { session: 's-2', prompt: '/dev-sprint PROJ-102', from: 9000, to: 9400 });
      const r = await run(SENDER, hub, { at: 9500 });
      const pickups = sentLines(platform).filter((l) => l.type === 'command').map((l) => l.pickup_s).sort((a, b) => a - b);
      return [
        r.code === 0 || `exit ${r.code}: ${r.out}`,
        JSON.stringify(pickups) === JSON.stringify([2400, 7800]) || `the pickups are ${pickups.join(', ')}, expected 2400 and 7800`,
        sentLines(platform).filter((l) => l.type === 'command').every((l) => l.previous_gate_merged_at === atIso(1200)) || 'the two runs name different merges',
      ];
    },
  },
  {
    n: 41, name: 'a /decompose after the requirements merge: the pickup follows the feature\'s gate',
    run: async ({ root, platform }) => {
      const hub = makeHub(root, { url: platform.url });
      const slug = 'service-version-endpoint';
      mergePullRequest(hub, { branch: `requirements/${slug}`, files: { [`docs/requirements/${slug}/requirements.md`]: '# Requirements\n' }, commitAt: 700, mergeAt: 1200, number: 1, subject: 'docs: the requirements' });
      endedRun(hub, { session: 's-2', prompt: `/decompose docs/requirements/${slug}/requirements.md`, from: 3600, to: 4000 });
      const r = await run(SENDER, hub, { at: 4100 });
      const c = commandLine(platform, 'decompose');
      return [
        r.code === 0 || `exit ${r.code}: ${r.out}`,
        c.feature === slug && c.story === null && c.previous_gate === 'requirements-merge' && c.pickup_s === 2400 || `the /decompose pickup is ${c.previous_gate}, ${c.pickup_s} s, on ${c.feature}`,
        rulesOk(c) || 'the command record breaks the record rules',
      ];
    },
  },
  {
    n: 42, name: 'a merge inside a reply wait: the time from the wait\'s start to the merge leaves wait_s for gate_wait_s, on the command and on the reply wait',
    run: async ({ root, platform }) => {
      const hub = makeHub(root, { url: platform.url });
      const r = runWithTurn(hub, { session: 's-1', prompt: '/dev-sprint PROJ-102', from: 0, to: 600, reply: { at: 2000, to: 2500 } });
      mergePullRequest(hub, { branch: 'feature/PROJ-102-amend', files: { 'docs/designs/PROJ-102.lld.md': '# PROJ-102, amended\n' }, commitAt: 650, mergeAt: 1200, number: 4, subject: 'docs(PROJ-102): amend the design' });
      r.end(2600);
      const s = await run(SENDER, hub, { at: 2700 });
      const c = commandLine(platform, 'dev-sprint');
      const reply = sentLines(platform).find((l) => l.type === 'wait-in-session') || {};
      return [
        s.code === 0 || `exit ${s.code}: ${s.out}`,
        c.busy_s === 1100 && c.wait_s === 800 && c.gate_wait_s === 600 && c.unexplained_s === 0 && c.duration_s === 2500 || `the command is ${c.duration_s} s: busy ${c.busy_s}, wait ${c.wait_s}, gate wait ${c.gate_wait_s}, unexplained ${c.unexplained_s}`,
        reply.gate === 'reply' && reply.started_at === atIso(600) && reply.duration_s === 1400 && reply.gate_wait_s === 600 || `the reply wait is ${reply.gate}, from ${reply.started_at}, ${reply.duration_s} s, gate wait ${reply.gate_wait_s}`,
        rulesOk(c) && rulesOk(reply) || 'a record breaks the record rules',
      ];
    },
  },
  {
    n: 43, name: 'a /dev-spec after its feature\'s decomposition merge: the pickup follows the gate of the story\'s feature, from the trunk',
    run: async ({ root, platform }) => {
      const hub = makeHub(root, { url: platform.url });
      mergePullRequest(hub, { branch: 'decompose/service-version-endpoint', files: { 'docs/backlog/service-version-endpoint/decomposition.md': '# Decomposition\n' }, commitAt: 700, mergeAt: 1200, number: 5, subject: 'docs: the decomposition' });
      endedRun(hub, { session: 's-2', prompt: '/dev-spec PROJ-102', from: 3600, to: 4000 });
      const r = await run(SENDER, hub, { at: 4100 });
      const c = commandLine(platform, 'dev-spec');
      return [
        r.code === 0 || `exit ${r.code}: ${r.out}`,
        c.story === 'PROJ-102' && c.feature === 'service-version-endpoint' && c.previous_gate === 'decomposition-merge' && c.pickup_s === 2400 || `the /dev-spec pickup is ${c.previous_gate}, ${c.pickup_s} s, on ${c.feature}`,
      ];
    },
  },
  {
    n: 44, name: 'a merge while the run works, outside every wait: no gate wait on the command or the reply wait',
    run: async ({ root, platform }) => {
      const hub = makeHub(root, { url: platform.url });
      const r = runWithTurn(hub, { session: 's-1', prompt: '/dev-sprint PROJ-102', from: 0, to: 600, reply: { at: 2000, to: 2500 } });
      mergePullRequest(hub, { branch: 'feature/PROJ-102-amend', files: { 'docs/designs/PROJ-102.lld.md': '# PROJ-102, amended\n' }, commitAt: 100, mergeAt: 300, number: 4, subject: 'docs(PROJ-102): amend the design' });
      r.end(2600);
      const s = await run(SENDER, hub, { at: 2700 });
      const c = commandLine(platform, 'dev-sprint');
      const reply = sentLines(platform).find((l) => l.type === 'wait-in-session') || {};
      return [
        s.code === 0 || `exit ${s.code}: ${s.out}`,
        c.wait_s === 1400 && c.gate_wait_s === 0 && reply.gate_wait_s === 0 || `a merge outside the waits gave a gate wait: command ${c.gate_wait_s}, reply ${reply.gate_wait_s}, wait ${c.wait_s}`,
      ];
    },
  },
  {
    n: 45, name: 'a record that a hook queues while the sender sends leaves with that sender, in a second request',
    run: async ({ root, platform }) => {
      const hub = makeHub(root, { url: platform.url });
      const ctx = queue(hub);
      // A session's last hook queues its last call while the sender that an earlier hook started sends.
      // The sender that the last hook starts finds the lock held and returns at once.
      platform.onRequest = (n) => {
        if (n !== 1) return;
        const calls = [{ id: 'm-late', ms: T0 + 5000, model: 'claude-opus-5-5', provider: 'anthropic', counts: counts() }];
        core.collect.collect({ ctx, runtime: 'claude-code', collector: 'claude-code/1', session: 's-1', logRef: 'log-late', synthetic: true, read: () => ({ calls }) });
      };
      const r = await run(SENDER, hub);
      return [
        r.code === 0 || `exit ${r.code}: ${r.out}`,
        platform.seen.length === 2 || `${platform.seen.length} request(s), not 2`,
        names(join(dirOf(hub), 'queue')).length === 0 || `the queue still holds ${names(join(dirOf(hub), 'queue')).join(', ')}`,
        names(join(dirOf(hub), 'sent')).length === 2 || `sent/ holds ${names(join(dirOf(hub), 'sent')).length} records, not 2`,
      ];
    },
  },
  {
    n: 46, name: 'a run that ends on a question the person declined: the command ends at the decline, and counts the question as its wait',
    run: async ({ root, platform }) => {
      const hub = makeHub(root, { url: platform.url });
      endedRun(hub, { session: 's-1', prompt: '/dev-spec PROJ-102', from: 0, to: 600, declined: 660 });
      const r = await run(SENDER, hub, { at: 4100 });
      const c = sentLines(platform).find((l) => l.type === 'command' && l.started_at === atIso(0)) || {};
      return [
        r.code === 0 || `exit ${r.code}: ${r.out}`,
        c.ended_at === atIso(660) && c.duration_s === 660 && c.busy_s === 600 && c.wait_s === 60 && c.unexplained_s === 0 && rulesOk(c) || `the command runs to ${c.ended_at}: ${c.duration_s} s, busy ${c.busy_s}, wait ${c.wait_s}, expected 660 s to the decline`,
      ];
    },
  },
  {
    n: 47, name: 'a record that an older library queued with collector_tested leaves without it, and the observability platform accepts it',
    run: async ({ root, platform }) => {
      const hub = makeHub(root, { url: platform.url });
      const ctx = queue(hub);
      const q = join(ctx.dir, 'queue');
      for (const n of names(q)) {
        const entry = JSON.parse(readFileSync(join(q, n), 'utf8'));
        entry.record.collector_tested = true;
        writeFileSync(join(q, n), JSON.stringify(entry));
      }
      const r = await run(SENDER, hub);
      const lines = sentLines(platform);
      return [
        r.code === 0 || `exit ${r.code}: ${r.out}`,
        lines.length === 1 || `the observability platform received ${lines.length} records, expected 1`,
        lines.every((l) => !('collector_tested' in l)) || 'a record left with collector_tested',
        names(join(ctx.dir, 'refused')).length === 0 || 'the old record was refused',
      ];
    },
  },
  {
    n: 48, name: 'the person leaves with each record: CubeAPM keeps it as a field, and Grafana keeps it in the line, never in a label',
    run: async ({ root, platform }) => {
      const cube = makeHub(join(root, 'cube'), { url: platform.url });
      queue(cube, { person: 'octo-cat' });
      queueTime(cube, { person: 'octo-cat' });
      const a = await run(SENDER, cube);
      const lines = sentLines(platform);
      const grafana = makeHub(join(root, 'grafana'), { url: platform.url, platform: 'grafana' });
      queue(grafana, { person: 'dev@example.invalid' });
      queueTime(grafana, { person: 'dev@example.invalid' });
      const b = await run(SENDER, grafana);
      const push = platform.seen.find((x) => x.url === '/loki/api/v1/push') || { body: '{}' };
      const streams = JSON.parse(push.body).streams || [];
      const pushed = streams.flatMap((x) => x.values.map((v) => JSON.parse(v[1])));
      return [
        a.code === 0 && b.code === 0 || `exit ${a.code} and ${b.code}`,
        lines.length >= 3 && lines.every((l) => l.person === 'octo-cat') || `CubeAPM's lines name ${[...new Set(lines.map((l) => l.person))].join(', ')}`,
        new Set(lines.map((l) => l.type)).size >= 3 || 'CubeAPM did not get the tokens and the work-time types',
        lines.every((l) => l._msg.search(/octo-cat/) === -1) || 'the person reached _msg',
        pushed.length >= 3 && pushed.every((l) => l.person === 'dev@example.invalid') || 'a Grafana line does not name the person',
        streams.every((x) => JSON.stringify(Object.keys(x.stream)) === JSON.stringify(['job', 'hub', 'type'])) || `a Grafana stream has the labels ${streams.map((x) => Object.keys(x.stream).join('+')).join(', ')}`,
      ];
    },
  },
  {
    n: 49, name: 'the status names the person and where it came from: gh asked now, else git\'s user.email, else a warning, with no change to the exit code and no person.json',
    run: async ({ root, platform }) => {
      const hub = makeHub(root, { url: platform.url });
      const none = await run(STATUS, hub);
      git(hub, 'config', 'user.email', 'Dev@Example.invalid');
      const fromGit = await run(STATUS, hub);
      const fromGh = await run(STATUS, hub, { env: { FAKE_GH_LOGIN: 'Octo-Cat' } });
      return [
        none.code === 0 && none.out.includes('WARN Person: none. gh gives no login and git has no user.email') || `with no person, exit ${none.code}: ${none.out}`,
        fromGit.code === 0 && fromGit.out.includes('Person: dev@example.invalid, from git\'s user.email, because gh gives no login.') || `from git: ${fromGit.out}`,
        fromGh.code === 0 && fromGh.out.includes('Person: octo-cat, the GitHub login that gh is signed in to.') || `from gh: ${fromGh.out}`,
        !existsSync(join(dirOf(hub), 'person.json')) || 'the status wrote person.json',
      ];
    },
  },
  {
    n: 50, name: 'a decomposed story: its records name its ticket from the link file on the site trackers.json gives, and its feature\'s Epic',
    run: async ({ root, platform }) => {
      const hub = makeHub(root, { url: platform.url });
      onTrunk(hub, { 'docs/estate/trackers.json': TRACKERS, [LINKS_PATH]: LINKS });
      queue(hub);
      queueTime(hub);
      const r = await run(SENDER, hub);
      const lines = sentLines(platform);
      return [
        r.code === 0 || `exit ${r.code}: ${r.out}`,
        lines.length >= 4 || `${lines.length} lines, expected a tokens record and the work-time records`,
        lines.every((l) => l.story === 'PROJ-102' && l.ticket_url === STORY_URL) || `the ticket URLs are ${[...new Set(lines.map((l) => l.ticket_url))].join(', ')}`,
        lines.every((l) => l.epic === 'PLAT-10' && l.epic_url === EPIC_URL) || `the Epics are ${[...new Set(lines.map((l) => `${l.epic} ${l.epic_url}`))].join(', ')}`,
        lines.every(rulesOk) || 'a line breaks the record rules',
        lines.every((l) => l._msg.endsWith('PROJ-102')) || '_msg changed',
        Object.keys(asRecord(lines[0])).join(',').includes('story,ticket_url,feature,epic,epic_url,defect_of') || `the field order is ${Object.keys(asRecord(lines[0])).join(',')}`,
      ];
    },
  },
  {
    n: 51, name: 'a /decompose record names its feature\'s Epic and no ticket, because it has no story',
    run: async ({ root, platform }) => {
      const hub = makeHub(root, { url: platform.url });
      onTrunk(hub, { 'docs/estate/trackers.json': TRACKERS, [LINKS_PATH]: LINKS });
      queue(hub, { prompt: '/decompose docs/requirements/service-version-endpoint/requirements.md' });
      await run(SENDER, hub);
      const lines = sentLines(platform);
      return [
        lines.length === 1 && lines[0].scope === 'feature' && lines[0].story === null || `the record left as ${lines[0]?.scope} with story ${lines[0]?.story}`,
        lines.length === 1 && lines[0].ticket_url === null && lines[0].epic === 'PLAT-10' && lines[0].epic_url === EPIC_URL || `ticket ${lines[0]?.ticket_url}, Epic ${lines[0]?.epic} ${lines[0]?.epic_url}`,
        lines.every(rulesOk) || 'a line breaks the record rules',
      ];
    },
  },
  {
    n: 52, name: 'a story /from-ticket took in: the URL is the host of its snapshot\'s Source: line and its key, never the line\'s path or query, and no Epic',
    run: async ({ root, platform }) => {
      const hub = makeHub(root, { url: platform.url });
      const snapshot = [
        '# PROJ-512 — the ticket as fetched', '', '```', 'Source: https://elsewhere.example.invalid/browse/PROJ-512', '```', '',
        'Key: PROJ-512', 'Source: https://Acme.Atlassian.net/browse/PROJ-512?focusedCommentId=9#comment-9', 'Fetched: PROJ-512@2026-11-01T10:00:00.000+0000', '',
      ].join('\n');
      onTrunk(hub, { 'docs/backlog/jira/PROJ-512.ticket.md': snapshot, 'docs/backlog/jira/PROJ-512.item.md': '# PROJ-512\n' });
      queue(hub, { prompt: '/dev-sprint PROJ-512' });
      await run(SENDER, hub);
      const lines = sentLines(platform);
      return [
        lines.length === 1 && lines[0].story === 'PROJ-512' && lines[0].feature === 'jira' || `the record left with ${lines[0]?.story} in ${lines[0]?.feature}`,
        lines.length === 1 && lines[0].ticket_url === 'https://acme.atlassian.net/browse/PROJ-512' || `the ticket URL is ${lines[0]?.ticket_url}`,
        lines.length === 1 && lines[0].epic === null && lines[0].epic_url === null || 'an intake story named an Epic',
        lines.every(rulesOk) || 'a line breaks the record rules',
      ];
    },
  },
  {
    n: 53, name: 'a link file that the laptop\'s origin/main does not hold yet: the record leaves at once, with no ticket and no Epic, never held',
    run: async ({ root, platform }) => {
      const hub = makeHub(root, { url: platform.url });
      onTrunk(hub, { 'docs/estate/trackers.json': TRACKERS, [LINKS_PATH]: LINKS }, { push: false });
      queue(hub);
      const r = await run(SENDER, hub);
      const lines = sentLines(platform);
      return [
        r.code === 0 && !r.out.includes('Waiting for a key: 1') || `the record was held: ${r.out}`,
        lines.length === 1 && lines[0].ticket_url === null && lines[0].epic === null && lines[0].epic_url === null || `the record named ${lines[0]?.ticket_url} and ${lines[0]?.epic}, which only the working tree holds`,
        lines.every(rulesOk) || 'a line breaks the record rules',
      ];
    },
  },
  {
    n: 54, name: 'no ticket is guessed: a ticket on an instance trackers.json does not name, a defect\'s sub-task, and a hub with no link file give null',
    run: async ({ root, platform }) => {
      const hub = makeHub(root, { url: platform.url });
      const links = { ...LINKS, epic: 'other:PLAT-10', items: { ...LINKS.items, 'PROJ-102': { type: 'story', board: 'platform', ticket: 'other:PLAT-345' } } };
      onTrunk(hub, { 'docs/estate/trackers.json': TRACKERS, [LINKS_PATH]: links });
      queue(hub);
      await run(SENDER, hub);
      const a = sentLines(platform);
      const other = makeHub(join(root, 'second'), { url: platform.url });
      onTrunk(other, { 'docs/estate/trackers.json': TRACKERS, [LINKS_PATH]: LINKS });
      queue(other, { prompt: '/dev-sprint PROJ-103' });
      const bare = makeHub(join(root, 'third'), { url: platform.url });
      queue(bare);
      await run(SENDER, other);
      await run(SENDER, bare);
      const lines = sentLines(platform);
      const b = lines.filter((l) => l.story === 'PROJ-103');
      const c = lines.slice(a.length).filter((l) => l.story === 'PROJ-102');
      return [
        a.length === 1 && a[0].ticket_url === null && a[0].epic === null || `an unknown instance gave ${a[0]?.ticket_url}, ${a[0]?.epic}`,
        b.length === 1 && b[0].ticket_url === null || `a defect's record named ${b[0]?.ticket_url}`,
        c.length === 1 && c[0].ticket_url === null && c[0].epic === null && c[0].epic_url === null || 'a hub with no Jira named a ticket',
        lines.every(rulesOk) || 'a line breaks the record rules',
      ];
    },
  },
  {
    n: 55, name: 'the record rules refuse a ticket URL of any other shape, a ticket with no story, an Epic with no feature, and an Epic and epic_url that disagree',
    run: async ({ root, platform }) => {
      const hub = makeHub(root, { url: platform.url });
      onTrunk(hub, { 'docs/estate/trackers.json': TRACKERS, [LINKS_PATH]: LINKS });
      queue(hub);
      await run(SENDER, hub);
      const good = asRecord(sentLines(platform)[0] || {});
      const breaks = (change, finding) => {
        const problems = core.record.validateRecord({ ...good, ...change });
        return problems.some((p) => p.includes(finding)) || `${JSON.stringify(change)} gave ${problems.join(' · ') || 'no finding'}`;
      };
      const shape = 'has a value of the wrong shape';
      const missing = { ...good };
      delete missing.ticket_url;
      return [
        core.record.validateRecord(good).length === 0 || `the control breaks the rules: ${core.record.validateRecord(good).join(' · ')}`,
        breaks({ ticket_url: 'http://acme.atlassian.net/browse/PLAT-345' }, `ticket_url ${shape}`),
        breaks({ ticket_url: `${STORY_URL}?focusedCommentId=9` }, `ticket_url ${shape}`),
        breaks({ ticket_url: 'https://acme.atlassian.net/jira/software/projects/PLAT/issues/PLAT-345' }, `ticket_url ${shape}`),
        breaks({ ticket_url: 'https://Acme.atlassian.net/browse/PLAT-345' }, `ticket_url ${shape}`),
        breaks({ ticket_url: 'see the ticket' }, `ticket_url ${shape}`),
        breaks({ epic: 'the checkout epic', epic_url: null }, `epic ${shape}`),
        breaks({ epic_url: 'https://acme.atlassian.net/browse/PLAT-11' }, 'do not name the same Epic'),
        breaks({ epic_url: null }, 'do not name the same Epic'),
        breaks({ story: null, scope: 'feature', key_from: 'command' }, 'ticket_url is set on a record with no story'),
        breaks({ story: null, ticket_url: null, feature: null, scope: 'none', key_from: null }, 'epic is set on a record with no feature'),
        core.record.validateRecord(missing).some((p) => p.includes(`ticket_url ${shape}`)) || 'a record with no ticket_url field passed',
      ];
    },
  },
  {
    n: 56, name: 'Grafana: the ticket URL and the Epic stay inside the line, and the labels are still job, hub and type',
    run: async ({ root, platform }) => {
      const hub = makeHub(root, { url: platform.url, platform: 'grafana' });
      onTrunk(hub, { 'docs/estate/trackers.json': TRACKERS, [LINKS_PATH]: LINKS });
      queue(hub);
      const r = await run(SENDER, hub);
      const body = JSON.parse((platform.seen[0] || { body: '{}' }).body);
      const s = (body.streams || [])[0] || { stream: {}, values: [] };
      const line = s.values[0] ? JSON.parse(s.values[0][1]) : {};
      return [
        r.code === 0 || `exit ${r.code}: ${r.out}`,
        JSON.stringify(s.stream) === JSON.stringify({ job: 'harness', hub: 'example-hub', type: 'tokens' }) || `the labels are ${JSON.stringify(s.stream)}`,
        line.ticket_url === STORY_URL && line.epic === 'PLAT-10' && line.epic_url === EPIC_URL || `the line holds ${line.ticket_url}, ${line.epic}, ${line.epic_url}`,
      ];
    },
  },
];

/* ------------------------------------------------------------------------------------ runner */

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

/**
 * A fake gh first on PATH, so no fixture reaches the real gh or the network. It answers the login
 * in FAKE_GH_LOGIN, or else it is signed out. FAKE_GH_CALLS names a file that gets one line for
 * each call.
 */
function fakeGh(sandbox) {
  const bin = join(sandbox, 'bin');
  mkdirSync(bin, { recursive: true });
  const script = join(bin, 'fake-gh.mjs');
  writeFileSync(script, [
    "import { appendFileSync } from 'node:fs';",
    "if (process.env.FAKE_GH_CALLS) appendFileSync(process.env.FAKE_GH_CALLS, `${process.argv.slice(2).join(' ')}\\n`);",
    "if (process.env.FAKE_GH_LOGIN) { process.stdout.write(`${process.env.FAKE_GH_LOGIN}\\n`); process.exit(0); }",
    "process.stderr.write('To get started with GitHub CLI, please run:  gh auth login\\n');",
    'process.exit(4);',
  ].join('\n'));
  writeFileSync(join(bin, 'gh'), `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
  chmodSync(join(bin, 'gh'), 0o755);
  process.env.PATH = `${bin}${delimiter}${process.env.PATH}`;
  for (const k of ['FAKE_GH_LOGIN', 'FAKE_GH_CALLS', 'GH_TOKEN', 'GITHUB_TOKEN', 'GH_HOST']) delete process.env[k];
}

async function main() {
  const sandbox = mkdtempSync(join(tmpdir(), 'observability-send-'));
  // A private HOME, so a developer's gitconfig cannot change a result.
  Object.assign(process.env, {
    HOME: sandbox, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
  });
  fakeGh(sandbox);
  for (const k of ['HARNESS_OBSERVABILITY_NOW', 'HARNESS_OBSERVABILITY_TIMEOUT_MS', 'HARNESS_TRUNK', 'HARNESS_OBSERVABILITY_TOKEN']) delete process.env[k];
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
    ? `\n${failed} of ${selected.length} fixtures FAILED. The sender is not trustworthy until this is green.\n`
    : `\nAll ${selected.length} fixtures passed.\n`);
  process.exit(failed ? 1 : 0);
}

await main();

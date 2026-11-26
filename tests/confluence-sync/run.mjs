#!/usr/bin/env node
/**
 * run.mjs — the fixture suite for confluence-sync.mjs (PLDC-712).
 *
 *   usage:  node run.mjs            run every fixture
 *           node run.mjs 3 7        run only the numbered fixtures
 *           node run.mjs --keep     leave the throwaway repositories on disk
 *
 * A fixture is a REPOSITORY STATE plus a SITE: a real hub or global context repository (a git
 * repository with a bare `origin`, the connection and the summaries committed on its trunk), and a
 * fake Confluence (fake-confluence.mjs) answering over real HTTP. The shipped script runs in the
 * repository as the context-sync workflow runs it, with the service account in the environment.
 * Exit code, output, the files written in its worktree, its commit, and what the fake was asked are
 * asserted. The script is never imported and never stubbed.
 *
 * check-context.mjs is stubbed, as the Jira suite stubs its siblings: its own suite proves what it
 * judges, and a real one needs a whole hub. The stub exits 1, naming the file, when a summary carries
 * FAIL-CHECK. Every summary the sync writes is instead parsed here with the real context-docs.mjs, so
 * a summary in the wrong form fails the fixture that wrote it.
 *
 * Every fixture also asserts that Confluence saw no request but a GET.
 *
 * Fixture 1 is the valid control. Most others change one thing.
 *
 * Node standard library only, plus git. No test framework.
 * Exit 0 if every fixture passes, 1 if any fails.
 */

import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { adrPage, DECISION, standardPage, startFake } from './fake-confluence.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

// Two layouts: the library, where the scripts are two levels up; and an adopting hub, where this
// suite lands at tests/confluence-sync/ and the scripts at scripts/.
const first = (...c) => c.filter(Boolean).find((p) => existsSync(p));
const SCRIPTS = first(
  process.env.HARNESS_SCRIPTS_DIR,
  existsSync(resolve(HERE, '..', '..', 'confluence-sync.mjs')) ? resolve(HERE, '..', '..') : null,
  existsSync(resolve(HERE, '..', '..', 'scripts', 'confluence-sync.mjs')) ? resolve(HERE, '..', '..', 'scripts') : null,
);
if (!SCRIPTS) {
  console.error('cannot locate confluence-sync.mjs. Set HARNESS_SCRIPTS_DIR=/path/to/the/scripts/folder.');
  process.exit(4);
}
const KEEP = process.argv.includes('--keep');
const { parseDocument } = await import(pathToFileURL(join(SCRIPTS, 'context-docs.mjs')).href);

const SUBJECT = 'docs(context): sync ADRs and standards from Confluence';
const WATERMARK = 'Generated-by: SHL Agentic Harness';
const USER = 'sync@example.invalid';
const TOKEN = 'fixture-token';

/* ----------------------------------------------------------------------- git helpers */

const SANDBOX_HOME = mkdtempSync(join(tmpdir(), 'confluence-sync-home-'));
const ENV = {
  ...process.env,
  HOME: SANDBOX_HOME,
  XDG_CONFIG_HOME: join(SANDBOX_HOME, '.config'),
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
  GIT_ASKPASS: 'true',
};
for (const k of ['HARNESS_TRUNK', 'CONFLUENCE_USER', 'CONFLUENCE_API_TOKEN', 'HARNESS_CONFLUENCE_GATEWAY']) delete ENV[k];

const git = (cwd, args) => execFileSync('git', args, { cwd, env: ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const identity = (cwd, name = 'Fixture Runner') => {
  for (const [k, v] of [['user.name', name], ['user.email', 'fixture@example.invalid'], ['commit.gpgsign', 'false']]) git(cwd, ['config', k, v]);
};

function write(root, rel, body) {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, typeof body === 'string' ? body : `${JSON.stringify(body, null, 2)}\n`);
}

// The check-context stub: exit 1 naming each summary that carries FAIL-CHECK, else exit 0.
const CHECK_STUB = `#!/usr/bin/env node
import { readdirSync, readFileSync, existsSync } from 'node:fs';
const bad = [];
for (const dir of ['docs/architecture', 'docs/standards']) {
  if (!existsSync(dir)) continue;
  for (const f of readdirSync(dir)) if (f.endsWith('.md') && readFileSync(dir + '/' + f, 'utf8').includes('FAIL-CHECK')) bad.push(dir + '/' + f);
}
for (const b of bad) process.stdout.write(b + ': carries FAIL-CHECK\\n');
process.exit(bad.length ? 1 : 0);
`;

/* ----------------------------------------------------------------------- the Confluence tree */

// Key decisions (1) > global (2) > "ADRs - global" (3), "standards - global" (4);
// hubs (5) > NOVA (6) > "ADRs - NOVA" (7), "standards - NOVA" (8); hubs > ALPHA (9) > "ADRs - ALPHA" (10);
// templates (12) > <templateHubName> (13) > "ADRs - <templateHubName>" (14), which the sync never reads.
const TREE = [
  { id: '1', type: 'folder', title: 'Key decisions' },
  { id: '2', type: 'folder', title: 'global', parent: '1' },
  { id: '3', type: 'folder', title: 'ADRs - global', parent: '2' },
  { id: '4', type: 'folder', title: 'standards - global', parent: '2' },
  { id: '5', type: 'folder', title: 'hubs', parent: '1' },
  { id: '6', type: 'folder', title: 'NOVA', parent: '5' },
  { id: '7', type: 'folder', title: 'ADRs - NOVA', parent: '6' },
  { id: '8', type: 'folder', title: 'standards - NOVA', parent: '6' },
  { id: '9', type: 'folder', title: 'ALPHA', parent: '5' },
  { id: '10', type: 'folder', title: 'ADRs - ALPHA', parent: '9' },
  { id: '12', type: 'folder', title: 'templates', parent: '1' },
  { id: '13', type: 'folder', title: '<templateHubName>', parent: '12' },
  { id: '14', type: 'folder', title: 'ADRs - <templateHubName>', parent: '13' },
  { id: '15', type: 'page', title: 'ADR-999: A page inside the templates folder', parent: '14' },
];
const G_ADRS = '3';
const G_STDS = '4';
const H_ADRS = '7';
const A_ADRS = '10';

const page = (id, parent, title, adf, extra = {}) => ({ id: String(id), type: 'page', parent, title, adf, ...extra });
const ADR_101 = (extra = {}, body = {}) => page(101, G_ADRS, 'ADR-101: We use Postgres for every new relational store', adrPage(body), { author: 'acc-a', ...extra });

/* ----------------------------------------------------------------------- one world */

async function world(root, spec) {
  const fake = await startFake({ user: USER, token: TOKEN, space: 'TEST', nodes: [...TREE, ...(spec.nodes || [])], people: { 'acc-a': 'Ada Author', 'acc-b': 'Bea Builder' }, fail: spec.fail });
  const bare = join(root, 'repo.git');
  const work = join(root, 'repo');
  git(root, ['init', '--bare', '-q', '--initial-branch', 'main', bare]);
  git(root, ['init', '-q', '--initial-branch', 'main', work]);
  identity(work);
  git(work, ['remote', 'add', 'origin', bare]);
  mkdirSync(join(work, 'scripts'), { recursive: true });
  for (const f of ['confluence-sync.mjs', 'confluence.mjs', 'confluence-page.mjs', 'context-docs.mjs', 'spoke-remote.mjs', 'spoke-rules.mjs']) copyFileSync(join(SCRIPTS, f), join(work, 'scripts', f));
  if (spec.level !== 'global') {
    // A hub commits through the harness's commit helper, with the files it imports.
    for (const f of ['harness-commit.mjs', 'check-watermark.mjs', 'check-staged.mjs', 'check-coverage.mjs', 'spoke-trunk.mjs']) {
      const src = first(join(SCRIPTS, f), join(SCRIPTS, '..', 'gate', f));
      if (src) copyFileSync(src, join(work, 'scripts', f));
    }
    mkdirSync(join(work, 'scripts', 'test-guard'), { recursive: true });
    for (const f of ['contract.mjs', 'common.mjs', 'git.mjs']) {
      const src = first(join(SCRIPTS, 'test-guard', f), join(SCRIPTS, '..', 'gate', 'test-guard', f));
      if (src) copyFileSync(src, join(work, 'scripts', 'test-guard', f));
    }
    if (spec.ledger !== null) write(work, 'docs/backlog/keys.json', spec.ledger || { schema_version: 1, prefix: spec.key || 'NOVA', next: 1, blocks: [] });
  }
  write(work, 'scripts/check-context.mjs', CHECK_STUB);
  const connection = spec.connection === undefined ? { schema_version: 1, site: fake.origin, space: 'TEST', root_folder: '1', mode: 'site' } : spec.connection;
  if (connection !== null) write(work, 'docs/estate/confluence.json', typeof connection === 'function' ? connection(fake) : connection);
  if (spec.template !== false) write(work, 'docs/architecture/_TEMPLATE.adr.md', '# template\n');
  for (const [rel, body] of Object.entries(spec.files || {})) write(work, rel, body);
  write(work, 'README.md', '# repository\n');
  git(work, ['add', '-A']);
  git(work, ['commit', '-q', '-m', 'repository']);
  git(work, ['push', '-q', 'origin', 'main']);

  let outs = 0;
  const w = {
    root, work, bare, fake,
    level: spec.level || 'global',
    env: { CONFLUENCE_USER: USER, CONFLUENCE_API_TOKEN: TOKEN, ...(spec.env || {}) },
    /** Run the script. `verb` is plan or apply; apply gets a fresh --out. `extra.node` are options for Node. */
    run(verb = 'apply', extra = {}) {
      const args = [...(extra.node || []), join(work, 'scripts', 'confluence-sync.mjs'), verb, '--level', extra.level || w.level];
      let out = null;
      if (verb === 'apply') { outs += 1; out = join(root, `out-${outs}`); args.push('--out', out); }
      args.push(...(extra.args || []));
      return new Promise((resolveRun) => {
        const child = spawn(process.execPath, args, { cwd: work, env: { ...ENV, ...w.env, ...(extra.env || {}) } });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (d) => { stdout += d; });
        child.stderr.on('data', (d) => { stderr += d; });
        child.on('close', (status) => {
          let result = null;
          try { result = JSON.parse(stdout); } catch { result = null; }
          resolveRun({ status, stdout, stderr, out, result });
        });
      });
    },
    /** Merge a run's commit into the trunk, as the person who merges the pull request does. */
    merge(r) {
      if (!r.result || !r.result.changed) throw new Error('merge: the run made no commit');
      git(r.result.worktree, ['push', '-q', 'origin', 'HEAD:main']);
      git(work, ['worktree', 'remove', '--force', r.result.worktree]);
      git(work, ['fetch', '-q', 'origin']);
    },
    /** A person's commit straight onto the trunk, from a second clone. */
    pushFile(rel, change, name = 'Hub Editor') {
      const clone = join(root, `pusher-${Date.now()}-${Math.random().toString(16).slice(2)}`);
      git(root, ['clone', '-q', bare, clone]);
      identity(clone, name);
      const abs = join(clone, rel);
      write(clone, rel, typeof change === 'function' ? change(existsSync(abs) ? readFileSync(abs, 'utf8') : '') : change);
      git(clone, ['add', '-A']);
      git(clone, ['commit', '-q', '-m', `edit ${rel}`]);
      git(clone, ['push', '-q', 'origin', 'main']);
    },
    /** A file on the trunk, or null. */
    trunk(rel) { try { return git(bare, ['show', `main:${rel}`]); } catch { return null; } },
    /** A file the run wrote in its worktree, or null. */
    wrote(r, rel) { const p = r.result && r.result.worktree ? join(r.result.worktree, rel) : null; return p && existsSync(p) ? readFileSync(p, 'utf8') : null; },
    node: (id) => fake.state.nodes.get(String(id)),
  };
  return w;
}

/* ----------------------------------------------------------------------- assertions */

const items = (r) => (r.result && Array.isArray(r.result.items) ? r.result.items : []);
const itemOf = (r, pred) => items(r).find(pred) || null;
const byId = (r, id) => itemOf(r, (i) => i.id === id);
const body = (r) => (r.out && existsSync(join(r.out, 'pr-body.md')) ? readFileSync(join(r.out, 'pr-body.md'), 'utf8') : '');
const summary = (r) => (r.out && existsSync(join(r.out, 'job-summary.md')) ? readFileSync(join(r.out, 'job-summary.md'), 'utf8') : '');
const ADR_101_PATH = 'docs/architecture/ADR-101-we-use-postgres-for-every-new.md';

function expectAction(r, id, action) {
  const i = byId(r, id);
  return !i ? [`no item for ${id}; items: ${JSON.stringify(items(r).map((x) => [x.id, x.action]))}`] : i.action !== action ? [`${id} is ${i.action} (${i.why}), expected ${action}`] : [];
}

function wellFormed(text, path) {
  if (text === null) return [`${path} was not written`];
  const kind = path.startsWith('docs/standards/') ? 'standard' : 'adr';
  const doc = parseDocument(path, text, [kind]);
  return doc.findings.map((f) => `context-docs refuses ${path}: ${f}`);
}

function lastCommit(r) {
  if (!r.result || !r.result.worktree) return null;
  return git(r.result.worktree, ['log', '-1', '--format=%B']).trim();
}

function committedWithWatermark(r) {
  const msg = lastCommit(r);
  if (msg === null) return ['no commit'];
  const p = [];
  if (!msg.startsWith(SUBJECT)) p.push(`the commit subject is not "${SUBJECT}": ${msg.split('\n')[0]}`);
  if (msg.trim().split('\n').pop() !== WATERMARK) p.push('the commit does not end with the watermark');
  return p;
}

/** Sync once, merge, then change the site with `change` and return the second run. */
async function syncedThen(w, change, verb = 'apply') {
  const r1 = await w.run();
  if (r1.status !== 0) throw new Error(`the first sync exited ${r1.status}: ${r1.stderr}`);
  w.merge(r1);
  await change(w);
  return w.run(verb);
}

const approvedAgain = (w, n, fields) => { Object.assign(w.node(n), fields); };

/**
 * Run the script with a preload that writes each Node process's execArgv, one JSON line, to a log.
 * The script's restart with --use-system-ca passes the preload on, so the log shows every start.
 */
async function runLogged(w, env = {}) {
  const preload = join(w.root, 'record-argv.mjs');
  const log = join(w.root, 'argv.log');
  writeFileSync(preload, "import { appendFileSync } from 'node:fs';\nappendFileSync(process.env.FIXTURE_ARGV_LOG, JSON.stringify(process.execArgv) + '\\n');\n");
  const r = await w.run('apply', { node: ['--import', pathToFileURL(preload).href], env: { FIXTURE_ARGV_LOG: log, ...env } });
  r.starts = existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  return r;
}
const systemCa = (argv) => argv.filter((a) => a === '--use-system-ca').length;

/* ----------------------------------------------------------------------- the fixtures */

const FIXTURES = [
  { n: 1, name: 'the valid control: a new approved ADR page under global writes its summary in the global repository (case 1)', exit: 0,
    level: 'global', nodes: [ADR_101()],
    check: (w, r) => {
      const p = [...expectAction(r, 'ADR-101', 'created'), ...wellFormed(w.wrote(r, ADR_101_PATH), ADR_101_PATH), ...committedWithWatermark(r)];
      const t = w.wrote(r, ADR_101_PATH) || '';
      if (!t.includes('status: Accepted')) p.push('the status is not Accepted');
      if (!t.includes('revision: 1')) p.push('the revision is not the page version 1');
      if (!t.includes('(Confluence page 101)')) p.push('the origin does not name the page id');
      if (!t.includes(`description: ${DECISION}`)) p.push('the description is not the first Decision sentence');
      if (!t.includes('globs: ["services/orders/**","libs/db/**"]')) p.push('Applies to did not become the globs');
      if (!t.includes('- Not keep every engine, because three sets of backups to run.')) p.push('an option did not become a Rejected line');
      if (!r.result.changed) p.push('changed is false');
      if (!body(r).includes('Ada Author')) p.push('the pull request does not name the author of the page version');
      if (body(r).trim().split('\n').pop() !== WATERMARK) p.push('the pull request description does not end with the watermark');
      const top = body(r).split('\n').filter(Boolean);
      if (!top[0].startsWith('**Confluence:** ') || !top[0].includes(' · **Space:** TEST · **Folder:** Key decisions > global · **Level:** global')) p.push(`the description does not open with the bold source line: ${top[0]}`);
      if (top[1] !== '**1 created**') p.push(`the counts are not one bold line: ${top[1]}`);
      if (byId(r, 'ADR-999') || w.fake.state.requests.some((q) => q.path.includes('/folders/13') || q.path.includes('/folders/14'))) p.push('the run read the templates folder');
      return p;
    } },
  { n: 2, name: 'a hub run writes only the pages of its own folder, and commits through harness-commit.mjs (case 15)', exit: 0,
    level: 'hub', nodes: [ADR_101(), page(201, H_ADRS, 'ADR-201: The hub keeps one queue', adrPage())],
    check: (w, r) => {
      const p = [...expectAction(r, 'ADR-201', 'created'), ...committedWithWatermark(r)];
      if (byId(r, 'ADR-101')) p.push('a global page reached the hub run');
      const path = 'docs/architecture/ADR-201-the-hub-keeps-one-queue.md';
      return [...p, ...wellFormed(w.wrote(r, path), path)];
    } },
  { n: 3, name: 'a second hub with its own folder syncs its pages only (case 15)', exit: 0,
    level: 'hub', key: 'ALPHA', nodes: [page(201, H_ADRS, 'ADR-201: A NOVA record', adrPage()), page(301, A_ADRS, 'ADR-301: An ALPHA record', adrPage())],
    check: (w, r) => [...expectAction(r, 'ADR-301', 'created'), ...(byId(r, 'ADR-201') ? ['the NOVA page reached the ALPHA run'] : [])] },
  { n: 4, name: 'an approved page that changes: the summary text changes and the revision moves (case 2)', exit: 0,
    level: 'global', nodes: [ADR_101()],
    run: (w) => syncedThen(w, () => approvedAgain(w, 101, { version: 2, adf: adrPage({ context: 'Three engines run in production today.' }) })),
    check: (w, r) => {
      const t = w.wrote(r, ADR_101_PATH) || '';
      const p = [...expectAction(r, 'ADR-101', 'updated'), ...wellFormed(t, ADR_101_PATH)];
      if (!t.includes('revision: 2')) p.push('the revision did not move to 2');
      if (!t.includes('Three engines run in production today.')) p.push('the new Context did not reach Why');
      if (byId(r, 'ADR-101').lostEdit) p.push('a lost edit is reported where nobody edited the harness');
      return p;
    } },
  { n: 5, name: 'an approved page moves to Superseded by ADR-102: the file stays and only its status line changes (case 3)', exit: 0,
    level: 'global', nodes: [ADR_101()],
    run: (w) => syncedThen(w, () => approvedAgain(w, 101, { version: 2, adf: adrPage({ status: 'Superseded by ADR-102' }) })),
    check: (w, r) => {
      const before = w.trunk(ADR_101_PATH) || '';
      const t = w.wrote(r, ADR_101_PATH) || '';
      const p = [...expectAction(r, 'ADR-101', 'demoted')];
      if (!t.includes('status: Superseded by ADR-102')) p.push('the status line is not Superseded by ADR-102');
      if (t.replace(/^status: .*$/m, '') !== before.replace(/^status: .*$/m, '')) p.push('more than the status line changed');
      return p;
    } },
  { n: 6, name: 'an approved page moves to Rejected: Deprecated, and listed (case 3)', exit: 0,
    level: 'global', nodes: [ADR_101()],
    run: (w) => syncedThen(w, () => approvedAgain(w, 101, { version: 2, adf: adrPage({ status: 'Rejected' }) })),
    check: (w, r) => {
      const p = [...expectAction(r, 'ADR-101', 'demoted')];
      if (!(w.wrote(r, ADR_101_PATH) || '').includes('status: Deprecated')) p.push('the status is not Deprecated');
      if (!body(r).includes('### Demoted')) p.push('the pull request does not list the demotion');
      return p;
    } },
  { n: 7, name: 'an approved page moves to In discussion: Deprecated; approved again, the next run restores Accepted (case 4)', exit: 0,
    level: 'global', nodes: [ADR_101()],
    run: async (w) => {
      const r2 = await syncedThen(w, () => approvedAgain(w, 101, { version: 2, adf: adrPage({ status: 'In discussion' }) }));
      if (expectAction(r2, 'ADR-101', 'demoted').length) return r2;
      w.merge(r2);
      approvedAgain(w, 101, { version: 3, adf: adrPage({ status: 'Approved' }) });
      return w.run();
    },
    check: (w, r) => {
      const p = [...expectAction(r, 'ADR-101', 'restored')];
      if (!(w.wrote(r, ADR_101_PATH) || '').includes('status: Accepted')) p.push('the status was not restored to Accepted');
      return p;
    } },
  { n: 8, name: 'an approved page is deleted: its summary becomes Deprecated, and is listed (case 4)', exit: 0,
    level: 'global', nodes: [ADR_101()],
    run: (w) => syncedThen(w, () => approvedAgain(w, 101, { status: 'trashed' })),
    check: (w, r) => {
      const p = [...expectAction(r, 'ADR-101', 'demoted')];
      if (!(w.wrote(r, ADR_101_PATH) || '').includes('status: Deprecated')) p.push('the status is not Deprecated');
      return p;
    } },
  { n: 9, name: 'a page with status Proposed and no harness file: nothing appears, and no commit is made (case 5)', exit: 0,
    level: 'global', nodes: [ADR_101({}, { status: 'Proposed' })],
    check: (w, r) => [...expectAction(r, 'ADR-101', 'no-file'), ...(r.result.changed ? ['changed is true'] : []), ...(w.wrote(r, ADR_101_PATH) ? ['a file was written'] : [])] },
  { n: 10, name: 'the owner is copied as written, a person\'s name included, and an empty section reads None. (case 6)', exit: 0,
    level: 'global', nodes: [ADR_101({}, { owner: 'Ada Author (BCG)', context: '' })],
    check: (w, r) => {
      const t = w.wrote(r, ADR_101_PATH) || '';
      const p = [...expectAction(r, 'ADR-101', 'created'), ...wellFormed(t, ADR_101_PATH)];
      if (!t.includes('owner: Ada Author (BCG)')) p.push('the owner was not copied as written');
      if (!t.match(/## Why\n\nNone\.\n/)) p.push('the empty Context did not become "None." under Why');
      return p;
    } },
  { n: 11, name: 'a page with no Rules section is listed as needs reformatting and writes no file (case 7)', exit: 0,
    level: 'global', nodes: [ADR_101({}, { omit: ['Rules'] })],
    check: (w, r) => [...expectAction(r, 'ADR-101', 'reformat'), ...(w.wrote(r, ADR_101_PATH) ? ['a file was written'] : []), ...(summary(r).includes('Needs reformatting') ? [] : ['the job summary does not list it'])] },
  { n: 12, name: 'a page with no Applies to section needs reformatting (case 7)', exit: 0,
    level: 'global', nodes: [ADR_101({}, { omit: ['Applies to'] })],
    check: (w, r) => expectAction(r, 'ADR-101', 'reformat') },
  { n: 13, name: 'a first Decision sentence over 200 characters needs reformatting (case 7)', exit: 0,
    level: 'global', nodes: [ADR_101({}, { decision: `We use Postgres for every new service ${'that needs a relational store and keeps one schema per domain '.repeat(4)}always.` })],
    check: (w, r) => expectAction(r, 'ADR-101', 'reformat') },
  { n: 14, name: 'a section the template does not have needs reformatting (case 7)', exit: 0,
    level: 'global', nodes: [ADR_101({}, { extra: 'Proposed direction' })],
    check: (w, r) => [...expectAction(r, 'ADR-101', 'reformat'), ...(byId(r, 'ADR-101') && byId(r, 'ADR-101').why.includes('Proposed direction') ? [] : ['the reason does not name the section'])] },
  { n: 15, name: 'Applies to that names no path, "whole estate" or "None" needs reformatting (case 7)', exit: 0,
    level: 'global', nodes: [ADR_101({}, { applies: 'the payments code' })],
    check: (w, r) => expectAction(r, 'ADR-101', 'reformat') },
  { n: 16, name: 'a harness edit, then the approved page changes: Confluence wins, and the pull request names the lost edit and its author (case 8)', exit: 0,
    level: 'global', nodes: [ADR_101()],
    run: (w) => syncedThen(w, () => {
      w.pushFile(ADR_101_PATH, (t) => t.replace('## Rules\n', '## Rules\n\n- MUST ALSO log every query.\n'), 'Hub Editor');
      approvedAgain(w, 101, { version: 2, adf: adrPage({ context: 'Changed in Confluence.' }) });
    }),
    check: (w, r) => {
      const i = byId(r, 'ADR-101');
      const p = [...expectAction(r, 'ADR-101', 'updated')];
      if (!i || !i.lostEdit) return [...p, 'no lost edit was reported'];
      if (!i.lostEdit.authors.some((a) => a.includes('Hub Editor'))) p.push('the lost edit does not name its author');
      if (!body(r).includes('MUST ALSO log every query')) p.push('the pull request does not show the lost line');
      if ((w.wrote(r, ADR_101_PATH) || '').includes('MUST ALSO')) p.push('the harness edit survived; Confluence must win');
      return p;
    } },
  { n: 17, name: 'two pages claim ADR-107: neither is written, and both are listed (case 9)', exit: 0,
    level: 'global', nodes: [page(107, G_ADRS, 'ADR-107: One claim', adrPage()), page(108, G_ADRS, 'ADR-107: A second claim', adrPage())],
    check: (w, r) => {
      const dup = items(r).filter((i) => i.id === 'ADR-107' && i.action === 'duplicate');
      return [...(dup.length === 2 ? [] : [`${dup.length} duplicate items, expected 2`]), ...(r.result.changed ? ['a file was written'] : [])];
    } },
  { n: 18, name: 'one page fails and nine succeed: nine are written, one is listed, and the run exits 0 (case 10)', exit: 0,
    level: 'global',
    nodes: [...Array.from({ length: 9 }, (_, k) => page(110 + k, G_ADRS, `ADR-${110 + k}: Record number ${k + 1}`, adrPage())), page(119, G_ADRS, 'ADR-119: A broken page', null, { rawBody: '{not json' })],
    check: (w, r) => {
      const made = items(r).filter((i) => i.action === 'created').length;
      const failed = items(r).filter((i) => i.action === 'failed' && String(i.page) === '119').length;
      return [...(made === 9 ? [] : [`${made} created, expected 9`]), ...(failed === 1 ? [] : ['the broken page is not listed as failed'])];
    } },
  { n: 19, name: 'the run repeats with no change: no commit, so no pull request (case 11)', exit: 0,
    level: 'global', nodes: [ADR_101()],
    run: (w) => syncedThen(w, () => {}),
    check: (w, r) => [...expectAction(r, 'ADR-101', 'unchanged'), ...(r.result.changed ? ['changed is true'] : []), ...(summary(r).includes('no pull request') ? [] : ['the job summary does not say there is no pull request'])] },
  { n: 20, name: 'Confluence cannot be reached: the run stops, changes nothing and says so (case 12)', exit: 2,
    level: 'global', nodes: [ADR_101()], connection: { schema_version: 1, site: 'http://127.0.0.1:9', space: 'TEST', root_folder: '1', mode: 'site' },
    check: (w, r) => [...(r.stderr.includes('could not be reached') ? [] : ['the run does not say Confluence could not be reached']), ...(r.stderr.includes('REASON: wiki-unreachable') ? [] : ['no REASON: wiki-unreachable']), ...(existsSync(join(r.out, 'worktree')) ? ['a worktree was made'] : [])] },
  { n: 21, name: 'a refused credential: exit 2, and the reason is auth-failed', exit: 2,
    level: 'global', nodes: [ADR_101()], env: { CONFLUENCE_API_TOKEN: 'wrong' },
    check: (w, r) => (r.stderr.includes('REASON: auth-failed') ? [] : ['no REASON: auth-failed']) },
  { n: 22, name: 'a page outside ADRs and standards is ignored and listed, and a global page with a shl-hub- label is skipped (case 13)', exit: 0,
    level: 'global', nodes: [page(150, '2', 'ADR-150: Directly under global', adrPage()), page(151, G_ADRS, 'ADR-151: A hub record in the wrong place', adrPage(), { labels: ['shl-hub-nova'] })],
    check: (w, r) => {
      const p = [];
      if (!itemOf(r, (i) => i.action === 'ignored' && String(i.page) === '150')) p.push('the page under global is not listed as ignored');
      return [...p, ...expectAction(r, 'ADR-151', 'skipped'), ...(r.result.changed ? ['a file was written'] : [])];
    } },
  { n: 23, name: 'a summary that no page holds is listed every run, and its file stays (case 14)', exit: 0,
    level: 'global', nodes: [], files: { 'docs/architecture/ADR-004-only-in-the-harness.md': '---\nname: ADR-004\ndescription: Only in the harness.\nglobs: []\nalwaysApply: false\nkind: adr\nstatus: Accepted\nowner: lead architect\nrevision: v1\norigin: architecture board minutes\n---\n\n# ADR-004: Only in the harness\n' },
    check: (w, r) => [...expectAction(r, 'ADR-004', 'orphan'), ...(r.result.changed ? ['the file changed'] : [])] },
  { n: 24, name: 'a hub with no folder in the tree is listed, and nothing is written (case 14)', exit: 0,
    level: 'hub', key: 'BETA', nodes: [ADR_101()],
    check: (w, r) => [...(itemOf(r, (i) => i.action === 'missing-folder') ? [] : ['the missing folder is not listed']), ...(r.result.changed ? ['a file was written'] : [])] },
  { n: 25, name: 'a standard page that is Reserved writes Reserved; then Rejected writes Deprecated (case 16)', exit: 0,
    level: 'global', nodes: [page(401, G_STDS, 'std-api-naming: API path naming', standardPage({ topic: 'api-naming', status: 'Reserved' }))],
    run: async (w) => {
      const r1 = await w.run();
      const path = 'docs/standards/std-api-naming.md';
      const p = [...expectAction(r1, 'std-api-naming', 'created'), ...wellFormed(w.wrote(r1, path), path)];
      if (!(w.wrote(r1, path) || '').includes('status: Reserved')) p.push('the first run did not write Reserved');
      if (p.length) return { ...r1, early: p };
      w.merge(r1);
      approvedAgain(w, 401, { version: 2, adf: standardPage({ topic: 'api-naming', status: 'Rejected' }) });
      return w.run();
    },
    check: (w, r) => {
      if (r.early) return r.early;
      const path = 'docs/standards/std-api-naming.md';
      return [...expectAction(r, 'std-api-naming', 'demoted'), ...((w.wrote(r, path) || '').includes('status: Deprecated') ? [] : ['the status is not Deprecated']), ...wellFormed(w.wrote(r, path), path)];
    } },
  { n: 26, name: 'an approved standard: Summary gives the description, the Scope box the globs, "In words" Applies to; Contact and Links are not copied, and the Values column For becomes Applies to', exit: 0,
    level: 'global', nodes: [page(402, G_STDS, 'std-event-naming: Event naming', standardPage({ topic: 'event-naming' }))],
    check: (w, r) => {
      const path = 'docs/standards/std-event-naming.md';
      const t = w.wrote(r, path) || '';
      const p = [...expectAction(r, 'std-event-naming', 'created'), ...wellFormed(t, path)];
      if (!t.includes('status: Active')) p.push('the status is not Active');
      if (!t.includes('description: How every public API names its event-naming.')) p.push('Summary did not become the description');
      if (!t.includes('globs: ["**/*.ts","**/*.tsx"]')) p.push('the TypeScript box did not become the globs');
      if (!t.match(/## Applies to\n\nEvery public HTTP API\. Internal events are not covered\.\n/)) p.push('"In words" did not become the Applies to section');
      if (t.includes('TypeScript') || t.includes('Scope')) p.push('the Scope boxes were copied');
      if (!t.includes('- **std-event-naming.01** MUST use kebab-case')) p.push('a rule lost its id');
      if (!t.includes('- **std-event-naming.03** SHOULD keep')) p.push('the SHOULD rule is missing');
      if (!t.includes('| Value | Setting | Applies to | Source |')) p.push('the Values column For did not become Applies to');
      if (t.includes('Ada Author') || t.includes('Jira:') || t.includes('## Links')) p.push('Contact or Links reached the summary');
      return p;
    } },
  { n: 27, name: 'a standard rule without its id needs reformatting (R-12)', exit: 0,
    level: 'global', nodes: [page(403, G_STDS, 'std-error-format: Error format', standardPage({ topic: 'error-format', ids: false }))],
    check: (w, r) => expectAction(r, 'std-error-format', 'reformat') },
  { n: 28, name: 'an approved page moved from a hub folder to global: the global run writes it, and the hub run lists the hub summary with its new place (case 17)', exit: 0,
    level: 'hub', nodes: [page(201, H_ADRS, 'ADR-201: The hub keeps one queue', adrPage())],
    run: async (w) => {
      const r1 = await w.run();
      w.merge(r1);
      w.node(201).parent = G_ADRS;
      return w.run();
    },
    check: (w, r) => {
      const i = byId(r, 'ADR-201');
      const p = [...expectAction(r, 'ADR-201', 'moved')];
      if (i && !String(i.location).includes('global')) p.push(`the new location is ${i.location}`);
      if (r.result.changed) p.push('the hub summary changed');
      return p;
    } },
  { n: 29, name: 'a title that says Obsolete demotes an approved record to Deprecated (R-08)', exit: 0,
    level: 'global', nodes: [ADR_101()],
    run: (w) => syncedThen(w, () => approvedAgain(w, 101, { version: 2, title: '(Obsolete) ADR-101: We use Postgres for every new relational store' })),
    check: (w, r) => [...expectAction(r, 'ADR-101', 'demoted'), ...((w.wrote(r, ADR_101_PATH) || '').includes('status: Deprecated') ? [] : ['the status is not Deprecated'])] },
  { n: 30, name: 'a page retitled to another id clashes with the record it wrote: neither changes (R-14)', exit: 0,
    level: 'global', nodes: [ADR_101()],
    run: (w) => syncedThen(w, () => approvedAgain(w, 101, { version: 2, title: 'ADR-150: Now another record' })),
    check: (w, r) => [...expectAction(r, 'ADR-150', 'duplicate'), ...(r.result.changed ? ['a file changed'] : [])] },
  { n: 31, name: 'check-context refuses one summary: it is listed as failed, and the others are committed', exit: 0,
    level: 'global', nodes: [ADR_101(), page(102, G_ADRS, 'ADR-102: A record the check refuses', adrPage({ context: 'FAIL-CHECK' }))],
    check: (w, r) => [...expectAction(r, 'ADR-101', 'created'), ...expectAction(r, 'ADR-102', 'failed'), ...(w.wrote(r, 'docs/architecture/ADR-102-a-record-the-check-refuses.md') ? ['the refused summary is still in the commit'] : [])] },
  { n: 32, name: 'the gateway: a token with scopes reads through api.atlassian.com/ex/confluence/<cloud id>', exit: 0,
    level: 'global', nodes: [ADR_101()],
    connection: (fake) => ({ schema_version: 1, site: fake.origin, space: 'TEST', root_folder: '1', mode: 'gateway' }),
    env: {},
    before: (w) => { w.env.HARNESS_CONFLUENCE_GATEWAY = w.fake.origin; },
    check: (w, r) => {
      const wiki = w.fake.state.requests.filter((q) => q.path.startsWith('/wiki/'));
      return [...expectAction(r, 'ADR-101', 'created'), ...(wiki.length && wiki.every((q) => q.gateway) ? [] : ['a request did not go through the gateway'])];
    } },
  { n: 33, name: 'no connection file: the repository has no sync, and the run says so with exit 0', exit: 0,
    level: 'global', nodes: [], connection: null,
    check: (w, r) => (r.result && r.result.configured === false ? [] : ['expected {"configured": false}']) },
  { n: 34, name: 'a connection file that is not well formed stops the run with exit 1, before Confluence is asked', exit: 1,
    level: 'global', nodes: [], connection: { schema_version: 1, site: 'ftp://nowhere', space: 'TEST', root_folder: 'one', mode: 'both' },
    check: (w, r) => [...(r.stderr.includes('not well formed') ? [] : ['the run does not say the file is not well formed']), ...(w.fake.state.requests.length ? ['Confluence was asked'] : [])] },
  { n: 35, name: 'no credential in the environment: exit 2, credential-missing', exit: 2,
    level: 'global', nodes: [], env: { CONFLUENCE_API_TOKEN: '' },
    check: (w, r) => (r.stderr.includes('REASON: credential-missing') ? [] : ['no REASON: credential-missing']) },
  { n: 36, name: 'plan reads and writes nothing: no worktree, the decisions on stdout', exit: 0,
    level: 'global', nodes: [ADR_101()],
    run: (w) => w.run('plan'),
    check: (w, r) => [...expectAction(r, 'ADR-101', 'created'), ...(git(w.work, ['worktree', 'list']).trim().split('\n').length === 1 ? [] : ['plan made a worktree'])] },
  { n: 37, name: 'Scope: "All code" ticked alone binds every design (alwaysApply: true)', exit: 0,
    level: 'global', nodes: [page(410, G_STDS, 'std-eng-logs: Logging', standardPage({ topic: 'eng-logs', scope: ['All code'] }))],
    check: (w, r) => {
      const path = 'docs/standards/std-eng-logs.md';
      const t = w.wrote(r, path) || '';
      return [...expectAction(r, 'std-eng-logs', 'created'), ...wellFormed(t, path), ...(t.includes('alwaysApply: true') && t.includes('globs: []') ? [] : ['"All code" did not give alwaysApply: true and globs: []'])];
    } },
  { n: 38, name: 'Scope: "Only when a design asks" ticked alone gives globs: [] and alwaysApply: false', exit: 0,
    level: 'global', nodes: [page(411, G_STDS, 'std-arch-data: Data ownership', standardPage({ topic: 'arch-data', scope: ['Only when a design asks for this rule explicitly'] }))],
    check: (w, r) => {
      const t = w.wrote(r, 'docs/standards/std-arch-data.md') || '';
      return [...expectAction(r, 'std-arch-data', 'created'), ...(t.includes('alwaysApply: false') && t.includes('globs: []') ? [] : ['the page did not give globs: [] and alwaysApply: false'])];
    } },
  { n: 39, name: 'Scope: "All code" ticked with another box needs reformatting', exit: 0,
    level: 'global', nodes: [page(412, G_STDS, 'std-eng-logs: Logging', standardPage({ topic: 'eng-logs', scope: ['All code', 'Python'] }))],
    check: (w, r) => expectAction(r, 'std-eng-logs', 'reformat') },
  { n: 40, name: 'Scope: no box ticked needs reformatting', exit: 0,
    level: 'global', nodes: [page(413, G_STDS, 'std-eng-logs: Logging', standardPage({ topic: 'eng-logs', scope: [] }))],
    check: (w, r) => expectAction(r, 'std-eng-logs', 'reformat') },
  { n: 41, name: 'Scope: Python and "Other" with paths give their globs together', exit: 0,
    level: 'global', nodes: [page(414, G_STDS, 'std-eng-py: Python', standardPage({ topic: 'eng-py', scope: ['Python', 'Other: tools/scripts/**'] }))],
    check: (w, r) => {
      const t = w.wrote(r, 'docs/standards/std-eng-py.md') || '';
      return [...expectAction(r, 'std-eng-py', 'created'), ...(t.includes('globs: ["**/*.py","tools/scripts/**"]') ? [] : ['the globs are not the Python extension and the Other path'])];
    } },
  { n: 42, name: 'Scope: "Other" ticked with no paths needs reformatting', exit: 0,
    level: 'global', nodes: [page(415, G_STDS, 'std-eng-py: Python', standardPage({ topic: 'eng-py', scope: ['Other: [exact paths, one per line. Ask the PDLC team]'] }))],
    check: (w, r) => expectAction(r, 'std-eng-py', 'reformat') },
  { n: 43, name: 'Scope: a box the scopes table does not map is left out of the globs and listed; the page is still written', exit: 0,
    level: 'global', nodes: [page(416, G_STDS, 'std-eng-api: API design', standardPage({ topic: 'eng-api', scope: ['Backend', 'Go'] }))],
    check: (w, r) => {
      const i = byId(r, 'std-eng-api');
      const t = w.wrote(r, 'docs/standards/std-eng-api.md') || '';
      const p = [...expectAction(r, 'std-eng-api', 'created')];
      if (!t.includes('globs: ["**/*.go"]')) p.push('the globs are not only the Go extension');
      if (!i || !String(i.why).includes('"Backend"') || !body(r).includes('"Backend"')) p.push('the unmapped box is not listed');
      return p;
    } },
  { n: 44, name: 'Scope: the scopes table in the connection maps a box to its paths', exit: 0,
    level: 'global', nodes: [page(417, G_STDS, 'std-eng-api: API design', standardPage({ topic: 'eng-api', scope: ['Backend'] }))],
    connection: (fake) => ({ schema_version: 1, site: fake.origin, space: 'TEST', root_folder: '1', mode: 'site', scopes: { Backend: ['services/**', 'workers/**'] } }),
    check: (w, r) => {
      const t = w.wrote(r, 'docs/standards/std-eng-api.md') || '';
      return [...expectAction(r, 'std-eng-api', 'created'), ...(t.includes('globs: ["services/**","workers/**"]') ? [] : ['the Backend box did not take the table\'s paths'])];
    } },
  { n: 45, name: 'the block "How to write this page" left on a standard page needs reformatting', exit: 0,
    level: 'global', nodes: [page(418, G_STDS, 'std-eng-logs: Logging', standardPage({ topic: 'eng-logs', howTo: true }))],
    check: (w, r) => [...expectAction(r, 'std-eng-logs', 'reformat'), ...(String((byId(r, 'std-eng-logs') || {}).why).includes('How to write this page') ? [] : ['the reason does not name the block'])] },
  { n: 47, name: 'section headings match whatever their case: "applies to", "RULES" and "Options Considered" are the template\'s sections', exit: 0,
    level: 'global',
    nodes: [page(101, G_ADRS, 'ADR-101: We use Postgres for every new relational store', (() => {
      const recase = { 'Applies to': 'applies to', Rules: 'RULES', 'Options considered': 'Options Considered', Context: 'context' };
      const doc = adrPage();
      for (const b of doc.content) if (b.type === 'heading' && recase[b.content[0].text]) b.content[0].text = recase[b.content[0].text];
      return doc;
    })())],
    check: (w, r) => {
      const t = w.wrote(r, ADR_101_PATH) || '';
      const p = [...expectAction(r, 'ADR-101', 'created'), ...wellFormed(t, ADR_101_PATH)];
      if (!t.includes('globs: ["services/orders/**","libs/db/**"]')) p.push('"applies to" did not give the globs');
      if (!t.includes('- Not keep every engine, because three sets of backups to run.')) p.push('"Options Considered" did not give Rejected');
      if (!t.includes('Each team picks its own database today.')) p.push('"context" did not give Why');
      return p;
    } },
  { n: 48, name: 'discover finds the global folder, its two folders and their pages, and exits 0', exit: 0,
    level: 'global', nodes: [ADR_101(), page(402, G_STDS, 'std-event-naming: Event naming', standardPage({ topic: 'event-naming' }))],
    run: (w) => w.run('discover'),
    check: (w, r) => {
      const d = r.result || {};
      const p = [];
      if (!d.root || d.root.title !== 'Key decisions') p.push(`root is ${JSON.stringify(d.root)}`);
      if (!d.folders || d.folders.adr !== 'ADRs - global' || d.folders.standard !== 'standards - global') p.push(`folders are ${JSON.stringify(d.folders)}`);
      if (!d.pages || d.pages.adr !== 1 || d.pages.standard !== 1) p.push(`pages are ${JSON.stringify(d.pages)}`);
      if ((d.missing || []).length) p.push(`missing ${JSON.stringify(d.missing)}`);
      return p;
    } },
  { n: 49, name: 'discover in a hub whose folder Confluence lacks exits 1 and names the folder', exit: 1,
    level: 'hub', key: 'BETA', nodes: [],
    run: (w) => w.run('discover'),
    check: (w, r) => (((r.result || {}).missing || []).some((m) => m.includes('hubs > BETA')) ? [] : [`missing is ${JSON.stringify((r.result || {}).missing)}`]) },
  { n: 50, name: 'discover --draft reads the connection from the working tree, for /connect-confluence before its merge', exit: 0,
    level: 'global', nodes: [],
    connection: (fake) => ({ schema_version: 1, site: fake.origin, space: 'TEST', root_folder: '999', mode: 'site' }),
    run: (w) => {
      write(w.work, 'docs/estate/confluence.json', { schema_version: 1, site: w.fake.origin, space: 'TEST', root_folder: '1', mode: 'site' });
      return w.run('discover', { args: ['--draft'] });
    },
    check: (w, r) => ((r.result || {}).root && r.result.root.id === '1' ? [] : ['the working tree\'s root_folder was not read']) },
  { n: 51, name: 'discover --find-root lists the folders of the space titled Key decisions, with their ids', exit: 0,
    level: 'global', nodes: [],
    run: (w) => w.run('discover', { args: ['--find-root'] }),
    check: (w, r) => (((r.result || {}).candidates || []).some((c) => c.id === '1' && c.type === 'folder') ? [] : [`candidates are ${JSON.stringify((r.result || {}).candidates)}`]) },
  { n: 52, name: 'the shipped connection template is well formed: its fields pass, through the gateway, with only the site, the space and the folder pointed at the fake', exit: 0,
    level: 'global', nodes: [],
    connection: (fake) => {
      const shipped = first(resolve(SCRIPTS, '..', 'templates', 'confluence.template.json'), resolve(SCRIPTS, '..', 'docs', 'estate', 'confluence.json'));
      const t = shipped ? JSON.parse(readFileSync(shipped, 'utf8')) : {};
      return { ...t, site: fake.origin, space: 'TEST', root_folder: '1' };
    },
    before: (w) => { w.env.HARNESS_CONFLUENCE_GATEWAY = w.fake.origin; },
    run: (w) => w.run('discover'),
    check: (w, r) => [...((r.result || {}).mode === 'gateway' ? [] : [`the shipped mode is ${(r.result || {}).mode}, expected gateway`]), ...(w.fake.state.requests.some((q) => q.gateway) ? [] : ['nothing went through the gateway'])] },
  { n: 46, name: 'an Owner that still holds the template\'s choices needs reformatting', exit: 0,
    level: 'global', nodes: [page(419, G_STDS, 'std-eng-logs: Logging', standardPage({ topic: 'eng-logs', owner: 'Global Architecture Board | Lead architect' }))],
    check: (w, r) => expectAction(r, 'std-eng-logs', 'reformat') },
  { n: 53, name: 'a global repository with no docs/standards/ folder: an approved ADR is still written and committed, with exit 0', exit: 0,
    level: 'global', nodes: [ADR_101()],
    check: (w, r) => {
      const p = [...expectAction(r, 'ADR-101', 'created'), ...wellFormed(w.wrote(r, ADR_101_PATH), ADR_101_PATH), ...committedWithWatermark(r)];
      if (git(w.bare, ['ls-tree', '--name-only', 'main', '--', 'docs/standards']).trim()) p.push('the trunk has docs/standards/, so the fixture proves nothing');
      if (!r.result.changed) p.push('changed is false');
      return p;
    } },
  { n: 54, name: 'a repository with neither docs/architecture/ nor docs/standards/, and no page to write: nothing is staged, no commit, exit 0', exit: 0,
    level: 'global', template: false, nodes: [ADR_101({}, { status: 'Proposed' })],
    check: (w, r) => {
      const p = [...expectAction(r, 'ADR-101', 'no-file')];
      if (git(w.bare, ['ls-tree', '--name-only', 'main', '--', 'docs/architecture', 'docs/standards']).trim()) p.push('the trunk has one of the two folders, so the fixture proves nothing');
      if (r.result.changed) p.push('changed is true');
      return p;
    } },
  { n: 55, name: 'a run without --use-system-ca starts Node again once with it, keeps its own Node options, and the run still works', exit: 0,
    level: 'global', nodes: [ADR_101()],
    run: (w) => runLogged(w, { NODE_OPTIONS: '' }),
    check: (w, r) => {
      const p = [...expectAction(r, 'ADR-101', 'created'), ...committedWithWatermark(r)];
      if (r.starts.length !== 2) return [...p, `Node started ${r.starts.length} time(s), expected 2: ${JSON.stringify(r.starts)}`];
      if (systemCa(r.starts[0]) !== 0) p.push('the first start already had --use-system-ca');
      if (systemCa(r.starts[1]) !== 1) p.push(`the second start does not have --use-system-ca once: ${JSON.stringify(r.starts[1])}`);
      if (!r.starts[1].includes('--import')) p.push('the second start lost the Node options of the first');
      if (r.stdout.trim().split('\n').filter((l) => l === '{').length !== 1) p.push('the result was written more than once');
      return p;
    } },
  { n: 56, name: 'NODE_OPTIONS already holds --use-system-ca: Node starts once, and the run works', exit: 0,
    level: 'global', nodes: [ADR_101()],
    run: (w) => runLogged(w, { NODE_OPTIONS: '--use-system-ca' }),
    check: (w, r) => [...expectAction(r, 'ADR-101', 'created'), ...(r.starts.length === 1 ? [] : [`Node started ${r.starts.length} time(s), expected 1`])] },
  { n: 57, name: 'a second apply while an earlier run\'s worktree still holds the branch stops with exit 1, names the folder, and removes nothing', exit: 1,
    level: 'global', nodes: [ADR_101()],
    run: async (w) => {
      const r1 = await w.run();
      if (r1.status !== 0) throw new Error(`the first apply exited ${r1.status}: ${r1.stderr}`);
      const r2 = await w.run();
      return { ...r2, first: r1 };
    },
    check: (w, r) => {
      const left = realpathSync(r.first.result.worktree);
      const p = [];
      if (!r.stderr.includes(`checked out in ${left}`)) p.push(`the message does not name the earlier worktree: ${r.stderr.trim().split('\n').slice(-2).join(' | ')}`);
      if (!r.stderr.includes('git worktree remove')) p.push('the message does not say how to remove it');
      if (r.stderr.includes('could not be reached')) p.push('the message still blames Confluence');
      if (!existsSync(left)) p.push('the earlier worktree was removed');
      return p;
    } },
  { n: 58, name: 'an earlier run\'s worktree whose folder is gone is pruned, and the next apply works', exit: 0,
    level: 'global', nodes: [ADR_101()],
    run: async (w) => {
      const r1 = await w.run();
      if (r1.status !== 0) throw new Error(`the first apply exited ${r1.status}: ${r1.stderr}`);
      rmSync(r1.result.worktree, { recursive: true, force: true });
      return w.run();
    },
    check: (w, r) => expectAction(r, 'ADR-101', 'created') },
  { n: 59, name: 'the pull request shows a path only for a file that exists, and each reason starts as a sentence', exit: 0,
    level: 'global', nodes: [ADR_101(), page(103, G_ADRS, 'ADR-103: A record without its Rules', adrPage({ omit: ['Rules'] })), page(104, G_ADRS, 'ADR-104: One claim', adrPage()), page(105, G_ADRS, 'ADR-104: A second claim', adrPage())],
    check: (w, r) => {
      const b = body(r);
      const line = (id) => b.split('\n').find((l) => l.startsWith(`- ${id} `)) || '';
      const p = [];
      if (!line('ADR-101').includes(`→ \`${ADR_101_PATH}\``)) p.push('the created record lost its path');
      if (line('ADR-103').includes('→')) p.push(`a record that needs reformatting shows a path: ${line('ADR-103')}`);
      if (line('ADR-104').includes('→')) p.push(`a duplicate shows a path: ${line('ADR-104')}`);
      if (!line('ADR-101').includes('. Status Approved')) p.push(`the reason does not start with a capital: ${line('ADR-101')}`);
      return p;
    } },
];

/* ----------------------------------------------------------------------- the runner */

const only = process.argv.slice(2).filter((a) => a.match(/^\d+$/)).map(Number);
let failed = 0;
for (const f of FIXTURES) {
  if (only.length && !only.includes(f.n)) continue;
  const root = mkdtempSync(join(tmpdir(), `confluence-sync-${f.n}-`));
  let w = null;
  let problems = [];
  try {
    w = await world(root, f);
    if (f.before) await f.before(w);
    const r = f.run ? await f.run(w) : await w.run();
    if (r.status !== f.exit) problems.push(`exit ${r.status}, expected ${f.exit}. stderr: ${r.stderr.trim().split('\n').slice(-3).join(' | ')}`);
    else problems.push(...f.check(w, r));
    if (w.fake.state.writes.length) problems.push(`Confluence was asked to write: ${JSON.stringify(w.fake.state.writes)}`);
    if (w.fake.state.requests.some((q) => q.path.startsWith('/wiki/') && !q.auth) && f.n !== 21) problems.push('a request went without the service account');
  } catch (err) {
    problems = [`fixture fault: ${err && err.stack ? err.stack : err}`];
  } finally {
    if (w) await w.fake.close();
    if (!KEEP) rmSync(root, { recursive: true, force: true });
  }
  if (problems.length) failed += 1;
  console.log(`${problems.length ? 'FAIL' : 'ok  '} ${String(f.n).padStart(2)} ${f.name}${problems.length ? `\n       - ${problems.join('\n       - ')}` : ''}`);
}
if (!KEEP) rmSync(SANDBOX_HOME, { recursive: true, force: true });
console.log(`\n${failed ? `${failed} fixture(s) failed` : 'every fixture passes'}`);
process.exit(failed ? 1 : 0);

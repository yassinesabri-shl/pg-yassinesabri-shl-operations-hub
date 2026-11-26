#!/usr/bin/env node
/**
 * run.mjs — the fixture suite for jira-sync.mjs (plan, apply, epics, discover and create).
 *
 *   usage:  node run.mjs            run every fixture
 *           node run.mjs 3 7        run only the numbered fixtures
 *           node run.mjs --keep     leave the throwaway hubs on disk
 *
 * A fixture is a REPOSITORY STATE plus a SITE: a real hub (a git repository with a bare `origin`
 * and the tracker records committed on its trunk), and a fake Jira (fake-jira.mjs) answering over
 * real HTTP. The shipped script is run in the hub exactly as a developer would run it, with their
 * credential in the environment, and exit code, stdout, stderr and what the fake was asked are
 * asserted. The script is never imported and never stubbed.
 *
 * Three sibling checks are stubbed: check-decomposition, check-dev-ready and check-validation.
 * Each has its own suite that proves what it judges. Here they only have to answer, so each exits
 * 0 when its file is on the trunk, 1 when the file says FAIL-CHECK, and 2 when it says
 * CANNOT-VERIFY. check-trackers.mjs, which the script also runs, is the real one.
 *
 * A fixture that does not name `writes: true` also asserts that Jira saw no write at all.
 *
 * Fixture 1 is the valid control. Most others change one thing.
 *
 * Node standard library only, plus git. No test framework.
 * Exit 0 if every fixture passes, 1 if any fails.
 */

import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFake, STATUS, storyWorkflow } from './fake-jira.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

// Two layouts: the library, where the scripts are two levels up; and an adopting hub, where this
// suite lands at tests/jira-sync/ and the scripts at scripts/.
const first = (...c) => c.filter(Boolean).find((p) => existsSync(p));
const SCRIPTS = first(
  process.env.HARNESS_SCRIPTS_DIR,
  existsSync(resolve(HERE, '..', '..', 'jira-sync.mjs')) ? resolve(HERE, '..', '..') : null,
  existsSync(resolve(HERE, '..', '..', 'scripts', 'jira-sync.mjs')) ? resolve(HERE, '..', '..', 'scripts') : null,
);
if (!SCRIPTS) {
  console.error('cannot locate jira-sync.mjs. Set HARNESS_SCRIPTS_DIR=/path/to/the/scripts/folder.');
  process.exit(4);
}
const KEEP = process.argv.includes('--keep');

/* ----------------------------------------------------------------------- git helpers */

const SANDBOX_HOME = mkdtempSync(join(tmpdir(), 'jira-sync-home-'));
const ENV = {
  ...process.env,
  HOME: SANDBOX_HOME,
  XDG_CONFIG_HOME: join(SANDBOX_HOME, '.config'),
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
  GIT_ASKPASS: 'true',
};
delete ENV.HARNESS_TRUNK;
delete ENV.HARNESS_JIRA_BASE_URL;

const git = (cwd, args) => execFileSync('git', args, { cwd, env: ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

function write(root, rel, body) {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, typeof body === 'string' ? body : `${JSON.stringify(body, null, 2)}\n`);
}

/* ----------------------------------------------------------- the three stub siblings */

const stub = (path, ext) => `#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
const arg = process.argv[2];
const trunk = process.env.HARNESS_TRUNK || 'main';
const path = ${path};
let text;
try { text = execFileSync('git', ['show', \`origin/\${trunk}:\${path}\`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); } catch { process.exit(1); }
if (text.includes('CANNOT-VERIFY')) { process.stderr.write('CANNOT VERIFY: the stub was told to refuse to judge\\n'); process.exit(2); }
process.exit(text.includes('FAIL-CHECK') ? 1 : 0);
`;
const STUBS = {
  'check-decomposition.js': stub('`docs/backlog/${arg}.decomposition.md`'),
  'check-dev-ready.js': stub('`docs/designs/${arg}.lld.md`'),
  'check-validation.js': stub('`docs/designs/${arg}.validation.md`'),
};

/* --------------------------------------------------------------------- the control hub */

const clone = (v) => JSON.parse(JSON.stringify(v));

const CLOSING_PASS = 'Criteria: 3 · PASS 3 · FAIL 0 · defects raised: NONE';

function controlFiles() {
  return {
    trackers: {
      schema_version: 1,
      instances: { acme: { kind: 'jira-cloud', site: 'acme.example.invalid', auth: { method: 'api-token', user_env: 'JIRA_USER', token_env: 'JIRA_API_TOKEN' } } },
      boards: {
        nova: { instance: 'acme', project: 'PLAT', board: 1153, sprint: 'report', sprint_field: 'customfield_10020', epics: 'ask',
          status_ids: { Backlog: STATUS.Backlog, 'In Analysis': STATUS['In Analysis'], 'Ready for Development': STATUS['Ready for Development'], 'In Development': STATUS['In Development'], 'Awaiting Code Review': STATUS['Awaiting Code Review'] } },
      },
      default_board: 'nova',
      types: {
        story: { issue_type: 'Story',
          moves: { 'design-merged': { route: ['Backlog', 'In Analysis', 'Ready for Development'] }, started: { route: ['Ready for Development', 'In Development'] }, 'in-review': { route: ['In Development', 'Awaiting Code Review'] } },
          annotations: { merged: { label: 'shl-merged' }, validated: { label: 'shl-validated' } } },
        defect: { issue_type: 'Defect', parent: 'story',
          moves: { started: { route: ['Backlog', 'In Development'] } },
          annotations: { merged: { label: 'shl-merged' }, validated: { label: 'shl-validated' } } },
      },
    },
    ledger: { schema_version: 1, prefix: 'SVC', next: 130, blocks: [{ from: 101, to: 102, taken_by: 'decomposition', slug: 'visibility' }] },
    links: { visibility: { schema_version: 1, slug: 'visibility', epic: 'acme:PLAT-9', items: { 'SVC-101': { type: 'story', board: 'nova', ticket: 'acme:PLAT-210' } } } },
    files: {
      'docs/backlog/visibility.decomposition.md': '# record\n',
      'docs/backlog/visibility/SVC-101.item.md': '# SVC-101 — Make the thing visible\n\nKey: SVC-101\nRepository: svc\n',
      'docs/backlog/visibility/SVC-102.item.md': '# SVC-102 — Make the other thing visible\n\nKey: SVC-102\nRepository: svc\n',
      'docs/designs/SVC-101.lld.md': '# design\n',
    },
  };
}

function controlJira() {
  return { issues: [{ key: 'PLAT-210', status: 'Backlog' }] };
}

async function buildHub(root, hubSpec) {
  const bare = join(root, 'hub.git');
  const work = join(root, 'hub');
  git(root, ['init', '--bare', '-q', '--initial-branch', 'main', bare]);
  git(root, ['init', '-q', '--initial-branch', 'main', work]);
  git(work, ['config', 'user.name', 'Fixture Runner']);
  git(work, ['config', 'user.email', 'fixture@example.invalid']);
  git(work, ['config', 'commit.gpgsign', 'false']);
  git(work, ['remote', 'add', 'origin', bare]);
  // The scripts under test, copied in as the hub install would, the three stub siblings, and the
  // real commit helper with the files it imports. They are committed, so the checkout is clean.
  mkdirSync(join(work, 'scripts'), { recursive: true });
  for (const f of ['jira-sync.mjs', 'jira.mjs', 'spoke-remote.mjs', 'spoke-rules.mjs', 'context-docs.mjs', 'check-trackers.mjs']) copyFileSync(join(SCRIPTS, f), join(work, 'scripts', f));
  for (const f of ['harness-commit.mjs', 'check-watermark.mjs', 'check-staged.mjs', 'check-coverage.mjs', 'spoke-trunk.mjs']) {
    const src = first(join(SCRIPTS, f), join(SCRIPTS, '..', 'gate', f));
    if (src) copyFileSync(src, join(work, 'scripts', f));
  }
  // check-staged imports check-coverage, which imports three modules of the test guard.
  mkdirSync(join(work, 'scripts', 'test-guard'), { recursive: true });
  for (const f of ['contract.mjs', 'common.mjs', 'git.mjs']) {
    const src = first(join(SCRIPTS, 'test-guard', f), join(SCRIPTS, '..', 'gate', 'test-guard', f));
    if (src) copyFileSync(src, join(work, 'scripts', 'test-guard', f));
  }
  for (const [name, body] of Object.entries(STUBS)) write(work, `scripts/${name}`, body);
  if (hubSpec.trackers !== null) write(work, 'docs/estate/trackers.json', hubSpec.trackers);
  if (hubSpec.ledger !== null) write(work, 'docs/backlog/keys.json', hubSpec.ledger);
  for (const [slug, body] of Object.entries(hubSpec.links || {})) write(work, `docs/estate/tracker-links/${slug}.json`, body);
  for (const [rel, body] of Object.entries(hubSpec.files || {})) write(work, rel, body);
  write(work, 'README.md', '# hub\n');
  git(work, ['add', '-A']);
  git(work, ['commit', '-q', '-m', 'hub']);
  git(work, ['push', '-q', 'origin', 'main']);
  if (hubSpec.dirty) write(work, 'uncommitted-notes.txt', 'not committed\n');
  return { work, bare };
}

function run(cwd, args, env, root = cwd) {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [join(root, 'scripts', 'jira-sync.mjs'), ...args], { cwd, env: { ...ENV, ...env } });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (status) => resolveRun({ status, out, err }));
  });
}

const json = (r) => { try { return JSON.parse(r.out); } catch { return null; } };
const item = (r, key) => (json(r) && json(r).items.find((i) => i.key === key)) || null;
const act = (i, kind, fact) => (i ? i.actions.find((a) => a.kind === kind && (fact === undefined || a.fact === fact)) : undefined);

// ---- helpers for the create fixtures
const gitOut = (cwd, args) => git(cwd, args).trim();
const linkOnBranch = (hub, slug) => JSON.parse(gitOut(hub.work, ['show', `harness/tracker-links-${slug}:docs/estate/tracker-links/${slug}.json`]));
const branchesCut = (hub) => gitOut(hub.work, ['branch', '--list', 'harness/tracker-links-*']);
const unlinked = (h) => { h.links = {}; };
const withEpic = (j) => { j.issues.push({ key: 'PLAT-9', issueType: 'Epic', summary: 'Harness delivery' }); };
const issue = (fake, key) => fake.state.issues.get(key);

// ---- helpers for the apply fixtures
const textOf = (node) => (typeof node === 'string' ? node : !node ? '' : typeof node.text === 'string' ? node.text : (node.content || []).map(textOf).join(' '));
const commentsOf = (fake, key) => ((fake.state.issues.get(key) || {}).comments || []).map((c) => textOf(c.body));
const statusOf = (fake, key) => fake.state.issues.get(key).status.name;
const labelsOf = (fake, key) => fake.state.issues.get(key).labels;
const posts = (fake, re) => fake.state.requests.filter((q) => q.method === 'POST' && re.test(q.path)).length;
const inStatus = (name) => (j) => { j.issues[0].status = name; };

// ---- helpers for the apply fixtures that go beyond the first dozen
const harness = (text) => ({ id: '1', body: text, author: { accountId: 'acc-1' } });
const withWorkflow = (fn) => (j) => { j.workflows = { Story: fn(storyWorkflow()) }; };
// Four linked stories, SVC-101 to SVC-104, on tickets PLAT-210 to PLAT-213, all in Backlog with designs merged.
const fourStories = (h) => {
  h.ledger.blocks = [{ from: 101, to: 104, taken_by: 'decomposition', slug: 'visibility' }];
  for (const n of [102, 103, 104]) {
    h.links.visibility.items[`SVC-${n}`] = { type: 'story', board: 'nova', ticket: `acme:PLAT-${n + 109}` };
    h.files[`docs/designs/SVC-${n}.lld.md`] = '# design\n';
    h.files[`docs/backlog/visibility/SVC-${n}.item.md`] = `# SVC-${n} — Another thing\n\nKey: SVC-${n}\nRepository: svc\n`;
  }
};
const fourTickets = (j) => { for (const n of [211, 212, 213]) j.issues.push({ key: `PLAT-${n}`, status: 'Backlog' }); };
const noDesign = (h) => { delete h.files['docs/designs/SVC-101.lld.md']; };
// Commit a file straight onto the hub's trunk from a second clone, as a merged pull request would.
function pushFile(hub, rel, body) {
  const clone = join(dirname(hub.work), `pusher-${Date.now()}`);
  git(dirname(hub.work), ['clone', '-q', hub.bare, clone]);
  for (const [k, v] of [['user.name', 'Fixture Runner'], ['user.email', 'fixture@example.invalid'], ['commit.gpgsign', 'false']]) git(clone, ['config', k, v]);
  write(clone, rel, body);
  git(clone, ['add', '-A']); git(clone, ['commit', '-q', '-m', `change ${rel}`]); git(clone, ['push', '-q', 'origin', 'main']);
}
// A hub decision record in the shape read-context.mjs prints, and its entry on a story's line.
const ADR_PATH = 'docs/architecture/ADR-001-one-request-id-per-call.md';
const ADR = `---\nname: ADR-001\ndescription: One request id per call\nglobs: []\nalwaysApply: false\nkind: adr\nstatus: Accepted\nowner: lead architect\nrevision: v1\norigin: wiki\n---\n\n# ADR-001: One request id per call\n\n## Decision\n\nOne id.\n\n## Rules\n\n- MUST carry one id.\n\n## Why\n\nTracing.\n\n## Rejected\n\n- None.\n\n## Accepted costs\n\n- None.\n`;
const blobOf = (text) => { const buf = Buffer.from(text, 'utf8'); return createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex'); };
const pinOf = (text) => blobOf(text).slice(0, 12);
const ADR_ENTRY = `ADR-001@${pinOf(ADR)}:${ADR_PATH}`;
const resultsOf = (r, key) => { const o = json(r); const e = o && o.items.find((i) => i.key === key); return e ? e.results : []; };

/* ----------------------------------------------------------------------- the fixtures */

// The connection for a developer who holds an OAuth access token: one variable, the gateway.
const CLOUD_ID = '11111111-2222-4333-8444-555555555555';
function oauthConnection(h) {
  h.trackers.instances.acme.auth = { method: 'oauth', token_env: 'JIRA_OAUTH_TOKEN' };
  h.trackers.instances.acme.base_url = `https://api.atlassian.com/ex/jira/${CLOUD_ID}`;
}
// The API token is unset, so a run that ignores the method cannot pass with it.
const OAUTH_ENV = { JIRA_USER: '', JIRA_API_TOKEN: '', JIRA_OAUTH_TOKEN: 'fixture-oauth-token' };
const schemesOf = (fake) => [...new Set(fake.state.requests.map((q) => q.scheme))];

// `hub` edits the control hub, `jira` the control site. `check` returns a list of problems.
const FIXTURES = [
  { n: 1, name: 'the valid control: a designed story in Backlog gets a ready move to Ready for Development, by way of In Analysis', exit: 0,
    args: ['plan', 'SVC-101'],
    check: (r) => {
      const i = item(r, 'SVC-101');
      const m = act(i, 'move', 'design-merged');
      const p = [];
      if (!i || !i.facts['design-merged'] || !i.facts.queued) p.push('queued and design-merged should both be true');
      if (!m) return [...p, 'no design-merged move planned'];
      if (m.status !== 'ready') p.push(`move status ${m.status}`);
      if (JSON.stringify(m.hops) !== JSON.stringify(['In Analysis', 'Ready for Development'])) p.push(`hops ${JSON.stringify(m.hops)}`);
      if (!m.firstHop || m.firstHop.transitionId !== '264') p.push(`first hop ${JSON.stringify(m.firstHop)}`);
      if (r.err.indexOf('acting as Fixture Developer') === -1) p.push('did not say who it is acting as');
      return p;
    } },
  { n: 2, name: 'no trackers.json on the trunk: no tracker, and that is valid', exit: 0, args: ['plan', '--all'],
    hub: (h) => { h.trackers = null; h.links = {}; },
    check: (r) => (json(r) && json(r).configured === false ? [] : ['expected {"configured": false}']) },
  { n: 3, name: 'a trackers.json that is not well formed stops the run before Jira is asked', exit: 1, args: ['plan', 'SVC-101'],
    hub: (h) => { h.trackers.default_board = 'nowhere'; },
    includes: ['not well formed', '"default_board" names "nowhere"'] },
  { n: 4, name: 'no credential in the environment is cannot-verify, and says which variables', exit: 2, args: ['plan', 'SVC-101'], env: { JIRA_API_TOKEN: '' },
    includes: ['set JIRA_USER and JIRA_API_TOKEN in your environment'] },
  { n: 5, name: 'a credential Jira refuses is cannot-verify', exit: 2, args: ['plan', 'SVC-101'], env: { JIRA_API_TOKEN: 'wrong' },
    includes: ['refused the credential (401)'] },
  { n: 6, name: 'apply with neither a key nor --all is usage', exit: 3, args: ['apply'], includes: ['apply needs a KEY or --all'] },
  { n: 7, name: '"create" with neither a slug nor a key is usage', exit: 3, args: ['create'], includes: ['create needs a SLUG'] },
  { n: 8, name: 'plan with neither a key nor --all is usage', exit: 3, args: ['plan'], includes: ['plan needs a KEY or --all'] },
  { n: 9, name: '--fact without a key is usage', exit: 3, args: ['plan', '--all', '--fact', 'started'], includes: ['--fact needs one KEY'] },
  { n: 10, name: 'a key that is not a harness key is usage', exit: 3, args: ['plan', 'nope'], includes: ['is not a harness key'] },
  { n: 11, name: 'a key the hub has never heard of is a failure, not a guess', exit: 1, args: ['plan', 'SVC-999'], includes: ['is not a story or defect'] },
  { n: 12, name: 'a ticket already at the target is marked as applied, not moved: a later regression must not be walked forward again', exit: 0, args: ['plan', 'SVC-101'],
    jira: (j) => { j.issues[0].status = 'Ready for Development'; },
    check: (r) => { const a = item(r, 'SVC-101').actions.find((x) => x.fact === 'design-merged'); return a && a.kind === 'mark' && /already at Ready for Development/.test(a.reason) ? [] : [`expected a mark, got ${JSON.stringify(a)}`]; } },
  { n: 13, name: 'a ticket a person sent back to Backlog is not walked forward again: the applied label wins', exit: 0, args: ['plan', 'SVC-101'],
    jira: (j) => { j.issues[0].labels = ['shl-applied-design-merged']; },
    check: (r) => { const a = item(r, 'SVC-101').actions.find((x) => x.fact === 'design-merged'); return a && a.kind === 'none' && /already applied/.test(a.reason) && !act(item(r, 'SVC-101'), 'move') ? [] : ['expected "already applied" and no move']; } },
  { n: 14, name: 'a ticket whose status is on no route is left alone and says so', exit: 0, args: ['plan', 'SVC-101'],
    jira: (j) => { j.issues[0].status = 'Awaiting QA'; },
    check: (r) => { const a = item(r, 'SVC-101').actions.find((x) => x.fact === 'design-merged'); return a && /is not on the route, no action/.test(a.reason) ? [] : ['expected "not on the route"']; } },
  { n: 15, name: 'no design on the trunk: no design-merged move', exit: 0, args: ['plan', 'SVC-101'],
    hub: (h) => { delete h.files['docs/designs/SVC-101.lld.md']; },
    check: (r) => (!act(item(r, 'SVC-101'), 'move') && item(r, 'SVC-101').facts['design-merged'] === false ? [] : ['expected no move and design-merged false']) },
  { n: 16, name: 'a design on the trunk that the pickup gate refuses is not design-merged, and the note says why', exit: 0, args: ['plan', 'SVC-101'],
    hub: (h) => { h.files['docs/designs/SVC-101.lld.md'] = '# design\nFAIL-CHECK\n'; },
    check: (r) => (!act(item(r, 'SVC-101'), 'move') && item(r, 'SVC-101').notes.some((n) => /pickup gate does not pass/.test(n)) ? [] : ['expected no move and a pickup-gate note']) },
  { n: 17, name: 'a sibling check that cannot judge makes the run cannot-verify', exit: 2, args: ['plan', 'SVC-101'],
    hub: (h) => { h.files['docs/designs/SVC-101.lld.md'] = '# design\nCANNOT-VERIFY\n'; },
    includes: ['CANNOT VERIFY', 'refuse to judge'] },
  { n: 18, name: '--fact started on a ticket in Ready for Development plans the In Development move', exit: 0, args: ['plan', 'SVC-101', '--fact', 'started'],
    jira: (j) => { j.issues[0].status = 'Ready for Development'; },
    check: (r) => { const m = act(item(r, 'SVC-101'), 'move', 'started'); return m && m.status === 'ready' && m.firstHop.transitionId === '284' && m.to === 'In Development' ? [] : [`started move ${JSON.stringify(m)}`]; } },
  { n: 19, name: '--fact in-review on a ticket in In Development plans Awaiting Code Review', exit: 0, args: ['plan', 'SVC-101', '--fact', 'in-review', '--pr', 'https://example.invalid/pr/7'],
    jira: (j) => { j.issues[0].status = 'In Development'; },
    check: (r) => { const m = act(item(r, 'SVC-101'), 'move', 'in-review'); return m && m.status === 'ready' && m.firstHop.transitionId === '294' ? [] : [`in-review move ${JSON.stringify(m)}`]; } },
  { n: 20, name: '--fact merged annotates with the label and the pull request', exit: 0, args: ['plan', 'SVC-101', '--fact', 'merged', '--pr', 'https://example.invalid/pr/7'],
    check: (r) => { const a = act(item(r, 'SVC-101'), 'annotate', 'merged'); return a && a.labels.join() === 'shl-merged' && a.pr === 'https://example.invalid/pr/7' && a.marker === '[shl:merged]' ? [] : [`annotation ${JSON.stringify(a)}`]; } },
  { n: 21, name: 'a merged annotation already carried, label and comment both, plans nothing', exit: 0, args: ['plan', 'SVC-101', '--fact', 'merged'],
    jira: (j) => { j.issues[0].labels = ['shl-merged']; j.issues[0].comments = [{ id: '1', body: '[shl:merged] Merged to the trunk.', author: { accountId: 'acc-1' } }]; },
    check: (r) => (!act(item(r, 'SVC-101'), 'annotate', 'merged') ? [] : ['planned an annotation the ticket already carries']) },
  { n: 22, name: 'a passing validation report annotates the ticket as validated', exit: 0, args: ['plan', 'SVC-101'],
    hub: (h) => { h.files['docs/designs/SVC-101.validation.md'] = `# Validation\n${CLOSING_PASS}\n`; },
    check: (r) => { const a = act(item(r, 'SVC-101'), 'annotate', 'validated'); return a && a.labels.join() === 'shl-validated' && item(r, 'SVC-101').facts.validated === 'pass' ? [] : [`annotation ${JSON.stringify(a)}`]; } },
  // A failing report never reaches the hub now. One that an older check-validation passed marks
  // nothing, and says why.
  { n: 23, name: 'a report with a FAIL that an older check-validation passed marks nothing validated, and says why', exit: 0, args: ['plan', 'SVC-101'],
    hub: (h) => { h.files['docs/designs/SVC-101.validation.md'] = '# Validation\nCriteria: 3 · PASS 1 · FAIL 2 · defects raised: SVC-120, SVC-121\n'; },
    check: (r) => { const i = item(r, 'SVC-101'); return !act(i, 'annotate', 'validated') && i.facts.validated === null && i.notes.some((n) => n.includes('so that check is older than this file')) ? [] : [`item ${JSON.stringify(i)}`]; } },
  { n: 24, name: 'a story with no link whose label no ticket carries plans a create, and says an Epic is asked for', exit: 0, args: ['plan', 'SVC-102'],
    check: (r) => { const c = act(item(r, 'SVC-102'), 'create'); return c && c.issueType === 'Story' && c.project === 'PLAT' && c.epic === 'asked at /decompose' && c.status === 'Backlog' ? [] : [`create ${JSON.stringify(c)}`]; } },
  { n: 25, name: 'a story with no link whose label one ticket carries plans an adopt, not a second create', exit: 0, args: ['plan', 'SVC-102'],
    jira: (j) => { j.issues.push({ key: 'PLAT-300', labels: ['shl-key-SVC-102'] }); },
    check: (r) => { const a = act(item(r, 'SVC-102'), 'adopt'); return a && a.ticket === 'PLAT-300' && !act(item(r, 'SVC-102'), 'create') ? [] : [`adopt ${JSON.stringify(a)}`]; } },
  { n: 26, name: 'two tickets carrying one key\'s label is a failure and chooses none', exit: 1, args: ['plan', 'SVC-102'],
    jira: (j) => { j.issues.push({ key: 'PLAT-300', labels: ['shl-key-SVC-102'] }, { key: 'PLAT-301', labels: ['shl-key-SVC-102'] }); },
    includes: ['2 tickets carry the label shl-key-SVC-102', 'none is chosen'] },
  { n: 27, name: 'a linked ticket Jira says is gone is a failure and is never recreated', exit: 1, args: ['plan', 'SVC-101'],
    jira: (j) => { j.issues = []; },
    includes: ['PLAT-210 is gone (404)', 'never recreated'] },
  { n: 28, name: 'a linked ticket that now sits in another project is reported and not followed', exit: 1, args: ['plan', 'SVC-101'],
    jira: (j) => { j.issues[0].project = 'ELSE'; },
    includes: ['is in project ELSE, not PLAT', 'does not follow it'] },
  { n: 29, name: 'a story whose board changed since it was linked is reported and not moved', exit: 1, args: ['plan', 'SVC-101'],
    hub: (h) => {
      h.trackers.boards.other = { ...clone(h.trackers.boards.nova), project: 'OTHR', board: 7 };
      h.files['docs/backlog/visibility/SVC-101.item.md'] = '# SVC-101\n\nKey: SVC-101\nRepository: svc\nJira board: other\n';
    },
    includes: ['board changed to "other"', 'the ticket is not moved'] },
  { n: 30, name: 'two transitions that both qualify is a failure: the first is never picked', exit: 1, args: ['plan', 'SVC-101'],
    jira: (j) => { j.workflows = { Story: [...storyWorkflow(), { id: '999', name: 'Analyse (again)', from: 'Backlog', to: 'In Analysis' }] }; },
    includes: ['2 transitions to "In Analysis" qualify'] },
  { n: 31, name: 'a transition that asks for a field with no default is blocked and names the field', exit: 0, args: ['plan', 'SVC-101'],
    jira: (j) => { j.workflows = { Story: storyWorkflow().map((t) => (t.id === '264' ? { ...t, requiredFields: ['Resolution'] } : t)) }; },
    check: (r) => { const m = act(item(r, 'SVC-101'), 'move'); return m && m.status === 'blocked' && /asks for Resolution/.test(m.reason) ? [] : [`move ${JSON.stringify(m)}`]; } },
  { n: 32, name: 'when no transition leads where the route goes, only a way back to Backlog being offered, the move is blocked and nothing is taken', exit: 0, args: ['plan', 'SVC-101'],
    jira: (j) => { j.workflows = { Story: storyWorkflow().filter((t) => t.id !== '264') }; },
    check: (r) => { const m = act(item(r, 'SVC-101'), 'move'); return m && m.status === 'blocked' && /no available transition to "In Analysis"/.test(m.reason) ? [] : [`move ${JSON.stringify(m)}`]; } },
  { n: 46, name: 'a global transition that leads where the route goes qualifies: a simple workflow is built of them', exit: 0, args: ['plan', 'SVC-101'],
    jira: (j) => { j.workflows = { Story: storyWorkflow().map((t) => (t.id === '264' ? { ...t, isGlobal: true } : t)) }; },
    check: (r) => { const m = act(item(r, 'SVC-101'), 'move'); return m && m.status === 'ready' && m.firstHop.transitionId === '264' ? [] : [`move ${JSON.stringify(m)}`]; } },
  { n: 47, name: 'a looped transition that leads where the route goes is never taken: the move is blocked', exit: 0, args: ['plan', 'SVC-101'],
    jira: (j) => { j.workflows = { Story: storyWorkflow().map((t) => (t.id === '264' ? { ...t, isLooped: true } : t)) }; },
    check: (r) => { const m = act(item(r, 'SVC-101'), 'move'); return m && m.status === 'blocked' && /no available transition to "In Analysis"/.test(m.reason) ? [] : [`move ${JSON.stringify(m)}`]; } },
  { n: 33, name: 'sprint report: a closed sprint and another board\'s active sprint are not this board\'s active sprint', exit: 0, args: ['plan', 'SVC-101'],
    jira: (j) => { j.issues[0].sprints = [{ id: 1, boardId: 1153, state: 'closed' }, { id: 2, boardId: 999, state: 'active' }]; },
    check: (r) => (item(r, 'SVC-101').ticket.sprint === 'not-in' ? [] : [`sprint ${item(r, 'SVC-101').ticket.sprint}`]) },
  { n: 34, name: 'sprint report: this board\'s active sprint is recognised', exit: 0, args: ['plan', 'SVC-101'],
    jira: (j) => { j.issues[0].sprints = [{ id: 1, boardId: 1153, state: 'closed' }, { id: 3, boardId: 1153, state: 'active' }]; },
    check: (r) => (item(r, 'SVC-101').ticket.sprint === 'in' ? [] : [`sprint ${item(r, 'SVC-101').ticket.sprint}`]) },
  { n: 35, name: 'sprint add: a ticket outside the active sprint plans an add, and still only plans', exit: 0, args: ['plan', 'SVC-101'],
    hub: (h) => { h.trackers.boards.nova.sprint = 'add'; },
    check: (r) => (act(item(r, 'SVC-101'), 'add-to-sprint') ? [] : ['no add-to-sprint planned']) },
  { n: 36, name: 'a 429 with Retry-After is retried, and the plan still succeeds', exit: 0, args: ['plan', 'SVC-101'],
    script: [{ status: 429, headers: { 'retry-after': '0' } }],
    check: (r, fake) => (fake.state.requests.length > 3 && item(r, 'SVC-101') ? [] : ['did not retry']) },
  { n: 37, name: 'a 503 on every attempt is cannot-verify', exit: 2, args: ['plan', 'SVC-101'],
    script: [{ status: 503, headers: { 'retry-after': '0' } }, { status: 503, headers: { 'retry-after': '0' } }, { status: 503, headers: { 'retry-after': '0' } }, { status: 503, headers: { 'retry-after': '0' } }],
    includes: ['answered 503 on all 4 attempts'] },
  { n: 38, name: 'Jira unreachable is cannot-verify', exit: 2, args: ['plan', 'SVC-101'], env: { HARNESS_JIRA_BASE_URL: 'http://127.0.0.1:1' },
    includes: ['cannot reach'] },
  { n: 39, name: 'a trunk name that is not the remote\'s default is cannot-verify', exit: 2, args: ['plan', 'SVC-101'], env: { HARNESS_TRUNK: 'develop' },
    includes: ['CANNOT VERIFY'] },
  { n: 40, name: 'a defect named by a passing validation report, with no link, plans a create under its parent', exit: 0, args: ['plan', 'SVC-120'],
    hub: (h) => {
      h.ledger.blocks.push({ from: 120, to: 120, taken_by: 'validation', key: 'SVC-101' });
      h.files['docs/designs/SVC-101.validation.md'] = '# Validation\nCriteria: 2 · PASS 1 · FAIL 1 · defects raised: SVC-120\n';
    },
    check: (r) => { const c = act(item(r, 'SVC-120'), 'create'); return item(r, 'SVC-120').type === 'defect' && c && c.issueType === 'Defect' && c.parent === 'SVC-101' && !c.epic ? [] : [`create ${JSON.stringify(c)}`]; } },
  { n: 41, name: '--fact started on a linked defect in Backlog plans the Start Work move through the mapping\'s own route', exit: 0, args: ['plan', 'SVC-120', '--fact', 'started'],
    hub: (h) => {
      h.ledger.blocks.push({ from: 120, to: 120, taken_by: 'validation', key: 'SVC-101' });
      h.files['docs/designs/SVC-101.validation.md'] = '# Validation\nCriteria: 2 · PASS 1 · FAIL 1 · defects raised: SVC-120\n';
      h.links.visibility.items['SVC-120'] = { type: 'defect', board: 'nova', ticket: 'acme:PLAT-231', parent: 'SVC-101' };
    },
    jira: (j) => { j.issues.push({ key: 'PLAT-231', issueType: 'Defect', parent: 'PLAT-210', status: 'Backlog' }); },
    check: (r) => { const m = act(item(r, 'SVC-120'), 'move', 'started'); return m && m.status === 'ready' && m.firstHop.transitionId === '11' ? [] : [`defect move ${JSON.stringify(m)}`]; } },
  { n: 42, name: 'epics lists the open Epics in the board\'s project', exit: 0, args: ['epics'],
    jira: (j) => { j.issues.push({ key: 'PLAT-9', issueType: 'Epic', summary: 'Harness delivery' }, { key: 'OTHR-1', issueType: 'Epic', project: 'OTHR', summary: 'Elsewhere' }); },
    check: (r) => { const o = json(r); return o && o.open.length === 1 && o.open[0].key === 'PLAT-9' && o.open[0].summary === 'Harness delivery' ? [] : [`epics ${r.out}`]; } },
  { n: 43, name: 'epics on a board that does not use them asks nothing of Jira', exit: 0, args: ['epics'],
    hub: (h) => { h.trackers.boards.nova.epics = 'none'; },
    check: (r, fake) => (json(r).epics === 'none' && json(r).open.length === 0 && fake.state.requests.length === 0 ? [] : ['asked Jira about Epics on a board with none']) },
  { n: 44, name: 'discover reads the status ids, the sprint field and the issue types for /connect-jira', exit: 0, args: ['discover'],
    check: (r) => { const o = json(r); return o && o.status_ids['In Development'] === STATUS['In Development'] && o.sprint_field === 'customfield_10020' && o.issue_types.some((t) => t.name === 'Sub-task' && t.subtask === true) && o.issue_types.some((t) => t.name === 'Story' && t.subtask === false) ? [] : [`discover ${r.out}`]; } },
  { n: 45, name: 'plan --all covers every story, linked or not, in one run', exit: 0, args: ['plan', '--all'],
    check: (r) => { const o = json(r); return o && o.items.map((i) => i.key).sort().join() === 'SVC-101,SVC-102' ? [] : [`items ${o && o.items.map((i) => i.key)}`]; } },
  // ---- create
  { n: 48, name: 'create <SLUG> --epic makes each story in Backlog under that Epic, commits the link file on its own branch with the watermark, and leaves the checkout where it was', exit: 0, writes: true,
    args: ['create', 'visibility', '--epic', 'PLAT-9'], hub: unlinked, jira: withEpic,
    check: (r, fake, hub) => {
      const o = json(r); const p = [];
      if (!o || o.created.map((c) => c.key).join() !== 'SVC-101,SVC-102') return [`created ${JSON.stringify(o && o.created)}`];
      const a = issue(fake, 'PLAT-301');
      if (!a || a.summary !== 'SVC-101: Make the thing visible' || a.issueType !== 'Story' || a.parent !== 'PLAT-9' || a.status.name !== 'Backlog' || a.labels.join() !== 'shl-key-SVC-101') p.push(`ticket ${JSON.stringify(a)}`);
      const link = linkOnBranch(hub, 'visibility');
      if (link.epic !== 'acme:PLAT-9' || link.items['SVC-101'].ticket !== 'acme:PLAT-301' || link.items['SVC-102'].ticket !== 'acme:PLAT-302') p.push(`link file ${JSON.stringify(link)}`);
      const msg = gitOut(hub.work, ['log', '-1', '--format=%B', 'harness/tracker-links-visibility']);
      if (!/\nGenerated-by: SHL Agentic Harness\s*$/.test(`\n${msg}`)) p.push(`commit message lacks the watermark as its last line: ${JSON.stringify(msg)}`);
      if (gitOut(hub.work, ['rev-parse', '--abbrev-ref', 'HEAD']) !== 'main') p.push('the checkout was not returned to main');
      if (gitOut(hub.work, ['ls-remote', '--heads', hub.bare, 'harness/*'])) p.push('something was pushed');
      if (gitOut(hub.work, ['status', '--porcelain'])) p.push('the checkout is dirty afterwards');
      return p;
    } },
  { n: 49, name: 'create <SLUG> with no Epic named is usage, and nothing is made or committed', exit: 3, args: ['create', 'visibility'], hub: unlinked, jira: withEpic,
    includes: ['needs an Epic for its stories'],
    check: (r, fake, hub) => (fake.state.created.length === 0 && branchesCut(hub) === '' ? [] : ['something was made or a branch was cut']) },
  { n: 50, name: '--create-epic makes one Epic labelled for the slug, and the stories sit under it', exit: 0, writes: true,
    args: ['create', 'visibility', '--create-epic', 'Harness delivery'], hub: unlinked,
    check: (r, fake, hub) => {
      const e = issue(fake, 'PLAT-301'); const p = [];
      if (!e || e.issueType !== 'Epic' || e.summary !== 'Harness delivery' || e.labels.join() !== 'shl-slug-visibility') p.push(`epic ${JSON.stringify(e)}`);
      if (issue(fake, 'PLAT-302').parent !== 'PLAT-301' || issue(fake, 'PLAT-303').parent !== 'PLAT-301') p.push('the stories are not under the new Epic');
      if (linkOnBranch(hub, 'visibility').epic !== 'acme:PLAT-301') p.push('the Epic is not recorded in the link file');
      return p;
    } },
  { n: 51, name: '--create-epic reuses an Epic that already carries the slug label, and makes none', exit: 0, writes: true,
    args: ['create', 'visibility', '--create-epic', 'Harness delivery'], hub: unlinked,
    jira: (j) => { j.issues.push({ key: 'PLAT-9', issueType: 'Epic', labels: ['shl-slug-visibility'] }); },
    check: (r, fake) => (fake.state.created.length === 2 && issue(fake, 'PLAT-301').parent === 'PLAT-9' ? [] : [`created ${fake.state.created}`]) },
  { n: 52, name: '--epic naming a ticket that is not an Epic is refused, and nothing is made', exit: 1, args: ['create', 'visibility', '--epic', 'PLAT-210'], hub: unlinked,
    includes: ['is a Story, not an Epic'], check: (r, fake) => (fake.state.created.length === 0 ? [] : ['something was made']) },
  { n: 53, name: '--epic in another project than the board is refused', exit: 1, args: ['create', 'visibility', '--epic', 'OTHR-1'], hub: unlinked,
    jira: (j) => { j.issues.push({ key: 'OTHR-1', issueType: 'Epic', project: 'OTHR' }); }, includes: ['is in project OTHR'] },
  { n: 54, name: '--epic naming a ticket that does not exist is refused', exit: 1, args: ['create', 'visibility', '--epic', 'PLAT-999'], hub: unlinked,
    includes: ['no such ticket'] },
  { n: 55, name: '--epic together with --create-epic is usage', exit: 3, args: ['create', 'visibility', '--epic', 'PLAT-9', '--create-epic', 'x'], includes: ['not both'] },
  { n: 56, name: 'on a board with epics "none", the stories are made with no Epic and the link file records none', exit: 0, writes: true,
    args: ['create', 'visibility'], hub: (h) => { h.links = {}; h.trackers.boards.nova.epics = 'none'; },
    check: (r, fake, hub) => (issue(fake, 'PLAT-301').parent === null && linkOnBranch(hub, 'visibility').epic === undefined ? [] : ['an Epic was applied or recorded']) },
  { n: 57, name: 'on a board with epics "none", --epic is usage', exit: 3, args: ['create', 'visibility', '--epic', 'PLAT-9'],
    hub: (h) => { h.links = {}; h.trackers.boards.nova.epics = 'none'; }, includes: ['does not use Epics'] },
  { n: 58, name: 'a decomposition whose Epic is already recorded makes its missing story under it without being asked', exit: 0, writes: true,
    args: ['create', 'visibility'], jira: withEpic,
    check: (r, fake, hub) => {
      const o = json(r);
      return o && o.created.map((c) => c.key).join() === 'SVC-102' && issue(fake, 'PLAT-301').parent === 'PLAT-9' && Object.keys(linkOnBranch(hub, 'visibility').items).join() === 'SVC-101,SVC-102' ? [] : [`result ${r.out}`];
    } },
  { n: 59, name: 'a decomposition whose every story already has a ticket makes nothing and writes nothing', exit: 0, args: ['create', 'visibility'],
    hub: (h) => { h.links.visibility.items['SVC-102'] = { type: 'story', board: 'nova', ticket: 'acme:PLAT-211' }; },
    includes: ['nothing to create'] },
  { n: 60, name: 'a ticket that already carries a key\'s label is adopted, never made twice', exit: 0, writes: true,
    args: ['create', 'visibility', '--epic', 'PLAT-9'], hub: unlinked,
    jira: (j) => { withEpic(j); j.issues.push({ key: 'PLAT-310', labels: ['shl-key-SVC-101'] }); },
    check: (r, fake, hub) => {
      const o = json(r);
      return o.adopted.map((a) => a.key).join() === 'SVC-101' && o.created.map((c) => c.key).join() === 'SVC-102' && fake.state.created.length === 1 && linkOnBranch(hub, 'visibility').items['SVC-101'].ticket === 'acme:PLAT-310' ? [] : [`result ${r.out}`];
    } },
  { n: 61, name: 'two tickets carrying one key\'s label is a failure that makes none for that key, and the other story is still made', exit: 1, writes: true,
    args: ['create', 'visibility', '--epic', 'PLAT-9'], hub: unlinked,
    jira: (j) => { withEpic(j); j.issues.push({ key: 'PLAT-310', labels: ['shl-key-SVC-101'] }, { key: 'PLAT-311', labels: ['shl-key-SVC-101'] }); },
    includes: ['2 tickets carry the label shl-key-SVC-101'],
    check: (r, fake, hub) => (fake.state.created.length === 1 && Object.keys(linkOnBranch(hub, 'visibility').items).join() === 'SVC-102' ? [] : [`created ${fake.state.created}`]) },
  { n: 62, name: 'a ticket an earlier run made that the search index has not caught up with is found on the second look, not made again', exit: 0, writes: true,
    args: ['create', 'visibility', '--epic', 'PLAT-9'], hub: unlinked,
    jira: (j) => { withEpic(j); j.issues.push({ key: 'PLAT-310', labels: ['shl-key-SVC-102'] }); },
    fake: (st) => { st.searchLag = 1; },
    check: (r, fake) => { const o = json(r); return o.adopted.map((a) => a.key).join() === 'SVC-102' && fake.state.created.length === 1 ? [] : [`result ${r.out}`]; } },
  { n: 63, name: 'a checkout with uncommitted changes is left exactly as it was: the link file is committed in a worktree of its own', exit: 0, writes: true,
    args: ['create', 'visibility', '--epic', 'PLAT-9'], hub: (h) => { h.links = {}; h.dirty = true; }, jira: withEpic,
    check: (r, fake, hub) => {
      const p = [];
      if (gitOut(hub.work, ['status', '--porcelain']) !== '?? uncommitted-notes.txt') p.push(`the checkout changed: ${gitOut(hub.work, ['status', '--porcelain'])}`);
      if (gitOut(hub.work, ['rev-parse', '--abbrev-ref', 'HEAD']) !== 'main') p.push('the branch changed');
      if (Object.keys(linkOnBranch(hub, 'visibility').items).join() !== 'SVC-101,SVC-102') p.push('the link file is not on its branch');
      if (gitOut(hub.work, ['worktree', 'list']).split('\n').length !== 1) p.push('a worktree was left behind');
      return p;
    } },
  { n: 64, name: 'a field Jira insists on that trackers.json has no default for stops the run before a ticket is made, naming it', exit: 1,
    args: ['create', 'visibility', '--epic', 'PLAT-9'], hub: unlinked, jira: withEpic,
    fake: (st) => { st.required = { Story: [{ id: '10500', name: 'Team' }] }; },
    includes: ['requires Team (customfield_10500)', 'nothing is created'], check: (r, fake) => (fake.state.created.length === 0 ? [] : ['something was made']) },
  { n: 65, name: 'a default for that field in trackers.json is sent with each ticket', exit: 0, writes: true,
    args: ['create', 'visibility', '--epic', 'PLAT-9'], jira: withEpic,
    hub: (h) => { h.links = {}; h.trackers.types.story.fields = { customfield_10500: 'Platform' }; },
    fake: (st) => { st.required = { Story: [{ id: '10500', name: 'Team' }] }; },
    check: (r, fake) => (issue(fake, 'PLAT-301').extra.customfield_10500 === 'Platform' ? [] : ['the default was not sent']) },
  { n: 66, name: 'a failure part-way records what was made, commits it, and says to run again: exit 2', exit: 2, writes: true,
    args: ['create', 'visibility', '--epic', 'PLAT-9'], hub: unlinked, jira: withEpic,
    fake: (st) => { st.failCreateAfter = 1; },
    includes: ['may or may not have been done', 'Run create again'],
    check: (r, fake, hub) => (Object.keys(linkOnBranch(hub, 'visibility').items).join() === 'SVC-101' && fake.state.created.length === 1 ? [] : ['the first ticket was not recorded, or a second was made']) },
  { n: 67, name: 'a 429 on a create is retried, because Jira had not begun on it', exit: 0, writes: true,
    args: ['create', 'visibility', '--epic', 'PLAT-9'], hub: unlinked, jira: withEpic,
    fake: (st) => { st.rateLimitCreate = 1; },
    check: (r, fake) => (fake.state.created.length === 2 && fake.state.requests.filter((q) => q.method === 'POST' && q.path === '/rest/api/3/issue').length === 3 ? [] : ['expected three create requests for two tickets']) },
  { n: 68, name: 'run again after a part-way failure: the ticket already made is adopted, the missing one is made, and the branch gains a second commit', exit: 2, writes: true,
    args: ['create', 'visibility', '--epic', 'PLAT-9'], hub: unlinked, jira: withEpic,
    fake: (st) => { st.failCreateAfter = 1; },
    again: { args: ['create', 'visibility', '--epic', 'PLAT-9'], exit: 0, fake: (st) => { st.failCreateAfter = null; } },
    check: (r, fake, hub, second) => {
      const o = json(second); const p = [];
      if (!o || o.adopted.map((a) => a.key).join() !== 'SVC-101' || o.created.map((c) => c.key).join() !== 'SVC-102') p.push(`second run ${second.out}`);
      if (fake.state.created.length !== 2) p.push(`${fake.state.created.length} tickets exist, expected 2`);
      if (Object.keys(linkOnBranch(hub, 'visibility').items).join() !== 'SVC-101,SVC-102') p.push('the branch does not link both');
      if (gitOut(hub.work, ['rev-list', '--count', 'main..harness/tracker-links-visibility']) !== '2') p.push('the branch does not have two commits');
      return p;
    } },
  { n: 69, name: 'a defect named by a passing validation report is made as a sub-task of its story\'s ticket, and linked in the story\'s file', exit: 0, writes: true,
    args: ['create', 'SVC-120'],
    hub: (h) => {
      h.ledger.blocks.push({ from: 120, to: 120, taken_by: 'validation', key: 'SVC-101' });
      h.files['docs/designs/SVC-101.validation.md'] = '# Validation\nCriteria: 2 · PASS 1 · FAIL 1 · defects raised: SVC-120\n';
    },
    check: (r, fake, hub) => {
      const d = issue(fake, 'PLAT-301'); const p = [];
      if (!d || d.issueType !== 'Defect' || d.parent !== 'PLAT-210' || d.labels.join() !== 'shl-key-SVC-120') p.push(`defect ${JSON.stringify(d)}`);
      const link = linkOnBranch(hub, 'visibility');
      if (link.items['SVC-120'].parent !== 'SVC-101' || link.items['SVC-120'].type !== 'defect' || link.items['SVC-101'].ticket !== 'acme:PLAT-210' || link.epic !== 'acme:PLAT-9') p.push(`link ${JSON.stringify(link)}`);
      return p;
    } },
  { n: 70, name: 'a defect whose parent story has no ticket yet is refused: the decomposition\'s tickets come first', exit: 1, args: ['create', 'SVC-120'],
    hub: (h) => {
      h.links = {};
      h.ledger.blocks.push({ from: 120, to: 120, taken_by: 'validation', key: 'SVC-101' });
      h.files['docs/designs/SVC-101.validation.md'] = '# Validation\nCriteria: 2 · PASS 1 · FAIL 1 · defects raised: SVC-120\n';
    },
    includes: ['has no ticket yet'] },
  { n: 71, name: 'create <KEY> on a story is usage: stories are made together', exit: 3, args: ['create', 'SVC-101'], includes: ['stories are made together'] },
  { n: 72, name: 'work the trunk does not prove queued makes nothing', exit: 1, args: ['create', 'visibility', '--epic', 'PLAT-9'], hub: (h) => { h.links = {}; h.files['docs/backlog/visibility.decomposition.md'] = '# record\nFAIL-CHECK\n'; }, jira: withEpic,
    includes: ['is not queued', 'nothing is created'], check: (r, fake) => (fake.state.created.length === 0 ? [] : ['something was made']) },
  { n: 73, name: 'a slug the hub has no stories for is a failure', exit: 1, args: ['create', 'nowhere', '--epic', 'PLAT-9'], includes: ['no story for the slug nowhere'] },
  { n: 74, name: 'a key the ledger does not know stops the run before a ticket is made', exit: 1, args: ['create', 'visibility', '--epic', 'PLAT-9'], jira: withEpic,
    hub: (h) => { h.links = {}; h.ledger.blocks[0].slug = 'another'; }, includes: ['is in no decomposition block of the key ledger', 'nothing is created'],
    check: (r, fake) => (fake.state.created.length === 0 ? [] : ['something was made']) },
  { n: 75, name: 'a title longer than Jira allows is cut at a word boundary to 255 characters', exit: 0, writes: true,
    args: ['create', 'visibility', '--epic', 'PLAT-9'], jira: withEpic,
    hub: (h) => { h.links = {}; h.files['docs/backlog/visibility/SVC-101.item.md'] = `# SVC-101 — ${'word '.repeat(80).trim()}\n\nKey: SVC-101\nRepository: svc\n`; },
    check: (r, fake) => { const t = issue(fake, 'PLAT-301').summary; return t.length <= 255 && t.endsWith('...') && t.startsWith('SVC-101: word') ? [] : [`summary length ${t.length}: ${t.slice(-20)}`]; } },
  // ---- found by the independent review of create
  { n: 76, name: 'a ticket whose create reply was lost, still out of the index while its neighbour is in it, is found on the second look and not made again', exit: 2, writes: true,
    args: ['create', 'visibility', '--epic', 'PLAT-9'], hub: unlinked, jira: withEpic,
    fake: (st) => { st.loseCreateReplyAt = 2; st.lostCreateLag = 1; },
    again: { args: ['create', 'visibility', '--epic', 'PLAT-9'], exit: 0 },
    check: (r, fake, hub, second) => {
      const o = json(second);
      return fake.state.created.length === 2 && o && o.adopted.map((a) => a.key).sort().join() === 'SVC-101,SVC-102' && o.created.length === 0 ? [] : [`${fake.state.created.length} tickets exist; second run ${second.out.slice(0, 300)}`];
    } },
  { n: 77, name: 'a link-file commit that is refused leaves the ticket keys reported, the checkout clean and no worktree behind; the next run adopts and commits', exit: 1, writes: true,
    args: ['create', 'visibility', '--epic', 'PLAT-9'], hub: unlinked, jira: withEpic,
    setup: async (hub) => { const hook = join(hub.work, '.git', 'hooks', 'pre-commit'); write(hub.work, '.git/hooks/pre-commit', '#!/bin/sh\nexit 1\n'); (await import('node:fs')).chmodSync(hook, 0o755); },
    includes: ['TICKETS EXIST BUT THE LINK FILE IS NOT COMMITTED'],
    again: { args: ['create', 'visibility', '--epic', 'PLAT-9'], exit: 0, before: async (hub) => { (await import('node:fs')).rmSync(join(hub.work, '.git', 'hooks', 'pre-commit')); } },
    check: (r, fake, hub, second) => {
      const o = json(r); const p = [];
      if (!o || o.created.map((c) => c.key).join() !== 'SVC-101,SVC-102' || !o.linkError) p.push(`first run ${r.out.slice(0, 300)}`);
      if (gitOut(hub.work, ['status', '--porcelain']) !== '') p.push('the checkout is not clean');
      if (gitOut(hub.work, ['worktree', 'list']).split('\n').length !== 1) p.push('a worktree was left behind');
      if (fake.state.created.length !== 2) p.push(`${fake.state.created.length} tickets exist`);
      if (Object.keys(linkOnBranch(hub, 'visibility').items).join() !== 'SVC-101,SVC-102') p.push('the second run did not commit the link file');
      return p;
    } },
  { n: 78, name: 'a link branch checked out in another worktree is reported with the ticket keys, and the next run, once it is free, adopts them and commits', exit: 2, writes: true,
    args: ['create', 'visibility', '--epic', 'PLAT-9'], hub: unlinked, jira: withEpic,
    setup: async (hub) => { git(hub.work, ['worktree', 'add', '-q', '-b', 'harness/tracker-links-visibility', join(dirname(hub.work), 'other'), 'main']); },
    includes: ['could not open a worktree', 'TICKETS EXIST'],
    again: { args: ['create', 'visibility', '--epic', 'PLAT-9'], exit: 0, before: async (hub) => { git(hub.work, ['worktree', 'remove', '--force', join(dirname(hub.work), 'other')]); } },
    check: (r, fake, hub) => (fake.state.created.length === 2 && Object.keys(linkOnBranch(hub, 'visibility').items).join() === 'SVC-101,SVC-102' ? [] : [`${fake.state.created.length} tickets exist`]) },
  { n: 79, name: 'run from a subdirectory, the link file is still committed at its own path', exit: 0, writes: true, cwd: 'docs',
    args: ['create', 'visibility', '--epic', 'PLAT-9'], hub: unlinked, jira: withEpic,
    check: (r, fake, hub) => {
      const p = [];
      if (Object.keys(linkOnBranch(hub, 'visibility').items).join() !== 'SVC-101,SVC-102') p.push('the link file is not at docs/estate/tracker-links/');
      if (gitOut(hub.work, ['ls-tree', '-r', '--name-only', 'harness/tracker-links-visibility']).includes('docs/docs/')) p.push('a doubled docs/docs path was committed');
      return p;
    } },
  { n: 80, name: 'on a detached HEAD the checkout is left detached at the same commit', exit: 0, writes: true,
    args: ['create', 'visibility', '--epic', 'PLAT-9'], hub: unlinked, jira: withEpic,
    setup: async (hub) => { git(hub.work, ['checkout', '-q', '--detach']); hub.detachedAt = gitOut(hub.work, ['rev-parse', 'HEAD']); },
    check: (r, fake, hub) => (gitOut(hub.work, ['rev-parse', '--abbrev-ref', 'HEAD']) === 'HEAD' && gitOut(hub.work, ['rev-parse', 'HEAD']) === hub.detachedAt && gitOut(hub.work, ['rev-parse', '--verify', 'harness/tracker-links-visibility']) ? [] : ['the checkout moved']) },
  { n: 81, name: 'a search that gets a 502 is retried, because it only reads', exit: 0, writes: true,
    args: ['create', 'visibility', '--epic', 'PLAT-9'], hub: unlinked, jira: withEpic,
    fake: (st) => { st.failSearch = 1; },
    check: (r, fake) => (fake.state.created.length === 2 ? [] : [`${fake.state.created.length} tickets made`]) },
  { n: 82, name: 'a ticket for a key that someone moved to another project is reported, and no second one is made beside it', exit: 1, writes: true,
    args: ['create', 'visibility', '--epic', 'PLAT-9'], hub: unlinked,
    jira: (j) => { withEpic(j); j.issues.push({ key: 'ELSE-5', project: 'ELSE', labels: ['shl-key-SVC-101'] }); },
    includes: ['was moved'],
    check: (r, fake, hub) => (fake.state.created.length === 1 && Object.keys(linkOnBranch(hub, 'visibility').items).join() === 'SVC-102' ? [] : [`${fake.state.created.length} tickets made`]) },
  { n: 83, name: 'an Epic made in a run whose first story then fails is recorded on its own, and the next run reuses it', exit: 2, writes: true,
    args: ['create', 'visibility', '--create-epic', 'Harness delivery'], hub: unlinked,
    fake: (st) => { st.failCreateAfter = 1; },
    again: { args: ['create', 'visibility', '--create-epic', 'Harness delivery'], exit: 0, fake: (st) => { st.failCreateAfter = null; },
      before: async (hub) => { hub.afterFirstRun = linkOnBranch(hub, 'visibility'); } },
    check: (r, fake, hub) => {
      const link = linkOnBranch(hub, 'visibility'); const p = [];
      if (!hub.afterFirstRun || hub.afterFirstRun.epic !== 'acme:PLAT-301' || Object.keys(hub.afterFirstRun.items).length !== 0) p.push(`after the first run the link file was ${JSON.stringify(hub.afterFirstRun)}`);
      if (link.epic !== 'acme:PLAT-301' || Object.keys(link.items).join() !== 'SVC-101,SVC-102') p.push(`link ${JSON.stringify(link)}`);
      if (fake.state.created.length !== 3) p.push(`${fake.state.created.length} tickets made: ${fake.state.created}`);
      return p;
    } },
  { n: 84, name: 'a refusal Jira makes at create time is a verified failure, exit 1, not a "run again" cannot-verify', exit: 1, writes: true,
    args: ['create', 'visibility', '--epic', 'PLAT-9'], hub: unlinked, jira: withEpic,
    fake: (st) => { st.hiddenRequired = { Story: [{ id: '10600', name: 'Team' }] }; },
    includes: ['Fix that, then run create again'] },
  { n: 85, name: 'a project key that is a JQL reserved word is quoted in the searches', exit: 0, writes: true,
    args: ['create', 'visibility', '--create-epic', 'Harness delivery'],
    hub: (h) => { h.links = {}; h.trackers.boards.nova.project = 'IN'; h.trackers.boards.nova.status_ids = undefined; delete h.trackers.boards.nova.status_ids; },
    check: (r, fake) => (fake.state.created[0] === 'IN-301' && fake.state.created.length === 3 ? [] : [`created ${fake.state.created}`]) },
  { n: 86, name: 'a leftover link branch behind the trunk cannot revert what was merged since: the file is the trunk\'s entries and this run\'s', exit: 0, writes: true,
    args: ['create', 'visibility', '--epic', 'PLAT-9'], jira: withEpic,
    setup: async (hub) => {
      // An unmerged link branch from an earlier run whose file does not know SVC-101, which the trunk does.
      const other = join(dirname(hub.work), 'stale');
      git(hub.work, ['worktree', 'add', '-q', '-b', 'harness/tracker-links-visibility', other, 'main']);
      const path = join(other, 'docs/estate/tracker-links/visibility.json');
      write(other, 'docs/estate/tracker-links/visibility.json', { schema_version: 1, slug: 'visibility', epic: 'acme:PLAT-9', items: {} });
      git(other, ['add', '-A']); git(other, ['-c', 'user.name=Fixture', '-c', 'user.email=f@example.invalid', 'commit', '-q', '-m', 'an earlier, unmerged run']);
      git(hub.work, ['worktree', 'remove', '--force', other]);
      void path;
    },
    check: (r, fake, hub) => (Object.keys(linkOnBranch(hub, 'visibility').items).join() === 'SVC-101,SVC-102' ? [] : [`link items ${Object.keys(linkOnBranch(hub, 'visibility').items)}`]) },
  { n: 87, name: 'an Epic that carries the slug label but is not yet in the index is found on the second look, and no second Epic is made', exit: 0, writes: true,
    args: ['create', 'visibility', '--create-epic', 'Harness delivery'], hub: unlinked,
    jira: (j) => { j.issues.push({ key: 'PLAT-9', issueType: 'Epic', labels: ['shl-slug-visibility'], hiddenUntilSearches: 1 }); },
    check: (r, fake) => (fake.state.created.length === 2 && issue(fake, 'PLAT-301').parent === 'PLAT-9' ? [] : [`created ${fake.state.created}`]) },
  { n: 88, name: 'a project that names its issue type differently stops the run before a ticket is made, and lists the types it does offer', exit: 1,
    args: ['create', 'visibility', '--epic', 'PLAT-9'], hub: unlinked, jira: withEpic,
    fake: (st) => { st.issueTypeIds = { 'User story': '10125', Epic: '10000', Subtask: '10107' }; },
    includes: ['has no issue type "Story"', 'it offers: User story, Epic, Subtask', 'nothing is created'], check: (r, fake) => (fake.state.created.length === 0 ? [] : ['something was made']) },
  { n: 89, name: 'a ticket in no sprint, which Jira reports as null, is not in the active sprint rather than unknown', exit: 0, args: ['plan', 'SVC-101'],
    jira: (j) => { j.issues[0].sprints = null; },
    check: (r) => (item(r, 'SVC-101').ticket.sprint === 'not-in' ? [] : [`sprint ${item(r, 'SVC-101').ticket.sprint}`]) },
  // ---- found by the second independent review of create
  { n: 90, name: 'a retry that names another Epic than the one the unmerged link branch records is usage, and nothing more is made', exit: 2, writes: true,
    args: ['create', 'visibility', '--epic', 'PLAT-9'], hub: unlinked,
    jira: (j) => { withEpic(j); j.issues.push({ key: 'PLAT-10', issueType: 'Epic', summary: 'Another Epic' }); },
    fake: (st) => { st.failCreateAfter = 1; },
    again: { args: ['create', 'visibility', '--epic', 'PLAT-10'], exit: 3, fake: (st) => { st.failCreateAfter = null; } },
    check: (r, fake, hub, second) => {
      const p = [];
      if (!second.err.includes('already has the Epic acme:PLAT-9') || !second.err.includes('unmerged branch')) p.push(`second run said: ${second.err.slice(0, 300)}`);
      if (fake.state.created.length !== 1) p.push(`${fake.state.created.length} tickets exist`);
      if (linkOnBranch(hub, 'visibility').epic !== 'acme:PLAT-9') p.push(`the recorded Epic is now ${linkOnBranch(hub, 'visibility').epic}`);
      return p;
    } },
  { n: 91, name: 'a link branch whose commits a squash merge brought into the trunk is cut again, so the new branch merges with the trunk without conflict', exit: 2, writes: true,
    args: ['create', 'visibility', '--epic', 'PLAT-9'], hub: unlinked, jira: withEpic,
    fake: (st) => { st.failCreateAfter = 1; },
    again: {
      args: ['create', 'visibility', '--epic', 'PLAT-9'], exit: 0, fake: (st) => { st.failCreateAfter = null; },
      before: async (hub) => {
        const clone = join(dirname(hub.work), 'squasher');
        git(dirname(hub.work), ['clone', '-q', hub.bare, clone]);
        for (const [k, v] of [['user.name', 'Fixture Runner'], ['user.email', 'fixture@example.invalid'], ['commit.gpgsign', 'false']]) git(clone, ['config', k, v]);
        git(clone, ['fetch', '-q', hub.work, 'harness/tracker-links-visibility:refs/heads/linkbranch']);
        git(clone, ['merge', '--squash', 'linkbranch']);
        git(clone, ['commit', '-q', '-m', 'squash of the link branch']);
        git(clone, ['push', '-q', 'origin', 'main']);
      },
    },
    check: (r, fake, hub) => {
      const p = [];
      const branch = 'harness/tracker-links-visibility';
      try { git(hub.work, ['merge-base', '--is-ancestor', 'origin/main', branch]); } catch { p.push('the link branch is not cut from the trunk that holds the squash merge'); }
      try { git(hub.work, ['merge-tree', '--write-tree', 'origin/main', branch]); } catch { p.push('the link branch conflicts with the trunk'); }
      if (Object.keys(linkOnBranch(hub, 'visibility').items).join() !== 'SVC-101,SVC-102') p.push('the link file lacks a story');
      return p;
    } },
  { n: 92, name: 'a ticket whose create reply was lost and which stays out of the index for two looks is found on the third, because the run before it ended uncertain', exit: 2, writes: true,
    args: ['create', 'visibility', '--epic', 'PLAT-9'], hub: unlinked, jira: withEpic,
    fake: (st) => { st.loseCreateReplyAt = 2; st.lostCreateLag = 2; },
    again: { args: ['create', 'visibility', '--epic', 'PLAT-9'], exit: 0 },
    check: (r, fake, hub, second) => {
      const o = json(second);
      return fake.state.created.length === 2 && o && o.adopted.length === 2 && o.created.length === 0 ? [] : [`${fake.state.created.length} tickets exist; second run ${second.out.slice(0, 300)}`];
    } },
  { n: 93, name: 'an Epic the project cannot make without a field stops --create-epic before anything is made, naming the field', exit: 1,
    args: ['create', 'visibility', '--create-epic', 'Harness delivery'], hub: unlinked,
    fake: (st) => { st.required = { Epic: [{ id: '10700', name: 'Team' }] }; },
    includes: ['requires Team (customfield_10700) on an Epic', 'pass --epic <KEY>', 'nothing is created'],
    check: (r, fake) => (fake.state.created.length === 0 ? [] : ['something was made']) },
  { n: 94, name: 'apply walks a route one hop at a time and labels the ticket once it is there', exit: 0, writes: true, args: ['apply', 'SVC-101'],
    check: (r, fake) => (statusOf(fake, 'PLAT-210') === 'Ready for Development' && labelsOf(fake, 'PLAT-210').includes('shl-applied-design-merged') && posts(fake, /transitions$/) === 2 ? [] : [`status ${statusOf(fake, 'PLAT-210')}, labels ${labelsOf(fake, 'PLAT-210')}, ${posts(fake, /transitions$/)} transitions`]) },
  { n: 95, name: 'apply twice moves it once: the second run finds the label and writes nothing', exit: 0, writes: true, args: ['apply', 'SVC-101'],
    again: { args: ['apply', 'SVC-101'], exit: 0 },
    check: (r, fake) => (posts(fake, /transitions$/) === 2 ? [] : [`${posts(fake, /transitions$/)} transitions in all`]) },
  { n: 96, name: 'a hop Jira will not let the harness take leaves the ticket waiting on a person: a label, one comment, exit 0', exit: 0, writes: true, args: ['apply', 'SVC-101'],
    jira: (j) => { j.workflows = { Story: storyWorkflow().map((t) => (t.id === '264' ? { ...t, requiredFields: ['Resolution'] } : t)) }; },
    check: (r, fake) => {
      const c = commentsOf(fake, 'PLAT-210'); const o = json(r); const p = [];
      if (statusOf(fake, 'PLAT-210') !== 'Backlog') p.push('it moved');
      if (!labelsOf(fake, 'PLAT-210').includes('shl-waiting-on-human') || labelsOf(fake, 'PLAT-210').includes('shl-applied-design-merged')) p.push(`labels ${labelsOf(fake, 'PLAT-210')}`);
      if (c.length !== 1 || !c[0].includes('[shl:waiting:design-merged:') || !c[0].includes('asks for Resolution')) p.push(`comments ${JSON.stringify(c)}`);
      if (!o || !o.waitingOnAHuman.length) p.push('the waiting list is empty');
      return p;
    } },
  { n: 97, name: 'once the person has cleared the way, the next run finishes the route and takes the waiting label off', exit: 0, writes: true, args: ['apply', 'SVC-101'],
    jira: (j) => { j.workflows = { Story: storyWorkflow().map((t) => (t.id === '264' ? { ...t, requiredFields: ['Resolution'] } : t)) }; },
    again: { args: ['apply', 'SVC-101'], exit: 0, fake: (st) => { st.workflows = { ...st.workflows, Story: storyWorkflow() }; } },
    check: (r, fake) => (statusOf(fake, 'PLAT-210') === 'Ready for Development' && !labelsOf(fake, 'PLAT-210').includes('shl-waiting-on-human') && labelsOf(fake, 'PLAT-210').includes('shl-applied-design-merged') ? [] : [`status ${statusOf(fake, 'PLAT-210')}, labels ${labelsOf(fake, 'PLAT-210')}`]) },
  { n: 98, name: '--fact merged labels and comments once, with the pull request, and never moves the ticket', exit: 0, writes: true, args: ['apply', 'SVC-101', '--fact', 'merged', '--pr', 'https://example.invalid/pr/7'],
    hub: (h) => { delete h.files['docs/designs/SVC-101.lld.md']; },
    again: { args: ['apply', 'SVC-101', '--fact', 'merged', '--pr', 'https://example.invalid/pr/7'], exit: 0 },
    check: (r, fake) => { const c = commentsOf(fake, 'PLAT-210'); return labelsOf(fake, 'PLAT-210').includes('shl-merged') && c.length === 1 && c[0].startsWith('[shl:merged]') && c[0].includes('https://example.invalid/pr/7') && statusOf(fake, 'PLAT-210') === 'Backlog' ? [] : [`labels ${labelsOf(fake, 'PLAT-210')}, comments ${JSON.stringify(c)}`]; } },
  { n: 100, name: 'sprint add: a ticket outside the active sprint is added to it, and a second run adds nothing', exit: 0, writes: true, args: ['apply', 'SVC-101'],
    hub: (h) => { h.trackers.boards.nova.sprint = 'add'; },
    fake: (st) => { st.sprints = { 1153: [{ id: 5, name: 'Nova Sprint 2' }] }; },
    again: { args: ['apply', 'SVC-101'], exit: 0 },
    check: (r, fake) => (posts(fake, /\/sprint\/5\/issue$/) === 1 ? [] : [`${posts(fake, /\/sprint\/5\/issue$/)} sprint adds`]) },
  { n: 101, name: 'a transition whose reply was lost is read back, not taken twice: the walk carries on and the run succeeds', exit: 0, writes: true, args: ['apply', 'SVC-101'],
    fake: (st) => { st.lostTransitionReply = true; },
    again: { args: ['apply', 'SVC-101'], exit: 0 },
    check: (r, fake) => (statusOf(fake, 'PLAT-210') === 'Ready for Development' && posts(fake, /transitions$/) === 2 && labelsOf(fake, 'PLAT-210').includes('shl-applied-design-merged') ? [] : [`status ${statusOf(fake, 'PLAT-210')}, ${posts(fake, /transitions$/)} transitions, labels ${labelsOf(fake, 'PLAT-210')}`]) },
  { n: 102, name: 'apply on a story with no ticket skips it and writes nothing', exit: 0, args: ['apply', 'SVC-102'],
    check: (r) => { const it = (json(r).items || []).find((i) => i.key === 'SVC-102'); return it && it.results.some((x) => x.kind === 'create' && x.result === 'skipped') ? [] : [`expected a skipped create, got ${JSON.stringify(it)}`]; } },
  { n: 103, name: 'a lost reply on the LAST hop is read back too: the label is written and the route is not re-walked', exit: 0, writes: true, args: ['apply', 'SVC-101'],
    fake: (st) => { st.lostTransitionReplyAt = 2; },
    again: { args: ['apply', 'SVC-101'], exit: 0 },
    check: (r, fake) => (statusOf(fake, 'PLAT-210') === 'Ready for Development' && labelsOf(fake, 'PLAT-210').includes('shl-applied-design-merged') && posts(fake, /transitions$/) === 2 ? [] : [`status ${statusOf(fake, 'PLAT-210')}, labels ${labelsOf(fake, 'PLAT-210')}, ${posts(fake, /transitions$/)} transitions`]) },
  { n: 104, name: 'a comment that fails leaves nothing half-done: the next run writes the comment and the label, once each', exit: 2, writes: true, args: ['apply', 'SVC-101', '--fact', 'merged', '--pr', 'https://example.invalid/pr/7'],
    hub: (h) => { delete h.files['docs/designs/SVC-101.lld.md']; },
    fake: (st) => { st.failCommentPost = 1; },
    again: { args: ['apply', 'SVC-101', '--fact', 'merged', '--pr', 'https://example.invalid/pr/7'], exit: 0 },
    check: (r, fake) => (labelsOf(fake, 'PLAT-210').includes('shl-merged') && commentsOf(fake, 'PLAT-210').length === 1 ? [] : [`labels ${labelsOf(fake, 'PLAT-210')}, comments ${commentsOf(fake, 'PLAT-210').length}`]) },
  { n: 105, name: 'one ticket Jira cannot read does not stop the others: it is that ticket\'s finding, the rest are applied, and the run is cannot-verify', exit: 2, writes: true, args: ['apply', '--all'],
    hub: (h) => { h.links.visibility.items['SVC-102'] = { type: 'story', board: 'nova', ticket: 'acme:PLAT-211' }; h.files['docs/designs/SVC-102.lld.md'] = '# design\n'; },
    jira: (j) => { j.issues.push({ key: 'PLAT-211', status: 'Backlog' }); },
    fake: (st) => { st.brokenIssues = ['PLAT-210']; },
    check: (r, fake) => { const o = json(r); return o && o.items.length === 2 && o.findings.some((f) => /SVC-101/.test(f)) && statusOf(fake, 'PLAT-211') === 'Ready for Development' ? [] : [`items ${o && o.items.length}, PLAT-211 ${statusOf(fake, 'PLAT-211')}`]; } },
  // ---- found by the review of apply
  { n: 106, name: 'a story finished in a closed sprint is Done, and is not added to the next sprint', exit: 0, args: ['apply', 'SVC-101'],
    hub: (h) => { h.trackers.boards.nova.sprint = 'add'; },
    jira: (j) => { j.issues[0].status = 'Done'; j.issues[0].sprints = [{ id: 1, boardId: 1153, state: 'closed' }]; },
    fake: (st) => { st.sprints = { 1153: [{ id: 5, name: 'Nova Sprint 2' }] }; },
    check: (r, fake) => (posts(fake, /\/sprint\/5\/issue$/) === 0 ? [] : ['a Done ticket was added to the active sprint']) },
  { n: 107, name: 'a started that failed is caught up by a later in-review: the ticket goes through In Development to Awaiting Code Review', exit: 2, writes: true,
    args: ['apply', 'SVC-101', '--fact', 'started'], jira: inStatus('Ready for Development'),
    fake: (st) => { st.failTransition503 = true; },
    again: { args: ['apply', 'SVC-101', '--fact', 'in-review'], exit: 0 },
    check: (r, fake) => { const l = labelsOf(fake, 'PLAT-210'); return statusOf(fake, 'PLAT-210') === 'Awaiting Code Review' && l.includes('shl-applied-started') && l.includes('shl-applied-in-review') ? [] : [`status ${statusOf(fake, 'PLAT-210')}, labels ${l}`]; } },
  { n: 108, name: 'a merged fact retries a started that never came, and the waiting label stays while an earlier hop is stuck', exit: 0, writes: true,
    args: ['apply', 'SVC-101', '--fact', 'merged', '--pr', 'https://example.invalid/pr/7'], jira: (j) => { j.issues[0].status = 'Ready for Development'; j.issues[0].labels = ['shl-waiting-on-human']; },
    hub: noDesign,
    fake: (st) => { st.workflows = { Story: storyWorkflow().map((t) => (t.id === '284' ? { ...t, requiredFields: ['Resolution'] } : t)) }; },
    check: (r, fake) => { const l = labelsOf(fake, 'PLAT-210'); return statusOf(fake, 'PLAT-210') === 'Ready for Development' && l.includes('shl-waiting-on-human') && l.includes('shl-merged') ? [] : [`status ${statusOf(fake, 'PLAT-210')}, labels ${l}`]; } },
  { n: 109, name: 'a credential Jira refuses part-way through is cannot-verify, and the earlier tickets that moved are still reported', exit: 2, writes: true, args: ['apply', '--all'],
    hub: fourStories, jira: fourTickets,
    fake: (st) => { st.forbiddenIssues = ['PLAT-213']; },
    check: (r, fake) => {
      const o = json(r); const p = [];
      if (!o || o.items.length !== 4) return [`items ${o && o.items.length}`];
      for (const k of ['PLAT-210', 'PLAT-211', 'PLAT-212']) if (statusOf(fake, k) !== 'Ready for Development') p.push(`${k} is ${statusOf(fake, k)}`);
      if (!r.err.includes('SVC-101') || !r.err.includes('SVC-103')) p.push('the summary lacks the tickets that moved');
      if (!o.items[3].results.some((x) => x.result === 'failed' && /403|permission/.test(x.detail))) p.push('the refused ticket has no failed result');
      return p;
    } },
  { n: 113, name: 'a person\'s comment that starts with the merged marker does not stand in for the harness\'s own', exit: 0, writes: true,
    args: ['apply', 'SVC-101', '--fact', 'merged', '--pr', 'https://example.invalid/pr/7'], hub: noDesign,
    jira: (j) => { j.issues[0].labels = ['shl-merged']; j.issues[0].comments = [{ id: '1', body: '[shl:merged] I merged it myself', author: { accountId: 'someone-else' } }]; },
    check: (r, fake) => { const c = commentsOf(fake, 'PLAT-210'); return c.length === 2 && c[1].includes('Merged to the repository') ? [] : [`comments ${JSON.stringify(c)}`]; } },
  { n: 114, name: 'a global transition to the next status is taken like any other', exit: 0, writes: true, args: ['apply', 'SVC-101'],
    jira: (j) => { j.issues[0].status = 'In Analysis'; withWorkflow((w) => [...w.filter((t) => t.to !== 'Ready for Development'), { id: '900', name: 'Straight to Ready', from: '*', to: 'Ready for Development', isGlobal: true }])(j); },
    check: (r, fake) => (statusOf(fake, 'PLAT-210') === 'Ready for Development' && fake.state.transitionsTaken === 1 ? [] : [`status ${statusOf(fake, 'PLAT-210')}`]) },
  { n: 115, name: 'two transitions that both lead to the next status are never guessed between: a failure, exit 1, and nothing moves', exit: 1, args: ['apply', 'SVC-101'],
    jira: withWorkflow((w) => [...w, { id: '901', name: 'Analyse (again)', from: 'Backlog', to: 'In Analysis' }]),
    includes: ['transitions to "In Analysis" qualify'], check: (r, fake) => (statusOf(fake, 'PLAT-210') === 'Backlog' ? [] : ['it moved']) },
  { n: 116, name: '--fact started applies: Ready for Development to In Development, labelled', exit: 0, writes: true, args: ['apply', 'SVC-101', '--fact', 'started'], jira: inStatus('Ready for Development'),
    check: (r, fake) => (statusOf(fake, 'PLAT-210') === 'In Development' && labelsOf(fake, 'PLAT-210').includes('shl-applied-started') ? [] : [`status ${statusOf(fake, 'PLAT-210')}, labels ${labelsOf(fake, 'PLAT-210')}`]) },
  { n: 117, name: '--fact in-review applies: In Development to Awaiting Code Review, labelled', exit: 0, writes: true, args: ['apply', 'SVC-101', '--fact', 'in-review', '--pr', 'https://example.invalid/pr/7'], jira: inStatus('In Development'),
    check: (r, fake) => (statusOf(fake, 'PLAT-210') === 'Awaiting Code Review' && labelsOf(fake, 'PLAT-210').includes('shl-applied-in-review') ? [] : [`status ${statusOf(fake, 'PLAT-210')}, labels ${labelsOf(fake, 'PLAT-210')}`]) },
  { n: 118, name: 'a ticket already at its target is marked as applied without a transition', exit: 0, writes: true, args: ['apply', 'SVC-101'], jira: inStatus('Ready for Development'),
    check: (r, fake) => (posts(fake, /transitions$/) === 0 && labelsOf(fake, 'PLAT-210').includes('shl-applied-design-merged') && resultsOf(r, 'SVC-101').some((x) => x.kind === 'mark' && x.result === 'done') ? [] : [`${posts(fake, /transitions$/)} transitions, labels ${labelsOf(fake, 'PLAT-210')}`]) },
  { n: 119, name: 'a transition that lands somewhere else than it names leaves the ticket waiting on a person, with the status it reached', exit: 0, writes: true, args: ['apply', 'SVC-101'],
    fake: (st) => { st.transitionLands = { 264: 'Awaiting QA' }; },
    check: (r, fake) => { const c = commentsOf(fake, 'PLAT-210'); return statusOf(fake, 'PLAT-210') === 'Awaiting QA' && labelsOf(fake, 'PLAT-210').includes('shl-waiting-on-human') && c.length === 1 && c[0].includes('"Awaiting QA", not "In Analysis"') ? [] : [`status ${statusOf(fake, 'PLAT-210')}, comments ${JSON.stringify(c)}`]; } },
  { n: 120, name: 'a lost reply on a transition that landed somewhere else is recorded as what happened, not rethrown as a bare 503', exit: 0, writes: true, args: ['apply', 'SVC-101'],
    fake: (st) => { st.transitionLands = { 264: 'Awaiting QA' }; st.lostTransitionReply = true; },
    check: (r, fake) => { const w = resultsOf(r, 'SVC-101').find((x) => x.result === 'waiting'); return w && w.detail.includes('reply to "Analyse" was lost') && w.detail.includes('"Awaiting QA"') ? [] : [`results ${JSON.stringify(resultsOf(r, 'SVC-101'))}`]; } },
  { n: 121, name: 'a transition answered 429 is retried and taken once', exit: 0, writes: true, args: ['apply', 'SVC-101'],
    fake: (st) => { st.rateLimitTransition = 1; },
    check: (r, fake) => (statusOf(fake, 'PLAT-210') === 'Ready for Development' && fake.state.transitionsTaken === 2 ? [] : [`status ${statusOf(fake, 'PLAT-210')}, ${fake.state.transitionsTaken} taken`]) },
  { n: 122, name: 'a label write that fails after the route is walked is a failure that still says what was taken, and the next run only writes the label', exit: 2, writes: true, args: ['apply', 'SVC-101'],
    fake: (st) => { st.failLabelPut = 99; },
    again: { args: ['apply', 'SVC-101'], exit: 0, fake: (st) => { st.failLabelPut = 0; } },
    check: (r, fake) => {
      const first = resultsOf(r, 'SVC-101'); const p = [];
      if (first.some((x) => x.kind === 'move' && x.result === 'done')) p.push('the move was reported done before its label was written');
      if (!first.some((x) => x.kind === 'move' && x.result === 'failed' && x.detail.includes('took Analyse, Ready for Development'))) p.push(`first results ${JSON.stringify(first)}`);
      if (fake.state.transitionsTaken !== 2 || !labelsOf(fake, 'PLAT-210').includes('shl-applied-design-merged')) p.push(`${fake.state.transitionsTaken} transitions, labels ${labelsOf(fake, 'PLAT-210')}`);
      return p;
    } },
  { n: 123, name: 'a Kanban board has no sprints: a sprint add on it is skipped, not an error', exit: 0, args: ['apply', 'SVC-101'],
    hub: (h) => { h.trackers.boards.nova.sprint = 'add'; noDesign(h); },
    fake: (st) => { st.kanban = true; },
    check: (r) => (resultsOf(r, 'SVC-101').some((x) => x.kind === 'add-to-sprint' && x.result === 'skipped') ? [] : [`results ${JSON.stringify(resultsOf(r, 'SVC-101'))}`]) },
  { n: 124, name: 'create: a story\'s ticket carries a Context section -- its Hub commit: with the date, the requirements document\'s Global: release, and one row per entry with its pin and where the trunk stands', exit: 0, writes: true,
    args: ['create', 'visibility', '--epic', 'PLAT-9'], hub: (h) => { unlinked(h); h.files[ADR_PATH] = ADR; h.files['docs/requirements/visibility/requirements.md'] = `# Visibility\n\nGlobal: v1.2.0 ${'b'.repeat(40)}\n`; }, jira: withEpic,
    setup: (hub) => {
      const head = gitOut(hub.work, ['rev-parse', 'origin/main']);
      pushFile(hub, 'docs/backlog/visibility/SVC-102.item.md', `# SVC-102 — Make the other thing visible\n\nKey: SVC-102\nRepository: svc\nContext: ${ADR_ENTRY}\nHub commit: ${head}\n`);
    },
    check: (r, fake, hub) => {
      const p = [];
      const first = gitOut(hub.work, ['rev-list', '--max-parents=0', 'origin/main']);
      const made = fake.state.created.map((k) => issue(fake, k)).find((i) => i.summary.startsWith('SVC-102'));
      const text = made ? textOf(made.description) : '';
      for (const s of ['Context', `Hub commit: ${first} (${first.slice(0, 12)}, `, 'on the trunk)', `Global: v1.2.0 ${'b'.repeat(40)}`, `- ADR-001 · adr · ${ADR_PATH} · pin ${pinOf(ADR)} · current`]) if (!text.includes(s)) p.push(`SVC-102's description lacks ${JSON.stringify(s)}: ${JSON.stringify(text)}`);
      if (text.includes('Not read')) p.push('a well-formed story reads as not read');
      return p;
    } },
  { n: 125, name: 'create: a story with no Context: and Hub commit: lines gets a Context section that says what was not read, and the create still succeeds', exit: 0, writes: true,
    args: ['create', 'visibility', '--epic', 'PLAT-9'], hub: unlinked, jira: withEpic,
    check: (r, fake) => {
      const made = fake.state.created.map((k) => issue(fake, k)).find((i) => i.summary.startsWith('SVC-102'));
      const text = made ? textOf(made.description) : '';
      return ['Hub commit: not read', 'Global: none', 'Not read: the design carries no Context: line'].every((s) => text.includes(s)) ? [] : [`description ${JSON.stringify(text)}`];
    } },
  // ---- an OAuth connection: one token variable, a bearer header, Atlassian's gateway
  { n: 126, name: 'an oauth connection sends the access token as a bearer header and never as basic', exit: 0, args: ['plan', 'SVC-101'],
    hub: oauthConnection, env: OAUTH_ENV,
    check: (r, fake) => {
      const p = [];
      if (!item(r, 'SVC-101')) p.push('no plan for SVC-101');
      if (r.err.indexOf('acting as Fixture Developer') === -1) p.push('did not say who it is acting as');
      if (JSON.stringify(schemesOf(fake)) !== '["Bearer"]') p.push(`Jira saw ${JSON.stringify(schemesOf(fake))}`);
      return p;
    } },
  { n: 127, name: 'an oauth connection writes as the developer: apply walks the ticket with the bearer header', exit: 0, writes: true, args: ['apply', 'SVC-101'],
    hub: oauthConnection, env: OAUTH_ENV,
    check: (r, fake) => (statusOf(fake, 'PLAT-210') === 'Ready for Development' && JSON.stringify(schemesOf(fake)) === '["Bearer"]'
      ? [] : [`status ${statusOf(fake, 'PLAT-210')}, Jira saw ${JSON.stringify(schemesOf(fake))}`]) },
  { n: 128, name: 'an oauth connection with no token in the environment is cannot-verify, and never falls back to the API token', exit: 2, args: ['plan', 'SVC-101'],
    hub: oauthConnection, env: { JIRA_OAUTH_TOKEN: '' },
    includes: ['set JIRA_OAUTH_TOKEN in your environment'],
    check: (r, fake) => (fake.state.requests.length === 0 ? [] : [`Jira was asked ${fake.state.requests.length} time(s)`]) },
  { n: 129, name: 'an access token Jira refuses is cannot-verify, and says that an access token expires', exit: 2, args: ['plan', 'SVC-101'],
    hub: oauthConnection, env: { ...OAUTH_ENV, JIRA_OAUTH_TOKEN: 'expired' },
    includes: ['refused the credential (401)', 'check the OAuth access token', 'An access token expires'] },
  { n: 130, name: 'an oauth connection on the site instead of the gateway stops the run before Jira is asked', exit: 1, args: ['plan', 'SVC-101'],
    hub: (h) => { oauthConnection(h); h.trackers.instances.acme.base_url = 'https://acme.example.invalid'; },
    env: OAUTH_ENV,
    includes: ['not well formed', 'must be https://api.atlassian.com/ex/jira/<cloudId>'] },
  { n: 131, name: '--fact needs-person --link plans the label shl-waiting-on-human and one comment with the link, and moves nothing', exit: 0, args: ['plan', 'SVC-101', '--fact', 'needs-person', '--link', 'https://example.invalid/acme/hub/issues/12'],
    check: (r) => { const a = act(item(r, 'SVC-101'), 'needs-person', 'needs-person'); const moves = (item(r, 'SVC-101').actions || []).filter((x) => x.kind === 'move' && x.fact !== 'design-merged'); return a && a.labels.join() === 'shl-waiting-on-human' && a.marker.startsWith('[shl:needs-person:') && a.link.endsWith('/issues/12') && !moves.length ? [] : [`needs-person action ${JSON.stringify(a)}, other moves ${moves.length}`]; } },
  { n: 132, name: '--fact needs-person labels and comments once, with the link and no detail, and a second run says nothing twice', exit: 0, writes: true, args: ['apply', 'SVC-101', '--fact', 'needs-person', '--link', 'https://example.invalid/acme/hub/issues/12'],
    hub: (h) => { delete h.files['docs/designs/SVC-101.lld.md']; },
    again: { args: ['apply', 'SVC-101', '--fact', 'needs-person', '--link', 'https://example.invalid/acme/hub/issues/12'], exit: 0 },
    check: (r, fake) => { const c = commentsOf(fake, 'PLAT-210'); return labelsOf(fake, 'PLAT-210').includes('shl-waiting-on-human') && c.length === 1 && c[0].startsWith('[shl:needs-person:') && c[0].includes('/acme/hub/issues/12') && statusOf(fake, 'PLAT-210') === 'Backlog' && posts(fake, /\/issue$/) === 0 ? [] : [`labels ${labelsOf(fake, 'PLAT-210')}, comments ${JSON.stringify(c)}, status ${statusOf(fake, 'PLAT-210')}, creates ${posts(fake, /\/issue$/)}`]; } },
  { n: 133, name: '--fact person-answered takes shl-waiting-on-human off, and a ticket without the label is left alone', exit: 0, writes: true, args: ['apply', 'SVC-101', '--fact', 'person-answered'],
    hub: (h) => { delete h.files['docs/designs/SVC-101.lld.md']; },
    jira: (j) => { j.issues[0].labels = ['shl-waiting-on-human']; },
    again: { args: ['apply', 'SVC-101', '--fact', 'person-answered'], exit: 0 },
    check: (r, fake) => (!labelsOf(fake, 'PLAT-210').includes('shl-waiting-on-human') ? [] : [`labels ${labelsOf(fake, 'PLAT-210')}`]) },
  { n: 134, name: 'needs-person without its link is a usage fault', exit: 3, args: ['apply', 'SVC-101', '--fact', 'needs-person'],
    includes: ['--fact needs-person needs --link'] },
  { n: 135, name: '--link goes only with --fact needs-person, and --pr goes only with the pull-request facts', exit: 3, args: ['apply', 'SVC-101', '--fact', 'person-answered', '--link', 'https://example.invalid/x'],
    includes: ['--link goes with --fact needs-person'] },
  { n: 136, name: 'a needs-person fact on a ticket that a person has already labelled waiting adds only the comment, and the move logic never takes the label off in the same run', exit: 0, writes: true, args: ['apply', 'SVC-101', '--fact', 'needs-person', '--link', 'https://example.invalid/acme/hub/issues/12'],
    jira: (j) => { j.issues[0].labels = ['shl-waiting-on-human']; },
    check: (r, fake) => { const c = commentsOf(fake, 'PLAT-210'); return labelsOf(fake, 'PLAT-210').includes('shl-waiting-on-human') && c.length === 1 ? [] : [`labels ${labelsOf(fake, 'PLAT-210')}, comments ${JSON.stringify(c)}`]; } },
  // /connect-jira writes the connection on its branch and runs discover before the pull request
  // merges, so on a first connection the trunk has no tracker file yet (PLDC-688).
  { n: 137, name: 'discover --draft reads a first connection from the working tree when the trunk has none', exit: 0, args: ['discover', '--draft'],
    hub: (h) => { h.trackers = null; h.links = {}; },
    setup: (hub) => { write(hub.work, 'docs/estate/trackers.json', controlFiles().trackers); },
    check: (r) => { const o = json(r); return o && o.board === 'nova' && o.status_ids['In Development'] === STATUS['In Development'] && o.sprint_field === 'customfield_10020' ? [] : [`discover ${r.out}`]; } },
  { n: 138, name: 'discover without --draft still reads only the trunk: a first connection in the working tree is cannot-verify', exit: 2, args: ['discover'],
    hub: (h) => { h.trackers = null; h.links = {}; },
    setup: (hub) => { write(hub.work, 'docs/estate/trackers.json', controlFiles().trackers); },
    includes: ['no docs/estate/trackers.json on origin/main', 'discover <board> --draft'] },
  { n: 139, name: 'discover --draft reads a board the working tree adds and the trunk does not have yet', exit: 0, args: ['discover', 'second', '--draft'],
    setup: (hub) => {
      const t = controlFiles().trackers;
      t.boards.second = { instance: 'acme', project: 'PLAT', board: 1154, sprint: 'report', epics: 'none' };
      write(hub.work, 'docs/estate/trackers.json', t);
    },
    check: (r) => { const o = json(r); return o && o.board === 'second' && o.project === 'PLAT' ? [] : [`discover ${r.out}`]; } },
  { n: 140, name: 'discover --draft with a working-tree file that is not well formed stops before Jira is asked', exit: 1, args: ['discover', '--draft'],
    hub: (h) => { h.trackers = null; h.links = {}; },
    setup: (hub) => { const t = controlFiles().trackers; t.default_board = 'nowhere'; write(hub.work, 'docs/estate/trackers.json', t); },
    includes: ['not well formed', '"default_board" names "nowhere"', 'in the working tree'],
    check: (r, fake) => (fake.state.requests.length ? [`Jira was asked ${fake.state.requests.length} times`] : []) },
  { n: 141, name: 'discover --draft with no tracker file in the working tree is cannot-verify, and names the file', exit: 2, args: ['discover', '--draft'],
    hub: (h) => { h.trackers = null; h.links = {}; },
    includes: ['no docs/estate/trackers.json in the working tree'] },
  { n: 142, name: '--draft belongs to discover only: plan --all --draft is a usage error', exit: 3, args: ['plan', '--all', '--draft'],
    includes: ['--draft goes with discover'] },
];

/* ---------------------------------------------------------------------------- the runner */

async function runFixture(f) {
  const root = mkdtempSync(join(tmpdir(), 'jira-sync-'));
  let fake;
  try {
    const hubSpec = controlFiles();
    const jira = controlJira();
    if (f.hub) f.hub(hubSpec);
    if (f.jira) f.jira(jira);
    fake = await startFake({ issues: jira.issues, workflows: jira.workflows || {} });
    if (f.script) fake.state.script.push(...f.script);
    if (f.fake) f.fake(fake.state);
    const hub = await buildHub(root, hubSpec);
    if (f.setup) await f.setup(hub, fake);
    const result = await run(f.cwd ? join(hub.work, f.cwd) : hub.work, f.args, {
      JIRA_USER: fake.credentials.user,
      JIRA_API_TOKEN: fake.credentials.token,
      HARNESS_JIRA_BASE_URL: fake.url,
      HARNESS_JIRA_SEARCH_LAG_MS: '30',
      ...(f.env || {}),
    }, hub.work);
    if (f.again && f.again.fake) f.again.fake(fake.state);
    if (f.again && f.again.before) await f.again.before(hub, fake);
    const second = f.again ? await run(hub.work, f.again.args, { JIRA_USER: fake.credentials.user, JIRA_API_TOKEN: fake.credentials.token, HARNESS_JIRA_BASE_URL: fake.url, HARNESS_JIRA_SEARCH_LAG_MS: '30' }) : null;
    const problems = [];
    if (result.status !== f.exit) problems.push(`exit ${result.status}, expected ${f.exit}`);
    const text = `${result.out}${result.err}`;
    for (const s of f.includes || []) if (!text.includes(s)) problems.push(`output lacks ${JSON.stringify(s)}`);
    if (!f.writes && fake.writes().length) problems.push(`this fixture expects no write, but Jira saw ${JSON.stringify(fake.writes())}`);
    if (f.again && second.status !== f.again.exit) problems.push(`second run exit ${second.status}, expected ${f.again.exit}`);
    if (f.check) problems.push(...f.check(result, fake, hub, second));
    return { problems, output: text };
  } catch (err) {
    return { problems: [`fixture setup failed: ${err && err.stack ? err.stack : String(err)}`], output: '' };
  } finally {
    if (fake) await fake.stop();
    if (!KEEP) rmSync(root, { recursive: true, force: true });
  }
}

async function main() {
  const wanted = process.argv.slice(2).filter((a) => /^\d+$/.test(a)).map(Number);
  const selected = wanted.length ? FIXTURES.filter((f) => wanted.includes(f.n)) : FIXTURES;
  let failed = 0;
  for (const f of selected) {
    const { problems, output } = await runFixture(f);
    if (problems.length) {
      failed += 1;
      process.stdout.write(`  FAIL  ${f.n}. ${f.name} [exit ${f.exit}]\n`);
      for (const p of problems) process.stdout.write(`          - ${p}\n`);
      process.stdout.write(`${output.split('\n').slice(0, 25).map((l) => `          | ${l}`).join('\n')}\n`);
    } else {
      process.stdout.write(`  PASS  ${f.n}. ${f.name} [exit ${f.exit}]\n`);
    }
  }
  process.stdout.write(failed
    ? `\n${failed} of ${selected.length} fixtures FAILED. The Jira sync is not trustworthy until this is green.\n`
    : `\nAll ${selected.length} fixtures passed.\n`);
  rmSync(SANDBOX_HOME, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
}

main();

#!/usr/bin/env node
/**
 * run.mjs — the fixture suite for pull-request.mjs.
 *
 *   usage:  node run.mjs            run every fixture
 *           node run.mjs 2 6        run only the numbered fixtures
 *           node run.mjs --keep     leave the throwaway hubs on disk
 *
 * A fixture is a HUB STATE plus a FORGE: a throwaway hub folder with the repository registry, and
 * a fake `gh` first on PATH (fake-gh.mjs) answering from a state file the fixture writes and
 * recording every call there, as scripts/tests/release/run.mjs fakes gh. The shipped script is run
 * as the main session runs it, and exit code, output, and what gh was asked and now holds are
 * asserted. Fixture 1 is the valid control. Nothing reaches a network, and everything runs under
 * a private HOME.
 *
 * Node standard library only. No test framework.
 * Exit 0 if every fixture passes, 1 if any fails.
 */

import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { HOST, OWNER, REPO, addIssueComment, addPull, addReview, addThread, newState } from './fake-gh.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FAKE = join(HERE, 'fake-gh.mjs');

const SCRIPT = [
  process.env.HARNESS_PULL_REQUEST,
  resolve(HERE, '..', '..', 'pull-request.mjs'),
  resolve(HERE, '..', '..', 'scripts', 'pull-request.mjs'),
].filter(Boolean).find((p) => existsSync(p));
if (!SCRIPT) {
  console.error('cannot locate pull-request.mjs. Set HARNESS_PULL_REQUEST=/path/to/pull-request.mjs.');
  process.exit(4);
}
// The watermark's own check, which pull-request.mjs cannot import in both layouts and so copies.
const CHECK_WATERMARK = [
  process.env.HARNESS_CHECK_WATERMARK,
  resolve(HERE, '..', '..', '..', 'gate', 'check-watermark.mjs'),
  resolve(HERE, '..', '..', 'scripts', 'check-watermark.mjs'),
].filter(Boolean).find((p) => existsSync(p));
if (!CHECK_WATERMARK) {
  console.error('cannot locate check-watermark.mjs. Set HARNESS_CHECK_WATERMARK=/path/to/check-watermark.mjs.');
  process.exit(4);
}
const pullRequest = await import(pathToFileURL(SCRIPT).href);
const checkWatermark = await import(pathToFileURL(CHECK_WATERMARK).href);

const W = 'Generated-by: SHL Agentic Harness';
const KEEP = process.argv.includes('--keep');
const SANDBOX_HOME = mkdtempSync(join(tmpdir(), 'pull-request-home-'));
const ENV = { ...process.env, HOME: SANDBOX_HOME, XDG_CONFIG_HOME: join(SANDBOX_HOME, '.config'), GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };
for (const k of ['HARNESS_REGISTRY', 'GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN', 'GH_HOST', 'GH_CONFIG_DIR']) delete ENV[k];

const HEAD = '7b8c9d0e1f2a3b4c5d6e7f8091a2b3c4d5e6f708';
const BASE = '1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d';
const BRANCH = 'feature/ORD-12-x';
const PR = 482;
const PARSE_PATCH = '@@ -38,6 +38,9 @@ export function parseOrder(input) {\n   const basket = input.basket;\n   const items = basket.items;\n-  return items;\n+  if (!items.length) {\n+    return reject("empty");\n+  }\n+  return accept(items);\n+  // done\n }\n';
const TOTAL_PATCH = '@@ -55,4 +55,4 @@ export function total(order) {\n   const sum = order.items.reduce((a, b) => a + b.price, 0);\n-  return Math.round(sum);\n+  return roundHalfEven(sum);\n }\n';
const FILES = [{ path: 'src/orders/parse.ts', patch: PARSE_PATCH }, { path: 'src/orders/total.ts', patch: TOTAL_PATCH }];
const BUG = '`parseOrder` reads `basket.items` before it checks that `basket` is set, so an order with no basket throws. Return the rejection when `basket` is missing.';
const GAP = '`total` rounds half to even while `tax` rounds half up, so the two disagree on a .5 total. Round both the same way.';

/* ------------------------------------------------------------- the hub and the forge */

/**
 * A hub folder with the registry, a fake gh first on PATH, and its state: the control's pull
 * request on it. `f.state` is written for the script with `f.save()` and read back with `f.load()`.
 */
function forge(root, { url = `https://${HOST}/${OWNER}/${REPO}.git`, labels = [], ...state } = {}) {
  mkdirSync(join(root, 'bin'), { recursive: true });
  writeFileSync(join(root, 'bin', 'gh'), `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" "$@"\n`);
  chmodSync(join(root, 'bin', 'gh'), 0o755);
  const registry = join(root, 'repositories.json');
  writeFileSync(registry, JSON.stringify({ schema_version: 1, repositories: { svc: { url, checks: 'checks.env', purpose: 'A made-up service for the pull-request fixtures.', readAt: 'c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00', trunk: 'default' } } }, null, 2));
  const f = { root, registry, statePath: join(root, 'gh-state.json'), state: newState(state) };
  addPull(f.state, { number: PR, branch: BRANCH, head: HEAD, body: 'Implements ORD-12.\n\nGenerated-by: SHL Agentic Harness\n', labels, files: FILES });
  f.save = () => writeFileSync(f.statePath, JSON.stringify(f.state, null, 2));
  f.load = () => { f.state = JSON.parse(readFileSync(f.statePath, 'utf8')); return f.state; };
  f.save();
  return f;
}

/** The shipped script, run as the main session runs it. */
function run(f, args, env = {}) {
  const res = spawnSync(process.execPath, [SCRIPT, args[0], '--repo-id', 'svc', ...args.slice(1)], {
    cwd: f.root, encoding: 'utf8',
    env: { ...ENV, PATH: `${join(f.root, 'bin')}:${process.env.PATH}`, HARNESS_REGISTRY: f.registry, FAKE_GH_STATE: f.statePath, ...env },
  });
  return { status: res.status, stdout: res.stdout || '', stderr: res.stderr || '', output: `${res.stdout || ''}${res.stderr || ''}` };
}

const writes = (state) => state.calls.filter((c) => c.route && (c.route.startsWith('POST') || c.route.startsWith('DELETE') || c.route === 'GRAPHQL ResolveThread'));
const harnessBody = (n, category, severity, text) => `**[SHL-R${n}]** **[${category} · ${severity}]** ${text}\n\n${W}`;
const file = (f, name, text) => { const p = join(f.root, name); writeFileSync(p, typeof text === 'string' ? text : JSON.stringify(text, null, 2)); return p; };
const finding = (id, over = {}) => ({ id, file: 'src/orders/parse.ts', line: 42, endLine: 42, severity: 'blocking', category: 'bug', title: `Finding ${id}`, body: BUG, ...over });
const findings = (list, over = {}) => ({ prId: String(PR), reviewedCommit: HEAD, baseCommit: BASE, summary: 'One blocking bug and a rounding gap; the rest is clean.', findings: list, preexistingNotes: [], ...over });
const verdict = (id, v = 'real', reason = `Confirmed at the line ${id} names.`, confidence = 'high') => ({ id, verdict: v, confidence, reason });
const verified = (list, over = {}) => ({ prId: String(PR), reviewedCommit: HEAD, baseCommit: BASE, verifierSummary: `${list.length} checked.`, verdicts: list, ...over });
const post = (f, fnd, ver) => run(f, ['post', '--pr', String(PR), '--head', HEAD, '--findings', file(f, 'findings.json', fnd), ...(ver === undefined ? [] : ['--verified', file(f, 'verified-findings.json', ver)])]);

/* ------------------------------------------------------- the scanner bot, Prime Security */

const PRIME = 'prime-security-app';
const OLD = '0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c';
// Prime's comment, exactly as Prime Security writes it on GitHub.
const primeBody = (policy, standard, sentence, fix) => `<details>\n\n <summary><b> This violates: </b>${policy} (${standard})</summary>\n\nThe policy, in one paragraph.\n\n</details>\n\n${sentence}\n\n<details>\n\n <summary><b> Suggested fix</b></summary>\n\n${fix}\n\n</details>`;
const LOG = primeBody('Security Event Logging with Metadata', 'COMPANY POLICY', 'Add the call ID to this rejected-report event.', 'Log the call ID and the trace ID.');
const FLOW = primeBody('Sequential Business Logic Flow', 'OWASP_ASVS', 'The routing path bypasses inactive modules.', 'Stop at the first inactive module.');
const ATOMIC = primeBody('Atomic Multi-Step Workflow Integrity', 'COMPANY POLICY', 'The workflow commits before it updates the state.', 'Use one transaction.');
const primeReview = (f, commit, comments) => addReview(f.state, { pull: PR, author: PRIME, bot: true, commit, comments });
const json = (r, problems) => { try { return JSON.parse(r.stdout); } catch { problems.push(`not JSON: ${r.output}`); return { threads: [], duplicates: [], gone: [], answered: [], withPerson: [] }; } };
// A wait in which one second lasts `ms` milliseconds.
const wait = (f, args, ms) => run(f, ['await', '--pr', String(PR), '--bot', PRIME, ...args], { HARNESS_AWAIT_SECOND_MS: String(ms) });
const reviewReads = (s) => s.calls.filter((c) => c.route === `GET repos/${OWNER}/${REPO}/pulls/${PR}/reviews`).length;

/**
 * The control estate of Prime threads: an old review at OLD and a review at HEAD. At HEAD Prime
 * repeats the logging finding and adds the flow one; the atomic one is gone; a person replied in an
 * old flow thread; a harness thread and a person's account named like the bot are on it too.
 */
function primeEstate(root, { headReview = true } = {}) {
  const f = forge(root);
  const old = primeReview(f, OLD, [{ path: 'src/orders/parse.ts', line: 42, body: LOG }, { path: 'src/orders/total.ts', line: 57, body: ATOMIC }, { path: 'src/orders/parse.ts', line: 43, body: FLOW }]);
  const [oldLog, oldAtomic, oldFlow] = old.threads;
  f.state.comments.push({ ...f.state.comments.find((c) => c.id === oldFlow.ids[0]), id: 9000001, node_id: 'PRRC_9000001', body: 'This is on purpose: inactive modules are skipped by design.', user: { login: 'alice', type: 'User' }, review: null, commit: null, in_reply_to_id: oldFlow.ids[0] });
  oldFlow.ids.push(9000001);
  const earlier = primeReview(f, OLD, [{ path: 'src/orders/parse.ts', line: 42, body: LOG }]);
  earlier.threads[0].resolved = true;
  const mine = addThread(f.state, { pull: PR, path: 'src/orders/total.ts', line: 57, comments: [{ body: harnessBody(1, 'gap', 'should-fix', GAP) }] });
  const impostor = addReview(f.state, { pull: PR, author: PRIME, bot: false, commit: HEAD, comments: [{ path: 'src/orders/parse.ts', line: 44, body: LOG }] });
  const head = headReview ? primeReview(f, HEAD, [{ path: 'src/orders/parse.ts', line: 42, body: LOG }, { path: 'src/orders/parse.ts', line: 44, body: FLOW }]) : { threads: [] };
  f.save();
  return { f, oldLog, oldAtomic, oldFlow, mine, impostor: impostor.threads[0], head: head.threads };
}
const cref = (t) => `PRIME-C${t.ids[0]}`;

function check(res, problems) {
  return { status: res.status, output: `${res.output}${problems.length ? `\nPROBLEMS:\n- ${problems.join('\n- ')}` : ''}` };
}
const both = (...rs) => ({ status: rs[rs.length - 1].status, output: rs.map((r) => r.output).join('\n----\n') });

/* -------------------------------------------------------------------------- fixtures */

const FIXTURES = [
  {
    n: 1, name: 'control: show finds the pull request by its branch and by its number — its number, state, head and branch, and that no harness review is on it yet — and with --body its description; it asks gh for nothing it writes, always naming the host',
    run: (root) => {
      const f = forge(root);
      f.state.reviews.push({ id: 1, pull: PR, event: 'COMMENT', body: 'Looks fine to me.', html_url: 'x' });
      f.save();
      const r = run(f, ['show', '--branch', BRANCH]);
      const byNumber = run(f, ['show', '--pr', String(PR)]);
      const b = run(f, ['show', '--pr', String(PR), '--body']);
      const s = f.load();
      const problems = [];
      if (byNumber.stdout !== r.stdout) problems.push(`show --pr and show --branch differ:\n${byNumber.stdout}\n${r.stdout}`);
      if (writes(s).length) problems.push('show wrote to the forge');
      if (s.calls.some((c) => c.args[0] === 'api' && !c.args.includes(HOST))) problems.push('a gh api call did not name the host');
      if (!b.stdout.endsWith('--- body\nImplements ORD-12.\n\nGenerated-by: SHL Agentic Harness\n')) problems.push(`the description is not printed after "--- body": ${JSON.stringify(b.stdout)}`);
      return check(both(r, b), problems);
    },
    exit: 0, includes: [`pr=${PR}\n`, 'state=open\n', `head=${HEAD}\n`, `branch=${BRANCH}\n`, 'review=none\n'],
  },
  {
    n: 2, name: 'gh not logged in for the registry url\'s host stops the script (exit 2) with the command to run, before any API call; a git@ url reads end to end once gh is logged in; an SSH alias is a host gh does not know and fails there; a url that is neither https:// nor git@ cannot be read',
    run: (root) => {
      const out = forge(join(root, 'out'), { loggedIn: [] });
      const stopped = run(out, ['show', '--branch', BRANCH]);
      const problems = [];
      if (out.load().calls.some((c) => c.args[0] === 'api')) problems.push('an API call was made while gh was not logged in');
      const scp = forge(join(root, 'scp'), { url: `git@${HOST}:${OWNER}/${REPO}.git` });
      const read = run(scp, ['show', '--branch', BRANCH]);
      if (read.status !== 0 || !read.stdout.includes(`pr=${PR}`)) problems.push(`a git@ url: exit ${read.status}\n${read.output}`);
      const alias = forge(join(root, 'alias'), { url: `git@github.com-acme:${OWNER}/${REPO}.git` });
      const unknown = run(alias, ['show', '--branch', BRANCH]);
      if (unknown.status !== 2 || !unknown.output.includes('run: gh auth login --hostname github.com-acme')) problems.push(`an SSH alias: exit ${unknown.status}\n${unknown.output}`);
      const other = forge(join(root, 'other'), { url: `ssh://git@${HOST}/${OWNER}/${REPO}.git` });
      const unread = run(other, ['show', '--branch', BRANCH]);
      if (unread.status !== 2 || !unread.output.includes('is not an https:// or git@ url')) problems.push(`an ssh:// url: exit ${unread.status}\n${unread.output}`);
      return check(stopped, problems);
    },
    exit: 2, includes: [`CANNOT VERIFY: gh is not logged in to ${HOST}: run: gh auth login --hostname ${HOST}`],
  },
  {
    n: 3, name: 'post joins findings.json and verified-findings.json into ONE review of type COMMENT at --head: refuted dropped, real posted, uncertain posted marked not verified; ids continue from the highest [SHL-R<n>] already on the pull request; each comment is [SHL-R<n>] [category · severity] and the body, signed; a finding over several lines of the diff is one comment over them; the body is the template\'s short shape — the counts by severity, the reviewer\'s summary, the verifier\'s tally counted from the votes, the finding no line carries, and what was dropped and the pre-existing notes folded in a <details>, with no list of the comments; show then reports review=posted; --body-file posts the run summary, signed',
    run: (root) => {
      const f = forge(root);
      addThread(f.state, { pull: PR, path: 'src/orders/total.ts', line: 57, comments: [{ body: harnessBody(1, 'convention', 'nit', 'An earlier review comment.') }] });
      addThread(f.state, { pull: PR, path: 'src/orders/parse.ts', line: 40, comments: [{ body: harnessBody(2, 'bug', 'should-fix', 'Another earlier one.') }] });
      f.save();
      const list = [
        finding('F1'),
        finding('F2', { title: 'A false alarm', body: 'Both call roundHalfEven.' }),
        finding('F3', { file: 'src/orders/total.ts', line: 57, endLine: 57, severity: 'should-fix', category: 'gap', title: 'Rounding disagrees', body: GAP }),
        finding('F4', { line: 41, endLine: 43, severity: 'nit', category: 'convention', title: 'Name the guard', body: 'The empty check deserves a name.' }),
        finding('F5', { file: null, line: null, endLine: null, severity: 'should-fix', category: 'gap', title: 'The description says rounded up', body: 'The description says the total is rounded up; the diff rounds half to even.' }),
      ];
      const r = post(f, findings(list, { preexistingNotes: ['src/legacy/x.ts:12 — a timer that is never cleared.'] }), verified([verdict('F1'), verdict('F2', 'refuted', 'total.ts:57 and tax.ts:31 both call roundHalfEven.'), verdict('F3', 'uncertain', 'tax.ts is outside this pull request.', 'low'), verdict('F4'), verdict('F5')], { verifierSummary: '5 checked · 3 real · 1 refuted · 1 uncertain' }));
      const shown = run(f, ['show', '--branch', BRANCH]);
      const s = run(f, ['post', '--pr', String(PR), '--body-file', file(f, 'summary.md', '**SHL harness — run summary**\n\n- SHL-R3 fixed in a1b2c3d\n')]);
      const st = f.load();
      const problems = [];
      if (st.reviews.length !== 1) problems.push(`${st.reviews.length} reviews were posted`);
      const rv = st.reviews[0] || {};
      if (rv.event !== 'COMMENT' || rv.commit_id !== HEAD) problems.push(`the review: ${rv.event} at ${rv.commit_id}`);
      if (!st.comments.some((c) => c.body === harnessBody(3, 'bug', 'blocking', BUG))) problems.push('SHL-R3 is not F1, prefixed and signed');
      if (!st.comments.some((c) => c.body === `**[SHL-R4]** **[gap · should-fix]** ${GAP}\n\n_Not verified: tax.ts is outside this pull request._\n\n${W}`)) problems.push('SHL-R4 is not F3, marked not verified');
      const sent = st.calls.find((c) => c.route === `POST repos/${OWNER}/${REPO}/pulls/${PR}/reviews`);
      const multi = sent && sent.body.comments.find((c) => c.body.startsWith('**[SHL-R5]**'));
      if (!multi || multi.start_line !== 41 || multi.line !== 43) problems.push(`F4 over lines 41-43: ${JSON.stringify(multi)}`);
      if (st.comments.some((c) => c.body.includes('Both call roundHalfEven'))) problems.push('the refuted F2 was posted');
      const body = rv.body || '';
      for (const want of [
        '**SHL harness review** · 3 comments: 1 blocking · 1 should-fix · 1 nit\n\nOne blocking bug and a rounding gap; the rest is clean.\n\nVerifier: 5 checked · 3 real · 1 refuted · 1 uncertain\n\n**Not on a line**\n- the pull request — The description says rounded up (gap · should-fix)\n  The description says the total is rounded up; the diff rounds half to even.',
        '<details><summary>Dropped by the verifier (1) · pre-existing (1)</summary>\n\n- F2 · A false alarm — total.ts:57 and tax.ts:31 both call roundHalfEven.\n\nPre-existing, not introduced here:\n- src/legacy/x.ts:12 — a timer that is never cleared.\n\n</details>',
      ]) {
        if (!body.includes(want)) problems.push(`the summary does not say: ${want}`);
      }
      if (!body.startsWith('**SHL harness review** · ') || !body.endsWith(`</details>\n\n${W}`)) problems.push('the body does not open with the headline and end with the fold, then the watermark');
      if (body.includes('[SHL-R')) problems.push('the body lists the comments, which are inline');
      if (!shown.stdout.includes('review=posted\n')) problems.push(`show after the review: ${shown.output}`);
      const general = st.issueComments[0];
      if (!general || general.body !== `**SHL harness — run summary**\n\n- SHL-R3 fixed in a1b2c3d\n\n${W}`) problems.push(`the run summary reads: ${general ? general.body : 'nothing'}`);
      return check(both(r, s), problems);
    },
    exit: 0, includes: ['VERIFIER 5 checked · 3 real · 1 refuted · 1 uncertain', 'SHL-R3 F1 blocking src/orders/parse.ts:42', 'SHL-R4 F3 should-fix src/orders/total.ts:57', 'SHL-R5 F4 nit src/orders/parse.ts:41', 'SUMMARY F5 [PR]', 'DROPPED F2 — refuted', `REVIEW POSTED https://${HOST}/acme/svc/pull/482#pullrequestreview-`, `POSTED https://${HOST}/acme/svc/pull/482#issuecomment-`],
  },
  {
    n: 4, name: 'post skips a finding already posted (same path, line and opening words) and moves into the summary what GitHub cannot attach to a line — a line outside the diff, a file the pull request does not change — so the one review is accepted; gh\'s pages, slurped into one list, are read whole',
    run: (root) => {
      const f = forge(root, { pageSize: 1 });
      addThread(f.state, { pull: PR, path: 'src/orders/parse.ts', line: 42, comments: [{ body: harnessBody(1, 'bug', 'blocking', BUG) }] });
      f.save();
      const list = [
        finding('F1', { body: `${BUG}\nReworded after the first line.` }),
        finding('F2', { line: 200, endLine: 200, title: 'Off the diff', body: 'A line the diff does not show.' }),
        finding('F3', { file: 'src/orders/tax.ts', line: 31, endLine: 31, title: 'Not in this pull request', body: 'A file this pull request does not change.' }),
        finding('F4', { file: 'src/orders/total.ts', line: 57, endLine: 57, category: 'gap', title: 'Rounding', body: GAP }),
      ];
      const r = post(f, findings(list), verified(list.map((x) => verdict(x.id))));
      const st = f.load();
      const problems = [];
      if (st.reviews.length !== 1) problems.push(`${st.reviews.length} reviews were posted`);
      const sent = st.calls.find((c) => c.route === `POST repos/${OWNER}/${REPO}/pulls/${PR}/reviews`);
      if (!sent || sent.body.comments.length !== 1 || sent.body.comments[0].line !== 57) problems.push(`the review sent ${sent ? JSON.stringify(sent.body.comments.map((c) => `${c.path}:${c.line}`)) : 'nothing'}`);
      const body = (st.reviews[0] || {}).body || '';
      for (const want of ['**SHL harness review** · 1 comment: 1 blocking · 0 should-fix · 0 nit, 1 already posted', '- `src/orders/parse.ts:200` — Off the diff (bug · blocking; a line outside the diff, which GitHub cannot attach a comment to)\n  A line the diff does not show.', '- `src/orders/tax.ts:31` — Not in this pull request (bug · blocking; a file this pull request does not change)']) {
        if (!body.includes(want)) problems.push(`the summary does not say: ${want}`);
      }
      return check(r, problems);
    },
    exit: 0, includes: ['SHL-R2 F4', 'SKIPPED F1 src/orders/parse.ts:42 — already posted as SHL-R1', 'SUMMARY F2 src/orders/parse.ts:200 — a line outside the diff', 'SUMMARY F3 src/orders/tax.ts:31 — a file this pull request does not change', 'REVIEW POSTED'],
  },
  {
    n: 5, name: 'a malformed findings.json is exit 1 with every finding listed, and nothing is posted: another pull request, another commit, a severity or a category outside the sets, an id that is not F<n> or listed twice, a line without a file, an endLine before its line, a two-line title, a body claiming the watermark, a pre-existing note with a suggestion block; a file that is not JSON; and a pull request whose head has moved past --head',
    run: (root) => {
      const f = forge(root);
      const bad = findings([
        finding('F1', { severity: 'CRITICAL', category: 'naming' }),
        finding('F1', { file: null, line: 3, endLine: 3 }),
        finding('X2', { endLine: 40 }),
        finding('F3', { title: 'two\nlines', body: `Fixed.\n\n${W}` }),
      ], { prId: '999', reviewedCommit: 'f'.repeat(40), preexistingNotes: ['Use this:\n```suggestion\nx\n```'] });
      const r = post(f, bad);
      const notJson = run(f, ['post', '--pr', String(PR), '--head', HEAD, '--findings', file(f, 'broken.json', '{ "prId": ')]);
      const stale = 'e'.repeat(40);
      const moved = run(f, ['post', '--pr', String(PR), '--head', stale, '--findings', file(f, 'stale.json', findings([finding('F1')], { reviewedCommit: stale }))]);
      const problems = [];
      if (notJson.status !== 1 || !notJson.output.includes('is not JSON')) problems.push(`a file that is not JSON: exit ${notJson.status}\n${notJson.output}`);
      if (moved.status !== 1 || !moved.output.includes(`pull request #${PR} is at ${HEAD}, not --head ${stale}`)) problems.push(`a pull request that moved on: exit ${moved.status}\n${moved.output}`);
      if (writes(f.load()).length) problems.push(`the forge was written to: ${JSON.stringify(writes(f.state).map((w) => w.route))}`);
      return check(r, problems);
    },
    exit: 1, includes: ['FAIL prId is "999", not 482', `reviewedCommit is "${'f'.repeat(40)}", not --head ${HEAD}`, 'severity "CRITICAL" is not one of blocking, should-fix, nit', 'category "naming" is not one of bug, gap, unused-import, unused-var, convention, coverage, other', 'F1 is listed twice', 'a line without a file', 'id is not F<n>', 'endLine is not an integer at or after line', 'title is not one line of text', 'body cannot be posted: it already claims the watermark', 'preexistingNotes[0] cannot be posted: it holds a suggestion block', 'NOT POSTED', 'nothing was posted'],
  },
  {
    n: 6, name: 'no verifier output, or one that cannot be read — a finding with no verdict, a verdict outside the set — posts every finding marked not verified, says why, and drops nothing',
    run: (root) => {
      const a = forge(join(root, 'none'));
      const none = post(a, findings([finding('F1')]));
      const b = forge(join(root, 'bad'));
      const bad = post(b, findings([finding('F1'), finding('F2', { file: 'src/orders/total.ts', line: 57, endLine: 57 })]), verified([verdict('F1', 'refuted', 'Wrong.'), { id: 'F3', verdict: 'maybe', confidence: 'high', reason: 'x' }]));
      const problems = [];
      const posted = (f) => f.load().comments.map((c) => c.body);
      if (!posted(a).some((x) => x.includes('_Not verified: the verifier gave no verdict_'))) problems.push('without --verified, F1 is not marked not verified');
      if (!(a.state.reviews[0] || { body: '' }).body.includes('Verifier: not run — every comment is marked not verified')) problems.push('the body does not say the verifier did not run');
      if (!(b.load().reviews[0] || { body: '' }).body.includes('Verifier: not read — every comment is marked not verified')) problems.push('the body does not say the verifier output was not read');
      if (posted(b).length !== 2 || !posted(b).every((x) => x.includes('_Not verified: the verifier gave no verdict_'))) problems.push(`an unreadable verifier output: ${JSON.stringify(posted(b))}`);
      return check(both(none, bad), problems);
    },
    exit: 0, includes: ['VERIFIER NOT READ a verdict names F3, which findings.json does not hold', 'VERIFIER NOT READ F2 has no verdict', 'REVIEW POSTED'],
  },
  {
    n: 7, name: 'a suggestion block is refused in the run summary and in a reply, and so is a body that already claims the watermark — both problems named when a body has both; exit 1 and nothing is posted',
    run: (root) => {
      const f = forge(root);
      const t = addThread(f.state, { pull: PR, path: 'src/orders/parse.ts', line: 42, comments: [{ body: harnessBody(1, 'bug', 'blocking', BUG) }] });
      f.save();
      const suggestion = 'Use this:\n```suggestion\nif (!basket) return reject("no basket");\n```';
      const outs = [
        run(f, ['post', '--pr', String(PR), '--body-file', file(f, 's.md', `Summary.\n\n${suggestion}\n`)]),
        run(f, ['reply', '--pr', String(PR), '--comment', String(t.ids[0]), '--body-file', file(f, 'r.md', 'Done.\n\n~~~ suggestion\nx\n~~~\n')]),
        run(f, ['reply', '--pr', String(PR), '--comment', String(t.ids[0]), '--body-file', file(f, 'w.md', `Done.\n\n${suggestion}\n\n${W}\n`)]),
      ];
      const problems = outs.filter((o) => o.status !== 1).map((o) => `exit ${o.status}: ${o.output}`);
      if (outs.filter((o) => o.output.includes('holds a suggestion block')).length !== 3) problems.push('a suggestion block was not refused everywhere');
      if (!outs[2].output.includes('already claims the watermark')) problems.push('a body claiming the watermark was not refused alongside its suggestion block');
      if (writes(f.load()).length) problems.push(`the forge was written to: ${JSON.stringify(writes(f.state).map((w) => w.route))}`);
      return check(both(...outs), problems);
    },
    exit: 1, includes: ['the harness never posts one — the fix lands as a commit', 'NOT POSTED'],
  },
  {
    n: 8, name: 'resolve refuses a thread the harness did not post (exit 1) and asks GitHub nothing; it resolves a harness thread; reply answers in a thread, signed',
    run: (root) => {
      const f = forge(root);
      const person = addThread(f.state, { pull: PR, path: 'src/orders/parse.ts', line: 42, comments: [{ author: 'alice', body: 'Please rename `tmp`.' }] });
      const mine = addThread(f.state, { pull: PR, path: 'src/orders/total.ts', line: 57, comments: [{ body: harnessBody(1, 'gap', 'should-fix', GAP) }] });
      f.save();
      const refused = run(f, ['resolve', '--pr', String(PR), '--thread', person.id]);
      const reply = run(f, ['reply', '--pr', String(PR), '--comment', String(mine.ids[0]), '--body-file', file(f, 'r.md', '**[SHL-R1]** Fixed in `a1b2c3d`.\n')]);
      const resolved = run(f, ['resolve', '--pr', String(PR), '--thread', mine.id]);
      const st = f.load();
      const problems = [];
      if (refused.status !== 1 || !refused.output.includes(`REFUSED ${person.id} — not a harness thread`)) problems.push(`the other thread: exit ${refused.status}\n${refused.output}`);
      if (st.calls.filter((c) => c.route === 'GRAPHQL ResolveThread').length !== 1) problems.push('ResolveThread was not asked exactly once');
      const now = (id) => st.threads.find((t) => t.id === id).resolved;
      if (now(person.id) || !now(mine.id)) problems.push(`resolved: other ${now(person.id)}, harness ${now(mine.id)}`);
      const answer = st.comments.find((c) => c.in_reply_to_id === mine.ids[0]);
      if (!answer || answer.body !== `**[SHL-R1]** Fixed in \`a1b2c3d\`.\n\n${W}`) problems.push(`the reply reads: ${answer ? answer.body : 'nothing'}`);
      return check(both(reply, resolved), problems);
    },
    exit: 0, includes: [`POSTED https://${HOST}/acme/svc/pull/482#discussion_r`, 'RESOLVED PRRT_'],
  },
  {
    n: 9, name: 'label sets one of the three labels and removes the other two, creating a label the repository does not have yet; --set none removes all three and nothing else',
    run: (root) => {
      const f = forge(root, { labels: ['harness-reviewing', 'needs-design'] });
      f.state.labels['harness-reviewing'] = { name: 'harness-reviewing', color: 'fbca04', description: '' };
      f.save();
      const fixing = run(f, ['label', '--pr', String(PR), '--set', 'fixing']);
      const after1 = f.load().pulls[0].labels.map((l) => l.name).sort().join(',');
      const done = run(f, ['label', '--pr', String(PR), '--set', 'done']);
      const after2 = f.load().pulls[0].labels.map((l) => l.name).sort().join(',');
      const none = run(f, ['label', '--pr', String(PR), '--set', 'none']);
      const st = f.load();
      const after3 = st.pulls[0].labels.map((l) => l.name).sort().join(',');
      const problems = [];
      if (after1 !== 'harness-fixing,needs-design') problems.push(`after --set fixing: ${after1}`);
      if (after2 !== 'harness-done,needs-design') problems.push(`after --set done: ${after2}`);
      if (after3 !== 'needs-design') problems.push(`after --set none: ${after3}`);
      const created = st.calls.filter((c) => c.route === `POST repos/${OWNER}/${REPO}/labels`).map((c) => c.body.name);
      if (created.join(',') !== 'harness-fixing,harness-done') problems.push(`labels created: ${created.join(',')}`);
      return check(both(fixing, done, none), problems);
    },
    exit: 0, includes: ['LABEL harness-fixing', 'LABEL harness-done', 'LABEL none'],
  },
  {
    n: 10, name: 'threads lists only the harness\'s own unresolved threads, in the order to fix — blocking, should-fix, nit, each by id; a resolved thread and a thread the harness did not post are not listed; paged by gh with --paginate --slurp',
    run: (root) => {
      const f = forge(root, { pageSize: 2 });
      const t = (n, sev, o = {}) => addThread(f.state, { pull: PR, path: 'src/a.ts', line: n, comments: [{ body: harnessBody(n, 'bug', sev, `Finding ${n}.`) }], ...o });
      t(1, 'nit'); t(2, 'blocking'); t(3, 'should-fix'); t(4, 'blocking', { resolved: true }); t(5, 'should-fix', { outdated: true });
      addThread(f.state, { pull: PR, path: 'src/b.ts', line: 1, comments: [{ author: 'alice', body: 'Why 3 retries?' }] });
      f.save();
      const all = run(f, ['threads', '--pr', String(PR)]);
      const st = f.load();
      const problems = [];
      const read = (r) => { try { return JSON.parse(r.stdout); } catch { problems.push(`threads did not print JSON: ${r.output}`); return { threads: [] }; } };
      const a = read(all);
      const order = (j) => j.threads.map((x) => x.ref).join(',');
      if (order(a) !== 'SHL-R2,SHL-R3,SHL-R5,SHL-R1') problems.push(`order: ${order(a)}`);
      const r2 = a.threads.find((x) => x.ref === 'SHL-R2') || {};
      if (r2.text !== 'Finding 2.' || r2.severity !== 'blocking' || r2.category !== 'bug' || r2.path !== 'src/a.ts' || r2.line !== 2 || typeof r2.comment !== 'number') problems.push(`SHL-R2 reads: ${JSON.stringify(r2)}`);
      if ((a.threads.find((x) => x.ref === 'SHL-R5') || {}).line !== 5) problems.push('the outdated thread does not keep its original line');
      if (!st.calls.filter((c) => c.route === 'GRAPHQL ReviewThreads').every((c) => c.args.includes('--paginate') && c.args.includes('--slurp'))) problems.push('the review threads were not asked with --paginate --slurp');
      if (writes(st).length) problems.push('threads wrote to the forge');
      return check({ status: all.status, output: all.stderr }, problems);
    },
    exit: 0,
  },
  {
    n: 11, name: 'gh\'s failures, as exit codes: a 404 or a 422 from the API is a verified refusal (1) with gh\'s message, so is a GraphQL NOT_FOUND; any other failure is cannot-verify (2); an answer that is not JSON is internal (4)',
    run: (root) => {
      const f = forge(root);
      const problems = [];
      const expect = (label, r, exit, text) => { if (r.status !== exit || !r.output.includes(text)) problems.push(`${label}: exit ${r.status}, wanted ${exit} with "${text}"\n${r.output}`); };
      const script = (entry) => { f.load(); f.state.script.push(entry); f.save(); };
      expect('404', run(f, ['reply', '--pr', String(PR), '--comment', '999', '--body-file', file(f, 'r.md', 'Hello.\n')]), 1, 'gh: Not Found (HTTP 404)');
      script({ match: `POST repos/${OWNER}/${REPO}/pulls/${PR}/reviews`, status: 422, body: { message: 'Unprocessable Entity', errors: ['commit_id is not part of the pull request'] } });
      expect('422', post(f, findings([finding('F1')]), verified([verdict('F1')])), 1, 'gh: Unprocessable Entity (HTTP 422): commit_id is not part of the pull request');
      expect('GraphQL NOT_FOUND', run(f, ['threads', '--pr', '999']), 1, 'Could not resolve to a PullRequest with the number of 999');
      script({ match: `GET repos/${OWNER}/${REPO}/pulls`, status: 502, body: { message: 'Bad Gateway' } });
      expect('502', run(f, ['show', '--branch', BRANCH]), 2, `CANNOT VERIFY: GET repos/${OWNER}/${REPO}/pulls: gh: Bad Gateway (HTTP 502)`);
      script({ match: `GET repos/${OWNER}/${REPO}/pulls`, raw: '<html>maintenance</html>' });
      expect('not JSON', run(f, ['show', '--branch', BRANCH]), 4, 'with a body that is not JSON');
      if (f.load().reviews.length) problems.push('a review was posted after a 422');
      return { status: problems.length ? 1 : 0, output: problems.join('\n') || 'every failure mapped' };
    },
    exit: 0, includes: ['every failure mapped'],
  },
  {
    n: 12, name: 'pull-request.mjs copies the watermark and its claim check from check-watermark.mjs, because it cannot import it in both layouts: the two agree on the watermark line and on whether each sample text claims it; signed() accepts a body this script signed and nothing else, and every text check-watermark.mjs accepts as signed',
    run: () => {
      const problems = [];
      if (pullRequest.WATERMARK !== checkWatermark.WATERMARK) problems.push(`the watermark lines differ: ${JSON.stringify(pullRequest.WATERMARK)} and ${JSON.stringify(checkWatermark.WATERMARK)}`);
      const samples = [
        W, `Fixed.\n\n${W}`, 'generated-by: shl agentic harness', 'GENERATED BY SHL AGENTIC HARNESS', 'Generated by SHL Agentic Harness',
        'Generated_by:SHL_Agentic_Harness', 'Generated-by:   SHL   Agentic   Harness', 'Generated\nby SHL Agentic\tHarness', 'generatedbyshlagenticharness',
        'Generated-by: SHL Agentic Harnesses', `**${W}**`, `a line, then ${W} in the middle`, 'Generated-by: SHL Agentic', 'Generated–by: SHL Agentic Harness',
        'Generated by the SHL harness', 'SHL Agentic Harness', 'Fixed in `a1b2c3d`.', '',
      ];
      for (const text of samples) {
        const mine = String(text).search(pullRequest.CLAIM) !== -1;
        const theirs = checkWatermark.claims(text);
        if (mine !== theirs) problems.push(`${JSON.stringify(text)}: pull-request.mjs says ${mine}, check-watermark.mjs says ${theirs}`);
      }
      const signedCases = [[`Fixed.\n\n${W}`, true], [W, true], [`Fixed.\n\n${W}\n\n`, true], [`${W}\n\n${W}`, false], [`Fixed.\n\n> ${W}`, false], [`${W}\n\nmore`, false], ['Fixed.', false], ['Fixed.\n\nGenerated by SHL Agentic Harness', false]];
      for (const [text, want] of signedCases) if (pullRequest.signed(text) !== want) problems.push(`signed(${JSON.stringify(text)}) is ${!want}`);
      for (const text of samples) if (checkWatermark.watermarkProblem(text) === null && !pullRequest.signed(text)) problems.push(`check-watermark.mjs accepts ${JSON.stringify(text)} as signed, pull-request.mjs does not`);
      return { status: problems.length ? 1 : 0, output: problems.join('\n') || `the watermark and ${samples.length} sample texts agree` };
    },
    exit: 0, includes: ['the watermark and 18 sample texts agree'],
  },
  {
    n: 13, name: 'label --needs-person yes adds the fourth label beside the run\'s state, creating it, and --set never touches it; --needs-person no removes only that label',
    run: (root) => {
      const f = forge(root, { labels: ['harness-reviewing', 'needs-design'] });
      f.state.labels['harness-reviewing'] = { name: 'harness-reviewing', color: 'fbca04', description: '' };
      f.save();
      const names = () => f.load().pulls[0].labels.map((l) => l.name).sort().join(',');
      const yes = run(f, ['label', '--pr', String(PR), '--needs-person', 'yes']);
      const afterYes = names();
      const again = run(f, ['label', '--pr', String(PR), '--needs-person', 'yes']);
      const done = run(f, ['label', '--pr', String(PR), '--set', 'done']);
      const afterDone = names();
      const setNone = run(f, ['label', '--pr', String(PR), '--set', 'none', '--needs-person', 'yes']);
      const afterNone = names();
      const no = run(f, ['label', '--pr', String(PR), '--needs-person', 'no']);
      const afterNo = names();
      const off = run(f, ['label', '--pr', String(PR), '--needs-person', 'no']);
      const st = f.load();
      const created = st.calls.filter((c) => c.route === `POST repos/${OWNER}/${REPO}/labels`).map((c) => c.body.name);
      const made = st.calls.find((c) => c.route === `POST repos/${OWNER}/${REPO}/labels` && c.body.name === 'harness-needs-person');
      const problems = [];
      if (afterYes !== 'harness-needs-person,harness-reviewing,needs-design') problems.push(`after --needs-person yes: ${afterYes}`);
      if (afterDone !== 'harness-done,harness-needs-person,needs-design') problems.push(`after --set done: ${afterDone}`);
      if (afterNone !== 'harness-needs-person,needs-design') problems.push(`after --set none --needs-person yes: ${afterNone}`);
      if (afterNo !== 'needs-design') problems.push(`after --needs-person no: ${afterNo}`);
      if (created.filter((n) => n === 'harness-needs-person').length !== 1) problems.push(`the fourth label was created ${created.filter((n) => n === 'harness-needs-person').length} times`);
      if (!made || !made.body.color || !made.body.description) problems.push('the fourth label was created without a colour and a description');
      return check(both(yes, again, done, setNone, no, off), problems);
    },
    exit: 0, includes: ['LABEL harness-needs-person', 'LABEL harness-needs-person removed', 'LABEL harness-done', 'LABEL none'],
  },
  {
    n: 14, name: 'label with neither --set nor --needs-person, or with a value that is not yes or no, is a usage fault, and nothing is called',
    run: (root) => {
      const f = forge(root, {});
      const none = run(f, ['label', '--pr', String(PR)]);
      const bad = run(f, ['label', '--pr', String(PR), '--needs-person', 'maybe']);
      const worse = run(f, ['label', '--pr', String(PR), '--set', 'needs-person']);
      const calls = f.load().calls.filter((c) => c.route.includes('/labels')).length;
      const problems = [];
      if (none.status !== 3 || bad.status !== 3 || worse.status !== 3) problems.push(`exits ${none.status}, ${bad.status}, ${worse.status}, expected 3, 3, 3`);
      if (calls !== 0) problems.push(`${calls} label calls were made`);
      return { status: none.status === 3 && bad.status === 3 && worse.status === 3 ? 3 : 1, output: `${none.output}\n${bad.output}\n${worse.output}\n${problems.join('\n')}`.trim() };
    },
    exit: 3, includes: ['label needs --set <state>, --needs-person yes|no, or both', '"maybe" is not yes or no', 'is not reviewing, fixing, done or none'],
  },
  {
    n: 15, name: 'await waits for Prime\'s review of --head and stops on it: a review by Prime of an older head, a person\'s review and a review by a person\'s account named like the bot do not count; it reads, never writes; a trailing [bot] in --bot is dropped',
    run: (root) => {
      const f = forge(root);
      primeReview(f, OLD, [{ path: 'src/orders/parse.ts', line: 42, body: LOG }]);
      addReview(f.state, { pull: PR, author: 'alice', commit: HEAD, body: 'Looks fine.' });
      addReview(f.state, { pull: PR, author: PRIME, bot: false, commit: HEAD, body: 'Not the bot.' });
      f.state.timeline.push({ after: 3, review: { author: PRIME, bot: true, commit: HEAD, comments: [{ path: 'src/orders/parse.ts', line: 42, body: LOG }] } });
      f.save();
      const r = run(f, ['await', '--pr', String(PR), '--bot', `${PRIME}[bot]`, '--head', HEAD, '--minutes', '120'], { HARNESS_AWAIT_SECOND_MS: '2' });
      const s = f.load();
      const problems = [];
      const landed = s.reviews.find((x) => x.user.type === 'Bot' && x.commit_id === HEAD);
      if (!landed || !r.stdout.includes(`prime=reviewed review=${landed.id} head=${HEAD}\n`)) problems.push('the last line does not name the review that landed');
      if (reviewReads(s) !== 3) problems.push(`the reviews were read ${reviewReads(s)} times, not 3`);
      if (writes(s).length) problems.push('await wrote to the forge');
      return check(r, problems);
    },
    exit: 0, includes: [`WAIT ${PRIME} on #${PR} at ${HEAD.slice(0, 12)} · up to 120 min · every 30 s`, `PRIME REVIEWED ${HEAD.slice(0, 12)}`],
  },
  {
    n: 16, name: 'await always ends: with no review of --head by the deadline it says so, prime=none, exit 0 — seen=yes when Prime posted on the pull request before (its scan summary), seen=no when it posted nothing; it never runs past the deadline by more than one look',
    run: (root) => {
      const a = forge(join(root, 'seen'));
      addIssueComment(a.state, { pull: PR, author: PRIME, bot: true, body: '## PrimeSec SCA Scan Summary\n\nNo dependency files changed in this pull request, so the SCA scan was skipped.' });
      a.save();
      const started = Date.now();
      const seen = wait(a, ['--head', HEAD, '--minutes', '1', '--interval', '20'], 100);
      const took = Date.now() - started;
      const b = forge(join(root, 'unseen'));
      addIssueComment(b.state, { pull: PR, author: PRIME, bot: false, body: 'A person named like the bot.' });
      b.save();
      const unseen = wait(b, ['--head', HEAD, '--minutes', '1', '--interval', '30'], 10);
      const problems = [];
      if (!seen.stdout.endsWith(`prime=none head=${HEAD} seen=yes\n`)) problems.push(`with the scan summary: ${seen.output}`);
      if (unseen.status !== 0 || !unseen.stdout.endsWith(`prime=none head=${HEAD} seen=no\n`)) problems.push(`with nothing from Prime: exit ${unseen.status}\n${unseen.output}`);
      const reads = reviewReads(a.load());
      if (reads < 2 || reads > 5) problems.push(`a 6 s wait looked ${reads} times every 2 s`);
      if (took > 30000) problems.push(`a 6 s wait took ${took} ms`);
      if (writes(a.state).length || writes(b.load()).length) problems.push('await wrote to the forge');
      return check(both(seen, unseen), problems);
    },
    exit: 0, includes: [`NO PRIME REVIEW of ${HEAD.slice(0, 12)} within 1 min · ${PRIME} has posted on this pull request before`, `${PRIME} has posted nothing on this pull request`],
  },
  {
    n: 17, name: 'await waits 15 minutes, every 30 seconds, by default; it stops (exit 1) when the head moves during the wait, when --head is already not the head, and when the pull request is merged or closed — it never waits for a review of code that is no longer there',
    run: (root) => {
      const problems = [];
      const moved = forge(join(root, 'moved'));
      moved.state.timeline.push({ after: 2, head: OLD });
      moved.save();
      const m = wait(moved, ['--head', HEAD, '--minutes', '120'], 2);
      if (m.status !== 1 || !m.output.includes(`STOPPED the head moved: #${PR} is at ${OLD}, not ${HEAD}`)) problems.push(`a head that moved: exit ${m.status}\n${m.output}`);
      const stale = wait(forge(join(root, 'stale')), ['--head', OLD], 2);
      if (stale.status !== 1 || !stale.output.includes(`is at ${HEAD}, not ${OLD}`)) problems.push(`a stale --head: exit ${stale.status}\n${stale.output}`);
      if (!stale.output.includes('· up to 15 min · every 30 s')) problems.push(`the default wait is not 15 minutes every 30 seconds: ${stale.output}`);
      const merged = forge(join(root, 'merged'));
      merged.state.timeline.push({ after: 1, state: 'merged' });
      merged.save();
      const g = wait(merged, ['--head', HEAD, '--minutes', '120'], 2);
      if (g.status !== 1 || !g.output.includes(`STOPPED pull request #${PR} is merged`)) problems.push(`a merged pull request: exit ${g.status}\n${g.output}`);
      return { status: problems.length ? 1 : 0, output: problems.join('\n') || 'every stop seen' };
    },
    exit: 0, includes: ['every stop seen'],
  },
  {
    n: 18, name: 'await retries a read that fails (a 502) and goes on waiting; a read still failing at the deadline is exit 2, never a guess; a host gh is not logged in to stops it at once (exit 2); a 404 for the pull request is exit 1',
    run: (root) => {
      const problems = [];
      const flaky = forge(join(root, 'flaky'));
      flaky.state.script.push({ match: `GET repos/${OWNER}/${REPO}/pulls/${PR}`, status: 502, body: { message: 'Bad Gateway' } }, { match: `GET repos/${OWNER}/${REPO}/pulls/${PR}/reviews`, status: 502, body: { message: 'Bad Gateway' } });
      primeReview(flaky, HEAD, [{ path: 'src/orders/parse.ts', line: 42, body: LOG }]);
      flaky.save();
      const r = wait(flaky, ['--head', HEAD, '--minutes', '120'], 2);
      if (r.status !== 0 || (r.stdout.match(/^RETRY /gm) || []).length !== 2 || !r.stdout.includes('prime=reviewed')) problems.push(`two failed reads, then the review: exit ${r.status}\n${r.output}`);
      const down = forge(join(root, 'down'));
      down.state.script.push({ match: `GET repos/${OWNER}/${REPO}/pulls/${PR}`, status: 502, body: { message: 'Bad Gateway' }, sticky: true });
      down.save();
      const d = wait(down, ['--head', HEAD, '--minutes', '1', '--interval', '20'], 10);
      if (d.status !== 2 || !d.output.includes('CANNOT VERIFY: GitHub could not be read at the end of the wait')) problems.push(`GitHub down for the whole wait: exit ${d.status}\n${d.output}`);
      const out = wait(forge(join(root, 'out'), { loggedIn: [] }), ['--head', HEAD], 2);
      if (out.status !== 2 || !out.output.includes('gh is not logged in')) problems.push(`not logged in: exit ${out.status}\n${out.output}`);
      const gone = run(forge(join(root, 'gone')), ['await', '--pr', '999', '--bot', PRIME, '--head', HEAD], { HARNESS_AWAIT_SECOND_MS: '2' });
      if (gone.status !== 1 || !gone.output.includes('Not Found (HTTP 404)')) problems.push(`no such pull request: exit ${gone.status}\n${gone.output}`);
      return { status: problems.length ? 1 : 0, output: problems.join('\n') || 'every failure handled' };
    },
    exit: 0, includes: ['every failure handled'],
  },
  {
    n: 19, name: 'threads --source prime lists each Prime finding once: the newest thread of each finding is the work, in file and line order; an older thread on a finding that Prime repeats is a duplicate of that work; an older thread on a finding that Prime\'s review at --head leaves out stays work, and nothing is gone; a thread a person replied in, a harness thread and a person\'s account named like the bot are not work; each item reads policy, standard, sentence and suggested fix out of Prime\'s markup, ref PRIME-C<comment id>, and says when the finding was resolved before; --out writes the verifier\'s findings.json, once',
    run: (root) => {
      const e = primeEstate(root);
      const r = run(e.f, ['threads', '--pr', String(PR), '--source', 'prime', '--bot', PRIME, '--head', HEAD, '--out', join(root, 'r1')]);
      const again = run(e.f, ['threads', '--pr', String(PR), '--source', 'prime', '--bot', PRIME, '--head', HEAD, '--out', join(root, 'r1')]);
      const problems = [];
      const j = json(r, problems);
      const [log, flow] = e.head;
      if (j.threads.map((t) => t.ref).join(',') !== `${cref(log)},${cref(flow)},${cref(e.oldAtomic)}`) problems.push(`work: ${j.threads.map((t) => t.ref).join(',')}`);
      const w = j.threads[0] || {};
      const want = { id: log.id, source: 'prime', severity: 'should-fix', category: 'other', title: 'Security Event Logging with Metadata', policy: 'Security Event Logging with Metadata', standard: 'COMPANY POLICY', path: 'src/orders/parse.ts', line: 42, text: 'Add the call ID to this rejected-report event.', fix: 'Log the call ID and the trace ID.', commit: HEAD, reportedBefore: true };
      for (const [k, v] of Object.entries(want)) if (w[k] !== v) problems.push(`the logging item's ${k} is ${JSON.stringify(w[k])}, not ${JSON.stringify(v)}`);
      if (JSON.stringify(w.duplicates) !== JSON.stringify([e.oldLog.id])) problems.push(`the logging item's duplicates: ${JSON.stringify(w.duplicates)}`);
      if ((j.threads[1] || {}).reportedBefore !== false) problems.push('the flow item says it was resolved before');
      if (JSON.stringify(j.duplicates) !== JSON.stringify([{ thread: e.oldLog.id, ref: cref(e.oldLog), of: cref(log) }])) problems.push(`duplicates: ${JSON.stringify(j.duplicates)}`);
      if ('gone' in j) problems.push(`the summary still lists gone threads: ${JSON.stringify(j.gone)}`);
      if (JSON.stringify(j.withPerson) !== JSON.stringify([{ thread: e.oldFlow.id, ref: cref(e.oldFlow) }])) problems.push(`with a person: ${JSON.stringify(j.withPerson)}`);
      if (JSON.stringify(j.reviewAtHead) !== JSON.stringify([e.f.state.reviews[e.f.state.reviews.length - 1].id])) problems.push(`reviewAtHead: ${JSON.stringify(j.reviewAtHead)}`);
      const handIn = JSON.parse(readFileSync(join(root, 'r1', 'findings.json'), 'utf8'));
      const ok = pullRequest.readFindings(handIn, { pr: PR, head: HEAD });
      if (ok.findings.length) problems.push(`the verifier's findings.json is not in the reviewer's shape: ${ok.findings.join('; ')}`);
      if (handIn.findings.map((x) => `${x.id}=${x.ref}@${x.file}:${x.line}`).join(',') !== `F1=${cref(log)}@src/orders/parse.ts:42,F2=${cref(flow)}@src/orders/parse.ts:44,F3=${cref(e.oldAtomic)}@src/orders/total.ts:57`) problems.push(`findings.json holds ${JSON.stringify(handIn.findings)}`);
      if (handIn.findings[0].body !== 'Add the call ID to this rejected-report event. Suggested fix: Log the call ID and the trace ID. (per Security Event Logging with Metadata, COMPANY POLICY)') problems.push(`F1's body: ${handIn.findings[0].body}`);
      if (again.status !== 1 || !again.output.includes('already exists: give each round its own --out directory')) problems.push(`a second --out to the same directory: exit ${again.status}\n${again.output}`);
      const plainText = pullRequest.scannerFinding('Just one sentence, no markup.');
      if (plainText.policy !== null || plainText.text !== 'Just one sentence, no markup.') problems.push(`a comment without Prime's markup: ${JSON.stringify(plainText)}`);
      if (writes(e.f.load()).length) problems.push('threads wrote to the forge');
      return check({ status: r.status, output: r.stderr }, problems);
    },
    exit: 0,
  },
  {
    n: 20, name: 'threads --source prime --verified gives each work item the pr-verifier\'s verdict, confidence and reason by its ref; a refutation that does not open with the line that meets the rule, the line that shows that the rule does not apply, a misread or "Not in this change" is uncertain, so it is fixed; an unreadable verified-findings.json makes every item uncertain and says why; an item posted after the verifier ran has no verdict yet; a findings.json written at another head is refused',
    run: (root) => {
      const e = primeEstate(root);
      const dir = join(root, 'r1');
      run(e.f, ['threads', '--pr', String(PR), '--source', 'prime', '--bot', PRIME, '--head', HEAD, '--out', dir]);
      const args = ['threads', '--pr', String(PR), '--source', 'prime', '--bot', PRIME, '--head', HEAD, '--verified', dir];
      const missing = run(e.f, args);
      writeFileSync(join(dir, 'verified-findings.json'), JSON.stringify(verified([verdict('F1', 'refuted', 'Meets the rule at src/orders/parse.ts:42, which logs the call ID.'), verdict('F2'), verdict('F3')])));
      e.f.load();
      primeReview(e.f, HEAD, [{ path: 'src/orders/total.ts', line: 56, body: ATOMIC }]);
      e.f.save();
      const r = run(e.f, args);
      const problems = [];
      const m = json(missing, problems);
      if (!m.threads.every((t) => t.verdict === 'uncertain' && t.reason === 'the verifier\'s file could not be read') || !missing.stderr.includes('VERIFIER NOT READ verified-findings.json')) problems.push(`no verifier file: ${missing.output}`);
      const j = json(r, problems);
      const by = Object.fromEntries(j.threads.map((t) => [t.path + ':' + t.line, `${t.verdict}/${t.confidence}`]));
      if (by['src/orders/parse.ts:42'] !== 'refuted/high' || by['src/orders/parse.ts:44'] !== 'real/high' || by['src/orders/total.ts:56'] !== 'null/null') problems.push(`verdicts: ${JSON.stringify(by)}`);
      writeFileSync(join(dir, 'verified-findings.json'), JSON.stringify(verified([verdict('F1', 'refuted', 'Conflict with the design: REQ-2 lets any caller do this.'), verdict('F2', 'refuted', 'Not in this change: the hunk only moves the call.'), verdict('F3')])));
      if ('Does not apply at src/orders/total.ts:57: one writer holds the lock.'.search(pullRequest.PRIME_REFUTED) !== 0 || 'Does not apply: the requirement allows it.'.search(pullRequest.PRIME_REFUTED) === 0) problems.push('the "Does not apply" refutation needs its line');
      const loose = json(run(e.f, args), problems);
      const lb = Object.fromEntries(loose.threads.map((t) => [t.path + ':' + t.line, t]));
      const f1 = lb['src/orders/parse.ts:42'];
      if (!f1 || f1.verdict !== 'uncertain' || !f1.reason.startsWith('refuted without the line that meets the rule, so it is fixed: Conflict with the design')) problems.push(`a refutation that cites the design: ${JSON.stringify(f1)}`);
      if (!lb['src/orders/parse.ts:44'] || lb['src/orders/parse.ts:44'].verdict !== 'refuted') problems.push('a "Not in this change" refutation did not hold');
      writeFileSync(join(dir, 'findings.json'), JSON.stringify({ ...JSON.parse(readFileSync(join(dir, 'findings.json'), 'utf8')), reviewedCommit: OLD }));
      const stale = run(e.f, args);
      if (stale.status !== 1 || !stale.output.includes(`was written at ${OLD}, not --head ${HEAD}`)) problems.push(`a stale findings.json: exit ${stale.status}\n${stale.output}`);
      return check({ status: r.status, output: r.stderr }, problems);
    },
    exit: 0,
  },
  {
    n: 21, name: 'settle resolves every duplicate Prime thread with a signed reply that names the thread it repeats, and nothing else — not the work, not an older thread that Prime\'s review at --head leaves out, not a thread a person replied in, not a harness thread; run again it changes nothing; it refuses a --head that is not the head',
    run: (root) => {
      const e = primeEstate(root);
      const args = ['settle', '--pr', String(PR), '--bot', PRIME, '--head', HEAD];
      const stale = run(e.f, ['settle', '--pr', String(PR), '--bot', PRIME, '--head', OLD]);
      const first = run(e.f, args);
      const second = run(e.f, args);
      const s = e.f.load();
      const problems = [];
      if (stale.status !== 1 || !stale.output.includes(`is at ${HEAD}, not --head ${OLD}; nothing was resolved`)) problems.push(`a stale --head: exit ${stale.status}\n${stale.output}`);
      const resolved = s.threads.filter((t) => t.resolved).map((t) => t.id).sort();
      const earlier = s.threads.find((t) => t.resolved && t.id !== e.oldLog.id);
      if (JSON.stringify(resolved) !== JSON.stringify([e.oldLog.id, earlier && earlier.id].sort())) problems.push(`resolved: ${JSON.stringify(resolved)}`);
      const reply = (t) => (s.comments.find((c) => c.in_reply_to_id === t.ids[0] && c.user.login !== 'alice') || {}).body;
      if (reply(e.oldLog) !== `**[${cref(e.oldLog)}]** Duplicate of ${cref(e.head[0])}. Prime Security posted this finding again on a later review, and the harness tracks it in that thread.\n\n${W}`) problems.push(`the duplicate's reply: ${reply(e.oldLog)}`);
      if (reply(e.oldAtomic) || reply(e.oldFlow) || reply(e.head[0]) || reply(e.head[1]) || reply(e.mine) || reply(e.impostor)) problems.push('settle replied in a thread it must leave alone');
      if (!second.stdout.includes('SETTLED 0 duplicate(s) · 3 to work · 0 answered · 1 with a person')) problems.push(`the second run: ${second.output}`);
      return check(first, problems);
    },
    exit: 0, includes: ['DUPLICATE PRIME-C', 'LEFT PRIME-C', 'SETTLED 1 duplicate(s) · 3 to work · 0 answered · 1 with a person'], excludes: ['GONE ', 'no longer reports'],
  },
  {
    n: 22, name: 'with no Prime review at --head, settle posts no reply in an open thread, and --waited is refused; the newest thread of each finding is the work and older ones duplicates; a finding the harness answered "Not changed" keeps its thread, and Prime\'s repeat of it at --head becomes its duplicate',
    run: (root) => {
      const problems = [];
      const a = primeEstate(join(root, 'no-review'), { headReview: false });
      const waited = run(a.f, ['settle', '--pr', String(PR), '--bot', PRIME, '--head', HEAD, '--waited', '15']);
      if (waited.status !== 3 || !waited.output.includes('USAGE:')) problems.push(`settle --waited is not refused: exit ${waited.status}\n${waited.output}`);
      const settled = run(a.f, ['settle', '--pr', String(PR), '--bot', PRIME, '--head', HEAD]);
      const sa = a.f.load();
      const replyA = sa.comments.find((c) => c.in_reply_to_id === a.oldLog.ids[0]);
      if (replyA) problems.push(`a thread with no review of --head got a reply: ${replyA.body}`);
      if (settled.stdout.search(/gone/i) >= 0) problems.push(`settle with no review of --head: ${settled.output}`);
      const b = primeEstate(join(root, 'nowait'), { headReview: false });
      primeReview(b.f, OLD, [{ path: 'src/orders/total.ts', line: 57, body: ATOMIC }]);
      b.f.save();
      const j = json(run(b.f, ['threads', '--pr', String(PR), '--source', 'prime', '--bot', PRIME, '--head', HEAD]), problems);
      const newest = b.f.load().threads[b.f.state.threads.length - 1];
      if (j.threads.map((t) => t.ref).join(',') !== `${cref(b.oldLog)},${cref(newest)}` || JSON.stringify(j.duplicates.map((d) => d.ref)) !== JSON.stringify([cref(b.oldAtomic)])) problems.push(`without --waited: work ${j.threads.map((t) => t.ref)}, duplicates ${JSON.stringify(j.duplicates)}`);
      const c = primeEstate(join(root, 'answered'));
      const replyBody = `**[${cref(c.oldLog)}]** Not changed: the harness's verifier refuted this finding. parse.ts:42 logs it.\n\n${W}`;
      c.f.state.comments.push({ ...c.f.state.comments.find((x) => x.id === c.oldLog.ids[0]), id: 9000002, node_id: 'PRRC_9000002', body: replyBody, user: { login: 'shl-harness-bot', type: 'User' }, review: null, commit: null, in_reply_to_id: c.oldLog.ids[0] });
      c.f.state.threads.find((t) => t.id === c.oldLog.id).ids.push(9000002);
      c.f.save();
      const k = json(run(c.f, ['threads', '--pr', String(PR), '--source', 'prime', '--bot', PRIME, '--head', HEAD]), problems);
      if (k.threads.map((t) => t.ref).join(',') !== `${cref(c.head[1])},${cref(c.oldAtomic)}`) problems.push(`answered: work ${k.threads.map((t) => t.ref)}`);
      if (JSON.stringify(k.answered) !== JSON.stringify([{ thread: c.oldLog.id, ref: cref(c.oldLog) }]) || !k.duplicates.some((d) => d.ref === cref(c.head[0]) && d.of === cref(c.oldLog))) problems.push(`answered: ${JSON.stringify(k.answered)} duplicates ${JSON.stringify(k.duplicates)}`);
      return { status: problems.length ? 1 : 0, output: problems.join('\n') || 'every case sorted' };
    },
    exit: 0, includes: ['every case sorted'],
  },
  {
    n: 23, name: 'resolve --bot resolves a thread Prime started, and only after the harness answered in it with a closing form; an unanswered Prime thread and one answered "refuted" are refused, and a refutation that carries the second reader\'s line closes; without --bot that thread is refused; a person\'s thread and a person\'s account named like the bot are refused even with --bot; a harness thread still resolves with --bot',
    run: (root) => {
      const e = primeEstate(root);
      const person = addThread(e.f.state, { pull: PR, path: 'src/orders/parse.ts', line: 41, comments: [{ author: 'alice', body: 'Please rename `tmp`.' }] });
      e.f.save();
      const res = (t, bot) => run(e.f, ['resolve', '--pr', String(PR), '--thread', t.id, ...(bot ? ['--bot', PRIME] : [])]);
      const answer = (t, name, text) => run(e.f, ['reply', '--pr', String(PR), '--comment', String(t.ids[0]), '--body-file', file(e.f, name, `**[${cref(t)}]** ${text}\n`)]);
      const unanswered = res(e.head[0], true);
      const refuted = answer(e.head[0], 'refuted.md', 'Not changed. Meets the rule at src/orders/parse.ts:42, which logs the call ID.');
      const stillOpen = res(e.head[0], true);
      const open = e.f.load().threads.find((x) => x.id === e.head[0].id).resolved;
      const confirmed = answer(e.head[1], 'confirmed.md', 'Not changed. Does not apply at src/orders/parse.ts:44: every module runs in one process.\n\n**Second reader:** the security reviewer read the evidence and agreed.');
      const closed = res(e.head[1], true);
      const before = answer(e.head[0], 'before.md', 'Fixed before. Meets the rule at src/orders/parse.ts:42, which logs the call ID.');
      const outs = { bare: res(e.head[0], false), prime: res(e.head[0], true), person: res(person, true), impostor: res(e.impostor, true), mine: res(e.mine, true) };
      const s = e.f.load();
      const problems = [];
      const isResolved = (t) => s.threads.find((x) => x.id === t.id).resolved;
      if (unanswered.status !== 1 || !unanswered.output.includes('a Prime finding closes only when it is addressed')) problems.push(`an unanswered Prime thread: exit ${unanswered.status}\n${unanswered.output}`);
      if (refuted.status !== 0 || stillOpen.status !== 1 || open) problems.push(`a Prime thread answered "refuted": reply ${refuted.status}, resolve ${stillOpen.status}, resolved ${open}`);
      if (before.status !== 0) problems.push(`the "Fixed before" reply: ${before.output}`);
      if (confirmed.status !== 0 || closed.status !== 0 || !isResolved(e.head[1])) problems.push(`a refutation with the second reader's line: reply ${confirmed.status}, resolve ${closed.status}\n${closed.output}`);
      if (outs.bare.status !== 1 || !outs.bare.output.includes('not a harness thread')) problems.push(`a Prime thread without --bot: ${outs.bare.output}`);
      if (outs.prime.status !== 0 || !isResolved(e.head[0])) problems.push(`a Prime thread with --bot: ${outs.prime.output}`);
      if (outs.person.status !== 1 || isResolved(person)) problems.push(`a person's thread: ${outs.person.output}`);
      if (outs.impostor.status !== 1 || isResolved(e.impostor)) problems.push(`a person named like the bot: ${outs.impostor.output}`);
      if (outs.mine.status !== 0 || !isResolved(e.mine)) problems.push(`a harness thread with --bot: ${outs.mine.output}`);
      return { status: problems.length ? 1 : 0, output: problems.join('\n') || 'only the bot\'s and the harness\'s threads resolved' };
    },
    exit: 0, includes: ['only the bot\'s and the harness\'s threads resolved'],
  },
  {
    n: 24, name: 'the scanner options are checked before anything is asked (exit 3): a Prime option without --source prime, --source prime without --bot or --head, a --bot that is no App login, --out with --verified, --minutes 0 or 121, --interval 301, --waited, which is gone, a short --head',
    run: (root) => {
      const f = forge(root);
      const pr = ['--pr', String(PR)];
      const cases = [
        ['threads', ...pr, '--bot', PRIME], ['threads', ...pr, '--source', 'prime', '--head', HEAD], ['threads', ...pr, '--source', 'prime', '--bot', PRIME],
        ['threads', ...pr, '--source', 'sonar', '--bot', PRIME, '--head', HEAD], ['threads', ...pr, '--source', 'prime', '--bot', 'not a bot', '--head', HEAD],
        ['threads', ...pr, '--source', 'prime', '--bot', PRIME, '--head', HEAD, '--out', 'a', '--verified', 'b'],
        ['await', ...pr, '--bot', PRIME, '--head', HEAD, '--minutes', '0'], ['await', ...pr, '--bot', PRIME, '--head', HEAD, '--minutes', '121'],
        ['await', ...pr, '--bot', PRIME, '--head', HEAD, '--interval', '301'], ['await', ...pr, '--bot', PRIME, '--head', 'abc123'],
        ['settle', ...pr, '--bot', PRIME, '--head', HEAD, '--waited', '0'], ['settle', ...pr, '--head', HEAD],
      ];
      const problems = [];
      for (const c of cases) { const r = run(f, c); if (r.status !== 3 || !r.output.includes('USAGE:')) problems.push(`${c.join(' ')}: exit ${r.status}\n${r.output}`); }
      if (f.load().calls.length) problems.push('gh was asked something');
      return { status: problems.length ? 1 : 0, output: problems.join('\n') || `${cases.length} usages refused` };
    },
    exit: 0, includes: ['12 usages refused'],
  },
  {
    n: 25, name: 'a reply that opens with a Prime ref takes one of the allowed forms: fixed, test added, fixed before, covered by a recorded answer, refuted with or without a second reader, a conflict with the design, needs a person, could not fix — each is posted and signed; a refusal with a free reason, a "Covered by" that names no role and a conflict without its line are not posted (exit 1), and nothing is written; a reply in a harness thread is not held to these forms',
    run: (root) => {
      const e = primeEstate(root);
      const t = e.head[0];
      const ref = cref(t);
      const reply = (name, text, to = t) => run(e.f, ['reply', '--pr', String(PR), '--comment', String(to.ids[0]), '--body-file', file(e.f, name, `${text}\n`)]);
      const allowed = [
        'Fixed in `a1b2c3d4e5f6`.\n\n| Comment ref | What changed | Test that goes green |\n|---|---|---|\n| x | y | z |',
        'Fixed in a1b2c3d4e5f6.',
        'Test added in a1b2c3d4e5f6: `ParseTest::logs_the_call_id`.',
        'Fixed before. Meets the rule at src/orders/parse.ts:42, which logs the call ID.',
        'Covered by CLAR-ORD-prime-03: "every agent may read every order of its own team". Accepted for the product owner.',
        'Not changed. Meets the rule at src/orders/parse.ts:42, which logs the call ID.',
        'Not changed. Does not apply at src/orders/parse.ts:40: the route takes its credential from a header that a browser never adds.',
        'Not changed. Misread: the finding names a branch that this file does not hold.\n\n**Second reader:** the security reviewer read the evidence and agreed.',
        'Not changed. Misread: the finding names a branch that this file does not hold.',
        'Not changed. Not in this change: the hunk only moves the call.',
        'Not changed: this comment conflicts with the merged design. The design keeps the report unlogged.\n\n**Conflicts with the design:** §3.2 L88 — "the report is never logged", against a log line for it\nThe reviewing critic and the security reviewer agreed.\nA person decides: amend the design, or answer here that the design stands.',
        'Not changed: no source gives the number of calls a minute.\nThe reviewing critic and the security reviewer agreed.\n\n**Needs a person:** the rate for the limit — the product owner, through a /dev-spec ORD-12 amendment\n**Why:** the rate is a business value',
        'Could not fix this automatically: the test stays red after three tries\nNothing was committed for it. A person decides.',
        'Not worked: Prime Security rates this finding LOW, which is below PRIME_FIX_SEVERITY=MEDIUM in checks.env.',
      ];
      const refused = [
        'Not changed: the check is already in the server, and the requirement allows every caller.\nThe reviewing critic and the security reviewer agreed.',
        'Covered by CLAR-ORD-prime-03: "every agent may read every order".',
        'Not changed: this comment conflicts with the merged design. The design keeps the report unlogged.',
        'This is fine as it is.',
        'Not worked: Prime Security rates this finding minor, which is below PRIME_FIX_SEVERITY=MEDIUM in checks.env.',
      ];
      const problems = [];
      allowed.forEach((text, i) => { const r = reply(`ok-${i}.md`, `**[${ref}]** ${text}`); if (r.status !== 0 || !r.output.includes('POSTED ')) problems.push(`an allowed form was not posted: ${text.split('\n')[0]}\n${r.output}`); });
      const before = writes(e.f.load()).length;
      let last = { status: 0, output: '' };
      refused.forEach((text, i) => {
        last = reply(`no-${i}.md`, `**[${ref}]** ${text}`);
        if (last.status !== 1 || !last.output.includes('it answers a Prime finding in no form the harness allows') || !last.output.includes('NOT POSTED')) problems.push(`a refusal was posted: ${text.split('\n')[0]}\nexit ${last.status}\n${last.output}`);
      });
      if (writes(e.f.load()).length !== before) problems.push('a refused reply wrote to the forge');
      if (before !== allowed.length) problems.push(`${before} replies were posted, not ${allowed.length}`);
      const mine = reply('mine.md', '**[SHL-R1]** Not changed: the two rounding rules differ on purpose.\nThe reviewing critic agreed.', e.mine);
      if (mine.status !== 0) problems.push(`a decline in a harness thread: exit ${mine.status}\n${mine.output}`);
      if (pullRequest.PRIME_REPLIES.filter((f) => f.closes).map((f) => f.name).join(', ') !== 'fixed, test added, fixed before, covered by a recorded answer, refuted with a second reader') problems.push('the closing forms changed');
      return check(last, problems.length ? problems : []);
    },
    exit: 1, includes: ['NOT POSTED', 'A refusal for any other reason is not a form'],
  },
  {
    n: 26, name: 'threads --source prime --severity joins Prime\'s own rating to each finding by file, policy and sentence; --min is the lowest rating that is work, LOW when not given; a finding rated below it is belowSetting and is left out of the verifier\'s findings.json; a finding with no rating is always work, and so is a repeat of a finding the run fixed; a thread answered "Not worked" is not work again while its rating stays below --min, and is work once --min is lowered; a --min that is no rating is a usage fault',
    run: (root) => {
      const e = primeEstate(root);
      const [log, flow] = e.head;
      const rated = (name, list) => file(e.f, name, { repoId: 'svc', pr: PR, issues: list });
      const LOG_LOW = { title: 'Security Event Logging with Metadata', path: 'src/orders/parse.ts', line: 42, text: 'Add the call ID to this rejected-report event.', severity: 'LOW' };
      const FLOW_LOW = { title: 'Sequential Business Logic Flow', path: 'src/orders/parse.ts', line: 44, text: 'The routing path bypasses inactive modules.', severity: 'LOW' };
      const sev = rated('prime-severity.json', [LOG_LOW, FLOW_LOW]);
      const base = ['threads', '--pr', String(PR), '--source', 'prime', '--bot', PRIME, '--head', HEAD, '--severity', sev];
      const problems = [];
      const at = (args) => { const j = json(run(e.f, args), problems); return Object.fromEntries(j.threads.map((t) => [t.ref, `${t.primeSeverity}/${t.belowSetting}`])); };
      const low = at(base);
      if (low[cref(log)] !== 'LOW/false' || low[cref(flow)] !== 'LOW/false') problems.push(`with the default --min LOW: ${JSON.stringify(low)}`);
      const medium = at([...base, '--min', 'medium', '--out', join(root, 'r1')]);
      if (medium[cref(flow)] !== 'LOW/true') problems.push(`with --min MEDIUM, the new finding: ${JSON.stringify(medium)}`);
      if (medium[cref(log)] !== 'LOW/false') problems.push(`with --min MEDIUM, the repeat of a fixed finding: ${JSON.stringify(medium)}`);
      const unrated = at(['threads', '--pr', String(PR), '--source', 'prime', '--bot', PRIME, '--head', HEAD, '--severity', rated('only-log.json', [LOG_LOW]), '--min', 'CRITICAL']);
      if (unrated[cref(flow)] !== 'null/false') problems.push(`a finding with no rating: ${JSON.stringify(unrated)}`);
      const handIn = JSON.parse(readFileSync(join(root, 'r1', 'findings.json'), 'utf8'));
      if (handIn.findings.map((x) => x.ref).join(',') !== `${cref(log)},${cref(e.oldAtomic)}`) problems.push(`findings.json holds ${handIn.findings.map((x) => x.ref)}`);
      writeFileSync(join(root, 'r1', 'verified-findings.json'), JSON.stringify(verified([verdict('F1'), verdict('F2')])));
      const v = json(run(e.f, [...base, '--min', 'MEDIUM', '--verified', join(root, 'r1')]), problems);
      const skipped = v.threads.find((t) => t.ref === cref(flow)) || {};
      if (skipped.verdict !== null || skipped.reason !== 'not worked: Prime rates it LOW, below MEDIUM') problems.push(`the skipped item's verdict: ${skipped.verdict} — ${skipped.reason}`);
      const answered = run(e.f, ['reply', '--pr', String(PR), '--comment', String(flow.ids[0]), '--body-file', file(e.f, 'skip.md', `**[${cref(flow)}]** Not worked: Prime Security rates this finding LOW, which is below PRIME_FIX_SEVERITY=MEDIUM in checks.env.\n`)]);
      if (answered.status !== 0) problems.push(`the "Not worked" reply: ${answered.output}`);
      const still = json(run(e.f, [...base, '--min', 'MEDIUM']), problems);
      if (still.threads.some((t) => t.ref === cref(flow)) || !still.answered.some((a) => a.ref === cref(flow))) problems.push(`after the reply, with --min MEDIUM: work ${still.threads.map((t) => t.ref)}, answered ${JSON.stringify(still.answered)}`);
      const lowered = at([...base, '--min', 'LOW']);
      if (lowered[cref(flow)] !== 'LOW/false') problems.push(`after the setting is lowered: ${JSON.stringify(lowered)}`);
      const bad = run(e.f, [...base, '--min', 'minor']);
      if (bad.status !== 3) problems.push(`--min minor: exit ${bad.status}`);
      return { status: problems.length ? 1 : 0, output: problems.join('\n') || 'ratings joined, and the setting holds' };
    },
    exit: 0, includes: ['ratings joined, and the setting holds'],
  },
  {
    n: 27, name: 'a repeat states its reason: settle quotes the harness\'s answer in the reply of a duplicate of an answered thread; a finding that the harness closed without a change, as covered by a recorded answer or refuted with a second reader, keeps that answer, so Prime\'s repeat of it is its duplicate and settle closes it with the quoted answer; a repeat of a finding that the harness closed with a fix is work again',
    run: (root) => {
      const problems = [];
      const own = (e, t, id, text) => {
        e.f.state.comments.push({ ...e.f.state.comments.find((x) => x.id === t.ids[0]), id, node_id: `PRRC_${id}`, body: `**[${cref(t)}]** ${text}\n\n${W}`, user: { login: 'shl-harness-bot', type: 'User' }, review: null, commit: null, in_reply_to_id: t.ids[0] });
        e.f.state.threads.find((x) => x.id === t.id).ids.push(id);
        e.f.save();
      };
      const settleArgs = ['settle', '--pr', String(PR), '--bot', PRIME, '--head', HEAD];
      const list = ['threads', '--pr', String(PR), '--source', 'prime', '--bot', PRIME, '--head', HEAD];
      const replyIn = (s, t) => (s.comments.filter((c) => c.in_reply_to_id === t.ids[0] && c.user.login !== 'alice').pop() || {}).body;

      // An open thread that the harness answered: its duplicate carries the answer.
      const a = primeEstate(join(root, 'answered'));
      own(a, a.oldLog, 9000002, 'Not changed: this value is the product owner\'s.\n\n**Needs a person:** the rate — the product owner, through a design amendment\n**Why:** no source gives it.');
      const sa = run(a.f, settleArgs);
      const wantA = `**[${cref(a.head[0])}]** Duplicate of ${cref(a.oldLog)}. Prime Security posted this finding again on a later review. The harness answered it in that thread, and the answer holds:\n\n> Not changed: this value is the product owner's.\n\n${W}`;
      if (sa.status !== 0 || replyIn(a.f.load(), a.head[0]) !== wantA) problems.push(`a duplicate of an answered thread: exit ${sa.status}\n${replyIn(a.f.load(), a.head[0])}`);
      if (!sa.stdout.includes(`DUPLICATE ${cref(a.head[0])} of ${cref(a.oldLog)} — resolved, with the answer`)) problems.push(`the line of settle: ${sa.output}`);

      // A resolved thread that the harness closed with a person's answer: every repeat is its duplicate.
      const b = primeEstate(join(root, 'covered'));
      const closedB = b.f.state.threads.find((t) => t.resolved);
      own(b, closedB, 9000003, 'Covered by the answer given in this run: "keep the event as it is". Accepted for the tech lead.');
      const jb = json(run(b.f, list), problems);
      if (jb.threads.some((t) => [cref(b.head[0]), cref(b.oldLog)].includes(t.ref))) problems.push(`a repeat of a covered finding is work: ${jb.threads.map((t) => t.ref)}`);
      if (!jb.duplicates.some((d) => d.ref === cref(b.head[0]) && d.of === cref(closedB)) || !jb.duplicates.some((d) => d.ref === cref(b.oldLog) && d.of === cref(closedB))) problems.push(`the duplicates of a covered finding: ${JSON.stringify(jb.duplicates)}`);
      const sb = run(b.f, settleArgs);
      const wantB = `**[${cref(b.head[0])}]** Duplicate of ${cref(closedB)}. Prime Security posted this finding again on a later review. The harness answered it in that thread, and the answer holds:\n\n> Covered by the answer given in this run: "keep the event as it is". Accepted for the tech lead.\n\n${W}`;
      const afterB = b.f.load();
      if (sb.status !== 0 || replyIn(afterB, b.head[0]) !== wantB) problems.push(`a repeat of a covered finding: exit ${sb.status}\n${replyIn(afterB, b.head[0])}`);
      if (!afterB.threads.find((t) => t.id === b.head[0].id).resolved || !afterB.threads.find((t) => t.id === b.oldLog.id).resolved) problems.push('a repeat of a covered finding stays open');

      // A refutation that the second reader agreed with stands too, and its reason is the quote.
      const c = primeEstate(join(root, 'refuted'));
      const closedC = c.f.state.threads.find((t) => t.resolved);
      own(c, closedC, 9000004, 'Not changed. Meets the rule at src/orders/parse.ts:42, which logs the call ID.\n\n**Second reader:** the security reviewer read the evidence and agreed.');
      const sc = run(c.f, settleArgs);
      const saidC = replyIn(c.f.load(), c.head[0]) || '';
      if (sc.status !== 0 || !saidC.includes('> Not changed. Meets the rule at src/orders/parse.ts:42, which logs the call ID.') || saidC.includes('Second reader')) problems.push(`a repeat of a refuted finding: exit ${sc.status}\n${saidC}`);

      // A finding that the harness fixed is read again: the code changed.
      const d = primeEstate(join(root, 'fixed'));
      const closedD = d.f.state.threads.find((t) => t.resolved);
      own(d, closedD, 9000005, 'Fixed in `a1b2c3d4e5f6`.\n\n| File | Change |\n|---|---|\n| src/orders/parse.ts | logs the call ID |');
      const jd = json(run(d.f, list), problems);
      const again = jd.threads.find((t) => t.ref === cref(d.head[0]));
      if (!again || again.reportedBefore !== true) problems.push(`a repeat of a fixed finding: ${JSON.stringify(jd.threads.map((t) => [t.ref, t.reportedBefore]))}`);
      return { status: problems.length ? 1 : 0, output: problems.join('\n') || 'each repeat states its reason' };
    },
    exit: 0, includes: ['each repeat states its reason'],
  },
];

/* ---------------------------------------------------------------------------- runner */

function main() {
  const wanted = process.argv.slice(2).filter((a) => a.search(/^\d+$/) === 0).map(Number);
  const selected = wanted.length ? FIXTURES.filter((f) => wanted.includes(f.n)) : FIXTURES;
  process.stdout.write(`script under test: ${SCRIPT}\n${selected.length} of ${FIXTURES.length} fixtures\n\n`);
  let failed = 0;
  for (const f of selected) {
    const root = mkdtempSync(join(tmpdir(), `pull-request-fx${String(f.n).padStart(2, '0')}-`));
    let res;
    try { res = f.run(root); } catch (err) { res = { status: 'threw', output: err && err.stack ? err.stack : String(err) }; }
    const problems = [];
    if (res.status !== f.exit) problems.push(`expected exit ${f.exit}, got ${res.status}`);
    for (const s of f.includes || []) if (!res.output.includes(s)) problems.push(`output does not contain: ${s}`);
    for (const s of [...(f.excludes || []), 'PROBLEMS:', 'INTERNAL:']) if (res.output.includes(s)) problems.push(`output should not contain: ${s}`);
    if (problems.length) {
      failed += 1;
      process.stdout.write(`  FAIL  ${f.n}. ${f.name} [exit ${f.exit}]\n${problems.map((p) => `          - ${p}`).join('\n')}\n${res.output.split('\n').map((l) => `          | ${l}`).join('\n')}\n`);
    } else process.stdout.write(`  PASS  ${f.n}. ${f.name} [exit ${f.exit}]\n`);
    if (!KEEP) rmSync(root, { recursive: true, force: true });
  }
  process.stdout.write(failed ? `\n${failed} of ${selected.length} fixtures FAILED.\n` : `\nAll ${selected.length} fixtures passed.\n`);
  rmSync(SANDBOX_HOME, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
}

main();

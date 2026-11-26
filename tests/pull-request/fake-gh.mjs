/**
 * fake-gh.mjs — a stand-in for the GitHub CLI, for the pull-request fixtures.
 *
 * The suite puts a `gh` first on PATH that runs this file, so the shipped script calls it exactly
 * as it calls the real one. It answers the calls `pull-request.mjs` makes, from a JSON state file
 * FAKE_GH_STATE names, which it reads and writes back on every call, and it records each call
 * there. It is a stand-in for the parts of GitHub the script depends on, and nothing more:
 *
 *   gh auth status --hostname <host>              logged in for the hosts in `loggedIn`
 *   gh api --hostname <host> --method <m> [--paginate --slurp] [--input -] repos/{o}/{r}/…
 *       pulls?head=…  pulls/{n}  pulls/{n}/files  pulls/{n}/comments  pulls/{n}/reviews (GET, POST:
 *       refused whole when one comment is not on a line of the diff, as GitHub does)
 *       pulls/{n}/comments/{id}/replies  issues/{n}/comments (GET, POST)  issues/{n}/labels[/{name}]
 *       labels[/{name}]
 *   gh api graphql --hostname <host> [--paginate --slurp] -f query=… -f|-F <var>=…
 *       by operation name: ReviewThreads (paged on $endCursor), Thread, ResolveThread
 *
 * --paginate --slurp prints every page in one JSON list, `pageSize` items each, as gh does; one
 * without the other is refused. A failure is gh's:
 * the API's body on stdout, `gh: <message> (HTTP <status>)` on stderr, exit 1. A fixture arranges
 * one with `script`: `{ match: 'GET repos/acme/svc/pulls' | 'GRAPHQL ReviewThreads' | '*', status, body }`,
 * or `{ match, raw: '<html>' }` for an answer that is not JSON; `sticky: true` keeps it for every
 * later call too.
 *
 * A scanner bot (Prime Security) is an author with `bot: true`: REST shows it as `<login>[bot]` of
 * type Bot, GraphQL as a Bot named `<login>`, as GitHub does. `addReview` posts one of its reviews,
 * with a thread per comment. `timeline` makes things happen while a script waits: each entry
 * `{ after: <n>, review | head | state }` runs once the reviews of a pull request were read n times.
 *
 * Node standard library only.
 */

import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const HOST = 'ghe.acme.invalid';
export const OWNER = 'acme';
export const REPO = 'svc';
export const BOT = 'shl-harness-bot';

/* ------------------------------------------------------------- the state, for fixtures */

export function newState({ pageSize = 100, loggedIn = [HOST] } = {}) {
  return {
    loggedIn, pageSize, pulls: [], files: {}, comments: [], threads: [], reviews: [], issueComments: [],
    labels: {}, script: [], calls: [], nextId: 2817000, nextThread: 1, timeline: [], reviewReads: 0,
  };
}

export function addPull(state, { number, branch, head, state: st = 'open', merged = false, body = '', labels = [], files = [] }) {
  const pull = {
    number, head: { ref: branch, sha: head }, base: { ref: 'main', sha: '1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d' }, state: st, merged_at: merged ? '2026-10-12T10:00:00Z' : null,
    body, html_url: `https://${HOST}/${OWNER}/${REPO}/pull/${number}`, labels: labels.map((name) => ({ name })),
  };
  state.pulls.push(pull);
  state.files[number] = files.map((f) => ({ filename: f.path, status: f.status || 'modified', patch: f.patch }));
  return pull;
}

const userOf = (author, bot) => ({ login: bot ? `${author}[bot]` : author, type: bot ? 'Bot' : 'User' });

function addComment(state, thread, { author = BOT, bot = false, body, at = new Date().toISOString(), replyTo = null, review = null, commit = null }) {
  state.nextId += 1;
  const c = {
    id: state.nextId, node_id: `PRRC_${state.nextId}`, pull: thread.pull, thread: thread.id, path: thread.path, line: thread.line, side: 'RIGHT',
    body, user: userOf(author, bot), created_at: at, in_reply_to_id: replyTo, review, commit,
    html_url: `https://${HOST}/${OWNER}/${REPO}/pull/${thread.pull}#discussion_r${state.nextId}`,
  };
  state.comments.push(c);
  thread.ids.push(c.id);
  return c;
}

/** A review thread already on a pull request: its comments, oldest first, each `{ author, body, at }`. */
export function addThread(state, { pull, path, line, resolved = false, outdated = false, comments }) {
  const thread = { id: `PRRT_${String(state.nextThread++).padStart(4, '0')}`, pull, path, line: outdated ? null : line, originalLine: line, resolved, outdated, ids: [] };
  state.threads.push(thread);
  for (const c of comments) addComment(state, thread, c);
  return thread;
}

/** A review already on a pull request, with one new thread per comment `{ path, line, body }`; the threads are returned. */
export function addReview(state, { pull, body = '', author = BOT, bot = false, commit = null, comments = [] }) {
  state.nextId += 1;
  const review = { id: state.nextId, pull, event: 'COMMENT', body, commit_id: commit, user: userOf(author, bot), submitted_at: new Date().toISOString(), html_url: `https://${HOST}/${OWNER}/${REPO}/pull/${pull}#pullrequestreview-${state.nextId}` };
  state.reviews.push(review);
  const threads = comments.map((c) => addThread(state, { pull, path: c.path, line: c.line, comments: [{ author, bot, body: c.body, review: review.id, commit }] }));
  return { review, threads };
}

/** A general comment on a pull request, by a person or a bot. */
export function addIssueComment(state, { pull, body, author = BOT, bot = false }) {
  state.nextId += 1;
  state.issueComments.push({ id: state.nextId, pull, body, user: userOf(author, bot), html_url: `https://${HOST}/${OWNER}/${REPO}/pull/${pull}#issuecomment-${state.nextId}` });
}

/** What the timeline holds for the reviews' n-th read: a review posted, the head moved, the pull request closed or merged. */
function happen(state) {
  state.reviewReads += 1;
  for (const e of state.timeline) {
    if (e.done || e.after > state.reviewReads) continue;
    e.done = true;
    const pull = state.pulls.find((x) => x.number === e.pull) || state.pulls[0];
    if (e.review) addReview(state, { pull: pull.number, ...e.review });
    if (e.head) pull.head.sha = e.head;
    if (e.state === 'merged') { pull.state = 'closed'; pull.merged_at = '2026-10-26T10:00:00Z'; }
    if (e.state === 'closed') pull.state = 'closed';
  }
}

/* ------------------------------------------------------------------------- the CLI */

class Answer extends Error {
  constructor(status, body, message) { super(message); this.status = status; this.body = body; }
}
const refuse = (status, message, extra = {}) => { throw new Answer(status, { message, ...extra }, message); };

/** The lines of the new side a patch shows: the lines a comment can be attached to. */
function rightLines(patch) {
  const lines = new Set();
  let right = 0;
  for (const l of String(patch || '').split('\n')) {
    const h = l.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (h) { right = Number(h[1]); continue; }
    if (l.startsWith('-') || l.startsWith('\\')) continue;
    if (l.startsWith('+') || l.startsWith(' ')) { lines.add(right); right += 1; }
  }
  return lines;
}

function rest(state, method, endpoint, body) {
  const url = new URL(endpoint, 'https://fake/');
  const repo = `/repos/${OWNER}/${REPO}`;
  if (!url.pathname.startsWith(`${repo}/`)) refuse(404, 'Not Found');
  const rel = url.pathname.slice(repo.length);
  const pullOf = (n) => state.pulls.find((x) => x.number === Number(n));
  let m;
  if (method === 'GET' && rel === '/pulls') {
    const head = url.searchParams.get('head') || '';
    const branch = head.startsWith(`${OWNER}:`) ? head.slice(OWNER.length + 1) : null;
    return state.pulls.filter((x) => x.head.ref === branch).slice().reverse();
  }
  if ((m = rel.match(/^\/pulls\/(\d+)$/)) && method === 'GET') return pullOf(m[1]) || refuse(404, 'Not Found');
  if ((m = rel.match(/^\/pulls\/(\d+)\/files$/)) && method === 'GET') return pullOf(m[1]) ? state.files[m[1]] || [] : refuse(404, 'Not Found');
  if ((m = rel.match(/^\/pulls\/(\d+)\/comments$/)) && method === 'GET') return state.comments.filter((c) => c.pull === Number(m[1]));
  if ((m = rel.match(/^\/pulls\/(\d+)\/reviews$/))) {
    const pull = pullOf(m[1]) || refuse(404, 'Not Found');
    if (method === 'GET') { happen(state); return state.reviews.filter((r) => r.pull === pull.number); }
    if (body.event !== 'COMMENT') refuse(422, `fake gh: this suite only expects COMMENT reviews, got ${body.event}`);
    const files = state.files[pull.number] || [];
    for (const c of body.comments || []) {
      const f = files.find((x) => x.filename === c.path);
      if (!f || !rightLines(f.patch).has(c.line) || c.side !== 'RIGHT' || (c.start_line !== undefined && !rightLines(f.patch).has(c.start_line))) refuse(422, 'Unprocessable Entity', { errors: ['Pull request review thread line must be part of the diff'] });
    }
    state.nextId += 1;
    const review = { id: state.nextId, pull: pull.number, event: body.event, body: body.body, commit_id: body.commit_id, user: userOf(BOT, false), html_url: `${pull.html_url}#pullrequestreview-${state.nextId}` };
    state.reviews.push(review);
    for (const c of body.comments || []) addThread(state, { pull: pull.number, path: c.path, line: c.line, comments: [{ body: c.body, review: review.id, commit: body.commit_id }] });
    return review;
  }
  if ((m = rel.match(/^\/pulls\/(\d+)\/comments\/(\d+)\/replies$/)) && method === 'POST') {
    const parent = state.comments.find((c) => c.id === Number(m[2]) && c.pull === Number(m[1])) || refuse(404, 'Not Found');
    return addComment(state, state.threads.find((t) => t.id === parent.thread), { body: body.body, replyTo: parent.id });
  }
  if ((m = rel.match(/^\/issues\/(\d+)\/comments$/)) && method === 'GET') return pullOf(m[1]) ? state.issueComments.filter((c) => c.pull === Number(m[1])) : refuse(404, 'Not Found');
  if ((m = rel.match(/^\/issues\/(\d+)\/comments$/)) && method === 'POST') {
    const pull = pullOf(m[1]) || refuse(404, 'Not Found');
    state.nextId += 1;
    const c = { id: state.nextId, pull: pull.number, body: body.body, user: userOf(BOT, false), html_url: `${pull.html_url}#issuecomment-${state.nextId}` };
    state.issueComments.push(c);
    return c;
  }
  if ((m = rel.match(/^\/issues\/(\d+)\/labels$/))) {
    const pull = pullOf(m[1]) || refuse(404, 'Not Found');
    if (method === 'GET') return pull.labels;
    for (const name of body.labels || []) {
      if (!state.labels[name]) state.labels[name] = { name, color: 'ededed', description: '' };
      if (!pull.labels.some((l) => l.name === name)) pull.labels.push({ name });
    }
    return pull.labels;
  }
  if ((m = rel.match(/^\/issues\/(\d+)\/labels\/(.+)$/)) && method === 'DELETE') {
    const pull = pullOf(m[1]);
    const name = decodeURIComponent(m[2]);
    if (!pull || !pull.labels.some((l) => l.name === name)) refuse(404, 'Label does not exist');
    pull.labels = pull.labels.filter((l) => l.name !== name);
    return pull.labels;
  }
  if ((m = rel.match(/^\/labels\/(.+)$/)) && method === 'GET') return state.labels[decodeURIComponent(m[1])] || refuse(404, 'Not Found');
  if (rel === '/labels' && method === 'POST') {
    if (state.labels[body.name]) refuse(422, 'Validation Failed', { errors: [{ code: 'already_exists' }] });
    state.labels[body.name] = { name: body.name, color: body.color, description: body.description };
    return state.labels[body.name];
  }
  return refuse(404, `fake gh has no ${method} ${url.pathname}`);
}

const comment = (state, id) => {
  const c = state.comments.find((x) => x.id === id);
  const bot = c.user.type === 'Bot';
  return {
    id: c.node_id, databaseId: c.id, author: { __typename: bot ? 'Bot' : 'User', login: bot ? c.user.login.replace(/\[bot\]$/, '') : c.user.login },
    body: c.body, createdAt: c.created_at, url: c.html_url,
    pullRequestReview: c.review ? { databaseId: c.review, commit: c.commit ? { oid: c.commit } : null } : null,
  };
};

function graphql(state, op, v) {
  if (op === 'ReviewThreads') {
    if (v.owner !== OWNER || v.name !== REPO) return { data: { repository: null }, errors: [{ type: 'NOT_FOUND', message: `Could not resolve to a Repository with the name '${v.owner}/${v.name}'.` }] };
    const pull = state.pulls.find((x) => x.number === v.number);
    if (!pull) return { data: { repository: { pullRequest: null } }, errors: [{ type: 'NOT_FOUND', message: `Could not resolve to a PullRequest with the number of ${v.number}.` }] };
    const all = state.threads.filter((t) => t.pull === pull.number);
    const start = v.endCursor ? Number(v.endCursor) : 0;
    const page = all.slice(start, start + state.pageSize);
    const next = start + page.length;
    const nodes = page.map((t) => ({
      id: t.id, isResolved: t.resolved, path: t.path, line: t.line, originalLine: t.originalLine,
      comments: { nodes: t.ids.slice(0, 1).map((id) => comment(state, id)) },
      recent: { nodes: t.ids.slice(-20).map((id) => comment(state, id)) },
    }));
    return { data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: next < all.length, endCursor: String(next) }, nodes } } } } };
  }
  const thread = state.threads.find((t) => t.id === v.id);
  if (op === 'Thread') return { data: { node: thread ? { id: thread.id, isResolved: thread.resolved, pullRequest: { number: thread.pull }, comments: { nodes: [comment(state, thread.ids[0])] }, recent: { nodes: thread.ids.slice(-20).map((id) => comment(state, id)) } } : null } };
  if (op === 'ResolveThread') {
    if (!thread) return { data: { resolveReviewThread: null }, errors: [{ type: 'NOT_FOUND', message: `Could not resolve to a node with the global id of '${v.id}'` }] };
    thread.resolved = true;
    return { data: { resolveReviewThread: { thread: { id: thread.id, isResolved: true } } } };
  }
  return { errors: [{ message: `fake gh has no operation ${op}` }] };
}

function main(argv) {
  const file = process.env.FAKE_GH_STATE;
  const state = JSON.parse(readFileSync(file, 'utf8'));
  const save = () => writeFileSync(file, JSON.stringify(state, null, 2));
  const say = (stdout, stderr, code) => { save(); if (stdout) process.stdout.write(stdout); if (stderr) process.stderr.write(stderr); process.exit(code); };
  const call = { args: argv };
  state.calls.push(call);
  if (argv[0] === 'auth' && argv[1] === 'status') {
    const host = argv[argv.indexOf('--hostname') + 1];
    if (state.loggedIn.includes(host)) say(`${host}\n  ✓ Logged in to ${host} account ${BOT}\n`, '', 0);
    say('', `You are not logged into any accounts on ${host}\n`, 1);
  }
  if (argv[0] !== 'api') say('', `fake gh: unexpected call ${argv.join(' ')}\n`, 1);
  const o = { method: 'GET', paginate: false, slurp: false, input: false, fields: {}, endpoint: null, hostname: null };
  for (let i = 1; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--hostname') o.hostname = argv[++i];
    else if (a === '--method' || a === '-X') o.method = argv[++i];
    else if (a === '--paginate') o.paginate = true;
    else if (a === '--slurp') o.slurp = true;
    else if (a === '--input') { o.input = argv[++i] === '-'; }
    else if (a === '-f' || a === '-F') { const kv = argv[++i]; const eq = kv.indexOf('='); const k = kv.slice(0, eq); const val = kv.slice(eq + 1); o.fields[k] = a === '-F' && val.search(/^\d+$/) === 0 ? Number(val) : val; }
    else o.endpoint = a;
  }
  if (o.paginate !== o.slurp) say('', 'fake gh: --paginate and --slurp go together\n', 1);
  if (!state.loggedIn.includes(o.hostname)) say(JSON.stringify({ message: 'Bad credentials' }), 'gh: Bad credentials (HTTP 401)\n', 1);
  const body = o.input ? JSON.parse(readFileSync(0, 'utf8')) : null;
  if (body) call.body = body;
  const isGraphql = o.endpoint === 'graphql';
  const op = isGraphql ? ((o.fields.query || '').match(/^\s*(?:query|mutation) (\w+)/) || [])[1] : null;
  call.route = isGraphql ? `GRAPHQL ${op}` : `${o.method} ${o.endpoint.split('?')[0]}`;
  const at = state.script.findIndex((s) => s.match === '*' || s.match === call.route);
  if (at !== -1) {
    const forced = state.script[at].sticky ? state.script[at] : state.script.splice(at, 1)[0];
    if (forced.raw !== undefined) say(forced.raw, '', 0);
    const message = (forced.body && forced.body.message) || `scripted ${forced.status}`;
    say(JSON.stringify(forced.body || { message }), `gh: ${message} (HTTP ${forced.status})\n`, 1);
  }
  if (isGraphql) {
    const vars = { ...o.fields };
    delete vars.query;
    const pages = [];
    for (;;) {
      const answer = graphql(state, op, vars);
      if (answer.errors) say(JSON.stringify(answer), `gh: ${answer.errors.map((e) => e.message).join('; ')}\n`, 1);
      pages.push(answer);
      const info = answer.data && answer.data.repository && answer.data.repository.pullRequest && answer.data.repository.pullRequest.reviewThreads ? answer.data.repository.pullRequest.reviewThreads.pageInfo : null;
      if (!o.paginate || !info || !info.hasNextPage) break;
      vars.endCursor = info.endCursor;
    }
    say(JSON.stringify(o.paginate ? pages : pages[0]), '', 0);
  }
  let answer;
  try { answer = rest(state, o.method, o.endpoint, body); } catch (err) {
    if (!(err instanceof Answer)) throw err;
    say(JSON.stringify(err.body), `gh: ${err.message} (HTTP ${err.status})\n`, 1);
  }
  if (o.paginate && Array.isArray(answer)) {
    const pages = [];
    for (let i = 0; i < answer.length; i += state.pageSize) pages.push(answer.slice(i, i + state.pageSize));
    say(JSON.stringify(pages.length ? pages : [[]]), '', 0);
  }
  say(JSON.stringify(answer), '', 0);
}

const invoked = (() => { try { return realpathSync(process.argv[1] || '') === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })();
if (invoked) main(process.argv.slice(2));

#!/usr/bin/env node
/**
 * fake-gh.mjs — a stand-in for the GitHub CLI, for the escalation suites. It answers the calls
 * escalation-store.mjs and escalation.mjs make, from one JSON state file, and nothing else:
 *
 *   gh repo view --json nameWithOwner -q .nameWithOwner
 *   gh pr list ...                     the state's `pulls`, or the file GH_FAKE names
 *   gh api -X <METHOD> <path> [-H ...] [--input -]
 *     issues, issue comments, issue labels, repository labels and issue artifacts with versions
 *
 * FAKE_GH_STATE   the state file, created on first use: { repo, next, issues, labels, pulls }
 * FAKE_GH_USER    the login every write is made as (default dev-one)
 * FAKE_GH_ASSOC   the author_association of a comment it writes (default COLLABORATOR)
 *   A login's permission (`collaborators/<login>/permission`) is the state's `permissions` entry,
 *   else read for reader, drive-by, someone and stranger, none for a bot, and write for the rest.
 * FAKE_GH_DOWN    any value: every call fails as GitHub being down (HTTP 503)
 * FAKE_GH_FAIL    a substring of "<METHOD> <path>": that call fails (HTTP 500)
 * FAKE_GH_BARRIER a count: the first comment POST of each process waits until that many processes
 *                 reached it, so two writers really race
 *
 * Each call holds a lock on the state file, so a call is atomic, as one GitHub request is.
 * Node standard library only.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmdirSync, writeFileSync } from 'node:fs';
import { stdin, stdout, stderr } from 'node:process';

const STATE = process.env.FAKE_GH_STATE;
const USER = process.env.FAKE_GH_USER || 'dev-one';
// Logins that can read the hub but not write to it, unless the state's `permissions` says otherwise.
const READ_ONLY = ['reader', 'drive-by', 'someone', 'stranger'];
const ASSOC = process.env.FAKE_GH_ASSOC || 'COLLABORATOR';
const now = () => new Date(Date.parse(process.env.FAKE_GH_NOW || process.env.HARNESS_ESCALATION_NOW || '') || Date.now()).toISOString().replace(/\.\d{3}Z$/, 'Z');

class Fail extends Error {}
const fail = (code, text) => { throw new Fail(`gh: ${text} (HTTP ${code})`); };
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function locked(fn) {
  const lock = `${STATE}.lock`;
  for (let i = 0; i < 2000; i += 1) {
    try { mkdirSync(lock); break; } catch { sleep(5); }
    if (i === 1999) fail(500, 'the fake state stayed locked');
  }
  try {
    const state = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : { repo: 'acme/hub', next: 1, issues: [], labels: [], pulls: [] };
    const out = fn(state);
    // A rename replaces the file whole, so the barrier's unlocked read never sees half of it.
    writeFileSync(`${STATE}.tmp`, JSON.stringify(state, null, 2));
    renameSync(`${STATE}.tmp`, STATE);
    return out;
  } finally {
    rmdirSync(lock);
  }
}

function barrier() {
  const want = Number(process.env.FAKE_GH_BARRIER || 0);
  if (!want || process.env.FAKE_GH_BARRIER_DONE) return;
  process.env.FAKE_GH_BARRIER_DONE = '1';
  locked((s) => { s.barrier = (s.barrier || 0) + 1; });
  for (let i = 0; i < 1000; i += 1) {
    const s = JSON.parse(readFileSync(STATE, 'utf8'));
    if ((s.barrier || 0) >= want) return;
    sleep(10);
  }
}

const url = (s, kind, n) => `https://github.example/${s.repo}/${kind}/${n}`;
const publicIssue = (s, i) => ({ number: i.number, title: i.title, body: i.body, state: i.state, state_reason: i.state_reason || null, closed_at: i.closed_at || null, labels: i.labels.map((name) => ({ name })), user: { login: i.user }, html_url: url(s, 'issues', i.number), created_at: i.created_at });
const publicArtifact = (s, i, a) => ({ id: a.number * 1000 + i.number, number: a.number, type: a.type, name: a.name, body: a.versions[a.versions.length - 1].body, html_url: `${url(s, 'issues', i.number)}/artifacts/${a.number}`, creator: { login: a.versions[0].actor }, updated_by_actor: { login: a.versions[a.versions.length - 1].actor } });

function page(list, query) {
  const per = Number(query.get('per_page') || 30);
  const p = Number(query.get('page') || 1);
  return list.slice((p - 1) * per, p * per);
}

function route(method, path, body) {
  const [where, qs] = path.split('?');
  const query = new URLSearchParams(qs || '');
  const parts = where.replace(/^\/?repos\//, '').split('/');
  const repo = `${parts[0]}/${parts[1]}`;
  const rest = parts.slice(2);
  return locked((s) => {
    if (repo !== s.repo) fail(404, 'Not Found');
    const issueOf = (n) => s.issues.find((i) => i.number === Number(n)) || fail(404, 'Not Found');
    // labels of the repository
    if (rest[0] === 'labels' && rest.length === 1) {
      if (method === 'GET') return page(s.labels, query);
      if (method === 'POST') { if (s.labels.some((l) => l.name === body.name)) fail(422, 'Validation Failed'); s.labels.push({ name: body.name, color: body.color, description: body.description }); return body; }
    }
    // A login's permission on the hub: the state's `permissions`, else read for the fixtures' outsiders, write for everyone else.
    if (rest[0] === 'collaborators' && rest[2] === 'permission' && method === 'GET') {
      const login = decodeURIComponent(rest[1]);
      const permission = (s.permissions || {})[login] || (login.endsWith('[bot]') ? 'none' : READ_ONLY.includes(login) ? 'read' : 'write');
      return { permission, role_name: permission };
    }
    if (rest[0] !== 'issues') fail(404, 'Not Found');
    if (rest.length === 1) {
      if (method === 'GET') {
        const st = query.get('state') || 'open';
        return page(s.issues.filter((i) => st === 'all' || i.state === st).sort((a, b) => b.number - a.number).map((i) => publicIssue(s, i)), query);
      }
      if (method === 'POST') {
        const i = { number: s.next++, title: body.title, body: body.body || '', state: 'open', state_reason: null, labels: [], user: USER, created_at: now(), comments: [], artifacts: [] };
        s.issues.push(i);
        return publicIssue(s, i);
      }
    }
    if (rest[1] === 'comments' && rest.length === 3) {
      const at = s.issues.findIndex((i) => i.comments.some((c) => c.id === Number(rest[2])));
      if (at === -1) fail(404, 'Not Found');
      if (method === 'DELETE') { s.issues[at].comments = s.issues[at].comments.filter((c) => c.id !== Number(rest[2])); return null; }
      if (method === 'PATCH') { const c = s.issues[at].comments.find((x) => x.id === Number(rest[2])); c.body = body.body; return c; }
    }
    const issue = issueOf(rest[1]);
    if (rest.length === 2) {
      if (method === 'GET') return publicIssue(s, issue);
      if (method === 'PATCH') {
        for (const k of ['title', 'body', 'state']) if (body[k] !== undefined) issue[k] = body[k];
        if (body.state_reason !== undefined) issue.state_reason = body.state_reason;
        if (body.state === 'closed') issue.closed_at = now();
        if (body.state === 'open') { issue.state_reason = null; issue.closed_at = null; }
        return publicIssue(s, issue);
      }
    }
    if (rest[2] === 'comments' && rest.length === 3) {
      if (method === 'GET') return page(issue.comments.slice().sort((a, b) => a.id - b.id), query);
      if (method === 'POST') {
        s.commentSeq = (s.commentSeq || 100) + 1;
        const c = { id: s.commentSeq, body: body.body, user: { login: USER }, author_association: ASSOC, created_at: now() };
        issue.comments.push(c);
        return c;
      }
    }
    if (rest[2] === 'labels') {
      if (method === 'POST' && rest.length === 3) { for (const l of body.labels) if (!issue.labels.includes(l)) issue.labels.push(l); return issue.labels.map((name) => ({ name })); }
      if (method === 'DELETE' && rest.length === 4) { const name = decodeURIComponent(rest[3]); if (!issue.labels.includes(name)) fail(404, 'Label does not exist'); issue.labels = issue.labels.filter((l) => l !== name); return null; }
    }
    if (rest[2] === 'artifacts') {
      if (rest.length === 3 && method === 'GET') return page(issue.artifacts.map((a) => publicArtifact(s, issue, a)), query);
      if (rest.length === 3 && method === 'POST') {
        const a = { number: (issue.artifactSeq = (issue.artifactSeq || 0) + 1), type: body.type || 'generic', name: body.name, versions: [{ version: 1, body: body.body, actor: USER, created_at: now() }] };
        issue.artifacts.push(a);
        return publicArtifact(s, issue, a);
      }
      const a = issue.artifacts.find((x) => x.number === Number(rest[3])) || fail(404, 'Not Found');
      if (method === 'GET') return { artifact: publicArtifact(s, issue, a), versions: a.versions.slice().reverse().map((v) => ({ version: v.version, name: a.name, body: v.body, created_at: v.created_at, actor: { login: v.actor } })) };
      if (method === 'PATCH') { a.versions.push({ version: a.versions.length + 1, body: body.body, actor: USER, created_at: now() }); return publicArtifact(s, issue, a); }
      if (method === 'DELETE') { issue.artifacts = issue.artifacts.filter((x) => x !== a); return null; }
    }
    return fail(404, 'Not Found');
  });
}

function readInput() {
  try { return JSON.parse(readFileSync(stdin.fd, 'utf8') || 'null'); } catch { return null; }
}

function main() {
const args = process.argv.slice(2);
if (!STATE) fail(500, 'FAKE_GH_STATE is not set');
if (process.env.FAKE_GH_DOWN) fail(503, 'Service Unavailable');

if (args[0] === 'repo' && args[1] === 'view') {
  stdout.write(`${locked((s) => s.repo)}\n`);
} else if (args[0] === 'pr' && args[1] === 'list') {
  if (process.env.GH_FAKE) stdout.write(readFileSync(process.env.GH_FAKE, 'utf8'));
  else stdout.write(JSON.stringify(locked((s) => s.pulls || [])));
} else if (args[0] === 'api') {
  let method = 'GET';
  let path = null;
  let input = false;
  for (let i = 1; i < args.length; i += 1) {
    if (args[i] === '-X' || args[i] === '--method') { method = args[i + 1]; i += 1; } else if (args[i] === '-H' || args[i] === '--header') { i += 1; } else if (args[i] === '--input') { input = true; i += 1; } else if (!path) path = args[i];
  }
  if (process.env.FAKE_GH_FAIL && `${method} ${path}`.includes(process.env.FAKE_GH_FAIL)) fail(500, 'Internal Server Error');
  const body = input ? readInput() : null;
  if (method === 'POST' && path.endsWith('/comments')) barrier();
  const out = route(method, path, body);
  if (out !== null && out !== undefined) stdout.write(JSON.stringify(out));
} else {
  fail(400, `the fake gh does not answer: gh ${args.join(' ')}`);
}
}

try {
  main();
} catch (err) {
  if (!(err instanceof Fail)) throw err;
  stderr.write(`${err.message}\n`);
  process.exit(1);
}

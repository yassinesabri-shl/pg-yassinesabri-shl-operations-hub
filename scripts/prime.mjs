#!/usr/bin/env node
// Part of the harness asset library c6f3b4427d58f7c3 (see VERSION.json) · 2026-11-09
/**
 * prime.mjs — the one path from the harness to Prime Security's guardrails.
 *
 * A guardrail is one security rule from Prime: a title and a rule of about 30 words. Prime holds
 * them for the whole account; it keeps no list per repository. This script reads them for one
 * design, at these points of a story, and never writes to Prime:
 *
 *   list     /dev-spec, run by the orchestrator before it dispatches the writer, and /dev-sprint
 *            precondition 9, for the security reviewer of the code. The guardrail
 *            list the design writer, the critic and the security reviewer read: every guardrail of the repository's
 *            stack, each with its full rule, numbered g1, g2 …. The guardrails Prime found broken
 *            in this repository come first, from any group, then the rest of the stack by
 *            category, then one line that counts the groups outside the stack. The stack is the
 *            core (OWASP ASVS and the company's policies), plus OWASP LLM where Prime's summary
 *            of the repository shows an `ai` component, plus a CIS group where a component names
 *            AWS, Google Cloud or Azure. --stack sets it by hand (checks.env PRIME_STACK).
 *   choose   /dev-spec step 2. Writes the rules of the guardrails the design applies from the
 *            saved list, and prints the design's line: `Guardrails: prime@<12-hex>:<id>, <id>` —
 *            the fingerprint of the rules, then each Prime id. --pick none prints
 *            `Guardrails: none`. It asks Prime nothing and needs no token, so the design writer
 *            may run it. Only list and refresh reach Prime.
 *   refresh  /dev-sprint precondition 9 and /prime-review. Reads the design's line, reads the
 *            chosen guardrails from Prime again, writes their rules, and says whether one changed
 *            or is missing. A line that is off, none or unchecked, or no line, asks Prime nothing.
 *   severity the PR fixes, before they list Prime's findings. Reads Prime's own record of its
 *            reviews of one pull request, and writes the rating Prime gave each issue: CRITICAL,
 *            HIGH, MEDIUM, LOW or INFO. pull-request.mjs joins the ratings to the threads, and
 *            PRIME_FIX_SEVERITY in the spoke's checks.env says which ratings the run works on.
 *   history  /dev-spec and /dev-sprint, after list. Reads Prime's own record of its reviews of the
 *            repository's earlier pull requests, the newest 10 that hold a finding, and writes
 *            prime-history.md: each guardrail that Prime raised there, with the pull requests, the
 *            files and Prime's sentences. The design writer and the security reviewer read it, so
 *            the design decides each one before Prime raises it again. Prime's search of findings
 *            by repository holds none of these, so list alone does not show them.
 *            --designs <the hub's design folder> adds what the designs of this repository recorded
 *            for Prime's rules: each `Closed` row of §9 whose Source is `Prime <g-number> <title>`,
 *            and each row of §10 whose decision opens `Prime <g-number> <title> — `. A person
 *            gave each answer, at design time or in the fixes of a pull request, so a later design
 *            that meets the same question starts from it.
 *
 * Usage:   node scripts/prime.mjs list    --repo-id <id> --out <dir> [--stack core,llm,aws,gcp,azure]
 *          node scripts/prime.mjs choose  --out <dir> --pick g3,g7|none
 *          node scripts/prime.mjs refresh --design <path> --out <dir> [--since <ISO date>]
 *          node scripts/prime.mjs severity --repo-id <id> --pr <n> --out <dir>
 *          node scripts/prime.mjs history --repo-id <id> --out <dir> [--designs <dir>]
 *
 *   --repo-id  the spoke's id in docs/estate/repositories.json (HARNESS_REGISTRY moves it); its
 *              url names the owner and the repository that Prime holds
 *   --out      the folder for this story's files: list.json, guardrail-list.md and chosen.md, and
 *              prime-severity.json for severity and prime-history.md for history. It lives outside
 *              every repository's tracked files
 *
 * Prime is reached at https://api.primesec.ai: its MCP server (/mcp) first, and its REST API with
 * the same operation when MCP does not answer. It calls four operations, each marked read-only by
 * Prime: list_guardrails and search_guardrail_findings through call_prime_operation, and the
 * named tools search_repositories and get_repository_by_id. The token comes from PRIME_PAT_TOKEN
 * or the file ~/.config/prime-security/token, and is sent only as a Bearer header to that host.
 * It is never printed, and no message the script prints holds it. HARNESS_PRIME_ORIGIN, for the
 * suite only, moves the host to a loopback address and nowhere else.
 *
 * The script prints counts, ids and titles, never a rule: the rules go to the files in --out. The
 * whole stack in full is about 3,000 tokens for a repository with no AI or cloud component.
 * check-dev-ready.js carries the same `Guardrails:` grammar; the two are kept in step by hand.
 *
 * Exit: 0 done · 1 verified and failed (an unknown g-number, a malformed line) · 2 cannot verify (no token, Prime does not answer, Prime holds no such
 * repository) · 3 usage · 4 internal. The harness treats exit 2 as `Guardrails: unchecked` and
 * goes on: Prime never stops a sprint.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXIT, REPO_ID, readRegistry, reasonLine, registryPath, validateRegistry } from './spoke-remote.mjs';
import { parseRemote } from './pull-request.mjs';

export const ORIGIN = 'https://api.primesec.ai';
const PROTOCOL = '2025-06-18';
const TIMEOUT_MS = 30000;
const MAX_PAGES = 50;

/** The design's line, as check-dev-ready.js reads it. */
export const LINE = /^Guardrails:[ \t]*(\S.*?)\s*$/;
export const WORDS = ['off', 'none', 'unchecked'];
export const CITE = /^prime@([0-9a-f]{12}):(.+)$/;
export const GUARDRAIL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const G_NUMBER = /^g[1-9]\d*$/;

/** The stack a repository can have, beside the core that every repository has. */
export const STACKS = ['core', 'llm', 'aws', 'gcp', 'azure'];
const STACK_NAMES = { core: 'core', llm: 'OWASP LLM', aws: 'CIS AWS', gcp: 'CIS GCP', azure: 'CIS Azure' };

/** `reason` is a token of spoke-remote.mjs's REASONS for an error that cannot verify, or null. */
class PrimeError extends Error {
  constructor(exit, message, reason = null) { super(message); this.exit = exit; this.reason = reason; }
}
const usage = (m) => new PrimeError(EXIT.USAGE, m);
const fail = (m) => new PrimeError(EXIT.FAIL, m);
const cannot = (m, reason = null) => new PrimeError(EXIT.CANNOT_VERIFY, m, reason);

/* ----------------------------------------------------------------------- arguments */

const ALLOWED = {
  list: ['repo-id', 'out', 'stack'],
  choose: ['out', 'pick'],
  refresh: ['design', 'out', 'since'],
  severity: ['repo-id', 'pr', 'out'],
  history: ['repo-id', 'out', 'designs'],
};
// A design's file name in the hub: the work item's key, then `.lld.md`.
const DESIGN_FILE = /^[A-Z][A-Z0-9]{1,9}-\d+\.lld\.md$/;
// The earlier pull requests that history reads: the newest ones that hold a finding.
const HISTORY_REVIEWS = 10;
// The examples that history keeps for one guardrail: Prime's own sentences, each with its file.
const HISTORY_EXAMPLES = 3;
// Prime's ratings of an issue, lowest first. pull-request.mjs carries the same list.
export const SEVERITY_LEVELS = ['INFO', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];


export function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!ALLOWED[command]) throw usage(`the command is list, choose, refresh, severity or history, not "${command ?? ''}"`);
  const o = {};
  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i];
    if (!flag.startsWith('--')) throw usage(`"${flag}" is not an option`);
    const name = flag.slice(2);
    if (!ALLOWED[command].includes(name)) throw usage(`${command} takes ${ALLOWED[command].map((k) => `--${k}`).join(', ')}, not ${flag}`);
    const value = rest[i + 1];
    if (value === undefined || value.startsWith('--')) throw usage(`${flag} needs a value`);
    if (name in o) throw usage(`${flag} is given twice`);
    o[name] = value;
    i += 1;
  }
  if (!o.out) throw usage(`${command} needs --out <dir>`);
  if (command === 'list') {
    if (!o['repo-id'] || o['repo-id'].search(REPO_ID) !== 0) throw usage('list needs --repo-id <the spoke\'s id in docs/estate/repositories.json>');
    if ('stack' in o) {
      const parts = splitList(o.stack);
      const bad = parts.filter((p) => !STACKS.includes(p));
      if (!parts.length || bad.length) throw usage(`--stack takes ${STACKS.join(', ')}, joined by commas${bad.length ? `, not ${bad.join(', ')}` : ''}`);
      o.stack = ['core', ...STACKS.filter((s) => s !== 'core' && parts.includes(s))];
    }
  }
  if (command === 'severity') {
    if (!o['repo-id'] || o['repo-id'].search(REPO_ID) !== 0) throw usage('severity needs --repo-id <the spoke\'s id in docs/estate/repositories.json>');
    if (!o.pr || o.pr.search(/^[1-9]\d*$/) !== 0) throw usage('severity needs --pr <the pull request\'s number>');
  }
  if (command === 'history' && (!o['repo-id'] || o['repo-id'].search(REPO_ID) !== 0)) throw usage('history needs --repo-id <the spoke\'s id in docs/estate/repositories.json>');
  if (command === 'history' && 'designs' in o && !(existsSync(o.designs) && statSync(o.designs).isDirectory())) throw usage(`--designs ${o.designs} is not a folder: name the hub's design folder, docs/designs`);
  if (command === 'choose') {
    if (!o.pick) throw usage('choose needs --pick g3,g7, or --pick none');
    o.pick = o.pick === 'none' ? [] : splitList(o.pick);
    const bad = o.pick.filter((g) => g.search(G_NUMBER) !== 0);
    if (bad.length) throw usage(`--pick takes g-numbers joined by commas, or none, not ${bad.join(', ')}`);
    if (new Set(o.pick).size !== o.pick.length) throw usage('--pick names one guardrail twice');
  }
  if (command === 'refresh') {
    if (!o.design) throw usage('refresh needs --design <the design file>');
    if ('since' in o && Number.isNaN(Date.parse(o.since))) throw usage(`--since "${o.since}" is not a date`);
  }
  return { command, o };
}

const splitList = (text) => text.split(',').map((x) => x.trim()).filter(Boolean);

/* ------------------------------------------------------------------- the token */

/** The token, from the environment or the file. Never printed. */
export function readToken(env = process.env) {
  const fromEnv = (env.PRIME_PAT_TOKEN || '').trim();
  if (fromEnv) return fromEnv;
  const file = join(env.HOME || homedir(), '.config', 'prime-security', 'token');
  if (existsSync(file)) {
    const t = readFileSync(file, 'utf8').trim();
    if (t) return t;
  }
  throw cannot('no Prime token: set PRIME_PAT_TOKEN, or write the token to ~/.config/prime-security/token', 'credential-missing');
}

/** The host to call. Only the suite moves it, and only to a loopback address. */
export function origin(env = process.env) {
  const o = env.HARNESS_PRIME_ORIGIN;
  if (!o) return ORIGIN;
  if (o.search(/^http:\/\/(?:127\.0\.0\.1|localhost):\d{1,5}$/) !== 0) {
    throw usage(`HARNESS_PRIME_ORIGIN "${o}" is not a loopback address: it exists for the suite only, and the token is never sent anywhere else`);
  }
  return o;
}

/* ---------------------------------------------------------------- the two routes */

/** One client: each operation goes to MCP first, and to REST with the same token when MCP fails. */
export function client(token, base) {
  const scrub = (text) => String(text).split(token).join('<token>');
  const headers = { Authorization: `Bearer ${token}` };
  const via = new Set();
  let mcpSession = null;
  let mcpReady = null;
  let mcpDown = null;
  let nextId = 1;

  async function http(method, path, body, extra = {}) {
    let res;
    try {
      res = await fetch(base + path, {
        method, redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { ...headers, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}), ...extra },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      throw new Error(scrub(`${method} ${path}: ${err && err.cause && err.cause.code ? err.cause.code : err.message}`));
    }
    const text = await res.text();
    if (!res.ok) throw new Error(scrub(`${method} ${path}: HTTP ${res.status} ${text.slice(0, 200)}`));
    return { res, text };
  }

  async function rpc(method, params, notify = false) {
    const id = notify ? undefined : nextId++;
    const body = { jsonrpc: '2.0', method, ...(params ? { params } : {}), ...(notify ? {} : { id }) };
    const { res, text } = await http('POST', '/mcp', body, {
      Accept: 'application/json, text/event-stream',
      ...(mcpSession ? { 'Mcp-Session-Id': mcpSession } : {}),
      ...(method !== 'initialize' ? { 'MCP-Protocol-Version': PROTOCOL } : {}),
    });
    mcpSession = res.headers.get('mcp-session-id') || mcpSession;
    if (notify || !text.trim()) return null;
    let msg;
    try {
      msg = (res.headers.get('content-type') || '').includes('text/event-stream')
        ? text.split('\n').filter((l) => l.startsWith('data:')).map((l) => JSON.parse(l.slice(5))).find((m) => m.id === id)
        : JSON.parse(text);
    } catch { throw new Error(`MCP ${method}: the answer is not JSON`); }
    if (!msg) throw new Error(`MCP ${method}: no answer to request ${id}`);
    if (msg.error) throw new Error(scrub(`MCP ${method}: error ${msg.error.code} ${msg.error.message}`));
    return msg.result;
  }

  async function tool(name, args) {
    // A server that fails to start a session is not asked again in this run: every later
    // operation goes to REST at once, instead of waiting for MCP each time.
    if (mcpDown) throw mcpDown;
    if (!mcpReady) {
      mcpReady = rpc('initialize', { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'shl-harness-prime', version: '1' } })
        .then(() => rpc('notifications/initialized', null, true))
        .catch((err) => { mcpDown = err; throw err; });
    }
    await mcpReady;
    const result = await rpc('tools/call', { name, arguments: args });
    if (!result) throw new Error(`MCP ${name}: an empty answer`);
    const text = (result.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    if (result.isError) throw new Error(scrub(`MCP ${name}: ${text.slice(0, 200)}`));
    if (result.structuredContent) return result.structuredContent;
    try { return JSON.parse(text); } catch { throw new Error(`MCP ${name}: the answer is not JSON`); }
  }

  async function both(label, viaMcp, viaRest) {
    let mcpError;
    try {
      const out = await viaMcp();
      via.add('mcp');
      return out;
    } catch (err) { mcpError = err; }
    try {
      const out = await viaRest();
      via.add('rest');
      return out;
    } catch (err) {
      throw cannot(`Prime did not answer ${label}: over MCP, ${mcpError.message}; over REST, ${err.message}`);
    }
  }

  const json = (text, label) => { try { return JSON.parse(text); } catch { throw new Error(`${label}: the answer is not JSON`); } };

  // The next page starts after the rows Prime sent, not after the rows asked for: Prime may send
  // fewer than the limit and still have more.
  async function pages(label, fetchPage) {
    const out = [];
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const body = await fetchPage(out.length);
      const rows = Array.isArray(body && body.results) ? body.results : null;
      if (!rows) throw new Error(`${label}: the answer holds no results`);
      out.push(...rows);
      if (!body.has_next || rows.length === 0) return out;
    }
    throw new Error(`${label}: more than ${MAX_PAGES} pages`);
  }

  return {
    via: () => [...via].join('+') || 'none',
    guardrails: () => both('the guardrail list',
      () => pages('list_guardrails', (offset) => tool('call_prime_operation', { name: 'list_guardrails', arguments: { limit: 100, offset } })),
      () => pages('GET /guardrails', async (offset) => json((await http('GET', `/guardrails?limit=100&offset=${offset}`)).text, 'GET /guardrails'))),
    findings: (repositoryId) => both('the findings search',
      () => pages('search_guardrail_findings', (offset) => tool('call_prime_operation', { name: 'search_guardrail_findings', arguments: { filter: { repository_ids: [repositoryId] }, limit: 500, offset } })),
      () => pages('the findings search', async (offset) => json((await http('POST', '/code-management/findings/guardrails/search', { filter: { repository_ids: [repositoryId] }, limit: 500, offset })).text, 'the findings search'))),
    repositories: (owner, repo) => both('the repository search',
      () => pages('search_repositories', (offset) => tool('search_repositories', { filter: { org_name: [owner], repo_name: [repo], enabled: null }, limit: 100, offset })),
      () => pages('GET /code-management/repositories', async (offset) => json((await http('GET', `/code-management/repositories?include_disabled=true&limit=100&offset=${offset}`)).text, 'the repository list'))),
    repository: (id) => both('the repository',
      () => tool('get_repository_by_id', { repository_id: id }),
      async () => json((await http('GET', `/code-management/repositories/${id}`)).text, 'the repository')),
    // Prime's reviews of one pull request, and the full record of each guardrail issue in them.
    // With `pr` null: the reviews of the repository's pull requests, the `newest` ones that hold a
    // guardrail issue. Each issue then carries `pr_number`, the pull request it was raised on.
    // REST only: the search, each review, then each issue, which alone holds the file and the sentence.
    reviews: async (repositoryId, pr, newest = null) => {
      const what = pr === null ? 'the reviews of the repository\'s pull requests' : `the reviews of pull request ${pr}`;
      try {
        const filter = pr === null ? { repository_ids: [repositoryId] } : { repository_ids: [repositoryId], pr_number: [pr] };
        let found = await pages('the review search', async (offset) => json((await http('POST', '/code-management/pr-reviews/search', { filter, limit: 100, offset })).text, 'the review search'));
        if (newest !== null) {
          const holds = (r) => (Array.isArray(r.guardrail_issues) ? r.guardrail_issues.length : Number(r.guardrail_issues_count) || 0) > 0;
          found = found.filter(holds).sort((a, b) => (Number(b.pr_number) || 0) - (Number(a.pr_number) || 0)).slice(0, newest);
        }
        const issues = [];
        for (const r of found) {
          const review = json((await http('GET', `/code-management/pr-reviews/${r.id}`)).text, 'the review');
          for (const g of Array.isArray(review.guardrail_issues) ? review.guardrail_issues : []) {
            issues.push({ ...json((await http('GET', `/code-management/findings/guardrails/${g.id}`)).text, 'the issue'), pr_number: Number(r.pr_number) || null });
          }
        }
        via.add('rest');
        return { reviews: found.length, issues };
      } catch (err) {
        throw cannot(`Prime did not answer ${what}: ${err.message}`);
      }
    },
  };
}

/* ---------------------------------------------------------------- the guardrails */

/** The group a guardrail is in, and the stack that group belongs to. */
export function groupOf(g) {
  if (g.guardrail_type === 'POLICY') return { group: 'Company policy', stack: 'core' };
  const f = String(g.framework || '');
  if (f === 'OWASP_ASVS') return { group: 'OWASP ASVS', stack: 'core' };
  if (f === 'OWASP_LLM') return { group: 'OWASP LLM', stack: 'llm' };
  if (f === 'CIS_AWS') return { group: 'CIS AWS', stack: 'aws' };
  if (f === 'CIS_GCP') return { group: 'CIS GCP', stack: 'gcp' };
  if (f === 'CIS_AZURE') return { group: 'CIS Azure', stack: 'azure' };
  // A group Prime adds later is listed with the core, so no guardrail drops out of sight.
  return { group: f ? f.replace(/_/g, ' ') : 'Other', stack: 'core' };
}

/** A title as a finding and a guardrail can both spell it: Prime renames "Attributes" to "Attribute". */
export function titleKey(title) {
  return String(title || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(Boolean)
    .map((w) => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w)).join(' ');
}

/** The stack Prime's summary of the repository shows: its data-flow components. */
export function stackOf(repository) {
  const nodes = (repository && repository.data_flow && Array.isArray(repository.data_flow.nodes)) ? repository.data_flow.nodes : [];
  const found = new Set(['core']);
  for (const n of nodes) {
    const label = String(n.label || '');
    if (n.resource_category_type === 'ai') found.add('llm');
    if (label.search(/\b(?:aws|amazon)\b/i) !== -1) found.add('aws');
    if (label.search(/\b(?:gcp|google cloud)\b/i) !== -1) found.add('gcp');
    if (label.search(/\bazure\b/i) !== -1) found.add('azure');
  }
  return STACKS.filter((s) => found.has(s));
}

/** The fingerprint of a set of rules: the first 12 hex of SHA-256 over id, title and rule, sorted by id. */
export function fingerprint(rules) {
  const h = createHash('sha256');
  for (const r of [...rules].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) h.update(`${r.id}\n${r.title}\n${r.rule}\n`);
  return h.digest('hex').slice(0, 12);
}

const entryOf = (g) => ({ id: String(g.external_id), title: String(g.guardrail_title || ''), rule: String(g.guardrail || ''),
  category: String(g.category || 'Uncategorised'), updated: g.updated_at || null, ...groupOf(g) });

/** The guardrail list: every guardrail of the stack in full, those broken here first; the rest counted. */
export function buildList(guardrails, findings, stack) {
  const all = guardrails.map(entryOf).filter((e) => e.id.search(GUARDRAIL_ID) === 0);
  const byKey = new Map();
  for (const e of all) byKey.set(titleKey(e.title), [...(byKey.get(titleKey(e.title)) || []), e]);
  const count = new Map();
  const unmatched = new Map();
  for (const f of findings) {
    if (String(f.status || 'open').toLowerCase() !== 'open') continue;
    const hits = byKey.get(titleKey(f.guardrail_title));
    if (!hits) { unmatched.set(f.guardrail_title, (unmatched.get(f.guardrail_title) || 0) + 1); continue; }
    for (const e of hits) count.set(e.id, (count.get(e.id) || 0) + 1);
  }
  const order = (a, b) => (a.group + a.category + a.title + a.id).localeCompare(b.group + b.category + b.title + b.id);
  // A guardrail Prime found broken here is listed whatever its group: the finding shows it applies.
  const broken = all.filter((e) => count.has(e.id)).sort(order);
  const rest = all.filter((e) => !count.has(e.id) && stack.includes(e.stack)).sort(order);
  const outside = {};
  for (const e of all) if (!count.has(e.id) && !stack.includes(e.stack)) outside[e.group] = (outside[e.group] || 0) + 1;
  let n = 0;
  const entries = [...broken, ...rest].map((e) => ({ g: `g${++n}`, ...e, findings: count.get(e.id) || 0 }));
  return { entries, outside, unmatched: Object.fromEntries(unmatched) };
}

export function renderList(meta, list) {
  const lines = [
    `# Prime guardrails for ${meta.repoId}`,
    '',
    `Prime repository ${meta.prime.org}/${meta.prime.repo} (id ${meta.prime.id}) · stack: ${meta.stack.map((s) => STACK_NAMES[s]).join(', ')} · read ${meta.read}`,
    `${list.entries.length} guardrails listed, each with its full rule: ${list.entries.filter((e) => e.findings).length} that Prime found broken here, then the rest of the stack.`,
    'Prime reviews every pull request against every one of them. The design applies each one its code touches, by its g-number.',
    '',
    '## Broken in this repository',
    '',
  ];
  const broken = list.entries.filter((e) => e.findings);
  if (!broken.length) lines.push('None: Prime has no open finding in this repository.', '');
  // One line each, so the whole stack stays short enough to read in one pass.
  for (const e of broken) lines.push(`- **${e.g} · ${e.title}** (${e.group}, ${e.findings} open) — ${e.rule}`);
  if (broken.length) lines.push('');
  lines.push('## The rest of the stack, by category');
  let last = '';
  for (const e of list.entries.filter((x) => !x.findings)) {
    const head = `${e.group} · ${e.category}`;
    if (head !== last) { lines.push('', `### ${head}`); last = head; }
    lines.push(`- **${e.g} · ${e.title}** — ${e.rule}`);
  }
  const out = Object.entries(list.outside);
  lines.push('', '## Outside the stack', '',
    out.length ? `${out.map(([g, k]) => `${g} ${k}`).join(' · ')}. Not listed, because Prime's summary of this repository shows no such component.` : 'Nothing: every group is in the stack.');
  const um = Object.entries(list.unmatched);
  if (um.length) lines.push('', `Findings whose title matches no guardrail: ${um.map(([t, k]) => `${t} (${k})`).join(', ')}.`);
  return `${lines.join('\n')}\n`;
}

export function renderRules(heading, rules, note) {
  const lines = [`# ${heading}`, '', note, ''];
  for (const r of rules) lines.push(`## ${r.g ? `${r.g} · ` : ''}${r.title}`, `Prime id ${r.id} · ${r.group} · ${r.category}`, '', r.rule, '');
  return `${lines.join('\n')}\n`;
}

/* ------------------------------------------------------------------- the commands */

const out = (line) => process.stdout.write(`${line}\n`);

function writeOut(dir, name, text) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), text);
  return join(dir, name);
}

function readSaved(dir) {
  const file = join(dir, 'list.json');
  if (!existsSync(file)) throw usage(`${file} does not exist: run prime.mjs list --repo-id <id> --out ${dir} first`);
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { throw fail(`${file} is not the JSON prime.mjs list writes`); }
}

function pickFrom(saved, picks) {
  const byG = new Map(saved.entries.map((e) => [e.g, e]));
  const unknown = picks.filter((g) => !byG.has(g));
  if (unknown.length) throw fail(`${unknown.join(', ')} ${unknown.length === 1 ? 'is' : 'are'} not on the guardrail list in ${saved.dir}, which runs from g1 to g${saved.entries.length}`);
  return picks.map((g) => byG.get(g));
}

/** The registry's url for one spoke id, and the one repository Prime holds under that name. */
async function primeRepository(prime, repoId) {
  const regPath = registryPath();
  let registry;
  try { registry = readRegistry(regPath); } catch (err) { throw new PrimeError(err.exit ?? EXIT.CANNOT_VERIFY, err.message); }
  const problems = validateRegistry(registry, regPath);
  if (problems.length) throw fail(`the registry is not well formed; run check-registry first:\n  - ${problems.join('\n  - ')}`);
  const entry = registry.repositories[repoId];
  if (!entry) throw usage(`"${repoId}" is not in ${regPath}`);
  const remote = parseRemote(entry.url);
  if (!remote) throw cannot(`the registry url "${entry.url}" names no owner and repository`, 'registry-invalid');
  const repos = (await prime.repositories(remote.owner, remote.repo))
    .filter((r) => String(r.org_name).toLowerCase() === remote.owner.toLowerCase() && String(r.repo_name).toLowerCase() === remote.repo.toLowerCase());
  if (repos.length !== 1) throw cannot(repos.length ? `Prime holds ${repos.length} repositories named ${remote.owner}/${remote.repo}` : `Prime holds no repository ${remote.owner}/${remote.repo}: it may not be connected to Prime yet`);
  return repos[0];
}

async function cmdList(o, env) {
  const prime = client(readToken(env), origin(env));
  const pr = await primeRepository(prime, o['repo-id']);
  const [guardrails, findings, detail] = await Promise.all([prime.guardrails(), prime.findings(pr.id), o.stack ? null : prime.repository(pr.id)]);
  const stack = o.stack || stackOf(detail);
  const list = buildList(guardrails, findings, stack);
  const meta = { repoId: o['repo-id'], prime: { id: pr.id, org: pr.org_name, repo: pr.repo_name }, stack, read: new Date().toISOString(), stackFrom: o.stack ? 'PRIME_STACK' : 'Prime' };
  writeOut(o.out, 'list.json', `${JSON.stringify({ ...meta, entries: list.entries, outside: list.outside }, null, 2)}\n`);
  const file = writeOut(o.out, 'guardrail-list.md', renderList(meta, list));
  out(`PRIME LIST ${o['repo-id']} · Prime repository ${pr.org_name}/${pr.repo_name} (${pr.id}) · stack ${stack.map((s) => STACK_NAMES[s]).join(', ')} from ${meta.stackFrom}`);
  out(`listed=${list.entries.length} broken=${list.entries.filter((e) => e.findings).length} outside=${Object.values(list.outside).reduce((a, b) => a + b, 0)} via=${prime.via()}`);
  // The title of the last rule: only a seat that received the end of the list can name it.
  const last = list.entries[list.entries.length - 1];
  if (last) out(`last=${last.g} · ${last.title}`);
  out(`wrote ${file}`);
  return EXIT.PASS;
}

/**
 * The rating Prime gave each issue of its reviews of one pull request, for pull-request.mjs to join
 * to the threads: the guardrail's title, the file, the line and the sentence of Prime's comment.
 */
async function cmdSeverity(o, env) {
  const prime = client(readToken(env), origin(env));
  const repo = await primeRepository(prime, o['repo-id']);
  const read = await prime.reviews(repo.id, Number(o.pr));
  const issues = [];
  for (const g of read.issues) {
    const severity = String(g.severity || '').toUpperCase();
    if (!SEVERITY_LEVELS.includes(severity)) continue;
    issues.push({ title: String(g.guardrail_title || g.title || ''), path: String(g.path || ''), line: Number.isInteger(g.start_line) ? g.start_line : null, text: String(g.comment || ''), severity });
  }
  const file = writeOut(o.out, 'prime-severity.json', `${JSON.stringify({ repoId: o['repo-id'], pr: Number(o.pr), read: new Date().toISOString(), issues }, null, 2)}\n`);
  const count = (level) => issues.filter((i) => i.severity === level).length;
  out(`PRIME SEVERITY ${o['repo-id']} #${o.pr} · reviews=${read.reviews} issues=${issues.length} · ${[...SEVERITY_LEVELS].reverse().map((l) => `${l.toLowerCase()}=${count(l)}`).join(' ')} via=${prime.via()}`);
  out(`wrote ${file}`);
  return EXIT.PASS;
}

/**
 * What Prime raised on the repository's earlier pull requests, one entry for each guardrail: the
 * pull requests, the count, and Prime's own sentences with their files. `entries` is the saved
 * guardrail list where one exists, and gives each entry its g-number.
 */
export function buildHistory(issues, entries = []) {
  const gOf = new Map(entries.map((e) => [titleKey(e.title), e.g]));
  const byTitle = new Map();
  for (const i of issues) {
    const title = String(i.guardrail_title || i.title || '').trim();
    if (!title) continue;
    const key = titleKey(title);
    const h = byTitle.get(key) || { title, g: gOf.get(key) || null, count: 0, prs: new Set(), examples: [] };
    h.count += 1;
    if (i.pr_number) h.prs.add(i.pr_number);
    const text = String(i.comment || '').replace(/\s+/g, ' ').trim();
    const path = String(i.path || '');
    if (text && !h.examples.some((x) => x.path === path && x.text === text)) {
      h.examples.push({ pr: i.pr_number || null, path, line: Number.isInteger(i.start_line) ? i.start_line : null, text, severity: SEVERITY_LEVELS.includes(String(i.severity || '').toUpperCase()) ? String(i.severity).toUpperCase() : null });
    }
    byTitle.set(key, h);
  }
  return [...byTitle.values()].map((h) => ({ ...h, prs: [...h.prs].sort((a, b) => b - a) }))
    .sort((a, b) => b.prs.length - a.prs.length || b.count - a.count || a.title.localeCompare(b.title));
}

export function renderHistory(meta, history) {
  const lines = [
    `# What Prime raised on ${meta.repoId} before`,
    '',
    `Prime repository ${meta.prime.org}/${meta.prime.repo} (id ${meta.prime.id}) · read ${meta.read}`,
    `${history.reduce((n, h) => n + h.count, 0)} findings under ${history.length} guardrails, on the newest ${meta.reviews} pull requests that hold a finding.`,
    'Each sentence is Prime\'s own, about this repository\'s code. Prime reads the next pull request in the same way.',
    'A design, or a change, that touches the same kind of code meets the rule, or holds a person\'s recorded answer.',
    '',
  ];
  if (!history.length) lines.push('Nothing: Prime raised no guardrail finding on a pull request of this repository.');
  for (const h of history) {
    lines.push(`## ${h.g ? `${h.g} · ` : ''}${h.title}`, `${h.count} ${h.count === 1 ? 'finding' : 'findings'} · pull ${h.prs.length === 1 ? 'request' : 'requests'} ${h.prs.map((n) => `#${n}`).join(', ') || 'unknown'}${h.g ? '' : ' · not on the guardrail list'}`, '');
    for (const x of h.examples.slice(0, HISTORY_EXAMPLES)) lines.push(`- ${x.pr ? `#${x.pr} · ` : ''}${x.severity ? `${x.severity} · ` : ''}\`${x.path}${x.line === null ? '' : `:${x.line}`}\` — ${x.text}`);
    if (h.examples.length > HISTORY_EXAMPLES) lines.push(`- and ${h.examples.length - HISTORY_EXAMPLES} more, in other places`);
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

/** The lines of a design that a person reads: none inside a code fence or an HTML comment. */
function visibleLines(text) {
  const kept = [];
  let fence = null;
  for (const line of String(text).replace(/<!--[\s\S]*?-->/g, '').split(/\r?\n/)) {
    const f = line.match(/^\s*(`{3,}|~{3,})/);
    if (f) { if (!fence) fence = f[1][0]; else if (f[1][0] === fence) fence = null; continue; }
    if (!fence) kept.push(line);
  }
  return kept;
}

/** The cells of one table row. Null for a line that is no row, and for the rule under a header. */
function cells(line) {
  const t = line.trim().replace(/\\\|/g, '\u0000');
  if (!t.startsWith('|')) return null;
  const parts = t.split('|').slice(1);
  if (t.endsWith('|')) parts.pop();
  const row = parts.map((c) => c.replace(/\u0000/g, '|').trim());
  return row.every((c) => c.search(/^:?-{3,}:?$/) === 0) ? null : row;
}

/** The rows of one numbered section of a design, `## <n>. …`, without the header row. */
function sectionRows(lines, n) {
  const start = lines.findIndex((l) => l.startsWith(`## ${n}. `));
  if (start < 0) return [];
  const rows = [];
  for (const l of lines.slice(start + 1)) {
    if (l.startsWith('## ')) break;
    const row = cells(l);
    if (row) rows.push(row);
  }
  return rows.slice(1);
}

/**
 * What one design recorded for Prime's rules. An answer is a `Closed` row of §9 whose Source is
 * `Prime <g-number> <title>`. A decision is a row of §10 whose first cell after the number opens
 * `Prime <g-number> <title> — `. A design of another repository gives nothing.
 */
export function designRecords(key, text, repoId) {
  const lines = visibleLines(text);
  if (!lines.some((l) => l.trim() === `Repository: ${repoId}`)) return [];
  const bare = (c) => c.replace(/`/g, '').trim();
  const records = [];
  for (const c of sectionRows(lines, 9)) {
    if (c.length !== 8 || !bare(c[2]).startsWith('Prime ') || c[5] !== 'Closed') continue;
    records.push({ key, kind: 'answer', rule: bare(c[2]), id: c[0], question: c[1], said: c[6], why: null, date: c[7] });
  }
  for (const c of sectionRows(lines, 10)) {
    const at = c.length === 5 ? bare(c[1]).indexOf(' — ') : -1;
    if (at < 0 || !bare(c[1]).startsWith('Prime ')) continue;
    records.push({ key, kind: 'decision', rule: bare(c[1]).slice(0, at), id: c[0], question: null, said: bare(c[1]).slice(at + 3), why: c[3], date: c[4] });
  }
  return records;
}

/** Every record of the designs in `dir` for one repository, the newest design first. */
function recordsIn(dir, repoId) {
  const number = (name) => Number(name.match(/-(\d+)\./)[1]);
  return readdirSync(dir).filter((name) => name.search(DESIGN_FILE) === 0).sort((a, b) => number(b) - number(a) || a.localeCompare(b))
    .flatMap((name) => designRecords(name.replace(/\.lld\.md$/, ''), readFileSync(join(dir, name), 'utf8'), repoId));
}

export function renderRecords(meta, records) {
  const designs = new Set(records.map((r) => r.key)).size;
  const lines = [
    `# What this hub's designs recorded for Prime's rules on ${meta.repoId}`,
    '',
    `${records.length} ${records.length === 1 ? 'entry' : 'entries'} from ${designs} ${designs === 1 ? 'design' : 'designs'} under ${meta.designs}.`,
    'An answer is a person\'s own, for the role that the entry names. A decision is what the fixes of a pull request did.',
    'A design that meets the same question on the same code names the entry. Its question to a person gives that answer as the recommended choice.',
    '',
  ];
  if (!records.length) lines.push('Nothing: no design of this repository records an answer or a decision for a Prime rule.', '');
  const rules = [...new Set(records.map((r) => r.rule))];
  for (const rule of rules) {
    lines.push(`## ${rule}`, '');
    for (const r of records.filter((x) => x.rule === rule)) {
      lines.push(r.kind === 'answer'
        ? `- ${r.key} · answer ${r.id} · ${r.date} — ${r.question} Answer: ${r.said}`
        : `- ${r.key} · decision ${r.id} · ${r.date} — ${r.said}${r.why ? ` Why: ${r.why}` : ''}`);
    }
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

async function cmdHistory(o, env) {
  const prime = client(readToken(env), origin(env));
  const repo = await primeRepository(prime, o['repo-id']);
  const read = await prime.reviews(repo.id, null, HISTORY_REVIEWS);
  const saved = existsSync(join(o.out, 'list.json')) ? readSaved(o.out) : { entries: [] };
  const history = buildHistory(read.issues, Array.isArray(saved.entries) ? saved.entries : []);
  const meta = { repoId: o['repo-id'], prime: { id: repo.id, org: repo.org_name, repo: repo.repo_name }, read: new Date().toISOString(), reviews: read.reviews, designs: o.designs || null };
  const records = o.designs ? recordsIn(o.designs, o['repo-id']) : null;
  const file = writeOut(o.out, 'prime-history.md', `${renderHistory(meta, history)}${records ? renderRecords(meta, records) : ''}`);
  out(`PRIME HISTORY ${o['repo-id']} · pull requests=${read.reviews} findings=${read.issues.length} guardrails=${history.length}${records ? ` recorded=${records.length}` : ''} via=${prime.via()}`);
  out(`wrote ${file}`);
  return EXIT.PASS;
}

/** The current rule of each id, from Prime. Missing ids are returned apart. */
async function currentRules(env, ids) {
  const prime = client(readToken(env), origin(env));
  const byId = new Map((await prime.guardrails()).map(entryOf).map((e) => [e.id, e]));
  return { found: ids.filter((id) => byId.has(id)).map((id) => byId.get(id)), missing: ids.filter((id) => !byId.has(id)), via: prime.via() };
}

async function cmdChoose(o, env) {
  const saved = { ...readSaved(o.out), dir: o.out };
  if (!o.pick.length) {
    out('Guardrails: none');
    return EXIT.PASS;
  }
  // The saved list holds the full rule of every guardrail, so choose asks Prime nothing and needs
  // no token: the writer may run it. A rule Prime changes later is refresh's to report.
  const rules = pickFrom(saved, o.pick);
  const fp = fingerprint(rules);
  const file = writeOut(o.out, 'chosen.md', renderRules(`Chosen Prime guardrails for ${saved.repoId}`, rules,
    `From the guardrail list read ${saved.read} · fingerprint ${fp}. Prime was not asked again. These are the rules the design applies.`));
  out(`CHOSEN ${rules.map((r) => `${r.g} ${r.title}`).join(' · ')} · wrote ${file}`);
  out(`Guardrails: prime@${fp}:${rules.map((r) => r.id).join(', ')}`);
  return EXIT.PASS;
}

/** The design's Guardrails: lines, outside code fences. */
export function designLines(text) {
  const found = [];
  let fence = null;
  text.split(/\r?\n/).forEach((line, i) => {
    const f = line.match(/^\s*(`{3,}|~{3,})/);
    if (f) { if (!fence) fence = f[1][0]; else if (f[1][0] === fence) fence = null; return; }
    if (fence) return;
    const m = line.match(LINE);
    if (m) found.push({ no: i + 1, value: m[1] });
  });
  return found;
}

/** The value of a Guardrails: line, read as check-dev-ready.js reads it. */
export function parseLine(value) {
  if (WORDS.includes(value)) return { word: value };
  const cite = value.match(CITE);
  if (!cite) return null;
  const ids = cite[2].split(', ');
  if (ids.some((id) => id.search(GUARDRAIL_ID) !== 0) || new Set(ids).size !== ids.length) return null;
  return { fp: cite[1], ids };
}

async function cmdRefresh(o, env) {
  if (!existsSync(o.design)) throw usage(`${o.design} does not exist`);
  const lines = designLines(readFileSync(o.design, 'utf8'));
  if (lines.length > 1) throw fail(`${o.design} carries ${lines.length} Guardrails: lines (${lines.map((l) => `line ${l.no}`).join(', ')}); a design chooses its guardrails once`);
  if (!lines.length) { out('guardrails=off · the design has no Guardrails: line'); return EXIT.PASS; }
  const { value, no } = lines[0];
  const line = parseLine(value);
  if (!line) throw fail(`${o.design} line ${no}: "Guardrails: ${value}" is not off, none, unchecked or prime@<12-hex>:<id>, <id>`);
  if (line.word) {
    out(`guardrails=${line.word} · ${{ off: 'Prime is off for this repository', none: 'the design chose no guardrail', unchecked: 'Prime did not answer when the design was written: the guardrails were not checked' }[line.word]}`);
    return EXIT.PASS;
  }
  const { found, missing, via } = await currentRules(env, line.ids);
  const fp = fingerprint(found);
  const same = !missing.length && fp === line.fp;
  const file = writeOut(o.out, 'chosen.md', renderRules(`Chosen Prime guardrails, read again for ${o.design}`, found,
    `Read from Prime ${new Date().toISOString()} · fingerprint ${fp}; the design's is ${line.fp}. These are the rules this run applies.`));
  for (const id of missing) out(`MISSING ${id} · Prime no longer holds this guardrail`);
  if (!same) {
    // The fingerprint says that a rule changed, not which one. Prime dates each rule, so the
    // rules dated after the design's merge are the ones to name.
    const since = o.since ? Date.parse(o.since) : null;
    const moved = since === null ? [] : found.filter((r) => r.updated && Date.parse(r.updated) > since);
    for (const r of moved) out(`CHANGED ${r.id} · ${r.title} · updated ${r.updated}`);
    if (!moved.length && !missing.length) {
      out(since === null ? 'CHANGED · the fingerprint differs: pass --since <the design\'s merge date> to name the rule'
        : `CHANGED · the fingerprint differs, and no chosen rule is dated after ${o.since}`);
    }
  }
  out(`guardrails=${same ? 'current' : 'changed'} · ${found.length} of ${line.ids.length} read · fingerprint ${fp}, the design's ${line.fp} · via=${via}`);
  out(`wrote ${file}`);
  return EXIT.PASS;
}

export async function main(argv, env = process.env) {
  const { command, o } = parseArgs(argv);
  if (command === 'list') return cmdList(o, env);
  if (command === 'choose') return cmdChoose(o, env);
  if (command === 'severity') return cmdSeverity(o, env);
  if (command === 'history') return cmdHistory(o, env);
  return cmdRefresh(o, env);
}

const invoked = (() => { try { return realpathSync(process.argv[1] || '') === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })();
if (invoked) {
  // The last line of an exit 2, 3 or 4 names this script and its code, so a shell line that hides
  // the code, with a pipe or `; echo`, still tells the harness's failure record. Written at once,
  // so a process.exit() never loses it.
  process.on('exit', (code) => { if (code >= 2 && code <= 4) { try { writeSync(2, `HARNESS EXIT: prime ${code}\n`); } catch { /* stderr is closed */ } } });
  main(process.argv.slice(2)).then((code) => process.exit(code), (err) => {
    let token = '';
    try { token = readToken(); } catch { /* no token: nothing to scrub */ }
    const scrub = (t) => (token ? String(t).split(token).join('<token>') : String(t));
    if (err instanceof PrimeError) {
      process.stderr.write(`${err.exit === EXIT.USAGE ? 'USAGE' : err.exit === EXIT.CANNOT_VERIFY ? 'CANNOT VERIFY' : 'FAIL'}: ${scrub(err.message)}\n${err.exit === EXIT.CANNOT_VERIFY ? reasonLine(err.reason) : ''}`);
      process.exit(err.exit);
    }
    process.stderr.write(`INTERNAL: ${scrub(err && err.stack ? err.stack : err)}\n`);
    process.exit(EXIT.INTERNAL);
  });
}

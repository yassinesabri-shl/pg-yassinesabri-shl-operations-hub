#!/usr/bin/env node
/**
 * run.mjs — the fixture suite for prime.mjs.
 *
 *   usage:  node run.mjs            run every fixture
 *           node run.mjs 2 6        run only the numbered fixtures
 *           node run.mjs --keep     leave the throwaway folders on disk
 *
 * A fixture is a HUB FOLDER with the repository registry, plus a FAKE PRIME: an HTTP server on a
 * loopback port that answers the MCP server's JSON-RPC at /mcp and the REST API beside it, from a
 * state the fixture sets, and records every call. The shipped script is run as the orchestrator
 * runs it, with HARNESS_PRIME_ORIGIN pointing at the fake, and the exit code, the output, the
 * files written and what Prime was asked are asserted. Fixture 1 is the valid control. Nothing
 * reaches a network, everything runs under a private HOME, and the token is a fixture string.
 *
 * Node standard library only. No test framework.
 * Exit 0 if every fixture passes, 1 if any fails.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = [
  process.env.HARNESS_PRIME,
  resolve(HERE, '..', '..', 'prime.mjs'),
  resolve(HERE, '..', '..', 'scripts', 'prime.mjs'),
].filter(Boolean).find((p) => existsSync(p));
if (!SCRIPT) {
  console.error('cannot locate prime.mjs. Set HARNESS_PRIME=/path/to/prime.mjs.');
  process.exit(4);
}
const prime = await import(pathToFileURL(SCRIPT).href);

const KEEP = process.argv.includes('--keep');
const TOKEN = 'fixture-not-a-token-7f3a';
const SANDBOX_HOME = mkdtempSync(join(tmpdir(), 'prime-home-'));
const BASE_ENV = { ...process.env, HOME: SANDBOX_HOME, XDG_CONFIG_HOME: join(SANDBOX_HOME, '.config') };
for (const k of ['PRIME_PAT_TOKEN', 'HARNESS_PRIME_ORIGIN', 'HARNESS_REGISTRY']) delete BASE_ENV[k];

/* --------------------------------------------------------------- the synthetic account */

const gr = (n, type, framework, category, title, rule) => ({
  external_id: `${String(n).repeat(8)}-0000-5000-8000-${String(n).repeat(12)}`.slice(0, 36),
  guardrail_type: type, framework, category, guardrail_title: title, guardrail: rule, quote: `Source text ${n}.`,
  level: 1, policy_id: null, policy_name: null, updated_at: '2026-10-01T09:00:00Z',
});
const G = {
  access: gr(1, 'FRAMEWORK', 'OWASP_ASVS', 'Access Control', 'Object-Level Access Control', 'Check that the caller owns each object it reads or changes.'),
  inputAsvs: gr(2, 'FRAMEWORK', 'OWASP_ASVS', 'Validation', 'Server-Side Input Validation', 'Validate every input on the server against an allow list.'),
  inputPolicy: gr(3, 'POLICY', null, 'Validation', 'Server-Side Input Validation', 'Reject input that the schema does not allow, on the server.'),
  logging: gr(4, 'POLICY', null, 'Logging', 'Security Event Logging with Metadata', 'Log each security event with the call id and the actor.'),
  cookie: gr(5, 'POLICY', null, 'Session', 'Secure Cookie Attribute Required', 'Set Secure, HttpOnly and SameSite on every session cookie.'),
  prompt: gr(6, 'FRAMEWORK', 'OWASP_LLM', 'AI', 'Prompt Injection Defence', 'Treat model input from users as untrusted data.'),
  s3: gr(7, 'FRAMEWORK', 'CIS_AWS', 'Storage', 'S3 Bucket Public Access Blocked', 'Block public access on every S3 bucket.'),
  gcs: gr(8, 'FRAMEWORK', 'CIS_GCP', 'Storage', 'Cloud Storage Uniform Access', 'Use uniform bucket-level access on Cloud Storage.'),
  vault: gr(9, 'FRAMEWORK', 'CIS_AZURE', 'Secrets', 'Key Vault Soft Delete', 'Turn on soft delete for every key vault.'),
};
const REPO_ID = 501;
const finding = (id, title, status = 'open') => ({ id, guardrail_title: title, status, severity: 'MEDIUM', path: 'src/a.ts', start_line: 3 });

function account() {
  return {
    guardrails: Object.values(G).map((g) => ({ ...g })),
    findings: {
      [REPO_ID]: [
        finding(1, 'Secure Cookie Attributes Required'),
        finding(2, 'Server-Side Input Validation'),
        finding(3, 'Cloud Storage Uniform Access'),
        finding(4, 'Object-Level Access Control', 'resolved'),
        finding(5, 'Retired Rule X'),
      ],
    },
    repos: [
      { id: REPO_ID, org_name: 'acme', repo_name: 'orders-api' },
      { id: 502, org_name: 'acme', repo_name: 'orders-api-legacy' },
    ],
    details: {
      [REPO_ID]: { id: REPO_ID, org_name: 'acme', repo_name: 'orders-api', data_flow: { nodes: [
        { label: 'Model gateway', resource_category_type: 'ai' },
        { label: 'AWS S3 bucket for receipts', resource_category_type: 'storage' },
        { label: 'Orders HTTP service', resource_category_type: 'business_application' },
      ] } },
    },
    reviews: {
      [REPO_ID]: [
        { id: 9001, pr_number: 14, guardrail_issues: [
          { id: 1, guardrail_title: 'Object-Level Access Control', title: 'Object-Level Access Control', path: 'src/a.ts', start_line: 12, comment: 'Add a permission check for the order.', severity: 'HIGH', created_by: 'a.person@example.test' },
          { id: 2, guardrail_title: 'Server-Side Input Validation', title: 'Server-Side Input Validation', path: 'src/a.ts', start_line: 3, comment: 'Validate the whole id.', severity: 'LOW' },
          { id: 3, guardrail_title: 'Secure Cookie Attributes Required', title: 'Secure Cookie Attributes Required', path: 'src/b.ts', start_line: 8, comment: 'Set the Secure attribute.', severity: 'unknown' },
        ] },
        { id: 9002, pr_number: 15, guardrail_issues: [{ id: 4, guardrail_title: 'Other', path: 'src/c.ts', start_line: 1, comment: 'Another pull request.', severity: 'CRITICAL' }] },
        { id: 9003, pr_number: 16, guardrail_issues: [] },
        { id: 9004, pr_number: 17, guardrail_issues: [{ id: 5, guardrail_title: 'Object-Level Access Control', title: 'Object-Level Access Control', path: 'src/a.ts', start_line: 12, comment: 'Add a permission check for the order.', severity: 'HIGH' }, { id: 6, guardrail_title: 'Object-Level Access Control', title: 'Object-Level Access Control', path: 'src/d.ts', start_line: 4, comment: 'Check that the caller owns the refund.', severity: 'MEDIUM' }] },
      ],
    },
    mcp: 'ok', rest: 'ok', pageCap: 100, calls: [],
  };
}

/* ------------------------------------------------------------------------ the fake */

function page(rows, limit, offset, cap) {
  const size = Math.min(Number(limit ?? 100), cap);
  const from = Number(offset ?? 0);
  const results = rows.slice(from, from + size);
  return { results, size: results.length, limit: size, offset: from, total: rows.length, has_next: from + size < rows.length };
}

function startPrime(state) {
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      const auth = req.headers.authorization === `Bearer ${TOKEN}`;
      const send = (status, body, type = 'application/json') => { res.writeHead(status, { 'Content-Type': type }); res.end(typeof body === 'string' ? body : JSON.stringify(body)); };
      if (url.pathname === '/mcp') {
        let msg;
        try { msg = JSON.parse(raw); } catch { return send(400, { error: 'not JSON' }); }
        const tool = msg.method === 'tools/call' ? (msg.params.name === 'call_prime_operation' ? msg.params.arguments.name : msg.params.name) : msg.method;
        state.calls.push({ route: 'mcp', op: tool, auth });
        if (state.mcp === 'down') return send(503, 'MCP is down');
        if (!auth) return send(401, { error: 'unauthorized' });
        if (msg.method === 'initialize') return send(200, { jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'fake-prime', version: '0' } } });
        if (msg.method === 'notifications/initialized') { res.writeHead(202); return res.end(); }
        let data;
        const a = msg.params.arguments || {};
        if (tool === 'list_guardrails') data = page(state.guardrails, a.arguments.limit, a.arguments.offset, state.pageCap);
        else if (tool === 'search_guardrail_findings') data = page(state.findings[a.arguments.filter.repository_ids[0]] || [], a.arguments.limit, a.arguments.offset, state.pageCap);
        else if (tool === 'search_repositories') data = page(state.repos.filter((r) => a.filter.org_name.includes(r.org_name) && a.filter.repo_name.includes(r.repo_name)), a.limit, a.offset, state.pageCap);
        else if (tool === 'get_repository_by_id') data = state.details[a.repository_id];
        else return send(200, { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `no tool ${tool}` } });
        const result = { content: [{ type: 'text', text: JSON.stringify(data) }], ...(state.mcp === 'text-only' ? {} : { structuredContent: data }) };
        const reply = { jsonrpc: '2.0', id: msg.id, result };
        if (state.mcp === 'sse') return send(200, `event: message\ndata: ${JSON.stringify(reply)}\n\n`, 'text/event-stream');
        return send(200, reply);
      }
      const op = `${req.method} ${url.pathname}`;
      state.calls.push({ route: 'rest', op, auth });
      if (state.rest === 'down') return send(502, `Bad Gateway for ${req.headers.authorization}`);
      if (!auth) return send(401, { error: 'unauthorized' });
      const q = url.searchParams;
      if (op === 'GET /guardrails') return send(200, page(state.guardrails, q.get('limit'), q.get('offset'), state.pageCap));
      if (op === 'POST /code-management/findings/guardrails/search') {
        const b = JSON.parse(raw);
        return send(200, page(state.findings[b.filter.repository_ids[0]] || [], b.limit, b.offset, state.pageCap));
      }
      if (op === 'GET /code-management/repositories') return send(200, page(state.repos, q.get('limit'), q.get('offset'), state.pageCap));
      if (op === 'POST /code-management/pr-reviews/search') {
        const b = JSON.parse(raw);
        // As Prime answers: with no pr_number in the filter, every review of the repository, each with its count of issues.
        const rows = (state.reviews[b.filter.repository_ids[0]] || []).filter((r) => !b.filter.pr_number || b.filter.pr_number.includes(r.pr_number)).map((r) => ({ id: r.id, pr_number: r.pr_number, guardrail_issues_count: r.guardrail_issues.length }));
        return send(200, page(rows, b.limit, b.offset, state.pageCap));
      }
      const rv = url.pathname.match(/^\/code-management\/pr-reviews\/(\d+)$/);
      if (req.method === 'GET' && rv) {
        // As Prime answers: a review lists its issues by id, title and rating, without the file or the sentence.
        const one = Object.values(state.reviews).flat().find((r) => r.id === Number(rv[1]));
        return one ? send(200, { ...one, guardrail_issues: one.guardrail_issues.map((g) => ({ id: g.id, title: g.title, severity: g.severity })) }) : send(404, { error: 'no review' });
      }
      const gi = url.pathname.match(/^\/code-management\/findings\/guardrails\/(\d+)$/);
      if (req.method === 'GET' && gi) {
        const issue = Object.values(state.reviews).flat().flatMap((r) => r.guardrail_issues).find((g) => g.id === Number(gi[1]));
        return issue ? send(200, issue) : send(404, { error: 'no issue' });
      }
      const m = url.pathname.match(/^\/code-management\/repositories\/(\d+)$/);
      if (req.method === 'GET' && m && state.details[m[1]]) return send(200, state.details[m[1]]);
      return send(404, { error: `no route ${op}` });
    });
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok({ server, origin: `http://127.0.0.1:${server.address().port}` })));
}

/* --------------------------------------------------------------------- the harness */

function hub(root, url = 'https://github.com/acme/orders-api.git') {
  mkdirSync(root, { recursive: true });
  const registry = join(root, 'repositories.json');
  writeFileSync(registry, JSON.stringify({ schema_version: 1, repositories: { 'orders-api': { url, checks: 'checks.env', purpose: 'A made-up service for the Prime fixtures.', readAt: 'c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00', trunk: 'default' } } }, null, 2));
  return registry;
}

function exec(args, env) {
  return new Promise((ok) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], { env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('close', (status) => ok({ status, stdout, stderr, output: `${stdout}${stderr}` }));
  });
}

/** One fixture's world: a fake Prime, a hub registry, an output folder, and `run` to call the script. */
async function world(root, change = (s) => s) {
  const state = change(account());
  const { server, origin } = await startPrime(state);
  const registry = hub(join(root, 'hub'));
  const out = join(root, 'prime');
  const env = { ...BASE_ENV, PRIME_PAT_TOKEN: TOKEN, HARNESS_PRIME_ORIGIN: origin, HARNESS_REGISTRY: registry };
  return { state, out, env, close: () => new Promise((ok) => server.close(ok)), run: (args, extra = {}) => exec(args, { ...env, ...extra }) };
}

const filesOf = (dir) => (existsSync(dir) ? readdirSync(dir).map((f) => readFileSync(join(dir, f), 'utf8')).join('\n') : '');
const LIST = (w, ...more) => w.run(['list', '--repo-id', 'orders-api', '--out', w.out, ...more]);
const summarize = (problems, ok) => ({ status: problems.length ? 1 : 0, output: problems.join('\n') || ok });

function leaks(w, results) {
  const problems = [];
  for (const r of results) if (r.output.includes(TOKEN)) problems.push('the token appears in the output');
  if (filesOf(w.out).includes(TOKEN)) problems.push('the token appears in a file the script wrote');
  if (w.state.calls.some((c) => !c.auth)) problems.push('a call to Prime went without the token');
  return problems;
}

function design(root, line, extra = '') {
  const file = join(root, 'ORD-1.lld.md');
  writeFileSync(file, `# LLD — ORD-1\n\n## 1. Traceability\n\nRepository: orders-api\n${line === null ? '' : `${line}\n`}${extra}\n## 2. Context\n\nText.\n`);
  return file;
}

/* ------------------------------------------------------------------------ fixtures */

const FIXTURES = [
  {
    n: 1, name: 'list builds the guardrail list: every guardrail with its full rule, those with findings here first, from any group, then the stack Prime shows (core, OWASP LLM, CIS AWS); the rest counted; over MCP, with the token sent and never shown',
    run: async (root) => {
      const w = await world(root);
      const r = await LIST(w);
      await w.close();
      const problems = leaks(w, [r]);
      const md = existsSync(join(w.out, 'guardrail-list.md')) ? readFileSync(join(w.out, 'guardrail-list.md'), 'utf8') : '';
      const broken = md.split('## The rest of the stack')[0];
      for (const g of [G.cookie, G.inputAsvs, G.inputPolicy, G.gcs]) if (!broken.includes(g.guardrail)) problems.push(`the full rule of "${g.guardrail_title}" (${g.framework || 'policy'}) is not listed first`);
      const rest = md.split('## The rest of the stack')[1] || '';
      for (const g of [G.access, G.logging, G.prompt, G.s3]) if (!rest.includes(`· ${g.guardrail_title}** — ${g.guardrail}\n`)) problems.push(`"${g.guardrail_title}" is not listed with its full rule`);
      if (md.includes('by title')) problems.push('the list still offers titles only');
      if (md.includes(G.vault.guardrail_title)) problems.push('a guardrail outside the stack is listed');
      if (!md.includes('CIS Azure 1.')) problems.push('the line of counts does not count CIS Azure');
      if (!md.includes('Retired Rule X (1)')) problems.push('a finding whose title matches no guardrail is not named');
      if (r.stdout.includes(G.cookie.guardrail)) problems.push('a rule was printed');
      const ops = [...new Set(w.state.calls.map((c) => c.op))].sort().join(',');
      if (ops !== 'get_repository_by_id,initialize,list_guardrails,notifications/initialized,search_guardrail_findings,search_repositories') problems.push(`Prime was asked ${ops}`);
      if (r.status !== 0) problems.push(`exit ${r.status}\n${r.output}`);
      return { status: problems.length ? 1 : r.status, output: `${r.stdout}${problems.join('\n')}` };
    },
    exit: 0, includes: ['PRIME LIST orders-api · Prime repository acme/orders-api (501) · stack core, OWASP LLM, CIS AWS from Prime', 'listed=8 broken=4 outside=1 via=mcp', 'guardrail-list.md'],
  },
  {
    n: 2, name: 'list --stack core sets the stack by hand: OWASP LLM and CIS AWS drop to the line of counts, and Prime is not asked for the repository\'s summary',
    run: async (root) => {
      const w = await world(root);
      const r = await LIST(w, '--stack', 'core');
      await w.close();
      const problems = leaks(w, [r]);
      const md = readFileSync(join(w.out, 'guardrail-list.md'), 'utf8');
      if (md.includes(G.s3.guardrail_title) || md.includes(G.prompt.guardrail_title)) problems.push('a group outside the hand-set stack is listed');
      if (!md.includes('CIS AWS 1') || !md.includes('OWASP LLM 1')) problems.push('the line of counts misses a group');
      if (w.state.calls.some((c) => c.op === 'get_repository_by_id')) problems.push('Prime was asked for the summary');
      return { status: problems.length ? 1 : r.status, output: `${r.stdout}${problems.join('\n')}` };
    },
    exit: 0, includes: ['stack core from PRIME_STACK', 'listed=6 broken=4 outside=3'],
  },
  {
    n: 3, name: 'the saved list holds every guardrail of the list with its full rule and its g-number, the same as guardrail-list.md; --rules is gone, so the list never offers a title alone',
    run: async (root) => {
      const w = await world(root);
      await LIST(w);
      const rules = await w.run(['list', '--out', w.out, '--rules', 'g1']);
      await w.close();
      const problems = leaks(w, [rules]);
      const saved = JSON.parse(readFileSync(join(w.out, 'list.json'), 'utf8'));
      const md = readFileSync(join(w.out, 'guardrail-list.md'), 'utf8');
      for (const e of saved.entries) {
        if (!e.rule) problems.push(`${e.g} has no rule in list.json`);
        if (!md.includes(`${e.g} · ${e.title}`) || !md.includes(e.rule)) problems.push(`${e.g} is not in guardrail-list.md with its rule`);
      }
      if ('full' in saved.entries[0]) problems.push('list.json still marks a rule full or not');
      if (rules.status !== 3 || !rules.output.includes('list takes --repo-id, --out, --stack, not --rules')) problems.push(`list --rules: exit ${rules.status}\n${rules.output}`);
      return summarize(problems, `${saved.entries.length} guardrails, each in full`);
    },
    exit: 0, includes: ['8 guardrails, each in full'],
  },
  {
    n: 4, name: 'choose prints the design\'s line, prime@<fingerprint>:<id>, <id>, from the saved list, with the rules in chosen.md and none printed; --pick none prints Guardrails: none. Neither asks Prime anything',
    run: async (root) => {
      const w = await world(root);
      await LIST(w);
      const saved = JSON.parse(readFileSync(join(w.out, 'list.json'), 'utf8'));
      const [a, b] = [saved.entries[1], saved.entries[3]];
      const before = w.state.calls.length;
      const r = await w.run(['choose', '--out', w.out, '--pick', `${a.g},${b.g}`]);
      const none = await w.run(['choose', '--out', w.out, '--pick', 'none']);
      await w.close();
      const problems = leaks(w, [r, none]);
      const fp = prime.fingerprint([a, b]);
      if (!r.stdout.endsWith(`Guardrails: prime@${fp}:${a.id}, ${b.id}\n`)) problems.push(`the line is not prime@${fp}:${a.id}, ${b.id}`);
      const chosen = readFileSync(join(w.out, 'chosen.md'), 'utf8');
      if (!chosen.includes(a.rule) || !chosen.includes(b.rule)) problems.push('chosen.md misses a chosen rule');
      if (r.stdout.includes(a.rule)) problems.push('a rule was printed');
      if (none.stdout !== 'Guardrails: none\n') problems.push(`--pick none: ${none.output}`);
      if (w.state.calls.length !== before) problems.push('choose asked Prime');
      return { status: problems.length ? 1 : r.status, output: `${r.stdout}${problems.join('\n')}` };
    },
    exit: 0, includes: ['CHOSEN g2', 'Guardrails: prime@'],
  },
  {
    n: 5, name: 'choose needs no token and no Prime: with neither, it still writes the line from the saved list, even for a guardrail Prime dropped since, which refresh reports',
    run: async (root) => {
      const w = await world(root);
      await LIST(w);
      w.state.guardrails = w.state.guardrails.filter((g) => g.external_id !== G.cookie.external_id);
      const saved = JSON.parse(readFileSync(join(w.out, 'list.json'), 'utf8'));
      const e = saved.entries.find((x) => x.id === G.cookie.external_id);
      const before = w.state.calls.length;
      await w.close();
      const r = await w.run(['choose', '--out', w.out, '--pick', e.g], { PRIME_PAT_TOKEN: '', HARNESS_PRIME_ORIGIN: 'http://127.0.0.1:9' });
      const problems = [];
      if (w.state.calls.length !== before) problems.push('Prime was asked');
      if (!r.stdout.endsWith(`Guardrails: prime@${prime.fingerprint([e])}:${e.id}\n`)) problems.push('no line from the saved list');
      return { status: problems.length ? 1 : r.status, output: `${r.output}${problems.join('\n')}` };
    },
    exit: 0, includes: ['CHOSEN g', 'Guardrails: prime@'],
  },
  {
    n: 6, name: 'refresh reads the chosen rules again: current when the fingerprint holds; changed, naming the rule dated after --since, when Prime rewrote one; MISSING for a guardrail Prime dropped — each exit 0, the sprint goes on',
    run: async (root) => {
      const w = await world(root);
      const rules = [G.cookie, G.inputAsvs].map((g) => ({ id: g.external_id, title: g.guardrail_title, rule: g.guardrail }));
      const file = design(root, `Guardrails: prime@${prime.fingerprint(rules)}:${G.cookie.external_id}, ${G.inputAsvs.external_id}`);
      const args = ['refresh', '--design', file, '--out', w.out, '--since', '2026-10-15T00:00:00Z'];
      const current = await w.run(args);
      const cookie = w.state.guardrails.find((g) => g.external_id === G.cookie.external_id);
      cookie.guardrail = 'Set Secure, HttpOnly and SameSite=Strict on every session cookie.';
      cookie.updated_at = '2026-11-01T10:00:00Z';
      const changed = await w.run(args);
      w.state.guardrails = w.state.guardrails.filter((g) => g.external_id !== G.inputAsvs.external_id);
      const missing = await w.run(args);
      await w.close();
      const problems = leaks(w, [current, changed, missing]);
      if (current.status !== 0 || !current.stdout.includes('guardrails=current · 2 of 2 read')) problems.push(`current: ${current.output}`);
      if (changed.status !== 0 || !changed.stdout.includes(`CHANGED ${G.cookie.external_id} · Secure Cookie Attribute Required · updated 2026-11-01T10:00:00Z`) || !changed.stdout.includes('guardrails=changed')) problems.push(`changed: ${changed.output}`);
      if (missing.status !== 0 || !missing.stdout.includes(`MISSING ${G.inputAsvs.external_id}`) || !missing.stdout.includes('guardrails=changed · 1 of 2 read')) problems.push(`missing: ${missing.output}`);
      if (!readFileSync(join(w.out, 'chosen.md'), 'utf8').includes('SameSite=Strict')) problems.push('chosen.md does not hold the new rule');
      return summarize(problems, 'current, changed and missing each said');
    },
    exit: 0, includes: ['current, changed and missing each said'],
  },
  {
    n: 7, name: 'refresh asks Prime nothing for off, none, unchecked or no line, and ignores a line in a code fence; two lines, or a line that is no form, is exit 1',
    run: async (root) => {
      const w = await world(root);
      const problems = [];
      for (const [line, want] of [['Guardrails: off', 'guardrails=off'], ['Guardrails: none', 'guardrails=none'], ['Guardrails: unchecked', 'guardrails=unchecked · Prime did not answer'], [null, 'guardrails=off · the design has no Guardrails: line']]) {
        const r = await w.run(['refresh', '--design', design(root, line), '--out', w.out]);
        if (r.status !== 0 || !r.stdout.startsWith(want)) problems.push(`${line}: exit ${r.status} ${r.output}`);
      }
      const fenced = await w.run(['refresh', '--design', design(root, null, '```\nGuardrails: prime@0123456789ab:x\n```\n'), '--out', w.out]);
      if (!fenced.stdout.startsWith('guardrails=off')) problems.push(`a fenced line counted: ${fenced.output}`);
      const two = await w.run(['refresh', '--design', design(root, 'Guardrails: none\nGuardrails: off'), '--out', w.out]);
      if (two.status !== 1 || !two.output.includes('carries 2 Guardrails: lines')) problems.push(`two lines: exit ${two.status} ${two.output}`);
      const prose = await w.run(['refresh', '--design', design(root, 'Guardrails: the OWASP ones'), '--out', w.out]);
      if (prose.status !== 1 || !prose.output.includes('is not off, none, unchecked or prime@')) problems.push(`prose: exit ${prose.status} ${prose.output}`);
      await w.close();
      if (w.state.calls.length) problems.push(`Prime was asked ${w.state.calls.length} times`);
      return summarize(problems, 'no read, and the bad lines refused');
    },
    exit: 0, includes: ['no read, and the bad lines refused'],
  },
  {
    n: 8, name: 'MCP down: every operation goes to REST with the same token, and the list is the same',
    run: async (root) => {
      const w = await world(root, (s) => ({ ...s, mcp: 'down' }));
      const r = await LIST(w);
      await w.close();
      const problems = leaks(w, [r]);
      if (w.state.calls.filter((c) => c.route === 'mcp').length !== 1) problems.push(`MCP was asked ${w.state.calls.filter((c) => c.route === 'mcp').length} times after it failed to start`);
      return { status: problems.length ? 1 : r.status, output: `${r.stdout}${problems.join('\n')}` };
    },
    exit: 0, includes: ['listed=8 broken=4 outside=1 via=rest'],
  },
  {
    n: 9, name: 'MCP and REST both down is exit 2, the cannot-verify the harness reads as unchecked, and a token the server echoes is shown as <token>',
    run: async (root) => {
      const w = await world(root, (s) => ({ ...s, mcp: 'down', rest: 'down' }));
      const r = await LIST(w);
      await w.close();
      return { status: r.output.includes(TOKEN) ? 4 : r.status, output: r.output };
    },
    exit: 2, includes: ['CANNOT VERIFY: Prime did not answer the repository search', 'over MCP', 'over REST', 'Bad Gateway for Bearer <token>'],
  },
  {
    n: 10, name: 'no token is exit 2 and asks Prime nothing; a token in ~/.config/prime-security/token is read',
    run: async (root) => {
      const w = await world(root);
      const none = await w.run(['list', '--repo-id', 'orders-api', '--out', w.out], { PRIME_PAT_TOKEN: '' });
      const asked = w.state.calls.length;
      const home = join(root, 'home');
      mkdirSync(join(home, '.config', 'prime-security'), { recursive: true });
      writeFileSync(join(home, '.config', 'prime-security', 'token'), `${TOKEN}\n`);
      const fromFile = await w.run(['list', '--repo-id', 'orders-api', '--out', w.out], { PRIME_PAT_TOKEN: '', HOME: home });
      await w.close();
      const problems = [];
      if (none.status !== 2 || !none.output.includes('no Prime token')) problems.push(`no token: exit ${none.status} ${none.output}`);
      if (asked !== 0) problems.push(`Prime was asked ${asked} times without a token`);
      if (fromFile.status !== 0 || fromFile.output.includes(TOKEN)) problems.push(`token file: exit ${fromFile.status} ${fromFile.output}`);
      return summarize(problems, 'no token refused, the token file read');
    },
    exit: 0, includes: ['no token refused, the token file read'],
  },
  {
    n: 11, name: 'MCP answers as an event stream, or with text only and no structured content: both are read',
    run: async (root) => {
      const problems = [];
      for (const mode of ['sse', 'text-only']) {
        const w = await world(join(root, mode), (s) => ({ ...s, mcp: mode }));
        const r = await LIST(w);
        await w.close();
        if (r.status !== 0 || !r.stdout.includes('listed=8 broken=4 outside=1 via=mcp')) problems.push(`${mode}: exit ${r.status} ${r.output}`);
      }
      return summarize(problems, 'both answer forms read');
    },
    exit: 0, includes: ['both answer forms read'],
  },
  {
    n: 12, name: 'a host that is not a loopback address is a usage fault before any call; a repository Prime does not hold is exit 2',
    run: async (root) => {
      const w = await world(root);
      const away = await w.run(['list', '--repo-id', 'orders-api', '--out', w.out], { HARNESS_PRIME_ORIGIN: 'https://prime.example.invalid' });
      writeFileSync(w.env.HARNESS_REGISTRY, readFileSync(w.env.HARNESS_REGISTRY, 'utf8').replace('acme/orders-api.git', 'acme/unknown.git'));
      const unknown = await LIST(w);
      await w.close();
      const problems = [];
      if (away.status !== 3 || !away.output.includes('is not a loopback address')) problems.push(`away: exit ${away.status} ${away.output}`);
      if (unknown.status !== 2 || !unknown.output.includes('Prime holds no repository acme/unknown')) problems.push(`unknown: exit ${unknown.status} ${unknown.output}`);
      return summarize(problems, 'both refused');
    },
    exit: 0, includes: ['both refused'],
  },
  {
    n: 13, name: 'usage is checked before Prime is asked (exit 3): no command, no --out, a stack Prime has no group for, list without --repo-id, a g-number twice, a bad --since',
    run: async (root) => {
      const w = await world(root);
      const cases = [
        ['sync', '--out', w.out], ['list', '--repo-id', 'orders-api'], ['list', '--repo-id', 'orders-api', '--out', w.out, '--stack', 'core,k8s'],
        ['list', '--out', w.out], ['choose', '--out', w.out, '--pick', 'g1,g1'],
        ['choose', '--out', w.out, '--pick', 'cookie'], ['refresh', '--design', 'x.md', '--out', w.out, '--since', 'yesterday'],
      ];
      const problems = [];
      for (const c of cases) { const r = await w.run(c); if (r.status !== 3 || !r.output.includes('USAGE:')) problems.push(`${c.join(' ')}: exit ${r.status} ${r.output}`); }
      await w.close();
      if (w.state.calls.length) problems.push('Prime was asked something');
      return summarize(problems, `${cases.length} usages refused`);
    },
    exit: 0, includes: ['7 usages refused'],
  },
  {
    n: 14, name: 'every list is read to its last page: two rows a page still gives the whole account',
    run: async (root) => {
      const w = await world(root, (s) => ({ ...s, pageCap: 2 }));
      const r = await LIST(w);
      await w.close();
      const pages = w.state.calls.filter((c) => c.op === 'list_guardrails').length;
      return { status: pages === 5 ? r.status : 1, output: `${r.stdout}${pages === 5 ? '' : `the guardrails took ${pages} pages, not 5`}` };
    },
    exit: 0, includes: ['listed=8 broken=4 outside=1 via=mcp'],
  },
  {
    n: 15, name: 'severity writes the rating Prime gave each issue of its reviews of one pull request — title, file, line, sentence and rating, and nothing that names a person; an issue with no known rating and another pull request\'s review are left out; it prints counts only; REST down is exit 2; no --pr is a usage fault',
    run: async (root) => {
      const w = await world(root);
      const r = await w.run(['severity', '--repo-id', 'orders-api', '--pr', '14', '--out', w.out]);
      const usage = await w.run(['severity', '--repo-id', 'orders-api', '--out', w.out]);
      w.state.rest = 'down';
      const down = await w.run(['severity', '--repo-id', 'orders-api', '--pr', '14', '--out', join(root, 'down')]);
      await w.close();
      const problems = leaks(w, [r, down]);
      const saved = existsSync(join(w.out, 'prime-severity.json')) ? JSON.parse(readFileSync(join(w.out, 'prime-severity.json'), 'utf8')) : { issues: [] };
      const want = [
        { title: 'Object-Level Access Control', path: 'src/a.ts', line: 12, text: 'Add a permission check for the order.', severity: 'HIGH' },
        { title: 'Server-Side Input Validation', path: 'src/a.ts', line: 3, text: 'Validate the whole id.', severity: 'LOW' },
      ];
      if (JSON.stringify(saved.issues) !== JSON.stringify(want)) problems.push(`prime-severity.json holds ${JSON.stringify(saved.issues)}`);
      if (saved.pr !== 14 || saved.repoId !== 'orders-api') problems.push(`the file names ${saved.repoId} #${saved.pr}`);
      if (filesOf(w.out).includes('example.test') || r.output.includes('permission check')) problems.push('a person\'s address is in the file, or a finding\'s text is printed');
      if (usage.status !== 3) problems.push(`no --pr: exit ${usage.status}`);
      if (down.status !== 2 || !down.output.includes('CANNOT VERIFY') || existsSync(join(root, 'down', 'prime-severity.json'))) problems.push(`REST down: exit ${down.status}\n${down.output}`);
      return { status: problems.length ? 1 : r.status, output: `${r.stdout}${problems.join('\n')}` };
    },
    exit: 0, includes: ['PRIME SEVERITY orders-api #14 · reviews=1 issues=2 · critical=0 high=1 medium=0 low=1 info=0 via=', 'prime-severity.json'],
  },
  {
    n: 16, name: 'history writes what Prime raised on the repository\'s earlier pull requests, from its reviews and never from the findings search: one entry for each guardrail, the one raised on the most pull requests first, with its g-number from the saved list, the pull requests, and Prime\'s sentences once each with their files; a review with no finding is not read; it prints counts only and names no person; REST down is exit 2',
    run: async (root) => {
      const w = await world(root);
      await LIST(w);
      const before = w.state.calls.length;
      const r = await w.run(['history', '--repo-id', 'orders-api', '--out', w.out]);
      const asked = w.state.calls.slice(before).map((c) => c.op);
      const usage = await w.run(['history', '--out', w.out]);
      w.state.rest = 'down';
      const down = await w.run(['history', '--repo-id', 'orders-api', '--out', join(root, 'down')]);
      await w.close();
      const problems = leaks(w, [r, down]);
      const md = existsSync(join(w.out, 'prime-history.md')) ? readFileSync(join(w.out, 'prime-history.md'), 'utf8') : '';
      const heads = md.split('\n').filter((l) => l.startsWith('## '));
      if (!heads[0] || !heads[0].endsWith('· Object-Level Access Control') || heads[0].search(/^## g\d+ · /) !== 0) problems.push(`the first entry is "${heads[0]}"`);
      if (heads.length !== 4) problems.push(`the file holds ${heads.length} entries, not 4`);
      if (!md.includes('3 findings · pull requests #17, #14')) problems.push('the access-control entry does not count 3 findings on #17 and #14');
      if ((md.match(/Add a permission check for the order\./g) || []).length !== 1) problems.push('a sentence Prime repeated on two pull requests is not listed once');
      if (!md.includes('- #17 · MEDIUM · `src/d.ts:4` — Check that the caller owns the refund.')) problems.push('an example lacks its pull request, rating, file or sentence');
      if (!md.includes('## Other\n1 finding · pull request #15 · not on the guardrail list')) problems.push('a guardrail that is not on the list is not marked');
      if (md.includes('example.test')) problems.push('a person\'s address is in the file');
      if (asked.includes('GET /code-management/pr-reviews/9003')) problems.push('a review with no finding was read');
      if (asked.some((op) => op.includes('findings/guardrails/search') || op === 'search_guardrail_findings')) problems.push('history asked the findings search');
      if (r.output.includes('permission check')) problems.push('a finding\'s text is printed');
      if (usage.status !== 3) problems.push(`no --repo-id: exit ${usage.status}`);
      if (down.status !== 2 || !down.output.includes('CANNOT VERIFY') || existsSync(join(root, 'down', 'prime-history.md'))) problems.push(`REST down: exit ${down.status}\n${down.output}`);
      return { status: problems.length ? 1 : r.status, output: `${r.stdout}${problems.join('\n')}` };
    },
    exit: 0, includes: ['PRIME HISTORY orders-api · pull requests=3 findings=6 guardrails=4 via=', 'prime-history.md'],
  },
  {
    n: 17, name: 'history --designs adds what the hub\'s designs of this repository recorded for Prime\'s rules: each Closed row of §9 whose Source is a Prime guardrail, with its story, its question and the person\'s answer, and each row of §10 whose decision opens with a Prime guardrail; an open row, a row from another source, a design of another repository, a template, and a row inside a code fence or a comment are left out; a folder that does not exist is a usage fault',
    run: async (root) => {
      const w = await world(root);
      await LIST(w);
      const designs = join(root, 'designs');
      mkdirSync(designs, { recursive: true });
      const nine = '| ID | Question | Source | Blocking | Routed to | Status | Resolution | Resolved |\n|---|---|---|---|---|---|---|---|';
      const ten = '| # | Decision | Alternatives rejected | Why | Date |\n|---|---|---|---|---|';
      const design = (repo, rows9, rows10) => `# Design\n\nRepository: ${repo}\n\n## 9. Clarifications\n\n<!--\n| CLAR-X-00 | hidden in a comment | Prime g9 Hidden | yes | lead | Closed | no | 2026-01-01 |\n-->\n\n${nine}\n${rows9.join('\n')}\n\n\`\`\`\n| CLAR-X-99 | inside a fence | Prime g9 Fenced | yes | lead | Closed | no | 2026-01-01 |\n\`\`\`\n\n## 10. Decisions log\n\n${ten}\n${rows10.join('\n')}\n\n## 11. Review record\n`;
      writeFileSync(join(designs, 'SHOP-2.lld.md'), design('orders-api', [
        '| CLAR-SHOP-2-01 | May a staff member mark any product? | `Prime g4 Object-Level Access Control` | yes | tech lead | Closed | "Yes: every staff member may, for this service" — tech lead, in the fixes of pull request #15 | 2026-11-13 |',
        '| CLAR-SHOP-2-02 | Which rate applies? | Prime g7 Rate Limiting | yes | product owner | Open | | |',
        '| CLAR-SHOP-2-03 | Which page size? | FSD §3 L12 | no | product owner | Closed | 50 | 2026-11-10 |',
      ], [
        '| D-1 | Use the existing repository class | a new class | less code | 2026-11-10 |',
        '| D-2 | Prime g7 Rate Limiting — the mark route refuses a body above 64 KB, a value that the engineer chose | no cap | no valid request reaches it \\| see the route | 2026-11-13 |',
      ]));
      writeFileSync(join(designs, 'SHOP-3.lld.md'), design('other-api', ['| CLAR-SHOP-3-01 | Another service? | Prime g4 Object-Level Access Control | yes | tech lead | Closed | "no" — tech lead | 2026-11-12 |'], []));
      writeFileSync(join(designs, '_TEMPLATE.lld.md'), design('orders-api', ['| CLAR-PROJ-auth-01 | a template row | Prime g1 Template | yes | role | Closed | x | 2026-01-01 |'], []));
      const r = await w.run(['history', '--repo-id', 'orders-api', '--out', w.out, '--designs', designs]);
      const missing = await w.run(['history', '--repo-id', 'orders-api', '--out', w.out, '--designs', join(root, 'nowhere')]);
      await w.close();
      const problems = leaks(w, [r]);
      const md = existsSync(join(w.out, 'prime-history.md')) ? readFileSync(join(w.out, 'prime-history.md'), 'utf8') : '';
      if (!md.includes('# What Prime raised on orders-api before')) problems.push('the first part is gone');
      if (!md.includes(`# What this hub's designs recorded for Prime's rules on orders-api\n\n2 entries from 1 design under ${designs}.`)) problems.push('the second part does not count 2 entries from 1 design');
      if (!md.includes('## Prime g4 Object-Level Access Control\n\n- SHOP-2 · answer CLAR-SHOP-2-01 · 2026-11-13 — May a staff member mark any product? Answer: "Yes: every staff member may, for this service" — tech lead, in the fixes of pull request #15')) problems.push('the answer is not listed with its story, question and words');
      if (!md.includes('## Prime g7 Rate Limiting\n\n- SHOP-2 · decision D-2 · 2026-11-13 — the mark route refuses a body above 64 KB, a value that the engineer chose Why: no valid request reaches it | see the route')) problems.push('the decision is not listed with its reason');
      for (const left of ['Which rate applies', 'Which page size', 'SHOP-3', 'template row', 'hidden in a comment', 'inside a fence', 'existing repository class']) if (md.includes(left)) problems.push(`"${left}" is in the file`);
      if (missing.status !== 3 || !missing.output.includes('is not a folder')) problems.push(`a folder that does not exist: exit ${missing.status}\n${missing.output}`);
      return { status: problems.length ? 1 : r.status, output: `${r.stdout}${problems.join('\n')}` };
    },
    exit: 0, includes: ['PRIME HISTORY orders-api · pull requests=3 findings=6 guardrails=4 recorded=2 via='],
  },
];

/* -------------------------------------------------------------------------- runner */

async function main() {
  const wanted = process.argv.slice(2).filter((a) => a.search(/^\d+$/) === 0).map(Number);
  const selected = wanted.length ? FIXTURES.filter((f) => wanted.includes(f.n)) : FIXTURES;
  process.stdout.write(`script under test: ${SCRIPT}\n${selected.length} of ${FIXTURES.length} fixtures\n\n`);
  let failed = 0;
  for (const f of selected) {
    const root = mkdtempSync(join(tmpdir(), `prime-fx${String(f.n).padStart(2, '0')}-`));
    let res;
    try { res = await f.run(root); } catch (err) { res = { status: 'threw', output: err && err.stack ? err.stack : String(err) }; }
    const problems = [];
    if (res.status !== f.exit) problems.push(`expected exit ${f.exit}, got ${res.status}`);
    for (const s of f.includes || []) if (!res.output.includes(s)) problems.push(`output does not contain: ${s}`);
    for (const s of ['INTERNAL:']) if (res.output.includes(s)) problems.push(`output should not contain: ${s}`);
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

await main();

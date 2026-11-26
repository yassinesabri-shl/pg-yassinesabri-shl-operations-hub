/**
 * fake-confluence.mjs — an in-memory Confluence Cloud that answers over real HTTP, for run.mjs.
 *
 * It answers the reads confluence.mjs makes, on the site's paths and on the gateway's
 * (/ex/confluence/<cloud id>/wiki/...): the current user, a space by key, a folder or a page by id
 * (a page's body in Atlassian Document Format), the direct children of a folder or a page, a
 * page's labels and ancestors, a user by account id, and the tenant's cloud id. Every request is
 * recorded. Any method but GET is answered 405 and recorded, so a fixture can prove the sync never
 * writes. Children come two to a page, so every list is paginated.
 *
 * Node standard library only.
 */

import { createServer } from 'node:http';

export const CLOUD_ID = '0f0e0d0c-0b0a-4909-8807-060504030201';

/**
 * @param {object} site
 * @param {string} site.user        the service account's email
 * @param {string} site.token       its token
 * @param {string} site.space       the space key
 * @param {Array}  site.nodes       [{ id, type: 'folder'|'page', title, parent, status?, version?, author?, adf?, labels? }]
 * @param {object} [site.people]    accountId → display name
 * @param {object} [site.fail]      { status: 503 } answers every request but tenant_info with that status
 * A page node may carry `rawBody`, a body that is not JSON.
 */
export function startFake(site) {
  const state = { requests: [], writes: [], nodes: new Map(), people: site.people || {} };
  for (const n of site.nodes || []) state.nodes.set(String(n.id), { status: 'current', version: 1, author: 'acc-author', labels: [], ...n, id: String(n.id), parent: n.parent ? String(n.parent) : null });

  const auth = `Basic ${Buffer.from(`${site.user}:${site.token}`).toString('base64')}`;
  const childrenOf = (id) => [...state.nodes.values()].filter((n) => n.parent === id && n.status !== 'trashed');

  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://fake');
    let path = url.pathname;
    const gateway = path.startsWith(`/ex/confluence/${CLOUD_ID}`);
    if (gateway) path = path.slice(`/ex/confluence/${CLOUD_ID}`.length);
    state.requests.push({ method: req.method, path, query: Object.fromEntries(url.searchParams), gateway, auth: req.headers.authorization === auth });
    const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };

    if (req.method !== 'GET') { state.writes.push({ method: req.method, path }); return send(405, { message: 'the fake answers reads only' }); }
    if (path === '/_edge/tenant_info') return send(200, { cloudId: CLOUD_ID });
    if (site.fail && site.fail.status) return send(site.fail.status, { message: 'forced' });
    if (req.headers.authorization !== auth) return send(401, { message: 'Unauthorized' });

    if (path === '/wiki/rest/api/user/current') return send(200, { type: 'known', accountId: 'acc-sync', displayName: 'Sync Service' });
    if (path === '/wiki/api/v2/spaces') return send(200, { results: url.searchParams.get('keys') === site.space ? [{ id: '100', key: site.space, name: 'Test space', status: 'current' }] : [] });
    if (path === '/wiki/rest/api/search') {
      // Only the query discover --find-root makes: title = "<text>". Titles compare without regard to case.
      const m = String(url.searchParams.get('cql') || '').match(/title\s*=\s*"([^"]*)"/i);
      const want = m ? m[1].toLowerCase() : null;
      const hits = [...state.nodes.values()].filter((n) => want !== null && n.title.toLowerCase() === want && n.status !== 'trashed');
      return send(200, { results: hits.map((n) => ({ content: { id: n.id, type: n.type, title: n.title } })), _links: {} });
    }
    if (path === '/wiki/rest/api/user') {
      const name = state.people[url.searchParams.get('accountId')];
      return name ? send(200, { accountId: url.searchParams.get('accountId'), displayName: name }) : send(404, { message: 'no such user' });
    }

    let m = path.match(/^\/wiki\/api\/v2\/(pages|folders)\/(\d+)(?:\/(direct-children|labels|ancestors))?$/);
    if (!m) return send(404, { message: `the fake has no ${path}` });
    const [, kind, id, sub] = m;
    const node = state.nodes.get(id);
    if (!node || node.status === 'trashed' || (kind === 'pages') !== (node.type === 'page')) return send(404, { message: 'not found' });

    if (sub === 'direct-children') {
      const all = childrenOf(id);
      const from = Number(url.searchParams.get('cursor') || 0);
      const slice = all.slice(from, from + 2);
      const next = from + 2 < all.length ? `/wiki/api/v2/${kind}/${id}/direct-children?limit=100&cursor=${from + 2}` : undefined;
      return send(200, { results: slice.map((c) => ({ id: c.id, type: c.type, title: c.title, status: c.status })), _links: next ? { next } : {} });
    }
    if (sub === 'labels') return send(200, { results: (node.labels || []).map((name, i) => ({ id: String(i + 1), name, prefix: 'global' })), _links: {} });
    if (sub === 'ancestors') {
      const chain = [];
      for (let p = node.parent; p; p = state.nodes.get(p) && state.nodes.get(p).parent) chain.unshift({ id: p, type: state.nodes.get(p).type });
      return send(200, { results: chain });
    }
    const out = { id: node.id, type: node.type, title: node.title, status: node.status, parentId: node.parent, version: { number: node.version, authorId: node.author, createdAt: '2026-11-20T10:00:00.000Z' }, _links: { webui: `/spaces/${site.space}/pages/${node.id}` } };
    if (node.type === 'page' && url.searchParams.get('body-format') === 'atlas_doc_format') {
      // `rawBody` is a body that is not JSON, for the fixture where one page fails.
      const value = typeof node.rawBody === 'string' ? node.rawBody : JSON.stringify(node.adf || { type: 'doc', content: [] });
      out.body = { atlas_doc_format: { value, representation: 'atlas_doc_format' } };
    }
    return send(200, out);
  });

  return new Promise((resolveStart) => {
    server.listen(0, '127.0.0.1', () => {
      const origin = `http://127.0.0.1:${server.address().port}`;
      resolveStart({ origin, state, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

/* ------------------------------------------------------------------ ADF builders for the fixtures */

export const text = (t, marks) => (marks ? { type: 'text', text: t, marks: marks.map((m) => ({ type: m })) } : { type: 'text', text: t });
export const para = (...parts) => ({ type: 'paragraph', content: parts.map((x) => (typeof x === 'string' ? text(x) : x)) });
export const heading = (t, level = 2) => ({ type: 'heading', attrs: { level }, content: [text(t)] });
export const bullets = (...items) => ({ type: 'bulletList', content: items.map((i) => ({ type: 'listItem', content: [para(i)] })) });
const cell = (t, header) => ({ type: header ? 'tableHeader' : 'tableCell', content: [para(t)] });
export const table = (rowList) => ({ type: 'table', content: rowList.map((r, i) => ({ type: 'tableRow', content: r.map((c) => cell(c, i === 0)) })) });

/** The page header as the two-column table the ADR pages use. */
export const header = (fields) => table([['Section', 'Content'], ...Object.entries(fields).map(([k, v]) => [k, v])]);

export const DECISION = 'We use Postgres for every new service that needs a relational store.';

/** An ADR page that follows the ADR template. `omit` drops sections, `extra` adds one the template does not have. */
export function adrPage({ status = 'Approved', owner = 'Platform architect', decision = DECISION, applies = 'services/orders/**, libs/db/**', omit = [], extra = null, context = 'Each team picks its own database today.' } = {}) {
  const sections = [
    ['Context', [para(context)]],
    ['Decision', [para(decision)]],
    ['Rules', [bullets('MUST use Postgres for a new relational store.', 'MUST NOT share a schema between two domains.')]],
    ['Applies to', [para(applies)]],
    ['Options considered', [table([['Option', 'Why not chosen'], ['Keep every engine', 'Three sets of backups to run'], ['MySQL everywhere', 'No team runs it today']])]],
    ['Consequences', [bullets('One backup design for the estate.')]],
    ['Links', [para('None')]],
  ];
  if (extra) sections.splice(3, 0, [extra, [para('A section the template does not have.')]]);
  const fields = { Status: status, Date: '2026-11-20', Owner: owner, 'Decided by': 'Design Authority' };
  if (owner === null) delete fields.Owner;
  return { type: 'doc', content: [header(fields), ...sections.filter(([n]) => !omit.includes(n)).flatMap(([n, b]) => [heading(n), ...b])] };
}

/** The page header as "Label: value" lines in one paragraph, the form both Confluence templates use. */
export function headerLines(fields) {
  const content = [];
  Object.entries(fields).forEach(([k, v], i) => {
    if (i) content.push({ type: 'hardBreak' });
    content.push(text(`${k}:`, ['strong']), text(` ${v}`));
  });
  return { type: 'paragraph', content };
}

export const SCOPE_BOXES = ['All code', 'Backend', 'Frontend', 'Data and database', 'CI/CD and infrastructure', 'Python', 'TypeScript', 'Java', 'Go', 'Only when a design asks for this rule explicitly', 'Other: [exact paths, one per line. Ask the PDLC team]'];

/**
 * A standard page that follows Template - Standard. `scope` lists the boxes ticked; a box that starts
 * "Other:" replaces the template's Other box. `howTo` leaves the guidance block on the page.
 */
export function standardPage({ topic, status = 'Approved', ids = true, scope = ['TypeScript'], inWords = 'Every public HTTP API. Internal events are not covered.', howTo = false, owner = 'Lead architect' } = {}) {
  const r = (n, t) => `${ids ? `std-${topic}.${String(n).padStart(2, '0')} ` : ''}${t}`;
  const other = scope.find((s) => s.startsWith('Other:'));
  const boxes = SCOPE_BOXES.map((b) => (b.startsWith('Other:') && other ? other : b));
  const ticked = (b) => scope.includes(b) || (b.startsWith('Other:') && Boolean(other));
  return { type: 'doc', content: [
    headerLines({ Status: status, Date: '2026-11-20', Owner: owner, Contact: 'Ada Author', 'Decided by': 'Nova architecture forum', Summary: `How every public API names its ${topic}.` }),
    ...(howTo ? [{ type: 'expand', attrs: { title: 'How to write this page — delete before publishing' }, content: [para('Write the title as std-[topic].')] }] : []),
    heading('Applies to'),
    para(text('Scope', ['strong']), ' (tick every one that applies):'),
    { type: 'taskList', content: boxes.map((b) => ({ type: 'taskItem', attrs: { state: ticked(b) ? 'DONE' : 'TODO' }, content: [text(b)] })) },
    para(text('In words:', ['strong']), ` ${inWords}`),
    heading('Must'), bullets(r(1, 'MUST use kebab-case in a path segment.'), r(2, 'MUST NOT put a verb in a path.')),
    heading('Should'), bullets(r(3, 'SHOULD keep a path under five segments.')),
    heading('Values'), table([['Value', 'Setting', 'For', 'Source'], ['Path segments', '5 at most', 'All public APIs', 'API guide, page 2']]),
    heading('Checked by'), bullets(`std-${topic}.01 — review: the reviewer reads every new path.`),
    heading('Relations'), para('None.'),
    heading('Exceptions'), bullets('Granted by: Lead architect'),
    heading('Unresolved'), para('None.'),
    heading('Origin'), bullets('Source: API guide v2, the API guild space'),
    heading('Links'), para('Jira: [ ]'),
  ] };
}

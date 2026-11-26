// Part of the harness asset library c6f3b4427d58f7c3 (see VERSION.json) · 2026-11-25
/**
 * confluence.mjs — a small, read-only client for the parts of Confluence Cloud's REST API the
 * context sync reads.
 *
 * Shared by `confluence-sync.mjs`. Not a command. Node standard library only: `fetch`, `AbortSignal`.
 *
 * What it does, and what it will not:
 *
 *   - It sends GET requests only. Nothing in this file can write to Confluence (connector.md).
 *   - It authenticates as the sync's service account: HTTP basic, `<user>:<token>`. The caller reads
 *     both from the environment. It stores nothing and logs no header.
 *   - It reaches Confluence one of two ways. `site` calls `https://<site>/wiki/...`, for a classic
 *     API token. `gateway` calls `https://api.atlassian.com/ex/confluence/<cloud id>/wiki/...`,
 *     which an API token with scopes needs. The cloud id is read from `<site>/_edge/tenant_info`.
 *   - It retries 429, 502, 503 and 504, honouring `Retry-After`, and a network error, up to
 *     `tries` attempts. It never retries a 401 or a 403.
 *   - Every failure is a `ConfluenceError` with a harness exit code: 2 for cannot verify
 *     (unreachable, 401, 403, 5xx or 429 after retries), 1 for a verified refusal (404, 400),
 *     4 for a reply it cannot read.
 *
 * What this module cannot see
 *   - Whether the response shapes it reads are the ones a given site returns after Atlassian
 *     changes them. Each reader checks the fields it needs and says which is missing.
 */

export const EXIT = { PASS: 0, FAIL: 1, CANNOT_VERIFY: 2, USAGE: 3, INTERNAL: 4 };

/** A refusal or a failure of Confluence. `reason` is a token of spoke-remote.mjs's REASONS. */
export class ConfluenceError extends Error {
  constructor(exit, message, status = null) {
    super(message);
    this.name = 'ConfluenceError';
    this.exit = exit;
    this.status = status;
    this.reason = exit !== EXIT.CANNOT_VERIFY ? null
      : status === 401 || status === 403 ? 'auth-failed' : status ? 'wiki-failed' : 'wiki-unreachable';
  }
}

const RETRY_STATUS = new Set([429, 502, 503, 504]);

/**
 * Why a fetch did not reach `where`. A certificate error is most often a proxy that inspects TLS, with
 * a root certificate that Node does not trust. The message then says how to give Node that certificate.
 */
export function reachProblem(where, err) {
  const code = err && err.cause && err.cause.code ? String(err.cause.code) : '';
  const said = code || (err && err.message) || String(err);
  const tls = code.match(/CERT|SELF_SIGNED|ISSUER/) !== null;
  return `cannot reach ${where}: ${said}${tls ? '. A proxy that inspects TLS may have signed the reply. Set NODE_EXTRA_CA_CERTS to the path of the proxy\'s root certificate (a PEM file), or run Node with --use-system-ca' : ''}`;
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// `Retry-After` is seconds, or an HTTP date. Anything else is no hint.
function retryAfterMs(header) {
  if (!header) return null;
  const n = Number(header);
  if (Number.isFinite(n) && n >= 0) return n * 1000;
  const when = Date.parse(header);
  return Number.isNaN(when) ? null : Math.max(0, when - Date.now());
}

/**
 * The root every `/wiki/...` path is appended to.
 * @param {string} site     `https://<site>`, for example https://shl.atlassian.net
 * @param {'site'|'gateway'} mode
 * @param {string} [gatewayBase]  for fixtures: the gateway's origin, default https://api.atlassian.com
 */
export async function resolveRoot(site, mode, { gatewayBase = 'https://api.atlassian.com', timeoutMs = 20000 } = {}) {
  const origin = String(site).replace(/\/+$/, '');
  if (mode === 'site') return origin;
  if (mode !== 'gateway') throw new ConfluenceError(EXIT.INTERNAL, `unknown Confluence mode ${JSON.stringify(mode)}`);
  let res;
  try {
    res = await fetch(`${origin}/_edge/tenant_info`, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    throw new ConfluenceError(EXIT.CANNOT_VERIFY, reachProblem(`${origin}/_edge/tenant_info to read the cloud id`, err));
  }
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  const id = body && typeof body.cloudId === 'string' ? body.cloudId : '';
  if (!res.ok || !id.match(/^[0-9a-f-]{8,}$/i)) {
    throw new ConfluenceError(EXIT.CANNOT_VERIFY, `${origin}/_edge/tenant_info answered ${res.status} with no cloud id`, res.ok ? null : res.status);
  }
  return `${String(gatewayBase).replace(/\/+$/, '')}/ex/confluence/${id}`;
}

/**
 * @param {object} o
 * @param {string} o.root    from resolveRoot
 * @param {string} o.user    the service account's email
 * @param {string} o.token   its API token
 * @param {number} [o.tries]       attempts per request, default 4
 * @param {number} [o.baseDelayMs] first backoff, default 500
 * @param {number} [o.maxDelayMs]  backoff cap, default 8000
 * @param {number} [o.timeoutMs]   per attempt, default 30000
 * @param {(ms:number)=>Promise<void>} [o.wait] for fixtures
 */
export function createClient({ root, user, token, tries = 4, baseDelayMs = 500, maxDelayMs = 8000, timeoutMs = 30000, wait = sleep }) {
  const base = String(root).replace(/\/+$/, '');
  const authorization = `Basic ${Buffer.from(`${user}:${token}`).toString('base64')}`;

  // v2 answers `_links.next` as /wiki/api/v2/...; v1 answers /rest/api/... relative to /wiki.
  const nextOf = (links) => {
    const n = links && typeof links.next === 'string' ? links.next : null;
    if (!n) return null;
    return n.startsWith('/wiki/') ? n : `/wiki${n.startsWith('/') ? '' : '/'}${n}`;
  };

  function backoff(attempt, hinted) {
    if (hinted !== null && hinted !== undefined) return Math.min(maxDelayMs, hinted);
    const exp = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
    return Math.round(exp / 2 + Math.random() * (exp / 2));
  }

  /** GET one path under the root. Returns the parsed JSON, or null on 204. */
  async function get(path, query = {}) {
    const url = new URL(`${base}${path}`);
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    let lastProblem = '';
    for (let attempt = 1; attempt <= tries; attempt += 1) {
      let res;
      try {
        res = await fetch(url, { method: 'GET', headers: { Authorization: authorization, Accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
      } catch (err) {
        lastProblem = reachProblem(new URL(base).origin, err);
        if (attempt < tries) { await wait(backoff(attempt, null)); continue; }
        throw new ConfluenceError(EXIT.CANNOT_VERIFY, lastProblem);
      }
      if (RETRY_STATUS.has(res.status)) {
        lastProblem = `GET ${path} answered ${res.status}`;
        if (attempt < tries) { await wait(backoff(attempt, retryAfterMs(res.headers.get('retry-after')))); continue; }
        throw new ConfluenceError(EXIT.CANNOT_VERIFY, `${lastProblem} on all ${tries} attempts`, res.status);
      }
      if (res.status === 401) throw new ConfluenceError(EXIT.CANNOT_VERIFY, 'Confluence refused the credential (401): check the service account and its token. A token with scopes needs the mode "gateway"', 401);
      if (res.status === 403) throw new ConfluenceError(EXIT.CANNOT_VERIFY, `Confluence says this account may not read this (403): GET ${path}`, 403);
      if (res.status === 404) throw new ConfluenceError(EXIT.FAIL, `not found (404): GET ${path}`, 404);
      if (res.status >= 400) {
        const text = await res.text().catch(() => '');
        throw new ConfluenceError(EXIT.FAIL, `GET ${path} answered ${res.status}: ${text.split('\n')[0].slice(0, 200)}`, res.status);
      }
      if (res.status === 204) return null;
      try {
        return await res.json();
      } catch {
        throw new ConfluenceError(EXIT.INTERNAL, `GET ${path} answered ${res.status} with a body that is not JSON`);
      }
    }
    throw new ConfluenceError(EXIT.CANNOT_VERIFY, lastProblem || `GET ${path} failed`);
  }

  /** Every result of a paged list, following `_links.next`. */
  async function getAll(path, query = {}, max = 5000) {
    const out = [];
    let page = await get(path, query);
    for (;;) {
      if (!page || !Array.isArray(page.results)) throw new ConfluenceError(EXIT.INTERNAL, `GET ${path} answered without a results list`);
      out.push(...page.results);
      const next = nextOf(page._links);
      if (!next || out.length >= max) return out;
      const u = new URL(`${base}${next}`);
      page = await get(u.pathname.slice(new URL(base).pathname.replace(/\/+$/, '').length), Object.fromEntries(u.searchParams));
    }
  }

  return {
    get,
    getAll,
    /** The account the token belongs to. Confluence answers an anonymous user for a credential it did not take. */
    async whoami() {
      const me = await get('/wiki/rest/api/user/current');
      if (!me || me.type === 'anonymous') throw new ConfluenceError(EXIT.CANNOT_VERIFY, 'Confluence treats the request as anonymous: the credential was not accepted', 401);
      return { accountId: me.accountId, displayName: me.displayName || me.publicName || me.accountId };
    },
    async space(key) {
      const r = await get('/wiki/api/v2/spaces', { keys: key });
      const s = r && Array.isArray(r.results) ? r.results[0] : null;
      if (!s) throw new ConfluenceError(EXIT.CANNOT_VERIFY, `space ${key} is not visible to this account`, 403);
      return s;
    },
    /** A folder or a page, without a body. */
    node: (type, id) => get(`/wiki/api/v2/${type === 'folder' ? 'folders' : 'pages'}/${encodeURIComponent(id)}`),
    /** The direct children of a page or a folder, of every content type. */
    children: (type, id) => getAll(`/wiki/api/v2/${type === 'folder' ? 'folders' : 'pages'}/${encodeURIComponent(id)}/direct-children`, { limit: 100 }),
    /** A page with its body in Atlassian Document Format, parsed. */
    async page(id) {
      const p = await get(`/wiki/api/v2/pages/${encodeURIComponent(id)}`, { 'body-format': 'atlas_doc_format' });
      const raw = p && p.body && p.body.atlas_doc_format ? p.body.atlas_doc_format.value : null;
      if (typeof raw !== 'string') throw new ConfluenceError(EXIT.INTERNAL, `page ${id} answered without an atlas_doc_format body`);
      let adf;
      try { adf = JSON.parse(raw); } catch { throw new ConfluenceError(EXIT.INTERNAL, `page ${id} carries a body that is not JSON`); }
      return { ...p, adf };
    },
    labels: async (id) => (await getAll(`/wiki/api/v2/pages/${encodeURIComponent(id)}/labels`, { limit: 100 })).map((l) => l.name),
    /** The content a CQL query finds, as { id, type, title }. */
    async search(cql, max = 50) {
      const found = await getAll('/wiki/rest/api/search', { cql, limit: 25 }, max);
      return found.map((r) => r.content || r).filter((c) => c && c.id).map((c) => ({ id: String(c.id), type: c.type, title: c.title }));
    },
    /** A person's display name, for the pull request (R-18). Null when Confluence does not say. */
    async person(accountId) {
      if (!accountId) return null;
      try {
        const u = await get('/wiki/rest/api/user', { accountId });
        return (u && (u.displayName || u.publicName)) || null;
      } catch (err) {
        if (err instanceof ConfluenceError && err.exit === EXIT.FAIL) return null;
        throw err;
      }
    },
  };
}

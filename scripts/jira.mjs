// Part of the harness asset library c6f3b4427d58f7c3 (see VERSION.json) · 2026-10-09
/**
 * jira.mjs — a small, honest client for the parts of Jira Cloud's REST API the mirror uses.
 *
 * Shared by `jira-sync.mjs`. Not a command. Node standard library only: `fetch`, `AbortSignal`.
 *
 * What it does, and what it will not:
 *
 *   - It authenticates as the developer, with a credential the caller reads from that
 *     developer's own environment. An API token goes as HTTP basic, `<user>:<token>`. An OAuth
 *     2.0 access token goes as a bearer header, with no user, because the token says who it is.
 *     It stores nothing and logs no header.
 *   - It retries what is worth retrying: 429, 502, 503 and 504, honouring `Retry-After`, with a
 *     capped exponential backoff and jitter, up to `tries` attempts. A network error is retried
 *     the same way. Nothing else is retried.
 *   - It never retries a 401 or a 403. Those are "cannot verify": the credential is wrong or the
 *     account may not do this, and asking again says the same thing.
 *   - Every failure is a `JiraError` with a harness exit code, so the caller's exit code is
 *     decided in one place: 2 for cannot verify (unreachable, 401, 403, 5xx after retries,
 *     429 after retries), 1 for a verified refusal (404, 400, 409), 4 for a reply it cannot read.
 *   - It writes only what the mirror needs, and never retries a write blindly. A create, a
 *     transition and a comment are not idempotent: a 502 or a lost reply may mean it happened.
 *     So such a write is retried only on a 429 (Jira had not started on it); any other failure
 *     is reported as "may or may not have been done", and the caller finds out by looking: for
 *     a create, a search for the harness key's label; for a transition, the ticket's status;
 *     for a comment, its marker. A label add is idempotent and is retried like a read.
 *
 * What this module cannot see
 *   - Whether the response shapes it reads are the ones a given site returns after Atlassian
 *     changes them. Each reader checks the fields it needs and says which is missing.
 */

export const EXIT = { PASS: 0, FAIL: 1, CANNOT_VERIFY: 2, USAGE: 3, INTERNAL: 4 };

/**
 * A refusal or a failure of Jira. `reason`, when Jira's answer cannot be verified, is a token of
 * spoke-remote.mjs's REASONS: a refused credential, another answer of Jira, or no answer. This
 * client imports nothing, so it names the three tokens itself.
 */
export class JiraError extends Error {
  constructor(exit, message, status = null) {
    super(message);
    this.name = 'JiraError';
    this.exit = exit;
    this.status = status;
    this.reason = exit !== EXIT.CANNOT_VERIFY ? null
      : status === 401 || status === 403 ? 'auth-failed' : status ? 'tracker-failed' : 'tracker-unreachable';
  }
}

const RETRY_STATUS = new Set([429, 502, 503, 504]);

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
 * @param {object} o
 * @param {string} o.baseUrl   `https://<site>`, or `https://api.atlassian.com/ex/jira/<cloudId>`
 * @param {string} [o.user]    the developer's account email, for an API token
 * @param {string} o.token     the developer's API token, or their OAuth 2.0 access token
 * @param {'basic'|'bearer'} [o.scheme] `basic` for an API token (default), `bearer` for an OAuth token
 * @param {number} [o.tries]   attempts per request, default 4
 * @param {number} [o.baseDelayMs] first backoff, default 500
 * @param {number} [o.maxDelayMs]  backoff cap, default 8000
 * @param {number} [o.timeoutMs]   per attempt, default 20000
 * @param {(ms:number)=>Promise<void>} [o.wait] for fixtures
 */
export function createClient({ baseUrl, user, token, scheme = 'basic', tries = 4, baseDelayMs = 500, maxDelayMs = 8000, timeoutMs = 20000, wait = sleep }) {
  if (scheme !== 'basic' && scheme !== 'bearer') throw new JiraError(EXIT.INTERNAL, `unknown auth scheme ${JSON.stringify(scheme)}`);
  const root = baseUrl.replace(/\/+$/, '');
  const authorization = scheme === 'bearer'
    ? `Bearer ${token}`
    : `Basic ${Buffer.from(`${user}:${token}`).toString('base64')}`;
  const refused = scheme === 'bearer'
    ? `Jira refused the credential (401): check the OAuth access token this developer's environment holds. An access token expires, so get a new one`
    : `Jira refused the credential (401): check the user and token this developer's environment holds`;

  async function request(method, path, { query, body, idempotent = method === 'GET' } = {}) {
    const retryable = idempotent ? RETRY_STATUS : new Set([429]);
    const url = new URL(`${root}${path}`);
    for (const [k, v] of Object.entries(query || {})) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    let lastProblem = '';
    for (let attempt = 1; attempt <= tries; attempt += 1) {
      let res;
      try {
        res = await fetch(url, {
          method,
          headers: {
            Authorization: authorization,
            Accept: 'application/json',
            ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        lastProblem = `cannot reach ${root}: ${err && err.cause && err.cause.code ? err.cause.code : err.message}`;
        if (!idempotent) throw new JiraError(EXIT.CANNOT_VERIFY, `${lastProblem}; the ${method} ${path} may or may not have been done`);
        if (attempt < tries) { await wait(backoff(attempt, null)); continue; }
        throw new JiraError(EXIT.CANNOT_VERIFY, lastProblem);
      }
      if (RETRY_STATUS.has(res.status) && !retryable.has(res.status)) {
        throw new JiraError(EXIT.CANNOT_VERIFY, `${method} ${path} answered ${res.status}; it may or may not have been done`, res.status);
      }
      if (retryable.has(res.status)) {
        lastProblem = `${method} ${path} answered ${res.status}`;
        if (attempt < tries) { await wait(backoff(attempt, retryAfterMs(res.headers.get('retry-after')))); continue; }
        throw new JiraError(EXIT.CANNOT_VERIFY, `${lastProblem} on all ${tries} attempts`, res.status);
      }
      if (res.status === 401) throw new JiraError(EXIT.CANNOT_VERIFY, refused, 401);
      if (res.status === 403) throw new JiraError(EXIT.CANNOT_VERIFY, `Jira says this account may not do that (403): ${method} ${path}`, 403);
      if (res.status === 404) throw new JiraError(EXIT.FAIL, `not found (404): ${method} ${path}`, 404);
      if (res.status >= 400) {
        const text = await res.text().catch(() => '');
        throw new JiraError(EXIT.FAIL, `${method} ${path} answered ${res.status}: ${firstLine(text)}`, res.status);
      }
      if (res.status === 204) return null;
      try {
        return await res.json();
      } catch (err) {
        throw new JiraError(EXIT.INTERNAL, `${method} ${path} answered ${res.status} with a body that is not JSON`);
      }
    }
    throw new JiraError(EXIT.CANNOT_VERIFY, lastProblem || `${method} ${path} failed`);
  }

  function backoff(attempt, hinted) {
    if (hinted !== null) return Math.min(hinted, 60000);
    const capped = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
    return Math.round(capped / 2 + Math.random() * (capped / 2));
  }

  const need = (value, what) => {
    if (value === undefined || value === null) throw new JiraError(EXIT.INTERNAL, `Jira's reply has no ${what}; the API may have changed`);
    return value;
  };

  let who = null;

  return {
    /** Who the credential is. Printed before any write: "acting as". */
    async myself() {
      if (!who) {
        const me = await request('GET', '/rest/api/3/myself');
        who = { accountId: need(me.accountId, 'accountId'), displayName: need(me.displayName, 'displayName'), email: me.emailAddress || null };
      }
      return who;
    },

    /** One issue, with the fields the planner reads. `extra` names more, such as the sprint field. */
    async issue(key, extra = []) {
      const fields = ['status', 'labels', 'project', 'parent', 'issuetype', 'summary', ...extra];
      const i = await request('GET', `/rest/api/3/issue/${encodeURIComponent(key)}`, { query: { fields: fields.join(',') } });
      const f = need(i.fields, 'fields');
      return {
        key: need(i.key, 'key'),
        id: need(i.id, 'id'),
        status: { id: need(f.status && f.status.id, 'status.id'), name: need(f.status && f.status.name, 'status.name'), category: f.status.statusCategory && f.status.statusCategory.key ? f.status.statusCategory.key : null },
        labels: Array.isArray(f.labels) ? f.labels : [],
        project: need(f.project && f.project.key, 'project.key'),
        parent: f.parent ? f.parent.key : null,
        issueType: f.issuetype ? f.issuetype.name : null,
        summary: f.summary || '',
        fields: f,
      };
    },

    /**
     * The transitions a ticket can take now, with the fields each asks for. Only what the planner
     * needs: id, the target status, whether it is global or looped, and any required field with
     * no default.
     */
    async transitions(key) {
      const r = await request('GET', `/rest/api/3/issue/${encodeURIComponent(key)}/transitions`, { query: { expand: 'transitions.fields' } });
      return need(r.transitions, 'transitions').map((t) => ({
        id: need(t.id, 'transition id'),
        name: t.name || '',
        to: { id: need(t.to && t.to.id, 'transition to.id'), name: need(t.to && t.to.name, 'transition to.name') },
        isAvailable: t.isAvailable !== false,
        isGlobal: t.isGlobal === true,
        isLooped: t.isLooped === true,
        hasScreen: t.hasScreen === true,
        requiredFields: Object.entries(t.fields || {})
          .filter(([, spec]) => spec && spec.required === true && spec.hasDefaultValue !== true)
          .map(([id, spec]) => ({ id, name: spec.name || id })),
      }));
    },

    /** JQL search, paged with `nextPageToken` to the end or to `limit`. */
    async search(jql, { fields = ['summary', 'status', 'labels', 'project'], limit = 100 } = {}) {
      const out = [];
      let nextPageToken;
      do {
        // A POST that only reads, so it is retried like a GET.
        const r = await request('POST', '/rest/api/3/search/jql', {
          body: { jql, fields, maxResults: Math.min(100, limit - out.length), ...(nextPageToken ? { nextPageToken } : {}) },
          idempotent: true,
        });
        for (const i of need(r.issues, 'issues')) {
          out.push({
            key: i.key,
            id: i.id,
            summary: (i.fields && i.fields.summary) || '',
            status: i.fields && i.fields.status ? { id: i.fields.status.id, name: i.fields.status.name } : null,
            labels: (i.fields && i.fields.labels) || [],
            project: i.fields && i.fields.project ? i.fields.project.key : null,
            fields: i.fields || {},
          });
        }
        nextPageToken = r.isLast === false || (r.isLast === undefined && r.nextPageToken) ? r.nextPageToken : undefined;
      } while (nextPageToken && out.length < limit);
      return out;
    },

    /**
     * The fields Jira will insist on when a ticket of this type is created, that have no default
     * and that the caller does not set itself. `null` when the project's create metadata cannot
     * be read, which the caller reports and does not treat as "none required".
     */
    async requiredCreateFields(project, issueTypeName, provided = []) {
      const known = new Set(['project', 'issuetype', 'summary', 'reporter', 'description', 'labels', 'parent', ...provided]);
      try {
        const types = await request('GET', `/rest/api/3/issue/createmeta/${encodeURIComponent(project)}/issuetypes`, { query: { maxResults: 100 } });
        const list = types.issueTypes || types.values || [];
        const type = list.find((t) => t.name === issueTypeName);
        if (!type) return { missingType: true, available: list.map((t) => t.name).filter(Boolean), fields: [] };
        const out = [];
        let startAt = 0;
        for (let page = 0; page < 20; page += 1) {
          const r = await request('GET', `/rest/api/3/issue/createmeta/${encodeURIComponent(project)}/issuetypes/${encodeURIComponent(type.id)}`, { query: { startAt, maxResults: 100 } });
          const fields = r.fields || r.values || [];
          for (const f of Array.isArray(fields) ? fields : Object.values(fields)) {
            const id = f.fieldId || f.key;
            if (f.required === true && f.hasDefaultValue !== true && id && !known.has(id)) out.push({ id, name: f.name || id });
          }
          const total = typeof r.total === 'number' ? r.total : fields.length;
          startAt += fields.length;
          if (!fields.length || startAt >= total) break;
        }
        return { missingType: false, fields: out };
      } catch (err) {
        if (err instanceof JiraError && (err.status === 403 || err.status === 404)) return null;
        throw err;
      }
    },

    /** The issue types a project offers, as `{ name, subtask }`; `null` when its create metadata cannot be read. */
    async issueTypes(project) {
      try {
        const r = await request('GET', `/rest/api/3/issue/createmeta/${encodeURIComponent(project)}/issuetypes`, { query: { maxResults: 100 } });
        return (r.issueTypes || r.values || []).filter((t) => t.name).map((t) => ({ name: t.name, subtask: t.subtask === true }));
      } catch (err) {
        if (err instanceof JiraError && (err.status === 403 || err.status === 404)) return null;
        throw err;
      }
    },

    /**
     * Create one ticket. Never retried (see the header): a failure that is not a verified refusal
     * says the ticket may exist, and the caller searches for its label before trying again.
     * `fields` is merged over the standard ones, which is where a type's create defaults go.
     */
    async createIssue({ project, issueType, summary, labels = [], parent = null, description = null, fields = {} }) {
      const body = {
        fields: {
          ...fields,
          project: { key: project },
          issuetype: { name: issueType },
          summary,
          labels,
          ...(parent ? { parent: { key: parent } } : {}),
          ...(description ? { description: adoc(description) } : {}),
        },
      };
      const r = await request('POST', '/rest/api/3/issue', { body, idempotent: false });
      return { key: need(r.key, 'key of the created issue'), id: need(r.id, 'id of the created issue') };
    },

    /**
     * Take one transition. Not idempotent and never retried but on a 429: a failed reply may
     * mean the ticket moved, so the caller reads the ticket's status and decides what is left.
     */
    async transition(key, transitionId) {
      await request('POST', `/rest/api/3/issue/${encodeURIComponent(key)}/transitions`, { body: { transition: { id: String(transitionId) } }, idempotent: false });
    },

    /** Add labels. Idempotent, so retried like a read. */
    async addLabels(key, labels) {
      await request('PUT', `/rest/api/3/issue/${encodeURIComponent(key)}`, { body: { update: { labels: labels.map((add) => ({ add })) } }, idempotent: true });
    },

    async removeLabel(key, label) {
      await request('PUT', `/rest/api/3/issue/${encodeURIComponent(key)}`, { body: { update: { labels: [{ remove: label }] } }, idempotent: true });
    },

    /** Every comment on a ticket, paged, as { text, accountId } for finding a marker the harness wrote. */
    async comments(key) {
      const out = [];
      let startAt = 0;
      for (let page = 0; page < 50; page += 1) {
        const r = await request('GET', `/rest/api/3/issue/${encodeURIComponent(key)}/comment`, { query: { startAt, maxResults: 100 } });
        const list = need(r.comments, 'comments');
        for (const c of list) out.push({ text: plainText(c.body), accountId: c.author && c.author.accountId ? c.author.accountId : null });
        startAt += list.length;
        if (!list.length || startAt >= (typeof r.total === 'number' ? r.total : startAt)) break;
      }
      return out;
    },

    /** Add one comment. Not idempotent: the caller looks for its marker first. */
    async addComment(key, text) {
      await request('POST', `/rest/api/3/issue/${encodeURIComponent(key)}/comment`, { body: { body: adoc(text) }, idempotent: false });
    },

    /** A board's active sprints. */
    async activeSprints(boardId) {
      try {
        const r = await request('GET', `/rest/agile/1.0/board/${encodeURIComponent(boardId)}/sprint`, { query: { state: 'active' } });
        return need(r.values, 'sprints').map((sp) => ({ id: sp.id, name: sp.name }));
      } catch (err) {
        // A Kanban board has no sprints, and Jira answers its sprint list with a 400.
        if (err instanceof JiraError && err.exit === EXIT.FAIL && err.status === 400) return [];
        throw err;
      }
    },

    async addToSprint(sprintId, key) {
      await request('POST', `/rest/agile/1.0/sprint/${encodeURIComponent(sprintId)}/issue`, { body: { issues: [key] }, idempotent: false });
    },

    /** Every status name and id the project's workflows use, across issue types. */
    async projectStatuses(project) {
      const r = await request('GET', `/rest/api/3/project/${encodeURIComponent(project)}/statuses`);
      const byName = {};
      for (const type of Array.isArray(r) ? r : []) {
        for (const s of type.statuses || []) byName[s.name] = String(s.id);
      }
      return byName;
    },

    /** The sprint field's id: the one custom field whose schema is Jira Software's sprint. */
    async sprintField() {
      const all = await request('GET', '/rest/api/3/field');
      const hit = (Array.isArray(all) ? all : []).filter((f) => f.custom === true && f.schema && f.schema.custom === 'com.pyxis.greenhopper.jira:gh-sprint');
      return hit.length === 1 ? hit[0].id : null;
    },
  };
}

function firstLine(text) {
  return String(text || '').split('\n').find((l) => l.trim()) || '';
}

// A paragraph per line, as Atlassian Document Format: the form Jira Cloud's v3 API takes for text.
export function adoc(text) {
  return {
    type: 'doc',
    version: 1,
    content: String(text).split('\n').filter((l) => l.trim() !== '').map((line) => ({ type: 'paragraph', content: [{ type: 'text', text: line }] })),
  };
}

// The text inside an Atlassian Document Format body (or a plain string), for reading a marker back.
export function plainText(node) {
  if (typeof node === 'string') return node;
  if (!node || typeof node !== 'object') return '';
  if (typeof node.text === 'string') return node.text;
  return (Array.isArray(node.content) ? node.content : []).map(plainText).join(node.type === 'doc' ? '\n' : '');
}

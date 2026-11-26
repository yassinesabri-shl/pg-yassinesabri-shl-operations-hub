/**
 * fake-jira.mjs — a small in-memory Jira, for the jira-sync fixtures.
 *
 * It answers the handful of endpoints `jira.mjs` reads, over real HTTP on a port the operating
 * system picks, so the shipped script is run exactly as a developer would run it and only the
 * site is made up. It is a stand-in for the parts of Jira the mirror depends on, and nothing more:
 *
 *   GET  /rest/api/3/myself
 *   GET  /rest/api/3/issue/{key}
 *   GET  /rest/api/3/issue/{key}/transitions      (expand=transitions.fields)
 *   POST /rest/api/3/search/jql                   (labels = "X", or issuetype = Epic)
 *   GET  /rest/api/3/project/{key}/statuses
 *   GET  /rest/api/3/field
 *   POST /rest/api/3/issue                        (create; Epic, Story, Defect with a parent)
 *   PUT  /rest/api/3/issue/{key}                  (labels: add and remove)
 *   POST /rest/api/3/issue/{key}/transitions      (a move; may land elsewhere, may lose its reply)
 *   GET|POST /rest/api/3/issue/{key}/comment
 *   GET  /rest/agile/1.0/board/{id}/sprint        (active sprints)
 *   POST /rest/agile/1.0/sprint/{id}/issue        (add to a sprint)
 *   GET  /rest/api/3/issue/createmeta/{project}/issuetypes[/{id}]
 *
 * Every request is logged with its method, its path and the scheme of its Authorization header,
 * so a fixture can assert that a read-only run made no write, and which credential reached Jira.
 * The fake accepts the API token as HTTP basic and the OAuth access token as a bearer header,
 * and nothing else. A fixture may also arrange a failure: `script` holds responses to give the next
 * requests in order (`{ status: 429, headers: { 'retry-after': '0' } }`, `{ status: 503 }`,
 * `{ status: 401 }`), and `searchLag` makes the next N searches answer with nothing, as Jira's
 * index does just after a create.
 *
 * Node standard library only.
 */

import { createServer } from 'node:http';

export const STATUS = {
  Backlog: '10029', 'In Analysis': '10043', 'Ready for Development': '10045', 'In Development': '10095',
  'Awaiting Code Review': '10324', 'Awaiting QA': '10297', Done: '10019',
};
const NAME_OF = Object.fromEntries(Object.entries(STATUS).map(([n, id]) => [id, n]));

// The Story workflow as the SHL board shows it: forward by one step, a global way back to Backlog.
// `from` is a status name, or '*' for every status.
export function storyWorkflow() {
  return [
    { id: '264', name: 'Analyse', from: 'Backlog', to: 'In Analysis' },
    { id: '274', name: 'Ready for Development', from: 'In Analysis', to: 'Ready for Development' },
    { id: '284', name: 'In Development', from: 'Ready for Development', to: 'In Development' },
    { id: '294', name: 'Development Done', from: 'In Development', to: 'Awaiting Code Review' },
    { id: '494', name: 'Code Review Done', from: 'Awaiting Code Review', to: 'Awaiting QA' },
    { id: '474', name: 'Backlog (2)', from: '*', to: 'Backlog', isGlobal: true },
  ];
}

export function defectWorkflow() {
  return [
    { id: '11', name: 'Start Work', from: 'Backlog', to: 'In Development', hasScreen: true },
    { id: '61', name: 'Implementation Done', from: 'In Development', to: 'Awaiting QA' },
    { id: '131', name: 'Backlog', from: '*', to: 'Backlog', isGlobal: true },
  ];
}

export async function startFake({ issues = [], workflows = {}, sprintField = 'customfield_10020', me = { accountId: 'acc-1', displayName: 'Fixture Developer', emailAddress: 'dev@example.invalid' }, credentials = { user: 'dev@example.invalid', token: 'fixture-token', bearer: 'fixture-oauth-token' } } = {}) {
  const state = {
    issues: new Map(),
    workflows: { Story: storyWorkflow(), Defect: defectWorkflow(), ...workflows },
    requests: [],
    script: [],
    searchLag: 0,
    nextId: 20000,
    nextKey: {},
    // What a project insists on at create, by issue type name: [{ id, name }]. Empty by default.
    required: {},
    // Hidden from search for the next N searches after a create: Jira's index lags.
    createdLag: 0,
    created: [],
    rateLimitCreate: 0,
    failCreateAfter: null,
    // Active sprints per board id: [{ id, name }]
    sprints: {},
    // A transition that lands in a different status than it names, by transition id.
    transitionLands: {},
    rateLimitTransition: 0,
    // The next transition is applied and then the reply is a 503: the ticket moved, the caller was told it failed.
    lostTransitionReply: false,
    // The next transition is refused with a 503 before anything changes.
    failTransition503: false,
    // The next N label updates answer 503 before anything changes.
    failLabelPut: 0,
    // The Nth transition (counting from 1) is taken and then the reply is a 503.
    lostTransitionReplyAt: null,
    transitionsTaken: 0,
    // The next N comment posts answer 503 before anything changes.
    failCommentPost: 0,
    // Tickets whose reads always answer 503.
    brokenIssues: [],
    // Tickets whose reads always answer 403: the credential may not see them, and the run must stop.
    forbiddenIssues: [],
    // A Kanban board has no sprints: its sprint list is a 400.
    kanban: false,
    // The Nth create is made, and then the reply is a 502: the ticket exists, the caller is told it failed.
    loseCreateReplyAt: null,
    // How many searches that ticket stays out of the index for (a fresh create's lag, for the lost one only).
    lostCreateLag: 0,
    // The next N searches answer 502 before doing anything.
    failSearch: 0,
    // Fields only the create call enforces: createmeta does not mention them, the POST refuses without them.
    hiddenRequired: {},
  };
  for (const i of issues) addIssue(state, i);

  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const url = new URL(req.url, 'http://fake');
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null;
      const presented = req.headers.authorization || '';
      state.requests.push({ method: req.method, path: url.pathname, scheme: presented.split(' ')[0] || null });
      const send = (status, payload, headers = {}) => {
        res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
        res.end(payload === undefined ? '' : JSON.stringify(payload));
      };

      const basic = `Basic ${Buffer.from(`${credentials.user}:${credentials.token}`).toString('base64')}`;
      const bearer = `Bearer ${credentials.bearer}`;
      if (presented !== basic && presented !== bearer) return send(401, { errorMessages: ['bad credential'] });
      const forced = state.script.shift();
      if (forced) return send(forced.status, forced.body || {}, forced.headers || {});

      let m;
      if (req.method === 'GET' && url.pathname === '/rest/api/3/myself') return send(200, me);
      if (req.method === 'GET' && url.pathname === '/rest/api/3/field') {
        return send(200, [
          { id: 'summary', name: 'Summary', custom: false },
          { id: sprintField, name: 'Sprint', custom: true, schema: { custom: 'com.pyxis.greenhopper.jira:gh-sprint' } },
        ]);
      }
      if (req.method === 'GET' && (m = /^\/rest\/api\/3\/project\/([A-Z0-9_]+)\/statuses$/.exec(url.pathname))) {
        return send(200, [{ id: '10125', name: 'Story', statuses: Object.entries(STATUS).map(([name, id]) => ({ id, name })) }]);
      }
      if (req.method === 'GET' && (m = /^\/rest\/api\/3\/issue\/([A-Z][A-Z0-9_]*-\d+)\/transitions$/.exec(url.pathname))) {
        const issue = state.issues.get(m[1]);
        if (!issue) return send(404, { errorMessages: ['Issue does not exist'] });
        const wf = state.workflows[issue.issueType] || [];
        const out = wf
          .filter((t) => t.from === '*' || t.from === issue.status.name)
          .map((t) => ({
            id: t.id, name: t.name,
            to: { id: STATUS[t.to], name: t.to },
            hasScreen: t.hasScreen === true, isGlobal: t.isGlobal === true, isLooped: t.isLooped === true,
            isAvailable: t.isAvailable !== false, isConditional: false,
            fields: Object.fromEntries((t.requiredFields || []).map((f) => [f, { required: true, name: f, hasDefaultValue: false }])),
          }));
        return send(200, { transitions: out });
      }
      if (req.method === 'GET' && (m = /^\/rest\/api\/3\/issue\/([A-Z][A-Z0-9_]*-\d+)$/.exec(url.pathname))) {
        if (state.brokenIssues.includes(m[1])) return send(503, { errorMessages: ['unavailable'] });
        if (state.forbiddenIssues.includes(m[1])) return send(403, { errorMessages: ['no permission'] });
        const issue = state.issues.get(m[1]);
        if (!issue) return send(404, { errorMessages: ['Issue does not exist'] });
        return send(200, render(issue, sprintField));
      }
      if (req.method === 'POST' && url.pathname === '/rest/api/3/search/jql') {
        if (state.failSearch > 0) { state.failSearch -= 1; return send(502, { errorMessages: ['bad gateway'] }); }
        if (state.searchLag > 0) { state.searchLag -= 1; return send(200, { issues: [], isLast: true }); }
        const jql = String(body.jql || '');
        // Real JQL reads an unquoted IN, IS, OR, AND or NOT after `project =` as an operator.
        if (/project\s*=\s*(IN|IS|OR|AND|NOT)\b/.test(jql)) return send(400, { errorMessages: [`Error in the JQL Query: unquoted reserved word in ${jql}`] });
        // A freshly created ticket is not in the index yet: hidden for `hiddenUntilSearches` searches.
        for (const i of state.issues.values()) if (i.hiddenUntilSearches > 0) i.pending = true;
        let hits = [...state.issues.values()].filter((i) => !(i.hiddenUntilSearches > 0));
        for (const i of state.issues.values()) if (i.hiddenUntilSearches > 0) i.hiddenUntilSearches -= 1;
        const label = /labels\s*=\s*"([^"]+)"/.exec(jql);
        const labelIn = /labels\s+in\s*\(([^)]*)\)/.exec(jql);
        if (labelIn) {
          const wanted = [...labelIn[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
          hits = hits.filter((i) => i.labels.some((l) => wanted.includes(l)));
        } else if (label) hits = hits.filter((i) => i.labels.includes(label[1]));
        if (/issuetype\s*=\s*Epic/i.test(jql)) {
          const project = /project\s*=\s*"?([A-Z][A-Z0-9_]*)"?/.exec(jql);
          hits = hits.filter((i) => i.issueType === 'Epic' && (!project || i.project === project[1]));
        }
        const inProject = /project\s*=\s*"?([A-Z][A-Z0-9_]*)"?/.exec(jql);
        if (inProject) hits = hits.filter((i) => i.project === inProject[1]);
        const start = body.nextPageToken ? Number(body.nextPageToken) : 0;
        const size = Math.min(body.maxResults || 50, state.pageSize || 50);
        const page = hits.slice(start, start + size);
        const more = start + size < hits.length;
        return send(200, { issues: page.map((i) => render(i, sprintField)), isLast: !more, ...(more ? { nextPageToken: String(start + size) } : {}) });
      }
      if (req.method === 'POST' && (m = /^\/rest\/api\/3\/issue\/([A-Z][A-Z0-9_]*-\d+)\/transitions$/.exec(url.pathname))) {
        const issue = state.issues.get(m[1]);
        if (!issue) return send(404, { errorMessages: ['Issue does not exist'] });
        if (state.rateLimitTransition > 0) { state.rateLimitTransition -= 1; return send(429, {}, { 'retry-after': '0' }); }
        if (state.failTransition503) { state.failTransition503 = false; return send(503, { errorMessages: ['unavailable'] }); }
        const wf = state.workflows[issue.issueType] || [];
        const t = wf.find((x) => x.id === String(body && body.transition && body.transition.id) && (x.from === '*' || x.from === issue.status.name));
        if (!t) return send(400, { errorMessages: ['Transition is not valid for this issue'] });
        if ((t.requiredFields || []).length && !(body.fields && Object.keys(body.fields).length)) return send(400, { errors: Object.fromEntries(t.requiredFields.map((f) => [f, `${f} is required`])) });
        const lands = state.transitionLands[t.id] || t.to;
        issue.status = { id: STATUS[lands], name: lands };
        state.transitionsTaken += 1;
        if (state.lostTransitionReplyAt !== null && state.transitionsTaken === state.lostTransitionReplyAt) { state.lostTransitionReplyAt = null; return send(503, { errorMessages: ['unavailable'] }); }
        if (state.lostTransitionReply) { state.lostTransitionReply = false; return send(503, { errorMessages: ['unavailable'] }); }
        return send(204);
      }
      if (req.method === 'PUT' && (m = /^\/rest\/api\/3\/issue\/([A-Z][A-Z0-9_]*-\d+)$/.exec(url.pathname))) {
        const issue = state.issues.get(m[1]);
        if (!issue) return send(404, { errorMessages: ['Issue does not exist'] });
        if (state.failLabelPut > 0) { state.failLabelPut -= 1; return send(503, { errorMessages: ['unavailable'] }); }
        for (const op of (body && body.update && body.update.labels) || []) {
          if (op.add && !issue.labels.includes(op.add)) issue.labels.push(op.add);
          if (op.remove) issue.labels = issue.labels.filter((l) => l !== op.remove);
        }
        return send(204);
      }
      if ((m = /^\/rest\/api\/3\/issue\/([A-Z][A-Z0-9_]*-\d+)\/comment$/.exec(url.pathname))) {
        const issue = state.issues.get(m[1]);
        if (!issue) return send(404, { errorMessages: ['Issue does not exist'] });
        issue.comments = issue.comments || [];
        if (req.method === 'GET') return send(200, { comments: issue.comments, total: issue.comments.length });
        if (req.method === 'POST' && state.failCommentPost > 0) { state.failCommentPost -= 1; return send(503, { errorMessages: ['unavailable'] }); }
        if (req.method === 'POST') { const c = { id: String(issue.comments.length + 1), body: body.body, author: { accountId: me.accountId } }; issue.comments.push(c); return send(201, c); }
      }
      if (req.method === 'GET' && (m = /^\/rest\/agile\/1\.0\/board\/(\d+)\/sprint$/.exec(url.pathname))) {
        if (state.kanban) return send(400, { errorMessages: ['The board does not support sprints'] });
        return send(200, { values: (state.sprints[m[1]] || []).map((sp) => ({ ...sp, state: 'active' })) });
      }
      if (req.method === 'POST' && (m = /^\/rest\/agile\/1\.0\/sprint\/(\d+)\/issue$/.exec(url.pathname))) {
        for (const k of (body && body.issues) || []) {
          const issue = state.issues.get(k);
          if (issue) issue.sprints = [...(issue.sprints || []), { id: Number(m[1]), boardId: 1153, state: 'active' }];
        }
        return send(204);
      }
      if (req.method === 'GET' && (m = /^\/rest\/api\/3\/issue\/createmeta\/([A-Z][A-Z0-9_]*)\/issuetypes$/.exec(url.pathname))) {
        const ids = state.issueTypeIds || { Story: '10125', Defect: '10134', Epic: '10000', 'Sub-task': '10107' };
        return send(200, { issueTypes: Object.entries(ids).map(([name, id]) => ({ id, name, subtask: /^sub-?task$/i.test(name) })), total: Object.keys(ids).length });
      }
      if (req.method === 'GET' && (m = /^\/rest\/api\/3\/issue\/createmeta\/([A-Z][A-Z0-9_]*)\/issuetypes\/(\d+)$/.exec(url.pathname))) {
        const names = { 10125: 'Story', 10134: 'Defect', 10000: 'Epic', 10107: 'Sub-task' };
        const need = state.required[names[m[2]]] || [];
        return send(200, { fields: [
          { fieldId: 'summary', name: 'Summary', required: true, hasDefaultValue: false },
          ...need.map((n) => ({ fieldId: `customfield_${n.id}`, name: n.name, required: true, hasDefaultValue: false })),
        ], total: 1 + need.length });
      }
      if (req.method === 'POST' && url.pathname === '/rest/api/3/issue') {
        if (state.rateLimitCreate > 0) { state.rateLimitCreate -= 1; return send(429, {}, { 'retry-after': '0' }); }
        if (typeof state.failCreateAfter === 'number' && state.created.length >= state.failCreateAfter) return send(503, { errorMessages: ['unavailable'] });
        const f = (body && body.fields) || {};
        const project = f.project && f.project.key;
        const type = f.issuetype && f.issuetype.name;
        if (!project || !type || !f.summary) return send(400, { errorMessages: ['project, issuetype and summary are required'] });
        const missing = [...(state.required[type] || []), ...(state.hiddenRequired[type] || [])].filter((n) => f[`customfield_${n.id}`] === undefined);
        if (missing.length) return send(400, { errors: Object.fromEntries(missing.map((n) => [`customfield_${n.id}`, `${n.name} is required`])) });
        if (f.parent && !state.issues.has(f.parent.key)) return send(400, { errors: { parent: 'Given parent work item does not exist.' } });
        state.nextKey[project] = (state.nextKey[project] || 300) + 1;
        const key = `${project}-${state.nextKey[project]}`;
        addIssue(state, { key, project, issueType: type, summary: f.summary, labels: f.labels || [], parent: f.parent ? f.parent.key : null, status: 'Backlog' });
        const made = state.issues.get(key);
        made.description = f.description || null;
        made.extra = Object.fromEntries(Object.entries(f).filter(([k]) => k.startsWith('customfield_')));
        state.created.push(key);
        if (state.createdLag > 0) { made.hiddenUntilSearches = state.createdLag; }
        if (state.loseCreateReplyAt !== null && state.created.length === state.loseCreateReplyAt) {
          state.loseCreateReplyAt = null;
          made.hiddenUntilSearches = state.lostCreateLag;
          return send(502, { errorMessages: ['bad gateway'] });
        }
        return send(201, { id: made.id, key, self: `${'http://fake'}/rest/api/3/issue/${made.id}` });
      }
      return send(404, { errorMessages: [`fake-jira has no ${req.method} ${url.pathname}`] });
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    state,
    credentials,
    addIssue: (i) => addIssue(state, i),
    stop: () => new Promise((resolve) => server.close(resolve)),
    writes: () => state.requests.filter((r) => r.method !== 'GET' && !(r.method === 'POST' && r.path === '/rest/api/3/search/jql')),
  };
}

function addIssue(state, i) {
  const key = i.key;
  const n = Number(key.split('-')[1]);
  const status = i.status || 'Backlog';
  state.issues.set(key, {
    id: String(state.nextId + n),
    key,
    summary: i.summary || `${key}: a story`,
    project: i.project || key.split('-')[0],
    issueType: i.issueType || 'Story',
    status: { id: STATUS[status], name: status },
    labels: i.labels || [],
    parent: i.parent || null,
    sprints: i.sprints === undefined ? [] : i.sprints,
    hiddenUntilSearches: i.hiddenUntilSearches || 0,
    comments: i.comments || [],
  });
}

function render(issue, sprintField) {
  return {
    id: issue.id,
    key: issue.key,
    fields: {
      summary: issue.summary,
      status: { ...issue.status, statusCategory: { key: issue.status.name === 'Done' ? 'done' : issue.status.name === 'Backlog' ? 'new' : 'indeterminate' } },
      labels: issue.labels,
      project: { key: issue.project },
      issuetype: { name: issue.issueType },
      parent: issue.parent ? { key: issue.parent } : undefined,
      [sprintField]: issue.sprints,
    },
  };
}

export { NAME_OF };

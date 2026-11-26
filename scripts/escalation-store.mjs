// Part of the harness asset library c6f3b4427d58f7c3 (see VERSION.json) · 2026-11-04
/**
 * escalation-store.mjs — the store of the escalation record. Each escalation is one GitHub issue
 * in the hub, with its comments and one issue artefact that holds the JSON Lines file.
 *
 *   The issue      Its title starts `[shl-harness] `. Its body ends with the marker
 *                  `<!-- shl-escalation id=<ID> -->` and the watermark. Nothing else makes an
 *                  issue a harness issue, and the store never reads, edits, labels or closes any
 *                  other issue in the hub.
 *   A comment      One for each line. It carries the line in a `json` fence and the marker
 *                  `<!-- shl-escalation-line id=<ID> seq=<n> -->`. A comment is an atomic append,
 *                  so two writers can never overwrite each other's line.
 *   The artefact   `escalation-record.jsonl`: every line of the escalation in one `jsonl` fence.
 *                  GitHub keeps every version with its author. The record is this file, and the
 *                  comments are its second copy.
 *
 * The reader rule, `reconcile`, reads each line as the first version of the artefact that held it
 * says, and its comment must say the same. The latest version must say it too. A line that reads
 * differently is exit 2, and the fault names the version or the comment and its author, so a
 * changed line blocks every write until a person restores the version that held it
 * (`gh issue artefact edit --restore-version`). A version in between that changed a line and was
 * restored is a warning. A line that is in the comments but not yet in the artefact is appended on
 * the next write. An artefact that is missing or shorter than its history is rebuilt, with a
 * warning. A deleted comment is a warning, because the artefact keeps the line.
 *
 * GitHub cannot stop a person with Write access from deleting an artefact or a comment. The store
 * warns in the artefact itself, rebuilds what it can, and reports what it cannot.
 *
 * Every call goes through `gh api`, which reads the hub from GH_REPO, GITHUB_REPOSITORY or the
 * checkout's origin. INTEGRATION POINT for a forge other than GitHub. Issue artefacts are a GitHub
 * preview: their calls send `X-GitHub-Api-Version: 2026-03-10`.
 *
 * Node standard library only, plus `gh`.
 */

import { spawnSync } from 'node:child_process';
import { EXIT, SpokeError, firstLine } from './spoke-remote.mjs';
import { parseId, readRecord } from './escalation-record.mjs';

const TITLE_PREFIX = '[shl-harness]';
export const RECORD_ARTEFACT = 'escalation-record.jsonl';
export const FINDINGS_ARTEFACT = 'findings.md';
export const STATE_LABELS = {
  waiting: { name: 'harness-waiting', color: 'fbca04', description: 'Waiting for a person. Nobody has acknowledged it yet' },
  overdue: { name: 'harness-overdue', color: 'd93f0b', description: 'The second wait ended with no answer' },
  acknowledged: { name: 'harness-acknowledged', color: '0e8a16', description: 'A person has taken this escalation. Reminders stop' },
};
const HARNESS_LABELS = new Set(Object.values(STATE_LABELS).map((l) => l.name));
const API_VERSION = '2026-03-10';
const PAGE = 100;
export const WATERMARK = 'Generated-by: SHL Agentic Harness';
const SWEEP_BOT = 'github-actions[bot]';
const ISSUE_MARK = /<!-- shl-escalation id=(ESC-[A-Za-z0-9-]+) -->/;
const LINE_MARK = /<!-- shl-escalation-line id=(ESC-[A-Za-z0-9-]+) seq=(\d+) -->/;
const REPLY_MARK = /<!-- shl-escalation-reply comment=(\d+) -->/;
const JSON_FENCE = /```json\n([\s\S]*?)\n```/;
const JSONL_FENCE = /```jsonl\n([\s\S]*?)\n```/;
const ARTEFACT_NOTE = 'The SHL harness writes this record, one line for each event, and only ever adds a line at the end.\n'
  + 'Do not edit or delete it. The harness checks every version, and a changed line stops the escalation until a person repairs it.';

const issueMark = (id) => `<!-- shl-escalation id=${id} -->`;
const lineMark = (id, seq) => `<!-- shl-escalation-line id=${id} seq=${seq} -->`;
const replyMark = (commentId) => `<!-- shl-escalation-reply comment=${commentId} -->`;
const isHarnessComment = (c) => String(c.body || '').includes(WATERMARK) && (String(c.body).search(LINE_MARK) !== -1 || String(c.body).search(REPLY_MARK) !== -1) && byWriter(c);

/* ------------------------------------------------------------------------------- gh */

function gh(args, input) {
  const res = spawnSync('gh', args, { encoding: 'utf8', input, env: process.env, maxBuffer: 64 * 1024 * 1024 });
  if (res.error) throw new SpokeError(EXIT.CANNOT_VERIFY, `the escalation record needs the GitHub CLI: ${res.error.message}`, 'gh-unavailable');
  if (res.status !== 0) {
    const err = new SpokeError(EXIT.CANNOT_VERIFY, `gh ${args.slice(0, 4).join(' ')}: ${firstLine(res.stderr) || `exit ${res.status}`}`, 'gh-failed');
    err.detail = res.stderr || '';
    throw err;
  }
  return res.stdout;
}

/** One REST call. `allow` lists HTTP codes that return null instead of throwing. */
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const THROTTLED = /HTTP (429|500|502|503)/;

/** One REST call. `allow` lists HTTP codes that return null instead of throwing. A throttled or failed call is tried twice more. */
function api(method, path, body, { preview = false, allow = [] } = {}) {
  const args = ['api', '-X', method, path, '-H', 'Accept: application/vnd.github+json'];
  if (preview) args.push('-H', `X-GitHub-Api-Version: ${API_VERSION}`);
  if (body !== undefined) args.push('--input', '-');
  for (let attempt = 1; ; attempt += 1) {
    try {
      const out = gh(args, body === undefined ? undefined : JSON.stringify(body));
      return out.trim() ? JSON.parse(out) : null;
    } catch (err) {
      if (err instanceof SpokeError && allow.some((code) => String(err.detail).includes(`HTTP ${code}`))) return null;
      if (err instanceof SyntaxError) throw new SpokeError(EXIT.CANNOT_VERIFY, `gh answered ${path} with text that is not JSON`, 'gh-failed');
      if (attempt < 3 && err instanceof SpokeError && String(err.detail).search(THROTTLED) !== -1) { sleep((process.env.FAKE_GH_STATE ? 10 : 2000) * attempt); continue; }
      throw err;
    }
  }
}

function pages(path, opts = {}) {
  const all = [];
  for (let page = 1; page <= 200; page += 1) {
    const got = api('GET', `${path}${path.includes('?') ? '&' : '?'}per_page=${PAGE}&page=${page}`, undefined, opts);
    if (!Array.isArray(got)) throw new SpokeError(EXIT.CANNOT_VERIFY, `gh answered ${path} with something that is not a list`, 'gh-failed');
    all.push(...got);
    if (got.length < PAGE) return all;
  }
  throw new SpokeError(EXIT.CANNOT_VERIFY, `${path} has more than ${200 * PAGE} entries, so the store does not read them all`, 'gh-failed');
}

let cachedRepo = null;
/** The hub on GitHub, as owner/name. */
export function repo() {
  if (cachedRepo) return cachedRepo;
  const named = process.env.GH_REPO || process.env.GITHUB_REPOSITORY;
  cachedRepo = named ? named.replace(/^https?:\/\/[^/]+\//, '') : gh(['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner']).trim();
  if (!cachedRepo.includes('/')) throw new SpokeError(EXIT.CANNOT_VERIFY, `cannot tell which GitHub repository holds the hub (${cachedRepo || 'no answer'}). Set GH_REPO to owner/name.`, 'gh-repo-unknown');
  return cachedRepo;
}

const permissions = new Map();
/**
 * Whether a login may write to the hub. The sweep's own bot may, and so may a person whose
 * permission on the hub is write or admin. Read access, an org membership and an outside
 * collaborator with Read do not count.
 */
export function mayWrite(login) {
  if (!login) return false;
  if (login === SWEEP_BOT) return true;
  if (!permissions.has(login)) {
    const got = api('GET', `repos/${repo()}/collaborators/${encodeURIComponent(login)}/permission`, undefined, { allow: [404] });
    permissions.set(login, Boolean(got) && ['admin', 'write'].includes(got.permission));
  }
  return permissions.get(login);
}
const byWriter = (c) => mayWrite(c.user ? c.user.login : null);

/* ------------------------------------------------------------------------- reading */

const fenced = (body, fence) => { const m = String(body || '').match(fence); return m ? m[1] : null; };
const norm = (raw) => { try { return JSON.stringify(JSON.parse(raw)); } catch { return String(raw); } };
const linesOfBody = (body) => { const t = fenced(body, JSONL_FENCE); return t === null ? null : t.split('\n').filter((l) => l.trim() !== ''); };

/** Every harness issue in the hub: { number, id, owner, title, state, stateReason, labels, url }. */
export function harnessIssues() {
  return pages(`repos/${repo()}/issues?state=all`)
    .filter((i) => !i.pull_request && typeof i.title === 'string' && i.title.startsWith(`${TITLE_PREFIX} `) && mayWrite(i.user ? i.user.login : null))
    .map((i) => {
      const m = String(i.body || '').match(ISSUE_MARK);
      const parsed = m ? parseId(m[1]) : null;
      return parsed ? {
        number: i.number, id: m[1], owner: parsed.owner, escNumber: parsed.number, title: i.title, state: i.state,
        stateReason: i.state_reason || null, closedAt: i.closed_at || null, labels: (i.labels || []).map((l) => (typeof l === 'string' ? l : l.name)), url: i.html_url,
      } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.escNumber - b.escNumber || a.number - b.number);
}

/** The record artefact of an issue, with every version oldest first, or null. */
function recordArtefact(number) {
  const list = api('GET', `repos/${repo()}/issues/${number}/artifacts?per_page=${PAGE}`, undefined, { preview: true });
  const hit = (list || []).find((a) => a.name === RECORD_ARTEFACT && a.type === 'generic');
  if (!hit) return null;
  const full = api('GET', `repos/${repo()}/issues/${number}/artifacts/${hit.number}`, undefined, { preview: true });
  const art = full && full.artifact ? full.artifact : full;
  const noHistory = !(full && Array.isArray(full.versions) && full.versions.length);
  const raw = noHistory ? [{ version: 1, body: art.body, actor: art.updated_by_actor || art.creator }] : full.versions;
  const versions = raw.map((v) => ({ version: v.version, actor: v.actor ? v.actor.login : null, lines: linesOfBody(v.body) })).sort((a, b) => a.version - b.version);
  return { number: hit.number, url: art.html_url || null, versions, noHistory, latest: versions[versions.length - 1].lines || [] };
}

/** The line comments of one id that a writer posted, oldest first, and the ones nobody may trust. */
function lineComments(comments, id) {
  const out = [];
  out.ignored = [];
  for (const c of comments) {
    const m = String(c.body || '').match(LINE_MARK);
    if (!m || m[1] !== id) continue;
    if (!byWriter(c)) { out.ignored.push(c); continue; }
    const raw = fenced(c.body, JSON_FENCE);
    out.push({ seq: Number(m[2]), raw: raw === null ? '' : raw.trim(), id: c.id, login: c.user ? c.user.login : null });
  }
  return out.sort((a, b) => a.id - b.id);
}

/**
 * The lines of one escalation, from every version of its artefact and from its line comments.
 * Returns { lines, faults, warnings, fold } where `fold` says the artefact must be written again.
 */
function reconcile(id, number, artefact, comments) {
  const faults = [];
  const warnings = [];
  const where = `#${number} ${id}`;
  // Each line reads as the first version of the artefact that held it says, or else as its comment says.
  const first = [];
  if (artefact) {
    for (const v of artefact.versions) {
      if (v.lines === null) { warnings.push(`${where}: version ${v.version} of ${RECORD_ARTEFACT}${v.actor ? ` by ${v.actor}` : ''} holds no jsonl block`); continue; }
      v.lines.forEach((raw, i) => { if (first[i] === undefined) first[i] = { raw: norm(raw), from: `version ${v.version} of ${RECORD_ARTEFACT}${v.actor ? ` by ${v.actor}` : ''}` }; });
    }
  }
  if (artefact && artefact.noHistory) warnings.push(`${where}: GitHub gave no version history of ${RECORD_ARTEFACT}, so only its latest version was checked`);
  const mine = lineComments(comments, id);
  for (const c of mine.ignored) warnings.push(`${where}: comment ${c.id}${c.user ? ` by ${c.user.login}` : ''} carries a record line, but its author cannot write to the hub, so it is ignored`);
  const bySeq = new Map();
  for (const c of mine) {
    const from = `comment ${c.id}${c.login ? ` by ${c.login}` : ''}`;
    if (bySeq.has(c.seq)) {
      if (norm(bySeq.get(c.seq).raw) !== norm(c.raw)) faults.push({ code: 2, duplicate: true, text: `${where}: two comments carry line ${c.seq} with different text (${bySeq.get(c.seq).from} and ${from}). Delete the newer one if no other writer is running`, line: c.seq });
      continue;
    }
    bySeq.set(c.seq, { ...c, from });
  }
  const canon = [];
  const size = Math.max(first.length, ...[...bySeq.keys()].map((s) => s), 0);
  for (let i = 0; i < size; i += 1) {
    const c = bySeq.get(i + 1);
    const f = first[i];
    if (f && c && norm(c.raw) !== f.raw) faults.push({ code: 2, text: `${where}: line ${i + 1} reads differently in ${f.from} and in ${c.from}. The record was changed, so it cannot be verified`, line: i + 1 });
    if (f) canon[i] = f.raw;
    else if (c) canon[i] = norm(c.raw);
  }
  const latest = artefact ? (artefact.versions[artefact.versions.length - 1].lines || []).map(norm) : [];
  if (artefact) {
    const lastV = artefact.versions[artefact.versions.length - 1];
    latest.forEach((l, i) => {
      if (canon[i] !== undefined && l !== canon[i]) faults.push({ code: 2, text: `${where}: line ${i + 1} of the latest ${RECORD_ARTEFACT} (version ${lastV.version}${lastV.actor ? ` by ${lastV.actor}` : ''}) differs from what the line first said. Restore an earlier version, and the record reads again`, line: i + 1 });
    });
    for (const v of artefact.versions.slice(0, -1)) {
      (v.lines || []).forEach((raw, i) => {
        if (canon[i] !== undefined && norm(raw) !== canon[i]) warnings.push(`${where}: version ${v.version} of ${RECORD_ARTEFACT}${v.actor ? ` by ${v.actor}` : ''} changed line ${i + 1}, and a later version restored it`);
      });
    }
  }
  const lines = canon.filter((c) => c !== undefined);
  const fold = lines.length > 0 && (latest.length !== lines.length || latest.some((l, i) => l !== lines[i]));
  if (lines.length && !artefact) warnings.push(`${where}: ${RECORD_ARTEFACT} is missing. It is rebuilt from the line comments`);
  else if (artefact && latest.length < first.length) warnings.push(`${where}: the latest version of ${RECORD_ARTEFACT} lost lines that an earlier version held. They are restored`);
  for (let i = 0; i < latest.length; i += 1) if (!bySeq.has(i + 1)) warnings.push(`${where}: the comment of line ${i + 1} was deleted. The artefact keeps the line`);
  return { lines, faults, warnings, fold };
}

/** One issue, fully read: its comments, its artefact and its reconciled lines. */
function loadIssue(issue) {
  const comments = pages(`repos/${repo()}/issues/${issue.number}/comments`);
  const artefact = recordArtefact(issue.number);
  return { ...issue, comments, artefact, ...reconcile(issue.id, issue.number, artefact, comments) };
}

/**
 * Every escalation of the named owners, or of the whole hub, as `readRecord` sees them, each with
 * its issue. Two issues that carry one id, and an issue with no line, are reported.
 */
export function readEscalations(owners = null, { closedSince = null } = {}) {
  const issues = harnessIssues()
    .filter((i) => (!owners || owners.includes(i.owner)) && !(closedSince && i.state === 'closed' && i.closedAt && Date.parse(i.closedAt) < closedSince))
    .map(loadIssue);
  const faults = issues.flatMap((i) => i.faults);
  const warnings = issues.flatMap((i) => i.warnings);
  const seen = new Map();
  for (const i of issues) {
    if (seen.has(i.id)) faults.push({ code: 2, text: `issues #${seen.get(i.id)} and #${i.number} carry the same id ${i.id}`, line: null });
    else seen.set(i.id, i.number);
  }
  const escalations = [];
  for (const owner of [...new Set(issues.map((i) => i.owner))].sort()) {
    const mine = issues.filter((i) => i.owner === owner && i.lines.length);
    for (const i of issues.filter((x) => x.owner === owner && !x.lines.length)) warnings.push(`#${i.number} ${i.id}: the issue holds no line yet, so it is not on the record`);
    const r = readRecord(owner, mine.map((i) => `${i.lines.join('\n')}\n`).join(''));
    faults.push(...r.faults.map((f) => ({ ...f, text: `${owner}: ${f.text}` })));
    for (const e of r.escalations) escalations.push({ ...e, issue: mine.find((i) => i.id === e.id) || null });
  }
  return { escalations, faults, warnings, issues };
}

/** The record text of one owner: what a writer validates its new lines against. */
export function textOf(read, owner) {
  return read.issues.filter((i) => i.owner === owner && i.lines.length).map((i) => `${i.lines.join('\n')}\n`).join('');
}

/* ------------------------------------------------------------------------- writing */

let labelsReady = false;
function ensureLabels() {
  if (labelsReady) return;
  for (const l of Object.values(STATE_LABELS)) api('POST', `repos/${repo()}/labels`, l, { allow: [422] });
  labelsReady = true;
}

/** Open the issue of a new escalation. Returns { number, url }. */
export function createIssue({ id, title, body }) {
  const made = api('POST', `repos/${repo()}/issues`, { title: `${TITLE_PREFIX} ${title}`, body: `${body}\n\n${issueMark(id)}\n${WATERMARK}\n` });
  return { number: made.number, url: made.html_url };
}

/** Give up an issue whose id another raise took first: its marker goes, and it closes. */
export function abandonIssue(number, why) {
  api('PATCH', `repos/${repo()}/issues/${number}`, { body: `This issue was opened by mistake: ${why}. It is not on the record.\n\n${WATERMARK}\n`, state: 'closed', state_reason: 'not_planned' });
}

/** Post one line as a comment. Returns the comment id. */
export function postLine(number, line, text) {
  const body = `${text}\n\n<details><summary>Record line ${line.seq}</summary>\n\n\`\`\`json\n${JSON.stringify(line)}\n\`\`\`\n</details>\n\n${lineMark(line.id, line.seq)}\n${WATERMARK}\n`;
  return api('POST', `repos/${repo()}/issues/${number}/comments`, { body }).id;
}

export function deleteComment(commentId) {
  api('DELETE', `repos/${repo()}/issues/comments/${commentId}`, undefined, { allow: [404] });
}

/** A reply that is not a record line, posted once for a person's comment. */
export function reply(number, toComment, text) {
  api('POST', `repos/${repo()}/issues/${number}/comments`, { body: `${text}\n\n${replyMark(toComment)}\n${WATERMARK}\n` });
}

/** The line comments of one id on an issue, oldest first: { seq, id }. */
export function lineCommentsOf(number, id) {
  return lineComments(pages(`repos/${repo()}/issues/${number}/comments`), id);
}

export function addFindings(number, text) {
  api('POST', `repos/${repo()}/issues/${number}/artifacts`, { type: 'generic', name: FINDINGS_ARTEFACT, body: text }, { preview: true });
}

function writeArtefact(issue) {
  const body = `${ARTEFACT_NOTE}\n\n\`\`\`jsonl\n${issue.lines.join('\n')}\n\`\`\`\n`;
  if (issue.artefact) api('PATCH', `repos/${repo()}/issues/${issue.number}/artifacts/${issue.artefact.number}`, { body }, { preview: true });
  else api('POST', `repos/${repo()}/issues/${issue.number}/artifacts`, { type: 'generic', name: RECORD_ARTEFACT, body }, { preview: true });
}

/** Whether an issue's label, state or artefact no longer match what its escalation asks for. */
export function needsSettle(issue, want) {
  const desired = want.label ? STATE_LABELS[want.label].name : null;
  const have = issue.labels.filter((l) => HARNESS_LABELS.has(l));
  const labelsOk = have.length === (desired ? 1 : 0) && (!desired || have[0] === desired);
  return issue.fold || !labelsOk || (want.close ? issue.state !== 'closed' : issue.state !== 'open');
}

/**
 * Bring one issue in line with its record: append the lines the artefact lacks, set the one
 * state label, and close or reopen it. `stateOf(esc)` gives { label, close } for the escalation
 * the issue holds: `label` is a key of STATE_LABELS or null, `close` is null, 'completed' or
 * 'not_planned'. Returns what it changed, and the faults that stopped it.
 */
export function settle(issue, stateOf, { repair = false } = {}) {
  const now = api('GET', `repos/${repo()}/issues/${issue.number}`);
  const fresh = loadIssue({ ...issue, state: now.state, labels: (now.labels || []).map((l) => l.name) });
  const changed = [];
  if (fresh.faults.length) return { changed, faults: fresh.faults, warnings: fresh.warnings };
  const r = readRecord(issue.owner, `${fresh.lines.join('\n')}\n`);
  if (r.faults.length) return { changed, faults: r.faults, warnings: fresh.warnings };
  if (fresh.fold) {
    writeArtefact(fresh);
    changed.push(fresh.artefact ? 'appended to the record artefact' : 'created the record artefact');
    if (repair && !fresh.artefact) api('POST', `repos/${repo()}/issues/${issue.number}/comments`, { body: `**Record rebuilt.** The artefact \`${RECORD_ARTEFACT}\` was missing, so the harness rebuilt it from the line comments. Its earlier versions are gone.\n\n${replyMark(0)}\n${WATERMARK}\n` });
  }
  const esc = r.escalations.find((e) => e.id === issue.id);
  if (!esc) return { changed, faults: [], warnings: fresh.warnings };
  const want = stateOf(esc);
  ensureLabels();
  const desired = want.label ? STATE_LABELS[want.label].name : null;
  for (const name of fresh.labels.filter((l) => HARNESS_LABELS.has(l) && l !== desired)) {
    api('DELETE', `repos/${repo()}/issues/${issue.number}/labels/${encodeURIComponent(name)}`, undefined, { allow: [404] });
    changed.push(`removed ${name}`);
  }
  if (desired && !fresh.labels.includes(desired)) { api('POST', `repos/${repo()}/issues/${issue.number}/labels`, { labels: [desired] }); changed.push(`added ${desired}`); }
  if (want.close && fresh.state !== 'closed') {
    api('PATCH', `repos/${repo()}/issues/${issue.number}`, { state: 'closed', state_reason: want.close });
    changed.push(`closed as ${want.close.replace('_', ' ')}`);
  } else if (!want.close && fresh.state === 'closed') {
    api('PATCH', `repos/${repo()}/issues/${issue.number}`, { state: 'open' });
    api('POST', `repos/${repo()}/issues/${issue.number}/comments`, { body: `**Reopened.** This escalation is still open, so the issue stays open. Fix the cause and run the command again, or comment \`/stop <reason>\` or \`/withdraw <reason>\`.\n\n${replyMark(0)}\n${WATERMARK}\n` });
    changed.push('reopened, because a person closed it while the escalation is open');
  }
  return { changed, faults: [], warnings: [] };
}

/* ------------------------------------------------------------- a person's comment */

/**
 * The commands people wrote on an issue, newest last, that no line and no reply answers yet:
 * { commentId, command, rest, login, allowed, at }, where `allowed` says the person may write to the hub.
 */
export function pendingCommands(issue, lines) {
  const answered = new Set();
  for (const l of lines) { try { const o = JSON.parse(l); if (o.by && o.by.comment) answered.add(Number(o.by.comment)); } catch { /* a reader fault elsewhere */ } }
  for (const c of issue.comments) { const m = String(c.body || '').match(REPLY_MARK); if (m && byWriter(c)) answered.add(Number(m[1])); }
  const out = [];
  for (const c of issue.comments) {
    if (isHarnessComment(c) || answered.has(c.id)) continue;
    const first = String(c.body || '').trim().split('\n')[0];
    const m = first.match(/^\/(ack|stop|withdraw)\b[ \t]*(.*)$/);
    if (!m) continue;
    out.push({ commentId: c.id, command: m[1], rest: m[2].trim(), login: c.user ? c.user.login : null, allowed: byWriter(c), at: c.created_at });
  }
  return out;
}

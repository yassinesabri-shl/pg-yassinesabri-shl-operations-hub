#!/usr/bin/env node
// Part of the harness asset library c6f3b4427d58f7c3 (see VERSION.json) · 2026-10-12
/**
 * pull-request.mjs — the one path from the harness to a story's pull request on GitHub.
 *
 * The pull-request review — `/pr-review <pr-id>`, and `/dev-sprint` steps 10a and 10b, both through
 * the fix-pr-comments skill — reads the pull request, posts the pr-reviewer's findings that the
 * pr-verifier kept as one review, lists the harness's own threads to fix, replies in them, resolves
 * them and sets the labels through this script and nothing else. It never approves, requests
 * changes, merges or edits the description, and it has no command that could. It also reads the
 * threads of one scanner bot that the spoke declares (`PRIME_BOT` in its checks.env, Prime Security
 * today): it waits for that bot's review, lists its findings once each, and resolves its threads
 * that are repeated. It never touches a thread that a person started.
 *
 *   usage:  node scripts/pull-request.mjs show     --repo-id <id> (--branch <name> | --pr <n>) [--body]
 *           node scripts/pull-request.mjs threads  --repo-id <id> --pr <n>
 *           node scripts/pull-request.mjs threads  --repo-id <id> --pr <n> --source prime --bot <login> --head <sha>
 *                                                  [--out <dir> | --verified <dir>] [--severity <file>] [--min <rating>]
 *           node scripts/pull-request.mjs await    --repo-id <id> --pr <n> --bot <login> --head <sha> [--minutes <m>] [--interval <s>]
 *           node scripts/pull-request.mjs settle   --repo-id <id> --pr <n> --bot <login> --head <sha>
 *           node scripts/pull-request.mjs post     --repo-id <id> --pr <n> --head <sha> --findings <f> [--verified <f>]
 *           node scripts/pull-request.mjs post     --repo-id <id> --pr <n> --body-file <f>
 *           node scripts/pull-request.mjs reply    --repo-id <id> --pr <n> --comment <id> --body-file <f>
 *           node scripts/pull-request.mjs resolve  --repo-id <id> --pr <n> --thread <id> [--bot <login>]
 *           node scripts/pull-request.mjs label    --repo-id <id> --pr <n> [--set reviewing|fixing|done|none] [--needs-person yes|no]
 *
 *   --repo-id  the spoke's id in docs/estate/repositories.json (HARNESS_REGISTRY moves it); its
 *              `url`, https:// or git@, names the host, the owner and the repository.
 *
 *   show      a pull request, by its branch or its number: pr=, state=open|closed|merged, head=,
 *             branch=, and review=posted|none — whether a review ending with the watermark is on
 *             it; with --body, a `--- body` line and the description. No pull
 *             request is exit 1.
 *   threads   JSON: the harness's own unresolved review threads — the first comment `[SHL-R<n>]`
 *             and signed — each with its severity, category, place and text. In the order to fix:
 *             blocking, then should-fix, then nit, each by id.
 *   post      with --findings: the pr-reviewer's findings.json and, with --verified, the
 *             pr-verifier's verified-findings.json, read strictly — a malformed findings.json is
 *             exit 1 and nothing is posted. A verdict `refuted` drops the finding; `real` posts it;
 *             `uncertain`, or no verdict, posts it marked as not verified. A missing or unreadable
 *             verified-findings.json posts every finding as not verified. ONE review of type
 *             COMMENT at --head: each finding with a line inline as [SHL-R<n>], the ids continuing
 *             from the highest already on the pull request; one already posted (same path, line and
 *             opening words) skipped; one GitHub cannot attach to a line of the diff, and one with no
 *             line, in the review's body. The body is templates/pr-review.template.md: the counts,
 *             the reviewer's summary, the verifier's tally, those findings, and what was dropped
 *             and the pre-existing notes folded away; a part with nothing in it is left out. A
 *             pull request whose head is no longer --head is refused. With --body-file: one
 *             general comment (the run's summary).
 *   reply     a reply in the thread of review comment --comment. A reply that opens with a scanner
 *             ref, `**[PRIME-C<n>]**`, takes one of the forms of PRIME_REPLIES and no other: fixed,
 *             test added, fixed before, covered by a recorded answer, refuted with a second reader,
 *             refuted, a conflict with the design, a missing value for a person, or could not fix.
 *             A refusal for any other reason is not posted (exit 1): a Prime finding has no free
 *             refusal.
 *   resolve   resolves a harness thread; with --bot, also a thread whose first comment that bot wrote,
 *             and only when the harness answered in it with a closing form: `Fixed in`, `Test added
 *             in`, `Fixed before.`, `Covered by`, or a refutation that carries the line `**Second
 *             reader:**`. A Prime finding closes only when it is addressed.
 *             Any other thread, a person's above all, is refused (exit 1).
 *   label     sets harness-<state>, creating it when the repository has none, and removes the other two;
 *             --needs-person yes adds the fourth label, harness-needs-person, and --needs-person no removes it.
 *             That label does not take the place of the other three: a run that is done and left one
 *             item for a person carries harness-done and harness-needs-person together, and --set
 *             never touches it. The label says that the pull request has an escalation that waits for a
 *             person, as the escalation's [shl-harness] issue in the hub says. At least one of --set and
 *             --needs-person is given;
 *             --set none removes all three, for a run that stops.
 *
 *   The scanner bot. --bot is the GitHub App's login, `prime-security-app` (a trailing `[bot]` is
 *   dropped); an author counts as the bot only when GitHub says it is a Bot with that login, so a
 *   person's account of the same name never does. The bot analyses a pull request once. On a later
 *   push it posts again the stored findings of the files that the push touched, and no others. So
 *   a finding that a later review leaves out is not closed:
 *
 *   await     waits for the bot's review of --head: every --interval seconds (default 30) for at
 *             most --minutes (default 15, at most 120). It always ends. The last line is
 *             `prime=reviewed review=<id> head=<sha>` (exit 0), or `prime=none head=<sha>
 *             seen=yes|no` when no review of --head arrived in time (exit 0): seen says whether the
 *             bot posted anything on the pull request at all. A head that moves, or a pull request
 *             that closes, during the wait is `STOPPED …` (exit 1). A failed read is retried until
 *             the deadline; still failing then is exit 2. Every gh call has a time limit.
 *   threads --source prime
 *             JSON: the bot's open threads, each finding once. The newest thread of each finding
 *             is the work, and the older ones are its duplicates. No review of the bot closes a
 *             finding, at --head or before it: only an answer of the harness does. `reviewAtHead`
 *             says whether the bot reviewed --head. A thread
 *             the harness already answered (`Not changed`) keeps its finding: a repeat becomes its
 *             duplicate. So does a thread that the harness closed without a change, as covered by a
 *             recorded answer or refuted with a second reader: a repeat is its duplicate. A repeat
 *             of a finding that the harness fixed is work again, `reportedBefore`, because the code
 *             changed. A thread a person replied in is left alone. The dedupe key is the file,
 *             the policy and the first sentence. Each work item: ref `PRIME-C<comment id>` (never
 *             key-shaped), severity should-fix, the policy and its standard, the sentence, the
 *             suggested fix. --out <dir> also writes <dir>/findings.json in the pr-reviewer's shape,
 *             for the pr-verifier; --verified <dir> reads it back with <dir>/verified-findings.json
 *             and gives each item its verdict (an unreadable verifier file makes every item
 *             uncertain). A `refuted` verdict holds only when its reason opens with one of the
 *             four forms of PRIME_REFUTED: `Meets the rule at <path>:<line>`, `Does not apply at
 *             <path>:<line>`, `Misread:` or `Not in this change`. Any other reason makes the item
 *             uncertain, so the run fixes it.
 *             --severity <file> is prime-severity.json, which `prime.mjs severity` wrote: each item
 *             takes Prime's own rating, `primeSeverity`, by its file, policy and sentence, or null
 *             where Prime's record holds none. --min <rating> is PRIME_FIX_SEVERITY, LOW when not
 *             given: an item rated below it is `belowSetting`, is left out of findings.json, and
 *             is not work. An item with no rating is always work.
 *   settle    resolves every duplicate thread that `threads --source prime` finds, each with a
 *             signed reply that names the thread it repeats. Where the harness answered in that
 *             thread, the reply quotes the answer, so each repeat states its reason. It leaves the
 *             work, answered threads and threads with a person's reply open. Running it twice
 *             changes nothing more.
 *
 * GitHub, GitHub Enterprise included, through the GitHub CLI, 2.48 or later: `gh api` and
 * `gh api graphql`, every list read with `--paginate --slurp`, and `--hostname` the registry url's
 * host. The identity is whoever gh is logged in as for that host —
 * the person, or the bot whose token is in GH_TOKEN (GH_ENTERPRISE_TOKEN for an Enterprise host).
 * The first call is `gh auth status --hostname <host>`; a host gh does not know, an SSH alias
 * included, fails there.
 *
 * Rules built in:
 *   - every body ends with the watermark `Generated-by: SHL Agentic Harness`, which this script
 *     adds; a text that already claims it, or holds a suggestion block, is refused, every problem
 *     listed;
 *   - a review is always of type COMMENT;
 *   - severities are blocking, should-fix and nit; categories bug, gap, unused-import, unused-var,
 *     convention, coverage and other.
 *
 * Exit codes, shared with every check in the library:
 *   0 done  1 verified and failed: GitHub answered 404 or 422, a malformed input, a refused thread
 *   2 cannot verify: no registry, a url that is not https:// or git@, gh missing or not logged in,
 *     any other gh failure  3 usage  4 internal, an answer that is not JSON
 *
 * UNRESOLVED — the forge backend for a host that is not GitHub or GitHub Enterprise. Owner: platform lead. Resolves: when a spoke on that forge is added.
 *
 * Node standard library only, plus gh via child_process.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXIT, REPO_ID, firstLine, reasonLine, registryPath, readRegistry, validateRegistry } from './spoke-remote.mjs';

// The harness watermark, as check-watermark.mjs defines it (rules/watermark.md).
export const WATERMARK = 'Generated-by: SHL Agentic Harness';
export const CLAIM = /generated[\s_-]*by[\s:_-]*shl[\s_-]*agentic[\s_-]*harness/i;
const SUGGESTION = /^ {0,3}(?:`{3,}|~{3,})\s*suggestion\b/im;
const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
// The pull-request review's two closed sets, the review-pull-request skill's: lowest severity first.
export const SEVERITIES = ['nit', 'should-fix', 'blocking'];
export const CATEGORIES = ['bug', 'gap', 'unused-import', 'unused-var', 'convention', 'coverage', 'other'];
const SHL_REF = new RegExp(`^\\*\\*\\[SHL-R(\\d+)\\]\\*\\* \\*\\*\\[(${CATEGORIES.join('|')}) · (${SEVERITIES.join('|')})\\]\\*\\*`);
const LABELS = {
  reviewing: { color: 'fbca04', description: 'The SHL harness is reviewing this pull request' },
  fixing: { color: '1d76db', description: 'The SHL harness is fixing review comments, one commit each' },
  done: { color: '0e8a16', description: 'The SHL harness has finished this run; what needs a person is in its summary comment' },
};
// The fourth label. It is not one of the run's three states: it stands beside them.
export const NEEDS_PERSON = 'harness-needs-person';
const NEEDS_PERSON_LABEL = { color: 'b60205', description: 'The SHL harness stopped here and needs a person: the escalation is a [shl-harness] issue in the hub' };

/** `reason` is a token of spoke-remote.mjs's REASONS for an error that cannot verify, or null. */
export class ForgeError extends Error {
  constructor(exit, message, reason = null) { super(message); this.exit = exit; this.reason = reason; }
}
const usage = (message) => new ForgeError(EXIT.USAGE, message);
const fail = (message) => new ForgeError(EXIT.FAIL, message);
const cannot = (message, reason = null) => new ForgeError(EXIT.CANNOT_VERIFY, message, reason);
const internal = (message) => new ForgeError(EXIT.INTERNAL, message);
const out = (line = '') => process.stdout.write(`${line}\n`);
const rank = (severity) => SEVERITIES.indexOf(severity);

/* ------------------------------------------------------------------- the command line */

const OPTIONS = {
  show: ['repo-id', 'branch', 'pr', 'body'],
  threads: ['repo-id', 'pr', 'source', 'bot', 'head', 'out', 'verified', 'severity', 'min'],
  await: ['repo-id', 'pr', 'bot', 'head', 'minutes', 'interval'],
  settle: ['repo-id', 'pr', 'bot', 'head'],
  post: ['repo-id', 'pr', 'head', 'findings', 'verified', 'body-file'],
  reply: ['repo-id', 'pr', 'comment', 'body-file'],
  resolve: ['repo-id', 'pr', 'thread', 'bot'],
  label: ['repo-id', 'pr', 'set', 'needs-person'],
};
const FLAGS = new Set(['body']);
const NUMBER = /^[1-9]\d*$/;
// A GitHub App's login: its slug, as `--bot` names it; a trailing `[bot]` is dropped.
const BOT = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}(?:\[bot\])?$/;
// Prime's ratings of an issue, lowest first, as prime.mjs writes them.
export const PRIME_SEVERITIES = ['INFO', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
const inRange = (v, lo, hi) => String(v).search(NUMBER) === 0 && Number(v) >= lo && Number(v) <= hi;

function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!OPTIONS[command]) throw usage(`ask one thing: ${Object.keys(OPTIONS).join(', ')}`);
  const o = {};
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i];
    if (!a.startsWith('--')) throw usage(`unexpected argument "${a}"`);
    const name = a.slice(2);
    if (!OPTIONS[command].includes(name)) throw usage(`${command} takes no ${a}; it takes ${OPTIONS[command].map((x) => `--${x}`).join(', ')}`);
    if (name in o) throw usage(`${a} is given twice`);
    if (FLAGS.has(name)) { o[name] = true; continue; }
    if (rest[i + 1] === undefined) throw usage(`${a} needs a value`);
    o[name] = rest[i + 1];
    i += 1;
  }
  if (!o['repo-id']) throw usage('--repo-id is required');
  if (o['repo-id'].search(REPO_ID) !== 0) throw usage(`--repo-id "${o['repo-id']}" is not a repository id`);
  const need = (k, pattern, what) => {
    if (o[k] === undefined) throw usage(`${command} needs --${k}`);
    if (pattern && String(o[k]).search(pattern) !== 0) throw usage(`--${k} "${o[k]}" is not ${what}`);
  };
  if (command === 'show') {
    if (('branch' in o) === ('pr' in o)) throw usage('show takes --branch <name> or --pr <n>, not both');
    if ('branch' in o) need('branch', /^[^\s~^:?*[\\\x00-\x1f\x7f]+$/, 'a branch name');
    else need('pr', NUMBER, 'a pull-request number');
  } else need('pr', NUMBER, 'a pull-request number');
  if (command === 'post') {
    if (('findings' in o) === ('body-file' in o)) throw usage('post takes --findings <file> with --head, or --body-file <file>, not both');
    if ('findings' in o) need('head', COMMIT, 'a complete commit hash');
    else if ('head' in o || 'verified' in o) throw usage('--head and --verified go with --findings');
  }
  if (command === 'reply') { need('comment', NUMBER, 'a review comment id'); need('body-file'); }
  if (command === 'resolve') need('thread', /^[A-Za-z0-9_=-]+$/, 'a thread id');
  if (command === 'label') {
    if (!('set' in o) && !('needs-person' in o)) throw usage('label needs --set <state>, --needs-person yes|no, or both');
    if ('set' in o) need('set', /^(?:reviewing|fixing|done|none)$/, 'reviewing, fixing, done or none');
    if ('needs-person' in o) need('needs-person', /^(?:yes|no)$/, 'yes or no');
  }
  if (command === 'threads') {
    o.source = o.source ?? 'harness';
    if (o.source !== 'harness' && o.source !== 'prime') throw usage(`--source "${o.source}" is not harness or prime`);
    if (o.source === 'harness') {
      const extra = ['bot', 'head', 'out', 'verified', 'severity', 'min'].filter((k) => k in o);
      if (extra.length) throw usage(`${extra.map((k) => `--${k}`).join(', ')} go${extra.length === 1 ? 'es' : ''} with --source prime`);
    } else {
      if ('out' in o && 'verified' in o) throw usage('threads takes --out <dir> or --verified <dir>, not both');
      o.min = String(o.min ?? 'LOW').toUpperCase();
      if (!PRIME_SEVERITIES.includes(o.min)) throw usage(`--min "${o.min}" is not one of ${PRIME_SEVERITIES.join(', ')}`);
    }
  }
  if (['await', 'settle'].includes(command) || (command === 'threads' && o.source === 'prime')) {
    need('bot', BOT, 'a GitHub App login');
    need('head', COMMIT, 'a complete commit hash');
  }
  if ('bot' in o) { need('bot', BOT, 'a GitHub App login'); o.bot = o.bot.replace(/\[bot\]$/, ''); }
  if (command === 'await') {
    o.minutes = o.minutes ?? '15';
    o.interval = o.interval ?? '30';
    if (!inRange(o.minutes, 1, 120)) throw usage(`--minutes "${o.minutes}" is not a number of minutes from 1 to 120`);
    if (!inRange(o.interval, 1, 300)) throw usage(`--interval "${o.interval}" is not a number of seconds from 1 to 300`);
  }
  return { command, o };
}

function readBody(file) {
  if (!existsSync(file)) throw usage(`${file} does not exist`);
  return readFileSync(file, 'utf8');
}

/** { host, owner, repo } from a registry url: https://host/o/r(.git) or git@host:o/r(.git). */
export function parseRemote(url) {
  const s = String(url || '').trim();
  let host;
  let path;
  if (s.startsWith('https://')) {
    let u;
    try { u = new URL(s); } catch { return null; }
    host = u.hostname;
    path = u.pathname;
  } else {
    const m = s.match(/^git@([A-Za-z0-9._-]+):(.+)$/);
    if (!m) return null;
    [, host, path] = m;
  }
  const parts = path.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/, '').split('/');
  if (parts.length !== 2 || parts.some((p) => p === '' || p.search(REPO_ID) !== 0)) return null;
  return { host, owner: parts[0], repo: parts[1] };
}

/* ---------------------------------------------------------------------------- gh */

// Every gh call ends: one that hangs is killed and counts as a failed read (exit 2).
const GH_TIMEOUT_MS = 120000;

function run(args, input) {
  const res = spawnSync('gh', args, {
    input, encoding: 'utf8', maxBuffer: 1 << 28, timeout: GH_TIMEOUT_MS, killSignal: 'SIGKILL',
    env: { ...process.env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1', GH_PAGER: '' },
  });
  if (res.error) {
    if (res.error.code === 'ENOENT') throw cannot('gh is not installed: this script reaches GitHub through the GitHub CLI', 'gh-unavailable');
    if (res.error.code === 'ETIMEDOUT') throw cannot(`gh did not answer within ${GH_TIMEOUT_MS / 1000} s: gh ${args.slice(0, 4).join(' ')}`, 'gh-unavailable');
    throw cannot(`cannot run gh: ${res.error.message}`, 'gh-unavailable');
  }
  return { status: res.status, stdout: res.stdout || '', stderr: res.stderr || '' };
}

const githubErrors = (body) => {
  if (!body || typeof body !== 'object' || !Array.isArray(body.errors)) return '';
  return body.errors.map((e) => (typeof e === 'string' ? e : e.message || e.code || '')).filter(Boolean).join('; ');
};

/** gh's failure as an exit code: a 404 or 422 from the API is a verified refusal, anything else cannot verify. */
function failure(res, label) {
  const status = (res.stderr.match(/\(HTTP (\d{3})\)/) || [])[1] || null;
  let body = null;
  try { body = JSON.parse(res.stdout); } catch { body = null; }
  const notFound = !!body && Array.isArray(body.errors) && body.errors.some((e) => e && e.type === 'NOT_FOUND');
  const message = [firstLine(res.stderr) || `gh exited ${res.status}`, githubErrors(body)].filter(Boolean).join(': ');
  const verified = status === '404' || status === '422' || notFound;
  return { status, error: new ForgeError(verified ? EXIT.FAIL : EXIT.CANNOT_VERIFY, `${label}: ${message}`, verified ? null : 'gh-failed') };
}

function parsed(stdout, label) {
  if (stdout.trim() === '') return null;
  try { return JSON.parse(stdout); } catch { throw internal(`${label} answered with a body that is not JSON`); }
}

function client({ host, owner, repo }) {
  const auth = run(['auth', 'status', '--hostname', host]);
  if (auth.status !== 0) throw cannot(`gh is not logged in to ${host}: run: gh auth login --hostname ${host}`, 'gh-unavailable');
  const base = `repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const rest = (method, path, { body, paginate = false, allow404 = false } = {}) => {
    const label = `${method} ${base}${path.split('?')[0]}`;
    const args = ['api', '--hostname', host, '--method', method, ...(paginate ? ['--paginate', '--slurp'] : []), ...(body === undefined ? [] : ['--input', '-']), `${base}${path}`];
    const res = run(args, body === undefined ? undefined : JSON.stringify(body));
    if (res.status !== 0) {
      const f = failure(res, label);
      if (allow404 && f.status === '404') return null;
      throw f.error;
    }
    const value = parsed(res.stdout, label);
    if (!paginate) return value;
    if (!Array.isArray(value) || !value.every(Array.isArray)) throw internal(`${label} did not answer with a list`);
    return value.flat();
  };
  const graphql = (query, variables, { paginate = false } = {}) => {
    const label = `GraphQL ${(query.match(/^\s*(?:query|mutation) (\w+)/) || [])[1] || 'request'}`;
    const args = ['api', 'graphql', '--hostname', host, ...(paginate ? ['--paginate', '--slurp'] : []), '-f', `query=${query}`];
    for (const [k, v] of Object.entries(variables)) args.push(typeof v === 'number' ? '-F' : '-f', `${k}=${v}`);
    const res = run(args);
    if (res.status !== 0) throw failure(res, label).error;
    const answer = parsed(res.stdout, label);
    const pages = paginate ? answer : [answer];
    if (!Array.isArray(pages) || !pages.length || pages.some((p) => !p || !p.data)) throw internal(`${label} answered with no data`);
    return pages.map((p) => p.data);
  };
  return { rest, graphql, all: (path) => rest('GET', `${path}${path.includes('?') ? '&' : '?'}per_page=100`, { paginate: true }) };
}

/* ----------------------------------------------------------------------- the bodies */

/** Whether a body is signed as this script signs one: its last line the watermark, and the phrase nowhere else. */
export const signed = (body) => {
  const text = String(body || '').replace(/\r\n?/g, '\n').trimEnd();
  const lines = text.split('\n');
  return lines[lines.length - 1] === WATERMARK && lines.filter((l) => l.search(CLAIM) !== -1).length === 1;
};

/** Every reason a text may not be posted, empty when it may: a suggestion block, a watermark the script did not add, no text. */
function bodyProblems(text) {
  const problems = [];
  if (String(text).search(SUGGESTION) !== -1) problems.push('it holds a suggestion block; the harness never posts one — the fix lands as a commit');
  if (String(text).search(CLAIM) !== -1) problems.push('it already claims the watermark; the script adds it, once, as the last line');
  if (String(text).trim() === '') problems.push('it is empty');
  return problems;
}
const sign = (text) => `${String(text).replace(/\r\n?/g, '\n').trimEnd()}\n\n${WATERMARK}`;

/** The first comment of a harness thread — `[SHL-R<n>]` and signed: its id, category and severity, or null. */
function harnessRef(body) {
  if (!signed(body)) return null;
  const m = String(body).split('\n')[0].match(SHL_REF);
  return m ? { n: Number(m[1]), category: m[2], severity: m[3] } : null;
}

const opening = (text) => String(text).replace(/\s+/g, ' ').trim().toLowerCase().split(' ').slice(0, 8).join(' ');
/** A harness comment's own text: after its prefix, before the watermark. */
const textOf = (body) => {
  const s = String(body).replace(/\r\n?/g, '\n').trimEnd();
  const m = s.match(SHL_REF);
  const lines = (m ? s.slice(m[0].length) : s).trim().split('\n');
  return lines.slice(0, -1).join('\n').trim();
};

/* ------------------------------------------------- the reviewer's and verifier's files */

const isInt = (v) => Number.isInteger(v) && v >= 1;
const oneLine = (v) => typeof v === 'string' && v.trim() !== '' && v.search(/[\r\n]/) === -1;

function readJson(file, what) {
  if (!existsSync(file)) return { error: `${what} ${file} does not exist` };
  try { return { value: JSON.parse(readFileSync(file, 'utf8')) }; } catch (err) { return { error: `${what} ${file} is not JSON (${err.message})` }; }
}

/**
 * The pr-reviewer's findings.json, read literally — every finding listed that makes it unreadable:
 * { prId, reviewedCommit, baseCommit, summary, findings: [{ id, file, line, endLine, severity,
 * category, title, body }], preexistingNotes: [string] }. A finding with `line: null` belongs to a
 * file (`file` set) or the pull request as a whole (`file: null`).
 */
export function readFindings(json, { pr, head }) {
  const f = [];
  if (!json || typeof json !== 'object' || Array.isArray(json)) return { findings: ['findings.json is not an object'] };
  if (String(json.prId) !== String(pr)) f.push(`prId is ${JSON.stringify(json.prId)}, not ${pr}`);
  if (json.reviewedCommit !== head) f.push(`reviewedCommit is ${JSON.stringify(json.reviewedCommit)}, not --head ${head}: the findings were written for another commit`);
  if (typeof json.baseCommit !== 'string' || json.baseCommit.search(COMMIT) !== 0) f.push('baseCommit is not a complete commit hash');
  if (typeof json.summary !== 'string' || !json.summary.trim()) f.push('summary is missing or empty');
  else for (const p of bodyProblems(json.summary)) f.push(`summary cannot be posted: ${p}`);
  if (!Array.isArray(json.findings)) f.push('findings is not a list');
  if (!Array.isArray(json.preexistingNotes) || json.preexistingNotes.some((n) => typeof n !== 'string')) f.push('preexistingNotes is not a list of strings');
  else json.preexistingNotes.forEach((n, i) => { for (const p of bodyProblems(n)) f.push(`preexistingNotes[${i}] cannot be posted: ${p}`); });
  const seen = new Set();
  for (const [i, x] of (Array.isArray(json.findings) ? json.findings : []).entries()) {
    const at = `findings[${i}]${x && x.id ? ` (${x.id})` : ''}`;
    if (!x || typeof x !== 'object') { f.push(`${at} is not an object`); continue; }
    if (typeof x.id !== 'string' || x.id.search(/^F[1-9]\d*$/) !== 0) f.push(`${at}: id is not F<n>`);
    else if (seen.has(x.id)) f.push(`${at}: ${x.id} is listed twice`);
    seen.add(x.id);
    if (!(x.file === null || (typeof x.file === 'string' && x.file !== '' && !x.file.startsWith('/')))) f.push(`${at}: file is not a repository-relative path or null`);
    if (x.line === null) { if (x.endLine !== null && x.endLine !== undefined) f.push(`${at}: endLine without a line`); } else {
      if (!isInt(x.line)) f.push(`${at}: line is not a positive integer or null`);
      if (x.file === null) f.push(`${at}: a line without a file`);
      if (!(isInt(x.endLine) && x.endLine >= x.line)) f.push(`${at}: endLine is not an integer at or after line`);
    }
    if (!SEVERITIES.includes(x.severity)) f.push(`${at}: severity "${x.severity}" is not one of blocking, should-fix, nit`);
    if (!CATEGORIES.includes(x.category)) f.push(`${at}: category "${x.category}" is not one of ${CATEGORIES.join(', ')}`);
    if (!oneLine(x.title)) f.push(`${at}: title is not one line of text`);
    else for (const p of bodyProblems(x.title)) f.push(`${at}: title cannot be posted: ${p}`);
    if (typeof x.body !== 'string') f.push(`${at}: body is not text`);
    else for (const p of bodyProblems(x.body)) f.push(`${at}: body cannot be posted: ${p}`);
  }
  return { findings: f, value: json };
}

/** The pr-verifier's verdicts by finding id, or why they cannot be read: then every finding is unverified. */
export function readVerdicts(json, { pr, head, ids }) {
  const why = [];
  if (!json || typeof json !== 'object' || Array.isArray(json)) return { why: ['it is not an object'] };
  if (String(json.prId) !== String(pr)) why.push(`prId is ${JSON.stringify(json.prId)}, not ${pr}`);
  if (json.reviewedCommit !== head) why.push(`reviewedCommit is not --head ${head}`);
  if (typeof json.verifierSummary !== 'string' || !json.verifierSummary.trim()) why.push('verifierSummary is missing or empty');
  else for (const p of bodyProblems(json.verifierSummary)) why.push(`verifierSummary cannot be posted: ${p}`);
  if (!Array.isArray(json.verdicts)) why.push('verdicts is not a list');
  const by = new Map();
  for (const v of Array.isArray(json.verdicts) ? json.verdicts : []) {
    if (!v || !ids.has(v.id)) { why.push(`a verdict names ${v && v.id ? v.id : 'no finding'}, which findings.json does not hold`); continue; }
    if (by.has(v.id)) why.push(`${v.id} has two verdicts`);
    if (!['real', 'refuted', 'uncertain'].includes(v.verdict)) why.push(`${v.id}: verdict "${v.verdict}" is not real, refuted or uncertain`);
    if (!['high', 'medium', 'low'].includes(v.confidence)) why.push(`${v.id}: confidence "${v.confidence}" is not high, medium or low`);
    if (!oneLine(v.reason)) why.push(`${v.id}: reason is not one line of text`);
    else for (const p of bodyProblems(v.reason)) why.push(`${v.id}: reason cannot be posted: ${p}`);
    by.set(v.id, v);
  }
  for (const id of ids) if (!by.has(id)) why.push(`${id} has no verdict`);
  return why.length ? { why } : { by, summary: json.verifierSummary };
}

/** The lines of the new side a file's patch shows: the only lines GitHub attaches a comment to. */
export function rightLines(patch) {
  const lines = new Set();
  let right = 0;
  for (const l of String(patch || '').split('\n')) {
    const h = l.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (h) { right = Number(h[1]); continue; }
    if (right === 0 || l.startsWith('-') || l.startsWith('\\')) continue;
    if (l.startsWith('+') || l.startsWith(' ')) { lines.add(right); right += 1; }
  }
  return lines;
}

const UNVERIFIED = (reason) => `_Not verified: ${reason}_`;
const render = (n, x, note) => sign(`**[SHL-R${n}]** **[${x.category} · ${x.severity}]** ${x.body.trim()}${note ? `\n\n${note}` : ''}`);
const where = (x) => (x.file === null ? 'the pull request' : x.line === null ? `\`${x.file}\`` : `\`${x.file}:${x.line}\``);

/**
 * The review's body, in the shape of templates/pr-review.template.md: the comments are inline, so
 * the body only counts them; a part with nothing in it is left out.
 */
function summaryOf({ findings, verifier, posted, skipped, notes, dropped }) {
  const count = (sev) => posted.filter((p) => p.x.severity === sev).length;
  const headline = posted.length
    ? `**SHL harness review** · ${posted.length} comment${posted.length === 1 ? '' : 's'}: ${['blocking', 'should-fix', 'nit'].map((s) => `${count(s)} ${s}`).join(' · ')}`
    : '**SHL harness review** · no comments';
  const parts = [`${headline}${skipped.length ? `, ${skipped.length} already posted` : ''}`, findings.summary.trim(), `Verifier: ${verifier}`];
  if (notes.length) {
    parts.push(['**Not on a line**', ...notes.map((m) => `- ${where(m.x)} — ${m.x.title} (${m.x.category} · ${m.x.severity}${m.why ? `; ${m.why}` : ''})\n${m.x.body.trim().split('\n').map((l) => `  ${l}`).join('\n')}`)].join('\n'));
  }
  const pre = findings.preexistingNotes;
  if (dropped.length || pre.length) {
    const fold = [`<details><summary>Dropped by the verifier (${dropped.length}) · pre-existing (${pre.length})</summary>`];
    if (dropped.length) fold.push(dropped.map((d) => `- ${d.x.id} · ${d.x.title} — ${d.reason}`).join('\n'));
    if (pre.length) fold.push(['Pre-existing, not introduced here:', ...pre.map((n) => `- ${n}`)].join('\n'));
    fold.push('</details>');
    parts.push(fold.join('\n\n'));
  }
  return sign(parts.join('\n\n'));
}

/* ----------------------------------------------------------------------- the reads */

const THREADS = `query ReviewThreads($owner: String!, $name: String!, $number: Int!, $endCursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 50, after: $endCursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id isResolved path line originalLine
          comments(first: 1) { nodes { databaseId body createdAt author { __typename login } pullRequestReview { databaseId commit { oid } } } }
          recent: comments(last: 20) { nodes { databaseId body author { __typename login } } }
        }
      }
    }
  }
}`;
const THREAD = `query Thread($id: ID!) {
  node(id: $id) {
    ... on PullRequestReviewThread {
      id isResolved pullRequest { number } comments(first: 1) { nodes { body author { __typename login } } }
      recent: comments(last: 20) { nodes { body author { __typename login } } }
    }
  }
}`;
const RESOLVE = `mutation ResolveThread($id: ID!) {
  resolveReviewThread(input: { threadId: $id }) { thread { id isResolved } }
}`;

function pullOf(gh, n) {
  const p = gh.rest('GET', `/pulls/${n}`);
  if (!p || !p.head || typeof p.head.sha !== 'string') throw internal(`GET /pulls/${n} answered without a head commit`);
  return p;
}
const stateOf = (p) => (p.merged_at ? 'merged' : p.state);

function rawThreads(gh, remote, n) {
  const threads = [];
  for (const data of gh.graphql(THREADS, { owner: remote.owner, name: remote.repo, number: Number(n) }, { paginate: true })) {
    const pr = data.repository && data.repository.pullRequest;
    if (!pr) throw fail(`pull request #${n} is not in ${remote.owner}/${remote.repo}`);
    for (const t of pr.reviewThreads.nodes) {
      const first = t.comments.nodes[0] || null;
      const replies = ((t.recent && t.recent.nodes) || []).filter((c) => !first || c.databaseId !== first.databaseId);
      threads.push({ ...t, first, replies });
    }
  }
  return threads;
}

/* ---------------------------------------------------------------- the scanner bot */

// Prime Security's comment: a <details> whose summary is "This violates: <policy> (<standard>)",
// then one sentence, then a <details> whose summary is "Suggested fix".
const DETAILS = /<details>\s*<summary>([\s\S]*?)<\/summary>([\s\S]*?)<\/details>/gi;
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", nbsp: ' ' };
const plain = (html) => String(html).replace(/<[^>]*>/g, ' ').replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (_, e) => ENTITIES[e]).replace(/\s+/g, ' ').trim();
// The harness's own answer that keeps a scanner finding open for a person: the verifier refuted it.
const ANSWERED = /^\*\*\[PRIME-C\d+\]\*\* Not changed/;
// The harness's answer to a finding that Prime rates below PRIME_FIX_SEVERITY. It holds only while the rating stays below the setting.
const NOT_WORKED = /^\*\*\[PRIME-C\d+\]\*\* Not worked: /;
const norm = (t) => String(t || '').toLowerCase().replace(/\s+/g, ' ').trim();
const login = (name) => String(name || '').replace(/\[bot\]$/, '').toLowerCase();
/** A GraphQL author that is the bot: GitHub says Bot, and the login matches. A person never is. */
const byBot = (author, bot) => !!author && author.__typename === 'Bot' && login(author.login) === login(bot);
/** A REST user that is the bot, the same rule. */
const isBotUser = (user, bot) => !!user && user.type === 'Bot' && login(user.login) === login(bot);
export const scannerRef = (commentId) => `PRIME-C${commentId}`;

/** A scanner comment's parts: its policy and standard, its sentence, and its suggested fix, or null where absent. */
export function scannerFinding(body) {
  const s = String(body || '').replace(/\r\n?/g, '\n');
  let policy = null;
  let standard = null;
  let fix = null;
  for (const m of s.matchAll(DETAILS)) {
    const summary = plain(m[1]);
    const v = summary.match(/^This violates:\s*(.+?)(?:\s*\(([^()]+)\))?$/i);
    if (v && policy === null) { policy = v[1].trim(); standard = v[2] ? v[2].trim() : null; } else if (summary.search(/^Suggested fix$/i) === 0 && fix === null) fix = plain(m[2]) || null;
  }
  const text = plain(s.replace(DETAILS, ' ')) || plain(s);
  return { policy, standard, text, fix };
}

const byPlace = (a, b) => String(a.t.path).localeCompare(String(b.t.path)) || (a.t.line ?? a.t.originalLine ?? 0) - (b.t.line ?? b.t.originalLine ?? 0) || a.t.first.databaseId - b.t.first.databaseId;
const newestFirst = (a, b) => b.t.first.databaseId - a.t.first.databaseId;

/**
 * The bot's open threads on the pull request, sorted into the work (each finding once), the
 * duplicates, the answered and those a person replied in; see `threads --source prime`.
 */
/** Prime's ratings from prime-severity.json, or none: `rate(path, policy, text)` gives one rating or null. */
function ratings(o) {
  if (!o.severity) return () => null;
  const read = readJson(o.severity, 'prime-severity.json');
  if (read.error) throw fail(`${read.error}: write it with prime.mjs severity, or leave --severity out`);
  const issues = (Array.isArray(read.value.issues) ? read.value.issues : []).filter((i) => i && PRIME_SEVERITIES.includes(i.severity));
  return (path, policy, text) => {
    const same = issues.filter((i) => i.path === path && norm(i.title) === norm(policy));
    const exact = same.filter((i) => norm(i.text) === norm(text));
    const hit = exact.length ? exact : same.length === 1 ? same : [];
    // Two records of one finding with two ratings: the higher one counts.
    return hit.length ? hit.map((i) => i.severity).sort((a, b) => PRIME_SEVERITIES.indexOf(b) - PRIME_SEVERITIES.indexOf(a))[0] : null;
  };
}

function scannerState(gh, remote, o) {
  const pull = pullOf(gh, o.pr);
  const rate = ratings(o);
  const min = PRIME_SEVERITIES.indexOf(o.min || 'LOW');
  const reviews = gh.all(`/pulls/${o.pr}/reviews`).filter((r) => isBotUser(r.user, o.bot));
  const atHead = new Set(reviews.filter((r) => r.commit_id === o.head).map((r) => r.id));
  const all = rawThreads(gh, remote, o.pr).filter((t) => t.first && byBot(t.first.author, o.bot)).map((t) => {
    const f = scannerFinding(t.first.body);
    const review = t.first.pullRequestReview || null;
    const rating = rate(t.path || '', f.policy, f.text);
    const below = rating !== null && PRIME_SEVERITIES.indexOf(rating) < min;
    const own = t.replies.filter((c) => signed(c.body));
    const kept = own.filter((c) => String(c.body).search(ANSWERED) === 0 || (below && String(c.body).search(NOT_WORKED) === 0));
    const closing = own.map((c) => ({ body: String(c.body), form: primeReplyForm(c.body) })).filter((y) => y.form && y.form.closes);
    return {
      t, f, key: [t.path || '', norm(f.policy), norm(f.text)].join('\u0000'), rating, below,
      review: review ? review.databaseId : null, commit: review && review.commit ? review.commit.oid : null,
      person: t.replies.some((c) => !byBot(c.author, o.bot) && !signed(c.body)),
      answered: kept.length > 0,
      // The harness's own words: its answer in an open thread, and the reply that closed a resolved one.
      answer: kept.length ? String(kept[kept.length - 1].body) : null,
      closing: t.isResolved && closing.length ? closing[closing.length - 1] : null,
      // Already told "Not worked", and still below the setting: the run does not answer it twice.
      skipped: below && t.replies.some((c) => signed(c.body) && String(c.body).search(NOT_WORKED) === 0),
    };
  });
  const reported = new Set(all.filter((x) => x.t.isResolved).map((x) => x.key));
  const work = [];
  const duplicates = [];
  const answered = [];
  const person = [];
  const open = [];
  for (const x of all) {
    if (x.t.isResolved) continue;
    if (x.person) person.push(x); else open.push(x);
  }
  // Prime does not read the whole change again on a later push: its later review repeats the stored
  // findings of the files that the push touched. A finding that a later review leaves out is
  // therefore still open. The newest thread of each finding is the work, and the older ones are
  // its duplicates. Only an answer of the harness closes a finding.
  // A finding that the harness closed without a change keeps that answer: a person accepted the
  // behaviour, or the second reader agreed with the evidence. Prime's repeat of it is its duplicate.
  // A finding that the harness closed with a fix is read again, because the code changed.
  const last = new Map();
  for (const x of [...all].sort(newestFirst).reverse()) if (x.closing) last.set(x.key, x);
  const stands = (key) => { const x = last.get(key); return x && STANDS.includes(x.closing.form.name) ? x : null; };
  const groups = new Map();
  for (const x of open) groups.set(x.key, [...(groups.get(x.key) || []), x]);
  for (const g of groups.values()) {
    g.sort(newestFirst);
    const kept = g.find((y) => y.answered);
    if (kept) { answered.push(kept); for (const y of g) if (y !== kept) duplicates.push({ x: y, of: kept }); continue; }
    const stood = stands(g[0].key);
    if (stood) { for (const y of g) duplicates.push({ x: y, of: stood }); continue; }
    const keep = g.filter((y) => y.review === g[0].review);
    work.push(...keep);
    for (const y of g) if (!keep.includes(y)) duplicates.push({ x: y, of: keep[0] });
  }
  work.sort(byPlace);
  const ref = (x) => scannerRef(x.t.first.databaseId);
  const item = (x) => ({
    id: x.t.id, ref: ref(x), source: 'prime', severity: 'should-fix', category: 'other',
    title: x.f.policy || x.f.text.split(' ').slice(0, 8).join(' ') || 'Prime Security finding',
    policy: x.f.policy, standard: x.f.standard, path: x.t.path, line: x.t.line ?? null, originalLine: x.t.originalLine ?? null,
    comment: x.t.first.databaseId, review: x.review, commit: x.commit, text: x.f.text, fix: x.f.fix,
    reportedBefore: reported.has(x.key), duplicates: duplicates.filter((d) => d.of === x).map((d) => d.x.t.id),
    // A repeat of a finding the run fixed is always read again, whatever its rating: it is closed, not skipped.
    primeSeverity: x.rating, belowSetting: x.below && !reported.has(x.key),
  });
  return {
    pull, atHead: [...atHead], work, duplicates, answered, person, item, ref,
    summary: {
      pr: Number(o.pr), head: o.head, bot: o.bot, source: 'prime',
      reviewAtHead: atHead.size ? [...atHead] : null,
      threads: work.map(item),
      duplicates: duplicates.map((d) => ({ thread: d.x.t.id, ref: ref(d.x), of: ref(d.of) })),
      answered: answered.map((x) => ({ thread: x.t.id, ref: ref(x) })),
      withPerson: person.map((x) => ({ thread: x.t.id, ref: ref(x) })),
    },
  };
}

/** findings.json in the pr-reviewer's shape, for the pr-verifier: one finding per work item, `ref` naming its thread. */
function scannerFindings(state, o) {
  return {
    prId: String(o.pr), reviewedCommit: o.head, baseCommit: state.pull.base && state.pull.base.sha ? state.pull.base.sha : null,
    summary: `Prime Security findings to verify: ${state.work.length}.`,
    findings: state.summary.threads.filter((t) => !t.belowSetting).map((t, i) => ({
      id: `F${i + 1}`, ref: t.ref, file: t.path, line: t.line, endLine: t.line, severity: t.severity, category: t.category, title: t.title,
      body: `${t.text}${t.fix ? ` Suggested fix: ${t.fix}` : ''}${t.policy ? ` (per ${t.policy}${t.standard ? `, ${t.standard}` : ''})` : ''}`,
    })),
    preexistingNotes: [],
  };
}

/**
 * The forms a refutation of a Prime finding opens with: the line that meets the rule, the line
 * that shows that the rule's condition is absent, a misread of the code, or a finding outside the
 * change. A design or a requirement that allows the behaviour is none of them: the finding asks for
 * a control that the fix adds.
 */
export const PRIME_REFUTED = /^(?:Meets the rule at [^\s:]+:\d+|Does not apply at [^\s:]+:\d+|Misread: |Not in this change)/;

/**
 * The replies the harness may give in a Prime thread, after the ref `**[PRIME-C<n>]**`. Each opens
 * with fixed words, and some need one more line. `closes` marks the forms that address the finding:
 * `resolve --bot` takes a thread only after one of them. A refutation closes only with the line
 * `**Second reader:**`, which says that the security reviewer read the evidence and agreed. There
 * is no form for a refusal with a free reason: a Prime finding is fixed, refuted with evidence,
 * covered by an answer a person gave, in true conflict with the design, or it waits for a value
 * that a person owns.
 */
const SHA12 = '`?[0-9a-f]{12}`?';
export const PRIME_REPLIES = [
  { name: 'fixed', opens: new RegExp(`^Fixed in ${SHA12}\\.`), closes: true },
  { name: 'test added', opens: new RegExp(`^Test added in ${SHA12}: `), closes: true },
  { name: 'fixed before', opens: /^Fixed before\. Meets the rule at [^\s:]+:\d+/, closes: true },
  { name: 'covered by a recorded answer', opens: /^Covered by \S/, needs: 'Accepted for ', closes: true },
  { name: 'refuted with a second reader', opens: new RegExp(`^Not changed\\. ${PRIME_REFUTED.source.slice(1)}`), needs: '**Second reader:**', closes: true },
  { name: 'refuted', opens: new RegExp(`^Not changed\\. ${PRIME_REFUTED.source.slice(1)}`) },
  { name: 'conflicts with the design', opens: /^Not changed: this comment conflicts with the merged design\./, needs: '**Conflicts with the design:**' },
  { name: 'needs a person', opens: /^Not changed: /, needs: '**Needs a person:**' },
  { name: 'could not fix', opens: /^Could not fix this automatically: / },
  { name: 'below the setting', opens: new RegExp(`^Not worked: Prime Security rates this finding (?:${PRIME_SEVERITIES.join('|')}), which is below PRIME_FIX_SEVERITY=(?:${PRIME_SEVERITIES.join('|')}) in checks\\.env\\.`) },
];
const PRIME_REF = /^\*\*\[PRIME-C\d+\]\*\*[ \t]*/;
// The closing forms that change no code. A finding closed with one of them keeps that answer when Prime repeats it.
const STANDS = ['covered by a recorded answer', 'refuted with a second reader'];

/** The form a reply in a Prime thread takes, or null: `text` is the body with or without its ref. */
export function primeReplyForm(text) {
  const rest = String(text || '').replace(/\r\n?/g, '\n').replace(PRIME_REF, '');
  return PRIME_REPLIES.find((f) => rest.search(f.opens) === 0 && (!f.needs || rest.includes(f.needs))) || null;
}

/** Why a reply that opens with a Prime ref may not be posted, empty when it may or when it is no Prime reply. */
function primeReplyProblems(text) {
  const body = String(text || '').replace(/\r\n?/g, '\n').trimStart();
  if (body.search(PRIME_REF) !== 0 || primeReplyForm(body)) return [];
  return [`it answers a Prime finding in no form the harness allows. A Prime finding ends as one of: ${PRIME_REPLIES.map((f) => f.name).join(', ')}. A refusal for any other reason is not a form: fix the finding, or name the recorded answer, the design's words or the value a person owns`];
}

/** Each work item's verdict, read from <dir>/findings.json and <dir>/verified-findings.json. */
function attachVerdicts(summary, o) {
  const dir = o.verified;
  const fnd = readJson(join(dir, 'findings.json'), 'findings.json');
  if (fnd.error) throw fail(`${fnd.error}: write it with threads --source prime --out ${dir} first`);
  if (fnd.value.reviewedCommit !== o.head) throw fail(`${join(dir, 'findings.json')} was written at ${fnd.value.reviewedCommit}, not --head ${o.head}`);
  const list = Array.isArray(fnd.value.findings) ? fnd.value.findings : [];
  const idOf = new Map(list.filter((x) => x && typeof x.ref === 'string').map((x) => [x.ref, x.id]));
  const ver = readJson(join(dir, 'verified-findings.json'), 'verified-findings.json');
  const read = ver.error ? { why: [ver.error] } : readVerdicts(ver.value, { pr: o.pr, head: o.head, ids: new Set(list.map((x) => x.id)) });
  if (read.why) for (const w of read.why) process.stderr.write(`VERIFIER NOT READ ${w}\n`);
  for (const t of summary.threads) {
    const id = idOf.get(t.ref);
    const v = id && read.by ? read.by.get(id) : null;
    if (t.belowSetting) Object.assign(t, { verdict: null, confidence: null, reason: `not worked: Prime rates it ${t.primeSeverity}, below ${o.min}` });
    else if (!id) Object.assign(t, { verdict: null, confidence: null, reason: 'posted after the verifier ran: verify it in the next round' });
    else if (!v) Object.assign(t, { verdict: 'uncertain', confidence: 'low', reason: 'the verifier\'s file could not be read' });
    else if (v.verdict === 'refuted' && String(v.reason || '').search(PRIME_REFUTED) !== 0) {
      Object.assign(t, { verdict: 'uncertain', confidence: 'low', reason: `refuted without the line that meets the rule, so it is fixed: ${v.reason}` });
    } else Object.assign(t, { verdict: v.verdict, confidence: v.confidence, reason: v.reason });
  }
}

function cmdScannerThreads(gh, remote, o) {
  const state = scannerState(gh, remote, o);
  if (o.out) {
    const target = join(o.out, 'findings.json');
    if (existsSync(target)) throw fail(`${target} already exists: give each round its own --out directory`);
    mkdirSync(o.out, { recursive: true });
    writeFileSync(target, `${JSON.stringify(scannerFindings(state, o), null, 2)}\n`);
  }
  if (o.verified) attachVerdicts(state.summary, o);
  out(JSON.stringify(state.summary, null, 2));
  return EXIT.PASS;
}

function cmdSettle(gh, remote, o) {
  const state = scannerState(gh, remote, o);
  if (stateOf(state.pull) !== 'open') throw fail(`pull request #${o.pr} is ${stateOf(state.pull)}; nothing was resolved`);
  if (state.pull.head.sha !== o.head) throw fail(`pull request #${o.pr} is at ${state.pull.head.sha}, not --head ${o.head}; nothing was resolved`);
  const settle = (x, text, line) => {
    gh.rest('POST', `/pulls/${o.pr}/comments/${x.t.first.databaseId}/replies`, { body: { body: sign(text) } });
    const [r] = gh.graphql(RESOLVE, { id: x.t.id });
    if (!r.resolveReviewThread || !r.resolveReviewThread.thread || !r.resolveReviewThread.thread.isResolved) throw internal(`GitHub did not report ${x.t.id} resolved`);
    out(line);
  };
  // The reason, in the harness's own earlier words: the first paragraph of its answer, without the ref.
  const quote = (body) => String(body).replace(/\r\n?/g, '\n').replace(PRIME_REF, '').split('\n\n')[0].split('\n').map((l) => `> ${l}`).join('\n');
  for (const d of state.duplicates) {
    const said = d.of.closing ? d.of.closing.body : d.of.answer;
    const text = said
      ? `**[${state.ref(d.x)}]** Duplicate of ${state.ref(d.of)}. Prime Security posted this finding again on a later review. The harness answered it in that thread, and the answer holds:\n\n${quote(said)}`
      : `**[${state.ref(d.x)}]** Duplicate of ${state.ref(d.of)}. Prime Security posted this finding again on a later review, and the harness tracks it in that thread.`;
    settle(d.x, text, `DUPLICATE ${state.ref(d.x)} of ${state.ref(d.of)} — resolved${said ? ', with the answer' : ''}`);
  }
  for (const x of state.person) out(`LEFT ${state.ref(x)} — a person replied in it`);
  out(`SETTLED ${state.duplicates.length} duplicate(s) · ${state.work.length} to work · ${state.answered.length} answered · ${state.person.length} with a person`);
  return EXIT.PASS;
}

// The length of one second in milliseconds. The fixtures shorten it; nothing else may.
const SECOND_MS = (() => {
  const v = process.env.HARNESS_AWAIT_SECOND_MS;
  return v !== undefined && inRange(v, 1, 1000) ? Number(v) : 1000;
})();
const sleep = (ms) => { if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

/** One look at the pull request for the bot's review of --head: { stop } | { review } | {}. */
function probe(gh, o) {
  const p = pullOf(gh, o.pr);
  if (stateOf(p) !== 'open') return { stop: `STOPPED pull request #${o.pr} is ${stateOf(p)}` };
  if (p.head.sha !== o.head) return { stop: `STOPPED the head moved: #${o.pr} is at ${p.head.sha}, not ${o.head}` };
  const review = gh.all(`/pulls/${o.pr}/reviews`).find((r) => isBotUser(r.user, o.bot) && r.commit_id === o.head);
  return review ? { review } : {};
}

function cmdAwait(gh, o) {
  const minutes = Number(o.minutes);
  const interval = Number(o.interval) * SECOND_MS;
  const start = Date.now();
  const deadline = start + minutes * 60 * SECOND_MS;
  out(`WAIT ${o.bot} on #${o.pr} at ${o.head.slice(0, 12)} · up to ${minutes} min · every ${o.interval} s`);
  let lastError = null;
  let said = 0;
  for (;;) {
    let seen = null;
    try {
      seen = probe(gh, o);
      lastError = null;
    } catch (err) {
      // A refusal is an answer; a read that failed is asked again until the deadline.
      if (!(err instanceof ForgeError) || err.exit === EXIT.FAIL || err.exit === EXIT.USAGE) throw err;
      lastError = err;
      out(`RETRY ${err.message}`);
    }
    if (seen && seen.stop) { out(seen.stop); return EXIT.FAIL; }
    if (seen && seen.review) {
      out(`PRIME REVIEWED ${o.head.slice(0, 12)} after ${Math.round((Date.now() - start) / SECOND_MS)} s`);
      out(`prime=reviewed review=${seen.review.id} head=${o.head}`);
      return EXIT.PASS;
    }
    const now = Date.now();
    if (now >= deadline) {
      if (lastError) throw cannot(`GitHub could not be read at the end of the wait: ${lastError.message}`);
      const posted = gh.all(`/pulls/${o.pr}/reviews`).some((r) => isBotUser(r.user, o.bot)) || gh.all(`/issues/${o.pr}/comments`).some((c) => isBotUser(c.user, o.bot));
      out(`NO PRIME REVIEW of ${o.head.slice(0, 12)} within ${minutes} min · ${o.bot} ${posted ? 'has posted on this pull request before' : 'has posted nothing on this pull request'}`);
      out(`prime=none head=${o.head} seen=${posted ? 'yes' : 'no'}`);
      return EXIT.PASS;
    }
    const minute = Math.floor((now - start) / (60 * SECOND_MS));
    if (minute > said) { said = minute; out(`WAITING ${minute} min`); }
    sleep(Math.min(interval, deadline - now));
  }
}

/* ------------------------------------------------------------------- the commands */

function cmdShow(gh, remote, o) {
  let p;
  if (o.pr) p = gh.rest('GET', `/pulls/${o.pr}`, { allow404: true });
  else {
    const mine = gh.all(`/pulls?head=${encodeURIComponent(`${remote.owner}:${o.branch}`)}&state=all`).filter((x) => x.head && x.head.ref === o.branch).sort((a, b) => b.number - a.number);
    p = mine.find((x) => x.state === 'open') || mine[0];
  }
  if (!p) { out(`NO PULL REQUEST ${o.pr ? `#${o.pr}` : `for ${o.branch}`} in ${remote.owner}/${remote.repo}`); return EXIT.FAIL; }
  const reviewed = gh.all(`/pulls/${p.number}/reviews`).some((r) => signed(r.body));
  out(`pr=${p.number}`);
  out(`state=${stateOf(p)}`);
  out(`head=${p.head.sha}`);
  out(`branch=${p.head.ref}`);
  out(`review=${reviewed ? 'posted' : 'none'}`);
  if (o.body) { out('--- body'); process.stdout.write(`${p.body || ''}${String(p.body || '').endsWith('\n') || !p.body ? '' : '\n'}`); }
  return EXIT.PASS;
}

function cmdThreads(gh, remote, o) {
  const list = [];
  for (const t of rawThreads(gh, remote, o.pr)) {
    const ref = t.first ? harnessRef(t.first.body) : null;
    if (!ref || t.isResolved) continue;
    list.push({
      id: t.id, ref: `SHL-R${ref.n}`, severity: ref.severity, category: ref.category,
      path: t.path, line: t.line ?? t.originalLine ?? null, comment: t.first.databaseId, text: textOf(t.first.body),
    });
  }
  const id = (t) => Number(t.ref.slice('SHL-R'.length));
  list.sort((a, b) => rank(b.severity) - rank(a.severity) || id(a) - id(b));
  out(JSON.stringify({ pr: Number(o.pr), threads: list }, null, 2));
  return EXIT.PASS;
}

function cmdPostReview(gh, o) {
  const read = readJson(o.findings, 'findings.json');
  const checked = read.error ? { findings: [read.error] } : readFindings(read.value, { pr: o.pr, head: o.head });
  if (checked.findings.length) {
    for (const f of checked.findings) out(`FAIL ${f}`);
    out(`NOT POSTED — ${checked.findings.length} finding(s) in ${o.findings}; nothing was posted`);
    return EXIT.FAIL;
  }
  const findings = checked.value;
  const ids = new Set(findings.findings.map((x) => x.id));
  let verdicts = null;
  let verifier;
  if (!o.verified) verifier = 'not run — every comment is marked not verified';
  else {
    const v = readJson(o.verified, 'verified-findings.json');
    const r = v.error ? { why: [v.error] } : readVerdicts(v.value, { pr: o.pr, head: o.head, ids });
    if (r.why) { verifier = 'not read — every comment is marked not verified'; for (const w of r.why) out(`VERIFIER NOT READ ${w}`); } else {
      verdicts = r.by;
      const tally = (k) => [...r.by.values()].filter((x) => x.verdict === k).length;
      verifier = `${ids.size} checked · ${tally('real')} real · ${tally('refuted')} refuted · ${tally('uncertain')} uncertain`;
      out(`VERIFIER ${r.summary.trim().replace(/\s+/g, ' ')}`);
    }
  }
  const p = pullOf(gh, o.pr);
  if (stateOf(p) !== 'open') throw fail(`pull request #${o.pr} is ${stateOf(p)}; nothing was posted`);
  if (p.head.sha !== o.head) throw fail(`pull request #${o.pr} is at ${p.head.sha}, not --head ${o.head}: the findings were written for another commit; nothing was posted`);
  const files = new Map(gh.all(`/pulls/${o.pr}/files`).map((f) => [f.filename, rightLines(f.patch)]));
  const existing = gh.all(`/pulls/${o.pr}/comments`).map((c) => ({ c, ref: harnessRef(c.body) })).filter((x) => x.ref);
  let next = existing.reduce((max, x) => Math.max(max, x.ref.n), 0) + 1;
  const posted = [];
  const skipped = [];
  const notes = [];
  const dropped = [];
  for (const x of findings.findings) {
    const verdict = verdicts ? verdicts.get(x.id) : null;
    if (verdict && verdict.verdict === 'refuted') { dropped.push({ x, reason: verdict.reason }); continue; }
    const note = !verdict ? UNVERIFIED('the verifier gave no verdict') : verdict.verdict === 'uncertain' ? UNVERIFIED(verdict.reason) : null;
    if (x.line === null) { notes.push({ x }); continue; }
    const lines = files.get(x.file);
    if (!lines) { notes.push({ x, why: 'a file this pull request does not change' }); continue; }
    if (!lines.has(x.line)) { notes.push({ x, why: 'a line outside the diff, which GitHub cannot attach a comment to' }); continue; }
    const twin = existing.find((e) => e.c.path === x.file && [x.line, x.endLine].includes(e.c.line ?? e.c.original_line) && opening(textOf(e.c.body)) === opening(x.body));
    if (twin) { skipped.push({ x, n: twin.ref.n }); continue; }
    let span = true;
    for (let l = x.line; l <= x.endLine; l += 1) if (!lines.has(l)) span = false;
    posted.push({ x, n: next, note, start: span && x.endLine > x.line ? x.line : null, end: span ? x.endLine : x.line });
    next += 1;
  }
  const review = gh.rest('POST', `/pulls/${o.pr}/reviews`, {
    body: {
      commit_id: o.head, event: 'COMMENT',
      body: summaryOf({ findings, verifier, posted, skipped, notes, dropped }),
      comments: posted.map((q) => ({ path: q.x.file, line: q.end, side: 'RIGHT', ...(q.start ? { start_line: q.start, start_side: 'RIGHT' } : {}), body: render(q.n, q.x, q.note) })),
    },
  });
  for (const q of posted) out(`SHL-R${q.n} ${q.x.id} ${q.x.severity} ${q.x.file}:${q.x.line}`);
  for (const s of skipped) out(`SKIPPED ${s.x.id} ${s.x.file}:${s.x.line} — already posted as SHL-R${s.n}`);
  for (const m of notes) out(`SUMMARY ${m.x.id} ${m.x.line === null ? (m.x.file || '[PR]') : `${m.x.file}:${m.x.line}`}${m.why ? ` — ${m.why}` : ''}`);
  for (const d of dropped) out(`DROPPED ${d.x.id} — refuted: ${d.reason}`);
  out(`REVIEW POSTED ${review && review.html_url ? review.html_url : `#${o.pr}`}`);
  return EXIT.PASS;
}

function postSigned(gh, o, path, more = () => []) {
  const text = readBody(o['body-file']);
  const problems = [...bodyProblems(text), ...more(text)];
  if (problems.length) { for (const p of problems) out(`FAIL ${o['body-file']}: ${p}`); out('NOT POSTED'); return EXIT.FAIL; }
  const c = gh.rest('POST', path, { body: { body: sign(text) } });
  out(`POSTED ${c && c.html_url ? c.html_url : `#${o.pr}`}`);
  return EXIT.PASS;
}

function cmdResolve(gh, o) {
  const [data] = gh.graphql(THREAD, { id: o.thread });
  const t = data.node;
  if (!t || !t.comments) throw fail(`${o.thread} is not a review thread`);
  if (!t.pullRequest || t.pullRequest.number !== Number(o.pr)) throw fail(`${o.thread} is not a thread of pull request #${o.pr}`);
  const first = t.comments.nodes[0];
  const scanner = !!first && !!o.bot && byBot(first.author, o.bot);
  if (!first || (!harnessRef(first.body) && !scanner)) {
    out(`REFUSED ${o.thread} — not a harness thread${o.bot ? ` and not started by ${o.bot}` : ''}: the harness resolves only the threads it posted${o.bot ? ' and the scanner\'s' : ''}`);
    return EXIT.FAIL;
  }
  if (scanner && !harnessRef(first.body) && !t.isResolved) {
    const closing = ((t.recent && t.recent.nodes) || []).some((c) => signed(c.body) && String(c.body).search(PRIME_REF) === 0 && (primeReplyForm(c.body) || {}).closes);
    if (!closing) {
      out(`REFUSED ${o.thread} — a Prime finding closes only when it is addressed: reply in the thread first with ${PRIME_REPLIES.filter((f) => f.closes).map((f) => f.name).join(', ')}`);
      return EXIT.FAIL;
    }
  }
  if (!t.isResolved) {
    const [r] = gh.graphql(RESOLVE, { id: o.thread });
    if (!r.resolveReviewThread || !r.resolveReviewThread.thread || !r.resolveReviewThread.thread.isResolved) throw internal(`GitHub did not report ${o.thread} resolved`);
  }
  out(`RESOLVED ${o.thread}`);
  return EXIT.PASS;
}

// Put the label `name` on the pull request, and make it in the repository first when it is missing.
function addLabel(gh, pr, on, name, spec) {
  if (!gh.rest('GET', `/labels/${encodeURIComponent(name)}`, { allow404: true })) gh.rest('POST', '/labels', { body: { name, ...spec } });
  if (!on.includes(name)) gh.rest('POST', `/issues/${pr}/labels`, { body: { labels: [name] } });
}

function cmdLabel(gh, o) {
  const on = gh.all(`/issues/${o.pr}/labels`).map((l) => l.name);
  if ('set' in o) {
    const name = o.set === 'none' ? null : `harness-${o.set}`;
    if (name) addLabel(gh, o.pr, on, name, LABELS[o.set]);
    for (const other of Object.keys(LABELS).map((st) => `harness-${st}`)) {
      if (other !== name && on.includes(other)) gh.rest('DELETE', `/issues/${o.pr}/labels/${encodeURIComponent(other)}`);
    }
    out(`LABEL ${name || 'none'}`);
  }
  if ('needs-person' in o) {
    if (o['needs-person'] === 'yes') {
      addLabel(gh, o.pr, on, NEEDS_PERSON, NEEDS_PERSON_LABEL);
      out(`LABEL ${NEEDS_PERSON}`);
    } else {
      if (on.includes(NEEDS_PERSON)) gh.rest('DELETE', `/issues/${o.pr}/labels/${encodeURIComponent(NEEDS_PERSON)}`);
      out(`LABEL ${NEEDS_PERSON} removed`);
    }
  }
  return EXIT.PASS;
}

function main(argv) {
  const { command, o } = parseArgs(argv);
  const regPath = registryPath();
  const registry = (() => { try { return readRegistry(regPath); } catch (err) { throw new ForgeError(err.exit ?? EXIT.CANNOT_VERIFY, err.message, err.reason ?? null); } })();
  const problems = validateRegistry(registry, regPath);
  if (problems.length) throw fail(`the registry is not well formed; run check-registry first:\n  - ${problems.join('\n  - ')}`);
  const entry = registry.repositories[o['repo-id']];
  if (!entry) throw usage(`"${o['repo-id']}" is not in ${regPath}`);
  const remote = parseRemote(entry.url);
  if (!remote) throw cannot(`the registry url "${entry.url}" is not an https:// or git@ url naming an owner and a repository`, 'registry-invalid');
  const gh = client(remote);
  if (command === 'show') return cmdShow(gh, remote, o);
  if (command === 'threads') return o.source === 'prime' ? cmdScannerThreads(gh, remote, o) : cmdThreads(gh, remote, o);
  if (command === 'await') return cmdAwait(gh, o);
  if (command === 'settle') return cmdSettle(gh, remote, o);
  if (command === 'post') return o.findings ? cmdPostReview(gh, o) : postSigned(gh, o, `/issues/${o.pr}/comments`);
  if (command === 'reply') return postSigned(gh, o, `/pulls/${o.pr}/comments/${o.comment}/replies`, primeReplyProblems);
  if (command === 'resolve') return cmdResolve(gh, o);
  return cmdLabel(gh, o);
}

const invoked = (() => { try { return realpathSync(process.argv[1] || '') === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })();
if (invoked) {
  // The last line of an exit 2, 3 or 4 names this script and its code, so a shell line that hides
  // the code, with a pipe or `; echo`, still tells the harness's failure record. Written at once,
  // so a process.exit() never loses it.
  process.on('exit', (code) => { if (code >= 2 && code <= 4) { try { writeSync(2, `HARNESS EXIT: pull-request ${code}\n`); } catch { /* stderr is closed */ } } });
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (err) {
    if (err instanceof ForgeError) {
      process.stderr.write(`${err.exit === EXIT.USAGE ? 'USAGE' : err.exit === EXIT.CANNOT_VERIFY ? 'CANNOT VERIFY' : err.exit === EXIT.INTERNAL ? 'INTERNAL' : 'FAIL'}: ${err.message}\n${err.exit === EXIT.CANNOT_VERIFY ? reasonLine(err.reason) : ''}`);
      process.exit(err.exit);
    }
    process.stderr.write(`INTERNAL: ${err && err.stack ? err.stack : String(err)}\n`);
    process.exit(EXIT.INTERNAL);
  }
}

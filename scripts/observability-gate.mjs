#!/usr/bin/env node
// Part of the harness asset library c6f3b4427d58f7c3 (see VERSION.json) · 2026-11-12
/**
 * observability-gate.mjs — the record of each merge of a human gate, written by the hub's
 * `observability-gates` workflow at the merge, and sent to the hub's observability platform. A
 * laptop never writes it.
 *
 *     node scripts/observability-gate.mjs --event <file>                        a hub pull request that closed
 *     node scripts/observability-gate.mjs --pull-request <n>                    a hub pull request, sent again
 *     node scripts/observability-gate.mjs --pull-request <n> --spoke <id>       a spoke's signal: a story's code merge
 *     common:  [--hub <folder>] [--dry-run]
 *
 * A hub pull request gives one record for each gate whose file it changed (gates.mjs): the
 * requirements, the decomposition, a design or a validation report. A story's code pull request in
 * a spoke gives one `story-merge` record. The hub reads that pull request itself, from the spoke's
 * API, and trusts no input of the signal: the spoke must be in the hub's registry, the pull request
 * must have merged into the trunk that the registry declares, from `feature/<KEY>-…`, and the hub's
 * design of that story must name this spoke.
 *
 * The gate wait starts at the hand-off: the later of the pull request's opening and its last
 * commit. A story's gate wait starts no earlier than the merge of the story's validation report,
 * because the spoke's `qa-gate` holds the code merge until that report merges.
 *
 * GitHub is read through `gh`, with the token in GH_TOKEN: `github.token` for the hub, and the
 * spoke-read token for a spoke. The hub's files are read from the trunk of this checkout. The
 * write token of the observability platform comes from HARNESS_OBSERVABILITY_TOKEN, and a hub whose
 * observability.json says "auth": "none" sends none.
 *
 * INTEGRATION POINT — another forge: its pull requests and its workflows have other names. This
 * script reads GitHub's, Enterprise included through GH_HOST.
 *
 * Exit 0: every record was sent, or the pull request merged no gate, or the story is not this hub's.
 * Exit 1: the observability platform refused a record, or a signal names a spoke that the hub's
 *         registry does not list.
 * Exit 2: cannot verify. The hub is not connected, `gh` cannot read the pull request, the token is
 *         missing, or the observability platform could not be reached.
 * Exit 3: a usage error. Exit 4: an internal error.
 *
 * Node standard library only, plus git and gh.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, realpathSync, writeSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXIT, isKey, nowMs, reasonLine } from './observability/common.mjs';
import { hubContext } from './observability/config.mjs';
import { ROUTED_TO, gatesOfPaths, openTrunk } from './observability/gates.mjs';
import { featuresOnTrunk, ticketsOnTrunk } from './observability/lookups.mjs';
import { buildGateRecord, validateRecord } from './observability/record.mjs';
import { BATCH, post } from './observability/sender.mjs';
import { REPO_ID } from './spoke-remote.mjs';

const USAGE = [
  'usage: node scripts/observability-gate.mjs --event <file> [--hub <folder>] [--dry-run]',
  '       node scripts/observability-gate.mjs --pull-request <n> [--spoke <id>] [--hub <folder>] [--dry-run]',
].join('\n');

export const COLLECTOR = 'github-gate/1';
export const RUNTIME = 'github-actions';
const STORY_BRANCH = /^feature\/([A-Z][A-Z0-9]{1,9}-\d+)-/;
const REPOSITORY_LINE = /^Repository:[ \t]*(\S+)[ \t]*$/m;
const OWNER_REPO = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;

/** A failure with an exit code and a REASON token, for main() to report. */
class GateError extends Error {
  constructor(exit, message, reason = null) {
    super(message);
    this.exit = exit;
    this.reason = reason;
  }
}

function parseArgs(argv) {
  const out = { hub: process.cwd(), dryRun: false };
  const value = (i) => (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[i + 1] : null);
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--help') return { help: true };
    if (a === '--dry-run') { out.dryRun = true; continue; }
    if (!['--hub', '--event', '--pull-request', '--spoke'].includes(a)) return { error: `unknown argument ${a}` };
    const v = value(i);
    if (v === null) return { error: `${a} needs a value` };
    i += 1;
    if (a === '--hub') out.hub = resolve(v);
    if (a === '--event') out.event = resolve(v);
    if (a === '--spoke') out.spoke = v;
    if (a === '--pull-request') {
      if (v.search(/^[1-9][0-9]{0,9}$/) !== 0) return { error: '--pull-request needs a pull request number' };
      out.pullRequest = Number(v);
    }
  }
  if (Boolean(out.event) === (out.pullRequest !== undefined)) return { error: 'give one of --event or --pull-request' };
  if (out.spoke !== undefined && out.pullRequest === undefined) return { error: '--spoke needs --pull-request' };
  if (out.spoke !== undefined && out.spoke.search(REPO_ID) !== 0) return { error: `${out.spoke} is not a repository id` };
  return out;
}

/* --------------------------------------------------------------------------------- GitHub */

/** One `gh api` call's output. `host` is the forge's host for a spoke on another one. */
function ghRun(args, path, host) {
  const env = { ...process.env, ...(host && host !== 'github.com' ? { GH_HOST: host } : {}) };
  const r = spawnSync('gh', ['api', ...args, path], { encoding: 'utf8', env, maxBuffer: 64 * 1024 * 1024 });
  if (r.error && r.error.code === 'ENOENT') throw new GateError(EXIT.CANNOT_VERIFY, 'gh is not installed on this runner', 'gh-unavailable');
  if (r.status !== 0) throw new GateError(EXIT.CANNOT_VERIFY, `gh api ${path} failed: ${(r.stderr || '').trim().split('\n')[0] || `exit ${r.status}`}`, 'gh-failed');
  return r.stdout;
}

/** One `gh api` call: its JSON answer. */
function ghApi(path, { host = null } = {}) {
  const out = ghRun([], path, host);
  try { return JSON.parse(out); } catch {
    throw new GateError(EXIT.CANNOT_VERIFY, `gh api ${path} did not answer JSON`, 'gh-failed');
  }
}

/** Every changed file of a pull request, across all pages, one name on each line of gh's answer. */
function changedFiles(repo, number) {
  return ghRun(['--paginate', '--jq', '.[].filename'], `repos/${repo}/pulls/${number}/files?per_page=100`, null).split('\n').filter(Boolean);
}

/** The owner/repo and host of a clone URL on a GitHub host, or null. */
export function repoOfUrl(url) {
  if (typeof url !== 'string') return null;
  const m = url.match(/^(?:https:\/\/([^/@\s]+)\/|git@([^:\s]+):|ssh:\/\/git@([^/\s]+)\/)([^\s]+?)(?:\.git)?\/?$/);
  if (!m) return null;
  const repo = m[4];
  return repo.search(OWNER_REPO) === 0 ? { host: m[1] || m[2] || m[3], repo } : null;
}

const ms = (iso) => {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
};

/**
 * The committer time of a pull request's last commit, from the forge: its hand-off. Null when the
 * forge gives none, or gives a time after the merge, which a clock that runs fast can write.
 */
function handoffOf(repo, sha, host, mergedMs) {
  if (typeof sha !== 'string' || sha.search(/^[0-9a-f]{40}$/) !== 0) return null;
  const c = ghApi(`repos/${repo}/commits/${sha}`, { host });
  const at = ms(c?.commit?.committer?.date);
  return at !== null && at <= mergedMs ? at : null;
}

/* ------------------------------------------------------------------------------ the hub's files */

function gitShow(main, ref, path) {
  const r = spawnSync('git', ['-C', main, 'show', `${ref}:${path}`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return r.status === 0 ? r.stdout : null;
}

/** The trunk's name, as HARNESS_TRUNK or the remote's HEAD gives it. */
function trunkName(ref) {
  return ref ? ref.replace(/^origin\//, '') : null;
}

/* ---------------------------------------------------------------------------- the records */

/** The story's Jira ticket and the feature's Epic, from the hub's trunk, as the laptop's sender fills them. */
function jiraOf(tickets, { story = null, feature = null }) {
  const epic = feature ? tickets.epics.get(feature) : null;
  return { ticket_url: (story && tickets.stories.get(story)) || null, epic: epic ? epic.key : null, epic_url: epic ? epic.url : null };
}

/** The records of a hub pull request that merged into the trunk: one for each gate it changed. */
function hubRecords(pr, { ctx, trunk, features, tickets, repo }) {
  if (!pr || !pr.merged_at) return { skipped: `pull request #${pr?.number ?? '?'} closed without a merge` };
  if (pr.base?.ref !== trunkName(trunk.ref)) return { skipped: `pull request #${pr.number} merged into ${pr.base?.ref}, not the trunk` };
  const gates = gatesOfPaths(changedFiles(repo, pr.number));
  if (!gates.length) return { skipped: `pull request #${pr.number} merged no gate` };
  const opened = ms(pr.created_at);
  const merged = ms(pr.merged_at);
  const handoff = handoffOf(repo, pr.head?.sha, null, merged);
  const records = gates.map((g) => {
    const key = g.story ? { story: g.story, feature: features.get(g.story) ?? null } : { feature: g.feature };
    return buildGateRecord({
      ctx, gate: g.gate, key, repository: ctx.hub, pullRequest: pr.number, routedTo: ROUTED_TO[g.gate] ?? null,
      times: { opened, handoff, started: Math.max(opened, handoff ?? opened), merged }, jira: jiraOf(tickets, key),
    });
  });
  return { records };
}

/**
 * The story-merge record of a spoke's pull request, after the hub's own checks. `entry` is the
 * spoke's registry entry. Returns { records }, { skipped }, or throws a GateError.
 */
function storyRecord(pr, { ctx, trunk, features, tickets, spoke, entry, where }) {
  const n = pr?.number ?? '?';
  if (!pr || !pr.merged_at) return { skipped: `${spoke} #${n} closed without a merge` };
  const declared = entry.trunk === 'default' ? pr.base?.repo?.default_branch : entry.trunk;
  if (!declared || pr.base?.ref !== declared) return { skipped: `${spoke} #${n} merged into ${pr.base?.ref}, not the harness trunk ${declared ?? '(unknown)'}` };
  const story = (pr.head?.ref || '').match(STORY_BRANCH)?.[1];
  if (!isKey(story)) return { skipped: `${spoke} #${n} merged from ${pr.head?.ref}, which names no story` };
  const design = gitShow(ctx.main, trunk.ref, `docs/designs/${story}.lld.md`);
  if (design === null) return { skipped: `this hub has no design of ${story} on its trunk` };
  const named = design.match(REPOSITORY_LINE)?.[1];
  if (named !== spoke) return { skipped: `the design of ${story} names ${named ?? 'no repository'}, not ${spoke}` };
  const opened = ms(pr.created_at);
  const merged = ms(pr.merged_at);
  const handoff = handoffOf(where.repo, pr.head?.sha, where.host, merged);
  const validation = trunk.lastMerge('validation-merge', { story }, merged);
  if (validation && validation.unknown) throw new GateError(EXIT.CANNOT_VERIFY, validation.unknown, 'git-failed');
  const started = Math.max(opened, handoff ?? opened, validation?.mergedMs ?? -Infinity);
  const key = { story, feature: features.get(story) ?? null };
  return {
    records: [buildGateRecord({
      ctx, gate: 'story-merge', key, repository: spoke, pullRequest: pr.number,
      times: { opened, handoff, started: Math.min(started, merged), merged }, jira: jiraOf(tickets, key),
    })],
  };
}

/** A spoke's registry entry, from the hub's trunk, and where its pull requests live. Throws for a spoke the registry does not list. */
function spokeOf(ctx, trunk, spoke) {
  const text = trunk.ref ? gitShow(ctx.main, trunk.ref, 'docs/estate/repositories.json') : null;
  if (text === null) throw new GateError(EXIT.CANNOT_VERIFY, 'the hub\'s trunk has no docs/estate/repositories.json', 'registry-missing');
  let entry = null;
  try { entry = JSON.parse(text)?.repositories?.[spoke] ?? null; } catch {
    throw new GateError(EXIT.CANNOT_VERIFY, 'docs/estate/repositories.json on the trunk is not valid JSON', 'registry-invalid');
  }
  if (!entry) throw new GateError(EXIT.FAIL, `the hub's registry does not list ${spoke}, so its signal is refused`, 'not-registered');
  const where = repoOfUrl(entry.url);
  if (!where) throw new GateError(EXIT.CANNOT_VERIFY, `the registry's URL of ${spoke} is not a repository on a GitHub host`, 'gh-repo-unknown');
  return { entry, where };
}

/* ----------------------------------------------------------------------------------- main */

function readEvent(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch {
    throw new GateError(EXIT.USAGE, `${path} is not a readable event file`);
  }
}

/** The hub's own owner/repo: GITHUB_REPOSITORY, as GitHub Actions sets it. */
function hubRepo() {
  const repo = process.env.GITHUB_REPOSITORY;
  if (typeof repo !== 'string' || repo.search(OWNER_REPO) !== 0) throw new GateError(EXIT.CANNOT_VERIFY, 'GITHUB_REPOSITORY does not name the hub\'s repository', 'gh-repo-unknown');
  return repo;
}

/** The records this run must send, from its mode. */
function collectRecords(args, base) {
  if (args.event) {
    const event = readEvent(args.event);
    if (!event.pull_request) throw new GateError(EXIT.USAGE, 'the event holds no pull request');
    return hubRecords(event.pull_request, { ...base, repo: hubRepo() });
  }
  if (args.spoke) {
    const { entry, where } = spokeOf(base.ctx, base.trunk, args.spoke);
    const pr = ghApi(`repos/${where.repo}/pulls/${args.pullRequest}`, { host: where.host });
    return storyRecord(pr, { ...base, spoke: args.spoke, entry, where });
  }
  const repo = hubRepo();
  return hubRecords(ghApi(`repos/${repo}/pulls/${args.pullRequest}`), { ...base, repo });
}

function describe(r) {
  return `${r.gate} ${r.story ?? r.feature} ${r.repository}#${r.pull_request}: gate wait ${r.gate_s} s, from ${r.started_at} to ${r.merged_at}`;
}

async function send(records, ctx, { fetchImpl = globalThis.fetch, now }) {
  const token = ctx.auth === 'none' ? null : process.env.HARNESS_OBSERVABILITY_TOKEN || null;
  if (ctx.auth === 'bearer' && !token) throw new GateError(EXIT.CANNOT_VERIFY, 'HARNESS_OBSERVABILITY_TOKEN is not set, and this hub\'s observability platform needs a write token. Set the hub secret, and give it to this step', 'credential-missing');
  const refused = [];
  for (let i = 0; i < records.length; i += BATCH) {
    const part = records.slice(i, i + BATCH);
    const got = await post(part, { connection: ctx.connection, hub: ctx.hub, token, fetchImpl, now });
    if (got.retry) throw new GateError(EXIT.CANNOT_VERIFY, got.retry, 'platform-unreachable');
    if (got.refused) refused.push(`the observability platform answered ${got.refused.status}: ${got.refused.answer}`);
  }
  return refused;
}

export async function main(argv = process.argv.slice(2), { fetchImpl = globalThis.fetch, stdout = process.stdout } = {}) {
  const args = parseArgs(argv);
  if (args.help) { stdout.write(`${USAGE}\n`); return EXIT.PASS; }
  if (args.error) { process.stderr.write(`${args.error}\n${USAGE}\n`); return EXIT.USAGE; }
  try {
    const hub = hubContext(args.hub);
    if (!hub.ok) throw new GateError(EXIT.CANNOT_VERIFY, hub.why, hub.reason);
    const now = nowMs();
    const ctx = { ...hub, runtime: RUNTIME, runtimeVersion: null, collector: COLLECTOR };
    const trunk = openTrunk(hub.main);
    if (!trunk.ref) throw new GateError(EXIT.CANNOT_VERIFY, 'this checkout has no origin trunk to read the hub\'s files from', 'trunk-missing');
    const base = { ctx, trunk, features: featuresOnTrunk(hub.main), tickets: ticketsOnTrunk(hub.main) };
    const got = collectRecords(args, base);
    const skipped = [got.skipped].flat().filter(Boolean);
    for (const s of skipped) stdout.write(`Skipped: ${s}.\n`);
    const records = got.records || [];
    for (const r of records) {
      const problems = validateRecord(r);
      if (problems.length) throw new GateError(EXIT.INTERNAL, `a gate record breaks the record rules: ${problems.join(' · ')}`);
    }
    if (!records.length) { stdout.write('No gate record to send.\n'); return EXIT.PASS; }
    for (const r of records) stdout.write(`Gate: ${describe(r)}.\n`);
    if (args.dryRun) {
      for (const r of records) stdout.write(`${JSON.stringify(r)}\n`);
      stdout.write(`Dry run: ${records.length} record(s), nothing sent.\n`);
      return EXIT.PASS;
    }
    const refused = await send(records, hub, { fetchImpl, now });
    if (refused.length) {
      for (const why of refused) stdout.write(`Refused: ${why}\n`);
      return EXIT.FAIL;
    }
    stdout.write(`Sent ${records.length} gate record(s).\n`);
    return EXIT.PASS;
  } catch (err) {
    if (!(err instanceof GateError)) throw err;
    const label = err.exit === EXIT.FAIL ? 'FAIL' : err.exit === EXIT.CANNOT_VERIFY ? 'CANNOT VERIFY' : 'ERROR';
    const out = err.exit === EXIT.USAGE ? process.stderr : stdout;
    out.write(`${label}: ${err.message}.\n${reasonLine(err.reason)}`);
    if (err.exit === EXIT.USAGE) process.stderr.write(`${USAGE}\n`);
    return err.exit;
  }
}

const invoked = (() => { try { return realpathSync(process.argv[1] || '') === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })();
if (invoked) {
  // The last line of an exit 2, 3 or 4 names this script and its code, as every harness script does.
  process.on('exit', (code) => { if (code >= 2 && code <= 4) { try { writeSync(2, `HARNESS EXIT: observability-gate ${code}\n`); } catch { /* stderr is closed */ } } });
  main().then((code) => process.exit(code), (err) => {
    process.stderr.write(`internal error: ${err && err.message ? err.message : String(err)}\n`);
    process.exit(EXIT.INTERNAL);
  });
}

#!/usr/bin/env node
// Part of the harness asset library c6f3b4427d58f7c3 (see VERSION.json) · 2026-11-02
/**
 * escalation.mjs — the one writer of the escalation record, and the reader of its state.
 *
 *   usage:  node scripts/escalation.mjs raise --point <ID> --slug <slug> [--work-item <KEY>] --runner <login|none>
 *                                       --question "<one line>" [--repository <id>] [--parked-ref <branch> --parked-commit <12-hex>]
 *                                       [--findings-file <path>] [--design <path>] [--iteration-run <id>] [--tests-commit <12-hex>]
 *                                       [--path <alternative path>] [--trigger <trigger>] [--route-first <role>] [--route-next <role>]
 *                                       [--asked left|absent] [--by-seat <name>] [--now <time>]
 *           node scripts/escalation.mjs ack      <id> --role <role> [--login <login>]
 *           node scripts/escalation.mjs stop     <id> --role <role> --reason "<your own words>" [--login <login>]
 *           node scripts/escalation.mjs withdraw <id> --role <role> --reason "<your own words>" [--login <login>]
 *           node scripts/escalation.mjs resume   (--work-item <KEY> | --slug <slug>) [--point <ID>] [--tests-commit <12-hex>] [--pr <url>] [--by-seat <name>] [--check]
 *           node scripts/escalation.mjs resolve  (<id> | --work-item <KEY> | --slug <slug> [--point <ID>]) --fact-kind <kind> --fact-value <value> [--round <n>] [--by-seat <name>]
 *           node scripts/escalation.mjs print    [<id> | --work-item <KEY> | --slug <slug> | --all] [--json]
 *           node scripts/escalation.mjs sweep    [--standing] [--gates] [--dry-run] [--tz <zone>] [--day-end HH:MM] [--summary <file>] [--now <time>]
 *
 * When the harness stops for a person, a command calls `raise`. It opens one GitHub issue in the hub
 * for the escalation, titled `[shl-harness] <KEY or SLUG> · <point>`, and writes each event as one
 * line: a comment that carries the line, and the issue artefact `escalation-record.jsonl` that
 * holds every line. escalation-store.mjs owns that layout. A writer only adds a line at the end.
 * People still decide where they already do, for example at a merge. The record links to the
 * decision and never holds it.
 *
 *   raise      Opens an escalation: the `raised` line and one `notified` line to the runner in
 *              the session. A capped run's findings go on the same issue, as the artefact
 *              `findings.md`. It prints the escalation for the
 *              run's closing report. A point on the question path or on no path writes nothing,
 *              and `raise` refuses it. A point marked `ask_first` in governance/escalation-points.json
 *              is a question that the runner can answer. `raise` refuses it (exit 1)
 *              without `--asked left`, where the runner left it for the role, or `--asked absent`,
 *              where the run has no runner. The session asks first, and escalates what is left.
 *   ack        A person says "this is mine". The ladder stops. The escalation stays open. On the
 *              issue, a member or collaborator comments `/ack`, `/stop <reason>` or
 *              `/withdraw <reason>` instead, and the sweep writes the line with their login.
 *   stop       A person ends the work, with a reason in their own words. Git keeps the work.
 *   withdraw   A person ends an escalation that should not have been raised, with a reason.
 *   resume     A re-run calls it before it starts. For a review cap it compares the upstream state
 *              (the design's blob, the approved tests, the clarifications that reached `Closed`,
 *              the requirements document) with the `raised` line. With a change it writes
 *              `resumed` with what changed and exits 0. With no change it exits 1, and the run
 *              stops at once. A person's answer counts only once it is in one of those four places.
 *              While an incident is open on the work, it refuses every re-run. `--check` reads and
 *              writes nothing. With no open escalation it exits 0 and says so, so a first run is
 *              never refused.
 *   resolve    The re-run that passes the point calls it. The fact that ends the escalation is a
 *              verdict APPROVED, an exit 0, a row `Closed` or a merge `MERGED`, read by a script.
 *   print      The state of each escalation, and the table that docs/designs/CLAR-log.md
 *              § Escalation record shows. Nobody edits that table by hand. `--jsonl` prints
 *              the record lines themselves, for a reader that keeps them.
 *
 *   sweep      The scheduled hub workflow `escalation-sweep` runs it. The run that stopped has ended
 *              by the time a reminder is due, so the sweep follows the ladder. When the first wait
 *              of a path ends with no acknowledgement, it asks the first roles and the runner
 *              again (`reasked`) and tells the next roles (`notified`). When the second wait ends,
 *              it tells the delivery lead, and it sends nothing after that. The escalation then
 *              shows as overdue: the reader computes that and never writes it. An acknowledgement
 *              stops the ladder, and the escalation comes up once at each `--standing` sweep until
 *              a fact or a person closes it. A handover has no ladder, and comes up at each
 *              standing sweep. A timeout tells more people and never lets the work continue.
 *              With `--gates` it reads the hub's pull requests through `gh`. It raises a merge
 *              still open at the end of the working day it opened in, or 2 hours after it opened if
 *              that is later (trigger `gate-waiting`). It writes `resolved` with the fact `merge`
 *              when it sees the merge. It writes `stopped` when it sees a close without a merge and
 *              a person's comment, posted after the raise, that gives the reason. It never writes a
 *              reason itself. The working day ends at one time in one time zone for the whole hub
 *              (`--tz` and `--day-end`, or HARNESS_ESCALATION_TZ and HARNESS_ESCALATION_DAY_END).
 *              The messages are comments on the issue, and they also go to the job summary and
 *              to stdout (`deliver`, an INTEGRATION POINT for a chat channel). `--dry-run` writes
 *              nothing. Everyone who was told gets one closing message, from whoever writes the
 *              line that ends the escalation. Each sweep also reads the commands people commented,
 *              appends lines the artefact lacks, rebuilds an artefact a person deleted, sets the
 *              one state label (`harness-waiting`, `harness-overdue` or `harness-acknowledged`),
 *              closes the issue when the escalation ends, and reopens one a person closed.
 *
 * How it writes. Each line is first a comment, which GitHub appends atomically. The writer then
 * reads the comments back: if another writer took the same seq first, it deletes its comment and
 * writes again on a fresh read, at most three times. Only then does it append the line to the
 * artefact and settle the label and the open or closed state. Every reader rule of
 * escalation-record.mjs and every rule of escalation-store.mjs runs before the write, so a record
 * that was changed by hand is never made worse.
 *
 * Who may write. `acknowledged`, `stopped` and `withdrawn` are a person's, and this script
 * refuses to write them as a seat or a script. It cannot prove who runs the session. The
 * commands and the seat charters never call `ack`, `stop` or `withdraw`.
 *
 * Exit codes — the library's:
 *   0  done, or nothing to do
 *   1  verified and refused: a reader rule, a re-run with no upstream change or with an open
 *      incident, an escalation that already ended
 *   2  cannot verify: GitHub or the remote cannot be reached, the trunk cannot be confirmed,
 *      or a record has a gap in seq, a line that is not JSON, or a line that was changed
 *   3  usage, and a point on the question path, which writes nothing
 *   4  internal
 *
 * Node standard library only, plus git and gh.
 */

import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync, statSync, writeSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { stdout, stderr } from 'node:process';
import { EXIT, SpokeError, reasonLine, git, firstLine, quietGitEnv, short, syncTrunk } from './spoke-remote.mjs';
import {
  FACT_KINDS, PATHS, SCHEMA_VERSION, TRIGGERS,
  appendLine, escalationId, faultCode, findEscalation, isFinal, isHex12, isKey, isSlug, loadPoints, ownerOf,
  parseId, pinOf, readRecord, renderTable, routeOf, stamp, supersededBy, triggerLabel,
  DEFAULT_CONFIG, ROLE_SEPARATOR, SWEEP_CHANNEL, planLadder, splitRoles, waitEnds,
} from './escalation-record.mjs';
import * as store from './escalation-store.mjs';

const REMOTE = 'origin';
const TRUNK = process.env.HARNESS_TRUNK || 'main';
// Each work item has its own clarification log, so that two designs written at once change different files.
const CLAR_LOG = (owner) => `docs/designs/${owner}.clar-log.md`;
const REQUIREMENTS = (slug) => `docs/requirements/${slug}/requirements.md`;
const FINDINGS_MAX = 262144;
const SCRIPT = { kind: 'script', name: 'escalation.mjs' };
const PULL_LIMIT = 1000;

/* -------------------------------------------------------------------------- usage */

function usage(message) {
  const me = process.argv[1] || 'scripts/escalation.mjs';
  stderr.write(`${message}\nusage: node ${me} raise|ack|stop|withdraw|resume|resolve|print|sweep ...\nSee the header of ${basename(me)} for every option.\n`);
  process.exit(EXIT.USAGE);
}

const VALUED = {
  raise: ['point', 'path', 'trigger', 'work-item', 'slug', 'repository', 'runner', 'question', 'findings-file', 'parked-ref', 'parked-commit', 'design', 'iteration-run', 'tests-commit', 'comment', 'pr', 'route-first', 'route-next', 'asked', 'by-seat', 'by-script', 'now', 'hub'],
  ack: ['role', 'login', 'by-kind', 'now', 'hub'],
  stop: ['role', 'login', 'reason', 'by-kind', 'now', 'hub'],
  withdraw: ['role', 'login', 'reason', 'by-kind', 'now', 'hub'],
  resume: ['work-item', 'slug', 'point', 'tests-commit', 'pr', 'by-seat', 'by-script', 'now', 'hub'],
  resolve: ['work-item', 'slug', 'point', 'fact-kind', 'fact-value', 'round', 'by-seat', 'by-script', 'now', 'hub'],
  print: ['work-item', 'slug', 'hub'],
  sweep: ['tz', 'day-end', 'summary', 'now', 'hub'],
};
const FLAGS = { resume: ['check'], print: ['all', 'json', 'jsonl'], sweep: ['standing', 'gates', 'dry-run'] };

function parseArgs(command, argv) {
  const valued = new Set(VALUED[command]);
  const flags = new Set(FLAGS[command] || []);
  const opts = {};
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const name = a.slice(2);
      if (flags.has(name)) { opts[name] = true; continue; }
      if (!valued.has(name)) usage(`${command} has no option ${a}.`);
      if (argv[i + 1] === undefined) usage(`${a} needs a value.`);
      opts[name] = argv[i + 1];
      i += 1;
    } else {
      positional.push(a);
    }
  }
  return { opts, positional };
}

class Refusal extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

/* ----------------------------------------------------------------------- git helpers */

const gitOut = (args, opts = {}) => git(args, { env: quietGitEnv(), ...opts });

function tryGit(args, opts = {}) {
  try { return gitOut(args, opts); } catch { return null; }
}

/** A file at a commit, or null where it is not there. */
function fileAt(rev, path) {
  return rev ? tryGit(['show', `${rev}:${path}`]) : null;
}

/** The blob id of a path at a revision, or null where it is not there. */
function blobAt(rev, path) {
  const out = tryGit(['rev-parse', '--verify', '--quiet', `${rev}:${path}`]);
  return out ? out.trim() : null;
}

/** The trunk this run reads, confirmed against the remote, and its 12-hex commit. */
function hubTrunk() {
  const t = syncTrunk(REMOTE, TRUNK);
  return { head: t.head, commit: short(t.head), ref: t.ref };
}

/* ------------------------------------------------------------- what a person reads */

const at12 = (sha) => (sha ? `\`${sha}\`` : 'no commit');

/** The body of a new escalation's issue: what stopped, what to do, and the warning. */
function issueFor(esc) {
  const r = esc.raised;
  const point = loadPoints().byId.get(r.point);
  const label = r.work_item || r.slug;
  const title = `${r.path === 'incident' ? 'incident · ' : ''}${label} · ${r.point}`;
  const rows = [
    ['Stop', `\`${r.point}\`, ${point ? point.title : r.point}`],
    ['Work', `${label}${r.work_item ? `, feature \`${r.slug}\`` : ''}`],
    ...(r.repository ? [['Repository', `\`${r.repository}\``]] : []),
    ...(r.path === 'incident' ? [] : [['Work waits at', r.parked ? `\`${r.parked.ref || 'no branch'}\` @ ${at12(r.parked.commit)}` : 'nothing was changed']]),
    ...(r.links && r.links.design && r.path !== 'incident' ? [['Design', `\`${r.links.design}\``]] : []),
    ...(r.links && r.links.pr ? [['Pull request', r.links.pr]] : []),
    ['Told first', r.route.first],
    ['Told next', `${r.route.next ? `${r.route.next}, then ` : ''}the delivery lead`],
    ['Escalation', `\`${esc.id}\``],
  ];
  const ask = r.path === 'incident'
    ? `An incident is open on ${label}. The role told first holds the detail. This issue holds none of it, because everyone who can read the hub can read it.`
    : `**${r.question}**`;
  const body = [
    `### ${triggerLabel(r.trigger)} on ${label}`,
    '',
    ask,
    '',
    '| | |',
    '|---|---|',
    ...rows.map(([k, v]) => `| ${k} | ${v} |`),
    '',
    '#### How to act',
    `- ${point ? point.fix : 'Fix the cause where the decision belongs'}, then run ${point ? `\`${point.command}\`` : 'the command'} again. The run closes this issue.`,
    '- Comment `/ack` to take it, or `/ack as <role>`. The reminders stop.',
    '- Comment `/stop <reason>` to end the work, or `/withdraw <reason>` if the stop was a mistake.',
    '',
    `The record is the artefact \`${store.RECORD_ARTEFACT}\` on this issue. The harness only adds lines to it. Do not edit or delete the artefact or the harness's comments.`,
  ];
  return { id: esc.id, title, body: body.join('\n') };
}

/** The sentence that goes with one line in its comment. */
function sayLine(esc, line) {
  const r = esc.raised;
  switch (line.event) {
    case 'raised': return `**Raised.** ${triggerLabel(r.trigger)} at \`${r.point}\` on ${r.work_item || r.slug}.`;
    case 'notified': return line.channel === 'session' ? `**Told** ${line.to}, in the session.`
      : `**Told** ${line.to}.\n\n${messageFor(esc, line.to, line.to === 'delivery lead' ? 'the second wait ended with no answer' : 'the first wait ended with no answer').text}`;
    case 'reasked': return `**Reminder** to ${line.to}. Nobody has answered since ${r.at}.`;
    case 'handed-over': return `**Handed over** to ${line.to}.`;
    case 'acknowledged': return `**Acknowledged** by ${line.by.role}${line.by.login ? ` (@${line.by.login})` : ''}. The reminders stop. The standing sweep shows the escalation again once each weekday until it closes.`;
    case 'resumed': return line.upstream ? `**Resumed.** The ${line.upstream.what} changed from \`${line.upstream.from}\` to \`${line.upstream.to}\`, so the run starts a new count of rounds.` : '**Resumed.** The run continues.';
    default: return `**${line.event === 'resolved' ? 'Resolved' : line.event === 'stopped' ? 'Stopped' : 'Withdrawn'}.**\n\n${closingMessage(esc, line).text}`;
  }
}

/* --------------------------------------------------------------- the one write path */

/** The one state label and the open or closed state an escalation asks of its issue. */
function wantOf(escalations, ctx) {
  return (esc) => {
    if (isFinal(esc)) return { label: null, close: esc.state === 'resolved' ? 'completed' : 'not_planned' };
    if (supersededBy(escalations, esc)) return { label: null, close: 'not_planned' };
    if (esc.state === 'acknowledged') return { label: 'acknowledged', close: null };
    return { label: planLadder(esc, ctx.now, ctx.cfg).overdue ? 'overdue' : 'waiting', close: null };
  };
}

const REPORTED = new Set();
function report(warnings) {
  for (const w of warnings) if (!REPORTED.has(w)) { REPORTED.add(w); stderr.write(`WARNING — ${w}\n`); }
}

/**
 * Add lines to the escalations of one owner. `build({ existing, read })` returns { lines, findings,
 * result, replies }, and runs again on a fresh read when another writer took the same seq first,
 * so the seq and the id are always computed against what GitHub holds. It may throw a Refusal.
 * Returns { issues, lines, result }.
 */
function writeRecord(owner, build, ctx) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const read = store.readEscalations([owner]);
    remember(read.issues);
    report(read.warnings);
    if (read.faults.length) throw new Refusal(faultCode(read.faults), read.faults.map((f) => f.text).join('\n'));
    const existing = store.textOf(read, owner);
    const plan = build({ existing, read });
    let text = existing;
    for (const line of plan.lines) {
      const next = appendLine(owner, text, line);
      if (next.faults.length) throw new Refusal(faultCode(next.faults), next.faults.map((f) => f.text).join('\n'));
      text = next.text;
    }
    const after = readRecord(owner, text).escalations;
    const touched = [];
    const existed = new Set(read.issues.map((i) => i.number));
    let clash = false;
    const posted = [];
    let opened = null;
    try {
    for (const id of [...new Set(plan.lines.map((l) => l.id))]) {
      const esc = findEscalation(after, id);
      let issue = read.issues.find((i) => i.id === id);
      opened = null;
      if (!issue) {
        const made = store.createIssue(issueFor(esc));
        if (store.harnessIssues().some((i) => i.id === id && i.number < made.number)) {
          store.abandonIssue(made.number, `another raise took ${id} first`);
          clash = true;
          break;
        }
        opened = made.number;
        issue = { number: made.number, url: made.url, id, owner, escNumber: parseId(id).number, labels: [], state: 'open' };
        remember([issue]);
        if (plan.findings && plan.findings[id]) store.addFindings(issue.number, plan.findings[id]);
      }
      const mine = [];
      for (const line of plan.lines.filter((l) => l.id === id)) mine.push({ line, comment: store.postLine(issue.number, line, sayLine(esc, line)) });
      posted.push(...mine);
      opened = null;
      const all = store.lineCommentsOf(issue.number, id);
      if (mine.some((p) => all.some((c) => c.seq === p.line.seq && c.id < p.comment))) {
        for (const p of mine) store.deleteComment(p.comment);
        clash = true;
        break;
      }
      touched.push(issue);
    }
    } catch (err) {
      if (!(err instanceof SpokeError)) throw err;
      // Take back what this write posted, so a half-written plan never stays on the record.
      for (const p of posted) { try { store.deleteComment(p.comment); } catch { /* the reader reports a stray line */ } }
      if (opened) { try { store.abandonIssue(opened, 'GitHub refused its first line'); } catch { /* the reader ignores an issue with no line */ } }
      throw new SpokeError(err.exit, `${err.message}. The line is not on the record.`, err.reason);
    }
    const want = wantOf(after, ctx);
    for (const issue of touched) {
      // A writer that lost the seq deletes its comment a moment later. Until then the two comments
      // disagree, so the artefact waits for it rather than for the next write.
      const repair = existed.has(issue.number);
      let s = store.settle(issue, want, { repair });
      for (let wait = 1; wait <= 4 && s.faults.some((f) => f.duplicate); wait += 1) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250 * wait);
        s = store.settle(issue, want, { repair });
      }
      report(s.warnings);
      for (const f of s.faults) stderr.write(`RECORD FAULT (exit ${f.code}) — ${f.text}\n`);
    }
    for (const r of plan.replies || []) store.reply(r.issue, r.comment, r.text);
    if (!clash) return { issues: touched, lines: plan.lines, result: plan.result };
  }
  throw new SpokeError(EXIT.CANNOT_VERIFY, `another writer wrote to ${owner} at the same moment three times. The line is not on the record.`, 'write-conflict');
}

/* ------------------------------------------------------------------ the reading side */

/** Every escalation of one owner, or of the whole hub. Warnings go to stderr. */
function readOwners(owners, opts) {
  const read = store.readEscalations(owners, opts);
  remember(read.issues);
  report(read.warnings);
  return read;
}

const refOf = (written) => written.issues.map((i) => `#${i.number}`).join(', ') || 'no issue';

/** The escalation `id`, refused when the record does not hold it or it has already ended. */
function liveOrRefuse(esc, id) {
  if (!esc) throw new Refusal(1, `${id} is not on the record. Run print to list the escalations.`);
  if (isFinal(esc)) throw new Refusal(1, `${id} is already final (${esc.state}). A new stop on the same work is a new id.`);
  return esc;
}

/** The open escalations of one owner, optionally of one point, as the commands see them. */
function openOf(escalations, point) {
  return escalations.filter((e) => !isFinal(e) && !supersededBy(escalations, e) && (!point || e.point === point));
}

function ownerFromOpts(opts) {
  const owner = ownerOf(opts['work-item'], opts.slug);
  if (opts['work-item'] && !isKey(opts['work-item'])) usage(`--work-item ${opts['work-item']} is not a key such as PROJ-421.`);
  if (opts.slug && !isSlug(opts.slug)) usage(`--slug ${opts.slug} is not a slug such as payments-refunds.`);
  if (!owner) usage('name the work with --work-item <KEY> or --slug <slug>.');
  return owner;
}

const clock = (opts) => {
  const raw = opts.now || process.env.HARNESS_ESCALATION_NOW;
  if (!raw) return Date.now();
  const ms = Date.parse(raw);
  if (Number.isNaN(ms)) usage(`--now ${raw} is not a time.`);
  return ms;
};

/** The clock and the working day a write settles the issue's label with. */
const ctxOf = (opts) => ({ now: clock(opts), cfg: workingConfig(opts) });

function writerOf(opts) {
  if (opts['by-seat']) return { kind: 'seat', name: opts['by-seat'] };
  return { kind: 'script', name: opts['by-script'] || 'escalation.mjs' };
}

function personOf(opts) {
  const kind = opts['by-kind'] || 'person';
  if (kind !== 'person') throw new Refusal(1, `this line was written as a ${kind}: an agent never acknowledges, stops or withdraws its own escalation. A person runs this command.`);
  if (!opts.role) usage('a person line names the role that acts: --role "<role>".');
  const by = { kind: 'person', role: opts.role };
  if (opts.login) by.login = opts.login;
  return by;
}

/* ---------------------------------------------------------------------------- raise */

/**
 * The lines of one new escalation, against what the record file holds now. `raise` calls it with
 * `session` true: the runner is in the session, so the second line says so. The sweep calls it
 * for a merge that waited too long, with `session` false, because no session exists. A point on
 * the handover path also writes `handed-over` to its first role. It throws a Refusal while the
 * same stop is still open, except where the open escalation's last line is `resumed`: the re-run
 * reached the cap again, so this is a new escalation and the reader shows the old one as superseded.
 */
function raisedPlan(existing, spec) {
  const { owner, point, route } = spec;
  const { escalations } = readRecord(owner, existing);
  // One escalation for each pull-request comment that needs a person: the comment is part of the stop.
  const sameStop = openOf(escalations, point.id).filter((e) => e.raised.slug === spec.slug && e.raised.work_item === spec.workItem
    && (e.raised.links.comment || null) === (spec.links.comment || null));
  const live = sameStop.filter((e) => !(e.last && e.last.event === 'resumed'));
  if (live.length) {
    throw new Refusal(1, `${live[0].id} is still open for ${owner} at ${point.id}. Resolve, stop or withdraw it first. A re-run calls resume before it starts.`);
  }
  // An issue that another writer opened a moment ago holds its number before it holds a line.
  const number = Math.max(escalations.reduce((n, e) => Math.max(n, e.number), 0), ...(spec.taken || [])) + 1;
  const id = escalationId(owner, number);
  const first = spec.routeFirst || route.first.join(ROLE_SEPARATOR);
  const next = spec.routeNext || (route.next.length ? route.next.join(ROLE_SEPARATOR) : null);
  const findings = spec.findingsText !== null && spec.findingsText !== undefined ? store.FINDINGS_ARTEFACT : null;
  const links = { design: spec.links.design, iteration_run: spec.links.iteration_run };
  for (const k of ['tests', 'comment', 'pr']) if (spec.links[k]) links[k] = spec.links[k];
  const raised = {
    schema_version: SCHEMA_VERSION, id, seq: 1, event: 'raised', at: spec.at, by: spec.by,
    trigger: spec.trigger || route.trigger, point: point.id, path: route.path,
    work_item: spec.workItem, slug: spec.slug, repository: spec.repository,
    runner: spec.runner, route: { first, next }, parked: spec.parked,
    question: spec.question, findings, links, hub_commit: spec.hubCommit,
  };
  const lines = [raised];
  const add = (line) => lines.push({ schema_version: SCHEMA_VERSION, id, seq: lines.length + 1, at: spec.at, by: SCRIPT, ...line });
  if (spec.session) add({ event: 'notified', to: 'runner', channel: 'session' });
  if (route.path === 'handover') for (const role of splitRoles(first)) if (role !== 'runner') add({ event: 'handed-over', to: role });
  return {
    lines,
    findings: findings ? { [id]: spec.findingsText } : {},
    result: { id, number, raised, findings },
  };
}

function raiseCommand(opts) {
  const { byId } = loadPoints();
  if (!opts.point) usage('raise needs --point <ID>, such as dev-sprint.code-review-cap.');
  const point = byId.get(opts.point);
  if (!point) usage(`--point ${opts.point} is not one of the ${byId.size} stop points in governance/escalation-points.json.`);
  const route = routeOf(point, opts.path || null);
  if (!route) usage(`point ${point.id} follows ${point.path}${point.alternative ? ` or ${point.alternative.path}` : ''}, not ${opts.path}.`);
  if (route.path === 'question' || route.path === 'none') {
    throw new Refusal(3, `point ${point.id} follows the ${route.path} path, which writes no line. A question waits in the session, and nothing has stopped yet.`);
  }
  if (!PATHS.includes(route.path)) usage(`path ${route.path} is not a path.`);
  if (opts.asked && !point.ask_first) usage(`--asked goes only with a point that asks the person first, and ${point.id} is not one.`);
  if (opts.asked && !['left', 'absent'].includes(opts.asked)) usage('--asked is left or absent.');
  if (point.ask_first && !opts.asked) {
    throw new Refusal(1, `point ${point.id} is a question that the runner can answer, so ask the runner first. Nothing was raised.\nThen pass --asked left, where the runner left it for the role, or --asked absent, where the run has no runner.`);
  }
  if (opts.trigger && !TRIGGERS.includes(opts.trigger)) usage(`--trigger ${opts.trigger} is not one of ${TRIGGERS.join(', ')}.`);
  if (!opts.slug) usage('raise needs --slug <slug>. A feature has a slug before it has any key.');
  if (!isSlug(opts.slug)) usage(`--slug ${opts.slug} is not a slug such as payments-refunds.`);
  if (opts['work-item'] && !isKey(opts['work-item'])) usage(`--work-item ${opts['work-item']} is not a key such as PROJ-421.`);
  if (!opts.runner) usage('raise needs --runner <forge login>, or --runner none where the data officer refuses a stored login.');
  if (!opts.question) usage('raise needs --question "<the one question a person must answer>".');
  if (opts['parked-commit'] && !isHex12(opts['parked-commit'])) usage('--parked-commit is 12 hex characters.');
  if (opts['tests-commit'] && !isHex12(opts['tests-commit'])) usage('--tests-commit is 12 hex characters.');
  const dynamic = new Set(loadPoints().doc.roles.dynamic);
  for (const [role, flag] of [[route.first, 'route-first'], [route.next, 'route-next']]) {
    if (role.some((r) => dynamic.has(r)) && !opts[flag]) usage(`point ${point.id} names a role that only the command can resolve (${role.join(', ')}). Pass --${flag} "<role>".`);
  }
  const owner = ownerOf(opts['work-item'], opts.slug);
  const at = stamp(clock(opts));
  const trunk = hubTrunk();

  let findingsText = null;
  if (opts['findings-file']) {
    if (route.path === 'incident') throw new Refusal(1, 'an incident never carries findings. The record holds where it is, as a path and a commit, and never the secret or the data.');
    let size;
    try { size = statSync(opts['findings-file']).size; } catch { usage(`--findings-file ${opts['findings-file']} cannot be read.`); }
    if (size > FINDINGS_MAX) throw new Refusal(1, `the findings file is ${size} bytes. The limit is ${FINDINGS_MAX}. Deduplicate the findings first.`);
    findingsText = readFileSync(opts['findings-file'], 'utf8');
  }

  const written = writeRecord(owner, ({ existing, read }) => raisedPlan(existing, {
    taken: read.issues.filter((i) => i.owner === owner).map((i) => i.escNumber),
    owner, point, route, at, hubCommit: trunk.commit, by: writerOf(opts), session: true, findingsText,
    slug: opts.slug, workItem: opts['work-item'] || null, repository: opts.repository || null,
    runner: opts.runner === 'none' ? null : opts.runner, question: opts.question,
    routeFirst: opts['route-first'] || null, routeNext: opts['route-next'] || null, trigger: opts.trigger || null,
    parked: opts['parked-ref'] || opts['parked-commit'] ? { ref: opts['parked-ref'] || null, commit: opts['parked-commit'] || null } : null,
    links: { design: opts.design || null, iteration_run: opts['iteration-run'] || null, tests: opts['tests-commit'] || null, comment: opts.comment || null, pr: opts.pr || null },
  }), ctxOf(opts));
  return reportRaised(written, point, route, owner, trunk);
}

/**
 * The one line that tells a command how to mirror the stop on the story's Jira ticket, where the hub
 * has a Jira connection and the escalation names a story. The script runs nothing of it: Jira only
 * mirrors, the ticket is the story's own, and a failure there never changes the escalation.
 */
function jiraHint(workItem, trunkHead, fact, link) {
  if (!workItem || !blobAt(trunkHead, 'docs/estate/trackers.json')) return [];
  return [`  Jira: node scripts/jira-sync.mjs apply ${workItem} --fact ${fact}${link ? ` --link ${link}` : ''}`];
}

function reportRaised(written, point, route, owner, trunk) {
  const { raised, id } = written.result;
  const lines = [
    `ESCALATION RAISED — ${id}`,
    `  Work: ${raised.work_item || raised.slug} at ${point.id}, ${point.title}.`,
    `  Path: ${route.path}. Severity: ${point.severity || 'IMPORTANT'}. Wait: ${loadPoints().doc.waits[route.wait]}.`,
    `  Question: ${raised.question}`,
    raised.parked ? `  Parked: ${raised.parked.ref || 'no branch'} at ${raised.parked.commit || 'no commit'}. The harness reverts nothing.` : '  Parked: nothing was changed.',
    `  Told: the runner, in this session. Next: ${raised.route.first}${raised.route.next ? `, then ${raised.route.next}` : ''}, then the delivery lead.`,
    `  To act: ${point.fix}.`,
    `  Record: issue ${refOf(written)}, ${written.issues[0] ? written.issues[0].url : ''}, artefact ${store.RECORD_ARTEFACT}.`,
    `  To take it: comment /ack on the issue, or node scripts/escalation.mjs ack ${id} --role "<your role>"`,
    ...jiraHint(raised.work_item, trunk.head, 'needs-person', written.issues[0] && written.issues[0].url ? written.issues[0].url : '<the address of the issue>'),
    ...(raised.links.pr ? [`  Pull request: node scripts/pull-request.mjs label --repo-id <id> --pr <n> --needs-person yes`] : []),
  ];
  stdout.write(`${lines.join('\n')}\n`);
  return EXIT.PASS;
}

/* ----------------------------------------------------------- ack, stop and withdraw */

function personCommand(event, opts, positional) {
  const id = positional[0];
  if (!id || !parseId(id)) usage(`${event} needs an escalation id such as ESC-PROJ-421-01.`);
  if (event !== 'acknowledged' && !opts.reason) usage(`${event === 'stopped' ? 'stop' : 'withdraw'} needs --reason "<your own words>".`);
  const by = personOf(opts);
  const { owner } = parseId(id);
  const at = stamp(clock(opts));
  const written = writeRecord(owner, ({ existing }) => {
    const esc = liveOrRefuse(findEscalation(readRecord(owner, existing).escalations, id), id);
    const line = { schema_version: SCHEMA_VERSION, id, seq: esc.lines.length + 1, event, at, by };
    if (event !== 'acknowledged') line.reason = opts.reason;
    return { lines: [line], result: { esc, line } };
  }, ctxOf(opts));
  stdout.write(`ESCALATION ${event.toUpperCase()} — ${id}, line ${written.result.line.seq}, issue ${refOf(written)}.\n`);
  if (event !== 'acknowledged') deliver([closingMessage(written.result.esc, written.result.line)], { summary: process.env.GITHUB_STEP_SUMMARY });
  if (event === 'acknowledged') stdout.write('  The ladder stops. The escalation stays open and comes up once at each standing sweep until a fact or a person closes it.\n');
  else stdout.write('  The issue closes. The branch and the engineer\'s clone stay until a person removes them.\n');
  return EXIT.PASS;
}

/* ------------------------------------------------------------------- upstream state */

// The closed rows of one owner's clarification log, as the set a hash can pin. An owner with no log has none.
function closedRows(text) {
  if (text === null) return '';
  const rows = [];
  for (const line of text.split('\n')) {
    if (!line.startsWith('|')) continue;
    const cells = line.split('|').slice(1, -1).map((c) => c.trim());
    if (cells.length >= 8 && (cells[5] === 'Closed' || cells[5] === 'Withdrawn')) rows.push(`${cells[0]}:${cells[5]}`);
  }
  return rows.sort().join('\n');
}

/** What each upstream kind reads at the raise and now: { from, to } as 12 hex, or null when unreadable. */
function upstreamState(esc, spec, trunk, given) {
  const r = esc.raised;
  const pin = (blob) => (blob ? blob.slice(0, 12) : null);
  if (spec.what === 'tests') {
    const from = r.links && r.links.tests ? r.links.tests : null;
    return { from, to: given.tests || null, note: given.tests ? null : 'pass --tests-commit <the approved test commit> to compare the tests' };
  }
  if (spec.what === 'clarification') {
    const from = fileAt(r.hub_commit, CLAR_LOG(esc.owner));
    const to = fileAt(trunk.head, CLAR_LOG(esc.owner));
    return { from: pinOf(closedRows(from)), to: pinOf(closedRows(to)) };
  }
  const path = spec.what === 'requirements' ? REQUIREMENTS(r.slug) : r.links && r.links.design;
  if (!path) return { from: null, to: null, note: `the raised line names no ${spec.what} path` };
  if (spec.at === 'branch') {
    if (!r.parked || !r.parked.ref || !r.parked.commit) return { from: null, to: null, note: 'the raised line names no parked branch and commit' };
    tryGit(['fetch', '--no-tags', '--force', REMOTE, `+refs/heads/${r.parked.ref}:refs/remotes/${REMOTE}/${r.parked.ref}`]);
    return { from: pin(blobAt(r.parked.commit, path)), to: pin(blobAt(`refs/remotes/${REMOTE}/${r.parked.ref}`, path)), path };
  }
  return { from: pin(blobAt(r.hub_commit, path)), to: pin(blobAt(trunk.head, path)), path };
}

/* ---------------------------------------------------------------------------- resume */

function resumeCommand(opts) {
  const owner = ownerFromOpts(opts);
  const { escalations, faults } = readOwners([owner]);
  if (faults.length) throw new Refusal(faultCode(faults), faults.map((f) => f.text).join('\n'));
  const incident = openOf(escalations).find((e) => e.path === 'incident');
  if (incident) {
    throw new Refusal(1, `${incident.id} is an open incident on ${owner}. No run starts on this work until a person resolves or stops the incident.`);
  }
  const open = openOf(escalations, opts.point);
  if (!open.length) {
    stdout.write(`NO OPEN ESCALATION — ${owner}${opts.point ? ` at ${opts.point}` : ''}. The run starts a new count of rounds.\n`);
    return EXIT.PASS;
  }
  const { byId } = loadPoints();
  const capped = open.filter((e) => e.path === 'review-cap');
  if (!opts.point && open.length > 1 && capped.length !== 1) usage(`${owner} has ${open.length} open escalations (${open.map((e) => `${e.id} at ${e.point}`).join(', ')}). Name one with --point.`);
  const esc = opts.point ? open[0] : (capped[0] || open[0]);
  const point = byId.get(esc.point);
  const by = writerOf(opts);
  const at = stamp(clock(opts));

  if (esc.path !== 'review-cap' || !point.upstream || point.rerun_check === false) {
    if (opts.check) { stdout.write(`RE-RUN ALLOWED — ${esc.id} follows ${esc.path}, which asks for no upstream change.\n`); return EXIT.PASS; }
    const written = writeRecord(owner, ({ existing }) => {
      const cur = liveOrRefuse(findEscalation(readRecord(owner, existing).escalations, esc.id), esc.id);
      return { lines: [{ schema_version: SCHEMA_VERSION, id: esc.id, seq: cur.lines.length + 1, event: 'resumed', at, by }], result: {} };
    }, ctxOf(opts));
    stdout.write(`ESCALATION RESUMED — ${esc.id}, issue ${refOf(written)}. ${esc.path} asks for no upstream change.\n`);
    return EXIT.PASS;
  }

  const trunk = hubTrunk();
  const given = { tests: opts['tests-commit'] || null };
  if (given.tests && !isHex12(given.tests)) usage('--tests-commit is 12 hex characters.');
  const states = point.upstream.map((spec) => ({ spec, ...upstreamState(esc, spec, trunk, given) }));
  const changed = states.filter((s) => s.from && s.to && s.from !== s.to);
  const unreadable = states.filter((s) => (!s.from || !s.to) && s.spec.what !== 'tests');
  const already = new Set(esc.lines.filter((l) => l.event === 'resumed' && l.upstream).map((l) => `${l.upstream.what}:${l.upstream.to}`));

  if (!changed.length) {
    const report = states.map((s) => `  ${s.spec.what}${s.path ? ` ${s.path}` : ''}: ${s.from && s.to ? `unchanged (${s.from})` : `cannot be read${s.note ? ` — ${s.note}` : ''}`}`);
    if (unreadable.length === states.filter((s) => s.spec.what !== 'tests').length && unreadable.length) {
      throw new SpokeError(EXIT.CANNOT_VERIFY, `the upstream state of ${esc.id} cannot be read:\n${report.join('\n')}`, 'upstream-unreadable');
    }
    stderr.write(`RE-RUN REFUSED — nothing changed upstream since ${esc.id} was raised at ${esc.point}.\n${report.join('\n')}\n`);
    stderr.write(`The run stops at once. Change one of ${point.upstream.map((u) => u.what).join(', ')}, then run ${point.command} again. A cap is never raised.\n`);
    return EXIT.FAIL;
  }
  if (opts.check) {
    stdout.write(`RE-RUN ALLOWED — ${esc.id}: ${changed.map((s) => `${s.spec.what} ${s.from} to ${s.to}`).join(', ')}.\n`);
    return EXIT.PASS;
  }
  const fresh = changed.filter((s) => !already.has(`${s.spec.what}:${s.to}`));
  if (!fresh.length) {
    stdout.write(`RE-RUN ALLOWED — ${esc.id} already records ${changed.map((s) => s.spec.what).join(', ')}. The run starts a new count of rounds.\n`);
    return EXIT.PASS;
  }
  const written = writeRecord(owner, ({ existing }) => {
    const cur = liveOrRefuse(findEscalation(readRecord(owner, existing).escalations, esc.id), esc.id);
    const lines = fresh.map((s, i) => {
      const upstream = { what: s.spec.what, from: s.from, to: s.to };
      if (opts.pr) upstream.pr = opts.pr;
      return { schema_version: SCHEMA_VERSION, id: esc.id, seq: cur.lines.length + 1 + i, event: 'resumed', at, by, upstream };
    });
    return { lines, result: {} };
  }, ctxOf(opts));
  stdout.write(`ESCALATION RESUMED — ${esc.id}, issue ${refOf(written)}.\n${fresh.map((s) => `  ${s.spec.what}${s.path ? ` ${s.path}` : ''}: ${s.from} to ${s.to}`).join('\n')}\n  The run starts a new count of rounds.\n`);
  return EXIT.PASS;
}

/* --------------------------------------------------------------------------- resolve */

function resolveCommand(opts, positional) {
  if (!opts['fact-kind'] || !FACT_KINDS.includes(opts['fact-kind'])) usage(`resolve needs --fact-kind, one of ${FACT_KINDS.join(', ')}.`);
  if (opts['fact-value'] === undefined) usage('resolve needs --fact-value, the value a script read.');
  if (opts.round !== undefined && !Number.isInteger(Number(opts.round))) usage('--round is a whole number.');
  const id = positional[0];
  const owner = id ? (parseId(id) || usage(`${id} is not an escalation id.`)).owner : ownerFromOpts(opts);
  const { escalations, faults } = readOwners([owner]);
  if (faults.length) throw new Refusal(faultCode(faults), faults.map((f) => f.text).join('\n'));
  let targets;
  if (id) targets = escalations.filter((e) => e.id === id);
  else targets = openOf(escalations, opts.point);
  if (id) liveOrRefuse(targets[0], id);
  if (!targets.length) {
    stdout.write(`NOTHING TO RESOLVE — ${owner} has no open escalation${opts.point ? ` at ${opts.point}` : ''}.\n`);
    return EXIT.PASS;
  }
  const by = writerOf(opts);
  const at = stamp(clock(opts));
  // Confirm the trunk before the first write, so exit 2 always means that no line landed.
  const trunk = hubTrunk();
  const done = [];
  const closing = [];
  for (const target of targets) {
    const written = writeRecord(owner, ({ existing }) => {
      const cur = liveOrRefuse(findEscalation(readRecord(owner, existing).escalations, target.id), target.id);
      const fact = { kind: opts['fact-kind'], value: opts['fact-kind'] === 'exit' ? String(opts['fact-value']) : opts['fact-value'] };
      if (opts.round !== undefined) fact.round = Number(opts.round);
      const line = { schema_version: SCHEMA_VERSION, id: target.id, seq: cur.lines.length + 1, event: 'resolved', at, by, fact };
      return { lines: [line], result: { esc: cur, line } };
    }, ctxOf(opts));
    done.push(`${target.id}, issue ${refOf(written)}`);
    closing.push(closingMessage(written.result.esc, written.result.line));
  }
  stdout.write(`ESCALATION RESOLVED — ${done.join(', ')}.\n  The fact that ended it: ${opts['fact-kind']} ${opts['fact-value']}.\n`);
  const hint = targets.flatMap((t) => jiraHint(t.raised.work_item, trunk.head, 'person-answered', null));
  if (hint.length) stdout.write(`${[...new Set(hint)].join('\n')}\n`);
  deliver(closing, { summary: process.env.GITHUB_STEP_SUMMARY });
  return EXIT.PASS;
}

/* ----------------------------------------------------------------------------- print */

function printCommand(opts, positional) {
  const id = positional[0];
  let owners = null;
  if (id) owners = [(parseId(id) || usage(`${id} is not an escalation id.`)).owner];
  else if (opts['work-item'] || opts.slug) owners = [ownerFromOpts(opts)];
  else if (!opts.all) usage('print needs an id, --work-item, --slug or --all.');
  const { escalations, faults } = readOwners(owners);
  const shown = id ? escalations.filter((e) => e.id === id) : escalations;
  if (id && !shown.length && !faults.length) throw new Refusal(1, `${id} is not on the record.`);
  const hub = store.repo();
  if (opts.jsonl) {
    for (const e of shown) stdout.write(`${e.lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
  } else if (opts.json) {
    const out = shown.map((e) => ({ id: e.id, state: supersededBy(escalations, e) ? 'superseded' : e.state, point: e.point, path: e.path, work_item: e.raised && e.raised.work_item, slug: e.raised && e.raised.slug, lines: e.lines.length, last: e.last && e.last.event, issue: e.issue ? e.issue.number : null, url: e.issue ? e.issue.url : null }));
    stdout.write(`${JSON.stringify({ repository: hub, escalations: out, faults }, null, 2)}\n`);
  } else {
    stdout.write(`ESCALATION RECORD — the [shl-harness] issues of ${hub}\n`);
    for (const e of shown) {
      const state = supersededBy(escalations, e) ? 'superseded' : e.state;
      stdout.write(`  ${e.id}  ${String(state).padEnd(12)} ${e.point} (${e.path})  #${e.issue ? e.issue.number : '?'}  ${e.raised ? e.raised.question : ''}\n`);
    }
    if (!shown.length) stdout.write('  No escalation on the record.\n');
    stdout.write(`\n${renderTable(shown)}\n`);
  }
  for (const f of faults) stderr.write(`RECORD FAULT (exit ${f.code}) — ${f.text}\n`);
  return faultCode(faults);
}


/* ------------------------------------------------------------------ messages and the sweep */

// The link a person follows to act: the escalation's issue, from every issue this run read or opened.
const ISSUE_URLS = new Map();
const remember = (issues) => { for (const i of issues) if (i.url) ISSUE_URLS.set(i.id, i.url); };
function recordLink(esc) {
  return ISSUE_URLS.get(esc.id) || `the [shl-harness] issue of ${esc.id}`;
}

/**
 * One message: the key, the trigger and the point, the question, where the work waits, and a link
 * to act. A message to a person who is not in the session is the only reminder there is.
 */
function messageFor(esc, to, why) {
  const r = esc.raised;
  const label = r.work_item || r.slug;
  return {
    to, id: esc.id,
    text: [
      `[${label}] ${r.trigger} at ${r.point} — to ${to}`,
      `Why you are told: ${why}.`,
      `Question: ${r.question}`,
      r.parked ? `Parked: ${r.parked.ref || 'no branch'} at ${r.parked.commit || 'no commit'}.` : 'Parked: nothing was changed.',
      `Act: ${recordLink(esc)}`,
      'To take it: comment /ack on the issue.',
    ].join('\n'),
  };
}

/** The one message that tells everyone who was told that the escalation ended, and how. */
function closingMessage(esc, endLine) {
  const r = esc.raised;
  const told = [...new Set(esc.lines.filter((l) => ['notified', 'reasked', 'handed-over'].includes(l.event)).map((l) => l.to))];
  const how = endLine.event === 'resolved' ? `resolved by a fact: ${endLine.fact.kind} ${endLine.fact.value}`
    : r.path === 'incident' ? `${endLine.event} by ${endLine.by.role}`
      : `${endLine.event} by ${endLine.by.role}: ${endLine.reason}`;
  return {
    to: told.join(ROLE_SEPARATOR) || 'runner', id: esc.id,
    text: [`[${r.work_item || r.slug}] ${esc.id} ended — ${how}.`, `Told: ${told.join(ROLE_SEPARATOR) || 'the runner'}.`, 'Nothing more is asked of you for this escalation.'].join('\n'),
  };
}

/**
 * Deliver messages. The escalation's issue is the channel: each message is already a comment on
 * it, so GitHub notifies the people who follow it. This also writes each message to stdout and to
 * the job summary of the workflow that runs the sweep. INTEGRATION POINT for a chat tool, which a
 * hub adds to the body of this function. The `channel` of each `notified` and `reasked` line the
 * sweep writes is SWEEP_CHANNEL, the issue.
 */
function deliver(messages, { summary = null } = {}) {
  if (!messages.length) return;
  stdout.write(`\nMESSAGES — ${messages.length}\n${messages.map((m) => `\n${m.text}\n`).join('')}`);
  if (summary) {
    try { appendFileSync(summary, `\n## Escalation messages\n\n${messages.map((m) => `~~~text\n${m.text}\n~~~\n`).join('\n')}`); } catch (err) { stderr.write(`WARNING — the job summary ${summary} cannot be written (${err.message}). The messages are above.\n`); }
  }
}

class Nothing extends Error {}

function workingConfig(opts) {
  const cfg = {
    ...DEFAULT_CONFIG,
    tz: opts.tz || process.env.HARNESS_ESCALATION_TZ || DEFAULT_CONFIG.tz,
    dayEnd: opts['day-end'] || process.env.HARNESS_ESCALATION_DAY_END || DEFAULT_CONFIG.dayEnd,
  };
  try { new Intl.DateTimeFormat('en-GB', { timeZone: cfg.tz }); } catch { usage(`${cfg.tz} is not a time zone, such as Europe/Paris.`); }
  if (cfg.dayEnd.match(/^([01]\d|2[0-3]):[0-5]\d$/) === null) usage(`--day-end ${cfg.dayEnd} is not a time such as 17:00.`);
  return cfg;
}

// The pull requests of the hub: the one forge read the sweep makes. INTEGRATION POINT for a forge
// other than GitHub, as pull-request.mjs is. It runs `gh` in the hub checkout, or in GH_REPO.
function listPulls() {
  const args = ['pr', 'list', '--state', 'all', '--limit', String(PULL_LIMIT), '--json', 'number,headRefName,headRefOid,state,createdAt,closedAt,mergedAt,url,author,comments'];
  if (process.env.GH_REPO) args.push('--repo', process.env.GH_REPO);
  const res = spawnSync('gh', args, { encoding: 'utf8', env: process.env });
  if (res.error || res.status !== 0) throw new SpokeError(EXIT.CANNOT_VERIFY, `the gate scan needs the GitHub CLI: ${res.error ? res.error.message : firstLine(res.stderr)}`, 'gh-unavailable');
  try { return JSON.parse(res.stdout); } catch { throw new SpokeError(EXIT.CANNOT_VERIFY, 'the GitHub CLI answered with text that is not JSON', 'gh-failed'); }
}

// The slug of the work item `key`, from the backlog on the trunk, or null.
function slugOfItem(key, trunkHead) {
  const tree = tryGit(['ls-tree', '-r', '--name-only', trunkHead, 'docs/backlog']) || '';
  const hit = tree.split('\n').find((p) => p.endsWith(`/${key}.item.md`));
  return hit ? hit.split('/')[2] : null;
}

/**
 * The stop point a hub pull request waits at, from its branch, or null. A gate with no story is
 * recorded under its branch name, as `context-<name>` or `survey-<id>`.
 *   requirements/<slug> feature.merge · backlog/<slug> decompose.merge · feature/<KEY>-<words> dev-spec.merge · validation/<KEY> qa-sprint.merge
 *   context/<name> add-context.merge · estate/survey-<id> survey-repo.merge · estate/connect-<board> connect-jira.connection
 * dev-sprint.code-merge, add-context.rule-override, add-context.exception-approval and dev-sprint.coverage-floor merge in a spoke or in the global repository, which the sweep never reads.
 */
function gateOf(branch, trunkHead) {
  const cut = branch.indexOf('/');
  const kind = cut === -1 ? branch : branch.slice(0, cut);
  const rest = cut === -1 ? '' : branch.slice(cut + 1);
  if (kind === 'requirements' && isSlug(rest)) return { point: 'feature.merge', slug: rest, workItem: null, owner: rest };
  if (kind === 'backlog' && isSlug(rest)) return { point: 'decompose.merge', slug: rest, workItem: null, owner: rest };
  if (kind === 'feature' || kind === 'validation') {
    const key = kind === 'feature' ? rest.split('-').slice(0, 2).join('-') : rest;
    const slug = isKey(key) ? slugOfItem(key, trunkHead) : null;
    if (slug) return { point: kind === 'feature' ? 'dev-spec.merge' : 'qa-sprint.merge', slug, workItem: key, owner: key };
  }
  const named = (point, slug, path = null) => (isSlug(slug) ? { point, slug, workItem: null, owner: slug, path } : null);
  if (kind === 'context') return named('add-context.merge', `context-${rest.toLowerCase()}`);
  if (kind === 'estate' && rest.startsWith('survey-')) return named('survey-repo.merge', rest.toLowerCase());
  if (kind === 'estate' && rest.startsWith('connect-')) return named('connect-jira.connection', rest.toLowerCase(), 'merge-waiting');
  return null;
}

/**
 * The reason a person gave when they closed a pull request without a merge: their latest comment
 * after the escalation was raised. A bot's comment and a harness comment are never a reason.
 */
function closeReason(pr, raisedAt) {
  const isBot = (login) => !login || login.endsWith('[bot]') || login === 'github-actions';
  const said = (pr.comments || [])
    .filter((c) => c.body && c.author && !isBot(c.author.login) && !c.body.includes(store.WATERMARK) && String(c.createdAt) >= raisedAt)
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
    .pop();
  return said ? { login: said.author.login, reason: firstLine(said.body).slice(0, 300) } : null;
}

const COMMAND_EVENT = { ack: 'acknowledged', stop: 'stopped', withdraw: 'withdrawn' };

/** The role an escalation waits on now: the last role told after the runner, or its first role. */
function waitingRole(esc) {
  const told = esc.lines.filter((l) => (l.event === 'notified' || l.event === 'reasked' || l.event === 'handed-over') && l.to !== 'runner').map((l) => l.to);
  return told.length ? splitRoles(told[told.length - 1])[0] : splitRoles(esc.raised.route.first)[0];
}

/**
 * What the sweep owes one owner, against what GitHub holds now: the commands people commented,
 * the merges it watches, and the ladder. It runs again on a fresh read when another writer took
 * the same seq first. Returns the lines, the messages and the replies, or throws Nothing.
 */
function sweepPlan(owner, existing, ctx, read) {
  const { escalations } = readRecord(owner, existing);
  const lines = [];
  const messages = [];
  const states = [];
  const notes = [];
  const replies = [];
  const next = new Map(escalations.map((e) => [e.id, e.lines.length + 1]));
  const push = (esc, line, at = ctx.at) => { lines.push({ schema_version: SCHEMA_VERSION, id: esc.id, seq: next.get(esc.id), at, ...line }); next.set(esc.id, next.get(esc.id) + 1); };
  const ended = new Set();
  const taken = new Set();
  // Each new escalation counts its number against the ones this sweep raised before it.
  let planned = existing;

  for (const esc of escalations) {
    const issue = read.issues.find((i) => i.id === esc.id);
    if (!issue || !esc.raised) continue;
    for (const c of store.pendingCommands(issue, issue.lines)) {
      const say = (text) => replies.push({ issue: issue.number, comment: c.commentId, text });
      if (isFinal(esc) || ended.has(esc.id)) { say(`${esc.id} has already ended, so \`/${c.command}\` records nothing.`); continue; }
      if (!c.allowed) { say(`Only a person with write access to this repository can run \`/${c.command}\`. Nothing was recorded.`); continue; }
      const event = COMMAND_EVENT[c.command];
      let role = waitingRole(esc);
      if (event === 'acknowledged') {
        const as = c.rest.match(/^as\s+(.+)$/i);
        if (as) role = as[1].trim();
      } else if (!c.rest) {
        say(`\`/${c.command}\` needs a reason in your own words, such as \`/${c.command} the work moved to next quarter\`. Nothing was recorded.`);
        continue;
      }
      const by = { kind: 'person', role, via: 'issue-comment', comment: c.commentId };
      if (c.login) by.login = c.login;
      const line = { event, by, ...(event === 'acknowledged' ? {} : { reason: c.rest }) };
      push(esc, line, stamp(Date.parse(c.at) || ctx.now));
      if (event === 'acknowledged') taken.add(esc.id);
      else { ended.add(esc.id); messages.push(closingMessage(esc, line)); }
    }
  }

  for (const gate of ctx.gates.filter((g) => g.owner === owner)) {
    const esc = escalations.find((e) => e.raised && e.raised.links && e.raised.links.pr === gate.pr.url);
    const live = esc && !isFinal(esc) && !supersededBy(escalations, esc) && !ended.has(esc.id);
    const pr = gate.pr;
    if (esc && live && pr.state === 'MERGED') {
      const line = { event: 'resolved', by: SCRIPT, fact: { kind: 'merge', value: 'MERGED' } };
      push(esc, line);
      messages.push(closingMessage(esc, line));
      ended.add(esc.id);
    } else if (esc && live && pr.state === 'CLOSED') {
      // A closed pull request asks nobody to merge it, so the ladder stops for it either way.
      ended.add(esc.id);
      const said = closeReason(pr, esc.raised.at);
      if (said) {
        // The role is the one that may close the gate: the first role of the escalation.
        const line = { event: 'stopped', by: { kind: 'person', role: splitRoles(esc.raised.route.first)[0], login: said.login }, reason: said.reason };
        push(esc, line);
        messages.push(closingMessage(esc, line));
      } else {
        notes.push(`${esc.id}: pull request #${pr.number} closed without a merge, and no person gave a reason after the raise. A person comments /stop <reason> on the escalation's issue`);
      }
    } else if (!esc && pr.state === 'OPEN' && ctx.now >= waitEnds(Date.parse(pr.createdAt), 'same-working-day', ctx.cfg)) {
      const { byId } = loadPoints();
      const point = byId.get(gate.point);
      const plan = raisedPlan(planned, {
        taken: read.issues.filter((i) => i.owner === owner).map((i) => i.escNumber),
        owner, point, route: routeOf(point, gate.path), at: ctx.at, hubCommit: ctx.hubCommit, by: SCRIPT, session: false, findingsText: null,
        slug: gate.slug, workItem: gate.workItem, repository: null, runner: pr.author && pr.author.login ? pr.author.login : null,
        question: `Merge pull request #${pr.number}, or ask for changes. It is still open at the end of its working day.`, routeFirst: null, routeNext: null, trigger: null,
        parked: { ref: pr.headRefName, commit: pr.headRefOid ? pr.headRefOid.slice(0, 12) : null },
        links: { design: null, iteration_run: null, tests: null, comment: null, pr: pr.url },
      });
      lines.push(...plan.lines);
      for (const line of plan.lines) planned = appendLine(owner, planned, line).text;
      notes.push(`${plan.result.id}: raised for pull request #${pr.number}, which is still open at the end of its working day`);
    }
  }

  for (const esc of escalations) {
    if (!esc.raised || isFinal(esc) || supersededBy(escalations, esc) || ended.has(esc.id) || taken.has(esc.id)) continue;
    const plan = planLadder(esc, ctx.now, ctx.cfg, { standing: ctx.standing });
    states.push({ id: esc.id, point: esc.point, state: plan.overdue ? 'overdue' : plan.state, actions: plan.actions });
    for (const a of plan.actions) {
      push(esc, a.event === 'handed-over' ? { event: 'handed-over', by: SCRIPT, to: a.to } : { event: a.event, by: SCRIPT, to: a.to, channel: SWEEP_CHANNEL });
      messages.push(messageFor(esc, a.to, a.why));
    }
  }
  if (!lines.length) throw Object.assign(new Nothing('nothing is due'), { states, notes, replies });
  return { lines, replies, findings: {}, result: { messages, states, notes } };
}

/** Settle the issues of one owner whose label, state or artefact no longer matches the record. */
function settleOwner(read, owner, ctx) {
  const mine = read.escalations.filter((e) => e.owner === owner && e.issue);
  const want = wantOf(mine, ctx);
  const changed = [];
  for (const esc of mine.filter((e) => store.needsSettle(e.issue, want(e)))) {
    const s = store.settle(esc.issue, want, { repair: true });
    report(s.warnings);
    for (const f of s.faults) stderr.write(`RECORD FAULT (exit ${f.code}) — ${f.text}\n`);
    if (s.changed.length) changed.push(`#${esc.issue.number} ${esc.id}: ${s.changed.join(', ')}`);
  }
  return changed;
}

function sweepCommand(opts) {
  const nowMs = clock(opts);
  const at = stamp(nowMs);
  const cfg = workingConfig(opts);
  const summary = opts.summary || process.env.GITHUB_STEP_SUMMARY || null;
  const trunk = hubTrunk();
  // An escalation closed more than two days ago needs nothing more, and the hub's own closed-issue
  // event reopens one a person closes, so the sweep does not read every old issue each run.
  const read = readOwners(null, { closedSince: nowMs - 2 * 86400000 });
  const faults = [...read.faults];
  const pulls = opts.gates ? listPulls() : [];
  if (pulls.length >= PULL_LIMIT) {
    faults.push({ code: 2, text: `gh lists only the newest ${PULL_LIMIT} pull requests of the hub, so the sweep does not read a gate on an older one.`, line: null });
  }
  const gates = pulls.map((pr) => ({ pr, ...gateOf(pr.headRefName, trunk.head) })).filter((g) => g.point);
  const owners = [...new Set([...read.issues.map((i) => i.owner), ...gates.map((g) => g.owner)])].sort();
  const ctx = { now: nowMs, at, cfg, standing: Boolean(opts.standing), gates, hubCommit: trunk.commit };

  const out = [`ESCALATION SWEEP — ${at}${ctx.standing ? ', standing' : ''}, the working day ends at ${cfg.dayEnd} in ${cfg.tz}`];
  const sent = [];
  const live = [];
  for (const owner of owners) {
    const ownerFaults = read.faults.filter((f) => f.text.startsWith(`${owner}:`) || read.issues.some((i) => i.owner === owner && f.text.startsWith(`#${i.number} `)));
    if (ownerFaults.length) { out.push(`  ${owner}: refused — ${ownerFaults[0].text}`); continue; }
    let result;
    try {
      if (opts['dry-run']) {
        result = sweepPlan(owner, store.textOf(read, owner), ctx, read).result;
      } else {
        result = writeRecord(owner, ({ existing, read: fresh }) => sweepPlan(owner, existing, ctx, fresh), ctx).result;
      }
    } catch (err) {
      if (err instanceof Nothing) {
        live.push(...err.states.map((s) => ({ ...s, owner })));
        out.push(...err.notes.map((n) => `  ${n}`));
        if (!opts['dry-run']) {
          for (const r of err.replies) store.reply(r.issue, r.comment, r.text);
          out.push(...settleOwner(read, owner, ctx).map((n) => `  ${n}`));
        }
        continue;
      }
      if (err instanceof Refusal) { out.push(`  ${owner}: refused — ${err.message.split('\n')[0]}`); faults.push({ code: err.code, text: err.message, line: null }); continue; }
      throw err;
    }
    live.push(...result.states.map((s) => ({ ...s, owner })));
    out.push(...result.notes.map((n) => `  ${n}`));
    sent.push(...result.messages);
  }
  for (const s of live) {
    const did = s.actions.length ? s.actions.map((a) => `${a.event} ${a.to}`).join(', ') : 'nothing due';
    out.push(`  ${s.id}  ${s.state.padEnd(12)} ${s.point}  ${did}`);
  }
  if (!live.length && !sent.length) out.push('  No live escalation is due.');
  const counts = live.reduce((c, s) => { c[s.state] = (c[s.state] || 0) + 1; return c; }, {});
  out.push(`  Live: ${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ') || 'none'}.${opts['dry-run'] ? ' Dry run: nothing was written.' : ''}`);
  stdout.write(`${out.join('\n')}\n`);
  for (const f of faults) stderr.write(`RECORD FAULT (exit ${f.code}) — ${f.text}\n`);
  if (!opts['dry-run']) deliver(sent, { summary });
  else if (sent.length) stdout.write(`\nMESSAGES THAT A RUN WOULD SEND — ${sent.length}\n${sent.map((m) => `\n${m.text}\n`).join('')}`);
  if (summary && !opts['dry-run']) { try { appendFileSync(summary, `\n## Escalation sweep\n\n~~~text\n${out.join('\n')}\n~~~\n`); } catch { /* the summary is a courtesy */ } }
  return faultCode(faults);
}

/* ------------------------------------------------------------------------------ main */

function main(argv) {
  const [command, ...rest] = argv;
  if (!command || !Object.hasOwn(VALUED, command)) usage(command ? `unknown subcommand: ${command}` : 'name a subcommand.');
  const { opts, positional } = parseArgs(command, rest);
  if (opts.hub) {
    try { process.chdir(resolve(opts.hub)); } catch { usage(`--hub ${opts.hub} is not a folder.`); }
  }
  switch (command) {
    case 'raise': return raiseCommand(opts);
    case 'ack': return personCommand('acknowledged', opts, positional);
    case 'stop': return personCommand('stopped', opts, positional);
    case 'withdraw': return personCommand('withdrawn', opts, positional);
    case 'resume': return resumeCommand(opts);
    case 'resolve': return resolveCommand(opts, positional);
    case 'print': return printCommand(opts, positional);
    case 'sweep': return sweepCommand(opts);
    default: return usage(`unknown subcommand: ${command}`);
  }
}

// The last line of an exit 2, 3 or 4 names this script and its code, so a shell line that hides
// the code, with a pipe or `; echo`, still tells the harness's failure record. Written at once,
// so a process.exit() never loses it.
process.on('exit', (code) => { if (code >= 2 && code <= 4) { try { writeSync(2, `HARNESS EXIT: escalation ${code}\n`); } catch { /* stderr is closed */ } } });

try {
  process.exit(main(process.argv.slice(2)));
} catch (err) {
  if (err instanceof Refusal) {
    stderr.write(`${err.code === 3 ? 'USAGE' : 'ESCALATION REFUSED'} — ${err.message}\n`);
    process.exit(err.code);
  }
  if (err instanceof SpokeError) {
    stderr.write(`ESCALATION ${err.exit === EXIT.CANNOT_VERIFY ? 'CANNOT VERIFY' : 'REFUSED'} — ${err.message}\n${reasonLine(err.reason)}`);
    process.exit(err.exit);
  }
  stderr.write(`INTERNAL — ${err && err.stack ? err.stack : err}\n`);
  process.exit(EXIT.INTERNAL);
}

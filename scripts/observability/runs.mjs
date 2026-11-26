// Part of the harness asset library c6f3b4427d58f7c3 (see VERSION.json) · 2026-10-26
/**
 * runs.mjs — the harness's own sessions. A run is one harness command, from the prompt that starts
 * it to the next harness command in the same runtime session, or the session's end.
 *
 * A run takes its key from the command line: the story from a story command's argument, the
 * feature from /decompose's document path. /feature and /pr-review find theirs later, in the
 * branch of the session's working folder. The key is kept only when it matches the key pattern or
 * the slug pattern: the rest of a command line never leaves this module. The run records where it
 * found its key, and every record of the run names its bucket (`bucketOf`).
 *
 * A main-session call goes to the last run that started before it. A seat's calls all go to the
 * run that was current when the seat made its first call.
 *
 * Node standard library only.
 */
import { randomUUID } from 'node:crypto';
import { isKey, isSlug } from './common.mjs';

/**
 * Every command in accelerator/commands/, with the key its run carries: a story, a feature, or none
 * for estate work. The observability-collect suite fails when this list and the folder disagree.
 */
export const COMMANDS = Object.freeze({
  'add-context': null,
  'add-repo': null,
  // A bug's Jira key is a key like a story's, so the run carries it as a story.
  bugfix: 'story',
  'check-global': null,
  'connect-confluence': null,
  'connect-jira': null,
  'connect-observability-platform': null,
  decompose: 'feature',
  'dev-spec': 'story',
  'dev-sprint': 'story',
  'enrich-ticket': 'story',
  'estate-overview': null,
  'estate-overview-refresh': null,
  feature: 'feature',
  feedback: null,
  'from-ticket': 'story',
  'pr-review': 'story',
  'prime-review': 'story',
  'qa-sprint': 'story',
  'survey-repo': null,
});

/**
 * Where a run found its key: its command line, the branch of the session's working folder, a harness
 * script that its work ran, or the same command typed again. A key, once found, never changes.
 */
export const KEY_SOURCES = Object.freeze(['command', 'branch', 'work', 'next-command']);
/**
 * The bucket of a record: a story, a feature with no story, estate work, or none, when a story or a
 * feature command found no key.
 */
export const SCOPES = Object.freeze(['story', 'feature', 'estate', 'none']);

const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

/** The slug of `docs/requirements/<SLUG>/…`, or null. */
export function slugFromPath(text) {
  const m = typeof text === 'string' ? text.match(/^(?:\.\/)?docs\/requirements\/([a-z0-9]+(?:-[a-z0-9]+)*)(?:\/|$)/) : null;
  return m && isSlug(m[1]) ? m[1] : null;
}

/**
 * The harness command a prompt starts, or null when it starts none. A namespace before the name,
 * as in `/project:dev-sprint` or `/prompts:dev-sprint`, is allowed.
 */
export function parseCommand(prompt) {
  if (typeof prompt !== 'string') return null;
  const m = prompt.trim().match(/^\/(?:[a-z0-9_-]+:)?([a-z][a-z0-9-]*)(?:\s+([\s\S]*))?$/);
  if (!m || !has(COMMANDS, m[1])) return null;
  const command = m[1];
  const kind = COMMANDS[command];
  const args = (m[2] || '').split(/\s+/).filter(Boolean);
  const run = { command, key_kind: kind, story: null, feature: null };
  if (kind === 'story' && command !== 'pr-review' && command !== 'prime-review') run.story = args.find(isKey) ?? null;
  if (command === 'decompose') run.feature = args.map(slugFromPath).find(Boolean) ?? null;
  return run;
}

/** The key a harness branch names: `{ story }`, `{ feature }`, or null for any other branch. */
export function keyFromBranch(branch) {
  if (typeof branch !== 'string') return null;
  let m = branch.match(/^(?:requirements|backlog)\/([a-z0-9]+(?:-[a-z0-9]+)*)$/);
  if (m && isSlug(m[1])) return { feature: m[1] };
  m = branch.match(/^harness\/tracker-links-([a-z0-9]+(?:-[a-z0-9]+)*)$/);
  if (m && isSlug(m[1])) return { feature: m[1] };
  m = branch.match(/^(?:feature|validation)\/([A-Z][A-Z0-9]{1,9}-\d+)(?:-|$)/);
  if (m && isKey(m[1])) return { story: m[1] };
  return null;
}

/**
 * The five harness scripts whose command line names the story that a story's work is on, each with
 * the place of the key in that line. `.js` checks become `.mjs` in a hub that is not a module package.
 */
const WORK_SCRIPTS = /check-dev-ready|check-validation|check-design-amend|jira-sync|test-guard/;
const WORK_KEYS = [
  /(?:^|[\s/'"])check-(?:dev-ready|validation)\.m?js\s+["']?([A-Z][A-Z0-9]{1,9}-\d+)(?![\w-])/,
  /(?:^|[\s/'"])check-design-amend\.mjs\s+["']?([A-Z][A-Z0-9]{1,9}-\d+)(?![\w-])/,
  /(?:^|[\s/'"])jira-sync\.mjs\s+apply\s+["']?([A-Z][A-Z0-9]{1,9}-\d+)(?![\w-])/,
  /(?:^|[\s/'"])test-guard\.mjs\s+setup\s[^;&|]*?--key[\s=]+["']?([A-Z][A-Z0-9]{1,9}-\d+)(?![\w-])/,
];

/**
 * The story key a shell command line gives when it runs one of the five scripts, or null. When the
 * line runs more than one, the first key in the line counts. The rest of the line never leaves.
 */
export function keyFromWork(commandLine) {
  if (typeof commandLine !== 'string' || commandLine.search(WORK_SCRIPTS) === -1) return null;
  let found = null;
  for (const pattern of WORK_KEYS) {
    const m = commandLine.match(pattern);
    if (m && isKey(m[1]) && (!found || m.index < found.at)) found = { key: m[1], at: m.index };
  }
  return found ? found.key : null;
}

/**
 * The work of a story run shows a story's key at `ms`. A run with no key takes it. A run on another
 * story ends, and a run of the same command opens for this key. A feature run and estate work never
 * take a key from the work. Returns true when the binding changed.
 */
export function takeWorkKey(binding, key, ms) {
  const run = runAt(binding, ms);
  if (!run || run.key_kind !== 'story' || !isKey(key) || run.story === key) return false;
  if (!run.story) return fillKey(run, { story: key }, 'work');
  openRun(binding, { command: run.command, key_kind: 'story', story: key, feature: null, key_from: 'work', person: run.person ?? null }, ms);
  return true;
}

/**
 * Opens a run in a session's binding. The run before it ends where this one starts. `parsed.person`
 * is the person who runs the command (person.mjs), or null. Every record of the run names that person.
 */
export function openRun(binding, parsed, startedMs) {
  const runs = binding.runs || (binding.runs = []);
  const last = runs[runs.length - 1];
  if (last && last.ended_ms == null) last.ended_ms = startedMs;
  const keyFrom = parsed.key_from ?? (parsed.story || parsed.feature ? 'command' : null);
  const run = { run_id: randomUUID(), command: parsed.command, key_kind: parsed.key_kind, story: parsed.story, feature: parsed.feature, key_from: keyFrom, person: parsed.person ?? null, started_ms: startedMs, ended_ms: null };
  runs.push(run);
  return run;
}

/** How soon the same command, typed again with its key, must start after the run that had none. */
export const NEXT_COMMAND_MS = 10 * 60 * 1000;

/**
 * A story run that ended with no key takes the key of `run`, the run just opened, when the person
 * typed the same command again: in the same session, with no harness command between, and within
 * 10 minutes of the start of the run with no key. Returns true when the run before took the key.
 */
export function keyFromNextCommand(binding, run) {
  const runs = binding.runs || [];
  const at = runs.indexOf(run);
  const before = at > 0 ? runs[at - 1] : null;
  if (!before || before.key_kind !== 'story' || before.story || !run.story) return false;
  if (before.command !== run.command || run.started_ms - before.started_ms > NEXT_COMMAND_MS) return false;
  return fillKey(before, { story: run.story }, 'next-command');
}

/** The run a call at `ms` belongs to: the last one that started at or before it. Null before the first. */
export function runAt(binding, ms) {
  let found = null;
  for (const run of binding.runs || []) if (run.started_ms <= ms && (!found || run.started_ms >= found.started_ms)) found = run;
  return found;
}

export const runById = (binding, id) => (binding.runs || []).find((r) => r.run_id === id) || null;

/**
 * Fills a run's missing key, from its branch unless `source` names another of KEY_SOURCES. A key,
 * once found, never changes: a story run takes only a story, a feature run only a feature, and a
 * run with a key keeps it.
 */
export function fillKey(run, found, source = 'branch') {
  if (!run || !found) return false;
  if (run.key_kind === 'story' && !run.story && found.story) { run.story = found.story; run.key_from = source; return true; }
  if (run.key_kind === 'feature' && !run.feature && found.feature) { run.feature = found.feature; run.key_from = source; return true; }
  return false;
}

/**
 * The bucket of a record, and where its key came from: { scope, key_from }. `key_from` is null when
 * the record has no key. Without its run, a record keeps its own source, and takes the key kind of
 * its command.
 */
export function bucketOf(record, run) {
  const kind = run ? run.key_kind : (COMMANDS[record.command] ?? null);
  const source = run ? run.key_from : record.key_from;
  const keyFrom = KEY_SOURCES.includes(source) ? source : null;
  if (record.story) return { scope: 'story', key_from: keyFrom };
  if (record.feature) return { scope: 'feature', key_from: keyFrom };
  return { scope: kind ? 'none' : 'estate', key_from: null };
}

/** Marks a session's last run as ended, as `SessionEnd` does. */
export function endSession(binding, ms) {
  const runs = binding.runs || [];
  const last = runs[runs.length - 1];
  if (last && last.ended_ms == null) last.ended_ms = ms;
  binding.ended_ms = ms;
}

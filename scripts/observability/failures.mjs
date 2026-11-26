// Part of the harness asset library c6f3b4427d58f7c3 (see VERSION.json) · 2026-11-09
/**
 * failures.mjs — the rules of a harness failure. It holds no runtime's log format. A collector
 * adapter's time reader reads its log into time events, and time.mjs turns a failure in them into a
 * `failure` record:
 *   - a harness script that exits 2 (cannot verify), 3 (usage) or 4 (internal). Exit 1 is a check
 *     that worked and refused the work, so it is not a failure, and exit 0 is a pass;
 *   - a turn that the runtime failed: an API error, an authentication error, an output cap.
 *
 * Only a harness script on the fixed list below counts. Another program gives its exit codes other
 * meanings. A shell command line that names exactly one script on the list is that script's run.
 * A line that names two or more scripts gives no record, because the exit code is the line's and
 * not one script's. A script piped into another program, or followed by `|| true`, hides its exit
 * code, so its failure gives no record. The command line never leaves this module: the record names
 * the script only.
 *
 * Node standard library only.
 */

import { REASONS, reasonIn } from './common.mjs';

/**
 * The harness scripts that a command, a seat or a person runs, as installed under scripts/ in the
 * hub or the spoke, by the name of their file. Modules that only other scripts import, and the
 * hooks that a runtime runs, are not on the list.
 */
export const HARNESS_SCRIPTS = Object.freeze([
  'check-agent-registry', 'check-context', 'check-coverage', 'check-decomposition',
  'check-dependencies', 'check-design-amend', 'check-dev-ready', 'check-fan-in', 'check-intake',
  'check-qa-gate', 'check-registry', 'check-requirements', 'check-requirements-amend',
  'check-requirements-candidate', 'check-spoke-rules', 'check-staged', 'check-survey',
  'check-survey-secrets', 'check-trackers', 'check-validation', 'check-watermark', 'escalation',
  'feedback-context', 'harness-commit', 'jira-sync', 'join-survey', 'observability-gate', 'observability-send',
  'observability-status', 'plan-overview', 'plan-survey', 'prime', 'pull-request', 'read-context',
  'read-global', 'read-hubs', 'read-spoke', 'read-spoke-rules', 'read-survey', 'report-context',
  'report-global', 'secret-scan', 'spoke-codeowners', 'story-gate-plan', 'test-guard',
  'test-quality-scan'
]);

/** The outcome of each exit code that is a failure. */
export const OUTCOMES = Object.freeze({ 2: 'cannot-verify', 3: 'usage', 4: 'internal' });
/** The outcome of a turn that the runtime failed. */
export const RUNTIME_OUTCOME = 'runtime';
/** Where a failure came from. */
export const SOURCES = Object.freeze(['script', 'runtime']);

/** A script's name in a command line: after a start, a space, a slash or a quote, and before its end. */
const SCRIPT_IN_LINE = new RegExp(String.raw`(?:^|[\s/'"])(${HARNESS_SCRIPTS.join('|')})\.(?:c|m)?js(?=$|[\s'";&|)])`, 'g');
/** A reason as a record carries it: a short token, never a sentence. */
const REASON = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

/** The harness script that a shell command line runs, or null when it runs none or more than one. */
export function scriptOf(commandLine) {
  if (typeof commandLine !== 'string') return null;
  const names = new Set([...commandLine.matchAll(SCRIPT_IN_LINE)].map((m) => m[1]));
  return names.size === 1 ? [...names][0] : null;
}

/**
 * A runtime failure's reason as a record may carry it: the runtime's own type of error, such as
 * `server_error`. Null when the text is not a short token.
 */
export const reasonOf = (value) => (typeof value === 'string' && value.search(REASON) === 0 ? value : null);

/**
 * The token of the last `REASON: <token>` line in a script's output, or null. Only a token on
 * spoke-remote.mjs's REASONS counts, so a script failure's reason is always one of a fixed list.
 * The rest of the output never leaves.
 */
export const reasonInOutput = reasonIn;

/** The line a harness script writes last when it exits 2, 3 or 4: `HARNESS EXIT: <script> <code>`. */
const EXIT_MARKER = /^HARNESS EXIT: ([a-z][a-z0-9-]*) ([234])\s*$/gm;

/**
 * The exit codes that a shell call's output states, by script: `{ <script>: <code> }`. A script
 * writes the line itself, so it holds when the shell line hides the code, with a pipe or `; echo`.
 * A script that quotes another script's output quotes that one's line too, so each script keeps the
 * last line that names it, and a call counts only the line of the script it runs.
 */
export function statedExits(output) {
  const out = {};
  if (typeof output !== 'string') return out;
  for (const m of output.matchAll(EXIT_MARKER)) if (HARNESS_SCRIPTS.includes(m[1])) out[m[1]] = Number(m[2]);
  return out;
}

/** Stated exits as a plugin passes them, kept only for scripts on the list and codes 2, 3 or 4. */
export function cleanStated(value) {
  const out = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
  for (const [script, code] of Object.entries(value)) if (HARNESS_SCRIPTS.includes(script) && isFailureExit(code)) out[script] = code;
  return out;
}

/** The reasons a script failure may carry: the tokens of spoke-remote.mjs's REASONS. */
export const SCRIPT_REASONS = REASONS;

/** True when an exit code is a harness failure. */
export const isFailureExit = (code) => Number.isInteger(code) && Object.hasOwn(OUTCOMES, code);

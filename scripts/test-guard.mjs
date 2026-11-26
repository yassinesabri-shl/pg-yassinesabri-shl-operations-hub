#!/usr/bin/env node
// Part of the harness asset library c6f3b4427d58f7c3 (see VERSION.json) · 2026-10-08
/**
 * test-guard.mjs — the protected-test guard: during /dev-sprint the tests the test writer wrote and
 * the critic approved stay the tests the build is judged by. Only the test writer creates or
 * changes a test, fixture, snapshot, helper or runner configuration; a missing or wrong test is a
 * request to the orchestrator, which pauses the engineer and routes it to the test writer.
 *
 * What it checks, and the whole of it: the candidate `finalize` validates and `verdict` accepts
 * holds the approved tests exactly as approved and no new path the declaration covers, and the
 * critic's verdict names that exact commit and tree. That holds when acceptance goes through
 * `verdict` after `finalize`, as /dev-sprint instructs; nothing here forces that order. The workflow:
 *
 *   1. setup         the baseline, the manifest of every tracked entry TEST_GUARD_PATHS covers there,
 *                    the runner and every validation command, frozen outside the engineer's clone:
 *                    private refs in the controller checkout and a temporary run directory. The
 *                    baseline is the approved test commit, or, for a fix round after /qa-sprint,
 *                    the branch QA validated: an accepted candidate, the test writer's new test
 *                    commit on it, or a merge of the spoke's trunk (test-guard/baseline.mjs).
 *   2. the engineer  one Claude Code engineer subagent per run, in its own `git clone --no-local`,
 *                    started only after the preflight has proved its hooks and `dispatch` has bound
 *                    them to the run; its first hook call claims the binding, which is the proof the
 *                    hooks ran for this run. A write to an approved test, a protected location, a
 *                    runner configuration or a new conventional test is refused before it happens;
 *                    after every command, failed or not, approved files are put back, refused files
 *                    moved aside and runner configuration added to a mixed file undone. Neither ends
 *                    the engineer's session.
 *   3. finalize      after every engineer round, before any critic: one clean candidate tree built
 *                    from the engineer's HEAD tree — approved tests as approved, every new path the
 *                    declaration covers left out — committed on the approved test commit through
 *                    harness-commit.mjs only when the frozen commands pass, run once in a checkout
 *                    the finalizer made, the protected locations checked on disk before the first
 *                    command and after every command.
 *   4. hand-in, verdict
 *                    the critic reviews that exact commit and tree; its verdict names both.
 *   5. accept        APPROVED re-reads the candidate from the controller — a finalized, passed
 *                    round, its ref, tree, a single commit on the baseline, the approved tests
 *                    intact — and fast-forwards to it. A round never finalized is refused.
 *
 * `git commit --no-verify`, a changed hook, a rewritten branch, the engineer's index, commits or
 * configuration: none of them is authority. This is workflow isolation, not a sandbox: a process
 * running as the same user can still write into the controller, its refs or the run directory, and
 * nothing here claims a file is physically unwritable. The checks prove the protected tree and each
 * command's exit status, not that every approved test ran.
 *
 * What counts as a test is the declaration plus a fixed list of supported conventions, never a
 * reading of what code does. Protected: every path TEST_GUARD_PATHS covers; a runner configuration
 * by its file name; a new file laid out as a test by a supported runner's default discovery
 * (contract.mjs TEST_CONVENTIONS); runner configuration inside package.json, pyproject.toml or
 * setup.cfg, read for that fact alone; and a configuration the frozen test command's runner would
 * find by searching — vitest's vite.config.* where it has no --config and no vitest.config.*. Setup refuses a tracked file of any of those kinds the
 * declaration leaves uncovered. A test outside both the declaration and the conventions — a runner
 * configured to collect other names, test code in a production module — is not seen here.
 *
 *   usage:  node scripts/test-guard.mjs check --repo <dir> [--checks <file>]
 *           node scripts/test-guard.mjs setup --controller <dir> --key <KEY> --repo-id <id>
 *                --checks <file> --base <commit> --test <commit> [--subject <line>] [--run-root <dir>]
 *           node scripts/test-guard.mjs engineer-clone --state <run> --into <dir> [--sync <command>] [--hub <dir>]
 *           node scripts/test-guard.mjs preflight --state <run> [--hub <dir>]
 *           node scripts/test-guard.mjs dispatch --state <run> [--session <id>]
 *           node scripts/test-guard.mjs finalize --state <run>
 *           node scripts/test-guard.mjs hand-in --state <run> --round <n>
 *           node scripts/test-guard.mjs verdict --state <run> --round <n> --candidate <commit>
 *                --tree <tree> --verdict APPROVED|CHANGES_REQUESTED
 *           node scripts/test-guard.mjs summary --state <run> [--pr-line]
 *           node scripts/test-guard.mjs cleanup --state <run> [--keep-engineer] [--controller <dir>]
 *
 *   check           the declaration, and that the secret scan is a command, against a checkout's
 *                   HEAD, for /add-repo, the spoke install and /dev-sprint before anyone is
 *                   dispatched. --checks names the file (default <repo>/checks.env).
 *   setup           after test-review reads APPROVED. --checks is the output of
 *                   `read-spoke.mjs <id> <checks path>`, saved as printed; --base the trunk commit
 *                   the branch was cut from; --test the approved test commit, the controller's HEAD.
 *                   A changed approved test commit after a test dispute is a fresh run: clean this
 *                   one up with --keep-engineer and set up again.
 *                   One pull-request comment (/dev-sprint step 10b) is a run of its own on the
 *                   branch's tip H: --base H, and --test the comment's approved test commit on H,
 *                   or H itself for a comment no test can see. --subject is that run's fix commit's
 *                   first line, `fix(<KEY>): resolve <ref> — <title>`, on one line, <ref> the
 *                   comment's SHL-R<n>, or PRIME-C<n> for a Prime Security finding. A group of
 *                   Prime findings is one run and one commit: <ref> is each PRIME-C<n> of the
 *                   group, joined by ", ".
 *                   The empty range --test = --base is allowed only with --subject; nothing before
 *                   --base is read, so earlier fix commits and a person's commits are not judged.
 *   engineer-clone  the engineer's checkout, cut from the baseline; --sync is /dev-sprint's config
 *                   sync, run with the clone's path. The preflight runs straight after.
 *   preflight       proves the hub's engineer definition (--hub, default the current folder) again
 *                   and prints the dispatch line. Exit 2 names every problem: do not dispatch. The
 *                   hub is the folder the Claude Code session started in, never a hub worktree.
 *   dispatch        binds the Claude Code engineer subagent about to start to this run and its
 *                   clone, from the orchestrator's session (CLAUDE_CODE_SESSION_ID), and prints the
 *                   prompt it starts with. Refused once an engineer has claimed the run.
 *   finalize        one engineer round; the candidate's first line is the run's --subject, if
 *                   it has one. Exit 0 sends the candidate to the critic; exit 1 is a
 *                   machine-detected CHANGES_REQUESTED (nothing to review, the guard's hooks
 *                   tampered with, a check red) and nothing is imported. A protected change alone
 *                   never fails a round: it is undone.
 *   hand-in         what the critic is given: the exact commit, tree, delta, diff, what was undone,
 *                   and the check results.
 *   verdict         the critic's verdict for a finalized round; APPROVED is the acceptance.
 *   summary         the compact tampering summary, the one line the pull request carries.
 *   cleanup         removes the refs, worktrees, run directory — state, manifest, event log,
 *                   quarantine, round records, logs — and, unless --keep-engineer, the engineer
 *                   clone; retires the run's engineer in the hub; prints the summary line first.
 *                   Safe to run twice, and after a failure.
 *
 * The contract (checks.env): TEST_GUARD_PATHS — grammar and states in test-guard/contract.mjs and
 * the commented spoke template; the test command's integrity rule in test-guard/baseline.mjs.
 * TEST_WRITABLE_PATHS is retired, and refused when set.
 *
 * Exit codes, shared with every check in the library:
 *   0 pass  1 verified and failed, every finding listed  2 cannot verify  3 usage  4 internal
 *
 * Node standard library only, plus git via child_process.
 */

import { realpathSync, writeSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { EXIT, GuardError, usageError } from './test-guard/common.mjs';
import { cmdCheck, cmdSetup } from './test-guard/cmd-setup.mjs';
import { cmdDispatch, cmdEngineerClone, cmdPreflight } from './test-guard/cmd-engineer.mjs';
import { cmdFinalize } from './test-guard/cmd-finalize.mjs';
import { cmdHandIn, cmdVerdict } from './test-guard/cmd-review.mjs';
import { cmdCleanup, cmdSummary } from './test-guard/cmd-run.mjs';

export { matchPattern, parseChecksEnv, isRunnerConfig, makePolicy, testConvention, embeddedRunnerConfig } from './test-guard/contract.mjs';

const COMMANDS = {
  check: cmdCheck, setup: cmdSetup, 'engineer-clone': cmdEngineerClone, preflight: cmdPreflight, dispatch: cmdDispatch,
  finalize: cmdFinalize, 'hand-in': cmdHandIn, verdict: cmdVerdict, summary: cmdSummary, cleanup: cmdCleanup,
};
// The options each command takes; any other is refused, never ignored.
const OPTIONS = {
  check: ['repo', 'checks'], setup: ['controller', 'key', 'repo-id', 'checks', 'base', 'test', 'subject', 'run-root'],
  'engineer-clone': ['state', 'into', 'sync', 'hub'], preflight: ['state', 'hub'], dispatch: ['state', 'session'],
  finalize: ['state'], 'hand-in': ['state', 'round'], verdict: ['state', 'round', 'candidate', 'tree', 'verdict'],
  summary: ['state', 'pr-line'], cleanup: ['state', 'keep-engineer', 'controller'],
};
const FLAGS = new Set(['keep-engineer', 'pr-line']);

function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!COMMANDS[command]) throw usageError(`ask one thing: ${Object.keys(COMMANDS).join(', ')}`);
  const o = {};
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i];
    if (!a.startsWith('--')) throw usageError(`unexpected argument "${a}"`);
    const name = a.slice(2);
    if (!OPTIONS[command].includes(name)) throw usageError(`${command} takes no ${a}; it takes ${OPTIONS[command].map((x) => `--${x}`).join(', ')}`);
    if (FLAGS.has(name)) { o[name] = true; continue; }
    if (rest[i + 1] === undefined) throw usageError(`${a} needs a value`);
    o[name] = rest[i + 1];
    i += 1;
  }
  return { command, o };
}

const invoked = (() => { try { return realpathSync(process.argv[1] || '') === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })();
if (invoked) {
  // The last line of an exit 2, 3 or 4 names this script and its code, so a shell line that hides
  // the code, with a pipe or `; echo`, still tells the harness's failure record. Written at once,
  // so a process.exit() never loses it.
  process.on('exit', (code) => { if (code >= 2 && code <= 4) { try { writeSync(2, `HARNESS EXIT: test-guard ${code}\n`); } catch { /* stderr is closed */ } } });
  try {
    const { command, o } = parseArgs(process.argv.slice(2));
    process.exit(COMMANDS[command](o));
  } catch (err) {
    if (err instanceof GuardError) {
      process.stderr.write(`${err.exit === EXIT.USAGE ? 'USAGE' : err.exit === EXIT.CANNOT_VERIFY ? 'CANNOT VERIFY' : 'FAIL'}: ${err.message}\n`);
      // This line, just before the exit line, names the cause as a token of REASONS in scripts/spoke-remote.mjs, which the
      // guard does not import. `make reasons` proves the tokens.
      if (err.exit === EXIT.CANNOT_VERIFY && err.reason) process.stderr.write(`REASON: ${err.reason}\n`);
      process.exit(err.exit);
    }
    process.stderr.write(`INTERNAL: ${err && err.stack ? err.stack : String(err)}\n`);
    process.exit(EXIT.INTERNAL);
  }
}

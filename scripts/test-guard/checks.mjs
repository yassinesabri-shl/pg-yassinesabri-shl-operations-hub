/**
 * checks.mjs — the repository's own commands, frozen at setup, run once on the candidate tree in
 * the finalizer's own checkout, and the candidate commit made only when they pass: the finalizer
 * commits through harness-commit.mjs with check-staged.mjs's candidate rows, so the commands are
 * judged by the one implementation every harness commit meets. Every new path the declaration
 * covers was taken out of the candidate, so a test the engineer wrote there never runs here: one
 * run is the approved suite against the engineer's code. A test file outside the declaration that
 * no supported runner convention names is a gap in it, read as production code; the critic names it.
 *
 * Before the first command and after every command, failed or not, the protected locations and
 * every runner configuration on disk — tracked, untracked, ignored, linked, case-aliased — are
 * checked, runner configuration added to a mixed file included: approved files put back, anything
 * the candidate does not hold quarantined, before the command's tree is judged, each event
 * recorded against the candidate tree. Ignored build output that only a runner's test convention
 * makes a test (scan.mjs) is moved aside the same way but fails nothing: it is noted, because a
 * test command that runs tests from build output then runs none of them.
 *
 * What this proves is the protected tree and each command's exit status, not that every approved
 * test ran: a runner that collects fewer tests than the approved commit holds, and still exits 0,
 * is not caught here. The critic reads the suite's log for that.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CANDIDATE_ROWS } from '../check-staged.mjs';
import { HarnessCommitError, harnessCommit } from '../harness-commit.mjs';
import { cannot } from './common.mjs';
import { gitEnv, lsTree, revParse } from './git.mjs';
import { removeUnauthorized, repairApproved, repairHosts } from './scan.mjs';
import { hostsIn } from './contract.mjs';
import { recordEvents } from './state.mjs';

export const notConfigured = (v) => v === undefined || v === null || v === '' || v === 'UNRESOLVED';

const WHAT = {
  deleted: 'deleted on disk — restored from the approved commit',
  edited: 'changed on disk — restored from the approved commit',
  mode: 'mode changed on disk — restored',
  replaced: 'replaced on disk — restored',
  folder: 'a folder above approved tests was replaced on disk — rebuilt',
  removed: 'not part of the candidate (untracked, ignored or generated) — quarantined',
  configured: 'runner configuration added on disk — put back to the candidate',
};

// A runner prints its summary at the end; eight lines hold one in full (node --test's is eight)
// without naming a runner. The last line alone may be a duration, which proves no test ran.
const EVIDENCE_LINES = 8;

function logLines(file) {
  try { return readFileSync(file, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean); } catch { return []; }
}

function evidence(file) {
  const lines = logLines(file);
  return { last: lines[lines.length - 1] || '', tail: lines.slice(-EVIDENCE_LINES).map((l) => (l.length > 200 ? `${l.slice(0, 200)}…` : l)).join(' · ') };
}

/** One row as the round records it: its output written to the round's logs, never kept in the record. */
function logged({ output, stdout, ...row }, logDir) {
  if (output === undefined) return row;
  const log = join(logDir, `${row.key}.log`);
  writeFileSync(log, output);
  const stdoutFile = stdout === undefined ? null : join(logDir, `${row.key}.stdout`);
  if (stdoutFile) writeFileSync(stdoutFile, stdout);
  return { ...row, log, ...evidence(stdoutFile || log) };
}

/**
 * The frozen checks in the finalizer's checkout `wt`, the candidate `tree` staged on the approved
 * test commit, and the commit made through harness-commit.mjs when they pass. Pushes failures into
 * `findings`; returns { commit, rows }, commit null when none was made.
 */
export function runChecks({ state, dir, round, logDir, wt, raw, tree, policy, findings, notes, fileMode }) {
  const ctl = state.controller.path;
  const base = state.baseline.sha;
  const approved = [...policy.approved.values()];
  const entries = lsTree(ctl, tree);
  const kept = new Set(entries.map((e) => e.path));
  const clean = hostsIn(entries, policy.approved);
  const quarantine = join(dir, 'quarantine', `round-${round}`);
  const what = (c) => {
    if (c.kind !== 'removed') return WHAT[c.kind];
    if (/\.snap$/i.test(c.path)) return `${WHAT.removed}: a snapshot a command wrote, so an approved test has none committed and its snapshot assertion compared nothing — a test-change request for the test writer, and a runner run with --ci fails on a missing snapshot instead of writing it`;
    return policy.conventionOnly(c.path) ? `${WHAT.removed}; if a command builds it, the repository should ignore its folder (.gitignore), and it is then moved aside as build output without failing the round` : WHAT.removed;
  };
  const guard = (when) => {
    const changes = [...repairApproved(wt, approved, { blobs: ctl, quarantine, acceptClean: true, fileMode }), ...removeUnauthorized(wt, policy, { kept, quarantine }),
      ...repairHosts(wt, policy, { clean, blobs: ctl, quarantine })];
    recordEvents(dir, changes.map((c) => ({ phase: 'validate', tree, round, when, kind: c.kind, path: c.path })));
    const generated = changes.filter((c) => c.kind === 'generated').map((c) => c.path);
    if (generated.length) {
      notes.push(`${when}: ${generated.length} ignored build output file(s) laid out as tests moved aside before the next command, so no runner collects them — ${generated.slice(0, 10).join(', ')}${generated.length > 10 ? ', …' : ''}; a test command that runs tests from build output ran none of these`);
    }
    findings.integrity.push(...changes.filter((c) => c.kind !== 'cleared' && c.kind !== 'generated').map((c) => `${when}: ${c.path} — ${what(c)}`));
  };
  const between = (key) => {
    guard(`after ${key}`);
    if (revParse(wt, 'HEAD') !== base) findings.integrity.push(`${key} moved the finalizer checkout's HEAD away from the approved test commit`);
  };
  guard('before the first command');
  let checks = null;
  let commit = null;
  try {
    commit = harnessCommit({
      repo: wt,
      paragraphs: [
        state.subject ?? `feat(${state.key}): the engineer's implementation, round ${round}`,
        `Built by the protected-test guard from the engineer's HEAD ${raw} on the approved tests ${base}: approved tests as approved, refused paths left out.`,
      ],
      // The coverage command is told what changed: from the trunk commit the branch was cut from to
      // the candidate's tree, which is committed only once every row passes.
      checks: { rows: CANDIDATE_ROWS, frozen: { blob: state.checks.blob }, env: gitEnv({ HARNESS_TEST_GUARD: '1' }), between, coverage: { base: state.baseline.base, head: tree } },
      onChecks: (report, r) => { checks = r; },
    });
  } catch (err) {
    if (!(err instanceof HarnessCommitError)) throw err;
    if (err.checks) checks = err.checks;
    if (err.code === 2) {
      if (checks) checks.rows.forEach((r) => logged(r, logDir));
      const left = findings.integrity.length ? `\nWhat the commands left was undone and recorded first: ${findings.integrity.join('; ')}` : '';
      throw cannot(`the frozen commands cannot judge the candidate — ${err.message}${left}`, err.reason || null);
    }
    if (err.code !== 1 || !checks) throw err;
    if (!err.checks) findings.checks.push(`the checks passed and git refused the candidate commit (a hook of the repository's): ${err.message.replace(/\s*\n\s*/g, ' ')}`);
  }
  const rows = checks.rows.map((r) => logged(r, logDir));
  for (const r of rows) {
    if (r.notes) notes.push(...r.notes);
    if (r.result === 'fail') findings.checks.push(`${r.name}: ${r.key} "${r.command}" ${r.reason || `exited ${r.exit}`} — ${r.last || 'no output'} (log ${r.log})`);
  }
  return { commit, rows };
}

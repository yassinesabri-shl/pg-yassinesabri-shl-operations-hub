/**
 * cmd-review.mjs — `hand-in` (what the critic is given) and `verdict` (what the critic decided,
 * bound to the exact commit and tree the finalizer checked; on APPROVED, the acceptance).
 *
 * Acceptance refuses, and moves nothing: a round that was never finalized (finalize skipped), one
 * the finalizer failed, a round whose candidate ref is missing or names another commit, a verdict
 * about another commit or tree, and a candidate whose protected content differs from the approved
 * tests. What it re-derives for itself, from the controller's objects: that the candidate ref of
 * the round still names the commit and tree the critic was shown; that the commit is a single
 * commit on the approved test commit; and that its tree holds every approved entry exactly as the
 * baseline does and no path the declaration refuses, by the manifest rebuilt from the baseline and
 * the frozen checks.env (verifyIntegrity). What it takes as trusted input: that the finalizer's
 * checks passed on that commit — the round's record and its candidate ref, which only a passing
 * round gets. Neither the record, the refs nor the run directory resists a process running as the
 * same user; they keep the steps honest with each other, not an attacker out.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EXIT, OID, cannot, out, short, usageError } from './common.mjs';
import { commitInfo, git, gitTry, revParse } from './git.mjs';
import { residue } from './candidate.mjs';
import { loadState, policyOf, refOf, saveState, verifyController, verifyIntegrity } from './state.mjs';

function roundRecord(dir, state, nArg) {
  const n = Number(nArg);
  if (!Number.isInteger(n) || n < 1) throw usageError('--round <n> is required');
  const entry = state.rounds.find((r) => r.round === n);
  if (!entry) throw usageError(`round ${n} has not been finalized in this run`);
  let record;
  try { record = JSON.parse(readFileSync(join(dir, entry.record), 'utf8')); } catch (err) { throw cannot(`the record of round ${n} cannot be read (${err.message})`, 'guard-state-invalid'); }
  if (record.candidate !== entry.candidate || record.tree !== entry.tree || record.result !== entry.result) throw cannot(`the record of round ${n} and the run state disagree about its candidate; something other than the guard changed the run directory — escalate`, 'guard-state-invalid');
  return { entry, record };
}

/** Why the round's candidate cannot be accepted, from the controller's objects; empty when it can. */
function candidateProblems(state, manifest, n, candidate, tree) {
  const ctl = state.controller.path;
  const problems = [];
  const ref = refOf(state, `candidate-${n}`);
  const now = revParse(ctl, ref);
  if (now !== candidate) return [`${ref} resolves to ${now || 'nothing'}, not ${candidate}: only a round the finalizer passed has a candidate ref, and it must still name the commit the critic reviewed`];
  if (revParse(ctl, `${candidate}^{tree}`) !== tree) problems.push(`${candidate} does not have the tree ${tree} the critic reviewed`);
  const c = commitInfo(ctl, candidate);
  if (c.parents.length !== 1 || c.parents[0] !== state.baseline.sha) problems.push(`${candidate} is not a single commit on the approved test commit ${short(state.baseline.sha)}`);
  const left = residue(ctl, candidate, policyOf(state, manifest));
  if (left.length) problems.push(`${candidate} does not hold the approved tests as approved, or holds a refused path: ${left.join(', ')}`);
  return problems;
}

export function cmdHandIn(o) {
  const { dir, state } = loadState(o.state);
  const { entry, record } = roundRecord(dir, state, o.round);
  if (entry.result !== 'pass') throw usageError(`round ${entry.round} failed the finalizer; a critic is never dispatched on it`);
  verifyController(state);
  const ctl = state.controller.path;
  if (revParse(ctl, record.candidate_ref) !== record.candidate) throw cannot(`${record.candidate_ref} no longer resolves to ${record.candidate}`, 'guard-state-invalid');
  const from = record.delta_from;
  const what = from === record.baseline ? 'the approved test commit' : `the candidate the critic reviewed in round ${state.rounds.find((r) => r.candidate === from)?.round ?? '?'}`;
  out(`## Finalized candidate — ${state.key}, round ${entry.round}`);
  out('');
  out(`Candidate: ${record.candidate} — one commit the finalizer built on the approved test commit from the engineer's HEAD`);
  out(`Tree: ${record.tree}`);
  out(`Engineer HEAD: ${record.raw}`);
  out(`Baseline: ${record.baseline} — the approved test commit`);
  out(`Delta from: ${from} — ${what}`);
  out(`Candidate ref: ${record.candidate_ref}`);
  out(`Protected tests: identical to the approved manifest (${state.guard.patterns.join(', ')})`);
  if (record.undone.length) {
    out(`Undone by the finalizer in this round (${record.undone.length}) — the engineer changed approved or protected paths, and the candidate does not carry it:`);
    for (const u of record.undone) out(`  ${u.path} — ${u.kind}`);
  }
  out('');
  out('Checks — run by the finalizer, in its own checkout at the candidate, from the commands frozen at setup:');
  out('');
  out('| Check | Command as run | Exit | Result | Evidence (last lines of the log, joined by ·) |');
  out('|---|---|---|---|---|');
  for (const r of record.checks || []) out(`| ${r.name} | ${(r.command ?? '—').replace(/\|/g, '\\|')} | ${r.exit ?? '—'} | ${r.result} | ${([r.reason, r.record].filter(Boolean).join(' · ') || r.tail || r.last || '').replace(/\|/g, '\\|')} |`);
  out('');
  for (const nt of record.notes) out(`Note: ${nt}`);
  out('');
  out(`--- diff ${short(from)}..${short(record.candidate)} ---`);
  process.stdout.write(git(ctl, ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '--stat', '--patch', from, record.candidate]));
  out('--- end of diff ---');
  out(`Record the verdict with: verdict --round ${entry.round} --candidate ${record.candidate} --tree ${record.tree} --verdict <APPROVED | CHANGES_REQUESTED>`);
  return EXIT.PASS;
}

export function cmdVerdict(o) {
  const { dir, state, manifest } = loadState(o.state);
  const verdict = o.verdict;
  if (!['APPROVED', 'CHANGES_REQUESTED'].includes(verdict)) throw usageError('--verdict is APPROVED or CHANGES_REQUESTED, the loop\'s two tokens');
  if (!o.candidate || !OID.test(o.candidate)) throw usageError('--candidate <commit> is required: the commit the critic was shown');
  if (!o.tree || !OID.test(o.tree)) throw usageError('--tree <tree hash> is required: the tree the critic was shown');
  if (state.accepted) throw usageError(`round ${state.accepted.round} was already accepted`);
  const { entry, record } = roundRecord(dir, state, o.round);
  if (entry.result !== 'pass') throw usageError(`round ${entry.round} failed the finalizer; its verdict is the finalizer's, not a critic's`);
  if (entry.verdict) throw usageError(`round ${entry.round} already carries the verdict ${entry.verdict}`);
  if (state.rounds[state.rounds.length - 1].round !== entry.round) throw usageError(`round ${entry.round} is not the latest round`);
  const findings = [];
  if (o.candidate !== record.candidate) findings.push(`the critic's verdict names ${o.candidate}; round ${entry.round} finalized ${record.candidate}`);
  if (o.tree !== record.tree) findings.push(`the critic's verdict names tree ${o.tree}; round ${entry.round} finalized tree ${record.tree}`);
  if (findings.length) { for (const f of findings) out(`FAIL ${f}`); out('VERDICT REFUSED — the verdict is not about the candidate the finalizer checked'); return EXIT.FAIL; }

  if (verdict === 'CHANGES_REQUESTED') {
    entry.verdict = verdict;
    entry.verdict_at = new Date().toISOString();
    saveState(dir, state);
    out(`VERDICT RECORDED round ${entry.round} — CHANGES_REQUESTED; the controller branch is unchanged, and the next round's delta starts from ${short(record.candidate)}`);
    return EXIT.PASS;
  }

  verifyController(state);
  const { manifest: approved } = verifyIntegrity(state, manifest);
  const problems = candidateProblems(state, approved, entry.round, record.candidate, record.tree);
  if (problems.length) {
    for (const f of problems) out(`FAIL ${f}`);
    out('NOT ACCEPTED — the candidate is not the one the finalizer passed and the critic reviewed; nothing was imported');
    return EXIT.FAIL;
  }
  const ctl = state.controller.path;
  const status = git(ctl, ['status', '--porcelain=v1', '--untracked-files=all']);
  if (status.trim()) { out(`FAIL the controller checkout is not clean:\n${status.trimEnd()}`); out('NOT ACCEPTED — the controller must be clean to fast-forward'); return EXIT.FAIL; }
  if (revParse(ctl, 'HEAD') !== state.controller.tip) throw cannot(`the controller's HEAD is not ${state.controller.tip}`, 'guard-state-invalid');
  const ff = gitTry(ctl, ['merge', '--ff-only', '--quiet', record.candidate]);
  if (ff.status !== 0 || revParse(ctl, 'HEAD') !== record.candidate) {
    out(`FAIL the fast-forward of ${state.controller.branch} to ${record.candidate} failed: ${(ff.stderr || ff.stdout).trim().split('\n')[0]}`);
    out('NOT ACCEPTED — nothing was imported');
    return EXIT.FAIL;
  }
  entry.verdict = verdict;
  entry.verdict_at = new Date().toISOString();
  state.controller.tip = record.candidate;
  state.accepted = { round: entry.round, candidate: record.candidate, tree: record.tree, at: entry.verdict_at };
  saveState(dir, state);
  out(`ACCEPTED round ${entry.round} — ${state.controller.branch} fast-forwarded to ${record.candidate}, the one commit the finalizer built and the critic reviewed`);
  return EXIT.PASS;
}

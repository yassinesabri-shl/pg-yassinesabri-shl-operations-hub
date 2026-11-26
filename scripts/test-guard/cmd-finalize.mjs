/**
 * cmd-finalize.mjs — `finalize`, the round the engineer hands in.
 *
 * The finalizer takes the engineer's committed HEAD, never the engineer's account of it, and builds
 * one clean candidate tree from it: every approved test as approved, every new path the declaration
 * refuses left out (candidate.mjs). In its own checkout at the approved test commit it stages that
 * tree and commits it through harness-commit.mjs, which runs the repository's frozen commands once
 * and commits only when they pass (checks.mjs). It hands only that commit on, under a candidate ref
 * that exists only for a round that passed. /dev-sprint runs it after
 * every engineer round and before any critic; acceptance (cmd-review.mjs) refuses a round it did
 * not pass. A protected change costs the engineer
 * nothing but the change itself: it is undone and counted, never a reason to refuse the round. The
 * engineer's hooks, index, history, commit messages and configuration are not inputs.
 *
 * No round is finalized unless the Claude Code preflight passed and the engineer dispatched for
 * the run claimed its binding, with no other engineer acting since — so the guard fails closed when
 * hooks are not running. A changed engineer definition fails the round, whether this put it back or
 * the in-agent guard did during the round.
 */

import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { EXIT, cannot, firstLine, out, plural, short, usageError } from './common.mjs';
import { commitInfo, git, gitTry, revParse } from './git.mjs';
import { runSync } from './clone.mjs';
import { buildCandidate, residue } from './candidate.mjs';
import { runChecks } from './checks.mjs';
import { bindingProblems, boundAgent } from './subagent.mjs';
import {
  loadState, policyOf, readEvents, recordEvents, refOf, repairHooks, saveState, verifyController, verifyIntegrity, withLock, writeJson,
} from './state.mjs';

function uncommitted(eng) {
  const r = gitTry(eng, ['status', '--porcelain=v1', '--untracked-files=all']);
  if (r.status !== 0) throw cannot(`cannot read the engineer clone's status: ${firstLine(r.stderr)}`, 'git-failed');
  return r.stdout.trimEnd().split('\n').filter(Boolean);
}

function fetchInto(ctl, from, sha, ref) {
  gitTry(ctl, ['update-ref', '-d', ref]);
  const f = gitTry(ctl, ['-c', 'fetch.fsckObjects=true', 'fetch', '--quiet', '--no-tags', '--no-write-fetch-head', '--no-recurse-submodules', from, `${sha}:${ref}`]);
  if (f.status !== 0) throw cannot(`cannot fetch ${sha} from the engineer clone into ${ref}: ${firstLine(f.stderr)}`, 'fetch-failed');
  if (revParse(ctl, ref) !== sha) throw cannot(`${ref} does not resolve to ${sha} after the fetch`, 'fetch-failed');
}

/** The candidate tree committed through the frozen commands, in a fresh checkout the finalizer makes and removes. */
function validate({ state, dir, n, raw, tree, policy, findings, notes }) {
  const ctl = state.controller.path;
  const logDir = join(dir, 'rounds', String(n));
  mkdirSync(logDir, { recursive: true });
  const fileMode = gitTry(ctl, ['config', '--bool', 'core.fileMode']).stdout.trim() !== 'false';
  const wt = join(dir, 'worktrees', `round-${n}`);
  mkdirSync(dirname(wt), { recursive: true });
  const added = gitTry(ctl, ['worktree', 'add', '--quiet', '--detach', wt, state.baseline.sha]);
  if (added.status !== 0) throw cannot(`cannot make the finalizer checkout at ${state.baseline.sha}: ${firstLine(added.stderr)}`, 'git-failed');
  try {
    const staged = gitTry(wt, ['read-tree', '--reset', '-u', tree]);
    if (staged.status !== 0) throw cannot(`cannot stage the candidate tree ${tree} in the finalizer checkout: ${firstLine(staged.stderr)}`, 'git-failed');
    if (state.sync) {
      const r = runSync(state.sync, wt);
      if (r.status !== 0) throw cannot(`the config sync failed for the finalizer checkout (exit ${r.status}): ${firstLine(r.output)}`, 'git-failed');
    }
    return runChecks({ state, dir, round: n, logDir, wt, raw, tree, policy, findings, notes, fileMode });
  } finally {
    gitTry(ctl, ['worktree', 'remove', '--force', '--force', wt]);
    gitTry(ctl, ['worktree', 'prune']);
    rmSync(wt, { recursive: true, force: true });
  }
}

const KIND = { deleted: 'deleted', edited: 'edited', mode: 'executable bit changed', replaced: 'replaced by another kind of entry', configured: 'runner configuration added to a file the declaration leaves free', removed: 'a new path in a protected location' };

export function cmdFinalize(o) {
  const { dir, state, manifest } = loadState(o.state);
  if (state.accepted) throw usageError(`round ${state.accepted.round} was already accepted; nothing more is finalized in this run`);
  if (!state.engineer || !existsSync(state.engineer.path)) throw cannot('this run has no engineer clone on disk; run engineer-clone first', 'guard-state-invalid');
  const last = state.rounds[state.rounds.length - 1];
  if (last && last.result === 'pass' && !last.verdict) throw usageError(`round ${last.round} passed and waits for the critic's verdict; record it before the next round`);
  verifyController(state);
  const { manifest: approved } = verifyIntegrity(state, manifest);
  if (!state.preflight || !state.preflight.ok) throw cannot(`the Claude Code preflight has not passed for this run, so no hook is known to be watching the engineer: run preflight --state ${dir}, and dispatch the engineer only after it passes`, 'preflight-missing');
  const problems = bindingProblems(dir, state);
  if (problems.length) throw cannot(`the engineer subagent's guard binding does not hold, so nothing is finalized: ${problems.join('; ')}`, 'guard-fault');
  const agent = boundAgent(readEvents(dir), state.binding);
  const policy = policyOf(state, approved);
  const ctl = state.controller.path;
  const n = state.rounds.length + 1;
  const base = state.baseline.sha;
  const reviewed = [...state.rounds].reverse().find((r) => r.verdict === 'CHANGES_REQUESTED');
  const deltaFrom = reviewed ? reviewed.candidate : base;
  const findings = { guard: [], candidate: [], integrity: [], checks: [] };
  const notes = [];

  // The guard's own hook configuration: put back now, and any repair since the last round — by the
  // in-agent guard, or by a finalize that stopped before recording a round — fails this one.
  const since = last ? last.finalized_at : '';
  const hooks = withLock(dir, () => repairHooks(state, dir));
  if (hooks.length) recordEvents(dir, hooks.map((h) => ({ phase: 'finalize', kind: 'guard', path: h.path, round: n })));
  const put = new Set();
  for (const e of readEvents(dir)) {
    if ((e.phase !== 'post' && e.phase !== 'finalize') || e.kind !== 'guard' || !(e.at > since) || put.has(e.path)) continue;
    put.add(e.path);
    findings.guard.push(`${e.path}, the guard's hook configuration, was changed or removed during the round and has been put back${e.phase === 'post' ? ' by the in-agent guard' : ''}. Disabling the guard is not allowed`);
  }

  const dirty = uncommitted(state.engineer.path);
  if (dirty.length) notes.push(`uncommitted changes in the engineer clone are not part of this candidate: ${dirty.slice(0, 10).join('; ')}`);
  const raw = revParse(state.engineer.path, 'HEAD^{commit}');
  if (!raw) throw cannot(`the engineer clone at ${state.engineer.path} has no HEAD commit`, 'git-failed');
  const rawRef = refOf(state, `engineer-${n}`);
  fetchInto(ctl, state.engineer.path, raw, rawRef);

  let built = null;
  if (raw === base) findings.candidate.push('the engineer\'s HEAD is the baseline itself; there is no engineer commit to finalize');
  else {
    built = buildCandidate(ctl, { raw, policy, workdir: dir });
    const left = residue(ctl, built.tree, policy);
    if (left.length) throw cannot(`the candidate still holds ${left.join(', ')}; the guard has a fault — escalate`, 'guard-fault');
    if (built.tree === state.baseline.tree) findings.candidate.push('once the protected changes are undone, the engineer\'s HEAD changes nothing: there is nothing to review');
    else if (reviewed && built.tree === reviewed.tree) findings.candidate.push(`once the protected changes are undone, the engineer's HEAD is the candidate reviewed in round ${reviewed.round}: there is nothing new since`);
  }
  const undone = built ? [...built.restored, ...built.removed.map((path) => ({ path, kind: 'removed' }))] : [];
  const qref = refOf(state, `candidate-${n}`);
  gitTry(ctl, ['update-ref', '-d', qref]);

  let checks = null;
  let candidate = null;
  if (built && !findings.candidate.length) {
    ({ commit: candidate, rows: checks } = validate({ state, dir, n, raw, tree: built.tree, policy, findings, notes }));
    // What git committed is what the checks judged: a hook of the repository's that changed it fails the round.
    if (candidate) {
      const c = commitInfo(ctl, candidate);
      if (revParse(ctl, `${candidate}^{tree}`) !== built.tree || c.parents.length !== 1 || c.parents[0] !== base) {
        findings.integrity.push(`the candidate commit ${short(candidate)} is not the checked tree ${short(built.tree)} on the approved test commit ${short(base)}: something changed it while git committed`);
      }
    }
    verifyController(state);
    notes.push('the finalizer verified the approved tests unchanged and each command\'s exit status, not that every approved test ran');
  } else notes.push('the authoritative checks were not run: the candidate was refused before validation');

  const result = Object.values(findings).some((f) => f.length) ? 'fail' : 'pass';
  // The candidate ref exists only for a round that passed: acceptance requires it.
  if (result === 'pass') git(ctl, ['update-ref', qref, candidate]);
  const categories = Object.entries(findings).filter(([, f]) => f.length).map(([k]) => k);
  const tree = built ? built.tree : null;
  const finalizedAt = new Date().toISOString();
  state.undone = [...new Set([...(state.undone || []), ...undone.map((u) => u.path)])];
  const finalizer = {
    candidate_sha: candidate || raw, raw_sha: raw, tree_sha: tree || revParse(ctl, `${raw}^{tree}`), result,
    restored: undone.filter((u) => u.kind !== 'removed').length, removed: undone.filter((u) => u.kind === 'removed').length,
    failed_checks: (checks || []).filter((r) => r.result === 'fail').map((r) => r.key),
  };
  const record = {
    round: n, run_id: state.run_id, key: state.key, finalized_at: finalizedAt, raw, candidate, tree, baseline: base, delta_from: deltaFrom,
    engineer_ref: rawRef, candidate_ref: result === 'pass' ? qref : null, undone, result, categories, findings, checks, notes,
    engineer: agent, finalizer,
    iteration_record: result === 'pass'
      ? { finalizer, note: 'merge into the critic\'s record for this round, with verdict_source "critic"' }
      : {
        schema_version: 1, emitted_at: finalizedAt, run_id: state.run_id, artefact_id: state.key, artefact_type: 'code', iteration: n - 1,
        quality: 0, signal_source: 'machine', verdict: 'CHANGES_REQUESTED', verdict_source: 'finalizer', finalizer,
      },
  };
  mkdirSync(join(dir, 'rounds'), { recursive: true });
  writeJson(join(dir, 'rounds', `round-${n}.json`), record);
  state.rounds.push({ round: n, raw, candidate, tree, result, categories, delta_from: deltaFrom, undone: undone.length, verdict: null, finalized_at: finalizedAt, record: `rounds/round-${n}.json` });
  saveState(dir, state);

  out(`Round: ${n}`);
  out(`Engineer HEAD: ${raw}`);
  out(`Candidate: ${candidate || 'none'}`);
  if (tree) out(`Tree: ${tree}`);
  if (candidate) out(`Candidate ref: ${result === 'pass' ? qref : 'none — the round failed'}`);
  out(`Delta from: ${deltaFrom}`);
  out(`Engineer: subagent ${agent}`);
  for (const nt of notes) out(`NOTE ${nt}`);
  for (const u of undone) out(`UNDONE ${u.path} — ${KIND[u.kind]}; ${u.kind === 'removed' ? 'taken out of the candidate' : `restored from the approved test commit ${short(base)}`}`);
  for (const [k, list] of Object.entries(findings)) for (const f of list) out(`FAIL [${k}] ${f}`);
  if (checks) for (const r of checks) out(`CHECK ${r.name.padEnd(22)} ${String(r.result).padEnd(14)} ${r.command === 'none' || r.result === 'NOT CONFIGURED' ? '' : `exit ${r.exit} · ${r.record || r.last}`}`.trimEnd());
  const tally = undone.length ? ` · ${plural(undone.length, 'protected change')} undone` : '';
  if (result === 'pass') {
    out(`FINALIZED round ${n} — PASS · candidate ${short(candidate)} · tree ${short(tree)}${tally}; hand it to the critic with: hand-in --round ${n}`);
    return EXIT.PASS;
  }
  out(`FINALIZED round ${n} — FAIL (${categories.join(', ')})${tally} · a machine-detected CHANGES_REQUESTED: nothing imported, the controller branch unchanged`);
  return EXIT.FAIL;
}

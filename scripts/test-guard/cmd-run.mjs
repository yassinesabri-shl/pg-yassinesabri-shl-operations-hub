/**
 * cmd-run.mjs — `summary` and `cleanup`.
 */

import { existsSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { EXIT, RUN_PREFIX, REF_ROOT, out, plural, short, usageError } from './common.mjs';
import { gitTry } from './git.mjs';
import { releaseEngineerClone, removeEngineerClone } from './clone.mjs';
import { boundAgent, retireEntry } from './subagent.mjs';
import { STATE_FILE, loadState, readEvents, summaryLine } from './state.mjs';

export function cmdSummary(o) {
  const { dir, state } = loadState(o.state);
  const line = summaryLine(state, readEvents(dir));
  if (o['pr-line']) { out(line); return EXIT.PASS; }
  out(`${state.key} · run ${state.run_id} · baseline ${short(state.baseline.sha)}`);
  out(`${plural(state.rounds.length, 'round')} finalized`);
  out(state.accepted ? `accepted: round ${state.accepted.round} at ${state.accepted.candidate}` : 'not accepted');
  out(line);
  return EXIT.PASS;
}

/**
 * Removes everything the run made but the summary line it prints, and retires its engineer in the
 * hub's entry for the session. With --keep-engineer the clone stays, unmarked, for inspection.
 * Safe to run twice, and after a failure.
 */
export function cmdCleanup(o) {
  if (!o.state) throw usageError('--state <run directory> is required');
  const dir = resolve(o.state);
  const name = basename(dir);
  if (!name.startsWith(RUN_PREFIX)) throw usageError(`${dir} is not a test-guard run directory (${RUN_PREFIX}…)`);
  const runId = name.slice(RUN_PREFIX.length);
  let state = null;
  try { state = JSON.parse(readFileSync(join(dir, STATE_FILE), 'utf8')); } catch { state = null; }
  const ctl = (state && state.controller && state.controller.path) || (o.controller ? resolve(o.controller) : null);
  const removed = [];
  const events = readEvents(dir);
  if (state && Array.isArray(state.rounds)) out(summaryLine(state, events));
  if (ctl && existsSync(ctl)) {
    const real = existsSync(dir) ? realpathSync(dir) : null;
    for (const wt of gitTry(ctl, ['worktree', 'list', '--porcelain']).stdout.split('\n').filter((l) => l.startsWith('worktree ')).map((l) => l.slice(9))) {
      if (wt === dir || wt.startsWith(`${dir}/`) || (real && wt.startsWith(`${real}/`))) { gitTry(ctl, ['worktree', 'remove', '--force', '--force', wt]); removed.push(`worktree ${wt}`); }
    }
    gitTry(ctl, ['worktree', 'prune']);
    for (const ref of gitTry(ctl, ['for-each-ref', '--format=%(refname)', `${REF_ROOT}/${runId}/`]).stdout.split('\n').filter(Boolean)) {
      gitTry(ctl, ['update-ref', '-d', ref]);
      removed.push(`ref ${ref}`);
    }
  } else if (!ctl) {
    out('NOTE the run state is unreadable and no --controller was given: the temporary refs in the controller were not removed');
  }
  const b = state && state.binding;
  if (b && b.hub) retireEntry(b.hub, b.session, runId, boundAgent(events, b));
  if (state && state.engineer) {
    const run = { ...state, run_id: runId };
    if (o['keep-engineer']) {
      releaseEngineerClone(run);
      out(`NOTE the engineer clone ${state.engineer.path} is kept (--keep-engineer), its marker removed: it holds the work for inspection, nothing of it is carried into another run, and the in-agent guard no longer applies to it`);
    } else {
      const gone = removeEngineerClone(run, (n) => out(`NOTE ${n}`));
      if (gone) removed.push(`engineer clone ${gone}`);
    }
  }
  if (existsSync(dir)) { rmSync(dir, { recursive: true, force: true }); removed.push(`run directory ${dir} (state, manifest, event log, quarantine, round records and logs)`); }
  out(`CLEANED — ${removed.length ? removed.join('; ') : 'nothing was left'}`);
  return EXIT.PASS;
}

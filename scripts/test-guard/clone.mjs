/**
 * clone.mjs — the engineer's checkout: an independent clone of the controller. Its .git/ carries a
 * marker naming the run — a cache for callers that name no run, never the guard's authority.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cannot, firstLine, usageError } from './common.mjs';
import { git, gitEnv, gitTry, revParse } from './git.mjs';
import { removeMarker, writeMarker, readMarker } from './state.mjs';
import { valueState } from '../check-staged.mjs';

const GATE = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function runSync(sync, target) {
  const res = spawnSync('/bin/sh', ['-c', `${sync} "$1"`, 'harness-sync', target], { encoding: 'utf8', env: gitEnv() });
  return { status: res.status, output: `${res.stdout || ''}${res.stderr || ''}`.trim() };
}

/**
 * The frozen INSTALL_COMMAND, run once at the root of a new checkout. The clone holds only tracked
 * files, and the engineer's checks need the dependencies the finalizer's checkout installs too.
 * Returns the note to print; throws on a failure, because an engineer in a clone without its
 * dependencies spends rounds on a fault that is not in the code.
 */
function runInstall(install, target) {
  const v = valueState(install === null ? undefined : install);
  if (v.state === 'none') return `INSTALL_COMMAND is none${v.reason ? ` — ${v.reason}` : ''}: no dependencies installed`;
  if (v.state !== 'command') throw cannot(`INSTALL_COMMAND in the frozen checks.env is ${install === null ? 'missing' : `"${install}"`}, not a command or "none"`, 'config-invalid');
  const res = spawnSync('/bin/sh', ['-c', `exec 2>&1\n${v.command}`], { cwd: target, encoding: 'utf8', env: gitEnv(), stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
  if (res.error || res.status !== 0) {
    const said = `${res.stdout || ''}${res.stderr || ''}`.trim().split('\n').slice(-5).join(' · ');
    throw cannot(`INSTALL_COMMAND "${v.command}" failed in the engineer clone (${res.error ? res.error.message : res.signal ? `stopped by ${res.signal}` : `exit ${res.status}`})${said ? `: ${said}` : ''}; the clone is removed`, 'tool-missing');
  }
  return `INSTALL_COMMAND "${v.command}" ran in the engineer clone`;
}

/** A fresh `git clone --no-local` of the controller at `start`, with no way back to it configured. */
export function makeEngineerClone(state, dir, into, start, sync, install) {
  const target = resolve(into);
  const ctl = state.controller.path;
  if (existsSync(target)) throw usageError(`${target} already exists; an engineer clone is cut fresh, never reused`);
  const rel = relative(ctl, target);
  if (!rel.startsWith('..') && rel !== target) throw usageError(`${target} is inside the controller checkout; the engineer clone sits beside it`);
  // Beside means in the controller's own folder, .worktrees/<KEY>/. A path written from the hub
  // root and run from .worktrees/<KEY>/hub lands inside the hub checkout, and the run keeps it.
  const beside = dirname(realpathSync(ctl));
  const parent = existsSync(dirname(target)) ? realpathSync(dirname(target)) : null;
  if (parent !== beside) throw usageError(`${target} is not beside the controller ${ctl}. The engineer clone must be in ${beside}, for example ${join(beside, `${basename(ctl)}.engineer`)}. From .worktrees/<KEY>/hub, that path is ../${basename(ctl)}.engineer. Nothing was created`);
  mkdirSync(dirname(target), { recursive: true });
  const clone = gitTry(dirname(target), ['clone', '--quiet', '--no-local', '--no-checkout', '--single-branch', '--branch', state.controller.branch, ctl, target]);
  if (clone.status !== 0) throw cannot(`git clone --no-local of ${ctl} failed: ${firstLine(clone.stderr)}`, 'git-failed');
  try {
    if (existsSync(join(target, '.git', 'objects', 'info', 'alternates'))) throw cannot(`${target} borrows objects through alternates; the engineer clone owns its objects`, 'guard-state-invalid');
    if (!revParse(target, `${start}^{commit}`)) {
      const f = gitTry(target, ['fetch', '--quiet', '--no-tags', ctl, start]);
      if (f.status !== 0) throw cannot(`cannot fetch ${start} into the engineer clone: ${firstLine(f.stderr)}`, 'fetch-failed');
    }
    git(target, ['checkout', '--quiet', '-B', state.controller.branch, start]);
    git(target, ['remote', 'remove', 'origin']);
    writeMarker(target, state, dir);
    if (sync) {
      const r = runSync(sync, target);
      if (r.status !== 0) throw cannot(`the config sync failed for the engineer clone (exit ${r.status}): ${firstLine(r.output)}; the clone is removed, as /dev-sprint removes a half-configured code checkout`, 'git-failed');
    }
    // After the sync, which may write the configuration an install reads (.npmrc, a registry token).
    const installNote = runInstall(install, target);
    const hook = join(GATE, 'harness-commit.mjs');
    let hookNote = 'no local watermark hook: harness-commit.mjs is not beside this script (the finalizer checks every commit regardless)';
    if (existsSync(hook)) {
      const h = spawnSync(process.execPath, [hook, '--install-hook', target], { encoding: 'utf8' });
      hookNote = h.status === 0 ? 'the watermark commit-msg hook installed (early feedback only; the finalizer is the authority)' : `the watermark hook did not install (${firstLine(h.stderr)}); the finalizer checks every commit regardless`;
    }
    return { path: target, start, hookNote, installNote };
  } catch (err) {
    rmSync(target, { recursive: true, force: true });
    throw err;
  }
}

const ownedBy = (path, state) => { try { return readMarker(path).run_id === state.run_id; } catch { return false; } };

/** Removes the run's engineer clone; leaves anything this run did not make, and says so. */
export function removeEngineerClone(state, say = () => {}) {
  const path = state.engineer && state.engineer.path;
  if (!path || !existsSync(path)) return null;
  const ctl = state.controller.path;
  if (!ownedBy(path, state) || resolve(path) === resolve(ctl) || !relative(path, ctl).startsWith('..')) {
    say(`${path} was left in place: it is not an engineer clone this run made`);
    return null;
  }
  rmSync(path, { recursive: true, force: true });
  return path;
}

/** Keeps the clone but unmarks it, so the in-agent guard stops applying once the run is gone. */
export function releaseEngineerClone(state) {
  const path = state.engineer && state.engineer.path;
  if (path && existsSync(path) && ownedBy(path, state)) removeMarker(path);
}

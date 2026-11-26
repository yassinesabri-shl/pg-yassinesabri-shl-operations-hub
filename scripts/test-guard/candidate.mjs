/**
 * candidate.mjs — the one clean tree a round hands on: the engineer's HEAD tree, read from its
 * objects in the controller, with every approved entry put back to the approved test commit and
 * every new path the declaration refuses taken out — a test the engineer added included — and runner
 * configuration added to a mixed file undone. The finalizer commits it on the approved test commit
 * through harness-commit.mjs (checks.mjs). The engineer's commits, their authors, dates, messages and
 * hooks are never part of it.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { git, lsTree, readBlob } from './git.mjs';
import { embeddedRunnerConfig, isRunnerHost } from './contract.mjs';

function kindOf(approved, current) {
  if (!current) return 'deleted';
  if (approved.type !== current.type || (approved.mode === '120000') !== (current.mode === '120000')) return 'replaced';
  if (approved.oid === current.oid) return 'mode';
  return 'edited';
}

/**
 * One tree's entries, cleaned: { entries, restored: [{ path, kind }], removed: [path] }. A mixed file
 * outside the manifest that carries runner configuration (read from `ctl`'s objects) goes back to its
 * version at the approved test commit — kind `configured` — or is left out when it had none.
 */
function cleanEntries(entries, policy, ctl) {
  const map = new Map(entries.map((e) => [e.path, e]));
  const restored = [];
  const removed = [];
  for (const e of policy.approved.values()) {
    const current = map.get(e.path);
    if (current && current.mode === e.mode && current.oid === e.oid) continue;
    restored.push({ path: e.path, kind: kindOf(e, current) });
    map.set(e.path, { ...e, raw: Buffer.from(e.path) });
  }
  for (const path of [...map.keys()]) {
    if (policy.approved.has(path)) continue;
    if (policy.classify(path) === 'protected' || policy.collides(path)) { map.delete(path); removed.push(path); }
  }
  for (const [path, e] of [...map]) {
    if (policy.approved.has(path) || e.type !== 'blob' || !isRunnerHost(path)) continue;
    const clean = policy.hosts.get(path);
    if (clean && clean.oid === e.oid && clean.mode === e.mode) continue;
    if (!embeddedRunnerConfig(path, readBlob(ctl, e.oid)).length) continue;
    if (clean) { map.set(path, { ...clean, raw: Buffer.from(path) }); restored.push({ path, kind: 'configured' }); } else { map.delete(path); removed.push(path); }
  }
  return { entries: [...map.values()], restored, removed };
}

function writeTree(ctl, entries, index) {
  const env = { GIT_INDEX_FILE: index };
  git(ctl, ['read-tree', '--empty'], { env });
  const input = Buffer.concat(entries.map((e) => Buffer.concat([Buffer.from(`${e.mode} ${e.oid}\t`), e.raw || Buffer.from(e.path), Buffer.from([0])])));
  git(ctl, ['update-index', '-z', '--index-info'], { env, input });
  return git(ctl, ['write-tree'], { env }).trim();
}

/**
 * The candidate tree for the engineer's HEAD `raw`, already fetched into the controller. Returns
 * { tree, restored, removed }.
 */
export function buildCandidate(ctl, { raw, policy, workdir }) {
  const { entries, restored, removed } = cleanEntries(lsTree(ctl, raw), policy, ctl);
  const scratch = mkdtempSync(join(workdir, 'candidate-'));
  try {
    return { tree: writeTree(ctl, entries, join(scratch, 'index')), restored, removed };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** What a tree or commit still holds that it must not — an approved entry changed, a refused path present: empty for a clean candidate. */
export function residue(ctl, commit, policy) {
  const { restored, removed } = cleanEntries(lsTree(ctl, commit), policy, ctl);
  return [...restored.map((r) => `${r.path} (${r.kind})`), ...removed];
}

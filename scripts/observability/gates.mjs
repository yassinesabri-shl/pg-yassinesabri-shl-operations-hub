// Part of the harness asset library c6f3b4427d58f7c3 (see VERSION.json) · 2026-10-30
/**
 * gates.mjs — the human gates: which file each one merges, which command follows it, and when one
 * merged on the hub's trunk.
 *
 * The gates, where each one merges, and its key:
 *   requirements-merge    docs/requirements/<SLUG>/requirements.md, on the hub's trunk   feature
 *   decomposition-merge   docs/backlog/<SLUG>/, on the hub's trunk                        feature
 *   design-merge          docs/designs/<KEY>.lld.md, on the hub's trunk                    story
 *   validation-merge      docs/designs/<KEY>.validation.md, on the hub's trunk             story
 *   story-merge           the trunk of the spoke that the design names                     story
 *
 * A GitHub workflow writes the record of each merge (observability-gate.mjs). This module gives it
 * the gate of a changed file. It also gives the sender, on the laptop, the last merge of a hub gate
 * before a run started, for the run's pickup, and the merges inside a run, for the part of its
 * waits that a gate counts.
 *
 * On the hub's trunk, a merge is a commit on the first-parent line that brings or changes the gate's
 * file. Its committer time is the merge time, for a merge commit and for a squash merge alike, and
 * it is the pull request's `merged_at` on GitHub. The trunk is read as this clone last fetched it,
 * as lookups.mjs reads it. This module never fetches, and it never reads a spoke.
 *
 * Node standard library only, plus git.
 */
import { spawnSync } from 'node:child_process';
import { isKey, isSlug } from './common.mjs';
import { trunkRef } from './lookups.mjs';

/**
 * The role that a gate's merge goes to, where the library names one: /feature names the feature
 * owner as the one who merges the requirements pull request.
 */
export const ROUTED_TO = Object.freeze({ 'requirements-merge': 'feature-owner' });
// UNRESOLVED — the roles that merge the decomposition, design, story and validation pull requests.
// Owner: harness lead. Resolves: the commands that open those pull requests name the role.

/**
 * The gate that each command follows, and the key of that gate. The pickup of a run is the time
 * from that gate's last merge to the run's start. Every other command follows no gate: the
 * validation merge is followed by the code merge, and the code merge only by the closing /qa-sprint.
 */
export const PREVIOUS_GATE = Object.freeze({
  decompose: { gate: 'requirements-merge', key: 'feature' },
  'dev-spec': { gate: 'decomposition-merge', key: 'feature' },
  'dev-sprint': { gate: 'design-merge', key: 'story' },
});

/** The file or folder that a hub gate merges, for its key. Null for a gate that merges in a spoke, or a key of the wrong kind. */
export function gatePath(gate, { story = null, feature = null } = {}) {
  if (gate === 'requirements-merge' && isSlug(feature)) return `docs/requirements/${feature}/requirements.md`;
  if (gate === 'decomposition-merge' && isSlug(feature)) return `docs/backlog/${feature}/`;
  if (gate === 'design-merge' && isKey(story)) return `docs/designs/${story}.lld.md`;
  if (gate === 'validation-merge' && isKey(story)) return `docs/designs/${story}.validation.md`;
  return null;
}

/** The hub gates of a key, in the order a story or a feature meets them. */
export function hubGatesOf({ story = null, feature = null } = {}) {
  if (isKey(story)) return ['design-merge', 'validation-merge'];
  if (isSlug(feature)) return ['requirements-merge', 'decomposition-merge'];
  return [];
}

const REQUIREMENTS = /^docs\/requirements\/([a-z0-9]+(?:-[a-z0-9]+)*)\/requirements\.md$/;
const BACKLOG = /^docs\/backlog\/([a-z0-9]+(?:-[a-z0-9]+)*)\/[^/]+$/;
const DESIGN = /^docs\/designs\/([A-Z][A-Z0-9]{1,9}-\d+)\.lld\.md$/;
const VALIDATION = /^docs\/designs\/([A-Z][A-Z0-9]{1,9}-\d+)\.validation\.md$/;

/**
 * The hub gate that one changed file belongs to, with its key: { gate, story } or { gate, feature },
 * or null. `docs/backlog/jira/` holds the snapshots of /from-ticket, which is no decomposition.
 */
export function gateOfPath(path) {
  if (typeof path !== 'string') return null;
  let m = path.match(REQUIREMENTS);
  if (m && isSlug(m[1])) return { gate: 'requirements-merge', feature: m[1] };
  m = path.match(BACKLOG);
  if (m && isSlug(m[1]) && m[1] !== 'jira') return { gate: 'decomposition-merge', feature: m[1] };
  m = path.match(DESIGN);
  if (m && isKey(m[1])) return { gate: 'design-merge', story: m[1] };
  m = path.match(VALIDATION);
  if (m && isKey(m[1])) return { gate: 'validation-merge', story: m[1] };
  return null;
}

/** Every hub gate that a pull request's changed files merge, once each, in the order of first appearance. */
export function gatesOfPaths(paths) {
  const out = new Map();
  for (const p of paths || []) {
    const g = gateOfPath(p);
    if (!g) continue;
    const id = `${g.gate}:${g.story ?? g.feature}`;
    if (!out.has(id)) out.set(id, g);
  }
  return [...out.values()];
}

function gitOut(main, args) {
  const r = spawnSync('git', ['-C', main, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return r.status === 0 ? r.stdout : null;
}

/**
 * Opens the hub's trunk for one send, or for one run of the workflow script. `main` is a checkout
 * of the hub. Returns:
 *   lastMerge(gate, key, beforeMs)    the gate's last merge at or before `beforeMs`: { mergedMs },
 *                                      null when there is none, or { unknown } when git cannot say
 *   mergesIn(key, fromMs, toMs)       every merge of the key's hub gates after `fromMs` and at or
 *                                      before `toMs`: { merges: [{ gate, mergedMs }] } or { unknown }
 */
export function openTrunk(main) {
  const ref = trunkRef(main);

  function lastMerge(gate, key, beforeMs) {
    const path = gatePath(gate, key);
    if (!path || !Number.isFinite(beforeMs)) return null;
    if (!ref) return { unknown: 'the hub has no trunk that this clone fetched' };
    const until = `--until=@${Math.floor(beforeMs / 1000)}`;
    const out = gitOut(main, ['log', '--first-parent', '-1', '--format=%ct', until, ref, '--', path]);
    if (out === null) return { unknown: 'git cannot read the hub\'s trunk' };
    const seconds = Number(out.trim());
    return out.trim() && Number.isFinite(seconds) ? { mergedMs: seconds * 1000 } : null;
  }

  function mergesIn(key, fromMs, toMs) {
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) return { merges: [] };
    if (!ref) return { unknown: 'the hub has no trunk that this clone fetched' };
    const merges = [];
    for (const gate of hubGatesOf(key)) {
      const since = `--since=@${Math.floor(fromMs / 1000) - 1}`;
      const until = `--until=@${Math.ceil(toMs / 1000) + 1}`;
      const out = gitOut(main, ['log', '--first-parent', '--format=%ct', since, until, ref, '--', gatePath(gate, key)]);
      if (out === null) return { unknown: 'git cannot read the hub\'s trunk' };
      for (const line of out.split('\n').filter(Boolean)) {
        const ms = Number(line) * 1000;
        if (Number.isFinite(ms) && ms > fromMs && ms <= toMs) merges.push({ gate, mergedMs: ms });
      }
    }
    merges.sort((a, b) => a.mergedMs - b.mergedMs);
    return { merges };
  }

  return { ref, lastMerge, mergesIn };
}

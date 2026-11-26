/**
 * git.mjs — git as the guard runs it, and the few readings of commits and trees it needs.
 *
 * Nothing a repository carries may change what git reports to the guard or run code inside it:
 * no hooks, no fsmonitor, no replace refs, no grafts, no commit-graph (git would trust its parents
 * over the commits'), no submodule recursion, no signing. Variables that point git at another
 * repository, or change how a pathspec reads, are dropped. A caller may add variables of its own
 * (a temporary index, a commit's identity) through `env`.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { cannot, short } from './common.mjs';

const HARDEN = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.commitGraph=false',
  '-c', 'submodule.recurse=false', '-c', 'commit.gpgsign=false', '-c', 'core.quotePath=false'];
const DROP = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR', 'GIT_NAMESPACE', 'GIT_REPLACE_REF_BASE', 'GIT_SHALLOW_FILE', 'GIT_LITERAL_PATHSPECS',
  'GIT_GLOB_PATHSPECS', 'GIT_NOGLOB_PATHSPECS', 'GIT_ICASE_PATHSPECS'];

export function gitEnv(extra = {}) {
  const env = { ...process.env, GIT_NO_REPLACE_OBJECTS: '1', GIT_GRAFT_FILE: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'true' };
  for (const k of DROP) delete env[k];
  // GIT_GRAFT_FILE makes git print a deprecation hint on every history walk. A check the guard runs inherits this env, so
  // the hint would fill its log, and the hand-in quotes the last lines of that log as evidence. Append after the caller's entries.
  const n = Number.isInteger(Number(env.GIT_CONFIG_COUNT)) && Number(env.GIT_CONFIG_COUNT) > 0 ? Number(env.GIT_CONFIG_COUNT) : 0;
  Object.assign(env, { GIT_CONFIG_COUNT: String(n + 1), [`GIT_CONFIG_KEY_${n}`]: 'advice.graftFileDeprecated', [`GIT_CONFIG_VALUE_${n}`]: 'false' });
  return { ...env, ...extra };
}

export function git(cwd, args, { input, binary = false, env } = {}) {
  return execFileSync('git', ['-C', cwd, ...HARDEN, ...args], {
    env: gitEnv(env), input, encoding: binary ? undefined : 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 1 << 28,
  });
}

export function gitTry(cwd, args, { env, ...opts } = {}) {
  const res = spawnSync('git', ['-C', cwd, ...HARDEN, ...args], { env: gitEnv(env), encoding: 'utf8', maxBuffer: 1 << 28, ...opts });
  if (res.error) throw cannot(`git could not run: ${res.error.message}`, 'git-failed');
  return { status: res.status, stdout: res.stdout || '', stderr: res.stderr || '' };
}

export function revParse(cwd, spec) {
  const r = gitTry(cwd, ['rev-parse', '--verify', '--quiet', spec]);
  return r.status === 0 ? r.stdout.trim() : null;
}

const isAncestor = (cwd, ancestor, descendant) => gitTry(cwd, ['merge-base', '--is-ancestor', ancestor, descendant]).status === 0;
export const hashBlob = (cwd, bytes) => git(cwd, ['hash-object', '--stdin', '--no-filters'], { input: bytes }).trim();
export const readBlob = (cwd, oid) => git(cwd, ['cat-file', 'blob', oid], { binary: true });

export function splitZ(buf) {
  const parts = [];
  let at = 0;
  while (at < buf.length) {
    const nul = buf.indexOf(0, at);
    if (nul === -1) { parts.push(buf.subarray(at)); break; }
    parts.push(buf.subarray(at, nul));
    at = nul + 1;
  }
  return parts.filter((p) => p.length);
}

// A path as git stores it is bytes. Valid UTF-8 is read as text; anything else is read lossily and
// flagged, and its bytes are kept, so a tree is never rewritten from a guess at its names.
const UTF8 = new TextDecoder('utf-8', { fatal: true });
export function decodePath(buf) {
  const raw = Buffer.from(buf);
  try { return { path: UTF8.decode(raw), utf8: true, raw }; } catch { return { path: raw.toString('utf8'), utf8: false, raw }; }
}

/** Every tracked entry of a commit's tree: { path, mode, type, oid, utf8, raw }. */
export function lsTree(cwd, commit) {
  return splitZ(git(cwd, ['ls-tree', '-r', '-z', '--full-tree', commit], { binary: true })).map((rec) => {
    const tab = rec.indexOf(0x09);
    const [mode, type, oid] = rec.subarray(0, tab).toString('latin1').split(' ');
    return { mode, type, oid, ...decodePath(rec.subarray(tab + 1)) };
  });
}

/** What one commit changed against another, renames as a deletion and an addition. */
export function diffTree(cwd, from, to) {
  const parts = splitZ(git(cwd, ['diff-tree', '-r', '-z', '--no-renames', '--no-commit-id', from, to], { binary: true }));
  const changes = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const [srcMode, dstMode, srcOid, dstOid, status] = parts[i].toString('latin1').replace(/^:/, '').split(' ');
    changes.push({ srcMode, dstMode, srcOid, dstOid, status, ...decodePath(parts[i + 1]) });
  }
  return changes;
}

const IDENT = /^(author|committer) (.*) <([^>]*)> (\d+) ([+-]\d{4})$/;

/** A commit read from its object, never through anything that could stand in for it. */
export function commitInfo(cwd, sha) {
  const raw = git(cwd, ['cat-file', 'commit', sha], { binary: true });
  const split = raw.indexOf('\n\n');
  const head = (split === -1 ? raw : raw.subarray(0, split)).toString('utf8');
  const messageBytes = split === -1 ? Buffer.alloc(0) : raw.subarray(split + 2);
  const message = messageBytes.toString('utf8');
  const ident = {};
  for (const line of head.split('\n')) {
    const m = line.match(IDENT);
    if (m) ident[m[1]] = { name: m[2], email: m[3], date: `@${m[4]} ${m[5]}` };
  }
  return {
    sha,
    tree: (head.match(/^tree ([0-9a-f]+)$/m) || [])[1],
    parents: [...head.matchAll(/^parent ([0-9a-f]+)$/gm)].map((m) => m[1]),
    author: ident.author || null,
    committer: ident.committer || null,
    subject: message.split('\n')[0],
    message,
    messageBytes,
  };
}

/** The commits of from..to, oldest first, each with one parent; a merge or a gap is a finding. */
export function linearRange(cwd, from, to, findings, label) {
  if (!isAncestor(cwd, from, to)) {
    findings.push(`${label}: ${short(from)} is not an ancestor of ${short(to)}`);
    return null;
  }
  const shas = git(cwd, ['rev-list', '--reverse', '--topo-order', `${from}..${to}`]).split('\n').filter(Boolean);
  const commits = shas.map((s) => commitInfo(cwd, s));
  const merges = commits.filter((c) => c.parents.length !== 1);
  for (const c of merges) findings.push(`${label}: commit ${c.sha} has ${c.parents.length} parents; the chain is linear, with no merge commit`);
  if (merges.length) return null;
  let expect = from;
  for (const c of commits) {
    if (c.parents[0] !== expect) { findings.push(`${label}: commit ${c.sha} does not sit on ${short(expect)}; the chain is one line from ${short(from)}`); return null; }
    expect = c.sha;
  }
  return commits;
}

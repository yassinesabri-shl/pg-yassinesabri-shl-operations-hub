/**
 * scan.mjs — protected files on disk, read from the file system rather than from git, so an
 * untracked, ignored, linked or case-aliased file is seen as plainly as a tracked one.
 *
 * `repairApproved` puts every approved entry back to its approved bytes and mode, and
 * `removeUnauthorized` moves every file the policy refuses out of the tree — into the run's
 * quarantine, removed with it at cleanup. The approved bytes are written here, never through git
 * checkout (whose filters, attributes and hooks a checkout could configure), and never through a
 * link: a link or file standing where a folder above an approved entry should be is moved aside
 * first. Byte-code caches a runner leaves under a protected location are cleared, and reported
 * apart from tampering. So is build output the repository ignores that only a runner's test
 * convention makes a test — a compiled `dist/x.test.js`, a `build/lib/test_x.py`: it is moved aside
 * all the same, since a runner may collect it there, but it is no one's change to a test, so it is
 * recorded as generated. Ignored is read from the ignore rules on disk, which the checkout's own
 * `.gitignore` can widen; that only changes how a file is recorded, never whether it is moved
 * aside, and a file the declaration covers is never generated. `repairHosts` undoes runner
 * configuration added to a mixed file (package.json, pyproject.toml, setup.cfg) outside the
 * manifest. `restoreClone` does all three in an engineer clone, and puts its index back too.
 */

import { chmodSync, cpSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { embeddedRunnerConfig, isRunnerHost } from './contract.mjs';
import { decodePath, git, gitTry, hashBlob, readBlob, splitZ } from './git.mjs';

// Folders never walked: git's own, and dependency trees a package manager installs into the checkout.
// A package there may ship its own runner configuration (numpy ships a conftest.py), and the
// supported runners do not collect tests from them.
const SKIP_DIRS = new Set(['.git', 'node_modules', '.venv', 'venv', '.tox', '.nox', '__pypackages__', '.eggs', '.yarn', 'bower_components', 'jspm_packages']);
// Jest and node --test do collect tests from a `vendor/` folder. So it is skipped only where Composer,
// Go or Bundler owns it, and a JavaScript repository's own `vendor/` is still walked.
const VENDOR_OWNERS = ['composer.json', 'go.mod', 'Gemfile'];
const isCache = (rel) => /(^|\/)(__pycache__|\.pytest_cache)(\/|$)/.test(rel) || /\.py[co]$/.test(rel);

const lstatOrNull = (p) => { try { return lstatSync(p); } catch { return null; } };
const inside = (abs, name) => Buffer.concat([abs, Buffer.from(sep), Buffer.from(name)]);

/** A dependency tree: a folder named in SKIP_DIRS, a `vendor/` beside its owner's manifest, or a virtual environment of any name. */
function isDependencyTree(parentAbs, name, abs) {
  if (SKIP_DIRS.has(name)) return true;
  if (name === 'vendor' && VENDOR_OWNERS.some((f) => lstatOrNull(inside(parentAbs, f))?.isFile())) return true;
  return !!lstatOrNull(inside(abs, 'pyvenv.cfg'))?.isFile();
}

/** Every non-folder entry under root — files, links, anything else — without following links. */
export function walk(root) {
  const found = [];
  const stack = [{ abs: Buffer.from(root), rel: '' }];
  while (stack.length) {
    const { abs, rel } = stack.pop();
    let entries;
    try { entries = readdirSync(abs, { withFileTypes: true, encoding: 'buffer' }); } catch { continue; }
    for (const d of entries) {
      const name = decodePath(d.name).path;
      const childAbs = Buffer.concat([abs, Buffer.from(sep), d.name]);
      const childRel = rel ? `${rel}/${name}` : name;
      if (d.isDirectory()) { if (!isDependencyTree(abs, name, childAbs)) stack.push({ abs: childAbs, rel: childRel }); continue; }
      found.push({ rel: childRel, abs: childAbs, link: d.isSymbolicLink() });
    }
  }
  return found;
}

/** Hashes of files on disk, through git, in one call. Null for a path git cannot hash. */
function hashFiles(wt, paths, filters) {
  const result = new Map();
  const batch = paths.filter((p) => !p.includes('\n'));
  if (batch.length) {
    const r = gitTry(wt, ['hash-object', ...(filters ? [] : ['--no-filters']), '--stdin-paths'], { input: `${batch.join('\n')}\n` });
    if (r.status === 0) r.stdout.trim().split('\n').forEach((oid, i) => result.set(batch[i], oid));
  }
  for (const p of paths.filter((x) => x.includes('\n'))) {
    const r = gitTry(wt, ['hash-object', ...(filters ? [] : ['--no-filters']), '--', p]);
    result.set(p, r.status === 0 ? r.stdout.trim() : null);
  }
  return result;
}

/** Move a path into the quarantine, across file systems if it must. */
function moveAside(abs, quarantine, rel) {
  let dest = join(quarantine, rel);
  for (let i = 1; lstatOrNull(dest); i += 1) dest = `${join(quarantine, rel)}.${i}`;
  mkdirSync(dirname(dest), { recursive: true });
  try { renameSync(abs, dest); } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    cpSync(abs, dest, { recursive: true, verbatimSymlinks: true });
    rmSync(abs, { recursive: true, force: true });
  }
}

function ensureRealDirs(root, relDir, quarantine) {
  const fixed = [];
  if (!relDir || relDir === '.') return fixed;
  let rel = '';
  for (const seg of relDir.split('/')) {
    rel = rel ? `${rel}/${seg}` : seg;
    const abs = join(root, rel);
    const st = lstatOrNull(abs);
    if (st && st.isDirectory()) continue;
    if (st) { moveAside(abs, quarantine, rel); fixed.push(rel); }
    mkdirSync(abs);
  }
  return fixed;
}

function writeApproved(root, entry, bytes) {
  const abs = join(root, entry.path);
  rmSync(abs, { force: true });
  if (entry.mode === '120000') { symlinkSync(bytes, abs); return; }
  writeFileSync(abs, bytes);
  chmodSync(abs, entry.mode === '100755' ? 0o755 : 0o644);
}

/**
 * Every approved entry on disk is its approved bytes, kind and mode; returns { path, kind } per
 * repair, kind deleted | edited | mode | replaced | folder. `acceptClean` also accepts bytes that
 * git's clean filters turn into the approved object (an eol attribute, say).
 */
export function repairApproved(root, approved, { blobs, quarantine, acceptClean = false, fileMode = true }) {
  const changes = [];
  const seen = new Set();
  const add = (path, kind) => { if (!seen.has(path)) { seen.add(path); changes.push({ path, kind }); } };
  const entries = approved.filter((e) => e.type === 'blob');
  for (const e of entries) for (const f of ensureRealDirs(root, dirname(e.path), quarantine)) add(f, 'folder');
  const files = [];
  for (const e of entries) {
    const abs = join(root, e.path);
    const st = lstatOrNull(abs);
    if (!st) { writeApproved(root, e, readBlob(blobs, e.oid)); add(e.path, 'deleted'); continue; }
    if (e.mode === '120000') {
      if (st.isSymbolicLink() && hashBlob(root, readlinkSync(abs, { encoding: 'buffer' })) === e.oid) continue;
      if (st.isDirectory()) moveAside(abs, quarantine, e.path);
      writeApproved(root, e, readBlob(blobs, e.oid));
      add(e.path, st.isSymbolicLink() ? 'edited' : 'replaced');
      continue;
    }
    if (!st.isFile()) {
      if (st.isDirectory()) moveAside(abs, quarantine, e.path);
      writeApproved(root, e, readBlob(blobs, e.oid));
      add(e.path, 'replaced');
      continue;
    }
    files.push({ e, st });
  }
  const raw = hashFiles(root, files.map((f) => f.e.path), false);
  const clean = acceptClean ? hashFiles(root, files.filter((f) => raw.get(f.e.path) !== f.e.oid).map((f) => f.e.path), true) : new Map();
  for (const { e, st } of files) {
    if (raw.get(e.path) !== e.oid && clean.get(e.path) !== e.oid) { writeApproved(root, e, readBlob(blobs, e.oid)); add(e.path, 'edited'); continue; }
    if (fileMode && ((st.mode & 0o111) !== 0) !== (e.mode === '100755')) { chmodSync(join(root, e.path), e.mode === '100755' ? 0o755 : 0o644); add(e.path, 'mode'); }
  }
  return changes;
}

/** The paths of `rels` that git ignores in the checkout at `root`; none when git cannot say. */
function ignoredIn(root, rels) {
  if (!rels.length) return new Set();
  const r = gitTry(root, ['check-ignore', '-z', '--stdin'], { input: `${rels.join('\0')}\0` });
  return r.status === 0 ? new Set(r.stdout.split('\0').filter(Boolean)) : new Set();
}

/**
 * Every file on disk the policy refuses and `kept` does not hold is moved to the quarantine.
 * Returns { path, kind } per file, kind removed (tampering), cleared (a runner's byte-code cache) or
 * generated (ignored build output that only a runner's test convention makes a test).
 */
export function removeUnauthorized(root, policy, { kept, quarantine }) {
  const refused = walk(root).filter((f) => {
    if (kept.has(f.rel)) return false;
    const cls = policy.classify(f.rel);
    return cls !== 'approved' && (cls === 'protected' || policy.collides(f.rel));
  });
  const ignored = ignoredIn(root, refused.filter((f) => policy.conventionOnly(f.rel)).map((f) => f.rel));
  return refused.map((f) => {
    moveAside(f.abs, quarantine, f.rel);
    return { path: f.rel, kind: isCache(f.rel) ? 'cleared' : ignored.has(f.rel) ? 'generated' : 'removed' };
  });
}

/**
 * Every mixed file on disk outside the manifest that carries runner configuration goes back to its
 * `clean` version (path to entry, read from `blobs`), or into the quarantine when it has none.
 * Returns { path, kind } per file, kind configured or removed. Its contents are read only to find
 * runner configuration; a file that carries none is never touched, whatever else changed in it.
 */
export function repairHosts(root, policy, { clean, blobs, quarantine }) {
  const changes = [];
  for (const f of walk(root)) {
    if (!isRunnerHost(f.rel) || policy.approved.has(f.rel)) continue;
    let bytes;
    try { bytes = f.link ? readlinkSync(f.abs, { encoding: 'buffer' }) : readFileSync(f.abs); } catch { continue; }
    if (!embeddedRunnerConfig(f.rel, bytes).length) continue;
    const c = clean.get(f.rel);
    if (c) { writeApproved(root, c, readBlob(blobs, c.oid)); changes.push({ path: f.rel, kind: 'configured' }); } else { moveAside(f.abs, quarantine, f.rel); changes.push({ path: f.rel, kind: 'removed' }); }
  }
  return changes;
}

function readIndex(root) {
  const index = new Map();
  for (const rec of splitZ(git(root, ['ls-files', '--stage', '-z'], { binary: true }))) {
    const tab = rec.indexOf(0x09);
    const [mode, oid, stage] = rec.subarray(0, tab).toString('latin1').split(' ');
    const p = decodePath(rec.subarray(tab + 1));
    if (!index.has(p.path) || stage === '0') index.set(p.path, { mode, oid, stage, ...p });
  }
  return index;
}

/**
 * Put every approved entry of an engineer clone back to the approved test commit — on disk and in
 * the index — and move out every file the declaration refuses, whether git tracks, ignores or has
 * never seen it. `blobs` is the repository the approved objects are read from (the controller). Returns one change per path:
 * { path, kind } with kind deleted | edited | mode | replaced | folder | staged | removed | cleared |
 * generated. A refused file the engineer staged is removed, never generated, whatever ignores it.
 */
export function restoreClone(root, policy, { blobs, quarantine }) {
  const approved = [...policy.approved.values()].filter((e) => e.type === 'blob');
  const changes = repairApproved(root, approved, { blobs, quarantine });
  const seen = new Set(changes.map((c) => c.path));

  const index = readIndex(root);
  const stale = approved.filter((e) => { const i = index.get(e.path); return !i || i.mode !== e.mode || i.oid !== e.oid || i.stage !== '0'; });
  if (stale.length) {
    git(root, ['update-index', '--add', '-z', '--index-info'], { input: stale.map((e) => `${e.mode} ${e.oid}\t${e.path}\0`).join('') });
    for (const e of stale) if (!seen.has(e.path)) { seen.add(e.path); changes.push({ path: e.path, kind: 'staged' }); }
  }
  const refused = [...index.values()].filter((i) => !policy.approved.has(i.path) && (policy.classify(i.path) === 'protected' || policy.collides(i.path)));
  if (refused.length) git(root, ['update-index', '--force-remove', '-z', '--stdin'], { input: Buffer.concat(refused.map((i) => Buffer.concat([i.raw, Buffer.from([0])]))) });

  const kept = new Set([...index.keys()].filter((p) => !refused.some((r) => r.path === p)));
  const removed = removeUnauthorized(root, policy, { kept, quarantine });
  for (const r of refused) {
    const x = removed.find((c) => c.path === r.path);
    if (x) x.kind = 'removed'; else removed.push({ path: r.path, kind: 'removed' });
  }

  // Runner configuration added to a mixed file: on disk, then a staged copy of it.
  const hosts = repairHosts(root, policy, { clean: policy.hosts, blobs, quarantine });
  const configured = [...index.values()].filter((i) => !policy.approved.has(i.path) && i.stage === '0' && i.mode !== '160000' && isRunnerHost(i.path) && !refused.includes(i)
    && (policy.hosts.get(i.path) || {}).oid !== i.oid && embeddedRunnerConfig(i.path, readBlob(root, i.oid)).length);
  for (const i of configured) {
    const c = policy.hosts.get(i.path);
    if (c) git(root, ['update-index', '-z', '--index-info'], { input: `${c.mode} ${c.oid}\t${i.path}\0` });
    else git(root, ['update-index', '--force-remove', '-z', '--stdin'], { input: Buffer.concat([i.raw, Buffer.from([0])]) });
    if (!hosts.some((h) => h.path === i.path)) hosts.push({ path: i.path, kind: c ? 'configured' : 'removed' });
  }
  return [...changes, ...removed.filter((c) => !seen.has(c.path)), ...hosts.filter((c) => !seen.has(c.path) && !removed.some((r) => r.path === c.path))];
}

// Part of the harness asset library c6f3b4427d58f7c3 (see VERSION.json) · 2026-10-26
/**
 * state.mjs — the hub's state folder, `.harness/observability/` in the hub's main checkout, and
 * every file in it.
 *
 *   runs/<key>.json          one runtime session's runs: run_id, command, key, start time
 *   checkpoints/<key>.json   one log: the counts already sent for each call id, and its seat's run
 *   index/<runtime>.json     the call index: the log that first counted each call id
 *   time/<key>.json          one log's work time: its own offset, and the turn or activation still open
 *   time/runs/<key>.json     one run's finished work and waits, and the logs that still hold a piece open
 *   queue/<id>.pending       a record whose checkpoint has not moved yet; the sender never reads it
 *   queue/<id>.json          a record ready to send
 *   sent/<id>.json           a record the observability platform accepted, kept 30 days
 *   refused/<id>.json        a record the observability platform refused, with its answer
 *   observability.log                warnings and errors, without content
 *
 * The folder sits in the main checkout, found through `git rev-parse --git-common-dir`, so every
 * linked worktree of the hub shares it. Nothing is written until git ignores it. Every write goes to
 * a temporary file and a rename puts it in place, so a stopped process never leaves half a file.
 * A record is written as `.pending` before its checkpoint moves and renamed to `.json` after, and
 * `repair` finishes any `.pending` file at the next start: a stop between the two writes never
 * sends a call twice.
 *
 * Node standard library only, plus git.
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync,
  rmSync, statSync, writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { STATE_DIR, fileKey, maxCounts, nowMs } from './common.mjs';

/** A failure the hook reports in observability.log and survives: a lock it cannot take, a file it cannot read. */
export class StateError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const real = (p) => { try { return realpathSync(p); } catch { return p; } };

/** The hub's main checkout, from any folder inside the hub or one of its linked worktrees. Null when there is none. */
export function mainCheckout(start) {
  const r = spawnSync('git', ['rev-parse', '--git-common-dir'], { cwd: start, encoding: 'utf8' });
  if (r.status !== 0) return null;
  const common = real(resolve(start, r.stdout.trim()));
  // A bare repository or a separate git directory has no checkout to keep state in.
  if (basename(common) !== '.git') return null;
  return dirname(common);
}

/** True when git ignores the state folder in this checkout. The collector writes nothing until it does. */
export function isIgnored(main) {
  const r = spawnSync('git', ['check-ignore', '-q', '--', `${STATE_DIR}/probe`], { cwd: main, encoding: 'utf8' });
  return r.status === 0;
}

export const stateDir = (main) => join(main, STATE_DIR);

export function folders(dir) {
  return {
    runs: join(dir, 'runs'),
    checkpoints: join(dir, 'checkpoints'),
    index: join(dir, 'index'),
    time: join(dir, 'time'),
    timeRuns: join(dir, 'time', 'runs'),
    queue: join(dir, 'queue'),
    sent: join(dir, 'sent'),
    refused: join(dir, 'refused'),
    log: join(dir, 'observability.log'),
  };
}

/** A JSON file, or `fallback` when it does not exist. A file that exists and cannot be parsed is an error, never empty. */
export function readJson(path, fallback) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw new StateError('unreadable', `${basename(path)} cannot be read (${err.code})`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new StateError('unreadable', `${basename(path)} is not valid JSON`);
  }
}

export function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
  writeFileSync(tmp, `${JSON.stringify(value)}\n`);
  renameSync(tmp, path);
}

/**
 * Runs `fn` while holding `<path>.lock`. A lock older than `staleMs` is from a process that stopped,
 * and is broken. A lock held for longer than `waitMs` is a StateError, never a silent wait.
 */
export function withLock(path, fn, { waitMs = 5000, staleMs = 30000 } = {}) {
  const lock = `${path}.lock`;
  mkdirSync(dirname(lock), { recursive: true });
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      const fd = openSync(lock, 'wx');
      writeFileSync(fd, `${process.pid}\n`);
      closeSync(fd);
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      try {
        if (Date.now() - statSync(lock).mtimeMs > staleMs) { rmSync(lock, { force: true }); continue; }
      } catch {
        continue;
      }
      if (Date.now() > deadline) throw new StateError('busy', `${basename(path)} is held by another process`);
      sleep(20);
    }
  }
  try {
    return fn();
  } finally {
    rmSync(lock, { force: true });
  }
}

/**
 * Takes `<path>.lock` at once, or returns null while another process holds it. A lock older than
 * `staleMs` is from a process that stopped, and is broken. Returns the function that frees the lock.
 */
export function tryLock(path, { staleMs = 10 * 60 * 1000 } = {}) {
  const lock = `${path}.lock`;
  mkdirSync(dirname(lock), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(lock, 'wx');
      writeFileSync(fd, `${process.pid}\n`);
      closeSync(fd);
      return () => rmSync(lock, { force: true });
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      try {
        if (Date.now() - statSync(lock).mtimeMs <= staleMs) return null;
        rmSync(lock, { force: true });
      } catch {
        // The holder freed the lock between the two calls. The next attempt takes it.
      }
    }
  }
  return null;
}

/** One line in observability.log. It never holds content: callers pass counts, ids and short reasons only. */
export function logLine(dir, level, message) {
  try {
    const path = folders(dir).log;
    mkdirSync(dir, { recursive: true });
    if (existsSync(path) && statSync(path).size > 1024 * 1024) renameSync(path, `${path}.1`);
    appendFileSync(path, `${new Date(nowMs()).toISOString()} ${level} ${message}\n`);
  } catch {
    // The log is a convenience. A failure to write it never stops a collection.
  }
}

/* ------------------------------------------------------------------------------- run bindings */

export const bindingKey = (runtime, session) => fileKey('binding', runtime, String(session));
export const bindingPath = (dir, key) => join(folders(dir).runs, `${key}.json`);

export function loadBinding(dir, key) {
  return readJson(bindingPath(dir, key), { runs: [] });
}

export function saveBinding(dir, key, binding) {
  writeJson(bindingPath(dir, key), binding);
}

/* -------------------------------------------------------------------------------- checkpoints */

export const logKeyOf = (runtime, logRef) => fileKey('log', runtime, String(logRef));
export const checkpointPath = (dir, logKey) => join(folders(dir).checkpoints, `${logKey}.json`);

export function loadCheckpoint(dir, logKey) {
  return readJson(checkpointPath(dir, logKey), { offset: 0, calls: {} });
}

export function saveCheckpoint(dir, logKey, checkpoint) {
  writeJson(checkpointPath(dir, logKey), checkpoint);
}

/* --------------------------------------------------------------------------------- call index */

export const indexPath = (dir, runtime) => join(folders(dir).index, `${runtime}.json`);

export function loadIndex(dir, runtime) {
  return readJson(indexPath(dir, runtime), { calls: {} });
}

/** Saves the index, dropping entries older than 120 days: no runtime keeps a log that long. */
export function saveIndex(dir, runtime, index) {
  const cutoff = nowMs() - 120 * 24 * 3600 * 1000;
  for (const [id, entry] of Object.entries(index.calls)) if (!Array.isArray(entry) || entry[1] < cutoff) delete index.calls[id];
  writeJson(indexPath(dir, runtime), index);
}

/* ---------------------------------------------------------------------------------- work time */

export const timeStatePath = (dir, logKey) => join(folders(dir).time, `${logKey}.json`);
export const timeRunPath = (dir, runId) => join(folders(dir).timeRuns, `${fileKey('time-run', String(runId))}.json`);

/** One log's work time, or null before its first read. */
export function loadTimeState(dir, logKey) {
  return readJson(timeStatePath(dir, logKey), null);
}

export function saveTimeState(dir, logKey, state) {
  writeJson(timeStatePath(dir, logKey), state);
}

/** One run's work time, or null when no piece of it has been read yet. */
export function loadTimeRun(dir, runId) {
  return readJson(timeRunPath(dir, runId), null);
}

export function saveTimeRun(dir, runId, run) {
  writeJson(timeRunPath(dir, runId), run);
}

/* -------------------------------------------------------------------------------------- queue */

const queueFile = (dir, id, ext) => join(folders(dir).queue, `${id}.${ext}`);

/** True when a record with this id is already queued, sent or refused: it is never written twice. */
export function queueHas(dir, id) {
  const f = folders(dir);
  return existsSync(queueFile(dir, id, 'json')) || existsSync(queueFile(dir, id, 'pending'))
    || existsSync(join(f.sent, `${id}.json`)) || existsSync(join(f.refused, `${id}.json`));
}

export function writePending(dir, entry) {
  writeJson(queueFile(dir, entry.record.record_id, 'pending'), entry);
}

/**
 * Queues a record ready to send at once. A work-time record moves no checkpoint, so it needs no
 * `.pending` step: its id is the same at every read, and queueHas keeps it from being written twice.
 */
export function writeReady(dir, entry) {
  writeJson(queueFile(dir, entry.record.record_id, 'json'), entry);
}

export function markReady(dir, id) {
  const from = queueFile(dir, id, 'pending');
  if (existsSync(from)) renameSync(from, queueFile(dir, id, 'json'));
}

/** Applies what a queued record says its checkpoint and the call index must hold. Safe to repeat. */
export function applyEntry(dir, apply) {
  const checkpoint = loadCheckpoint(dir, apply.log);
  for (const [id, after] of Object.entries(apply.calls)) {
    const had = checkpoint.calls[id];
    checkpoint.calls[id] = { ...(had || {}), sent: maxCounts(had ? had.sent : null, after) };
    delete checkpoint.calls[id].skipped;
  }
  saveCheckpoint(dir, apply.log, checkpoint);
  if (apply.index && apply.index.length) {
    withLock(indexPath(dir, apply.runtime), () => {
      const index = loadIndex(dir, apply.runtime);
      for (const id of apply.index) if (!index.calls[id]) index.calls[id] = [apply.log, apply.ms];
      saveIndex(dir, apply.runtime, index);
    });
  }
}

/** Finishes every `.pending` record left by a process that stopped: its checkpoint moves, then it is ready. */
export function repair(dir) {
  const q = folders(dir).queue;
  if (!existsSync(q)) return 0;
  let repaired = 0;
  for (const name of readdirSync(q)) {
    if (!name.endsWith('.pending')) continue;
    const path = join(q, name);
    const entry = readJson(path, null);
    if (!entry || !entry.local || !entry.local.apply) continue;
    withLock(checkpointPath(dir, entry.local.apply.log), () => applyEntry(dir, entry.local.apply));
    markReady(dir, name.slice(0, -'.pending'.length));
    repaired += 1;
  }
  return repaired;
}

/** The ready records, oldest first. The sender reads only these. */
export function readyRecords(dir) {
  const q = folders(dir).queue;
  if (!existsSync(q)) return [];
  const out = [];
  for (const name of readdirSync(q)) {
    if (!name.endsWith('.json')) continue;
    const entry = readJson(join(q, name), null);
    if (entry && entry.record) out.push(entry);
  }
  return out.sort((a, b) => (a.local?.created_ms ?? 0) - (b.local?.created_ms ?? 0));
}

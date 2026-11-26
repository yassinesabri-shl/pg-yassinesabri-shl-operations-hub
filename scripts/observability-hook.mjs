#!/usr/bin/env node
// Part of the harness asset library c6f3b4427d58f7c3 (see VERSION.json) · 2026-10-26
/**
 * observability-hook.mjs — the one hook entry for observability. Claude Code runs it at
 * UserPromptSubmit, PreToolUse on Bash, Stop, StopFailure, SubagentStop and SessionEnd
 * (accelerator/settings/observability-hooks.settings.json). Codex runs it at UserPromptSubmit,
 * PreToolUse on Bash, Stop, SubagentStop and SessionEnd (accelerator/settings/codex-hooks.json,
 * untested). OpenCode's plugin runs it when a command starts, before a shell call that runs a
 * harness script, and when a session goes idle (accelerator/plugins/opencode/):
 *
 *     node "$CLAUDE_PROJECT_DIR/scripts/observability-hook.mjs" claude-code
 *     node "$(git rev-parse --show-toplevel)/scripts/observability-hook.mjs" codex
 *     node <hub>/scripts/observability-hook.mjs opencode
 *
 * It reads one hook event on stdin and does only local work, in the hub's state folder:
 *   - Every prompt reads the main log again. A prompt that starts a harness command then opens a
 *     run, which names the person who runs it. Any other prompt changes nothing else.
 *   - A shell call that runs one of five harness scripts with a story's key gives a story run its
 *     key, or moves the session's work to a run for that story (runs.mjs `takeWorkKey`). Any other
 *     shell call ends the hook before it reads anything, because this hook runs at every one.
 *   - Stop and StopFailure read the main session's log, and every subagent log of the session again.
 *   - SubagentStop reads the subagent's log. A seat keeps its name, a subagent that the runtime
 *     ships is runtime-agent, and any other subagent is other-agent. Only a seat's log is read in
 *     a session that has no run.
 *   - SessionEnd reads the main log and every subagent log a last time.
 * A runtime can run a hook before the last call of a turn or a seat is on disk. The next hook reads
 * that call, and the checkpoints keep every call from counting twice.
 * In a session with a run, every read of a log also reads its work time, where the adapter has a
 * time reader (observability/time.mjs), and the harness's failures in it, where the adapter has a
 * failure reader (observability/failures.mjs). At the end of a turn and at the session's end, the hook writes the
 * command record of each ended run whose work has all finished.
 * A run still missing its key takes it from the branch of the session's working folder. Then the
 * hook starts the sender in the background and exits. It calls the network only through gh, to
 * name the person: once a day with a login, once an hour while gh fails, and for 2 seconds at most
 * each time (observability/person.mjs).
 * A run's key comes from the first source that gives one: the command line, the branch, the work,
 * or the same command typed again. A key, once found, never changes.
 *
 * The hub is the one this script is installed in: CLAUDE_PROJECT_DIR, or else the folder above
 * scripts/. Never the session's working folder, which can be a spoke clone. A hub without
 * docs/estate/observability.json, or whose .gitignore does not cover .harness/, collects nothing.
 *
 * Observability is not optional. A prompt that starts a harness command does not start in a hub
 * that collects nothing, or with "auth": "bearer" and no HARNESS_OBSERVABILITY_TOKEN. The hook then
 * prints the runtime's refusal, with the reason and its fix, and does nothing else
 * (config.mjs `promptRefusal`). /connect-observability-platform always starts.
 *
 * At any other prompt it prints nothing, because Claude Code adds a prompt hook's output to the
 * conversation. At the end of a turn of a harness command it prints one message, once in each
 * session, when a record has waited more than 24 hours on this laptop, where the runtime shows a
 * hook's message to the person. It always exits 0, because a non-zero exit can show the person an
 * error. A problem goes to .harness/observability/observability.log, without content.
 *
 * Node standard library only, plus git and gh.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collect, collectTime, finishRuns } from './observability/collect.mjs';
import { nowMs } from './observability/common.mjs';
import { hubContext, promptRefusal } from './observability/config.mjs';
import { personOf } from './observability/person.mjs';
import { endSession, fillKey, keyFromBranch, keyFromNextCommand, keyFromWork, openRun, parseCommand, runAt, takeWorkKey } from './observability/runs.mjs';
import { bindingKey, bindingPath, loadBinding, loadCheckpoint, logKeyOf, logLine, readyRecords, saveBinding, withLock } from './observability/state.mjs';
import * as claudeCode from './observability/collectors/claude-code.mjs';
import * as codex from './observability/collectors/codex.mjs';
import * as opencode from './observability/collectors/opencode.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ADAPTERS = { 'claude-code': claudeCode, codex, opencode };

function readStdin() {
  return new Promise((done) => {
    let raw = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { raw += chunk; });
    process.stdin.on('end', () => done(raw));
    process.stdin.on('error', () => done(raw));
  });
}

function branchOf(cwd) {
  if (!cwd || !existsSync(cwd)) return null;
  const r = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

/** Changes a session's binding under its lock. */
function withBinding(ctx, adapter, session, change) {
  const key = bindingKey(adapter.RUNTIME, session);
  withLock(bindingPath(ctx.dir, key), () => {
    const binding = loadBinding(ctx.dir, key);
    if (change(binding) !== false) saveBinding(ctx.dir, key, binding);
  });
}

/**
 * A prompt that starts a harness command opens a run, with its key from the command line or the
 * branch, and the person who runs it (person.mjs: gh, then git). The run starts now, or at the time
 * the adapter gives: OpenCode's plugin sees a command start before this hook runs. The same story
 * command, typed again with its key, gives that key to the run before it, which had none (runs.mjs
 * `keyFromNextCommand`).
 */
function onPrompt(ctx, adapter, ev) {
  const parsed = parseCommand(ev.prompt);
  if (!parsed) return;
  const { person } = personOf(ctx);
  withBinding(ctx, adapter, ev.session, (binding) => {
    const run = openRun(binding, { ...parsed, person }, ev.at ?? nowMs());
    fillKey(run, keyFromBranch(branchOf(ev.cwd)));
    keyFromNextCommand(binding, run);
  });
}

/** The current run takes its missing key from the branch, as /feature's does once it cuts requirements/<SLUG>. */
function fillFromBranch(ctx, adapter, ev) {
  if (!existsSync(bindingPath(ctx.dir, bindingKey(adapter.RUNTIME, ev.session)))) return;
  const fromBranch = keyFromBranch(branchOf(ev.cwd));
  if (!fromBranch) return;
  withBinding(ctx, adapter, ev.session, (binding) => fillKey(runAt(binding, nowMs()), fromBranch));
}

/** A shell call that runs a harness script with a story's key: the session's run takes that key. */
function onWork(ctx, adapter, ev) {
  const key = keyFromWork(ev.command);
  if (!key || !existsSync(bindingPath(ctx.dir, bindingKey(adapter.RUNTIME, ev.session)))) return;
  withBinding(ctx, adapter, ev.session, (binding) => takeWorkKey(binding, key, ev.at ?? nowMs()));
}

/**
 * Collects one log: its calls, then its work time. `time.stopped` says that the runtime said at this
 * hook that the seat stopped. `time.final` says that the session ends.
 */
function collectLog(ctx, adapter, ev, log, seat, time = {}) {
  let written = 0;
  try {
    written = collect({
      ctx, runtime: adapter.RUNTIME, collector: adapter.COLLECTOR, session: ev.session, logRef: log.logRef, seat,
      read: (checkpoint) => adapter.read(log, checkpoint, { main: !seat }),
    }).written;
  } catch (err) {
    logLine(ctx.dir, 'ERROR', `${adapter.RUNTIME} ${seat ? 'seat' : 'main'} log not collected: ${err && err.code ? err.code : 'error'}`);
  }
  return written + collectLogTime(ctx, adapter, ev, log, seat, time);
}

const hasBinding = (ctx, adapter, session) => existsSync(bindingPath(ctx.dir, bindingKey(adapter.RUNTIME, session)));
const readsTime = (ctx, adapter, ev) => typeof adapter.readTime === 'function' && hasBinding(ctx, adapter, ev.session);

/** One log's work time, in a session with a run, when the adapter has a time reader. */
function collectLogTime(ctx, adapter, ev, log, seat, { stopped = false, final = false }) {
  if (!readsTime(ctx, adapter, ev)) return 0;
  try {
    const failures = adapter.FAILURE_COLLECTOR ? { collector: adapter.FAILURE_COLLECTOR } : null;
    return collectTime({
      ctx, runtime: adapter.RUNTIME, collector: adapter.TIME_COLLECTOR, session: ev.session, logRef: log.logRef, seat, stopped, final,
      failures, readTime: (offset, state) => adapter.readTime(log, offset, { main: !seat, state }),
    }).written;
  } catch (err) {
    logLine(ctx.dir, 'ERROR', `${adapter.RUNTIME} ${seat ? 'seat' : 'main'} work time not read: ${err && err.code ? err.code : 'error'}`);
    return 0;
  }
}

/** The command record of each ended run of the session whose work has all finished. */
function finishCommands(ctx, adapter, ev, final = false) {
  if (!readsTime(ctx, adapter, ev)) return 0;
  try {
    return finishRuns({
      ctx, runtime: adapter.RUNTIME, collector: adapter.TIME_COLLECTOR, session: ev.session, final,
      seatRefs: adapter.seatLogs(ev).map((s) => s.logRef),
    });
  } catch (err) {
    logLine(ctx.dir, 'ERROR', `${adapter.RUNTIME} command records not written: ${err && err.code ? err.code : 'error'}`);
    return 0;
  }
}

/**
 * The name of a subagent's records, or null when its log is not read: a seat's own, runtime-agent
 * for a type that the runtime ships, or other-agent. Only a seat's log is read in a session with
 * no run.
 */
function subagentName(ctx, adapter, ev, name) {
  if (adapter.isHarnessSeat(ctx, name)) return name;
  return hasBinding(ctx, adapter, ev.session) ? adapter.agentName(ctx, name) : null;
}

/**
 * Reads every subagent log of the session again. A log keeps the name its first read gave it. A log
 * whose type is not known yet waits for its SubagentStop, and the session's end reads it as other-agent.
 */
function collectSeats(ctx, adapter, ev, time = {}) {
  let queued = 0;
  for (const seat of adapter.seatLogs(ev)) {
    const known = loadCheckpointQuiet(ctx, adapter, seat.logRef)?.seat;
    if (!known && !seat.metaName && ev.kind !== 'end') continue;
    const name = known || subagentName(ctx, adapter, ev, seat.metaName);
    if (name) queued += collectLog(ctx, adapter, ev, seat, name, time);
  }
  return queued;
}

/** How long a record may wait on this laptop before the session of a harness command is told. */
const STUCK_MS = 24 * 3600 * 1000;
/** What that session is told, once. */
const STUCK_MESSAGE = 'Observability: a record has waited more than 24 hours on this laptop to reach the observability platform. Run node scripts/observability-status.mjs to see why.';

/**
 * The warning for a session of a harness command, at the end of a turn, when the oldest record ready
 * to send has waited more than 24 hours, or null. Each session is told once. A runtime that shows no
 * hook message to the person gets none.
 */
function queueWarning(ctx, adapter, ev) {
  if (ev.kind !== 'turn' || typeof adapter.showMessage !== 'function' || !hasBinding(ctx, adapter, ev.session)) return null;
  if (loadBinding(ctx.dir, bindingKey(adapter.RUNTIME, ev.session)).queue_warned_ms) return null;
  const oldest = readyRecords(ctx.dir)[0]?.local?.created_ms;
  if (!Number.isFinite(oldest) || nowMs() - oldest <= STUCK_MS) return null;
  let first = false;
  withBinding(ctx, adapter, ev.session, (binding) => {
    if (binding.queue_warned_ms) return false;
    binding.queue_warned_ms = nowMs();
    first = true;
    return true;
  });
  return first ? adapter.showMessage(STUCK_MESSAGE) : null;
}

/** Handles one normalised event. Returns the number of records queued. */
export function handle(ctx, adapter, ev) {
  if (!ev || !ev.session) return 0;
  let queued = 0;
  if (ev.kind === 'prompt') {
    // The last call of the turn before can reach the disk after its Stop ran.
    if (ev.main && hasBinding(ctx, adapter, ev.session)) queued += collectLog(ctx, adapter, ev, ev.main, null);
    onPrompt(ctx, adapter, ev);
  } else if (ev.kind === 'turn' && ev.main) {
    fillFromBranch(ctx, adapter, ev);
    queued += collectLog(ctx, adapter, ev, ev.main, null);
    // A seat's last call can reach the disk after its SubagentStop ran.
    queued += collectSeats(ctx, adapter, ev);
    queued += finishCommands(ctx, adapter, ev);
  } else if (ev.kind === 'tool') {
    onWork(ctx, adapter, ev);
  } else if (ev.kind === 'seat' && ev.seat) {
    const name = subagentName(ctx, adapter, ev, ev.seat.name);
    // A runtime that lists no seat log reads a seat only at its stop, so that read finishes its open piece.
    if (name) queued += collectLog(ctx, adapter, ev, ev.seat, name, { stopped: true, final: adapter.SEATS_READ_ONCE === true });
  } else if (ev.kind === 'end' && ev.main) {
    fillFromBranch(ctx, adapter, ev);
    queued += collectLog(ctx, adapter, ev, ev.main, null, { final: true });
    queued += collectSeats(ctx, adapter, ev, { final: true });
    if (hasBinding(ctx, adapter, ev.session)) withBinding(ctx, adapter, ev.session, (b) => endSession(b, nowMs()));
    queued += finishCommands(ctx, adapter, ev, true);
  }
  return queued;
}

function loadCheckpointQuiet(ctx, adapter, logRef) {
  try { return loadCheckpoint(ctx.dir, logKeyOf(adapter.RUNTIME, logRef)); } catch { return null; }
}

/** Starts the sender in the background, when it is installed. HARNESS_OBSERVABILITY_SENDER=off stops it, for the suites. */
function startSender(ctx) {
  if (process.env.HARNESS_OBSERVABILITY_SENDER === 'off') return;
  const sender = join(HERE, 'observability-send.mjs');
  if (!existsSync(sender)) return;
  // A TLS inspection proxy re-signs HTTPS with its own authority, which the operating system trusts.
  // Node trusts only its own bundled authorities, unless NODE_USE_SYSTEM_CA=1 adds the system's.
  // Older Node versions ignore the variable. Certificate checks always stay on.
  const env = { ...process.env, NODE_USE_SYSTEM_CA: '1' };
  try {
    const child = spawn(process.execPath, [sender, '--hub', ctx.main], { detached: true, stdio: 'ignore', windowsHide: true, env });
    child.unref();
  } catch {
    // The next hook starts it again. Nothing is lost: the records wait in the queue.
  }
}

async function main() {
  const adapter = ADAPTERS[process.argv[2]];
  const raw = await readStdin();
  if (!adapter) return;
  let event;
  try { event = JSON.parse(raw); } catch { return; }
  if (!event || typeof event !== 'object' || Array.isArray(event)) return;
  let ev;
  try { ev = adapter.normalise(event); } catch { return; }
  // The hook runs at every shell call. One that runs none of the five scripts ends here, before git runs.
  if (ev.kind === 'tool' && !keyFromWork(ev.command)) return;
  const ctx = hubContext(process.env.CLAUDE_PROJECT_DIR || dirname(HERE));
  // A harness command does not start in a hub that is not connected, or without its write token.
  const refusal = ev.kind === 'prompt' ? promptRefusal(ctx, parseCommand(ev.prompt)) : null;
  if (refusal && typeof adapter.refusePrompt === 'function') {
    process.stdout.write(`${adapter.refusePrompt(refusal)}\n`);
    return;
  }
  if (!ctx.ok) return;
  let queued = 0;
  let message = null;
  try {
    queued = handle(ctx, adapter, ev);
    message = queueWarning(ctx, adapter, ev);
  } catch (err) {
    logLine(ctx.dir, 'ERROR', `${adapter.RUNTIME} event not handled: ${err && err.code ? err.code : 'error'}`);
  }
  if (message) process.stdout.write(`${message}\n`);
  if (queued > 0) startSender(ctx);
}

const invoked = (() => { try { return realpathSync(process.argv[1] || '') === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })();
if (invoked) {
  process.on('uncaughtException', () => process.exit(0));
  main().catch(() => {}).finally(() => process.exit(0));
}

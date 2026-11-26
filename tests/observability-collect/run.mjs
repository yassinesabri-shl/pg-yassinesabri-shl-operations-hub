#!/usr/bin/env node
// Part of the harness asset library c6f3b4427d58f7c3 (see VERSION.json) · 2026-10-26
/**
 * run.mjs — the fixture suite for observability: the core (scripts/observability/), the hook that
 * drives it, and each runtime's collector adapter.
 *
 *   usage:  node run.mjs            run every fixture
 *           node run.mjs 3 7        run only the numbered fixtures
 *           node run.mjs --keep     leave the throwaway hubs on disk
 *
 * A fixture is a HUB STATE: a throwaway hub with a real bare origin, its observability.json, its
 * agent registry and its install receipt, under a private HOME. The core has no command of its own,
 * so the core fixtures call its functions against that hub, the way the hook does. The fixtures
 * check the queue, the checkpoints and the call index that the collection leaves on disk.
 *
 * Fixture 1 is the full control. Every other fixture changes one thing.
 *
 * Reads the whole tree it is installed in. scripts/upgrade.mjs reads that line literally: the
 * modules under scripts/observability/ are not scripts it can trace, so this suite runs on every
 * upgrade.
 *
 * Node standard library only. No test framework.
 * Exit 0 if every fixture passes, 1 if any fails, 4 if the code under test cannot be found.
 */

import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

// Two layouts: the library, where the modules sit at ../../observability/; and an adopting hub,
// where this suite lands at tests/observability-collect/ and the modules at scripts/observability/.
const first = (...c) => c.filter(Boolean).find((p) => existsSync(join(p, 'collect.mjs')));
const CORE = first(
  process.env.HARNESS_OBSERVABILITY_DIR,
  resolve(HERE, '..', '..', 'observability'),
  resolve(HERE, '..', '..', 'scripts', 'observability'),
);
if (!CORE) {
  console.error('cannot locate the observability modules. Set HARNESS_OBSERVABILITY_DIR=/path/to/scripts/observability.');
  process.exit(4);
}
const LIBRARY_LAYOUT = CORE === resolve(HERE, '..', '..', 'observability');
const COMMANDS_DIR = resolve(HERE, '..', '..', '..', 'commands');
// The hook sits beside the modules' folder in both layouts: scripts/observability-hook.mjs.
const HOOK = resolve(CORE, '..', 'observability-hook.mjs');

const KEEP = process.argv.includes('--keep');
const load = (name) => import(pathToFileURL(join(CORE, name)).href);
const core = {
  collect: await load('collect.mjs'),
  config: await load('config.mjs'),
  common: await load('common.mjs'),
  failures: await load('failures.mjs'),
  prices: await load('prices.mjs'),
  record: await load('record.mjs'),
  person: await load('person.mjs'),
  runs: await load('runs.mjs'),
  state: await load('state.mjs'),
};

/* --------------------------------------------------------------------------- the control hub */

const CONNECTION = { schema_version: 1, hub: 'example-hub', platform: 'cubeapm', url: 'https://cubeapm.example.invalid' };
const REGISTRY = [{ agent_id: 'engineer' }, { agent_id: 'dual-mode-critic' }, { agent_id: 'test-writer' }];
const RECEIPT = { schema_version: 1, library: { harnessVersion: '0.9.4', libraryCommit: 'c15a998e0f1d2c3b4a5968778695a4b3c2d1e0f9' }, files: {} };
const T0 = Date.parse('2026-10-26T10:00:00Z');
const MARKER = 'MARKER-6f1c-never-on-a-record';

function write(root, rel, text) {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, text);
}

function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
}

/** A hub with a bare origin. `opts` removes or changes one part of the control. */
function makeHub(root, opts = {}) {
  const origin = join(root, 'origin.git');
  const hub = join(root, 'hub');
  mkdirSync(root, { recursive: true });
  git(root, 'init', '-q', '--bare', origin);
  git(root, 'init', '-q', hub);
  git(hub, 'checkout', '-q', '-b', 'main');
  write(hub, '.gitignore', opts.ignore === false ? '.worktrees/\n' : '.worktrees/\n.harness/\n');
  if (opts.connection !== null) write(hub, 'docs/estate/observability.json', `${JSON.stringify(opts.connection ?? CONNECTION, null, 2)}\n`);
  write(hub, 'governance/agent-registry.json', `${JSON.stringify(REGISTRY)}\n`);
  write(hub, 'docs/harness-install.json', `${JSON.stringify(RECEIPT)}\n`);
  git(hub, 'add', '-A');
  git(hub, 'commit', '-q', '-m', 'hub');
  git(hub, 'remote', 'add', 'origin', origin);
  git(hub, 'push', '-q', 'origin', 'main');
  return hub;
}

/** Counts as an adapter maps them. Unnamed counts are 0, or null where they are optional. */
const counts = (c = {}) => core.common.cleanCounts({
  input: c.input ?? 10, cache_read: c.cache_read ?? 1000, cache_write: c.cache_write ?? 100,
  cache_write_5m: c.cache_write_5m ?? c.cache_write ?? 100, cache_write_1h: c.cache_write_1h ?? 0, output: c.output ?? 50,
  reasoning: c.reasoning,
});
const call = (id, at, c, model = 'claude-opus-5-5', extra = {}) => ({ id, ms: T0 + at * 1000, model, provider: 'anthropic', counts: counts(c), ...extra });

/** Opens runs in a session's binding, as the hook does at UserPromptSubmit. */
function bind(ctx, session, runs) {
  const key = core.state.bindingKey('claude-code', session);
  const binding = core.state.loadBinding(ctx.dir, key);
  for (const r of runs) {
    const parsed = core.runs.parseCommand(r.prompt);
    core.runs.openRun(binding, { ...parsed, person: r.person ?? null }, T0 + r.at * 1000);
  }
  core.state.saveBinding(ctx.dir, key, binding);
  return binding;
}

function gather(ctx, { session = 's-1', logRef = 'log-main', seat = null, calls }) {
  return core.collect.collect({
    ctx, runtime: 'claude-code', collector: 'claude-code/1', session, logRef, seat, synthetic: true,
    read: () => ({ calls, runtimeVersion: '2.1.308' }),
  });
}

const queued = (ctx) => core.state.readyRecords(ctx.dir).map((e) => e.record);
const sum = (records, field) => records.reduce((s, r) => s + (r[field] ?? 0), 0);
const listing = (dir) => (existsSync(dir) ? readdirSync(dir) : []);

/** The control: a hub, its context, and one run of /dev-sprint PROJ-102 opened at T0. */
function control(root, opts = {}) {
  const hub = makeHub(root, opts);
  const ctx = core.config.hubContext(hub);
  if (ctx.ok) bind(ctx, 's-1', [{ prompt: '/dev-sprint PROJ-102', at: 0 }]);
  return { hub, ctx };
}

/* ------------------------------------------------------------------ Claude Code, through the hook */

const SESSION = 's-cc';
const transcriptPath = (root) => join(root, 'home', '.claude', 'projects', '-hub', `${SESSION}.jsonl`);
const seatPath = (root, agent, sub = '') => join(root, 'home', '.claude', 'projects', '-hub', SESSION, 'subagents', sub, `agent-${agent}.jsonl`);

/** A usage block as Claude Code writes it, with the 5-minute and 1-hour writes split. */
function usageBlock(u = {}) {
  const w5 = u.w5 ?? 100;
  const w1 = u.w1 ?? 0;
  return {
    input_tokens: u.input ?? 10, cache_creation_input_tokens: w5 + w1, cache_read_input_tokens: u.read ?? 1000,
    cache_creation: { ephemeral_5m_input_tokens: w5, ephemeral_1h_input_tokens: w1 }, output_tokens: u.out ?? 50, service_tier: 'standard',
  };
}

/** One assistant line of a transcript. Its text, and any tool input, carry the marker. */
function assistant(id, at, u = {}, extra = {}) {
  return JSON.stringify({
    parentUuid: null, isSidechain: extra.sidechain === true, userType: 'external', cwd: '/home/dev/hub', sessionId: SESSION,
    version: '2.1.308', gitBranch: 'main',
    message: {
      id, type: 'message', role: 'assistant', model: extra.model ?? 'claude-opus-5-5',
      content: extra.content ?? [{ type: 'text', text: `the answer ${MARKER}` }, { type: 'tool_use', id: `t-${id}`, name: 'Bash', input: { command: `cat /home/dev/${MARKER}` } }],
      stop_reason: null, usage: usageBlock(u),
    },
    requestId: `req_${id}`, type: 'assistant', uuid: `u-${id}-${Math.random().toString(16).slice(2)}`, timestamp: new Date(T0 + at * 1000).toISOString(),
  });
}

const userTurn = (at, text) => JSON.stringify({ type: 'user', message: { role: 'user', content: text }, uuid: `p-${at}`, sessionId: SESSION, timestamp: new Date(T0 + at * 1000).toISOString() });

function appendLines(path, lines, end = '\n') {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${lines.join('\n')}${end}`);
}

/** Runs the shipped hook as Claude Code does: the event on stdin, CLAUDE_PROJECT_DIR set, the clock at `at`. */
function hook(hub, event, at, runtime = 'claude-code', stdin = null, env = {}) {
  const started = Date.now();
  const r = spawnSync(process.execPath, [HOOK, runtime], {
    input: stdin ?? JSON.stringify(event), encoding: 'utf8', timeout: 30000,
    env: { ...process.env, CLAUDE_PROJECT_DIR: hub, HARNESS_OBSERVABILITY_SENDER: 'off', HARNESS_OBSERVABILITY_NOW: new Date(T0 + at * 1000).toISOString(), ...env },
  });
  return { status: r.status, out: `${r.stdout || ''}${r.stderr || ''}`, ms: Date.now() - started };
}

const ev = (root, hub, name, extra = {}) => ({ session_id: SESSION, transcript_path: transcriptPath(root), cwd: hub, hook_event_name: name, ...extra });
/** A Bash call as Claude Code passes it to PreToolUse: the command line in tool_input. */
const bash = (root, hub, command, extra = {}) => ev(root, hub, 'PreToolUse', { tool_name: 'Bash', tool_input: { command, description: MARKER }, tool_use_id: 'toolu_1', ...extra });
const runsOf = (hub, session = SESSION, runtime = 'claude-code') => core.state.loadBinding(join(hub, '.harness', 'observability'), core.state.bindingKey(runtime, session)).runs || [];
const quiet = (...runs) => runs.every((r) => r.status === 0 && r.out === '') || `the hook did not exit 0 in silence: ${runs.map((r) => `${r.status} ${r.out.slice(0, 120)}`).join(' / ')}`;

/** Every file under the hub's state folder, as text: what "never on disk" is checked against. */
function stateText(hub) {
  const out = [];
  const walk = (dir) => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else out.push(readFileSync(p, 'utf8'));
    }
  };
  walk(join(hub, '.harness'));
  return out.join('\n');
}

/** The tokens records in the hub's queue: the token counts and the cost. The work-time records are timeOf's. */
const recordsOf = (hub) => queued(core.config.hubContext(hub)).filter((r) => r.type === 'tokens');
/** The work-time records of `type` in the hub's queue, oldest first. */
const timeOf = (hub, type) => queued(core.config.hubContext(hub)).filter((r) => r.type === type);

/* -------------------------------------------------------------------- Claude Code's work time */

// The lines of Claude Code 2.1.308 that work time reads, as the first measurement found them. Their
// text and every tool input carry the marker, which must never reach the disk.
const tAt = (s) => new Date(T0 + s * 1000).toISOString();
const msAt = (s) => T0 + s * 1000;
const near = (value, expected) => typeof value === 'number' && Math.abs(value - expected) < 0.0005;
/** A prompt line of the main session: a person's (human), a seat's report (peer), or a notice (task-notification). */
const promptLine = (s, kind = 'human') => JSON.stringify({
  type: 'user', message: { role: 'user', content: `${MARKER} prompt` }, origin: { kind, ...(kind === 'peer' ? { handback: true } : {}) },
  ...(kind === 'human' ? { promptSource: 'typed' } : {}), isSidechain: false, sessionId: SESSION, version: '2.1.308', uuid: `p-${s}`, timestamp: tAt(s),
});
/** The line that opens a model call. */
const requestLine = (s, id) => JSON.stringify({ type: 'api-request', id, querySource: 'repl_main_thread', sessionId: SESSION, timestamp: tAt(s) });
/** An answer line of the model call `ref`, with tool calls as [id, name, command]. A seat's lines are sidechain lines. */
const answerLine = (s, ref, tools = [], seat = false) => JSON.stringify({
  type: 'assistant', requestRef: ref, isSidechain: seat, sessionId: SESSION, version: '2.1.308',
  message: {
    id: `msg_${ref}`, type: 'message', role: 'assistant', model: 'claude-opus-5-5', usage: usageBlock(),
    content: [{ type: 'text', text: MARKER }, ...tools.map(([id, name, command]) => ({ type: 'tool_use', id, name, input: { command: command ?? MARKER } }))],
  },
  uuid: `a-${s}-${ref}`, timestamp: tAt(s),
});
/** A failed Bash call's result, as Claude Code 2.1.308 writes it: is_error, and its text starts `Exit code <n>`. */
const failedResultLine = (s, id, text) => JSON.stringify({
  type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text, is_error: true }] },
  toolUseResult: `Error: ${text}`, isSidechain: false, sessionId: SESSION, uuid: `r-${s}-${id}`, timestamp: tAt(s),
});
/** A shell call's result that did not fail: a pipe or `; echo` after the script gave the line exit 0. */
const passedResultLine = (s, id, text) => JSON.stringify({
  type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text }] },
  toolUseResult: { stdout: text, stderr: '', interrupted: false }, isSidechain: false, sessionId: SESSION, uuid: `r-${s}-${id}`, timestamp: tAt(s),
});
/** The line that Claude Code writes itself when a model call fails and ends the turn: no usage, and the error's type. */
const apiErrorLine = (s, error) => JSON.stringify({
  type: 'assistant', error, isApiErrorMessage: true, isSidechain: false, sessionId: SESSION, version: '2.1.308',
  message: { id: `msg_err_${s}`, type: 'message', role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: `API Error: ${MARKER}` }] },
  uuid: `e-${s}`, timestamp: tAt(s),
});
/** A tool's result, with the source of its permission decision: config, or user_temporary when a person decided. */
const resultLine = (s, id, source = 'config', seat = false) => JSON.stringify({
  type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: MARKER }] },
  permissionDecision: { source, decision: 'allow' }, isSidechain: seat, sessionId: SESSION, uuid: `r-${s}-${id}`, timestamp: tAt(s),
});
/** The line that ends a turn of the main session. */
const turnEndLine = (s) => JSON.stringify({ type: 'system', subtype: 'turn_duration', durationMs: 1, messageCount: 2, isSidechain: false, sessionId: SESSION, timestamp: tAt(s) });
/** A print-mode prompt (claude -p): no origin, and `turnOrigin: "sdk"`, as Claude Code 2.1.308 writes it. */
const sdkPromptLine = (s) => JSON.stringify({ type: 'user', message: { role: 'user', content: `${MARKER} prompt` }, turnOrigin: 'sdk', entrypoint: 'sdk-cli', isSidechain: false, sessionId: SESSION, version: '2.1.308', uuid: `p-${s}`, timestamp: tAt(s) });
/** The summary after a turn's Stop hooks: in print mode, the only line that says the turn stopped. */
const stopLine = (s) => JSON.stringify({ type: 'system', subtype: 'stop_hook_summary', hookCount: 1, hookErrors: [], preventedContinuation: false, stopReason: '', entrypoint: 'sdk-cli', isSidechain: false, sessionId: SESSION, timestamp: tAt(s) });
/** A tool call that the person declined with Esc, as Claude Code 2.1.308 writes it: an error result, and no permission decision. */
const rejectedLine = (s, id) => JSON.stringify({
  type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: MARKER, is_error: true }] },
  toolUseResult: 'User rejected tool use', toolDenialKind: 'user-rejected', isSidechain: false, sessionId: SESSION, uuid: `r-${s}-${id}`, timestamp: tAt(s),
});
/** The line that Claude Code writes after a person interrupts a tool call: its own text, with no origin. */
const interruptLine = (s) => JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] }, isSidechain: false, sessionId: SESSION, uuid: `i-${s}`, timestamp: tAt(s) });
/** The line of a seat's transcript where the main session resumes the seat. */
const resumeLine = (s) => JSON.stringify({ type: 'user', message: { role: 'user', content: `${MARKER} resume` }, origin: { kind: 'coordinator' }, isSidechain: true, sessionId: SESSION, uuid: `c-${s}`, timestamp: tAt(s) });
/** The .meta.json file that Claude Code writes beside a seat's transcript. */
const seatMeta = (root, agent, type) => write(root, seatPath(root, agent).slice(root.length + 1).replace(/\.jsonl$/, '.meta.json'), `${JSON.stringify({ agentType: type })}\n`);
/** A turn of the main session: its prompt line, one model call, and its end line. */
const turnLines = (from, to, ref, kind = 'human') => [promptLine(from, kind), requestLine(from + 0.5, ref), answerLine(to, ref), turnEndLine(to + 0.1)];
/** What a fixture says when a record is not the interval it expects. */
const span = (r) => `${r.started_at ?? '-'} to ${r.ended_at ?? '-'}, ${r.duration_s} s`;
const figures = (c) => `${c.duration_s} s: busy ${c.busy_s}, wait ${c.wait_s}, unexplained ${c.unexplained_s}`;

/* ------------------------------------------------------------------------ Codex's rollout files */

const CODEX_THREAD = '019a2b3c-0000-7000-8000-00000000c0de';
const CODEX_FORK = '019a2b3c-0000-7000-8000-00000000f0f0';
const CODEX_SEAT = '019a2b3c-0000-7000-8000-0000000000e1';
const codexPath = (root, name = 'rollout-main') => join(root, 'home', '.codex', 'sessions', '2026', '10', '26', `${name}.jsonl`);
const codexLine = (at, type, payload) => JSON.stringify({ timestamp: new Date(T0 + at * 1000).toISOString(), type, payload });
/** A rollout's first line: its own thread, the CLI version and the provider. Its instructions carry the marker. */
const codexMeta = (at, thread = CODEX_THREAD) => codexLine(at, 'session_meta', { id: thread, timestamp: new Date(T0 + at * 1000).toISOString(), cwd: '/home/dev/hub', originator: 'codex_cli_rs', cli_version: '0.164.0', model_provider: 'openai', base_instructions: { text: MARKER } });
const codexContext = (at, model = 'gpt-5.5-codex') => codexLine(at, 'turn_context', { cwd: '/home/dev/hub', model, approval_policy: 'on-request' });
/**
 * One completed response, with Codex's own test values: input 100 of which 40 cached and 60 written,
 * output 10 of which reasoning 5. `u.thread` sets the running totals, which the adapter never reads.
 */
function codexUsage(at, id, u = {}, thread = CODEX_THREAD) {
  const usage = { input_tokens: 100, cached_input_tokens: 40, cache_write_input_tokens: 60, output_tokens: 10, reasoning_output_tokens: 5, total_tokens: 110 };
  const n = u.thread ?? 0;
  const total = { input_tokens: n, cached_input_tokens: n, cache_write_input_tokens: n, output_tokens: n, reasoning_output_tokens: n, total_tokens: n };
  return codexLine(at, 'token_usage_record', { thread_id: thread, turn_id: `turn-${id}`, session_id: thread, root_turn_id: `turn-${id}`, response_id: id, usage, turn_token_usage: total, thread_token_usage: total });
}
const codexEv = (root, hub, name, extra = {}) => ({ session_id: CODEX_THREAD, transcript_path: codexPath(root), cwd: hub, hook_event_name: name, ...extra });
/** A turn's start line. `agent` names the agent that started it, as a sub-agent's report does. */
const codexTurnStart = (at, turn, agent = null) => codexLine(at, 'event_msg', {
  type: 'turn_started', turn_id: turn, started_at: Math.floor(msAt(at) / 1000),
  ...(agent ? { turn_attribution: { turn_id: turn, turn_trigger: null, parent_turn_id: null, initiating_agent_path: agent, root_turn_id: null } } : {}),
});
/** A turn's end line. Its last message carries the marker. */
const codexTurnEnd = (at, turn) => codexLine(at, 'event_msg', { type: 'turn_complete', turn_id: turn, last_agent_message: MARKER, duration_ms: 1 });
/** A tool call and its output. Their arguments and output carry the marker. */
const codexCall = (at, id, name = 'shell') => codexLine(at, 'response_item', { type: 'function_call', name, arguments: JSON.stringify({ command: MARKER }), call_id: id });
const codexOutput = (at, id) => codexLine(at, 'response_item', { type: 'function_call_output', call_id: id, output: MARKER });

/* ------------------------------------------------------------------- OpenCode and its plugin */

// Two layouts: the library ships the plugin at accelerator/plugins/opencode/, and a hub holds it at .opencode/plugin/.
const PLUGIN = [
  resolve(HERE, '..', '..', '..', 'plugins', 'opencode', 'harness-observability.js'),
  resolve(HERE, '..', '..', '.opencode', 'plugin', 'harness-observability.js'),
].find((p) => existsSync(p));

const ocSession = (id, at, extra = {}) => ({ id, projectID: 'prj_1', directory: '/home/dev/hub', title: 'New session', version: '1.19.4', time: { created: T0 + at * 1000, updated: T0 + at * 1000 }, ...extra });
const ocUser = (id, at) => ({ info: { id, sessionID: 'ses_root', role: 'user', time: { created: T0 + at * 1000 } }, parts: [{ id: `${id}-t`, type: 'text', text: MARKER }] });
const ocStep = (id) => ({ id, type: 'step-finish', cost: 0.01, tokens: { input: 10, output: 40, reasoning: 10, cache: { read: 1000, write: 100 } } });
/** A tool part of OpenCode v1.19.4 that ran from `start` to `end`. Its input, output and title carry the marker. */
const ocToolPart = (id, tool, start, end) => ({
  id: `${id}-p`, type: 'tool', callID: id, tool,
  state: { status: 'completed', input: { command: MARKER }, output: MARKER, title: MARKER, metadata: {}, time: { start: msAt(start), end: msAt(end) } },
});
/** A user message of a session. Its text carries the marker. */
const ocPrompt = (session, id, at) => ({ info: { id, sessionID: session, role: 'user', time: { created: msAt(at) } }, parts: [{ id: `${id}-t`, type: 'text', text: MARKER }] });
/** One model step: an assistant message from `created` to `completed`, with the tool parts that ran inside it. */
function ocStepMessage(session, id, created, completed, tools = []) {
  return {
    info: { id, sessionID: session, role: 'assistant', time: { created: msAt(created), completed: msAt(completed) }, modelID: 'claude-opus-5-5', providerID: 'anthropic', mode: 'build', agent: 'build', cost: 0.01, tokens: { input: 10, output: 40, reasoning: 10, cache: { read: 1000, write: 100 } } },
    parts: [{ id: `${id}-s`, type: 'step-start' }, { id: `${id}-t`, type: 'text', text: MARKER }, ...tools, ocStep(`${id}-f`)],
  };
}

/** One assistant message of OpenCode v1.19.4: its text and its tool input carry the marker. */
function ocAssistant(session, id, created, completed, steps) {
  return {
    info: { id, sessionID: session, role: 'assistant', time: { created: T0 + created * 1000, completed: T0 + completed * 1000 }, modelID: 'claude-opus-5-5', providerID: 'anthropic', mode: 'build', cost: 0.01, tokens: { input: 10, output: 40, reasoning: 10, cache: { read: 1000, write: 100 } } },
    parts: [{ id: `${id}-s`, type: 'step-start' }, { id: `${id}-t`, type: 'text', text: MARKER }, { id: `${id}-u`, type: 'tool', tool: 'bash', state: { input: { command: MARKER } } }, ...steps],
  };
}

const pause = (ms) => new Promise((d) => setTimeout(d, ms));

/** Each file under the hub's state folder, with its size and time, one line each and sorted. A file that goes during the look is "gone". */
function stateLook(hub) {
  const out = [];
  const walk = (dir, rel) => {
    let names = [];
    try { names = readdirSync(dir); } catch { return; }
    for (const name of names) {
      try {
        const s = statSync(join(dir, name));
        if (s.isDirectory()) walk(join(dir, name), `${rel}${name}/`);
        else out.push(`${rel}${name} ${s.size} ${s.mtimeMs}`);
      } catch {
        out.push(`${rel}${name} gone`);
      }
    }
  };
  walk(join(hub, '.harness'), '');
  return out.sort().join('\n');
}

/**
 * Waits for the hooks that the plugin started, 10 s at most. They have finished when the state
 * folder holds no lock and no temporary file, and nothing in it changed for half a second. A hook
 * reads a log's work time after it queues its token records, so a queued record does not mean
 * that its hook ended.
 */
async function hooksDone(hub) {
  const deadline = Date.now() + 10000;
  let last = stateLook(hub);
  let since = Date.now();
  while (Date.now() < deadline && Date.now() - since < 500) {
    await pause(100);
    const now = stateLook(hub);
    if (now !== last || now.includes('.lock') || now.includes('.tmp-') || now.includes(' gone')) {
      last = now;
      since = Date.now();
    }
  }
}

/** The queued records once `n` of them are there and the hooks have finished, or what is there after 10 s. The plugin's hook runs in the background. */
async function settle(hub, n) {
  const deadline = Date.now() + 10000;
  while (recordsOf(hub).length < n && Date.now() < deadline) await pause(100);
  await hooksDone(hub);
  return recordsOf(hub);
}

/** The work-time records of `type` once `n` of them are there and the hooks have finished, or what is there after 10 s. */
async function settleTime(hub, type, n) {
  const deadline = Date.now() + 10000;
  while (timeOf(hub, type).length < n && Date.now() < deadline) await pause(100);
  await hooksDone(hub);
  return timeOf(hub, type);
}

/**
 * The plugin as OpenCode loads it: installed in the hub's .opencode/plugin/, beside the hook it
 * starts in scripts/, with a fake client that answers from `sessions` and `messages`. `command` and
 * `idle` call its two hooks with the hook's clock at `at` seconds after T0. `command` waits until
 * the hook has saved the run, or 3 s, because the plugin never waits for the hook.
 */
async function openCode(hub, { sessions = {}, messages = {}, client } = {}) {
  cpSync(CORE, join(hub, 'scripts', 'observability'), { recursive: true });
  copyFileSync(HOOK, join(hub, 'scripts', 'observability-hook.mjs'));
  copyFileSync(resolve(CORE, '..', 'spoke-remote.mjs'), join(hub, 'scripts', 'spoke-remote.mjs'));
  const plugin = join(hub, '.opencode', 'plugin', 'harness-observability.js');
  mkdirSync(dirname(plugin), { recursive: true });
  copyFileSync(PLUGIN, plugin);
  const fake = client || {
    session: {
      get: async ({ path }) => ({ data: sessions[path.id] ?? null }),
      messages: async ({ path }) => ({ data: messages[path.id] ?? [] }),
    },
  };
  const mod = await import(pathToFileURL(plugin).href);
  const hooks = await mod.HarnessObservability({ client: fake, project: { id: 'prj_1' }, directory: hub, worktree: hub, serverUrl: new URL('http://127.0.0.1:4096'), $: null });
  const clock = (at) => { process.env.HARNESS_OBSERVABILITY_NOW = new Date(T0 + at * 1000).toISOString(); };
  const runs = join(hub, '.harness', 'observability', 'runs');
  return {
    command: async (sessionID, command, args, at) => {
      const before = existsSync(runs) ? readdirSync(runs).filter((n) => n.endsWith('.json')).length : 0;
      clock(at);
      await hooks['command.execute.before']({ command, sessionID, arguments: args }, { parts: [] });
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline && (existsSync(runs) ? readdirSync(runs).filter((n) => n.endsWith('.json')).length : 0) <= before) await pause(50);
    },
    idle: async (sessionID, at) => {
      clock(at);
      await hooks.event({ event: { type: 'session.status', properties: { sessionID, status: { type: 'idle' } } } });
    },
    /** Any other event of OpenCode's bus. The plugin reads its own clock for some of them, so the clock moves too. */
    event: async (event, at) => {
      const realNow = Date.now;
      Date.now = () => msAt(at);
      try { await hooks.event({ event }); } finally { Date.now = realNow; }
    },
    tool: async (sessionID, tool, command, at, waitMs = 3000) => {
      const text = () => (existsSync(runs) ? readdirSync(runs).filter((n) => n.endsWith('.json')).map((n) => readFileSync(join(runs, n), 'utf8')).join('') : '');
      const before = text();
      clock(at);
      await hooks['tool.execute.before']({ tool, sessionID, callID: `call_${at}` }, { args: { command } });
      const deadline = Date.now() + waitMs;
      while (Date.now() < deadline && text() === before) await pause(50);
    },
  };
}

/* ---------------------------------------------------------------------------------- fixtures */

const FIXTURES = [
  {
    n: 1, name: 'the control: one run, three calls, one record',
    run: ({ root }) => {
      const { ctx } = control(root);
      const r = gather(ctx, { calls: [call('m1', 1), call('m2', 2), call('m3', 3)] });
      const recs = queued(ctx);
      const rec = recs[0] || {};
      return [
        ctx.ok || `the hub context is not ok: ${ctx.why}`,
        r.written === 1 || `wrote ${r.written} records, expected 1`,
        recs.length === 1 || `the queue holds ${recs.length} records, expected 1`,
        core.record.validateRecord(rec).length === 0 || `the record is invalid: ${core.record.validateRecord(rec).join(' · ')}`,
        rec.story === 'PROJ-102' || `story is ${rec.story}`,
        rec.command === 'dev-sprint' || `command is ${rec.command}`,
        rec.agent === 'orchestrator' || `agent is ${rec.agent}`,
        rec.schema === 'harness-observability/1' || `schema is ${rec.schema}`,
        rec.scope === 'story' && rec.key_from === 'command' || `the bucket is ${rec.scope}, ${rec.key_from}`,
        rec.calls === 3 || `calls is ${rec.calls}`,
        rec.tokens_input === 30 && rec.tokens_cache_read === 3000 && rec.tokens_cache_write === 300 && rec.tokens_output === 150 || 'the counts are not the sums of the calls',
        rec.hub === 'example-hub' || `hub is ${rec.hub}`,
        rec.harness === 'c15a998e0f1d' || `harness is ${rec.harness}`,
        !existsSync(join(CORE, 'tested.json')) || 'a list of tested versions ships again',
        rec.epic === null || 'epic is not null',
        listing(join(ctx.dir, 'queue')).every((n) => n.endsWith('.json')) || 'a .pending file was left behind',
      ];
    },
  },
  {
    n: 2, name: 'a second read with nothing new writes no record',
    run: ({ root }) => {
      const { ctx } = control(root);
      const calls = [call('m1', 1), call('m2', 2)];
      gather(ctx, { calls });
      const r = gather(ctx, { calls });
      return [r.written === 0 || `the second read wrote ${r.written} records`, queued(ctx).length === 1 || 'the queue does not hold exactly one record'];
    },
  },
  {
    n: 3, name: 'a resumed seat over two rounds: the second record carries only round 2',
    run: ({ root }) => {
      const { ctx } = control(root);
      gather(ctx, { logRef: 'agent-e1', seat: 'engineer', calls: [call('e1', 5), call('e2', 6)] });
      gather(ctx, { logRef: 'agent-e1', seat: 'engineer', calls: [call('e1', 5), call('e2', 6), call('e3', 60), call('e4', 61)] });
      const recs = queued(ctx);
      const second = recs.find((r) => r.calls === 2 && r.first_call_at === new Date(T0 + 60000).toISOString());
      return [
        recs.length === 2 || `the queue holds ${recs.length} records, expected 2`,
        Boolean(second) || 'no record holds exactly round 2',
        recs.every((r) => r.agent === 'engineer') || 'a record does not name the engineer',
        sum(recs, 'tokens_output') === 200 || `the output adds up to ${sum(recs, 'tokens_output')}, expected 200`,
      ];
    },
  },
  {
    n: 4, name: 'a call whose complete entry arrives late: the difference goes in the next record',
    run: ({ root }) => {
      const { ctx } = control(root);
      gather(ctx, { calls: [call('m1', 1, { output: 1 })] });
      gather(ctx, { calls: [call('m1', 1, { output: 500 })] });
      const recs = queued(ctx);
      const late = recs.find((r) => r.tokens_output === 499);
      return [
        recs.length === 2 || `the queue holds ${recs.length} records, expected 2`,
        Boolean(late) || 'no record carries the late 499 output tokens',
        late && late.tokens_input === 0 && late.tokens_cache_read === 0 || 'the late record repeats counts already sent',
        sum(recs, 'tokens_output') === 500 || 'the output does not add up to the complete entry',
      ];
    },
  },
  {
    n: 5, name: 'entries out of order in one read: the entry with the largest total counts',
    run: ({ root }) => {
      const { ctx } = control(root);
      gather(ctx, { calls: [call('m1', 1, { output: 500 }), call('m1', 1, { output: 1 })] });
      const recs = queued(ctx);
      return [recs.length === 1 || 'not one record', recs[0] && recs[0].tokens_output === 500 || 'the record does not carry the largest entry'];
    },
  },
  {
    n: 6, name: 'a count that goes down later is never sent as a negative',
    run: ({ root }) => {
      const { ctx } = control(root);
      gather(ctx, { calls: [call('m1', 1, { output: 500 })] });
      const r = gather(ctx, { calls: [call('m1', 1, { output: 10 })] });
      return [r.written === 0 || 'a record was written for a smaller entry', queued(ctx).every((x) => x.tokens_output >= 0) || 'a negative count was queued'];
    },
  },
  {
    n: 7, name: 'a missed event: the next read carries the missed calls',
    run: ({ root }) => {
      const { ctx } = control(root);
      gather(ctx, { calls: [call('m1', 1), call('m2', 2), call('m3', 3)] });
      const recs = queued(ctx);
      return [recs.length === 1 && recs[0].calls === 3 || 'the three calls are not in one record'];
    },
  },
  {
    n: 8, name: 'the same call id in two logs: counted once, for the first log',
    run: ({ root }) => {
      const { ctx } = control(root);
      gather(ctx, { logRef: 'log-a', calls: [call('x1', 1)] });
      gather(ctx, { logRef: 'log-b', calls: [call('x1', 1), call('y1', 2)] });
      const recs = queued(ctx);
      const b = recs.find((r) => r.log_ref === 'log-b');
      return [
        recs.length === 2 || `the queue holds ${recs.length} records, expected 2`,
        b && b.calls === 1 || 'log-b\'s record does not carry exactly one call',
        sum(recs, 'tokens_output') === 100 || 'the copied call counted twice',
      ];
    },
  },
  {
    n: 9, name: 'two runs in one read: one record for each',
    run: ({ root }) => {
      const { ctx } = control(root);
      bind(ctx, 's-1', [{ prompt: '/qa-sprint PROJ-103', at: 100 }]);
      gather(ctx, { calls: [call('m1', 1), call('m2', 101)] });
      const recs = queued(ctx);
      return [
        recs.length === 2 || `the queue holds ${recs.length} records, expected 2`,
        recs.some((r) => r.story === 'PROJ-102' && r.command === 'dev-sprint') || 'no record for the first run',
        recs.some((r) => r.story === 'PROJ-103' && r.command === 'qa-sprint') || 'no record for the second run',
      ];
    },
  },
  {
    n: 10, name: 'two models in one read: one record for each',
    run: ({ root }) => {
      const { ctx } = control(root);
      gather(ctx, { calls: [call('m1', 1), call('m2', 2, {}, 'claude-sonnet-5-5')] });
      const recs = queued(ctx);
      return [recs.length === 2 || `the queue holds ${recs.length} records`, new Set(recs.map((r) => r.model)).size === 2 || 'the records do not name two models'];
    },
  },
  {
    n: 11, name: 'calls before the first harness command are never sent, even after a run starts',
    run: ({ root }) => {
      const hub = makeHub(root);
      const ctx = core.config.hubContext(hub);
      gather(ctx, { calls: [call('early', 1)] });
      bind(ctx, 's-1', [{ prompt: '/dev-sprint PROJ-102', at: 10 }]);
      gather(ctx, { calls: [call('early', 1), call('late', 11)] });
      const recs = queued(ctx);
      return [recs.length === 1 || `the queue holds ${recs.length} records`, recs[0] && recs[0].calls === 1 && recs[0].first_call_at === new Date(T0 + 11000).toISOString() || 'the early call was sent'];
    },
  },
  {
    n: 12, name: 'a seat that started before any run sends nothing, ever',
    run: ({ root }) => {
      const hub = makeHub(root);
      const ctx = core.config.hubContext(hub);
      gather(ctx, { logRef: 'agent-x', seat: 'engineer', calls: [call('s1', 1)] });
      bind(ctx, 's-1', [{ prompt: '/dev-sprint PROJ-102', at: 10 }]);
      gather(ctx, { logRef: 'agent-x', seat: 'engineer', calls: [call('s1', 1), call('s2', 20)] });
      return [queued(ctx).length === 0 || 'the seat\'s calls were sent'];
    },
  },
  {
    n: 13, name: 'a hub without observability.json collects nothing and writes nothing',
    run: ({ root }) => {
      const hub = makeHub(root, { connection: null });
      const ctx = core.config.hubContext(hub);
      return [ctx.ok === false || 'the context is ok', (ctx.why || '').includes('observability.json') || `the reason does not name observability.json: ${ctx.why}`, !existsSync(join(hub, '.harness')) || 'the state folder exists'];
    },
  },
  {
    n: 14, name: 'a hub whose .gitignore does not cover the state folder writes nothing',
    run: ({ root }) => {
      const hub = makeHub(root, { ignore: false });
      const ctx = core.config.hubContext(hub);
      return [ctx.ok === false || 'the context is ok', (ctx.why || '').includes('.gitignore') || `the reason does not name .gitignore: ${ctx.why}`, !existsSync(join(hub, '.harness')) || 'the state folder exists'];
    },
  },
  {
    n: 15, name: 'an observability.json whose URL carries a credential is refused',
    run: ({ root }) => {
      const hub = makeHub(root, { connection: { ...CONNECTION, url: 'https://user:secret@cubeapm.example.invalid' } });
      const ctx = core.config.hubContext(hub);
      return [ctx.ok === false || 'the context is ok', !(ctx.why || '').includes('secret') || 'the reason repeats the password'];
    },
  },
  {
    n: 16, name: 'a stop between the queue write and the checkpoint write: repaired, never sent twice',
    run: ({ root }) => {
      const { ctx } = control(root);
      const calls = [call('m1', 1), call('m2', 2)];
      gather(ctx, { calls });
      const [entry] = core.state.readyRecords(ctx.dir);
      const id = entry.record.record_id;
      // What a process that stopped after the queue write leaves: the record pending, no checkpoint, no index.
      renameSync(join(ctx.dir, 'queue', `${id}.json`), join(ctx.dir, 'queue', `${id}.pending`));
      rmSync(join(ctx.dir, 'checkpoints'), { recursive: true, force: true });
      rmSync(join(ctx.dir, 'index'), { recursive: true, force: true });
      const r = gather(ctx, { calls });
      const names = listing(join(ctx.dir, 'queue'));
      return [
        r.written === 0 || `the next read wrote ${r.written} records`,
        names.length === 1 && names[0] === `${id}.json` || `the queue holds ${names.join(', ')}`,
      ];
    },
  },
  {
    n: 17, name: 'two writers at once: one record, no call twice',
    run: async ({ root }) => {
      const { hub, ctx } = control(root);
      const calls = [call('m1', 1), call('m2', 2), call('m3', 3)];
      write(root, 'calls.json', JSON.stringify(calls));
      write(root, 'drive.mjs', [
        `const { collect } = await import(${JSON.stringify(pathToFileURL(join(CORE, 'collect.mjs')).href)});`,
        `const { hubContext } = await import(${JSON.stringify(pathToFileURL(join(CORE, 'config.mjs')).href)});`,
        `const { readFileSync } = await import('node:fs');`,
        `const calls = JSON.parse(readFileSync(${JSON.stringify(join(root, 'calls.json'))}, 'utf8'));`,
        `const r = collect({ ctx: hubContext(${JSON.stringify(hub)}), runtime: 'claude-code', collector: 'claude-code/1', session: 's-1', logRef: 'log-main', synthetic: true, read: () => ({ calls }) });`,
        'process.stdout.write(JSON.stringify(r));',
      ].join('\n'));
      const one = () => new Promise((done) => {
        const p = spawn(process.execPath, [join(root, 'drive.mjs')], { env: process.env });
        let err = '';
        p.stderr.on('data', (d) => { err += d; });
        p.on('close', (code) => done({ code, err }));
      });
      const results = await Promise.all([one(), one()]);
      const recs = queued(ctx);
      return [
        results.every((x) => x.code === 0) || `a writer failed: ${results.map((x) => x.err).join(' ')}`,
        recs.length === 1 || `the queue holds ${recs.length} records, expected 1`,
        sum(recs, 'tokens_output') === 150 || `the output adds up to ${sum(recs, 'tokens_output')}, expected 150`,
      ];
    },
  },
  {
    n: 18, name: 'a record with free text where an id belongs is refused, and the log does not repeat it',
    run: ({ root }) => {
      const { ctx } = control(root);
      const r = gather(ctx, { calls: [call('m1', 1, {}, `claude opus ${MARKER}`)] });
      const log = existsSync(join(ctx.dir, 'observability.log')) ? readFileSync(join(ctx.dir, 'observability.log'), 'utf8') : '';
      const onDisk = listing(join(ctx.dir, 'queue')).map((n) => readFileSync(join(ctx.dir, 'queue', n), 'utf8')).join('');
      return [
        r.written === 0 || 'the record was queued',
        log.includes('refused before the queue') || 'observability.log does not say the record was refused',
        !log.includes(MARKER) && !onDisk.includes(MARKER) || 'the free text reached the log or the queue',
      ];
    },
  },
  {
    n: 19, name: 'price tiers: Haiku 5.5 on both sides of 100,000 prompt tokens, and fast mode',
    run: ({ root }) => {
      const { ctx } = control(root);
      gather(ctx, {
        calls: [
          call('h1', 1, { input: 50000, cache_read: 0, cache_write: 0, cache_write_5m: 0 }, 'claude-haiku-5-5'),
          call('h2', 2, { input: 20000, cache_read: 90000, cache_write: 0, cache_write_5m: 0 }, 'claude-haiku-5-5'),
          call('f1', 3, {}, 'claude-opus-5-5', { speed: 'fast' }),
        ],
      });
      const tiers = queued(ctx).map((r) => r.price_tier).sort();
      return [JSON.stringify(tiers) === JSON.stringify(['fast', 'over-100k', 'up-to-100k']) || `the tiers are ${JSON.stringify(tiers)}`];
    },
  },
  {
    n: 20, name: 'the price table: well formed, exact ids, date suffixes, never a prefix, and its costs',
    run: () => {
      const p = core.prices;
      const table = p.loadPrices();
      const rec = (over) => ({ model_provider: 'anthropic', model: 'claude-opus-5-5', price_tier: null, tokens_input: 1e6, tokens_cache_read: 1e6, tokens_cache_write: 1e6, tokens_cache_write_5m: 5e5, tokens_cache_write_1h: 5e5, tokens_output: 1e6, ...over });
      return [
        p.validatePrices(table).length === 0 || `the table is malformed: ${p.validatePrices(table).join(' · ')}`,
        Boolean(p.findModel(table, 'anthropic', 'claude-haiku-4-5-20251001')) || 'a dated id does not find its row',
        p.findModel(table, 'anthropic', 'claude-opus-5-9') === null || 'an unknown id matched a row by its prefix',
        p.costOf(table, rec({})) === 30.7 || `the cost of the control record is ${p.costOf(table, rec({}))}, expected 30.7`,
        p.costOf(table, rec({ tokens_input: 0, tokens_cache_read: 0, tokens_output: 0, tokens_cache_write_5m: null, tokens_cache_write_1h: null })) === 5 || 'a single cache-write count is not priced at the 5-minute rate',
        p.costOf(table, rec({ model: 'claude-unknown-1' })) === null || 'a model with no row got a cost',
        p.costOf(table, rec({ price_tier: 'fast', tokens_cache_write_5m: null, tokens_cache_write_1h: null, tokens_cache_write: 0 })) === 48.4 || `the fast-mode cost is ${p.costOf(table, rec({ price_tier: 'fast', tokens_cache_write_5m: null, tokens_cache_write_1h: null, tokens_cache_write: 0 }))}, expected 48.4`,
      ];
    },
  },
  {
    n: 21, name: 'the list of harness commands matches accelerator/commands/',
    run: () => {
      if (!LIBRARY_LAYOUT || !existsSync(COMMANDS_DIR)) return [true];
      const onDisk = readdirSync(COMMANDS_DIR).filter((n) => n.endsWith('.md')).map((n) => n.slice(0, -3)).sort();
      const listed = Object.keys(core.runs.COMMANDS).sort();
      return [JSON.stringify(onDisk) === JSON.stringify(listed) || `runs.mjs lists ${listed.join(', ')}, the folder holds ${onDisk.join(', ')}`];
    },
  },
  {
    n: 22, name: 'a command line gives its key and nothing else, and a branch gives a missing key',
    run: () => {
      const { parseCommand, keyFromBranch } = core.runs;
      const f = parseCommand(`/feature build a version endpoint ${MARKER}`);
      return [
        parseCommand('/dev-sprint PROJ-102')?.story === 'PROJ-102' || 'the story is not read from /dev-sprint',
        parseCommand('/project:dev-spec PROJ-7 change the thing')?.story === 'PROJ-7' || 'a namespaced command does not give its story',
        parseCommand('/dev-sprint the thing')?.story === null || 'an argument that is not a key became a story',
        f && f.command === 'feature' && f.feature === null && !JSON.stringify(f).includes(MARKER) || 'the /feature intent was kept',
        parseCommand('/decompose docs/requirements/service-version-endpoint/requirements.md')?.feature === 'service-version-endpoint' || 'the slug is not read from the document path',
        parseCommand('/pr-review 42')?.story === null || '/pr-review took its number as a story',
        parseCommand('/compact') === null || '/compact started a run',
        parseCommand('please run /dev-sprint PROJ-1') === null || 'a prompt that does not start with a command started a run',
        keyFromBranch('requirements/service-version-endpoint')?.feature === 'service-version-endpoint' || 'no feature from requirements/<SLUG>',
        keyFromBranch('feature/PROJ-102-version-endpoint')?.story === 'PROJ-102' || 'no story from feature/<KEY>-<slug>',
        keyFromBranch('harness/tracker-links-service-version-endpoint')?.feature === 'service-version-endpoint' || 'no feature from the tracker-links branch',
        keyFromBranch('main') === null || 'main gave a key',
      ];
    },
  },
  {
    n: 23, name: 'a checkpoint that cannot be read stops that log: nothing is sent again from zero',
    run: ({ root }) => {
      const { ctx } = control(root);
      gather(ctx, { calls: [call('m1', 1)] });
      const logKey = core.state.logKeyOf('claude-code', 'log-main');
      writeFileSync(core.state.checkpointPath(ctx.dir, logKey), '{ not json');
      let code = null;
      try { gather(ctx, { calls: [call('m1', 1), call('m2', 2)] }); } catch (err) { code = err.code; }
      return [code === 'unreadable' || `the collection did not stop with "unreadable" (got ${code})`, queued(ctx).length === 1 || 'a record was added'];
    },
  },
  {
    n: 24, name: 'Claude Code through the hook: a harness command, two calls, one record, nothing printed',
    run: ({ root }) => {
      const hub = makeHub(root);
      const p = hook(hub, ev(root, hub, 'UserPromptSubmit', { prompt: '/dev-sprint PROJ-102' }), 0);
      appendLines(transcriptPath(root), [userTurn(0, '/dev-sprint PROJ-102'), assistant('msg_1', 5), assistant('msg_2', 10, { w5: 0, w1: 300 })]);
      const s = hook(hub, ev(root, hub, 'Stop'), 11);
      const recs = recordsOf(hub);
      const r = recs[0] || {};
      return [
        quiet(p, s),
        recs.length === 1 || `the queue holds ${recs.length} records, expected 1`,
        r.story === 'PROJ-102' && r.command === 'dev-sprint' && r.agent === 'orchestrator' || 'the record does not belong to the main session of /dev-sprint PROJ-102',
        r.runtime === 'claude-code' && r.runtime_version === '2.1.308' && r.collector === 'claude-code/1' || 'the runtime fields are wrong',
        r.model_provider === 'anthropic' && r.model === 'claude-opus-5-5' || 'the model fields are wrong',
        r.calls === 2 && r.tokens_cache_write === 400 && r.tokens_cache_write_5m === 100 && r.tokens_cache_write_1h === 300 || 'the cache writes are not split as written',
        r.log_ref === SESSION || `log_ref is ${r.log_ref}`,
      ];
    },
  },
  {
    n: 25, name: 'one call written as several entries, a placeholder first: counted once, at its largest',
    run: ({ root }) => {
      const hub = makeHub(root);
      hook(hub, ev(root, hub, 'UserPromptSubmit', { prompt: '/dev-sprint PROJ-102' }), 0);
      appendLines(transcriptPath(root), [assistant('msg_1', 5, { out: 1 }), assistant('msg_1', 5, { out: 420 }), assistant('msg_1', 5, { out: 420 }), assistant('msg_1', 5, { out: 420 })]);
      hook(hub, ev(root, hub, 'Stop'), 6);
      const recs = recordsOf(hub);
      return [recs.length === 1 || 'not one record', recs[0] && recs[0].calls === 1 && recs[0].tokens_output === 420 && recs[0].tokens_input === 10 || 'the call did not count once, at its largest entry'];
    },
  },
  {
    n: 26, name: 'every subagent of a session with a run: a seat keeps its name, Claude Code\'s own agent is runtime-agent, and a person\'s or a plugin\'s agent is other-agent',
    run: ({ root }) => {
      const hub = makeHub(root);
      hook(hub, ev(root, hub, 'UserPromptSubmit', { prompt: '/dev-sprint PROJ-102' }), 0);
      appendLines(seatPath(root, 'e1'), [assistant('msg_e1', 5, {}, { sidechain: true }), assistant('msg_e2', 6, {}, { sidechain: true })]);
      appendLines(seatPath(root, 'x1'), [assistant('msg_x1', 7, {}, { sidechain: true })]);
      appendLines(seatPath(root, 'p1'), [assistant('msg_p1', 7, {}, { sidechain: true })]);
      appendLines(seatPath(root, 'q1'), [assistant('msg_q1', 7, {}, { sidechain: true })]);
      const stop = (id, type, at) => hook(hub, ev(root, hub, 'SubagentStop', { agent_id: id, agent_type: type, agent_transcript_path: seatPath(root, id) }), at);
      const hooks = [stop('e1', 'engineer', 8), stop('x1', 'statusline-setup', 9), stop('p1', `my-reviewer`, 9), stop('q1', `some-plugin:reviewer`, 9)];
      const recs = recordsOf(hub);
      const of = (id) => recs.find((r) => r.log_ref === id) || {};
      return [
        quiet(...hooks),
        recs.length === 4 || `the queue holds ${recs.length} records, expected 4`,
        of('e1').agent === 'engineer' && of('e1').calls === 2 && of('e1').story === 'PROJ-102' || 'the engineer\'s record is wrong',
        of('x1').agent === 'runtime-agent' && of('x1').story === 'PROJ-102' || `Claude Code's own agent is ${of('x1').agent}`,
        of('p1').agent === 'other-agent' || `a person's own agent is ${of('p1').agent}`,
        of('q1').agent === 'other-agent' || `a plugin's agent is ${of('q1').agent}`,
        !stateText(hub).includes('my-reviewer') && !stateText(hub).includes('some-plugin') || 'a person\'s or a plugin\'s agent name reached the state folder',
      ];
    },
  },
  {
    n: 27, name: 'a <synthetic> row and a sidechain copy in the main transcript are skipped: the seat counts its own call',
    run: ({ root }) => {
      const hub = makeHub(root);
      hook(hub, ev(root, hub, 'UserPromptSubmit', { prompt: '/dev-sprint PROJ-102' }), 0);
      appendLines(transcriptPath(root), [
        assistant('msg_1', 5),
        assistant('msg_syn', 6, { input: 0, read: 0, w5: 0, out: 0 }, { model: '<synthetic>' }),
        assistant('msg_side', 7, {}, { sidechain: true }),
      ]);
      appendLines(seatPath(root, 'e1'), [assistant('msg_side', 7, {}, { sidechain: true })]);
      hook(hub, ev(root, hub, 'Stop'), 8);
      hook(hub, ev(root, hub, 'SubagentStop', { agent_id: 'e1', agent_type: 'engineer', agent_transcript_path: seatPath(root, 'e1') }), 9);
      const recs = recordsOf(hub);
      const main = recs.find((r) => r.agent === 'orchestrator');
      const seat = recs.find((r) => r.agent === 'engineer');
      return [
        recs.length === 2 || `the queue holds ${recs.length} records, expected 2`,
        main && main.calls === 1 || 'the main session counted a synthetic row or a sidechain copy',
        seat && seat.calls === 1 || 'the seat did not count its own call',
        !recs.some((r) => r.model === '<synthetic>') || 'a synthetic row became a record',
      ];
    },
  },
  {
    n: 28, name: '/feature takes its slug from requirements/<SLUG>, and its intent never reaches the disk',
    run: ({ root }) => {
      const hub = makeHub(root);
      hook(hub, ev(root, hub, 'UserPromptSubmit', { prompt: `/feature build a version endpoint ${MARKER}` }), 0);
      appendLines(transcriptPath(root), [userTurn(0, `/feature build a version endpoint ${MARKER}`), assistant('msg_1', 5)]);
      hook(hub, ev(root, hub, 'Stop'), 6);
      git(hub, 'checkout', '-q', '-b', 'requirements/service-version-endpoint');
      appendLines(transcriptPath(root), [assistant('msg_2', 20)]);
      hook(hub, ev(root, hub, 'Stop'), 21);
      const recs = recordsOf(hub);
      const later = recs.find((r) => r.first_call_at === new Date(T0 + 20000).toISOString());
      const binding = core.state.loadBinding(join(hub, '.harness', 'observability'), core.state.bindingKey('claude-code', SESSION));
      return [
        recs.length === 2 || `the queue holds ${recs.length} records, expected 2`,
        recs.every((r) => r.command === 'feature' && r.story === null) || 'a record is not the /feature run\'s',
        later && later.feature === 'service-version-endpoint' || 'the record after the branch does not carry the slug',
        later && later.scope === 'feature' && later.key_from === 'branch' || 'the record after the branch does not name the feature bucket and the branch',
        binding.runs[0]?.key_from === 'branch' || 'the run does not say that its key came from the branch',
        binding.runs.length === 1 && binding.runs[0].feature === 'service-version-endpoint' || 'the run did not keep the slug',
        !stateText(hub).includes(MARKER) || 'the intent or the transcript text reached the state folder',
      ];
    },
  },
  {
    n: 29, name: 'a follow-up prompt keeps the run: no new run, both turns in one run',
    run: ({ root }) => {
      const hub = makeHub(root);
      hook(hub, ev(root, hub, 'UserPromptSubmit', { prompt: '/dev-sprint PROJ-102' }), 0);
      appendLines(transcriptPath(root), [assistant('msg_1', 5)]);
      hook(hub, ev(root, hub, 'Stop'), 6);
      hook(hub, ev(root, hub, 'UserPromptSubmit', { prompt: 'yes, continue' }), 7);
      appendLines(transcriptPath(root), [assistant('msg_2', 10)]);
      hook(hub, ev(root, hub, 'Stop'), 11);
      const recs = recordsOf(hub);
      const binding = core.state.loadBinding(join(hub, '.harness', 'observability'), core.state.bindingKey('claude-code', SESSION));
      return [binding.runs.length === 1 || `the session has ${binding.runs.length} runs`, recs.length === 2 && recs[0].run_id === recs[1].run_id || 'the two turns are not in one run'];
    },
  },
  {
    n: 30, name: 'a session with no harness command sends nothing',
    run: ({ root }) => {
      const hub = makeHub(root);
      hook(hub, ev(root, hub, 'UserPromptSubmit', { prompt: 'hello there' }), 0);
      appendLines(transcriptPath(root), [assistant('msg_1', 5)]);
      const s = hook(hub, ev(root, hub, 'Stop'), 6);
      return [quiet(s), recordsOf(hub).length === 0 || 'a record was queued'];
    },
  },
  {
    n: 31, name: 'bad input, an unknown runtime and the end of a turn in a hub without observability.json: exit 0, nothing written',
    run: ({ root }) => {
      const hub = makeHub(root);
      const bare = makeHub(join(root, 'second'), { connection: null });
      const a = hook(hub, null, 0, 'claude-code', 'not json');
      const b = hook(hub, ev(root, hub, 'Stop'), 1, 'unknown-runtime');
      const c = hook(bare, ev(root, bare, 'Stop'), 2);
      return [quiet(a, b, c), !existsSync(join(hub, '.harness')) && !existsSync(join(bare, '.harness')) || 'a state folder was written'];
    },
  },
  {
    n: 32, name: 'a half-written last line waits for the next read, and is then counted once',
    run: ({ root }) => {
      const hub = makeHub(root);
      hook(hub, ev(root, hub, 'UserPromptSubmit', { prompt: '/dev-sprint PROJ-102' }), 0);
      const third = assistant('msg_3', 7);
      appendLines(transcriptPath(root), [assistant('msg_1', 5), assistant('msg_2', 6), third.slice(0, 40)], '');
      hook(hub, ev(root, hub, 'Stop'), 8);
      const before = recordsOf(hub).reduce((s, r) => s + r.calls, 0);
      appendFileSync(transcriptPath(root), `${third.slice(40)}\n`);
      hook(hub, ev(root, hub, 'Stop'), 9);
      const after = recordsOf(hub).reduce((s, r) => s + r.calls, 0);
      return [before === 1 || before === 2 || `the first read counted ${before} calls`, before === 2 || 'the first read did not count the two complete lines', after === 3 || `after the line completed, ${after} calls were counted, expected 3`];
    },
  },
  {
    n: 33, name: 'a long transcript is read once: ten more lines take well under 1.5 s',
    run: ({ root }) => {
      const hub = makeHub(root);
      hook(hub, ev(root, hub, 'UserPromptSubmit', { prompt: '/dev-sprint PROJ-102' }), 0);
      const lines = [];
      for (let i = 0; i < 20000; i += 1) lines.push(i % 20 === 0 ? assistant(`msg_${i}`, 5 + i / 1000) : userTurn(5 + i / 1000, `tool output line ${i} ${'x'.repeat(200)}`));
      appendLines(transcriptPath(root), lines);
      const firstRead = hook(hub, ev(root, hub, 'Stop'), 100);
      appendLines(transcriptPath(root), Array.from({ length: 10 }, (_, i) => assistant(`msg_tail_${i}`, 101 + i)));
      const secondRead = hook(hub, ev(root, hub, 'Stop'), 120);
      const calls = recordsOf(hub).reduce((s, r) => s + r.calls, 0);
      return [quiet(firstRead, secondRead), calls === 1010 || `${calls} calls were counted, expected 1010`, secondRead.ms < 1500 || `the second read took ${secondRead.ms} ms`];
    },
  },
  {
    n: 34, name: 'SessionEnd reads everything a last time, a nested seat whose SubagentStop was missed included',
    run: ({ root }) => {
      const hub = makeHub(root);
      hook(hub, ev(root, hub, 'UserPromptSubmit', { prompt: '/dev-sprint PROJ-102' }), 0);
      appendLines(transcriptPath(root), [assistant('msg_1', 5)]);
      appendLines(seatPath(root, 'w1', 'workflow'), [assistant('msg_w1', 6, {}, { sidechain: true }), assistant('msg_w2', 7, {}, { sidechain: true })]);
      writeFileSync(seatPath(root, 'w1', 'workflow').replace(/\.jsonl$/, '.meta.json'), `${JSON.stringify({ agentType: 'engineer' })}\n`);
      const e = hook(hub, ev(root, hub, 'SessionEnd', { reason: 'other' }), 10);
      const recs = recordsOf(hub);
      const binding = core.state.loadBinding(join(hub, '.harness', 'observability'), core.state.bindingKey('claude-code', SESSION));
      return [
        quiet(e),
        recs.some((r) => r.agent === 'orchestrator' && r.calls === 1) || 'the main transcript was not read',
        recs.some((r) => r.agent === 'engineer' && r.calls === 2 && r.log_ref === 'w1') || 'the nested seat was not read',
        binding.ended_ms === T0 + 10000 || 'the session was not marked as ended',
      ];
    },
  },
  {
    n: 35, name: 'StopFailure reads the main transcript as Stop does',
    run: ({ root }) => {
      const hub = makeHub(root);
      hook(hub, ev(root, hub, 'UserPromptSubmit', { prompt: '/dev-sprint PROJ-102' }), 0);
      appendLines(transcriptPath(root), [assistant('msg_1', 5)]);
      const f = hook(hub, ev(root, hub, 'StopFailure', { error: 'rate_limit' }), 6);
      return [quiet(f), recordsOf(hub).length === 1 || 'no record after StopFailure'];
    },
  },
  {
    n: 36, name: 'text after the key on the command line, in the transcript and in tool inputs never reaches the disk',
    run: ({ root }) => {
      const hub = makeHub(root);
      hook(hub, ev(root, hub, 'UserPromptSubmit', { prompt: `/dev-sprint PROJ-102 ${MARKER}` }), 0);
      appendLines(transcriptPath(root), [userTurn(0, `/dev-sprint PROJ-102 ${MARKER}`), assistant('msg_1', 5)]);
      appendLines(seatPath(root, 'e1'), [assistant('msg_e1', 6, {}, { sidechain: true })]);
      hook(hub, ev(root, hub, 'Stop'), 7);
      hook(hub, ev(root, hub, 'SubagentStop', { agent_id: 'e1', agent_type: 'engineer', agent_transcript_path: seatPath(root, 'e1'), last_assistant_message: MARKER }), 8);
      const recs = recordsOf(hub);
      return [recs.length === 2 || `the queue holds ${recs.length} records`, recs.every((r) => r.story === 'PROJ-102') || 'the story is not PROJ-102', !stateText(hub).includes(MARKER) || 'the marker reached the state folder'];
    },
  },
  {
    n: 37, name: 'Codex through the hook: Codex\'s own test values give input 0, cache read 40, cache write 60, output 10 and reasoning 5, and the record says no live run confirmed the adapter',
    run: ({ root }) => {
      const hub = makeHub(root);
      const p = hook(hub, codexEv(root, hub, 'UserPromptSubmit', { prompt: '/prompts:dev-sprint PROJ-102' }), 0, 'codex');
      appendLines(codexPath(root), [codexMeta(0), codexContext(1), codexUsage(5, 'resp_1')]);
      const s = hook(hub, codexEv(root, hub, 'Stop'), 6, 'codex');
      const recs = recordsOf(hub);
      const r = recs[0] || {};
      return [
        quiet(p, s),
        recs.length === 1 || `the queue holds ${recs.length} records, expected 1`,
        r.story === 'PROJ-102' && r.command === 'dev-sprint' && r.agent === 'orchestrator' || 'the record does not belong to the main session of /dev-sprint PROJ-102',
        r.runtime === 'codex' && r.runtime_version === '0.164.0' && r.collector === 'codex/1' || 'the runtime fields are wrong',
        r.model_provider === 'openai' && r.model === 'gpt-5.5-codex' || `the model fields are ${r.model_provider} ${r.model}`,
        r.tokens_input === 0 && r.tokens_cache_read === 40 && r.tokens_cache_write === 60 && r.tokens_output === 10 && r.tokens_reasoning === 5 || 'the counts are not Codex\'s test values',
        r.log_ref === CODEX_THREAD || `log_ref is ${r.log_ref}`,
      ];
    },
  },
  {
    n: 38, name: 'a forked Codex rollout holds the lines of the thread it came from: only the file\'s own thread counts',
    run: ({ root }) => {
      const hub = makeHub(root);
      const ev = (name, extra = {}) => ({ ...codexEv(root, hub, name, extra), session_id: CODEX_FORK, transcript_path: codexPath(root, 'rollout-fork') });
      hook(hub, ev('UserPromptSubmit', { prompt: '/dev-sprint PROJ-102' }), 0, 'codex');
      appendLines(codexPath(root, 'rollout-fork'), [codexMeta(0, CODEX_FORK), codexUsage(1, 'resp_parent'), codexContext(2), codexUsage(5, 'resp_fork', {}, CODEX_FORK)]);
      hook(hub, ev('Stop'), 6, 'codex');
      const recs = recordsOf(hub);
      return [recs.length === 1 && recs[0].calls === 1 && recs[0].log_ref === CODEX_FORK || `the fork's records are ${JSON.stringify(recs.map((r) => [r.log_ref, r.calls]))}`];
    },
  },
  {
    n: 39, name: 'Codex\'s running totals are never read: a context overflow that resets them changes nothing',
    run: ({ root }) => {
      const hub = makeHub(root);
      hook(hub, codexEv(root, hub, 'UserPromptSubmit', { prompt: '/dev-sprint PROJ-102' }), 0, 'codex');
      appendLines(codexPath(root), [codexMeta(0), codexContext(1), codexUsage(5, 'resp_1', { thread: 900000 }), codexUsage(7, 'resp_2', { thread: 10 })]);
      hook(hub, codexEv(root, hub, 'Stop'), 8, 'codex');
      const recs = recordsOf(hub);
      const r = recs[0] || {};
      return [recs.length === 1 && r.calls === 2 && r.tokens_input === 0 && r.tokens_cache_read === 80 && r.tokens_cache_write === 120 && r.tokens_output === 20 || `the record is ${JSON.stringify(r)}`];
    },
  },
  {
    n: 40, name: 'a resumed Codex thread appends to its rollout past its first lines: the file\'s thread, version and model stay known, and the calls already sent are not counted again',
    run: ({ root }) => {
      const hub = makeHub(root);
      hook(hub, codexEv(root, hub, 'UserPromptSubmit', { prompt: '/dev-sprint PROJ-102' }), 0, 'codex');
      appendLines(codexPath(root), [codexMeta(0), codexContext(1), codexUsage(5, 'resp_1')]);
      hook(hub, codexEv(root, hub, 'Stop'), 6, 'codex');
      appendLines(codexPath(root), [codexUsage(25, 'resp_2'), codexUsage(26, 'resp_other', {}, CODEX_FORK)]);
      hook(hub, codexEv(root, hub, 'Stop'), 26, 'codex');
      const recs = recordsOf(hub);
      return [
        recs.length === 2 || `the queue holds ${recs.length} records, expected 2`,
        recs.every((r) => r.calls === 1) || 'a call was counted twice',
        recs.every((r) => r.runtime_version === '0.164.0' && r.model === 'gpt-5.5-codex') || 'the resumed read lost the file\'s version or model',
      ];
    },
  },
  {
    n: 41, name: 'a Codex sub-agent: the prompt its parent sends opens no run, and its SubagentStop reads its own rollout as the seat\'s',
    run: ({ root }) => {
      const hub = makeHub(root);
      hook(hub, codexEv(root, hub, 'UserPromptSubmit', { prompt: '/dev-sprint PROJ-102' }), 0, 'codex');
      hook(hub, codexEv(root, hub, 'UserPromptSubmit', { prompt: '/dev-sprint PROJ-999', agent_id: 'e1', agent_type: 'engineer' }), 2, 'codex');
      appendLines(codexPath(root, 'rollout-e1'), [codexMeta(2, CODEX_SEAT), codexContext(3), codexUsage(5, 'resp_e1', {}, CODEX_SEAT)]);
      const s = hook(hub, codexEv(root, hub, 'SubagentStop', { agent_id: 'e1', agent_type: 'engineer', agent_transcript_path: codexPath(root, 'rollout-e1') }), 6, 'codex');
      const recs = recordsOf(hub);
      const r = recs[0] || {};
      return [
        quiet(s),
        recs.length === 1 || `the queue holds ${recs.length} records, expected 1`,
        r.agent === 'engineer' && r.story === 'PROJ-102' && r.log_ref === 'e1' || `the seat's record is ${JSON.stringify({ agent: r.agent, story: r.story, log_ref: r.log_ref })}`,
      ];
    },
  },
  {
    n: 42, name: 'a Codex skill typed as $dev-sprint PROJ-102 starts the run that /dev-sprint PROJ-102 starts',
    run: ({ root }) => {
      const hub = makeHub(root);
      hook(hub, codexEv(root, hub, 'UserPromptSubmit', { prompt: '$dev-sprint PROJ-102' }), 0, 'codex');
      appendLines(codexPath(root), [codexMeta(0), codexContext(1), codexUsage(5, 'resp_1')]);
      hook(hub, codexEv(root, hub, 'SessionEnd'), 6, 'codex');
      const recs = recordsOf(hub);
      return [recs.length === 1 && recs[0].story === 'PROJ-102' && recs[0].command === 'dev-sprint' || `the records are ${JSON.stringify(recs.map((r) => [r.command, r.story]))}`];
    },
  },
  {
    n: 43, name: 'OpenCode through the plugin: a command opens the run, an idle session passes its step, and the record counts reasoning inside output',
    run: async ({ root }) => {
      const hub = makeHub(root);
      const oc = await openCode(hub, {
        sessions: { ses_root: ocSession('ses_root', 0) },
        messages: { ses_root: [ocUser('msg_u1', 1), ocAssistant('ses_root', 'msg_a1', 2, 5, [ocStep('prt_f1')])] },
      });
      await oc.command('ses_root', 'dev-sprint', `PROJ-102 ${MARKER}`, 0.5);
      await oc.idle('ses_root', 6);
      const recs = await settle(hub, 1);
      const r = recs[0] || {};
      return [
        recs.length === 1 || `the queue holds ${recs.length} records, expected 1`,
        r.story === 'PROJ-102' && r.command === 'dev-sprint' && r.agent === 'orchestrator' && r.log_ref === 'ses_root' || 'the record does not belong to the main session of /dev-sprint PROJ-102',
        r.runtime === 'opencode' && r.runtime_version === '1.19.4' && r.collector === 'opencode/1' || 'the runtime fields are wrong',
        r.model_provider === 'anthropic' && r.model === 'claude-opus-5-5' || 'the model fields are wrong',
        r.tokens_input === 10 && r.tokens_cache_read === 1000 && r.tokens_cache_write === 100 && r.tokens_output === 50 && r.tokens_reasoning === 10 || `the counts are ${JSON.stringify([r.tokens_input, r.tokens_cache_read, r.tokens_cache_write, r.tokens_output, r.tokens_reasoning])}`,
        !stateText(hub).includes(MARKER) || 'the marker reached the state folder',
      ];
    },
  },
  {
    n: 44, name: 'OpenCode passes every step again at each idle: one step reported at three idles counts once',
    run: async ({ root }) => {
      const hub = makeHub(root);
      const oc = await openCode(hub, {
        sessions: { ses_root: ocSession('ses_root', 0) },
        messages: { ses_root: [ocAssistant('ses_root', 'msg_a1', 2, 5, [ocStep('prt_f1')])] },
      });
      await oc.command('ses_root', 'dev-sprint', 'PROJ-102', 0.5);
      await oc.idle('ses_root', 6);
      await settle(hub, 1);
      await oc.idle('ses_root', 7);
      await oc.idle('ses_root', 8);
      await pause(2000);
      const recs = recordsOf(hub);
      return [recs.length === 1 && recs[0].calls === 1 || `the queue holds ${recs.length} records`];
    },
  },
  {
    n: 45, name: 'an OpenCode fork copies the messages of the session it came from: the copies are skipped, and its own step counts',
    run: async ({ root }) => {
      const hub = makeHub(root);
      const oc = await openCode(hub, {
        sessions: { ses_fork: ocSession('ses_fork', 100) },
        messages: { ses_fork: [ocAssistant('ses_fork', 'msg_c1', 2, 5, [ocStep('prt_c1')]), ocAssistant('ses_fork', 'msg_f1', 102, 105, [ocStep('prt_f1')])] },
      });
      await oc.command('ses_fork', 'dev-sprint', 'PROJ-102', 101);
      await oc.idle('ses_fork', 106);
      const recs = await settle(hub, 1);
      return [recs.length === 1 && recs[0].calls === 1 && recs[0].log_ref === 'ses_fork' || `the fork's records are ${JSON.stringify(recs.map((r) => r.calls))}`];
    },
  },
  {
    n: 46, name: 'an OpenCode child session is a seat: named by the @name in its title, its calls join the run of its root session',
    run: async ({ root }) => {
      const hub = makeHub(root);
      const oc = await openCode(hub, {
        sessions: { ses_root: ocSession('ses_root', 0), ses_child: ocSession('ses_child', 3, { parentID: 'ses_root', title: `${MARKER} (@test-writer subagent)` }) },
        messages: { ses_child: [ocAssistant('ses_child', 'msg_s1', 4, 6, [ocStep('prt_s1')])] },
      });
      await oc.command('ses_root', 'dev-sprint', 'PROJ-102', 0.5);
      await oc.idle('ses_child', 7);
      const recs = await settle(hub, 1);
      const r = recs[0] || {};
      return [
        recs.length === 1 || `the queue holds ${recs.length} records, expected 1`,
        r.agent === 'test-writer' && r.story === 'PROJ-102' && r.log_ref === 'ses_child' || `the seat's record is ${JSON.stringify({ agent: r.agent, story: r.story, log_ref: r.log_ref })}`,
        !stateText(hub).includes(MARKER) || 'the title reached the state folder',
      ];
    },
  },
  {
    n: 47, name: 'an OpenCode child session that the agent registry does not list: OpenCode\'s own agent is runtime-agent, and any other is other-agent',
    run: async ({ root }) => {
      const hub = makeHub(root);
      const oc = await openCode(hub, {
        sessions: {
          ses_root: ocSession('ses_root', 0),
          ses_child: ocSession('ses_child', 3, { parentID: 'ses_root', title: 'Look around (@explore subagent)' }),
          ses_mine: ocSession('ses_mine', 3, { parentID: 'ses_root', title: 'Help (@my-helper subagent)' }),
        },
        messages: { ses_child: [ocAssistant('ses_child', 'msg_s1', 4, 6, [ocStep('prt_s1')])], ses_mine: [ocAssistant('ses_mine', 'msg_m1', 4, 6, [ocStep('prt_m1')])] },
      });
      await oc.command('ses_root', 'dev-sprint', 'PROJ-102', 0.5);
      await oc.idle('ses_child', 7);
      await oc.idle('ses_mine', 8);
      const recs = await settle(hub, 2);
      const of = (id) => recs.find((r) => r.log_ref === id) || {};
      return [
        recs.length === 2 || `the queue holds ${recs.length} records, expected 2`,
        of('ses_child').agent === 'runtime-agent' && of('ses_child').story === 'PROJ-102' || `OpenCode's own agent is ${of('ses_child').agent}`,
        of('ses_mine').agent === 'other-agent' || `a person's own agent is ${of('ses_mine').agent}`,
        !stateText(hub).includes('my-helper') || 'a person\'s agent name reached the state folder',
      ];
    },
  },
  {
    n: 48, name: 'the hook opens an OpenCode run at the time the plugin saw the command, so a call made before the hook ran still joins it',
    run: ({ root }) => {
      const hub = makeHub(root);
      const at = (s) => T0 + s * 1000;
      const cmd = hook(hub, { hook_event_name: 'command', session_id: 'ses_root', name: 'dev-sprint', arguments: 'PROJ-102', at: at(5), cwd: hub }, 10, 'opencode');
      const calls = [{ id: 'prt_f1', ms: at(6), model: 'claude-opus-5-5', provider: 'anthropic', tokens: { input: 10, output: 40, reasoning: 10, cache: { read: 1000, write: 100 } } }];
      const idle = hook(hub, { hook_event_name: 'idle', session_id: 'ses_root', log_ref: 'ses_root', parent: null, seat: null, version: '1.19.4', calls, cwd: hub }, 12, 'opencode');
      const far = hook(hub, { hook_event_name: 'command', session_id: 'ses_two', name: 'dev-sprint', arguments: 'PROJ-103', at: at(-3600), cwd: hub }, 20, 'opencode');
      const late = [{ ...calls[0], id: 'prt_f2', ms: at(15) }];
      hook(hub, { hook_event_name: 'idle', session_id: 'ses_two', log_ref: 'ses_two', parent: null, seat: null, version: '1.19.4', calls: late, cwd: hub }, 21, 'opencode');
      const recs = recordsOf(hub);
      return [
        quiet(cmd, idle, far),
        recs.some((r) => r.story === 'PROJ-102' && r.calls === 1) || 'the call made after the plugin saw the command did not join its run',
        !recs.some((r) => r.story === 'PROJ-103') || 'a time an hour from the hook\'s clock opened the run at that time',
      ];
    },
  },
  {
    n: 49, name: 'an OpenCode client that fails: the plugin\'s hooks still return, and nothing is written',
    run: async ({ root }) => {
      const hub = makeHub(root);
      const fail = async () => { throw new Error('server gone'); };
      const oc = await openCode(hub, { client: { session: { get: fail, messages: fail } } });
      let threw = null;
      try {
        await oc.command('ses_root', 'dev-sprint', 'PROJ-102', 0.5);
        await oc.idle('ses_root', 6);
      } catch (err) {
        threw = err;
      }
      await pause(2000);
      const recs = recordsOf(hub);
      return [threw === null || `a hook threw: ${threw.message}`, recs.length === 0 || 'records were written'];
    },
  },
  {
    n: 50, name: 'the OpenCode plugin passes the hook ids, times, model names and counts: no message text, no title, no tool input and no copy a fork made',
    run: async ({ root }) => {
      const hub = makeHub(root);
      const oc = await openCode(hub, {
        sessions: {
          ses_fork: ocSession('ses_fork', 100, { title: `${MARKER} (fork #1)` }),
          ses_child: ocSession('ses_child', 103, { parentID: 'ses_fork', title: `${MARKER} (@test-writer subagent)` }),
        },
        messages: {
          ses_fork: [ocUser('msg_u1', 1), ocAssistant('ses_fork', 'msg_c1', 2, 5, [ocStep('prt_c1')]), ocAssistant('ses_fork', 'msg_f1', 102, 105, [ocStep('prt_f1')])],
          ses_child: [ocAssistant('ses_child', 'msg_s1', 104, 106, [ocStep('prt_s1')])],
        },
      });
      // A recorder in the hook's place keeps what the plugin passes on stdin.
      const seen = join(root, 'payloads.jsonl');
      writeFileSync(join(hub, 'scripts', 'observability-hook.mjs'), `import { appendFileSync } from 'node:fs';\nlet raw = '';\nprocess.stdin.on('data', (c) => { raw += c; });\nprocess.stdin.on('end', () => appendFileSync(${JSON.stringify(seen)}, \`\${raw}\\n\`));\n`);
      await oc.idle('ses_fork', 106);
      await oc.idle('ses_child', 107);
      const lines = () => (existsSync(seen) ? readFileSync(seen, 'utf8').split('\n').filter(Boolean) : []);
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline && lines().length < 2) await pause(100);
      const payloads = lines().map((l) => JSON.parse(l));
      const fork = payloads.find((p) => p.log_ref === 'ses_fork') || {};
      const child = payloads.find((p) => p.log_ref === 'ses_child') || {};
      return [
        payloads.length === 2 || `the plugin passed ${payloads.length} payloads, expected 2`,
        JSON.stringify((fork.calls || []).map((c) => c.id)) === '["prt_f1"]' || `the fork passed the calls ${JSON.stringify((fork.calls || []).map((c) => c.id))}`,
        child.seat === 'test-writer' && child.session_id === 'ses_fork' && child.parent === 'ses_fork' || `the child passed ${JSON.stringify({ seat: child.seat, session_id: child.session_id, parent: child.parent })}`,
        !payloads.some((p) => JSON.stringify(p).includes(MARKER)) || 'text, a title or a tool input reached the hook',
      ];
    },
  },
  {
    n: 51, name: 'no record carries a tested flag, the record rules refuse one, and no adapter states one',
    run: async ({ root }) => {
      const { ctx } = control(root);
      gather(ctx, { calls: [call('m1', 1)] });
      const recs = queued(ctx);
      const adapters = await Promise.all(['claude-code', 'codex', 'opencode'].map(async (n) => import(pathToFileURL(join(CORE, 'collectors', `${n}.mjs`)).href)));
      const flags = ['TESTED', 'TIME_TESTED', 'FAILURES_TESTED'];
      return [
        recs.length === 1 && !('collector_tested' in recs[0]) || 'a record carries collector_tested',
        recs.length === 1 && core.record.validateRecord({ ...recs[0], collector_tested: true }).some((p) => p.startsWith('field collector_tested is not allowed')) || 'a record with collector_tested passed the record rules',
        adapters.every((a) => !flags.some((k) => k in a)) || 'an adapter still states a tested flag',
      ];
    },
  },
  {
    n: 52, name: 'a seat\'s call that reaches the disk after its SubagentStop is read at the next Stop',
    run: ({ root }) => {
      const hub = makeHub(root);
      hook(hub, ev(root, hub, 'UserPromptSubmit', { prompt: '/dev-sprint PROJ-102' }), 0);
      appendLines(seatPath(root, 'e1'), [assistant('msg_e1', 5, {}, { sidechain: true })]);
      const a = hook(hub, ev(root, hub, 'SubagentStop', { agent_id: 'e1', agent_type: 'engineer', agent_transcript_path: seatPath(root, 'e1') }), 6);
      appendLines(seatPath(root, 'e1'), [assistant('msg_e2', 6, {}, { sidechain: true })]);
      appendLines(transcriptPath(root), [assistant('msg_1', 8)]);
      const b = hook(hub, ev(root, hub, 'Stop'), 9);
      const recs = recordsOf(hub);
      const seat = recs.filter((r) => r.agent === 'engineer').reduce((n, r) => n + r.calls, 0);
      return [quiet(a, b), seat === 2 || `the seat's records hold ${seat} calls before the session ends, expected 2`, recs.some((r) => r.agent === 'orchestrator') || 'the main session has no record'];
    },
  },
  {
    n: 53, name: 'the main session\'s call that reaches the disk after its Stop is read at the next prompt, in its own run',
    run: ({ root }) => {
      const hub = makeHub(root);
      hook(hub, ev(root, hub, 'UserPromptSubmit', { prompt: '/dev-sprint PROJ-102' }), 0);
      appendLines(transcriptPath(root), [assistant('msg_1', 5)]);
      const a = hook(hub, ev(root, hub, 'Stop'), 6);
      appendLines(transcriptPath(root), [assistant('msg_2', 6)]);
      const b = hook(hub, ev(root, hub, 'UserPromptSubmit', { prompt: '/dev-spec PROJ-103' }), 30);
      const recs = recordsOf(hub);
      const first = recs.filter((r) => r.story === 'PROJ-102').reduce((n, r) => n + r.calls, 0);
      return [quiet(a, b), first === 2 || `the first run's records hold ${first} calls, expected 2`, !recs.some((r) => r.story === 'PROJ-103') || 'a call of the first run went to the second'];
    },
  },
  {
    n: 54, name: 'the price table\'s other providers: an alias reads Anthropic\'s rows, OpenAI\'s dated ids and 30-minute writes, a row with no write rate, and the 272K and 200K tiers',
    run: () => {
      const p = core.prices;
      const table = p.loadPrices();
      const rec = (over) => ({ model_provider: 'openai', model: 'gpt-6.1-sol', price_tier: 'up-to-272k', tokens_input: 1e6, tokens_cache_read: 1e6, tokens_cache_write: 1e6, tokens_cache_write_5m: null, tokens_cache_write_1h: null, tokens_output: 1e6, ...over });
      const opus = { model_provider: 'foundry', model: 'claude-opus-5-5', price_tier: null, tokens_input: 1e6, tokens_cache_read: 1e6, tokens_cache_write: 1e6, tokens_cache_write_5m: 5e5, tokens_cache_write_1h: 5e5, tokens_output: 1e6 };
      const broken = { ...table, aliases: { ...table.aliases, azure: 'nowhere' } };
      return [
        p.costOf(table, opus) === 30.7 || `a Foundry record costs ${p.costOf(table, opus)}, expected Anthropic's 30.7`,
        p.costOf(table, rec({})) === 14.6 || `a GPT-6.1 Sol record costs ${p.costOf(table, rec({}))}, expected 14.6 with its write at the 30-minute rate`,
        p.costOf(table, rec({ model: 'gpt-4.1-2025-04-14', price_tier: null })) === 12.5 || 'a dated OpenAI id, or a write on a row with no write rate, is priced wrongly',
        p.findModel(table, 'openai', 'gpt-5.5-codex') === null || 'an OpenAI id matched a row by its prefix',
        p.tierOf(table, 'openai', 'gpt-5.5', { input: 272000 }, null) === 'up-to-272k' && p.tierOf(table, 'openai', 'gpt-5.5', { input: 272001 }, null) === 'over-272k' || 'the 272K limit is wrong',
        p.tierOf(table, 'google', 'gemini-2.5-pro', { input: 150000, cache_read: 50001 }, null) === 'over-200k' || 'the 200K limit does not count cache reads',
        p.costOf(table, rec({ model_provider: 'bedrock', model: 'claude-opus-5-5', price_tier: null })) === null || 'a Bedrock record got a guessed cost',
        p.validatePrices(broken).some((x) => x.includes('alias azure points to no provider')) || 'an alias to no provider was allowed',
      ];
    },
  },
  {
    n: 55, name: 'the hook starts the sender with NODE_USE_SYSTEM_CA=1, so Node also trusts the system\'s certificate authorities',
    run: async ({ root }) => {
      const hub = makeHub(root);
      // The hook as a hub holds it, beside a stand-in sender that writes down how it was started.
      cpSync(CORE, join(hub, 'scripts', 'observability'), { recursive: true });
      copyFileSync(HOOK, join(hub, 'scripts', 'observability-hook.mjs'));
      copyFileSync(resolve(CORE, '..', 'spoke-remote.mjs'), join(hub, 'scripts', 'spoke-remote.mjs'));
      const seen = join(root, 'sender-start.json');
      // It writes a temporary file and renames it, so the fixture never reads half a file.
      write(hub, 'scripts/observability-send.mjs', `import { renameSync, writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(`${seen}.tmp`)}, JSON.stringify({ ca: process.env.NODE_USE_SYSTEM_CA ?? null, args: process.argv.slice(2) }));\nrenameSync(${JSON.stringify(`${seen}.tmp`)}, ${JSON.stringify(seen)});\n`);
      const env = { ...process.env, CLAUDE_PROJECT_DIR: hub };
      delete env.HARNESS_OBSERVABILITY_SENDER;
      delete env.NODE_USE_SYSTEM_CA;
      const fire = (event, at) => spawnSync(process.execPath, [join(hub, 'scripts', 'observability-hook.mjs'), 'claude-code'], {
        input: JSON.stringify(event), encoding: 'utf8', timeout: 30000, env: { ...env, HARNESS_OBSERVABILITY_NOW: new Date(T0 + at * 1000).toISOString() },
      });
      const p = fire(ev(root, hub, 'UserPromptSubmit', { prompt: '/dev-sprint PROJ-102' }), 0);
      appendLines(transcriptPath(root), [userTurn(0, '/dev-sprint PROJ-102'), assistant('msg_1', 5)]);
      const s = fire(ev(root, hub, 'Stop'), 6);
      // The hook starts the sender in the background and returns at once, so the fixture waits for it.
      const deadline = Date.now() + 10000;
      while (!existsSync(seen) && Date.now() < deadline) await pause(100);
      const start = existsSync(seen) ? JSON.parse(readFileSync(seen, 'utf8')) : null;
      return [
        p.status === 0 && s.status === 0 || 'the hook did not exit 0',
        start !== null || 'the hook did not start the sender',
        start === null || start.ca === '1' || `the sender started with NODE_USE_SYSTEM_CA=${start.ca}`,
        start === null || start.args[0] === '--hub' || `the sender started with ${JSON.stringify(start.args)}`,
      ];
    },
  },
  {
    n: 56, name: 'every record names its bucket and its key\'s source: a story from the command line or the branch, a feature from its document, estate work, and a story command with no key',
    run: ({ root }) => {
      const hub = makeHub(root);
      const turn = (prompt, at, id) => {
        const p = hook(hub, ev(root, hub, 'UserPromptSubmit', { prompt }), at);
        appendLines(transcriptPath(root), [userTurn(at, prompt), assistant(id, at + 5)]);
        return [p, hook(hub, ev(root, hub, 'Stop'), at + 6)];
      };
      const hooks = [
        ...turn('/dev-sprint PROJ-102', 0, 'msg_a'),
        ...turn('/add-repo', 10, 'msg_b'),
        ...turn('/dev-sprint', 20, 'msg_c'),
        ...turn('/decompose docs/requirements/service-version-endpoint/requirements.md', 30, 'msg_d'),
      ];
      git(hub, 'checkout', '-q', '-b', 'feature/PROJ-7-version-endpoint');
      hooks.push(...turn('/qa-sprint', 40, 'msg_e'));
      const recs = recordsOf(hub);
      const at = (s) => recs.find((r) => r.first_call_at === new Date(T0 + s * 1000).toISOString()) || {};
      const bucket = (r) => JSON.stringify([r.scope, r.key_from, r.story, r.feature]);
      const want = [
        [5, 'a story from its command line', ['story', 'command', 'PROJ-102', null]],
        [15, 'estate work', ['estate', null, null, null]],
        [25, 'a story command with no key', ['none', null, null, null]],
        [35, 'a feature from its document', ['feature', 'command', null, 'service-version-endpoint']],
        [45, 'a story from its branch', ['story', 'branch', 'PROJ-7', null]],
      ];
      return [
        quiet(...hooks),
        recs.length === 5 || `the queue holds ${recs.length} records, expected 5`,
        recs.every((r) => core.record.validateRecord(r).length === 0) || `a record is invalid: ${recs.map((r) => core.record.validateRecord(r).join(' · ')).filter(Boolean).join(' / ')}`,
        recs.every((r) => r.schema === 'harness-observability/1' && r.agent === 'orchestrator') || 'a record is not harness-observability/1, or its main session is not orchestrator',
        ...want.map(([s, what, b]) => bucket(at(s)) === JSON.stringify(b) || `${what} gave ${bucket(at(s))}, expected ${JSON.stringify(b)}`),
      ];
    },
  },
  {
    n: 57, name: 'the record rules refuse a bucket that disagrees with the key, and a key source that is not one of the four',
    run: ({ root }) => {
      const { ctx } = control(root);
      gather(ctx, { calls: [call('m1', 1)] });
      const good = queued(ctx)[0] || {};
      const refused = (change) => core.record.validateRecord({ ...good, ...change }).some((p) => p.startsWith('field scope') || p.startsWith('field key_from'));
      const { bucketOf } = core.runs;
      return [
        core.record.validateRecord(good).length === 0 || `the control record is invalid: ${core.record.validateRecord(good).join(' · ')}`,
        good.scope === 'story' && good.key_from === 'command' || `the control record's bucket is ${good.scope}, ${good.key_from}`,
        refused({ story: null }) || 'a story record with no story passed',
        refused({ scope: 'estate' }) || 'an estate record with a story passed',
        refused({ scope: 'feature', feature: 'service-version-endpoint' }) || 'a feature record with a story passed',
        refused({ scope: 'none', story: null, key_from: 'branch' }) || 'a record with no key and a key source passed',
        refused({ key_from: 'guess' }) || 'a key source that is not one of the four passed',
        refused({ scope: 'everything' }) || 'a scope that is not one of the four passed',
        !refused({ key_from: null }) || 'a story record of a run that predates the key source was refused',
        JSON.stringify(bucketOf({ command: 'add-repo', story: null, feature: null }, null)) === '{"scope":"estate","key_from":null}' || 'a record without its run is not estate work by its command',
        JSON.stringify(bucketOf({ command: 'dev-sprint', story: null, feature: null }, null)) === '{"scope":"none","key_from":null}' || 'a story command without its run and its key is not in the bucket none',
        JSON.stringify(bucketOf({ command: 'dev-sprint', story: 'PROJ-102', feature: null, key_from: 'branch' }, null)) === '{"scope":"story","key_from":"branch"}' || 'a record without its run lost its own key source',
      ];
    },
  },
  {
    n: 58, name: 'the key from the work: a story command typed without its key, then the key answered as a plain message, takes the story that check-dev-ready.js names',
    run: ({ root }) => {
      const hub = makeHub(root);
      const hooks = [hook(hub, ev(root, hub, 'UserPromptSubmit', { prompt: '/dev-sprint' }), 0)];
      appendLines(transcriptPath(root), [userTurn(0, '/dev-sprint'), assistant('msg_1', 5)]);
      hooks.push(hook(hub, ev(root, hub, 'Stop'), 6));
      hooks.push(hook(hub, ev(root, hub, 'UserPromptSubmit', { prompt: 'PROJ-102' }), 7));
      hooks.push(hook(hub, bash(root, hub, `HARNESS_TRUNK=main HARNESS_REPO=example-api node scripts/check-dev-ready.js PROJ-102 # ${MARKER}`), 8));
      appendLines(transcriptPath(root), [userTurn(7, 'PROJ-102'), assistant('msg_2', 10)]);
      hooks.push(hook(hub, ev(root, hub, 'Stop'), 11));
      const runs = runsOf(hub);
      const later = recordsOf(hub).find((r) => r.first_call_at === new Date(T0 + 10000).toISOString()) || {};
      return [
        quiet(...hooks),
        runs.length === 1 || `the session has ${runs.length} runs, expected 1: the plain message opened a run`,
        runs[0]?.story === 'PROJ-102' && runs[0]?.key_from === 'work' || `the run's key is ${runs[0]?.story}, from ${runs[0]?.key_from}`,
        later.story === 'PROJ-102' && later.scope === 'story' && later.key_from === 'work' || `the record after the work is ${later.story}, ${later.scope}, ${later.key_from}`,
        !stateText(hub).includes(MARKER) || 'the rest of the command line reached the state folder',
      ];
    },
  },
  {
    n: 59, name: 'the work on another story opens a run for that story from that moment: the calls before it stay on the first story',
    run: ({ root }) => {
      const hub = makeHub(root);
      const hooks = [hook(hub, ev(root, hub, 'UserPromptSubmit', { prompt: '/dev-sprint PROJ-102' }), 0)];
      appendLines(transcriptPath(root), [userTurn(0, '/dev-sprint PROJ-102'), assistant('msg_1', 5)]);
      hooks.push(hook(hub, ev(root, hub, 'Stop'), 6));
      hooks.push(hook(hub, bash(root, hub, 'node scripts/check-dev-ready.js PROJ-102'), 7));
      hooks.push(hook(hub, bash(root, hub, 'HARNESS_TRUNK=main node scripts/check-validation.mjs PROJ-7'), 8));
      appendLines(transcriptPath(root), [assistant('msg_2', 10)]);
      hooks.push(hook(hub, ev(root, hub, 'Stop'), 11));
      const runs = runsOf(hub);
      const recs = recordsOf(hub);
      const at = (sec) => recs.find((r) => r.first_call_at === new Date(T0 + sec * 1000).toISOString()) || {};
      return [
        quiet(...hooks),
        runs.length === 2 || `the session has ${runs.length} runs, expected 2: the same story's work opened a run, or the other story's did not`,
        runs[1]?.command === 'dev-sprint' && runs[1]?.story === 'PROJ-7' && runs[1]?.key_from === 'work' && runs[1]?.started_ms === T0 + 8000 || `the second run is ${JSON.stringify(runs[1])}`,
        runs[0]?.ended_ms === T0 + 8000 && runs[0]?.story === 'PROJ-102' || 'the first run did not end where the second one starts, or lost its key',
        at(5).story === 'PROJ-102' && at(5).key_from === 'command' || `the call before the work is on ${at(5).story}`,
        at(10).story === 'PROJ-7' && at(10).key_from === 'work' && at(10).run_id === runs[1]?.run_id || `the call after the work is on ${at(10).story}`,
      ];
    },
  },
  {
    n: 60, name: 'a feature run and estate work never take a key from the work, and a shell call that runs no harness script changes nothing',
    run: ({ root }) => {
      const { keyFromWork } = core.runs;
      const hub = makeHub(root);
      const hooks = [hook(hub, ev(root, hub, 'UserPromptSubmit', { prompt: '/decompose docs/requirements/service-version-endpoint/requirements.md' }), 0)];
      hooks.push(hook(hub, bash(root, hub, 'node scripts/check-dev-ready.js PROJ-9'), 2));
      hooks.push(hook(hub, ev(root, hub, 'UserPromptSubmit', { prompt: '/add-repo' }), 10));
      hooks.push(hook(hub, bash(root, hub, 'node scripts/jira-sync.mjs apply PROJ-9'), 12));
      hooks.push(hook(hub, ev(root, hub, 'UserPromptSubmit', { prompt: '/dev-sprint' }), 20));
      const quietCall = hook(hub, bash(root, hub, `ls -la ${MARKER}`), 22);
      hooks.push(quietCall);
      const runs = runsOf(hub);
      const lines = {
        env: 'HARNESS_TRUNK=main HARNESS_REPO=example-api node scripts/check-dev-ready.js PROJ-102',
        module: 'node scripts/check-dev-ready.mjs "PROJ-102"',
        amend: 'node scripts/check-design-amend.mjs PROJ-102 && git status',
        jira: 'node scripts/jira-sync.mjs apply PROJ-102',
        guard: 'node scripts/test-guard.mjs setup --controller .worktrees/PROJ-102/example-api --key PROJ-102 \\\n  --subject "fix(PROJ-102): x"',
        equals: 'node scripts/test-guard.mjs setup --key=PROJ-102',
        first: 'node scripts/check-validation.js PROJ-7; node scripts/check-dev-ready.js PROJ-102',
      };
      const none = {
        'no key': 'node scripts/check-dev-ready.js',
        'a key with more after it': 'node scripts/check-dev-ready.js PROJ-102x',
        'jira-sync create': 'node scripts/jira-sync.mjs create PROJ-102',
        'test-guard check': 'node scripts/test-guard.mjs check --key PROJ-102',
        'a --key after another command': 'node scripts/test-guard.mjs setup --controller x; echo --key PROJ-102',
        'another script': 'node scripts/check-decomposition.js PROJ-102',
      };
      return [
        quiet(...hooks),
        runs.length === 3 && runs.every((r) => r.story === null && r.key_from !== 'work') || `a run took a key from the work: ${JSON.stringify(runs.map((r) => [r.command, r.story, r.key_from]))}`,
        runs[0]?.feature === 'service-version-endpoint' || 'the feature run lost its feature',
        ...Object.entries(lines).map(([name, line]) => keyFromWork(line) === (name === 'first' ? 'PROJ-7' : 'PROJ-102') || `the ${name} form gave ${keyFromWork(line)}`),
        ...Object.entries(none).map(([name, line]) => keyFromWork(line) === null || `${name} gave ${keyFromWork(line)}`),
        !stateText(hub).includes(MARKER) || 'a shell call\'s text reached the state folder',
      ];
    },
  },
  {
    n: 61, name: 'Codex: a Bash PreToolUse that runs a harness script gives a keyless story run its key, from a string or a list of words',
    run: ({ root }) => {
      const hub = makeHub(root);
      const p = hook(hub, codexEv(root, hub, 'UserPromptSubmit', { prompt: '$dev-sprint' }), 0, 'codex');
      const pre = (command, at) => hook(hub, codexEv(root, hub, 'PreToolUse', { turn_id: 'turn-1', model: 'gpt-5.5-codex', permission_mode: 'default', tool_name: 'Bash', tool_input: { command }, tool_use_id: 'call_1' }), at, 'codex');
      const a = pre('node scripts/check-dev-ready.js PROJ-102', 2);
      const first = runsOf(hub, CODEX_THREAD, 'codex');
      const q = hook(hub, codexEv(root, hub, 'UserPromptSubmit', { prompt: '$qa-sprint' }), 10, 'codex');
      const b = pre(['node', 'scripts/check-validation.js', 'PROJ-7'], 12);
      const runs = runsOf(hub, CODEX_THREAD, 'codex');
      return [
        quiet(p, a, q, b),
        first.length === 1 && first[0].story === 'PROJ-102' && first[0].key_from === 'work' || `the run took ${first[0]?.story}, from ${first[0]?.key_from}`,
        runs.length === 2 && runs[1].command === 'qa-sprint' && runs[1].story === 'PROJ-7' && runs[1].key_from === 'work' || `the list form gave ${runs[1]?.story}`,
      ];
    },
  },
  {
    n: 62, name: 'OpenCode: the plugin passes a bash call that runs a harness script, and only that one, and the hook gives the run its key',
    run: async ({ root }) => {
      const hub = makeHub(root);
      const oc = await openCode(hub, { sessions: { ses_root: ocSession('ses_root', 0) } });
      await oc.command('ses_root', 'dev-sprint', '', 0.5);
      await oc.tool('ses_root', 'bash', `ls ${MARKER}`, 1, 500);
      await oc.tool('ses_root', 'read', 'node scripts/check-dev-ready.js PROJ-9', 2, 500);
      const before = runsOf(hub, 'ses_root', 'opencode');
      await oc.tool('ses_root', 'bash', `node scripts/check-dev-ready.js PROJ-102 ${MARKER}`, 3);
      const runs = runsOf(hub, 'ses_root', 'opencode');
      return [
        before.length === 1 && before[0].story === null || `a call that is not a harness script's bash call changed the run: ${JSON.stringify(before.map((r) => r.story))}`,
        runs.length === 1 && runs[0].story === 'PROJ-102' && runs[0].key_from === 'work' || `the run took ${runs[0]?.story}, from ${runs[0]?.key_from}`,
        !stateText(hub).includes(MARKER) || 'a command line\'s text reached the state folder',
      ];
    },
  },
  {
    n: 63, name: 'the same story command typed again with its key within 10 minutes: the run before it, which had none, takes the key as next-command',
    run: ({ root }) => {
      const hub = makeHub(root);
      const hooks = [hook(hub, ev(root, hub, 'UserPromptSubmit', { prompt: '/dev-sprint' }), 0)];
      appendLines(transcriptPath(root), [userTurn(0, '/dev-sprint'), assistant('msg_1', 5)]);
      hooks.push(hook(hub, ev(root, hub, 'Stop'), 6));
      hooks.push(hook(hub, ev(root, hub, 'UserPromptSubmit', { prompt: '/dev-sprint PROJ-102' }), 590));
      appendLines(transcriptPath(root), [userTurn(590, '/dev-sprint PROJ-102'), assistant('msg_2', 595)]);
      hooks.push(hook(hub, ev(root, hub, 'Stop'), 596));
      const runs = runsOf(hub);
      return [
        quiet(...hooks),
        runs.length === 2 || `the session has ${runs.length} runs, expected 2`,
        runs[0]?.story === 'PROJ-102' && runs[0]?.key_from === 'next-command' || `the run with no key took ${runs[0]?.story}, from ${runs[0]?.key_from}`,
        runs[1]?.story === 'PROJ-102' && runs[1]?.key_from === 'command' || 'the run typed again lost its own key',
        recordsOf(hub).length === 2 || `the queue holds ${recordsOf(hub).length} records, expected 2`,
      ];
    },
  },
  {
    n: 64, name: 'the run with no key keeps none when the next command is another one, starts after 10 minutes, or follows another harness command',
    run: ({ root }) => {
      const hub = makeHub(root);
      const prompt = (session, text, at) => hook(hub, ev(root, hub, 'UserPromptSubmit', { session_id: session, prompt: text }), at);
      const hooks = [
        prompt('s-other', '/dev-sprint', 0), prompt('s-other', '/qa-sprint PROJ-102', 60),
        prompt('s-late', '/dev-sprint', 0), prompt('s-late', '/dev-sprint PROJ-102', 601),
        prompt('s-between', '/dev-sprint', 0), prompt('s-between', '/add-repo', 30), prompt('s-between', '/dev-sprint PROJ-102', 60),
      ];
      const first = (session) => runsOf(hub, session)[0] || {};
      return [
        quiet(...hooks),
        first('s-other').story === null || `another command gave its key: ${first('s-other').story}`,
        first('s-late').story === null || `a command typed again after 10 minutes gave its key: ${first('s-late').story}`,
        first('s-between').story === null || `a command after another harness command gave its key: ${first('s-between').story}`,
        runsOf(hub, 's-between')[1]?.story === null && runsOf(hub, 's-between')[1]?.key_from === null || 'the estate command took a key',
      ];
    },
  },
  {
    n: 65, name: 'a subagent found at Stop is classified by its .meta.json type, Explore and Plan are runtime-agent, one with no type waits for the session\'s end, and a session with no run reads only a seat\'s log',
    run: ({ root }) => {
      const hub = makeHub(root);
      const meta = (id, type) => write(dirname(seatPath(root, id)), `agent-${id}.meta.json`, JSON.stringify({ agentType: type }));
      // A session with no harness command: its subagent's log is never read, so no checkpoint names it.
      const lone = 's-lone';
      const lonePath = join(root, 'home', '.claude', 'projects', '-hub', lone, 'subagents', 'agent-z1.jsonl');
      appendLines(lonePath, [assistant('msg_z1', 2, {}, { sidechain: true })]);
      const a = hook(hub, { session_id: lone, transcript_path: join(root, 'home', '.claude', 'projects', '-hub', `${lone}.jsonl`), cwd: hub, hook_event_name: 'SubagentStop', agent_id: 'z1', agent_type: 'Explore', agent_transcript_path: lonePath }, 3);
      const before = listing(join(hub, '.harness', 'observability', 'checkpoints')).length;
      hook(hub, ev(root, hub, 'UserPromptSubmit', { prompt: '/dev-sprint PROJ-102' }), 10);
      appendLines(seatPath(root, 'g1'), [assistant('msg_g1', 12, {}, { sidechain: true })]);
      appendLines(seatPath(root, 'g2'), [assistant('msg_g2', 12, {}, { sidechain: true })]);
      appendLines(seatPath(root, 'g3'), [assistant('msg_g3', 12, {}, { sidechain: true })]);
      meta('g1', 'Explore');
      meta('g2', 'Plan');
      meta('g3', `My Agent ${MARKER}`);
      appendLines(seatPath(root, 'g4'), [assistant('msg_g4', 12, {}, { sidechain: true })]);
      const s = hook(hub, ev(root, hub, 'Stop'), 14);
      const waited = !recordsOf(hub).some((r) => r.log_ref === 'g4');
      const end = hook(hub, ev(root, hub, 'SessionEnd'), 20);
      const recs = recordsOf(hub);
      const of = (id) => recs.find((r) => r.log_ref === id) || {};
      return [
        quiet(a, s, end),
        before === 0 || `the session with no run left ${before} checkpoint(s)`,
        waited || 'a subagent with no type was read at Stop, before its SubagentStop could name it',
        of('g4').agent === 'other-agent' || `the session's end read the subagent with no type as ${of('g4').agent}`,
        of('g1').agent === 'runtime-agent' && of('g1').story === 'PROJ-102' && core.record.validateRecord(of('g1')).length === 0 || `the Explore subagent's record is ${of('g1').agent}`,
        core.record.validateRecord({ ...of('g1'), agent: 'Explore' }).some((p) => p.startsWith('field agent')) || 'a record whose agent is Explore passed the record rules',
        of('g2').agent === 'runtime-agent' || `the Plan subagent's record is ${of('g2').agent}`,
        of('g3').agent === 'other-agent' || `an agent type with a space is ${of('g3').agent}`,
        !stateText(hub).includes(MARKER) || 'an agent type reached the state folder',
        !stateText(hub).includes('Explore') && !stateText(hub).includes('Plan') || 'a type that Claude Code ships reached a record or another file of the state folder',
      ];
    },
  },
  {
    n: 66, name: 'a Codex sub-agent that the agent registry does not list: Codex\'s own role is runtime-agent, and any other role is other-agent',
    run: ({ root }) => {
      const hub = makeHub(root);
      hook(hub, codexEv(root, hub, 'UserPromptSubmit', { prompt: '/dev-sprint PROJ-102' }), 0, 'codex');
      const sub = (id, thread, role, at) => {
        appendLines(codexPath(root, `rollout-${id}`), [codexMeta(at, thread), codexContext(at + 1), codexUsage(at + 2, `resp_${id}`, {}, thread)]);
        return hook(hub, codexEv(root, hub, 'SubagentStop', { agent_id: id, agent_type: role, agent_transcript_path: codexPath(root, `rollout-${id}`) }), at + 3, 'codex');
      };
      const a = sub('r1', '019a2b3c-0000-7000-8000-0000000000a1', 'explorer', 2);
      const b = sub('r2', '019a2b3c-0000-7000-8000-0000000000a2', 'my-role', 6);
      const recs = recordsOf(hub);
      const of = (id) => recs.find((r) => r.log_ref === id) || {};
      return [
        quiet(a, b),
        of('r1').agent === 'runtime-agent' && of('r1').story === 'PROJ-102' || `Codex's own role is ${of('r1').agent}`,
        of('r2').agent === 'other-agent' || `a role of a person's own is ${of('r2').agent}`,
      ];
    },
  },
  {
    n: 67, name: 'a harness command does not start in a hub that is not connected, nor with "auth": "bearer" and no HARNESS_OBSERVABILITY_TOKEN: the refusal names the fix, as Claude Code and Codex read it. /connect-observability-platform, a plain prompt, the token and "auth": "none" start',
    run: ({ root }) => {
      const noToken = { HARNESS_OBSERVABILITY_TOKEN: undefined };
      const prompt = (hub, text, env = {}, session = SESSION, runtime = 'claude-code') => hook(hub,
        runtime === 'codex' ? codexEv(root, hub, 'UserPromptSubmit', { prompt: text }) : ev(root, hub, 'UserPromptSubmit', { prompt: text, session_id: session }), 0, runtime, null, env);
      const reason = (r) => { try { const o = JSON.parse(r.out); return o.decision === 'block' && Object.keys(o).length === 2 && typeof o.reason === 'string' ? o.reason : ''; } catch { return ''; } };
      const bare = makeHub(join(root, 'bare'), { connection: null });
      const broken = makeHub(join(root, 'broken'), { connection: { ...CONNECTION, platform: 'nowhere' } });
      const unignored = makeHub(join(root, 'unignored'), { ignore: false });
      const tokenHub = makeHub(join(root, 'token'));
      const open = makeHub(join(root, 'open'), { connection: { ...CONNECTION, auth: 'none' } });
      const missing = prompt(bare, '/dev-sprint PROJ-102');
      const codexMissing = prompt(bare, '$dev-sprint PROJ-102', {}, SESSION, 'codex');
      const estate = prompt(bare, '/add-repo https://example.invalid/spoke.git');
      const connect = prompt(bare, '/connect-observability-platform');
      const plain = prompt(bare, `what does this hub hold? ${MARKER}`);
      const bad = prompt(broken, '/feature');
      const notIgnored = prompt(unignored, '/dev-spec PROJ-102');
      const noTok = prompt(tokenHub, '/dev-sprint PROJ-102', noToken, 's-no-token');
      const withTok = prompt(tokenHub, '/dev-sprint PROJ-103', {}, 's-token');
      const none = prompt(open, '/dev-sprint PROJ-102', noToken);
      const ctx = core.config.hubContext(tokenHub);
      const bound = (session) => existsSync(core.state.bindingPath(ctx.dir, core.state.bindingKey('claude-code', session)));
      return [
        missing.status === 0 && reason(missing).includes('/dev-sprint did not start') && reason(missing).includes('not connected to its observability platform') && reason(missing).includes('Run /connect-observability-platform first') || `a hub without observability.json gave: ${missing.status} ${missing.out}`,
        reason(codexMissing).includes('/dev-sprint did not start') || `Codex's prompt was not refused: ${codexMissing.out}`,
        reason(estate).includes('/add-repo did not start') || `a command with no key was not refused: ${estate.out}`,
        quiet(connect, plain, withTok, none),
        reason(bad).includes('/feature did not start') && reason(bad).includes('platform must be one of') && reason(bad).includes('to correct the connection') || `a broken observability.json gave: ${bad.out}`,
        reason(notIgnored).includes('.gitignore') || `a hub that does not ignore .harness/ gave: ${notIgnored.out}`,
        reason(noTok).includes('HARNESS_OBSERVABILITY_TOKEN is not set') && !noTok.out.includes('token-for-fixtures-only') || `a session without the token gave: ${noTok.out}`,
        !bound('s-no-token') || 'the refused prompt opened a run',
        bound('s-token') || 'the prompt with the token opened no run',
        [bare, broken, unignored].every((h) => !existsSync(join(h, '.harness'))) || 'a hub that is not connected has a state folder',
        ![missing, estate, bad, noTok].some((r) => r.out.includes(MARKER) || r.out.includes('cubeapm.example.invalid')) || 'a refusal repeats the prompt or the URL',
      ];
    },
  },
  {
    n: 68, name: 'the three types of work time and the gate: a valid record of each passes the record rules, and each broken rule is refused without its value',
    run: () => {
      const run = core.runs.openRun({ runs: [] }, core.runs.parseCommand('/dev-sprint PROJ-102'), T0);
      const ctx = { hub: 'example-hub', harness: 'c15a998e0f1d', runtime: 'claude-code', collector: 'claude-code-time/1', runtimeVersion: '2.1.308' };
      const build = (type, from, to, own, logRef = SESSION) => core.record.buildTimeRecord(type, { run, ctx, start: msAt(from), end: msAt(to), own, logRef });
      const work = build('work', 0, 15, { agent: 'orchestrator', model_s: 8.3, tool_s: 6 });
      const reply = build('wait-in-session', 15, 75, { gate: 'reply', gate_wait_s: null });
      const command = build('command', 0, 90, { busy_s: 79, wait_s: 11, unexplained_s: 0 }, null);
      // What the sender adds to a command record: the pickup, and the part of its waits that a gate counts.
      const prepared = { ...command, wait_s: 6, gate_wait_s: 5, previous_gate: 'design-merge', previous_gate_merged_at: tAt(-600), pickup_s: 600 };
      const gateCtx = { hub: 'example-hub', harness: 'c15a998e0f1d', runtime: 'github-actions', runtimeVersion: null, collector: 'github-gate/1' };
      const gate = core.record.buildGateRecord({ ctx: gateCtx, gate: 'design-merge', key: { story: 'PROJ-102' }, repository: 'example-hub', pullRequest: 7, times: { opened: msAt(0), handoff: msAt(90), started: msAt(90), merged: msAt(600) } });
      const says = (r, text) => core.record.validateRecord(r).some((p) => p.startsWith(text));
      return [
        JSON.stringify(core.record.TYPES) === JSON.stringify(['tokens', 'work', 'wait-in-session', 'command', 'failure', 'gate']) || `the types are ${core.record.TYPES}`,
        [work, reply, command, prepared, gate].every((r) => core.record.validateRecord(r).length === 0) || `a valid record was refused: ${[work, reply, command, prepared, gate].map((r) => core.record.validateRecord(r).join(' · ')).join(' | ')}`,
        gate.gate_s === 510 && gate.command === null && gate.run_id === null && gate.key_from === 'pull-request' && gate.scope === 'story' || `the gate record is ${JSON.stringify(gate)}`,
        core.record.buildGateRecord({ ctx: gateCtx, gate: 'design-merge', key: { story: 'PROJ-102' }, repository: 'example-hub', pullRequest: 7, times: { opened: msAt(1), handoff: null, started: msAt(5), merged: msAt(700) } }).record_id === gate.record_id || 'a second send of the same merge gave another record id',
        build('work', 0, 15, { agent: 'orchestrator', model_s: 8.3, tool_s: 6 }).record_id === work.record_id || 'the same piece of time gave two record ids',
        says({ ...work, duration_s: 14 }, 'field duration_s is not the time') || 'a duration that is not the interval passed',
        says({ ...work, ended_at: tAt(-1) }, 'the interval ends before started_at') || 'an end before the start passed',
        says({ ...work, model_s: 10 }, 'fields model_s and tool_s add up to more than duration_s') || 'model time and tool time over the whole passed',
        says({ ...command, wait_s: 12 }, 'fields busy_s, wait_s, gate_wait_s and unexplained_s do not add up') || 'a command whose parts do not make its whole passed',
        says({ ...prepared, gate_wait_s: 6 }, 'fields busy_s, wait_s, gate_wait_s and unexplained_s do not add up') || 'a gate wait outside the command\'s parts passed',
        says({ ...prepared, pickup_s: null }, 'fields previous_gate, previous_gate_merged_at and pickup_s are set together') || 'a pickup with a missing part passed',
        says({ ...prepared, pickup_s: 601 }, 'field pickup_s is not the time from previous_gate_merged_at') || 'a pickup that is not the time from the merge passed',
        says({ ...prepared, previous_gate: 'lunch' }, 'field previous_gate has a value of the wrong shape') || 'a previous gate not on the list passed',
        says({ ...reply, gate: 'lunch' }, 'field gate has a value of the wrong shape') || 'a gate not on the list passed',
        says({ ...reply, gate: 'design-merge' }, 'field gate has a value of the wrong shape') || 'a wait in a session that names a merge gate passed',
        says({ ...reply, gate_wait_s: 61 }, 'field gate_wait_s is more than duration_s') || 'a reply wait whose gate part is over its whole passed',
        says({ ...reply, handoff_at: tAt(1) }, 'field handoff_at is not allowed on a record') || 'a wait in a session kept a hand-off',
        says({ ...gate, gate_s: 500 }, 'field gate_s is not the time from started_at to merged_at') || 'a gate wait that is not the time to the merge passed',
        says({ ...gate, started_at: tAt(700) }, 'the gate wait starts after the merge') || 'a gate wait that starts after its merge passed',
        says({ ...gate, started_at: tAt(80), gate_s: 520 }, 'the gate wait starts before the hand-off') || 'a gate wait before its hand-off passed',
        says({ ...gate, command: 'dev-sprint' }, 'field command has a value of the wrong shape') || 'a gate record with a command passed',
        says({ ...gate, key_from: 'command' }, 'field key_from has a value of the wrong shape') || 'a gate record whose key is not the pull request\'s passed',
        says({ ...gate, gate: 'requirements-merge' }, 'a requirements-merge record needs a feature') || 'a feature\'s gate with a story passed',
        says({ ...gate, pull_request: 0 }, 'field pull_request has a value of the wrong shape') || 'a pull request number of 0 passed',
        says({ ...gate, type: 'wait' }, 'field type has a value of the wrong shape') || 'the retired wait type passed',
        says({ ...work, started_at: null }, 'field started_at has a value of the wrong shape') || 'a work record with no clock time passed',
        says({ ...work, calls: 3 }, 'field calls is not allowed on a record') || 'a field of the tokens type passed on a work record',
        says({ ...command, agent: 'engineer' }, 'field agent is not allowed on a record') || 'an agent passed on a command record',
        says({ ...work, agent: `engineer ${MARKER}` }, 'field agent has a value of the wrong shape') || 'free text passed in agent',
        !core.record.validateRecord({ ...work, agent: `engineer ${MARKER}` }).join(' ').includes(MARKER) || 'a finding repeats the value it refused',
      ];
    },
  },
  {
    n: 69, name: 'work time through the hook: a turn of /dev-sprint gives one work record with its model time and tool time, and the session\'s end gives the command record',
    run: ({ root }) => {
      const hub = makeHub(root);
      const p = hook(hub, ev(root, hub, 'UserPromptSubmit', { prompt: '/dev-sprint PROJ-102' }), 0);
      appendLines(transcriptPath(root), [
        promptLine(0), requestLine(0.5, 'r1'), answerLine(3, 'r1'), answerLine(4, 'r1', [['tu1', 'Bash'], ['tu2', 'mcp__acme__internal']]),
        resultLine(10, 'tu1'), resultLine(10, 'tu2'), requestLine(10.2, 'r2'), answerLine(15, 'r2'), turnEndLine(15.5),
      ]);
      const s = hook(hub, ev(root, hub, 'Stop'), 16);
      const atStop = timeOf(hub, 'work').length;
      const e = hook(hub, ev(root, hub, 'SessionEnd'), 20);
      const w = timeOf(hub, 'work')[0] || {};
      const c = timeOf(hub, 'command')[0] || {};
      return [
        quiet(p, s, e),
        atStop === 1 || `the Stop queued ${atStop} work records, expected 1`,
        timeOf(hub, 'work').length === 1 || 'the session\'s end wrote the turn again',
        core.record.validateRecord(w).length === 0 || `the work record is invalid: ${core.record.validateRecord(w).join(' · ')}`,
        w.agent === 'orchestrator' && w.story === 'PROJ-102' && w.command === 'dev-sprint' && w.scope === 'story' && w.key_from === 'command' || 'the work record does not belong to the main session of /dev-sprint PROJ-102',
        w.started_at === tAt(0) && w.ended_at === tAt(15) && w.duration_s === 15 || `the turn runs ${span(w)}, expected its prompt line to its last line, 15 s`,
        near(w.model_s, 8.3) && near(w.tool_s, 6) || `model time ${w.model_s} s and tool time ${w.tool_s} s, expected 8.3 and 6`,
        w.collector === 'claude-code-time/1' && w.runtime_version === '2.1.308' && w.log_ref === SESSION || 'the work record\'s source fields are wrong',
        timeOf(hub, 'command').length === 1 || `${timeOf(hub, 'command').length} command records, expected 1`,
        core.record.validateRecord(c).length === 0 || `the command record is invalid: ${core.record.validateRecord(c).join(' · ')}`,
        c.started_at === tAt(0) && c.ended_at === tAt(15) && c.busy_s === 15 && c.wait_s === 0 && c.unexplained_s === 0 || `the command takes ${figures(c)}`,
        timeOf(hub, 'wait-in-session').length === 0 || 'a wait was recorded in a run that never waited',
        recordsOf(hub).length === 1 || 'the turn\'s calls did not give their one tokens record',
        !stateText(hub).includes(MARKER) || 'a prompt, an answer or a tool input reached the state folder',
        !stateText(hub).includes('mcp__acme') || 'a tool name that work time does not keep reached the state folder',
      ];
    },
  },
  {
    n: 70, name: 'a turn whose end line reaches the disk after its Stop: the Stop writes no work record, and the next prompt writes it once',
    run: ({ root }) => {
      const hub = makeHub(root);
      hook(hub, ev(root, hub, 'UserPromptSubmit', { prompt: '/dev-sprint PROJ-102' }), 0);
      appendLines(transcriptPath(root), [promptLine(0), requestLine(0.5, 'r1'), answerLine(5, 'r1')]);
      const s = hook(hub, ev(root, hub, 'Stop'), 5.1);
      const atStop = timeOf(hub, 'work').length;
      appendLines(transcriptPath(root), [turnEndLine(5.2)]);
      const p = hook(hub, ev(root, hub, 'UserPromptSubmit', { prompt: 'thanks' }), 30);
      const atPrompt = timeOf(hub, 'work');
      const again = hook(hub, ev(root, hub, 'Stop'), 31);
      const w = atPrompt[0] || {};
      return [
        quiet(s, p, again),
        atStop === 0 || `the Stop wrote ${atStop} work record(s) before the turn's end line was on disk`,
        atPrompt.length === 1 && w.started_at === tAt(0) && w.ended_at === tAt(5) || `the next prompt did not write the turn from its prompt line to its last line: ${span(w)}`,
        timeOf(hub, 'work').length === 1 || 'the turn was written twice',
      ];
    },
  },
  {
    n: 71, name: 'two seats at the same time: a work record for each, the command\'s busy time counts the overlap once, and agent time adds it up',
    run: ({ root }) => {
      const hub = makeHub(root);
      const hooks = [hook(hub, ev(root, hub, 'UserPromptSubmit', { prompt: '/dev-sprint PROJ-102' }), 0)];
      appendLines(transcriptPath(root), [
        promptLine(0), requestLine(0.5, 'm1'), answerLine(2, 'm1', [['ag1', 'Agent'], ['ag2', 'Agent']]), resultLine(2.5, 'ag1'), resultLine(2.5, 'ag2'), turnEndLine(2.6),
      ]);
      hooks.push(hook(hub, ev(root, hub, 'Stop'), 3));
      appendLines(seatPath(root, 'e1'), [requestLine(3, 'e1a'), answerLine(20, 'e1a', [], true)]);
      appendLines(seatPath(root, 't1'), [requestLine(4, 't1a'), answerLine(14, 't1a', [], true)]);
      const seatStop = (id, type, s) => hook(hub, ev(root, hub, 'SubagentStop', { agent_id: id, agent_type: type, agent_transcript_path: seatPath(root, id) }), s);
      hooks.push(seatStop('t1', 'test-writer', 15));
      appendLines(transcriptPath(root), turnLines(15, 16, 'm2', 'peer'));
      hooks.push(hook(hub, ev(root, hub, 'Stop'), 17));
      const early = timeOf(hub, 'command').length;
      hooks.push(seatStop('e1', 'engineer', 21));
      appendLines(transcriptPath(root), turnLines(21, 22, 'm3', 'peer'));
      hooks.push(hook(hub, ev(root, hub, 'Stop'), 23));
      const seatsBeforeEnd = timeOf(hub, 'work').filter((r) => r.agent !== 'orchestrator').length;
      hooks.push(hook(hub, ev(root, hub, 'SessionEnd'), 30));
      const work = timeOf(hub, 'work');
      const of = (agent) => work.filter((r) => r.agent === agent);
      const c = timeOf(hub, 'command')[0] || {};
      const agentTime = work.reduce((s, r) => s + r.duration_s, 0);
      return [
        quiet(...hooks),
        of('engineer').length === 1 && of('engineer')[0].started_at === tAt(3) && of('engineer')[0].ended_at === tAt(20) && of('engineer')[0].log_ref === 'e1' || `the engineer's work is ${of('engineer').map(span).join(' and ')}`,
        of('test-writer').length === 1 && of('test-writer')[0].started_at === tAt(4) && of('test-writer')[0].ended_at === tAt(14) || `the test writer's work is ${of('test-writer').map(span).join(' and ')}`,
        of('orchestrator').length === 3 || `${of('orchestrator').length} turns of the main session, expected 3`,
        work.every((r) => r.story === 'PROJ-102' && core.record.validateRecord(r).length === 0) || 'a work record is invalid or not in the run',
        seatsBeforeEnd === 2 || `the Stop after each SubagentStop finished ${seatsBeforeEnd} seat activation(s), expected 2 before the session's end`,
        early === 0 || 'a command record was written while the run was still open',
        c.started_at === tAt(0) && c.ended_at === tAt(22) && near(c.busy_s, 20.5) && c.wait_s === 0 && near(c.unexplained_s, 1.5) || `the command takes ${figures(c)}, expected 22 s: busy 20.5, wait 0, unexplained 1.5`,
        near(agentTime, 31.5) || `the agents worked ${agentTime} s, expected 31.5, more than the busy time`,
      ];
    },
  },
  {
    n: 72, name: 'a seat\'s report starts a turn and ends no reply wait, and a resumed seat works in two activations, not across the time between them',
    run: ({ root }) => {
      const hub = makeHub(root);
      const hooks = [hook(hub, ev(root, hub, 'UserPromptSubmit', { prompt: '/dev-sprint PROJ-102' }), 0)];
      const seatStop = (s) => hook(hub, ev(root, hub, 'SubagentStop', { agent_id: 'c1', agent_type: 'dual-mode-critic', agent_transcript_path: seatPath(root, 'c1') }), s);
      appendLines(transcriptPath(root), [promptLine(0), requestLine(0.5, 'm1'), answerLine(2, 'm1', [['ag1', 'Agent']]), resultLine(2.2, 'ag1'), turnEndLine(2.3)]);
      appendLines(seatPath(root, 'c1'), [requestLine(3, 'c1a'), answerLine(10, 'c1a', [], true)]);
      hooks.push(seatStop(10.5));
      // No hook reads the seat again before the resume line: the resume itself must end the first activation.
      appendLines(transcriptPath(root), turnLines(11, 12, 'm2', 'peer'));
      appendLines(transcriptPath(root), [promptLine(95), requestLine(95.2, 'm3'), answerLine(96, 'm3', [['sm1', 'SendMessage']]), resultLine(96.2, 'sm1'), turnEndLine(96.3)]);
      appendLines(seatPath(root, 'c1'), [resumeLine(97), requestLine(97.5, 'c1b'), answerLine(110, 'c1b', [], true)]);
      hooks.push(seatStop(110.5));
      appendLines(transcriptPath(root), turnLines(111, 112, 'm4', 'peer'));
      hooks.push(hook(hub, ev(root, hub, 'Stop'), 113));
      hooks.push(hook(hub, ev(root, hub, 'SessionEnd'), 120));
      const critic = timeOf(hub, 'work').filter((r) => r.agent === 'dual-mode-critic');
      const replies = timeOf(hub, 'wait-in-session').filter((r) => r.gate === 'reply');
      const c = timeOf(hub, 'command')[0] || {};
      return [
        quiet(...hooks),
        critic.length === 2 || `the resumed seat has ${critic.length} work record(s), expected one for each activation`,
        critic.some((r) => r.started_at === tAt(3) && r.ended_at === tAt(10)) && critic.some((r) => r.started_at === tAt(97) && r.ended_at === tAt(110)) || `the activations are ${critic.map(span).join(' and ')}`,
        replies.length === 1 && replies[0].started_at === tAt(12) && replies[0].ended_at === tAt(95) || `the reply waits are ${replies.map(span).join(' and ')}, expected one, from the report's turn to the person's prompt`,
        c.ended_at === tAt(112) && near(c.busy_s, 25.4) && c.wait_s === 83 && near(c.unexplained_s, 3.6) || `the command takes ${figures(c)}, expected 112 s: busy 25.4, wait 83, unexplained 3.6`,
      ];
    },
  },
  {
    n: 73, name: 'a question to the person: its wait splits the turn into two work records, and the command counts it as waiting time',
    run: ({ root }) => {
      const hub = makeHub(root);
      const p = hook(hub, ev(root, hub, 'UserPromptSubmit', { prompt: '/dev-sprint PROJ-102' }), 0);
      appendLines(transcriptPath(root), [
        promptLine(0), requestLine(0.5, 'r1'), answerLine(3, 'r1', [['q1', 'AskUserQuestion']]), resultLine(63, 'q1', 'user_temporary'),
        requestLine(63.5, 'r2'), answerLine(70, 'r2'), turnEndLine(71),
      ]);
      const s = hook(hub, ev(root, hub, 'Stop'), 72);
      const e = hook(hub, ev(root, hub, 'SessionEnd'), 80);
      const work = timeOf(hub, 'work');
      const waits = timeOf(hub, 'wait-in-session');
      const q = waits[0] || {};
      const c = timeOf(hub, 'command')[0] || {};
      return [
        quiet(p, s, e),
        work.length === 2 && work.some((r) => r.started_at === tAt(0) && r.ended_at === tAt(3)) && work.some((r) => r.started_at === tAt(63) && r.ended_at === tAt(70)) || `the turn's work is ${work.map(span).join(' and ')}, expected the two pieces around the question`,
        waits.length === 1 && q.gate === 'question' && q.started_at === tAt(3) && q.ended_at === tAt(63) && q.duration_s === 60 || `the waits are ${waits.map((r) => `${r.gate} ${span(r)}`).join(' and ')}, expected one question of 60 s`,
        core.record.validateRecord(q).length === 0 || `the question's record is invalid: ${core.record.validateRecord(q).join(' · ')}`,
        c.duration_s === 70 && c.busy_s === 10 && c.wait_s === 60 && c.unexplained_s === 0 || `the command takes ${figures(c)}, expected 70 s: busy 10, wait 60, unexplained 0`,
      ];
    },
  },
  {
    n: 74, name: 'a reply wait runs from the end of the turn before to the person\'s prompt, a seat\'s report ends none, and the next harness command\'s prompt is no reply',
    run: ({ root }) => {
      const hub = makeHub(root);
      const hooks = [hook(hub, ev(root, hub, 'UserPromptSubmit', { prompt: '/dev-sprint PROJ-102' }), 0)];
      appendLines(transcriptPath(root), [...turnLines(0, 5, 'r1'), ...turnLines(65, 70, 'r2'), ...turnLines(80, 82, 'r3', 'peer'), ...turnLines(140, 145, 'r4')]);
      hooks.push(hook(hub, ev(root, hub, 'Stop'), 146));
      hooks.push(hook(hub, ev(root, hub, 'UserPromptSubmit', { prompt: '/dev-spec PROJ-103' }), 200));
      appendLines(transcriptPath(root), turnLines(200, 205, 'r5'));
      hooks.push(hook(hub, ev(root, hub, 'Stop'), 206));
      const before = timeOf(hub, 'command').map((r) => r.story);
      hooks.push(hook(hub, ev(root, hub, 'SessionEnd'), 210));
      const replies = timeOf(hub, 'wait-in-session');
      const at = (from, to) => replies.some((r) => r.gate === 'reply' && r.story === 'PROJ-102' && r.started_at === tAt(from) && r.ended_at === tAt(to));
      const first = timeOf(hub, 'command').find((r) => r.story === 'PROJ-102') || {};
      return [
        quiet(...hooks),
        replies.length === 2 && at(5, 65) && at(82, 140) || `the reply waits are ${replies.map(span).join(' and ')}, expected 5 to 65 and 82 to 140`,
        JSON.stringify(before) === JSON.stringify(['PROJ-102']) || `the Stop after the next command wrote command records for ${before.join(', ') || 'no story'}, expected PROJ-102 only`,
        first.command === 'dev-sprint' && first.ended_at === tAt(145) && first.busy_s === 17 && first.wait_s === 118 && first.unexplained_s === 10 || `PROJ-102's command takes ${figures(first)}, expected 145 s: busy 17, wait 118, unexplained 10`,
        timeOf(hub, 'command').some((r) => r.story === 'PROJ-103' && r.command === 'dev-spec' && r.duration_s === 5) || 'the session\'s end did not write the command record of /dev-spec PROJ-103',
      ];
    },
  },
  {
    n: 75, name: 'a tool call that a person allowed: a permission wait over its span, which stays inside tool time, so the command counts it as busy',
    run: ({ root }) => {
      const hub = makeHub(root);
      const p = hook(hub, ev(root, hub, 'UserPromptSubmit', { prompt: '/dev-sprint PROJ-102' }), 0);
      appendLines(transcriptPath(root), [
        promptLine(0), requestLine(0.5, 'r1'), answerLine(2, 'r1', [['b1', 'Bash']]), resultLine(72, 'b1', 'user_temporary'),
        requestLine(72.5, 'r2'), answerLine(80, 'r2'), turnEndLine(80.1),
      ]);
      const s = hook(hub, ev(root, hub, 'Stop'), 81);
      const e = hook(hub, ev(root, hub, 'SessionEnd'), 90);
      const w = timeOf(hub, 'work')[0] || {};
      const waits = timeOf(hub, 'wait-in-session');
      const c = timeOf(hub, 'command')[0] || {};
      return [
        quiet(p, s, e),
        timeOf(hub, 'work').length === 1 && w.duration_s === 80 && near(w.model_s, 9) && near(w.tool_s, 70) || `the turn is ${span(w)}, model ${w.model_s} s and tool ${w.tool_s} s, expected 80 s with 9 and 70`,
        waits.length === 1 && waits[0].gate === 'permission-prompt' && waits[0].started_at === tAt(2) && waits[0].ended_at === tAt(72) || `the waits are ${waits.map((r) => `${r.gate} ${span(r)}`).join(' and ')}, expected one permission prompt from the call to its result`,
        c.busy_s === 80 && c.wait_s === 0 && c.unexplained_s === 0 || `the command takes ${figures(c)}, expected the permission wait inside busy time`,
      ];
    },
  },
  {
    n: 76, name: 'a turn with no end line, as after a crash: no work record at its Stop, and the session\'s end finishes it at its last line',
    run: ({ root }) => {
      const hub = makeHub(root);
      const p = hook(hub, ev(root, hub, 'UserPromptSubmit', { prompt: '/dev-sprint PROJ-102' }), 0);
      appendLines(transcriptPath(root), [promptLine(0), requestLine(1, 'r1'), answerLine(9, 'r1')]);
      const s = hook(hub, ev(root, hub, 'Stop'), 10);
      const atStop = timeOf(hub, 'work').length;
      const e = hook(hub, ev(root, hub, 'SessionEnd'), 20);
      const w = timeOf(hub, 'work')[0] || {};
      const c = timeOf(hub, 'command')[0] || {};
      return [
        quiet(p, s, e),
        atStop === 0 || 'the Stop wrote a turn that had no end line',
        w.started_at === tAt(0) && w.ended_at === tAt(9) || `the session's end finished the turn as ${span(w)}, expected its prompt line to its last line`,
        c.ended_at === tAt(9) && c.duration_s === 9 || `the command takes ${figures(c)}, expected 9 s`,
      ];
    },
  },
  {
    n: 77, name: 'a command ends at its last turn or seat: a seat still at work holds its command record after the next command starts, and its elapsed time ends with that seat',
    run: ({ root }) => {
      const hub = makeHub(root);
      const hooks = [hook(hub, ev(root, hub, 'UserPromptSubmit', { prompt: '/dev-spec PROJ-102' }), 0)];
      appendLines(transcriptPath(root), [promptLine(0), requestLine(0.5, 'm1'), answerLine(3, 'm1', [['ag1', 'Agent']]), resultLine(4, 'ag1'), turnEndLine(4.1)]);
      appendLines(seatPath(root, 'c1'), [requestLine(5, 'c1a'), answerLine(20, 'c1a', [], true)]);
      seatMeta(root, 'c1', 'dual-mode-critic');
      hooks.push(hook(hub, ev(root, hub, 'UserPromptSubmit', { prompt: '/dev-sprint PROJ-102' }), 30));
      appendLines(transcriptPath(root), turnLines(30, 35, 'm2'));
      hooks.push(hook(hub, ev(root, hub, 'Stop'), 36));
      const held = timeOf(hub, 'command').length;
      appendLines(seatPath(root, 'c1'), [answerLine(60, 'c1a', [], true)]);
      hooks.push(hook(hub, ev(root, hub, 'SubagentStop', { agent_id: 'c1', agent_type: 'dual-mode-critic', agent_transcript_path: seatPath(root, 'c1') }), 61));
      appendLines(transcriptPath(root), turnLines(62, 63, 'm3', 'peer'));
      hooks.push(hook(hub, ev(root, hub, 'Stop'), 64));
      const spec = timeOf(hub, 'command').find((r) => r.command === 'dev-spec') || {};
      const sprintEarly = timeOf(hub, 'command').some((r) => r.command === 'dev-sprint');
      hooks.push(hook(hub, ev(root, hub, 'SessionEnd'), 70));
      const sprint = timeOf(hub, 'command').find((r) => r.command === 'dev-sprint') || {};
      return [
        quiet(...hooks),
        held === 0 || 'the command record of /dev-spec was written while its seat still worked',
        spec.started_at === tAt(0) && spec.ended_at === tAt(60) && spec.busy_s === 59 && spec.unexplained_s === 1 || `/dev-spec takes ${figures(spec)}, expected 60 s to its seat's end: busy 59, unexplained 1`,
        !sprintEarly || 'the command record of /dev-sprint was written before its run ended',
        sprint.started_at === tAt(30) && sprint.ended_at === tAt(63) && sprint.busy_s === 6 || `/dev-sprint takes ${figures(sprint)}, expected 33 s: busy 6`,
      ];
    },
  },
  {
    n: 78, name: 'turns before the first harness command are never sent, and the command\'s prompt line a moment before its hook still starts its run',
    run: ({ root }) => {
      const hub = makeHub(root);
      const hooks = [hook(hub, ev(root, hub, 'UserPromptSubmit', { prompt: 'hello there' }), 0)];
      appendLines(transcriptPath(root), turnLines(0, 5, 'r0'));
      hooks.push(hook(hub, ev(root, hub, 'Stop'), 6));
      appendLines(transcriptPath(root), [promptLine(9.5)]);
      hooks.push(hook(hub, ev(root, hub, 'UserPromptSubmit', { prompt: '/dev-sprint PROJ-102' }), 10));
      appendLines(transcriptPath(root), [requestLine(10, 'r1'), answerLine(15, 'r1'), turnEndLine(15.1)]);
      hooks.push(hook(hub, ev(root, hub, 'Stop'), 16));
      hooks.push(hook(hub, ev(root, hub, 'SessionEnd'), 20));
      const work = timeOf(hub, 'work');
      const c = timeOf(hub, 'command')[0] || {};
      return [
        quiet(...hooks),
        work.length === 1 && work[0].started_at === tAt(9.5) && work[0].ended_at === tAt(15) && work[0].story === 'PROJ-102' || `the work records are ${work.map(span).join(' and ')}, expected only the command's turn, 9.5 to 15`,
        timeOf(hub, 'wait-in-session').length === 0 || 'the time before the harness command was recorded as a reply wait',
        c.started_at === tAt(9.5) || `the command starts at ${c.started_at}, expected its prompt line`,
      ];
    },
  },
  {
    n: 79, name: 'Codex\'s work time through the hook: a turn from its start line to its last response, a response from the last tool output to its token record, and the session\'s end gives the command record',
    run: ({ root }) => {
      const hub = makeHub(root);
      const p = hook(hub, codexEv(root, hub, 'UserPromptSubmit', { prompt: '/dev-sprint PROJ-102' }), 0, 'codex');
      appendLines(codexPath(root), [
        codexMeta(0), codexContext(0.1), codexTurnStart(0.2, 't1'), codexCall(3, 'c1'), codexUsage(3.5, 'resp_1'),
        codexOutput(10, 'c1'), codexUsage(15, 'resp_2'), codexTurnEnd(15.5, 't1'),
      ]);
      const s = hook(hub, codexEv(root, hub, 'Stop'), 16, 'codex');
      const e = hook(hub, codexEv(root, hub, 'SessionEnd'), 20, 'codex');
      const w = timeOf(hub, 'work')[0] || {};
      const c = timeOf(hub, 'command')[0] || {};
      return [
        quiet(p, s, e),
        timeOf(hub, 'work').length === 1 || `${timeOf(hub, 'work').length} work records, expected 1`,
        w.started_at === tAt(0.2) && w.ended_at === tAt(15) && near(w.duration_s, 14.8) || `the turn runs ${span(w)}, expected its start line to its last response`,
        near(w.model_s, 8.3) && near(w.tool_s, 6.5) || `model time ${w.model_s} s and tool time ${w.tool_s} s, expected 8.3 and 6.5`,
        w.runtime === 'codex' && w.collector === 'codex-time/1' && w.runtime_version === '0.164.0' && w.agent === 'orchestrator' || 'the Codex work record\'s source fields are wrong',
        core.record.validateRecord(w).length === 0 || `the work record is invalid: ${core.record.validateRecord(w).join(' · ')}`,
        c.story === 'PROJ-102' && c.started_at === tAt(0.2) && c.ended_at === tAt(15) && near(c.busy_s, 14.8) || `the command takes ${figures(c)}`,
        !stateText(hub).includes(MARKER) || 'a tool input, an output or a message reached the state folder',
      ];
    },
  },
  {
    n: 80, name: 'Codex: a turn that an agent started ends no reply wait, a person\'s next turn records one, and request_user_input is a question',
    run: ({ root }) => {
      const hub = makeHub(root);
      const hooks = [hook(hub, codexEv(root, hub, 'UserPromptSubmit', { prompt: '/dev-sprint PROJ-102' }), 0, 'codex')];
      appendLines(codexPath(root), [
        codexMeta(0), codexTurnStart(0.2, 't1'), codexUsage(5, 'r1'), codexTurnEnd(5.5, 't1'),
        codexTurnStart(20, 't2', '/root/worker'), codexUsage(22, 'r2'), codexTurnEnd(22.5, 't2'),
        codexTurnStart(80, 't3'), codexCall(81, 'q1', 'request_user_input'), codexUsage(81.5, 'r3'), codexOutput(141, 'q1'), codexUsage(145, 'r4'), codexTurnEnd(145.5, 't3'),
      ]);
      hooks.push(hook(hub, codexEv(root, hub, 'Stop'), 146, 'codex'), hook(hub, codexEv(root, hub, 'SessionEnd'), 150, 'codex'));
      const waits = timeOf(hub, 'wait-in-session');
      const replies = waits.filter((r) => r.gate === 'reply');
      const questions = waits.filter((r) => r.gate === 'question');
      const work = timeOf(hub, 'work');
      return [
        quiet(...hooks),
        replies.length === 1 && replies[0].started_at === tAt(22) && replies[0].ended_at === tAt(80) || `the reply waits are ${replies.map(span).join(' and ')}, expected one, from the agent's turn to the person's`,
        questions.length === 1 && questions[0].started_at === tAt(81) && questions[0].duration_s === 60 || `the questions are ${questions.map(span).join(' and ')}, expected one of 60 s`,
        work.length === 4 && work.some((r) => r.started_at === tAt(80) && r.ended_at === tAt(81)) && work.some((r) => r.started_at === tAt(141) && r.ended_at === tAt(145)) || `the work is ${work.map(span).join(' and ')}, expected the person's turn in two pieces around the question`,
      ];
    },
  },
  {
    n: 81, name: 'a Codex sub-agent: each turn of its rollout is one activation of the seat, finished at the read at its SubagentStop',
    run: ({ root }) => {
      const hub = makeHub(root);
      const hooks = [hook(hub, codexEv(root, hub, 'UserPromptSubmit', { prompt: '/dev-sprint PROJ-102' }), 0, 'codex')];
      appendLines(codexPath(root), [codexMeta(0), codexTurnStart(0.2, 't1'), codexCall(1, 's1', 'spawn_agent'), codexOutput(1.5, 's1'), codexUsage(2, 'r1'), codexTurnEnd(2.5, 't1')]);
      hooks.push(hook(hub, codexEv(root, hub, 'Stop'), 2.6, 'codex'));
      appendLines(codexPath(root, 'rollout-w1'), [
        codexMeta(3, CODEX_SEAT), codexTurnStart(3, 'w-t1', '/root'), codexUsage(10, 'w-r1', {}, CODEX_SEAT), codexTurnEnd(10.5, 'w-t1'),
        codexTurnStart(30, 'w-t2', '/root'), codexUsage(40, 'w-r2', {}, CODEX_SEAT),
      ]);
      hooks.push(hook(hub, codexEv(root, hub, 'SubagentStop', { agent_id: 'w1', agent_type: 'engineer', agent_transcript_path: codexPath(root, 'rollout-w1') }), 41, 'codex'));
      hooks.push(hook(hub, codexEv(root, hub, 'SessionEnd'), 50, 'codex'));
      const seat = timeOf(hub, 'work').filter((r) => r.agent === 'engineer');
      const c = timeOf(hub, 'command')[0] || {};
      return [
        quiet(...hooks),
        seat.length === 2 && seat.some((r) => r.started_at === tAt(3) && r.ended_at === tAt(10)) && seat.some((r) => r.started_at === tAt(30) && r.ended_at === tAt(40)) || `the seat's activations are ${seat.map(span).join(' and ')}, expected its two turns`,
        seat.every((r) => r.log_ref === 'w1' && r.story === 'PROJ-102' && near(r.model_s, r.duration_s)) || 'a seat record has the wrong log, story or model time',
        c.ended_at === tAt(40) && near(c.busy_s, 18.8) && near(c.unexplained_s, 21) || `the command takes ${figures(c)}, expected 39.8 s: busy 18.8, unexplained 21`,
      ];
    },
  },
  {
    n: 82, name: 'OpenCode\'s work time through the plugin: a step\'s span less its tool calls is model time, the turn ends at its last step, and the next command writes the run\'s command record',
    run: async ({ root }) => {
      const hub = makeHub(root);
      const messages = { ses_root: [ocPrompt('ses_root', 'u1', 0), ocStepMessage('ses_root', 'a1', 0.5, 15, [ocToolPart('c1', 'bash', 4, 10)])] };
      const oc = await openCode(hub, { sessions: { ses_root: ocSession('ses_root', -10) }, messages });
      await oc.command('ses_root', 'dev-sprint', 'PROJ-102', 0);
      await oc.idle('ses_root', 16);
      const first = await settleTime(hub, 'work', 1);
      messages.ses_root.push(ocPrompt('ses_root', 'u2', 30), ocStepMessage('ses_root', 'a2', 31, 35));
      await oc.command('ses_root', 'dev-spec', 'PROJ-103', 30);
      await oc.idle('ses_root', 40);
      const work = await settleTime(hub, 'work', 2);
      const commands = await settleTime(hub, 'command', 1);
      const w = first[0] || {};
      const c = commands[0] || {};
      return [
        first.length === 1 && w.started_at === tAt(0) && w.ended_at === tAt(15) && w.story === 'PROJ-102' || `the first turn is ${first.map(span).join(' and ')}, expected 0 to 15`,
        near(w.model_s, 8.5) && near(w.tool_s, 6) || `model time ${w.model_s} s and tool time ${w.tool_s} s, expected 8.5 and 6`,
        w.runtime === 'opencode' && w.collector === 'opencode-time/1' || 'the OpenCode work record\'s source fields are wrong',
        work.length === 2 && work.some((r) => r.story === 'PROJ-103' && r.started_at === tAt(30) && r.ended_at === tAt(35)) || `the work records are ${work.map((r) => `${r.story} ${span(r)}`).join(' and ')}, expected the first turn once and the next command's turn`,
        commands.length === 1 && c.story === 'PROJ-102' && c.duration_s === 15 && c.busy_s === 15 || `the command records are ${commands.map((r) => `${r.story} ${figures(r)}`).join(' and ')}, expected PROJ-102's`,
        !stateText(hub).includes(MARKER) || 'a message, a tool input or a title reached the state folder',
      ];
    },
  },
  {
    n: 83, name: 'OpenCode: a permission wait from its question to its reply, the question tool, and a child session\'s run as the seat\'s activation',
    run: async ({ root }) => {
      const hub = makeHub(root);
      const messages = {
        ses_root: [ocPrompt('ses_root', 'u1', 0), ocStepMessage('ses_root', 'a1', 0.5, 100, [ocToolPart('t1', 'task', 2, 60), ocToolPart('q1', 'question', 62, 92), ocToolPart('b1', 'bash', 93, 98)])],
        ses_child: [ocPrompt('ses_child', 'cu1', 2), ocStepMessage('ses_child', 'ca1', 2.5, 59, [ocToolPart('cb1', 'bash', 10, 20)])],
      };
      const sessions = { ses_root: ocSession('ses_root', -10), ses_child: ocSession('ses_child', 1, { parentID: 'ses_root', title: 'Build the endpoint (@engineer subagent)' }) };
      const oc = await openCode(hub, { sessions, messages });
      await oc.command('ses_root', 'dev-sprint', 'PROJ-102', 0);
      await oc.idle('ses_child', 60);
      const seat = await settleTime(hub, 'work', 1);
      await oc.event({ type: 'permission.asked', properties: { id: 'per_1', sessionID: 'ses_root', permission: 'bash', tool: { messageID: 'a1', callID: 'b1' } } }, 93.5);
      await oc.event({ type: 'permission.replied', properties: { sessionID: 'ses_root', requestID: 'per_1', reply: 'once' } }, 96.5);
      await oc.idle('ses_root', 101);
      const waits = await settleTime(hub, 'wait-in-session', 2);
      const work = timeOf(hub, 'work').filter((r) => r.agent === 'orchestrator');
      const of = (gate) => waits.find((r) => r.gate === gate) || {};
      const s = seat[0] || {};
      return [
        s.agent === 'engineer' && s.started_at === tAt(2) && s.ended_at === tAt(59) && near(s.model_s, 46.5) && near(s.tool_s, 10) || `the seat's activation is ${s.agent} ${span(s)}, model ${s.model_s} s, tool ${s.tool_s} s`,
        of('question').started_at === tAt(62) && of('question').duration_s === 30 || `the question is ${span(of('question'))}, expected 62 to 92`,
        of('permission-prompt').started_at === tAt(93.5) && of('permission-prompt').duration_s === 3 || `the permission wait is ${span(of('permission-prompt'))}, expected 93.5 to 96.5`,
        work.length === 3 || `the turn has ${work.length} work pieces, expected 3, around the question and the permission wait`,
        !stateText(hub).includes('per_1') || 'a permission request id reached the state folder',
      ];
    },
  },
  {
    n: 84, name: 'OpenCode passes every message again at each idle: the same turn read at three idles gives one work record',
    run: async ({ root }) => {
      const hub = makeHub(root);
      const messages = { ses_root: [ocPrompt('ses_root', 'u1', 0), ocStepMessage('ses_root', 'a1', 0.5, 15)] };
      const oc = await openCode(hub, { sessions: { ses_root: ocSession('ses_root', -10) }, messages });
      await oc.command('ses_root', 'dev-sprint', 'PROJ-102', 0);
      for (const at of [16, 20, 25]) await oc.idle('ses_root', at);
      await settleTime(hub, 'work', 2);
      const work = timeOf(hub, 'work');
      return [work.length === 1 || `${work.length} work records from one turn read three times, expected 1`];
    },
  },
  {
    n: 85, name: 'print mode (claude -p): a prompt with no origin and turnOrigin sdk starts a turn, a stop_hook_summary with no turn_duration ends it, a call after a stop continues the turn, and a seat\'s notice starts the next turn: work and command records as for interactive lines',
    run: ({ root }) => {
      const hub = makeHub(root);
      const hooks = [hook(hub, ev(root, hub, 'UserPromptSubmit', { prompt: '/dev-sprint PROJ-102' }), 0)];
      appendLines(transcriptPath(root), [
        sdkPromptLine(0), requestLine(0.5, 'r1'), answerLine(5, 'r1'), stopLine(5.1),
        // A Stop hook made the turn go on: its next call belongs to the same turn, and a notice while
        // the turn runs joins it.
        requestLine(6, 'r2'), answerLine(8, 'r2'), promptLine(8.5, 'task-notification'), requestLine(9, 'r3'), answerLine(9.5, 'r3'), stopLine(9.6),
        promptLine(20, 'task-notification'), requestLine(20.5, 'r4'), answerLine(24, 'r4'), stopLine(24.1),
      ]);
      hooks.push(hook(hub, ev(root, hub, 'Stop'), 25));
      hooks.push(hook(hub, ev(root, hub, 'SessionEnd'), 26));
      const work = timeOf(hub, 'work');
      const at = (from, to) => work.some((r) => r.started_at === tAt(from) && r.ended_at === tAt(to));
      const cmd = timeOf(hub, 'command')[0] || {};
      return [
        quiet(...hooks),
        work.length === 2 && at(0, 9.5) && at(20, 24) || `the work is ${work.map(span).join(' and ') || 'none'}, expected 0 to 9.5 and 20 to 24`,
        timeOf(hub, 'wait-in-session').length === 0 || 'a seat\'s notice ended a reply wait',
        cmd.command === 'dev-sprint' && cmd.started_at === tAt(0) && cmd.ended_at === tAt(24) && cmd.busy_s === 13.5 || `the command takes ${figures(cmd)}, expected 24 s from 0 with 13.5 s busy`,
      ];
    },
  },
  {
    n: 86, name: 'print mode across two calls on one session, as claude -p --resume makes them: the caller\'s next prompt ends a reply wait from the end of the turn before, and each call\'s turn gives its work record',
    run: ({ root }) => {
      const hub = makeHub(root);
      const hooks = [hook(hub, ev(root, hub, 'UserPromptSubmit', { prompt: '/dev-sprint PROJ-102' }), 0)];
      appendLines(transcriptPath(root), [sdkPromptLine(0), requestLine(0.5, 'r1'), answerLine(5, 'r1'), stopLine(5.1)]);
      hooks.push(hook(hub, ev(root, hub, 'Stop'), 6), hook(hub, ev(root, hub, 'SessionEnd'), 6.5));
      hooks.push(hook(hub, ev(root, hub, 'UserPromptSubmit', { prompt: 'and the second part' }), 65));
      appendLines(transcriptPath(root), [sdkPromptLine(65), requestLine(65.5, 'r2'), answerLine(70, 'r2'), stopLine(70.1)]);
      hooks.push(hook(hub, ev(root, hub, 'Stop'), 71), hook(hub, ev(root, hub, 'SessionEnd'), 71.5));
      const work = timeOf(hub, 'work');
      const replies = timeOf(hub, 'wait-in-session');
      return [
        quiet(...hooks),
        work.length === 2 || `${work.length} work record(s): ${work.map(span).join(' and ') || 'none'}, expected 2`,
        replies.length === 1 && replies[0].gate === 'reply' && replies[0].started_at === tAt(5) && replies[0].ended_at === tAt(65) || `the reply waits are ${replies.map(span).join(' and ') || 'none'}, expected one, 5 to 65`,
      ];
    },
  },
  {
    n: 87, name: 'a question that the person declines with Esc ends the turn with no call after it: its wait ends the command, and the interrupt line is no prompt',
    run: ({ root }) => {
      const hub = makeHub(root);
      const p = hook(hub, ev(root, hub, 'UserPromptSubmit', { prompt: '/dev-sprint PROJ-102' }), 0);
      appendLines(transcriptPath(root), [
        promptLine(0), requestLine(0.5, 'r1'), answerLine(3, 'r1', [['q1', 'AskUserQuestion']]), rejectedLine(20, 'q1'), interruptLine(20.002), turnEndLine(20.005),
      ]);
      const s = hook(hub, ev(root, hub, 'Stop'), 21);
      const e = hook(hub, ev(root, hub, 'SessionEnd'), 30);
      const work = timeOf(hub, 'work');
      const waits = timeOf(hub, 'wait-in-session');
      const q = waits[0] || {};
      const c = timeOf(hub, 'command')[0] || {};
      return [
        quiet(p, s, e),
        work.length === 1 && work[0].started_at === tAt(0) && work[0].ended_at === tAt(3) || `the turn's work is ${work.map(span).join(' and ')}, expected one piece, 0 to 3, before the question`,
        waits.length === 1 && q.gate === 'question' && q.started_at === tAt(3) && q.ended_at === tAt(20) && q.duration_s === 17 || `the waits are ${waits.map((r) => `${r.gate} ${span(r)}`).join(' and ')}, expected one question of 17 s and no reply wait`,
        c.started_at === tAt(0) && c.ended_at === tAt(20) && c.duration_s === 20 && c.busy_s === 3 && c.wait_s === 17 && c.unexplained_s === 0 || `the command takes ${figures(c)} to ${c.ended_at}, expected 20 s to the decline: busy 3, wait 17, unexplained 0`,
      ];
    },
  },
  {
    n: 88, name: 'OpenCode: a permission wait that ends the turn, as a refused call does: its wait ends the command, which the next command writes',
    run: async ({ root }) => {
      const hub = makeHub(root);
      const messages = { ses_root: [ocPrompt('ses_root', 'u1', 0), ocStepMessage('ses_root', 'a1', 0.5, 20, [ocToolPart('b1', 'bash', 5, 20)])] };
      const oc = await openCode(hub, { sessions: { ses_root: ocSession('ses_root', -10) }, messages });
      await oc.command('ses_root', 'dev-sprint', 'PROJ-102', 0);
      await oc.event({ type: 'permission.asked', properties: { id: 'per_1', sessionID: 'ses_root', permission: 'bash', tool: { messageID: 'a1', callID: 'b1' } } }, 5.5);
      await oc.event({ type: 'permission.replied', properties: { sessionID: 'ses_root', requestID: 'per_1', reply: 'reject' } }, 20);
      await oc.idle('ses_root', 21);
      messages.ses_root.push(ocPrompt('ses_root', 'u2', 30), ocStepMessage('ses_root', 'a2', 31, 35));
      await oc.command('ses_root', 'dev-spec', 'PROJ-103', 30);
      await oc.idle('ses_root', 40);
      const commands = await settleTime(hub, 'command', 1);
      const c = commands[0] || {};
      return [
        commands.length === 1 && c.story === 'PROJ-102' && c.started_at === tAt(0) && c.ended_at === tAt(20) && c.duration_s === 20 && near(c.busy_s, 5.5) && near(c.wait_s, 14.5) && c.unexplained_s === 0 || `the command records are ${commands.map((r) => `${r.story} ${figures(r)} to ${r.ended_at}`).join(' and ')}, expected PROJ-102's 20 s to the reply: busy 5.5, wait 14.5`,
      ];
    },
  },
  {
    n: 89, name: 'the failure type: a valid record of each source passes the record rules, and each broken rule is refused without its value',
    run: () => {
      const run = core.runs.openRun({ runs: [] }, core.runs.parseCommand('/dev-sprint PROJ-102'), T0);
      const ctx = { hub: 'example-hub', harness: 'c15a998e0f1d', runtime: 'claude-code', collector: 'claude-code-failures/1', runtimeVersion: '2.1.308' };
      const build = (from, to, own) => core.record.buildTimeRecord('failure', { run, ctx, start: msAt(from), end: msAt(to), own, logRef: SESSION });
      const script = build(2, 4, { agent: 'orchestrator', source: 'script', check: 'check-dev-ready', exit_code: 2, outcome: 'cannot-verify', reason: 'docker-not-running' });
      const runtime = build(9, 9, { agent: 'engineer', source: 'runtime', check: null, exit_code: null, outcome: 'runtime', reason: 'server_error' });
      const says = (r, text) => core.record.validateRecord(r).some((p) => p.startsWith(text));
      return [
        [script, runtime].every((r) => core.record.validateRecord(r).length === 0) || `a valid record was refused: ${[script, runtime].map((r) => core.record.validateRecord(r).join(' · ')).join(' | ')}`,
        says({ ...script, exit_code: 1, outcome: 'cannot-verify' }, 'field exit_code has a value of the wrong shape') || 'an exit 1 passed as a failure',
        says({ ...script, check: 'npm' }, 'field check has a value of the wrong shape') || 'a program that is not a harness script passed',
        says({ ...script, outcome: 'internal' }, 'field outcome has a value of the wrong shape') || 'an outcome that is not its exit code\'s passed',
        says({ ...runtime, check: 'check-dev-ready' }, 'field check has a value of the wrong shape') || 'a runtime failure that names a script passed',
        says({ ...script, reason: `docker ${MARKER}` }, 'field reason has a value of the wrong shape') || 'free text passed in reason',
        says({ ...script, reason: 'server_error' }, 'field reason has a value of the wrong shape') || 'a script reason that is not on the list of reasons passed',
        core.record.validateRecord({ ...script, reason: 'remote-unreachable' }).length === 0 || 'a script reason on the list of reasons was refused',
        says({ ...script, command_line: MARKER }, 'field command_line is not allowed on a record') || 'a command line passed on a failure record',
        !core.record.validateRecord({ ...script, reason: `docker ${MARKER}` }).join(' ').includes(MARKER) || 'a finding repeats the value it refused',
      ];
    },
  },
  {
    n: 90, name: 'the harness script that a shell command line runs: one script in any layout and form, and none when the line names none or two. A REASON line counts only with a listed token',
    run: () => {
      const of = core.failures.scriptOf;
      const cases = [
        ['node scripts/check-dev-ready.js PROJ-102', 'check-dev-ready'],
        ['cd /home/dev/hub && node "scripts/check-dev-ready.mjs" PROJ-102 2>&1', 'check-dev-ready'],
        ['node /home/dev/hub/scripts/check-requirements-amend.mjs service-version-endpoint', 'check-requirements-amend'],
        ['node scripts/secret-scan.cjs --staged', 'secret-scan'],
        ['node scripts/test-guard.mjs setup --key PROJ-102;', 'test-guard'],
        ['node scripts/check-dev-ready.js PROJ-102 && node scripts/check-staged.mjs', null],
        ['node scripts/check-dev-ready-old.js PROJ-102', null],
        ['npm test', null],
        ['node scripts/escalation-record.mjs', null],
        [null, null],
      ];
      const reason = core.failures.reasonInOutput(`line one\n${MARKER}\nREASON: docker-not-running\n`);
      return [
        ...cases.map(([line, want]) => of(line) === want || `${JSON.stringify(line)} gave ${of(line)}, expected ${want}`),
        reason === 'docker-not-running' || `the REASON line gave ${reason}`,
        core.failures.reasonInOutput(`REASON: ${MARKER} and more`) === null || 'a REASON line with free text gave a token',
        core.failures.reasonInOutput('CANNOT VERIFY: cannot reach the remote\nREASON: not-a-listed-token\n') === null || 'a REASON token that is not on the list gave a reason',
        core.failures.reasonInOutput('REASON: fetch-failed\nREASON: trunk-mismatch\n') === 'trunk-mismatch' || 'the last REASON line did not win',
      ];
    },
  },
  {
    n: 91, name: 'Claude Code: a harness script that exits 2 is a failure with its REASON token, a turn the API failed is a runtime failure, and exit 1, another program and a line of two scripts give none',
    run: ({ root }) => {
      const hub = makeHub(root);
      const hooks = [hook(hub, ev(root, hub, 'UserPromptSubmit', { prompt: '/dev-sprint PROJ-102' }), 0)];
      appendLines(transcriptPath(root), [
        promptLine(0), requestLine(0.5, 'r1'), answerLine(2, 'r1', [['b1', 'Bash', `node scripts/check-dev-ready.js PROJ-102 # ${MARKER}`]]),
        failedResultLine(4, 'b1', `Exit code 2\n${MARKER}\nREASON: docker-not-running`),
        requestLine(4.1, 'r2'),
        answerLine(5, 'r2', [['b2', 'Bash', 'node scripts/check-validation.js PROJ-102'], ['b3', 'Bash', 'npm test'], ['b4', 'Bash', 'node scripts/check-dev-ready.js PROJ-102 && node scripts/check-staged.mjs']]),
        failedResultLine(7, 'b2', `Exit code 1\n${MARKER}`), failedResultLine(7, 'b3', `Exit code 2\n${MARKER}`), failedResultLine(7, 'b4', `Exit code 3\n${MARKER}`),
        requestLine(7.1, 'r3'), apiErrorLine(9, 'server_error'), turnEndLine(9.1),
      ]);
      hooks.push(hook(hub, ev(root, hub, 'Stop'), 10), hook(hub, ev(root, hub, 'SessionEnd'), 12));
      const failures = timeOf(hub, 'failure');
      const s = failures.find((r) => r.source === 'script') || {};
      const rt = failures.find((r) => r.source === 'runtime') || {};
      return [
        quiet(...hooks),
        failures.length === 2 || `${failures.length} failure records, expected 2: ${failures.map((r) => `${r.source} ${r.check} ${r.exit_code}`).join(', ')}`,
        failures.every((r) => core.record.validateRecord(r).length === 0) || `a failure record is invalid: ${failures.map((r) => core.record.validateRecord(r).join(' · ')).join(' | ')}`,
        s.check === 'check-dev-ready' && s.exit_code === 2 && s.outcome === 'cannot-verify' && s.reason === 'docker-not-running' || `the script failure is ${s.check} ${s.exit_code} ${s.outcome} ${s.reason}`,
        s.started_at === tAt(2) && s.ended_at === tAt(4) && s.duration_s === 2 && s.agent === 'orchestrator' && s.story === 'PROJ-102' || `the script failure runs ${span(s)} for ${s.agent} on ${s.story}`,
        rt.reason === 'server_error' && rt.outcome === 'runtime' && rt.check === null && rt.exit_code === null && rt.started_at === tAt(9) && rt.duration_s === 0 || `the runtime failure is ${rt.reason} ${rt.outcome} at ${rt.started_at}`,
        failures.every((r) => r.collector === 'claude-code-failures/1' && r.log_ref === SESSION) || 'a failure record\'s source fields are wrong',
        timeOf(hub, 'work').length === 1 && timeOf(hub, 'work')[0].ended_at === tAt(9) || `the work records are ${timeOf(hub, 'work').map(span).join(' and ')}, expected the one turn to 9 s`,
        !stateText(hub).includes(MARKER) || 'a command line, an output or an error message reached the state folder',
      ];
    },
  },
  {
    n: 92, name: 'Codex: an exec_command of a harness script whose output says it exited 3 is a failure, and a turn_complete with an error is a runtime failure named by codex_error_info',
    run: ({ root }) => {
      const hub = makeHub(root);
      const hooks = [hook(hub, codexEv(root, hub, 'UserPromptSubmit', { prompt: '/dev-sprint PROJ-102' }), 0, 'codex')];
      const exec = (at, id, cmd) => codexLine(at, 'response_item', { type: 'function_call', name: 'exec_command', arguments: JSON.stringify({ cmd, yield_time_ms: 10000 }), call_id: id });
      const out = (at, id, code) => codexLine(at, 'response_item', { type: 'function_call_output', call_id: id, output: `Chunk ID: 1a2b\nWall time: 1.2 seconds\nProcess exited with code ${code}\nOriginal token count: 5\nOutput:\n${MARKER}` });
      appendLines(codexPath(root), [
        codexMeta(0), codexTurnStart(0.2, 't1'), exec(1, 'x1', `node scripts/check-staged.mjs ${MARKER}`), out(3, 'x1', 3),
        exec(3.5, 'x2', 'node scripts/check-staged.mjs'), out(4, 'x2', 0), codexUsage(5, 'r1'),
        codexLine(6, 'event_msg', { type: 'turn_complete', turn_id: 't1', last_agent_message: null, error: { message: MARKER, codex_error_info: { http_connection_failed: { http_status_code: 502 } } } }),
      ]);
      hooks.push(hook(hub, codexEv(root, hub, 'Stop'), 7, 'codex'), hook(hub, codexEv(root, hub, 'SessionEnd'), 8, 'codex'));
      const failures = timeOf(hub, 'failure');
      const s = failures.find((r) => r.source === 'script') || {};
      const rt = failures.find((r) => r.source === 'runtime') || {};
      return [
        quiet(...hooks),
        failures.length === 2 && failures.every((r) => core.record.validateRecord(r).length === 0) || `the failure records are ${failures.map((r) => `${r.source} ${r.check} ${r.exit_code}`).join(', ')}, expected two valid ones`,
        s.check === 'check-staged' && s.exit_code === 3 && s.outcome === 'usage' && s.started_at === tAt(1) && s.ended_at === tAt(3) || `the script failure is ${s.check} ${s.exit_code} ${s.outcome}, ${span(s)}`,
        rt.reason === 'http_connection_failed' && rt.started_at === tAt(6) || `the runtime failure is ${rt.reason} at ${rt.started_at}`,
        failures.every((r) => r.collector === 'codex-failures/1') || 'a Codex failure record\'s source fields are wrong',
        !stateText(hub).includes(MARKER) || 'a command line, an output or an error message reached the state folder',
      ];
    },
  },
  {
    n: 93, name: 'OpenCode: a bash call of a harness script with exit 4 in its metadata is a failure, a message with an APIError is a runtime failure, and an abort is none',
    run: async ({ root }) => {
      const hub = makeHub(root);
      const part = ocToolPart('c1', 'bash', 4, 10);
      part.state = { ...part.state, input: { command: `node scripts/check-coverage.mjs ${MARKER}` }, metadata: { output: MARKER, exit: 4, truncated: false } };
      const quietPart = ocToolPart('c2', 'bash', 11, 12);
      quietPart.state = { ...quietPart.state, input: { command: 'node scripts/check-coverage.mjs' }, metadata: { output: MARKER, exit: 1, truncated: false } };
      const failed = ocStepMessage('ses_root', 'a2', 13, 15);
      failed.info.error = { name: 'APIError', data: { message: MARKER, statusCode: 529, isRetryable: true } };
      const aborted = ocStepMessage('ses_root', 'a3', 15.5, 16);
      aborted.info.error = { name: 'MessageAbortedError', data: { message: MARKER } };
      const messages = { ses_root: [ocPrompt('ses_root', 'u1', 0), ocStepMessage('ses_root', 'a1', 0.5, 12.5, [part, quietPart]), failed, aborted] };
      const oc = await openCode(hub, { sessions: { ses_root: ocSession('ses_root', -10) }, messages });
      await oc.command('ses_root', 'dev-sprint', 'PROJ-102', 0);
      await oc.idle('ses_root', 17);
      const failures = await settleTime(hub, 'failure', 2);
      const s = failures.find((r) => r.source === 'script') || {};
      const rt = failures.find((r) => r.source === 'runtime') || {};
      return [
        failures.length === 2 && failures.every((r) => core.record.validateRecord(r).length === 0) || `the failure records are ${failures.map((r) => `${r.source} ${r.check} ${r.exit_code} ${r.reason}`).join(', ')}, expected two valid ones`,
        s.check === 'check-coverage' && s.exit_code === 4 && s.outcome === 'internal' && s.started_at === tAt(4) && s.ended_at === tAt(10) || `the script failure is ${s.check} ${s.exit_code} ${s.outcome}, ${span(s)}`,
        rt.reason === 'APIError' && rt.started_at === tAt(15) || `the runtime failure is ${rt.reason} at ${rt.started_at}`,
        failures.every((r) => r.collector === 'opencode-failures/1' && r.story === 'PROJ-102') || 'an OpenCode failure record\'s source fields are wrong',
        !stateText(hub).includes(MARKER) || 'a command line, an output or an error message reached the state folder',
      ];
    },
  },
  {
    n: 94, name: 'Claude Code: a harness script whose exit a pipe or `; echo` hid still fails by its own HARNESS EXIT line, an exit 3 too, and a line it quotes from another script counts for nothing',
    run: ({ root }) => {
      const hub = makeHub(root);
      const hooks = [hook(hub, ev(root, hub, 'UserPromptSubmit', { prompt: '/dev-sprint PROJ-102' }), 0)];
      appendLines(transcriptPath(root), [
        promptLine(0), requestLine(0.5, 'r1'),
        answerLine(1, 'r1', [
          ['b1', 'Bash', `node scripts/check-dev-ready.js PROJ-102 2>&1 | tail -5 # ${MARKER}`],
          ['b2', 'Bash', 'node scripts/check-staged.mjs --bogus; echo "exit=$?"'],
          ['b3', 'Bash', 'node scripts/harness-commit.mjs -m "x" | tail -3'],
          ['b4', 'Bash', 'node scripts/check-dev-ready.js PROJ-102 | tail -1'],
        ]),
        passedResultLine(3, 'b1', `${MARKER}\nREASON: fetch-failed\nHARNESS EXIT: check-dev-ready 2`),
        passedResultLine(4, 'b2', `USAGE ${MARKER}\nHARNESS EXIT: check-staged 3\nexit=3`),
        // harness-commit passed. The report it quotes holds the secret scan's line, which is not its own.
        passedResultLine(5, 'b3', `${MARKER}\nREASON: config-invalid\nHARNESS EXIT: secret-scan 2\nHARNESS COMMIT abc123`),
        // A line that names a script the list does not hold counts for nothing either.
        passedResultLine(6, 'b4', `${MARKER}\nHARNESS EXIT: check-dev-ready 7\nHARNESS EXIT: not-a-harness-script 2`),
        requestLine(6.1, 'r2'), answerLine(7, 'r2', []), turnEndLine(7.1),
      ]);
      hooks.push(hook(hub, ev(root, hub, 'Stop'), 8), hook(hub, ev(root, hub, 'SessionEnd'), 9));
      const failures = timeOf(hub, 'failure');
      const of = (check) => failures.find((r) => r.check === check) || {};
      return [
        quiet(...hooks),
        failures.length === 2 || `${failures.length} failure records, expected 2: ${failures.map((r) => `${r.check} ${r.exit_code} ${r.reason}`).join(', ')}`,
        failures.every((r) => core.record.validateRecord(r).length === 0) || `a failure record is invalid: ${failures.map((r) => core.record.validateRecord(r).join(' · ')).join(' | ')}`,
        of('check-dev-ready').exit_code === 2 && of('check-dev-ready').reason === 'fetch-failed' && of('check-dev-ready').started_at === tAt(1) && of('check-dev-ready').ended_at === tAt(3) || `the hidden exit 2 is ${of('check-dev-ready').exit_code} ${of('check-dev-ready').reason}, ${span(of('check-dev-ready'))}`,
        of('check-staged').exit_code === 3 && of('check-staged').outcome === 'usage' && of('check-staged').reason === null || `the hidden exit 3 is ${of('check-staged').exit_code} ${of('check-staged').outcome} ${of('check-staged').reason}`,
        !failures.some((r) => r.check === 'harness-commit' || r.check === 'secret-scan') || 'a line quoted from another script counted',
        !stateText(hub).includes(MARKER) || 'a command line or an output reached the state folder',
      ];
    },
  },
  {
    n: 95, name: 'Codex: a harness script whose exit a pipe hid still fails by its own HARNESS EXIT line',
    run: ({ root }) => {
      const hub = makeHub(root);
      const hooks = [hook(hub, codexEv(root, hub, 'UserPromptSubmit', { prompt: '/dev-sprint PROJ-102' }), 0, 'codex')];
      const exec = (at, id, cmd) => codexLine(at, 'response_item', { type: 'function_call', name: 'exec_command', arguments: JSON.stringify({ cmd, yield_time_ms: 10000 }), call_id: id });
      const out = (at, id, text) => codexLine(at, 'response_item', { type: 'function_call_output', call_id: id, output: `Chunk ID: 1a2b\nWall time: 1.2 seconds\nProcess exited with code 0\nOriginal token count: 5\nOutput:\n${text}` });
      appendLines(codexPath(root), [
        codexMeta(0), codexTurnStart(0.2, 't1'),
        exec(1, 'x1', `node scripts/test-guard.mjs finalize --state /tmp/run | head -20 # ${MARKER}`),
        out(3, 'x1', `${MARKER}\nREASON: guard-state-invalid\nHARNESS EXIT: test-guard 2`),
        codexUsage(4, 'r1'), codexLine(5, 'event_msg', { type: 'turn_complete', turn_id: 't1', last_agent_message: null }),
      ]);
      hooks.push(hook(hub, codexEv(root, hub, 'Stop'), 6, 'codex'), hook(hub, codexEv(root, hub, 'SessionEnd'), 7, 'codex'));
      const failures = timeOf(hub, 'failure');
      const f = failures[0] || {};
      return [
        quiet(...hooks),
        failures.length === 1 && core.record.validateRecord(f).length === 0 || `the failure records are ${failures.map((r) => `${r.check} ${r.exit_code} ${r.reason}`).join(', ')}, expected one valid one`,
        f.check === 'test-guard' && f.exit_code === 2 && f.reason === 'guard-state-invalid' && f.started_at === tAt(1) && f.ended_at === tAt(3) || `the failure is ${f.check} ${f.exit_code} ${f.reason}, ${span(f)}`,
        !stateText(hub).includes(MARKER) || 'a command line or an output reached the state folder',
      ];
    },
  },
  {
    n: 96, name: 'OpenCode: a bash call whose exit a pipe hid passes the script\'s own HARNESS EXIT line and REASON token from the plugin, and a token off the list is dropped',
    run: async ({ root }) => {
      const hub = makeHub(root);
      const part = ocToolPart('c1', 'bash', 4, 10);
      part.state = { ...part.state, input: { command: `node scripts/check-registry.mjs | tail -3 ${MARKER}` }, metadata: { output: `${MARKER}\nREASON: registry-missing\nHARNESS EXIT: check-registry 2`, exit: 0, truncated: false } };
      const offList = ocToolPart('c2', 'bash', 11, 12);
      offList.state = { ...offList.state, input: { command: 'node scripts/check-trackers.mjs | tail -2' }, metadata: { output: `${MARKER}\nREASON: not-a-listed-token\nHARNESS EXIT: check-trackers 2`, exit: 0, truncated: false } };
      const messages = { ses_root: [ocPrompt('ses_root', 'u1', 0), ocStepMessage('ses_root', 'a1', 0.5, 12.5, [part, offList])] };
      const oc = await openCode(hub, { sessions: { ses_root: ocSession('ses_root', -10) }, messages });
      await oc.command('ses_root', 'dev-sprint', 'PROJ-102', 0);
      await oc.idle('ses_root', 13);
      const failures = await settleTime(hub, 'failure', 2);
      const of = (check) => failures.find((r) => r.check === check) || {};
      return [
        failures.length === 2 && failures.every((r) => core.record.validateRecord(r).length === 0) || `the failure records are ${failures.map((r) => `${r.check} ${r.exit_code} ${r.reason}`).join(', ')}, expected two valid ones`,
        of('check-registry').exit_code === 2 && of('check-registry').reason === 'registry-missing' && of('check-registry').started_at === tAt(4) || `the hidden exit 2 is ${of('check-registry').exit_code} ${of('check-registry').reason}`,
        of('check-trackers').exit_code === 2 && of('check-trackers').reason === null || `a token off the list gave ${of('check-trackers').reason}`,
        !stateText(hub).includes(MARKER) || 'a command line or an output reached the state folder',
      ];
    },
  },
  {
    n: 97, name: 'a record that has waited more than 24 hours: one warning at the end of a turn of a harness command, as systemMessage, once in each session, and none before 24 hours or in a session with no harness command',
    run: ({ root }) => {
      const hub = makeHub(root);
      const ctx = core.config.hubContext(hub);
      core.state.writeReady(ctx.dir, { record: { id: 'rec-old', type: 'tokens' }, local: { created_ms: T0 } });
      const day = 24 * 3600;
      hook(hub, ev(root, hub, 'UserPromptSubmit', { prompt: '/dev-sprint PROJ-102' }), 0);
      const early = hook(hub, ev(root, hub, 'Stop'), day - 60);
      const late = hook(hub, ev(root, hub, 'Stop'), day + 60);
      const again = hook(hub, ev(root, hub, 'Stop'), day + 120);
      const plain = hook(hub, ev(root, hub, 'Stop', { session_id: 's-plain' }), day + 130);
      hook(hub, codexEv(root, hub, 'UserPromptSubmit', { prompt: '$dev-sprint PROJ-102' }), day + 140, 'codex');
      const codex = hook(hub, codexEv(root, hub, 'Stop'), day + 150, 'codex');
      const message = (r) => { try { return JSON.parse(r.out).systemMessage || ''; } catch { return ''; } };
      return [
        quiet(early, again, plain),
        late.status === 0 && message(late).includes('waited more than 24 hours') && message(late).includes('observability-status.mjs') && Object.keys(JSON.parse(late.out || '{}')).length === 1 || `the turn after 24 hours gave: ${late.out}`,
        message(codex).includes('waited more than 24 hours') || `Codex's Stop did not warn: ${codex.out}`,
      ];
    },
  },
  {
    n: 98, name: 'OpenCode: a harness command in a hub that is not connected throws the hook\'s reason at command.execute.before, and /connect-observability-platform starts',
    run: async ({ root }) => {
      const bare = makeHub(root, { connection: null });
      const oc = await openCode(bare, { sessions: { ses_root: ocSession('ses_root', 0) } });
      const attempt = async (command, args, at) => { try { await oc.command('ses_root', command, args, at); return null; } catch (err) { return err; } };
      const refused = await attempt('dev-sprint', 'PROJ-102', 1);
      const connect = await attempt('connect-observability-platform', '', 2);
      return [
        refused instanceof Error && refused.message.includes('/dev-sprint did not start') && refused.message.includes('Run /connect-observability-platform first') || `the plugin did not throw the refusal: ${refused}`,
        connect === null || `the connect command was refused: ${connect && connect.message}`,
        !existsSync(join(bare, '.harness')) || 'a hub that is not connected has a state folder',
      ];
    },
  },
  {
    n: 101, name: 'the person from gh: the run names the login gh is signed in to, lowercased, and its tokens, work and command records carry it',
    run: ({ root }) => {
      const hub = makeHub(root);
      git(hub, 'config', 'user.email', 'dev@example.invalid');
      const p = hook(hub, ev(root, hub, 'UserPromptSubmit', { prompt: '/dev-sprint PROJ-102' }), 0, 'claude-code', null, { FAKE_GH_LOGIN: 'Octo-Cat' });
      appendLines(transcriptPath(root), [
        promptLine(0), requestLine(0.5, 'r1'), answerLine(3, 'r1'), answerLine(4, 'r1', [['tu1', 'Bash']]),
        resultLine(10, 'tu1'), requestLine(10.2, 'r2'), answerLine(15, 'r2'), turnEndLine(15.5),
      ]);
      const s = hook(hub, ev(root, hub, 'Stop'), 16);
      const e = hook(hub, ev(root, hub, 'SessionEnd'), 20);
      const run = runsOf(hub)[0] || {};
      const recs = [...recordsOf(hub), ...timeOf(hub, 'work'), ...timeOf(hub, 'command')];
      return [
        quiet(p, s, e),
        run.person === 'octo-cat' || `the run names ${run.person}, expected octo-cat`,
        recs.length === 3 || `${recs.length} records, expected a tokens, a work and a command record`,
        ...recs.map((r) => r.person === 'octo-cat' || `the ${r.type} record names ${r.person}, expected octo-cat`),
        ...recs.map((r) => core.record.validateRecord(r).length === 0 || `the ${r.type} record is invalid: ${core.record.validateRecord(r).join(' · ')}`),
        recs.every((r) => Object.keys(r).indexOf('person') === Object.keys(r).indexOf('run_id') + 1) || 'person does not follow run_id',
      ];
    },
  },
  {
    n: 102, name: 'gh signed out: the person is git\'s user.email in the hub, lowercased. Neither: null, and the records stay valid',
    run: ({ root }) => {
      const hubA = makeHub(join(root, 'a'));
      git(hubA, 'config', 'user.email', 'Dev.Person@Example.COM');
      hook(hubA, ev(root, hubA, 'UserPromptSubmit', { prompt: '/dev-sprint PROJ-102' }), 0);
      const hubB = makeHub(join(root, 'b'));
      hook(hubB, ev(root, hubB, 'UserPromptSubmit', { prompt: '/dev-sprint PROJ-102' }), 0);
      const hubC = makeHub(join(root, 'c'));
      git(hubC, 'config', 'user.email', `Jane Doe ${MARKER}`);
      hook(hubC, ev(root, hubC, 'UserPromptSubmit', { prompt: '/dev-sprint PROJ-102' }), 0);
      const ctx = core.config.hubContext(hubB);
      const binding = core.state.loadBinding(ctx.dir, core.state.bindingKey('claude-code', SESSION));
      const r = gather(ctx, { session: SESSION, calls: [call('m1', 1)] });
      const rec = queued(ctx)[0] || {};
      return [
        (runsOf(hubA)[0] || {}).person === 'dev.person@example.com' || `with gh signed out, the run names ${(runsOf(hubA)[0] || {}).person}`,
        (runsOf(hubB)[0] || {}).person === null || `with no gh and no address, the run names ${(runsOf(hubB)[0] || {}).person}`,
        (runsOf(hubC)[0] || {}).person === null || 'an address of the wrong shape reached the run',
        !stateText(hubC).includes(MARKER) || 'free text from git reached the state folder',
        binding.runs && binding.runs.length === 1 || 'the binding has no run',
        r.written === 1 && 'person' in rec && rec.person === null || `the record names ${rec.person}, expected null`,
        core.record.validateRecord(rec).length === 0 || `a record with no person is invalid: ${core.record.validateRecord(rec).join(' · ')}`,
      ];
    },
  },
  {
    n: 99, name: 'gh is asked once a day: a login stays in person.json for 24 h, an empty answer for 1 h, and a signed-out laptop takes git meanwhile',
    run: ({ root }) => {
      const hub = makeHub(root);
      git(hub, 'config', 'user.email', 'dev@example.invalid');
      const calls = join(root, 'gh-calls.txt');
      const asked = () => (existsSync(calls) ? readFileSync(calls, 'utf8').split('\n').filter(Boolean).length : 0);
      const prompt = (at, env) => hook(hub, ev(root, hub, 'UserPromptSubmit', { prompt: '/dev-sprint PROJ-102' }), at, 'claude-code', null, { FAKE_GH_CALLS: calls, ...env });
      const H = 3600;
      prompt(0, { FAKE_GH_LOGIN: 'octo-cat' });
      prompt(60, { FAKE_GH_LOGIN: 'octo-cat' });
      prompt(23 * H, {});
      const inDay = asked();
      prompt(25 * H, {});
      prompt(25 * H + 1800, { FAKE_GH_LOGIN: 'octo-cat' });
      const inHour = asked();
      prompt(26 * H + 60, { FAKE_GH_LOGIN: 'octo-cat' });
      const people = runsOf(hub).map((r) => r.person);
      const kept = JSON.parse(readFileSync(join(hub, '.harness', 'observability', 'person.json'), 'utf8'));
      return [
        inDay === 1 || `gh was asked ${inDay} times in its first 24 h, expected once`,
        inHour === 2 || `gh was asked ${inHour} times by 25.5 h, expected twice: once a day, and the empty answer kept for an hour`,
        asked() === 3 || `gh was asked ${asked()} times, expected 3`,
        people.join(' ') === 'octo-cat octo-cat octo-cat dev@example.invalid dev@example.invalid octo-cat' || `the runs name ${people.join(' ')}`,
        kept.login === 'octo-cat' && kept.checked_ms === msAt(26 * H + 60) || `person.json holds ${JSON.stringify(kept)}`,
        readFileSync(calls, 'utf8').split('\n')[0] === 'api user --jq .login' || 'gh was not asked for the login of its user',
      ];
    },
  },
  {
    n: 100, name: 'the person\'s shape: a login or an address, lowercase, or null. Free text is refused, a gate record names no person, a seat\'s and a failure\'s record take their run\'s person, and work on another story keeps it',
    run: ({ root }) => {
      const { ctx } = control(root);
      const binding = core.state.loadBinding(ctx.dir, core.state.bindingKey('claude-code', 's-2'));
      core.runs.openRun(binding, { ...core.runs.parseCommand('/dev-sprint PROJ-103'), person: 'octo-cat' }, T0);
      core.runs.takeWorkKey(binding, 'PROJ-104', T0 + 5000);
      core.state.saveBinding(ctx.dir, core.state.bindingKey('claude-code', 's-2'), binding);
      gather(ctx, { session: 's-2', logRef: 'log-seat', seat: 'engineer', calls: [call('e1', 1)] });
      const seat = queued(ctx).find((r) => r.agent === 'engineer') || {};
      const good = queued(ctx)[0] || {};
      const refused = (value) => core.record.validateRecord({ ...good, person: value }).includes('field person has a value of the wrong shape');
      const run = binding.runs[0];
      const gate = core.record.buildGateRecord({
        ctx: { hub: 'example-hub', harness: null, runtime: 'github-actions', collector: 'github-gate/1' }, gate: 'design-merge', key: { story: 'PROJ-103' },
        repository: 'example-hub', pullRequest: 3, times: { opened: T0, handoff: T0 + 1000, started: T0 + 1000, merged: T0 + 60000 },
      });
      const failure = core.record.buildTimeRecord('failure', {
        run, ctx: { hub: 'example-hub', harness: null, runtime: 'claude-code', collector: 'claude-code-failures/1' }, start: T0 + 2000, end: T0 + 4000, logRef: SESSION,
        own: { agent: 'orchestrator', source: 'script', check: 'check-dev-ready', exit_code: 2, outcome: 'cannot-verify', reason: 'docker-not-running' },
      });
      const old = { ...good };
      delete old.person;
      return [
        seat.person === 'octo-cat' || `the seat's record names ${seat.person}, expected its run's person`,
        binding.runs.length === 2 && binding.runs[1].story === 'PROJ-104' && binding.runs[1].person === 'octo-cat' || 'the run that work on another story opened lost its person',
        ['octo-cat', 'a-b-c', 'dev.person+tag@example.co.uk', null].every((v) => !refused(v)) || 'a login, an address or null was refused',
        ['Octo-Cat', 'Jane Doe', 'jane@', 'a--b', '-ab', '<jane@example.com>', 'jane@example', `${'a'.repeat(40)}`, 42, ''].every(refused) || 'a value of the wrong shape passed',
        !('person' in gate) || 'a gate record names a person',
        failure.person === 'octo-cat' && core.record.validateRecord(failure).length === 0 || `the failure record names ${failure.person}: ${core.record.validateRecord(failure).join(' · ')}`,
        core.record.validateRecord({ ...gate, person: 'octo-cat' }).includes('field person is not allowed on a record') || 'a gate record with a person passed',
        core.record.validateRecord(old).length === 0 || 'a record queued before the field existed is refused',
        core.person.isPerson('octo-cat') && !core.person.isPerson('Octo-Cat') || 'isPerson does not take a lowercase login only',
      ];
    },
  },
];

/* ------------------------------------------------------------------------------------ runner */

// A hook that the OpenCode plugin starts runs in the background. It can still write a log's work
// time into the hub while the suite removes the hub, so the removal tries again.
const REMOVE = { recursive: true, force: true, maxRetries: 10, retryDelay: 100 };

async function runFixture(f, sandbox) {
  const root = mkdtempSync(join(sandbox, `f${f.n}-`));
  try {
    const results = await f.run({ root });
    return results.filter((p) => p !== true).map(String);
  } catch (err) {
    return [`the fixture threw: ${err && err.stack ? err.stack.split('\n').slice(0, 3).join(' | ') : String(err)}`];
  } finally {
    // An OpenCode fixture moves the clock of the hooks its plugin starts. It never reaches the next fixture.
    delete process.env.HARNESS_OBSERVABILITY_NOW;
    if (!KEEP) rmSync(root, REMOVE);
  }
}

/**
 * A fake gh first on PATH, so no fixture reaches the real gh or the network. It answers the login
 * in FAKE_GH_LOGIN, or else it is signed out. FAKE_GH_CALLS names a file that gets one line for
 * each call.
 */
function fakeGh(sandbox) {
  const bin = join(sandbox, 'bin');
  mkdirSync(bin, { recursive: true });
  const script = join(bin, 'fake-gh.mjs');
  writeFileSync(script, [
    "import { appendFileSync } from 'node:fs';",
    "if (process.env.FAKE_GH_CALLS) appendFileSync(process.env.FAKE_GH_CALLS, `${process.argv.slice(2).join(' ')}\\n`);",
    "if (process.env.FAKE_GH_LOGIN) { process.stdout.write(`${process.env.FAKE_GH_LOGIN}\\n`); process.exit(0); }",
    "process.stderr.write('To get started with GitHub CLI, please run:  gh auth login\\n');",
    'process.exit(4);',
  ].join('\n'));
  writeFileSync(join(bin, 'gh'), `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
  chmodSync(join(bin, 'gh'), 0o755);
  process.env.PATH = `${bin}${delimiter}${process.env.PATH}`;
  for (const k of ['FAKE_GH_LOGIN', 'FAKE_GH_CALLS', 'GH_TOKEN', 'GITHUB_TOKEN', 'GH_HOST']) delete process.env[k];
}

async function main() {
  const sandbox = mkdtempSync(join(tmpdir(), 'observability-collect-'));
  // A private HOME, so a developer's gitconfig cannot change a result.
  Object.assign(process.env, {
    HOME: sandbox, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
  });
  fakeGh(sandbox);
  // The hooks that the OpenCode plugin starts inherit this environment: no sender, and the hub taken
  // from where the hook is installed.
  process.env.HARNESS_OBSERVABILITY_SENDER = 'off';
  // Every hook runs with a write token, so the refusal of a session without one shows only in its
  // own fixture. The sender is off, so the token never leaves.
  process.env.HARNESS_OBSERVABILITY_TOKEN = 'token-for-fixtures-only';
  delete process.env.CLAUDE_PROJECT_DIR;
  delete process.env.HARNESS_OBSERVABILITY_NOW;
  const wanted = process.argv.slice(2).filter((a) => a.search(/^\d+$/) === 0).map(Number);
  const selected = wanted.length ? FIXTURES.filter((f) => wanted.includes(f.n)) : FIXTURES;
  let failed = 0;
  for (const f of selected) {
    const problems = await runFixture(f, sandbox);
    if (problems.length) {
      failed += 1;
      process.stdout.write(`  FAIL  ${f.n}. ${f.name}\n`);
      for (const p of problems) process.stdout.write(`          - ${p}\n`);
    } else {
      process.stdout.write(`  PASS  ${f.n}. ${f.name}\n`);
    }
  }
  if (!KEEP) rmSync(sandbox, REMOVE);
  else process.stdout.write(`\nThe throwaway hubs are kept under ${sandbox}\n`);
  process.stdout.write(failed
    ? `\n${failed} of ${selected.length} fixtures FAILED. Observability is not trustworthy until this is green.\n`
    : `\nAll ${selected.length} fixtures passed.\n`);
  process.exit(failed ? 1 : 0);
}

await main();

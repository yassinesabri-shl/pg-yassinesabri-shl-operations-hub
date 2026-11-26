// Part of the harness asset library c6f3b4427d58f7c3 (see VERSION.json) · 2026-10-26
/**
 * harness-observability.js — the OpenCode plugin for observability, written for OpenCode v1.19.4
 * and installed at .opencode/plugin/harness-observability.js. No live run has confirmed it yet.
 *
 * It does four things, and nothing else:
 *   - At `command.execute.before`, a command is about to start. The plugin passes the command's
 *     name, its arguments and the time to the hook, which opens a run for a harness command.
 *     OpenCode publishes `command.executed` only after the command's model calls end, so that event
 *     comes too late to open the run. Here the plugin waits for the hook, 10 s at most. When the
 *     hook refuses the command, because the hub is not connected to its observability platform or
 *     the session has no write token, the plugin throws the hook's reason. OpenCode then stops the
 *     command before its prompt reaches the model. No live run has confirmed the refusal yet.
 *   - At `tool.execute.before`, a `bash` call whose command line names one of the five harness
 *     scripts that carry a story's key is about to run. The plugin passes that command line and the
 *     time to the hook, which keeps only the key. It passes no other tool call.
 *   - When a session goes idle (`session.status` idle, or the older `session.idle`), the plugin
 *     lists the session's messages through its own OpenCode client and passes on their
 *     `step-finish` parts, one for each model call. For work time it also passes each message's
 *     times, each tool call's start and end, and the waits for the person's permission. For the
 *     harness's failures it passes a `bash` call's exit code and command line when it exited 2, 3
 *     or 4, and the name of a failed message's error.
 *   - At `permission.asked` and `permission.replied`, the plugin notes the time, and keeps each
 *     wait for its session's next idle. OpenCode keeps no such time in its messages.
 * It passes `scripts/observability-hook.mjs opencode`, on stdin, a command's name and arguments,
 * those command lines, and ids, times, model names and counts. Of a tool, it passes only whether it
 * is OpenCode's question tool, and a failed shell call's exit code and command line. The hook keeps only a key or a slug from the arguments and the
 * command lines. A seat is named by the `@<name>` that OpenCode puts at the end of a child session's
 * title. No other part of a title, and no message text, reaches the hook. The plugin waits for the
 * hook only at a command's start.
 *
 * A fork copies the messages of the session it came from under new ids, and keeps their times. A
 * message created before its own session is such a copy, and is skipped. The copies are older than
 * any run of the fork, so the hook would leave them out too: the plugin does not pass them at all.
 *
 * The hub is the folder this file is installed in, never OpenCode's working folder. OpenCode calls
 * every export of this file as a plugin, so the file exports nothing else. The plugin swallows every
 * failure, so it never disturbs OpenCode. The one exception is the hook's refusal of a command.
 */
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HUB = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const SEAT = /\(@([a-z0-9][a-z0-9-]{0,63}) subagent\)$/;
/** The five scripts whose command line names a story's key. The hook reads the key. */
const WORK_SCRIPTS = /check-dev-ready|check-validation|check-design-amend|jira-sync|test-guard/;

export const HarnessObservability = async ({ client, directory }) => {
  const hook = join(HUB, 'scripts', 'observability-hook.mjs');
  const sessions = new Map();

  // OpenCode runs a plugin on Bun, so process.execPath is Bun's. The hook runs on the Node of the
  // PATH, as every script of the harness does.
  const send = (payload) => {
    try {
      const child = spawn('node', [hook, 'opencode'], { cwd: HUB, stdio: ['pipe', 'ignore', 'ignore'], detached: true, windowsHide: true });
      child.on('error', () => {});
      child.stdin.on('error', () => {});
      child.stdin.end(JSON.stringify(payload));
      child.unref();
    } catch {
      // The next idle session sends again. Nothing is lost: the counts stay in OpenCode.
    }
  };

  /**
   * Runs the hook for a command's start and waits for it, 10 s at most. Gives the reason the hook
   * refuses the command, or null. A hook that fails or takes too long refuses nothing.
   */
  const ask = (payload) => new Promise((done) => {
    try {
      const child = spawn('node', [hook, 'opencode'], { cwd: HUB, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
      let out = '';
      const timer = setTimeout(() => { try { child.kill(); } catch { /* gone already */ } done(null); }, 10000);
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => { out += chunk; });
      child.on('error', () => { clearTimeout(timer); done(null); });
      child.on('close', () => {
        clearTimeout(timer);
        let answer = null;
        try { answer = JSON.parse(out.trim() || 'null'); } catch { answer = null; }
        done(answer && answer.decision === 'block' && typeof answer.reason === 'string' ? answer.reason : null);
      });
      child.stdin.on('error', () => {});
      child.stdin.end(JSON.stringify(payload));
    } catch {
      done(null);
    }
  });

  /** What the plugin keeps of a session: its parent, its creation time, its version and its seat. */
  const info = async (id) => {
    if (sessions.has(id)) return sessions.get(id);
    const res = await client.session.get({ path: { id } });
    const s = res?.data;
    if (!s) return null;
    const seat = s.parentID && typeof s.title === 'string' ? (s.title.match(SEAT) || [])[1] || null : null;
    const kept = { parentID: s.parentID || null, created: s.time?.created, version: s.version || null, seat };
    sessions.set(id, kept);
    return kept;
  };

  /** The session at the top of a chain of child sessions. The hook keeps its runs under that session. */
  const rootOf = async (id) => {
    let at = id;
    for (let depth = 0; depth < 6; depth += 1) {
      const s = await info(at);
      if (!s?.parentID) return at;
      at = s.parentID;
    }
    return at;
  };

  /** The session's own messages. A message created before its own session is a fork's copy. */
  const messagesOf = async (id, own) => {
    const res = await client.session.messages({ path: { id } });
    return (res?.data || []).filter((m) => m?.info?.time && !(Number.isFinite(own?.created) && m.info.time.created < own.created));
  };

  /** One entry for each `step-finish` part of the session's own assistant messages. */
  const calls = (messages) => {
    const out = [];
    for (const m of messages) {
      const i = m.info;
      if (i.role !== 'assistant') continue;
      for (const p of m.parts || []) {
        if (p?.type !== 'step-finish' || !p.tokens) continue;
        const t = p.tokens;
        out.push({
          id: p.id, ms: i.time.completed || i.time.created, model: i.modelID, provider: i.providerID,
          tokens: { input: t.input, output: t.output, reasoning: t.reasoning, cache: { read: t.cache?.read, write: t.cache?.write } },
        });
      }
    }
    return out;
  };

  /**
   * A `bash` call that can be a harness failure: its exit code when it exited 2, 3 or 4, the exit
   * codes its output states as `HARNESS EXIT: <script> <code>`, the token of its last `REASON:`
   * line, and its command line. A pipe or `; echo` can hide the call's own code, and the script
   * still states its own. A non-zero exit still completes the tool, with the code in
   * `metadata.exit`. The output itself is never passed, and the hook keeps only the name of the
   * harness script that the line runs.
   */
  const failed = (p) => {
    if (p.tool !== 'bash' || p.state?.status !== 'completed') return {};
    const exit = p.state.metadata?.exit;
    const said = p.state.metadata?.output ?? p.state.output;
    const output = typeof said === 'string' ? said : '';
    const stated = {};
    for (const m of output.matchAll(/^HARNESS EXIT: ([a-z][a-z0-9-]*) ([234])\s*$/gm)) stated[m[1]] = Number(m[2]);
    const failedExit = [2, 3, 4].includes(exit);
    if (!failedExit && !Object.keys(stated).length) return {};
    const reasons = [...output.matchAll(/^REASON: ([a-z][a-z0-9-]*)\s*$/gm)];
    const command = p.state.input?.command;
    if (typeof command !== 'string') return {};
    return { ...(failedExit ? { exit } : {}), stated, ...(reasons.length ? { reason: reasons[reasons.length - 1][1] } : {}), command };
  };

  /**
   * The times of the session's own messages: a user message's creation, and an assistant message's
   * span with the span of each tool call that ran in it. Only OpenCode's question tool keeps its name.
   * A message that failed keeps the name of its error. An abort is the person's, not a failure.
   */
  const times = (messages) => messages.map((m) => {
    const i = m.info;
    if (i.role === 'user') return { role: 'user', id: i.id, created: i.time.created };
    if (i.role !== 'assistant') return null;
    const tools = (m.parts || [])
      .filter((p) => p?.type === 'tool' && Number.isFinite(p.state?.time?.start) && Number.isFinite(p.state?.time?.end))
      .map((p) => ({ id: p.callID, name: p.tool === 'question' ? 'question' : 'other', start: p.state.time.start, end: p.state.time.end, ...failed(p) }));
    const error = typeof i.error?.name === 'string' && i.error.name !== 'MessageAbortedError' ? { error: i.error.name } : {};
    return { role: 'assistant', id: i.id, created: i.time.created, completed: i.time.completed ?? null, tools, ...error };
  }).filter(Boolean);

  // A permission's wait, from the question to the person's reply, kept for the session's next idle.
  const asked = new Map();
  const waits = new Map();
  const notePermission = (event) => {
    const p = event?.properties;
    if (event?.type === 'permission.asked' && typeof p?.id === 'string' && p.sessionID) asked.set(p.id, { session: p.sessionID, at: Date.now() });
    if (event?.type !== 'permission.replied' || !asked.has(p?.requestID)) return;
    const a = asked.get(p.requestID);
    asked.delete(p.requestID);
    waits.set(a.session, [...(waits.get(a.session) || []), { start: a.at, end: Date.now() }].slice(-200));
  };

  return {
    'command.execute.before': async (input) => {
      let refusal = null;
      try {
        if (!input?.sessionID) return;
        const at = Date.now();
        refusal = await ask({ hook_event_name: 'command', session_id: await rootOf(input.sessionID), name: input.command, arguments: input.arguments, at, cwd: directory });
      } catch {
        // Never disturb OpenCode, but for a refusal.
      }
      // OpenCode runs this hook inside its command, so the throw stops the command before its prompt.
      if (refusal) throw new Error(refusal);
    },
    'tool.execute.before': async (input, output) => {
      try {
        const command = output?.args?.command;
        if (input?.tool !== 'bash' || !input.sessionID || typeof command !== 'string' || command.search(WORK_SCRIPTS) === -1) return;
        const at = Date.now();
        send({ hook_event_name: 'tool', session_id: await rootOf(input.sessionID), command, at, cwd: directory });
      } catch {
        // Never disturb OpenCode.
      }
    },
    event: async ({ event }) => {
      try {
        notePermission(event);
        const p = event?.properties;
        if (!p?.sessionID) return;
        const idle = (event.type === 'session.status' && p.status?.type === 'idle') || event.type === 'session.idle';
        if (!idle) return;
        const own = await info(p.sessionID);
        const messages = await messagesOf(p.sessionID, own);
        send({
          hook_event_name: 'idle', session_id: await rootOf(p.sessionID), log_ref: p.sessionID,
          parent: own?.parentID ?? null, seat: own?.seat ?? null, version: own?.version ?? null,
          calls: calls(messages), times: times(messages), waits: waits.get(p.sessionID) || [], cwd: directory,
        });
      } catch {
        // Never disturb OpenCode.
      }
    },
  };
};

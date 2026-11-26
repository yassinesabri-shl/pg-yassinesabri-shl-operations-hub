/**
 * preflight.mjs — the mandatory Claude Code preflight: no engineer is dispatched until it passes.
 *
 * The engineer is a native Claude Code subagent of the orchestrator's session, so its hooks are the
 * block in the hub's engineer definition (.claude/agents/engineer.md). The preflight keeps a trusted
 * copy of that definition; reads Claude Code's own settings, and its trust in the hub folder, for
 * anything that would disable, distrust or overrule the hooks; and then runs every hook exactly as
 * Claude Code would — the command parsed back out of the definition, run from the hub, fed a
 * realistic subagent payload carrying a one-time nonce — and requires both Claude Code's own form of
 * the expected answer and the nonce recorded in this run's directory. That proves the hooks can run;
 * that Claude Code runs them for this run is proved later, by the engineer's binding claim, which
 * the finalizer requires.
 */

import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { HANDSHAKE, firstLine } from './common.mjs';
import { gitTry } from './git.mjs';
import { readEvents, saveState, snapshotHooks } from './state.mjs';
import { AGENT_FILE, AGENT_TYPE, HOOK_COMMAND, HOOK_EVENTS, agentProblems, hasHookBlock, removeEntry, writeEntry } from './subagent.mjs';

/**
 * A settings file: { missing } only when it is not there; { unreadable } when it is there and
 * cannot be read — a sandboxed orchestrator may be denied a file the engineer's runtime reads, so an
 * unreadable file is never taken for an absent one; { error } when it is not JSON; else { value }.
 */
function readJson(path) {
  let text;
  try { text = readFileSync(path, 'utf8'); } catch (err) {
    return err.code === 'ENOENT' || err.code === 'ENOTDIR' ? { missing: true } : { unreadable: err.code || err.message };
  }
  try { return { value: JSON.parse(text) }; } catch (err) { return { error: err.message }; }
}

function managedDirs() {
  if (process.env.HARNESS_TEST_GUARD_CLAUDE_MANAGED !== undefined) return process.env.HARNESS_TEST_GUARD_CLAUDE_MANAGED.split(delimiter).filter(Boolean);
  if (process.platform === 'darwin') return ['/Library/Application Support/ClaudeCode'];
  if (process.platform === 'win32') return ['C:\\Program Files\\ClaudeCode', 'C:\\ProgramData\\ClaudeCode'];
  return ['/etc/claude-code'];
}

/**
 * Whether Claude Code trusts the hub folder: it runs a project agent's frontmatter hooks only then,
 * and skips them otherwise without a word in the session. Claude Code counts a folder as trusted
 * when the folder or any folder above it has accepted the dialog, and saves the answer only for the
 * folder where the dialog was accepted. A hub checkout under .worktrees/<KEY>/ is therefore trusted
 * through the hub root, shows no dialog and has no entry of its own. Read from .claude.json
 * (in CLAUDE_CONFIG_DIR when set, else the home folder). Observed on Claude Code 2.1.296: an engineer
 * hook fired in a ticket hub whose parent alone was trusted. The finalizer's live proof still stops
 * a round whose hooks did not run, so this check is the early warning, not the boundary.
 */
function hubTrust(hub) {
  const keys = new Set([resolve(hub)]);
  try { keys.add(realpathSync.native(hub)); } catch { /* not there */ }
  const files = [...(process.env.CLAUDE_CONFIG_DIR ? [join(process.env.CLAUDE_CONFIG_DIR, '.claude.json')] : []), join(homedir(), '.claude.json')];
  for (const file of files) {
    const r = readJson(file);
    if (r.missing) continue;
    if (r.unreadable || r.error) return `${file} cannot be read (${r.unreadable || r.error}), so the preflight cannot tell whether Claude Code trusts the hub folder ${hub}. Without that trust, Claude Code runs the engineer without the guard's hooks`;
    const projects = (r.value && r.value.projects) || {};
    if (trustedFolder(projects, keys)) return null;
    return `Claude Code trusts neither the hub folder ${hub} nor a folder above it (${file}). Until it does, it runs the engineer subagent without the guard's hooks, and it says so only in its debug log. ${TRUST_FIX(hub)}`;
  }
  return `no Claude Code configuration (.claude.json) records the hub folder ${hub}, or a folder above it, as trusted. Until one does, Claude Code runs the engineer subagent without the guard's hooks. ${TRUST_FIX(hub)}`;
}

/** The hub folder, or the nearest folder above it, that Claude Code trusts, or null. Each key is one spelling of the hub's path. */
function trustedFolder(projects, keys) {
  for (const key of keys) {
    for (let d = key; ; d = dirname(d)) {
      if (projects[d] && projects[d].hasTrustDialogAccepted === true) return d;
      if (d === dirname(d)) break;
    }
  }
  return null;
}

/** What a person does: the dialog shows for a folder that nothing above it trusts. A -p session never accepts it. */
const TRUST_FIX = (hub) => `A person starts claude, not claude -p, in the main hub folder, the one that holds .worktrees/, and accepts the trust dialog there. That trust covers every ticket folder inside it, ${hub} included. Then run: node scripts/test-guard.mjs preflight --state <run>`;

/** What Claude Code would do to the engineer's hooks: no definition, untrusted, disabled, or overruled by policy. */
function settingsProblems(hub) {
  const stops = [...agentProblems(hub)];
  const notes = [];
  const trust = hubTrust(hub);
  if (trust) stops.push(trust);
  const user = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'settings.json');
  const managed = managedDirs().flatMap((d) => {
    let extra = [];
    try { extra = readdirSync(join(d, 'managed-settings.d')).filter((f) => f.endsWith('.json')).sort().map((f) => join(d, 'managed-settings.d', f)); } catch (err) {
      if (err.code !== 'ENOENT' && err.code !== 'ENOTDIR') stops.push(`${join(d, 'managed-settings.d')} cannot be listed (${err.code || err.message}), so the managed policy in it cannot be checked — make it readable where the preflight runs`);
    }
    return [join(d, 'managed-settings.json'), ...extra];
  });
  for (const [file, kind] of [...managed.map((f) => [f, 'managed']), [user, 'user'], [join(hub, '.claude', 'settings.json'), 'project'], [join(hub, '.claude', 'settings.local.json'), 'local']]) {
    const r = readJson(file);
    if (r.missing) continue;
    if (r.unreadable) { stops.push(`${file} exists but cannot be read (${r.unreadable}), so the preflight cannot tell whether it disables the guard's hooks — make it readable where the preflight runs, or remove it`); continue; }
    if (r.error) { (kind === 'managed' ? stops : notes).push(`${file} cannot be read as JSON (${r.error})${kind === 'managed' ? '' : '; Claude Code skips it'}`); continue; }
    if (r.value.disableAllHooks === true) stops.push(`${file} sets "disableAllHooks": true, so Claude Code runs none of the guard's hooks — remove it${kind === 'managed' ? ' (an administrator owns this file)' : ''}`);
    if (kind === 'managed' && r.value.allowManagedHooksOnly === true) stops.push(`${file} sets "allowManagedHooksOnly": true, so the hooks in ${AGENT_FILE} are ignored — an administrator must add the guard's hooks to managed settings or lift the restriction`);
  }
  notes.push('Claude Code policy from MDM or the claude.ai console is not a file this check can read; the engineer\'s first hook call claiming its dispatch proves the hooks ran, and the finalizer accepts nothing without it');
  return { stops, notes };
}

/** Realistic engineer-subagent payloads, as Claude Code 2.1 sends them: the hub as cwd, the agent's id. */
function handshakes({ clone, hub, nonce, approvedAbs }) {
  const base = { session_id: nonce, transcript_path: null, cwd: hub, permission_mode: 'default', agent_id: nonce, agent_type: AGENT_TYPE };
  const inClone = (cmd) => `cd "${clone}" && ${cmd}`;
  const ok = (o) => o.exit === 0;
  const denied = (o) => /"permissionDecision":"deny"/.test(o.stdout);
  return [
    { event: 'PreToolUse', payload: { ...base, hook_event_name: 'PreToolUse', tool_name: 'Write', tool_use_id: nonce, tool_input: { file_path: approvedAbs, content: 'x' } }, expect: denied },
    { event: 'PreToolUse', payload: { ...base, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: `${nonce}-workdir`, tool_input: { command: 'git status' } }, expect: (o) => denied(o) && /Begin every Bash command with cd/.test(o.stdout) },
    { event: 'PostToolUse', payload: { ...base, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: nonce, tool_input: { command: inClone('true') }, tool_response: { stdout: '', stderr: '', interrupted: false } }, expect: ok },
    { event: 'PostToolUseFailure', payload: { ...base, hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_use_id: nonce, tool_input: { command: inClone('false') }, error: 'Exit code 1', is_interrupt: false }, expect: ok },
    { event: 'Stop', recorded: 'SubagentStop', payload: { ...base, hook_event_name: 'SubagentStop', stop_hook_active: false, agent_transcript_path: null, last_assistant_message: '' }, expect: ok },
  ];
}

/**
 * A note when the hub is a linked worktree. Claude Code loads the engineer definition and runs its
 * hooks from the folder the session started in, which the preflight cannot read. A session started
 * in the main checkout runs another copy, and the hooks refuse the engineer at its first call.
 */
function linkedWorktree(hub) {
  const dirs = gitTry(hub, ['rev-parse', '--path-format=absolute', '--absolute-git-dir', '--git-common-dir']);
  const [own, common] = dirs.stdout.trim().split('\n');
  if (dirs.status !== 0 || !own || !common || own === common) return null;
  return `the hub ${hub} is a linked worktree of the checkout in ${dirname(common)}. The engineer's hooks accept it only when this Claude Code session started in ${hub}. Otherwise run preflight again with --hub <the folder the session started in>`;
}

/** Returns { stops, notes }; `stops` empty means the engineer may be dispatched. */
export function runPreflight({ state, dir, manifest, hub }) {
  const out = { stops: [], notes: [] };
  if (!state.engineer || !existsSync(state.engineer.path)) { out.stops.push('this run has no engineer clone on disk; run engineer-clone first'); return out; }
  const clone = realpathSync.native(state.engineer.path);
  // The hooks about to be handshaken put back what the run state names: it must name this
  // definition's trusted copy before they run.
  state.hooks = { files: snapshotHooks(dir, hub, [AGENT_FILE]), installed_at: new Date().toISOString() };
  state.hub = hub;
  state.preflight = { ok: false, at: new Date().toISOString() };
  saveState(dir, state);
  const checked = settingsProblems(hub);
  out.stops.push(...checked.stops);
  out.notes.push(...checked.notes);
  const linked = linkedWorktree(hub);
  if (linked) out.notes.push(linked);
  const file = join(hub, AGENT_FILE);
  let text;
  try { text = readFileSync(file, 'utf8'); } catch { return out; }

  const approved = manifest.find((e) => e.type === 'blob');
  const nonce = `${HANDSHAKE}${randomUUID()}`;
  const hctx = { clone, hub, nonce, approvedAbs: join(clone, approved.path) };
  const env = { ...process.env, CLAUDE_PROJECT_DIR: hub };
  writeEntry(hub, nonce, { state: dir, run_id: state.run_id, handshake: nonce });
  try {
    for (const hs of handshakes(hctx)) {
      if (!hasHookBlock(text) || !HOOK_EVENTS.includes(hs.event)) { out.stops.push(`${file} wires no ${hs.event} hook`); continue; }
      const r = spawnSync(HOOK_COMMAND, { shell: true, cwd: hub, env, input: JSON.stringify(hs.payload), encoding: 'utf8', timeout: 60000 });
      if (r.error || !hs.expect({ exit: r.status, stdout: r.stdout || '' })) out.stops.push(`the ${hs.event} hook did not answer as the guard does: exit ${r.status}, ${firstLine(r.stdout) || firstLine(r.stderr) || (r.error && r.error.message) || 'no output'}`);
    }
  } finally { removeEntry(hub, nonce); }
  const reached = new Set(readEvents(dir).filter((e) => e.phase === 'handshake' && e.nonce === nonce).map((e) => e.event));
  for (const hs of handshakes(hctx)) if (!reached.has(hs.recorded || hs.event)) out.stops.push(`the ${hs.event} hook ran but did not reach this run's directory (${dir}); it is not bound to the run`);
  return out;
}

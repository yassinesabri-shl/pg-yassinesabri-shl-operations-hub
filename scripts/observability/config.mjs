// Part of the harness asset library c6f3b4427d58f7c3 (see VERSION.json) · 2026-10-26
/**
 * config.mjs — what a hub must hold before anything is collected, and what the records take from it.
 *
 * A hub collects only when all of this holds:
 *   - it is a git checkout, and its main checkout is found;
 *   - `docs/estate/observability.json` exists and is well formed: the observability platform, its
 *     URL and the hub's id, and `auth` when the hub sends no write token;
 *   - git ignores the state folder, `.harness/observability/`.
 * Otherwise `hubContext` says why, and the hook writes nothing at all. Observability is not
 * optional: a harness command does not start in such a hub (`promptRefusal`), and neither does
 * one that needs a write token the session does not have. `/connect-observability-platform` is the
 * one command that always starts, because it makes the connection.
 *
 * Node standard library only, plus git.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONNECTION_PATH, RECEIPT_PATH, REGISTRY_PATH, credentialInUrl } from './common.mjs';
import { isIgnored, mainCheckout, stateDir } from './state.mjs';

export const PLATFORMS = ['cubeapm', 'grafana'];
/**
 * How the sender authorises its requests. `bearer`, the default when observability.json has no
 * `auth`, sends HARNESS_OBSERVABILITY_TOKEN. `none` sends no authorisation, for a receiver that
 * needs no key.
 */
export const AUTHS = ['bearer', 'none'];
const HUB_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
/** The host names of this laptop. Only these may take plain http, for an observability platform that runs locally. */
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** Every rule an observability.json breaks, as findings. Empty means it is well formed. */
export function validateConnection(u) {
  const problems = [];
  if (!u || typeof u !== 'object' || Array.isArray(u)) return ['it is not a JSON object'];
  const allowed = ['schema_version', 'hub', 'platform', 'url', 'auth', 'note'];
  for (const k of Object.keys(u)) if (!allowed.includes(k)) problems.push(`field ${k} is not allowed`);
  if (u.schema_version !== 1) problems.push('schema_version must be 1');
  if (typeof u.hub !== 'string' || u.hub.search(HUB_ID) !== 0) problems.push('hub must be an id: letters, digits, dot, dash or underscore');
  if (!PLATFORMS.includes(u.platform)) problems.push(`platform must be one of ${PLATFORMS.join(', ')}`);
  let url = null;
  try { url = new URL(u.url); } catch { url = null; }
  const local = url?.protocol === 'http:' && LOOPBACK.has(url.hostname);
  if (!url || (url.protocol !== 'https:' && !local)) problems.push('url must be an https URL, or an http URL to this laptop');
  else if (credentialInUrl(u.url)) problems.push('url must not carry a user name or a password. The write token stays in HARNESS_OBSERVABILITY_TOKEN');
  if ('auth' in u && !AUTHS.includes(u.auth)) problems.push('auth must be bearer or none');
  if ('note' in u && typeof u.note !== 'string') problems.push('note must be text');
  return problems;
}

const readJsonQuiet = (path) => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; } };

/**
 * What the records of a hub take from it, or `{ ok: false, cause, reason, why }` when the hub
 * collects nothing. `cause` is `not-git`, `missing`, `invalid` or `not-ignored`, and
 * `promptRefusal` reads it. `reason` is the REASON token that the status and the sender print.
 * `missing: true` says that the
 * hub has no observability.json at all, so `/connect-observability-platform` connects it. `start`
 * is any folder inside the hub or one of its linked worktrees.
 */
export function hubContext(start) {
  const main = mainCheckout(start);
  if (!main) return { ok: false, cause: 'not-git', reason: 'not-a-checkout', why: 'not inside a git checkout of a hub' };
  if (!existsSync(join(main, CONNECTION_PATH))) return { ok: false, main, cause: 'missing', missing: true, reason: 'config-invalid', why: `${CONNECTION_PATH} is missing, so this hub is not connected to its observability platform` };
  const connection = readJsonQuiet(join(main, CONNECTION_PATH));
  if (!connection) return { ok: false, main, cause: 'invalid', reason: 'config-invalid', why: `${CONNECTION_PATH} is not valid JSON` };
  const problems = validateConnection(connection);
  if (problems.length) return { ok: false, main, cause: 'invalid', reason: 'config-invalid', why: `${CONNECTION_PATH}: ${problems.join(' · ')}` };
  if (!isIgnored(main)) return { ok: false, main, cause: 'not-ignored', reason: 'config-invalid', why: 'git does not ignore .harness/observability/, so nothing is written. Add .harness/ to the hub\'s .gitignore' };
  const receipt = readJsonQuiet(join(main, RECEIPT_PATH));
  const commit = receipt && receipt.library && receipt.library.libraryCommit;
  const harness = typeof commit === 'string' && commit.search(/^[0-9a-f]{12,40}$/) === 0 ? commit.slice(0, 12) : null;
  const registry = readJsonQuiet(join(main, REGISTRY_PATH));
  const seats = new Set(Array.isArray(registry) ? registry.map((e) => e && e.agent_id).filter((id) => typeof id === 'string') : []);
  return { ok: true, main, dir: stateDir(main), hub: connection.hub, connection, auth: connection.auth ?? 'bearer', harness, seats };
}

/** The one harness command that starts in a hub with no connection, because it makes the connection. */
export const CONNECT_COMMAND = 'connect-observability-platform';

/**
 * Why the harness command `run` (from runs.mjs `parseCommand`) does not start in this hub, or null
 * when it starts. Every harness command needs the connection, and with `bearer` the write token.
 * The reason names the fix. It never repeats the URL or the token.
 */
export function promptRefusal(ctx, run, env = process.env) {
  if (!run || run.command === CONNECT_COMMAND) return null;
  const start = `Observability: /${run.command} did not start.`;
  const connect = `Run /${CONNECT_COMMAND} first, and merge its pull request. If it is merged already, pull the trunk.`;
  if (!ctx.ok && ctx.cause === 'missing') return `${start} This hub is not connected to its observability platform. Every harness command needs that connection. ${connect}`;
  if (!ctx.ok && ctx.cause === 'invalid') return `${start} ${ctx.why}. Run /${CONNECT_COMMAND} to correct the connection.`;
  if (!ctx.ok && ctx.cause === 'not-ignored') return `${start} Git does not ignore .harness/observability/, so no record can be written. Add the line .harness/ to the hub's .gitignore.`;
  if (!ctx.ok) return `${start} The hub is not a git checkout, so its connection to the observability platform cannot be read.`;
  if (ctx.auth === 'bearer' && !env.HARNESS_OBSERVABILITY_TOKEN) return `${start} HARNESS_OBSERVABILITY_TOKEN is not set, and this hub's observability platform needs a write token. Set it in your environment, then start a new session.`;
  return null;
}

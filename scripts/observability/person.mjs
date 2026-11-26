// Part of the harness asset library c6f3b4427d58f7c3 (see VERSION.json) · 2026-11-11
/**
 * person.mjs — the person who runs a harness command: the value that a record carries in `person`.
 *
 * The person comes from the first of two sources:
 *   gh   the login of the GitHub account that the GitHub CLI is signed in to, asked in the hub's
 *        main checkout, so that gh takes the host of the hub's repository
 *   git  `user.email` in the hub's main checkout, when gh is missing, signed out or too slow
 * Each value is lowercased. A value of another shape is no value: free text never reaches a record.
 * Neither source gives a value: the person is null, never a guess.
 *
 * gh asks the network, so the hook waits for it 2 seconds at most, and `person.json` in the state
 * folder keeps its answer. A login is kept for a day. An empty answer, when gh is missing, signed
 * out or too slow, is kept for an hour: the hook asks gh again once an hour while it fails, and a
 * person who signs in to gh soon takes their login.
 *
 * Node standard library only, plus git and gh.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { nowMs } from './common.mjs';
import { readJson, writeJson } from './state.mjs';

/** How long a login from gh stays in person.json. */
export const GH_KEEP_MS = 24 * 3600 * 1000;
/** How long an empty answer from gh stays in person.json. */
export const GH_EMPTY_KEEP_MS = 3600 * 1000;
/** How long the hook waits for gh. */
export const GH_TIMEOUT_MS = 2000;

/** A GitHub login: letters, digits and single hyphens, at most 39 characters. */
const LOGIN = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,38}$/;
/** An e-mail address, with no space, quote or angle bracket. */
const EMAIL = /^[a-z0-9._%+-]{1,64}@[a-z0-9-]{1,63}(?:\.[a-z0-9-]{1,63})+$/;

/** True when `text` is a person's value of the right shape: a GitHub login or an e-mail address, lowercase. */
export const isPerson = (text) => typeof text === 'string' && text.length <= 254 && (text.search(LOGIN) === 0 || text.search(EMAIL) === 0);

/** A value from a source, lowercased, or null when it does not have the shape of a login or an address. */
function clean(text) {
  if (typeof text !== 'string') return null;
  const value = text.trim().toLowerCase();
  return isPerson(value) ? value : null;
}

const cachePath = (dir) => join(dir, 'person.json');

/** The login gh gives, or null. Never a prompt: gh asks nothing and stops after GH_TIMEOUT_MS. */
function askGh(main) {
  const env = { ...process.env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', GH_SPINNER_DISABLED: '1', NO_COLOR: '1' };
  const r = spawnSync('gh', ['api', 'user', '--jq', '.login'], { cwd: main, encoding: 'utf8', timeout: GH_TIMEOUT_MS, env, windowsHide: true });
  if (r.error || r.status !== 0) return null;
  const login = clean(r.stdout);
  return login && login.search(LOGIN) === 0 ? login : null;
}

/** The address git gives in the hub's main checkout, or null. */
export function gitPerson(main) {
  const r = spawnSync('git', ['config', '--get', 'user.email'], { cwd: main, encoding: 'utf8' });
  if (r.error || r.status !== 0) return null;
  const email = clean(r.stdout);
  return email && email.search(EMAIL) === 0 ? email : null;
}

/**
 * gh's login from person.json while it is fresh, else from gh itself, which person.json then keeps.
 * With `fresh`, gh itself, and person.json does not change.
 */
function ghPerson(ctx, now, fresh) {
  if (fresh) return askGh(ctx.main);
  let kept = null;
  try { kept = readJson(cachePath(ctx.dir), null); } catch { kept = null; }
  if (kept && Number.isFinite(kept.checked_ms) && kept.checked_ms <= now) {
    const login = clean(kept.login);
    const keep = login ? GH_KEEP_MS : GH_EMPTY_KEEP_MS;
    if (now - kept.checked_ms < keep) return login;
  }
  const login = askGh(ctx.main);
  try { writeJson(cachePath(ctx.dir), { checked_ms: now, login }); } catch { /* the next prompt asks again */ }
  return login;
}

/**
 * The person who runs a command in this hub, as { person, from }: gh first, then git, then null.
 * `ctx` is hubContext(start), with ok: true. `fresh` asks gh past person.json and writes nothing,
 * as the status command does.
 */
export function personOf(ctx, { now = nowMs(), fresh = false } = {}) {
  const login = ghPerson(ctx, now, fresh);
  if (login) return { person: login, from: 'gh' };
  const email = gitPerson(ctx.main);
  if (email) return { person: email, from: 'git' };
  return { person: null, from: null };
}

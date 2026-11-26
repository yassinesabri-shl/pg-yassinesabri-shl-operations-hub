#!/usr/bin/env node
// Part of the harness asset library c6f3b4427d58f7c3 (see VERSION.json) · 2026-10-26
/**
 * observability-status.mjs — what observability holds on this laptop for this hub: the queue, its
 * oldest record, the refusals and the last send. It changes nothing.
 *
 *     node scripts/observability-status.mjs [--hub <folder>]
 *
 * It never prints the write token. It says how the hub authorises its requests, and with bearer,
 * whether HARNESS_OBSERVABILITY_TOKEN is set. It names the person that a new run's records name, and
 * where that came from: gh, asked now, or git. It warns when records name no person.
 *
 * Exit 0: nothing needs a person.
 * Exit 1: the observability platform refused records, or a record has waited more than 7 days. An
 *         observability platform refuses old records.
 * Exit 2: cannot verify. There is no observability.json, or git does not ignore the state folder. A
 *         hub with no observability.json is told to run /connect-observability-platform.
 * Exit 3: a usage error. Exit 4: an internal error.
 *
 * Node standard library only, plus git and gh.
 */
import { existsSync, readdirSync, realpathSync, writeSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXIT, nowMs, reasonLine } from './observability/common.mjs';
import { hubContext } from './observability/config.mjs';
import { personOf } from './observability/person.mjs';
import { loadPrices } from './observability/prices.mjs';
import { prepare } from './observability/sender.mjs';
import { folders, readJson, readyRecords } from './observability/state.mjs';

const USAGE = 'usage: node scripts/observability-status.mjs [--hub <folder>]';
const OLD_MS = 7 * 24 * 3600 * 1000;

function parseArgs(argv) {
  const out = { hub: process.cwd() };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--hub' && argv[i + 1]) { out.hub = resolve(argv[i + 1]); i += 1; }
    else if (argv[i] === '--help') return { help: true };
    else return { error: `unknown argument ${argv[i]}` };
  }
  return out;
}

const count = (dir, ext) => (existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith(ext)).length : 0);

function age(ms) {
  if (ms < 3600 * 1000) return `${Math.max(1, Math.round(ms / 60000))} min`;
  if (ms < 2 * 24 * 3600 * 1000) return `${Math.round(ms / 3600000)} h`;
  return `${Math.round(ms / 86400000)} days`;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { process.stdout.write(`${USAGE}\n`); return EXIT.PASS; }
  if (args.error) { process.stderr.write(`${args.error}\n${USAGE}\n`); return EXIT.USAGE; }
  const ctx = hubContext(args.hub);
  if (!ctx.ok) {
    process.stdout.write(`CANNOT VERIFY: ${ctx.why}.${ctx.missing ? ' Run /connect-observability-platform to connect it.' : ''}\n${reasonLine(ctx.reason)}`);
    return EXIT.CANNOT_VERIFY;
  }
  const f = folders(ctx.dir);
  const now = nowMs();
  const prices = loadPrices();
  const ready = readyRecords(ctx.dir);
  const held = ready.filter((e) => prepare(e, { dir: ctx.dir, features: new Map(), prices, now }) === null).length;
  const oldest = ready.reduce((m, e) => Math.min(m, e.local?.created_ms ?? now), now);
  const refused = count(f.refused, '.json');
  const st = readJson(join(ctx.dir, 'send-state.json'), { failures: 0, next_ms: 0 });
  const lines = [
    `Observability for hub ${ctx.hub}, sent to ${ctx.connection.platform} at ${ctx.connection.url}.`,
    'State folder: .harness/observability/ in the main checkout. Git ignores it.',
    `Queue: ${ready.length - held} ready to send, ${held} waiting for a key, ${count(f.queue, '.pending')} pending.${ready.length ? ` The oldest has waited ${age(now - oldest)}.` : ''}`,
    `Refused by the observability platform: ${refused}.${refused ? ' See .harness/observability/refused/ for its answers.' : ''}`,
    `Last send: ${st.last_sent_ms ? new Date(st.last_sent_ms).toISOString() : 'none yet'}. Failures in a row: ${st.failures || 0}.${st.failures && st.why ? ` The last failure: ${st.why}.` : ''}${st.next_ms > now ? ` The next try is after ${new Date(st.next_ms).toISOString()}.` : ''}`,
    ctx.auth === 'none'
      ? 'Authorisation: none. Records go without authorisation, and HARNESS_OBSERVABILITY_TOKEN is not used.'
      : `Authorisation: bearer. HARNESS_OBSERVABILITY_TOKEN: ${process.env.HARNESS_OBSERVABILITY_TOKEN ? 'set' : 'not set, so nothing can be sent'}.`,
  ];
  const { person, from } = personOf(ctx, { now, fresh: true });
  if (from === 'gh') lines.push(`Person: ${person}, the GitHub login that gh is signed in to. A new run's records name this person.`);
  else if (from === 'git') lines.push(`Person: ${person}, from git's user.email, because gh gives no login. A new run's records name this person.`);
  else lines.push('WARN Person: none. gh gives no login and git has no user.email, so a new run\'s records name no person. Run `gh auth login`, or `git config user.email <address>`.');
  const old = ready.length > 0 && now - oldest > OLD_MS;
  if (old) lines.push('WARN a record has waited more than 7 days. An observability platform refuses old records, so send it soon or check the connection.');
  process.stdout.write(`${lines.join('\n')}\n`);
  return refused > 0 || old ? EXIT.FAIL : EXIT.PASS;
}

const invoked = (() => { try { return realpathSync(process.argv[1] || '') === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })();
if (invoked) {
  // The last line of an exit 2, 3 or 4 names this script and its code, so a shell line that hides
  // the code, with a pipe or `; echo`, still tells the harness's failure record. Written at once,
  // so a process.exit() never loses it.
  process.on('exit', (code) => { if (code >= 2 && code <= 4) { try { writeSync(2, `HARNESS EXIT: observability-status ${code}\n`); } catch { /* stderr is closed */ } } });
  try {
    process.exit(main());
  } catch (err) {
    process.stderr.write(`internal error: ${err && err.message ? err.message : String(err)}\n`);
    process.exit(EXIT.INTERNAL);
  }
}

#!/usr/bin/env node
// Part of the harness asset library c6f3b4427d58f7c3 (see VERSION.json) · 2026-10-26
/**
 * observability-send.mjs — sends the hub's ready records to its observability platform
 * (scripts/observability/sender.mjs). The observability hook starts it in the background after it
 * queues records. A person may run it by hand:
 *
 *     node scripts/observability-send.mjs [--hub <folder>]
 *
 * The write token comes from HARNESS_OBSERVABILITY_TOKEN, and never from a file. A hub whose
 * observability.json says "auth": "none" sends no token at all.
 *
 * Exit 0: everything ready was sent, nothing was ready, or another sender is running.
 * Exit 1: the observability platform refused some records. They are in
 *         .harness/observability/refused/, with its answer.
 * Exit 2: cannot verify. There is no observability.json, or no HARNESS_OBSERVABILITY_TOKEN for a
 *         hub that uses bearer, or the observability platform could not be reached. The records
 *         wait in the queue.
 * Exit 3: a usage error. Exit 4: an internal error.
 *
 * Node standard library only, plus git.
 */
import { realpathSync, writeSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXIT, reasonLine } from './observability/common.mjs';
import { drain } from './observability/sender.mjs';

const USAGE = 'usage: node scripts/observability-send.mjs [--hub <folder>]';

function parseArgs(argv) {
  const out = { hub: process.cwd() };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--hub' && argv[i + 1]) { out.hub = resolve(argv[i + 1]); i += 1; }
    else if (argv[i] === '--help') return { help: true };
    else return { error: `unknown argument ${argv[i]}` };
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { process.stdout.write(`${USAGE}\n`); return EXIT.PASS; }
  if (args.error) { process.stderr.write(`${args.error}\n${USAGE}\n`); return EXIT.USAGE; }
  const r = await drain({ start: args.hub });
  if (r.busy) { process.stdout.write('Another sender is running for this hub. Nothing was sent by this one.\n'); return EXIT.PASS; }
  if (r.waiting_until) { process.stdout.write(`The last send failed. The next try is after ${new Date(r.waiting_until).toISOString()}.\n`); return EXIT.PASS; }
  process.stdout.write(`Sent ${r.sent} record(s). Refused ${r.refused}. Waiting for a key: ${r.held}.\n`);
  if (r.why) process.stdout.write(`CANNOT VERIFY: ${r.why}.\n${reasonLine(r.reason)}`);
  return r.code;
}

const invoked = (() => { try { return realpathSync(process.argv[1] || '') === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })();
if (invoked) {
  // The last line of an exit 2, 3 or 4 names this script and its code, so a shell line that hides
  // the code, with a pipe or `; echo`, still tells the harness's failure record. Written at once,
  // so a process.exit() never loses it.
  process.on('exit', (code) => { if (code >= 2 && code <= 4) { try { writeSync(2, `HARNESS EXIT: observability-send ${code}\n`); } catch { /* stderr is closed */ } } });
  main().then((code) => process.exit(code), (err) => {
    process.stderr.write(`internal error: ${err && err.message ? err.message : String(err)}\n`);
    process.exit(EXIT.INTERNAL);
  });
}

#!/usr/bin/env node
// Part of the harness asset library c6f3b4427d58f7c3 (see VERSION.json) · 2026-10-24
/**
 * report-context.mjs — where the documents an artefact read sit in the hub's history.
 *
 *   usage:  node scripts/report-context.mjs <artefact-path>
 *
 * The artefact is a requirements document, a story or a design, read from the
 * working directory of a hub checkout. It carries one `Context:` line, which
 * pins the bytes of every document it read, and one `Hub commit:` line, which
 * names the hub commit that held them, both copied from scripts/read-context.mjs.
 * This script reads the two lines and prints, for a person, one block per
 * document: its kind, revision and status at the pinned bytes, the hub commit
 * that holds them and that commit's date, and whether the hub's trunk still
 * holds those bytes. It changes nothing, and it asks no remote: the trunk is
 * the local ref refs/remotes/origin/<HARNESS_TRUNK, or main>, never fetched,
 * as check-context.mjs reads it. Run it after `git fetch` for the trunk as it
 * is now.
 *
 * What it prints:
 *
 *   Artefact: <path>
 *   Kind: requirements document | story | design | artefact
 *   Trunk: refs/remotes/origin/<branch> at <40-hex>
 *   Hub commit: <40-hex> (<12-hex>, <date>, on the trunk)   or `not read`
 *   Global: vX.Y.Z <40-hex>                  (only when the line carries a global entry)
 *   Context: <n> document(s): <a> current, <b> drift[, <c> at the global release][, <d> in a spoke]
 *   Status: READ | FAIL: <n> finding(s) | CANNOT VERIFY: <n> reason(s)
 *   ---
 *   Document: <id>
 *   Layer: hub · Kind: <kind> · Revision: <text> · Status: <status>
 *   Path: <path>
 *   Pin: <12-hex> · held at <12-hex>, <date>
 *   Trunk: current | drift: <pin> → <now> | drift: <pin> → removed
 *   ---
 *
 * A global entry pins the commit of the release the artefact's requirements
 * document records, so its block names the release and never drifts. A spoke
 * entry is printed by its form alone: this script reads the hub and no spoke;
 * `scripts/read-context.mjs <repo-id> --pinned` reads the spoke's bytes.
 *
 * The judgement lives in context-docs.mjs (`contextReport`), and jira-sync.mjs
 * puts the same rows in a mirrored issue's description, so the two agree.
 *
 * Exit codes
 *   0  read, drift included: drift is the reader's fact to weigh
 *   1  the artefact is wrong: a Context: or Hub commit: line missing, doubled or
 *      malformed, a hub commit the trunk does not hold, a hub entry the hub
 *      commit does not hold, or a global entry that pins another commit than the
 *      recorded release
 *   2  cannot verify: the trunk ref cannot be read, the clone is too shallow to
 *      see the hub commit, or the requirements document a global entry needs is
 *      not on the trunk. The report is still printed
 *   3  usage: no artefact path, more than one, or a path that cannot be read
 *   4  internal
 */

import { readFileSync, writeSync } from 'node:fs';
import { stdout, stderr } from 'node:process';
import { EXIT, SpokeError, reasonLine } from './spoke-remote.mjs';
import { contextReport, contextReportExit, contextReportLines } from './context-docs.mjs';

function usage(message) {
  const invoked = process.argv[1] || 'scripts/report-context.mjs';
  stderr.write(`${message}\nusage: node ${invoked} <artefact-path>\n`);
  process.exit(EXIT.USAGE);
}

function main() {
  const args = process.argv.slice(2);
  if (args.some((a) => a.startsWith('--'))) usage(`unknown option ${args.find((a) => a.startsWith('--'))}; the report takes one artefact path and no option`);
  if (args.length !== 1) usage('expected exactly one argument: the path of a requirements document, a story or a design');
  const path = args[0];
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    usage(`cannot read ${path}: ${err.message}`);
  }

  const report = contextReport({ root: '.', path, text });
  stdout.write(`${contextReportLines(report).join('\n')}\n`);
  if (report.findings.length) stderr.write(`FAIL: the artefact's lines cannot be placed in the hub's history as written:\n  - ${report.findings.join('\n  - ')}\n`);
  if (report.cannot.length) stderr.write(`CANNOT VERIFY: ${report.cannot.join('\n  - ')}\n${reasonLine(report.reason)}`);
  process.exit(contextReportExit(report));
}

// The last line of an exit 2, 3 or 4 names this script and its code, so a shell line that hides
// the code, with a pipe or `; echo`, still tells the harness's failure record. Written at once,
// so a process.exit() never loses it.
process.on('exit', (code) => { if (code >= 2 && code <= 4) { try { writeSync(2, `HARNESS EXIT: report-context ${code}\n`); } catch { /* stderr is closed */ } } });

try {
  main();
} catch (err) {
  if (err instanceof SpokeError) {
    stderr.write(`${err.exit === EXIT.CANNOT_VERIFY ? 'CANNOT VERIFY' : 'FAIL'}: ${err.message}\n${reasonLine(err.reason)}`);
    process.exit(err.exit);
  }
  stderr.write(`INTERNAL: ${err && err.stack ? err.stack : String(err)}\n`);
  process.exit(EXIT.INTERNAL);
}

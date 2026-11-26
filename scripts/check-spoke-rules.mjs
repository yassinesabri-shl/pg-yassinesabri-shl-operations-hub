#!/usr/bin/env node
// Part of the harness asset library c6f3b4427d58f7c3 (see VERSION.json) · 2026-09-14
/**
 * check-spoke-rules.mjs — is a spoke's rules folder well formed?
 *
 *   usage:  node scripts/check-spoke-rules.mjs <repo-id> [--at <commit|12-hex>] [--registry <file>]
 *           node scripts/check-spoke-rules.mjs --local <dir> [--index <path>]
 *
 * Two ways in, one check.
 *
 *   Remote, from the hub: the repository id names an entry in the list, the
 *   commands file is read at the trunk head (or --at), and the folder its
 *   RULES_INDEX names is read at the same commit. --at takes a full
 *   40-character commit, or its first 12 characters, as read-spoke.mjs does.
 *
 *   Local, from the spoke's own CI: --local names a checkout on disk; the
 *   commands file at its root says where the folder is, or --index says so
 *   directly. The story-gate workflow runs this from the hub checkout it already
 *   holds, so a spoke carries no third file.
 *
 * What is checked -- every rule, then the set, one run listing everything:
 *   - every entry is a `.md` file; no sub-folders, nothing else;
 *   - every file opens with frontmatter carrying `name`, `description`, `globs`
 *     (a one-line JSON array) and `alwaysApply` (true or false), at most one
 *     optional `overrides` (a one-line JSON array of standard ids or standard
 *     rule ids, with or without the `global.` prefix), then a body. Whether an
 *     overridden id exists is the hub's to check, in `read-context.mjs`,
 *     because a spoke reads no hub;
 *   - every file is within the line cap `spoke-rules.mjs` publishes;
 *   - names are unique; exactly one rule is `alwaysApply: true`; a path-scoped
 *     rule does not carry a catch-all glob.
 *
 * Exit codes
 *   0  well formed; or the repository declares `none`; or RULES_INDEX is not
 *      configured. The last two are reported as such, never as a pass on rules
 *   1  the folder is not where the commands file says, or a finding
 *   2  cannot verify: no registry, or the remote could not be reached, or a
 *      12-character --at matches no commit on the trunk, or more than one
 *   3  usage
 *   4  internal
 */

import { existsSync, writeSync } from 'node:fs';
import { stdout, stderr } from 'node:process';
import {
  EXIT, REPO_ID, SpokeError, reasonLine, atProblem, pinAt,
  registryPath, readRegistry, validateRegistry,
  resolveSpokeTrunk, cacheDir, short,
} from './spoke-remote.mjs';
import { RULES_INDEX_KEY, readRulesAt, readRulesLocal } from './spoke-rules.mjs';

function usage(message) {
  const invoked = process.argv[1] || 'scripts/check-spoke-rules.mjs';
  stderr.write(`${message}\nusage: node ${invoked} <repo-id> [--at <commit|12-hex>] [--registry <file>]\n       node ${invoked} --local <dir> [--index <path>]\n`);
  process.exit(EXIT.USAGE);
}

function parseArgs(argv) {
  const out = { positional: [], at: null, registry: null, local: null, index: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--at' || a === '--registry' || a === '--local' || a === '--index') {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) usage(`${a} needs a value`);
      out[a.slice(2)] = v;
      i += 1;
    } else if (a.startsWith('--')) {
      usage(`unknown option ${a}`);
    } else {
      out.positional.push(a);
    }
  }
  return out;
}

function report(where, read) {
  stdout.write(`\nspoke rules  (${where})\n\n`);
  if (read.state === 'not-configured') {
    stdout.write(`  [NOT CONFIGURED] ${RULES_INDEX_KEY} is missing, empty or UNRESOLVED\n\nNOT CONFIGURED: this repository has not said whether it writes rules. Reported in every pull-request body; never a pass.\n`);
    return EXIT.PASS;
  }
  if (read.state === 'none') {
    stdout.write(`  [PASS] ${RULES_INDEX_KEY}=none\n\nNO RULES DECLARED: this repository says on purpose that it has no written rules.\n`);
    return EXIT.PASS;
  }
  if (read.state !== 'path') {
    stdout.write(`  [FAIL] ${RULES_INDEX_KEY}\n`);
    for (const f of read.findings) stdout.write(`         - ${f}\n`);
    stdout.write(`\nNOT WELL FORMED: ${read.findings.length} finding(s).\n`);
    return EXIT.FAIL;
  }
  const byPath = new Map();
  for (const f of read.findings) {
    const m = f.match(/^([^:]+): /);
    const key = m ? m[1] : read.path;
    if (!byPath.has(key)) byPath.set(key, []);
    byPath.get(key).push(m ? f.slice(m[0].length) : f);
  }
  for (const rule of read.rules) {
    const findings = byPath.get(rule.path) || [];
    const tags = [rule.name, ...(rule.alwaysApply ? ['always on'] : []), ...(rule.overrides.length ? [`overrides ${rule.overrides.join(', ')}`] : [])];
    stdout.write(`  [${findings.length ? 'FAIL' : 'PASS'}] ${rule.path}${rule.name ? `  (${tags.join(', ')})` : ''}\n`);
    for (const f of findings) stdout.write(`         - ${f}\n`);
    byPath.delete(rule.path);
  }
  for (const [key, findings] of byPath) {
    stdout.write(`  [FAIL] ${key}\n`);
    for (const f of findings) stdout.write(`         - ${f}\n`);
  }
  stdout.write('\n');
  if (read.findings.length) {
    stdout.write(`NOT WELL FORMED: ${read.findings.length} finding(s). A malformed rule set binds nobody until it is fixed.\n`);
    return EXIT.FAIL;
  }
  const alwaysOn = read.rules.find((r) => r.alwaysApply);
  stdout.write(`WELL FORMED: ${read.rules.length} rule(s) in ${read.path}, always on: ${alwaysOn.name}.\n`);
  return EXIT.PASS;
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.local !== null) {
    if (args.positional.length || args.at !== null || args.registry !== null) usage('--local takes no repository id, --at or --registry');
    if (!existsSync(args.local)) usage(`--local ${args.local} does not exist`);
    const read = readRulesLocal(args.local, { indexPath: args.index });
    if (read.state === 'no-commands-file') {
      stderr.write(`FAIL: ${read.findings.join('; ')}; pass --index <path> or write the commands file\n`);
      process.exit(EXIT.FAIL);
    }
    process.exit(report(`${args.local}, local`, read));
  }

  if (args.index !== null) usage('--index is only for --local');
  if (args.positional.length !== 1) usage('expected exactly one argument: <repo-id>, or --local <dir>');
  const [id] = args.positional;
  if (!REPO_ID.test(id)) usage(`"${id}" is not a repository id (letters, digits, ".", "_", "-")`);
  if (args.at !== null && atProblem(args.at)) usage(atProblem(args.at));

  const regPath = registryPath(args.registry);
  const registry = readRegistry(regPath);
  const problems = validateRegistry(registry, regPath);
  if (problems.length) {
    throw new SpokeError(EXIT.FAIL, `the registry is not well formed; run check-registry first:\n  - ${problems.join('\n  - ')}`);
  }
  const entry = registry.repositories[id];
  if (!entry) {
    const known = Object.keys(registry.repositories);
    usage(`"${id}" is not in ${regPath}. Listed: ${known.length ? known.join(', ') : '(nothing yet)'}. Add it with /add-repo`);
  }

  const dir = cacheDir(id);
  let commit;
  let trunk;
  if (args.at === null) {
    ({ trunk, head: commit } = resolveSpokeTrunk(entry, dir));
  } else {
    trunk = 'not asked';
    commit = pinAt(id, entry, dir, args.at);
  }
  const read = readRulesAt(dir, commit, entry.checks);
  if (read.state === 'no-commands-file') {
    stderr.write(`NOT FOUND: ${entry.checks} is not in ${id} at ${short(commit)} (trunk: ${trunk})\n`);
    process.exit(EXIT.FAIL);
  }
  process.exit(report(`${id} at ${short(commit)}, trunk: ${trunk}`, read));
}

// The last line of an exit 2, 3 or 4 names this script and its code, so a shell line that hides
// the code, with a pipe or `; echo`, still tells the harness's failure record. Written at once,
// so a process.exit() never loses it.
process.on('exit', (code) => { if (code >= 2 && code <= 4) { try { writeSync(2, `HARNESS EXIT: check-spoke-rules ${code}\n`); } catch { /* stderr is closed */ } } });

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

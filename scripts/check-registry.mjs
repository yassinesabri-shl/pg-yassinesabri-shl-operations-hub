#!/usr/bin/env node
// Part of the harness asset library c6f3b4427d58f7c3 (see VERSION.json) · 2026-09-12
/**
 * check-registry.mjs — is the list of repositories still true?
 *
 *   usage:  node scripts/check-registry.mjs [--offline] [--registry <file>]
 *
 * The registry is an index, never the truth. This script re-asks each remote the
 * questions the registry claims answers to, and reports. It runs in the hub as a
 * report-only job and by hand; it is not a required check, because it reads
 * several remotes and a check that stalls on another repository's outage is not
 * enforcement.
 *
 * Two passes.
 *
 *   1. Shape, offline. The file parses, and every entry has the five fields the
 *      schema names and nothing else: an id in the gate's grammar, a URL with no
 *      credential in it, a relative path for the commands file, a purpose that is
 *      prose and not a placeholder, a full commit hash for readAt, and a trunk
 *      that is `default` or a branch name. A shape failure stops the run: there
 *      is no point asking a remote about an entry that is not an entry.
 *   2. Truth, against each remote, unless --offline:
 *        - the trunk rule (spoke-remote.mjs): the remote answers, the trunk
 *          the entry names exists on it, and TRUNK_FOR_HUB in the commands
 *          file at its tip names the same trunk. A tip with no commands file
 *          is the spoke install's own window: the agreement is reported as
 *          pending, and the entry still passes;
 *        - where the commands file is at the trunk's head and names a rules
 *          folder (RULES_INDEX), that folder is there too;
 *        - the commands file names the spoke's own secret scan
 *          (SECRET_SCAN_COMMAND is a command; missing, empty, UNRESOLVED and
 *          `none` all fail), because every spoke scans before a commit exists;
 *        - the commands file lists this hub's key prefix in HUBS, because the
 *          spoke's story-gate clones only the hub whose prefix the key carries.
 *          The prefix is the one in this hub's docs/backlog/keys.json. A hub
 *          with no ledger yet has no prefix, and HUBS is only checked for form;
 *        - the library the spoke's harness files came from (HARNESS_LIBRARY)
 *          has this hub's major version, from docs/harness-install.json. Every
 *          hub of a spoke runs one major, because each hub's gate runs against
 *          the spoke's one set of files. Not recorded yet is a note: the next
 *          upgrade records it;
 *        - readAt is a commit the remote knows. Equal to the head is "current";
 *          older is "stale", reported and not failed, because /add-repo is the
 *          fix and the checker is not it; unknown to the remote is a failure,
 *          because a purpose read at a commit nobody can open was read nowhere.
 *
 * Exit codes -- the gate's, and the highest across repositories:
 *   0  every entry is well formed and, unless offline, true
 *   1  a shape failure, a commands file with no secret scan, without this hub
 *      in HUBS or on another major version, or an unknown readAt
 *   2  cannot verify: no registry, a remote that could not be reached, a
 *      declared trunk the remote does not have, or a TRUNK_FOR_HUB that does
 *      not name the registry's trunk
 *   3  usage
 *   4  internal
 *
 * What this script cannot see
 *   - Whether the purpose is right. It checks that one is written, not what it
 *     says. A purpose is for ranking, and a plan never cites it.
 *   - Whether the commands in the commands file work. The spoke's own CI runs
 *     them on the spoke's install pull request; this only checks the file is
 *     where the registry says.
 *   - A repository the team forgot to add. It checks the list it is given.
 */

import { existsSync, readFileSync, writeSync } from 'node:fs';
import { stdout, stderr } from 'node:process';
import {
  EXIT, SpokeError, reasonLine,
  registryPath, readRegistry, validateRegistry,
  resolveSpokeTrunk, cacheDir, hasCommit, fetchOne, fetchBranchFully, short, KEYS_PATH, readHubPrefix,
} from './spoke-remote.mjs';
import { readHubsAt, readLibraryAt, readRulesAt, readSecretScanAt, HUBS_KEY, LIBRARY_KEY, SECRET_SCAN_KEY } from './spoke-rules.mjs';

const RECEIPT_PATH = 'docs/harness-install.json';

// This hub's library version, from its receipt in the working tree, or null.
function hubVersion() {
  if (!existsSync(RECEIPT_PATH)) return null;
  try {
    const version = ((JSON.parse(readFileSync(RECEIPT_PATH, 'utf8')) || {}).library || {}).harnessVersion;
    return typeof version === 'string' && version.match(/^\d+\./) ? version : null;
  } catch {
    return null;
  }
}

function usage(message) {
  const invoked = process.argv[1] || 'scripts/check-registry.mjs';
  stderr.write(`${message}\nusage: node ${invoked} [--offline] [--registry <file>]\n`);
  process.exit(EXIT.USAGE);
}

function parseArgs(argv) {
  const out = { offline: false, registry: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--offline') out.offline = true;
    else if (a === '--registry') {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) usage('--registry needs a value');
      out.registry = v;
      i += 1;
    } else usage(`unknown argument ${a}`);
  }
  return out;
}

// One repository, one verdict, every finding. Never throws for a per-repository
// problem: an unreachable remote is that repository's exit 2, and the next one
// is still asked. `reason` is the token of its first cannot-verify finding.
function checkOne(id, entry, prefix, version) {
  const findings = [];
  let exit = EXIT.PASS;
  let reason = null;
  const fail = (m) => { findings.push(m); exit = Math.max(exit, EXIT.FAIL); };
  const cannot = (m, why = null) => { findings.push(m); exit = Math.max(exit, EXIT.CANNOT_VERIFY); reason = reason || why; };
  const note = (m) => { findings.push(m); };

  const dir = cacheDir(id);
  let trunk;
  let head;
  let state;
  let declared;
  try {
    ({ trunk, head, state, declared } = resolveSpokeTrunk(entry, dir));
  } catch (err) {
    if (!(err instanceof SpokeError)) throw err;
    cannot(err.message, err.reason);
    return { exit, findings, reason };
  }
  note(`trunk is ${trunk} (${declared ? 'declared' : 'default branch'}) at ${short(head)}`);

  if (state === 'pending') {
    note(`agreement pending: no ${entry.checks} on ${trunk} yet`);
  } else {
    note(`commands file ${entry.checks} present, and TRUNK_FOR_HUB agrees`);
    // The commands file may name a rules folder. Whether that folder is well
    // formed is check-spoke-rules.mjs's question; this only checks it is where
    // the commands file says, at the same commit.
    const rules = readRulesAt(dir, head, entry.checks);
    if (rules.state === 'path') note(`rules folder ${rules.path} present`);
    else if (rules.state === 'none') note('no rules declared (RULES_INDEX=none)');
    else if (rules.state === 'not-configured') note('rules NOT CONFIGURED (RULES_INDEX missing or UNRESOLVED)');
    else fail(rules.findings.join('; '));
    // Whether the scan finds anything is the spoke's own hook and story-gate's question; this
    // only checks one is declared.
    const scan = readSecretScanAt(dir, head, entry.checks);
    if (scan.state === 'command') note(`secret scan declared (${SECRET_SCAN_KEY}=${scan.command})`);
    else fail(`${entry.checks} has ${SECRET_SCAN_KEY} ${scan.state === 'none' ? '`none`' : scan.state}; every spoke names its own secret scan, a command that runs on Windows, Linux and Mac`);
    // Whether a listed hub can be cloned is story-gate's question; this only checks
    // that the spoke routes this hub's keys to some hub.
    const hubs = readHubsAt(dir, head, entry.checks);
    if (hubs.state === 'not-configured') {
      fail(`${entry.checks} has no ${HUBS_KEY}; story-gate cannot choose a hub to clone. Run the spoke install or the spoke upgrade from this hub`);
    } else if (hubs.state === 'invalid') {
      fail(hubs.findings.join('; '));
    } else {
      const route = hubs.hubs.find((h) => h.prefix === prefix);
      const listed = hubs.hubs.map((h) => h.prefix).join(', ');
      if (prefix === null) note(`${HUBS_KEY} lists ${listed}; this hub has no key prefix in ${KEYS_PATH} to look for`);
      else if (route) note(`${HUBS_KEY} routes this hub's prefix ${prefix} to ${route.hub}`);
      else fail(`${entry.checks} has ${HUBS_KEY} listing ${listed}, and not this hub's prefix ${prefix}; story-gate refuses every ${prefix} key until the spoke install adds this hub`);
    }
    const library = readLibraryAt(dir, head, entry.checks);
    const hubMajor = version === null ? null : Number(version.split('.')[0]);
    if (library.state === 'not-configured') {
      note(`harness library not recorded (${LIBRARY_KEY} missing or UNRESOLVED); the next upgrade from any hub of this spoke records it`);
    } else if (library.state === 'invalid') {
      fail(`${entry.checks} has ${LIBRARY_KEY}=${library.value}, which is not "<version> <full library commit>"`);
    } else if (hubMajor !== null && library.major !== null && library.major !== hubMajor) {
      fail(`${entry.checks} records harness library ${library.version}, major ${library.major}, and this hub runs ${version}, major ${hubMajor}; every hub of a spoke runs one major. Upgrade the spoke, or the hubs behind it, to one major`);
    } else {
      note(`harness library ${library.version} at ${short(library.commit)}`);
    }
  }

  if (entry.readAt === head) {
    note('readAt is the trunk head: current');
  } else if (hasCommit(dir, entry.readAt) || fetchable(dir, entry.url, trunk, entry.readAt)) {
    note(`readAt ${short(entry.readAt)} is behind the trunk head ${short(head)}: stale. Run /add-repo ${entry.url} --trunk ${entry.trunk} to refresh purpose and readAt`);
  } else {
    fail(`readAt ${short(entry.readAt)} is not a commit ${entry.url} knows; the purpose was read at a commit nobody can open`);
  }
  return { exit, findings, reason };
}

// A commit the depth-1 fetch did not bring. Ask for it by hash; a server that
// refuses bare hashes gets the branch fetched in full instead. Only then is
// "unknown" a fact rather than a server setting.
function fetchable(dir, url, trunk, sha) {
  try {
    return fetchOne(dir, url, sha) === sha;
  } catch {
    try {
      fetchBranchFully(dir, url, trunk);
    } catch {
      return false;
    }
    return hasCommit(dir, sha);
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const path = registryPath(args.registry);
  const registry = readRegistry(path);

  const problems = validateRegistry(registry, path);
  stdout.write(`\nrepository registry  (${path}${args.offline ? ', offline: remotes not asked' : ''})\n\n`);
  if (problems.length) {
    stdout.write('  [FAIL] shape\n');
    for (const p of problems) stdout.write(`         - ${p}\n`);
    stdout.write(`\nNOT WELL FORMED: ${problems.length} finding(s). Remotes were not asked.\n`);
    process.exit(EXIT.FAIL);
  }
  stdout.write('  [PASS] shape\n');

  const ids = Object.keys(registry.repositories);
  if (ids.length === 0) {
    stdout.write('\nWELL FORMED: no repositories listed yet. Add one with /add-repo.\n');
    process.exit(EXIT.PASS);
  }

  let worst = EXIT.PASS;
  let reason = null;
  const prefix = readHubPrefix();
  const version = hubVersion();
  const width = Math.max(...ids.map((i) => i.length));
  for (const id of ids) {
    if (args.offline) {
      stdout.write(`  [SKIP] ${id.padEnd(width)}  remote not asked\n`);
      continue;
    }
    const one = checkOne(id, registry.repositories[id], prefix, version);
    const { exit, findings } = one;
    worst = Math.max(worst, exit);
    reason = reason || one.reason || null;
    const status = exit === EXIT.PASS ? 'PASS' : exit === EXIT.FAIL ? 'FAIL' : 'CANNOT VERIFY';
    stdout.write(`  [${status}] ${id}\n`);
    for (const f of findings) stdout.write(`         - ${f}\n`);
  }

  stdout.write('\n');
  if (args.offline) stdout.write(`WELL FORMED: ${ids.length} repositor${ids.length === 1 ? 'y' : 'ies'} listed. Run without --offline to ask the remotes.\n`);
  else if (worst === EXIT.PASS) stdout.write(`TRUE: every listed repository answered as the registry says.\n`);
  else if (worst === EXIT.FAIL) stdout.write(`NOT TRUE: at least one entry disagrees with its repository. The repository wins; fix the list.\n`);
  else stdout.write(`CANNOT VERIFY: at least one repository could not be reached. Nothing about it is known.\n${reasonLine(reason)}`);
  process.exit(worst);
}

// The last line of an exit 2, 3 or 4 names this script and its code, so a shell line that hides
// the code, with a pipe or `; echo`, still tells the harness's failure record. Written at once,
// so a process.exit() never loses it.
process.on('exit', (code) => { if (code >= 2 && code <= 4) { try { writeSync(2, `HARNESS EXIT: check-registry ${code}\n`); } catch { /* stderr is closed */ } } });

try {
  main();
} catch (err) {
  if (err instanceof SpokeError) {
    stderr.write(`${err.exit === EXIT.CANNOT_VERIFY ? 'CANNOT VERIFY' : 'FAIL'}: ${err.message}\n${err.exit === EXIT.CANNOT_VERIFY ? reasonLine(err.reason) : ''}`);
    process.exit(err.exit);
  }
  stderr.write(`INTERNAL: ${err && err.stack ? err.stack : String(err)}\n`);
  process.exit(EXIT.INTERNAL);
}

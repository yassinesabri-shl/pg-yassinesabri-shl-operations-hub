#!/usr/bin/env node
// Part of the harness asset library c6f3b4427d58f7c3 (see VERSION.json) · 2026-09-14
/**
 * read-spoke-rules.mjs — the rules a spoke declares for itself, selected for one
 * change and printed as text with the commit they were read at.
 *
 *   usage:  node scripts/read-spoke-rules.mjs <repo-id> [--at <commit|12-hex>]
 *               [--design <file>] [--paths <a,b,...>] [--all] [--registry <file>]
 *
 *   <repo-id>   a key in docs/estate/repositories.json
 *   --at        read at this commit instead of the trunk head, as read-spoke.mjs.
 *               A full 40-character commit, or its first 12 characters
 *   --design    a design file on disk; its §3.1 "Components changed or added"
 *               table names the paths the change touches
 *   --paths     paths the change touches, comma-separated, added to --design's
 *   --all       every rule in the folder, for inspection; never for a dispatch
 *
 * With none of --design, --paths or --all, only the always-on rule is selected.
 *
 * What it prints, always, before any rule:
 *
 *   Repository: <id>
 *   Commit: <40-hex>
 *   Trunk: <branch as the remote reports it now>   (or "not asked" with --at)
 *   Rules: <id>@<12-hex>:<folder>                   (or "Rules: none")
 *   Status: <n> rule(s) declared | none declared | NOT CONFIGURED
 *   Paths: <p1>, <p2>                               (or "(none given)")
 *   Selected: <n> of <m>: <name>, <name>
 *   Overrides: <id>, <id>                           (or "Overrides: none")
 *   ---
 *   Rule: <name>
 *   Cite: <id>@<12-hex>:<folder>/<file>
 *   Overrides: <id>, <id>                           (only a rule that carries the key)
 *   <the rule body, frontmatter removed>
 *   ---
 *   Rule: ...
 *
 * The `Rules:` line is the value a design carries on its own `Rules:` line, and
 * the pickup gate reads that line. Copy it; never type it.
 *
 * The `Overrides:` lines name the hub and global standards, or single standard
 * rules, that the selected spoke rules replace. The header line is the union; a
 * rule's line is its own. An overridden standard rule does not bind this
 * change, and the spoke rule binds in its place. A rule overrides only where it
 * binds, so a rule that no path selected overrides nothing here.
 * `read-context.mjs` prints the same facts from the standard's side.
 *
 * Exit codes
 *   0  read -- including "none declared" and "NOT CONFIGURED", which are facts
 *      about the repository and not failures of this read
 *   1  the folder the commands file names is not at that commit, or the rule set
 *      is malformed. A malformed set binds nobody, so nothing is selected
 *   2  cannot verify: no registry, the remote is unreachable, or --at names a
 *      commit neither the cache nor the remote will give up, or a 12-character
 *      --at matches no commit on the trunk, or more than one
 *   3  usage: bad arguments, or a repository id not in the list
 *   4  internal
 *
 * Design notes
 *   - The commands file is the single home of the rules folder's path. This
 *     script reads the file at the commit, then the folder at the same commit,
 *     so the header's one commit is true of everything printed.
 *   - Selection is by the design's own table, not by a shell glob over a
 *     checkout: the design is the contract, and the paths it names are the
 *     paths a rule binds.
 *   - Reads. No write path, no branch argument, no prompt.
 */

import { readFileSync, writeSync } from 'node:fs';
import { stdout, stderr } from 'node:process';
import {
  EXIT, REPO_ID, SpokeError, reasonLine, atProblem, pinAt,
  registryPath, readRegistry, validateRegistry,
  resolveSpokeTrunk, cacheDir, short,
} from './spoke-remote.mjs';
import { RULES_NONE, designPaths, orderRules, readRulesAt, selectRules } from './spoke-rules.mjs';

function usage(message) {
  const invoked = process.argv[1] || 'scripts/read-spoke-rules.mjs';
  stderr.write(`${message}\nusage: node ${invoked} <repo-id> [--at <commit|12-hex>] [--design <file>] [--paths <a,b>] [--all] [--registry <file>]\n`);
  process.exit(EXIT.USAGE);
}

function parseArgs(argv) {
  const out = { positional: [], at: null, design: null, paths: null, all: false, registry: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--all') {
      out.all = true;
    } else if (a === '--at' || a === '--registry' || a === '--design' || a === '--paths') {
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

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.positional.length !== 1) usage('expected exactly one argument: <repo-id>');
  const [id] = args.positional;
  if (!REPO_ID.test(id)) usage(`"${id}" is not a repository id (letters, digits, ".", "_", "-")`);
  if (args.at !== null && atProblem(args.at)) usage(atProblem(args.at));

  let paths = [];
  if (args.design !== null) {
    let text;
    try {
      text = readFileSync(args.design, 'utf8');
    } catch (err) {
      usage(`cannot read --design ${args.design}: ${err.message}`);
    }
    paths.push(...designPaths(text));
  }
  if (args.paths !== null) {
    paths.push(...args.paths.split(',').map((p) => p.trim()).filter(Boolean));
  }
  paths = [...new Set(paths)];

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
  const header = [`Repository: ${id}`, `Commit: ${commit}`, `Trunk: ${trunk}`];

  if (read.state === 'no-commands-file') {
    stderr.write(`NOT FOUND: ${entry.checks} is not in ${id} at ${short(commit)} (trunk: ${trunk})\n`);
    process.exit(EXIT.FAIL);
  }
  if (read.state === 'invalid' || read.state === 'missing-folder') {
    stdout.write(`${header.join('\n')}\n`);
    stderr.write(`FAIL: ${read.findings.join('\n')}\n`);
    process.exit(EXIT.FAIL);
  }
  if (read.state === 'none' || read.state === 'not-configured') {
    header.push(`Rules: ${RULES_NONE}`);
    header.push(`Status: ${read.state === 'none' ? 'none declared' : 'NOT CONFIGURED'}`);
    header.push(`Paths: ${paths.length ? paths.join(', ') : '(none given)'}`);
    header.push('Selected: 0 of 0');
    header.push('Overrides: none');
    stdout.write(`${header.join('\n')}\n---\n`);
    return;
  }

  header.push(`Rules: ${id}@${short(commit)}:${read.path}`);
  if (read.findings.length) {
    header.push(`Status: NOT WELL FORMED: ${read.findings.length} finding(s)`);
    stdout.write(`${header.join('\n')}\n`);
    stderr.write(`FAIL: the rule set is malformed and binds nobody until it is fixed:\n  - ${read.findings.join('\n  - ')}\n`);
    process.exit(EXIT.FAIL);
  }
  header.push(`Status: ${read.rules.length} rule(s) declared`);
  header.push(`Paths: ${paths.length ? paths.join(', ') : '(none given)'}`);
  const selected = args.all ? orderRules(read.rules) : selectRules(read.rules, paths);
  header.push(`Selected: ${selected.length} of ${read.rules.length}${selected.length ? `: ${selected.map((r) => r.name).join(', ')}` : ''}`);
  const overrides = [...new Set(selected.flatMap((r) => r.overrides))];
  header.push(`Overrides: ${overrides.length ? overrides.join(', ') : 'none'}`);
  stdout.write(`${header.join('\n')}\n`);
  for (const rule of selected) {
    const own = rule.overrides.length ? `Overrides: ${rule.overrides.join(', ')}\n` : '';
    stdout.write(`---\nRule: ${rule.name}\nCite: ${id}@${short(commit)}:${rule.path}\n${own}${rule.body.replace(/^\n+/, '').replace(/\n*$/, '\n')}`);
  }
  if (!selected.length) stdout.write('---\n');
}

// The last line of an exit 2, 3 or 4 names this script and its code, so a shell line that hides
// the code, with a pipe or `; echo`, still tells the harness's failure record. Written at once,
// so a process.exit() never loses it.
process.on('exit', (code) => { if (code >= 2 && code <= 4) { try { writeSync(2, `HARNESS EXIT: read-spoke-rules ${code}\n`); } catch { /* stderr is closed */ } } });

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

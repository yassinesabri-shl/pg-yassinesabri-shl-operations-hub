#!/usr/bin/env node
// Part of the harness asset library c6f3b4427d58f7c3 (see VERSION.json) · 2026-10-21
/**
 * read-global.mjs — the release of the global context repository a new feature
 * reads.
 *
 *   usage:  node scripts/read-global.mjs --resolve
 *           node scripts/read-global.mjs --exceptions <repo-id>
 *           node scripts/read-global.mjs --connect <url>
 *
 * The global context repository holds the decision records, standards and
 * exceptions that bind every product. The Global Architecture Board merges to
 * its trunk, and a release tag `vX.Y.Z` on the trunk makes the documents at that
 * commit binding. `/feature` runs this script and copies the last line it prints
 * into the requirements document. The decomposition, the stories and the designs
 * inherit that line. The commit binds, and the tag is a label.
 *
 * --resolve:
 *
 *   1. reads docs/estate/global.json (HARNESS_GLOBAL names another file), and
 *      prints `Global: none` when the file is absent: the hub has no global layer
 *   2. lists the remote's tags and keeps only release tags, `v<n>.<n>.<n>`. A
 *      pre-release tag such as `v1.5.0-rc.1` never counts, so the Board can try a
 *      change without binding a product
 *   3. drops every tag whose commit is not on the global trunk, the branch the
 *      remote reports as its default now
 *   4. takes the highest version, and prints `Global: vX.Y.Z <40-hex>`
 *
 * It asks the remote every time and never falls back to a cache. The bare cache
 * outside the hub, the one the spokes use, holds only the trunk's history that
 * step 3 needs. What it prints:
 *
 *   Global repository: <url>
 *   Trunk: <branch> at <40-hex>
 *   Release tags: <n> on the trunk: <tag>, <tag>     (or "none on the trunk")
 *   Ignored: <tag> (<why>), <tag> (<why>)            (only when a tag was ignored)
 *   Global: vX.Y.Z <40-hex>
 *
 * or the one line `Global: none`.
 *
 * --exceptions <repo-id>: what /add-repo reads before it lists a repository
 * (docs/proposals/global-context.md §9.1). It resolves the newest release as
 * --resolve does, reads the exceptions at that commit, and prints one WARNING
 * line for each Active exception whose `repositories` names the repository and
 * whose `hubs` does not name this hub, the prefix in docs/backlog/keys.json.
 * The code in that repository may have been built under the exception, and this
 * hub's designs still follow the global record. The output is the --resolve
 * lines, then:
 *
 *   Hub: <PREFIX>                                  (or "no key prefix in ...")
 *   Exceptions: <n> Active at vX.Y.Z; <k> cover <repo-id>
 *   WARNING: global.EXC-<NNN> covers <repo-id> and names the hubs <A>, <B>, not <PREFIX>. ...
 *
 * A trunk with no release tag binds nothing, so --exceptions prints that and
 * exits 0. The repository id need not be listed yet: /add-repo runs this before
 * its pull request merges.
 *
 * --connect <url>: what `/check-global --connect` reads before it writes
 * docs/estate/global.json (docs/proposals/global-context.md §11.4). It writes
 * nothing. It refuses a hub that already has the link file, and a URL that the
 * link file could not hold: one with a user name or password, because the file
 * is committed. Then it resolves the newest release at that URL as --resolve
 * does, and reads the documents at its commit. A trunk with no release tag, or a
 * release that holds no decision record, standard or exception, is refused: the
 * hub's next /feature would record a release that binds nothing, or the URL
 * names another kind of repository. The output is the --resolve lines, then:
 *
 *   Hub: <PREFIX>                                  (or "no key prefix in ...")
 *   Documents: <n> at vX.Y.Z: <r> record(s), <s> standard(s), <e> exception(s)
 *   Note: <a document that does not parse>         (only when one does not)
 *   Global: vX.Y.Z <40-hex>
 *
 * The two refusals before the remote is asked never print the URL, so a
 * credential in it reaches no log.
 *
 * Exit codes
 *   0  resolved, or `Global: none` because the hub has no global.json. For
 *      --exceptions, also with WARNING lines, and with no release tag
 *   1  global.json is not well formed, or (--resolve) the trunk carries no
 *      release tag: a hub with a global layer cannot record a version that does
 *      not exist yet. For --connect: the hub already has global.json, the URL
 *      carries a credential, the trunk carries no release tag, or the release
 *      holds no global document
 *   2  cannot verify: the global repository does not answer, reports no default
 *      branch, or global.json cannot be read. When git could not authenticate to
 *      the host, the message says so, names the URL without a credential, and
 *      gives the fix: a credential for git, which on GitHub is
 *      `gh auth setup-git`. This script runs git only, never gh
 *   3  usage
 *   4  internal
 */

import { existsSync, writeSync } from 'node:fs';
import { stdout, stderr } from 'node:process';
import {
  EXIT, KEYS_PATH, REPO_ID, SpokeError, reasonLine, globalPath, newestRelease, readGlobalLink, readHubPrefix, validateGlobalLink,
} from './spoke-remote.mjs';
import { GLOBAL_PREFIX, readGlobalDocumentsAt } from './context-docs.mjs';

function usage(message) {
  const invoked = process.argv[1] || 'scripts/read-global.mjs';
  stderr.write(`${message}\nusage: node ${invoked} --resolve\n       node ${invoked} --exceptions <repo-id>\n       node ${invoked} --connect <url>\n`);
  process.exit(EXIT.USAGE);
}

// The newest release, and the lines --resolve prints before its last, are
// newestRelease's in spoke-remote.mjs, because report-global.mjs reads the same.

// What git prints when it has no credential for the host, or a wrong one, over
// HTTPS or SSH. The prompts are off (quietGitEnv), so git fails at once.
const AUTH_FAILURE = /could not read (Username|Password)|unable to get (username|password)|terminal prompts disabled|Authentication failed|Invalid username or password|Permission denied \(publickey|HTTP Basic: Access denied/i;

/** The URL with any user name and password removed, for a message. */
function withoutCredential(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return url;
    parsed.username = '';
    parsed.password = '';
    return parsed.toString();
  } catch {
    return url;
  }
}

/**
 * newestRelease, with an authentication failure said in plain words. The
 * rehearsal of /check-global --connect met a git with no credential for the
 * host, and "cannot reach" did not say what to fix.
 */
function readRelease(link) {
  try {
    return newestRelease(link);
  } catch (err) {
    if (!(err instanceof SpokeError) || err.exit !== EXIT.CANNOT_VERIFY || err.message.search(AUTH_FAILURE) === -1) throw err;
    const url = withoutCredential(link.url);
    throw new SpokeError(EXIT.CANNOT_VERIFY, `git could not authenticate to ${url}, so the global repository was not read (${err.message}). Give git a credential for this host, then run the command again. On GitHub, run \`gh auth setup-git\`, which makes the GitHub CLI's login git's credential helper. On another host, set a git credential helper, or use an SSH URL with a key the host accepts`, 'auth-failed');
  }
}

function resolve() {
  const link = readGlobalLink();
  const found = link === null ? null : readRelease(link);
  if (found === null) {
    stdout.write('Global: none\n');
    return;
  }
  const { lines, trunk, release } = found;
  if (release === null) {
    stdout.write(`${lines.join('\n')}\n`);
    stderr.write(`FAIL: ${link.url} has no release tag (vX.Y.Z) on ${trunk}, so nothing in it binds yet, and ${globalPath()} links this hub to it. The Board tags a release before a feature can record one\n`);
    process.exit(EXIT.FAIL);
  }
  lines.push(`Global: ${release.name} ${release.commit}`);
  stdout.write(`${lines.join('\n')}\n`);
}

function exceptions(repo) {
  const link = readGlobalLink();
  const found = link === null ? null : readRelease(link);
  if (found === null) {
    stdout.write('Global: none\n');
    return;
  }
  const { lines, dir, release } = found;
  const prefix = readHubPrefix();
  if (release === null) {
    lines.push('Global: no release tag, so no exception binds yet');
    stdout.write(`${lines.join('\n')}\n`);
    return;
  }
  lines.push(`Global: ${release.name} ${release.commit}`);
  lines.push(`Hub: ${prefix || `no key prefix in ${KEYS_PATH}`}`);
  // The release commit is on the trunk, and the trunk's whole history is in the cache.
  const read = readGlobalDocumentsAt(dir, release.commit);
  const active = read.documents.filter((d) => d.kind === 'exception' && d.status === 'Active');
  const covering = active.filter((d) => d.repositories.includes(repo));
  const warnings = covering.filter((d) => prefix === null || !d.hubs.includes(prefix));
  lines.push(`Exceptions: ${active.length} Active at ${release.name}; ${covering.length} cover ${repo}`);
  for (const d of warnings) {
    const departs = d.departs.map((x) => `${GLOBAL_PREFIX}${x}`).join(', ');
    lines.push(`WARNING: ${GLOBAL_PREFIX}${d.name} covers ${repo} and names the hubs ${d.hubs.join(', ')}, not ${prefix || 'this hub, which has no key prefix yet'}. The code in ${repo} may follow the exception, and this hub's designs follow ${departs}. Ask the Global Architecture Board for an exception that names this hub, or accept that this hub's designs follow ${departs}`);
  }
  if (!warnings.length) lines.push(`No Active exception at ${release.name} covers ${repo} without naming ${prefix || 'this hub'}.`);
  for (const f of read.findings) lines.push(`Note: ${f}. The document is not read, so it warns of nothing`);
  stdout.write(`${lines.join('\n')}\n`);
}

function connect(url) {
  // Both refusals come before the remote is asked, and neither prints the URL.
  if (existsSync(globalPath())) {
    throw new SpokeError(EXIT.FAIL, `${globalPath()} already links this hub to a global context repository, so --connect has nothing to write. Run /check-global without --connect to check the hub against it`);
  }
  const problems = validateGlobalLink({ schema_version: 1, url }, 'the URL').map((p) => p.replace(/^the URL: "url" /, 'the URL '));
  if (problems.length) throw new SpokeError(EXIT.FAIL, `${problems.join('; ')}. The URL is written into ${globalPath()}, which is committed. Give the clone URL without it; the hub's CI reads the repository with the credential it uses for its spokes`);

  const { lines, dir, trunk, release } = readRelease({ url });
  if (release === null) {
    stdout.write(`${lines.join('\n')}\n`);
    throw new SpokeError(EXIT.FAIL, `the global repository has no release tag (vX.Y.Z) on ${trunk}, so nothing in it binds yet. The Board tags its first release before a hub connects (docs/proposals/global-context.md §16.2)`);
  }
  const prefix = readHubPrefix();
  lines.push(`Hub: ${prefix || `no key prefix in ${KEYS_PATH}`}`);
  const read = readGlobalDocumentsAt(dir, release.commit);
  const count = (kind) => read.documents.filter((d) => d.kind === kind).length;
  lines.push(`Documents: ${read.documents.length} at ${release.name}: ${count('adr')} record(s), ${count('standard')} standard(s), ${count('exception')} exception(s)`);
  for (const f of read.findings) lines.push(`Note: ${f}`);
  if (!read.documents.length) {
    stdout.write(`${lines.join('\n')}\n`);
    throw new SpokeError(EXIT.FAIL, `${release.name} holds no decision record, standard or exception that parses, so the URL names another kind of repository, or the Board has not seeded it yet (docs/proposals/global-context.md §16.2)`);
  }
  lines.push(`Global: ${release.name} ${release.commit}`);
  stdout.write(`${lines.join('\n')}\n`);
}

function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--resolve') {
    resolve();
  } else if (args[0] === '--exceptions') {
    if (args.length !== 2) usage('--exceptions takes one repository id');
    if (!args[1].match(REPO_ID)) usage(`"${args[1]}" is not a repository id (letters, digits, ".", "_", "-")`);
    exceptions(args[1]);
  } else if (args[0] === '--connect') {
    // Never echo the arguments: the URL may carry a credential.
    if (args.length !== 2) usage('--connect takes one URL');
    connect(args[1]);
  } else {
    usage(args.length ? `unknown arguments: ${args.join(' ')}` : 'say what to do: --resolve, --exceptions <repo-id> or --connect <url>');
  }
}

// The last line of an exit 2, 3 or 4 names this script and its code, so a shell line that hides
// the code, with a pipe or `; echo`, still tells the harness's failure record. Written at once,
// so a process.exit() never loses it.
process.on('exit', (code) => { if (code >= 2 && code <= 4) { try { writeSync(2, `HARNESS EXIT: read-global ${code}\n`); } catch { /* stderr is closed */ } } });

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

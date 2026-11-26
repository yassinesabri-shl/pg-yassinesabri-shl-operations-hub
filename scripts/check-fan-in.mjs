#!/usr/bin/env node
// Part of the harness asset library c6f3b4427d58f7c3 (see VERSION.json) · 2026-09-12
/**
 * check-fan-in.mjs — is the feature finished?
 *
 *   usage:  node scripts/check-fan-in.mjs <SLUG>          e.g. payments-onboarding
 *
 * A feature is one requirements document, cut by /decompose into stories that
 * each land in one repository. Nothing stores whether the feature is done: this
 * script derives it, when asked, from the hub's trunk and each repository's
 * trunk, and prints it. Run it by hand as `make fan-in SLUG=<SLUG>` or from the
 * report-only `fan-in` workflow. It is never a required check: it reads several
 * remotes, and a check that stalls on another repository's outage is not
 * enforcement (machine-gates.md §8).
 *
 * The stories of a slug are the item files under docs/backlog/<SLUG>/ on the
 * hub's trunk, which check-decomposition proves equal the ledger's blocks for the
 * slug and the record's Items table. For every story, four questions, each
 * already answered by an existing script or file. Nothing here re-implements
 * their parsing:
 *
 *   1. the design is on the trunk and `check-dev-ready <KEY>` exits 0, asked as
 *      the story's repository (HARNESS_REPO), so a design written for another
 *      repository fails here as it would in that repository's own check;
 *   2. the validation report is on the trunk and `check-validation <KEY>` exits 0;
 *   3. every verdict in that report is PASS. `N/A` is not a failure: the check
 *      in 2 has already refused it against anything but a DEPRECATED criterion;
 *   4. the report's `Spoke commit:` is a commit of the story's repository -- the
 *      story's `Repository:` line, looked up in docs/estate/repositories.json --
 *      and its code is on that repository's trunk as the remote names it now.
 *      /qa-sprint validates the head of the open code pull request, so the
 *      commit is on the trunk after a merge commit or a fast-forward. A squash or
 *      a rebase merge writes new commits instead. Then the answer is yes when a
 *      trunk commit, along the first parent since the two lines parted, has the
 *      tree the report read. It is also yes when a run of those trunk commits has
 *      the change the report read, by `git patch-id --stable`: a branch that was
 *      behind the trunk at the merge. QA did not read that merged tree, as after a
 *      merge commit of the same branch. This is the one question check-validation cannot
 *      ask, because that commit lives in another repository and a required check
 *      reads one remote.
 *
 * The feature is done only when every story passes all four. One line per story
 * says which of the four failed.
 *
 * Exit codes -- the gate's
 *   0  every story passes all four questions          FEATURE DONE
 *   1  at least one story does not, or the slug has   FEATURE NOT DONE
 *      no record or no stories on the trunk
 *   2  cannot verify: the hub's trunk could not be confirmed, the list of
 *      repositories is not on it, a sibling check is not installed beside this
 *      file, or ANY repository a story names could not be reached. One
 *      unreachable repository is exit 2 for the whole run and no story is
 *      reported, never "three of four done"
 *   3  usage: no slug, or not a slug
 *   4  internal
 *
 * Design notes
 *   - Same trunk discipline as the gate for the hub: reads origin's default
 *     branch, never the working tree, confirms the name against the remote and
 *     force-fetches first. HARNESS_TRUNK names a non-`main` trunk; a name the
 *     remote does not confirm is exit 2.
 *   - Each repository's trunk is asked of its remote with `ls-remote --symref`
 *     and fetched in full into the bare cache spoke-remote.mjs keeps (one per
 *     repository, under the system temp directory; HARNESS_SPOKE_CACHE to move
 *     it). A full fetch, not depth 1, because "is an ancestor of the trunk" needs
 *     the history. The cache makes the second run cheap.
 *   - The four questions live in story-done.mjs, which check-dependencies.mjs
 *     imports too. It sits beside this file after install, as spoke-remote.mjs does.
 *   - Imports spoke-remote.mjs from beside itself, as read-spoke.mjs and
 *     check-registry.mjs do. In the library this file sits in gate/ and that one
 *     in scripts/; the hub install lands all of them in scripts/, which is where
 *     the import resolves. The fixture suite copies them there as the install
 *     does, and generation.md §1 says so. This is why the file is .mjs in both
 *     layouts: the `.js` -> `.mjs` rename rule the four one-file checks follow
 *     does not apply to it.
 *   - Finds check-dev-ready and check-validation beside itself, under either
 *     extension, and runs each as a child process exactly as a person would.
 *     Their exit codes are read; their output is quoted, not parsed, except for
 *     one summary line each prints.
 *   - Runs every question it can for every story before exiting. Questions 3
 *     and 4 read the report's content, so they are asked only after question 2
 *     has proved its shape; until then they are printed as "not asked".
 *   - One run, one trunk. The two checks fetch the hub's trunk again and judge
 *     its tip; if that tip is no longer the one this file confirmed, the trunk
 *     moved during the run and the answer is exit 2, "run again", rather than
 *     two questions about one version of a report and two about another.
 *   - Node standard library only, plus git via child_process.
 *
 * What this script cannot see
 *   - Whether the feature works. Every story validated alone and every spoke
 *     commit on its trunk is consistent with two repositories that do not agree
 *     with each other. Running them together is the platform lead's open item
 *     (upgrade.md §14).
 *   - Whether a PASS is deserved. It reads the verdict the validating seat
 *     wrote, through the check that proves the paperwork.
 *   - A story nobody cut. It reads the item files that exist.
 *   - Why a story was stopped, beyond the person's words in the record. It reports each
 *     story whose latest escalation ended in `stopped` (its `[shl-harness]` issue in the hub, read
 *     through escalation-store.mjs and gh), and never changes the decomposition.
 *   - Which repository `origin` is. The URL is printed in the header so a
 *     repointed remote sits in the transcript beside the verdict.
 */

import { existsSync, writeSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { stdout, stderr } from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  EXIT, REGISTRY_PATH, REPO_ID, SpokeError, reasonLine, git, short, syncTrunk,
} from './spoke-remote.mjs';
import {
  KEY_PATTERN, REPOSITORY_LINE, sibling, readBlob, readRegistryBlob, reachRepositories, askStory,
} from './story-done.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

// The escalation record's store, beside this file after the hub install (scripts/), or in the
// library's scripts/ folder. A hub whose install predates the escalation feature has none, and
// then this report says nothing about escalations.
let STORE = null;
for (const dir of [HERE, resolve(HERE, '..', 'scripts')]) {
  const path = join(dir, 'escalation-store.mjs');
  if (existsSync(path)) { STORE = await import(pathToFileURL(path).href); break; }
}

const CONFIG = {
  remote: 'origin',
  branch: process.env.HARNESS_TRUNK || 'main',
  backlogDir: 'docs/backlog',
  recordSuffix: '.decomposition.md',
  itemSuffix: '.item.md',
  registryPath: REGISTRY_PATH,
  slugPattern: /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
  keyPattern: KEY_PATTERN,
  // The item file's two lines, read by label as check-decomposition reads them.
  keyLine: /^Key:[ \t]*(\S.*?)\s*$/m,
  repositoryLine: REPOSITORY_LINE,
  siblings: { gate: 'check-dev-ready', validation: 'check-validation' },
};

/* ------------------------------------------------------------------- usage */

function usage(message) {
  const invoked = process.argv[1] || 'scripts/check-fan-in.mjs';
  stderr.write(`${message}\nusage: node ${invoked} <SLUG>   e.g. payments-onboarding\n`);
  process.exit(EXIT.USAGE);
}

/* ---------------------------------------------------------- stopped escalations */

// A stopped story stays in the backlog: the library has no state or mark for a withdrawn story. So
// this report reads the escalation record (the hub's `[shl-harness]` issues) and names each story
// whose latest escalation ended in `stopped`, and the feature itself where its slug's latest one
// ends that way. It reads, and it changes nothing. A hub with no harness issue has no escalation. A
// record that cannot be read is exit 2: "cannot read" is never shown as "no escalation".
function readStopped(owners) {
  const found = new Map();
  if (!STORE) return found;
  let read;
  try {
    read = STORE.readEscalations(owners);
  } catch (err) {
    // GitHub, not the record: a hub whose workflow has no token yet still gets its verdict.
    if (!(err instanceof SpokeError)) throw err;
    stdout.write(`\nNOTE: the escalation record cannot be read (${err.message}), so this report names no stopped story.\n`);
    return found;
  }
  const { escalations, faults } = read;
  if (faults.length) throw new SpokeError(EXIT.CANNOT_VERIFY, `the escalation record cannot be read: ${faults.map((f) => f.text).join('. ')}`, 'record-unreadable');
  for (const owner of owners) {
    const latest = escalations.filter((e) => e.owner === owner).reduce((a, e) => (!a || e.number > a.number ? e : a), null);
    if (latest && latest.state === 'stopped') {
      const line = latest.lines.find((l) => l.event === 'stopped');
      found.set(owner, { id: latest.id, at: line.at, role: line.by.role, reason: line.reason, point: latest.point });
    }
  }
  return found;
}

/* ---------------------------------------------------------------- hub trunk */

// The gate's discipline: fetch the named branch, then confirm the remote itself
// calls that branch its default. HARNESS_TRUNK names the trunk; it does not
// choose one. syncTrunk in spoke-remote.mjs owns it, and report-global.mjs reads
// the hub's trunk the same way.
function syncHubTrunk() {
  return syncTrunk(CONFIG.remote, CONFIG.branch);
}

// The files directly under `dir` at `commit`, by name. `:(top)` anchors the
// pathspec to the repository root so the answer is the same from any directory.
function listFiles(commit, dir) {
  let out;
  try {
    out = git(['ls-tree', '-z', '--full-name', '--name-only', commit, '--', `:(top)${dir}/`]);
  } catch (err) {
    return [];
  }
  return out.split('\0').filter(Boolean).map((p) => p.slice(p.lastIndexOf('/') + 1)).sort();
}

/* ------------------------------------------------------------------ stories */

// One story per item file. A malformed item is still a story -- it is on the
// trunk under this slug -- and it fails with its fault named, rather than
// vanishing from the list.
function readStories(head, slug) {
  const dir = `${CONFIG.backlogDir}/${slug}`;
  const files = listFiles(head, dir).filter((f) => f.endsWith(CONFIG.itemSuffix));
  return files.map((file) => {
    const key = file.slice(0, -CONFIG.itemSuffix.length);
    const text = readBlob(head, `${dir}/${file}`) || '';
    const faults = [];
    if (!CONFIG.keyPattern.test(key)) faults.push(`the file name "${file}" is not <KEY>${CONFIG.itemSuffix}`);
    const keyLine = text.match(CONFIG.keyLine);
    if (!keyLine) faults.push('the item file has no "Key: <KEY>" line');
    else if (keyLine[1] !== key) faults.push(`the item file's Key: line names ${keyLine[1]}, not ${key}`);
    const repoLine = text.match(CONFIG.repositoryLine);
    let repo = null;
    if (!repoLine) faults.push('the item file has no "Repository: <id>" line');
    else if (!REPO_ID.test(repoLine[1])) faults.push(`the item file's Repository: line "${repoLine[1]}" is not a repository id`);
    else repo = repoLine[1];
    return { key, file: `${dir}/${file}`, repo, faults };
  });
}

/* --------------------------------------------------------------------- main */

function main() {
  const args = process.argv.slice(2);
  if (args.length !== 1) usage(`expected exactly one argument, the slug; got ${args.length}`);
  const slug = args[0];
  if (!CONFIG.slugPattern.test(slug)) usage(`"${slug}" is not a slug (lower-case letters, digits and single hyphens)`);

  const caller = basename(process.argv[1] || 'check-fan-in.mjs');
  const siblings = {
    gate: sibling(CONFIG.siblings.gate, HERE, caller),
    validation: sibling(CONFIG.siblings.validation, HERE, caller),
  };
  const hub = syncHubTrunk();

  const recordPath = `${CONFIG.backlogDir}/${slug}${CONFIG.recordSuffix}`;
  if (readBlob(hub.head, recordPath) === null) {
    throw new SpokeError(EXIT.FAIL, `no decomposition record for "${slug}" on ${hub.ref} (${recordPath}); run /decompose`);
  }
  const stories = readStories(hub.head, slug);
  if (stories.length === 0) {
    throw new SpokeError(EXIT.FAIL, `the record for "${slug}" is on ${hub.ref} but ${CONFIG.backlogDir}/${slug}/ holds no *${CONFIG.itemSuffix}; a feature with no stories cannot be done`);
  }

  const registry = readRegistryBlob(hub.head, hub.ref);
  const ids = [...new Set(stories.map((s) => s.repo).filter(Boolean))];
  const repositories = reachRepositories(ids, registry);

  stdout.write(`\n${slug} fan-in  (against ${hub.ref} at ${short(hub.head)}, ${CONFIG.remote} -> ${hub.url})\n\n`);
  stdout.write('  repositories\n');
  const width = Math.max(1, ...ids.map((i) => i.length));
  const unreachable = [];
  for (const id of ids) {
    const state = repositories.get(id);
    if (!state.listed) stdout.write(`    [FAIL] ${id.padEnd(width)}  not in ${CONFIG.registryPath}\n`);
    else if (state.unreachable) { unreachable.push(id); stdout.write(`    [CANNOT VERIFY] ${id.padEnd(width)}  ${state.unreachable}\n`); }
    else stdout.write(`    [OK] ${id.padEnd(width)}  trunk ${state.trunk} at ${short(state.head)}\n`);
  }
  if (ids.length === 0) stdout.write('    (no story names a repository)\n');

  if (unreachable.length) {
    stdout.write(`\nCANNOT VERIFY: ${unreachable.length} of ${ids.length} repositor${ids.length === 1 ? 'y' : 'ies'} could not be reached (${unreachable.join(', ')}). Nothing is known about the feature until every repository answers; no story is reported.\n\n${reasonLine(repositories.get(unreachable[0]).reason)}`);
    process.exit(EXIT.CANNOT_VERIFY);
  }

  const stopped = readStopped([slug, ...stories.map((st) => st.key).filter(Boolean)]);
  if (stopped.has(slug)) {
    const e = stopped.get(slug);
    stdout.write(`\n  escalation of the feature\n    [STOPPED] ${e.id} at ${e.point}, ${e.at}, by ${e.role}: ${e.reason}\n`);
  }

  stdout.write('\n  stories\n');
  let passed = 0;
  for (const story of stories) {
    const answers = askStory(story, hub, repositories, siblings);
    const ok = story.faults.length === 0 && answers.every((a) => a.ok);
    if (ok) passed += 1;
    stdout.write(`    [${ok ? 'PASS' : 'FAIL'}] ${story.key}  ${story.repo || '(repository unknown)'}\n`);
    for (const f of story.faults) stdout.write(`           item file: ${f}\n`);
    for (const a of answers) stdout.write(`           ${a.label}: ${a.detail}\n`);
    if (stopped.has(story.key)) {
      const e = stopped.get(story.key);
      stdout.write(`           escalation: [STOPPED] ${e.id} at ${e.point}, ${e.at}, by ${e.role}: ${e.reason}\n`);
    }
  }
  const stoppedStories = stories.filter((st) => stopped.has(st.key));
  if (stoppedStories.length) stdout.write(`\n${stoppedStories.length} stor${stoppedStories.length === 1 ? 'y was' : 'ies were'} stopped by a person (${stoppedStories.map((st) => st.key).join(', ')}). A stopped story stays in the backlog, and this report does not change it.\n`);

  const n = stories.length;
  stdout.write(passed === n
    ? `\nFEATURE DONE: ${n} of ${n} stor${n === 1 ? 'y' : 'ies'} passed. Every design is merged, every report is complete with every verdict PASS, and every spoke commit is on its repository's trunk.\n\n`
    : `\nFEATURE NOT DONE: ${passed} of ${n} stor${n === 1 ? 'y' : 'ies'} passed. Each failing story's list says which question failed.\n\n`);
  process.exit(passed === n ? EXIT.PASS : EXIT.FAIL);
}

// The last line of an exit 2, 3 or 4 names this script and its code, so a shell line that hides
// the code, with a pipe or `; echo`, still tells the harness's failure record. Written at once,
// so a process.exit() never loses it.
process.on('exit', (code) => { if (code >= 2 && code <= 4) { try { writeSync(2, `HARNESS EXIT: check-fan-in ${code}\n`); } catch { /* stderr is closed */ } } });

try {
  main();
} catch (err) {
  if (err instanceof SpokeError) {
    const label = err.exit === EXIT.CANNOT_VERIFY ? 'CANNOT VERIFY' : err.exit === EXIT.INTERNAL ? 'INTERNAL' : 'FAIL';
    stderr.write(`${label}: ${err.message}\n${reasonLine(err.reason)}`);
    process.exit(err.exit);
  }
  stderr.write(`INTERNAL: ${err && err.stack ? err.stack : String(err)}\n`);
  process.exit(EXIT.INTERNAL);
}

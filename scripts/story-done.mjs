// Part of the harness asset library c6f3b4427d58f7c3 (see VERSION.json) · 2026-09-12
/**
 * story-done.mjs -- the four questions that say a story is done.
 *
 * Both check-fan-in.mjs and check-dependencies.mjs import this module. It has no
 * command line. The hub install puts it in scripts/, beside spoke-remote.mjs,
 * which it imports. In the library it sits in scripts/ and check-fan-in.mjs sits
 * in gate/, so the import resolves only after install. The fixture suites copy
 * both files into a hub's scripts/ as the install does.
 *
 * The four questions are the ones check-fan-in.mjs documents. One shared copy
 * means a story that fan-in calls done is a story that the dependency check
 * calls done. askStory takes `through: 1` to ask question 1 only. That mode
 * reads no repository.
 *
 * Node standard library only, plus git via child_process.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import {
  EXIT, REGISTRY_PATH, SpokeError, reasonIn, git, firstLine,
  validateRegistry, resolveSpokeTrunk, cacheDir, hasCommit, fetchOne, fetchBranchFully, short,
} from './spoke-remote.mjs';

// The same four labels print in both checks, so they live in one place.
export const QUESTIONS = {
  design: '1. design on the trunk and the pickup gate passes',
  report: '2. validation report on the trunk and complete',
  verdicts: '3. every verdict PASS',
  merged: "4. spoke commit on the repository's trunk",
};

// check-fan-in.mjs reads the item file with the same two patterns.
export const KEY_PATTERN = /^[A-Z][A-Z0-9]{1,9}-\d+$/;
export const REPOSITORY_LINE = /^Repository:[ \t]*(\S.*?)\s*$/m;

const CONFIG = {
  registryPath: REGISTRY_PATH,
  designDir: 'docs/designs',
  designSuffix: '.lld.md',
  reportSuffix: '.validation.md',
  // The report's line and table, read only after check-validation has proved the
  // report has exactly this shape.
  spokeLine: /^Spoke commit:[ \t]*([0-9a-fA-F]{40})\s*$/m,
  reportHeader: ['AC', 'Criterion (short)', 'Requirement', 'Verdict', 'Evidence'],
  // The one line each sibling prints that is worth quoting.
  gateSummary: /^(?:NOT )?ELIGIBLE: .*$/m,
  validationSummary: /^REPORT (?:IN)?COMPLETE: .*$/m,
};

// The checks this module runs live beside the caller after the hub install, under
// either extension. Not finding one is an install fault, so "cannot verify".
export function sibling(name, here, caller) {
  for (const ext of ['.js', '.mjs']) {
    const path = join(here, `${name}${ext}`);
    if (existsSync(path)) return path;
  }
  throw new SpokeError(EXIT.CANNOT_VERIFY, `${name}.js (or .mjs) is not beside ${caller} in ${here}; the hub install puts the gate, its sibling checks and this script in one directory`, 'script-missing');
}

/* ------------------------------------------------------------- repositories */

export function readBlob(commit, path) {
  try {
    return git(['show', `${commit}:${path}`]).replace(/^\uFEFF/, '');
  } catch (err) {
    return null;
  }
}

export function readRegistryBlob(head, ref) {
  const text = readBlob(head, CONFIG.registryPath);
  if (text === null) {
    throw new SpokeError(EXIT.CANNOT_VERIFY, `no list of repositories at ${CONFIG.registryPath} on ${ref}; run /add-repo`, 'registry-missing');
  }
  let registry;
  try {
    registry = JSON.parse(text);
  } catch (err) {
    throw new SpokeError(EXIT.FAIL, `${CONFIG.registryPath} on ${ref} is not JSON: ${err.message}`);
  }
  const problems = validateRegistry(registry, CONFIG.registryPath);
  if (problems.length) {
    throw new SpokeError(EXIT.FAIL, `the list of repositories is not well formed; run check-registry first:\n  - ${problems.join('\n  - ')}`);
  }
  return registry.repositories;
}

// Every repository the stories name, asked for its trunk and fetched in full.
// Nothing about any story is decided until every one has answered.
export function reachRepositories(ids, registry) {
  const states = new Map();
  for (const id of ids) {
    const entry = registry[id];
    if (!entry) {
      states.set(id, { listed: false });
      continue;
    }
    try {
      const dir = cacheDir(id);
      const { trunk } = resolveSpokeTrunk(entry, dir);
      const head = fetchBranchFully(dir, entry.url, trunk);
      states.set(id, { listed: true, url: entry.url, trunk, head, dir });
    } catch (err) {
      if (!(err instanceof SpokeError)) throw err;
      states.set(id, { listed: true, url: entry.url, unreachable: err.message, reason: err.reason });
    }
  }
  return states;
}

/* ------------------------------------------------------- the four questions */

// A sibling fetches the hub's trunk again and judges its tip; this file read the
// report at the tip it confirmed first. If the two differ the trunk moved during
// the run, and one run must not mix two versions of the same report.
function runSibling(path, key, env, hub) {
  const res = spawnSync(process.execPath, [path, key], {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
  const name = basename(path);
  if (res.error) throw new SpokeError(EXIT.INTERNAL, `could not run ${name}: ${res.error.message}`);
  const now = git(['rev-parse', '--verify', `${hub.ref}^{commit}`]).trim();
  if (now !== hub.head) {
    throw new SpokeError(EXIT.CANNOT_VERIFY, `${hub.ref} moved from ${short(hub.head)} to ${short(now)} while this ran; run again`, 'trunk-moved');
  }
  if (res.status === EXIT.CANNOT_VERIFY) {
    throw new SpokeError(EXIT.CANNOT_VERIFY, `${name} ${key}: ${firstLine(String(res.stderr).replace(/^\s*CANNOT VERIFY:\s*/m, '')) || 'refused to judge'}`, reasonIn(String(res.stderr)));
  }
  if (res.status !== EXIT.PASS && res.status !== EXIT.FAIL) {
    throw new SpokeError(EXIT.INTERNAL, `${name} ${key} exited ${res.status}: ${firstLine(res.stderr) || firstLine(res.stdout) || 'no output'}`);
  }
  return { status: res.status, stdout: String(res.stdout || '') };
}

const quote = (text, re) => {
  const m = text.match(re);
  return m ? `"${m[0].trim()}"` : 'see its output';
};

// How a table row and a cell are read, copied from check-validation.js and kept
// the same on purpose: the two files read one table and must agree on what a
// cell says. Invisible characters are not content; a comment inside a cell is
// not content; a verdict is the token that remains.
const INVISIBLE = /[\u200B-\u200F\u202A-\u202E\u2060\uFEFF\u00AD]/g;
const COMMENT_BLOCK = { '<!--': '-->', '{/*': '*/}' };

function splitRow(line) {
  const trimmed = line.replace(INVISIBLE, '').trim();
  if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) return null;
  if (trimmed.slice(0, -1).search(/(?:^|[^\\])(?:\\\\)*\\$/) !== -1) return null;
  return trimmed
    .slice(1, -1)
    .split(/(?<!\\)\|/)
    .map((c) => c.trim().replace(/\\\|/g, '|'));
}

function stripInlineComments(line) {
  let text = line;
  for (const [open, close] of Object.entries(COMMENT_BLOCK)) {
    for (;;) {
      const start = text.indexOf(open);
      if (start === -1) break;
      const end = text.indexOf(close, start + open.length);
      if (end === -1) break;
      text = text.slice(0, start) + text.slice(end + close.length);
    }
  }
  return text;
}

function isSeparatorRow(cells, width) {
  return !!cells && cells.length === width && cells.every((c) => c.search(/^:?-{2,}:?$/) !== -1);
}

// The Verdict column of a report check-validation has already accepted: header
// by name, the separator, then rows until the blank line before the closing line.
function readVerdicts(text) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => {
    const cells = splitRow(l);
    return cells !== null && cells.join('|') === CONFIG.reportHeader.join('|');
  });
  if (start < 0) return null;
  const column = CONFIG.reportHeader.indexOf('Verdict');
  const verdicts = [];
  let i = start + 1;
  while (i < lines.length && (lines[i].trim() === '' || isSeparatorRow(splitRow(lines[i]), CONFIG.reportHeader.length))) i += 1;
  for (; i < lines.length; i += 1) {
    const cells = splitRow(lines[i]);
    if (cells === null || cells.length !== CONFIG.reportHeader.length) break;
    const read = cells.map((c) => stripInlineComments(c).trim());
    verdicts.push({ ac: read[0], verdict: read[column] });
  }
  return verdicts;
}

function fetchable(dir, url, sha) {
  try {
    return fetchOne(dir, url, sha) === sha;
  } catch (err) {
    return false;
  }
}

// Git in the spoke's cache. Only the "no" the caller names is an answer. Any
// other failure is "cannot verify", never a "no".
function cacheGit(dir, repo, what, args, { no = null, input = null } = {}) {
  try {
    return git(['--git-dir', dir, ...args], input === null ? {} : { input, stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (err) {
    if (no !== null && err.status === 1) return no;
    throw new SpokeError(EXIT.CANNOT_VERIFY, `git cannot ${what} in the cache of ${repo}: ${firstLine(err.stderr) || err.message}`, 'git-failed');
  }
}

// The change from one commit to another, as one hash. `-U0` leaves out the
// context lines, so a trunk commit that changed a line next to the story's lines
// does not change the hash. Null when the two trees are the same.
function changeId(dir, repo, from, to) {
  const diff = cacheGit(dir, repo, `compute the change from ${short(from)} to ${short(to)}`,
    ['diff', '--no-color', '--no-ext-diff', '--no-renames', '--binary', '-U0', from, to]);
  if (diff === '') return null;
  return cacheGit(dir, repo, `compute the patch-id of the change to ${short(to)}`, ['patch-id', '--stable'], { input: diff }).split(' ')[0] || null;
}

// True when `text` names `key` as a whole key: no letter or digit before it,
// and no digit after it. Matched by hand, because the key comes from a file.
function namesKey(text, key) {
  const keyChar = (c) => (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9');
  for (let at = text.indexOf(key); at !== -1; at = text.indexOf(key, at + 1)) {
    const after = text[at + key.length] || '';
    if (!(at > 0 && keyChar(text[at - 1])) && !(after >= '0' && after <= '9')) return true;
  }
  return false;
}

/**
 * Where the code of the commit QA read is on the trunk. Three answers, in order:
 *
 *   ancestor  the commit is on the trunk (a merge commit or a fast-forward).
 *   tree      a first-parent trunk commit since the two lines parted has the
 *             commit's tree (a squash or a rebase merge of an up-to-date branch).
 *   change    a run of first-parent trunk commits since the two lines parted has
 *             the story's change: the change from the merge-base to the commit,
 *             compared by `git patch-id --stable`. A squash merge writes a run of
 *             one, and a rebase merge one commit for each commit of the branch.
 *             This is a squash or a rebase merge of a branch behind the trunk.
 *             QA did not read the merged tree, as after a merge commit of that
 *             branch.
 *
 * Otherwise `named` is the newest first-parent trunk commit since the parting
 * whose message names the key, or null. A commit fetched alone has no merge-base
 * in the cache, so the caller deepens it first. Without a merge-base the whole
 * first-parent line is searched for the tree, and the change is not asked.
 */
function findOnTrunk(dir, repo, sha, head, key) {
  if (cacheGit(dir, repo, `ask whether ${short(sha)} is on the trunk`, ['merge-base', '--is-ancestor', sha, head], { no: false }) !== false) {
    return { how: 'ancestor', commit: sha };
  }
  const base = cacheGit(dir, repo, `find where ${short(sha)} parted from the trunk`, ['merge-base', sha, head], { no: '' }).trim() || null;
  const range = base ? `${base}..${head}` : head;
  const tree = cacheGit(dir, repo, `read the tree of ${short(sha)}`, ['rev-parse', `${sha}^{tree}`]).trim();
  const sameTree = cacheGit(dir, repo, 'read the trunk', ['log', '--first-parent', '--format=%H %T', range])
    .split('\n').map((l) => l.split(' ')).find(([, t]) => t === tree);
  if (sameTree) return { how: 'tree', commit: sameTree[0] };
  if (!base) return { how: null, named: null };

  const own = changeId(dir, repo, base, sha);
  const count = Number(cacheGit(dir, repo, `count the commits of ${short(sha)}`, ['rev-list', '--count', '--no-merges', `${head}..${sha}`]).trim());
  if (own !== null && count > 0) {
    const paths = cacheGit(dir, repo, `list the paths ${short(sha)} changes`, ['diff', '--name-only', '--no-renames', base, sha]).split('\n').filter(Boolean);
    // Oldest first, each with the paths it changes against its first parent.
    const line = cacheGit(dir, repo, 'read the trunk', ['log', '--first-parent', '--diff-merges=first-parent', '--reverse', '--no-renames', '--name-only', '--format=%x01%H', range])
      .split('\x01').filter((b) => b.trim()).map((b) => {
        const [commit, ...changed] = b.split('\n').filter(Boolean);
        return { commit, changed };
      });
    for (let last = 0; last < line.length; last += 1) {
      const touched = new Set();
      for (let first = last; first >= 0 && last - first < count; first -= 1) {
        for (const p of line[first].changed) touched.add(p);
        // A run that does not touch every path of the change cannot hold it.
        if (!paths.every((p) => touched.has(p))) continue;
        if (changeId(dir, repo, `${line[first].commit}^1`, line[last].commit) === own) {
          return { how: 'change', commit: line[last].commit, first: line[first].commit, size: last - first + 1 };
        }
      }
    }
  }
  const named = cacheGit(dir, repo, 'read the trunk messages', ['log', '--first-parent', '--format=%x01%H %B', range])
    .split('\x01').filter((b) => b.trim()).find((b) => namesKey(b.slice(41), key));
  return { how: null, named: named ? named.slice(0, 40) : null };
}

export function askStory(story, hub, repositories, siblings, { through = 4 } = {}) {
  const answers = [];
  // `extra` adds fields to one answer. Question 4 adds `commit`, the trunk commit
  // that holds the report's code, which the dependency check reads, and on a
  // "no" a `reason`, which the comment at question 4 lists.
  const ask = (label, ok, detail, extra = {}) => { answers.push({ label, ok, detail, ...extra }); return ok; };
  const asRepo = story.repo ? { HARNESS_REPO: story.repo } : { HARNESS_REPO: '' };
  const repoName = story.repo || 'its repository';

  // A file name that is not a key is a story the two checks would refuse as
  // usage. Its fault is already recorded; nothing is asked on its behalf.
  if (story.key.search(KEY_PATTERN) === -1) {
    ask(QUESTIONS.design, false, 'not asked: the file name is not a work-item key');
    ask(QUESTIONS.report, false, 'not asked: the file name is not a work-item key');
    ask(QUESTIONS.verdicts, false, 'not asked: needs 2');
    ask(QUESTIONS.merged, false, 'not asked: needs 2');
    return answers;
  }

  // 1. The design is merged and the gate passes, asked as the story's repository.
  const designPath = `${CONFIG.designDir}/${story.key}${CONFIG.designSuffix}`;
  if (readBlob(hub.head, designPath) === null) {
    ask(QUESTIONS.design, false, `no: no ${designPath} on ${hub.ref}; the design is not merged`);
  } else {
    const gate = runSibling(siblings.gate, story.key, asRepo, hub);
    ask(QUESTIONS.design, gate.status === EXIT.PASS,
      gate.status === EXIT.PASS
        ? 'yes'
        : `no: the pickup gate says ${quote(gate.stdout, CONFIG.gateSummary)} (node scripts/${basename(siblings.gate)} ${story.key}, as ${repoName})`);
  }

  // Question 1 alone needs no report and no other repository.
  if (through === 1) return answers;

  // 2. The report is merged and complete.
  const reportPath = `${CONFIG.designDir}/${story.key}${CONFIG.reportSuffix}`;
  const report = readBlob(hub.head, reportPath);
  let complete = false;
  if (report === null) {
    ask(QUESTIONS.report, false, `no: no ${reportPath} on ${hub.ref}; /qa-sprint has not run, or its pull request is not merged`);
  } else {
    const check = runSibling(siblings.validation, story.key, {}, hub);
    complete = ask(QUESTIONS.report, check.status === EXIT.PASS,
      check.status === EXIT.PASS
        ? 'yes'
        : `no: the validation check says ${quote(check.stdout, CONFIG.validationSummary)} (node scripts/${basename(siblings.validation)} ${story.key})`);
  }

  // 3 and 4 read the report's content, so they wait for 2.
  if (!complete) {
    ask(QUESTIONS.verdicts, false, 'not asked: needs 2');
    ask(QUESTIONS.merged, false, 'not asked: needs 2');
    return answers;
  }

  const verdicts = readVerdicts(report);
  if (verdicts === null || verdicts.length === 0) {
    throw new SpokeError(EXIT.INTERNAL, `${reportPath} passed ${basename(siblings.validation)} but its table could not be read here; the two files disagree on the report's shape`);
  }
  const failed = verdicts.filter((v) => v.verdict === 'FAIL');
  const na = verdicts.filter((v) => v.verdict === 'N/A').length;
  ask(QUESTIONS.verdicts, failed.length === 0,
    failed.length === 0
      ? `yes (${verdicts.length - na} PASS${na ? `, ${na} N/A against a deprecated criterion` : ''})`
      : `no: ${failed.length} of ${verdicts.length} verdicts FAIL (${failed.map((v) => v.ac).join(', ')}); the installed check-validation passed a failing report, so it is older than this file`);

  const spoke = report.match(CONFIG.spokeLine);
  const named = report.match(REPOSITORY_LINE);
  const q4 = QUESTIONS.merged;
  if (!spoke || !named) {
    throw new SpokeError(EXIT.INTERNAL, `${reportPath} passed ${basename(siblings.validation)} but its header lines could not be read here`);
  }
  const sha = spoke[1].toLowerCase();
  // Each "no" of question 4 carries a reason, so a caller chooses the next step
  // by the reason and never by the text:
  //   no-repository   the story names no repository
  //   wrong-repository the report names another repository than the story
  //   not-listed      the repository is not in the list of repositories
  //   unknown-commit  the spoke does not serve the commit the report names
  //   not-merged      no trunk commit holds the code, and none names the key
  //   merged-changed  a trunk commit names the key, but no trunk commit holds
  //                   the change QA validated
  if (!story.repo) {
    ask(q4, false, 'no: the story names no repository, so there is no trunk to ask', { reason: 'no-repository' });
  } else if (named[1] !== story.repo) {
    ask(q4, false, `no: the report says Repository: ${named[1]} and the story says ${story.repo}`, { reason: 'wrong-repository' });
  } else {
    const state = repositories.get(story.repo);
    if (!state.listed) {
      ask(q4, false, `no: "${story.repo}" is not in ${CONFIG.registryPath}; check-decomposition refuses this story, and there is no trunk to ask`, { reason: 'not-listed' });
    } else if (hasCommit(state.dir, sha) || fetchable(state.dir, state.url, sha)) {
      // A depth-1 read leaves the commit without its parents, and then git finds
      // no merge-base. The change test needs the story's history.
      if (existsSync(join(state.dir, 'shallow'))) fetchBranchFully(state.dir, state.url, sha);
      const found = findOnTrunk(state.dir, story.repo, sha, state.head, story.key);
      const on = `${story.repo}'s trunk ${state.trunk}`;
      if (found.how === 'ancestor') {
        ask(q4, true, `yes: ${short(sha)} is on ${on} (head ${short(state.head)})`, { commit: sha });
      } else if (found.how === 'tree') {
        ask(q4, true, `yes: ${short(sha)} merged into ${on} as ${short(found.commit)}, with the same tree (a squash or a rebase merge)`, { commit: found.commit });
      } else if (found.how === 'change') {
        const as = found.size === 1 ? short(found.commit) : `the ${found.size} trunk commits ${short(found.first)} to ${short(found.commit)}`;
        ask(q4, true, `yes: ${short(sha)} merged into ${on} as ${as}, with the same change on a newer trunk (a squash or a rebase merge of a branch behind the trunk); QA did not read the merged tree`, { commit: found.commit });
      } else {
        const detail = `no: ${short(sha)} is a commit of ${story.repo} but not on its trunk ${state.trunk} (head ${short(state.head)}), and no trunk commit since the two lines parted has its tree or its change; the code the report read is not the code on the trunk`;
        if (found.named) {
          ask(q4, false, `${detail}. ${short(found.named)} on the trunk names ${story.key} in its message`, { reason: 'merged-changed', named: found.named, validated: sha });
        } else {
          ask(q4, false, detail, { reason: 'not-merged' });
        }
      }
    } else {
      ask(q4, false, `no: ${short(sha)} is not a commit ${story.repo} knows (or its server does not serve a bare hash); either way it is not on ${state.trunk}`, { reason: 'unknown-commit' });
    }
  }
  return answers;
}


/**
 * baseline.mjs — what setup proves about an approved test commit, and whether its test command can
 * change without a protected file changing.
 *
 * Every commit between the trunk and the baseline, along the first parent, is one of four kinds:
 *   - the test writer's stubs commit, which adds, deletes and retypes no path the declaration
 *     covers, watermarked. It may modify an existing protected file, so that a signature the design
 *     changes and the tests that call it compile in one commit;
 *   - the test writer's test commit, which changes such paths only, watermarked;
 *   - a candidate an earlier guarded run accepted, `feat(<KEY>): the engineer's implementation,
 *     round <n>`, watermarked, which changes no path the declaration covers;
 *   - a trunk merge: a merge whose second parent is on the spoke's trunk as read-spoke read it, and
 *     which leaves every protected path as one of its two parents has it.
 * The last two are what a fix round after /qa-sprint starts from: the branch QA validated, with the
 * code an earlier run accepted on it. The chain holds at least one test commit. The manifest is
 * every tracked entry the declaration covers at the baseline, and every tracked runner
 * configuration must be one of them. After a trunk merge, coverage is measured from the newest
 * trunk commit merged in, so the changed lines are the branch's own.
 *
 * A run for one pull-request comment (setup --subject) starts at the branch's tip instead: its range
 * is the comment's one test commit, or empty for a comment no test can see — the one case an empty
 * range is allowed. Nothing before the range's start is read.
 *
 * What the declaration leaves uncovered (declarationGaps) is refused too: a tracked runner
 * configuration, a tracked file a supported runner collects as a test by its convention, and a mixed
 * file that carries runner configuration — the one place a file's contents are read.
 *
 * The test command (commandIntegrity) reads no file's contents; the rule is about which files exist
 * and are protected:
 *   - a token of TEST_COMMAND that names a tracked file must be protected;
 *   - a command that runs vitest with no --config and no vitest.config.* must have the vite.config.* it
 *     reads protected, and a vite.config.* it would find if one were added is refused in the run
 *     (discoveredConfigs);
 *   - a task-runner alias must have its controlling file protected (ALIASES is the whole list; a
 *     runner not on it is read as a direct runner);
 *   - an alias whose controlling file also holds dependencies is refused, because protecting the
 *     file whole would freeze them and the guard has no field-level policy.
 */

import { basename } from 'node:path';
import { GUARD_KEY } from './common.mjs';
import { commitInfo, git, gitTry, readBlob, revParse } from './git.mjs';
import { buildManifest, embeddedRunnerConfig, isRunnerConfig, isRunnerHost, makePolicy, patternCoverage, testConvention } from './contract.mjs';
import { watermarkProblem } from '../check-watermark.mjs';

const listOf = (paths, n = 8) => `${paths.slice(0, n).join(', ')}${paths.length > n ? `, and ${paths.length - n} more` : ''}`;

/**
 * What the declaration leaves uncovered at a commit, which the guard cannot protect and the engineer
 * could change: a tracked runner configuration; a tracked file a supported runner collects as a test
 * by its convention; a tracked mixed file (package.json, pyproject.toml, setup.cfg) that carries
 * runner configuration. `tree` is that commit's ls-tree, `cwd` the repository its objects are read from.
 */
export function declarationGaps(cwd, tree, policy) {
  const findings = [];
  const byConvention = new Map();
  for (const e of tree) {
    if (policy.approved.has(e.path)) continue;
    if (isRunnerConfig(e.path)) { findings.push(`${e.path} configures the test runner and is tracked, but ${GUARD_KEY} does not cover it, so the engineer could change it — add it to ${GUARD_KEY}`); continue; }
    const convention = testConvention(e.path);
    if (convention) { byConvention.set(convention, [...(byConvention.get(convention) || []), e.path]); continue; }
    if (e.type !== 'blob' || !isRunnerHost(e.path)) continue;
    const found = embeddedRunnerConfig(e.path, readBlob(cwd, e.oid));
    if (found.length) {
      findings.push(`${e.path} configures the test runner (${found.join(', ')}), but ${GUARD_KEY} does not cover it, so the engineer could change what the tests run. `
        + `The guard protects files whole and reads no field inside one: either add ${e.path} to ${GUARD_KEY} — which also freezes everything else in it for the sprint, its dependencies included — `
        + 'or move the runner configuration into a file of its own (jest.config.js, .mocharc.json, pytest.ini, .coveragerc …) and add that');
    }
  }
  for (const [convention, paths] of byConvention) {
    findings.push(`${paths.length} tracked file${paths.length === 1 ? ' is' : 's are'} laid out as tests by a supported runner's convention (${convention}) but ${GUARD_KEY} does not cover ${paths.length === 1 ? 'it' : 'them'}: ${listOf(paths)}. `
      + `Add patterns to ${GUARD_KEY} that cover ${paths.length === 1 ? 'it' : 'them'}, or rename production code that is not a test`);
  }
  return findings;
}

const escapeKey = (key) => key.replace(/[-]/g, '\\-');
const STUBS_SUBJECT = (key) => new RegExp(`^chore\\(${escapeKey(key)}\\): stubs\\b`);
const TEST_SUBJECT = (key) => new RegExp(`^test\\(${escapeKey(key)}\\): \\S`);
// The subject the finalizer gives the candidate it builds (checks.mjs), and that accept fast-forwards to.
const CANDIDATE_SUBJECT = (key) => new RegExp(`^feat\\(${escapeKey(key)}\\): the engineer's implementation, round [1-9]\\d*$`);

const isAncestor = (ctl, a, b) => gitTry(ctl, ['merge-base', '--is-ancestor', a, b]).status === 0;
const blobAt = (ctl, commit, path) => { const r = gitTry(ctl, ['rev-parse', '--verify', '--quiet', `${commit}:${path}`]); return r.status === 0 ? r.stdout.trim() : null; };

/**
 * The commits from `base` to `test` along the first parent, oldest first, each sitting on the one
 * before. A merge's second parent is not walked: what a trunk merge brings in is the trunk's, and the
 * merge itself is judged in checkChain. Null, with a finding, when the line is broken.
 */
function chainRange(ctl, base, test, findings) {
  const label = 'the branch\'s commits';
  if (!isAncestor(ctl, base, test)) {
    findings.push(`${label}: ${base.slice(0, 12)} is not an ancestor of ${test.slice(0, 12)}`);
    return null;
  }
  const shas = git(ctl, ['rev-list', '--reverse', '--first-parent', `${base}..${test}`]).split('\n').filter(Boolean);
  const commits = shas.map((sha) => commitInfo(ctl, sha));
  let expect = base;
  for (const c of commits) {
    if (c.parents.length > 2) { findings.push(`${label}: commit ${c.sha} has ${c.parents.length} parents; the only merge the chain holds is a trunk merge, with two`); return null; }
    if (c.parents[0] !== expect) { findings.push(`${label}: commit ${c.sha} does not sit on ${expect.slice(0, 12)}; the chain is one line from ${base.slice(0, 12)}, along the first parent`); return null; }
    expect = c.sha;
  }
  return commits;
}

/** Each commit judged by its kind; returns the newest trunk commit a trunk merge brought in, or null. */
function checkChain(ctl, commits, key, policy, trunk, findings) {
  const stubsRe = STUBS_SUBJECT(key);
  const testRe = TEST_SUBJECT(key);
  const candidateRe = CANDIDATE_SUBJECT(key);
  let merged = null;
  const changedIn = (c) => git(ctl, ['diff-tree', '-r', '-z', '--no-renames', '--no-commit-id', '--name-only', c.parents[0], c.sha]).split('\0').filter(Boolean);
  // Each changed path with its status letter: A added, D deleted, M modified, T its type changed.
  const statusIn = (c) => {
    const fields = git(ctl, ['diff-tree', '-r', '-z', '--no-renames', '--no-commit-id', '--name-status', c.parents[0], c.sha]).split('\0').filter(Boolean);
    const out = [];
    for (let i = 0; i + 1 < fields.length; i += 2) out.push([fields[i], fields[i + 1]]);
    return out;
  };
  for (const c of commits) {
    if (c.parents.length === 2) {
      // A trunk merge: "Update branch", or a person's merge of the trunk. It carries no watermark,
      // because a person or the code host makes it; what it may not do is change a protected path
      // to anything but what one of its parents holds.
      if (!trunk || gitTry(ctl, ['cat-file', '-e', `${trunk}^{commit}`]).status !== 0) {
        findings.push(`commit ${c.sha} is a merge, and the spoke's trunk commit read-spoke read${trunk ? `, ${trunk.slice(0, 12)},` : ''} is not in the controller checkout to judge it against; fetch the trunk into the controller`);
        continue;
      }
      if (!isAncestor(ctl, c.parents[1], trunk)) {
        findings.push(`commit ${c.sha} merges ${c.parents[1].slice(0, 12)}, which is not on the spoke's trunk at ${trunk.slice(0, 12)}; the only merge the chain holds is a merge of the trunk`);
        continue;
      }
      for (const path of changedIn(c).filter((p) => policy.declared(p))) {
        const here = blobAt(ctl, c.sha, path);
        if (here !== blobAt(ctl, c.parents[0], path) && here !== blobAt(ctl, c.parents[1], path)) {
          findings.push(`trunk merge ${c.sha} leaves ${path}, which ${GUARD_KEY} covers, as neither of its parents has it; a merge resolution that rewrites a test is a test change, and only the test writer makes one`);
        }
      }
      merged = c.parents[1];
      continue;
    }
    const is = (re) => c.subject.search(re) !== -1;
    const kind = is(stubsRe) ? 'stubs' : is(testRe) ? 'test' : is(candidateRe) ? 'candidate' : null;
    if (!kind) {
      findings.push(`commit ${c.sha} "${c.subject}" is not "chore(${key}): stubs", "test(${key}): …", an accepted candidate "feat(${key}): the engineer's implementation, round <n>" or a trunk merge; only those sit between the trunk and the baseline`);
      continue;
    }
    const problem = watermarkProblem(c.message);
    if (problem) findings.push(`commit ${c.sha} "${c.subject}": ${problem}`);
    for (const [status, path] of statusIn(c)) {
      const covered = policy.declared(path);
      // A changed signature and its callers compile only together, and in a compiled language some
      // callers are protected tests. So the stubs commit may modify a protected file that already
      // exists; the critic judges that the change only follows the signature. Adding a protected
      // file stays refused, because a stub would land there and freeze.
      if (kind === 'stubs' && covered && status === 'A') findings.push(`stubs commit ${c.sha} adds ${path}, which ${GUARD_KEY} covers; a stub is production code the engineer must be able to change, so the two cannot overlap — move the stub out of the protected paths, or the test file out of the stubs commit`);
      if (kind === 'stubs' && covered && status !== 'A' && status !== 'M') findings.push(`stubs commit ${c.sha} ${status === 'D' ? 'deletes' : 'changes the type of'} ${path}, which ${GUARD_KEY} covers; the stubs commit may only modify an existing protected file to follow a signature the design changes — move this change to the test commit`);
      if (kind === 'candidate' && covered) findings.push(`candidate commit ${c.sha} changes ${path}, which ${GUARD_KEY} covers; an accepted candidate holds the approved tests as approved, so this commit was not built by the finalizer`);
      if (kind === 'test' && !covered) findings.push(`test commit ${c.sha} changes ${path}, which ${GUARD_KEY} does not cover; a test path outside the declaration would not be protected — add a pattern for it, or move it out of the test commit`);
    }
  }
  if (!commits.some((c) => c.parents.length === 1 && c.subject.search(testRe) !== -1)) findings.push(`no commit between the trunk and the baseline is a "test(${key}): …" commit; the test writer's approved tests come first`);
  const last = commits[commits.length - 1];
  if (last && last.parents.length === 1 && last.subject.search(stubsRe) !== -1) findings.push(`the baseline is the stubs commit; it is a "test(${key}): …" commit, an accepted candidate or a trunk merge`);
  return merged;
}

/**
 * Returns { commits, entries, notes, integrity, coverageBase } or null; every problem goes into
 * `findings`. `trunk` is the spoke's trunk commit read-spoke read, which a trunk merge is judged
 * against. `coverageBase` is `base`, or the newest trunk commit a trunk merge brought in. With a
 * `subject` (one pull-request comment), `test` may be `base` itself: no commit to prove, every other
 * rule as for any run.
 */
export function proveBaseline({ ctl, key, base, test, guard, testCommand, trunk, subject = null, findings }) {
  for (const [name, sha] of [['base', base], ['test', test]]) {
    if (gitTry(ctl, ['cat-file', '-t', sha]).stdout.trim() !== 'commit') findings.push(`--${name} ${sha} is not a commit in the controller checkout`);
  }
  if (findings.length) return null;
  const commits = chainRange(ctl, base, test, findings);
  if (!commits) return null;
  if (!commits.length && subject === null) { findings.push(`there is no commit between ${base.slice(0, 12)} and ${test.slice(0, 12)}`); return null; }
  const { entries, tree } = buildManifest(ctl, test, guard);
  if (!entries.length) findings.push(`${GUARD_KEY} protects no tracked entry at the approved test commit ${test.slice(0, 12)}`);
  for (const e of entries) if (!e.utf8) findings.push(`${e.path}: a protected path that is not UTF-8 cannot be recorded exactly; rename it`);
  const guardCover = patternCoverage(GUARD_KEY, guard, tree);
  findings.push(...guardCover.findings);
  const policy = makePolicy({ guard, manifest: entries });
  findings.push(...declarationGaps(ctl, tree, policy));
  const merged = commits.length ? checkChain(ctl, commits, key, policy, trunk, findings) : null;
  const integrity = commandIntegrity(testCommand, new Map(tree.map((e) => [e.path, e])), (p) => policy.approved.has(p));
  findings.push(...integrity.findings);
  return { commits, entries, notes: [...guardCover.notes, ...integrity.notes], integrity, coverageBase: merged || base };
}

/** The controller is clean, on a branch, at the baseline; returns the branch name. */
export function controllerReady(ctl, test, findings) {
  if (gitTry(ctl, ['rev-parse', '--is-shallow-repository']).stdout.trim() === 'true') findings.push(`${ctl} is a shallow clone; the guard reads whole history`);
  const status = git(ctl, ['status', '--porcelain=v1', '--untracked-files=all']);
  if (status.trim()) findings.push(`the controller checkout is not clean:\n${status.trimEnd().split('\n').map((l) => `    ${l}`).join('\n')}`);
  const branch = gitTry(ctl, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  if (branch.status !== 0) findings.push('the controller checkout is not on a branch');
  const head = revParse(ctl, 'HEAD^{commit}');
  if (head !== test) findings.push(`the controller's HEAD is ${head || 'nothing'}, not the baseline ${test}`);
  return branch.stdout.trim();
}

/* ------------------------------------------------------------ the test command */

const ALIASES = [
  { programs: ['make', 'gmake'], files: ['GNUmakefile', 'makefile', 'Makefile'], flags: ['-f', '--file', '--makefile'], dirFlags: ['-C', '--directory'] },
  { programs: ['just'], files: ['justfile', 'Justfile', '.justfile'], flags: ['-f', '--justfile'] },
  { programs: ['task'], files: ['Taskfile.yml', 'taskfile.yml', 'Taskfile.yaml', 'taskfile.yaml'], flags: ['-t', '--taskfile'] },
  { programs: ['rake'], files: ['Rakefile', 'rakefile', 'Rakefile.rb', 'rakefile.rb'], flags: ['-f', '--rakefile'] },
  { programs: ['nox'], files: ['noxfile.py'], flags: ['-f', '--noxfile'] },
  { programs: ['tox'], files: ['tox.ini'], flags: ['-c', '--conf'], fallbackMixed: ['pyproject.toml', 'setup.cfg'] },
  { programs: ['npm'], files: ['package.json'], mixed: true, direct: ['exec', 'x'] },
  { programs: ['pnpm'], files: ['package.json'], mixed: true, direct: ['exec', 'dlx'] },
  { programs: ['yarn'], files: ['package.json'], mixed: true, direct: ['dlx', 'exec'] },
  { programs: ['bun'], files: ['package.json'], mixed: true, direct: ['test', 'x'] },
  { programs: ['composer'], files: ['composer.json'], mixed: true, direct: ['exec'] },
  { programs: ['gradle', 'gradlew'], files: ['build.gradle', 'build.gradle.kts'], mixed: true },
  { programs: ['mvn', 'mvnw'], files: ['pom.xml'], mixed: true },
  { programs: ['sbt'], files: ['build.sbt'], mixed: true },
  { programs: ['hatch'], files: ['pyproject.toml', 'hatch.toml'], mixed: true },
  { programs: ['pdm'], files: ['pyproject.toml'], mixed: true },
];
const SHELLS = ['sh', 'bash', 'zsh', 'dash', 'ksh'];

const LIMITATION = 'protecting it whole would block a legitimate dependency change, and the guard reads no field inside a file. '
  + 'Run the tool directly (for example `node --test …`, `npx jest …`, `pytest …`), or move the test configuration into a file of its own and add that to TEST_GUARD_PATHS; '
  + 'a field-level policy is not part of this library yet';

/**
 * `tree` is a Map of path to entry at the approved test commit; `guarded(path)` says whether a path
 * is approved. Returns findings, notes, the files the command depends on, and direct or alias.
 */
export function commandIntegrity(command, tree, guarded) {
  const findings = [];
  const notes = [];
  const controlling = [];
  const at = `TEST_COMMAND "${command}"`;
  if (/`|\$\(/.test(command)) {
    return { findings: [`${at} uses command substitution, which the guard cannot read; write the runner command itself`], notes, controlling, kind: 'opaque' };
  }
  const isTrackedFile = (p) => { const e = tree.get(p); return !!e && e.type === 'blob'; };
  const need = (path, why) => {
    if (controlling.includes(path)) return;
    controlling.push(path);
    if (!guarded(path)) findings.push(`${at} ${why}; ${path} is not in ${GUARD_KEY}, so the engineer could change what the command runs — add ${path} to ${GUARD_KEY}, or write the runner command directly`);
  };
  let kind = 'direct';
  // Split on the operators alone and trim each piece: whitespace around an operator inside the
  // pattern makes the split quadratic on a long run of spaces.
  for (const segment of command.split(/&&|\|\||;|\|/).map((s) => s.trim()).filter(Boolean)) {
    const tokens = segment.split(/\s+/);
    let i = 0;
    while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i += 1;
    if (tokens[i] === 'env') { i += 1; while (i < tokens.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]) || tokens[i].startsWith('-'))) i += 1; }
    const program = tokens[i];
    if (program === undefined || program === 'cd') continue;
    const args = tokens.slice(i + 1);
    const name = basename(program);
    if (SHELLS.includes(name) && args.includes('-c')) {
      findings.push(`${at} runs "${name} -c", a command line the guard cannot read; write the runner command itself`);
      continue;
    }
    for (const t of [program, ...args]) {
      const value = (t.startsWith('--') && t.includes('=') ? t.slice(t.indexOf('=') + 1) : t).replace(/^\.\/+/, '');
      if (value && !value.startsWith('-') && isTrackedFile(value)) need(value, `names ${value}, a tracked file it runs or reads`);
    }
    if (program.startsWith('./') && !isTrackedFile(program.replace(/^\.\/+/, '')) && !ALIASES.some((a) => a.programs.includes(name))) {
      findings.push(`${at} runs ${program}, which is not a tracked file at the approved test commit`);
    }
    const alias = ALIASES.find((a) => a.programs.includes(name));
    if (!alias) continue;
    const sub = args.find((a) => !a.startsWith('-'));
    if (alias.direct && alias.direct.includes(sub)) continue;
    kind = 'alias';
    if (alias.mixed) {
      findings.push(`${at} runs "${name}${sub ? ` ${sub}` : ''}", an alias defined in ${alias.files.join(' or ')}, which also holds the repository's dependencies: ${LIMITATION}`);
      continue;
    }
    let dir = '';
    let named = null;
    for (let k = 0; k < args.length; k += 1) {
      const a = args[k];
      const take = (flags) => { for (const f of flags || []) { if (a === f) return args[k + 1]; if (a.startsWith(`${f}=`)) return a.slice(f.length + 1); } return undefined; };
      const d = take(alias.dirFlags);
      if (d !== undefined) dir = `${d.replace(/^\.\/+/, '').replace(/\/+$/, '')}/`;
      const f = take(alias.flags);
      if (f !== undefined) named = f.replace(/^\.\/+/, '');
    }
    const prefix = dir === '/' ? '' : dir;
    const candidates = named ? [named] : alias.files.map((f) => `${prefix}${f}`);
    const present = candidates.find(isTrackedFile);
    if (present) { need(present, `runs "${name}", an alias defined in ${present}`); continue; }
    const fallback = (alias.fallbackMixed || []).map((f) => `${prefix}${f}`).find(isTrackedFile);
    if (fallback) findings.push(`${at} runs "${name}", which reads its configuration from ${fallback} when ${candidates.join(' or ')} is absent; ${fallback} also holds the repository's dependencies: ${LIMITATION}`);
    else findings.push(`${at} runs "${name}", which reads ${candidates.join(', ')}; none is tracked at the approved test commit`);
  }
  const found = discoveredConfigs(command, new Set(tree.keys()));
  for (const p of found.tracked) {
    need(p, `runs vitest, which reads its test configuration from ${p} when there is no vitest.config.* and no --config; protecting ${p} whole also freezes the build configuration for the sprint — or move the test block into a vitest.config.* and add that instead`);
  }
  if (found.absent.length) notes.push(`${at} runs vitest with no --config and no vitest.config.* tracked, so it would load a vite.config.* added at its root: ${found.absent.join(', ')} are refused as new runner configuration for the run`);
  if (!findings.length && kind === 'direct') {
    notes.push(`${at} runs its tool directly; the files that tool reads its configuration from are ${GUARD_KEY}'s to name — the guard reads no file's contents`);
  }
  return { findings, notes, controlling, kind };
}

/* ------------------------------------------------- configuration a runner finds by searching */

// Vite's own order: the first of these that exists is the one loaded.
const VITE_EXTS = ['js', 'mjs', 'ts', 'cjs', 'mts', 'cts'];

function flagValue(args, flags) {
  for (let k = 0; k < args.length; k += 1) {
    for (const f of flags) {
      if (args[k] === f) return args[k + 1] ?? '';
      if (args[k].startsWith(`${f}=`)) return args[k].slice(f.length + 1);
    }
  }
  return undefined;
}

/**
 * The configuration a test command's runner finds by searching rather than by being told, where the
 * search reaches a file no runner-configuration name covers: today Vitest, which with no --config
 * loads vitest.config.* from its root and, failing that, the build's vite.config.*. Returns the
 * vite.config.* paths it would load — `tracked` ones, which must be protected, and `absent` ones,
 * which a run refuses as new runner configuration. Both are empty when the command names its
 * configuration, a vitest.config.* is tracked at that root (it wins over every vite.config.*), or the
 * command runs no vitest: a vite.config.* is then the build's alone. `paths` is the set of tracked
 * paths at the approved test commit; a `cd` before the runner is not followed.
 */
export function discoveredConfigs(command, paths) {
  const tracked = new Set();
  const absent = new Set();
  for (const segment of String(command || '').split(/&&|\|\||;|\|/).map((x) => x.trim()).filter(Boolean)) {
    const tokens = segment.split(/\s+/);
    const at = tokens.findIndex((t) => basename(t) === 'vitest');
    if (at === -1 || tokens[0] === 'cd') continue;
    const args = tokens.slice(at + 1);
    if (flagValue(args, ['--config', '-c']) !== undefined) continue;
    const r = flagValue(args, ['--root', '-r']);
    const dir = r === undefined ? '' : r.replace(/^\.\/+/, '').replace(/\/+$/, '');
    const root = dir && dir !== '.' ? `${dir}/` : '';
    if (VITE_EXTS.some((x) => paths.has(`${root}vitest.config.${x}`))) continue;
    for (const x of VITE_EXTS) (paths.has(`${root}vite.config.${x}`) ? tracked : absent).add(`${root}vite.config.${x}`);
  }
  return { tracked: [...tracked], absent: [...absent] };
}

#!/usr/bin/env node
/**
 * run.mjs: the fixture suite for plan-survey.mjs.
 *
 *   usage:  node run.mjs            run every fixture
 *           node run.mjs 2 6        run only the numbered fixtures
 *           node run.mjs --keep     leave the throwaway repositories on disk
 *
 * A fixture is a REPOSITORY STATE: a throwaway git repository, used as the
 * clone, with the files the fixture lists, committed. The shipped script runs
 * against it as /survey-repo runs it. Exit code, output and plan.json are
 * asserted. Fixture 1 is the valid control. Unless a fixture says otherwise,
 * it plans with --budget 100.
 *
 * A refresh fixture commits a second state on top of the first. It writes the
 * previous survey at the first commit with renderSurvey. The suite imports
 * surveys.mjs from the folder of the script under test. Then the fixture plans
 * with --previous and --since.
 *
 * Node standard library only, plus git via child_process. No test framework.
 * Exit 0 if every fixture passes, 1 if any fails.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { deflateSync } from 'node:zlib';

const HERE = dirname(fileURLToPath(import.meta.url));

const SCRIPT = [
  process.env.HARNESS_PLAN_SURVEY,
  resolve(HERE, '..', '..', 'plan-survey.mjs'),
  resolve(HERE, '..', '..', 'scripts', 'plan-survey.mjs'),
].filter(Boolean).find((p) => existsSync(p));

if (!SCRIPT) {
  console.error('cannot locate plan-survey.mjs. Set HARNESS_PLAN_SURVEY=/path/to/plan-survey.mjs.');
  process.exit(4);
}

const { parseSurvey, renderSurvey, excludeRule, factKind, factFiles, FACT_KINDS, notReadRows, packageRoots, parseLsTree, isNumericText, isLicensedText, isQuietMarkup, numericCandidates, EXCLUDE_RULES, EXCLUDE_LIMIT, NUMERIC_JSON_LIMIT } = await import(pathToFileURL(join(dirname(SCRIPT), 'surveys.mjs')).href);

/* ------------------------------------------------------------------ git helpers */

const SANDBOX_HOME = mkdtempSync(join(tmpdir(), 'plan-survey-home-'));
const ENV = {
  ...process.env,
  HOME: SANDBOX_HOME,
  XDG_CONFIG_HOME: join(SANDBOX_HOME, '.config'),
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
  GIT_ASKPASS: 'true',
};

function git(cwd, args) {
  return execFileSync('git', args, { cwd, env: ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

const text = (n, ch = 'x') => `${ch.repeat(n - 1)}\n`;
// The content of excludeRule in which one set holds one path.
const only = (set, path) => ({ numeric: new Set(), licensed: new Set(), quiet: new Set(), [set]: new Set([path]) });
// A file of `total` bytes with `hits` numeric characters: digits, then letters, then the line feed, which counts as white space.
const digits = (total, hits) => `${'1'.repeat(hits - 1)}${'a'.repeat(total - hits)}\n`;

/** A repository with one commit. `files` maps a path to text, or to a Buffer. */
function makeClone(root, files, { extra = null } = {}) {
  const dir = join(root, 'clone');
  mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q', '--initial-branch', 'main']);
  git(dir, ['config', 'user.name', 'Fixture Runner']);
  git(dir, ['config', 'user.email', 'fixture@example.invalid']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), body);
  }
  if (extra) extra(dir);
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'commit 1']);
  return { dir, commit: git(dir, ['rev-parse', 'HEAD']).trim() };
}

function plan(clone, out, extraArgs = [], commit = clone.commit) {
  return spawnSync(process.execPath, [SCRIPT, '--id', 'svc', '--clone', clone.dir, '--commit', commit, '--out', out, ...extraArgs], { env: ENV, encoding: 'utf8' });
}

const readPlan = (out) => JSON.parse(readFileSync(join(out, 'plan.json'), 'utf8'));
const pathsOf = (out) => readPlan(out).parts.map((p) => p.paths);

/* ---------------------------------------------------------------- refreshes */

/** Commit a second state: renames first, then removals, then writes. */
function commitNext(clone, { write = {}, remove = [], rename = [] } = {}) {
  for (const [from, to] of rename) git(clone.dir, ['mv', from, to]);
  for (const rel of remove) git(clone.dir, ['rm', '-q', rel]);
  for (const [rel, body] of Object.entries(write)) {
    mkdirSync(dirname(join(clone.dir, rel)), { recursive: true });
    writeFileSync(join(clone.dir, rel), body);
  }
  git(clone.dir, ['add', '-A']);
  git(clone.dir, ['commit', '-q', '--allow-empty', '-m', 'commit 2']);
  return { dir: clone.dir, commit: git(clone.dir, ['rev-parse', 'HEAD']).trim() };
}

/** A pointer in the shape parseSurvey gives. renderSurvey writes its text. */
const at = (pin, path, from = 1, to = 1) => ({ id: 'svc', pin, path, from, to, text: `svc@${pin}:${path} L${from}-${to}` });
const serve = (key, evidence) => ({ table: 'serves', key, what: `Serves ${key}`, evidence });
const openPoint = (what, evidence) => ({ what, owner: 'service owner', resolves: 'the deployment configuration', evidence });

/**
 * A refresh fixture's run. `survey(pin)` gives { rows, openPoints } pinned at
 * `pin`. The survey names `surveyAt`, the first commit unless given, and the
 * plan runs with --since `since`, the same commit unless given. `edit` changes
 * the survey text before it is written. `after` runs on the delta plan.
 */
function refresh({ survey, next = {}, budget = 100, since = null, surveyAt = null, edit = (t) => t, after = null }) {
  return (clone, out) => {
    const old = surveyAt || clone.commit;
    const { rows, openPoints = [] } = survey(old.slice(0, 12));
    const previous = join(dirname(out), 'previous.md');
    writeFileSync(previous, edit(renderSurvey({ repository: 'svc', commit: old, rows, openPoints })));
    const second = commitNext(clone, next);
    let res = plan(second, out, ['--budget', String(budget), '--previous', previous, '--since', since || old], second.commit);
    if (after && res.status === 0) res = after(second, out);
    res.second = second;
    return res;
  };
}

const readCarried = (out) => readFileSync(join(out, 'carried.md'), 'utf8');
const rowsOf = (out) => Object.fromEntries(readPlan(out).parts.map((p) => [p.id, p.rows]));

/** A fact sheet at `commit`, with `edit` to change its text. */
function factSheet(commit, edit = (t) => t) {
  const pin = commit.slice(0, 12);
  return edit([
    '---',
    'kind: service-survey-facts',
    'repository: svc',
    `commit: ${commit}`,
    '---',
    '',
    '# Fact sheet of svc',
    '',
    '## Stores',
    '',
    '| Key | What | Evidence |',
    '|---|---|---|',
    `| \`store:mysql:orders\` | MySQL, the orders database | svc@${pin}:config/db.ini L1-2 |`,
    '',
    '## Configuration properties',
    '',
    '| Property | Holds | Value | Evidence |',
    '|---|---|---|---|',
    `| \`db.host\` | host | none in the repository | svc@${pin}:config/db.ini L1-1 |`,
    '',
    '## Routes',
    '',
    '| Rule | Evidence |',
    '|---|---|',
    `| A path /{module}/{action} runs the action of that module | svc@${pin}:src/Router.php L2-3 |`,
    '',
    '## HTTP helpers',
    '',
    'None found.',
    '',
  ].join('\n'));
}

function checkSheet(edit) {
  return (clone, out) => {
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, 'facts.md'), factSheet(clone.commit, edit));
    return plan(clone, out, ['--check-facts']);
  };
}

const SHEET_FILES = { 'config/db.ini': 'host=\nname=orders\n', 'src/Router.php': '<?php\n// routes\nreturn [];\n' };

/* -------------------------------------------------------------------- fixtures */

// Each fixture: n, name, files, [extra], [args], [commit], exit, includes, check(out, result).
const FIXTURES = [
  {
    n: 1,
    name: 'three small files are one part',
    files: { 'a.js': text(30), 'b.js': text(30), 'c.js': text(30) },
    exit: 0,
    includes: ['Mode: full (no previous survey)', 'Part: P1 90 bytes 1 paths', 'PLANNED: svc@'],
    excludes: ['Large file:'],
    check: (out) => {
      const p = readPlan(out);
      expectEqual(p.parts.length, 1);
      expectEqual(p.parts[0].paths, ['./']);
      expectEqual(p.parts[0].files, [{ path: 'a.js', bytes: 30 }, { path: 'b.js', bytes: 30 }, { path: 'c.js', bytes: 30 }]);
      expectEqual(p.parts[0].rows, []);
      expectEqual(p.reason, 'no previous survey');
      expectEqual(p.mode, 'full');
      expectEqual(p.budget, 100);
      expectEqual(p.repository, 'svc');
    },
  },
  {
    n: 2,
    name: 'two folders over the budget together are two parts',
    files: { 'src/a/one.js': text(80), 'src/b/two.js': text(80) },
    exit: 0,
    check: (out) => expectEqual(pathsOf(out), [['src/a/'], ['src/b/']]),
  },
  {
    n: 3,
    name: 'the files directly in a folder pack together, before its child folders',
    files: { 'src/x.js': text(30), 'src/y.js': text(30), 'src/a/one.js': text(80) },
    exit: 0,
    check: (out) => expectEqual(pathsOf(out), [['src/x.js', 'src/y.js'], ['src/a/']]),
  },
  {
    n: 4,
    name: 'one file over the budget is a part of its own',
    files: { 'big.js': text(300), 'small.js': text(10) },
    exit: 0,
    check: (out) => {
      const p = readPlan(out);
      const big = p.parts.find((part) => part.paths.includes('big.js'));
      expectEqual(big.bytes, 300);
      expectEqual(big.paths, ['big.js']);
    },
  },
  {
    n: 5,
    name: 'a binary file is in no part',
    files: { 'logo.png': Buffer.from([0x89, 0x50, 0x00, 0x00, 0x01, 0x00, 0x02, ...Array(20).fill(0x02)]), 'a.js': text(30) },
    exit: 0,
    check: (out) => {
      // The folder shows as './' because every plannable file is in the part.
      expectEqual(pathsOf(out), [['./']]);
      expectEqual(readPlan(out).parts[0].bytes, 30);
    },
  },
  {
    n: 6,
    name: 'a submodule and a symbolic link are in no part',
    files: { 'a.js': text(30) },
    extra: (dir) => {
      symlinkSync('a.js', join(dir, 'link.js'));
      git(dir, ['update-index', '--add', '--cacheinfo', `160000,${'1'.repeat(40)},vendor/sub`]);
    },
    exit: 0,
    check: (out) => {
      expectEqual(pathsOf(out), [['./']]);
      expectEqual(readPlan(out).parts[0].bytes, 30);
    },
  },
  {
    n: 7,
    name: 'a clone not at the commit is refused',
    files: { 'a.js': text(30) },
    commit: '0123456789abcdef0123456789abcdef01234567',
    exit: 2,
    includes: ['is not at'],
  },
  {
    n: 8,
    name: '--split cuts a part into two halves',
    files: { 'a.js': text(60), 'b.js': text(60) },
    args: ['--budget', '200'],
    then: (clone, out) => {
      const first = plan(clone, out, ['--budget', '200']);
      expectEqual(first.status, 0);
      expectEqual(pathsOf(out), [['./']]);
      return plan(clone, out, ['--split', 'P1']);
    },
    exit: 0,
    includes: ['Part: P1.1 60 bytes 1 paths', 'Part: P1.2 60 bytes 1 paths'],
    excludes: ['Part: P1 '],
    check: (out) => {
      const p = readPlan(out);
      expectEqual(p.parts.map((part) => part.id), ['P1.1', 'P1.2']);
      expectEqual(p.parts.map((part) => part.paths), [['a.js'], ['b.js']]);
      expectEqual(p.parts.map((part) => part.files), [[{ path: 'a.js', bytes: 60 }], [{ path: 'b.js', bytes: 60 }]]);
    },
  },
  {
    n: 9,
    name: '--split on a part that is one file is refused',
    files: { 'big.js': text(300) },
    then: (clone, out) => {
      expectEqual(plan(clone, out).status, 0);
      return plan(clone, out, ['--split', 'P1']);
    },
    exit: 1,
    includes: ['P1 is one file', 'big.js'],
  },
  {
    n: 10,
    name: 'a refresh carries a row on an unchanged file, re-pinned at the new commit',
    files: { 'a.js': text(30), 'b.js': text(30) },
    then: refresh({
      survey: (pin) => ({
        rows: [serve('http:GET:/a', [at(pin, 'a.js')]), serve('http:GET:/b', [at(pin, 'b.js')])],
        openPoints: [
          openPoint('Which host the client of a.js reaches', [at(pin, 'a.js')]),
          openPoint('Which queue the worker of b.js reads', [at(pin, 'b.js'), at(pin, 'a.js')]),
        ],
      }),
      next: { write: { 'b.js': text(40) } },
    }),
    exit: 0,
    // The counts are table rows only. Each open point goes where its row would.
    includes: ['Mode: delta (', 'Carried: 1 row(s)', 'Look again: 1 row(s)'],
    check: (out, res) => {
      const p = readPlan(out);
      expectEqual(p.mode, 'delta');
      expectEqual(p.commit, res.second.commit);
      const carried = readCarried(out);
      const parsed = parseSurvey('carried.md', carried, { part: true });
      expectEqual(parsed.findings, []);
      expectEqual(parsed.part, 'carried');
      expectEqual(parsed.commit, res.second.commit);
      expectEqual(parsed.rows.map((r) => r.key), ['http:GET:/a']);
      expectEqual(parsed.rows[0].evidence.map((e) => e.text), [`svc@${res.second.commit.slice(0, 12)}:a.js L1-1`]);
      expectEqual(parsed.openPoints.map((o) => o.evidence.map((e) => e.text)), [[`svc@${res.second.commit.slice(0, 12)}:a.js L1-1`]]);
      // The open point looked at again brings a.js into the plan, so the part is the whole root.
      expectEqual(p.parts.map((part) => part.paths), [['./']]);
      const previous = readFileSync(join(dirname(out), 'previous.md'), 'utf8').split('\n');
      const rowLine = previous.find((l) => l.startsWith('| http:GET:/b |'));
      const pointLine = previous.find((l) => l.startsWith('| Which queue the worker of b.js reads |'));
      expectEqual(p.parts[0].rows, [
        { section: '1. Serves', line: rowLine, files: ['b.js'] },
        { section: '6. Open points', line: pointLine, files: ['b.js', 'a.js'] },
      ]);
    },
  },
  {
    n: 11,
    name: 'a row with one changed file goes to the part of its first surviving evidence file, word for word',
    files: { 'a.js': text(80), 'z.js': text(80) },
    then: refresh({
      survey: (pin) => ({ rows: [serve('http:GET:/z', [at(pin, 'z.js', 1, 1), at(pin, 'a.js', 1, 1)])] }),
      next: { write: { 'z.js': text(90) } },
    }),
    exit: 0,
    includes: ['Carried: 0 row(s)', 'Look again: 1 row(s)'],
    check: (out, res) => {
      const pin = res.second.commit.slice(0, 12);
      expectEqual(pathsOf(out), [['a.js'], ['z.js']]);
      const line = readFileSync(join(dirname(out), 'previous.md'), 'utf8').split('\n').find((l) => l.startsWith('| http:GET:/z |'));
      expectEqual(rowsOf(out), { P1: [], P2: [{ section: '1. Serves', line, files: ['z.js', 'a.js'] }] });
      expectEqual(line.includes(pin), false);
      expectEqual(existsSync(join(out, 'carried.md')), false);
    },
  },
  {
    n: 12,
    name: 'a row whose only file was deleted goes to P1',
    files: { 'a.js': text(30), 'gone.js': text(30) },
    then: refresh({
      survey: (pin) => ({ rows: [serve('http:GET:/a', [at(pin, 'a.js')]), serve('http:GET:/gone', [at(pin, 'gone.js')])] }),
      next: { remove: ['gone.js'] },
    }),
    exit: 0,
    includes: ['Carried: 1 row(s)', 'Look again: 1 row(s)', 'Part: P1 0 bytes 0 paths'],
    check: (out) => {
      const p = readPlan(out);
      expectEqual(p.parts.map((part) => part.id), ['P1']);
      expectEqual(p.parts[0].files, []);
      expectEqual(p.parts[0].rows.map((r) => [r.section, r.files]), [['1. Serves', []]]);
      expectEqual(p.parts[0].rows[0].line.startsWith('| http:GET:/gone |'), true);
    },
  },
  {
    n: 13,
    name: 'a previous survey on service-survey v4 makes a full plan, and says why',
    files: { 'a.js': text(30) },
    then: refresh({
      survey: (pin) => ({ rows: [serve('http:GET:/a', [at(pin, 'a.js')])] }),
      // A v4 survey has no section 7, so the edit drops it with the version.
      edit: (t) => t.replace('template: service-survey v6', 'template: service-survey v4').replace(/\n## 7\. Not read\n[\s\S]*$/, '\n'),
      next: { write: { 'b.js': text(30) } },
    }),
    exit: 0,
    includes: ['Mode: full ('],
    excludes: ['Carried:'],
    check: (out) => {
      const p = readPlan(out);
      expectEqual(p.mode, 'full');
      expectEqual(p.reason.includes('v4'), true);
      expectEqual(pathsOf(out), [['./']]);
      expectEqual(existsSync(join(out, 'carried.md')), false);
    },
  },
  {
    n: 14,
    name: '--since a commit the clone does not hold makes a full plan, and says why',
    files: { 'a.js': text(30) },
    then: refresh({
      survey: (pin) => ({ rows: [serve('http:GET:/a', [at(pin, 'a.js')])] }),
      surveyAt: '0123456789abcdef0123456789abcdef01234567',
      next: { write: { 'b.js': text(30) } },
    }),
    exit: 0,
    includes: ['Mode: full ('],
    check: (out) => {
      const p = readPlan(out);
      expectEqual(p.mode, 'full');
      expectEqual(p.reason.includes('not in the clone'), true);
      expectEqual(existsSync(join(out, 'carried.md')), false);
    },
  },
  {
    n: 15,
    name: 'a refresh with no changed file has no part',
    files: { 'a.js': text(30), 'b.js': text(30) },
    then: refresh({
      survey: (pin) => ({ rows: [serve('http:GET:/a', [at(pin, 'a.js')]), serve('http:GET:/b', [at(pin, 'b.js')])] }),
    }),
    exit: 0,
    includes: ['Mode: delta (', 'Carried: 2 row(s)', 'Look again: 0 row(s)', 'in 0 part(s)'],
    check: (out) => {
      expectEqual(readPlan(out).parts, []);
      expectEqual(parseSurvey('carried.md', readCarried(out), { part: true }).rows.length, 2);
    },
  },
  {
    n: 16,
    name: 'two runs write the same bytes',
    files: { 'src/x.js': text(30), 'src/a/one.js': text(80), 'src/b/two.js': text(80), 'z.js': text(10) },
    then: (clone, out) => {
      const second = `${out}-again`;
      const a = plan(clone, out);
      const b = plan(clone, second);
      expectEqual(a.status, 0);
      expectEqual(b.status, 0);
      expectEqual(readFileSync(join(out, 'plan.json'), 'utf8'), readFileSync(join(second, 'plan.json'), 'utf8'));
      return a;
    },
    exit: 0,
  },
  {
    n: 17,
    name: 'a path with a space and an accent is written as git stores it',
    files: { 'src/my file é.js': text(30) },
    exit: 0,
    then: (clone, out) => {
      const res = plan(clone, out, ['--budget', '10']);
      expectEqual(readPlan(out).parts[0].paths, ['src/my file é.js']);
      return res;
    },
  },
  {
    n: 18,
    name: 'a file renamed between the commits: its row is looked at again, and the new path is in a part',
    files: { 'old.js': text(30), 'keep.js': text(30) },
    then: refresh({
      survey: (pin) => ({ rows: [serve('http:GET:/keep', [at(pin, 'keep.js')]), serve('http:GET:/moved', [at(pin, 'old.js')])] }),
      next: { rename: [['old.js', 'new.js']] },
    }),
    exit: 0,
    includes: ['Carried: 1 row(s)', 'Look again: 1 row(s)'],
    check: (out) => {
      const p = readPlan(out);
      expectEqual(p.parts.map((part) => part.paths), [['new.js']]);
      expectEqual(p.parts[0].rows.map((r) => [r.line.startsWith('| http:GET:/moved |'), r.files]), [[true, []]]);
    },
  },
  {
    n: 19,
    name: '--split P1 on a delta plan moves the row with all evidence deleted to P1.1',
    files: { 'a.js': text(60), 'b.js': text(60), 'gone.js': text(30) },
    then: refresh({
      survey: (pin) => ({ rows: [serve('http:GET:/b', [at(pin, 'b.js')]), serve('http:GET:/gone', [at(pin, 'gone.js')])] }),
      next: { remove: ['gone.js'], write: { 'a.js': text(61), 'b.js': text(61) } },
      budget: 200,
      after: (second, out) => {
        const p = readPlan(out);
        expectEqual(p.parts.map((part) => [part.id, part.paths]), [['P1', ['./']]]);
        return plan(second, out, ['--split', 'P1'], second.commit);
      },
    }),
    exit: 0,
    includes: ['Mode: delta (', 'Part: P1.1 61 bytes 1 paths', 'Part: P1.2 61 bytes 1 paths'],
    check: (out) => {
      const rows = rowsOf(out);
      expectEqual(Object.keys(rows), ['P1.1', 'P1.2']);
      expectEqual(rows['P1.1'].map((r) => [r.line.startsWith('| http:GET:/gone |'), r.files]), [[true, []]]);
      expectEqual(rows['P1.2'].map((r) => r.files), [['b.js']]);
    },
  },
  {
    n: 20,
    name: '--split of a delta part that has no file is refused, and says so',
    files: { 'a.js': text(30), 'gone.js': text(30) },
    then: refresh({
      survey: (pin) => ({ rows: [serve('http:GET:/gone', [at(pin, 'gone.js')])] }),
      next: { remove: ['gone.js'] },
      after: (second, out) => plan(second, out, ['--split', 'P1'], second.commit),
    }),
    exit: 1,
    includes: ['P1 has no file to split'],
    excludes: ['is one file'],
  },
  {
    n: 21,
    name: 'an open point on an unchanged file that names a key looked at again is looked at again too',
    files: { 'a.js': text(30), 'b.js': text(30) },
    then: refresh({
      survey: (pin) => ({
        rows: [serve('http:GET:/a', [at(pin, 'a.js')]), serve('http:GET:/b', [at(pin, 'b.js')])],
        openPoints: [
          openPoint('Who calls http:GET:/b from outside', [at(pin, 'a.js')]),
          openPoint('Who calls http:GET:/a from outside', [at(pin, 'a.js')]),
        ],
      }),
      next: { write: { 'b.js': text(40) } },
    }),
    exit: 0,
    includes: ['Carried: 1 row(s)', 'Look again: 1 row(s)'],
    check: (out) => {
      // The seat can drop the row of http:GET:/b. A carried open point that names it would then name a key no row carries.
      const carried = parseSurvey('carried.md', readCarried(out), { part: true });
      expectEqual(carried.openPoints.map((o) => o.what), ['Who calls http:GET:/a from outside']);
      const p = readPlan(out);
      expectEqual(p.parts[0].rows.map((r) => [r.section, r.line.split(' | ')[0], r.files]), [
        ['1. Serves', '| http:GET:/b', ['b.js']],
        ['6. Open points', '| Who calls http:GET:/b from outside', ['a.js']],
      ]);
    },
  },
  {
    n: 22,
    name: 'a text file that .gitattributes marks -diff or binary is in a part, and a binary file is not',
    files: {
      '.gitattributes': 'gen.txt -diff\nlock.txt binary\n',
      'gen.txt': text(30),
      'lock.txt': text(40),
      'logo.png': Buffer.from([0x89, 0x50, 0x00, 0x00, 0x01, 0x00, 0x02, ...Array(20).fill(0x02)]),
    },
    args: ['--budget', '10'],
    exit: 0,
    check: (out) => expectEqual(pathsOf(out), [['.gitattributes'], ['gen.txt'], ['lock.txt']]),
  },
  {
    n: 23,
    name: '--split with a plan.json that is not a plan cannot verify',
    files: { 'a.js': text(30), 'b.js': text(30) },
    then: (clone, out) => {
      expectEqual(plan(clone, out).status, 0);
      writeFileSync(join(out, 'plan.json'), '{ "repository": "svc", ');
      const notJson = plan(clone, out, ['--split', 'P1']);
      expectEqual([notJson.status, notJson.stderr.includes('internal error')], [2, false]);
      writeFileSync(join(out, 'plan.json'), JSON.stringify({ repository: 'svc', commit: clone.commit, parts: 'P1' }));
      return plan(clone, out, ['--split', 'P1']);
    },
    exit: 2,
    includes: ['is not one plan-survey.mjs writes'],
    excludes: ['internal error'],
  },
  {
    n: 24,
    name: 'the exclude rules and their grouping, with no clone',
    files: { 'a.txt': text(2) },
    then: () => {
      const cases = [
        ['tests/phpunit.phar', 10, 'archive', 'tests/'],
        ['lib/vendor/x/a.php', 10, 'vendored', 'lib/vendor/'],
        ['node_modules/a/i.js', 10, 'vendored', 'node_modules/'],
        ['src/tests/fixtures/a.json', 10, 'test', 'src/tests/'],
        ['Tests/Unit/A.cs', 10, 'test', 'Tests/'],
        ['src/app.test.ts', 10, 'test', 'src/'],
        ['pkg/server_test.go', 10, 'test', 'pkg/'],
        ['src/latest/a.js', 100, null, null],
        ['src/tests.php', 100, null, null],
        ['db/migration/V1__init.sql', 10, 'migration', 'db/migration/'],
        ['App/Migrations/0001.cs', 10, 'migration', 'App/Migrations/'],
        ['db/migrate/001_x.rb', 10, 'migration', 'db/migrate/'],
        ['database/seeders/A.php', 10, 'migration', 'database/seeders/'],
        ['src/main/resources/db/changelog/master.yaml', 10, 'migration', 'src/main/resources/db/changelog/'],
        ['alembic/versions/abc.py', 10, 'migration', 'alembic/versions/'],
        ['db/changelog/seed/x.sql', 10, 'migration', 'db/changelog/'],
        ['src/db/changelog/migrations/a.yaml', 10, 'migration', 'src/db/changelog/'],
        ['docs/changelog/1.md', 100, null, null],
        ['api/versions/v1.py', 100, null, null],
        ['app/translations/en.json', 10, 'locale', 'app/translations/'],
        ['data/x.SQL', 10, 'data', 'data/'],
        ['seed.sql', 10, 'data', './'],
        ['public/app.min.js', 10, 'asset', 'public/'],
        ['public/site.CSS', 10, 'asset', 'public/'],
        ['big.txt', EXCLUDE_LIMIT + 1, 'size', './'],
        ['edge.txt', EXCLUDE_LIMIT, null, null],
        ['src/app.js', 100, null, null],
        ['composer.lock', 100, 'lock', './'],
        ['web/package-lock.json', 100, 'lock', 'web/'],
        ['web/yarn.lock', 100, 'lock', 'web/'],
        ['pnpm-lock.yaml', 100, 'lock', './'],
        ['ruby/Gemfile.lock', 100, 'lock', 'ruby/'],
        ['py/poetry.lock', 100, 'lock', 'py/'],
        ['go.sum', 100, 'lock', './'],
        ['rust/Cargo.lock', 100, 'lock', 'rust/'],
        ['composer.json', 100, null, null],
        ['.github/workflows/ci.yml', 100, 'ci', '.github/'],
        ['svc/.github/dependabot.yml', 100, 'ci', 'svc/.github/'],
        ['.circleci/config.yml', 100, 'ci', '.circleci/'],
        ['.gitlab-ci.yml', 100, 'ci', './'],
        ['deploy/Jenkinsfile', 100, 'ci', 'deploy/'],
        ['src/mock/a.js', 100, 'test', 'src/mock/'],
        ['test/a.js', 100, 'test', 'test/'],
        ['spec/models/a_spec.rb', 100, 'test', 'spec/'],
        ['src/test/java/a/ATest.java', 100, 'test', 'src/test/'],
        ['svc/src/test/a.kt', 100, 'test', 'svc/src/test/'],
        ['application/modules/test/services/TestService.php', 100, null, null],
        ['app/spec/a.rb', 100, null, null],
        ['tests/application/modules/test/A.php', 100, 'test', 'tests/'],
        ['application/modules/test/a.test.js', 100, 'test', 'application/modules/test/'],
        ['checks.env', 100, 'harness', './'],
        ['.githooks/pre-commit', 100, 'harness', '.githooks/'],
        ['svc/checks.env', 100, null, null],
        ['tools/aerospike-client-stubs/stubs/Aerospike.php', 100, 'vendored', 'tools/aerospike-client-stubs/stubs/'],
        ['lib/stub/a.php', 100, 'vendored', 'lib/stub/'],
        ['mocks/b.js', 100, 'test', 'mocks/'],
        ['application/api-simulator/a.php', 100, null, null],
        ['simulator/a.php', 100, null, null],
        ['public/assets/testfile', 16, 'tiny', 'public/assets/'],
        ['public/assets/other', 17, null, null],
        ['empty.txt', 0, 'tiny', './'],
        ['requirements.txt', 15, null, null],
        ['go.mod', 9, null, null],
        ['pnpm-workspace.yaml', 14, null, null],
        ['Dockerfile', 10, null, null],
        ['tests/x', 5, 'test', 'tests/'],
        ['data/dist.json', NUMERIC_JSON_LIMIT + 1, null, null],
      ];
      for (const [path, bytes, rule, folder] of cases) {
        expectEqual([path, excludeRule(path, bytes)], [path, rule ? { rule, folder } : null]);
      }
      // The numeric flag counts only for a .json file above the limit, and only where no earlier rule matches.
      const numeric = [
        ['data/dist.json', NUMERIC_JSON_LIMIT + 1, 'data', 'data/'],
        ['data/DIST.JSON', NUMERIC_JSON_LIMIT + 1, 'data', 'data/'],
        ['data/edge.json', NUMERIC_JSON_LIMIT, null, null],
        ['data/dist.txt', NUMERIC_JSON_LIMIT + 1, null, null],
        ['data/huge.json', EXCLUDE_LIMIT + 1, 'data', 'data/'],
        ['tests/dist.json', NUMERIC_JSON_LIMIT + 1, 'test', 'tests/'],
      ];
      for (const [path, bytes, rule, folder] of numeric) {
        expectEqual([path, excludeRule(path, bytes, new Set(), only('numeric', path))], [path, rule ? { rule, folder } : null]);
      }
      // The licence flag counts only for a code file, and only where no folder rule makes it vendored.
      const licensed = [
        ['framework/helpers/MobileDetect.php', 'vendored', 'framework/helpers/'],
        ['vendor/x/a.php', 'vendored', 'vendor/'],
        ['docs/LICENSE-notes.json', null, null],
        ['src/a.ts', 'vendored', 'src/'],
      ];
      for (const [path, rule, folder] of licensed) {
        expectEqual([path, excludeRule(path, 100, new Set(), only('licensed', path))], [path, rule ? { rule, folder } : null]);
      }
      expectEqual([
        isLicensedText(' * Permission is hereby granted, free of charge, to any person'),
        isLicensedText(' * Redistribution and use in source and binary forms, with or without'),
        isLicensedText(' * Licensed under the Apache License, Version 2.0'),
        isLicensedText(' * @license    http://www.apache.org/licenses/LICENSE-2.0 Apache License'),
        isLicensedText(' * GNU Lesser General Public License'),
        isLicensedText('// SPDX-License-Identifier: MIT'),
        isLicensedText(' * @license proprietary'),
        isLicensedText(' * Copyright 2024 the service team'),
      ], [true, true, true, true, true, false, false, false]);
      // The quiet flag counts only for a page, and only where no earlier rule takes it.
      const quiet = [
        ['templates/list.tpl', 'markup', 'templates/'],
        ['public/About.HTML', 'markup', 'public/'],
        ['public/a.htm', 'markup', 'public/'],
        ['src/a.php', null, null],
        ['tests/page.html', 'test', 'tests/'],
      ];
      for (const [path, rule, folder] of quiet) {
        expectEqual([path, excludeRule(path, 100, new Set(), only('quiet', path))], [path, rule ? { rule, folder } : null]);
      }
      expectEqual([
        isQuietMarkup('<select><option>Delhi</option></select>\n<script src="https://cdn.example.com/a.js"></script>\n<a href="https://www.example.com">site</a>'),
        isQuietMarkup('<script>$.ajax({ url: "/x" });</script>'),
        isQuietMarkup('<script>fetch(api + "/orders")</script>'),
        isQuietMarkup('<script>var r = new XMLHttpRequest();</script>'),
        isQuietMarkup('<form method="post" action="{$base}/submit">'),
        isQuietMarkup('<iframe src="https://pay.example.com/widget"></iframe>'),
        isQuietMarkup('<iframe src="/local/frame"></iframe>'),
        isQuietMarkup('<script>const s = new WebSocket(url);</script>'),
        isQuietMarkup('<script>$("#box").load("/fragment")</script>'),
      ], [true, false, false, false, false, false, true, false, false]);
      const share = (hits, total) => `${'1'.repeat(hits)}${'a'.repeat(total - hits)}`;
      expectEqual([isNumericText(share(80, 100)), isNumericText(share(79, 100)), isNumericText(share(13108, 16385)), isNumericText(share(13107, 16385))], [true, false, true, false]);
      expectEqual(isNumericText('{"name": "svc", "port": 8080}\n'), false);
      expectEqual(isNumericText('[[0.5, -1.25],\n [32, 4]]\t\r '), true);
      expectEqual(numericCandidates([
        { path: 'data/a.json', bytes: NUMERIC_JSON_LIMIT + 1 },
        { path: 'data/b.json', bytes: NUMERIC_JSON_LIMIT },
        { path: 'tests/c.json', bytes: NUMERIC_JSON_LIMIT + 1 },
        { path: 'data/d.csv', bytes: NUMERIC_JSON_LIMIT + 1 },
        { path: 'e.json', bytes: EXCLUDE_LIMIT + 1 },
      ]), ['data/a.json', 'e.json']);
      expectEqual([...EXCLUDE_RULES], ['archive', 'vendored', 'test', 'migration', 'locale', 'ci', 'harness', 'lock', 'data', 'asset', 'markup', 'tiny', 'size']);
      expectEqual(notReadRows([
        { path: 'tests/a.php', bytes: 10 },
        { path: 'tests/b/c.php', bytes: 5 },
        { path: 'public/a.css', bytes: 3 },
        { path: 'public/b.css', bytes: 4 },
        { path: 'public/c.js', bytes: 20 },
      ]), [
        { rule: 'asset', folder: 'public/', files: 2, bytes: 7 },
        { rule: 'test', folder: 'tests/', files: 2, bytes: 15 },
      ]);
      const tree = [
        'LICENSE', 'src/app.js',
        'framework/library/smarty-3.1.16/COPYING.lib', 'framework/library/smarty-3.1.16/libs/Smarty.class.php',
        'framework/library/phpmailer/LICENSE', 'framework/library/phpmailer/class.smtp.php',
        'application/library/Helper.php',
        'application/modules/licence/license.php',
        'vendor/acme/LICENSE.md', 'vendor/acme/a.php',
        'a/LICENSE', 'a/b/LICENSE-MIT.txt', 'a/b/c.js',
        'tests/fixtures/pkg/COPYING.LESSER', 'tests/fixtures/pkg/x.js', 'tests/a.php',
      ].map((path) => ({ path, bytes: 100 }));
      const roots = packageRoots(tree);
      expectEqual([...roots].sort(), ['a/', 'a/b/', 'framework/library/phpmailer/', 'framework/library/smarty-3.1.16/', 'tests/fixtures/pkg/', 'vendor/acme/']);
      const withRoots = [
        ['framework/library/smarty-3.1.16/libs/Smarty.class.php', 'vendored', 'framework/library/smarty-3.1.16/'],
        ['framework/library/phpmailer/class.smtp.php', 'vendored', 'framework/library/phpmailer/'],
        ['application/library/Helper.php', null, null],
        ['application/modules/licence/license.php', null, null],
        ['LICENSE', null, null],
        ['src/app.js', null, null],
        ['vendor/acme/a.php', 'vendored', 'vendor/'],
        ['a/b/c.js', 'vendored', 'a/'],
        ['tests/fixtures/pkg/x.js', 'vendored', 'tests/fixtures/pkg/'],
        ['tests/a.php', 'test', 'tests/'],
      ];
      for (const [path, rule, folder] of withRoots) {
        expectEqual([path, excludeRule(path, 100, roots)], [path, rule ? { rule, folder } : null]);
      }
      // The join passes only the excluded files. The rows must equal the rows of the full list.
      const full = notReadRows(tree);
      expectEqual(notReadRows(tree.filter(({ path }) => excludeRule(path, 100, roots))), full);
      expectEqual(full.filter((r) => r.rule === 'vendored').map((r) => [r.folder, r.files]), [
        ['a/', 3], ['framework/library/phpmailer/', 2], ['framework/library/smarty-3.1.16/', 2], ['tests/fixtures/pkg/', 2], ['vendor/', 2],
      ]);
      expectEqual([...packageRoots(['x/LICENCE', 'y/Copying', 'z/LICENSE.php', 'w/LICENSES/a.txt', 'v/license-apache'].map((path) => ({ path, bytes: 10 })))].sort(), ['v/', 'x/', 'y/']);
      const rec = (mode, type, size, path) => `${mode} ${type} ${'a'.repeat(40)} ${size.padStart(7)}\t${path}\0`;
      expectEqual(parseLsTree([
        rec('100644', 'blob', '12', 'z.txt'),
        rec('160000', 'commit', '-', 'sub'),
        rec('120000', 'blob', '4', 'link'),
        rec('100755', 'blob', '1234567', 'dir/with space.sh'),
        rec('100644', 'blob', '0', 'B.txt'),
      ].join('')), [
        { path: 'B.txt', bytes: 0 },
        { path: 'dir/with space.sh', bytes: 1234567 },
        { path: 'z.txt', bytes: 12 },
      ]);
      expectEqual(parseLsTree(''), []);
      // A symbolic link named LICENSE is not a licence document: parseLsTree drops it.
      expectEqual(notReadRows(parseLsTree([rec('120000', 'blob', '7', 'pkg/LICENSE'), rec('100644', 'blob', '90', 'pkg/a.js')].join(''))), []);
      return { status: 0, stdout: '', stderr: '' };
    },
    exit: 0,
  },
  {
    n: 25,
    name: 'every rule leaves its file out of the parts and lists it as excluded',
    files: {
      'src/app.js': text(30),
      'pkg/a.zip': text(10),
      'vendor/a.js': text(10),
      'tests/a.php': text(10),
      'db/migration/V1.sql': text(10),
      'lang/en.json': text(10),
      'data/x.csv': text(10),
      'public/a.css': text(10),
      'big.txt': text(EXCLUDE_LIMIT + 1),
      '.github/workflows/ci.yml': text(40),
      'composer.lock': text(40),
      'data/dist.json': digits(NUMERIC_JSON_LIMIT + 1, NUMERIC_JSON_LIMIT + 1),
      'public/assets/testfile': text(10),
      'checks.env': text(20),
      'lib/Detect.php': `<?php\n/**\n * @license Code and contributions have 'MIT License'\n */\nclass Detect {}\n`,
      'lib/Own.php': `<?php\n// SPDX-License-Identifier: MIT\nclass Own {}\n`,
      'web/list.tpl': '<select>\n<option>Delhi</option>\n</select>\n',
      'web/form.tpl': '<form method="post" action="https://pay.example.com/charge">\n</form>\n',
    },
    exit: 0,
    includes: ['Excluded: 15 file(s), ', 'PLANNED: svc@'],
    check: (out) => {
      expectEqual(pathsOf(out), [['lib/Own.php', 'src/'], ['web/form.tpl']]);
      expectEqual(readPlan(out).excluded.map((e) => [e.path, e.rule]), [
        ['.github/workflows/ci.yml', 'ci'],
        ['big.txt', 'size'],
        ['checks.env', 'harness'],
        ['composer.lock', 'lock'],
        ['data/dist.json', 'data'],
        ['data/x.csv', 'data'],
        ['db/migration/V1.sql', 'migration'],
        ['lang/en.json', 'locale'],
        ['lib/Detect.php', 'vendored'],
        ['pkg/a.zip', 'archive'],
        ['public/a.css', 'asset'],
        ['public/assets/testfile', 'tiny'],
        ['tests/a.php', 'test'],
        ['vendor/a.js', 'vendored'],
        ['web/list.tpl', 'markup'],
      ]);
      expectEqual(readPlan(out).excluded.find((e) => e.path === 'tests/a.php').bytes, 10);
    },
  },
  {
    n: 26,
    name: 'a repository whose files are all excluded has no part',
    files: { 'tests/a.php': text(10), 'docs/x.sql': text(10) },
    exit: 0,
    includes: ['Excluded: 2 file(s), 20 bytes', 'in 0 part(s)', 'PLANNED: svc@'],
    check: (out) => {
      const p = readPlan(out);
      expectEqual(p.parts, []);
      expectEqual(p.excluded.map((e) => e.path), ['docs/x.sql', 'tests/a.php']);
    },
  },
  {
    n: 27,
    name: 'a delta plan has no part for a changed excluded file, and lists every excluded file at the new commit',
    files: { 'src/app.js': text(30), 'tests/a.php': text(10) },
    then: refresh({
      survey: () => ({ rows: [] }),
      next: { write: { 'tests/a.php': text(20), 'src/app.js': text(40), 'tests/b.php': text(5) } },
    }),
    exit: 0,
    includes: ['Mode: delta (', 'Excluded: 2 file(s), 25 bytes'],
    check: (out) => {
      expectEqual(pathsOf(out), [['src/']]);
      expectEqual(readPlan(out).excluded.map((e) => [e.path, e.bytes]), [['tests/a.php', 20], ['tests/b.php', 5]]);
    },
  },
  {
    n: 28,
    name: 'a row whose only evidence file is an excluded file that changed goes to P1',
    files: { 'src/app.js': text(30), 'tests/a.php': text(10) },
    then: refresh({
      survey: (pin) => ({ rows: [serve('http:GET:/t', [at(pin, 'tests/a.php')])] }),
      next: { write: { 'tests/a.php': text(20) } },
    }),
    exit: 0,
    includes: ['Look again: 1 row(s)', 'Part: P1 0 bytes 0 paths'],
    check: (out) => {
      const p = readPlan(out);
      expectEqual(p.parts.map((part) => part.id), ['P1']);
      expectEqual(p.parts[0].rows.map((r) => [r.section, r.files]), [['1. Serves', []]]);
    },
  },
  {
    n: 29,
    name: 'a binary file that no rule matches is dropped with no record, and one that a rule matches is excluded',
    files: {
      'src/app.js': text(30),
      'logo.png': Buffer.from([0x89, 0x50, 0x00, 0x00, 0x01, ...Array(20).fill(0x02)]),
      'lib.jar': Buffer.from([0x50, 0x4b, 0x00, 0x00, 0x03]),
    },
    exit: 0,
    includes: ['Excluded: 1 file(s), 5 bytes'],
    check: (out) => {
      expectEqual(pathsOf(out), [['src/']]);
      expectEqual(readPlan(out).excluded, [{ path: 'lib.jar', bytes: 5, rule: 'archive' }]);
    },
  },
  {
    n: 30,
    name: '--split keeps the excluded list as it was',
    files: { 'a.js': text(60), 'b.js': text(60), 'tests/a.php': text(10) },
    then: (clone, out) => {
      expectEqual(plan(clone, out).status, 0);
      const before = readPlan(out).excluded;
      const res = plan(clone, out, ['--split', 'P1']);
      expectEqual(readPlan(out).excluded, before);
      expectEqual(before.map((e) => e.path), ['tests/a.php']);
      return res;
    },
    exit: 0,
    includes: ['Excluded: 1 file(s), 10 bytes'],
  },
  {
    n: 31,
    name: 'a folder name that no survey table can hold is refused with exit 2 and the folder name',
    files: { 'src/app.js': text(30), 'Foo<T>/tests/a.php': text(10) },
    exit: 2,
    includes: ['Foo<T>/'],
    excludes: ['internal error'],
  },
  {
    n: 32,
    name: 'a folder that holds a licence document is a vendored package, and its sibling folder of own code is planned',
    files: {
      'LICENSE': text(20),
      'framework/library/smarty/COPYING.lib': text(10),
      'framework/library/smarty/Smarty.class.php': text(30),
      'framework/http/Request.php': text(30),
      'application/library/Helper.php': text(30),
      'application/modules/licence/license.php': text(30),
    },
    exit: 0,
    includes: ['Package: framework/library/smarty/ (COPYING.lib)\nExcluded: 2 file(s), ', 'PLANNED: svc@'],
    excludes: ['Package: application/'],
    check: (out) => {
      expectEqual(readPlan(out).excluded.map((e) => [e.path, e.rule]), [
        ['framework/library/smarty/COPYING.lib', 'vendored'],
        ['framework/library/smarty/Smarty.class.php', 'vendored'],
      ]);
      const planned = pathsOf(out).flat();
      expectEqual(planned.some((p) => p.startsWith('framework/library')), false);
    },
  },
  {
    n: 33,
    name: 'the plan lists the manifests of the root, a workspace and a build file, and the dependency lists it leaves out',
    files: {
      'package.json': `${JSON.stringify({ name: 'svc', workspaces: ['packages/*'] })}\n`,
      'packages/web/package.json': '{}\n',
      'tools/gen/package.json': '{}\n',
      'ml/serve_requirements.txt': 'numpy==1.26.0\n',
      'ml/train_requirements.txt': 'torch==2.3.0\n',
      'ml/Dockerfile': 'FROM python:3.12\nRUN pip install -r serve_requirements.txt\n',
      'src/app.js': text(30),
    },
    exit: 0,
    includes: [
      'Manifest: ml/serve_requirements.txt (named by ml/Dockerfile)\nManifest: package.json (top-level)\nManifest: packages/web/package.json (workspace package.json)\n',
      'Not a manifest: ml/train_requirements.txt (no build file names it)\nNot a manifest: tools/gen/package.json (below package.json)\nExcluded: ',
    ],
    check: (out) => {
      const p = readPlan(out);
      expectEqual(p.manifests.map((m) => m.path), ['ml/serve_requirements.txt', 'package.json', 'packages/web/package.json']);
      expectEqual(p.notManifests.map((m) => [m.path, m.why]), [['ml/train_requirements.txt', 'no build file names it'], ['tools/gen/package.json', 'below package.json']]);
    },
  },
  {
    n: 34,
    name: 'a refresh looks again at a library row on a file that is not a manifest, though the file did not change',
    files: { 'package.json': '{}\n', 'ml/det_requirements.txt': 'numpy==1.26.0\n', 'src/app.js': text(30) },
    then: refresh({
      survey: (pin) => ({
        rows: [
          { table: 'third_party', key: 'lib:express', version: '^4.19.2', evidence: [at(pin, 'package.json')] },
          { table: 'third_party', key: 'lib:numpy', version: '==1.26.0', evidence: [at(pin, 'ml/det_requirements.txt')] },
        ],
      }),
      next: { write: { 'src/app.js': text(40) } },
    }),
    exit: 0,
    includes: ['Carried: 1 row(s)', 'Look again: 1 row(s)', 'Not a manifest: ml/det_requirements.txt (no build file names it)'],
    check: (out) => {
      expectEqual(parseSurvey('carried.md', readCarried(out), { part: true }).rows.map((r) => r.key), ['lib:express']);
      const look = readPlan(out).parts.flatMap((part) => part.rows);
      expectEqual(look.map((r) => [r.section, r.files]), [['5. Third-party libraries', ['ml/det_requirements.txt']]]);
    },
  },
  {
    n: 35,
    name: 'each part lists its files with their bytes, sorted by path, with no excluded or binary file',
    files: {
      'z.js': text(80),
      'src/a.js': text(30),
      'src/b/c.js': text(30),
      'src/tests/x.php': text(10),
      'src/logo.png': Buffer.from([0x89, 0x50, 0x00, 0x00, 0x01, 0x00, 0x02, ...Array(20).fill(0x02)]),
    },
    exit: 0,
    includes: ['Part: P1 80 bytes 1 paths', 'Part: P2 60 bytes 2 paths'],
    check: (out) => {
      const p = readPlan(out);
      // paths keeps folders, and files names every file that the folders hold.
      expectEqual(p.parts.map((part) => [part.id, part.paths, part.files]), [
        ['P1', ['z.js'], [{ path: 'z.js', bytes: 80 }]],
        ['P2', ['src/a.js', 'src/b/'], [{ path: 'src/a.js', bytes: 30 }, { path: 'src/b/c.js', bytes: 30 }]],
      ]);
      expectEqual(p.excluded.map((e) => e.path), ['src/tests/x.php']);
    },
  },
  {
    n: 36,
    name: 'a delta part lists only the files it plans, though its folder holds more',
    files: { 'src/a.js': text(30), 'src/b.js': text(30), 'src/c.js': text(30) },
    then: refresh({
      survey: (pin) => ({ rows: [serve('http:GET:/c', [at(pin, 'src/c.js')])] }),
      next: { write: { 'src/a.js': text(40) } },
    }),
    exit: 0,
    includes: ['Mode: delta (', 'Carried: 1 row(s)', 'Part: P1 40 bytes 1 paths'],
    check: (out) => {
      expectEqual(readPlan(out).parts.map((part) => [part.paths, part.files]), [[['src/a.js'], [{ path: 'src/a.js', bytes: 40 }]]]);
    },
  },
  {
    n: 37,
    name: '--split gives each half its files, and fills the files of a plan written before the list',
    files: { 'a/x.js': text(60), 'a/y.js': text(30), 'b/z.js': text(80) },
    then: (clone, out) => {
      expectEqual(plan(clone, out, ['--budget', '100']).status, 0);
      const old = readPlan(out);
      expectEqual(old.parts.map((part) => part.paths), [['a/'], ['b/']]);
      for (const part of old.parts) delete part.files;
      writeFileSync(join(out, 'plan.json'), `${JSON.stringify(old, null, 2)}\n`);
      return plan(clone, out, ['--split', 'P1']);
    },
    exit: 0,
    includes: ['Part: P1.1 60 bytes 1 paths', 'Part: P1.2 30 bytes 1 paths', 'Part: P2 80 bytes 1 paths'],
    check: (out) => {
      expectEqual(readPlan(out).parts.map((part) => [part.id, part.files]), [
        ['P1.1', [{ path: 'a/x.js', bytes: 60 }]],
        ['P1.2', [{ path: 'a/y.js', bytes: 30 }]],
        ['P2', [{ path: 'b/z.js', bytes: 80 }]],
      ]);
    },
  },
  {
    n: 38,
    name: 'a file above the budget prints a Large file line after the Part lines, and a file of exactly the budget does not',
    files: { 'edge.js': text(100), 'big.js': text(101), 'a-big.js': text(150) },
    exit: 0,
    includes: ['Part: P3 100 bytes 1 paths\nLarge file: a-big.js 150 bytes (P1)\nLarge file: big.js 101 bytes (P2)\nExcluded: '],
    excludes: ['Large file: edge.js'],
    check: (out) => {
      // The line changes nothing: each large file is still a part, and still dispatched.
      expectEqual(readPlan(out).parts.map((part) => [part.id, part.paths]), [['P1', ['a-big.js']], ['P2', ['big.js']], ['P3', ['edge.js']]]);
    },
  },
  {
    n: 39,
    name: 'a JSON file above 16384 bytes whose characters are all numeric is excluded under data',
    files: { 'src/app.js': text(30), 'data/dist.json': digits(NUMERIC_JSON_LIMIT + 1, NUMERIC_JSON_LIMIT + 1) },
    exit: 0,
    includes: [`Excluded: 1 file(s), ${NUMERIC_JSON_LIMIT + 1} bytes`, 'in 1 part(s)'],
    check: (out) => {
      expectEqual(pathsOf(out), [['src/']]);
      expectEqual(readPlan(out).excluded, [{ path: 'data/dist.json', bytes: NUMERIC_JSON_LIMIT + 1, rule: 'data' }]);
    },
  },
  {
    n: 40,
    name: 'a numeric JSON file of exactly 16384 bytes stays in the plan',
    files: { 'src/app.js': text(30), 'data/dist.json': digits(NUMERIC_JSON_LIMIT, NUMERIC_JSON_LIMIT) },
    exit: 0,
    includes: ['Excluded: 0 file(s), 0 bytes', `Large file: data/dist.json ${NUMERIC_JSON_LIMIT} bytes (P1)`],
    check: (out) => {
      expectEqual(readPlan(out).excluded, []);
      expectEqual(readPlan(out).parts.flatMap((p) => p.files.map((f) => f.path)), ['data/dist.json', 'src/app.js']);
    },
  },
  {
    n: 41,
    name: 'a JSON configuration file above 16384 bytes that is mostly text stays in the plan',
    files: { 'src/app.js': text(30), 'data/dist.json': `${JSON.stringify({ name: 'svc', note: 'a'.repeat(NUMERIC_JSON_LIMIT - 24) })}\n` },
    exit: 0,
    includes: ['Excluded: 0 file(s), 0 bytes'],
    check: (out) => {
      expectEqual(readPlan(out).excluded, []);
      expectEqual(readPlan(out).parts.flatMap((p) => p.files).find((f) => f.path === 'data/dist.json'), { path: 'data/dist.json', bytes: NUMERIC_JSON_LIMIT + 1 });
    },
  },
  {
    n: 42,
    name: 'a JSON file at exactly 80% numeric characters is excluded, and one just below 80% stays in',
    files: {
      'src/app.js': text(30),
      // 13108 of 16385 is the smallest count of at least 80%: 13108 * 5 = 65540 = 16385 * 4.
      'data/at.json': digits(NUMERIC_JSON_LIMIT + 1, 13108),
      'data/below.json': digits(NUMERIC_JSON_LIMIT + 1, 13107),
    },
    exit: 0,
    includes: [`Excluded: 1 file(s), ${NUMERIC_JSON_LIMIT + 1} bytes`],
    check: (out) => {
      expectEqual(readPlan(out).excluded.map((e) => [e.path, e.rule]), [['data/at.json', 'data']]);
      expectEqual(readPlan(out).parts.flatMap((p) => p.files.map((f) => f.path)), ['data/below.json', 'src/app.js']);
    },
  },
  {
    n: 43,
    name: 'a JSON blob above the limit that git cannot read as a blob is exit 2',
    files: { 'src/app.js': text(30), 'data/dist.json': digits(NUMERIC_JSON_LIMIT + 1, NUMERIC_JSON_LIMIT + 1) },
    then: (clone, out) => {
      // The object keeps its name and its size, but git reads it as a tree. A missing object never
      // reaches the rule, because git ls-tree then gives no size for it.
      const sha = git(clone.dir, ['rev-parse', `${clone.commit}:data/dist.json`]).trim();
      const file = join(clone.dir, '.git', 'objects', sha.slice(0, 2), sha.slice(2));
      chmodSync(file, 0o644);
      writeFileSync(file, deflateSync(Buffer.concat([Buffer.from(`tree ${NUMERIC_JSON_LIMIT + 1}\0`), Buffer.alloc(NUMERIC_JSON_LIMIT + 1, 0x31)])));
      return plan(clone, out, ['--budget', '100']);
    },
    exit: 2,
    includes: ['cannot read the files whose content a rule reads', 'git cannot read the blob of data/dist.json'],
    excludes: ['internal error', 'PLANNED:'],
  },
  {
    n: 44,
    name: 'a requirements file that only a CI workflow names is still a manifest, and the workflow is excluded under ci',
    files: {
      'src/app.js': text(30),
      'ml/serve_requirements.txt': 'numpy==1.26.0\n',
      '.github/workflows/ci.yml': 'jobs:\n  test:\n    steps:\n      - run: pip install -r ml/serve_requirements.txt\n',
    },
    exit: 0,
    includes: ['Manifest: ml/serve_requirements.txt (named by .github/workflows/ci.yml)\n'],
    excludes: ['Not a manifest: ml/serve_requirements.txt'],
    check: (out) => {
      const p = readPlan(out);
      expectEqual(p.excluded.map((e) => [e.path, e.rule]), [['.github/workflows/ci.yml', 'ci']]);
      expectEqual(p.manifests, [{ path: 'ml/serve_requirements.txt', why: 'named by .github/workflows/ci.yml' }]);
    },
  },
  {
    n: 45,
    name: 'a manifest of 16 bytes or less is planned and listed, and another file of that size is excluded under tiny',
    files: {
      'src/app.js': text(30),
      'requirements.txt': 'flask\nrequests\n',
      'src/stub.txt': text(16),
      'src/edge.txt': text(17),
    },
    exit: 0,
    includes: ['Manifest: requirements.txt (top-level)\n', 'Excluded: 1 file(s), 16 bytes'],
    check: (out) => {
      const p = readPlan(out);
      expectEqual(p.excluded, [{ path: 'src/stub.txt', bytes: 16, rule: 'tiny' }]);
      expectEqual(p.parts.flatMap((part) => part.files.map((f) => f.path)), ['requirements.txt', 'src/app.js', 'src/edge.txt']);
    },
  },
  {
    n: 46,
    name: 'a part of a cut folder holds files of that folder only, and a small piece fills an earlier part of the same folder',
    // A pack in path order alone gives [base/], [h1.js], [h2.js, http/, tools/]: one part with three modules.
    files: {
      'framework/base/b.js': text(60),
      'framework/helpers/h1.js': text(60),
      'framework/helpers/h2.js': text(60),
      'framework/http/x.js': text(30),
      'tools/a/t.js': text(20),
      'tools/b/u.js': text(20),
    },
    exit: 0,
    includes: ['Part: P1 90 bytes 2 paths', 'Part: P4 40 bytes 1 paths'],
    check: (out) => expectEqual(pathsOf(out), [
      ['framework/base/', 'framework/http/'],
      ['framework/helpers/h1.js'],
      ['framework/helpers/h2.js'],
      ['tools/'],
    ]),
  },
  {
    n: 47,
    name: 'the child folders that fit share a part, and a cut child folder keeps its parts to itself',
    files: {
      'src/a/one.js': text(40),
      'src/big/p.js': text(70),
      'src/big/q.js': text(70),
      'src/c/two.js': text(40),
    },
    exit: 0,
    check: (out) => expectEqual(pathsOf(out), [['src/a/', 'src/c/'], ['src/big/p.js'], ['src/big/q.js']]),
  },
  {
    n: 48,
    name: 'the fact-file rule reads the path only, and the budget takes the files by kind, then by path',
    files: { 'a.txt': text(20) },
    then: () => {
      const cases = [
        ['application/configuration/database.ini.template', 'config'],
        ['application/configuration/main-config.php', 'config'],
        ['src/main/resources/application-prod.yml', 'config'],
        ['appsettings.Development.json', 'config'],
        ['config.php', 'config'],
        ['db.ini', 'config'],
        ['docker-compose.override.yml', 'config'],
        ['compose.yaml', 'config'],
        ['config/settings.py', 'config'],
        ['.env', null],
        ['.env.example', null],
        ['config/.env.production', null],
        ['application/constants/AmcatConstants.php', 'constants'],
        ['src/constants/index.ts', 'constants'],
        ['framework/base/Router.php', 'routes'],
        ['app/routes/users.js', 'routes'],
        ['project/urls.py', 'routes'],
        ['application/helpers/ApiHelper.php', 'http'],
        ['src/http_client.go', 'http'],
        ['src/rest-client.ts', 'http'],
        ['README.md', 'docs'],
        ['INSTALL.md', 'docs'],
        ['docs/README.md', null],
        ['src/app.js', null],
        ['src/configure.js', null],
      ];
      for (const [path, kind] of cases) expectEqual([path, factKind(path)], [path, kind]);
      expectEqual([...FACT_KINDS], ['config', 'routes', 'http', 'constants', 'docs']);
      // The budget is 100. The config file and the router fit, and the constants file no longer does.
      expectEqual(factFiles([
        { path: 'README.md', bytes: 10 },
        { path: 'b/Router.php', bytes: 30 },
        { path: 'c/Constants.php', bytes: 40 },
        { path: 'z/config.php', bytes: 50 },
        { path: 'src/app.js', bytes: 5 },
      ], 100), {
        facts: [{ path: 'README.md', bytes: 10, kind: 'docs' }, { path: 'b/Router.php', bytes: 30, kind: 'routes' }, { path: 'z/config.php', bytes: 50, kind: 'config' }],
        left: [{ path: 'c/Constants.php', bytes: 40, kind: 'constants' }],
      });
      return { status: 0, stdout: '', stderr: '' };
    },
    exit: 0,
  },
  {
    n: 49,
    name: 'a plan of two parts lists its fact files, and leaves out an excluded file and a file over the budget',
    files: {
      'README.md': text(20),
      'config/app.ini': text(30),
      'config/big.ini': text(90),
      'src/a.js': text(80),
      'src/b.js': text(80),
      'tests/config.php': text(20),
    },
    exit: 0,
    includes: [
      'Excluded: 1 file(s), 20 bytes\nFact file: README.md (docs)\nFact file: config/app.ini (config)\nFact file left out: config/big.ini (config, 90 bytes, over the budget)\nFacts: 2 file(s), 50 bytes\nPLANNED: ',
    ],
    check: (out) => {
      const p = readPlan(out);
      expectEqual(p.facts, [{ path: 'README.md', bytes: 20, kind: 'docs' }, { path: 'config/app.ini', bytes: 30, kind: 'config' }]);
      expectEqual(p.factsLeft, [{ path: 'config/big.ini', bytes: 90, kind: 'config' }]);
    },
  },
  {
    n: 50,
    name: 'a plan of one part has no fact sheet, and a split keeps the fact files of the plan',
    files: { 'README.md': text(20), 'config.php': text(30), 'src/a.js': text(40) },
    args: ['--budget', '200'],
    then: (clone, out) => {
      const first = plan(clone, out, ['--budget', '200']);
      expectEqual(first.status, 0);
      expectEqual(first.stdout.includes('Facts: none (the plan has 1 part(s))\n'), true);
      expectEqual(readPlan(out).facts, []);
      const again = plan(clone, out, ['--budget', '60']);
      expectEqual(again.status, 0);
      expectEqual(readPlan(out).facts.map((f) => f.path), ['README.md', 'config.php']);
      return plan(clone, out, ['--split', 'P1']);
    },
    exit: 0,
    includes: ['Fact file: README.md (docs)\nFact file: config.php (config)\nFacts: 2 file(s), 50 bytes\n'],
  },
  {
    n: 51,
    name: '--check-facts passes a fact sheet whose pointers are true at the commit, and writes nothing',
    files: SHEET_FILES,
    then: checkSheet(),
    exit: 0,
    includes: ['FACTS OK: 3 row(s)\n'],
    excludes: ['Mode:', 'PLANNED:'],
    check: (out) => expectEqual(existsSync(join(out, 'plan.json')), false),
  },
  {
    n: 52,
    name: '--check-facts lists every finding of a fact sheet: the form, a name twice, a secret and each false pointer',
    files: SHEET_FILES,
    then: checkSheet((t) => t
      .replace('| `store:mysql:orders` | MySQL, the orders database |', '| `store:MySQL:orders` | MySQL, the orders database |')
      .replace('| `db.host` | host |', '| `db.host` | hostname |')
      .replace(/\| `db\.host` .*\n/, (row) => `${row}${row.replace('hostname', 'host')}| \`db.pass\` | database | password=hunter2secret9 | ${row.split('| ').pop()}`)
      .replace('src/Router.php L2-3', 'src/Router.php L2-9')
      .replace('None found.', '| Helper | Method | Evidence |\n|---|---|---|\n| `ApiHelper::send` | the second argument | svc@' + 'x'.repeat(12) + ':src/ApiHelper.php L1-1 |')),
    exit: 1,
    includes: [
      '"store:MySQL:orders" is not a store key',
      'row holds "hostname". Holds is one of',
      'names "db.host" twice, also at L',
      'looks like a password or key assignment',
      'the range ends at line 9; src/Router.php has 3 line(s)',
      'is not a pointer <ID>@<12-hex>:<path> L<a>-<b>',
      'FACTS FINDINGS: ',
    ],
  },
  {
    n: 53,
    name: '--check-facts refuses a pointer to a file that is not at the commit, a folder, and a sheet of another commit',
    files: SHEET_FILES,
    then: checkSheet((t) => t
      .replace('config/db.ini L1-2', 'config/missing.ini L1-2')
      .replace('config/db.ini L1-1', 'config L1-1')
      .replace(/^commit: .*$/m, `commit: ${'0'.repeat(40)}`)),
    exit: 1,
    includes: ['the sheet is at 000000000000, not at', 'is pinned at', 'config/missing.ini is not in svc at', 'config is a folder, not a file'],
  },
  {
    n: 54,
    name: '--check-facts with no fact sheet cannot verify, and --check-facts with --split is usage',
    files: SHEET_FILES,
    then: (clone, out) => {
      const usageRun = plan(clone, out, ['--check-facts', '--split', 'P1']);
      expectEqual(usageRun.status, 3);
      return plan(clone, out, ['--check-facts']);
    },
    exit: 2,
    includes: ['facts.md is missing'],
  },
  {
    n: 55,
    name: '--check-facts passes a store named only by a property in braces, and a replica as a store of its own',
    files: SHEET_FILES,
    then: checkSheet((t) => t.replace(/^\| `store:mysql:orders` .*$/m, (row) => [
      row,
      row.replace('store:mysql:orders', 'store:mysql:orders_replica').replace('the orders database', 'the read replica of orders'),
      row.replace('store:mysql:orders', 'store:s3:{storage.bucket.name}').replace('MySQL, the orders database', 'S3, the bucket a property names'),
    ].join('\n'))),
    exit: 0,
    includes: ['FACTS OK: 5 row(s)\n'],
  },
  {
    n: 56,
    name: '--facts-for keeps the stores and routes whole, and each property and helper row that the part names or points into',
    files: { ...SHEET_FILES, 'a/Orders.php': '<?php $h = cfg("db.host");\n', 'b/Mail.php': '<?php MailClient::send($to);\n' },
    then: (clone, out) => {
      expectEqual(plan(clone, out, ['--budget', '40']).status, 0);
      const partOf = (path) => readPlan(out).parts.find((part) => part.files.some((f) => f.path === path)).id;
      const [a, b] = [partOf('a/Orders.php'), partOf('b/Mail.php')];
      const pin = clone.commit.slice(0, 12);
      writeFileSync(join(out, 'facts.md'), factSheet(clone.commit, (t) => t
        .replace(/^(\| `db\.host` .*)$/m, `$1\n| \`mail.endpoint_url\` | base address | none in the repository | svc@${pin}:config/db.ini L2-2 |`)
        .replace(/## HTTP helpers\n\nNone found\./, `## HTTP helpers\n\n| Helper | Method | Evidence |\n|---|---|---|\n| \`MailClient::send\` | POST | svc@${pin}:b/Mail.php L1-1 |`)));
      expectEqual(plan(clone, out, ['--check-facts']).stdout, 'FACTS OK: 5 row(s)\n');
      const forA = plan(clone, out, ['--facts-for', a]);
      expectEqual([forA.status, forA.stdout], [0, `FACTS FOR: ${a} 1 of 3 property and helper row(s)\n`]);
      const sheetA = readFileSync(join(out, `facts.${a}.md`), 'utf8');
      expectEqual([sheetA.includes('`db.host`'), sheetA.includes('mail.endpoint_url'), sheetA.includes('MailClient'), sheetA.includes('store:mysql:orders'), sheetA.includes('/{module}/{action}')], [true, false, false, true, true]);
      expectEqual(sheetA.includes('## HTTP helpers\n\nNone found.'), true);
      expectEqual(plan(clone, out, ['--facts-for', 'P99']).status, 2);
      return plan(clone, out, ['--facts-for', b]);
    },
    exit: 0,
    includes: ['1 of 3 property and helper row(s)'],
    check: (out) => {
      const id = readPlan(out).parts.find((part) => part.files.some((f) => f.path === 'b/Mail.php')).id;
      const sheet = readFileSync(join(out, `facts.${id}.md`), 'utf8');
      expectEqual([sheet.includes('`db.host`'), sheet.includes('MailClient'), sheet.includes('## Configuration properties\n\nNone found.')], [false, true, true]);
    },
  },
];

/* ---------------------------------------------------------------------- runner */

function expectEqual(actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`expected ${e}, got ${a}`);
}

/**
 * Every plan a fixture writes: each part lists its files, sorted by path, with
 * no excluded file, and the bytes of the part are the sum of the bytes of its files.
 */
function checkFiles(p) {
  const excluded = new Set((p.excluded || []).map((e) => e.path));
  for (const part of p.parts) {
    if (!Array.isArray(part.files)) throw new Error(`${part.id} has no files list`);
    const paths = part.files.map((f) => f.path);
    expectEqual([part.id, paths], [part.id, [...paths].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))]);
    expectEqual([part.id, part.bytes], [part.id, part.files.reduce((sum, f) => sum + f.bytes, 0)]);
    expectEqual([part.id, paths.filter((path) => excluded.has(path))], [part.id, []]);
  }
}

function runFixture(fixture) {
  const root = mkdtempSync(join(tmpdir(), `plan-survey-fx${String(fixture.n).padStart(2, '0')}-`));
  try {
    const clone = makeClone(root, fixture.files, { extra: fixture.extra });
    const out = join(root, 'clone.parts');
    const res = fixture.then
      ? fixture.then(clone, out)
      : plan(clone, out, fixture.args || ['--budget', '100'], fixture.commit || clone.commit);
    const output = `${res.stdout || ''}${res.stderr || ''}`;
    const problems = [];
    if (res.status !== fixture.exit) problems.push(`expected exit ${fixture.exit}, got ${res.status}`);
    for (const needle of fixture.includes || []) {
      if (!output.includes(needle)) problems.push(`output does not contain: ${JSON.stringify(needle)}`);
    }
    for (const needle of fixture.excludes || []) {
      if (output.includes(needle)) problems.push(`output should not contain: ${JSON.stringify(needle)}`);
    }
    if (res.status === 0 && existsSync(join(out, 'plan.json'))) {
      try {
        checkFiles(readPlan(out));
      } catch (err) {
        problems.push(err.message);
      }
    }
    if (fixture.check && res.status === 0) {
      try {
        fixture.check(out, res);
      } catch (err) {
        problems.push(err.message);
      }
    }
    return { problems, output };
  } catch (err) {
    return { problems: [`fixture failed: ${err && err.message ? err.message : String(err)}`], output: '' };
  } finally {
    if (!process.argv.includes('--keep')) rmSync(root, { recursive: true, force: true });
  }
}

function main() {
  const wanted = process.argv.slice(2).filter((a) => a.search(/^\d+$/) >= 0).map(Number);
  const selected = wanted.length ? FIXTURES.filter((f) => wanted.includes(f.n)) : FIXTURES;
  let failed = 0;
  for (const fixture of selected) {
    const { problems, output } = runFixture(fixture);
    if (problems.length) {
      failed += 1;
      process.stdout.write(`  FAIL  ${fixture.n}. ${fixture.name} [exit ${fixture.exit}]\n`);
      for (const p of problems) process.stdout.write(`          - ${p}\n`);
      process.stdout.write(`${output.split('\n').map((l) => `          | ${l}`).join('\n')}\n`);
    } else {
      process.stdout.write(`  PASS  ${fixture.n}. ${fixture.name} [exit ${fixture.exit}]\n`);
    }
  }
  process.stdout.write(failed
    ? `\n${failed} of ${selected.length} fixtures FAILED. The plan is not proven until this is green.\n`
    : `\nAll ${selected.length} fixtures passed.\n`);
  rmSync(SANDBOX_HOME, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
}

main();

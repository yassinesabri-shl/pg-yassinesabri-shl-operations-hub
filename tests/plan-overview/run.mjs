#!/usr/bin/env node
// Part of the harness asset library c6f3b4427d58f7c3 (see VERSION.json) · 2026-11-11
/**
 * run.mjs: the fixture suite for plan-overview.mjs.
 *
 *   usage:  node run.mjs            run every fixture
 *           node run.mjs 2 6        run only the numbered fixtures
 *           node run.mjs --keep     leave the throwaway hubs on disk
 *
 * A fixture is a REPOSITORY STATE: a throwaway hub clone with a real bare `origin`. The base
 * state is two commits on the trunk: the registry, one survey and the overview template, then
 * the overview. A fixture adds commits, pushes them, and runs the shipped script from the hub
 * root, as /estate-overview-refresh runs it. The script and spoke-remote.mjs, which it imports,
 * are copied to <hub>/scripts/. The runner records P, the last commit that touched the overview,
 * as it makes the commits, and asserts the exact first line, the exit code and the change lines.
 * Fixture 1 is the valid control. Most others change exactly one thing.
 *
 * Node standard library only, plus git via child_process. No test framework.
 * Exit 0 if every fixture passes, 1 if any fails.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

const SCRIPT = [
  process.env.HARNESS_PLAN_OVERVIEW,
  resolve(HERE, '..', '..', 'plan-overview.mjs'),
  resolve(HERE, '..', '..', 'scripts', 'plan-overview.mjs'),
].filter(Boolean).find((p) => existsSync(p));

if (!SCRIPT) {
  console.error('cannot locate plan-overview.mjs. Set HARNESS_PLAN_OVERVIEW=/path/to/plan-overview.mjs.');
  process.exit(4);
}

const SHARED = join(dirname(SCRIPT), 'spoke-remote.mjs');
if (!existsSync(SHARED)) {
  console.error(`cannot locate spoke-remote.mjs beside ${SCRIPT}.`);
  process.exit(4);
}

/* ------------------------------------------------------------------ git helpers */

const SANDBOX_HOME = mkdtempSync(join(tmpdir(), 'plan-overview-home-'));
const ENV = {
  ...process.env,
  HOME: SANDBOX_HOME,
  XDG_CONFIG_HOME: join(SANDBOX_HOME, '.config'),
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
  GIT_ASKPASS: 'true',
};
delete ENV.HARNESS_TRUNK;

function git(cwd, args) {
  return execFileSync('git', args, { cwd, env: ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function writeFiles(root, files) {
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(root, rel);
    if (body === null) {
      rmSync(abs, { force: true });
      continue;
    }
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }
}

function initClone(dir) {
  git(dir, ['config', 'user.name', 'Fixture Runner']);
  git(dir, ['config', 'user.email', 'fixture@example.invalid']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
}

const OVERVIEW = 'docs/estate/overview.md';

/* ------------------------------------------------------------------ the hub state */

const SURVEY = 'docs/estate/surveys/orders-api.md';
const REGISTRY = 'docs/estate/repositories.json';
const TEMPLATE = 'docs/estate/_TEMPLATE.overview.md';

const BASE_SOURCES = {
  [REGISTRY]: `${JSON.stringify([{ id: 'orders-api', url: 'https://example.invalid/orders-api.git', trunk: 'default', purpose: 'Takes and tracks orders. Synthetic.' }], null, 2)}\n`,
  [SURVEY]: '# Service survey: orders-api\n\n## 1. Serves\n\nTakes orders. Synthetic.\n',
  [TEMPLATE]: '# Estate overview\n\n## 1. What the system does\n\n## 2. The parts\n',
};
const BASE_OVERVIEW = { [OVERVIEW]: '# Estate overview\n\n## 1. What the system does\n\nA synthetic estate of one spoke.\n' };

// The base commits, then the fixture's own. A `null` body deletes the file.
const BASE = [BASE_SOURCES, BASE_OVERVIEW];

const FIXTURES = [
  {
    n: 1,
    name: 'control: an overview on the trunk and no source change since',
    commits: BASE,
    exit: 0,
    first: 'since',
    includes: ['no source change'],
  },
  {
    n: 2,
    name: 'a survey changed after the overview is listed',
    commits: [...BASE, { [SURVEY]: '# Service survey: orders-api\n\n## 1. Serves\n\nTakes and refunds orders. Synthetic.\n' }],
    exit: 1,
    first: 'since',
    includes: [`M\t${SURVEY}`],
    excludes: [REGISTRY, 'no source change'],
  },
  {
    n: 3,
    name: 'the registry changed after the overview is listed',
    commits: [...BASE, { [REGISTRY]: '[]\n' }],
    exit: 1,
    first: 'since',
    includes: [`M\t${REGISTRY}`],
    excludes: [SURVEY],
  },
  {
    n: 4,
    name: 'a file outside the sources and a _TEMPLATE file are not sources',
    commits: [...BASE, { 'README.md': '# A hub\n', [TEMPLATE]: '# Estate overview, version 2\n', 'docs/estate/surveys/_TEMPLATE.md': '# Service survey: <id>\n' }],
    exit: 0,
    first: 'since',
    includes: ['no source change'],
    excludes: ['README.md', '_TEMPLATE'],
  },
  {
    n: 5,
    name: 'no overview on the trunk is exit 1, `no overview`',
    commits: [BASE_SOURCES],
    exit: 1,
    first: 'at',
    includes: ['no overview'],
  },
  {
    n: 6,
    name: 'a remote that cannot be fetched cannot verify',
    commits: BASE,
    after: ({ root, hub }) => git(hub, ['remote', 'set-url', 'origin', join(root, 'missing.git')]),
    exit: 2,
    includes: ['CANNOT VERIFY', 'could not fetch origin/main'],
  },
  {
    n: 7,
    name: 'HARNESS_TRUNK that is not the remote default branch cannot verify',
    commits: BASE,
    after: ({ hub }) => git(hub, ['push', '-q', 'origin', 'main:develop']),
    env: { HARNESS_TRUNK: 'develop' },
    exit: 2,
    includes: ['CANNOT VERIFY', 'default branch is "main"'],
  },
  {
    n: 8,
    name: 'a hand edit to the overview after a source change moves P',
    commits: [
      ...BASE,
      { [SURVEY]: '# Service survey: orders-api\n\n## 1. Serves\n\nTakes and refunds orders. Synthetic.\n' },
      { [OVERVIEW]: '# Estate overview\n\n## 1. What the system does\n\nA synthetic estate that takes and refunds orders.\n' },
    ],
    exit: 0,
    first: 'since',
    includes: ['no source change'],
  },
  {
    n: 9,
    name: 'a file in a requirements run folder is not a source, even a copy named requirements.md',
    commits: [...BASE, {
      'docs/requirements/menu/runs/20261111_0900/interview.md': '# Interview\n\nSynthetic.\n',
      'docs/requirements/menu/runs/20261111_0900/requirements.md': '# A copied source\n\nSynthetic.\n',
    }],
    exit: 0,
    first: 'since',
    includes: ['no source change'],
    excludes: ['runs/'],
  },
  {
    n: 10,
    name: 'the remote tip is judged, not a local trunk that is behind it',
    commits: BASE,
    after: ({ root, bare, record }) => {
      const other = join(root, 'other');
      git(root, ['clone', '-q', bare, other]);
      initClone(other);
      writeFiles(other, { [SURVEY]: '# Service survey: orders-api\n\n## 1. Serves\n\nTakes orders from a second clone. Synthetic.\n' });
      git(other, ['add', '-A']);
      git(other, ['commit', '-q', '-m', 'a survey change from a second clone']);
      git(other, ['push', '-q', 'origin', 'main']);
      record(git(other, ['rev-parse', 'HEAD']).trim(), [SURVEY]);
    },
    exit: 1,
    first: 'since',
    includes: [`M\t${SURVEY}`],
  },
  {
    n: 11,
    name: 'an overview deleted on the trunk is `no overview`',
    commits: [...BASE, { [OVERVIEW]: null }],
    exit: 1,
    first: 'at',
    includes: ['no overview'],
  },
  {
    n: 12,
    name: 'a deleted source, new sources and a path with a space are listed exactly, sorted by path',
    commits: [
      ...BASE,
      {
        [SURVEY]: null,
        'docs/architecture/ADR-001.md': '# ADR-001\n\nSynthetic.\n',
        'docs/requirements/menu/requirements.md': '# Requirements: menu\n\nSynthetic.\n',
        'docs/standards/std-api naming.md': '# Standard: API naming\n\nSynthetic.\n',
      },
    ],
    exit: 1,
    first: 'since',
    exactTail: [
      'A\tdocs/architecture/ADR-001.md',
      `D\t${SURVEY}`,
      'A\tdocs/requirements/menu/requirements.md',
      'A\tdocs/standards/std-api naming.md',
    ],
  },
  {
    n: 13,
    name: 'an argument is usage',
    commits: BASE,
    args: ['--since', 'abc'],
    exit: 3,
    includes: ['unknown argument: --since', 'usage:'],
  },
];

/* ---------------------------------------------------------------------- runner */

function runFixture(fixture) {
  const root = mkdtempSync(join(tmpdir(), `plan-overview-fx${String(fixture.n).padStart(2, '0')}-`));
  try {
    const bare = join(root, 'origin.git');
    const hub = join(root, 'hub');
    git(root, ['init', '--bare', '-q', '--initial-branch', 'main', bare]);
    mkdirSync(hub);
    git(hub, ['init', '-q', '--initial-branch', 'main']);
    initClone(hub);
    git(hub, ['remote', 'add', 'origin', bare]);

    // P is the last commit whose change set names the overview. The runner keeps it by hand, so the
    // assertion does not reuse the script's own git query.
    let since = null;
    const record = (sha, paths) => {
      if (paths.includes(OVERVIEW)) since = sha;
    };
    fixture.commits.forEach((files, i) => {
      writeFiles(hub, files);
      git(hub, ['add', '-A']);
      git(hub, ['commit', '-q', '-m', `commit ${i + 1}`]);
      record(git(hub, ['rev-parse', 'HEAD']).trim(), Object.keys(files));
    });
    git(hub, ['push', '-q', 'origin', 'main']);
    if (fixture.after) fixture.after({ root, bare, hub, record });

    const scripts = join(hub, 'scripts');
    mkdirSync(scripts, { recursive: true });
    copyFileSync(SCRIPT, join(scripts, 'plan-overview.mjs'));
    copyFileSync(SHARED, join(scripts, 'spoke-remote.mjs'));

    const tip = git(root, ['--git-dir', bare, 'rev-parse', 'main']).trim();
    const res = spawnSync(process.execPath, [join('scripts', 'plan-overview.mjs'), ...(fixture.args || [])], {
      cwd: hub,
      env: { ...ENV, ...(fixture.env || {}) },
      encoding: 'utf8',
    });
    const output = `${res.stdout || ''}${res.stderr || ''}`;
    const lines = (res.stdout || '').split('\n').filter((l) => l !== '');
    const problems = [];
    if (res.status !== fixture.exit) problems.push(`expected exit ${fixture.exit}, got ${res.status}`);
    if (fixture.first === 'since') {
      const want = since ? `since ${since.slice(0, 12)} at ${tip.slice(0, 12)}` : '(the fixture made no overview commit)';
      if (lines[0] !== want) problems.push(`first line is ${JSON.stringify(lines[0])}, expected ${JSON.stringify(want)}`);
    } else if (fixture.first === 'at') {
      const want = `at ${tip.slice(0, 12)}`;
      if (lines[0] !== want) problems.push(`first line is ${JSON.stringify(lines[0])}, expected ${JSON.stringify(want)}`);
    }
    if (fixture.exactTail) {
      const tail = JSON.stringify(lines.slice(1));
      if (tail !== JSON.stringify(fixture.exactTail)) problems.push(`change lines are ${tail}, expected ${JSON.stringify(fixture.exactTail)}`);
    }
    for (const needle of fixture.includes || []) if (!output.includes(needle)) problems.push(`output does not contain: ${needle}`);
    for (const needle of fixture.excludes || []) if (output.includes(needle)) problems.push(`output should not contain: ${needle}`);
    return { problems, output };
  } finally {
    if (!process.argv.includes('--keep')) rmSync(root, { recursive: true, force: true });
  }
}

function main() {
  const wanted = process.argv.slice(2).filter((a) => a.search(/^\d+$/) >= 0).map(Number);
  const selected = wanted.length ? FIXTURES.filter((f) => wanted.includes(f.n)) : FIXTURES;
  process.stdout.write(`script under test: ${SCRIPT}\n${selected.length} of ${FIXTURES.length} fixtures\n\n`);
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
  process.stdout.write(failed ? `\n${failed} of ${selected.length} fixtures FAILED.\n` : `\nAll ${selected.length} fixtures passed.\n`);
  rmSync(SANDBOX_HOME, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
}

main();

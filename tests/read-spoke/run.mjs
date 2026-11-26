#!/usr/bin/env node
/**
 * run.mjs — the fixture suite for read-spoke.mjs.
 *
 *   usage:  node run.mjs            run every fixture
 *           node run.mjs 2 6        run only the numbered fixtures
 *           node run.mjs --keep     leave the throwaway repositories on disk
 *
 * A fixture is a REPOSITORY STATE: a real bare remote built on disk, a registry
 * file pointing at it, and the shipped script run from a throwaway hub exactly
 * as a seat would run it. The script is never imported and never stubbed. Exit
 * code, header lines and, where it matters, the bytes after the separator are
 * asserted.
 *
 * Node standard library only, plus git via child_process. No test framework.
 * Exit 0 if every fixture passes, 1 if any fails.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

const SCRIPT = [
  process.env.HARNESS_READ_SPOKE,
  resolve(HERE, '..', '..', 'read-spoke.mjs'),
  resolve(HERE, '..', '..', 'scripts', 'read-spoke.mjs'),
].filter(Boolean).find((p) => existsSync(p));

if (!SCRIPT) {
  console.error('cannot locate read-spoke.mjs. Set HARNESS_READ_SPOKE=/path/to/read-spoke.mjs.');
  process.exit(4);
}

// spoke-search.mjs sits beside read-spoke.mjs in both layouts.
const SEARCH_MODULE = join(dirname(SCRIPT), 'spoke-search.mjs');

/**
 * The Orca guard. Finds every RegExp( call in a source text and returns one
 * problem for each whose argument is not a plain string literal: an identifier,
 * an expression, or a template literal that holds an interpolation. The scan
 * uses indexOf and slice, so the guard builds no pattern itself.
 */
function regExpCallProblems(label, text) {
  const problems = [];
  const call = 'RegExp(';
  let at = text.indexOf(call);
  while (at !== -1) {
    const line = text.slice(0, at).split('\n').length;
    let i = at + call.length;
    while (i < text.length && (text[i] === ' ' || text[i] === '\t' || text[i] === '\n')) i += 1;
    const first = text[i];
    let ok = false;
    if (first === '"' || first === "'" || first === '`') {
      // Find the matching close quote, skipping each backslash and the character after it.
      let j = i + 1;
      while (j < text.length && text[j] !== first) j += text[j] === '\\' ? 2 : 1;
      if (j < text.length) {
        let k = j + 1;
        while (k < text.length && (text[k] === ' ' || text[k] === '\t' || text[k] === '\n')) k += 1;
        // The whole argument must be this one literal: the next token ends the argument.
        ok = (text[k] === ')' || text[k] === ',') && (first !== '`' || text.slice(i, j).indexOf('${') === -1);
      }
    }
    if (!ok) problems.push(`${label}:${line}: RegExp( argument is not one plain string literal`);
    at = text.indexOf(call, at + call.length);
  }
  return problems;
}

/* ------------------------------------------------------------------ git helpers */

const SANDBOX_HOME = mkdtempSync(join(tmpdir(), 'spoke-home-'));
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

function writeFiles(root, files) {
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }
}

function makeRemote(root, name, { trunk = 'main', commits, branch = null }) {
  const bare = join(root, `${name}.git`);
  const work = join(root, `${name}-work`);
  git(root, ['init', '--bare', '-q', '--initial-branch', trunk, bare]);
  git(root, ['--git-dir', bare, 'symbolic-ref', 'HEAD', `refs/heads/${trunk}`]);
  git(root, ['init', '-q', '--initial-branch', trunk, work]);
  git(work, ['config', 'user.name', 'Fixture Runner']);
  git(work, ['config', 'user.email', 'fixture@example.invalid']);
  git(work, ['config', 'commit.gpgsign', 'false']);
  const shas = [];
  commits.forEach((files, i) => {
    writeFiles(work, files);
    git(work, ['add', '-A']);
    git(work, ['commit', '-q', '-m', `commit ${i + 1}`]);
    shas.push(git(work, ['rev-parse', 'HEAD']).trim());
  });
  git(work, ['push', '-q', bare, trunk]);
  // A second branch, cut from the trunk's tip: a declared harness trunk.
  let branchHead = null;
  if (branch) {
    git(work, ['checkout', '-q', '-b', branch.name]);
    branch.commits.forEach((files, i) => {
      writeFiles(work, files);
      git(work, ['add', '-A']);
      git(work, ['commit', '-q', '-m', `${branch.name} commit ${i + 1}`]);
    });
    branchHead = git(work, ['rev-parse', 'HEAD']).trim();
    git(work, ['push', '-q', bare, branch.name]);
    git(work, ['checkout', '-q', trunk]);
  }
  return { url: bare, work, bare, trunk, shas, head: shas[shas.length - 1], branchHead };
}

/** Commit more files on the remote's trunk after the registry was written. */
function advance(remote, files) {
  writeFiles(remote.work, files);
  git(remote.work, ['add', '-A']);
  git(remote.work, ['commit', '-q', '-m', 'later']);
  git(remote.work, ['push', '-q', remote.bare, remote.trunk]);
  return git(remote.work, ['rev-parse', 'HEAD']).trim();
}

const README_V1 = '# transfer-service\n\nMoves money between accounts.\n';
const README_V2 = '# transfer-service\n\nMoves money between accounts. Now with limits.\n';

const registry = (repositories) => JSON.stringify({ schema_version: 1, repositories }, null, 2);
const entry = (remote) => ({
  url: remote.url,
  checks: 'checks.env',
  purpose: 'Moves money between accounts.',
  readAt: remote.head,
  trunk: 'default',
});

// The tree most --grep fixtures search. The commands file agrees with the
// registry entry, so the trunk rule ends in `agreed`, as on an installed spoke.
const GREP_FILES = {
  'checks.env': 'TEST_COMMAND=npm test\nTRUNK_FOR_HUB=default\n',
  'README.md': README_V1,
  'src/server.ts': "import x;\nres.setHeader('x-request-id', id);\n",
  'src/legacy/router.ts': "headers['x-request-id'] = makeId();\nconst y = 1;\nlog('x-request-id');\n",
};

const PATHS_FILES = { 'src/a.ts': 'needle\n', 'src/b/c.ts': 'needle\n', 'test/d.ts': 'needle\n' };

/** The header of a --grep output, up to and including the separator. */
function grepHeader(commit, trunk, search, scope, hits, files, shown) {
  return [
    'Repository: transfer-service',
    `Commit: ${commit}`,
    `Trunk: ${trunk}`,
    `Search: ${search}`,
    `Scope: ${scope} files`,
    `Hits: ${hits}`,
    `Files: ${files}`,
    `Shown: ${shown}`,
    '---',
    '',
  ].join('\n');
}

// The tree and the reply of the --requests fixtures.
const REQUEST_FILES = { ...GREP_FILES, 'src/a.ts': 'export const a = 1;\n' };

const REQUEST_REPLY = [
  'I need four facts before a verdict.',
  '',
  '### REQUESTS',
  '- grep "x-request-id" --paths "src/**/*.ts"',
  '- files "src/*.ts"',
  '- read "src/a.ts"',
  '- read "src/missing.ts"',
  '',
].join('\n');

/** The whole stdout of the round in REQUEST_REPLY, at the remote's head. */
function requestRound(a) {
  const blob = git(a.work, ['rev-parse', `${a.head}:src/a.ts`]).trim();
  return [
    'Request 1 of 4: grep "x-request-id" --paths "src/**/*.ts"',
    'Exit: 0',
    grepHeader(a.head, 'not asked', 'grep fixed "x-request-id" paths src/**/*.ts (binary files skipped)', 3, 3, 2, 'every hit')
      + "src/legacy/router.ts:1: headers['x-request-id'] = makeId();\n"
      + "src/legacy/router.ts:3: log('x-request-id');\n"
      + "src/server.ts:2: res.setHeader('x-request-id', id);",
    '',
    'Request 2 of 4: files "src/*.ts"',
    'Exit: 0',
    'Repository: transfer-service',
    `Commit: ${a.head}`,
    'Trunk: not asked',
    'Search: files src/*.ts',
    'Scope: 2 files',
    'Files: 2',
    'Shown: every path',
    '---',
    'src/a.ts',
    'src/server.ts',
    '',
    'Request 3 of 4: read "src/a.ts"',
    'Exit: 0',
    'Repository: transfer-service',
    `Commit: ${a.head}`,
    'Trunk: not asked',
    'Path: src/a.ts',
    `Blob: ${blob}`,
    'Lines: 1',
    `Cite: transfer-service@${a.head.slice(0, 12)}:src/a.ts`,
    '---',
    'export const a = 1;',
    '',
    'Request 4 of 4: read "src/missing.ts"',
    'Exit: 1',
    `NOT FOUND: src/missing.ts is not in transfer-service at ${a.head.slice(0, 12)} (trunk: not asked)`,
    '',
  ].join('\n');
}

// The files of the read-cap fixtures: one line over the line cap of a round,
// one line over the character cap, and a file with a NUL byte.
const LONG_LINES = Array.from({ length: 401 }, (_, i) => `line ${i + 1}`);
const CAP_FILES = {
  'long.txt': `${LONG_LINES.join('\n')}\n`,
  'wide.txt': `short\n${'w'.repeat(301)}\nend\n`,
  'logo.bin': 'PNG\u0000\u0001\u0002\nmore\n',
};

/** A registry entry whose remote does not exist: a fixture that reaches it fails with exit 2. */
const NEVER_ASKED = (root) => ({ url: join(root, 'never-asked.git'), checks: 'checks.env', purpose: 'Never asked.', readAt: 'a'.repeat(40), trunk: 'default' });

/** A problem when stdout is not exactly the expected text. */
function exactly(out, want) {
  return out === want ? [] : [`stdout is not the expected text.\n            want: ${JSON.stringify(want)}\n            got:  ${JSON.stringify(out)}`];
}

/** Problems when the cache config holds a filter or a promisor: a prefix resolution must leave it as it was. */
function cacheHasNoFilter(cache) {
  const config = readFileSync(join(cache, 'config'), 'utf8');
  return ['promisor', 'partialclonefilter'].filter((key) => config.includes(key)).map((key) => `the cache config ${cache} holds "${key}"`);
}

/**
 * Run the shipped script `count` times at once, each with the same args, and
 * return [{ status, stdout, stderr }]. A child Node process starts them all
 * and waits for all, so the runs overlap the way parallel reads of a seat do.
 */
function runParallel(hub, env, args, count) {
  const code = `
    const { spawn } = require('node:child_process');
    const [script, count, ...args] = process.argv.slice(1);
    const runs = Array.from({ length: Number(count) }, () => new Promise((done) => {
      const child = spawn(process.execPath, [script, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => { stdout += d; });
      child.stderr.on('data', (d) => { stderr += d; });
      child.on('close', (status) => done({ status, stdout, stderr }));
    }));
    Promise.all(runs).then((r) => process.stdout.write(JSON.stringify(r)));
  `;
  const res = spawnSync(process.execPath, ['-e', code, SCRIPT, String(count), ...args], { cwd: hub, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (res.status !== 0) throw new Error(`the parallel runner failed: ${res.stderr}`);
  return JSON.parse(res.stdout);
}

/** Problems for each parallel run that did not exit 0 or did not print `want`. */
function allPassed(label, runs, want) {
  return runs.flatMap((r, i) => (r.status === 0 && r.stdout === want ? [] : [`${label} run ${i + 1} of ${runs.length}: exit ${r.status}, ${JSON.stringify(r.stderr.slice(0, 300))}`]));
}

/** One more run of the shipped script, for fixtures that compare two runs. */
function runScript(hub, env, args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { cwd: hub, env, encoding: 'utf8' });
}

/* ------------------------------------------------------------------- fixtures */

// `build(root)` returns { registry, args, expect? }. `expect(output, remote)` may
// return extra problems, for the cases where the assertion needs a value only
// known after the remote is built.
const FIXTURES = [
  {
    n: 1,
    name: 'read a file at the trunk head: header pins the commit, body is the file byte for byte',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [{ 'README.md': README_V1, 'checks.env': 'TEST_COMMAND=npm test\nTRUNK_FOR_HUB=default\n' }] });
      return {
        registry: registry({ 'transfer-service': entry(a) }),
        args: ['transfer-service', 'README.md'],
        expect: (out) => {
          const problems = [];
          if (!out.includes(`Commit: ${a.head}`)) problems.push(`header does not pin the trunk head ${a.head}`);
          if (!out.includes(`Cite: transfer-service@${a.head.slice(0, 12)}:README.md`)) problems.push('no Cite line with the short commit');
          const body = out.split('---\n')[1];
          if (body !== README_V1) problems.push(`body is not the file: ${JSON.stringify(body)}`);
          if (!out.includes(`\nLines: ${README_V1.split('\n').length - 1}\n`)) problems.push('no Lines line with the file\'s line count');
          return problems;
        },
      };
    },
    exit: 0,
    includes: ['Repository: transfer-service', 'Trunk: main', 'Path: README.md', 'Blob: '],
  },
  {
    n: 2,
    name: 'read the root: one ls-tree line per entry',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [{ 'README.md': README_V1, 'src/app.ts': 'export {};\n' }] });
      return { registry: registry({ 'transfer-service': entry(a) }), args: ['transfer-service', '.'] };
    },
    exit: 0,
    includes: ['Path: .', 'Tree: ', 'blob', '\tREADME.md', 'tree', '\tsrc'],
  },
  {
    n: 3,
    name: 'a path that is not at the commit',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [{ 'README.md': README_V1 }] });
      return { registry: registry({ 'transfer-service': entry(a) }), args: ['transfer-service', 'docs/missing.md'] };
    },
    exit: 1,
    includes: ['NOT FOUND: docs/missing.md is not in transfer-service at'],
  },
  {
    n: 4,
    name: 'a repository id that is not in the list is a usage error, and the list is named',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [{ 'README.md': README_V1 }] });
      return { registry: registry({ 'transfer-service': entry(a) }), args: ['ledger-service', 'README.md'] };
    },
    exit: 3,
    includes: ['"ledger-service" is not in', 'Listed: transfer-service', 'Add it with /add-repo'],
  },
  {
    n: 5,
    name: 'a path that climbs out of the repository is a usage error',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [{ 'README.md': README_V1 }] });
      return { registry: registry({ 'transfer-service': entry(a) }), args: ['transfer-service', '../hub/secret'] };
    },
    exit: 3,
    includes: ['path must not climb'],
  },
  {
    n: 6,
    name: '--at reads the pinned commit after the trunk moved on, from the cache, without asking the remote',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [{ 'README.md': README_V1 }] });
      const pinned = a.head;
      return {
        registry: registry({ 'transfer-service': entry(a) }),
        // First read warms the cache at the pinned commit; then the trunk moves.
        before: (hub, env) => {
          const first = spawnSync(process.execPath, [SCRIPT, 'transfer-service', 'README.md'], { cwd: hub, env, encoding: 'utf8' });
          if (first.status !== 0) throw new Error(`warm-up read failed: ${first.stderr}`);
          advance(a, { 'README.md': README_V2 });
        },
        args: ['transfer-service', 'README.md', '--at', pinned],
        expect: (out) => {
          const problems = [];
          if (!out.includes(`Commit: ${pinned}`)) problems.push('header does not name the pinned commit');
          if (out.split('---\n')[1] !== README_V1) problems.push('body is not the file as it was at the pinned commit');
          return problems;
        },
      };
    },
    exit: 0,
    includes: ['Trunk: not asked'],
  },
  {
    n: 7,
    name: 'without --at the read follows the trunk, so a second read after a push sees the new file',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [{ 'README.md': README_V1 }] });
      return {
        registry: registry({ 'transfer-service': entry(a) }),
        before: (hub, env) => {
          spawnSync(process.execPath, [SCRIPT, 'transfer-service', 'README.md'], { cwd: hub, env, encoding: 'utf8' });
          a.later = advance(a, { 'README.md': README_V2 });
        },
        args: ['transfer-service', 'README.md'],
        expect: (out) => {
          const problems = [];
          if (!out.includes(`Commit: ${a.later}`)) problems.push('header does not name the new trunk head');
          if (out.split('---\n')[1] !== README_V2) problems.push('body is not the new file');
          return problems;
        },
      };
    },
    exit: 0,
  },
  {
    n: 8,
    name: 'the remote is unreachable',
    build: (root) => ({
      registry: registry({ 'transfer-service': { url: join(root, 'no-such-remote.git'), checks: 'checks.env', purpose: 'Gone.', readAt: 'a'.repeat(40), trunk: 'default' } }),
      args: ['transfer-service', 'README.md'],
    }),
    exit: 2,
    includes: ['CANNOT VERIFY: cannot reach', 'REASON: remote-unreachable'],
  },
  {
    n: 9,
    name: 'a trunk called master is read from the remote and printed',
    build: (root) => {
      const a = makeRemote(root, 'legacy-batch', { trunk: 'master', commits: [{ 'README': 'batch jobs\n' }] });
      return { registry: registry({ 'legacy-batch': entry(a) }), args: ['legacy-batch', 'README'] };
    },
    exit: 0,
    includes: ['Trunk: master', 'Cite: legacy-batch@'],
  },
  {
    n: 10,
    name: 'no registry',
    build: () => ({ registry: null, args: ['transfer-service', 'README.md'] }),
    exit: 2,
    includes: ['CANNOT VERIFY: no registry at', 'REASON: registry-missing'],
  },
  {
    n: 11,
    name: 'a registry that is not well formed is refused before any remote is asked',
    build: () => ({
      registry: JSON.stringify({ schema_version: 1, repositories: { 'transfer-service': { url: 'https://example.invalid/x.git' } } }),
      args: ['transfer-service', 'README.md'],
    }),
    exit: 1,
    includes: ['the registry is not well formed; run check-registry first', '.checks is missing'],
    excludes: ['cannot reach'],
  },
  {
    n: 12,
    name: 'a --at value that is not a full hash is a usage error',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [{ 'README.md': README_V1 }] });
      return { registry: registry({ 'transfer-service': entry(a) }), args: ['transfer-service', 'README.md', '--at', 'main'] };
    },
    exit: 3,
    includes: ['--at must be a full 40-character commit hash'],
  },
  {
    n: 13,
    name: 'a nested directory lists its own entries',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [{ 'src/app.ts': 'export {};\n', 'src/limits/table.ts': 'export {};\n' }] });
      return { registry: registry({ 'transfer-service': entry(a) }), args: ['transfer-service', 'src/'] };
    },
    exit: 0,
    includes: ['Path: src', 'Cite: transfer-service@', ':src', '\tapp.ts', '\tlimits'],
    excludes: ['Lines: '],
  },
  {
    // A hub checkout on a CI runner carries the runner's own credential in its
    // local git configuration, for every address on the forge, and git sends
    // that in preference to a token in the address. A spoke read that inherited
    // it would be answered as the hub, not as the token the workflow hands in.
    // Here the hub's local configuration rewrites the spoke's address to
    // nowhere; the read must not notice.
    n: 14,
    name: "a spoke read never inherits the hub checkout's local git configuration",
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [{ 'README.md': README_V1 }] });
      return {
        registry: registry({ 'transfer-service': entry(a) }),
        before: (hub) => {
          git(hub, ['init', '-q']);
          git(hub, ['config', '--local', 'url.file:///nonexistent/.insteadOf', a.url]);
        },
        args: ['transfer-service', 'README.md'],
        expect: (out) => (out.includes(`Commit: ${a.head}`) ? [] : [`header does not pin the trunk head ${a.head}`]),
      };
    },
    exit: 0,
    includes: ['Trunk: main'],
    excludes: ['cannot reach'],
  },
  {
    n: 15,
    name: 'a file whose last line has no newline counts that line, and an empty file counts none',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [{ 'one.txt': 'first\nsecond', 'empty.txt': '' }] });
      let empty = null;
      return {
        registry: registry({ 'transfer-service': entry(a) }),
        before: (hub, env) => { empty = spawnSync(process.execPath, [SCRIPT, 'transfer-service', 'empty.txt'], { cwd: hub, env, encoding: 'utf8' }); },
        args: ['transfer-service', 'one.txt'],
        expect: () => (empty.stdout.includes('\nLines: 0\n') ? [] : [`the empty file is not "Lines: 0": ${JSON.stringify(empty.stdout + empty.stderr)}`]),
      };
    },
    exit: 0,
    includes: ['Lines: 2'],
  },
  {
    n: 16,
    name: 'a declared trunk: the file is read on that branch, not on the default branch',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', {
        commits: [{ 'README.md': README_V1 }],
        branch: { name: 'harness-main', commits: [{ 'README.md': README_V2, 'checks.env': 'TEST_COMMAND=npm test\nTRUNK_FOR_HUB=harness-main\n' }] },
      });
      return {
        registry: registry({ 'transfer-service': { ...entry(a), trunk: 'harness-main', readAt: a.branchHead } }),
        args: ['transfer-service', 'README.md'],
        expect: (out) => {
          const problems = [];
          if (!out.includes(`Commit: ${a.branchHead}`)) problems.push(`header does not pin the declared trunk's head ${a.branchHead}`);
          if (out.split('---\n')[1] !== README_V2) problems.push('body is not the file on the declared trunk');
          return problems;
        },
      };
    },
    exit: 0,
    includes: ['Trunk: harness-main', 'Now with limits.'],
    excludes: ['Trunk: main\n'],
  },

  /* ------------------------------------------------------------ --grep */

  {
    n: 17,
    name: '--grep: a fixed text in two files gives the exact header, every hit in path and line order, and no Cite line',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [GREP_FILES] });
      return {
        registry: registry({ 'transfer-service': entry(a) }),
        args: ['transfer-service', '--grep', 'x-request-id'],
        expect: (out) => exactly(out, grepHeader(a.head, 'main', 'grep fixed "x-request-id" (binary files skipped)', 4, 3, 2, 'every hit') + [
          "src/legacy/router.ts:1: headers['x-request-id'] = makeId();",
          "src/legacy/router.ts:3: log('x-request-id');",
          "src/server.ts:2: res.setHeader('x-request-id', id);",
          '',
        ].join('\n')),
      };
    },
    exit: 0,
    excludes: ['Cite:'],
  },
  {
    n: 18,
    name: '--grep: a fixed text full of RegExp characters matches only itself',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [{ 'src/p.ts': 'aXbcc\nconst s = "a.b(c)*";\n' }] });
      return { registry: registry({ 'transfer-service': entry(a) }), args: ['transfer-service', '--grep', 'a.b(c)*'] };
    },
    exit: 0,
    includes: ['Hits: 1\n', 'src/p.ts:2: const s = "a.b(c)*";\n'],
    excludes: ['src/p.ts:1:'],
  },
  {
    n: 19,
    name: '--grep: a text that starts with "-" is a pattern, not an option',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [{ 'run.sh': 'tool -x now\ntool -y\n' }] });
      return { registry: registry({ 'transfer-service': entry(a) }), args: ['transfer-service', '--grep', '-x'] };
    },
    exit: 0,
    includes: ['Search: grep fixed "-x" (binary files skipped)', 'Hits: 1\n', 'run.sh:1: tool -x now\n'],
  },
  {
    n: 20,
    name: '--grep --regex finds what the fixed form does not',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [{ 'src/id.ts': 'makeId();\nmakeRequestId();\nmakeOtherId();\n' }] });
      let fixed = null;
      return {
        registry: registry({ 'transfer-service': entry(a) }),
        before: (hub, env) => { fixed = runScript(hub, env, ['transfer-service', '--grep', 'make(Request)?Id']); },
        args: ['transfer-service', '--regex', '--grep', 'make(Request)?Id'],
        expect: () => (fixed.stdout.includes('Hits: 0\n') ? [] : [`the fixed form found a hit: ${JSON.stringify(fixed.stdout)}`]),
      };
    },
    exit: 0,
    includes: ['Search: grep regex "make(Request)?Id" (binary files skipped)', 'Hits: 2\n', 'src/id.ts:1: makeId();\n', 'src/id.ts:2: makeRequestId();\n'],
    excludes: ['makeOtherId'],
  },
  {
    n: 21,
    name: '--grep --ignore-case finds the other case',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [GREP_FILES] });
      return { registry: registry({ 'transfer-service': entry(a) }), args: ['transfer-service', '--grep', 'X-REQUEST-ID', '--ignore-case'] };
    },
    exit: 0,
    includes: ['Search: grep fixed "X-REQUEST-ID" ignore-case (binary files skipped)', 'Hits: 3\n', 'Files: 2\n'],
  },
  {
    n: 22,
    name: '--grep --paths: the scope gets smaller, and "src/**/*.ts" also matches src/a.ts',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [PATHS_FILES] });
      return {
        registry: registry({ 'transfer-service': entry(a) }),
        args: ['transfer-service', '--grep', 'needle', '--paths', 'src/**/*.ts'],
        expect: (out) => exactly(out, grepHeader(a.head, 'main', 'grep fixed "needle" paths src/**/*.ts (binary files skipped)', 2, 2, 2, 'every hit')
          + 'src/a.ts:1: needle\nsrc/b/c.ts:1: needle\n'),
      };
    },
    exit: 0,
  },
  {
    n: 23,
    name: '--grep: two --paths globs give the union, and one glob given two times counts each file one time',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [PATHS_FILES] });
      let once = null;
      let twice = null;
      return {
        registry: registry({ 'transfer-service': entry(a) }),
        before: (hub, env) => {
          once = runScript(hub, env, ['transfer-service', '--grep', 'needle', '--paths', 'src/**/*.ts']);
          twice = runScript(hub, env, ['transfer-service', '--grep', 'needle', '--paths', 'src/**/*.ts', '--paths', 'src/**/*.ts']);
        },
        args: ['transfer-service', '--grep', 'needle', '--paths', 'src/*.ts', '--paths', 'test/*.ts'],
        expect: () => {
          const problems = [];
          for (const [label, res] of [['one glob', once], ['the glob two times', twice]]) {
            if (!res.stdout.includes('Scope: 2 files\nHits: 2\nFiles: 2\n')) problems.push(`${label}: not two files in scope and two hits: ${JSON.stringify(res.stdout)}`);
          }
          return problems;
        },
      };
    },
    exit: 0,
    includes: ['Scope: 2 files\n', 'Hits: 2\n', 'src/a.ts:1: needle\n', 'test/d.ts:1: needle\n'],
    excludes: ['src/b/c.ts'],
  },
  {
    n: 24,
    name: '--grep: no hit in a scope that holds files is an answer, exit 0',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [GREP_FILES] });
      return {
        registry: registry({ 'transfer-service': entry(a) }),
        args: ['transfer-service', '--grep', 'no-such-text'],
        expect: (out) => exactly(out, grepHeader(a.head, 'main', 'grep fixed "no-such-text" (binary files skipped)', 4, 0, 0, 'every hit')),
      };
    },
    exit: 0,
  },
  {
    n: 25,
    name: '--grep: a --paths glob that matches no file is exit 1, and the header still prints',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [GREP_FILES] });
      return {
        registry: registry({ 'transfer-service': entry(a) }),
        args: ['transfer-service', '--grep', 'x-request-id', '--paths', 'nothing/**'],
        expect: (out) => (out.startsWith(`Repository: transfer-service\nCommit: ${a.head}\nTrunk: main\n`) ? [] : ['the header does not print']),
      };
    },
    exit: 1,
    includes: ['Scope: 0 files\n', '---\n'],
  },
  {
    n: 26,
    name: '--grep over the cap: no hit lines, the counts most hits first and ties in path order, 100 files and a line for the rest',
    build: (root) => {
      const files = { 'zz/big.txt': 'needle\n'.repeat(150) };
      for (let i = 0; i < 100; i += 1) files[`many/f${String(i).padStart(3, '0')}.txt`] = 'needle\n';
      const a = makeRemote(root, 'transfer-service', { commits: [files] });
      const body = ['150 zz/big.txt'];
      for (let i = 0; i < 99; i += 1) body.push(`1 many/f${String(i).padStart(3, '0')}.txt`);
      body.push('1 more file not shown', '');
      return {
        registry: registry({ 'transfer-service': entry(a) }),
        args: ['transfer-service', '--grep', 'needle'],
        expect: (out) => exactly(out, grepHeader(a.head, 'main', 'grep fixed "needle" (binary files skipped)', 101, 250, 101, 'counts only: 250 hits is over the cap of 200') + body.join('\n')),
      };
    },
    exit: 0,
    excludes: ['.txt:1:'],
  },
  {
    n: 27,
    name: '--grep: a long line is cut at 300 characters with " [cut]", and a multi-byte character at the cut stays whole',
    build: (root) => {
      const long = `needle${'x'.repeat(394)}`;
      const accent = `needle${'a'.repeat(293)}é${'b'.repeat(50)}`;
      const a = makeRemote(root, 'transfer-service', { commits: [{ 'a.txt': `${long}\n`, 'b.txt': `${accent}\n` }] });
      return { registry: registry({ 'transfer-service': entry(a) }), args: ['transfer-service', '--grep', 'needle'] };
    },
    exit: 0,
    includes: [`a.txt:1: needle${'x'.repeat(294)} [cut]\n`, `b.txt:1: needle${'a'.repeat(293)}é [cut]\n`],
  },
  {
    n: 28,
    name: '--grep: a binary file that holds the text is not counted',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [{ 'blob.bin': Buffer.from('needle\0\x01\x02needle\n', 'binary'), 'text.txt': 'needle\n' }] });
      return { registry: registry({ 'transfer-service': entry(a) }), args: ['transfer-service', '--grep', 'needle'] };
    },
    exit: 0,
    includes: ['Scope: 2 files\n', 'Hits: 1\n', 'Files: 1\n', 'text.txt:1: needle\n'],
    excludes: ['blob.bin'],
  },
  {
    n: 29,
    name: '--grep: a path with a space and a non-ASCII name prints without quotes',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [{ 'src/a b/é.ts': 'needle here\n' }] });
      return { registry: registry({ 'transfer-service': entry(a) }), args: ['transfer-service', '--grep', 'needle'] };
    },
    exit: 0,
    includes: ['\nsrc/a b/é.ts:1: needle here\n'],
    excludes: ['"src/', '\\303'],
  },
  {
    n: 30,
    name: '--grep --at after the trunk moved: the search sees the pinned commit, not the new head',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [{ 'src/a.ts': 'old needle\n' }] });
      const pinned = a.head;
      return {
        registry: registry({ 'transfer-service': entry(a) }),
        before: (hub, env) => {
          const first = runScript(hub, env, ['transfer-service', '--grep', 'needle']);
          if (first.status !== 0) throw new Error(`warm-up search failed: ${first.stderr}`);
          advance(a, { 'src/a.ts': 'gone\n' });
        },
        args: ['transfer-service', '--grep', 'needle', '--at', pinned],
        expect: (out) => (out.includes(`Commit: ${pinned}\n`) ? [] : ['header does not name the pinned commit']),
      };
    },
    exit: 0,
    includes: ['Trunk: not asked\n', 'Hits: 1\n', 'src/a.ts:1: old needle\n'],
  },
  {
    n: 31,
    name: '--grep --regex with a bad pattern is a usage error, with git\'s message',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [GREP_FILES] });
      return { registry: registry({ 'transfer-service': entry(a) }), args: ['transfer-service', '--regex', '--grep', 'a('] };
    },
    exit: 3,
    includes: ['Unmatched ('],
  },
  ...[
    ['--grep with a <path>', ['transfer-service', 'src/a.ts', '--grep', 'x'], '--grep takes no <path>'],
    ['--grep with --files', ['transfer-service', '--grep', 'x', '--files', '*'], 'usage:'],
    ['--paths without --grep', ['transfer-service', 'README.md', '--paths', '*'], '--paths, --regex and --ignore-case need --grep'],
    ['a --paths glob that climbs', ['transfer-service', '--grep', 'x', '--paths', '../x'], 'must not climb'],
    ['a --paths glob that starts with ":"', ['transfer-service', '--grep', 'x', '--paths', ':(exclude)src'], 'must not start with'],
    ['a --paths glob that is absolute', ['transfer-service', '--grep', 'x', '--paths', '/src/*.ts'], 'must not start with'],
    ['a --paths glob with an empty segment', ['transfer-service', '--grep', 'x', '--paths', 'src//*.ts'], 'empty segment'],
    ['an empty --grep text', ['transfer-service', '--grep', ''], '--grep needs a text'],
    ['a --grep text with a newline', ['transfer-service', '--grep', 'a\nb'], 'one line'],
    ['a --grep text with a carriage return', ['transfer-service', '--grep', 'a\rb'], 'one line'],
    ['--grep given two times', ['transfer-service', '--grep', 'a', '--grep', 'b'], 'only one time'],
  ].map(([label, args, needle], i) => ({
    n: 32 + i,
    name: `--grep usage: ${label} is exit 3`,
    build: (root) => ({
      registry: registry({ 'transfer-service': { url: join(root, 'never-asked.git'), checks: 'checks.env', purpose: 'Never asked.', readAt: 'a'.repeat(40), trunk: 'default' } }),
      args,
    }),
    exit: 3,
    includes: [needle],
    excludes: ['cannot reach'],
  })),
  {
    n: 43,
    name: '--grep: an unreachable remote is exit 2',
    build: (root) => ({
      registry: registry({ 'transfer-service': { url: join(root, 'no-such-remote.git'), checks: 'checks.env', purpose: 'Gone.', readAt: 'a'.repeat(40), trunk: 'default' } }),
      args: ['transfer-service', '--grep', 'needle'],
    }),
    exit: 2,
    includes: ['CANNOT VERIFY: cannot reach', 'REASON: remote-unreachable'],
  },
  {
    n: 44,
    name: '--grep on a spoke whose trunk has no commands file yet works, the same as a read',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [{ 'src/a.ts': 'needle\n' }] });
      return { registry: registry({ 'transfer-service': entry(a) }), args: ['transfer-service', '--grep', 'needle'] };
    },
    exit: 0,
    includes: ['Trunk: main\n', 'Scope: 1 files\n', 'Hits: 1\n', 'src/a.ts:1: needle\n'],
  },
  {
    n: 45,
    name: '--files: the matching paths in path order, and "**/" also matches zero folders',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [{ ...PATHS_FILES, 'src/b/readme.md': 'x\n' }] });
      return {
        registry: registry({ 'transfer-service': entry(a) }),
        args: ['transfer-service', '--files', 'src/**/*.ts'],
        expect: (out) => exactly(out, [
          'Repository: transfer-service',
          `Commit: ${a.head}`,
          'Trunk: main',
          'Search: files src/**/*.ts',
          'Scope: 2 files',
          'Files: 2',
          'Shown: every path',
          '---',
          'src/a.ts',
          'src/b/c.ts',
          '',
        ].join('\n')),
      };
    },
    exit: 0,
    excludes: ['Hits:', 'Cite:'],
  },
  {
    n: 46,
    name: '--files: 501 paths give the count for each folder, most first and then in folder order',
    build: (root) => {
      const files = {};
      const put = (folder, count) => {
        for (let i = 0; i < count; i += 1) files[`gen/${folder}/f${String(i).padStart(3, '0')}.ts`] = 'x\n';
      };
      put('a', 300);
      put('b', 150);
      put('e', 25);
      put('c', 25);
      put('d', 1);
      files['gen/top.ts'] = 'x\n';
      const a = makeRemote(root, 'transfer-service', { commits: [files] });
      return {
        registry: registry({ 'transfer-service': entry(a) }),
        args: ['transfer-service', '--files', 'gen/**'],
        expect: (out) => exactly(out, [
          'Repository: transfer-service',
          `Commit: ${a.head}`,
          'Trunk: main',
          'Search: files gen/**',
          'Scope: 502 files',
          'Files: 502',
          'Shown: counts only: 502 paths is over the cap of 500',
          '---',
          '300 gen/a/',
          '150 gen/b/',
          '25 gen/c/',
          '25 gen/e/',
          '1 gen/',
          '1 gen/d/',
          '',
        ].join('\n')),
      };
    },
    exit: 0,
  },
  {
    n: 47,
    name: '--files: a glob that matches no file is exit 1, and the header prints with Scope: 0',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [GREP_FILES] });
      return {
        registry: registry({ 'transfer-service': entry(a) }),
        args: ['transfer-service', '--files', 'nothing/*'],
        expect: (out) => exactly(out, grepHeader(a.head, 'main', 'files nothing/*', 0, 0, 0, 'every path')
          .replace('Hits: 0\n', '')),
      };
    },
    exit: 1,
  },
  ...[
    ['--files with a <path>', ['transfer-service', 'src/a.ts', '--files', '*'], '--files takes no <path>'],
    ['--files with --grep', ['transfer-service', '--files', '*', '--grep', 'x'], 'usage:'],
    ['--files with --paths', ['transfer-service', '--files', '*', '--paths', 'src/*'], '--paths, --regex and --ignore-case need --grep'],
    ['--files with --regex', ['transfer-service', '--files', '*', '--regex'], '--paths, --regex and --ignore-case need --grep'],
    ['--files given two times', ['transfer-service', '--files', 'a', '--files', 'b'], 'only one time'],
    ['--files without a glob', ['transfer-service', '--files'], '--files needs a value'],
    ['--files with a glob that climbs', ['transfer-service', '--files', '../x'], 'must not climb'],
    ['--files with a glob that starts with ":"', ['transfer-service', '--files', ':(exclude)src'], 'must not start with'],
  ].map(([label, args, needle], i) => ({
    n: 48 + i,
    name: `--files usage: ${label} is exit 3`,
    build: (root) => ({
      registry: registry({ 'transfer-service': { url: join(root, 'never-asked.git'), checks: 'checks.env', purpose: 'Never asked.', readAt: 'a'.repeat(40), trunk: 'default' } }),
      args,
    }),
    exit: 3,
    includes: [needle],
    excludes: ['cannot reach'],
  })),
  {
    n: 56,
    name: '--requests: grep, files and two reads print in order, each with its Exit: line, and the missing read is Exit: 1',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [REQUEST_FILES] });
      return {
        registry: registry({ 'transfer-service': entry(a) }),
        before: (hub) => writeFileSync(join(hub, 'reply.md'), REQUEST_REPLY),
        args: ['transfer-service', '--requests', 'reply.md', '--at', a.head],
        expect: (out) => exactly(out, requestRound(a)),
      };
    },
    exit: 0,
  },
  {
    n: 57,
    name: '--requests: a reply with CRLF line ends gives the same output as LF',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [REQUEST_FILES] });
      return {
        registry: registry({ 'transfer-service': entry(a) }),
        before: (hub) => writeFileSync(join(hub, 'reply.md'), REQUEST_REPLY.split('\n').join('\r\n')),
        args: ['transfer-service', '--requests', 'reply.md', '--at', a.head],
        expect: (out) => exactly(out, requestRound(a)),
      };
    },
    exit: 0,
  },
  {
    n: 58,
    name: '--requests: text after the blank line that ends the block is ignored, also a "- read" line',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [REQUEST_FILES] });
      return {
        registry: registry({ 'transfer-service': entry(a) }),
        before: (hub) => writeFileSync(join(hub, 'reply.md'), '### REQUESTS\n- read "src/a.ts"\n\nAfter the block.\n- read "x"\n'),
        args: ['transfer-service', '--requests', 'reply.md', '--at', a.head],
      };
    },
    exit: 0,
    includes: ['Request 1 of 1: read "src/a.ts"\nExit: 0\n', 'Path: src/a.ts\n'],
    excludes: ['Request 2', 'NOT FOUND', 'of 2'],
  },
  {
    n: 59,
    name: '--requests: every bad line and a verdict are named with line numbers in one run, exit 3, and nothing runs',
    build: (root) => ({
      registry: registry({ 'transfer-service': NEVER_ASKED(root) }),
      before: (hub) => writeFileSync(join(hub, 'reply.md'), [
        'Three requests.',
        '',
        '### REQUESTS',
        '- grep "unclosed',
        '- find "x"',
        '- files "*" --regex',
        '',
        '### VERDICT: APPROVED',
        '',
      ].join('\n')),
      args: ['transfer-service', '--requests', 'reply.md', '--at', 'a'.repeat(40)],
    }),
    exit: 3,
    includes: ['line 4: ', 'unclosed', 'line 5: ', 'unknown kind "find"', 'line 6: ', '--regex applies to grep only', 'line 8: ', 'VERDICT'],
    excludes: ['cannot reach', 'Request 1', 'Exit:'],
  },
  ...[
    ['a reply with no block', 'No requests here.\n', 'no "### REQUESTS" block'],
    ['a reply with two blocks', '### REQUESTS\n- read "a"\n\n### REQUESTS\n- read "b"\n', 'line 4: a second "### REQUESTS" block'],
    ['a block with 11 requests', `### REQUESTS\n${Array.from({ length: 11 }, (_, i) => `- read "f${i}.ts"\n`).join('')}`, '11 requests, over the cap of 10'],
    ['a block with no request', '### REQUESTS\n\n- read "a"\n', 'line 1: the block holds no request'],
    ['a block line that does not start with "- "', '### REQUESTS\n* read "a"\n', 'line 2: a request line starts with "- "'],
    ['an unknown flag on a grep line', '### REQUESTS\n- grep "a" --word\n', 'line 2: unknown flag --word'],
    ['--regex given two times', '### REQUESTS\n- grep "a" --regex --regex\n', 'line 2: --regex can occur only one time'],
    ['--paths without a glob', '### REQUESTS\n- grep "a" --paths\n', 'line 2: --paths needs a glob'],
    ['trailing text after the operands', '### REQUESTS\n- read "a" "b"\n', 'line 2: unexpected "b" after the operands'],
    ['an operand that is not a JSON string', '### REQUESTS\n- files src/*.ts\n', 'line 2: the glob must be a JSON string'],
    ['a bad escape in a JSON string', '### REQUESTS\n- grep "a\\q"\n', 'line 2: '],
    ['a read path that climbs', '### REQUESTS\n- read "../hub/secret"\n', 'line 2: path must not climb'],
    ['a glob that climbs', '### REQUESTS\n- grep "a" --paths "../x"\n', 'line 2: a glob must not climb'],
    ['an empty grep text', '### REQUESTS\n- grep ""\n', 'line 2: --grep needs a text'],
    ['a grep with no text', '### REQUESTS\n- grep\n', 'line 2: grep needs a text'],
    ['a NUL character in a string', '### REQUESTS\n- read "a\\u0000"\n', 'line 2: a string must not hold a NUL character'],
  ].map(([label, reply, needle], i) => ({
    n: 60 + i,
    name: `--requests refusal: ${label} is exit 3, and nothing runs`,
    build: (root) => ({
      registry: registry({ 'transfer-service': NEVER_ASKED(root) }),
      before: (hub) => writeFileSync(join(hub, 'reply.md'), reply),
      args: ['transfer-service', '--requests', 'reply.md', '--at', 'a'.repeat(40)],
    }),
    exit: 3,
    includes: [needle],
    excludes: ['cannot reach', 'Request 1', 'Exit:'],
  })),
  ...[
    ['--requests without --at', ['transfer-service', '--requests', 'reply.md'], '--requests needs --at'],
    ['--requests with a <path>', ['transfer-service', 'src/a.ts', '--requests', 'reply.md', '--at', 'a'.repeat(40)], '--requests takes no <path>'],
    ['--requests with --grep', ['transfer-service', '--requests', 'reply.md', '--grep', 'x', '--at', 'a'.repeat(40)], '--requests excludes'],
    ['--requests with --files', ['transfer-service', '--requests', 'reply.md', '--files', '*', '--at', 'a'.repeat(40)], '--requests excludes'],
    ['--requests with --paths', ['transfer-service', '--requests', 'reply.md', '--paths', 'src/*', '--at', 'a'.repeat(40)], '--requests excludes'],
    ['--requests with --regex', ['transfer-service', '--requests', 'reply.md', '--regex', '--at', 'a'.repeat(40)], '--requests excludes'],
    ['--requests with --ignore-case', ['transfer-service', '--requests', 'reply.md', '--ignore-case', '--at', 'a'.repeat(40)], '--requests excludes'],
    ['--requests given two times', ['transfer-service', '--requests', 'reply.md', '--requests', 'reply.md', '--at', 'a'.repeat(40)], 'only one time'],
    ['--requests with a file that does not exist', ['transfer-service', '--requests', 'no-such-reply.md', '--at', 'a'.repeat(40)], 'cannot read the requests file'],
  ].map(([label, args, needle], i) => ({
    n: 76 + i,
    name: `--requests usage: ${label} is exit 3`,
    build: (root) => ({
      registry: registry({ 'transfer-service': NEVER_ASKED(root) }),
      before: (hub) => writeFileSync(join(hub, 'reply.md'), '### REQUESTS\n- read "a"\n'),
      args,
    }),
    exit: 3,
    includes: [needle],
    excludes: ['cannot reach', 'Request 1'],
  })),
  {
    n: 85,
    name: '--requests: an unreachable remote is exit 2, checked one time before any request runs',
    build: (root) => ({
      registry: registry({ 'transfer-service': { url: join(root, 'no-such-remote.git'), checks: 'checks.env', purpose: 'Gone.', readAt: 'a'.repeat(40), trunk: 'default' } }),
      before: (hub) => writeFileSync(join(hub, 'reply.md'), '### REQUESTS\n- read "a"\n- files "*"\n'),
      args: ['transfer-service', '--requests', 'reply.md', '--at', 'a'.repeat(40)],
    }),
    exit: 2,
    includes: ['CANNOT VERIFY: '],
    excludes: ['Request 1', 'Exit:'],
  },
  {
    n: 86,
    name: '--requests: a request that git refuses prints Exit: 3 in its result, and the round still exits 0',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [REQUEST_FILES] });
      return {
        registry: registry({ 'transfer-service': entry(a) }),
        before: (hub) => writeFileSync(join(hub, 'reply.md'), '### REQUESTS\n- grep "a(" --regex\n- files "src/*.ts"\n'),
        args: ['transfer-service', '--requests', 'reply.md', '--at', a.head],
      };
    },
    exit: 0,
    includes: ['Request 1 of 2: grep "a(" --regex\nExit: 3\n', '\n\nRequest 2 of 2: files "src/*.ts"\nExit: 0\n', 'src/server.ts\n'],
  },
  {
    n: 87,
    name: 'Orca guard: no RegExp is built from an argument in read-spoke.mjs or spoke-search.mjs',
    scan: true,
    exit: 0,
  },
  {
    n: 88,
    name: '--requests: a read of a 401-line file prints 400 lines and "[cut: 1 more lines]", and the header keeps Lines: 401',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [{ ...REQUEST_FILES, ...CAP_FILES }] });
      const blob = git(a.work, ['rev-parse', `${a.head}:long.txt`]).trim();
      return {
        registry: registry({ 'transfer-service': entry(a) }),
        before: (hub) => writeFileSync(join(hub, 'reply.md'), '### REQUESTS\n- read "long.txt"\n'),
        args: ['transfer-service', '--requests', 'reply.md', '--at', a.head],
        expect: (out) => exactly(out, [
          'Request 1 of 1: read "long.txt"',
          'Exit: 0',
          'Repository: transfer-service',
          `Commit: ${a.head}`,
          'Trunk: not asked',
          'Path: long.txt',
          `Blob: ${blob}`,
          'Lines: 401',
          `Cite: transfer-service@${a.head.slice(0, 12)}:long.txt`,
          '---',
          ...LONG_LINES.slice(0, 400),
          '[cut: 1 more lines]',
          '',
        ].join('\n')),
      };
    },
    exit: 0,
  },
  {
    n: 89,
    name: '--requests: a read cuts a line over 300 characters with " [cut]", as a hit line',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [{ ...REQUEST_FILES, ...CAP_FILES }] });
      return {
        registry: registry({ 'transfer-service': entry(a) }),
        before: (hub) => writeFileSync(join(hub, 'reply.md'), '### REQUESTS\n- read "wide.txt"\n'),
        args: ['transfer-service', '--requests', 'reply.md', '--at', a.head],
        expect: (out) => {
          const body = out.split('---\n')[1];
          const want = `short\n${'w'.repeat(300)} [cut]\nend\n`;
          return body === want ? [] : [`body is not the cut file.\n            want: ${JSON.stringify(want)}\n            got:  ${JSON.stringify(body)}`];
        },
      };
    },
    exit: 0,
    includes: ['\nLines: 3\n'],
  },
  {
    n: 90,
    name: '--requests: a read of a binary file prints the header and "[binary file not shown]", and no byte of the file',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [{ ...REQUEST_FILES, ...CAP_FILES }] });
      return {
        registry: registry({ 'transfer-service': entry(a) }),
        before: (hub) => writeFileSync(join(hub, 'reply.md'), '### REQUESTS\n- read "logo.bin"\n- read "src/a.ts"\n'),
        args: ['transfer-service', '--requests', 'reply.md', '--at', a.head],
        expect: (out) => {
          const first = out.split('\n\nRequest 2 of 2')[0];
          const want = `Cite: transfer-service@${a.head.slice(0, 12)}:logo.bin\n---\n[binary file not shown]`;
          return first.endsWith(want) ? [] : [`the binary result does not end with the marker.\n            got:  ${JSON.stringify(first)}`];
        },
      };
    },
    exit: 0,
    includes: ['Path: logo.bin\n', '\nLines: 2\n', 'Request 2 of 2: read "src/a.ts"\nExit: 0\n', 'export const a = 1;\n'],
    excludes: ['\u0000', 'PNG'],
  },
  ...[
    ['the 401-line file prints every line', 'long.txt', `${LONG_LINES.join('\n')}\n`],
    ['the line over 300 characters prints whole', 'wide.txt', CAP_FILES['wide.txt']],
    ['the binary file prints byte for byte', 'logo.bin', CAP_FILES['logo.bin']],
  ].map(([label, path, want], i) => ({
    n: 91 + i,
    name: `a plain read outside a round has no cap: ${label}`,
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [{ ...REQUEST_FILES, ...CAP_FILES }] });
      return {
        registry: registry({ 'transfer-service': entry(a) }),
        args: ['transfer-service', path, '--at', a.head],
        expect: (out) => {
          const body = out.slice(out.indexOf('---\n') + 4);
          return body === want ? [] : [`body is not the file byte for byte: ${JSON.stringify(body.slice(0, 200))}`];
        },
      };
    },
    exit: 0,
    excludes: ['[cut', '[binary file not shown]'],
  })),
  {
    n: 94,
    name: '--at with the 12-character prefix of the trunk head reads that commit and prints the full commit',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [{ 'README.md': README_V1 }] });
      return {
        registry: registry({ 'transfer-service': entry(a) }),
        args: ['transfer-service', 'README.md', '--at', a.head.slice(0, 12)],
        expect: (out) => {
          const problems = [];
          if (!out.includes(`\nCommit: ${a.head}\n`)) problems.push('header does not name the full commit');
          if (!out.includes(`Cite: transfer-service@${a.head.slice(0, 12)}:README.md`)) problems.push('no Cite line with the short commit');
          if (out.split('---\n')[1] !== README_V1) problems.push('body is not the file');
          return problems;
        },
      };
    },
    exit: 0,
    includes: ['Trunk: not asked'],
  },
  {
    n: 95,
    name: '--at with the prefix of an older commit after a push reads the old file, prints what the full commit prints, and the cache gets no filter',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [{ 'README.md': README_V1 }] });
      const pinned = a.head;
      let full = null;
      return {
        registry: registry({ 'transfer-service': entry(a) }),
        before: (hub, env) => {
          advance(a, { 'README.md': README_V2 });
          full = runScript(hub, { ...env, HARNESS_SPOKE_CACHE: join(root, 'cache-full') }, ['transfer-service', 'README.md', '--at', pinned]);
        },
        args: ['transfer-service', 'README.md', '--at', pinned.slice(0, 12)],
        expect: (out) => [
          ...(full.status === 0 ? [] : [`the read with the full commit failed: ${full.stderr}`]),
          ...exactly(out, full.stdout),
          ...(out.split('---\n')[1] === README_V1 ? [] : ['body is not the file as it was at the older commit']),
          ...cacheHasNoFilter(join(root, 'cache', 'transfer-service.git')),
        ],
      };
    },
    exit: 0,
  },
  {
    n: 96,
    name: '--at with a prefix that matches no commit on the trunk is exit 2, and the message names the prefix',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [{ 'README.md': README_V1 }] });
      return { registry: registry({ 'transfer-service': entry(a) }), args: ['transfer-service', 'README.md', '--at', '0123456789ab'] };
    },
    exit: 2,
    includes: ['CANNOT VERIFY: --at 0123456789ab matches no commit', 'REASON: commit-not-found'],
    excludes: ['Repository:'],
  },
  {
    n: 97,
    name: '--at with the prefix of a blob, not a commit, is exit 2: only a commit counts',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [{ 'README.md': README_V1 }] });
      const blob = git(a.work, ['rev-parse', `${a.head}:README.md`]).trim();
      return { registry: registry({ 'transfer-service': entry(a) }), args: ['transfer-service', 'README.md', '--at', blob.slice(0, 12)] };
    },
    exit: 2,
    includes: ['matches no commit', 'REASON: commit-not-found'],
  },
  {
    n: 98,
    name: '--requests with the 12-character prefix runs every request at the full commit',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [REQUEST_FILES] });
      return {
        registry: registry({ 'transfer-service': entry(a) }),
        before: (hub) => writeFileSync(join(hub, 'reply.md'), REQUEST_REPLY),
        args: ['transfer-service', '--requests', 'reply.md', '--at', a.head.slice(0, 12)],
        expect: (out) => exactly(out, requestRound(a)),
      };
    },
    exit: 0,
  },
  ...[
    ['11 characters', 'abcdef01234'],
    ['13 characters', 'abcdef0123456'],
    ['upper case', 'ABCDEF012345'],
  ].map(([label, value], i) => ({
    n: 99 + i,
    name: `a --at value of ${label} is a usage error, before any remote is asked`,
    build: (root) => ({ registry: registry({ 'transfer-service': NEVER_ASKED(root) }), args: ['transfer-service', 'README.md', '--at', value] }),
    exit: 3,
    includes: ['--at must be a full 40-character commit hash or its first 12 characters', value],
    excludes: ['cannot reach'],
  })),
  {
    n: 102,
    name: '--at with a prefix, from a remote that honours a filter: the history repository holds commits and no tree, and the cache gets no filter',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [{ 'README.md': README_V1 }] });
      git(root, ['--git-dir', a.bare, 'config', 'uploadpack.allowFilter', 'true']);
      const pinned = a.head;
      return {
        registry: registry({ 'transfer-service': { ...entry(a), url: `file://${a.bare}` } }),
        before: () => advance(a, { 'README.md': README_V2 }),
        args: ['transfer-service', 'README.md', '--at', pinned.slice(0, 12)],
        expect: (out) => {
          const history = join(root, 'cache', 'history', 'transfer-service.git');
          const problems = [...cacheHasNoFilter(join(root, 'cache', 'transfer-service.git'))];
          if (!out.includes(`\nCommit: ${pinned}\n`) || out.split('---\n')[1] !== README_V1) problems.push('the read is not the older commit');
          if (!readFileSync(join(history, 'config'), 'utf8').includes('partialclonefilter = tree:0')) problems.push('the history repository was not fetched with --filter=tree:0');
          const tree = spawnSync('git', ['--git-dir', history, 'cat-file', '-e', `${pinned}^{tree}`], { env: { ...ENV, GIT_NO_LAZY_FETCH: '1' } });
          if (tree.status === 0) problems.push('the history repository holds a tree; it must hold commits only');
          return problems;
        },
      };
    },
    exit: 0,
  },
  {
    n: 103,
    name: '--at with a prefix: eight reads of one spoke at the same time, cold and then warm, all exit 0 and print what the full commit prints',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [{ 'README.md': README_V1 }] });
      const pinned = a.head;
      let full = null;
      let cold = null;
      let warm = null;
      return {
        registry: registry({ 'transfer-service': entry(a) }),
        before: (hub, env) => {
          advance(a, { 'README.md': README_V2 });
          full = runScript(hub, { ...env, HARNESS_SPOKE_CACHE: join(root, 'cache-full') }, ['transfer-service', 'README.md', '--at', pinned]);
          cold = runParallel(hub, env, ['transfer-service', 'README.md', '--at', pinned.slice(0, 12)], 8);
          warm = runParallel(hub, env, ['transfer-service', 'README.md', '--at', pinned.slice(0, 12)], 8);
        },
        args: ['transfer-service', 'README.md', '--at', pinned.slice(0, 12)],
        expect: (out) => [
          ...exactly(out, full.stdout),
          ...allPassed('cold', cold, full.stdout),
          ...allPassed('warm', warm, full.stdout),
        ],
      };
    },
    exit: 0,
  },
  {
    n: 104,
    name: '--at with a prefix and a declared trunk: the prefix resolves on that branch, and a warm read asks no remote',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', {
        commits: [{ 'README.md': README_V1, 'checks.env': 'TRUNK_FOR_HUB=default\n' }],
        branch: { name: 'bcg_main', commits: [{ 'README.md': README_V2, 'checks.env': 'TRUNK_FOR_HUB=bcg_main\n' }] },
      });
      const moved = join(root, 'moved-away.git');
      return {
        registry: registry({ 'transfer-service': { ...entry(a), trunk: 'bcg_main', readAt: a.branchHead } }),
        before: (hub, env) => {
          const first = runScript(hub, env, ['transfer-service', 'README.md', '--at', a.branchHead.slice(0, 12)]);
          if (first.status !== 0) throw new Error(`the cold read failed: ${first.stderr}`);
          // The remote goes away. A warm read must resolve and read from the two
          // local repositories alone.
          renameSync(a.bare, moved);
        },
        args: ['transfer-service', 'README.md', '--at', a.branchHead.slice(0, 12)],
        expect: (out) => [
          ...(out.includes(`\nCommit: ${a.branchHead}\n`) ? [] : ['header does not name the declared trunk commit']),
          ...(out.split('---\n')[1] === README_V2 ? [] : ['body is not the file on the declared trunk']),
        ],
      };
    },
    exit: 0,
  },
  {
    n: 105,
    name: '--at with the prefix of a commit that is only on another branch is exit 2',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', {
        commits: [{ 'README.md': README_V1, 'checks.env': 'TRUNK_FOR_HUB=default\n' }],
        branch: { name: 'feature-x', commits: [{ 'README.md': README_V2 }] },
      });
      return { registry: registry({ 'transfer-service': entry(a) }), args: ['transfer-service', 'README.md', '--at', a.branchHead.slice(0, 12)] };
    },
    exit: 2,
    includes: [`matches no commit on main`, 'REASON: commit-not-found'],
  },
  {
    n: 106,
    name: '--grep: a fixed text with "\\|" and no hit prints a Note that names --regex',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [{ 'src/id.ts': 'getPath();\ngetUri();\n' }] });
      return { registry: registry({ 'transfer-service': entry(a) }), args: ['transfer-service', '--grep', 'getPath\\|getUri'] };
    },
    exit: 0,
    includes: ['Hits: 0\nFiles: 0\nShown: every hit\nNote: a fixed search reads "|" and "\\|" as text. To find one of several texts, search again with --regex and join them with "|".\n---\n'],
  },
  {
    n: 107,
    name: '--grep: a fixed text with "|" that has a hit prints no Note',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [{ 'src/t.ts': 'type T = string | null;\n' }] });
      return { registry: registry({ 'transfer-service': entry(a) }), args: ['transfer-service', '--grep', 'string | null'] };
    },
    exit: 0,
    includes: ['Hits: 1\n', 'src/t.ts:1: type T = string | null;\n'],
    excludes: ['Note:'],
  },
  {
    n: 108,
    name: '--grep --regex with "|" and no hit prints no Note',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [{ 'src/t.ts': 'nothing here\n' }] });
      return { registry: registry({ 'transfer-service': entry(a) }), args: ['transfer-service', '--grep', 'getPath|getUri', '--regex'] };
    },
    exit: 0,
    includes: ['Hits: 0\n'],
    excludes: ['Note:'],
  },
  {
    n: 109,
    name: 'a cache folder that is no longer a repository, as macOS leaves it after it cleans the temp directory, is made again and the read passes',
    build: (root) => {
      const a = makeRemote(root, 'transfer-service', { commits: [{ 'README.md': README_V1, 'checks.env': 'TEST_COMMAND=npm test\nTRUNK_FOR_HUB=default\n' }] });
      return {
        registry: registry({ 'transfer-service': entry(a) }),
        args: ['transfer-service', 'README.md'],
        // The folders of a bare repository stay, and HEAD and config are gone.
        before: (hub, env) => {
          for (const sub of ['objects', 'refs', 'hooks', 'info']) mkdirSync(join(env.HARNESS_SPOKE_CACHE, 'transfer-service.git', sub), { recursive: true });
          writeFileSync(join(env.HARNESS_SPOKE_CACHE, 'transfer-service.git', 'FETCH_HEAD'), '');
        },
        expect: (out) => (out.split('---\n')[1] === README_V1 ? [] : ['body is not the file']),
      };
    },
    exit: 0,
    includes: ['Repository: transfer-service', 'Trunk: main'],
    excludes: ['not a git repository'],
  },
];

/* ---------------------------------------------------------------------- runner */

function runFixture(fixture) {
  if (fixture.scan) {
    const problems = [];
    for (const file of [SCRIPT, SEARCH_MODULE]) {
      if (!existsSync(file)) { problems.push(`cannot read ${file}`); continue; }
      problems.push(...regExpCallProblems(file, readFileSync(file, 'utf8')));
    }
    return { problems, output: '' };
  }
  const root = mkdtempSync(join(tmpdir(), `spoke-fx${String(fixture.n).padStart(2, '0')}-`));
  try {
    const hub = join(root, 'hub');
    mkdirSync(join(hub, 'docs', 'estate'), { recursive: true });
    const built = fixture.build(root);
    if (built.registry !== null) writeFileSync(join(hub, 'docs', 'estate', 'repositories.json'), built.registry);
    const env = { ...ENV, HARNESS_SPOKE_CACHE: join(root, 'cache') };
    if (built.before) built.before(hub, env);
    const res = spawnSync(process.execPath, [SCRIPT, ...built.args], { cwd: hub, env, encoding: 'utf8' });
    const output = `${res.stdout || ''}${res.stderr || ''}`;
    const problems = [];
    if (res.status !== fixture.exit) problems.push(`expected exit ${fixture.exit}, got ${res.status}`);
    for (const needle of fixture.includes || []) {
      if (!output.includes(needle)) problems.push(`output does not contain: ${needle}`);
    }
    for (const needle of fixture.excludes || []) {
      if (output.includes(needle)) problems.push(`output should not contain: ${needle}`);
    }
    if (built.expect) problems.push(...built.expect(res.stdout || ''));
    return { problems, output };
  } catch (err) {
    return { problems: [`fixture setup failed: ${err && err.message ? err.message : String(err)}`], output: '' };
  } finally {
    if (!process.argv.includes('--keep')) rmSync(root, { recursive: true, force: true });
  }
}

function main() {
  const wanted = process.argv.slice(2).filter((a) => /^\d+$/.test(a)).map(Number);
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
    ? `\n${failed} of ${selected.length} fixtures FAILED. The spoke read is not trustworthy until this is green.\n`
    : `\nAll ${selected.length} fixtures passed.\n`);
  rmSync(SANDBOX_HOME, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
}

main();

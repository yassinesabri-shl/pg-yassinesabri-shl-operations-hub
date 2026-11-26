#!/usr/bin/env node
/**
 * run.mjs — the fixture suite for read-global.mjs: --resolve,
 * --exceptions <repo-id>, the warning /add-repo prints, and --connect <url>,
 * what /check-global --connect reads before it writes the link file.
 *
 *   usage:  node run.mjs            run every fixture
 *           node run.mjs 2 6        run only the numbered fixtures
 *           node run.mjs --keep     leave the throwaway repositories on disk
 *
 * A fixture is a REPOSITORY STATE: a throwaway hub folder with its
 * `docs/estate/global.json`, a real bare global remote with a trunk and tags,
 * and the shipped script run from the hub exactly as /feature would run it.
 * The exit code and the output text are asserted. Fixture 1 is the valid
 * control. Most others change one thing. Every fixture runs under a private
 * HOME, so a developer's gitconfig cannot change a result, and with its own
 * bare cache, so no fixture reads another's.
 *
 * Node standard library only, plus git via child_process. No test framework.
 * Exit 0 if every fixture passes, 1 if any fails.
 */

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

const SCRIPT = [
  process.env.HARNESS_READ_GLOBAL,
  resolve(HERE, '..', '..', 'read-global.mjs'),
  resolve(HERE, '..', '..', 'scripts', 'read-global.mjs'),
].filter(Boolean).find((p) => existsSync(p));

if (!SCRIPT) {
  console.error('cannot locate read-global.mjs. Set HARNESS_READ_GLOBAL=/path/to/read-global.mjs.');
  process.exit(4);
}

/* ------------------------------------------------------------------ git helpers */

const SANDBOX_HOME = mkdtempSync(join(tmpdir(), 'readglobal-home-'));
const ENV = {
  ...process.env,
  HOME: SANDBOX_HOME,
  XDG_CONFIG_HOME: join(SANDBOX_HOME, '.config'),
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
  GIT_ASKPASS: 'true',
};
delete ENV.HARNESS_GLOBAL;

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

/**
 * A bare global remote whose HEAD names `trunk`, and a work clone that pushes
 * to it. Each element of `commits` is one commit's files on the trunk.
 */
function makeGlobal(root, { trunk = 'main', commits = [RECORD(1)] } = {}) {
  const bare = join(root, 'global-context.git');
  const work = join(root, 'global-context-work');
  git(root, ['init', '--bare', '-q', '--initial-branch', trunk, bare]);
  git(root, ['--git-dir', bare, 'symbolic-ref', 'HEAD', `refs/heads/${trunk}`]);
  git(root, ['init', '-q', '--initial-branch', trunk, work]);
  git(work, ['config', 'user.name', 'Fixture Runner']);
  git(work, ['config', 'user.email', 'fixture@example.invalid']);
  git(work, ['config', 'commit.gpgsign', 'false']);
  git(work, ['config', 'tag.gpgsign', 'false']);
  const shas = [];
  commits.forEach((files, i) => {
    writeFiles(work, files);
    git(work, ['add', '-A']);
    git(work, ['commit', '-q', '-m', `commit ${i + 1}`]);
    shas.push(git(work, ['rev-parse', 'HEAD']).trim());
  });
  git(work, ['push', '-q', bare, trunk]);
  return { url: bare, bare, work, trunk, shas };
}

/** Tag a commit in the work clone and push only the tag. */
function tag(remote, name, at, { annotated = false } = {}) {
  git(remote.work, annotated ? ['tag', '-a', '-m', `release ${name}`, name, at] : ['tag', name, at]);
  git(remote.work, ['push', '-q', remote.bare, `refs/tags/${name}`]);
}

/** One commit on a branch beside the trunk, never merged. Returns its hash. */
function sideCommit(remote, branch, files, { push = false } = {}) {
  git(remote.work, ['checkout', '-q', '-b', branch, remote.shas[remote.shas.length - 1]]);
  writeFiles(remote.work, files);
  git(remote.work, ['add', '-A']);
  git(remote.work, ['commit', '-q', '-m', `on ${branch}`]);
  const sha = git(remote.work, ['rev-parse', 'HEAD']).trim();
  if (push) git(remote.work, ['push', '-q', remote.bare, branch]);
  git(remote.work, ['checkout', '-q', remote.trunk]);
  return sha;
}

/** One more commit on the trunk, pushed. Returns its hash. */
function advance(remote, files) {
  writeFiles(remote.work, files);
  git(remote.work, ['add', '-A']);
  git(remote.work, ['commit', '-q', '-m', 'later']);
  git(remote.work, ['push', '-q', remote.bare, remote.trunk]);
  const sha = git(remote.work, ['rev-parse', 'HEAD']).trim();
  remote.shas.push(sha);
  return sha;
}

/**
 * A git host that asks every client for a credential: an HTTP server, in its
 * own process because the script under test runs synchronously, that answers
 * 401 with a Basic challenge. Git with its prompts off then fails as it does on
 * GitHub when it has no credential for the host. Returns { url, stop }.
 */
function askingHost(root) {
  const script = join(root, 'asking-host.cjs');
  const portFile = join(root, 'asking-host.port');
  writeFileSync(script, [
    "const http = require('node:http');",
    "const server = http.createServer((req, res) => { res.writeHead(401, { 'WWW-Authenticate': 'Basic realm=\"global\"' }); res.end(); });",
    "server.listen(0, '127.0.0.1', () => require('node:fs').writeFileSync(process.argv[2], String(server.address().port)));",
  ].join('\n'));
  const child = spawn(process.execPath, [script, portFile], { stdio: 'ignore' });
  const pause = new Int32Array(new SharedArrayBuffer(4));
  for (let waited = 0; !existsSync(portFile) && waited < 10000; waited += 50) Atomics.wait(pause, 0, 0, 50);
  if (!existsSync(portFile)) { child.kill(); throw new Error('the asking host did not start'); }
  return { url: `http://127.0.0.1:${readFileSync(portFile, 'utf8')}/acme/global-context.git`, stop: () => child.kill() };
}

/* -------------------------------------------------------------- the content */

// One file of the global repository per commit, so each commit differs. The
// script reads no document, so the bytes only need to be distinct.
const RECORD = (n) => ({ [`docs/architecture/ADR-${String(n).padStart(3, '0')}-record.md`]: `# ADR-${String(n).padStart(3, '0')}: record ${n}\n` });

const link = (url, extra = {}) => `${JSON.stringify({ schema_version: 1, url, ...extra }, null, 2)}\n`;

// For --exceptions: a global record and an exception that parse, in the shape
// docs/proposals/global-context.md §9.3 gives.
const REDIS_ONLY = {
  'docs/architecture/ADR-012-redis-only.md': `---\nname: ADR-012\ndescription: Use only Redis for caching\nglobs: ["**/cache/**"]\nalwaysApply: false\nkind: adr\nstatus: Accepted\nowner: Global Architecture Board\nrevision: v1\norigin: architecture board minutes\n---\n\n${[
    '# ADR-012: Use only Redis for caching', '', '## Decision', '', 'Every cache is Redis.', '', '## Rules', '', '- MUST cache in Redis.', '',
    '## Why', '', 'One cache to run.', '', '## Rejected', '', '- Memcached — because two caches cost more.', '', '## Accepted costs', '', '- None.', '',
  ].join('\n')}`,
};
const EXCEPTION = ({ n = '004', hubs = '["SIM"]', repositories = '["sim-desktop", "auth-service"]', status = 'Active' } = {}) => ({
  [`docs/exceptions/EXC-${n}-offline-cache.md`]: `---\n${[
    `name: EXC-${n}`, 'description: The desktop simulator keeps an in-process cache instead of Redis, because it runs offline.', 'kind: exception',
    `hubs: ${hubs}`, `repositories: ${repositories}`, 'departs: ["ADR-012"]', `status: ${status}`, 'review-by: 2027-04-01',
    'owner: desktop simulator tech lead', 'approver: Global Architecture Board', 'revision: v1', 'origin: this repository',
  ].join('\n')}\n---\n\n${[
    `# EXC-${n} — the desktop simulator's offline cache`, '', '## Reason', '', 'No Redis is reachable in an exam room.', '',
    '## Scope', '', 'Only the session cache.', '', '## Alternatives considered', '', '- Embedded Redis. Rejected: it adds 40 MB.', '',
    '## What the product does instead', '', 'SIM hub record ADR-031 states the decision.', '', '## Exit', '', 'A network mode in exam rooms.', '',
  ].join('\n')}`,
});
const KEYS = (prefix) => ({ 'docs/backlog/keys.json': `${JSON.stringify({ prefix, next: 1 })}\n` });

/* ------------------------------------------------------------------- fixtures */

// `build(root)` returns { global, args?, hubFiles?, before?, expect? }. `global`
// is the text of docs/estate/global.json, or null for a hub without one.
// `hubFiles` are written into the hub, as its key ledger.
// `before(hub, env)` runs before the script. `expect(stdout, hub)` returns extra problems.
const FIXTURES = [
  {
    n: 1,
    name: 'valid control: two release tags on the trunk, and the higher one is printed with its commit',
    build: (root) => {
      const g = makeGlobal(root, { commits: [RECORD(1), RECORD(2), RECORD(3)] });
      tag(g, 'v1.0.0', g.shas[0]);
      tag(g, 'v1.1.0', g.shas[1]);
      return {
        global: link(g.url),
        expect: (out) => {
          const last = out.trimEnd().split('\n').pop();
          return last === `Global: v1.1.0 ${g.shas[1]}` ? [] : [`the last line is ${JSON.stringify(last)}, not the higher release and its commit`];
        },
      };
    },
    exit: 0,
    includes: ['Trunk: main at ', 'Release tags: 2 on the trunk: v1.1.0, v1.0.0'],
    excludes: ['Ignored:', 'Global: none'],
  },
  {
    n: 2,
    name: 'a pre-release tag above the highest release is ignored, so the Board can try a change without binding a product',
    build: (root) => {
      const g = makeGlobal(root, { commits: [RECORD(1), RECORD(2), RECORD(3)] });
      tag(g, 'v1.4.0', g.shas[0]);
      tag(g, 'v1.5.0-rc.1', g.shas[2]);
      return { global: link(g.url), expect: (out) => (out.includes(`Global: v1.4.0 ${g.shas[0]}\n`) ? [] : ['v1.4.0 and its commit are not the result']) };
    },
    exit: 0,
    includes: ['Release tags: 1 on the trunk: v1.4.0', 'Ignored: v1.5.0-rc.1 (not a release tag)'],
    excludes: ['Global: v1.5.0'],
  },
  {
    n: 3,
    name: 'a release tag whose commit is not on the trunk is dropped, though its version is the highest',
    build: (root) => {
      const g = makeGlobal(root, { commits: [RECORD(1), RECORD(2)] });
      tag(g, 'v1.0.0', g.shas[1]);
      const side = sideCommit(g, 'board/try-redis-rule', RECORD(9), { push: true });
      tag(g, 'v2.0.0', side);
      return { global: link(g.url), expect: (out) => (out.includes(`Global: v1.0.0 ${g.shas[1]}\n`) ? [] : ['v1.0.0 and its commit are not the result']) };
    },
    exit: 0,
    includes: ['Release tags: 1 on the trunk: v1.0.0', 'Ignored: v2.0.0 (its commit ', 'is not on main)'],
    excludes: ['Global: v2.0.0'],
  },
  {
    n: 4,
    name: 'no docs/estate/global.json: the hub has no global layer, Global: none, and no remote is asked',
    build: () => ({ global: null }),
    exit: 0,
    includes: ['Global: none'],
    excludes: ['Global repository:', 'Trunk:', 'CANNOT VERIFY'],
  },
  {
    n: 5,
    name: 'the global repository does not answer: exit 2, and no fall-back to a cache',
    build: (root) => ({ global: link(join(root, 'no-such-global.git')) }),
    exit: 2,
    includes: ['CANNOT VERIFY: cannot reach ', 'no-such-global.git', 'REASON: remote-unreachable'],
    excludes: ['Global: '],
  },
  {
    n: 6,
    name: 'versions compare as numbers: v1.10.0 is higher than v1.9.0',
    build: (root) => {
      const g = makeGlobal(root, { commits: [RECORD(1), RECORD(2)] });
      tag(g, 'v1.10.0', g.shas[0]);
      tag(g, 'v1.9.0', g.shas[1]);
      return { global: link(g.url), expect: (out) => (out.includes(`Global: v1.10.0 ${g.shas[0]}\n`) ? [] : ['v1.10.0 is not the result']) };
    },
    exit: 0,
    includes: ['Release tags: 2 on the trunk: v1.10.0, v1.9.0'],
  },
  {
    n: 7,
    name: 'an annotated release tag prints the commit it names, never the tag object',
    build: (root) => {
      const g = makeGlobal(root, { commits: [RECORD(1), RECORD(2)] });
      tag(g, 'v1.0.0', g.shas[0], { annotated: true });
      const object = git(g.work, ['rev-parse', 'refs/tags/v1.0.0']).trim();
      return {
        global: link(g.url),
        expect: (out) => {
          const problems = [];
          if (!out.includes(`Global: v1.0.0 ${g.shas[0]}\n`)) problems.push('the result is not the commit the annotated tag names');
          if (out.includes(object)) problems.push('the tag object hash was printed');
          return problems;
        },
      };
    },
    exit: 0,
    includes: ['Release tags: 1 on the trunk: v1.0.0'],
  },
  {
    n: 8,
    name: 'the trunk carries no release tag: a hub with a global layer cannot record a version that does not exist yet',
    build: (root) => {
      const g = makeGlobal(root, { commits: [RECORD(1)] });
      tag(g, 'v1.0.0-rc.1', g.shas[0]);
      return { global: link(g.url) };
    },
    exit: 1,
    includes: ['Release tags: none on the trunk', 'Ignored: v1.0.0-rc.1 (not a release tag)', 'FAIL: ', 'has no release tag (vX.Y.Z) on main', 'The Board tags a release before a feature can record one'],
    excludes: ['Global: v'],
  },
  {
    n: 9,
    name: 'a global.json that names a tag and carries a credential: exit 1, every rule it breaks in one run',
    build: (root) => ({ global: link('https://bot:s3cret@example.invalid/acme/global-context.git', { tag: 'v1.0.0' }) }),
    exit: 1,
    includes: ['is not well formed', 'unknown root field "tag". The file holds the URL only', '"url" carries a user name or password'],
    excludes: ['Global: '],
  },
  {
    n: 10,
    name: 'a global.json that is not JSON: exit 1',
    build: () => ({ global: '{ "schema_version": 1, "url": ' }),
    exit: 1,
    includes: ['FAIL: ', 'global.json is not JSON'],
  },
  {
    n: 11,
    name: 'a global.json with a wrong schema version and no URL: exit 1',
    build: () => ({ global: `${JSON.stringify({ schema_version: 2 })}\n` }),
    exit: 1,
    includes: ['"schema_version" must be 1, got 2', '"url" is missing'],
  },
  {
    n: 12,
    name: 'no arguments: a usage error',
    build: () => ({ global: null, args: [] }),
    exit: 3,
    includes: ['say what to do: --resolve', 'usage: node '],
    excludes: ['Global: none'],
  },
  {
    n: 13,
    name: 'an unknown argument beside --resolve: a usage error',
    build: () => ({ global: null, args: ['--resolve', '--latest'] }),
    exit: 3,
    includes: ['unknown arguments: --resolve --latest'],
  },
  {
    n: 14,
    name: 'a trunk that is not main: the remote names it, and only tags on it count',
    build: (root) => {
      const g = makeGlobal(root, { trunk: 'develop', commits: [RECORD(1), RECORD(2)] });
      tag(g, 'v3.0.0', g.shas[1]);
      const side = sideCommit(g, 'main', RECORD(5), { push: true });
      tag(g, 'v3.1.0', side);
      return { global: link(g.url), expect: (out) => (out.includes(`Global: v3.0.0 ${g.shas[1]}\n`) ? [] : ['v3.0.0 on develop is not the result']) };
    },
    exit: 0,
    includes: ['Trunk: develop at ', 'Ignored: v3.1.0 (its commit ', 'is not on develop)'],
  },
  {
    n: 15,
    name: 'the remote is asked every time: a release tagged after an earlier read is the result of the next one',
    build: (root) => {
      const g = makeGlobal(root, { commits: [RECORD(1)] });
      tag(g, 'v1.0.0', g.shas[0]);
      return {
        global: link(g.url),
        before: (hub, env) => {
          // The earlier read fills the cache and prints v1.0.0.
          const first = spawnSync(process.execPath, [SCRIPT, '--resolve'], { cwd: hub, env, encoding: 'utf8' });
          if (first.status !== 0 || !first.stdout.includes(`Global: v1.0.0 ${g.shas[0]}`)) throw new Error(`the earlier read did not print v1.0.0: ${first.stdout}${first.stderr}`);
          tag(g, 'v1.1.0', advance(g, RECORD(2)));
        },
        expect: (out) => (out.includes(`Global: v1.1.0 ${g.shas[1]}\n`) ? [] : ['the release tagged after the earlier read is not the result']),
      };
    },
    exit: 0,
    includes: ['Release tags: 2 on the trunk: v1.1.0, v1.0.0'],
  },
  {
    n: 16,
    name: 'a tag moved to a commit off the trunk after an earlier read: the remote\'s tag now, not the cache, decides',
    build: (root) => {
      const g = makeGlobal(root, { commits: [RECORD(1), RECORD(2)] });
      tag(g, 'v1.0.0', g.shas[0]);
      tag(g, 'v1.1.0', g.shas[1]);
      return {
        global: link(g.url),
        before: (hub, env) => {
          const first = spawnSync(process.execPath, [SCRIPT, '--resolve'], { cwd: hub, env, encoding: 'utf8' });
          if (first.status !== 0 || !first.stdout.includes(`Global: v1.1.0 ${g.shas[1]}`)) throw new Error(`the earlier read did not print v1.1.0: ${first.stdout}${first.stderr}`);
          const side = sideCommit(g, 'board/rework', RECORD(7));
          git(g.work, ['tag', '-f', 'v1.1.0', side]);
          git(g.work, ['push', '-q', '-f', g.bare, 'refs/tags/v1.1.0']);
        },
        expect: (out) => (out.includes(`Global: v1.0.0 ${g.shas[0]}\n`) ? [] : ['the moved tag was still trusted']),
      };
    },
    exit: 0,
    includes: ['Ignored: v1.1.0 (its commit ', 'is not on main)'],
  },
  {
    n: 17,
    name: 'HARNESS_GLOBAL names the link file, as HARNESS_REGISTRY names the registry',
    build: (root) => {
      const g = makeGlobal(root, { commits: [RECORD(1)] });
      tag(g, 'v1.0.0', g.shas[0]);
      const file = join(root, 'elsewhere', 'global.json');
      writeFiles(root, { 'elsewhere/global.json': link(g.url) });
      return { global: null, env: { HARNESS_GLOBAL: file }, expect: (out) => (out.includes(`Global: v1.0.0 ${g.shas[0]}\n`) ? [] : ['the file HARNESS_GLOBAL names was not read']) };
    },
    exit: 0,
    excludes: ['Global: none'],
  },
  {
    n: 18,
    name: '--exceptions: an Active exception at the newest release covers the repository and names another hub: one WARNING, exit 0',
    build: (root) => {
      const g = makeGlobal(root, { commits: [{ ...REDIS_ONLY, ...EXCEPTION() }] });
      tag(g, 'v1.0.0', g.shas[0]);
      return { global: link(g.url), hubFiles: KEYS('SCR'), args: ['--exceptions', 'auth-service'] };
    },
    exit: 0,
    includes: ['Global: v1.0.0 ', 'Hub: SCR', 'Exceptions: 1 Active at v1.0.0; 1 cover auth-service', 'WARNING: global.EXC-004 covers auth-service and names the hubs SIM, not SCR', 'this hub\'s designs follow global.ADR-012', 'Ask the Global Architecture Board for an exception that names this hub'],
    excludes: ['No Active exception'],
  },
  {
    n: 19,
    name: '--exceptions: the exception names this hub too: no warning',
    build: (root) => {
      const g = makeGlobal(root, { commits: [{ ...REDIS_ONLY, ...EXCEPTION({ hubs: '["SCR", "SIM"]' }) }] });
      tag(g, 'v1.0.0', g.shas[0]);
      return { global: link(g.url), hubFiles: KEYS('SCR'), args: ['--exceptions', 'auth-service'] };
    },
    exit: 0,
    includes: ['Exceptions: 1 Active at v1.0.0; 1 cover auth-service', 'No Active exception at v1.0.0 covers auth-service without naming SCR.'],
    excludes: ['WARNING'],
  },
  {
    n: 20,
    name: '--exceptions: a withdrawn exception has no effect, so it warns of nothing',
    build: (root) => {
      const g = makeGlobal(root, { commits: [{ ...REDIS_ONLY, ...EXCEPTION({ status: 'Withdrawn' }) }] });
      tag(g, 'v1.0.0', g.shas[0]);
      return { global: link(g.url), hubFiles: KEYS('SCR'), args: ['--exceptions', 'auth-service'] };
    },
    exit: 0,
    includes: ['Exceptions: 0 Active at v1.0.0; 0 cover auth-service'],
    excludes: ['WARNING'],
  },
  {
    n: 21,
    name: '--exceptions: an exception merged after the newest release binds nothing yet, so it warns of nothing',
    build: (root) => {
      const g = makeGlobal(root, { commits: [REDIS_ONLY, EXCEPTION()] });
      tag(g, 'v1.0.0', g.shas[0]);
      return { global: link(g.url), hubFiles: KEYS('SCR'), args: ['--exceptions', 'auth-service'] };
    },
    exit: 0,
    includes: ['Exceptions: 0 Active at v1.0.0'],
    excludes: ['WARNING'],
  },
  {
    n: 22,
    name: '--exceptions: another repository is not covered: no warning',
    build: (root) => {
      const g = makeGlobal(root, { commits: [{ ...REDIS_ONLY, ...EXCEPTION() }] });
      tag(g, 'v1.0.0', g.shas[0]);
      return { global: link(g.url), hubFiles: KEYS('SCR'), args: ['--exceptions', 'billing-service'] };
    },
    exit: 0,
    includes: ['Exceptions: 1 Active at v1.0.0; 0 cover billing-service'],
    excludes: ['WARNING'],
  },
  {
    n: 23,
    name: '--exceptions: no docs/estate/global.json: Global: none and nothing else, so /add-repo changes nothing',
    build: () => ({ global: null, hubFiles: KEYS('SCR'), args: ['--exceptions', 'auth-service'] }),
    exit: 0,
    includes: ['Global: none'],
    excludes: ['Exceptions:', 'WARNING', 'Hub:'],
  },
  {
    n: 24,
    name: '--exceptions: no release tag on the trunk: nothing binds yet, exit 0 and no warning',
    build: (root) => {
      const g = makeGlobal(root, { commits: [{ ...REDIS_ONLY, ...EXCEPTION() }] });
      return { global: link(g.url), hubFiles: KEYS('SCR'), args: ['--exceptions', 'auth-service'] };
    },
    exit: 0,
    includes: ['Release tags: none on the trunk', 'Global: no release tag, so no exception binds yet'],
    excludes: ['WARNING', 'FAIL'],
  },
  {
    n: 25,
    name: '--exceptions: the global repository does not answer: exit 2',
    build: (root) => ({ global: link(join(root, 'no-such-global.git')), hubFiles: KEYS('SCR'), args: ['--exceptions', 'auth-service'] }),
    exit: 2,
    includes: ['CANNOT VERIFY: cannot reach ', 'REASON: remote-unreachable'],
    excludes: ['WARNING'],
  },
  {
    n: 26,
    name: '--exceptions: a hub with no key ledger yet: every covering exception warns, because none can name it',
    build: (root) => {
      const g = makeGlobal(root, { commits: [{ ...REDIS_ONLY, ...EXCEPTION({ hubs: '["SCR", "SIM"]' }) }] });
      tag(g, 'v1.0.0', g.shas[0]);
      return { global: link(g.url), args: ['--exceptions', 'auth-service'] };
    },
    exit: 0,
    includes: ['Hub: no key prefix in docs/backlog/keys.json', 'WARNING: global.EXC-004 covers auth-service and names the hubs SCR, SIM, not this hub, which has no key prefix yet'],
  },
  {
    n: 27,
    name: '--exceptions with no repository id: a usage error',
    build: () => ({ global: null, args: ['--exceptions'] }),
    exit: 3,
    includes: ['--exceptions takes one repository id', 'usage: node '],
  },
  {
    n: 28,
    name: '--exceptions with a path for an id: a usage error',
    build: () => ({ global: null, args: ['--exceptions', '../auth-service'] }),
    exit: 3,
    includes: ['"../auth-service" is not a repository id'],
  },
  {
    n: 29,
    name: '--connect: a URL with a release that holds documents: the --resolve lines, the hub, the counts and the release, and nothing written',
    build: (root) => {
      const g = makeGlobal(root, { commits: [{ ...REDIS_ONLY, ...EXCEPTION({ hubs: '["SCR"]' }) }] });
      tag(g, 'v1.0.0', g.shas[0]);
      return {
        global: null,
        hubFiles: KEYS('SCR'),
        args: ['--connect', g.url],
        expect: (out, hub) => {
          const problems = [];
          const last = out.trimEnd().split('\n').pop();
          if (last !== `Global: v1.0.0 ${g.shas[0]}`) problems.push(`the last line is ${JSON.stringify(last)}, not the release and its commit`);
          if (existsSync(join(hub, 'docs', 'estate', 'global.json'))) problems.push('--connect wrote docs/estate/global.json');
          return problems;
        },
      };
    },
    exit: 0,
    includes: ['Global repository: ', 'Release tags: 1 on the trunk: v1.0.0', 'Hub: SCR', 'Documents: 2 at v1.0.0: 1 record(s), 0 standard(s), 1 exception(s)'],
    excludes: ['Note:', 'FAIL'],
  },
  {
    n: 30,
    name: '--connect: the hub already has docs/estate/global.json: exit 1, and no remote is asked',
    build: (root) => {
      const g = makeGlobal(root, { commits: [REDIS_ONLY] });
      tag(g, 'v1.0.0', g.shas[0]);
      return { global: link(g.url), args: ['--connect', g.url] };
    },
    exit: 1,
    includes: ['FAIL: docs/estate/global.json already links this hub to a global context repository', 'Run /check-global without --connect'],
    excludes: ['Global repository:', 'Global: v'],
  },
  {
    n: 31,
    name: '--connect: a URL with a user name and password: exit 1 before any remote is asked, and the URL is not printed',
    build: () => ({ global: null, args: ['--connect', 'https://bot:s3cret@example.invalid/acme/global-context.git'] }),
    exit: 1,
    includes: ['FAIL: the URL carries a user name or password', 'Give the clone URL without it'],
    excludes: ['s3cret', 'bot:', 'Global repository:'],
  },
  {
    n: 32,
    name: '--connect: the global repository does not answer: exit 2',
    build: (root) => ({ global: null, args: ['--connect', join(root, 'no-such-global.git')] }),
    exit: 2,
    includes: ['CANNOT VERIFY: cannot reach ', 'no-such-global.git', 'REASON: remote-unreachable'],
    excludes: ['Global: v'],
  },
  {
    n: 33,
    name: '--connect: the trunk carries no release tag: exit 1, because the next /feature would have nothing to record',
    build: (root) => {
      const g = makeGlobal(root, { commits: [REDIS_ONLY] });
      tag(g, 'v1.0.0-rc.1', g.shas[0]);
      return { global: null, args: ['--connect', g.url] };
    },
    exit: 1,
    includes: ['Release tags: none on the trunk', 'FAIL: the global repository has no release tag (vX.Y.Z) on main', 'The Board tags its first release before a hub connects'],
    excludes: ['Global: v', 'Documents:'],
  },
  {
    n: 34,
    name: '--connect: a release that holds no global document is another kind of repository: exit 1',
    build: (root) => {
      const g = makeGlobal(root, { commits: [{ 'src/index.js': 'export const answer = 42;\n' }] });
      tag(g, 'v1.0.0', g.shas[0]);
      return { global: null, args: ['--connect', g.url] };
    },
    exit: 1,
    includes: ['Documents: 0 at v1.0.0: 0 record(s), 0 standard(s), 0 exception(s)', 'FAIL: v1.0.0 holds no decision record, standard or exception that parses'],
    excludes: ['Global: v'],
  },
  {
    n: 35,
    name: '--connect with no URL: a usage error',
    build: () => ({ global: null, args: ['--connect'] }),
    exit: 3,
    includes: ['--connect takes one URL', 'usage: node '],
  },
  {
    n: 36,
    name: '--connect with a second argument: a usage error that does not echo the arguments',
    build: () => ({ global: null, args: ['--connect', 'https://bot:s3cret@example.invalid/acme/global-context.git', '--force'] }),
    exit: 3,
    includes: ['--connect takes one URL'],
    excludes: ['s3cret', '--force'],
  },
  {
    n: 37,
    name: '--connect: a hub with no key ledger yet is connected all the same, and says no exception can name it',
    build: (root) => {
      const g = makeGlobal(root, { commits: [REDIS_ONLY] });
      tag(g, 'v1.0.0', g.shas[0]);
      return { global: null, args: ['--connect', g.url], expect: (out) => (out.includes(`Global: v1.0.0 ${g.shas[0]}\n`) ? [] : ['the release is not the result']) };
    },
    exit: 0,
    includes: ['Hub: no key prefix in docs/backlog/keys.json', 'Documents: 1 at v1.0.0: 1 record(s), 0 standard(s), 0 exception(s)'],
  },
  {
    n: 38,
    name: '--resolve, and git has no credential for the host: exit 2, the message says git could not authenticate, names the URL and gives the fix',
    build: (root) => {
      const host = askingHost(root);
      return { global: link(host.url), after: host.stop, expect: (out) => (out.includes('Global: ') ? ['a release was printed'] : []) };
    },
    exit: 2,
    includes: ['CANNOT VERIFY: git could not authenticate to http://127.0.0.1:', '/acme/global-context.git, so the global repository was not read', 'gh auth setup-git', 'set a git credential helper', 'REASON: auth-failed'],
    excludes: ['INTERNAL'],
  },
  {
    n: 39,
    name: '--connect, and git has no credential for the host: the same message, and nothing written',
    build: (root) => {
      const host = askingHost(root);
      return { global: null, args: ['--connect', host.url], after: host.stop };
    },
    exit: 2,
    includes: ['CANNOT VERIFY: git could not authenticate to http://127.0.0.1:', 'gh auth setup-git', 'REASON: auth-failed'],
    excludes: ['Global: ', 'INTERNAL'],
  },
];

/* ---------------------------------------------------------------------- runner */

function runFixture(fixture) {
  const root = mkdtempSync(join(tmpdir(), `readglobal-fx${String(fixture.n).padStart(2, '0')}-`));
  let after = null;
  try {
    const hub = join(root, 'hub');
    mkdirSync(join(hub, 'docs', 'estate'), { recursive: true });
    const built = fixture.build(root);
    after = built.after || null;
    if (built.global !== null) writeFileSync(join(hub, 'docs', 'estate', 'global.json'), built.global);
    if (built.hubFiles) writeFiles(hub, built.hubFiles);
    const env = { ...ENV, HARNESS_SPOKE_CACHE: join(root, 'cache'), ...(built.env || {}) };
    if (built.before) built.before(hub, env);
    const args = built.args === undefined ? ['--resolve'] : built.args;
    const res = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: hub, env, encoding: 'utf8' });
    const output = `${res.stdout || ''}${res.stderr || ''}`;
    const problems = [];
    if (res.status !== fixture.exit) problems.push(`expected exit ${fixture.exit}, got ${res.status}`);
    for (const needle of fixture.includes || []) {
      if (!output.includes(needle)) problems.push(`output does not contain: ${JSON.stringify(needle)}`);
    }
    for (const needle of fixture.excludes || []) {
      if (output.includes(needle)) problems.push(`output should not contain: ${JSON.stringify(needle)}`);
    }
    if (built.expect) problems.push(...built.expect(res.stdout || '', hub));
    return { problems, output };
  } catch (err) {
    return { problems: [`fixture setup failed: ${err && err.message ? err.message : String(err)}`], output: '' };
  } finally {
    if (after) after();
    if (!process.argv.includes('--keep')) rmSync(root, { recursive: true, force: true });
  }
}

function main() {
  const wanted = process.argv.slice(2).filter((a) => a.match(/^\d+$/)).map(Number);
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
    ? `\n${failed} of ${selected.length} fixtures FAILED. The global release a feature records is not trustworthy until this is green.\n`
    : `\nAll ${selected.length} fixtures passed.\n`);
  rmSync(SANDBOX_HOME, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
}

main();

#!/usr/bin/env node
/**
 * run.mjs — the fixture suite for check-survey.mjs.
 *
 *   usage:  node run.mjs            run every fixture
 *           node run.mjs 2 6        run only the numbered fixtures
 *           node run.mjs --keep     leave the throwaway repositories on disk
 *
 * A fixture is a REPOSITORY STATE: a throwaway hub with two commits -- a base
 * and the pull request on top of it -- holding the list of repositories and
 * the surveys, and real bare remotes for the surveyed repositories, with the
 * files every pointer points at. The shipped script is run from the hub
 * exactly as the hub's `survey-gate` runs it, and exit code and report text
 * are asserted. Fixture 1 is the valid control; most others change exactly one
 * thing.
 *
 * Node standard library only, plus git via child_process. No test framework.
 * Exit 0 if every fixture passes, 1 if any fails.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

const SCRIPT = [
  process.env.HARNESS_CHECK_SURVEY,
  resolve(HERE, '..', '..', 'check-survey.mjs'),
  resolve(HERE, '..', '..', 'scripts', 'check-survey.mjs'),
].filter(Boolean).find((p) => existsSync(p));

if (!SCRIPT) {
  console.error('cannot locate check-survey.mjs. Set HARNESS_CHECK_SURVEY=/path/to/check-survey.mjs.');
  process.exit(4);
}

const { renderSurvey } = await import(pathToFileURL(join(dirname(SCRIPT), 'surveys.mjs')).href);
const V6 = 'service-survey v6';

/* ------------------------------------------------------------------ git helpers */

const SANDBOX_HOME = mkdtempSync(join(tmpdir(), 'survey-home-'));
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
    if (body === null) {
      rmSync(abs, { force: true });
      continue;
    }
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }
}

function initWork(dir, trunk) {
  git(dirname(dir), ['init', '-q', '--initial-branch', trunk, dir]);
  git(dir, ['config', 'user.name', 'Fixture Runner']);
  git(dir, ['config', 'user.email', 'fixture@example.invalid']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
}

function commitAll(dir, message) {
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '--allow-empty', '-m', message]);
  return git(dir, ['rev-parse', 'HEAD']).trim();
}

function makeRemote(root, name, { trunk = 'main', files = SPOKE_FILES, branch = null } = {}) {
  const bare = join(root, `${name}.git`);
  const work = join(root, `${name}-work`);
  git(root, ['init', '--bare', '-q', '--initial-branch', trunk, bare]);
  git(root, ['--git-dir', bare, 'symbolic-ref', 'HEAD', `refs/heads/${trunk}`]);
  initWork(work, trunk);
  writeFiles(work, files);
  const head = commitAll(work, 'commit 1');
  git(work, ['push', '-q', bare, trunk]);
  // A second branch, cut from the trunk's tip: a declared harness trunk.
  let branchHead = null;
  if (branch) {
    git(work, ['checkout', '-q', '-b', branch.name]);
    for (const [i, set] of branch.commits.entries()) {
      writeFiles(work, set);
      branchHead = commitAll(work, `${branch.name} commit ${i + 1}`);
    }
    git(work, ['push', '-q', bare, branch.name]);
    git(work, ['checkout', '-q', trunk]);
  }
  return { url: bare, work, bare, trunk, head, branchHead };
}

/** Commit more files on the remote's trunk after the survey was written. */
function advance(remote, files) {
  writeFiles(remote.work, files);
  const sha = commitAll(remote.work, 'later');
  git(remote.work, ['push', '-q', remote.bare, remote.trunk]);
  return sha;
}

/** A commit the remote holds on a side branch, never on its trunk. */
function sideBranch(remote, files) {
  git(remote.work, ['checkout', '-q', '-b', 'side']);
  writeFiles(remote.work, files);
  const sha = commitAll(remote.work, 'side');
  git(remote.work, ['push', '-q', remote.bare, 'side']);
  git(remote.work, ['checkout', '-q', remote.trunk]);
  return sha;
}

/* -------------------------------------------------------------- the content */

const lines = (n, label) => Array.from({ length: n }, (_, i) => `// ${label} line ${i + 1}`).join('\n') + '\n';

const SPOKE_FILES = {
  'src/routes.js': lines(12, 'routes'),
  'src/ledger.js': lines(6, 'ledger client'),
  'src/db.js': lines(8, 'db'),
  'package.json': lines(8, 'manifest'),
  'tests/a.js': lines(3, 'test'),
  'db/seed.sql': lines(2, 'seed'),
};
// What section 7 of a v6 survey says about SPOKE_FILES.
const bytesOf = (path) => Buffer.byteLength(SPOKE_FILES[path]);
const NOT_READ_OK = [['data', 'db/', '1', String(bytesOf('db/seed.sql'))], ['test', 'tests/', '1', String(bytesOf('tests/a.js'))]];

const DISCLAIMER = 'Generated by /survey-repo from the repository at the commit above. It describes what the code does and points at it; it is never cited as authority and never outranks a contract. Where the two disagree, the contract wins and this survey is refreshed.';
const NONE = 'None found.';
const OPEN = ['Unresolved', 'Owner', 'Resolves', 'Evidence'];

const ev = (id, commit, path, a, b) => `${id}@${commit.slice(0, 12)}:${path} L${a}-${b}`;

function table(header, rows) {
  if (typeof rows === 'string') return rows;
  return [`| ${header.join(' | ')} |`, `|${header.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.join(' | ')} |`)].join('\n');
}

/**
 * A survey as text. Every part has the control's value unless overridden; a
 * part set to null is left out, and `raw` replaces the whole file.
 */
function survey(id, commit, o = {}) {
  const e = (path, a, b) => ev(id, commit, path, a, b);
  const parts = {
    front: ['---', 'kind: service-survey', `repository: ${id}`, `commit: ${commit}`, `template: ${o.template ?? 'service-survey v5'}`, '---'].join('\n'),
    title: `# Service survey: ${id}`,
    disclaimer: DISCLAIMER,
    serves: [
      ['http:GET:/transfers/{id}', 'Returns one transfer', e('src/routes.js', 3, 5)],
      ['http:POST:/transfers', 'Creates a transfer', `${e('src/routes.js', 7, 12)}, ${e('src/db.js', 2, 3)}`],
    ],
    calls: [['http:POST:/postings', 'batch', e('src/ledger.js', 2, 4)]],
    stores: [['store:postgres:transfers', 'read-write', 'transfers, transfer_events', e('src/db.js', 1, 6)]],
    libs: NONE,
    third: NONE,
    open: 'None.',
    ...o,
  };
  if (parts.raw !== undefined) return parts.raw;
  const out = [parts.front, '', parts.title, '', parts.disclaimer, ''];
  const add = (heading, header, rows) => {
    if (heading === null) return;
    out.push(heading, '', table(header, rows), '');
  };
  add(parts.h1 === undefined ? '## 1. Serves' : parts.h1, ['Key', 'What', 'Evidence'], parts.serves);
  add(parts.h2 === undefined ? '## 2. Calls' : parts.h2, ['Key', 'Provider', 'Evidence'], parts.calls);
  add(parts.h3 === undefined ? '## 3. Data stores' : parts.h3, ['Key', 'Access', 'Objects', 'Evidence'], parts.stores);
  add(parts.h4 === undefined ? '## 4. Shared libraries' : parts.h4, ['Key', 'Version', 'Evidence'], parts.libs);
  add(parts.h5 === undefined ? '## 5. Third-party libraries' : parts.h5, ['Key', 'Version', 'Evidence'], parts.third);
  if (parts.extra) out.push(parts.extra, '');
  out.push('## 6. Open points', '', table(OPEN, parts.open), '');
  // Section 7 belongs to template v6. `undefined` leaves it out, so a v5 survey stays six sections.
  if (parts.notRead !== undefined) out.push('## 7. Not read', '', table(['Rule', 'Folder', 'Files', 'Bytes'], parts.notRead), '');
  return out.filter((l, i, a) => l !== null && !(l === '' && a[i - 1] === '')).join('\n');
}

function registry(entries) {
  return `${JSON.stringify({ schema_version: 1, repositories: entries }, null, 2)}\n`;
}

const entry = (remote, url) => ({
  url: url ?? remote.url,
  checks: 'checks.env',
  purpose: 'Moves money between accounts and records every transfer.',
  readAt: remote.head,
  trunk: 'default',
});

const BOGUS = '/nonexistent/remote.git';
const REG = 'docs/estate/repositories.json';
const PATH = (id) => `docs/estate/surveys/${id}.md`;

/** The two spokes almost every fixture uses, and a registry naming both. */
function estate(root, svcFiles = SPOKE_FILES) {
  const svc = makeRemote(root, 'svc', { files: svcFiles });
  const batch = makeRemote(root, 'batch');
  return { svc, batch, reg: registry({ svc: entry(svc), batch: entry(batch) }) };
}

/** The common shape: base holds the list; the pull request adds the svc survey. */
function adds(root, text, extra = {}, svcFiles = SPOKE_FILES) {
  const { svc, batch, reg } = estate(root, svcFiles);
  return {
    base: { [REG]: reg },
    head: { [PATH('svc')]: typeof text === 'function' ? text(svc, batch) : text ?? survey('svc', svc.head) },
    args: ['--changed-since', '{BASE}'],
    ...extra,
  };
}

/** SPOKE_FILES plus a package folder that holds a licence document. */
const PKG_FILES = { ...SPOKE_FILES, 'lib/smarty/COPYING.lib': lines(2, 'licence'), 'lib/smarty/Smarty.php': lines(4, 'smarty'), 'lib/Own.php': lines(3, 'own') };
const PKG_BYTES = String(Buffer.byteLength(PKG_FILES['lib/smarty/COPYING.lib']) + Buffer.byteLength(PKG_FILES['lib/smarty/Smarty.php']));

/** SPOKE_FILES plus a requirements file with a free name, deep in a folder of tools. */
const LISTS_FILES = { ...SPOKE_FILES, 'tools/audio/det_requirements.txt': lines(4, 'requirement') };

/** SPOKE_FILES plus a JSON file of 16385 bytes that holds only digits and a line feed: the data rule reads its content. */
const NUMERIC_FILES = { ...SPOKE_FILES, 'data/dist.json': `${'1'.repeat(16384)}\n` };
const NUMERIC_ROW = ['data', 'data/', '1', '16385'];

/** SPOKE_FILES plus a lock file, a CI workflow, a mock folder and a file of 16 bytes or less. */
const CI_WORKFLOW = 'jobs:\n  test:\n    steps:\n      - run: pip install -r tools/audio/det_requirements.txt\n';
const RULE_FILES = { ...SPOKE_FILES, 'composer.lock': lines(3, 'lock'), '.github/workflows/ci.yml': CI_WORKFLOW, 'src/mocks/a.js': lines(2, 'mock'), 'src/stub.txt': 'stub\n' };
const sizeOf = (files, path) => String(Buffer.byteLength(files[path]));

/* -------------------------------------------------------------- the fixtures */

const FIXTURES = [
  {
    n: 1,
    name: 'control: the pull request adds a well-formed survey whose every pointer is true',
    build: (root) => adds(root),
    exit: 0,
    includes: ['changed since', 'svc.md', '[PASS] svc', '4 row(s), 3 file(s) cited', 'WELL FORMED: 1 survey(s), 4 row(s), every pointer true'],
    excludes: ['behind the trunk head'],
  },
  {
    n: 2,
    name: 'no survey changed: nothing to check, and neither the list nor any remote is read',
    build: (root) => {
      const { svc } = estate(root);
      return {
        base: { [PATH('svc')]: survey('svc', svc.head) },
        head: { 'docs/notes.md': 'unrelated\n' },
        args: ['--changed-since', '{BASE}'],
      };
    },
    exit: 0,
    includes: ['NOTHING TO CHECK: no survey changed since'],
    excludes: ['no registry', 'cannot reach'],
  },
  {
    n: 3,
    name: '--all with no surveys at all: nothing to check',
    build: (root) => ({ base: { [REG]: estate(root).reg }, head: {}, args: ['--all'] }),
    exit: 0,
    includes: ['NOTHING TO CHECK: no survey at HEAD'],
  },
  {
    n: 4,
    name: 'no frontmatter',
    build: (root) => adds(root, (svc) => survey('svc', svc.head, { front: '' })),
    exit: 1,
    includes: ['does not open with a frontmatter line', '[FAIL] svc', 'NOT WELL FORMED'],
  },
  {
    n: 5,
    name: 'a template version the checker does not know',
    build: (root) => adds(root, (svc) => survey('svc', svc.head).replace('service-survey v5', 'service-survey v9')),
    exit: 1,
    includes: ['template is "service-survey v9"'],
  },
  {
    n: 6,
    name: 'the wrong kind',
    build: (root) => adds(root, (svc) => survey('svc', svc.head).replace('kind: service-survey', 'kind: contract')),
    exit: 1,
    includes: ['kind is "contract"'],
  },
  {
    n: 7,
    name: 'a short commit in the frontmatter',
    build: (root) => adds(root, (svc) => survey('svc', svc.head).replace(`commit: ${svc.head}`, `commit: ${svc.head.slice(0, 12)}`)),
    exit: 1,
    includes: ['commit must be the full 40-character hash'],
  },
  {
    n: 8,
    name: 'the file is named for another repository than the one it surveys',
    build: (root) => {
      const { svc, reg } = estate(root);
      return { base: { [REG]: reg }, head: { [PATH('batch')]: survey('svc', svc.head) }, args: ['--changed-since', '{BASE}'] };
    },
    exit: 1,
    includes: ['surveys repository "svc"; the file is named for the repository it surveys'],
  },
  {
    n: 9,
    name: 'a survey of a repository the list does not carry',
    build: (root) => {
      const { svc, batch } = estate(root);
      return { base: { [REG]: registry({ batch: entry(batch) }) }, head: { [PATH('svc')]: survey('svc', svc.head) }, args: ['--changed-since', '{BASE}'] };
    },
    exit: 1,
    includes: ['svc is not on the list of repositories'],
  },
  {
    n: 10,
    name: 'a section missing',
    build: (root) => adds(root, (svc) => survey('svc', svc.head, { h4: null })),
    exit: 1,
    includes: ['the sections must be exactly, in order'],
  },
  {
    n: 11,
    name: 'an extra section',
    build: (root) => adds(root, (svc) => survey('svc', svc.head, { extra: '## 7. Notes\n\nNone.' })),
    exit: 1,
    includes: ['the sections must be exactly, in order', '"## 7. Notes"'],
  },
  {
    n: 12,
    name: 'a section with neither a table nor "None found."',
    build: (root) => adds(root, (svc) => survey('svc', svc.head, { libs: '' })),
    exit: 1,
    includes: ['"## 4. Shared libraries" is empty; write "None found."'],
  },
  {
    n: 13,
    name: 'three malformed web keys: a capital in the path, a trailing slash, a query',
    build: (root) => adds(root, (svc) => {
      const e = (a, b) => ev('svc', svc.head, 'src/routes.js', a, b);
      return survey('svc', svc.head, {
        serves: [
          ['http:GET:/Transfers', 'x one', e(1, 2)],
          ['http:GET:/transfers/', 'x two', e(1, 2)],
          ['http:GET:/transfers?page=1', 'x three', e(1, 2)],
        ],
      });
    }),
    exit: 1,
    includes: ['"http:GET:/Transfers" is not a well-formed http key', '"http:GET:/transfers/" is not a well-formed http key', '"http:GET:/transfers?page=1" is not a well-formed http key'],
  },
  {
    n: 14,
    name: 'a store key under Serves',
    build: (root) => adds(root, (svc) => survey('svc', svc.head, { serves: [['store:postgres:x', 'a table', ev('svc', svc.head, 'src/db.js', 1, 2)]] })),
    exit: 1,
    includes: ['"store:postgres:x" is a store key; "## 1. Serves" takes http, event, queue, job keys'],
  },
  {
    n: 15,
    name: 'a row with no evidence',
    build: (root) => adds(root, (svc) => survey('svc', svc.head, { libs: [['lib:@acme/auth', '^1.2.0', '']] })),
    exit: 1,
    includes: ['a row without evidence is not a row'],
  },
  {
    n: 16,
    name: 'a pointer with no line range',
    build: (root) => adds(root, (svc) => survey('svc', svc.head, { libs: [['lib:@acme/auth', '^1.2.0', `svc@${svc.head.slice(0, 12)}:package.json`]] })),
    exit: 1,
    includes: ['is not a pointer <ID>@<12-hex>:<path> L<a>-<b>'],
  },
  {
    n: 17,
    name: 'a pointer into another repository',
    build: (root) => adds(root, (svc) => survey('svc', svc.head, { libs: [['lib:@acme/auth', '^1.2.0', ev('batch', svc.head, 'package.json', 1, 2)]] })),
    exit: 1,
    includes: ['points into batch; a survey points only into the repository it surveys, svc'],
  },
  {
    n: 18,
    name: 'a pointer pinned at another commit than the survey',
    build: (root) => adds(root, (svc) => survey('svc', svc.head, { libs: [['lib:@acme/auth', '^1.2.0', ev('svc', 'a'.repeat(40), 'package.json', 1, 2)]] })),
    exit: 1,
    includes: ['is pinned at aaaaaaaaaaaa; every pointer is pinned at the survey\'s commit'],
  },
  {
    n: 19,
    name: 'one key twice in a table',
    build: (root) => adds(root, (svc) => {
      const e = ev('svc', svc.head, 'src/routes.js', 1, 2);
      return survey('svc', svc.head, { serves: [['http:GET:/a', 'first', e], ['http:GET:/a', 'second', e]] });
    }),
    exit: 1,
    includes: ['"http:GET:/a" appears twice in "## 1. Serves"'],
  },
  {
    n: 20,
    name: 'rows out of key order',
    build: (root) => adds(root, (svc) => {
      const e = ev('svc', svc.head, 'src/routes.js', 1, 2);
      return survey('svc', svc.head, { serves: [['http:GET:/b', 'second', e], ['http:GET:/a', 'first', e]] });
    }),
    exit: 1,
    includes: ['rows must be sorted by key; "http:GET:/a" comes before "http:GET:/b"'],
  },
  {
    n: 21,
    name: 'a provider the list does not carry, and a repository that calls itself',
    build: (root) => adds(root, (svc) => {
      const e = ev('svc', svc.head, 'src/ledger.js', 1, 2);
      return survey('svc', svc.head, { calls: [['http:GET:/a', 'ghost', e], ['http:GET:/b', 'svc', e]] });
    }),
    exit: 1,
    includes: ['provider ghost is not on the list of repositories', 'a repository does not call itself'],
  },
  {
    n: 22,
    name: 'an access value outside the three',
    build: (root) => adds(root, (svc) => survey('svc', svc.head, { stores: [['store:postgres:transfers', 'rw', 'transfers', ev('svc', svc.head, 'src/db.js', 1, 6)]] })),
    exit: 1,
    includes: ['Access is one of read, write, read-write'],
  },
  {
    n: 23,
    name: 'a long survey: no line cap, because scripts read the rows',
    build: (root) => adds(root, (svc) => survey('svc', svc.head, {
      calls: Array.from({ length: 400 }, (_, i) => [`http:GET:/player/r${String(i).padStart(3, '0')}`, 'unknown', ev('svc', svc.head, 'src/ledger.js', 1, 2)]),
    })),
    exit: 0,
    includes: ['[PASS] svc', '403 row(s)', '400 call(s) with the provider unknown'],
    excludes: ['the cap is'],
  },
  {
    n: 24,
    name: 'an HTML comment and an invisible character',
    build: (root) => adds(root, (svc) => survey('svc', svc.head, { disclaimer: `${DISCLAIMER}\n\n<!-- hidden -->`, title: `# Service survey: svc​` })),
    exit: 1,
    includes: ['carries an HTML comment', 'carries an invisible character'],
  },
  {
    n: 25,
    name: 'a credential copied into a row: the finding names the line, never the value',
    build: (root) => adds(root, (svc) => survey('svc', svc.head, {
      serves: [['http:GET:/health', 'Health, with password=hunter2abc9 in config', ev('svc', svc.head, 'src/routes.js', 1, 2)]],
    })),
    exit: 1,
    includes: ['looks like a password or key assignment; never copy a secret'],
    excludes: ['hunter2abc9'],
  },
  {
    n: 26,
    name: 'a placeholder cell',
    build: (root) => adds(root, (svc) => survey('svc', svc.head, { serves: [['http:GET:/health', 'TBD', ev('svc', svc.head, 'src/routes.js', 1, 2)]] })),
    exit: 1,
    includes: ['the What cell is a placeholder'],
  },
  {
    n: 27,
    name: 'a commit the repository does not know',
    build: (root) => adds(root, () => survey('svc', 'b'.repeat(40))),
    exit: 1,
    includes: [`commit bbbbbbbbbbbb is not a commit`],
  },
  {
    n: 28,
    name: 'a commit on a side branch, never on the trunk',
    build: (root) => adds(root, (svc) => survey('svc', sideBranch(svc, { 'src/extra.js': 'x\n' }))),
    exit: 1,
    includes: ['is not on the trunk (main)'],
  },
  {
    n: 29,
    name: 'a pointer at a file that is not there, and one at a folder',
    build: (root) => adds(root, (svc) => survey('svc', svc.head, {
      libs: [['lib:@acme/auth', '^1.2.0', `${ev('svc', svc.head, 'src/gone.js', 1, 2)}, ${ev('svc', svc.head, 'src', 1, 2)}`]],
    })),
    exit: 1,
    includes: ['src/gone.js is not in svc at', 'src is a folder, not a file'],
  },
  {
    n: 30,
    name: 'a range past the end of the file, and one that runs backwards',
    build: (root) => adds(root, (svc) => survey('svc', svc.head, {
      libs: [['lib:@acme/auth', '^1.2.0', `${ev('svc', svc.head, 'src/routes.js', 40, 400)}, ${ev('svc', svc.head, 'package.json', 5, 3)}`]],
    })),
    exit: 1,
    includes: ['the range ends at line 400; src/routes.js has 12 line(s)', 'must start at 1 or later and not run backwards'],
  },
  {
    n: 31,
    name: 'the repository cannot be reached: cannot verify, and the form finding is still listed',
    build: (root) => {
      const svc = makeRemote(root, 'svc');
      const batch = makeRemote(root, 'batch');
      return {
        base: { [REG]: registry({ svc: entry(svc, BOGUS), batch: entry(batch) }) },
        head: { [PATH('svc')]: survey('svc', svc.head, { serves: [['http:GET:/health', 'TBD', ev('svc', svc.head, 'src/routes.js', 1, 2)]] }) },
        args: ['--changed-since', '{BASE}'],
      };
    },
    exit: 2,
    includes: ['[CANNOT VERIFY] svc', 'cannot reach', 'the What cell is a placeholder', 'CANNOT VERIFY: at least one repository', 'REASON: remote-unreachable'],
  },
  {
    n: 32,
    name: '--offline: form only, no remote asked',
    build: (root) => {
      const svc = makeRemote(root, 'svc');
      const batch = makeRemote(root, 'batch');
      return {
        base: { [REG]: registry({ svc: entry(svc, BOGUS), batch: entry(batch, BOGUS) }) },
        head: { [PATH('svc')]: survey('svc', svc.head) },
        args: ['--changed-since', '{BASE}', '--offline'],
      };
    },
    exit: 0,
    includes: ['offline: remotes not asked', 'pointers not proved', 'WELL FORMED: 1 survey(s)'],
  },
  {
    n: 33,
    name: 'the list changes and drops a surveyed repository: every survey is checked',
    build: (root) => {
      const { svc, batch, reg } = estate(root);
      return {
        base: { [REG]: reg, [PATH('svc')]: survey('svc', svc.head) },
        head: { [REG]: registry({ batch: entry(batch) }) },
        args: ['--changed-since', '{BASE}'],
      };
    },
    exit: 1,
    includes: ['the list of repositories, so every survey', 'svc is not on the list of repositories'],
  },
  {
    n: 49,
    name: 'the list drops a repository another survey calls: the call names nobody',
    build: (root) => {
      const { svc, reg } = estate(root);
      return {
        base: { [REG]: reg, [PATH('svc')]: survey('svc', svc.head) },
        head: { [REG]: registry({ svc: entry(svc) }) },
        args: ['--changed-since', '{BASE}'],
      };
    },
    exit: 1,
    includes: ['"http:POST:/postings": provider batch is not on the list of repositories'],
  },
  {
    n: 34,
    name: 'the trunk moved on after the survey: a note, never a failure',
    build: (root) => adds(root, (svc) => {
      const text = survey('svc', svc.head);
      advance(svc, { 'src/new.js': 'x\n' });
      return text;
    }),
    exit: 0,
    includes: ['is behind the trunk head', 'WELL FORMED'],
  },
  {
    n: 35,
    name: 'a base the clone does not hold: every survey is checked, and it says so',
    build: (root) => ({ ...adds(root), args: ['--changed-since', 'd'.repeat(40)] }),
    exit: 0,
    includes: ['is not in this clone, so every survey is checked', '[PASS] svc'],
  },
  {
    n: 36,
    name: 'a survey changed and there is no list: cannot verify',
    build: (root) => {
      const svc = makeRemote(root, 'svc');
      return { base: {}, head: { [PATH('svc')]: survey('svc', svc.head) }, args: ['--changed-since', '{BASE}'] };
    },
    exit: 2,
    includes: ['CANNOT VERIFY: no registry at', 'REASON: registry-missing'],
  },
  {
    n: 37,
    name: 'usage: nothing chosen',
    build: (root) => ({ base: { [REG]: estate(root).reg }, head: {}, args: [] }),
    exit: 3,
    includes: ['name the surveys to check'],
  },
  {
    n: 38,
    name: 'usage: two ways of choosing at once',
    build: (root) => ({ base: { [REG]: estate(root).reg }, head: {}, args: ['--all', 'svc'] }),
    exit: 3,
    includes: ['three ways to choose; use one'],
  },
  {
    n: 39,
    name: 'an edit in the working tree is not read: the check judges what is committed',
    build: (root) => ({ ...adds(root), before: (hub) => writeFiles(hub, { [PATH('svc')]: 'garbage\n' }) }),
    exit: 0,
    includes: ['[PASS] svc'],
  },
  {
    n: 40,
    name: 'a file in the surveys folder that is not a survey',
    build: (root) => ({ ...adds(root), head: { [PATH('svc')]: null, 'docs/estate/surveys/notes.txt': 'x\n' } }),
    exit: 1,
    includes: ['[FAIL] surveys folder', 'notes.txt'],
  },
  {
    n: 41,
    name: 'a named repository with no survey',
    build: (root) => ({ base: { [REG]: estate(root).reg }, head: {}, args: ['batch'] }),
    exit: 1,
    includes: ['[FAIL] batch', 'is not in the hub at HEAD; run /survey-repo batch'],
  },
  {
    n: 42,
    name: 'the pull request deletes a survey: nothing is left to check',
    build: (root) => {
      const { svc, reg } = estate(root);
      return { base: { [REG]: reg, [PATH('svc')]: survey('svc', svc.head) }, head: { [PATH('svc')]: null }, args: ['--changed-since', '{BASE}'] };
    },
    exit: 0,
    includes: ['NOTHING TO CHECK: no survey at HEAD'],
  },
  {
    n: 43,
    name: 'an open point written as a line, the earlier shape, not as a table',
    build: (root) => adds(root, (svc) => survey('svc', svc.head, { open: 'UNRESOLVED — the dynamic calls. Owner: tech lead. Resolves: a contract.' })),
    exit: 1,
    includes: ['"## 6. Open points" holds one table, or the single line "None."'],
  },
  {
    n: 44,
    name: 'a blank line splitting a table',
    build: (root) => adds(root, (svc) => {
      const e = ev('svc', svc.head, 'src/routes.js', 1, 2);
      return survey('svc', svc.head, { serves: `${table(['Key', 'What', 'Evidence'], [['http:GET:/a', 'first', e]])}\n\n| http:GET:/b | second | ${e} |` });
    }),
    exit: 1,
    includes: ['a blank line splits it in two'],
  },
  {
    n: 45,
    name: 'the disclaimer reworded',
    build: (root) => adds(root, (svc) => survey('svc', svc.head, { disclaimer: 'This survey is the truth about the service.' })),
    exit: 1,
    includes: ['the fixed disclaimer must follow the title'],
  },
  {
    n: 46,
    name: 'the title names another repository',
    build: (root) => adds(root, (svc) => survey('svc', svc.head, { title: '# Service survey: something-else' })),
    exit: 1,
    includes: ['must be "# Service survey: svc"'],
  },
  {
    n: 47,
    name: 'the list itself is malformed: reported, form still checked, no repository asked',
    build: (root) => {
      const { svc, batch } = estate(root);
      const bad = registry({ svc: { ...entry(svc), readAt: 'abc' }, batch: entry(batch) });
      return { base: { [REG]: bad }, head: { [PATH('svc')]: survey('svc', svc.head) }, args: ['--changed-since', '{BASE}'] };
    },
    exit: 1,
    includes: ['[FAIL] registry', 'readAt must be a full 40-character commit hash', '[PASS] svc'],
  },
  {
    n: 48,
    name: 'every kind in its place: events, queues, jobs, a shared library, third-party libraries, a call to a third party\'s host',
    build: (root) => adds(root, (svc) => {
      const e = (p, a, b) => ev('svc', svc.head, p, a, b);
      return survey('svc', svc.head, {
        serves: [
          ['event:transfer.completed', 'Published when a transfer settles', e('src/routes.js', 9, 10)],
          ['http:GET:/transfers/{id}', 'Returns one transfer', e('src/routes.js', 3, 5)],
          ['job:nightly-reconcile', 'Reconciles the day', e('src/routes.js', 11, 12)],
          ['queue:payouts', 'Consumes payout requests', e('src/routes.js', 6, 6)],
        ],
        calls: [
          ['http:POST:/postings', 'batch', e('src/ledger.js', 2, 4)],
          ['http:POST:/v1/charges', 'external:api.stripe.com', e('src/ledger.js', 5, 6)],
        ],
        libs: [['lib:@acme/auth-client', '^1.4.0', e('package.json', 3, 3)]],
        third: [['lib:express', '^4.19.2', e('package.json', 4, 4)], ['lib:pg', 'any', e('package.json', 5, 5)]],
        open: [['the notification base URL is built at run time', 'tech lead', 'the next survey', e('src/ledger.js', 1, 1)]],
      });
    }),
    exit: 0,
    includes: ['[PASS] svc', '10 row(s)'],
  },
  {
    n: 50,
    name: 'a call to a third party that says only "external": the host is asked for',
    build: (root) => adds(root, (svc) => survey('svc', svc.head, { calls: [['http:POST:/v1/charges', 'external', ev('svc', svc.head, 'src/ledger.js', 5, 6)]] })),
    exit: 1,
    includes: ['"http:POST:/v1/charges": Provider "external" must name the host the call reaches: external:<host>'],
    excludes: ['provider external is not on the list'],
  },
  {
    n: 51,
    name: 'three malformed hosts: a scheme, a capital letter, a single label',
    build: (root) => adds(root, (svc) => {
      const e = ev('svc', svc.head, 'src/ledger.js', 5, 6);
      return survey('svc', svc.head, {
        calls: [
          ['http:GET:/a', 'external:https://api.stripe.com', e],
          ['http:GET:/b', 'external:API.stripe.com', e],
          ['http:GET:/c', 'external:localhost', e],
        ],
      });
    }),
    exit: 1,
    includes: ['"http:GET:/a": Provider must be a listed repository id, external:<host> with the host in lower case', '"http:GET:/b": Provider must be', '"http:GET:/c": Provider must be'],
    excludes: ['is not on the list of repositories'],
  },
  {
    n: 52,
    name: 'one library under both library sections',
    build: (root) => adds(root, (svc) => {
      const e = ev('svc', svc.head, 'package.json', 3, 3);
      return survey('svc', svc.head, { libs: [['lib:@acme/auth', '^1.2.0', e]], third: [['lib:@acme/auth', '^1.2.0', e]] });
    }),
    exit: 1,
    includes: ['"lib:@acme/auth" is under both "## 4. Shared libraries" and "## 5. Third-party libraries"'],
  },
  {
    n: 53,
    name: 'a survey in the earlier shape: refused, and told how to write it again',
    build: (root) => adds(root, (svc) => survey('svc', svc.head, { open: 'None.' }).replace('service-survey v5', 'service-survey v3')),
    exit: 1,
    includes: ['template is "service-survey v3"; this checker knows "service-survey v4", "service-survey v5", "service-survey v6". Run /survey-repo <ID> --full'],
  },
  {
    n: 54,
    name: 'open points as a table: counted, and every pointer proved',
    build: (root) => adds(root, (svc) => survey('svc', svc.head, {
      open: [
        ['the ledger host: built from LEDGER_URL at run time', 'tech lead', 'the host is named in configuration', ev('svc', svc.head, 'src/ledger.js', 1, 2)],
        ['a local file the service writes', 'tech lead', 'the grammar gains a key for local files', `${ev('svc', svc.head, 'src/db.js', 7, 8)}, ${ev('svc', svc.head, 'src/routes.js', 1, 1)}`],
      ],
    })),
    exit: 0,
    includes: ['[PASS] svc', '4 row(s), 3 file(s) cited, 2 open point(s)', 'every pointer true'],
  },
  {
    n: 55,
    name: 'an open point with no evidence, and one with a placeholder owner',
    build: (root) => adds(root, (svc) => survey('svc', svc.head, {
      open: [
        ['the ledger host', 'tech lead', 'the host is named in configuration', ''],
        ['a local file the service writes', 'TBD', 'the grammar gains a key for local files', ev('svc', svc.head, 'src/db.js', 7, 8)],
      ],
    })),
    exit: 1,
    includes: ['open point "the ledger host": a row without evidence is not a row', "an open point's Owner cell is a placeholder"],
  },
  {
    n: 56,
    name: 'an open point whose pointer runs past the end of the file',
    build: (root) => adds(root, (svc) => survey('svc', svc.head, {
      open: [['the ledger host', 'tech lead', 'the host is named in configuration', ev('svc', svc.head, 'src/ledger.js', 5, 60)]],
    })),
    exit: 1,
    includes: ['the range ends at line 60; src/ledger.js has 6 line(s)'],
  },
  {
    n: 57,
    name: 'an open points table with the wrong header',
    build: (root) => adds(root, (svc) => survey('svc', svc.head, {
      open: `| Point | Owner | Resolves | Evidence |\n|---|---|---|---|\n| the ledger host | tech lead | the host is named | ${ev('svc', svc.head, 'src/ledger.js', 1, 2)} |`,
    })),
    exit: 1,
    includes: ['"## 6. Open points" header must be | Unresolved | Owner | Resolves | Evidence |'],
  },
  {
    n: 58,
    name: 'calls whose provider the code does not name: rows with Provider unknown, counted, never an unlisted repository',
    build: (root) => adds(root, (svc) => {
      const e = ev('svc', svc.head, 'src/ledger.js', 1, 2);
      return survey('svc', svc.head, {
        calls: [
          ['http:GET:/player/form', 'unknown', e],
          ['http:POST:/postings', 'batch', ev('svc', svc.head, 'src/ledger.js', 2, 4)],
          ['queue:notifications', 'unknown', e],
        ],
        open: [['the service behind PLAYER_API_BASE is not named; its calls are under Calls with Provider unknown', 'lead architect', 'the service is named and listed', e]],
      });
    }),
    exit: 0,
    includes: ['[PASS] svc', '6 row(s), 3 file(s) cited, 1 open point(s), 2 call(s) with the provider unknown', 'every pointer true'],
    excludes: ['is not on the list of repositories'],
  },
  {
    n: 59,
    name: 'an open point that lists keys no row carries: --readers could never see them',
    build: (root) => adds(root, (svc) => survey('svc', svc.head, {
      open: [['Player calls. The base comes from PLAYER_API_BASE. Calls: http:GET:/player/form; http:POST:/player/form/{id}; event:player.done.', 'lead architect', 'the service is named and listed', ev('svc', svc.head, 'src/ledger.js', 1, 2)]],
    })),
    exit: 1,
    includes: ['an open point names 3 key(s) no row carries: "http:GET:/player/form", "http:POST:/player/form/{id}", "event:player.done"', 'goes under "## 2. Calls" with Provider unknown'],
  },
  {
    n: 60,
    name: 'an open point that names a key a row carries, and a web address: neither is a loose key',
    build: (root) => adds(root, (svc) => survey('svc', svc.head, {
      open: [['http:POST:/postings goes to batch in production; the code falls back to http://localhost:8080 in development', 'tech lead', 'the fallback is removed', ev('svc', svc.head, 'src/ledger.js', 2, 4)]],
    })),
    exit: 0,
    includes: ['[PASS] svc', '1 open point(s)'],
  },
  {
    n: 61,
    name: 'Provider unknown with a host after it: a named host is external:<host>',
    build: (root) => adds(root, (svc) => survey('svc', svc.head, { calls: [['http:POST:/postings', 'unknown:api.ledger.example', ev('svc', svc.head, 'src/ledger.js', 2, 4)]] })),
    exit: 1,
    includes: ['"http:POST:/postings": Provider "unknown" stands alone; where the code names the host, write external:<host>'],
    excludes: ['is not on the list of repositories'],
  },
  {
    n: 62,
    name: 'a declared trunk: the survey is judged against harness-main, not the default branch',
    build: (root) => {
      // The survey's commit is only on harness-main, so a read of the default branch finds it off the trunk.
      const svc = makeRemote(root, 'svc', { branch: { name: 'harness-main', commits: [{ 'checks.env': 'TRUNK_FOR_HUB=harness-main\n', 'src/harness.js': lines(3, 'harness') }] } });
      advance(svc, { 'src/bau.js': lines(4, 'bau') });
      const batch = makeRemote(root, 'batch');
      const reg = registry({ svc: { ...entry(svc), readAt: svc.branchHead, trunk: 'harness-main' }, batch: entry(batch) });
      return { base: { [REG]: reg }, head: { [PATH('svc')]: survey('svc', svc.branchHead) }, args: ['--changed-since', '{BASE}'] };
    },
    exit: 0,
    includes: ['[PASS] svc', 'every pointer true'],
    excludes: ['is not on the trunk', 'behind the trunk head'],
  },
  {
    n: 63,
    name: 'a v5 survey with http:ANY and a placeholder queue passes',
    build: (root) => adds(root, (svc) => survey('svc', svc.head, {
      serves: [['http:ANY:/proxy/{path}', 'Forwards any request', ev('svc', svc.head, 'src/routes.js', 3, 5)]],
      calls: [['queue:{orders.queue.name}', 'unknown', ev('svc', svc.head, 'src/ledger.js', 2, 4)]],
      open: [['queue:{orders.queue.name} is set in the deployment configuration', 'tech lead', 'the deployment configuration names the queue', ev('svc', svc.head, 'src/ledger.js', 2, 4)]],
    })),
    exit: 0,
    includes: ['[PASS] svc'],
  },
  {
    n: 64,
    name: 'a v4 survey still passes',
    build: (root) => adds(root, (svc) => survey('svc', svc.head).replace('service-survey v5', 'service-survey v4')),
    exit: 0,
    includes: ['[PASS] svc'],
  },
  {
    n: 65,
    name: 'a placeholder with a space or an empty name is refused',
    build: (root) => adds(root, (svc) => survey('svc', svc.head, {
      calls: [
        ['queue:{}', 'unknown', ev('svc', svc.head, 'src/ledger.js', 2, 4)],
        ['queue:{a b}', 'unknown', ev('svc', svc.head, 'src/ledger.js', 2, 4)],
      ],
    })),
    exit: 1,
    includes: ['is not a well-formed queue key'],
  },
  {
    n: 66,
    name: 'http:ANY with a lower-case method is refused',
    build: (root) => adds(root, (svc) => survey('svc', svc.head, {
      serves: [['http:any:/x', 'Forwards any request', ev('svc', svc.head, 'src/routes.js', 3, 5)]],
    })),
    exit: 1,
    includes: ['is not a well-formed http key'],
  },
  {
    n: 67,
    name: 'a part file under docs/estate/surveys is refused',
    build: (root) => adds(root, (svc) => survey('svc', svc.head).replace('kind: service-survey', 'kind: service-survey-part').replace('template: service-survey v5', 'template: service-survey v5\npart: P1')),
    exit: 1,
    includes: ['kind is "service-survey-part"; a survey\'s kind is "service-survey"', 'frontmatter key "part" is not one a survey carries'],
  },
  {
    n: 68,
    name: 'a v6 survey with "None found." in section 7 passes',
    build: (root) => adds(root, (svc) => survey('svc', svc.head, { template: V6, notRead: NONE }), { args: ['--changed-since', '{BASE}', '--offline'] }),
    exit: 0,
    includes: ['[PASS] svc'],
  },
  {
    n: 69,
    name: 'a v6 survey with no section 7 is refused, and the finding lists the seven sections',
    build: (root) => adds(root, (svc) => survey('svc', svc.head, { template: V6 })),
    exit: 1,
    includes: ['the sections must be exactly, in order:', '"## 7. Not read"'],
  },
  {
    n: 70,
    name: 'a v5 survey with no section 7 still passes',
    build: (root) => adds(root),
    exit: 0,
    includes: ['[PASS] svc'],
  },
  {
    n: 71,
    name: 'a v5 survey with a section 7 is refused, because a v5 survey has six sections',
    build: (root) => adds(root, (svc) => survey('svc', svc.head, { notRead: NONE })),
    exit: 1,
    includes: ['the sections must be exactly, in order:', 'found "## 1. Serves"'],
  },
  {
    n: 72,
    name: 'a rule that is not in the table is refused',
    build: (root) => adds(root, (svc) => survey('svc', svc.head, { template: V6, notRead: [['docs', 'docs/', '2', '100']] })),
    exit: 1,
    includes: ['rule "docs" is not one of archive, vendored, test, migration, locale, ci, harness, lock, data, asset, markup, tiny, size'],
  },
  {
    n: 73,
    name: 'a count with a separator is refused',
    build: (root) => adds(root, (svc) => survey('svc', svc.head, { template: V6, notRead: [['test', 'tests/', '3', '1,024']] })),
    exit: 1,
    includes: ['is not a whole number'],
  },
  {
    n: 74,
    name: 'a folder with no trailing slash is refused',
    build: (root) => adds(root, (svc) => survey('svc', svc.head, { template: V6, notRead: [['test', 'tests', '3', '1024']] })),
    exit: 1,
    includes: ['a folder ends in "/" or is "./"'],
  },
  {
    n: 75,
    name: 'rows out of order are refused',
    build: (root) => adds(root, (svc) => survey('svc', svc.head, { template: V6, notRead: [['test', 'tests/', '3', '1024'], ['archive', 'lib/', '1', '600000']] })),
    exit: 1,
    includes: ['rows must sort by folder, then by rule'],
  },
  {
    n: 76,
    name: 'two rules in one folder sort by the rule table, not by name, and pass',
    build: (root) => adds(root, (svc) => survey('svc', svc.head, { template: V6, notRead: [['archive', 'lib/', '1', '600000'], ['test', 'lib/', '3', '1024'], ['data', 'lib/', '2', '90']] }), { args: ['--changed-since', '{BASE}', '--offline'] }),
    exit: 0,
    includes: ['[PASS] svc'],
  },
  {
    n: 77,
    name: 'one folder and rule twice is refused',
    build: (root) => adds(root, (svc) => survey('svc', svc.head, { template: V6, notRead: [['test', 'tests/', '3', '1024'], ['test', 'tests/', '1', '10']] })),
    exit: 1,
    includes: ['is in "## 7. Not read" twice'],
  },
  {
    n: 78,
    name: 'a folder with a pipe: renderSurvey writes it escaped, and the parser reads it back',
    build: (root) => adds(root, (svc) => renderSurvey({ repository: 'svc', commit: svc.head, rows: [], openPoints: [], notRead: [{ rule: 'test', folder: 'a|b/', files: 1, bytes: 10 }] }), { args: ['--changed-since', '{BASE}', '--offline'] }),
    exit: 0,
    includes: ['[PASS] svc'],
  },
  {
    n: 79,
    name: 'a v6 survey whose section 7 equals the one built from the commit passes',
    build: (root) => adds(root, (svc) => survey('svc', svc.head, { template: V6, notRead: NOT_READ_OK })),
    exit: 0,
    includes: ['[PASS] svc'],
  },
  {
    n: 80,
    name: 'a v6 survey that leaves out a row the commit has',
    build: (root) => adds(root, (svc) => survey('svc', svc.head, { template: V6, notRead: [NOT_READ_OK[0]] })),
    exit: 1,
    includes: ['"## 7. Not read" leaves out test tests/'],
  },
  {
    n: 81,
    name: 'a v6 survey with a wrong file count',
    build: (root) => adds(root, (svc) => survey('svc', svc.head, { template: V6, notRead: [NOT_READ_OK[0], ['test', 'tests/', '2', NOT_READ_OK[1][3]]] })),
    exit: 1,
    includes: ['"## 7. Not read" says test tests/ holds 2 file(s)', 'the commit holds 1'],
  },
  {
    n: 82,
    name: 'a v6 survey with a row for a folder the commit does not hold',
    build: (root) => adds(root, (svc) => survey('svc', svc.head, { template: V6, notRead: [NOT_READ_OK[0], ['test', 'spec/', '1', '4'], NOT_READ_OK[1]] })),
    exit: 1,
    includes: ['"## 7. Not read" names test spec/, which the commit does not hold'],
  },
  {
    n: 83,
    name: 'a v5 survey of the same spoke, with no section 7, passes: the check builds none for v5',
    build: (root) => adds(root, (svc) => survey('svc', svc.head)),
    exit: 0,
    includes: ['[PASS] svc'],
    excludes: ['Not read'],
  },
  {
    n: 84,
    name: 'a v6 survey with the right file count and a wrong byte count',
    build: (root) => adds(root, (svc) => survey('svc', svc.head, { template: V6, notRead: [NOT_READ_OK[0], ['test', 'tests/', '1', '999']] })),
    exit: 1,
    includes: ['"## 7. Not read" says test tests/ holds 999 byte(s)', `the commit holds ${NOT_READ_OK[1][3]}`],
  },
  {
    n: 85,
    name: 'a v6 survey with a wrong file count and a wrong byte count in one row has both findings',
    build: (root) => adds(root, (svc) => survey('svc', svc.head, { template: V6, notRead: [NOT_READ_OK[0], ['test', 'tests/', '2', '999']] })),
    exit: 1,
    includes: ['says test tests/ holds 2 file(s), and the commit holds 1', 'says test tests/ holds 999 byte(s)', `the commit holds ${NOT_READ_OK[1][3]}`],
  },
  {
    n: 86,
    name: 'the finding for a row the survey leaves out has no semicolon',
    build: (root) => adds(root, (svc) => survey('svc', svc.head, { template: V6, notRead: [NOT_READ_OK[0]] })),
    exit: 1,
    includes: ['leaves out test tests/. The commit holds 1 file(s) of it. Run /survey-repo svc --full again'],
    excludes: ['tests/;'],
  },
  {
    n: 87,
    name: 'a v6 survey that lists a licence-marked package as vendored passes',
    build: (root) => adds(root, (svc) => survey('svc', svc.head, { template: V6, notRead: [NOT_READ_OK[0], ['vendored', 'lib/smarty/', '2', PKG_BYTES], NOT_READ_OK[1]] }), {}, PKG_FILES),
    exit: 0,
    includes: ['[PASS] svc'],
  },
  {
    n: 88,
    name: 'a v6 survey that leaves out the licence-marked package',
    build: (root) => adds(root, (svc) => survey('svc', svc.head, { template: V6, notRead: NOT_READ_OK }), {}, PKG_FILES),
    exit: 1,
    includes: ['"## 7. Not read" leaves out vendored lib/smarty/'],
  },
  {
    n: 89,
    name: 'a survey joined before the static-file rule, with the load of a stylesheet under Calls, still passes',
    build: (root) => adds(root, (svc) => survey('svc', svc.head, { calls: [['http:GET:/css/main.css', 'external:cdn.example.com', ev('svc', svc.head, 'src/ledger.js', 1, 2)]] })),
    exit: 0,
    includes: ['[PASS] svc'],
  },
  {
    n: 90,
    name: 'a v6 library row that rests on a requirements file no build file names is refused, and a row on the root manifest is not',
    build: (root) => adds(root, (svc) => survey('svc', svc.head, {
      template: V6,
      notRead: NOT_READ_OK,
      third: [['lib:express', '^4.19.2', ev('svc', svc.head, 'package.json', 3, 3)], ['lib:numpy', '==1.26.0', ev('svc', svc.head, 'tools/audio/det_requirements.txt', 2, 2)]],
    }), {}, LISTS_FILES),
    exit: 1,
    includes: ['"lib:numpy" rests on tools/audio/det_requirements.txt, which is not a manifest at', '--full again'],
    excludes: ['"lib:express" rests on'],
  },
  {
    n: 91,
    name: 'a v6 library row on a requirements file that a Dockerfile installs passes',
    build: (root) => adds(root, (svc) => survey('svc', svc.head, {
      template: V6,
      notRead: NOT_READ_OK,
      third: [['lib:numpy', '==1.26.0', ev('svc', svc.head, 'tools/audio/det_requirements.txt', 2, 2)]],
    }), {}, { ...LISTS_FILES, 'tools/audio/Dockerfile': 'FROM python:3.12\nCOPY det_requirements.txt .\nRUN pip install -r ./det_requirements.txt\n' }),
    exit: 0,
    includes: ['[PASS] svc'],
  },
  {
    n: 92,
    name: 'a v6 library row on a nested package.json is refused outside a workspace, and passes when the root package.json names its folder',
    build: (root) => adds(root, (svc) => survey('svc', svc.head, {
      template: V6,
      notRead: NOT_READ_OK,
      libs: [['lib:@acme/ui', '^2.0.0', ev('svc', svc.head, 'packages/web/package.json', 2, 2)]],
      third: [['lib:left-pad', '1.3.0', ev('svc', svc.head, 'tools/gen/package.json', 2, 2)]],
    }), {}, {
      ...LISTS_FILES,
      'package.json': `${JSON.stringify({ name: 'svc', private: true, workspaces: ['packages/*'], dependencies: { express: '^4.19.2' } }, null, 2)}\n`,
      'packages/web/package.json': lines(3, 'web manifest'),
      'tools/gen/package.json': lines(3, 'gen manifest'),
    }),
    exit: 1,
    includes: ['"lib:left-pad" rests on tools/gen/package.json, which is not a manifest at'],
    excludes: ['"lib:@acme/ui" rests on'],
  },
  {
    n: 93,
    name: 'a v5 survey with a library row on a requirements file no build file names still passes, because v5 is not held to the rule',
    build: (root) => adds(root, (svc) => survey('svc', svc.head, {
      third: [['lib:numpy', '==1.26.0', ev('svc', svc.head, 'tools/audio/det_requirements.txt', 2, 2)]],
    }), {}, LISTS_FILES),
    exit: 0,
    includes: ['[PASS] svc'],
  },
  {
    // A reader sees a code span as text, so a <word> inside backticks is not hidden.
    n: 94,
    name: 'a <word> inside a code span in a row and in an open point passes',
    build: (root) => adds(root, (svc) => survey('svc', svc.head, {
      serves: [['http:GET:/a', 'Runs `/opt/<sid>.sh` for the session', ev('svc', svc.head, 'src/routes.js', 1, 2)]],
      open: [['The script `<name>.sh` comes from the deployment', 'tech lead', 'the deployment names it', ev('svc', svc.head, 'src/routes.js', 1, 2)]],
    })),
    exit: 0,
    includes: ['[PASS] svc'],
  },
  {
    n: 95,
    name: 'a <word> outside a code span is raw HTML, and the finding quotes it and names the {word} form',
    build: (root) => adds(root, (svc) => survey('svc', svc.head, {
      serves: [['http:GET:/a', 'Runs /opt/<sid>.sh for the session', ev('svc', svc.head, 'src/routes.js', 1, 2)]],
    })),
    exit: 1,
    includes: ['carries raw HTML "<sid>"', 'Write a placeholder as {sid}'],
  },
  {
    n: 96,
    name: 'a v6 survey whose section 7 has the row of a numeric JSON file passes',
    build: (root) => adds(root, (svc) => survey('svc', svc.head, { template: V6, notRead: [NUMERIC_ROW, ...NOT_READ_OK] }), {}, NUMERIC_FILES),
    exit: 0,
    includes: ['[PASS] svc'],
  },
  {
    n: 97,
    name: 'a v6 survey whose section 7 leaves out the row of a numeric JSON file',
    build: (root) => adds(root, (svc) => survey('svc', svc.head, { template: V6, notRead: NOT_READ_OK }), {}, NUMERIC_FILES),
    exit: 1,
    includes: ['"## 7. Not read" leaves out data data/. The commit holds 1 file(s) of it'],
  },
  {
    n: 98,
    name: 'a v6 survey whose section 7 lists a lock file, a CI folder, a mock folder and a file of 16 bytes or less passes',
    build: (root) => adds(root, (svc) => survey('svc', svc.head, {
      template: V6,
      notRead: [
        ['lock', './', '1', sizeOf(RULE_FILES, 'composer.lock')],
        ['ci', '.github/', '1', sizeOf(RULE_FILES, '.github/workflows/ci.yml')],
        NOT_READ_OK[0],
        ['tiny', 'src/', '1', sizeOf(RULE_FILES, 'src/stub.txt')],
        ['test', 'src/mocks/', '1', sizeOf(RULE_FILES, 'src/mocks/a.js')],
        NOT_READ_OK[1],
      ],
    }), {}, RULE_FILES),
    exit: 0,
    includes: ['[PASS] svc'],
  },
  {
    n: 99,
    name: 'a v6 library row on a requirements file that only an excluded CI workflow names passes',
    build: (root) => adds(root, (svc) => survey('svc', svc.head, {
      template: V6,
      notRead: [['ci', '.github/', '1', String(Buffer.byteLength(CI_WORKFLOW))], ...NOT_READ_OK],
      third: [['lib:numpy', '==1.26.0', ev('svc', svc.head, 'tools/audio/det_requirements.txt', 2, 2)]],
    }), {}, { ...LISTS_FILES, '.github/workflows/ci.yml': CI_WORKFLOW }),
    exit: 0,
    includes: ['[PASS] svc'],
  },
  {
    // Only join-survey.mjs refuses this row, so a survey committed before that rule still passes.
    n: 100,
    name: 'a committed survey with a call of provider unknown to a key it serves itself passes',
    build: (root) => adds(root, (svc) => survey('svc', svc.head, {
      calls: [['http:GET:/transfers/{transfer_id}', 'unknown', ev('svc', svc.head, 'src/ledger.js', 2, 4)]],
    })),
    exit: 0,
    includes: ['[PASS] svc', '1 call(s) with the provider unknown'],
    excludes: ['a call to itself'],
  },
  {
    // Finding C4 of the survey test run: a Google custom method, a parameter inside a segment, and the case of a third party's path.
    n: 101,
    name: 'a :verb on the last segment, a parameter inside a segment, and a third party\'s path in its own case are well-formed http keys',
    build: (root) => adds(root, (svc) => survey('svc', svc.head, {
      serves: [
        ['http:GET:/v{version}/{action}-instance', 'Starts or stops an instance', ev('svc', svc.head, 'src/routes.js', 1, 2)],
        ['http:POST:/v1/models/{model_id}:predict', 'Returns a prediction', ev('svc', svc.head, 'src/routes.js', 3, 5)],
      ],
      calls: [
        ['http:POST:/postings', 'batch', ev('svc', svc.head, 'src/ledger.js', 2, 4)],
        ['http:POST:/v1/projects/{project_id}/serviceAccounts/{service_account_email}:generateAccessToken', 'external:iamcredentials.googleapis.com', ev('svc', svc.head, 'src/ledger.js', 1, 2)],
      ],
    })),
    exit: 0,
    includes: ['[PASS] svc', '5 row(s)'],
  },
  {
    n: 102,
    name: 'a :verb inside the path, two parameters side by side, an unconverted :param, and upper case outside a third party\'s call are refused',
    build: (root) => adds(root, (svc) => survey('svc', svc.head, {
      serves: [
        ['http:GET:/Transfers', 'Lists transfers', ev('svc', svc.head, 'src/routes.js', 1, 2)],
        ['http:GET:/a:b/c', 'Returns c', ev('svc', svc.head, 'src/routes.js', 1, 2)],
        ['http:GET:/files/{name}{ext}', 'Returns a file', ev('svc', svc.head, 'src/routes.js', 1, 2)],
        ['http:GET:/users/:id', 'Returns a user', ev('svc', svc.head, 'src/routes.js', 1, 2)],
      ],
      calls: [
        ['http:POST:/Postings', 'batch', ev('svc', svc.head, 'src/ledger.js', 2, 4)],
        ['http:POST:/v1/models/{model_id}:Predict', 'unknown', ev('svc', svc.head, 'src/ledger.js', 2, 4)],
      ],
    })),
    exit: 1,
    includes: [
      '"http:GET:/Transfers" is not a well-formed http key: method in capitals; each segment holds literal text and {snake_case} parameters, never two parameters side by side; a :verb only at the end of the last segment; the path in lower case, except on a call to external:<host>, where it keeps the case of the host\'s API; no trailing slash, no host or query',
      '"http:GET:/a:b/c" is not a well-formed http key',
      '"http:GET:/files/{name}{ext}" is not a well-formed http key',
      '"http:GET:/users/:id" is not a well-formed http key',
      '"http:POST:/Postings" is not a well-formed http key',
      '"http:POST:/v1/models/{model_id}:Predict" is not a well-formed http key',
    ],
  },
  {
    // A survey on template v4 or v5 keeps the old grammar for keys in open points, so an upgrade does not make it fail.
    n: 103,
    name: 'a v5 survey whose open point names a :verb key that no row carries still passes',
    build: (root) => adds(root, (svc) => survey('svc', svc.head, {
      open: [['the model call http:POST:/v1/models/{model_id}:predict reaches a host the code does not name', 'tech lead', 'the host is named', ev('svc', svc.head, 'src/ledger.js', 1, 2)]],
    })),
    exit: 0,
    includes: ['[PASS] svc', '1 open point(s)'],
  },
  {
    n: 104,
    name: 'a v6 survey whose open point names a :verb key that no row carries is refused',
    build: (root) => adds(root, (svc) => survey('svc', svc.head, {
      template: V6,
      notRead: NOT_READ_OK,
      open: [['the model call http:POST:/v1/models/{model_id}:predict reaches a host the code does not name', 'tech lead', 'the host is named', ev('svc', svc.head, 'src/ledger.js', 1, 2)]],
    })),
    exit: 1,
    includes: ['an open point names 1 key(s) no row carries: "http:POST:/v1/models/{model_id}:predict"'],
  },
  {
    n: 105,
    name: 'a v6 survey whose open point names the mixed-case key of a third party\'s call that a row carries passes',
    build: (root) => adds(root, (svc) => survey('svc', svc.head, {
      template: V6,
      notRead: NOT_READ_OK,
      calls: [
        ['http:POST:/postings', 'batch', ev('svc', svc.head, 'src/ledger.js', 2, 4)],
        ['http:POST:/v1/projects/{project_id}/serviceAccounts/{service_account_email}:generateAccessToken', 'external:iamcredentials.googleapis.com', ev('svc', svc.head, 'src/ledger.js', 1, 2)],
      ],
      open: [['http:POST:/v1/projects/{project_id}/serviceAccounts/{service_account_email}:generateAccessToken: the service account is set at deployment', 'tech lead', 'the deployment names it', ev('svc', svc.head, 'src/ledger.js', 1, 2)]],
    })),
    exit: 0,
    includes: ['[PASS] svc', '1 open point(s)'],
  },
  {
    n: 106,
    name: 'a v6 survey with a call whose whole path is one parameter, or whose first segment is a host, fails',
    build: (root) => adds(root, (svc) => {
      const calls = [
        ['http:POST:/{send_email_url}', 'unknown', ev('svc', svc.head, 'src/ledger.js', 1, 2)],
        ['http:POST:/svar.example.in/generate.php', 'unknown', ev('svc', svc.head, 'src/ledger.js', 2, 4)],
      ];
      return survey('svc', svc.head, { template: V6, notRead: NOT_READ_OK, calls });
    }),
    exit: 1,
    includes: [
      '"http:POST:/{send_email_url}": a call whose whole path is one parameter',
      '"http:POST:/svar.example.in/generate.php": the first segment "svar.example.in" is a host',
    ],
  },
];

/* ---------------------------------------------------------------------- runner */

function runFixture(fixture) {
  const root = mkdtempSync(join(tmpdir(), `survey-fx${String(fixture.n).padStart(2, '0')}-`));
  try {
    const hub = join(root, 'hub');
    const built = fixture.build(root);
    initWork(hub, 'main');
    writeFiles(hub, { 'README.md': 'the hub\n', ...built.base });
    const base = commitAll(hub, 'base');
    writeFiles(hub, built.head || {});
    commitAll(hub, 'the pull request');
    const env = { ...ENV, HARNESS_SPOKE_CACHE: join(root, 'cache') };
    if (built.before) built.before(hub, env);
    const args = built.args.map((a) => (a === '{BASE}' ? base : a));
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
    ? `\n${failed} of ${selected.length} fixtures FAILED. The surveys are not proven until this is green.\n`
    : `\nAll ${selected.length} fixtures passed.\n`);
  rmSync(SANDBOX_HOME, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
}

main();

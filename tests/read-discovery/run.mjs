#!/usr/bin/env node
/**
 * run.mjs — the fixture suite for read-discovery.mjs.
 *
 *   usage:  node run.mjs            run every fixture
 *           node run.mjs 2 6        run only the numbered fixtures
 *           node run.mjs --keep     leave the throwaway repositories on disk
 *
 * A fixture is a REPOSITORY STATE: a throwaway hub with a bare origin, the
 * discovery maps merged on its trunk, a registry, and a real bare spoke remote
 * with two commits. Commit 2 changes src/ledger/post.ts and removes
 * src/ledger/old.ts. The shipped script runs from the hub exactly as /dev-spec
 * runs it. Each fixture asserts the exit code and the text. Fixture 1 is the
 * valid control. Most others change one thing.
 *
 * Node standard library only, plus git via child_process. No test framework.
 * Exit 0 if every fixture passes, 1 if any fails.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

const SCRIPT = [
  process.env.HARNESS_READ_DISCOVERY,
  resolve(HERE, '..', '..', 'read-discovery.mjs'),
  resolve(HERE, '..', '..', 'scripts', 'read-discovery.mjs'),
].filter(Boolean).find((p) => existsSync(p));

if (!SCRIPT) {
  console.error('cannot locate read-discovery.mjs. Set HARNESS_READ_DISCOVERY=/path/to/read-discovery.mjs.');
  process.exit(4);
}

/* ------------------------------------------------------------------ git helpers */

const SANDBOX_HOME = mkdtempSync(join(tmpdir(), 'readdisc-home-'));
const ENV = {
  ...process.env,
  HOME: SANDBOX_HOME,
  XDG_CONFIG_HOME: join(SANDBOX_HOME, '.config'),
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
  GIT_ASKPASS: 'true',
};
delete ENV.HARNESS_TRUNK;
delete ENV.HARNESS_REGISTRY;

function git(cwd, args) {
  return execFileSync('git', args, { cwd, env: ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function identity(work) {
  git(work, ['config', 'user.name', 'Fixture Runner']);
  git(work, ['config', 'user.email', 'fixture@example.invalid']);
  git(work, ['config', 'commit.gpgsign', 'false']);
}

// Write each file, and remove each file whose body is null.
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

function makeRemote(root, name, commits) {
  const bare = join(root, `${name}.git`);
  const work = join(root, `${name}-work`);
  git(root, ['init', '--bare', '-q', '--initial-branch', 'main', bare]);
  git(root, ['init', '-q', '--initial-branch', 'main', work]);
  identity(work);
  const shas = [];
  commits.forEach((files, i) => {
    writeFiles(work, files);
    git(work, ['add', '-A']);
    git(work, ['commit', '-q', '-m', `commit ${i + 1}`]);
    shas.push(git(work, ['rev-parse', 'HEAD']).trim());
  });
  git(work, ['push', '-q', bare, 'main']);
  return { url: bare, shas, head: shas[shas.length - 1] };
}

// The git blob hash of a text, without git: what `git hash-object` prints.
const blobHash = (text) => {
  const buf = Buffer.from(text, 'utf8');
  return createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');
};
const pin = (text) => blobHash(text).slice(0, 12);

/* -------------------------------------------------------------- the content */

const REPO = 'sample';
const POST_V1 = 'export function postLedger() { return 1; }\n';
const POST_V2 = 'export function postLedger() { return 2; }\n';
const OLD = 'export const old = true;\n';
const TYPES = 'export type Posting = { amount: number };\n';
const LEGACY = 'export function legacyPost() { return 0; }\n';
const LOGIN = 'export function login() { return true; }\n';
const PACKAGE = '{ "name": "sample" }\n';

const SPOKE_1 = {
  'checks.env': 'TRUNK_FOR_HUB=default\nSECRET_SCAN_COMMAND=true\n',
  'README.md': '# sample\n',
  'package.json': PACKAGE,
  'src/ledger/post.ts': POST_V1,
  'src/ledger/old.ts': OLD,
  'src/ledger/types.ts': TYPES,
  'src/ledger/legacy.ts': LEGACY,
  'src/auth/login.ts': LOGIN,
};
const SPOKE_2 = { 'src/ledger/post.ts': POST_V2, 'src/ledger/old.ts': null };

const row = (cells) => `| ${cells.join(' | ')} |`;
const sep = (n) => `|${'---|'.repeat(n)}`;
const SEARCH = '`--grep postLedger --paths src/**`';

// A map in the grammar. Each table takes a list of rows or the literal 'NONE'.
function discoveryMap({
  key, ticket = key, repository = REPO, commit,
  filesRead, searches = [[SEARCH, '3', '1']], ruledOut = 'NONE', reused = 'NONE',
}) {
  const table = (header, rows) => (rows === 'NONE' ? ['NONE'] : [row(header), sep(header.length), ...rows.map(row)]);
  return [
    `# Discovery — ${key}`,
    '',
    `Ticket: ${ticket}`,
    ...(repository === null ? [] : [`Repository: ${repository}`]),
    `Commit: ${commit}`,
    '',
    '## Files read',
    '',
    ...table(['Path', 'Blob', 'Why'], filesRead),
    '',
    '## Searches',
    '',
    ...table(['Search', 'Hits', 'Kept'], searches),
    '',
    '## Ruled out',
    '',
    ...table(['Path', 'Blob', 'Search', 'Reason'], ruledOut),
    '',
    '## Reused',
    '',
    ...table(['Map', 'Path', 'Pin'], reused),
    '',
  ].join('\n');
}

const mapPath = (key) => `docs/designs/${key}.discovery.md`;
const designPath = (key) => `docs/designs/${key}.lld.md`;

// The design beside a map: the one line the script reads from it, which pins
// the map's bytes. `pinned` is the 12-hex the line carries.
const designFor = (key, pinned) => `# Design — ${key}\n\nTicket: ${key}\nDiscovery: ${key}.discovery.md@${pinned}\n`;

// The hub's maps, as a function of the spoke's first commit, which they read.
// A: this spoke, src/ledger. B: this spoke, src/auth. C: another repository,
// src/ledger. D: this spoke, a file at the root.
// Each map gets a design that pins its bytes. `designs` overrides a design by
// key, and null removes it.
function maps(c1, over = {}, designs = {}) {
  const base = {
    'SVC-101': discoveryMap({
      key: 'SVC-101', commit: c1,
      filesRead: [
        ['src/ledger/post.ts', pin(POST_V1), 'holds the posting call that the change wraps'],
        ['src/ledger/old.ts', pin(OLD), 'holds the old posting flag'],
        ['src/ledger/types.ts', pin(TYPES), 'holds the posting types'],
      ],
      ruledOut: [['src/ledger/legacy.ts', pin(LEGACY), SEARCH, 'dead code, no caller since the v2 router']],
    }),
    'SVC-102': discoveryMap({ key: 'SVC-102', commit: c1, filesRead: [['src/auth/login.ts', pin(LOGIN), 'holds the login check']] }),
    'SVC-103': discoveryMap({ key: 'SVC-103', repository: 'other', commit: c1, filesRead: [['src/ledger/post.ts', pin(POST_V1), 'holds the posting call']] }),
    'SVC-104': discoveryMap({ key: 'SVC-104', commit: c1, filesRead: [['package.json', pin(PACKAGE), 'names the package']] }),
  };
  const files = {};
  for (const [key, text] of Object.entries({ ...base, ...over })) {
    if (text === null) continue;
    files[mapPath(key)] = text;
    const d = key in designs ? designs[key] : designFor(key, pin(text));
    if (d !== null) files[designPath(key)] = d;
  }
  return files;
}

const registry = (url, head) => JSON.stringify({
  schema_version: 1,
  repositories: { [REPO]: { url, checks: 'checks.env', purpose: 'Posts money to the ledger.', readAt: head, trunk: 'default' } },
}, null, 2);

const MISSING_URL = '/nonexistent/sample.git';

/* ------------------------------------------------------------------- fixtures */

// `build(spoke)` returns { hub?, designs?, args, env?, url?, before?, expect? }.
// `hub` overrides the maps (null removes one). `designs` overrides the design
// beside a map (null removes it). `before(hub)` changes the hub after it
// is published. `expect(stdout, run)` returns extra problems, and `run(args)`
// runs the script again in the same hub.
const FIXTURES = [
  {
    n: 1,
    name: 'valid control: --paths selects map A by folder, with its drift counted; not B (another folder), C (another repository) or D (the root). A trailing slash names the folder itself',
    build: (spoke) => ({
      args: [REPO, '--paths', 'src/ledger/new.ts'],
      expect: (out, run) => {
        const problems = [];
        const line = `SVC-101 · commit ${spoke.shas[0].slice(0, 12)} · files 3 (2 drift) · searches 1 · ruled out 1 · folders src/ledger`;
        if (!out.includes(line)) problems.push(`the index has no line ${JSON.stringify(line)}`);
        const again = run([REPO, '--paths', 'src/ledger/']);
        if (again.status !== 0) problems.push(`--paths src/ledger/ exited ${again.status}`);
        if (!again.stdout.includes('Maps: 1') || !again.stdout.includes(line)) problems.push('--paths src/ledger/ does not select map A alone');
        if (!again.stdout.includes('Paths: src/ledger/')) problems.push('--paths src/ledger/ is not echoed in the header');
        return problems;
      },
    }),
    exit: 0,
    includes: [`Repository: ${REPO}`, 'Trunk: main', 'Paths: src/ledger/new.ts', 'Maps: 1', '---'],
    excludes: ['SVC-102', 'SVC-103', 'SVC-104', 'Cite:'],
  },
  {
    n: 2,
    name: '--keys A: the map text with a Pin column on Files read and Ruled out. post.ts drifted, old.ts removed, types.ts current; Cite carries the map blob',
    build: (spoke) => ({
      args: [REPO, '--paths', 'src/ledger/new.ts', '--keys', 'SVC-101'],
      expect: (out) => {
        const problems = [];
        const want = [
          `Commit: ${spoke.head}`,
          'Map: docs/designs/SVC-101.discovery.md',
          `Cite: SVC-101.discovery.md@${pin(maps(spoke.shas[0])[mapPath('SVC-101')])}`,
          '| Path | Blob | Why | Pin |',
          '|---|---|---|---|',
          `| src/ledger/post.ts | ${pin(POST_V1)} | holds the posting call that the change wraps | drift: ${pin(POST_V1)} → ${pin(POST_V2)} |`,
          `| src/ledger/old.ts | ${pin(OLD)} | holds the old posting flag | drift: ${pin(OLD)} → removed |`,
          `| src/ledger/types.ts | ${pin(TYPES)} | holds the posting types | current |`,
          '| Path | Blob | Search | Reason | Pin |',
          '|---|---|---|---|---|',
          `| src/ledger/legacy.ts | ${pin(LEGACY)} | ${SEARCH} | dead code, no caller since the v2 router | current |`,
          '| Search | Hits | Kept |\n',
        ];
        for (const w of want) if (!out.includes(w)) problems.push(`output does not contain ${JSON.stringify(w)}`);
        return problems;
      },
    }),
    exit: 0,
    includes: ['Maps: 1'],
    excludes: ['| Search | Hits | Kept | Pin |', 'SVC-102'],
  },
  {
    n: 3,
    name: '--at the commit the map read: every row of A is current, and the trunk is not asked',
    build: (spoke) => ({
      args: [REPO, '--paths', 'src/ledger/new.ts', '--keys', 'SVC-101', '--at', spoke.shas[0]],
      expect: (out, run) => {
        const problems = [];
        if (!out.includes(`Commit: ${spoke.shas[0]}`)) problems.push('the header does not pin commit 1');
        if ((out.match(/\| current \|/g) || []).length !== 4) problems.push('four rows are not all current');
        const index = run([REPO, '--paths', 'src/ledger/new.ts', '--at', spoke.shas[0].slice(0, 12)]);
        if (!index.stdout.includes('files 3 (0 drift)')) problems.push('the index at commit 1 counts drift');
        return problems;
      },
    }),
    exit: 0,
    includes: ['Trunk: not asked'],
    excludes: ['drift:'],
  },
  {
    n: 4,
    name: 'no map has a path in the folder: Maps: 0, exit 0',
    build: () => ({ args: [REPO, '--paths', 'docs/guide.md'] }),
    exit: 0,
    includes: ['Paths: docs/guide.md', 'Maps: 0', '---'],
    excludes: ['SVC-'],
  },
  {
    n: 5,
    name: 'a root file: --paths README.md selects the map that lists package.json, whose folder is "."',
    build: (spoke) => ({ args: [REPO, '--paths', 'README.md'], expect: (out) => (out.includes(`SVC-104 · commit ${spoke.shas[0].slice(0, 12)} · files 1 (0 drift) · searches 1 · ruled out 0 · folders .`) ? [] : ['no index line for SVC-104 with the folder "."']) }),
    exit: 0,
    includes: ['Maps: 1'],
    excludes: ['SVC-101', 'SVC-102'],
  },
  {
    n: 6,
    name: 'a map on an unmerged hub branch is not selected, though the working tree holds it',
    build: (spoke) => ({
      args: [REPO, '--paths', 'src/ledger/new.ts'],
      before: (hub) => {
        git(hub, ['checkout', '-q', '-b', 'feature/SVC-105']);
        const open = discoveryMap({ key: 'SVC-105', commit: spoke.shas[0], filesRead: [['src/ledger/types.ts', pin(TYPES), 'holds the posting types']] });
        writeFiles(hub, { [mapPath('SVC-105')]: open, [designPath('SVC-105')]: designFor('SVC-105', pin(open)) });
        git(hub, ['add', '-A']);
        git(hub, ['commit', '-q', '-m', 'an open map']);
        git(hub, ['push', '-q', 'origin', 'feature/SVC-105']);
      },
    }),
    exit: 0,
    includes: ['Maps: 1', 'SVC-101 · '],
    excludes: ['SVC-105'],
  },
  {
    n: 7,
    name: '--keys with a key that has no map on the trunk: exit 1, naming it',
    build: () => ({ args: [REPO, '--paths', 'src/ledger/new.ts', '--keys', 'SVC-101,SVC-109'] }),
    exit: 1,
    includes: ['SVC-109', 'docs/designs/SVC-109.discovery.md is not on the hub\'s trunk'],
  },
  {
    n: 8,
    name: 'a map in scope that breaks the grammar (a Blob of 11 characters): exit 1, naming the map and the rule',
    build: (spoke) => ({
      hub: { 'SVC-101': discoveryMap({ key: 'SVC-101', commit: spoke.shas[0], filesRead: [['src/ledger/post.ts', pin(POST_V1).slice(0, 11), 'holds the posting call']] }) },
      args: [REPO, '--paths', 'src/ledger/new.ts'],
    }),
    exit: 1,
    includes: [`docs/designs/SVC-101.discovery.md line 11: the blob "${pin(POST_V1).slice(0, 11)}" is not 12 lowercase hex characters`],
  },
  {
    n: 9,
    name: 'no --paths: usage',
    build: () => ({ args: [REPO] }),
    exit: 3,
    includes: ['--paths'],
  },
  {
    n: 10,
    name: '--paths ../x climbs out of the repository: usage',
    build: () => ({ args: [REPO, '--paths', '../x'] }),
    exit: 3,
    includes: ['"../x"'],
  },
  {
    n: 11,
    name: 'an unreachable spoke remote: cannot verify',
    build: () => ({ url: MISSING_URL, args: [REPO, '--paths', 'src/ledger/new.ts'] }),
    exit: 2,
    includes: ['CANNOT VERIFY'],
  },
  {
    n: 12,
    name: 'HARNESS_TRUNK=develop against an origin whose trunk is main: cannot verify',
    build: () => ({ env: { HARNESS_TRUNK: 'develop' }, args: [REPO, '--paths', 'src/ledger/new.ts'] }),
    exit: 2,
    includes: ['CANNOT VERIFY: HARNESS_TRUNK is "develop", and the hub\'s origin reports its default branch as "main"'],
  },
  {
    n: 13,
    name: '--keys with the map of another repository: exit 1, naming it',
    build: () => ({ args: [REPO, '--paths', 'src/ledger/new.ts', '--keys', 'SVC-103'] }),
    exit: 1,
    includes: ['docs/designs/SVC-103.discovery.md reads "other", not "sample"'],
  },
  {
    n: 14,
    name: 'a malformed map out of scope (another folder) does not stop the read',
    build: (spoke) => ({
      hub: { 'SVC-102': discoveryMap({ key: 'SVC-102', commit: spoke.shas[0], filesRead: [['src/auth/login.ts', 'short', 'holds the login check']] }) },
      args: [REPO, '--paths', 'src/ledger/new.ts'],
    }),
    exit: 0,
    includes: ['Maps: 1', 'SVC-101 · '],
  },
  {
    n: 15,
    name: 'every rule runs before exit: two broken maps in scope are both named',
    build: (spoke) => ({
      hub: {
        'SVC-101': discoveryMap({ key: 'SVC-101', ticket: 'SVC-999', commit: spoke.shas[0], filesRead: [['src/ledger/post.ts', pin(POST_V1), 'holds the posting call']] }),
        'SVC-106': discoveryMap({ key: 'SVC-106', commit: spoke.shas[0], filesRead: [['src/ledger/types.ts', pin(TYPES), 'TBD']], searches: [[SEARCH, '1', '2']] }),
      },
      args: [REPO, '--paths', 'src/ledger/new.ts'],
    }),
    exit: 1,
    includes: [
      'docs/designs/SVC-101.discovery.md line 3: "Ticket: SVC-999" is not SVC-101',
      'docs/designs/SVC-106.discovery.md line 11: the "Why" cell "TBD" is empty or a placeholder',
      'docs/designs/SVC-106.discovery.md line 17: "Kept" is 2 and "Hits" is 1',
    ],
  },
  {
    n: 16,
    name: 'the columns of a table out of the grammar\'s order: the map is refused, as the gate refuses it',
    build: (spoke) => ({
      hub: { 'SVC-101': discoveryMap({ key: 'SVC-101', commit: spoke.shas[0], filesRead: [['src/ledger/post.ts', pin(POST_V1), 'holds the posting call']] }).replace('| Path | Blob | Why |', '| Blob | Path | Why |') },
      args: [REPO, '--paths', 'src/ledger/new.ts', '--keys', 'SVC-101'],
    }),
    exit: 1,
    includes: ['the "Files read" section carries no table with the header "| Path | Blob | Why |"'],
  },
  {
    n: 17,
    name: 'a bad key in --keys: usage',
    build: () => ({ args: [REPO, '--paths', 'src/ledger/new.ts', '--keys', 'svc-101'] }),
    exit: 3,
    includes: ['"svc-101"'],
  },
  {
    n: 18,
    name: 'a bad --at: usage',
    build: () => ({ args: [REPO, '--paths', 'src/ledger/new.ts', '--at', 'HEAD'] }),
    exit: 3,
    includes: ['--at must be'],
  },
  {
    n: 19,
    name: 'an unknown option: usage',
    build: () => ({ args: [REPO, '--paths', 'src/ledger/new.ts', '--all'] }),
    exit: 3,
    includes: ['unknown option --all'],
  },
  {
    n: 20,
    name: 'an empty path and an absolute path: usage',
    build: () => ({
      args: [REPO, '--paths', 'src/a.ts,,src/b.ts'],
      expect: (out, run) => (run([REPO, '--paths', '/etc/passwd']).status === 3 ? [] : ['--paths /etc/passwd is not refused as usage']),
    }),
    exit: 3,
    includes: ['empty path'],
  },
  {
    n: 21,
    name: 'a hub with no origin to fetch its trunk from: cannot verify',
    build: () => ({ args: [REPO, '--paths', 'src/ledger/new.ts'], before: (hub) => git(hub, ['remote', 'remove', 'origin']) }),
    exit: 2,
    includes: ['CANNOT VERIFY'],
  },
  {
    n: 22,
    name: 'a reused map pin that no commit on the hub trunk ever held: refused, as the gate refuses it',
    build: (spoke) => ({
      hub: { 'SVC-101': discoveryMap({ key: 'SVC-101', commit: spoke.shas[0], filesRead: [['src/ledger/post.ts', pin(POST_V1), 'holds the posting call']], reused: [['SVC-102.discovery.md@0123456789ab', 'src/auth/login.ts', 'current']] }) },
      args: [REPO, '--paths', 'src/ledger/new.ts'],
    }),
    exit: 1,
    includes: ['no commit on the hub\'s trunk ever held docs/designs/SVC-102.discovery.md at 0123456789ab'],
  },
  {
    n: 23,
    name: 'the state of fixture 16 in index mode: a map whose Files read table cannot be read is not ruled out, so it is refused',
    build: (spoke) => ({
      hub: { 'SVC-101': discoveryMap({ key: 'SVC-101', commit: spoke.shas[0], filesRead: [['src/ledger/post.ts', pin(POST_V1), 'holds the posting call']] }).replace('| Path | Blob | Why |', '| Blob | Path | Why |') },
      args: [REPO, '--paths', 'src/ledger/new.ts'],
    }),
    exit: 1,
    includes: ['docs/designs/SVC-101.discovery.md: the "Files read" section carries no table with the header "| Path | Blob | Why |"'],
  },
  {
    n: 24,
    name: 'a map with no Repository: line in index mode: it cannot be ruled out by repository, so it is refused',
    build: (spoke) => ({
      hub: { 'SVC-106': discoveryMap({ key: 'SVC-106', repository: null, commit: spoke.shas[0], filesRead: [['src/ledger/types.ts', pin(TYPES), 'holds the posting types']] }) },
      args: [REPO, '--paths', 'src/ledger/new.ts'],
    }),
    exit: 1,
    includes: ['docs/designs/SVC-106.discovery.md carries no "Repository:" line'],
  },
  {
    n: 25,
    name: 'a path cell in a form other than the one git prints (./x, a doubled slash, a ./ segment, a trailing slash): the map is refused, as the gate refuses it',
    build: (spoke) => ({
      hub: {
        'SVC-101': discoveryMap({
          key: 'SVC-101', commit: spoke.shas[0],
          filesRead: [
            ['./src/ledger/post.ts', pin(POST_V1), 'holds the posting call'],
            ['src//ledger/old.ts', pin(OLD), 'holds the old posting flag'],
            ['src/./ledger/types.ts', pin(TYPES), 'holds the posting types'],
            ['src/ledger/', pin(TYPES), 'holds the ledger folder'],
          ],
        }),
      },
      args: [REPO, '--paths', 'src/ledger/new.ts'],
    }),
    exit: 1,
    includes: [
      'the path "./src/ledger/post.ts" is not a relative path in the repository',
      'the path "src//ledger/old.ts" is not a relative path in the repository',
      'the path "src/./ledger/types.ts" is not a relative path in the repository',
      'the path "src/ledger/" is not a relative path in the repository',
    ],
    excludes: ['→ removed'],
  },
  {
    n: 26,
    name: 'a map in scope whose design pins other bytes: refused, because no person approved these bytes with the design',
    build: () => ({
      designs: { 'SVC-101': designFor('SVC-101', '0123456789ab') },
      args: [REPO, '--paths', 'src/ledger/new.ts'],
      expect: (out, run) => (run([REPO, '--paths', 'src/auth/login.ts', '--keys', 'SVC-101']).status === 1 ? [] : ['--keys SVC-101 out of scope is not refused']),
    }),
    exit: 1,
    includes: ['docs/designs/SVC-101.lld.md pins "SVC-101.discovery.md@0123456789ab"', 'Status: NOT READ: 1 finding(s)'],
    excludes: ['SVC-101 · '],
  },
  {
    n: 27,
    name: 'a map in scope with no design beside it on the trunk: refused',
    build: () => ({
      designs: { 'SVC-101': null },
      args: [REPO, '--paths', 'src/ledger/new.ts'],
    }),
    exit: 1,
    includes: ['docs/designs/SVC-101.discovery.md has no design beside it: docs/designs/SVC-101.lld.md is not on the hub\'s trunk'],
    excludes: ['SVC-101 · '],
  },
  {
    n: 28,
    name: 'a map out of scope that no design pins does not stop the read, and a design with no Discovery: line pins nothing',
    build: () => ({
      designs: { 'SVC-102': null, 'SVC-104': '# Design — SVC-104\n\nTicket: SVC-104\n' },
      args: [REPO, '--paths', 'src/ledger/new.ts'],
      expect: (out, run) => {
        const res = run([REPO, '--paths', 'README.md']);
        return `${res.stdout}${res.stderr}`.includes('docs/designs/SVC-104.lld.md carries 0 "Discovery:" lines') && res.status === 1 ? [] : [`--paths README.md does not refuse SVC-104: exit ${res.status}`];
      },
    }),
    exit: 0,
    includes: ['Maps: 1', 'SVC-101 · '],
  },
  {
    n: 29,
    name: '--paths in a form other than the one git prints (./x, a doubled slash): usage. One trailing slash still names a folder',
    build: () => ({
      args: [REPO, '--paths', './src/ledger/new.ts'],
      expect: (out, run) => (run([REPO, '--paths', 'src//ledger/new.ts']).status === 3 ? [] : ['--paths src//ledger/new.ts is not refused as usage']),
    }),
    exit: 3,
    includes: ['"./src/ledger/new.ts"'],
  },
];

/* ------------------------------------------------------------------ runner */

function publishHub(root, hub) {
  const bare = join(root, 'hub-origin.git');
  git(root, ['init', '--bare', '-q', '--initial-branch', 'main', bare]);
  git(hub, ['init', '-q', '--initial-branch', 'main']);
  identity(hub);
  git(hub, ['add', '-A']);
  git(hub, ['commit', '-q', '--allow-empty', '-m', 'the hub trunk']);
  git(hub, ['remote', 'add', 'origin', bare]);
  git(hub, ['push', '-q', 'origin', 'main']);
}

function runFixture(fixture) {
  const root = mkdtempSync(join(tmpdir(), `readdisc-fx${String(fixture.n).padStart(2, '0')}-`));
  try {
    const spoke = makeRemote(root, REPO, [SPOKE_1, SPOKE_2]);
    const built = fixture.build(spoke);
    const hub = join(root, 'hub');
    mkdirSync(hub, { recursive: true });
    writeFiles(hub, {
      'CLAUDE.md': '# Constitution\n',
      'docs/estate/repositories.json': registry(built.url || spoke.url, spoke.head),
      ...maps(spoke.shas[0], built.hub || {}, built.designs || {}),
    });
    publishHub(root, hub);
    const env = { ...ENV, HARNESS_SPOKE_CACHE: join(root, 'cache'), ...(built.env || {}) };
    if (built.before) built.before(hub);
    const run = (args) => spawnSync(process.execPath, [SCRIPT, ...args], { cwd: hub, env, encoding: 'utf8' });
    const res = run(built.args);
    const output = `${res.stdout || ''}${res.stderr || ''}`;
    const problems = [];
    if (res.status !== fixture.exit) problems.push(`expected exit ${fixture.exit}, got ${res.status}`);
    for (const needle of fixture.includes || []) {
      if (!output.includes(needle)) problems.push(`output does not contain: ${JSON.stringify(needle)}`);
    }
    for (const needle of fixture.excludes || []) {
      if (output.includes(needle)) problems.push(`output should not contain: ${JSON.stringify(needle)}`);
    }
    if (built.expect) problems.push(...built.expect(res.stdout || '', run));
    return { problems, output };
  } catch (err) {
    return { problems: [`fixture setup failed: ${err && err.message ? err.message : String(err)}`], output: '' };
  } finally {
    if (!process.argv.includes('--keep')) rmSync(root, { recursive: true, force: true });
  }
}

function main() {
  const wanted = process.argv.slice(2).filter((a) => a.search(/^\d+$/) === 0).map(Number);
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
    ? `\n${failed} of ${selected.length} fixtures FAILED. The discovery read is not trustworthy until this is green.\n`
    : `\nAll ${selected.length} fixtures passed.\n`);
  rmSync(SANDBOX_HOME, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
}

main();

#!/usr/bin/env node
/**
 * run.mjs — the fixture suite for check-survey-secrets.mjs, the Gitleaks scan of /survey-repo.
 *
 *   usage:  node run.mjs            run every fixture, against a scripted stand-in for docker
 *           node run.mjs 2 6        run only the numbered fixtures
 *           node run.mjs --keep     leave the throwaway repositories on disk
 *           node run.mjs --real     run the shipped scan with the real pinned image (see REAL below)
 *
 * A fixture is a REPOSITORY STATE: a throwaway hub whose committed revision carries the Gitleaks
 * pin and rules under scripts/gitleaks/, a throwaway spoke clone with a .gitleaksignore at the
 * pinned commit or none, and a stand-in `docker` first on the PATH. The stand-in records each call
 * as a JSON line: its arguments, its mounts, the names in each mount and the files under the /scan
 * mount. A fixture that needs a tree git would not commit from a working tree (one path twice, or
 * a path that is a file and a folder) writes it with `git mktree`. For `run ... version`
 * it prints the version the fixture asks for. For `run ... dir /scan ...` it writes the fixture's
 * findings as a Gitleaks JSON report to the file --report-path names under the /out mount, in the
 * shape the real image writes (`File` is the path in the container, under /scan/tree/). Like the
 * real image, it reports the canary under /scan/canary/ and skips a line that carries
 * `gitleaks:allow`, unless the command has `--ignore-gitleaks-allow`. The shipped script runs as
 * /survey-repo runs it, and the exit code and the report text are asserted. Fixture 1 is the valid
 * control. Most others change exactly one thing. Every path, fingerprint and commit is synthetic.
 *
 * Node standard library only, plus git via child_process. No test framework.
 * Exit 0 if every fixture passes, 1 if any fails.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

// The library layout first (accelerator/gate/), then the installed one (scripts/ beside tests/).
const SCRIPT = [
  process.env.HARNESS_CHECK_SURVEY_SECRETS,
  resolve(HERE, '..', '..', 'check-survey-secrets.mjs'),
  resolve(HERE, '..', '..', 'scripts', 'check-survey-secrets.mjs'),
].filter(Boolean).find((p) => existsSync(p));

if (!SCRIPT) {
  console.error('cannot locate check-survey-secrets.mjs. Set HARNESS_CHECK_SURVEY_SECRETS=/path/to/check-survey-secrets.mjs.');
  process.exit(4);
}

// The pin of the fixture hub: deliberately not the shipped one, which lives in gitleaks.json alone.
const PIN = '9.9.9';
const RULES = '# fixture rules\n[extend]\nuseDefault = true\n';
const RULES_HASH = createHash('sha256').update(RULES).digest('hex').slice(0, 12);

const SANDBOX_HOME = mkdtempSync(join(tmpdir(), 'survey-secrets-home-'));
const ENV = {
  ...process.env,
  HOME: SANDBOX_HOME,
  XDG_CONFIG_HOME: join(SANDBOX_HOME, '.config'),
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
  GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
};
delete ENV.GITLEAKS_IMAGE;
delete ENV.SHL_SURVEY_SECRETS_CASE_INSENSITIVE;

function git(cwd, args) {
  return execFileSync('git', args, { cwd, env: ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function writeFiles(root, files) {
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(root, rel);
    if (body === null) { rmSync(abs, { recursive: true, force: true }); continue; }
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }
}

function commitAll(dir, message) {
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', message]);
  return git(dir, ['rev-parse', 'HEAD']).trim();
}

/* ------------------------------------------------------------------ the stand-in for docker */

/**
 * The scripted `docker`, driven by the spec file FAKE_DOCKER names. It logs every call. `image inspect`
 * answers present, missing or daemon down; `pull` succeeds, fails or hangs; `run` plays Gitleaks.
 */
const FAKE_DOCKER = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const spec = JSON.parse(fs.readFileSync(process.env.FAKE_DOCKER, 'utf8'));
const argv = process.argv.slice(2);
const record = { argv };
const log = () => fs.appendFileSync(spec.log, JSON.stringify(record) + '\\n');
if (argv[0] === 'image' && argv[1] === 'inspect') {
  log();
  if (spec.daemon === 'down') { process.stderr.write('Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?\\n'); process.exit(1); }
  if (spec.image === 'missing' && !fs.existsSync(spec.pulled)) { process.stderr.write('Error response from daemon: No such image: ' + argv[argv.length - 1] + '\\n'); process.exit(1); }
  process.stdout.write('sha256:fake\\n');
  process.exit(0);
}
if (argv[0] === 'pull') {
  log();
  if (spec.pull === 'hang') Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 8000);
  if (spec.pull === 'fail') { process.stderr.write('Error response from daemon: Get "https://registry-1.docker.io/v2/": dial tcp: lookup registry-1.docker.io: no such host\\n'); process.exit(1); }
  fs.writeFileSync(spec.pulled, '');
  process.exit(0);
}
if (argv[0] === 'run') {
  const mounts = {};
  argv.forEach((a, i) => {
    if (a !== '--mount') return;
    const o = Object.fromEntries(argv[i + 1].split(',').map((p) => { const at = p.indexOf('='); return at < 0 ? [p, true] : [p.slice(0, at), p.slice(at + 1)]; }));
    mounts[o.dst] = { src: o.src, readonly: o.readonly === true, names: fs.readdirSync(o.src) };
  });
  const image = argv[argv.indexOf('-w') + 2];
  const command = argv.slice(argv.indexOf('-w') + 3);
  // What the container would see under /scan: each entry's kind, and the text of a regular file.
  const walk = (dir, base = '') => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) return walk(abs, base + e.name + '/');
    if (e.isSymbolicLink()) return [[base + e.name, { kind: 'symlink', target: fs.readlinkSync(abs) }]];
    return [[base + e.name, { kind: 'file', text: fs.readFileSync(abs, 'utf8') }]];
  });
  Object.assign(record, { image, command, mounts, files: mounts['/scan'] ? Object.fromEntries(walk(mounts['/scan'].src)) : null });
  log();
  if (command[0] === 'version') { process.stdout.write('v' + (spec.version || '') + '\\n'); process.exit(0); }
  if (command[0] === 'dir') {
    if (spec.sleepMs) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, spec.sleepMs);
    if (spec.stderr) process.stderr.write(spec.stderr);
    const target = command[1];
    const reportPath = command[command.indexOf('--report-path') + 1];
    const out = path.join(mounts['/out'].src, reportPath.slice('/out/'.length));
    // As the real image does: a line that carries gitleaks:allow is skipped without --ignore-gitleaks-allow,
    // and the canary (a private-key block under canary/) is reported at line 1 unless the fixture says it is not seen.
    const lineOf = (rel, n) => { const e = record.files[rel]; return e && e.kind === 'file' ? (e.text.split('\\n')[n - 1] || '') : ''; };
    const honoursAllow = !command.includes('--ignore-gitleaks-allow');
    const findings = (spec.findings || [])
      .map((f) => ({ ...f, rel: f.at || 'tree/' + f.file }))
      .filter((f) => f.line === 0 || !honoursAllow || !lineOf(f.rel, f.line).includes('gitleaks:allow'));
    if (spec.canary !== false) {
      for (const [rel, e] of Object.entries(record.files)) {
        if (rel.startsWith('canary/') && e.kind === 'file' && e.text.includes('-----BEGIN ' + 'PRIVATE KEY-----')) findings.push({ rel, rule: 'private-key', line: 1, endLine: e.text.split('\\n').length - 1 });
      }
    }
    const report = findings.map((f) => {
      const file = target + '/' + f.rel;
      return { RuleID: f.rule, Description: 'fixture', StartLine: f.line, EndLine: f.endLine || f.line, StartColumn: 1, EndColumn: 2, Match: f.match || 'key = "REDACTED"', Secret: f.secret || 'REDACTED', File: file, SymlinkFile: '', Commit: '', Entropy: 4, Author: '', Email: '', Date: '', Message: '', Tags: [], Fingerprint: file + ':' + f.rule + ':' + f.line };
    });
    if (spec.report !== false) fs.writeFileSync(out, spec.rawReport !== undefined ? spec.rawReport : JSON.stringify(report, null, 1));
    process.exit(spec.status === undefined ? 0 : spec.status);
  }
  process.exit(0);
}
log();
process.exit(0);
`;

/** The stand-in in <root>/bin, with its spec and call log. */
function fakeDocker(root, spec = {}) {
  const bin = join(root, 'bin', 'docker');
  mkdirSync(dirname(bin), { recursive: true });
  writeFileSync(bin, FAKE_DOCKER);
  chmodSync(bin, 0o755);
  const specFile = join(root, 'fake-docker.json');
  const log = join(root, 'docker-log.jsonl');
  writeFileSync(specFile, JSON.stringify({ log, pulled: join(root, 'pulled'), version: PIN, ...spec }));
  return { env: { FAKE_DOCKER: specFile, PATH: `${join(root, 'bin')}${delimiter}${process.env.PATH}` }, log };
}
const dockerCalls = (d) => (existsSync(d.log) ? readFileSync(d.log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

/* ------------------------------------------------------------------ the hub and the spoke */

/** A ustar archive of [name, bytes] pairs, written here so that no archive is committed. */
function tar(entries) {
  const blocks = [];
  for (const [name, body] of entries) {
    const head = Buffer.alloc(512);
    head.write(name, 0, 100);
    head.write('0000644\0', 100);
    head.write('0000000\0', 108);
    head.write('0000000\0', 116);
    head.write(`${body.length.toString(8).padStart(11, '0')}\0`, 124);
    head.write('00000000000\0', 136);
    head.fill(' ', 148, 156);
    head.write('0', 156);
    head.write('ustar\0', 257);
    head.write('00', 263);
    let sum = 0;
    for (const b of head) sum += b;
    head.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
    blocks.push(head, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}
const tarGz = (entries) => gzipSync(tar(entries.map(([n, b]) => [n, Buffer.from(b)])));

/**
 * Point the clone's branch at a commit of a crafted root tree: `entries` are [mode, path, text],
 * where a path with one '/' puts its file in a subtree. git commits no such tree from a working tree.
 */
function craftCommit(clone, entries) {
  const blob = (text) => execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: clone, env: ENV, input: text, encoding: 'utf8' }).trim();
  const mktree = (rows) => execFileSync('git', ['mktree'], { cwd: clone, env: ENV, input: rows.join(''), encoding: 'utf8' }).trim();
  const rows = entries.map(([mode, path, text]) => {
    const at = path.indexOf('/');
    if (at < 0) return `${mode} blob ${blob(text)}\t${path}\n`;
    return `040000 tree ${mktree([`${mode} blob ${blob(text)}\t${path.slice(at + 1)}\n`])}\t${path.slice(0, at)}\n`;
  });
  const commit = execFileSync('git', ['commit-tree', '-m', 'crafted', mktree(rows)], { cwd: clone, env: ENV, encoding: 'utf8' }).trim();
  git(clone, ['update-ref', 'HEAD', commit]);
  return commit;
}

/** A hub whose committed revision carries the pin and the rules, in the installed or the library layout. */
function hub(root, { pin = PIN, layout = 'installed' } = {}) {
  const dir = join(root, 'hub');
  mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q', '-b', 'main']);
  const base = layout === 'library' ? 'accelerator/gate/gitleaks' : 'scripts/gitleaks';
  writeFiles(dir, layout === 'none' ? { 'README.md': '# hub\n' }
    : { 'README.md': '# hub\n', [`${base}/gitleaks.json`]: `${JSON.stringify({ gitleaks: pin })}\n`, [`${base}/gitleaks.toml`]: RULES });
  return { dir, commit: commitAll(dir, 'chore: the hub') };
}

const CODE = {
  'src/config.ts': 'export const config = {\n  region: "eu-west-1",\n  key: "<synthetic>",\n};\n',
  'src/db.ts': 'const url = "<synthetic>";\nexport default url;\n',
  'tests/key.pem': '<synthetic one-line file>\n',
};

const IGNORE = [
  '# Accepted findings. Synthetic fingerprints for the fixture suite.',
  '',
  'src/config.ts:generic-api-key:3',
  '1111111111111111111111111111111111111111:src/config.ts:generic-api-key:3',
  'tests/key.pem:private-key:1',
  '',
].join('\n');

const TWO_FINDINGS = [
  { file: 'src/config.ts', rule: 'generic-api-key', line: 3 },
  { file: 'tests/key.pem', rule: 'private-key', line: 1 },
];

// Built from parts: the watermark suite refuses a tracked file that holds the header whole.
const PEM_HEADER = `-----BEGIN ${'PRIVATE'} KEY-----\n`;
const P12 = { file: 'cert.p12', rule: 'pkcs12-file', line: 0 };
const ALLOWED = 'export const config = {\n  region: "eu-west-1",\n  key: "<synthetic>", // gitleaks:allow\n};\n';
const scanCall = (calls) => calls.find((c) => c.argv[0] === 'run' && c.command && c.command[0] === 'dir') || { files: {}, mounts: {}, command: [], argv: [] };

const secretValue = 'synthetic-value-0f3a9c';
const runCalls = (calls) => calls.filter((c) => c.argv[0] === 'run');
const flags = (c, list) => list.filter((x) => !c.argv.includes(x)).map((x) => `no ${x} in the docker call`);
// A PATH that has git and no docker.
const GIT_ONLY = (() => {
  const dir = mkdtempSync(join(tmpdir(), 'survey-secrets-gitonly-'));
  const git = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  symlinkSync(git, join(dir, 'git'));
  return dir;
})();

/** Whether this machine's temporary folder ignores the case of letters, as the script's probe asks. */
const CASELESS = (() => {
  const dir = mkdtempSync(join(tmpdir(), 'survey-secrets-case-'));
  writeFileSync(join(dir, 'case-probe'), '');
  const caseless = existsSync(join(dir, 'CASE-PROBE'));
  rmSync(dir, { recursive: true, force: true });
  return caseless;
})();

/**
 * Build one fixture. `files` is the commit the survey pins; `after` edits the working tree or makes
 * a second commit. `docker` is the stand-in's spec. `history` is a list of file changes, each
 * committed in turn before `files`. A change, and `files`, may be a function of the commits made so
 * far. `shallow` scans a clone of depth 1 of the result.
 */
function build(root, { files = { ...CODE, '.gitleaksignore': IGNORE }, history = [], shallow = false, links = {}, after, craft, docker = {}, hubOptions = {} } = {}) {
  const h = hub(root, hubOptions);
  let clone = join(root, 'clone');
  mkdirSync(clone, { recursive: true });
  git(clone, ['init', '-q', '-b', 'main']);
  const made = [];
  for (const change of history) {
    writeFiles(clone, typeof change === 'function' ? change(made) : change);
    made.push(commitAll(clone, `history ${made.length + 1}`));
  }
  writeFiles(clone, typeof files === 'function' ? files(made) : files);
  for (const [rel, to] of Object.entries(links)) symlinkSync(to, join(clone, rel));
  let commit = commitAll(clone, 'spoke');
  if (craft) commit = craftCommit(clone, craft);
  if (after) after(clone);
  if (shallow) {
    const full = clone;
    clone = join(root, 'shallow');
    git(root, ['clone', '-q', '--depth', '1', `file://${full}`, clone]);
  }
  return { hub: h, clone, commit, history: made, docker: fakeDocker(root, docker) };
}

function run(f, args, env = {}) {
  const res = spawnSync(process.execPath, [SCRIPT, ...args], { env: { ...ENV, ...f.docker.env, ...env }, encoding: 'utf8' });
  return { status: res.status, stdout: res.stdout || '', stderr: res.stderr || '' };
}
const std = (f) => ['--clone', f.clone, '--commit', f.commit, '--hub', f.hub.dir];

/* ------------------------------------------------------------------ fixtures */

const FIXTURES = [
  { n: 1, name: 'control: two findings, each with a file entry', setup: { docker: { findings: TWO_FINDINGS } }, exit: 0,
    out: ['.gitleaksignore: 2 file entries, 1 commit entries at', `gitleaks ${PIN}, rules ${RULES_HASH}`,
      '[ACCEPTED] src/config.ts L3: generic-api-key (.gitleaksignore: src/config.ts:generic-api-key:3)',
      '[ACCEPTED] tests/key.pem L1: private-key (.gitleaksignore: tests/key.pem:private-key:1)'],
    absent: ['[LIVE]'] },
  { n: 2, name: 'no finding and no .gitleaksignore', setup: { files: CODE }, exit: 0,
    out: ['.gitleaksignore: none at', `gitleaks ${PIN}, rules ${RULES_HASH}`], absent: ['[LIVE]', '[ACCEPTED]'] },
  { n: 3, name: 'a finding with no entry', setup: { files: CODE, docker: { findings: [TWO_FINDINGS[0]] } }, exit: 1,
    out: ['.gitleaksignore: none at', '[LIVE] src/config.ts L3: generic-api-key'], absent: ['[ACCEPTED]'] },

  /* Fixtures 4 to 32: the interface, the Docker refusals and the matching of entries. */

  { n: 4, name: 'an entry with the wrong rule does not accept',
    setup: { files: { ...CODE, '.gitleaksignore': 'src/config.ts:private-key:3\n' }, docker: { findings: [TWO_FINDINGS[0]] } }, exit: 1,
    out: ['.gitleaksignore: 1 file entries, 0 commit entries at', '[LIVE] src/config.ts L3: generic-api-key'], absent: ['[ACCEPTED]'] },
  { n: 5, name: 'an entry with the wrong line does not accept',
    setup: { files: { ...CODE, '.gitleaksignore': 'src/config.ts:generic-api-key:2\n' }, docker: { findings: [TWO_FINDINGS[0]] } }, exit: 1,
    out: ['[LIVE] src/config.ts L3: generic-api-key'], absent: ['[ACCEPTED]'] },
  { n: 6, name: 'a commit entry for a commit outside the history accepts nothing',
    setup: { files: { ...CODE, '.gitleaksignore': '2222222222222222222222222222222222222222:src/config.ts:generic-api-key:3\n' }, docker: { findings: [TWO_FINDINGS[0]] } }, exit: 1,
    out: ['.gitleaksignore: 0 file entries, 1 commit entries at', '[LIVE] src/config.ts L3: generic-api-key'], absent: ['[ACCEPTED]', 'note:'] },
  { n: 7, name: 'a .gitleaksignore changed only in the working tree is not read',
    setup: { files: CODE, docker: { findings: [TWO_FINDINGS[0]] }, after: (c) => writeFiles(c, { '.gitleaksignore': IGNORE }) }, exit: 1,
    out: ['.gitleaksignore: none at', '[LIVE] src/config.ts L3: generic-api-key'], absent: ['[ACCEPTED]'] },
  { n: 8, name: 'the root .gitleaksignore and a .gitleaks.toml with an allowlist are exported and scanned, and a finding in either is live',
    setup: { files: { ...CODE, '.gitleaksignore': IGNORE, '.gitleaks.toml': '[allowlist]\npaths = [".*"]\n' },
      docker: { findings: [...TWO_FINDINGS, { file: '.gitleaks.toml', rule: 'generic-api-key', line: 2 }, { file: '.gitleaksignore', rule: 'generic-api-key', line: 1 }] } }, exit: 1,
    out: ['.gitleaksignore: 2 file entries, 1 commit entries at', '[ACCEPTED] src/config.ts L3', '[LIVE] .gitleaks.toml L2: generic-api-key', '[LIVE] .gitleaksignore L1: generic-api-key'],
    check: (f, calls) => {
      const files = Object.keys(scanCall(calls).files);
      return ['tree/.gitleaks.toml', 'tree/.gitleaksignore', 'tree/src/config.ts'].filter((p) => !files.includes(p)).map((p) => `not exported: ${p}`);
    } },
  { n: 9, name: 'the container has no network, a read-only root, no capability, redacted output, exit code 0, archives opened, inline markers ignored and an empty ignore folder; /scan, /rules and /no-ignore read-only, /out writable',
    setup: { files: CODE }, exit: 0,
    check: (f, calls) => {
      const c = scanCall(calls);
      const problems = flags(c, ['--network', 'none', '--read-only', '--cap-drop', 'ALL', 'no-new-privileges']);
      if (!c.command.includes('--redact')) problems.push('no --redact');
      if (c.command[c.command.indexOf('--exit-code') + 1] !== '0') problems.push('no --exit-code 0');
      if (c.command[c.command.indexOf('--config') + 1] !== '/rules/gitleaks.toml') problems.push('--config is not /rules/gitleaks.toml');
      if (c.command[c.command.indexOf('--max-archive-depth') + 1] !== '8') problems.push('no --max-archive-depth 8');
      if (!c.command.includes('--ignore-gitleaks-allow')) problems.push('no --ignore-gitleaks-allow');
      const ignorePath = c.command.includes('--gitleaks-ignore-path') ? c.command[c.command.indexOf('--gitleaks-ignore-path') + 1] : null;
      if (!ignorePath || !c.mounts[ignorePath] || c.mounts[ignorePath].names.length !== 0) problems.push(`--gitleaks-ignore-path does not name an empty mount: ${ignorePath}`);
      for (const dst of ['/scan', '/rules', ignorePath]) if (!(c.mounts[dst] && c.mounts[dst].readonly)) problems.push(`${dst} is not read-only`);
      if (!(c.mounts['/out'] && !c.mounts['/out'].readonly)) problems.push('/out is not writable');
      return problems;
    } },
  { n: 10, name: 'a version that is not the pin cannot verify', setup: { docker: { version: '8.0.0' } }, exit: 2,
    err: [`CANNOT VERIFY: gitleaks 8.0.0 ran, the hub pins ${PIN}`], absent: ['[ACCEPTED]', '[LIVE]'] },
  { n: 11, name: 'no docker on the PATH cannot verify', setup: { files: CODE }, env: { PATH: GIT_ONLY }, exit: 2,
    err: ['CANNOT VERIFY: Docker is not installed', 'https://docs.docker.com/get-docker/'] },
  { n: 12, name: 'a Docker daemon that is down cannot verify', setup: { files: CODE, docker: { daemon: 'down' } }, exit: 2,
    err: ['CANNOT VERIFY: Docker is not running or cannot be used'],
    check: (f, calls) => (runCalls(calls).length ? ['docker ran'] : []) },
  { n: 13, name: 'a missing image without --pull cannot verify', setup: { files: CODE, docker: { image: 'missing' } }, exit: 2,
    err: [`the Gitleaks image is not on this machine yet; fetch it once with: docker pull zricethezav/gitleaks:v${PIN}`],
    check: (f, calls) => (calls.some((c) => c.argv[0] === 'pull') ? ['docker pulled'] : []) },
  { n: 14, name: 'a missing image with --pull is fetched once, then the scan runs',
    setup: { files: CODE, docker: { image: 'missing' } }, args: (f) => [...std(f), '--pull'], exit: 0,
    out: ['.gitleaksignore: none at'],
    check: (f, calls) => {
      const pulls = calls.filter((c) => c.argv[0] === 'pull');
      return pulls.length === 1 && pulls[0].argv.includes(`zricethezav/gitleaks:v${PIN}`) ? [] : [`${pulls.length} pull calls`];
    } },
  { n: 15, name: 'a report that is not there cannot verify', setup: { files: CODE, docker: { report: false } }, exit: 2,
    err: ['CANNOT VERIFY: gitleaks wrote no readable report'] },
  { n: 16, name: 'a finding with no RuleID is a report the script does not recognise, and prints nothing from it',
    setup: { files: CODE, docker: { rawReport: JSON.stringify([{ File: '/scan/tree/src/config.ts', StartLine: 3, Secret: secretValue }]) } }, exit: 2,
    err: ['CANNOT VERIFY: gitleaks wrote a report this script does not recognise'], absent: [secretValue, '[LIVE]', '[ACCEPTED]'] },
  { n: 17, name: 'Gitleaks that exits non-zero cannot verify, even with a report', setup: { files: CODE, docker: { status: 1, findings: [TWO_FINDINGS[0]], stderr: 'gitleaks: failed to scan\n' } }, exit: 2,
    err: ['CANNOT VERIFY: docker run exited 1', 'gitleaks: failed to scan'], absent: ['[LIVE]'] },
  { n: 18, name: 'a scan that passes the time limit is stopped and its container removed',
    setup: { files: CODE, docker: { sleepMs: 8000 } }, args: (f) => [...std(f), '--timeout', '1'], exit: 2,
    err: ['CANNOT VERIFY: gitleaks did not finish within 1 s'],
    check: (f, calls) => {
      const run1 = runCalls(calls).find((c) => c.command && c.command[0] === 'dir');
      const name = run1 && run1.argv[run1.argv.indexOf('--name') + 1];
      return calls.some((c) => c.argv[0] === 'rm' && c.argv[1] === '-f' && c.argv[2] === name) ? [] : ['no `docker rm -f <name>` after the limit'];
    } },
  { n: 19, name: 'a clone that moved past --commit cannot verify, and names both commits',
    setup: { files: CODE, after: (c) => { writeFiles(c, { 'src/new.ts': 'x\n' }); commitAll(c, 'later'); } }, exit: 2,
    err: ['CANNOT VERIFY: the clone at'],
    check: (f, calls, res) => {
      const head = git(f.clone, ['rev-parse', 'HEAD']).trim();
      return [head.slice(0, 12), f.commit.slice(0, 12)].filter((c) => !res.stderr.includes(c)).map((c) => `stderr lacks ${c}`)
        .concat(runCalls(calls).length ? ['docker ran'] : []);
    } },
  { n: 20, name: 'a path with a colon and a space matches its entry',
    setup: { files: { ...CODE, 'a b/c:d.ts': 'const k = "<synthetic>";\n', '.gitleaksignore': 'a b/c:d.ts:generic-api-key:1\n' }, docker: { findings: [{ file: 'a b/c:d.ts', rule: 'generic-api-key', line: 1 }] } }, exit: 0,
    out: ['[ACCEPTED] a b/c:d.ts L1: generic-api-key (.gitleaksignore: a b/c:d.ts:generic-api-key:1)'], absent: ['[LIVE]'] },
  { n: 21, name: 'two rules on one line, with an entry for one: one accepted, one live',
    setup: { files: { ...CODE, '.gitleaksignore': 'src/config.ts:generic-api-key:3\n' }, docker: { findings: [
      { file: 'src/config.ts', rule: 'generic-api-key', line: 3 }, { file: 'src/config.ts', rule: 'aws-access-token', line: 3 }] } }, exit: 1,
    out: ['[ACCEPTED] src/config.ts L3: generic-api-key (.gitleaksignore: src/config.ts:generic-api-key:3)', '[LIVE] src/config.ts L3: aws-access-token'],
    check: (f, calls, res) => (res.stdout.split('\n').filter((l) => l.startsWith('[ACCEPTED]')).length === 1 && res.stdout.split('\n').filter((l) => l.startsWith('[LIVE]')).length === 1 ? [] : ['not one of each']) },
  { n: 22, name: 'a symbolic link is exported as a regular file that holds the link text',
    setup: { files: CODE, links: { 'src/passwd': '/etc/passwd' } }, exit: 0,
    check: (f, calls) => {
      const seen = scanCall(calls).files['tree/src/passwd'];
      return seen && seen.kind === 'file' && seen.text === '/etc/passwd' ? [] : [`the stand-in saw ${JSON.stringify(seen)}`];
    } },
  { n: 23, name: 'GITLEAKS_IMAGE names a mirror: the run uses it with the pin as the tag',
    setup: { files: CODE }, env: { GITLEAKS_IMAGE: 'registry.example.invalid/mirror/gitleaks' }, exit: 0,
    check: (f, calls) => {
      const c = scanCall(calls);
      return c.image === `registry.example.invalid/mirror/gitleaks:v${PIN}` ? [] : [`image ${c.image}`];
    } },
  { n: 24, name: 'a GITLEAKS_IMAGE that starts with a dash is usage, and docker is not called',
    setup: { files: CODE }, env: { GITLEAKS_IMAGE: '--privileged' }, exit: 3,
    err: ['USAGE:', 'is not an image name'],
    check: (f, calls) => (calls.length ? [`${calls.length} docker calls`] : []) },
  { n: 25, name: 'the library layout of the hub: the pin is read from accelerator/gate/gitleaks/',
    setup: { files: CODE, hubOptions: { layout: 'library' } }, exit: 0,
    out: [`gitleaks ${PIN}, rules ${RULES_HASH}`] },
  { n: 26, name: 'a hub with no pin at the revision cannot verify, and docker is not called',
    setup: { files: CODE, hubOptions: { layout: 'none' } }, exit: 2,
    err: ['CANNOT VERIFY: no gitleaks.json at'],
    check: (f, calls) => (calls.length ? [`${calls.length} docker calls`] : []) },
  { n: 27, name: '--ensure-image with the image present says so, and fetches nothing',
    setup: { files: CODE }, args: (f) => ['--ensure-image', '--hub', f.hub.dir], exit: 0,
    out: [`GITLEAKS IMAGE — zricethezav/gitleaks:v${PIN} is already on this machine`],
    check: (f, calls) => (calls.some((c) => c.argv[0] === 'pull' || c.argv[0] === 'run') ? ['docker pulled or ran'] : []) },
  { n: 28, name: '--ensure-image with Docker down ends on REASON: docker-not-running, then its exit line',
    setup: { files: CODE, docker: { daemon: 'down' } }, args: (f) => ['--ensure-image', '--hub', f.hub.dir], exit: 2,
    err: ['CANNOT VERIFY: Docker is not running or cannot be used'],
    check: (f, calls, res) => { const tail = res.stderr.trim().split('\n').slice(-2); return tail[0] === 'REASON: docker-not-running' && tail[1] === 'HARNESS EXIT: check-survey-secrets 2' ? [] : [`last lines: ${tail.join(' | ')}`]; } },
  { n: 29, name: '--ensure-image with a failed pull ends on REASON: pull-failed, then its exit line',
    setup: { files: CODE, docker: { image: 'missing', pull: 'fail' } }, args: (f) => ['--ensure-image', '--hub', f.hub.dir], exit: 2,
    err: [`docker pull zricethezav/gitleaks:v${PIN} failed`],
    check: (f, calls, res) => { const tail = res.stderr.trim().split('\n').slice(-2); return tail[0] === 'REASON: pull-failed' && tail[1] === 'HARNESS EXIT: check-survey-secrets 2' ? [] : [`last lines: ${tail.join(' | ')}`]; } },
  { n: 30, name: '--summary, the removed option, is usage', setup: { files: CODE }, args: (f) => [...std(f), '--summary', join(f.clone, 'summary.md')], exit: 3,
    err: ['USAGE: unknown argument: --summary'], check: (f, calls) => (calls.length ? ['docker was called'] : []) },
  { n: 31, name: 'a short commit is usage', setup: { files: CODE }, args: (f) => ['--clone', f.clone, '--commit', f.commit.slice(0, 12), '--hub', f.hub.dir], exit: 3,
    err: ['USAGE: --commit must be 40'] },
  { n: 32, name: 'the value of a credential never appears: not for a finding, not for a refused report',
    setup: { files: CODE, docker: { findings: TWO_FINDINGS.map((t) => ({ ...t, match: `key = "${secretValue}"`, secret: secretValue })) } }, exit: 1,
    out: ['[LIVE] src/config.ts L3: generic-api-key', '[LIVE] tests/key.pem L1: private-key'], absent: [secretValue] },

  /* Fixtures 33 to 42: the first review of the scan. */

  { n: 33, name: 'a finding by path alone (line 0) with its entry is accepted',
    setup: { files: { ...CODE, 'cert.p12': '<synthetic binary>\n', '.gitleaksignore': 'cert.p12:pkcs12-file:0\n' }, docker: { findings: [P12] } }, exit: 0,
    out: ['.gitleaksignore: 1 file entries, 0 commit entries at', '[ACCEPTED] cert.p12 L0: pkcs12-file (.gitleaksignore: cert.p12:pkcs12-file:0)'], absent: ['[LIVE]', 'note:'] },
  { n: 34, name: 'a finding by path alone (line 0) with no entry is live',
    setup: { files: { ...CODE, 'cert.p12': '<synthetic binary>\n' }, docker: { findings: [P12] } }, exit: 1,
    out: ['[LIVE] cert.p12 L0: pkcs12-file'], absent: ['[ACCEPTED]'] },
  { n: 35, name: 'a gitleaks:allow marker in the spoke does not hide a finding: the file is exported as it is, and the scan ignores the marker',
    setup: { files: { ...CODE, 'src/config.ts': ALLOWED }, docker: { findings: [TWO_FINDINGS[0]] } }, exit: 1,
    out: ['[LIVE] src/config.ts L3: generic-api-key', 'note: 1 gitleaks:allow markers ignored'],
    check: (f, calls) => {
      const seen = scanCall(calls).files['tree/src/config.ts'];
      return seen && seen.text === ALLOWED ? [] : [`the stand-in saw ${JSON.stringify(seen)}`];
    } },
  { n: 36, name: 'the two files in other cases of the letters are exported, and an entry in .GitleaksIgnore accepts nothing',
    setup: { files: { ...CODE, '.GitleaksIgnore': 'src/config.ts:generic-api-key:3\n', '.GITLEAKS.TOML': '[allowlist]\npaths = [".*"]\n', 'sub/.gitleaks.toml': 'x = 1\n' },
      docker: { findings: [TWO_FINDINGS[0], { file: '.GitleaksIgnore', rule: 'generic-api-key', line: 1 }] } }, exit: 1,
    out: ['.gitleaksignore: none at', '[LIVE] src/config.ts L3: generic-api-key', '[LIVE] .GitleaksIgnore L1: generic-api-key'], absent: ['[ACCEPTED]'],
    check: (f, calls) => {
      const files = Object.keys(scanCall(calls).files);
      return ['tree/.GitleaksIgnore', 'tree/.GITLEAKS.TOML', 'tree/sub/.gitleaks.toml'].filter((p) => !files.includes(p)).map((p) => `not exported: ${p}`);
    } },
  { n: 37, name: 'two files that differ only in case, on a file system that ignores case, cannot verify',
    setup: { files: { ...CODE, 'src/Config.ts': 'export {};\n' } }, env: { SHL_SURVEY_SECRETS_CASE_INSENSITIVE: '1' }, exit: 2,
    err: ['CANNOT VERIFY: the tree at', '"src/Config.ts" and "src/config.ts", which are one file on this file system'],
    check: (f, calls) => (calls.some((c) => c.argv[0] === 'run') ? ['docker ran after the refusal'] : []) },
  { n: 38, name: 'two folders that differ only in case, on a file system that ignores case, cannot verify',
    setup: { files: { ...CODE, 'Src/other.ts': 'export {};\n' } }, env: { SHL_SURVEY_SECRETS_CASE_INSENSITIVE: '1' }, exit: 2,
    err: ['"Src" and "src", which are one file on this file system'] },
  { n: 39, name: 'the case probe reads the real file system: without the hook the result is this machine\'s',
    setup: { files: { ...CODE, 'src/Config.ts': 'export {};\n' } }, exit: CASELESS ? 2 : 0,
    check: (f, calls) => {
      if (CASELESS) return [];
      const files = Object.keys(scanCall(calls).files);
      return ['tree/src/Config.ts', 'tree/src/config.ts'].filter((p) => !files.includes(p)).map((p) => `not exported: ${p}`);
    } },
  { n: 40, name: 'a Gitleaks that does not report the canary did not see the files: cannot verify',
    setup: { docker: { findings: TWO_FINDINGS, canary: false } }, exit: 2,
    err: ['CANNOT VERIFY: gitleaks did not see the exported files'], absent: ['[ACCEPTED]', '[LIVE]'] },
  { n: 41, name: 'a finding outside the exported tree and the canary is a report the script does not recognise',
    setup: { docker: { findings: [{ at: 'elsewhere/x.ts', rule: 'generic-api-key', line: 1 }] } }, exit: 2,
    err: ['CANNOT VERIFY: gitleaks wrote a report this script does not recognise'] },
  { n: 42, name: 'the layout: /scan holds tree/ and a canary made on each run, mounted read-only and scanned from /scan; the canary is never printed',
    setup: { files: CODE }, exit: 0, absent: ['canary', 'PRIVATE KEY'],
    check: (f, calls, res) => {
      const c = scanCall(calls);
      const problems = [];
      if (!(c.mounts['/scan'] && c.mounts['/scan'].readonly)) problems.push('/scan is not read-only');
      if (!(c.mounts['/rules'] && c.mounts['/rules'].readonly)) problems.push('/rules is not read-only');
      if (!(c.mounts['/out'] && !c.mounts['/out'].readonly)) problems.push('/out is not writable');
      if (c.mounts['/src']) problems.push('a /src mount is still there');
      if (c.command.slice(0, 2).join(' ') !== 'dir /scan' || c.argv[c.argv.indexOf('-w') + 1] !== '/scan') problems.push(`command ${c.command.join(' ')} from ${c.argv[c.argv.indexOf('-w') + 1]}`);
      const canary = c.files['canary/canary.pem'];
      if (!canary || !canary.text.startsWith(PEM_HEADER)) problems.push('no canary under canary/');
      if (Object.keys(c.files).some((p) => !p.startsWith('tree/') && !p.startsWith('canary/'))) problems.push(`stray files: ${Object.keys(c.files).join(', ')}`);
      const again = run(f, std(f));
      const second = scanCall(dockerCalls(f.docker).slice(calls.length)).files['canary/canary.pem'];
      if (again.status !== 0 || !second || second.text === (canary && canary.text)) problems.push('a second run did not make a new canary');
      if (canary && `${res.stdout}${res.stderr}`.includes(canary.text.split('\n')[1])) problems.push('the canary body was printed');
      return problems;
    } },
  /* Fixtures 43 to 52: the parsing of .gitleaksignore, and the arguments of the check. */

  { n: 43, name: 'a .gitleaksignore of comments only accepts nothing',
    setup: { files: { ...CODE, '.gitleaksignore': '# nothing accepted yet\n\n' }, docker: { findings: TWO_FINDINGS } }, exit: 1,
    out: ['.gitleaksignore: 0 file entries, 0 commit entries at', '[LIVE] src/config.ts L3', '[LIVE] tests/key.pem L1'], absent: ['[ACCEPTED]', 'note:'] },
  { n: 44, name: 'an empty .gitleaksignore accepts nothing, and no finding still passes',
    setup: { files: { ...CODE, '.gitleaksignore': '' } }, exit: 0,
    out: ['.gitleaksignore: 0 file entries, 0 commit entries at'], absent: ['[LIVE]', 'note:'] },
  { n: 45, name: 'a .gitleaksignore with CRLF line ends parses',
    setup: { files: { ...CODE, '.gitleaksignore': IGNORE.replace(/\n/g, '\r\n') }, docker: { findings: TWO_FINDINGS } }, exit: 0,
    out: ['.gitleaksignore: 2 file entries, 1 commit entries at', '[ACCEPTED] src/config.ts L3: generic-api-key (.gitleaksignore: src/config.ts:generic-api-key:3)'], absent: ['[LIVE]'] },
  { n: 46, name: 'a .gitleaksignore that is a folder accepts nothing',
    setup: { files: { ...CODE, '.gitleaksignore/README': 'x\n' }, docker: { findings: [TWO_FINDINGS[0]] } }, exit: 1,
    out: ['note: .gitleaksignore at the root is not a regular file', '[LIVE] src/config.ts L3'], absent: ['[ACCEPTED]'] },
  { n: 47, name: 'an unreadable .gitleaksignore line is a note, and the other entries still accept',
    setup: { files: { ...CODE, '.gitleaksignore': `${IGNORE}not a fingerprint\nsrc/db.ts:rule:L1\n` }, docker: { findings: TWO_FINDINGS } }, exit: 0,
    out: ['.gitleaksignore: 2 file entries, 1 commit entries at', 'note: .gitleaksignore lines 6, 7 are not file:rule:line', '[ACCEPTED] src/config.ts L3', '[ACCEPTED] tests/key.pem L1'], absent: ['[LIVE]'] },
  { n: 48, name: 'a ./ prefix on an entry is the same path',
    setup: { files: { ...CODE, '.gitleaksignore': './src/db.ts:generic-api-key:1\n' }, docker: { findings: [{ file: 'src/db.ts', rule: 'generic-api-key', line: 1 }] } }, exit: 0,
    out: ['[ACCEPTED] src/db.ts L1: generic-api-key (.gitleaksignore: ./src/db.ts:generic-api-key:1)'], absent: ['[LIVE]'] },
  { n: 49, name: 'a path with a colon in a file entry',
    setup: { files: { ...CODE, 'docs/a:b.txt': 'one\ntwo\nthree\nfour\n', '.gitleaksignore': 'docs/a:b.txt:generic-api-key:4\n' }, docker: { findings: [{ file: 'docs/a:b.txt', rule: 'generic-api-key', line: 4 }] } }, exit: 0,
    out: ['[ACCEPTED] docs/a:b.txt L4: generic-api-key'], absent: ['[LIVE]'] },
  { n: 50, name: 'a .gitleaksignore below the root is not read',
    setup: { files: { ...CODE, 'src/.gitleaksignore': IGNORE }, docker: { findings: TWO_FINDINGS } }, exit: 1,
    out: ['.gitleaksignore: none at', '[LIVE] src/config.ts L3'], absent: ['[ACCEPTED]'] },
  { n: 51, name: 'no repository at --clone cannot verify',
    setup: { files: CODE }, args: (f) => ['--clone', join(f.clone, '..', 'missing'), '--commit', f.commit, '--hub', f.hub.dir], exit: 2,
    err: ['CANNOT VERIFY: no repository at'], check: (f, calls) => (runCalls(calls).length ? ['docker ran'] : []) },
  { n: 52, name: 'a missing --commit is usage', setup: { files: CODE }, args: (f) => ['--clone', f.clone, '--hub', f.hub.dir], exit: 3,
    err: ['USAGE: --commit is required'] },

  /* Fixtures 53 to 57: the whole-branch review. */

  { n: 53, name: 'a finding inside an archive is accepted only by an entry with the exact <archive>!<path> form',
    setup: { files: { ...CODE, 'vendor/bundle.tar.gz': tarGz([['inner/key.ts', '<synthetic>\n'], ['inner/other.ts', '<synthetic>\n']]),
      '.gitleaksignore': 'vendor/bundle.tar.gz!inner/key.ts:generic-api-key:3\nvendor/bundle.tar.gz:generic-api-key:1\ninner/other.ts:generic-api-key:1\n' },
      docker: { findings: [{ file: 'vendor/bundle.tar.gz!inner/key.ts', rule: 'generic-api-key', line: 3 }, { file: 'vendor/bundle.tar.gz!inner/other.ts', rule: 'generic-api-key', line: 1 }] } }, exit: 1,
    out: ['[ACCEPTED] vendor/bundle.tar.gz!inner/key.ts L3: generic-api-key (.gitleaksignore: vendor/bundle.tar.gz!inner/key.ts:generic-api-key:3)',
      '[LIVE] vendor/bundle.tar.gz!inner/other.ts L1: generic-api-key'],
    check: (f, calls, res) => (res.stdout.split('\n').filter((l) => l.startsWith('[ACCEPTED]')).length === 1 ? [] : ['not one [ACCEPTED] line']) },
  { n: 54, name: 'a crafted tree that holds one path twice cannot verify: the second file would replace the first',
    setup: { files: CODE, craft: [['100644', 'x.ts', 'one\n'], ['100644', 'x.ts', 'two\n']] }, exit: 2,
    err: ['CANNOT VERIFY: the tree at', '"x.ts", and the export already has a file or a folder at its place (EEXIST)'],
    check: (f, calls) => (runCalls(calls).length ? ['docker ran'] : []) },
  { n: 55, name: 'a crafted tree with a file a and a file a/b cannot verify, on any file system',
    setup: { files: CODE, craft: [['100644', 'a', 'one\n'], ['100644', 'a/b', 'two\n']] }, exit: 2,
    err: ['CANNOT VERIFY: the tree at', '"a/b", and the export already has a file or a folder at its place'],
    check: (f, calls) => (runCalls(calls).length ? ['docker ran'] : []) },
  { n: 56, name: 'a path with a control character is printed as a JSON string and forges no line',
    setup: { files: { ...CODE, 'src/x\n[ACCEPTED] y.ts L1: r (.gitleaksignore: y.ts:r:1)': 'k\n' },
      docker: { findings: [{ file: 'src/x\n[ACCEPTED] y.ts L1: r (.gitleaksignore: y.ts:r:1)', rule: 'generic-api-key', line: 1 }] } }, exit: 1,
    out: ['[LIVE] "src/x\\n[ACCEPTED] y.ts L1: r (.gitleaksignore: y.ts:r:1)" L1: generic-api-key'],
    check: (f, calls, res) => (res.stdout.split('\n').some((l) => l.startsWith('[ACCEPTED]')) ? ['a forged [ACCEPTED] line'] : []) },
  { n: 57, name: 'a backslash in a git path stays a backslash: an entry with a slash does not accept it',
    setup: { files: { ...CODE, 'a\\b.ts': 'k\n', '.gitleaksignore': 'a/b.ts:generic-api-key:1\n' }, docker: { findings: [{ file: 'a\\b.ts', rule: 'generic-api-key', line: 1 }] } }, exit: 1,
    out: ['[LIVE] a\\b.ts L1: generic-api-key'], absent: ['[ACCEPTED]'] },

  /* Fixtures 58 to 61: the rules without the global path allowlist, and .tgz archives. */

  { n: 58, name: 'a .tgz file in any case is exported as .tar.gz, and each finding in it is reported and matched at the real path',
    setup: { files: { ...CODE, 'lib/a.tgz': tarGz([['inner/k.ts', '<synthetic>\n']]), 'lib/B.TGZ': tarGz([['k.ts', '<synthetic>\n']]),
      '.gitleaksignore': 'lib/B.TGZ!k.ts:generic-api-key:1\nlib/a.tar.gz!inner/k.ts:generic-api-key:1\n' },
      docker: { findings: [{ file: 'lib/a.tar.gz!inner/k.ts', rule: 'generic-api-key', line: 1 }, { file: 'lib/B.tar.gz!k.ts', rule: 'generic-api-key', line: 1 }, { file: 'lib/a.tar.gz', rule: 'generic-api-key', line: 0 }] } }, exit: 1,
    out: ['[ACCEPTED] lib/B.TGZ!k.ts L1: generic-api-key (.gitleaksignore: lib/B.TGZ!k.ts:generic-api-key:1)',
      '[LIVE] lib/a.tgz L0: generic-api-key', '[LIVE] lib/a.tgz!inner/k.ts L1: generic-api-key'],
    absent: ['a.tar.gz', 'B.tar.gz'],
    check: (f, calls) => {
      const files = Object.keys(scanCall(calls).files);
      return [...['tree/lib/a.tar.gz', 'tree/lib/B.tar.gz'].filter((p) => !files.includes(p)).map((p) => `not exported: ${p}`),
        ...['tree/lib/a.tgz', 'tree/lib/B.TGZ'].filter((p) => files.includes(p)).map((p) => `exported under the old name: ${p}`)];
    } },
  { n: 59, name: 'a .tgz file beside a tree path with its new name cannot verify, and names both',
    setup: { files: { ...CODE, 'lib/x.tgz': 'one\n', 'lib/x.tar.gz': 'two\n' } }, exit: 2,
    err: ['CANNOT VERIFY: the tree at', '"lib/x.tar.gz" and "lib/x.tgz"', 'one report path would have two readings'],
    check: (f, calls) => (runCalls(calls).length ? ['docker ran'] : []) },
  { n: 60, name: 'a tree path that starts with the new name of a .tgz file and a ! cannot verify, and names both',
    setup: { files: { ...CODE, 'lib/x.TGZ': 'one\n', 'lib/x.tar.gz!k.ts': 'two\n' } }, exit: 2,
    err: ['CANNOT VERIFY: the tree at', '"lib/x.TGZ" and "lib/x.tar.gz!k.ts"', 'one report path would have two readings'],
    check: (f, calls) => (runCalls(calls).length ? ['docker ran'] : []) },
  { n: 61, name: 'the shipped rules are the upstream file: no [extend], no paths list global or per rule, the value allowlists kept, and the MIT notice',
    setup: { files: CODE }, exit: 0,
    check: () => {
      const file = ['gitleaks/gitleaks.toml', 'scripts/gitleaks/gitleaks.toml'].map((d) => resolve(dirname(SCRIPT), d)).find((d) => existsSync(d));
      if (!file) return ['no gitleaks.toml beside the script'];
      const text = readFileSync(file, 'utf8');
      const lines = text.split('\n');
      const problems = [];
      if (lines.some((l) => l.trim() === '[extend]')) problems.push('an [extend] table');
      const top = lines.filter((l) => l === '[allowlist]' || l === '[[allowlists]]');
      if (top.length !== 1) problems.push(`${top.length} top-level allowlist tables, expected 1`);
      const at = lines.indexOf('[allowlist]');
      const next = lines.findIndex((l, i) => i > at && l.startsWith('['));
      if (lines.slice(at, next).some((l) => l.startsWith('paths'))) problems.push('the global [allowlist] has paths');
      const scoped = lines.filter((l) => !l.startsWith('#') && l.search(/^\s*paths\s*=/) >= 0).length;
      if (scoped) problems.push(`${scoped} paths lists, expected none: a file name must not hide a finding`);
      if (!lines.slice(at, next).some((l) => l.startsWith('regexes'))) problems.push('the global [allowlist] lost its regexes');
      if (lines.filter((l) => l === '[[rules]]').length < 200) problems.push('fewer than 200 rules');
      if (!lines.some((l) => l === '[[rules.allowlists]]')) problems.push('no per-rule allowlist');
      const pin = JSON.parse(readFileSync(join(dirname(file), 'gitleaks.json'), 'utf8')).gitleaks;
      for (const want of [`https://github.com/gitleaks/gitleaks/blob/v${pin}/config/gitleaks.toml`, '# Copyright (c) 2019 Zachary Rice',
        '# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR']) if (!text.includes(want)) problems.push(`lacks: ${want}`);
      return problems;
    } },

  /* Fixtures 62 to 75: commit entries, matched with git blame at the commit. */

  { n: 62, name: 'a commit entry for the commit that added the line accepts it, after the file moved to another folder and the line moved down',
    setup: { history: [CODE], files: (h) => ({ 'src/config.ts': null, 'app/config.ts': `export const version = 2;\n${CODE['src/config.ts']}`,
      '.gitleaksignore': `${h[0]}:src/config.ts:generic-api-key:3\n` }), docker: { findings: [{ file: 'app/config.ts', rule: 'generic-api-key', line: 4 }] } }, exit: 0,
    out: (f) => ['.gitleaksignore: 0 file entries, 1 commit entries at',
      `[ACCEPTED] app/config.ts L4: generic-api-key (.gitleaksignore: ${f.history[0]}:src/config.ts:generic-api-key:3)`], absent: ['[LIVE]'] },
  { n: 63, name: 'a commit entry does not accept a line edited after its commit',
    setup: { history: [CODE, { 'src/config.ts': CODE['src/config.ts'].replace('<synthetic>', '<synthetic-2>') }],
      files: (h) => ({ '.gitleaksignore': `${h[0]}:src/config.ts:generic-api-key:3\n` }), docker: { findings: [TWO_FINDINGS[0]] } }, exit: 1,
    out: ['[LIVE] src/config.ts L3: generic-api-key'], absent: ['[ACCEPTED]'] },
  { n: 64, name: 'a commit entry with the wrong rule does not accept',
    setup: { history: [CODE], files: (h) => ({ '.gitleaksignore': `${h[0]}:src/config.ts:private-key:3\n` }), docker: { findings: [TWO_FINDINGS[0]] } }, exit: 1,
    out: ['[LIVE] src/config.ts L3: generic-api-key'], absent: ['[ACCEPTED]'] },
  { n: 65, name: 'a commit entry with the wrong line does not accept',
    setup: { history: [CODE], files: (h) => ({ '.gitleaksignore': `${h[0]}:src/config.ts:generic-api-key:2\n` }), docker: { findings: [TWO_FINDINGS[0]] } }, exit: 1,
    out: ['[LIVE] src/config.ts L3: generic-api-key'], absent: ['[ACCEPTED]'] },
  { n: 66, name: 'after a move, a commit entry with the path and the line at the scanned commit does not accept: the entry names them in its own commit',
    setup: { history: [CODE], files: (h) => ({ 'src/config.ts': null, 'app/config.ts': `export const version = 2;\n${CODE['src/config.ts']}`,
      '.gitleaksignore': `${h[0]}:app/config.ts:generic-api-key:4\n` }), docker: { findings: [{ file: 'app/config.ts', rule: 'generic-api-key', line: 4 }] } }, exit: 1,
    out: ['[LIVE] app/config.ts L4: generic-api-key'], absent: ['[ACCEPTED]'] },
  { n: 67, name: 'a finding over several lines, all from the commit of the entry, is accepted',
    setup: { history: [CODE, { 'keys/k.pem': 'top\nblock one\nblock two\nblock three\nblock end\n' }],
      files: (h) => ({ '.gitleaksignore': `${h[1]}:keys/k.pem:private-key:2\n` }), docker: { findings: [{ file: 'keys/k.pem', rule: 'private-key', line: 2, endLine: 5 }] } }, exit: 0,
    out: (f) => [`[ACCEPTED] keys/k.pem L2: private-key (.gitleaksignore: ${f.history[1]}:keys/k.pem:private-key:2)`], absent: ['[LIVE]'] },
  { n: 68, name: 'a finding over several lines with one line edited after the commit of the entry is live',
    setup: { history: [CODE, { 'keys/k.pem': 'top\nblock one\nblock two\nblock three\nblock end\n' }, { 'keys/k.pem': 'top\nblock one\nblock two\nblock 3\nblock end\n' }],
      files: (h) => ({ '.gitleaksignore': `${h[1]}:keys/k.pem:private-key:2\n` }), docker: { findings: [{ file: 'keys/k.pem', rule: 'private-key', line: 2, endLine: 5 }] } }, exit: 1,
    out: ['[LIVE] keys/k.pem L2: private-key'], absent: ['[ACCEPTED]'] },
  { n: 69, name: 'an end line past the end of the file is not blamed, and the entry still accepts',
    setup: { history: [CODE, { 'keys/k.pem': 'top\nblock one\nblock two\nblock end' }],
      files: (h) => ({ '.gitleaksignore': `${h[1]}:keys/k.pem:private-key:2\n` }), docker: { findings: [{ file: 'keys/k.pem', rule: 'private-key', line: 2, endLine: 9 }] } }, exit: 0,
    out: (f) => [`[ACCEPTED] keys/k.pem L2: private-key (.gitleaksignore: ${f.history[1]}:keys/k.pem:private-key:2)`], absent: ['[LIVE]'] },
  { n: 70, name: 'a shallow clone cannot verify, before docker runs',
    setup: { history: [CODE], files: (h) => ({ '.gitleaksignore': `${h[0]}:src/config.ts:generic-api-key:3\n` }), shallow: true, docker: { findings: [TWO_FINDINGS[0]] } }, exit: 2,
    err: ['CANNOT VERIFY: the clone at', 'is shallow. Clone the whole history of the trunk, with no --depth'],
    check: (f, calls) => (runCalls(calls).length ? ['docker ran'] : []) },
  { n: 71, name: 'a commit entry for a finding at line 0 accepts nothing',
    setup: { history: [{ ...CODE, 'cert.p12': '<synthetic binary>\n' }], files: (h) => ({ '.gitleaksignore': `${h[0]}:cert.p12:pkcs12-file:0\n` }), docker: { findings: [P12] } }, exit: 1,
    out: ['[LIVE] cert.p12 L0: pkcs12-file'], absent: ['[ACCEPTED]'] },
  { n: 72, name: 'a commit entry for a finding inside an archive accepts nothing',
    setup: { history: [{ ...CODE, 'vendor/b.tar.gz': tarGz([['inner/key.ts', '<synthetic>\n']]) }],
      files: (h) => ({ '.gitleaksignore': `${h[0]}:vendor/b.tar.gz!inner/key.ts:generic-api-key:1\n` }),
      docker: { findings: [{ file: 'vendor/b.tar.gz!inner/key.ts', rule: 'generic-api-key', line: 1 }] } }, exit: 1,
    out: ['[LIVE] vendor/b.tar.gz!inner/key.ts L1: generic-api-key'], absent: ['[ACCEPTED]'] },
  { n: 73, name: 'a blame.ignoreRevsFile in the git configuration does not give an edited line to an older commit',
    setup: { history: [CODE, { 'src/config.ts': CODE['src/config.ts'].replace('<synthetic>', '<synthetic-2>') }],
      files: (h) => ({ '.gitleaksignore': `${h[0]}:src/config.ts:generic-api-key:3\n` }), docker: { findings: [TWO_FINDINGS[0]] },
      after: (c) => writeFileSync(join(c, '..', 'ignore-revs'), `${git(c, ['rev-parse', 'HEAD~1']).trim()}\n`) },
    env: (f) => ({ GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'blame.ignoreRevsFile', GIT_CONFIG_VALUE_0: join(f.clone, '..', 'ignore-revs') }), exit: 1,
    out: ['[LIVE] src/config.ts L3: generic-api-key'], absent: ['[ACCEPTED]'] },
  { n: 74, name: 'a commit entry for a path that git quotes is matched on the real path',
    setup: { history: [{ ...CODE, 'src/we"irdé.ts': 'a\nk\n' }], files: (h) => ({ '.gitleaksignore': `${h[0]}:src/we"irdé.ts:generic-api-key:2\n` }),
      docker: { findings: [{ file: 'src/we"irdé.ts', rule: 'generic-api-key', line: 2 }] } }, exit: 0,
    out: (f) => [`[ACCEPTED] src/we"irdé.ts L2: generic-api-key (.gitleaksignore: ${f.history[0]}:src/we"irdé.ts:generic-api-key:2)`], absent: ['[LIVE]'] },
  { n: 75, name: 'a file entry and a commit entry together: each accepts its own finding',
    setup: { history: [CODE], files: (h) => ({ '.gitleaksignore': `tests/key.pem:private-key:1\n${h[0]}:src/config.ts:generic-api-key:3\n` }), docker: { findings: TWO_FINDINGS } }, exit: 0,
    out: (f) => ['.gitleaksignore: 1 file entries, 1 commit entries at',
      `[ACCEPTED] src/config.ts L3: generic-api-key (.gitleaksignore: ${f.history[0]}:src/config.ts:generic-api-key:3)`,
      '[ACCEPTED] tests/key.pem L1: private-key (.gitleaksignore: tests/key.pem:private-key:1)'], absent: ['[LIVE]'] },
  { n: 76, name: 'two matches of one rule on one line give one location, and a third finding on another line keeps its own',
    setup: { files: { ...CODE, '.gitleaksignore': 'src/config.ts:generic-api-key:3\n' },
      docker: { findings: [TWO_FINDINGS[0], TWO_FINDINGS[0], { ...TWO_FINDINGS[0], line: 1 }] } }, exit: 1,
    out: ['[ACCEPTED] src/config.ts L3: generic-api-key (.gitleaksignore: src/config.ts:generic-api-key:3)', '[LIVE] src/config.ts L1: generic-api-key'],
    check: (f, calls, res) => {
      const accepted = res.stdout.split('\n').filter((l) => l.startsWith('[ACCEPTED]')).length;
      return accepted === 1 ? [] : [`${accepted} [ACCEPTED] lines, expected 1`];
    } },
];

/* ------------------------------------------------------------------ the real image */

/**
 * `--real`: the shipped scan with the real pinned image in Docker, over synthetic credentials made
 * at run time and committed into a throwaway spoke. Nothing credential-shaped is committed to this
 * repository: each value is made from random bytes here, and each marker text is built from parts.
 * The image is pulled on the first run. Where Docker cannot run, the reason is printed and the exit
 * is 2, which is not a pass.
 */
const rnd = (alphabet, n) => Array.from(randomBytes(n), (b) => alphabet[b % alphabet.length]).join('');
const ALNUM = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const DIGITS = '0123456789';
const LETTERS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const KEY_TABLE = [
  { rule: 'github-pat', path: 'src/ci.ts', line: 3, make: () => ['gh', 'p_'].join('') + rnd(ALNUM, 36) },
  { rule: 'aws-access-token', path: 'config/deploy.env', line: 2, make: () => ['AK', 'IA'].join('') + rnd(B32, 16) },
  { rule: 'slack-bot-token', path: 'docs/notes.md', line: 5, make: () => ['xo', 'xb'].join('') + `-${rnd(DIGITS, 12)}-${rnd(DIGITS, 12)}-${rnd(ALNUM, 24)}` },
  { rule: 'gitlab-pat', path: 'tools/release.sh', line: 1, make: () => ['gl', 'pat-'].join('') + rnd(ALNUM + '_', 20) },
  { rule: 'private-key', path: 'keys/deploy.pem', line: 1, make: () => `${PEM_HEADER}${Array.from({ length: 4 }, () => randomBytes(48).toString('base64')).join('\n')}\n-----END ${'PRIVATE'} KEY-----`, whole: true },
  { rule: 'pkcs12-file', path: 'certs/client.p12', line: 0, make: () => randomBytes(64).toString('base64'), whole: true },
  // In an archive: Gitleaks reports `<archive>!<path inside>`, and an archive in an archive adds a `!`.
  { rule: 'github-pat', path: 'vendor/bundle.tar.gz!inner/key.ts', line: 3, make: () => ['gh', 'p_'].join('') + rnd(ALNUM, 36) },
  { rule: 'github-pat', path: 'vendor/outer.tar!deep/inner.tar.gz!c.ts', line: 1, make: () => ['gh', 'p_'].join('') + rnd(ALNUM, 36) },
];
// The marker is built from parts, so that this suite's own line carries none.
const ALLOW = ['gitleaks', 'allow'].join(':');

/** The file text: filler lines, then the credential on its line. A `whole` entry is the file itself. */
function realText(e, value, tail = '') {
  if (e.whole) return `${value}\n`;
  return `${Array.from({ length: e.line - 1 }, (_, i) => `// filler ${i + 1}`).join('\n')}${e.line > 1 ? '\n' : ''}token = "${value}"${tail}\n`;
}

/** The files that hold `e`: one file, or an archive made here, nested at each `!` of its path. */
function realFiles(e, value) {
  const parts = e.path.split('!');
  let bytes = Buffer.from(realText(e, value));
  for (let i = parts.length - 1; i >= 1; i -= 1) {
    const archive = tar([[parts[i], bytes]]);
    bytes = parts[i - 1].search(/\.(?:gz|tgz)$/i) >= 0 ? gzipSync(archive) : archive;
  }
  return { [parts[0]]: bytes };
}

function realMain() {
  const probe = spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], { encoding: 'utf8' });
  if (probe.error || probe.status !== 0) {
    const why = probe.error ? `docker could not run: ${probe.error.message}` : String(probe.stderr).trim().split('\n')[0];
    console.error(`CANNOT VERIFY: ${why}`);
    return 2;
  }
  const gitleaksDir = ['scripts/gitleaks', 'gitleaks'].map((d) => resolve(dirname(SCRIPT), d)).find((d) => existsSync(join(d, 'gitleaks.json')));
  if (!gitleaksDir) { console.error('CANNOT VERIFY: no gitleaks.json beside the script'); return 2; }
  const root = mkdtempSync(join(tmpdir(), 'survey-secrets-real-'));
  const problems = [];
  try {
    const hubDir = join(root, 'hub');
    mkdirSync(join(hubDir, 'scripts', 'gitleaks'), { recursive: true });
    git(hubDir, ['init', '-q', '-b', 'main']);
    for (const name of ['gitleaks.json', 'gitleaks.toml']) writeFileSync(join(hubDir, 'scripts', 'gitleaks', name), readFileSync(join(gitleaksDir, name)));
    commitAll(hubDir, 'chore: the hub');

    const values = KEY_TABLE.map((e) => e.make());
    const files = {};
    KEY_TABLE.forEach((e, i) => Object.assign(files, realFiles(e, values[i])));
    const first = KEY_TABLE[0];
    const archived = KEY_TABLE.find((e) => e.path.includes('!'));
    const entry = (e) => `${e.path}:${e.rule}:${e.line}`;
    const allowed = { rule: 'github-pat', path: 'src/allowed.ts', line: 2 };
    const allowedValue = ['gh', 'p_'].join('') + rnd(ALNUM, 36);
    const inIgnore = { rule: 'github-pat', path: '.gitleaksignore', line: 4 };
    const inIgnoreValue = ['gh', 'p_'].join('') + rnd(ALNUM, 36);
    values.push(allowedValue, inIgnoreValue);
    // Each path shape that the upstream global path allowlist covers. The library's rules drop that list.
    const pat = () => ['gh', 'p_'].join('') + rnd(ALNUM, 36);
    const pem = () => KEY_TABLE.find((e) => e.rule === 'private-key').make();
    const shapes = [
      { rule: 'private-key', path: 'node_modules/pkg/key.pem', line: 1, whole: true, make: pem },
      { rule: 'private-key', path: 'img/key.svg', line: 1, whole: true, make: pem },
      { rule: 'github-pat', path: 'docs/gitleaks.toml.md', line: 2, make: pat },
      { rule: 'github-pat', path: 'package-lock.json', line: 2, make: pat },
      { rule: 'github-pat', path: 'vendor/modules.txt', line: 2, make: pat },
      { rule: 'github-pat', path: 'go.sum', line: 2, make: pat },
      { rule: 'private-key', path: 'other/x.pdf', line: 1, whole: true, make: pem },
      { rule: 'github-pat', path: '.gitleaks.toml', line: 2, make: pat },
    ];
    // The per-rule path allowlists are gone too: a GitHub token in an .inc file and in the @octokit
    // README, and a generic key on a SRC line of a .bb recipe, which the AND table hid with its path.
    // The generic key alternates a letter and a digit. Gitleaks drops a generic key that contains a
    // stopword, and about 1 in 110 plain random values held one. No stopword or allowlist pattern
    // fits this shape, and 20 pairs keep the entropy above the rule's 3.5.
    const genericKey = () => Array.from({ length: 20 }, () => rnd(LETTERS, 1) + rnd(DIGITS, 1)).join('');
    const ruleShapes = [
      { rule: 'github-pat', path: 'include/x.inc', line: 2, make: pat },
      { rule: 'github-pat', path: 'node_modules/@octokit/auth-token/README.md', line: 2, make: pat },
      { rule: 'generic-api-key', path: 'meta/recipe.bb', line: 1, whole: true, make: () => `SRC_KEY = "${genericKey()}"` },
    ];
    const ruleShapeFiles = {};
    for (const e of ruleShapes) { const v = e.make(); values.push(v); Object.assign(ruleShapeFiles, realFiles(e, v)); }
    const shapeFiles = {};
    for (const e of shapes) { const v = e.make(); values.push(v); Object.assign(shapeFiles, realFiles(e, v)); }
    // PLDC-678: the two value shapes that the library's rules accept for generic-api-key, in any file.
    // A SemVer version under a package name with a keyword in it, as JavaScript lock files have it,
    // and a whole Go checksum line, LF and CRLF. A key that is not a version, and a checksum line with
    // more text after the hash, stay LIVE in the same files. The hash alternates a letter and a digit
    // for the reason that genericKey gives.
    const goHash = () => `${genericKey()}${rnd(LETTERS, 1)}${rnd(DIGITS, 1)}${rnd(LETTERS, 1)}=`;
    const lockKey = { rule: 'generic-api-key', path: 'web/package-lock.json', line: 6 };
    const sumExtra = { rule: 'generic-api-key', path: 'svc/go.sum', line: 3 };
    const lockKeyValue = genericKey();
    const sumExtraHash = goHash();
    values.push(lockKeyValue, sumExtraHash);
    const goModule = 'github.com/aws/aws-sdk-go-v2/credentials v1.19.7';
    const lockFiles = {
      'web/package-lock.json': [
        '{', '  "packages": {', '    "node_modules/@material/web": {', '      "dependencies": {',
        '        "@material/tokens": "15.0.0-canary.684e33d25.0",',
        `        "@octokit/auth-token": "${lockKeyValue}",`,
        '        "google-auth-library": "0.0.0-20231011-ab12cd34ef56"', '      }', '    }', '  }', '}', ''].join('\n'),
      'web/pnpm-lock.yaml': ['snapshots:', "  '@material/web@15.0.0-canary.684e33d25.0':", '    dependencies:',
        "      '@material/tokens': 15.0.0-canary.684e33d25.0", "      '@octokit/auth-token': 0.0.0-20231011-ab12cd34ef56", ''].join('\n'),
      'svc/go.sum': [`${goModule}/go.mod h1:${goHash()}`, `${goModule} h1:${goHash()}`,
        `${goModule} h1:${sumExtraHash} extra`, `github.com/golang-jwt/jwt/v5/token v5.2.1 h1:${goHash()}`, ''].join('\n'),
      'svc/tools/go.sum': ['a', `${goModule} h1:${goHash()}`, 'b', ''].join('\r\n'),
    };
    // .tgz archives, in two cases of the suffix: one finding LIVE, and one accepted by its real <archive>!<path> entry.
    const tgzLive = { rule: 'github-pat', path: 'dist/pkg.tgz!inner/key.ts', line: 3 };
    const tgzAccepted = { rule: 'github-pat', path: 'dist/UP.TGZ!k.ts', line: 1 };
    const tgzFiles = {};
    for (const e of [tgzLive, tgzAccepted]) { const v = pat(); values.push(v); Object.assign(tgzFiles, realFiles(e, v)); }
    const cases = [
      { name: 'every credential is LIVE, in archives too', extra: {}, accepted: [], live: [] },
      { name: 'a .gitleaksignore entry at the commit accepts one, and the exact <archive>!<path> entry accepts one in an archive',
        extra: { '.gitleaksignore': `${entry(first)}\n${entry(archived)}\n` }, accepted: [first, archived], live: [] },
      { name: 'a credential on a line that ends with gitleaks:allow is LIVE',
        extra: { [allowed.path]: realText(allowed, allowedValue, ` // ${ALLOW}`) }, accepted: [], live: [allowed] },
      { name: 'the root .gitleaksignore and .gitleaks.toml are scanned and suppress nothing: Gitleaks fingerprints in the ignore file and an allowlist of every path',
        extra: {
          '.gitleaksignore': `/scan/tree/${entry(first)}\ntree/${entry(first)}\n/scan/tree/${entry(archived)}\ntoken = "${inIgnoreValue}"\n`,
          '.gitleaks.toml': '[allowlist]\npaths = [".*"]\n',
        }, accepted: [], live: [inIgnore] },
      { name: 'the library rules have no global path allowlist: node_modules, .svg, gitleaks.toml in a name, lock files, vendor/modules.txt, go.sum, .pdf and a root .gitleaks.toml are LIVE',
        extra: shapeFiles, accepted: [], live: shapes },
      { name: 'the library rules have no per-rule path allowlist: a token in an .inc file and in the @octokit README, and a key on a SRC line of a .bb file, are LIVE',
        extra: ruleShapeFiles, accepted: [], live: ruleShapes },
      { name: 'a SemVer dependency version and a Go checksum line are not findings, and a key and a longer checksum line in the same lock files are LIVE',
        extra: lockFiles, accepted: [], live: [lockKey, sumExtra] },
      { name: 'a .tgz archive in any case is opened, and its findings carry the real path: one LIVE, one accepted by its entry',
        extra: { ...tgzFiles, '.gitleaksignore': `${entry(tgzAccepted)}\n` }, accepted: [tgzAccepted], live: [tgzLive] },
    ];
    for (const c of cases) {
      const clone = join(root, `clone-${cases.indexOf(c)}`);
      mkdirSync(clone, { recursive: true });
      git(clone, ['init', '-q', '-b', 'main']);
      writeFiles(clone, { ...files, ...c.extra });
      const commit = commitAll(clone, 'spoke');
      const res = spawnSync(process.execPath, [SCRIPT, '--clone', clone, '--commit', commit, '--hub', hubDir, '--pull'], { env: ENV, encoding: 'utf8', timeout: 20 * 60 * 1000 });
      const text = `${res.stdout}${res.stderr}`;
      const want = c.accepted.length === KEY_TABLE.length ? 0 : 1;
      const issues = [];
      if (res.status !== want) issues.push(`exit ${res.status}, expected ${want}`);
      const line = (e) => `${e.path} L${e.line}: ${e.rule}`;
      const live = text.split('\n').filter((l) => l.startsWith('[LIVE]'));
      const accepted = text.split('\n').filter((l) => l.startsWith('[ACCEPTED]'));
      const wantLive = [...KEY_TABLE.filter((e) => !c.accepted.includes(e)), ...c.live].map((e) => `[LIVE] ${line(e)}`);
      for (const w of wantLive) if (live.filter((l) => l === w).length !== 1) issues.push(`no single line: ${w}`);
      if (live.length !== wantLive.length) issues.push(`${live.length} [LIVE] lines, expected ${wantLive.length}: ${live.join(' | ')}`);
      const wantAcc = c.accepted.map((e) => `[ACCEPTED] ${line(e)} (.gitleaksignore: ${entry(e)})`);
      if (accepted.length !== wantAcc.length || wantAcc.some((w) => !accepted.includes(w))) issues.push(`[ACCEPTED] lines: ${accepted.join(' | ') || 'none'}`);
      for (const v of values) if (text.includes(v) || text.includes(v.split('\n')[1] || v)) issues.push('a generated value is in the output');
      if (issues.length) issues.push(`--- stdout\n${res.stdout}--- stderr\n${res.stderr}`);
      problems.push(...issues);
      console.log(issues.length ? `FAIL real: ${c.name}\n  ${issues.join('\n  ')}` : `ok   real: ${c.name}`);
    }
  } catch (err) {
    problems.push(String(err));
    console.log(`FAIL real: crashed: ${err.stack || err}`);
  } finally {
    if (!process.argv.includes('--keep')) rmSync(root, { recursive: true, force: true });
  }
  return problems.length ? 1 : 0;
}

/* ------------------------------------------------------------------ runner */

const argv = process.argv.slice(2);
if (argv.includes('--real')) {
  const code = realMain();
  rmSync(SANDBOX_HOME, { recursive: true, force: true });
  rmSync(GIT_ONLY, { recursive: true, force: true });
  console.log(code === 0 ? '\nall fixtures passed' : code === 2 ? '\ncannot verify' : '\nreal fixtures failed');
  process.exit(code);
}
const keep = argv.includes('--keep');
const only = argv.filter((a) => a !== '--keep').map(Number);
let failed = 0;

for (const fx of FIXTURES) {
  if (only.length && !only.includes(fx.n)) continue;
  const root = mkdtempSync(join(tmpdir(), `survey-secrets-${fx.n}-`));
  const problems = [];
  try {
    const f = build(root, fx.setup);
    // `env` and `out` may be functions of the built fixture, where they name a commit it made.
    const res = run(f, fx.args ? fx.args(f) : std(f), typeof fx.env === 'function' ? fx.env(f) : fx.env);
    if (res.status !== fx.exit) problems.push(`exit ${res.status}, expected ${fx.exit}`);
    for (const want of (typeof fx.out === 'function' ? fx.out(f) : fx.out) || []) if (!res.stdout.includes(want)) problems.push(`stdout lacks: ${want}`);
    for (const want of fx.err || []) if (!res.stderr.includes(want)) problems.push(`stderr lacks: ${want}`);
    for (const not of fx.absent || []) if (`${res.stdout}${res.stderr}`.includes(not)) problems.push(`output holds: ${not}`);
    if (fx.check) problems.push(...fx.check(f, dockerCalls(f.docker), res));
    if (problems.length) problems.push(`--- stdout\n${res.stdout}--- stderr\n${res.stderr}`);
  } catch (err) {
    problems.push(`fixture crashed: ${err.stack || err}`);
  }
  if (problems.length) {
    failed += 1;
    console.log(`FAIL ${fx.n} ${fx.name}\n  ${problems.join('\n  ')}`);
  } else {
    console.log(`ok   ${fx.n} ${fx.name}`);
  }
  if (!keep) rmSync(root, { recursive: true, force: true });
}

rmSync(SANDBOX_HOME, { recursive: true, force: true });
rmSync(GIT_ONLY, { recursive: true, force: true });
console.log(failed ? `\n${failed} fixture(s) failed` : '\nall fixtures passed');
process.exit(failed ? 1 : 0);

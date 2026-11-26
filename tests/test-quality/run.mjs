#!/usr/bin/env node
/**
 * run.mjs — the fixture suite for test-quality-scan.mjs and test-quality-hook.mjs, the Semgrep CE
 * test-quality scan at every `test-review` critic launch and in a spoke's story-gate.
 *
 *   usage:  node run.mjs            the scan and the hook, against scripted stand-ins for semgrep and
 *                                   docker (nothing to install)
 *           node run.mjs --rules    the shipped rules, against fixtures/ with REAL semgrep at the
 *                                   pinned version, in Docker (the image is pulled if it is missing).
 *                                   Exit 2 where Docker cannot run it
 *           node run.mjs 3 7        only the numbered fixtures
 *           node run.mjs --keep     leave the throwaway repositories on disk
 *
 * A fixture is a REPOSITORY STATE: a throwaway hub whose committed revision carries the rules and
 * the pin, a throwaway spoke whose commits carry the tests, and the script run as the hook and
 * story-gate run it. Exit code and text are asserted. Fixture 1 is the valid control; most others
 * change one thing. The stand-in records how it was called (its flags, its environment, the rules
 * and the files it was handed), so what the scan reads from where is asserted, not assumed.
 *
 * `--rules` reads the markers in fixtures/: a comment `// ruleid: <rule>` (or `# ruleid:`) marks the
 * line after it as one the rule must flag; `// ok:` marks one it must not. Every finding must be
 * marked, so a rule that starts flagging something new fails here.
 *
 * Node standard library only, plus git via child_process. No test framework.
 * Exit 0 if every fixture passes, 1 if any fails, 2 where --rules cannot run.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const LIBRARY_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIBRARY = existsSync(join(LIBRARY_ROOT, 'accelerator', 'gate', 'test-quality-scan.mjs'));
const SCRIPTS = LIBRARY ? join(LIBRARY_ROOT, 'accelerator', 'gate') : join(resolve(HERE, '..', '..'), 'scripts');
const SCAN = join(SCRIPTS, 'test-quality-scan.mjs');
const HOOK = join(SCRIPTS, 'test-quality-hook.mjs');
const SHIPPED = join(SCRIPTS, 'test-quality');
const FIXTURE_TREE = join(HERE, 'fixtures');
if (!existsSync(SCAN) || !existsSync(HOOK) || !existsSync(join(SHIPPED, 'ruleset.json'))) {
  console.error(`cannot locate test-quality-scan.mjs, test-quality-hook.mjs and test-quality/ under ${SCRIPTS}`);
  process.exit(4);
}

// The pin of the stand-in's hub: deliberately not the shipped one, which lives in ruleset.json alone.
const PIN = '9.9.9';
const SHIPPED_PIN = JSON.parse(readFileSync(join(SHIPPED, 'ruleset.json'), 'utf8')).semgrep;
const SANDBOX_HOME = mkdtempSync(join(tmpdir(), 'tq-home-'));
const ENV = {
  ...process.env,
  HOME: SANDBOX_HOME,
  XDG_CONFIG_HOME: join(SANDBOX_HOME, '.config'),
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
};
for (const k of ['SEMGREP_BIN', 'SEMGREP_IMAGE', 'SEMGREP_APP_TOKEN', 'SEMGREP_SEND_METRICS', 'CLAUDE_PROJECT_DIR', 'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL']) delete ENV[k];

function git(cwd, args) {
  return execFileSync('git', args, { cwd, env: ENV, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}
function write(dir, files) {
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), body);
  }
}
function repo(dir) {
  mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q', '--initial-branch', 'main']);
  git(dir, ['config', 'user.name', 'A Person']);
  git(dir, ['config', 'user.email', 'person@example.invalid']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
}
function commit(dir, message) {
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', message]);
  return git(dir, ['rev-parse', 'HEAD']);
}

/** The scripted stand-in for semgrep, driven by the spec file FAKE_SEMGREP names, logging every call. */
const FAKE = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const spec = JSON.parse(fs.readFileSync(process.env.FAKE_SEMGREP, 'utf8'));
const argv = process.argv.slice(2);
const arg = (name) => argv[argv.indexOf(name) + 1];
const walk = (dir, base = '') => Object.fromEntries(fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory()
  ? Object.entries(walk(path.join(dir, e.name), base + e.name + '/'))
  : [[base + e.name, fs.readFileSync(path.join(dir, e.name), 'utf8')]])));
const subject = walk(process.cwd());
fs.appendFileSync(spec.log, JSON.stringify({
  argv, config: arg('--config'), rules: walk(arg('--config')), subject,
  env: { metrics: process.env.SEMGREP_SEND_METRICS, versionCheck: process.env.SEMGREP_ENABLE_VERSION_CHECK, token: process.env.SEMGREP_APP_TOKEN || null },
}) + '\\n');
if (spec.sleepMs) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, spec.sleepMs);
if (spec.stderr) process.stderr.write(spec.stderr);
const scanned = Object.keys(subject).filter((p) => p !== '.semgrepignore');
if (spec.json !== false) fs.writeFileSync(arg('--json-output'), spec.rawJson !== undefined ? spec.rawJson : JSON.stringify({ version: spec.version, ...(spec.json || { results: [], errors: [], paths: { scanned } }) }));
if (spec.sarif !== false) fs.writeFileSync(arg('--sarif-output'), spec.rawSarif !== undefined ? spec.rawSarif : JSON.stringify(spec.sarif || { runs: [{ tool: { driver: { name: 'fake' } }, results: [] }] }));
process.exit(spec.status === undefined ? 0 : spec.status);
`;

/** The scripted semgrep the scripted docker runs: installed in <root>/bin, with its spec and call log. */
function fakeSemgrep(root, spec = {}) {
  const bin = join(root, 'bin', 'semgrep');
  mkdirSync(dirname(bin), { recursive: true });
  writeFileSync(bin, FAKE);
  chmodSync(bin, 0o755);
  const specFile = join(root, 'fake-spec.json');
  const log = join(root, 'fake-log.jsonl');
  writeFileSync(specFile, JSON.stringify({ version: PIN, log, ...spec }));
  return { env: { FAKE_SEMGREP: specFile }, log };
}
/** A stand-in `docker` for the same scripted semgrep: image present, missing or the daemon down; `run` maps the mounts back to folders. */
const FAKE_DOCKER = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const spec = JSON.parse(fs.readFileSync(process.env.FAKE_DOCKER, 'utf8'));
const argv = process.argv.slice(2);
fs.appendFileSync(spec.log, JSON.stringify({ argv, token: process.env.SEMGREP_APP_TOKEN || null }) + '\\n');
if (argv[0] === 'image' && argv[1] === 'inspect') {
  if (spec.daemon === 'down') { process.stderr.write('Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?\\n'); process.exit(1); }
  if (spec.image === 'missing' && !fs.existsSync(spec.pulled)) { process.stderr.write('Error response from daemon: No such image: ' + argv[argv.length - 1] + '\\n'); process.exit(1); }
  process.stdout.write('sha256:fake\\n');
  process.exit(0);
}
if (argv[0] === 'pull') {
  if (spec.pull === 'hang') Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 8000);
  if (spec.pull === 'fail') { process.stderr.write('Error response from daemon: Get "https://registry-1.docker.io/v2/": dial tcp: lookup registry-1.docker.io: no such host\\n'); process.exit(1); }
  fs.writeFileSync(spec.pulled, ''); process.exit(0);
}
if (argv[0] === 'run') {
  const mounts = {};
  argv.forEach((a, i) => { if (a === '--mount') { const o = Object.fromEntries(argv[i + 1].split(',').map((p) => p.split('='))); mounts[o.dst] = o.src; } });
  const map = (a) => (a === '/rules' ? mounts['/rules'] : a.startsWith('/out/') ? path.join(mounts['/out'], a.slice(5)) : a);
  const res = spawnSync(process.execPath, [spec.semgrep, ...argv.slice(argv.indexOf('semgrep') + 1).map(map)], { cwd: mounts['/src'], stdio: ['ignore', 'ignore', 'inherit'], env: process.env });
  process.exit(res.status === null ? 1 : res.status);
}
process.exit(0);
`;

/** The scripted semgrep behind a scripted docker: the one way the scan runs. */
function fakeDocker(root, semgrepSpec = {}, docker = {}) {
  const f = fakeSemgrep(root, semgrepSpec);
  const bin = join(root, 'bin', 'docker');
  writeFileSync(bin, FAKE_DOCKER);
  chmodSync(bin, 0o755);
  const specFile = join(root, 'fake-docker.json');
  const log = join(root, 'docker-log.jsonl');
  writeFileSync(specFile, JSON.stringify({ log, semgrep: join(root, 'bin', 'semgrep'), pulled: join(root, 'pulled'), ...docker }));
  return { env: { FAKE_SEMGREP: f.env.FAKE_SEMGREP, FAKE_DOCKER: specFile, PATH: `${join(root, 'bin')}${delimiter}${process.env.PATH}` }, log: f.log, dockerLog: log };
}
/** The usual stand-in: Docker running, the image there, a scripted Semgrep inside. */
const fake = (root, spec = {}) => fakeDocker(root, spec);
const dockerCalls = (f) => (existsSync(f.dockerLog) ? readFileSync(f.dockerLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const dockerVerbs = (f) => dockerCalls(f).map((c) => c.argv.slice(0, 2).join(' ')).join(' | ');
const calls = (f) => (existsSync(f.log) ? readFileSync(f.log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const found = (path, line, rule, severity, message = 'a message') => ({ check_id: `tmp.rules.${rule}`, path, start: { line }, extra: { severity, message } });
const reportOf = (results, scanned = []) => ({ json: { results, errors: [], paths: { scanned } } });

const RULE = 'rules:\n  - id: shl-x\n    languages: [generic]\n    severity: ERROR\n    message: m\n    pattern: x\n';
/** A hub whose committed revision carries the shared rules and the pin, installed or library layout. */
function hub(root, { pin = PIN, layout = 'installed', rules = { 'one.yml': RULE }, name = 'hub' } = {}) {
  const dir = join(root, name);
  repo(dir);
  const base = layout === 'library' ? 'accelerator/gate/test-quality' : 'scripts/test-quality';
  write(dir, { 'README.md': '# hub\n', [`${base}/ruleset.json`]: `${JSON.stringify({ ruleset: '1.0.0', semgrep: pin })}\n`, ...Object.fromEntries(Object.entries(rules).map(([n, t]) => [`${base}/rules/${n}`, t])) });
  return { dir, base, commit: commit(dir, 'chore: the hub'), rulesDir: join(dir, base, 'rules') };
}
/** A spoke: a base commit with one test file already there, then a head commit adding `files`. */
function spoke(root, files, { name = 'spoke', remove = [], at = null } = {}) {
  const work = at || join(root, name);
  repo(work);
  write(work, { 'README.md': '# spoke\n', 'src/keep.test.ts': 'export {};\n', 'src/gone.test.ts': 'export {};\n' });
  const base = commit(work, 'chore: the trunk');
  write(work, files);
  for (const r of remove) rmSync(join(work, r));
  return { work, base, head: commit(work, 'test: the tests') };
}
const TEST_FILE = { 'src/a.test.ts': "it('works', () => { expect(run()).toBe(1); });\n" };

function spawn(cmd, args, { env = {}, input, cwd } = {}) {
  const res = spawnSync(cmd, args, { cwd, env: { ...ENV, ...env }, encoding: 'utf8', input });
  return { status: res.status, stdout: res.stdout || '', output: `${res.stdout || ''}${res.stderr || ''}` };
}
function scanCli(h, s, f, extra = [], env = {}) {
  return spawn(process.execPath, [SCAN, '--repo', s.work, '--range', `${s.base}..${s.head}`, '--hub', h.dir, ...extra], { env: { ...f.env, ...env } });
}
/** The preflight: --ensure-image against the hub, no checkout and no range. */
function ensureCli(h, f, extra = [], env = {}) {
  return spawn(process.execPath, [SCAN, '--ensure-image', '--hub', h.dir, ...extra], { env: { ...f.env, ...env } });
}

/** Which test stacks a checkout holds, against the hub's rules: reads files and git, so no stand-in is needed. */
function coverageCli(h, s, extra = []) {
  return spawn(process.execPath, [SCAN, '--coverage', '--repo', s.work, '--hub', h.dir, ...extra]);
}
const ruleFor = (id, languages, include) => `rules:\n  - id: ${id}\n    languages: [${languages}]\n    severity: ERROR\n    message: m\n    paths:\n      include: [${include}]\n    pattern: x\n`;
const STACK_RULES = { 'java.yml': ruleFor('shl-java-x', 'java', '"**/src/test/", "*Test.java"'), 'go.yml': ruleFor('shl-go-x', 'go', '"*_test.go"') };

/** One critic dispatch, as the orchestrator's Agent call carries it. */
const dispatch = (s, extra = '') => ({
  hook_event_name: 'PreToolUse', tool_name: 'Agent', cwd: '/elsewhere',
  tool_input: { subagent_type: 'dual-mode-critic', description: 'review the tests', prompt: `Mode: test-review\nTest-Checkout: ${s.work}\nTest-Base: ${s.base}\n\nReview the diff of the two commits.${extra}\n` },
});
function hookCli(h, f, event, env = {}) {
  const res = spawn(process.execPath, [HOOK], { env: { ...f.env, CLAUDE_PROJECT_DIR: h.dir, ...env }, input: typeof event === 'string' ? event : JSON.stringify(event) });
  let decoded = res.stdout;
  try {
    const o = JSON.parse(res.stdout);
    const out = o.hookSpecificOutput || {};
    decoded = [`systemMessage=${o.systemMessage || ''}`, `decision=${out.permissionDecision || 'none'}`, `seat=${out.updatedInput ? out.updatedInput.subagent_type : ''}`, `description=${out.updatedInput ? out.updatedInput.description : ''}`, `--- prompt ---`, out.updatedInput ? out.updatedInput.prompt : ''].join('\n');
  } catch (err) { /* no JSON: the raw output is asserted */ }
  return { status: res.status, output: `${decoded}\nstdout-bytes=${res.stdout.length}\n` };
}

/* ------------------------------------------------------------------- fixtures */

const FIXTURES = [
  /* ------------------------------------------------------------ the scan */
  {
    n: 1, name: 'a clean range passes, and the report names what was scanned: semgrep, ruleset, hub revision, commit and tree',
    run: (root) => { const h = hub(root); const s = spoke(root, TEST_FILE); const f = fake(root); return scanCli(h, s, f, ['--sarif', join(root, 'out.sarif')]); },
    exit: 0, includes: [`TEST QUALITY SCAN — semgrep ${PIN} · ruleset 1.0.0`, '1 of 1 changed source file(s)', 'TEST QUALITY: 0 violation(s), 0 warning(s).'],
  },
  {
    n: 2, name: 'the SARIF report is kept, stamped with the commit, tree, ruleset hash and semgrep version it was made from',
    run: (root) => {
      const h = hub(root); const s = spoke(root, TEST_FILE); const f = fake(root); const out = join(root, 'out.sarif');
      const r = scanCli(h, s, f, ['--sarif', out]);
      const stamp = JSON.parse(readFileSync(out, 'utf8')).runs[0].properties.shlTestQuality;
      return { status: r.status, output: `${r.output}\ncommit-ok=${stamp.commit === s.head}\ntree-ok=${stamp.tree === git(s.work, ['rev-parse', `${s.head}^{tree}`])}\nsha-ok=${stamp.rulesSha256.length === 64}\nhub-ok=${stamp.hubCommit === h.commit}\nsemgrep=${stamp.semgrep}\nruleset=${stamp.ruleset}\n` };
    },
    exit: 0, includes: ['commit-ok=true', 'tree-ok=true', 'sha-ok=true', 'hub-ok=true', `semgrep=${PIN}`, 'ruleset=1.0.0'],
  },
  {
    n: 3, name: 'warnings only is exit 0, and each is listed with its rule, location and message for the critic to judge',
    run: (root) => { const h = hub(root); const s = spoke(root, TEST_FILE); const f = fake(root, reportOf([found('src/a.test.ts', 4, 'shl-js-no-assertion', 'WARNING', 'no assertion recognised')], ['src/a.test.ts'])); return scanCli(h, s, f); },
    exit: 0, includes: ['[WARNING] SG-1 shl-js-no-assertion  src/a.test.ts:4 — no assertion recognised', 'TEST QUALITY: 0 violation(s), 1 warning(s).'],
  },
  {
    n: 4, name: 'a violation is exit 1, listed first with its rule and location; warnings follow in the same numbering',
    run: (root) => {
      const h = hub(root); const s = spoke(root, TEST_FILE);
      const f = fake(root, reportOf([found('src/a.test.ts', 9, 'shl-js-no-assertion', 'WARNING'), found('src/a.test.ts', 3, 'shl-js-skipped', 'ERROR', 'skipped')], ['src/a.test.ts']));
      return scanCli(h, s, f);
    },
    exit: 1, includes: ['[VIOLATION] SG-1 shl-js-skipped  src/a.test.ts:3 — skipped', '[WARNING] SG-2 shl-js-no-assertion  src/a.test.ts:9', 'TEST QUALITY: 1 violation(s), 1 warning(s).'],
  },
  {
    n: 5, name: 'INFO findings are ignored',
    run: (root) => { const h = hub(root); const s = spoke(root, TEST_FILE); const f = fake(root, reportOf([found('src/a.test.ts', 3, 'shl-x', 'INFO')], ['src/a.test.ts'])); return scanCli(h, s, f); },
    exit: 0, includes: ['0 violation(s), 0 warning(s).'],
  },
  {
    n: 6, name: 'Docker is the only way Semgrep runs: a SEMGREP_BIN in the environment changes nothing, and the scan still runs in the container',
    run: (root) => {
      const h = hub(root); const s = spoke(root, TEST_FILE); const f = fake(root);
      const r = scanCli(h, s, f, [], { SEMGREP_BIN: join(root, 'nowhere', 'semgrep') });
      return { status: r.status, output: `${r.output}\nverbs=${dockerVerbs(f)}\n` };
    },
    exit: 0, includes: ['TEST QUALITY: 0 violation(s), 0 warning(s).', 'verbs=image inspect | run --rm'],
  },
  {
    n: 7, name: 'a semgrep that is not the pinned version is exit 2, naming both',
    run: (root) => { const h = hub(root); const s = spoke(root, TEST_FILE); return scanCli(h, s, fake(root, { version: '1.100.0' })); },
    exit: 2, includes: [`semgrep 1.100.0 ran, the hub pins ${PIN}`],
  },
  {
    n: 8, name: 'a semgrep that exits non-zero is exit 2 with its own words, never a pass',
    run: (root) => { const h = hub(root); const s = spoke(root, TEST_FILE); return scanCli(h, s, fake(root, { status: 2, stderr: 'rule shl-x is invalid\n' })); },
    exit: 2, includes: ['docker run exited 2', 'rule shl-x is invalid'],
  },
  {
    n: 9, name: 'a JSON report that cannot be read is exit 2',
    run: (root) => { const h = hub(root); const s = spoke(root, TEST_FILE); return scanCli(h, s, fake(root, { rawJson: '{ not json' })); },
    exit: 2, includes: ['semgrep wrote no readable JSON report'],
  },
  {
    n: 10, name: 'a SARIF report that is not one is exit 2',
    run: (root) => { const h = hub(root); const s = spoke(root, TEST_FILE); return scanCli(h, s, fake(root, { rawSarif: '{"version":"2.1.0"}' })); },
    exit: 2, includes: ['SARIF report this script does not recognise'],
  },
  {
    n: 11, name: 'an error that means a file or rule was not run (a timeout) is exit 2, naming the file',
    run: (root) => {
      const h = hub(root); const s = spoke(root, TEST_FILE);
      const f = fake(root, { json: { results: [], errors: [{ type: ['Timeout', 'x'], level: 'warn', path: 'src/a.test.ts' }], paths: { scanned: ['src/a.test.ts'] } } });
      return scanCli(h, s, f);
    },
    exit: 2, includes: ['semgrep reported 1 error(s)', 'Timeout src/a.test.ts'],
  },
  {
    n: 12, name: 'a partial parse is reported as such and does not fail the scan: the rest of the file was checked',
    run: (root) => {
      const h = hub(root); const s = spoke(root, TEST_FILE);
      const f = fake(root, { json: { results: [], errors: [{ type: ['PartialParsing', []], level: 'warn', path: 'src/a.test.ts', spans: [{ start: { line: 17 } }] }], paths: { scanned: ['src/a.test.ts'] } } });
      return scanCli(h, s, f);
    },
    exit: 0, includes: ['[PARTIAL] src/a.test.ts:17 — Semgrep could not parse part of this file', '1 partly parsed'],
  },
  {
    n: 13, name: 'the rules are the hub\'s COMMITTED revision: an uncommitted edit and an untracked rule in the hub change nothing',
    run: (root) => {
      const h = hub(root); const s = spoke(root, TEST_FILE); const f = fake(root);
      write(h.dir, { [`${h.base}/rules/one.yml`]: 'rules: []\n# edited, not committed\n', [`${h.base}/rules/untracked.yml`]: 'rules: []\n' });
      const r = scanCli(h, s, f);
      const seen = calls(f)[0].rules;
      return { status: r.status, output: `${r.output}\nrule-files=${JSON.stringify(Object.keys(seen))}\nedited=${seen['one.yml'].includes('edited, not committed')}\n` };
    },
    exit: 0, includes: ['rule-files=["one.yml"]', 'edited=false'],
  },
  {
    n: 14, name: 'nothing in the spoke can change how it is judged: a rules folder and a .semgrepignore it carries are never read',
    run: (root) => {
      const h = hub(root); const f = fake(root);
      const s = spoke(root, { ...TEST_FILE, 'scripts/test-quality/rules/evil.yml': 'rules: []\n', 'scripts/test-quality/ruleset.json': '{"ruleset":"9","semgrep":"9.9.9"}\n', '.semgrepignore': '*\n', 'src/helper.ts': 'export {};\n' });
      const r = scanCli(h, s, f);
      const c = calls(f)[0];
      return { status: r.status, output: `${r.output}\nrule-files=${JSON.stringify(Object.keys(c.rules))}\nignore=${JSON.stringify(c.subject['.semgrepignore'])}\nsubject=${JSON.stringify(Object.keys(c.subject).sort())}\n` };
    },
    exit: 0, includes: ['rule-files=["one.yml"]', 'ignore="# the harness scans test folders: nothing is ignored\\n"', 'subject=[".semgrepignore","src/a.test.ts","src/helper.ts"]'],
  },
  {
    n: 15, name: '--rev reads the rules and the pin of that hub revision: an older revision with another pin is judged by its own',
    run: (root) => {
      const h = hub(root, { pin: '1.0.0' }); const first = h.commit;
      write(h.dir, { [`${h.base}/ruleset.json`]: `${JSON.stringify({ ruleset: '2.0.0', semgrep: '2.0.0' })}\n`, [`${h.base}/rules/two.yml`]: RULE });
      commit(h.dir, 'chore: a newer ruleset');
      const s = spoke(root, TEST_FILE); const f = fake(root, { version: '1.0.0' });
      const old = scanCli(h, s, f, ['--rev', first]);
      const now = scanCli(h, s, f);
      return { status: old.status === 0 && now.status === 2 ? 0 : 1, output: `old=${old.status} ${old.output.split('\n')[0]}\nnow=${now.status} ${now.output.split('\n')[0]}\n` };
    },
    exit: 0, includes: ['old=0 TEST QUALITY SCAN — semgrep 1.0.0 · ruleset 1.0.0', 'now=2 TEST QUALITY SCAN CANNOT VERIFY'],
  },
  {
    n: 16, name: 'the library layout (accelerator/gate/test-quality) is found as well as the installed one',
    run: (root) => { const h = hub(root, { layout: 'library' }); const s = spoke(root, TEST_FILE); return scanCli(h, s, fake(root)); },
    exit: 0, includes: ['TEST QUALITY: 0 violation(s), 0 warning(s).'],
  },
  {
    n: 17, name: 'a hub revision with no test-quality rules is exit 2: upgrade the hub',
    run: (root) => {
      const h = hub(root);
      write(h.dir, { 'other.md': 'x\n' }); git(h.dir, ['rm', '-q', '-r', h.base]); commit(h.dir, 'chore: without the rules');
      const s = spoke(root, TEST_FILE); return scanCli(h, s, fake(root));
    },
    exit: 2, includes: ['carries no test-quality rules', 'upgrade the hub'],
  },
  {
    n: 18, name: 'a ruleset.json with no pin is exit 2',
    run: (root) => { const h = hub(root); write(h.dir, { [`${h.base}/ruleset.json`]: '{"ruleset":"1.0.0"}\n' }); commit(h.dir, 'chore: no pin'); const s = spoke(root, TEST_FILE); return scanCli(h, s, fake(root)); },
    exit: 2, includes: ['needs a "ruleset" version and the "semgrep" version it pins'],
  },
  {
    n: 19, name: 'semgrep is called with local rules only: metrics off, no version check, nosem disabled, no token, the config a folder',
    run: (root) => {
      const h = hub(root); const s = spoke(root, TEST_FILE); const f = fake(root);
      const r = scanCli(h, s, f, [], { SEMGREP_APP_TOKEN: 'a-secret-token', SEMGREP_SEND_METRICS: 'on' });
      const c = calls(f)[0];
      return { status: r.status, output: `${r.output}\nargv=${c.argv.join(' ')}\nenv=${JSON.stringify(c.env)}\nconfig-is-a-folder=${!c.config.includes('://') && !c.config.startsWith('p/') && c.config !== 'auto'}\n` };
    },
    exit: 0, includes: ['--metrics=off', '--disable-version-check', '--disable-nosem', '--json-output', '--sarif-output', 'env={"metrics":"off","versionCheck":"0","token":null}', 'config-is-a-folder=true'],
  },
  {
    n: 20, name: 'the files are read as committed at the head: a later edit in the working tree is not scanned',
    run: (root) => {
      const h = hub(root); const s = spoke(root, { 'src/a.test.ts': "it('committed', () => {});\n" }); const f = fake(root);
      writeFileSync(join(s.work, 'src/a.test.ts'), "it('edited after the commit', () => {});\n");
      const r = scanCli(h, s, f);
      return { status: r.status, output: `${r.output}\nscanned=${JSON.stringify(calls(f)[0].subject['src/a.test.ts'])}\n` };
    },
    exit: 0, includes: ['scanned="it(\'committed\', () => {});\\n"'],
  },
  {
    n: 21, name: 'only what the range adds or modifies is scanned: not an unchanged file, a deleted one, or a file that is not source',
    run: (root) => {
      const h = hub(root); const f = fake(root);
      const s = spoke(root, { ...TEST_FILE, 'docs/notes.md': '# notes\n', 'data.json': '{}\n' }, { remove: ['src/gone.test.ts'] });
      const r = scanCli(h, s, f);
      return { status: r.status, output: `${r.output}\nsubject=${JSON.stringify(Object.keys(calls(f)[0].subject).sort())}\n` };
    },
    exit: 0, includes: ['subject=[".semgrepignore","src/a.test.ts"]'],
  },
  {
    n: 22, name: 'a range that changes no source file has nothing to scan: exit 0, and semgrep is never started',
    run: (root) => {
      const h = hub(root); const f = fake(root); const s = spoke(root, { 'docs/notes.md': '# notes\n' });
      const r = scanCli(h, s, f);
      return { status: r.status, output: `${r.output}\nsemgrep-calls=${calls(f).length}\n` };
    },
    exit: 0, includes: ['nothing to scan', 'semgrep-calls=0'],
  },
  {
    n: 23, name: 'a changed test file in a language or framework without rules is listed as not covered, never as clean',
    run: (root) => {
      const h = hub(root); const s = spoke(root, { ...TEST_FILE, 'spec/billing_spec.rb': "describe 'x' do end\n", 'src/Billing.Tests.cs': 'class T {}\n' });
      return scanCli(h, s, fake(root));
    },
    exit: 0, includes: ['[NOT COVERED] spec/billing_spec.rb — no rules for this language or framework: nothing was checked', '[NOT COVERED] src/Billing.Tests.cs', '2 file(s) not covered'],
  },
  {
    n: 24, name: 'only not-covered test files changed: still listed, exit 0, semgrep not started',
    run: (root) => { const h = hub(root); const f = fake(root); const s = spoke(root, { 'spec/billing_spec.rb': "describe 'x' do end\n" }); const r = scanCli(h, s, f); return { status: r.status, output: `${r.output}\nsemgrep-calls=${calls(f).length}\n` }; },
    exit: 0, includes: ['nothing to scan', '[NOT COVERED] spec/billing_spec.rb', 'semgrep-calls=0'],
  },
  {
    n: 25, name: 'a base commit that is not there (a shallow clone) is exit 2, never a pass',
    run: (root) => { const h = hub(root); const s = spoke(root, TEST_FILE); return spawn(process.execPath, [SCAN, '--repo', s.work, '--range', `${'0'.repeat(40)}..${s.head}`, '--hub', h.dir], { env: fake(root).env }); },
    exit: 2, includes: [`cannot read ${'0'.repeat(40)} in`],
  },
  {
    n: 26, name: 'usage: no range, a malformed range, an unknown flag and a --timeout that is not a number are each exit 3',
    run: (root) => {
      const h = hub(root); const s = spoke(root, TEST_FILE); const env = fake(root).env;
      const none = spawn(process.execPath, [SCAN, '--repo', s.work, '--hub', h.dir], { env });
      const bad = spawn(process.execPath, [SCAN, '--repo', s.work, '--range', 'main', '--hub', h.dir], { env });
      const flag = spawn(process.execPath, [SCAN, '--nonsense'], { env });
      const soon = spawn(process.execPath, [SCAN, '--repo', s.work, '--range', `${s.base}..${s.head}`, '--hub', h.dir, '--timeout', 'soon'], { env });
      return { status: [none, bad, flag, soon].every((r) => r.status === 3) ? 3 : 1, output: `${none.output}${bad.output}${flag.output}${soon.output}` };
    },
    exit: 3, includes: ['USAGE — node scripts/test-quality-scan.mjs', '--range takes <base>..<head>, not "main"', 'unknown argument: --nonsense', '--timeout takes a number of seconds'],
  },
  {
    n: 27, name: 'more than thirty of one kind are summarised, so a critic\'s prompt stays short; the SARIF keeps them all',
    run: (root) => {
      const h = hub(root); const s = spoke(root, TEST_FILE);
      const many = Array.from({ length: 40 }, (_, i) => found('src/a.test.ts', i + 1, 'shl-js-no-assertion', 'WARNING'));
      return scanCli(h, s, fake(root, reportOf(many, ['src/a.test.ts'])));
    },
    exit: 0, includes: ['[WARNING] SG-30 ', '[WARNING] … 10 more of the same kind; the SARIF report lists all', '0 violation(s), 40 warning(s).'],
  },

  {
    n: 37, name: 'a branch behind its base is judged on what it changed, not on what the base moved on to since: a three-dot diff',
    run: (root) => {
      const h = hub(root); const f = fake(root); const s = spoke(root, TEST_FILE);
      git(s.work, ['switch', '-q', '-c', 'trunk-moves', s.base]);
      write(s.work, { 'src/keep.test.ts': 'export const moved = 1;\n' });
      const ahead = commit(s.work, 'test: the trunk moved on');
      const r = scanCli(h, { work: s.work, base: ahead, head: s.head }, f);
      return { status: r.status, output: `${r.output}\nsubject=${JSON.stringify(Object.keys(calls(f)[0].subject).sort())}\n` };
    },
    exit: 0, includes: ['subject=[".semgrepignore","src/a.test.ts"]'],
  },
  {
    n: 38, name: 'a range bound that would be an option to git is a usage error, and nothing is written',
    run: (root) => {
      const h = hub(root); const s = spoke(root, TEST_FILE); const target = join(root, 'pwn');
      const r = spawn(process.execPath, [SCAN, '--repo', s.work, '--range', `--output=${target}..${s.head}`, '--hub', h.dir], { env: fake(root).env });
      return { status: r.status, output: `${r.output}\nfile-written=${existsSync(target)}\n` };
    },
    exit: 3, includes: ['--range takes <base>..<head>', 'file-written=false'],
  },
  {
    n: 39, name: 'a semgrep that does not finish in time is exit 2, never a hang: --timeout',
    run: (root) => { const h = hub(root); const s = spoke(root, TEST_FILE); return scanCli(h, s, fake(root, { sleepMs: 4000 }), ['--timeout', '1']); },
    exit: 2, includes: ['semgrep did not finish within 1 s'],
  },


  /* ------------------------------------------------------------ Docker, and the hub's own rules */
  {
    n: 40, name: 'Semgrep runs in the pinned container: no network, read-only root and mounts, no capabilities, the caller\'s user, no token; its findings are judged as ever',
    run: (root) => {
      const h = hub(root); const s = spoke(root, TEST_FILE);
      const f = fakeDocker(root, reportOf([found('src/a.test.ts', 3, 'shl-js-skipped', 'ERROR', 'skipped')], ['src/a.test.ts']));
      const r = scanCli(h, s, f, [], { SEMGREP_APP_TOKEN: 'a-secret-token' });
      const run = dockerCalls(f).find((c) => c.argv[0] === 'run');
      const a = run.argv;
      const mounts = a.filter((v, i) => a[i - 1] === '--mount');
      const readonly = (dst) => mounts.some((m) => m.includes(`dst=${dst},`) && m.endsWith(',readonly'));
      return { status: r.status, output: `${r.output}\nimage=${a[a.indexOf('semgrep') - 1]}\nnetwork=${a[a.indexOf('--network') + 1]}\nlocked-down=${['--rm', '--read-only', '--cap-drop', 'ALL', 'no-new-privileges'].every((v) => a.includes(v))}\nrules-readonly=${readonly('/rules')}\nsubject-readonly=${readonly('/src')}\nout-writable=${mounts.some((m) => m.includes('dst=/out') && !m.includes('readonly'))}\nuser-ok=${a[a.indexOf('--user') + 1] === `${process.getuid()}:${process.getgid()}`}\ntoken-passed=${run.token !== null || a.some((v) => v.includes('TOKEN'))}\nverbs=${dockerVerbs(f)}\n` };
    },
    exit: 1, includes: ['[VIOLATION] SG-1 shl-js-skipped  src/a.test.ts:3', `image=semgrep/semgrep:${PIN}`, 'network=none', 'locked-down=true', 'rules-readonly=true', 'subject-readonly=true', 'out-writable=true', 'user-ok=true', 'token-passed=false', 'verbs=image inspect | run --rm'],
  },
  {
    n: 41, name: 'no docker on the PATH is exit 2, naming Docker and where to get it, and offering no other way to run Semgrep',
    run: (root) => {
      const h = hub(root); const s = spoke(root, TEST_FILE);
      const tools = join(root, 'tools'); mkdirSync(tools);
      symlinkSync(execFileSync('which', ['git'], { encoding: 'utf8' }).trim(), join(tools, 'git'));
      return scanCli(h, s, { env: {} }, [], { PATH: tools });
    },
    exit: 2, includes: ['TEST QUALITY SCAN CANNOT VERIFY', 'Docker is not installed', 'https://docs.docker.com/get-docker/'],
  },
  {
    n: 42, name: 'a Docker that is not running is exit 2, with its own words',
    run: (root) => { const h = hub(root); const s = spoke(root, TEST_FILE); return scanCli(h, s, fakeDocker(root, {}, { daemon: 'down' })); },
    exit: 2, includes: ['Docker is not running or cannot be used: Cannot connect to the Docker daemon'],
  },
  {
    n: 43, name: 'the image not on the machine is exit 2 with the one command to fetch it, and nothing is downloaded by the scan itself',
    run: (root) => {
      const h = hub(root); const s = spoke(root, TEST_FILE); const f = fakeDocker(root, {}, { image: 'missing' });
      const r = scanCli(h, s, f);
      return { status: r.status, output: `${r.output}\nverbs=${dockerVerbs(f)}\n` };
    },
    exit: 2, includes: [`the Semgrep image is not on this machine yet; fetch it once with: docker pull semgrep/semgrep:${PIN}`, 'verbs=image inspect\n'],
  },
  {
    n: 44, name: '--pull fetches a missing image first and then scans: the CI way',
    run: (root) => {
      const h = hub(root); const s = spoke(root, TEST_FILE); const f = fakeDocker(root, {}, { image: 'missing' });
      const r = scanCli(h, s, f, ['--pull']);
      return { status: r.status, output: `${r.output}\nverbs=${dockerVerbs(f)}\n` };
    },
    exit: 0, includes: ['TEST QUALITY: 0 violation(s), 0 warning(s).', 'verbs=image inspect | pull --quiet | run --rm'],
  },
  {
    n: 45, name: 'SEMGREP_IMAGE names a mirror of the repository, tagged with the pin; a name that could be a docker option is exit 3 and nothing runs',
    run: (root) => {
      const h = hub(root); const s = spoke(root, TEST_FILE); const f = fakeDocker(root);
      const ok = scanCli(h, s, f, [], { SEMGREP_IMAGE: 'registry.example.invalid/mirror/semgrep' });
      const run = dockerCalls(f).find((c) => c.argv[0] === 'run');
      const before = dockerCalls(f).length;
      const bad = scanCli(h, s, f, [], { SEMGREP_IMAGE: '--privileged' });
      return { status: ok.status === 0 && bad.status === 3 ? 0 : 1, output: `image=${run.argv[run.argv.indexOf('semgrep') - 1]}\n${bad.output}docker-calls-after-refusal=${dockerCalls(f).length - before}\n` };
    },
    exit: 0, includes: [`image=registry.example.invalid/mirror/semgrep:${PIN}`, 'is not an image name', 'docker-calls-after-refusal=0'],
  },
  {
    n: 46, name: 'a container that does not finish in time is exit 2 and is removed, never left running',
    run: (root) => {
      const h = hub(root); const s = spoke(root, TEST_FILE); const f = fakeDocker(root, { sleepMs: 4000 });
      const r = scanCli(h, s, f, ['--timeout', '1']);
      const rm = dockerCalls(f).find((c) => c.argv[0] === 'rm');
      return { status: r.status, output: `${r.output}\nremoved=${rm ? rm.argv.slice(0, 2).join(' ') : 'no'} ${rm && rm.argv[2].startsWith('shl-test-quality-')}\n` };
    },
    exit: 2, includes: ['semgrep did not finish within 1 s', 'removed=rm -f true'],
  },
  {
    n: 47, name: 'a hub\'s own rule file sits beside the library\'s in the one folder: both are handed to Semgrep, both are in the hash, and its finding is judged like any other',
    run: (root) => {
      const own = RULE.replace('shl-x', 'hub-y');
      const h = hub(root, { rules: { 'one.yml': RULE, 'hub-own.yml': own } }); const alone = hub(root, { name: 'hub-alone' });
      const s = spoke(root, TEST_FILE);
      const f = fake(root, reportOf([found('src/a.test.ts', 3, 'hub-y', 'ERROR', 'this hub\'s rule')], ['src/a.test.ts']));
      const r = scanCli(h, s, f); const base = scanCli(alone, s, fake(root));
      const sha = (o) => o.output.match(/\(sha ([0-9a-f]{12})/)[1];
      return { status: r.status, output: `${r.output}\nrule-files=${JSON.stringify(Object.keys(calls(f)[0].rules).sort())}\nhash-differs=${sha(r) !== sha(base)}\n` };
    },
    exit: 1, includes: ['[VIOLATION] SG-1 hub-y  src/a.test.ts:3 — this hub\'s rule', 'rule-files=["hub-own.yml","one.yml"]', 'hash-differs=true'],
  },
  {
    n: 48, name: 'a rule id defined twice is exit 2 naming both files: a hub rule can neither replace nor hide another',
    run: (root) => { const h = hub(root, { rules: { 'one.yml': RULE, 'hub-dup.yml': RULE } }); const s = spoke(root, TEST_FILE); return scanCli(h, s, fake(root)); },
    exit: 2, includes: ['rule id shl-x is defined in both rules/hub-dup.yml and rules/one.yml', 'hub-<name>'],
  },
  {
    n: 49, name: 'the hook never downloads: with the image missing it warns with the one command, tells the critic, and the review continues',
    run: (root) => {
      const h = hub(root); const s = spoke(root, TEST_FILE); const f = fakeDocker(root, {}, { image: 'missing' });
      const r = hookCli(h, f, dispatch(s));
      return { status: r.status, output: `${r.output}verbs=${dockerVerbs(f)}\n` };
    },
    exit: 0, includes: [`⚠ test-quality: Semgrep scan not run — the Semgrep image is not on this machine yet; fetch it once with: docker pull semgrep/semgrep:${PIN}`, 'decision=none', 'Semgrep scan not run: the Semgrep image', 'verbs=image inspect\n'],
  },
  {
    n: 51, name: 'the preflight fetches a missing image, with Docker\'s progress shown, and scans nothing',
    run: (root) => {
      const h = hub(root); const f = fakeDocker(root, {}, { image: 'missing' });
      const r = ensureCli(h, f);
      const pull = dockerCalls(f).find((c) => c.argv[0] === 'pull');
      return { status: r.status, output: `${r.output}\nverbs=${dockerVerbs(f)}\npull=${pull ? pull.argv.join(' ') : 'none'}\n` };
    },
    exit: 0, includes: [`Fetching semgrep/semgrep:${PIN}`, `TEST QUALITY IMAGE — semgrep/semgrep:${PIN} fetched`, 'verbs=image inspect | pull ' + `semgrep/semgrep:${PIN}`, `pull=pull semgrep/semgrep:${PIN}\n`],
  },
  {
    n: 52, name: 'the preflight with the image already there fetches nothing and says so',
    run: (root) => {
      const h = hub(root); const f = fakeDocker(root);
      const r = ensureCli(h, f);
      return { status: r.status, output: `${r.output}\nverbs=${dockerVerbs(f)}\n` };
    },
    exit: 0, includes: [`semgrep/semgrep:${PIN} is already on this machine`, 'verbs=image inspect\n'],
  },
  {
    n: 53, name: 'the preflight with Docker down or absent is exit 2 in the scan\'s own words, never a hang or a crash',
    run: (root) => {
      const h = hub(root);
      const down = ensureCli(h, fakeDocker(root, {}, { daemon: 'down' }));
      const tools = join(root, 'tools'); mkdirSync(tools);
      symlinkSync(execFileSync('which', ['git'], { encoding: 'utf8' }).trim(), join(tools, 'git'));
      const none = ensureCli(h, { env: {} }, [], { PATH: tools });
      return { status: down.status === 2 && none.status === 2 ? 2 : 1, output: `daemon down:\n${down.output}\nno docker:\n${none.output}` };
    },
    exit: 2, includes: ['Docker is not running or cannot be used: Cannot connect to the Docker daemon', 'REASON: docker-not-running', 'Docker is not installed', 'REASON: docker-not-installed'],
  },
  {
    n: 54, name: 'a mirror in SEMGREP_IMAGE is the repository the preflight fetches; a SEMGREP_BIN in the environment is ignored and Docker is still asked',
    run: (root) => {
      const h = hub(root);
      const m = fakeDocker(root, {}, { image: 'missing' });
      const mirror = ensureCli(h, m, [], { SEMGREP_IMAGE: 'registry.example.com/mirror/semgrep', SEMGREP_BIN: join(root, 'nowhere', 'semgrep') });
      const pull = dockerCalls(m).find((c) => c.argv[0] === 'pull');
      return { status: mirror.status, output: `${mirror.output}\nmirror-pull=${pull ? pull.argv.join(' ') : 'none'}\nverbs=${dockerVerbs(m)}\n` };
    },
    exit: 0, includes: [`TEST QUALITY IMAGE — registry.example.com/mirror/semgrep:${PIN} fetched`, `mirror-pull=pull registry.example.com/mirror/semgrep:${PIN}`, 'verbs=image inspect | pull '],
  },
  {
    n: 55, name: '--ensure-image scans nothing: with a range or --pull it is exit 3 and docker is not called',
    run: (root) => {
      const h = hub(root); const f = fakeDocker(root);
      const a = ensureCli(h, f, ['--range', 'a..b']);
      const b = ensureCli(h, f, ['--pull']);
      return { status: a.status === 3 && b.status === 3 ? 3 : 1, output: `${a.output}${b.output}docker-calls=${dockerCalls(f).length}\n` };
    },
    exit: 3, includes: ['--ensure-image scans nothing', 'docker-calls=0'],
  },
  {
    n: 56, name: 'a download that fails (no network, a blocked registry) is exit 2 with its own words and the reason pull-failed, so the caller can tell the person what to do',
    run: (root) => {
      const h = hub(root); const f = fakeDocker(root, {}, { image: 'missing', pull: 'fail' });
      const r = ensureCli(h, f);
      return { status: r.status, output: `${r.output}\nverbs=${dockerVerbs(f)}\n` };
    },
    exit: 2, includes: ['no such host', `docker pull semgrep/semgrep:${PIN} failed`, 'REASON: pull-failed', 'verbs=image inspect | pull '],
  },
  {
    n: 57, name: 'a download that is slow is given up on at the preflight\'s limit (five minutes, --timeout to change it): exit 2, told to run the command again, never a long wait',
    run: (root) => {
      const h = hub(root); const f = fakeDocker(root, {}, { image: 'missing', pull: 'hang' });
      const started = Date.now();
      const r = ensureCli(h, f, ['--timeout', '1']);
      return { status: r.status, output: `${r.output}\nwaited-under-6s=${Date.now() - started < 6000}\n` };
    },
    exit: 2, includes: [`docker pull semgrep/semgrep:${PIN} did not finish within 1 s; run the command again to carry on`, 'REASON: pull-failed', 'waited-under-6s=true'],
  },

  /* ------------------------------------------------------------ the stacks a spoke holds (/add-repo) */
  {
    n: 58, name: 'coverage: the test stacks a spoke holds are listed, those the rules cover with their counts and those without rules as not covered; exit 0 and no Docker',
    run: (root) => {
      const h = hub(root, { rules: STACK_RULES });
      const s = spoke(root, { 'src/test/java/FooTest.java': 'class FooTest {}\n', 'src/test/java/BarTest.java': 'class BarTest {}\n', 'pkg/a_test.go': 'package a\n', 'app/src/test/FooTest.kt': 'class FooTest\n', 'app/src/main/Main.kt': 'class Main\n' });
      return coverageCli(h, s);
    },
    exit: 0, includes: ['covered by the rules: Go (1 test file(s)), Java (2 test file(s))', '[NOT COVERED] Kotlin — 1 test file(s), e.g. app/src/test/FooTest.kt: no rules, so nothing in them is checked', 'TEST STACKS: 2 covered, 1 not covered.'],
    excludes: ['Main.kt'],
  },
  {
    n: 59, name: 'coverage: a spoke whose every stack the rules cover has no not-covered line',
    run: (root) => coverageCli(hub(root, { rules: STACK_RULES }), spoke(root, { 'pkg/a_test.go': 'package a\n' })),
    exit: 0, includes: ['covered by the rules: Go (1 test file(s))', 'TEST STACKS: 1 covered, 0 not covered.'], excludes: ['NOT COVERED'],
  },
  {
    n: 60, name: 'coverage: a spoke with no test files says so instead of printing nothing',
    run: (root) => coverageCli(hub(root, { rules: STACK_RULES }), spoke(root, { 'docs/notes.md': '# n\n' }, {})),
    exit: 0, includes: ['TEST STACKS: 0 covered, 0 not covered.'],
  },
  {
    n: 61, name: 'coverage: tests in any language are recognised by the usual conventions (a folder, a suffix), and a source file that is not a test is not listed',
    run: (root) => {
      const h = hub(root, { rules: STACK_RULES });
      const s = spoke(root, { 'spec/billing_spec.rb': 'x\n', 'src/Billing.Tests.cs': 'x\n', 'tests/it.rs': 'x\n', 'Sources/FooTests.swift': 'x\n', 'src/billing.rb': 'x\n', 'src/Billing.cs': 'x\n' });
      return coverageCli(h, s);
    },
    exit: 0, includes: ['[NOT COVERED] C# — 1 test file(s), e.g. src/Billing.Tests.cs', '[NOT COVERED] Ruby — 1 test file(s), e.g. spec/billing_spec.rb', '[NOT COVERED] Rust — 1 test file(s)', '[NOT COVERED] Swift — 1 test file(s)', '0 covered, 4 not covered'],
    excludes: ['src/billing.rb', 'src/Billing.cs'],
  },
  {
    n: 62, name: 'coverage: a language the hub wrote its own rule for is covered, not listed as missing',
    run: (root) => {
      const h = hub(root, { rules: { ...STACK_RULES, 'hub-kotlin.yml': ruleFor('hub-kotlin-x', 'kotlin', '"*Test.kt"') } });
      return coverageCli(h, spoke(root, { 'app/src/test/FooTest.kt': 'class FooTest\n', 'spec/billing_spec.rb': 'x\n' }));
    },
    exit: 0, includes: ['covered by the rules: Kotlin (1 test file(s))', '[NOT COVERED] Ruby', '1 covered, 1 not covered'], excludes: ['NOT COVERED] Kotlin'],
  },
  {
    n: 63, name: 'a hub rule that names a language the library has no rules for (Kotlin) puts that language\'s changed tests in front of Semgrep; without it they are listed not covered and Semgrep is not started',
    run: (root) => {
      const files = { 'app/src/test/FooTest.kt': 'class FooTest\n' };
      const withRule = { ...STACK_RULES, 'hub-kotlin.yml': ruleFor('hub-kotlin-x', 'kotlin', '"*Test.kt"') };
      const fa = fake(root); const a = scanCli(hub(root, { rules: withRule, name: 'hub-a' }), spoke(root, files, { name: 'spoke-a' }), fa);
      const seen = calls(fa).map((c) => Object.keys(c.subject).filter((p) => p !== '.semgrepignore').join(',')).join(';');
      const fb = fake(join(root, "second")); const b = scanCli(hub(root, { rules: STACK_RULES, name: 'hub-b' }), spoke(root, files, { name: 'spoke-b' }), fb);
      return { status: a.status + b.status, output: `WITH: ${a.output}\nsemgrep-saw=${seen}\nWITHOUT: ${b.output}\nsemgrep-calls-without=${calls(fb).length}\n` };
    },
    exit: 0, includes: ['semgrep-saw=app/src/test/FooTest.kt', '1 of 1 changed source file(s)', 'WITHOUT: ', '[NOT COVERED] app/src/test/FooTest.kt', 'semgrep-calls-without=0'],
  },
  {
    n: 64, name: 'coverage: given a range, a pull flag or no repository it says what is wrong (exit 3, exit 2) and reads nothing else',
    run: (root) => {
      const h = hub(root, { rules: STACK_RULES }); const s = spoke(root, TEST_FILE);
      const withRange = coverageCli(h, s, ['--range', `${s.base}..${s.head}`]);
      const notRepo = spawn(process.execPath, [SCAN, '--coverage', '--repo', root, '--hub', h.dir]);
      return { status: withRange.status * 10 + notRepo.status, output: `${withRange.output}\n${notRepo.output}` };
    },
    exit: 32, includes: ['--coverage only reads files', 'is not a git checkout'],
  },

  {
    n: 65, name: 'in GitHub Actions a test file nothing checked is a warning annotation on it, and the exit code is unchanged; anywhere else there is none',
    run: (root) => {
      const files = { ...TEST_FILE, 'spec/billing_spec.rb': 'x\n', 'src/Billing.Tests.cs': 'x\n' };
      const h = hub(root); const s = spoke(root, files); const f = fake(root);
      const ci = scanCli(h, s, f, [], { GITHUB_ACTIONS: 'true' });
      const local = scanCli(h, s, fake(join(root, 'second')), [], { GITHUB_ACTIONS: '' });
      const count = (out) => out.split('\n').filter((l) => l.startsWith('::warning ')).length;
      return { status: ci.status + local.status, output: `CI:\n${ci.output}\nci-warnings=${count(ci.output)}\nlocal-warnings=${count(local.output)}\n` };
    },
    exit: 0, includes: ['::warning file=spec/billing_spec.rb,title=Not checked by the test-quality scan::', '::warning file=src/Billing.Tests.cs,title=', 'ci-warnings=2', 'local-warnings=0'],
  },

  {
    n: 66, name: 'coverage: a not-covered stack says whether the hub carries a suggested ruleset for it, and a suggested ruleset is never run as a rule',
    run: (root) => {
      const h = hub(root, { rules: STACK_RULES });
      write(h.dir, { [`${h.base}/suggested/hub-kotlin.yml`]: ruleFor('hub-kotlin-x', 'kotlin', '"*Test.kt"') });
      commit(h.dir, 'chore: a suggested ruleset');
      const s = spoke(root, { 'app/src/test/FooTest.kt': 'class FooTest\n', 'spec/billing_spec.rb': 'x\n', ...TEST_FILE });
      const f = fake(root);
      const stacks = coverageCli(h, s);
      const scanned = scanCli(h, s, f);
      return { status: stacks.status + scanned.status, output: `${stacks.output}\nrule-files=${JSON.stringify(Object.keys(calls(f)[0].rules).sort())}\n` };
    },
    exit: 0, includes: ['[NOT COVERED] Kotlin — 1 test file(s), e.g. app/src/test/FooTest.kt: no rules, so nothing in them is checked; a suggested ruleset is ready: hub-kotlin.yml', '[NOT COVERED] Ruby — 1 test file(s), e.g. spec/billing_spec.rb: no rules, so nothing in them is checked; no suggested ruleset ships for it', 'rule-files=["go.yml","java.yml"]'],
  },

  /* ------------------------------------------------------------ the hook */
  {
    n: 28, name: 'the hook adds a clean scan to the critic\'s prompt, keeps the rest of the dispatch, and says so to the user',
    run: (root) => { const h = hub(root); const s = spoke(root, TEST_FILE); return hookCli(h, fake(root), dispatch(s)); },
    exit: 0, includes: ['systemMessage=test-quality: TEST QUALITY: 0 violation(s), 0 warning(s).', 'decision=none', 'seat=dual-mode-critic', 'description=review the tests', 'Mode: test-review', 'Review the diff of the two commits.', '## STATIC SCAN — Semgrep CE', 'ONE findings table', 'CHANGES REQUESTED'],
  },
  {
    n: 29, name: 'the hook gives the critic a violation to return with its own findings, and the rule that it blocks approval',
    run: (root) => {
      const h = hub(root); const s = spoke(root, TEST_FILE);
      return hookCli(h, fake(root, reportOf([found('src/a.test.ts', 3, 'shl-js-skipped', 'ERROR', 'skipped')], ['src/a.test.ts'])), dispatch(s));
    },
    exit: 0, includes: ['[VIOLATION] SG-1 shl-js-skipped  src/a.test.ts:3 — skipped', 'TEST QUALITY: 1 violation(s)', 'while one stands your verdict is CHANGES REQUESTED, never APPROVED'],
  },
  {
    n: 30, name: 'Docker missing: a visible warning to the user, the critic told "Semgrep scan not run", the review continues (exit 0, dispatch allowed)',
    run: (root) => {
      const h = hub(root); const s = spoke(root, TEST_FILE);
      const tools = join(root, 'tools'); mkdirSync(tools);
      symlinkSync(execFileSync('which', ['git'], { encoding: 'utf8' }).trim(), join(tools, 'git'));
      return hookCli(h, { env: {} }, dispatch(s), { PATH: tools });
    },
    exit: 0, includes: ['systemMessage=⚠ test-quality: Semgrep scan not run — Docker is not installed', 'https://docs.docker.com/get-docker/', 'decision=none', 'Semgrep scan not run: Docker is not installed', 'Open your reply with the line above, word for word: the orchestrator relays it', 'say so in your reply and review the tests as usual'],
  },
  {
    n: 31, name: 'a scan that cannot run for any other reason (a wrong version) is the same: warn, tell the critic, carry on',
    run: (root) => { const h = hub(root); const s = spoke(root, TEST_FILE); return hookCli(h, fake(root, { version: '0.1.0' }), dispatch(s)); },
    exit: 0, includes: [`systemMessage=⚠ test-quality: Semgrep scan not run — semgrep 0.1.0 ran, the hub pins ${PIN}`, 'decision=none', 'Semgrep scan not run: semgrep 0.1.0 ran'],
  },
  {
    n: 32, name: 'a dispatch without Test-Checkout and Test-Base cannot be scanned: warn and carry on',
    run: (root) => {
      const h = hub(root); const s = spoke(root, TEST_FILE); const e = dispatch(s); e.tool_input.prompt = 'Mode: test-review\n\nReview the tests.\n';
      return hookCli(h, fake(root), e);
    },
    exit: 0, includes: ['systemMessage=⚠ test-quality: Semgrep scan not run — the dispatch carries no Test-Checkout line', 'decision=none', 'Semgrep scan not run: the dispatch carries no Test-Checkout line'],
  },
  {
    n: 33, name: 'a checkout that is not a repository is "not run", not a crash; a relative Test-Checkout is read from the hub',
    run: (root) => {
      const h = hub(root); const f = fake(root);
      const s = spoke(root, TEST_FILE, { at: join(h.dir, '.worktrees', 'SVC-1', 'repo') });
      const rel = dispatch(s); rel.tool_input.prompt = rel.tool_input.prompt.replace(s.work, '.worktrees/SVC-1/repo');
      const ok = hookCli(h, f, rel);
      const e = dispatch(s); e.tool_input.prompt = e.tool_input.prompt.replace(s.work, join(root, 'not-a-repo'));
      mkdirSync(join(root, 'not-a-repo'), { recursive: true });
      const bad = hookCli(h, f, e);
      return { status: ok.status === 0 && bad.status === 0 ? 0 : 1, output: `relative:\n${ok.output}\nnot a repository:\n${bad.output}` };
    },
    exit: 0, includes: ['TEST QUALITY: 0 violation(s), 0 warning(s).', 'Semgrep scan not run: '],
  },
  {
    n: 34, name: 'every launch is a fresh scan: a revision that fixes the violation is scanned again and passes',
    run: (root) => {
      const h = hub(root); const s = spoke(root, TEST_FILE);
      const dirty = hookCli(h, fake(root, reportOf([found('src/a.test.ts', 3, 'shl-js-skipped', 'ERROR')], ['src/a.test.ts'])), dispatch(s));
      write(s.work, { 'src/a.test.ts': "it('fixed', () => { expect(run()).toBe(2); });\n" }); commit(s.work, 'test: the revision');
      const clean = hookCli(h, fake(root, reportOf([], ['src/a.test.ts'])), dispatch(s));
      return { status: 0, output: `first:\n${dirty.output}\nrevision:\n${clean.output}` };
    },
    exit: 0, includes: ['[VIOLATION] SG-1', 'revision:', 'TEST QUALITY: 0 violation(s), 0 warning(s).'],
  },
  {
    n: 35, name: 'a dispatch the hook does not concern is untouched: another tool, another seat, another mode, no prompt',
    run: (root) => {
      const h = hub(root); const s = spoke(root, TEST_FILE); const f = fake(root);
      const other = (patch) => { const e = dispatch(s); Object.assign(e, patch.event || {}); Object.assign(e.tool_input, patch.input || {}); return hookCli(h, f, e).output; };
      const out = [
        other({ event: { tool_name: 'Bash' } }),
        other({ input: { subagent_type: 'engineer' } }),
        other({ input: { prompt: `Mode: code-review\nTest-Checkout: ${s.work}\nTest-Base: ${s.base}\n` } }),
        other({ input: { prompt: undefined } }),
      ];
      return { status: 0, output: `${out.join('')}semgrep-calls=${calls(f).length}\n` };
    },
    exit: 0, includes: ['semgrep-calls=0'], excludes: ['decision=none', 'systemMessage'],
  },
  {
    n: 67, name: 'the Mode line may go on after the mode, as a controller writes it with the cycle and the seat: that launch is scanned. A longer mode name, test-reviewer, is another mode, and its launch is untouched',
    run: (root) => {
      const h = hub(root); const s = spoke(root, TEST_FILE); const f = fake(root);
      const withMode = (line) => { const e = dispatch(s); e.tool_input.prompt = e.tool_input.prompt.replace('Mode: test-review\n', `${line}\n`); return e; };
      const scanned = hookCli(h, f, withMode('Mode: test-review. Cycle: 1 of 3. Seat: dual-mode-critic, fresh context.'));
      const untouched = hookCli(h, f, withMode('Mode: test-reviewer'));
      return { status: scanned.status, output: `${scanned.output}\n----\n${untouched.output}\nsemgrep-calls=${calls(f).length}\n` };
    },
    exit: 0, includes: ['## STATIC SCAN — Semgrep CE', 'Mode: test-review. Cycle: 1 of 3.', 'decision=none', 'semgrep-calls=1'],
  },
  {
    n: 36, name: 'the hook never blocks: unreadable input is exit 0 with a warning to the user and no change to the dispatch',
    run: (root) => { const h = hub(root); return hookCli(h, fake(root), 'this is not json'); },
    exit: 0, includes: ['⚠ test-quality: Semgrep scan not run — the hook failed'], excludes: ['seat=dual-mode-critic'],
  },
  {
    n: 50, name: 'a pull-request comment\'s test-review launch is scanned: Test-Checkout the controller, Test-Base H, and the scan covers T′ alone, not the branch\'s earlier tests',
    run: (root) => {
      const h = hub(root); const f = fake(root);
      // The controller: trunk, then the branch's approved tests and build, whose tip is H.
      const s = spoke(root, TEST_FILE, { at: join(h.dir, '.worktrees', 'SVC-1', 'repo') });
      write(s.work, { 'src/fix.test.ts': "it('keeps the total', () => { expect(total()).toBe(3); });\n" });
      commit(s.work, 'test(SVC-1): cover SHL-R1');
      const e = dispatch(s);
      e.tool_input.description = 'pr-fix SHL-R1 critic';
      e.tool_input.prompt = `Mode: test-review\nTest-Checkout: .worktrees/SVC-1/repo\nTest-Base: ${s.head}\n\nThe comment [SHL-R1], the design whole, the rules, T′'s diff and the logs.\n`;
      const r = hookCli(h, f, e);
      const c = calls(f);
      return { status: r.status, output: `${r.output}\nsemgrep-calls=${c.length}\nsubject=${c.length ? JSON.stringify(Object.keys(c[0].subject).sort()) : 'none'}\n` };
    },
    exit: 0, includes: ['systemMessage=test-quality: TEST QUALITY: 0 violation(s), 0 warning(s).', 'description=pr-fix SHL-R1 critic', '## STATIC SCAN — Semgrep CE', 'semgrep-calls=1', 'subject=[".semgrepignore","src/fix.test.ts"]'], excludes: ['Semgrep scan not run'],
  },
  {
    n: 68, name: '/dev-sprint\'s launch from .worktrees/<KEY>/hub: the absolute Test-Checkout is scanned; a path relative to that folder is read from the hub root and is not run',
    run: (root) => {
      const h = hub(root); const f = fake(root);
      // The session works in the ticket's hub checkout; Claude Code's project folder stays the hub root.
      const cwd = join(h.dir, '.worktrees', 'SVC-1', 'hub');
      mkdirSync(cwd, { recursive: true });
      const s = spoke(root, TEST_FILE, { at: join(h.dir, '.worktrees', 'SVC-1', 'repo') });
      const absolute = dispatch(s); absolute.cwd = cwd;
      const ok = hookCli(h, f, absolute);
      const fromCwd = dispatch(s); fromCwd.cwd = cwd; fromCwd.tool_input.prompt = fromCwd.tool_input.prompt.replace(s.work, '../repo');
      const bad = hookCli(h, f, fromCwd);
      return { status: ok.status === 0 && bad.status === 0 ? 0 : 1, output: `absolute:\n${ok.output}\nrelative to the cwd:\n${bad.output}` };
    },
    exit: 0, includes: ['absolute:\nsystemMessage=test-quality: TEST QUALITY: 0 violation(s), 0 warning(s).', `relative to the cwd:\nsystemMessage=⚠ test-quality: Semgrep scan not run — `, 'is not a git checkout'],
  },
];

/* --------------------------------------------------- the shipped rules, real semgrep */

/** The findings the markers in a fixture file expect: `path:line:rule`, the line being the one after the marker. */
function expectedIn(rel, text) {
  const out = [];
  let pending = [];
  text.split('\n').forEach((line, i) => {
    const m = line.match(/^\s*\*?\s*(\/\/|#)\s*(ruleid|ok):\s*(\S+)/);
    if (m) { if (m[2] === 'ruleid') pending.push(m[3]); return; }
    for (const rule of pending) out.push(`${rel}:${i + 1}:${rule}`);
    pending = [];
  });
  return out;
}
function listFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? listFiles(join(dir, e.name)) : [join(dir, e.name)]));
}
const ruleIds = (dir = join(SHIPPED, 'rules')) => readdirSync(dir).filter((n) => n.search(/\.ya?ml$/) !== -1).flatMap((n) => [...readFileSync(join(dir, n), 'utf8').matchAll(/^ {2}- id: (\S+)$/gm)].map((m) => m[1]));
const SUGGESTED = join(SHIPPED, 'suggested');
const SUGGESTED_TREE = join(HERE, 'fixtures-suggested');

/**
 * Real semgrep, real rules: `ruleFiles` ([{ name, text }]) committed as the hub's rules beside the real pin,
 * the fixtures of `tree` as the spoke's tests, every marker found and every finding marked, and every rule of
 * `ids` carrying a marker.
 */
function proveRules(root, ruleFiles, tree, ids) {
  const h = hub(root, { layout: LIBRARY ? 'library' : 'installed', rules: {} });
  rmSync(join(h.dir, h.base), { recursive: true, force: true });
  mkdirSync(join(h.dir, h.base, 'rules'), { recursive: true });
  writeFileSync(join(h.dir, h.base, 'ruleset.json'), readFileSync(join(SHIPPED, 'ruleset.json')));
  for (const { name, text } of ruleFiles) writeFileSync(join(h.dir, h.base, 'rules', name), text);
  commit(h.dir, 'chore: the rules');
  const files = {};
  const expected = new Set();
  for (const file of listFiles(tree)) {
    // fixtures/<language>/<path in a spoke>: the spoke's own paths, as the rules' globs see them
    const rel = relative(tree, file).split('\\').join('/').split('/').slice(1).join('/');
    const text = readFileSync(file, 'utf8');
    files[rel] = text;
    for (const e of expectedIn(rel, text)) expected.add(e);
  }
  const s = spoke(root, files);
  const r = scan({ repo: s.work, range: `${s.base}..${s.head}`, hub: h.dir, rev: 'HEAD', pull: true });
  if (r.code !== 0 && r.code !== 1) return { status: 2, output: r.report };
  const actual = new Set([...r.violations, ...r.warnings].map((f) => `${f.path}:${f.line}:${f.rule}`));
  const missing = [...expected].filter((e) => !actual.has(e)).sort();
  const extra = [...actual].filter((e) => !expected.has(e)).sort();
  const untested = ids.filter((id) => ![...expected].some((e) => e.endsWith(`:${id}`)));
  const lines = [`expected ${expected.size}, found ${actual.size}`, ...missing.map((m) => `MISSING ${m}`), ...extra.map((x) => `UNEXPECTED ${x}`), ...untested.map((id) => `NO FIXTURE for rule ${id}`)];
  return { status: missing.length || extra.length || untested.length ? 1 : 0, output: `${lines.join('\n')}\n` };
}
const ruleFilesIn = (dir) => readdirSync(dir).filter((n) => n.search(/\.ya?ml$/) !== -1).map((name) => ({ name, text: readFileSync(join(dir, name), 'utf8') }));

const { scan } = await import(pathToFileURL(SCAN).href);
const RULES = [
  {
    n: 101, name: 'every finding of the shipped rules over fixtures/ is marked, and every marker is found: Java, Go, PHP, JS/TS and Python, with real semgrep',
    run: (root) => {
      const shipped = ruleFilesIn(join(SHIPPED, 'rules'));
      // the real rules and pin replace the stand-in's, committed in the throwaway hub; the whole shipped folder goes too
      return proveRules(root, shipped, FIXTURE_TREE, ruleIds());
    },
    exit: 0, includes: ['expected '], excludes: ['MISSING', 'UNEXPECTED', 'NO FIXTURE'],
  },
  {
    n: 103, name: 'the suggested rulesets (Kotlin, C#, Ruby) over their own fixtures, each adopted as a hub would, with real semgrep: every marker found, every finding marked',
    run: (root) => (existsSync(SUGGESTED) ? proveRules(root, ruleFilesIn(SUGGESTED), SUGGESTED_TREE, ruleIds(SUGGESTED)) : { status: 1, output: 'no suggested rulesets are shipped\n' }),
    exit: 0, includes: ['expected '], excludes: ['MISSING', 'UNEXPECTED', 'NO FIXTURE', 'no suggested'],
  },
  {
    n: 102, name: 'an inline `nosem` comment does not hide a finding: the scan runs with --disable-nosem, and the fixture carries one',
    run: () => {
      const text = readFileSync(join(FIXTURE_TREE, 'js', 'test', 'nosem.test.mjs'), 'utf8');
      return { status: text.includes('nosem') ? 0 : 1, output: `fixture carries a nosem comment: ${text.includes('nosem')}\n` };
    },
    exit: 0, includes: ['fixture carries a nosem comment: true'],
  },
];

/* ---------------------------------------------------------------------- runner */

const args = process.argv.slice(2);
const keep = args.includes('--keep');
const rulesMode = args.includes('--rules');
const only = new Set(args.filter((a) => a.search(/^\d+$/) === 0).map(Number));
let failed = 0;
let ran = 0;
let cannot = 0;
for (const f of rulesMode ? RULES : FIXTURES) {
  if (only.size && !only.has(f.n)) continue;
  ran += 1;
  const root = mkdtempSync(join(tmpdir(), `tq-${f.n}-`));
  let r;
  try {
    r = f.run(root);
  } catch (err) {
    r = { status: 'threw', output: String(err && err.stack ? err.stack : err) };
  }
  if (rulesMode && r.status === 2) {
    cannot += 1;
    console.log(`  CANNOT VERIFY  ${f.n}. ${f.name}\n        ${r.output.trim().split('\n').join('\n        ')}`);
  } else {
    const problems = [];
    if (r.status !== f.exit) problems.push(`exit ${r.status}, expected ${f.exit}`);
    for (const s of f.includes || []) if (!r.output.includes(s)) problems.push(`output lacks: ${s}`);
    for (const s of f.excludes || []) if (r.output.includes(s)) problems.push(`output should not contain: ${s}`);
    if (problems.length) {
      failed += 1;
      console.log(`  FAIL  ${f.n}. ${f.name}\n        ${problems.join('\n        ')}\n${r.output.split('\n').map((l) => `        | ${l}`).join('\n')}`);
    } else {
      console.log(`  PASS  ${f.n}. ${f.name} [exit ${f.exit}]`);
    }
  }
  if (!keep) rmSync(root, { recursive: true, force: true });
  else console.log(`        kept: ${root}`);
}
rmSync(SANDBOX_HOME, { recursive: true, force: true });
if (cannot) { console.log(`\n${cannot} fixture(s) could not run: start Docker (it pulls semgrep/semgrep:${SHIPPED_PIN} on first use) — this is not a pass.`); process.exit(2); }
console.log(failed ? `\n${failed} of ${ran} fixtures failed.` : `\nAll ${ran} fixtures passed.`);
process.exit(failed ? 1 : 0);

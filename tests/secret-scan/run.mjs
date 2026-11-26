#!/usr/bin/env node
/**
 * run.mjs — the fixture suite for a spoke's secret scan: secret-scan.cjs as the spoke's
 * pre-commit hook and as the hub's runner, and harness-commit.mjs scanning before it commits.
 *
 *   usage:  node run.mjs            run every fixture
 *           node run.mjs 3 7        run only the numbered fixtures
 *           node run.mjs --keep     leave the throwaway repositories on disk
 *
 * A fixture is a REPOSITORY STATE: a throwaway spoke with a checks.env, a synthetic scanner of
 * its own (scan.mjs, which refuses an added line carrying a made-up FAKE_SECRET_ token) and real
 * commits, and the scripts run as a person, an agent and story-gate run them. The scanner is the
 * spoke's, as in a real spoke; the harness ships none. Exit code and text are asserted.
 *
 * Node standard library only, plus git via child_process. No test framework.
 * Exit 0 if every fixture passes, 1 if any fails.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const LIBRARY_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIBRARY = existsSync(join(LIBRARY_ROOT, 'accelerator', 'gate', 'secret-scan.cjs'));
const SCRIPTS = LIBRARY ? join(LIBRARY_ROOT, 'accelerator', 'gate') : join(resolve(HERE, '..', '..'), 'scripts');
const SCAN = join(SCRIPTS, 'secret-scan.cjs');
const COMMIT = join(SCRIPTS, 'harness-commit.mjs');
if (!existsSync(SCAN) || !existsSync(COMMIT)) {
  console.error(`cannot locate secret-scan.cjs and harness-commit.mjs under ${SCRIPTS}`);
  process.exit(4);
}

const SANDBOX_HOME = mkdtempSync(join(tmpdir(), 'secret-scan-home-'));
const ENV = {
  ...process.env,
  HOME: SANDBOX_HOME,
  XDG_CONFIG_HOME: join(SANDBOX_HOME, '.config'),
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
};
// HARNESS_TRUNK and HARNESS_SPOKE_TRUNK too: a value exported in a developer's shell must not reach a fixture.
for (const k of ['HARNESS_COMMIT', 'HARNESS_TRUNK', 'HARNESS_SPOKE_TRUNK', 'SHL_SECRET_SCANNED', 'SHL_SCAN_MODE', 'SHL_SCAN_RANGE', 'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL']) delete ENV[k];

// A made-up token, assembled here so this file carries no line a scanner would flag.
const SECRET = ['FAKE', 'SECRET', 'A1B2C3D4'].join('_');

// The spoke's own scanner. Refuses an added line that carries a FAKE_SECRET_ token: the staged
// diff in staged mode, every commit's patch in range mode. Logs each run where SCAN_LOG says.
const SCANNER = `import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
const mode = process.env.SHL_SCAN_MODE;
const range = process.env.SHL_SCAN_RANGE || '';
if (process.env.SCAN_LOG) appendFileSync(process.env.SCAN_LOG, mode + '\\n');
console.log('scanner mode=' + mode + ' range=' + range + ' cwd=' + process.cwd());
const diff = mode === 'range'
  ? execFileSync('git', ['log', '-p', '--format=', range], { encoding: 'utf8' })
  : execFileSync('git', ['diff', '--cached', '-U0'], { encoding: 'utf8' });
const hits = diff.split('\\n').filter((l) => l.startsWith('+') && /FAKE_SECRET_[A-Z0-9]{8}/.test(l));
if (hits.length) { console.error('scanner found ' + hits.length + ' secret(s)'); process.exit(1); }
`;
// The other three commit-check rows say none, on purpose: this suite is about the scan, and the helper
// runs all four.
const NONE = 'none — a synthetic spoke with no code to build';
const CHECKS = (scan, trunk = 'default') => `TEST_COMMAND=none\nFORMAT_COMMAND=${NONE}\nLINT_COMMAND=${NONE}\nTYPECHECK_COMMAND=${NONE}\nTRUNK_FOR_HUB=${trunk}\n${scan === undefined ? '' : `SECRET_SCAN_COMMAND=${scan}\n`}`;

function git(cwd, args, opts = {}) {
  return execFileSync('git', args, { cwd, env: ENV, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], ...opts });
}
function spawn(cwd, cmd, args, env = {}) {
  const res = spawnSync(cmd, args, { cwd, env: { ...ENV, ...env }, encoding: 'utf8' });
  return { status: res.status, output: `${res.stdout || ''}${res.stderr || ''}` };
}

/**
 * A spoke with a person's identity, its scanner and commands file, and one clean commit. With
 * `trunk`, a second branch of that name is cut from main and carries `TRUNK_FOR_HUB=<trunkSays>`
 * (the trunk's own name by default) and the scan command. main keeps TRUNK_FOR_HUB=default and
 * `defaultScan`, so a read of the wrong branch shows. The checkout stays on the declared branch.
 */
function spoke(root, opts = {}) {
  const { checks = true, origin = false, trunk = null, trunkSays = trunk } = opts;
  const scan = 'scan' in opts ? opts.scan : 'node scan.mjs';
  const work = join(root, 'spoke');
  git(root, ['init', '-q', '--initial-branch', 'main', work]);
  git(work, ['config', 'user.name', 'A Person']);
  git(work, ['config', 'user.email', 'person@example.invalid']);
  git(work, ['config', 'commit.gpgsign', 'false']);
  writeFileSync(join(work, 'README.md'), '# spoke\n');
  writeFileSync(join(work, 'scan.mjs'), SCANNER);
  if (checks) writeFileSync(join(work, 'checks.env'), CHECKS(trunk && 'defaultScan' in opts ? opts.defaultScan : scan));
  git(work, ['add', '-A']);
  git(work, ['commit', '-q', '-m', 'chore: the trunk']);
  if (trunk) {
    git(work, ['checkout', '-q', '-b', trunk]);
    writeFileSync(join(work, 'checks.env'), CHECKS(scan, trunkSays));
    git(work, ['add', '-A']);
    git(work, ['commit', '-q', '-m', 'chore: the harness trunk']);
  }
  // A real bare origin, so the trunk can be asked: where the helper and the hook read the command from.
  if (origin) {
    git(root, ['init', '-q', '--bare', '--initial-branch', 'main', join(root, 'origin.git')]);
    git(work, ['remote', 'add', 'origin', join(root, 'origin.git')]);
    git(work, ['push', '-q', 'origin', 'main']);
    if (trunk) git(work, ['push', '-q', 'origin', trunk]);
  }
  return { work, base: git(work, ['rev-parse', 'HEAD']).trim() };
}
const stage = (work, text, name = 'config.txt') => { writeFileSync(join(work, name), text); git(work, ['add', '-A']); };
const commitByHand = (work, text, message) => { stage(work, text); git(work, ['commit', '-q', '--no-verify', '-m', message]); };
const head = (work) => git(work, ['rev-parse', 'HEAD']).trim();
const scan = (work, args = [], env = {}) => spawn(work, process.execPath, [SCAN, '--repo', work, ...args], env);
const helper = (work, env = {}) => spawn(work, process.execPath, [COMMIT, '-m', 'chore(harness): a change'], env);
/** The hook as a spoke carries it: the same file, at .githooks/pre-commit, committed executable. */
function carryHook(work) {
  mkdirSync(join(work, '.githooks'), { recursive: true });
  copyFileSync(SCAN, join(work, '.githooks', 'pre-commit'));
  chmodSync(join(work, '.githooks', 'pre-commit'), 0o755);
  return join(work, '.githooks', 'pre-commit');
}
const logged = (file) => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : []);
/** Append facts to a result so `includes` can assert them. */
const withFacts = (r, facts) => ({ status: r.status, output: `${r.output}\n${Object.entries(facts).map(([k, v]) => `${k}=${v}`).join('\n')}` });

// Each unset state and its exit code: cannot verify (2), as check-staged.mjs has it, except `none`,
// which is a choice a spoke does not have (1).
const UNSET = [
  [undefined, 'missing', 2],
  ['', 'empty', 2],
  ['UNRESOLVED', 'UNRESOLVED', 2],
  ['none', 'none', 1],
];

/* ------------------------------------------------------------------- fixtures */

const FIXTURES = [
  {
    n: 1, name: 'a clean staged change passes, the spoke\'s scanner run in staged mode from the repository root',
    run: (root) => { const s = spoke(root); stage(s.work, 'port=8080\n'); return scan(s.work); },
    exit: 0, includes: ['SECRET SCAN — node scan.mjs over the staged changes', 'scanner mode=staged range= ', 'SECRET SCAN CLEAN — the staged changes'],
  },
  {
    n: 2, name: 'a staged secret is refused, before the commit exists',
    run: (root) => { const s = spoke(root); stage(s.work, `token=${SECRET}\n`); return scan(s.work); },
    exit: 1, includes: ['scanner found 1 secret(s)', 'SECRET SCAN REFUSED — SECRET_SCAN_COMMAND refused the staged changes (exit 1)', 'rotate any secret it found'],
  },
  {
    n: 3, name: 'a clean range passes, the range handed to the scanner',
    run: (root) => { const s = spoke(root); commitByHand(s.work, 'port=8080\n', 'feat: a'); return scan(s.work, ['--range', `${s.base}..HEAD`]); },
    exit: 0, includes: ['scanner mode=range range=', '..HEAD', 'SECRET SCAN CLEAN — every commit in'],
  },
  {
    n: 4, name: 'a secret added and deleted inside the range is still refused: it is in the history',
    run: (root) => {
      const s = spoke(root);
      commitByHand(s.work, `token=${SECRET}\n`, 'feat: add a value');
      commitByHand(s.work, 'token=from-the-environment\n', 'fix: take it back out');
      const inTree = spawnSync('git', ['grep', '-q', 'FAKE_SECRET', 'HEAD', '--', 'config.txt'], { cwd: s.work, env: ENV }).status === 0;
      return withFacts(scan(s.work, ['--range', `${s.base}..HEAD`]), { 'in-final-tree': inTree });
    },
    exit: 1, includes: ['scanner found 1 secret(s)', 'SECRET_SCAN_COMMAND refused every commit in', 'in-final-tree=false'],
  },
  ...UNSET.map(([value, said, code], i) => ({
    n: 5 + i, name: `SECRET_SCAN_COMMAND ${said} is refused (exit ${code}): every spoke names its own scan`,
    run: (root) => { const s = spoke(root, { scan: value }); stage(s.work, 'port=8080\n'); return scan(s.work); },
    exit: code, includes: [`SECRET SCAN ${code === 2 ? 'CANNOT VERIFY' : 'REFUSED'} — SECRET_SCAN_COMMAND is ${said} in checks.env`, 'runs on Windows, Linux and Mac'], excludes: ['scanner mode='],
  })),
  {
    n: 9, name: '--if-declared lets an unset key through with a warning, and runs nothing',
    run: (root) => { const s = spoke(root, { scan: 'UNRESOLVED' }); stage(s.work, `token=${SECRET}\n`); return scan(s.work, ['--if-declared']); },
    exit: 0, includes: ['SECRET SCAN SKIPPED — SECRET_SCAN_COMMAND is UNRESOLVED', 'story-gate refuses the pull request until the key is a command'], excludes: ['scanner mode='],
  },
  {
    n: 10, name: 'no checks.env cannot verify: exit 2',
    run: (root) => { const s = spoke(root, { checks: false }); stage(s.work, 'port=8080\n'); return scan(s.work); },
    exit: 2, includes: ['SECRET SCAN CANNOT VERIFY — no checks.env at', 'REASON: config-invalid'],
  },
  {
    n: 11, name: 'a command the shell cannot find cannot verify (exit 2), never a pass',
    run: (root) => { const s = spoke(root, { scan: 'no-such-secret-scanner-on-this-machine' }); stage(s.work, 'port=8080\n'); return scan(s.work); },
    exit: 2, includes: ['SECRET SCAN CANNOT VERIFY — SECRET_SCAN_COMMAND could not run (exit 127)', 'is not installed on this machine'], excludes: ['SECRET SCAN CLEAN'],
  },
  {
    n: 12, name: 'run from a subfolder, the scanner still runs at the repository root',
    run: (root) => {
      const s = spoke(root);
      mkdirSync(join(s.work, 'src'));
      stage(s.work, 'port=8080\n', 'src/config.txt');
      return withFacts(scan(join(s.work, 'src')), { root: realpathSync(s.work) });
    },
    exit: 0, includes: ['cwd=', 'SECRET SCAN CLEAN'],
    check: (output) => (output.includes(`cwd=${output.match(/^root=(.*)$/m)[1]}\n`) ? null : 'the scanner did not run at the repository root'),
  },
  {
    n: 13, name: 'usage: a range that is not <base>..<head>, and an unknown argument',
    run: (root) => {
      const s = spoke(root);
      const a = scan(s.work, ['--range', 'main']);
      const b = scan(s.work, ['--everything']);
      return { status: a.status === 3 && b.status === 3 ? 3 : 0, output: `${a.output}${b.output}` };
    },
    exit: 3, includes: ['USAGE — --range takes <base>..<head>, not "main"', 'USAGE — unknown argument: --everything'],
  },
  {
    n: 14, name: '--install points this clone\'s hooks at .githooks',
    run: (root) => {
      const s = spoke(root);
      const hook = carryHook(s.work);
      const r = spawn(s.work, process.execPath, [hook, '--install']);
      return withFacts(r, { hooksPath: git(s.work, ['config', '--get', 'core.hooksPath']).trim() });
    },
    exit: 0, includes: ['SECRET SCAN HOOK INSTALLED — core.hooksPath is .githooks', 'hooksPath=.githooks'],
  },
  {
    n: 15, name: '--install refuses to switch off a hooks path already in force, and changes nothing',
    run: (root) => {
      const s = spoke(root);
      const hook = carryHook(s.work);
      git(s.work, ['config', 'core.hooksPath', '.husky']);
      const r = spawn(s.work, process.execPath, [hook, '--install']);
      return withFacts(r, { hooksPath: git(s.work, ['config', '--get', 'core.hooksPath']).trim() });
    },
    exit: 1, includes: ['core.hooksPath is already .husky. Not changed', 'node .githooks/pre-commit', 'hooksPath=.husky'],
  },
  {
    n: 16, name: '--install refuses to switch off hooks of the clone\'s own in .git/hooks',
    run: (root) => {
      const s = spoke(root);
      const hook = carryHook(s.work);
      writeFileSync(join(s.work, '.git', 'hooks', 'pre-push'), '#!/bin/sh\nexit 0\n');
      chmodSync(join(s.work, '.git', 'hooks', 'pre-push'), 0o755);
      const r = spawn(s.work, process.execPath, [hook, '--install']);
      const set = spawnSync('git', ['config', '--get', 'core.hooksPath'], { cwd: s.work, env: ENV }).status;
      return withFacts(r, { hooksPathSet: set === 0 });
    },
    exit: 1, includes: ['holds hooks of its own (pre-push)', 'hooksPathSet=false'],
  },
  {
    n: 17, name: '--install is refused from anywhere but the spoke\'s hook',
    run: (root) => { const s = spoke(root); return spawn(s.work, process.execPath, [SCAN, '--repo', s.work, '--install']); },
    exit: 3, includes: ['--install is run as the hook inside the spoke'],
  },
  {
    n: 18, name: 'the installed hook refuses a person\'s commit carrying a secret, and passes a clean one',
    run: (root) => {
      const s = spoke(root);
      const hook = carryHook(s.work);
      execFileSync(process.execPath, [hook, '--install'], { cwd: s.work, env: ENV });
      stage(s.work, `token=${SECRET}\n`);
      const refused = spawn(s.work, 'git', ['commit', '-q', '-m', 'feat: a value']);
      const afterRefusal = head(s.work);
      stage(s.work, 'token=from-the-environment\n');
      const clean = spawn(s.work, 'git', ['commit', '-q', '-m', 'feat: a value']);
      return {
        status: refused.status !== 0 && clean.status === 0 ? 0 : 1,
        output: `${refused.output}${clean.output}\nrefused-left-head=${afterRefusal === s.base}\nclean-committed=${head(s.work) !== s.base}`,
      };
    },
    exit: 0, includes: ['SECRET SCAN REFUSED', 'refused-left-head=true', 'clean-committed=true'],
  },
  {
    n: 19, name: 'harness-commit.mjs refuses a spoke commit carrying a secret: nothing committed',
    run: (root) => { const s = spoke(root, { origin: true }); stage(s.work, `token=${SECRET}\n`); return withFacts(helper(s.work), { unchanged: head(s.work) === s.base }); },
    exit: 1, includes: ['HARNESS COMMIT REFUSED — the commit checks did not pass — nothing committed', '[FAIL] SECRET_SCAN_COMMAND', 'scanner found 1 secret(s)', 'unchanged=true'],
  },
  {
    n: 20, name: 'harness-commit.mjs commits a clean spoke change, scanned once with the hook installed too',
    run: (root) => {
      const s = spoke(root, { origin: true });
      const hook = carryHook(s.work);
      execFileSync(process.execPath, [hook, '--install'], { cwd: s.work, env: ENV });
      stage(s.work, 'port=8080\n');
      const log = join(root, 'scan.log');
      return withFacts(helper(s.work, { SCAN_LOG: log }), { scans: logged(log).length, committed: head(s.work) !== s.base });
    },
    exit: 0, includes: ['HARNESS COMMIT', '[PASS] SECRET_SCAN_COMMAND', 'COMMIT CHECKS PASSED.', 'scans=1', 'committed=true'],
  },
  {
    n: 21, name: 'harness-commit.mjs refuses a spoke commit where the key is UNRESOLVED on the trunk: exit 2, cannot verify',
    run: (root) => { const s = spoke(root, { scan: 'UNRESOLVED', origin: true }); stage(s.work, 'port=8080\n'); return withFacts(helper(s.work), { unchanged: head(s.work) === s.base }); },
    exit: 2, includes: ['SECRET_SCAN_COMMAND is UNRESOLVED in checks.env', 'nothing committed', 'unchanged=true'],
  },
  {
    n: 22, name: 'a SHL_SECRET_SCANNED a person exported does not skip the helper\'s own scan',
    run: (root) => { const s = spoke(root, { origin: true }); stage(s.work, `token=${SECRET}\n`); return withFacts(helper(s.work, { SHL_SECRET_SCANNED: '1' }), { unchanged: head(s.work) === s.base }); },
    exit: 1, includes: ['scanner found 1 secret(s)', 'unchanged=true'],
  },
  {
    n: 23, name: 'a hub, with no checks.env at its root, is committed without a scan',
    run: (root) => {
      const s = spoke(root, { checks: false });
      stage(s.work, 'docs\n', 'notes.md');
      const log = join(root, 'scan.log');
      return withFacts(helper(s.work, { SCAN_LOG: log }), { scans: logged(log).length, committed: head(s.work) !== s.base });
    },
    exit: 0, includes: ['HARNESS COMMIT', 'scans=0', 'committed=true'], excludes: ['SECRET SCAN'],
  },
  {
    n: 24, name: '--history scans every commit from the first, the first included',
    run: (root) => {
      const work = join(root, 'spoke');
      git(root, ['init', '-q', '--initial-branch', 'main', work]);
      for (const [k, v] of [['user.name', 'A Person'], ['user.email', 'person@example.invalid'], ['commit.gpgsign', 'false']]) git(work, ['config', k, v]);
      writeFileSync(join(work, 'scan.mjs'), SCANNER);
      writeFileSync(join(work, 'checks.env'), CHECKS('node scan.mjs'));
      writeFileSync(join(work, 'config.txt'), `token=${SECRET}\n`);
      git(work, ['add', '-A']);
      git(work, ['commit', '-q', '-m', 'chore: the first commit, carrying a secret']);
      commitByHand(work, 'token=from-the-environment\n', 'fix: take it back out');
      return scan(work, ['--history']);
    },
    exit: 1, includes: ['scanner mode=range range=HEAD ', 'scanner found 1 secret(s)', 'SECRET_SCAN_COMMAND refused every commit in the history'],
  },
  {
    n: 25, name: '--staged reads the command from the trunk: a branch that stages checks.env with the scan set to true is still scanned by the trunk\'s scanner',
    run: (root) => {
      const s = spoke(root, { origin: true });
      git(s.work, ['switch', '-q', '-c', 'feature/SVC-1-change']);
      writeFileSync(join(s.work, 'checks.env'), CHECKS('true'));
      stage(s.work, `token=${SECRET}\n`);
      return scan(s.work);
    },
    exit: 1, includes: ['read from checks.env at origin/main', 'scanner found 1 secret(s)'],
  },
  {
    n: 26, name: '--range reads the command from the base: a pull request that rewrites its own scan to true is still scanned by the base\'s scanner',
    run: (root) => {
      const s = spoke(root);
      writeFileSync(join(s.work, 'checks.env'), CHECKS('true'));
      commitByHand(s.work, `token=${SECRET}\n`, 'feat: a secret, and a scan that finds nothing');
      return scan(s.work, ['--range', `${s.base}..HEAD`]);
    },
    exit: 1, includes: ['read from checks.env at the base of the range', 'scanner found 1 secret(s)'],
  },
  {
    n: 27, name: 'the install\'s own pull request: a base with no checks.env is the bootstrap, and the command is read from the pull request itself, named as such',
    run: (root) => {
      const s = spoke(root, { checks: false });
      writeFileSync(join(s.work, 'checks.env'), CHECKS('node scan.mjs'));
      commitByHand(s.work, `token=${SECRET}\n`, 'chore(harness): install the spoke');
      const refused = scan(s.work, ['--range', `${s.base}..HEAD`]);
      commitByHand(s.work, 'token=from-the-environment\n', 'fix: take it back out');
      return withFacts(refused, { history: scan(s.work, ['--history']).status });
    },
    exit: 1, includes: ['has none: the spoke install\'s own pull request', 'scanner found 1 secret(s)', 'history=1'],
  },
  {
    n: 28, name: 'the trunk cannot be found: an unreachable origin and a HARNESS_SPOKE_TRUNK that names no branch on origin are exit 2, and nothing is scanned',
    run: (root) => {
      const s = spoke(root, { origin: true });
      stage(s.work, 'port=8080\n');
      const missing = scan(s.work, [], { HARNESS_SPOKE_TRUNK: 'release' });
      git(s.work, ['remote', 'set-url', 'origin', join(root, 'gone.git')]);
      const gone = scan(s.work);
      return { status: missing.status === 2 && gone.status === 2 ? 2 : 0, output: `${missing.output}${gone.output}` };
    },
    exit: 2, includes: ['the trunk is release, and origin has no branch release', 'could not reach origin'], excludes: ['scanner mode='],
  },
  {
    n: 29, name: 'a checkout with no origin cannot push: the scan reads its own checks.env, and says why',
    run: (root) => { const s = spoke(root); stage(s.work, `token=${SECRET}\n`); return scan(s.work); },
    exit: 1, includes: ['no origin remote: this checkout cannot push', 'scanner found 1 secret(s)'],
  },
  {
    n: 30, name: 'a declared trunk named in HARNESS_SPOKE_TRUNK: the command is read from that branch, not from the default branch',
    // main's scan is `true`, which passes anything: a read of main would let the secret through.
    run: (root) => { const s = spoke(root, { origin: true, trunk: 'harness-main', defaultScan: 'true' }); stage(s.work, `token=${SECRET}\n`); return scan(s.work, [], { HARNESS_SPOKE_TRUNK: 'harness-main' }); },
    exit: 1, includes: ['read from checks.env at origin/harness-main', 'scanner found 1 secret(s)'], excludes: ['origin/main'],
  },
  {
    n: 31, name: 'a declared trunk whose tip names another trunk in TRUNK_FOR_HUB: exit 2, both values named, nothing scanned',
    run: (root) => { const s = spoke(root, { origin: true, trunk: 'harness-main', trunkSays: 'harness-next' }); stage(s.work, 'port=8080\n'); return scan(s.work, [], { HARNESS_SPOKE_TRUNK: 'harness-main' }); },
    exit: 2, includes: ['the trunk is harness-main (from HARNESS_SPOKE_TRUNK)', 'has TRUNK_FOR_HUB=harness-next. The two must name the same branch'], excludes: ['scanner mode='],
  },
  {
    n: 32, name: 'E1 mismatch: TRUNK_FOR_HUB at HEAD names a trunk whose tip names another: exit 2, nothing scanned',
    run: (root) => {
      const s = spoke(root, { origin: true, trunk: 'harness-main', trunkSays: 'harness-next' });
      // A local commit, never pushed, that names harness-main at HEAD.
      writeFileSync(join(s.work, 'checks.env'), CHECKS('node scan.mjs', 'harness-main'));
      git(s.work, ['commit', '-q', '--no-verify', '-am', 'chore: name the trunk']);
      stage(s.work, 'port=8080\n');
      return scan(s.work);
    },
    exit: 2, includes: ['the trunk is harness-main (from TRUNK_FOR_HUB in checks.env at HEAD', 'has TRUNK_FOR_HUB=harness-next'], excludes: ['scanner mode='],
  },
  {
    n: 33, name: 'E1: with HARNESS_SPOKE_TRUNK not set, TRUNK_FOR_HUB at HEAD names the trunk, and the command is read from it',
    run: (root) => { const s = spoke(root, { origin: true, trunk: 'harness-main', defaultScan: 'true' }); stage(s.work, `token=${SECRET}\n`); return scan(s.work); },
    exit: 1, includes: ['read from checks.env at origin/harness-main', 'scanner found 1 secret(s)'],
  },
  {
    n: 34, name: 'HARNESS_SPOKE_TRUNK=main where TRUNK_FOR_HUB=default and main is the default branch: the two name one branch, and the scan passes',
    run: (root) => { const s = spoke(root, { origin: true }); stage(s.work, 'port=8080\n'); return scan(s.work, [], { HARNESS_SPOKE_TRUNK: 'main' }); },
    exit: 0, includes: ['read from checks.env at origin/main', 'SECRET SCAN CLEAN — the staged changes'],
  },
];

/* ---------------------------------------------------------------------- runner */

function runFixture(fixture) {
  const root = mkdtempSync(join(tmpdir(), `secret-scan-fx${String(fixture.n).padStart(2, '0')}-`));
  try {
    const { status, output } = fixture.run(root);
    const problems = [];
    if (status !== fixture.exit) problems.push(`expected exit ${fixture.exit}, got ${status}`);
    for (const needle of fixture.includes || []) if (!output.includes(needle)) problems.push(`output does not contain: ${needle}`);
    for (const needle of fixture.excludes || []) if (output.includes(needle)) problems.push(`output should not contain: ${needle}`);
    if (fixture.check) { const p = fixture.check(output); if (p) problems.push(p); }
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
    ? `\n${failed} of ${selected.length} fixtures FAILED. The secret scan is not trustworthy until this is green.\n`
    : `\nAll ${selected.length} fixtures passed.\n`);
  rmSync(SANDBOX_HOME, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
}

main();

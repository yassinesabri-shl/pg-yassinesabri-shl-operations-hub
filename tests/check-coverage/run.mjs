#!/usr/bin/env node
/**
 * run.mjs — the fixture suite for check-coverage.mjs: the two coverage floors of decision 2a,
 * judged on one commit against the checks.env on the spoke's trunk.
 *
 *   usage:  node run.mjs            run every fixture
 *           node run.mjs 3 7        run only the numbered fixtures
 *           node run.mjs --keep     leave the throwaway repositories on disk
 *
 * A fixture is a REPOSITORY STATE: a throwaway spoke with a real bare `origin`, a trunk carrying
 * checks.env, and a branch with a change on it. The check is run as the story-gate step runs it,
 * and its exit code and text are asserted. The coverage command in each fixture is a one-line
 * stand-in that prints what a real tool would; the harness ships no coverage tool. Fixture 1 is
 * the valid control. Fixtures marked library-only read files an installed hub does not carry and
 * are reported as skipped there.
 *
 * Node standard library only, plus git via child_process. No test framework.
 * Exit 0 if every fixture that runs passes, 1 if any fails.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const LIBRARY_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIBRARY = existsSync(join(LIBRARY_ROOT, 'accelerator', 'gate', 'check-coverage.mjs'));
const ROOT = LIBRARY ? LIBRARY_ROOT : resolve(HERE, '..', '..');
const SCRIPTS = LIBRARY ? join(ROOT, 'accelerator', 'gate') : join(ROOT, 'scripts');
const CHECK = join(SCRIPTS, 'check-coverage.mjs');
if (!existsSync(CHECK)) {
  console.error(`cannot locate check-coverage.mjs under ${SCRIPTS}`);
  process.exit(4);
}

const SANDBOX_HOME = mkdtempSync(join(tmpdir(), 'coverage-home-'));
const ENV = {
  ...process.env,
  HOME: SANDBOX_HOME,
  XDG_CONFIG_HOME: join(SANDBOX_HOME, '.config'),
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
  GIT_AUTHOR_NAME: 'A Person', GIT_AUTHOR_EMAIL: 'person@example.invalid',
  GIT_COMMITTER_NAME: 'A Person', GIT_COMMITTER_EMAIL: 'person@example.invalid',
};
for (const k of ['HARNESS_TRUNK', 'HARNESS_SPOKE_TRUNK', 'HARNESS_COVERAGE_BASE', 'HARNESS_COVERAGE_HEAD']) delete ENV[k];

function git(cwd, args, opts = {}) {
  return execFileSync('git', args, { cwd, env: ENV, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], ...opts }).trim();
}
function spawn(cwd, cmd, args, env = {}) {
  const res = spawnSync(cmd, args, { cwd, env: { ...ENV, ...env }, encoding: 'utf8' });
  return { status: res.status, output: `${res.stdout || ''}${res.stderr || ''}` };
}

/** checks.env text: the three coverage keys over a quiet default; `undefined` leaves a key out. */
function CHECKS(over = {}) {
  const values = {
    TEST_COMMAND: 'true',
    COVERAGE_COMMAND: "printf 'project=72.5\\nchanged=96\\n'",
    PROJECT_COVERAGE_FLOOR: '70',
    CHANGED_LINE_FLOOR: '95',
    TRUNK_FOR_HUB: 'default',
    ...over,
  };
  return `# checks.env — a fixture spoke\n${Object.entries(values).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${v}`).join('\n')}\n`;
}

/**
 * A spoke: a bare origin whose trunk carries `trunkChecks` (null: no checks.env), and a work clone
 * on a branch with one change. Returns the clone, the trunk commit the branch was cut from, HEAD.
 * `harness` ({ name, checks }) adds a declared harness trunk, cut from the default branch's tip
 * with its own checks.env, and cuts the change branch from it.
 */
function spoke(root, { checks = CHECKS(), trunk = 'main', branchChecks = null, harness = null } = {}) {
  const bare = join(root, 'origin.git');
  const work = join(root, 'work');
  git(root, ['init', '-q', '--bare', '--initial-branch', trunk, bare]);
  git(root, ['clone', '-q', bare, work]);
  git(work, ['config', 'commit.gpgsign', 'false']);
  git(work, ['checkout', '-q', '-b', trunk]);
  mkdirSync(join(work, 'src'), { recursive: true });
  writeFileSync(join(work, 'src', 'app.js'), 'export const one = 1;\n');
  if (checks !== null) writeFileSync(join(work, 'checks.env'), checks);
  git(work, ['add', '-A']);
  git(work, ['commit', '-q', '-m', 'chore: the trunk']);
  git(work, ['push', '-q', 'origin', trunk]);
  if (harness) {
    git(work, ['checkout', '-q', '-b', harness.name]);
    writeFileSync(join(work, 'checks.env'), harness.checks);
    writeFileSync(join(work, 'HARNESS.md'), `# ${harness.name}\n`);
    git(work, ['add', '-A']);
    git(work, ['commit', '-q', '-m', 'chore: the harness trunk']);
    git(work, ['push', '-q', 'origin', harness.name]);
  }
  const base = git(work, ['rev-parse', 'HEAD']);
  git(work, ['checkout', '-q', '-b', 'feature/SVC-1-change']);
  writeFileSync(join(work, 'src', 'app.js'), 'export const one = 1;\nexport const two = 2;\n');
  if (branchChecks !== null) writeFileSync(join(work, 'checks.env'), branchChecks);
  git(work, ['add', '-A']);
  git(work, ['commit', '-q', '-m', 'feat(SVC-1): a change']);
  return { root, bare, work, trunk, base, head: git(work, ['rev-parse', 'HEAD']) };
}

/** The check as story-gate runs it: from the trunk, against the pull request's base. */
const judge = (s, { env = {}, base = s.base, extra = ['--checks-from-trunk'], cwd = s.work } = {}) =>
  spawn(cwd, process.execPath, [CHECK, '--repo', s.work, '--base', base, ...extra], env);
const trunkBlob = (s) => git(s.work, ['rev-parse', `${s.trunk}:checks.env`]).slice(0, 12);

const read = (rel) => (existsSync(join(ROOT, rel)) ? readFileSync(join(ROOT, rel), 'utf8') : null);

/* ------------------------------------------------------------------- fixtures */

const FIXTURES = [
  {
    n: 1, name: 'control: both figures clear both floors, and the result records the bar it was judged against',
    run: (root) => { const s = spoke(root); const r = judge(s); return { ...r, output: `${r.output}\nblob ${trunkBlob(s)}` }; },
    exit: 0,
    includes: ['COVERAGE OK — project 72.5% (floor 70) · changed 96% (floor 95) · floors from checks.env@', 'COVERAGE project 72.5% (floor 70)'],
    check: (out) => { const blob = out.match(/blob ([0-9a-f]{12})$/m)[1]; return out.includes(`checks.env@${blob}`) ? null : `the record does not carry the trunk blob ${blob}`; },
  },
  {
    n: 2, name: 'project coverage below its floor fails, naming the figure and the floor',
    run: (root) => judge(spoke(root, { checks: CHECKS({ COVERAGE_COMMAND: "printf 'project=61.4\\nchanged=96\\n'" }) })),
    exit: 1, includes: ['FAIL project coverage 61.4 is below PROJECT_COVERAGE_FLOOR 70', 'COVERAGE FAILED — 1 finding(s)'],
  },
  {
    n: 3, name: 'changed-line coverage below its floor fails, naming the figure and the floor',
    run: (root) => judge(spoke(root, { checks: CHECKS({ COVERAGE_COMMAND: "printf 'project=72.5\\nchanged=80\\n'" }) })),
    exit: 1, includes: ['FAIL changed-line coverage 80 is below CHANGED_LINE_FLOOR 95', 'changed 80% (floor 95)'],
  },
  {
    n: 4, name: 'both below: both findings are listed before it exits',
    run: (root) => judge(spoke(root, { checks: CHECKS({ COVERAGE_COMMAND: "printf 'project=50\\nchanged=10\\n'" }) })),
    exit: 1, includes: ['FAIL project coverage 50 is below PROJECT_COVERAGE_FLOOR 70', 'FAIL changed-line coverage 10 is below CHANGED_LINE_FLOOR 95', '2 finding(s)'],
  },
  {
    n: 5, name: 'a bare number is read as the project figure, and with no changed= line the changed-line floor cannot be verified',
    run: (root) => judge(spoke(root, { checks: CHECKS({ COVERAGE_COMMAND: 'echo 72.5' }) })),
    exit: 2, includes: ['project 72.5% (floor 70)', 'printed no changed= line', 'CANNOT VERIFY — 1 problem(s)', 'REASON: coverage-unreadable'],
  },
  {
    n: 6, name: 'project= alone is the same: the changed-line floor is never passed by silence',
    run: (root) => judge(spoke(root, { checks: CHECKS({ COVERAGE_COMMAND: "printf 'project=90\\n'" }) })),
    exit: 2, includes: ['printed no changed= line', 'REASON: coverage-unreadable'], excludes: ['COVERAGE OK'],
  },
  {
    n: 7, name: 'changed=n/a: no measurable line changed, which passes and says so',
    run: (root) => judge(spoke(root, { checks: CHECKS({ COVERAGE_COMMAND: "printf 'project=72.5\\nchanged=n/a\\n'" }) })),
    exit: 0, includes: ['changed n/a (floor 95; no measurable line changed)', 'note: no measurable line changed', 'COVERAGE OK'],
  },
  {
    n: 8, name: 'COVERAGE_COMMAND UNRESOLVED on the trunk: cannot verify, and the required check is red',
    run: (root) => judge(spoke(root, { checks: CHECKS({ COVERAGE_COMMAND: 'UNRESOLVED', PROJECT_COVERAGE_FLOOR: 'UNRESOLVED', CHANGED_LINE_FLOOR: 'UNRESOLVED' }) })),
    exit: 2, includes: ['CANNOT VERIFY: COVERAGE_COMMAND is missing, empty or UNRESOLVED', 'project not measured (floor not configured)'], excludes: ['COVERAGE OK', 'COVERAGE NONE', 'not printed'],
  },
  {
    n: 9, name: 'COVERAGE_COMMAND missing is the same as UNRESOLVED',
    run: (root) => judge(spoke(root, { checks: CHECKS({ COVERAGE_COMMAND: undefined }) })),
    exit: 2, includes: ['COVERAGE_COMMAND is missing, empty or UNRESOLVED'],
  },
  {
    n: 10, name: 'COVERAGE_COMMAND=none: no coverage step, said on purpose, and reported as such',
    run: (root) => judge(spoke(root, { checks: CHECKS({ COVERAGE_COMMAND: 'none', PROJECT_COVERAGE_FLOOR: 'none', CHANGED_LINE_FLOOR: 'UNRESOLVED' }) })),
    exit: 0, includes: ['COVERAGE NONE — this repository declares no coverage step', 'floors from checks.env@'], excludes: ['COVERAGE OK'],
  },
  {
    n: 11, name: 'a numeric floor beside COVERAGE_COMMAND=none contradicts itself',
    run: (root) => judge(spoke(root, { checks: CHECKS({ COVERAGE_COMMAND: 'none' }) })),
    exit: 2, includes: ['PROJECT_COVERAGE_FLOOR is 70 beside COVERAGE_COMMAND=none', 'CHANGED_LINE_FLOOR is 95 beside COVERAGE_COMMAND=none'],
  },
  {
    n: 12, name: 'a floor UNRESOLVED beside a command cannot be judged, and the reason after UNRESOLVED does not change that',
    run: (root) => judge(spoke(root, { checks: CHECKS({ CHANGED_LINE_FLOOR: 'UNRESOLVED — the owner has not decided' }) })),
    exit: 2, includes: ['CHANGED_LINE_FLOOR is missing, empty or UNRESOLVED beside a coverage command'], excludes: ['COVERAGE OK'],
  },
  {
    n: 13, name: "the branch lowers its floor and swaps its command: the trunk's bar is the one that judges",
    run: (root) => {
      const s = spoke(root, {
        checks: CHECKS({ COVERAGE_COMMAND: "printf 'project=72.5\\nchanged=90\\n'" }),
        branchChecks: CHECKS({ COVERAGE_COMMAND: "printf 'project=99\\nchanged=99\\n'", CHANGED_LINE_FLOOR: '50' }),
      });
      const r = judge(s);
      return { ...r, output: `${r.output}\nblob ${trunkBlob(s)}` };
    },
    exit: 1, includes: ['FAIL changed-line coverage 90 is below CHANGED_LINE_FLOOR 95'], excludes: ['floor 50', 'changed 99%'],
    check: (out) => { const blob = out.match(/blob ([0-9a-f]{12})$/m)[1]; return out.includes(`checks.env@${blob}`) ? null : `the record does not carry the trunk blob ${blob}`; },
  },
  {
    n: 14, name: 'origin cannot be reached: cannot verify, never a guess from the branch',
    run: (root) => { const s = spoke(root); git(s.work, ['remote', 'set-url', 'origin', join(root, 'gone.git')]); return judge(s); },
    exit: 2, includes: ['could not reach origin', 'so the trunk cannot be read', 'REASON: remote-unreachable'],
  },
  {
    n: 15, name: 'a declared trunk that agrees: the floors are read from that branch, not from the default branch',
    run: (root) => judge(spoke(root, {
      // The default branch's command fails the changed-line floor, so a read of the wrong branch fails.
      checks: CHECKS({ COVERAGE_COMMAND: "printf 'project=72.5\\nchanged=80\\n'" }),
      harness: { name: 'harness-main', checks: CHECKS({ TRUNK_FOR_HUB: 'harness-main' }) },
    }), { env: { HARNESS_SPOKE_TRUNK: 'harness-main' } }),
    exit: 0, includes: ['floors from origin/harness-main at', 'COVERAGE OK — project 72.5% (floor 70) · changed 96% (floor 95)'], excludes: ['origin/main', 'changed 80%'],
  },
  {
    n: 16, name: 'a default branch named master, handed in as HARNESS_SPOKE_TRUNK=master, agrees with TRUNK_FOR_HUB=default',
    run: (root) => judge(spoke(root, { trunk: 'master' }), { env: { HARNESS_SPOKE_TRUNK: 'master' } }),
    exit: 0, includes: ['floors from origin/master at', 'COVERAGE OK'],
  },
  {
    n: 17, name: 'the trunk carries no checks.env: there is no recorded bar, so nothing is judged',
    run: (root) => judge(spoke(root, { checks: null, branchChecks: CHECKS() })),
    exit: 2, includes: ['has no checks.env: there is no recorded bar'],
  },
  {
    n: 18, name: 'output with no figure in it cannot be judged',
    run: (root) => judge(spoke(root, { checks: CHECKS({ COVERAGE_COMMAND: "printf 'all tests passed\\n'" }) })),
    exit: 2, includes: ['printed no project line coverage', 'REASON: coverage-unreadable'],
  },
  {
    n: 19, name: 'a figure over 100 is not a percentage',
    run: (root) => judge(spoke(root, { checks: CHECKS({ COVERAGE_COMMAND: "printf 'project=172\\nchanged=96\\n'" }) })),
    exit: 2, includes: ['project=172 is not a percentage from 0 to 100'],
  },
  {
    n: 20, name: 'the command exits non-zero: a failed check, with its last output as evidence',
    run: (root) => judge(spoke(root, { checks: CHECKS({ COVERAGE_COMMAND: "echo '3 tests failed' >&2; exit 1" }) })),
    exit: 1, includes: ['FAIL COVERAGE_COMMAND exited 1 — 3 tests failed'],
  },
  {
    n: 21, name: 'a command that cannot start is cannot-verify, never a skipped row',
    run: (root) => judge(spoke(root, { checks: CHECKS({ COVERAGE_COMMAND: 'definitely-not-a-coverage-tool' }) })),
    exit: 2, includes: ['failed to start (exit 127)', 'REASON: tool-missing'],
  },
  {
    n: 22, name: 'the command is handed the merge base and HEAD, so changed lines are measured from where the branch left the trunk',
    run: (root) => {
      const s = spoke(root, { checks: CHECKS({ COVERAGE_COMMAND: "printf 'project=80\\nchanged=96\\n'; echo \"saw base=$HARNESS_COVERAGE_BASE head=$HARNESS_COVERAGE_HEAD\" >&2" }) });
      // The trunk moves on after the branch was cut; the pull request's base is its new tip.
      git(s.work, ['checkout', '-q', s.trunk]);
      writeFileSync(join(s.work, 'README.md'), '# later\n');
      git(s.work, ['add', '-A']);
      git(s.work, ['commit', '-q', '-m', 'docs: later']);
      git(s.work, ['push', '-q', 'origin', s.trunk]);
      const tip = git(s.work, ['rev-parse', 'HEAD']);
      git(s.work, ['checkout', '-q', 'feature/SVC-1-change']);
      const r = judge(s, { base: tip });
      return { ...r, output: `${r.output}\nexpect base=${s.base} head=${s.head}` };
    },
    exit: 0, includes: ['COVERAGE OK'],
    check: (out) => { const m = out.match(/expect (base=\S+ head=\S+)$/m)[1]; return out.includes(`saw ${m}`) ? null : `the command did not see ${m}`; },
  },
  {
    n: 23, name: 'a floor that is not a number is cannot-verify',
    run: (root) => judge(spoke(root, { checks: CHECKS({ PROJECT_COVERAGE_FLOOR: 'eighty' }) })),
    exit: 2, includes: ['PROJECT_COVERAGE_FLOOR is "eighty": a floor is a number from 0 to 100'],
  },
  {
    n: 24, name: 'a shallow clone: the merge base cannot be trusted',
    run: (root) => {
      const s = spoke(root);
      git(s.work, ['push', '-q', 'origin', 'feature/SVC-1-change']);
      const shallow = join(root, 'shallow');
      git(root, ['clone', '-q', '--depth', '1', '--branch', 'feature/SVC-1-change', `file://${s.bare}`, shallow]);
      return spawn(shallow, process.execPath, [CHECK, '--repo', shallow, '--base', 'HEAD', '--checks-from-trunk']);
    },
    exit: 2, includes: ['the clone is shallow', 'REASON: shallow-clone'],
  },
  {
    n: 25, name: '--checks <file> with the same bytes records the same twelve characters as the trunk',
    run: (root) => {
      const s = spoke(root);
      const file = join(root, 'checks.env');
      writeFileSync(file, CHECKS());
      const r = judge(s, { extra: ['--checks', file] });
      return { ...r, output: `${r.output}\nblob ${trunkBlob(s)}` };
    },
    exit: 0, includes: ['COVERAGE OK'],
    check: (out) => { const blob = out.match(/blob ([0-9a-f]{12})$/m)[1]; return out.includes(`checks.env@${blob}`) ? null : `the file mode did not record ${blob}`; },
  },
  {
    n: 26, name: 'a modified tracked file: the tree measured would not be the commit',
    run: (root) => { const s = spoke(root); writeFileSync(join(s.work, 'src', 'app.js'), 'changed\n'); return judge(s); },
    exit: 2, includes: ['tracked files are modified (src/app.js)'],
  },
  {
    n: 27, name: 'a base that shares no history with HEAD',
    run: (root) => {
      const s = spoke(root);
      git(s.work, ['checkout', '-q', '--orphan', 'unrelated']);
      git(s.work, ['rm', '-q', '-rf', '.']);
      writeFileSync(join(s.work, 'x.txt'), 'x\n');
      git(s.work, ['add', '-A']);
      git(s.work, ['commit', '-q', '-m', 'chore: unrelated']);
      const other = git(s.work, ['rev-parse', 'HEAD']);
      git(s.work, ['checkout', '-q', 'feature/SVC-1-change']);
      return judge(s, { base: other });
    },
    exit: 2, includes: ['share no history'],
  },
  {
    n: 28, name: 'usage: --base is required, and the floors come from exactly one place',
    run: (root) => {
      const s = spoke(root);
      const results = [
        spawn(s.work, process.execPath, [CHECK, '--repo', s.work, '--checks-from-trunk']),
        spawn(s.work, process.execPath, [CHECK, '--repo', s.work, '--base', s.base]),
        spawn(s.work, process.execPath, [CHECK, '--repo', s.work, '--base', s.base, '--checks-from-trunk', '--checks', 'x']),
      ];
      const bad = results.filter((r) => r.status !== 3);
      return { status: bad.length ? 1 : 3, output: results.map((r) => r.output).join('\n') };
    },
    exit: 3, includes: ['--base <commit> is required', 'name where the floors come from, once'],
  },
  {
    n: 29, library: true, name: 'the spoke workflow runs this check on every gated pull request, from the trunk, and red on cannot-verify',
    run: () => {
      const p = [];
      const wf = read('accelerator/spoke/story-gate.workflow.yml') || '';
      const at = wf.indexOf('node hub/scripts/check-coverage.mjs');
      if (at < 0) p.push('story-gate.workflow.yml does not run hub/scripts/check-coverage.mjs');
      const step = at < 0 ? '' : wf.slice(wf.lastIndexOf('- name:', at), wf.indexOf('- name:', at) < 0 ? wf.length : wf.indexOf('- name:', at));
      for (const needle of ["if: ${{ !cancelled() && env.RUN_COVERAGE == '1' }}", 'set -euo pipefail', '--checks-from-trunk', '--base "$BASE_SHA"', '[ -f hub/scripts/check-coverage.mjs ] ||', 'HARNESS_SPOKE_TRUNK="$TRUNK"', '--install']) {
        if (!step.includes(needle)) p.push(`the coverage step lacks: ${needle}`);
      }
      if (step.includes('continue-on-error')) p.push('the coverage step carries continue-on-error, which makes a required check advisory');
      // The coverage step runs the pull request's own code, so it is in the story-gate-code job.
      const job = wf.indexOf('\n  story-gate-code:\n');
      const next = wf.indexOf('\n  qa-gate:\n');
      if (job < 0 || at < job || (next > job && at > next)) p.push('the coverage step is not in the story-gate-code job');
      if (!(read('examples/sample-estate/prove.mjs') || '').includes('check-coverage.mjs')) p.push('prove.mjs does not prove the coverage step');
      return { status: p.length ? 1 : 0, output: p.join('\n') || 'story-gate carries the coverage step as a required, trunk-read check' };
    },
    exit: 0, includes: ['story-gate carries the coverage step'],
  },
  {
    n: 30, name: 'a declared trunk whose TRUNK_FOR_HUB names another branch: cannot verify, both values named',
    run: (root) => judge(spoke(root, { harness: { name: 'harness-main', checks: CHECKS() } }), { env: { HARNESS_SPOKE_TRUNK: 'harness-main' } }),
    exit: 2, includes: ['the trunk is harness-main (from HARNESS_SPOKE_TRUNK)', 'has TRUNK_FOR_HUB=default. The two must name the same branch'], excludes: ['COVERAGE OK'],
  },
  {
    n: 31, name: 'a declared trunk that origin does not have: cannot verify',
    run: (root) => judge(spoke(root), { env: { HARNESS_SPOKE_TRUNK: 'harness-main' } }),
    exit: 2, includes: ['the trunk is harness-main, and origin has no branch harness-main', 'REASON: trunk-missing'], excludes: ['COVERAGE OK'],
  },
  {
    n: 32, name: 'HARNESS_SPOKE_TRUNK not set: TRUNK_FOR_HUB at HEAD names the trunk, and the floors come from that branch',
    run: (root) => judge(spoke(root, {
      checks: CHECKS({ COVERAGE_COMMAND: "printf 'project=72.5\\nchanged=80\\n'" }),
      harness: { name: 'harness-main', checks: CHECKS({ TRUNK_FOR_HUB: 'harness-main' }) },
    })),
    exit: 0, includes: ['floors from origin/harness-main at', 'COVERAGE OK'], excludes: ['origin/main', 'changed 80%'],
  },

  /* ------------------------------------------------- --install: dependencies before the measure */
  {
    n: 33, name: '--install runs INSTALL_COMMAND from the trunk\'s checks.env before the coverage command, and an ignored file it writes is not a finding',
    run: (root) => {
      const s = spoke(root, {
        checks: CHECKS({ INSTALL_COMMAND: "sh -c 'echo .deps/ > .git/info/exclude; mkdir -p .deps; echo installed > .deps/marker'", COVERAGE_COMMAND: "test -f .deps/marker && printf 'project=72.5\\nchanged=96\\n'" }),
        branchChecks: CHECKS({ INSTALL_COMMAND: 'false' }),
      });
      return judge(s, { extra: ['--checks-from-trunk', '--install'] });
    },
    exit: 0, includes: ['INSTALL OK — sh -c', 'COVERAGE OK'], excludes: ['INSTALL FAILED'],
  },
  {
    n: 34, name: '--install with INSTALL_COMMAND none, or none with its reason, installs nothing and measures',
    run: (root) => judge(spoke(root, { checks: CHECKS({ INSTALL_COMMAND: 'none — the standard library only' }) }), { extra: ['--checks-from-trunk', '--install'] }),
    exit: 0, includes: ['INSTALL NONE — the standard library only', 'COVERAGE OK'],
  },
  {
    n: 35, name: '--install with INSTALL_COMMAND missing or UNRESOLVED is cannot-verify, and nothing is measured',
    run: (root) => {
      const outs = [undefined, 'UNRESOLVED'].map((v, i) => {
        const sub = join(root, `case-${i}`);
        mkdirSync(sub);
        return judge(spoke(sub, { checks: CHECKS({ INSTALL_COMMAND: v }) }), { extra: ['--checks-from-trunk', '--install'] });
      });
      return { status: outs.every((o) => o.status === 2) ? 2 : 1, output: outs.map((o) => o.output).join('\n') };
    },
    exit: 2, includes: ['CANNOT VERIFY: INSTALL_COMMAND is missing or empty', 'CANNOT VERIFY: INSTALL_COMMAND is "UNRESOLVED"'], excludes: ['COVERAGE OK', 'COVERAGE FAILED'],
  },
  {
    n: 36, name: '--install: an install that exits non-zero, or one that changes a tracked file or leaves a file git does not ignore, fails, and the coverage command does not run',
    run: (root) => {
      const outs = ["sh -c 'echo nope; exit 3'", "sh -c 'echo x >> src/app.js; touch stray.txt'"].map((v, i) => {
        const sub = join(root, `case-${i}`);
        mkdirSync(sub);
        return judge(spoke(sub, { checks: CHECKS({ INSTALL_COMMAND: v }) }), { extra: ['--checks-from-trunk', '--install'] });
      });
      return { status: outs.every((o) => o.status === 1) ? 1 : 2, output: outs.map((o) => o.output).join('\n') };
    },
    exit: 1, includes: ['exited 3 — nope', 'changed the tree: src/app.js, stray.txt'], excludes: ['COVERAGE OK', 'COVERAGE FAILED'],
  },
  {
    n: 37, name: '--install: an install that cannot start is cannot-verify',
    run: (root) => judge(spoke(root, { checks: CHECKS({ INSTALL_COMMAND: 'definitely-not-an-installer-cc' }) }), { extra: ['--checks-from-trunk', '--install'] }),
    exit: 2, includes: ['CANNOT VERIFY: INSTALL_COMMAND "definitely-not-an-installer-cc" failed to start (exit 127)', 'REASON: tool-missing'],
  },
];

/* ---------------------------------------------------------------------- runner */

function main() {
  const wanted = process.argv.slice(2).filter((a) => a.match(/^\d+$/)).map(Number);
  const selected = wanted.length ? FIXTURES.filter((f) => wanted.includes(f.n)) : FIXTURES;
  process.stdout.write(`script under test: ${CHECK} (${LIBRARY ? 'library' : 'installed'} layout)\n${selected.length} of ${FIXTURES.length} fixtures\n\n`);
  let failed = 0;
  let skipped = 0;
  for (const f of selected) {
    if (f.library && !LIBRARY) { skipped += 1; process.stdout.write(`  SKIP  ${f.n}. ${f.name} — library layout only\n`); continue; }
    const root = mkdtempSync(join(tmpdir(), `coverage-fx${String(f.n).padStart(2, '0')}-`));
    let res;
    try { res = f.run(root); } catch (err) { res = { status: 'threw', output: err && err.stack ? err.stack : String(err) }; }
    const problems = [];
    if (res.status !== f.exit) problems.push(`expected exit ${f.exit}, got ${res.status}`);
    for (const n of f.includes || []) if (!res.output.includes(n)) problems.push(`output does not contain: ${n}`);
    for (const n of f.excludes || []) if (res.output.includes(n)) problems.push(`output should not contain: ${n}`);
    if (f.check && res.status !== 'threw') { const p = f.check(res.output); if (p) problems.push(p); }
    if (problems.length) {
      failed += 1;
      process.stdout.write(`  FAIL  ${f.n}. ${f.name} [exit ${f.exit}]\n${problems.map((p) => `          - ${p}`).join('\n')}\n${res.output.split('\n').map((l) => `          | ${l}`).join('\n')}\n`);
    } else {
      process.stdout.write(`  PASS  ${f.n}. ${f.name} [exit ${f.exit}]\n`);
    }
    if (!process.argv.includes('--keep')) rmSync(root, { recursive: true, force: true });
  }
  const ran = selected.length - skipped;
  process.stdout.write(failed ? `\n${failed} of ${ran} fixtures FAILED.\n` : `\nAll ${ran} fixtures passed${skipped ? ` (${skipped} skipped: library layout only)` : ''}.\n`);
  rmSync(SANDBOX_HOME, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
}

main();

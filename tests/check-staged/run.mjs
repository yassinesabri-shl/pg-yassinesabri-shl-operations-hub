#!/usr/bin/env node
/**
 * run.mjs — the fixture suite for check-staged.mjs, the format, lint and type-check rows a
 * harness commit in a spoke must pass, and for harness-commit.mjs's use of it; and the candidate
 * rows /dev-sprint's finalizer commits through, every command of a frozen checks.env.
 *
 *   usage:  node run.mjs            run every fixture
 *           node run.mjs 3 7        run only the numbered fixtures
 *           node run.mjs --keep     leave the throwaway repositories on disk
 *
 * A fixture is a REPOSITORY STATE: a throwaway spoke with a real bare origin whose trunk carries
 * checks.env, a branch with something staged, and the script run as the helper runs it. The
 * commands are small shell lines standing in for a formatter, a linter and a type checker. Exit
 * code and text are asserted. Fixture 1 is the valid control; most others change one thing.
 *
 * Node standard library only, plus git via child_process. No test framework.
 * Exit 0 if every fixture passes, 1 if any fails.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const LIBRARY_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIBRARY = existsSync(join(LIBRARY_ROOT, 'accelerator', 'gate', 'check-staged.mjs'));
const SCRIPTS = LIBRARY ? join(LIBRARY_ROOT, 'accelerator', 'gate') : join(resolve(HERE, '..', '..'), 'scripts');
const STAGED = join(SCRIPTS, 'check-staged.mjs');
const COMMIT = join(SCRIPTS, 'harness-commit.mjs');
if (!existsSync(STAGED) || !existsSync(COMMIT)) {
  console.error(`cannot locate check-staged.mjs and harness-commit.mjs under ${SCRIPTS}`);
  process.exit(4);
}

const SANDBOX_HOME = mkdtempSync(join(tmpdir(), 'staged-home-'));
const ENV = {
  ...process.env,
  HOME: SANDBOX_HOME,
  XDG_CONFIG_HOME: join(SANDBOX_HOME, '.config'),
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
};
for (const k of ['HARNESS_COMMIT', 'HARNESS_TRUNK', 'HARNESS_SPOKE_TRUNK', 'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL']) delete ENV[k];

function git(cwd, args) {
  return execFileSync('git', args, { cwd, env: ENV, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
}
function spawn(cwd, cmd, args, env = {}) {
  const res = spawnSync(cmd, args, { cwd, env: { ...ENV, ...env }, encoding: 'utf8' });
  return { status: res.status, output: `${res.stdout || ''}${res.stderr || ''}` };
}
function write(dir, files) {
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), body);
  }
}

/* The stand-in tools. Each reads src/ and nothing else. */
const FORMAT = `for f in src/*.txt; do tr -s ' ' < "$f" > "$f.tmp" && mv "$f.tmp" "$f"; done`; // squeezes double spaces, in place
const LINT = `! grep -n TODO src/*.txt`;                                                      // fails on a TODO
const TYPES = `! grep -n 'type error' src/*.txt`;                                             // fails on a "type error"
// The secret scan, as the contract has it: asked for the staged changes by SHL_SCAN_MODE, clean unless
// the diff carries the planted token, and refusing a call that names no mode.
const SCAN = `node -e "const d=require('child_process').execSync('git diff --cached',{encoding:'utf8'});process.exit(process.env.SHL_SCAN_MODE==='staged'&&!d.includes('AKIAFAKE'+'KEY0000')?0:1)"`;
const TOKEN = 'AKIAFAKE' + 'KEY0000';                                                      // what SCAN refuses
const GOOD = { SECRET_SCAN_COMMAND: SCAN, FORMAT_COMMAND: FORMAT, LINT_COMMAND: LINT, TYPECHECK_COMMAND: TYPES };
// Every spoke names its trunk. A fixture that sets TRUNK_FOR_HUB, or sets it to undefined, overrides the default.
const envText = (values) => `# checks.env\n${Object.entries({ TRUNK_FOR_HUB: 'default', ...values }).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${v}`).join('\n')}\nSTORY_GATE_EXCEPTION=^harness/\n`;

/**
 * A spoke: a bare origin whose trunk carries checks.env (unless `values` is null) and src/a.txt,
 * and a working clone on a feature branch. `branch` ({ name, values }) adds a second branch, cut
 * from the trunk's tip with its own checks.env: a declared harness trunk. The feature branch is
 * cut from that branch, unless `cutFrom` names another.
 */
function spoke(root, { values = GOOD, trunk = 'main', branch = null, cutFrom = null } = {}) {
  const origin = join(root, 'origin.git');
  const work = join(root, 'work');
  git(root, ['init', '-q', '--bare', '--initial-branch', trunk, origin]);
  git(root, ['init', '-q', '--initial-branch', trunk, work]);
  git(work, ['config', 'user.name', 'A Person']);
  git(work, ['config', 'user.email', 'person@example.invalid']);
  git(work, ['config', 'commit.gpgsign', 'false']);
  git(work, ['remote', 'add', 'origin', origin]);
  write(work, { 'README.md': '# spoke\n', 'src/a.txt': 'let a = 1\n', '.gitignore': '*.ignored\n', ...(values ? { 'checks.env': envText(values) } : {}) });
  git(work, ['add', '-A']);
  git(work, ['commit', '-q', '-m', 'chore: the trunk']);
  git(work, ['push', '-q', 'origin', trunk]);
  if (branch) {
    git(work, ['switch', '-q', '-c', branch.name]);
    write(work, { 'checks.env': envText(branch.values) });
    git(work, ['commit', '-q', '--allow-empty', '-am', `chore: the ${branch.name} trunk`]);
    git(work, ['push', '-q', 'origin', branch.name]);
  }
  const base = cutFrom || (branch ? branch.name : trunk);
  git(work, ['switch', '-q', '-c', 'feature/SVC-1-change', base]);
  return { root, origin, work, trunk };
}
/** Stage files on the feature branch. */
const stage = (s, files) => { write(s.work, files); git(s.work, ['add', '-A']); };
const check = (s, env = {}) => spawn(s.work, process.execPath, [STAGED, '--repo', s.work], env);
const checkHead = (s, env = {}) => spawn(s.work, process.execPath, [STAGED, '--repo', s.work, '--head'], env);
/** A commit made by hand on the feature branch, the way a commit the helper did not make lands (the finalizer's candidate). */
const commitByHand = (s, files) => { stage(s, files); git(s.work, ['commit', '-q', '-m', 'feat: by hand']); };
const helper = (s, env = {}) => spawn(s.work, process.execPath, [COMMIT, '--repo', '.', '-m', 'feat(SVC-1): a change'], env);
const head = (s) => git(s.work, ['rev-parse', 'HEAD']).trim();
/**
 * checkStaged as /dev-sprint's finalizer calls it: every candidate row, the trunk's checks.env blob
 * frozen, and each command between() was called after.
 */
function asFinalizer(s) {
  const blob = git(s.work, ['rev-parse', `${s.trunk}:checks.env`]).trim();
  const script = `import { CANDIDATE_ROWS, checkStaged } from ${JSON.stringify(pathToFileURL(STAGED).href)};
const seen = [];
const r = checkStaged({ repo: '.', rows: CANDIDATE_ROWS, frozen: { blob: process.argv[1] }, between: (key) => seen.push(key) });
process.stdout.write(\`\${r.report}between=\${seen.join(',')}\\nrows=\${r.rows.map((x) => \`\${x.key}:\${x.result}\`).join(',')}\\n\`);
process.exit(r.code);`;
  return spawn(s.work, process.execPath, ['--input-type=module', '-e', script, blob]);
}
/** Run the helper and report whether HEAD moved, so a fixture asserts "nothing committed". */
function helperMoved(s, env = {}) {
  const before = head(s);
  const r = helper(s, env);
  return { status: r.status, output: `${r.output}\nhead-moved=${head(s) !== before}\n` };
}

/**
 * The trunk moves: a commit on it made in a second clone and pushed, then fetched into the work
 * clone. `onTrunk: false` pushes it to a side branch instead. Returns the commit.
 */
function trunkMoves(s, files, { onTrunk = true } = {}) {
  const other = join(s.root, 'other');
  if (!existsSync(other)) {
    git(s.root, ['clone', '-q', s.origin, other]);
    git(other, ['config', 'user.name', 'Another Person']);
    git(other, ['config', 'user.email', 'another@example.invalid']);
    git(other, ['config', 'commit.gpgsign', 'false']);
  }
  git(other, ['switch', '-q', onTrunk ? s.trunk : '-c', ...(onTrunk ? [] : ['side'])]);
  write(other, files);
  git(other, ['add', '-A']);
  git(other, ['commit', '-q', '-m', 'feat: another story']);
  git(other, ['push', '-q', 'origin', onTrunk ? s.trunk : 'side']);
  git(s.work, ['fetch', '-q', 'origin']);
  return git(other, ['rev-parse', 'HEAD']).trim();
}
/** git merge --no-ff --no-commit, as /dev-sprint starts a trunk merge; a conflict leaves the merge in progress. */
const startMerge = (s, commit) => spawn(s.work, 'git', ['merge', '--no-ff', '--no-commit', commit]);
/** The helper on the merge in progress, with the subject /dev-sprint writes unless `subject` is given. */
function mergeHelper(s, commit, { subject = `chore(SVC-1): merge the trunk at ${commit.slice(0, 12)}`, flag = commit } = {}) {
  const before = head(s);
  const r = spawn(s.work, process.execPath, [COMMIT, '--repo', '.', '--trunk-merge', flag, '-m', subject]);
  const now = head(s);
  const parents = git(s.work, ['log', '-1', '--format=%P', now]).trim().split(' ');
  const body = git(s.work, ['log', '-1', '--format=%B', now]);
  return { status: r.status, output: `${r.output}\nhead-moved=${now !== before}\nparents=${parents.length}\nsecond=${parents[1] === commit}\n${now !== before ? body : ''}` };
}

/* ------------------------------------------------------------------- fixtures */

const FIXTURES = [
  /* ------------------------------------------------------------ the rows */
  {
    n: 1, name: 'a clean staged change in a spoke passes all three rows, read from the trunk',
    run: (root) => { const s = spoke(root); stage(s, { 'src/b.txt': 'let b = 2\n' }); return check(s); },
    exit: 0, includes: ['COMMIT CHECKS — checks.env at origin/main', '[PASS] FORMAT_COMMAND', '[PASS] LINT_COMMAND', '[PASS] TYPECHECK_COMMAND', 'COMMIT CHECKS PASSED.'],
  },
  {
    n: 2, name: 'the helper commits a clean change, prints the report, and records each row as a Harness-Check trailer above the watermark',
    run: (root) => {
      const s = spoke(root, { values: { ...GOOD, TYPECHECK_COMMAND: 'none — plain JavaScript, no type checker' } });
      stage(s, { 'src/b.txt': 'let b = 2\n' });
      const r = helperMoved(s);
      const message = git(s.work, ['log', '-1', '--format=%B']);
      const trailers = execFileSync('git', ['interpret-trailers', '--parse'], { input: message, encoding: 'utf8' }).trim().split('\n');
      return { status: r.status, output: `${r.output}\ntrailers=${JSON.stringify(trailers)}\nlast=${message.trim().split('\n').pop()}\n` };
    },
    exit: 0,
    includes: ['COMMIT CHECKS PASSED.', 'HARNESS COMMIT', 'head-moved=true', 'last=Generated-by: SHL Agentic Harness'],
    matches: [/trailers=\["Harness-Check: secret-scan pass \d+\.\ds","Harness-Check: format pass \d+\.\ds","Harness-Check: lint pass \d+\.\ds","Harness-Check: typecheck none — plain JavaScript, no type checker","Generated-by: SHL Agentic Harness"\]/],
  },
  {
    n: 3, name: 'a lint failure is exit 1 with the tool\'s own words, and the helper commits nothing',
    run: (root) => { const s = spoke(root); stage(s, { 'src/b.txt': 'let b = 2 // TODO tidy\n' }); return helperMoved(s); },
    exit: 1, includes: ['[FAIL] LINT_COMMAND', 'exit 1', 'src/b.txt:1:let b = 2 // TODO tidy', 'HARNESS COMMIT REFUSED', 'head-moved=false'],
  },
  {
    n: 4, name: 'every row runs before the exit: a lint failure and a type failure are both reported',
    run: (root) => { const s = spoke(root); stage(s, { 'src/b.txt': 'TODO: a type error\n' }); return check(s); },
    exit: 1, includes: ['[PASS] FORMAT_COMMAND', '[FAIL] LINT_COMMAND', '[FAIL] TYPECHECK_COMMAND', 'COMMIT CHECKS FAILED'],
  },

  /* ------------------------------------------------------- judged by the tree */
  {
    n: 5, name: 'a formatter that rewrites a staged file in place fails the row, names the file and leaves the rewrite unstaged',
    run: (root) => {
      const s = spoke(root);
      stage(s, { 'src/b.txt': 'let  b = 2\n' });
      const r = check(s);
      const left = readFileSync(join(s.work, 'src', 'b.txt'), 'utf8');
      const unstaged = git(s.work, ['diff', '--name-only']).trim();
      return { status: r.status, output: `${r.output}\nfile=${JSON.stringify(left)} unstaged=${unstaged}\n` };
    },
    exit: 1, includes: ['[FAIL] FORMAT_COMMAND', 'exit 0, but it changed the tree', 'src/b.txt (changed)', 'file="let b = 2\\n" unstaged=src/b.txt'],
  },
  {
    n: 6, name: 'a later row is judged on the content the earlier row left: a second change to the same file fails it, a row that changes nothing passes',
    run: (root) => {
      const s = spoke(root, { values: { ...GOOD, LINT_COMMAND: `echo more >> src/b.txt && ${LINT}` } });
      stage(s, { 'src/b.txt': 'let  b = 2\n' });
      return check(s);
    },
    exit: 1, includes: ['[FAIL] FORMAT_COMMAND', '[FAIL] LINT_COMMAND  echo more >> src/b.txt', 'src/b.txt (changed)', '[PASS] TYPECHECK_COMMAND'],
  },
  {
    n: 7, name: 'a tool that leaves an untracked file behind fails, naming it as created; an ignored one does not count',
    run: (root) => {
      const s = spoke(root, { values: { ...GOOD, LINT_COMMAND: `touch .lintcache lint.ignored && ${LINT}` } });
      stage(s, { 'src/b.txt': 'let b = 2\n' });
      return check(s);
    },
    exit: 1, includes: ['[FAIL] LINT_COMMAND', '.lintcache (created)'], excludes: ['lint.ignored (created)'],
  },
  {
    n: 8, name: 'a tool that stages its own fixes changes what would be committed: the row fails even though the tree matches the index',
    run: (root) => {
      const s = spoke(root, { values: { ...GOOD, FORMAT_COMMAND: `${FORMAT} && git add -A` } });
      stage(s, { 'src/b.txt': 'let  b = 2\n' });
      return check(s);
    },
    exit: 1, includes: ['[FAIL] FORMAT_COMMAND', 'it changed what is staged'],
  },
  {
    n: 9, name: 'a working tree that is not what is staged fails before any row runs: an unstaged change and an untracked file named, an ignored one not',
    run: (root) => {
      const s = spoke(root, { values: { ...GOOD, LINT_COMMAND: `touch ran && ${LINT}` } });
      stage(s, { 'src/b.txt': 'let b = 2\n' });
      write(s.work, { 'src/a.txt': 'let a = 3\n', 'scratch.md': 'notes\n', 'build.ignored': 'x\n' });
      const r = check(s);
      return { status: r.status, output: `${r.output}\nran=${existsSync(join(s.work, 'ran'))}\n` };
    },
    exit: 1, includes: ['the working tree is not what is staged:', 'src/a.txt (changed)', 'scratch.md (created)', 'nothing ran', 'ran=false'], excludes: ['build.ignored'],
  },

  /* ------------------------------------------------------------- the values */
  {
    n: 10, name: 'bare UNRESOLVED, a missing key and an empty value are each exit 2, reported as not set, and the helper commits nothing',
    run: (root) => { const s = spoke(root, { values: { FORMAT_COMMAND: 'UNRESOLVED', TYPECHECK_COMMAND: '' } }); stage(s, { 'src/b.txt': 'let b = 2\n' }); return helperMoved(s); },
    exit: 2, includes: ['[CANNOT VERIFY] FORMAT_COMMAND  not set:', '[CANNOT VERIFY] LINT_COMMAND  not set (missing)', '[CANNOT VERIFY] TYPECHECK_COMMAND  not set (empty)', 'HARNESS COMMIT CANNOT VERIFY', 'head-moved=false'],
  },
  {
    n: 11, name: 'UNRESOLVED with a reason is reported as unresolved, the reason printed',
    run: (root) => {
      const s = spoke(root, { values: { ...GOOD, FORMAT_COMMAND: 'UNRESOLVED — two formatters are configured. Owner: tech lead. Resolves: one is chosen.' } });
      stage(s, { 'src/b.txt': 'let b = 2\n' });
      return check(s);
    },
    exit: 2, includes: ['[CANNOT VERIFY] FORMAT_COMMAND  unresolved: UNRESOLVED — two formatters are configured.'], excludes: ['not set'],
  },
  {
    n: 12, name: 'none passes, reported as none; none with a reason prints the reason',
    run: (root) => {
      const s = spoke(root, { values: { ...GOOD, FORMAT_COMMAND: 'none', TYPECHECK_COMMAND: 'none — plain JavaScript, no type checker' } });
      stage(s, { 'src/b.txt': 'let b = 2\n' });
      return check(s);
    },
    exit: 0, includes: ['[NONE] FORMAT_COMMAND  none: this repository has no such step, on purpose', '[NONE] TYPECHECK_COMMAND  none — plain JavaScript, no type checker', '[PASS] LINT_COMMAND'],
  },
  {
    n: 13, name: 'a tool that is not installed (exit 127) is exit 2, never a pass and never a fix to attempt',
    run: (root) => { const s = spoke(root, { values: { ...GOOD, TYPECHECK_COMMAND: 'no-such-type-checker-xyz src' } }); stage(s, { 'src/b.txt': 'let b = 2\n' }); return check(s); },
    exit: 2, includes: ['[CANNOT VERIFY] TYPECHECK_COMMAND  no-such-type-checker-xyz src — exit 127', 'this needs a person, not another attempt'],
  },
  {
    n: 14, name: 'exit 2 outranks exit 1: a failing lint beside an unresolved type check is exit 2, both rows listed',
    run: (root) => { const s = spoke(root, { values: { ...GOOD, TYPECHECK_COMMAND: 'UNRESOLVED' } }); stage(s, { 'src/b.txt': 'TODO\n' }); return check(s); },
    exit: 2, includes: ['[FAIL] LINT_COMMAND', '[CANNOT VERIFY] TYPECHECK_COMMAND  not set'],
  },

  /* ------------------------------------------------------------- the trunk */
  {
    n: 15, name: 'the trunk wins: a branch that stages checks.env with none beside its code is still judged by the trunk\'s lint',
    run: (root) => {
      const s = spoke(root);
      stage(s, { 'checks.env': envText({ ...GOOD, LINT_COMMAND: 'none' }), 'src/b.txt': 'TODO\n' });
      return check(s);
    },
    exit: 1, includes: ['[FAIL] LINT_COMMAND  ! grep -n TODO src/*.txt'],
  },
  {
    n: 16, name: 'the trunk is force-fetched: a command a person merged after the branch was cut is the one that runs',
    run: (root) => {
      const s = spoke(root);
      const other = join(root, 'other');
      git(root, ['clone', '-q', s.origin, other]);
      git(other, ['config', 'user.name', 'A Person']);
      git(other, ['config', 'user.email', 'person@example.invalid']);
      write(other, { 'checks.env': envText({ ...GOOD, TYPECHECK_COMMAND: 'none — no type checker in this repository' }) });
      git(other, ['commit', '-q', '-am', 'chore: no type checker']);
      git(other, ['push', '-q', 'origin', 'main']);
      stage(s, { 'src/b.txt': 'a type error\n' });
      return check(s);
    },
    exit: 0, includes: ['[NONE] TYPECHECK_COMMAND  none — no type checker in this repository'],
  },
  {
    n: 17, name: 'an unreachable origin is exit 2: the commands cannot be read from the trunk',
    run: (root) => { const s = spoke(root); git(s.work, ['remote', 'set-url', 'origin', join(root, 'gone.git')]); stage(s, { 'src/b.txt': 'let b = 2\n' }); return check(s); },
    exit: 2, includes: ['COMMIT CHECKS CANNOT VERIFY — could not reach origin', 'REASON: remote-unreachable'],
  },
  {
    n: 18, name: 'a default branch that is not main is asked of the remote, and HARNESS_SPOKE_TRUNK naming a branch origin does not have is exit 2',
    run: (root) => {
      const s = spoke(root, { trunk: 'develop' });
      stage(s, { 'src/b.txt': 'let b = 2\n' });
      const asked = check(s);
      const named = check(s, { HARNESS_SPOKE_TRUNK: 'main' });
      return { status: named.status, output: `asked=${asked.status}\n${asked.output}\n${named.output}` };
    },
    exit: 2, includes: ['asked=0', 'checks.env at origin/develop', 'the trunk is main, and origin has no branch main', 'REASON: trunk-missing'],
  },

  /* ----------------------------------------------------- where nothing runs */
  {
    n: 19, name: 'a checkout with no checks.env in it or its history is not a spoke: nothing runs, and the helper commits with no remote at all',
    run: (root) => {
      const work = join(root, 'hub');
      git(root, ['init', '-q', '--initial-branch', 'main', work]);
      git(work, ['config', 'user.name', 'A Person']);
      git(work, ['config', 'user.email', 'person@example.invalid']);
      write(work, { 'docs/estate/drafts/svc.checks.env': 'LINT_COMMAND=UNRESOLVED\n' });
      git(work, ['add', '-A']);
      return spawn(work, process.execPath, [COMMIT, '--repo', '.', '-m', 'docs: a draft']);
    },
    exit: 0, includes: ['HARNESS COMMIT'], excludes: ['COMMIT CHECKS'],
  },
  {
    n: 20, name: 'a spoke whose branch deleted checks.env is still a spoke: its history says so, and the trunk is read',
    run: (root) => { const s = spoke(root); git(s.work, ['rm', '-q', 'checks.env']); stage(s, { 'src/b.txt': 'TODO\n' }); return check(s); },
    exit: 1, includes: ['[FAIL] LINT_COMMAND'],
  },
  {
    n: 21, name: 'only harness files staged (checks.env, the story-gate workflow, an upgrade\'s .shl-new and .shl-upstream.diff, the hook, .gitattributes, CODEOWNERS and a proposal beside it) skips format, lint and type-check, even with a failing trunk command, and is still scanned',
    run: (root) => {
      const s = spoke(root, { values: { ...GOOD, LINT_COMMAND: 'false' } });
      stage(s, {
        'checks.env': envText({ ...GOOD, LINT_COMMAND: 'none' }),
        '.github/workflows/story-gate.yml': 'name: story-gate\n',
        '.github/workflows/story-gate.yml.shl-new': 'x\n',
        '.github/workflows/story-gate.yml.shl-upstream.diff': 'y\n',
        '.githooks/pre-commit': '#!/usr/bin/env node\n',
        '.gitattributes': '.githooks/pre-commit text eol=lf\n',
        '.github/CODEOWNERS': '/checks.env @acme/gate\n',
        '.github/CODEOWNERS.shl-new': '/checks.env @acme/gate\n',
      });
      return check(s);
    },
    exit: 0,
    includes: ['only harness files are staged', 'format, lint and type-check are skipped, a harness change is not a story', '[PASS] SECRET_SCAN_COMMAND'],
    excludes: ['[FAIL] LINT_COMMAND', '[PASS] LINT_COMMAND'],
  },
  {
    n: 22, name: 'one code file beside the harness files makes it a story commit again, and the rows run',
    run: (root) => {
      const s = spoke(root, { values: { ...GOOD, LINT_COMMAND: 'false' } });
      stage(s, { '.github/workflows/story-gate.yml': 'name: story-gate\n', 'src/b.txt': 'let b = 2\n' });
      return check(s);
    },
    exit: 1, includes: ['[FAIL] LINT_COMMAND  false — exit 1'],
  },
  {
    n: 23, name: 'the spoke install\'s own branch: checks.env staged, none on the trunk yet, so only the secret scan runs, from the checkout, until the install merges',
    run: (root) => { const s = spoke(root, { values: null }); stage(s, { 'checks.env': envText({ SECRET_SCAN_COMMAND: SCAN, LINT_COMMAND: 'false' }), 'ci/coverage.yml': 'x\n' }); return check(s); },
    exit: 0,
    includes: ['origin/main carries no checks.env yet: this is the spoke install\'s own branch, so format, lint and type-check start once it merges', '[PASS] SECRET_SCAN_COMMAND'],
    excludes: ['LINT_COMMAND  false'],
  },
  {
    n: 24, name: 'a checkout with no origin cannot push: nothing runs, and the reason names the guard\'s finalizer; an origin that cannot be reached is exit 2 (17)',
    run: (root) => {
      const s = spoke(root, { values: { ...GOOD, LINT_COMMAND: 'false' } });
      git(s.work, ['remote', 'remove', 'origin']);
      stage(s, { 'src/b.txt': 'let b = 2\n' });
      return check(s);
    },
    exit: 0, includes: ["COMMIT CHECKS NOT RUN — no origin remote: this checkout cannot push", "the protected-test guard's engineer clone"],
  },
  {
    n: 25, name: '--head judges the checkout as committed: a clean commit passes, and the same rows fail one committed with a lint error the helper never saw',
    run: (root) => {
      const s = spoke(root);
      commitByHand(s, { 'src/b.txt': 'let b = 2\n' });
      const clean = checkHead(s);
      commitByHand(s, { 'src/c.txt': 'TODO later\n' });
      const red = checkHead(s);
      return { status: red.status, output: `clean=${clean.status}\n${clean.output}\nred=${red.status}\n${red.output}` };
    },
    exit: 1, includes: ['clean=0', ', as committed', 'red=1', '[FAIL] LINT_COMMAND', 'src/c.txt:1:TODO later', 'the commit as it stands fails a row above'], excludes: ['NOT RUN'],
  },
  {
    n: 26, name: '--head refuses anything staged, judges only harness files and a checkout with no origin rather than skipping them, and names a dirty tree',
    run: (root) => {
      const s = spoke(root, { values: { ...GOOD, LINT_COMMAND: 'false' } });
      commitByHand(s, { 'checks.env': envText({ ...GOOD, LINT_COMMAND: 'none' }) });
      const harnessOnly = checkHead(s);
      stage(s, { 'src/b.txt': 'let b = 2\n' });
      const staged = checkHead(s);
      git(s.work, ['reset', '-q']);
      const dirty = checkHead(s);
      rmSync(join(s.work, 'src', 'b.txt'));
      git(s.work, ['remote', 'remove', 'origin']);
      const noOrigin = checkHead(s);
      return { status: staged.status, output: `harness-only=${harnessOnly.status}\n${harnessOnly.output}\nstaged=${staged.status}\n${staged.output}\ndirty=${dirty.status}\n${dirty.output}\nno-origin=${noOrigin.status}\n${noOrigin.output}` };
    },
    exit: 1, includes: ['harness-only=1', '[FAIL] LINT_COMMAND  false', 'staged=1', 'something is staged: src/b.txt', 'dirty=1', 'the working tree is not what is committed: src/b.txt (created)', 'no-origin=2', 'could not reach origin'],
  },
  /* ------------------------------------------------------ the secret scan */
  {
    n: 27, name: 'a staged secret is exit 1 with the scanner\'s refusal, every other row still runs, and the helper commits nothing',
    run: (root) => { const s = spoke(root); stage(s, { 'src/b.txt': `let key = '${TOKEN}'\n` }); return helperMoved(s); },
    exit: 1,
    includes: ['[FAIL] SECRET_SCAN_COMMAND', 'refused the staged changes (exit 1)', '[PASS] LINT_COMMAND', 'HARNESS COMMIT REFUSED', 'head-moved=false'],
  },
  {
    n: 28, name: 'the scan command is the trunk\'s: a branch that stages checks.env with the scan set to true is still judged by the trunk\'s scanner',
    run: (root) => {
      const s = spoke(root);
      stage(s, { 'checks.env': envText({ ...GOOD, SECRET_SCAN_COMMAND: 'true' }), 'src/b.txt': `let key = '${TOKEN}'\n` });
      return check(s);
    },
    exit: 1, includes: ['[FAIL] SECRET_SCAN_COMMAND', 'read from checks.env at origin/main'],
  },
  {
    n: 29, name: 'a missing, empty or UNRESOLVED scan on the trunk cannot verify (exit 2), as the other rows do, and `none` is refused (exit 1)',
    run: (root) => {
      const out = [];
      let status = 0;
      for (const [name, value] of [['missing', undefined], ['empty', ''], ['unresolved', 'UNRESOLVED'], ['reason', 'UNRESOLVED — no scanner chosen. Owner: tech lead. Resolves: the choice.'], ['none', 'none'], ['none-why', 'none — no code here']]) {
        const dir = join(root, name);
        mkdirSync(dir);
        const s = spoke(dir, { values: { ...GOOD, SECRET_SCAN_COMMAND: value } });
        stage(s, { 'src/b.txt': 'let b = 2\n' });
        const r = check(s);
        out.push(`${name}=${r.status}\n${r.output}`);
        status += r.status;
      }
      return { status: status === 2 + 2 + 2 + 2 + 1 + 1 ? 0 : status, output: out.join('\n') };
    },
    exit: 0,
    includes: ['missing=2', 'empty=2', 'unresolved=2', 'reason=2', 'none=1', 'none-why=1', 'SECRET_SCAN_COMMAND is missing in checks.env', 'SECRET_SCAN_COMMAND is empty in checks.env', 'SECRET_SCAN_COMMAND is none in checks.env', 'no scanner chosen'],
  },
  {
    n: 30, name: 'a harness-only commit is scanned: a secret in a staged checks.env or hook is refused, though the other rows are skipped',
    run: (root) => {
      const s = spoke(root);
      stage(s, { 'checks.env': `${envText(GOOD)}# ${TOKEN}\n`, '.githooks/pre-commit': '#!/usr/bin/env node\n' });
      return helperMoved(s);
    },
    exit: 1, includes: ['only harness files are staged', '[FAIL] SECRET_SCAN_COMMAND', 'head-moved=false'],
    excludes: ['LINT_COMMAND'],
  },
  {
    n: 31, name: 'the install\'s own branch is scanned too, from its own checks.env: a secret staged beside it is refused, and the trunk still has none',
    run: (root) => {
      const s = spoke(root, { values: null });
      stage(s, { 'checks.env': envText({ SECRET_SCAN_COMMAND: SCAN }), 'src/b.txt': `let key = '${TOKEN}'\n` });
      return check(s);
    },
    exit: 1, includes: ['carries no checks.env yet', '[FAIL] SECRET_SCAN_COMMAND', 'read from this checkout\'s checks.env'],
  },
  {
    n: 32, name: 'a scan that is not installed (exit 127) cannot verify: exit 2, never a refusal and never a pass',
    run: (root) => { const s = spoke(root, { values: { ...GOOD, SECRET_SCAN_COMMAND: 'no-such-secret-scanner-anywhere' } }); stage(s, { 'src/b.txt': 'let b = 2\n' }); return check(s); },
    exit: 2, includes: ['[CANNOT VERIFY] SECRET_SCAN_COMMAND', 'exit 2', 'exit 127', 'is not installed on this machine'],
  },
  {
    n: 33, name: 'the upgrade\'s allowance: a spoke that names no scan yet commits with a warning and one skipped row, and a spoke that names one is scanned as ever',
    run: (root) => {
      const run = (dir, values, staged) => {
        mkdirSync(dir);
        const s = spoke(dir, { values });
        stage(s, staged);
        const script = `import { harnessCommit } from ${JSON.stringify(pathToFileURL(COMMIT).href)};\ntry { console.log('sha=' + harnessCommit({ repo: '.', paragraphs: ['chore: upgrade'], secretScanIfDeclared: true, onChecks: (r) => console.log(r) }).slice(0, 7)); } catch (e) { console.log('refused=' + e.code + '\\n' + e.message); process.exit(e.code); }`;
        const r = spawn(s.work, process.execPath, ['--input-type=module', '-e', script]);
        return `${r.status}\n${r.output}\ntrailers=${JSON.stringify(execFileSync('git', ['interpret-trailers', '--parse'], { input: git(s.work, ['log', '-1', '--format=%B']), encoding: 'utf8' }).trim().split('\n'))}`;
      };
      const open = run(join(root, 'open'), { ...GOOD, SECRET_SCAN_COMMAND: 'UNRESOLVED' }, { 'checks.env': `${envText({ ...GOOD, SECRET_SCAN_COMMAND: 'UNRESOLVED' })}# the upgrade\n` });
      const named = run(join(root, 'named'), GOOD, { 'src/b.txt': `let key = '${TOKEN}'\n` });
      return { status: 0, output: `open=${open}\n---\nnamed=${named}` };
    },
    exit: 0,
    includes: ['[SKIPPED] SECRET_SCAN_COMMAND', 'SECRET_SCAN_COMMAND is UNRESOLVED', 'Harness-Check: secret-scan none — not named yet; the upgrade only', 'refused=1', 'refused the staged changes'],
  },

  /* ------------------------------------------------- the finalizer's candidate rows */
  {
    n: 34, name: 'as the finalizer calls it: every candidate row, from the frozen checks.env blob and never the trunk, with no skip for a checkout without origin; the scan told SHL_SCAN_MODE=staged; coverage against both floors, judged by check-coverage.mjs; a reported row unset is NOT CONFIGURED; between() after each command',
    run: (root) => {
      const s = spoke(root, { values: { ...GOOD, INSTALL_COMMAND: 'true', BUILD_COMMAND: 'true', TEST_COMMAND: 'true', COVERAGE_COMMAND: "printf 'measured\\nproject=90\\nchanged=96\\n'", PROJECT_COVERAGE_FLOOR: '80', CHANGED_LINE_FLOOR: '95', MIGRATION_IMMUTABILITY_COMMAND: 'UNRESOLVED' } });
      git(s.work, ['remote', 'remove', 'origin']);
      stage(s, { 'src/b.txt': 'let b = 2\n' });
      return asFinalizer(s);
    },
    exit: 0,
    includes: ['COMMIT CHECKS — the frozen checks.env (blob', '[PASS] INSTALL_COMMAND', '[PASS] BUILD_COMMAND', '[PASS] TEST_COMMAND', '[PASS] COVERAGE_COMMAND', '[PASS] SECRET_SCAN_COMMAND', '[NOT CONFIGURED] MIGRATION_IMMUTABILITY_COMMAND',
      'between=INSTALL_COMMAND,BUILD_COMMAND,FORMAT_COMMAND,LINT_COMMAND,TYPECHECK_COMMAND,TEST_COMMAND,COVERAGE_COMMAND,SECRET_SCAN_COMMAND',
      'rows=INSTALL_COMMAND:pass,BUILD_COMMAND:pass,FORMAT_COMMAND:pass,LINT_COMMAND:pass,TYPECHECK_COMMAND:pass,TEST_COMMAND:pass,COVERAGE_COMMAND:pass,SECRET_SCAN_COMMAND:pass,MIGRATION_IMMUTABILITY_COMMAND:NOT CONFIGURED'],
  },
  {
    n: 35, name: 'the candidate rows meet the same rules as the commit rows: a test command that leaves a file git does not ignore fails, coverage below the floor fails, and a scan of `none` is refused, every row listed',
    run: (root) => {
      const s = spoke(root, { values: { ...GOOD, INSTALL_COMMAND: 'none — the fixture has no dependencies', BUILD_COMMAND: 'none', TEST_COMMAND: 'touch results.xml', COVERAGE_COMMAND: "printf 'project=60\\nchanged=100\\n'", PROJECT_COVERAGE_FLOOR: '80', CHANGED_LINE_FLOOR: '95', SECRET_SCAN_COMMAND: 'none', MIGRATION_IMMUTABILITY_COMMAND: 'none' } });
      stage(s, { 'src/b.txt': 'let b = 2\n' });
      return asFinalizer(s);
    },
    exit: 1, includes: ['[FAIL] TEST_COMMAND  touch results.xml — exit 0, but it changed the tree', 'results.xml (created)', '[FAIL] COVERAGE_COMMAND', 'project coverage 60 is below PROJECT_COVERAGE_FLOOR 80',
      "[FAIL] SECRET_SCAN_COMMAND  none: a spoke's secret scan is mandatory", 'TEST_COMMAND:fail', 'COVERAGE_COMMAND:fail', 'SECRET_SCAN_COMMAND:fail'],
  },

  /* ------------------------------------------------------- a declared trunk */
  {
    n: 36, name: 'a declared trunk: the commands are read from that branch, not from the default branch',
    run: (root) => {
      const s = spoke(root, { values: { ...GOOD, LINT_COMMAND: 'false' }, branch: { name: 'harness-main', values: { ...GOOD, TRUNK_FOR_HUB: 'harness-main' } } });
      stage(s, { 'src/b.txt': 'let b = 2\n' });
      return check(s, { HARNESS_SPOKE_TRUNK: 'harness-main' });
    },
    exit: 0, includes: ['checks.env at origin/harness-main', '[PASS] LINT_COMMAND', 'COMMIT CHECKS PASSED.'], excludes: ['origin/main'],
  },
  {
    n: 37, name: 'a declared trunk whose TRUNK_FOR_HUB names another branch is exit 2, and both values are named',
    run: (root) => {
      const s = spoke(root, { branch: { name: 'harness-main', values: GOOD } });
      stage(s, { 'src/b.txt': 'let b = 2\n' });
      return check(s, { HARNESS_SPOKE_TRUNK: 'harness-main' });
    },
    exit: 2, includes: ['COMMIT CHECKS CANNOT VERIFY', 'the trunk is harness-main (from HARNESS_SPOKE_TRUNK)', 'TRUNK_FOR_HUB=default', 'The two must name the same branch'],
  },
  {
    n: 38, name: 'a declared trunk that origin does not have is exit 2',
    run: (root) => {
      const s = spoke(root);
      stage(s, { 'src/b.txt': 'let b = 2\n' });
      return check(s, { HARNESS_SPOKE_TRUNK: 'harness-main' });
    },
    exit: 2, includes: ['COMMIT CHECKS CANNOT VERIFY', 'the trunk is harness-main, and origin has no branch harness-main', 'REASON: trunk-missing'],
  },
  {
    n: 39, name: 'with no HARNESS_SPOKE_TRUNK, the trunk is TRUNK_FOR_HUB at HEAD, and a HEAD with the key missing is exit 2',
    run: (root) => {
      const s = spoke(root, { values: { ...GOOD, LINT_COMMAND: 'false' }, branch: { name: 'harness-main', values: { ...GOOD, TRUNK_FOR_HUB: 'harness-main' } } });
      stage(s, { 'src/b.txt': 'let b = 2\n' });
      const declared = check(s);
      git(s.work, ['reset', '-q']);
      commitByHand(s, { 'checks.env': envText({ ...GOOD, TRUNK_FOR_HUB: undefined }) });
      stage(s, { 'src/c.txt': 'let c = 3\n' });
      const missing = check(s);
      return { status: missing.status, output: `declared=${declared.status}\n${declared.output}\nmissing=${missing.status}\n${missing.output}` };
    },
    exit: 2, includes: ['declared=0', 'checks.env at origin/harness-main', '[PASS] LINT_COMMAND', 'missing=2', 'TRUNK_FOR_HUB is missing in checks.env at HEAD'],
  },
  {
    n: 40, name: 'the trunk option reaches the scan: SECRET_SCAN_COMMAND is read from the declared branch, not from the branch TRUNK_FOR_HUB at HEAD names',
    run: (root) => {
      // HEAD says default, where the scan is `true`; only the declared branch carries the real scanner.
      const s = spoke(root, { values: { ...GOOD, SECRET_SCAN_COMMAND: 'true' }, branch: { name: 'harness-main', values: { ...GOOD, TRUNK_FOR_HUB: 'harness-main' } }, cutFrom: 'main' });
      stage(s, { 'src/b.txt': `let key = '${TOKEN}'\n` });
      const script = `import { checkStaged } from ${JSON.stringify(pathToFileURL(STAGED).href)};
const r = checkStaged({ repo: '.', trunk: 'harness-main' });
process.stdout.write(r.report);
process.exit(r.code);`;
      return spawn(s.work, process.execPath, ['--input-type=module', '-e', script]);
    },
    exit: 1, includes: ['checks.env at origin/harness-main', '[FAIL] SECRET_SCAN_COMMAND', 'read from checks.env at origin/harness-main'],
  },
  {
    n: 41, name: '--head on the install\'s own branch runs the rows from checks.env at HEAD: a harness file the whole-tree linter fails is exit 1, and the branch passes once the file is clear',
    run: (root) => {
      // A linter over every tracked file, as a whole-tree formatter reads the harness files too.
      const s = spoke(root, { values: null });
      commitByHand(s, { 'checks.env': envText({ ...GOOD, LINT_COMMAND: '! git grep -n TODO -- . :!checks.env' }), '.githooks/pre-commit': '#!/usr/bin/env node\n// TODO\n' });
      const red = checkHead(s);
      commitByHand(s, { '.githooks/pre-commit': '#!/usr/bin/env node\n' });
      const clean = checkHead(s);
      return { status: red.status, output: `red=${red.status}\n${red.output}\nclean=${clean.status}\n${clean.output}` };
    },
    exit: 1,
    includes: ['red=1', 'checks.env at HEAD (blob', 'origin/main carries none yet, so this is the spoke install\'s own branch', '[FAIL] LINT_COMMAND', '.githooks/pre-commit:2:// TODO', 'clean=0', '[PASS] LINT_COMMAND', '[PASS] FORMAT_COMMAND'],
    excludes: ['NOT RUN'],
  },

  /* ---------------------------------------------------------- a trunk merge */
  {
    n: 42, name: 'a trunk merge with no conflict commits as a merge of the trunk commit: the scan runs, format, lint and type-check are skipped, and the trailer says so',
    run: (root) => {
      const s = spoke(root);
      commitByHand(s, { 'src/b.txt': 'let b = 2\n' });
      // The trunk's new file would fail the lint row: the trunk merge does not run it.
      const t = trunkMoves(s, { 'src/c.txt': 'let c = 3 // TODO\n' });
      startMerge(s, t);
      return mergeHelper(s, t);
    },
    exit: 0,
    includes: ['COMMIT CHECKS — a trunk merge into feature/SVC-1-change, from origin/main', "[PASS] trunk merge  git's own merge of", '[PASS] SECRET_SCAN_COMMAND', '[SKIPPED] FORMAT_COMMAND, LINT_COMMAND, TYPECHECK_COMMAND',
      'head-moved=true', 'parents=2', 'second=true', 'Harness-Check: trunk-merge', 'format, lint and type-check run on the merged tree before the push', 'Generated-by: SHL Agentic Harness'],
    excludes: ['[PASS] LINT_COMMAND', '[FAIL]'],
  },
  {
    n: 43, name: 'a trunk merge with a hand edit on top of git\'s result is exit 1, names the path, and commits nothing',
    run: (root) => {
      const s = spoke(root);
      commitByHand(s, { 'src/b.txt': 'let b = 2\n' });
      const t = trunkMoves(s, { 'src/c.txt': 'let c = 3\n' });
      startMerge(s, t);
      stage(s, { 'src/b.txt': 'let b = 22\n' });
      return mergeHelper(s, t);
    },
    exit: 1, includes: ["what is staged is not git's own merge result. These paths differ: src/b.txt", 'head-moved=false'], excludes: ['[PASS] SECRET_SCAN_COMMAND'],
  },
  {
    n: 44, name: 'a trunk merge that git left in conflict is exit 1: the paths are named, and the harness never resolves one',
    run: (root) => {
      const s = spoke(root);
      commitByHand(s, { 'src/a.txt': 'let a = 10\n' });
      const t = trunkMoves(s, { 'src/a.txt': 'let a = 20\n' });
      startMerge(s, t);
      return mergeHelper(s, t);
    },
    exit: 1, includes: ['git left 1 path(s) unmerged: src/a.txt', 'A person resolves a conflict. The harness never resolves one', 'head-moved=false'],
  },
  {
    n: 45, name: 'a merge of a commit that is not on the trunk is exit 1, even with no conflict',
    run: (root) => {
      const s = spoke(root);
      commitByHand(s, { 'src/b.txt': 'let b = 2\n' });
      const side = trunkMoves(s, { 'src/c.txt': 'let c = 3\n' }, { onTrunk: false });
      startMerge(s, side);
      return mergeHelper(s, side);
    },
    exit: 1, includes: ['is not on origin/main at', 'A trunk merge brings in the trunk and nothing else', 'head-moved=false'],
  },
  {
    n: 46, name: 'the trunk-merge flag with no merge in progress is exit 1',
    run: (root) => {
      const s = spoke(root);
      commitByHand(s, { 'src/b.txt': 'let b = 2\n' });
      const t = trunkMoves(s, { 'src/c.txt': 'let c = 3\n' });
      return mergeHelper(s, t);
    },
    exit: 1, includes: ['no merge is in progress. Run git merge --no-ff --no-commit', 'head-moved=false'],
  },
  {
    n: 47, name: 'the trunk merge reads the staged diff for secrets: a token the trunk brings in is exit 1',
    run: (root) => {
      const s = spoke(root);
      commitByHand(s, { 'src/b.txt': 'let b = 2\n' });
      const t = trunkMoves(s, { 'src/c.txt': `let key = '${TOKEN}'\n` });
      startMerge(s, t);
      return mergeHelper(s, t);
    },
    exit: 1, includes: ["[PASS] trunk merge  git's own merge of", '[FAIL] SECRET_SCAN_COMMAND', 'head-moved=false'],
  },
  {
    n: 48, name: 'a trunk merge with a subject that is not "chore(<KEY>): merge the trunk at <12 hex>", or that names another commit, is exit 3',
    run: (root) => {
      const s = spoke(root);
      commitByHand(s, { 'src/b.txt': 'let b = 2\n' });
      const t = trunkMoves(s, { 'src/c.txt': 'let c = 3\n' });
      startMerge(s, t);
      const shape = mergeHelper(s, t, { subject: 'Merge branch main' });
      const other = mergeHelper(s, t, { subject: `chore(SVC-1): merge the trunk at ${'0'.repeat(12)}` });
      return { status: other.status, output: `shape=${shape.status}\n${shape.output}\nother=${other.status}\n${other.output}` };
    },
    exit: 3, includes: ['shape=3', 'a trunk merge\'s subject is "chore(<KEY>): merge the trunk at <12 hex>"', 'other=3', 'the subject names the trunk at 000000000000', 'head-moved=false'],
  },
  {
    n: 49, name: 'the helper without the trunk-merge flag refuses to commit while a merge is in progress, even with nothing staged',
    run: (root) => {
      const s = spoke(root);
      commitByHand(s, { 'src/b.txt': 'let b = 2\n' });
      const t = trunkMoves(s, { 'src/c.txt': 'let c = 3\n' });
      startMerge(s, t);
      return helperMoved(s);
    },
    exit: 1, includes: ['COMMIT CHECKS — a merge is in progress', 'the harness commits a merge only with --trunk-merge <commit>', 'head-moved=false'],
  },
];

/* ---------------------------------------------------------------------- runner */

const args = process.argv.slice(2);
const keep = args.includes('--keep');
const only = new Set(args.filter((a) => /^\d+$/.test(a)).map(Number));
let failed = 0;
let ran = 0;
for (const f of FIXTURES) {
  if (only.size && !only.has(f.n)) continue;
  ran += 1;
  const root = mkdtempSync(join(tmpdir(), `staged-${f.n}-`));
  let r;
  try {
    r = f.run(root);
  } catch (err) {
    r = { status: 'threw', output: String(err && err.stack ? err.stack : err) };
  }
  const problems = [];
  if (r.status !== f.exit) problems.push(`exit ${r.status}, expected ${f.exit}`);
  for (const s of f.includes || []) if (!r.output.includes(s)) problems.push(`output lacks: ${s}`);
  for (const s of f.excludes || []) if (r.output.includes(s)) problems.push(`output should not contain: ${s}`);
  for (const re of f.matches || []) if (!re.test(r.output)) problems.push(`output does not match: ${re}`);
  if (problems.length) {
    failed += 1;
    console.log(`  FAIL  ${f.n}. ${f.name}\n        ${problems.join('\n        ')}\n${r.output.split('\n').map((l) => `        | ${l}`).join('\n')}`);
  } else {
    console.log(`  PASS  ${f.n}. ${f.name} [exit ${f.exit}]`);
  }
  if (!keep) rmSync(root, { recursive: true, force: true });
  else console.log(`        kept: ${root}`);
}
rmSync(SANDBOX_HOME, { recursive: true, force: true });
console.log(failed ? `\n${failed} of ${ran} fixtures failed.` : `\nAll ${ran} fixtures passed.`);
process.exit(failed ? 1 : 0);

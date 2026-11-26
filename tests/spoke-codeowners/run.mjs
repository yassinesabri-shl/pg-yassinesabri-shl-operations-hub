#!/usr/bin/env node
/**
 * run.mjs — the fixture suite for spoke-codeowners.mjs.
 *
 *   usage:  node run.mjs            run every fixture
 *           node run.mjs 3 7        run only the numbered fixtures
 *           node run.mjs --keep     leave the throwaway repositories on disk
 *
 * A fixture is a REPOSITORY STATE: a throwaway spoke with checks.env, a scanner, a coverage script
 * and, where the fixture says, a CODEOWNERS file. The shipped script runs against it as the spoke
 * install and the upgrade run it, one command or more in order. Each command's exit code and
 * output lines are asserted, and where the fixture says, the files on disk.
 *
 * Node standard library only, plus git via child_process. No test framework.
 * Exit 0 if every fixture passes, 1 if any fails.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

// Two layouts. The library: this suite at accelerator/gate/tests/spoke-codeowners/ and the script at
// accelerator/gate/. An installed hub: this suite at tests/spoke-codeowners/ and the script at scripts/.
function locate(label, candidates) {
  const found = candidates.filter(Boolean).find((p) => existsSync(p));
  if (!found) {
    console.error(`cannot locate ${label}. Looked in order:`);
    for (const c of candidates.filter(Boolean)) console.error(`  ${c}`);
    process.exit(4);
  }
  return found;
}
const UP = resolve(HERE, '..', '..');
const SCRIPT = locate('spoke-codeowners.mjs', [process.env.HARNESS_SPOKE_CODEOWNERS, join(UP, 'spoke-codeowners.mjs'), join(UP, 'scripts', 'spoke-codeowners.mjs')]);

/* ------------------------------------------------------------------ git helpers */

const SANDBOX_HOME = mkdtempSync(join(tmpdir(), 'spoke-codeowners-home-'));
const ENV = {
  ...process.env,
  HOME: SANDBOX_HOME,
  XDG_CONFIG_HOME: join(SANDBOX_HOME, '.config'),
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
  GIT_AUTHOR_NAME: 'Fixture Runner',
  GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'Fixture Runner',
  GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
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

function commitAll(repo, message) {
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '--allow-empty', '-m', message]);
}

const checksEnv = (values) => `${Object.entries(values).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${v}`).join('\n')}\n`;

const OWNER = '@example-org/svc-gate-owners';
const COMMANDS = {
  SECRET_SCAN_COMMAND: 'node scripts/secret-scan.mjs',
  COVERAGE_COMMAND: 'node tools/coverage.mjs --report=coverage/summary.txt',
  TRUNK_FOR_HUB: 'default',
};

/**
 * One spoke, committed. `checks` overrides keys of checks.env (null for no checks.env), and
 * `files` adds or removes files before the commit.
 */
function spoke(root, { checks = {}, files = {} } = {}) {
  const repo = join(root, 'svc');
  git(root, ['init', '-q', '--initial-branch', 'main', repo]);
  git(repo, ['config', 'commit.gpgsign', 'false']);
  writeFiles(repo, {
    'README.md': '# svc\n',
    'checks.env': checks === null ? null : checksEnv({ ...COMMANDS, ...checks }),
    '.githooks/pre-commit': '#!/usr/bin/env node\n',
    '.gitattributes': '.githooks/pre-commit text eol=lf\n',
    '.github/workflows/story-gate.yml': 'name: story-gate\n',
    'scripts/secret-scan.mjs': 'process.exit(0);\n',
    'tools/coverage.mjs': 'process.exit(0);\n',
    '.gitleaks.toml': '[allowlist]\n',
    ...files,
  });
  commitAll(repo, 'svc: first');
  return repo;
}

const sh = (repo, ...args) => ({ args: [args[0], '--repo', repo, ...args.slice(1)] });
const read = (repo, rel) => (existsSync(join(repo, rel)) ? readFileSync(join(repo, rel), 'utf8') : null);

// Every path the control's block covers, as the rule's first column.
const CONTROL_PATTERNS = ['/.github/workflows/story-gate.yml', '/checks.env', '/.githooks/pre-commit', '/.gitattributes', '/.github/CODEOWNERS', '/scripts/secret-scan.mjs', '/tools/coverage.mjs', '/.gitleaks.toml'];

const FIXTURES = [
  {
    n: 1,
    name: 'control: write the block into a spoke with no CODEOWNERS, commit it, and check it at HEAD',
    build: (root) => {
      const repo = spoke(root);
      return {
        repo,
        steps: [
          { ...sh(repo, 'write', '--owner', OWNER), exit: 0, includes: ['WRITTEN  .github/CODEOWNERS'] },
          { run: () => commitAll(repo, 'svc: the gate owners') },
          { ...sh(repo, 'check', '--ref', 'HEAD'), exit: 0, includes: ['GATE OWNERS PROTECTED', `gives ${OWNER} every gate file (workflows: gate)`] },
        ],
        files: (problems) => {
          const text = read(repo, '.github/CODEOWNERS') || '';
          for (const p of CONTROL_PATTERNS) if (!text.split('\n').some((l) => l.startsWith(`${p} `) && l.trim().endsWith(OWNER))) problems.push(`.github/CODEOWNERS has no rule ${p} ${OWNER}`);
        },
      };
    },
  },
  {
    n: 2,
    name: 'render prints the block from the working tree: the commands\' files, the scanner configuration, a --path file',
    build: (root) => {
      const repo = spoke(root);
      writeFiles(repo, { 'scripts/scan-rules.json': '{}\n' });
      return {
        repo,
        steps: [{ ...sh(repo, 'render', '--owner', OWNER, '--path', 'scripts/scan-rules.json'), exit: 0, includes: [...CONTROL_PATTERNS, '/scripts/scan-rules.json', '# BEGIN shl-harness gate owners', '# END shl-harness gate owners'], excludes: ['/coverage/summary.txt', '/README.md'] }],
      };
    },
  },
  {
    n: 3,
    name: '--workflows folder owns the whole workflows folder, and check accepts it',
    build: (root) => {
      const repo = spoke(root);
      return {
        repo,
        steps: [
          { ...sh(repo, 'write', '--owner', OWNER, '--workflows', 'folder'), exit: 0, includes: ['WRITTEN'] },
          { ...sh(repo, 'check'), exit: 0, includes: ['(workflows: folder)'] },
        ],
        files: (problems) => {
          const text = read(repo, '.github/CODEOWNERS') || '';
          if (!text.includes(`/.github/workflows/ `)) problems.push('the block has no /.github/workflows/ rule');
          if (text.includes('/.github/workflows/story-gate.yml')) problems.push('the block names the gate\'s file as well as the folder');
        },
      };
    },
  },
  {
    n: 4,
    name: 'a person as the owner is refused',
    build: (root) => {
      const repo = spoke(root);
      return { repo, steps: [{ ...sh(repo, 'write', '--owner', '@alice'), exit: 1, includes: ['the owner @alice is not a team'] }], files: (problems) => { if (read(repo, '.github/CODEOWNERS') !== null) problems.push('a CODEOWNERS file was written'); } };
    },
  },
  {
    n: 5,
    name: 'a CODEOWNERS file without the block is the team\'s: the block is proposed beside it, and the file stays as it is',
    build: (root) => {
      const team = '* @example-org/svc-developers\n/src/payments/ @example-org/payments\n';
      const repo = spoke(root, { files: { '.github/CODEOWNERS': team } });
      return {
        repo,
        steps: [
          { ...sh(repo, 'write', '--owner', OWNER), exit: 0, includes: ['PROPOSED  .github/CODEOWNERS.shl-new', 'stays as it is'] },
          { ...sh(repo, 'check'), exit: 1, includes: ['.github/CODEOWNERS holds no block'] },
        ],
        files: (problems) => {
          if (read(repo, '.github/CODEOWNERS') !== team) problems.push('.github/CODEOWNERS changed');
          const proposal = read(repo, '.github/CODEOWNERS.shl-new') || '';
          if (!proposal.startsWith(team)) problems.push('the proposal does not keep the team\'s rules first');
          if (!proposal.trimEnd().endsWith('# END shl-harness gate owners')) problems.push('the proposal does not end with the block');
        },
      };
    },
  },
  {
    n: 6,
    name: 'a block that is not at the end is replaced and moved to the end, and the team\'s rules stay',
    build: (root) => {
      const repo = spoke(root);
      execFileSync(process.execPath, [SCRIPT, 'write', '--repo', repo, '--owner', OWNER], { env: ENV });
      writeFiles(repo, { '.github/CODEOWNERS': `${read(repo, '.github/CODEOWNERS')}/src/ @example-org/svc-developers\n` });
      return {
        repo,
        steps: [
          { ...sh(repo, 'check'), exit: 1, includes: ['the rule for /src/ follows the block'] },
          { ...sh(repo, 'write', '--owner', OWNER), exit: 0, includes: ['REPLACED'] },
          { ...sh(repo, 'check'), exit: 0, includes: ['GATE OWNERS PROTECTED'] },
        ],
        files: (problems) => {
          const text = read(repo, '.github/CODEOWNERS') || '';
          if (!text.startsWith('/src/ @example-org/svc-developers\n')) problems.push('the team\'s rule did not stay, first in the file');
          if (!text.trimEnd().endsWith('# END shl-harness gate owners')) problems.push('the block is not at the end');
        },
      };
    },
  },
  {
    n: 7,
    name: 'check: no CODEOWNERS file at all',
    build: (root) => {
      const repo = spoke(root);
      return { repo, steps: [{ ...sh(repo, 'check', '--ref', 'HEAD'), exit: 1, includes: ['GATE OWNERS NOT PROTECTED', 'has no CODEOWNERS file in .github/CODEOWNERS, CODEOWNERS, docs/CODEOWNERS'] }] };
    },
  },
  {
    n: 8,
    name: 'check: a rule after the block can replace its owner',
    build: (root) => {
      const repo = spoke(root);
      execFileSync(process.execPath, [SCRIPT, 'write', '--repo', repo, '--owner', OWNER], { env: ENV });
      writeFiles(repo, { '.github/CODEOWNERS': `${read(repo, '.github/CODEOWNERS')}* @example-org/everyone\n` });
      return { repo, steps: [{ ...sh(repo, 'check'), exit: 1, includes: ['the rule for * follows the block', 'Move the block to the end'] }] };
    },
  },
  {
    n: 9,
    name: 'check: the team points SECRET_SCAN_COMMAND at a new script that the block does not cover',
    build: (root) => {
      const repo = spoke(root);
      execFileSync(process.execPath, [SCRIPT, 'write', '--repo', repo, '--owner', OWNER], { env: ENV });
      commitAll(repo, 'svc: the gate owners');
      writeFiles(repo, { 'checks.env': checksEnv({ ...COMMANDS, SECRET_SCAN_COMMAND: 'node scripts/new-scan.mjs --staged' }), 'scripts/new-scan.mjs': 'process.exit(0);\n' });
      commitAll(repo, 'svc: a new scanner');
      return { repo, steps: [{ ...sh(repo, 'check', '--ref', 'HEAD'), exit: 1, includes: ['the block does not cover /scripts/new-scan.mjs'], excludes: ['does not cover /scripts/secret-scan.mjs'] }] };
    },
  },
  {
    n: 10,
    name: 'check: the block is in docs/CODEOWNERS, and GitHub reads .github/CODEOWNERS first',
    build: (root) => {
      const repo = spoke(root);
      const block = execFileSync(process.execPath, [SCRIPT, 'render', '--repo', repo, '--owner', OWNER], { env: ENV, encoding: 'utf8' });
      writeFiles(repo, { 'docs/CODEOWNERS': block, '.github/CODEOWNERS': '* @example-org/svc-developers\n' });
      return { repo, steps: [{ ...sh(repo, 'check'), exit: 1, includes: ['docs/CODEOWNERS holds the block, but GitHub reads .github/CODEOWNERS and ignores docs/CODEOWNERS', '.github/CODEOWNERS holds no block'] }] };
    },
  },
  {
    n: 11,
    name: 'a command that runs a package.json script gets a note, and the block still renders',
    build: (root) => {
      const repo = spoke(root, { checks: { SECRET_SCAN_COMMAND: 'npm run secret-scan' } });
      return { repo, steps: [{ ...sh(repo, 'render', '--owner', OWNER), exit: 0, includes: ['SECRET_SCAN_COMMAND: `npm run secret-scan` runs a package.json script', '/checks.env'], excludes: ['/scripts/secret-scan.mjs'] }] };
    },
  },
  {
    n: 12,
    name: 'check --ref that is not a commit cannot verify',
    build: (root) => {
      const repo = spoke(root);
      return { repo, steps: [{ ...sh(repo, 'check', '--ref', 'no-such-branch'), exit: 2, includes: ['no-such-branch is not a commit'] }] };
    },
  },
  {
    n: 13,
    name: 'a spoke without checks.env cannot verify which commands run',
    build: (root) => {
      const repo = spoke(root, { checks: null });
      return { repo, steps: [{ ...sh(repo, 'render', '--owner', OWNER), exit: 2, includes: ['has no checks.env'] }] };
    },
  },
  {
    n: 14,
    name: 'check: a block that names two owners',
    build: (root) => {
      const repo = spoke(root);
      execFileSync(process.execPath, [SCRIPT, 'write', '--repo', repo, '--owner', OWNER], { env: ENV });
      const text = read(repo, '.github/CODEOWNERS').replace(`/checks.env`, '/checks.env').replace(/^(\/checks\.env\s+)\S+$/m, '$1@example-org/other-team');
      writeFiles(repo, { '.github/CODEOWNERS': text });
      return { repo, steps: [{ ...sh(repo, 'check'), exit: 1, includes: ['the block names 2 owners'] }] };
    },
  },
  {
    n: 15,
    name: 'a --path that leaves the repository is a usage error',
    build: (root) => {
      const repo = spoke(root);
      return { repo, steps: [{ ...sh(repo, 'render', '--owner', OWNER, '--path', '../outside.txt'), exit: 3, includes: ['--path ../outside.txt is not a path inside the repository'] }] };
    },
  },
  {
    n: 16,
    name: 'check --ref reads the commit, not the working tree: a block written but not committed is not there yet',
    build: (root) => {
      const repo = spoke(root);
      execFileSync(process.execPath, [SCRIPT, 'write', '--repo', repo, '--owner', OWNER], { env: ENV });
      return {
        repo,
        steps: [
          { ...sh(repo, 'check', '--ref', 'HEAD'), exit: 1, includes: ['has no CODEOWNERS file'] },
          { ...sh(repo, 'check'), exit: 0, includes: ['GATE OWNERS PROTECTED  the working tree'] },
        ],
      };
    },
  },
  {
    n: 17,
    name: 'write twice is idempotent',
    build: (root) => {
      const repo = spoke(root);
      execFileSync(process.execPath, [SCRIPT, 'write', '--repo', repo, '--owner', OWNER], { env: ENV });
      return { repo, steps: [{ ...sh(repo, 'write', '--owner', OWNER), exit: 0, includes: ['UNCHANGED  .github/CODEOWNERS'] }] };
    },
  },
];

/* ---------------------------------------------------------------------- runner */

function runFixture(fixture) {
  const root = mkdtempSync(join(tmpdir(), `spoke-codeowners-fx${String(fixture.n).padStart(2, '0')}-`));
  const outputs = [];
  try {
    const scripts = join(root, 'scripts');
    mkdirSync(scripts);
    copyFileSync(SCRIPT, join(scripts, 'spoke-codeowners.mjs'));
    const { steps, files } = fixture.build(root);
    const problems = [];
    for (const [i, step] of steps.entries()) {
      if (step.run) {
        step.run();
        continue;
      }
      const res = spawnSync(process.execPath, [join(scripts, 'spoke-codeowners.mjs'), ...step.args], { cwd: root, env: ENV, encoding: 'utf8' });
      const output = `${res.stdout || ''}${res.stderr || ''}`;
      outputs.push(`$ spoke-codeowners.mjs ${step.args[0]}\n${output}`);
      const at = `step ${i + 1} (${step.args[0]})`;
      if (res.status !== step.exit) problems.push(`${at}: expected exit ${step.exit}, got ${res.status}`);
      for (const needle of step.includes || []) if (!output.includes(needle)) problems.push(`${at}: output does not contain: ${JSON.stringify(needle)}`);
      for (const needle of step.excludes || []) if (output.includes(needle)) problems.push(`${at}: output should not contain: ${JSON.stringify(needle)}`);
    }
    if (files) files(problems);
    return { problems, output: outputs.join('\n') };
  } catch (err) {
    return { problems: [`fixture setup failed: ${err && err.message ? err.message : String(err)}`], output: outputs.join('\n') };
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
      process.stdout.write(`  FAIL  ${fixture.n}. ${fixture.name}\n`);
      for (const p of problems) process.stdout.write(`          - ${p}\n`);
      process.stdout.write(`${output.split('\n').map((l) => `          | ${l}`).join('\n')}\n`);
    } else {
      process.stdout.write(`  PASS  ${fixture.n}. ${fixture.name}\n`);
    }
  }
  process.stdout.write(failed
    ? `\n${failed} of ${selected.length} fixtures FAILED. The gate owners block is not trustworthy until this is green.\n`
    : `\nAll ${selected.length} fixtures passed.\n`);
  rmSync(SANDBOX_HOME, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
}

main();

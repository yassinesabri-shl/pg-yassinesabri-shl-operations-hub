#!/usr/bin/env node
// Part of the harness asset library c6f3b4427d58f7c3 (see VERSION.json) · 2026-10-24
/**
 * run.mjs — the fixture suite for feedback-context.mjs.
 *
 *   usage:  node run.mjs            run every fixture
 *           node run.mjs 3 7        run only the numbered fixtures
 *           node run.mjs --keep     leave the throwaway hubs on disk
 *
 * A fixture is a HUB STATE: a throwaway folder with a receipt, a git repository with an origin
 * remote, and a stand-in `claude` binary first on PATH. The shipped script runs in it as a hub
 * would run it. The script is never imported for the fixtures and never stubbed. Its output is
 * parsed as JSON and asserted field by field.
 *
 * Fixture 1 is the full control. Every other fixture removes or changes one thing.
 *
 * The one assertion every fixture makes: the output does not contain the hub's folder. A path
 * in a ticket is the leak this script exists to prevent.
 *
 * Node standard library only. No test framework.
 * Exit 0 if every fixture passes, 1 if any fails.
 */

import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

// Two layouts: the library, where the script is two levels up; and an adopting hub, where this
// suite lands at tests/feedback-context/ and the script at scripts/.
const first = (...c) => c.filter(Boolean).find((p) => existsSync(p));
const SCRIPT = first(
  process.env.HARNESS_FEEDBACK_CONTEXT,
  resolve(HERE, '..', '..', 'feedback-context.mjs'),
  resolve(HERE, '..', '..', 'scripts', 'feedback-context.mjs'),
);
if (!SCRIPT) {
  console.error('cannot locate feedback-context.mjs. Set HARNESS_FEEDBACK_CONTEXT=/path/to/feedback-context.mjs.');
  process.exit(4);
}

const KEEP = process.argv.includes('--keep');

/* ----------------------------------------------------------------------- the control hub */

const RECEIPT = {
  schema_version: 1,
  library: { harnessVersion: '0.9.3', libraryCommit: '2e76c8d0bd4ffc1bd4440efab10d119aaf66e812', contentHash: 'abc' },
  files: {},
};

const CONTROL = {
  receipt: RECEIPT,
  remote: 'https://github.com/example-org/example-hub.git',
  claude: '2.0.31 (Claude Code)',
};

function writeJson(root, rel, value) {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`);
}

function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
}

/** A hub folder, a bin folder with a stand-in `claude`, and the PATH the script runs under. */
function buildHub(root, state) {
  const hub = join(root, 'hub');
  const bin = join(root, 'bin');
  mkdirSync(hub, { recursive: true });
  mkdirSync(bin, { recursive: true });
  if (state.receipt !== null) writeJson(hub, 'docs/harness-install.json', state.receipt);
  if (state.git !== false) {
    git(hub, 'init', '-q');
    if (state.remote !== null) git(hub, 'remote', 'add', 'origin', state.remote);
  }
  if (state.claude !== null) {
    const stub = join(bin, 'claude');
    writeFileSync(stub, `#!/bin/sh\n${state.claude === 'fail' ? 'exit 1' : `echo "${state.claude}"`}\n`);
    chmodSync(stub, 0o755);
  }
  return { hub, path: `${bin}:/usr/bin:/bin` };
}

/* ------------------------------------------------------------------------------ fixtures */

const FIXTURES = [
  {
    n: 1, name: 'the control: a receipt, an https remote and a runtime', state: CONTROL, exit: 0,
    check: (o) => [
      o.harnessVersion === '0.9.3' || 'harnessVersion is not 0.9.3',
      o.libraryCommit === RECEIPT.library.libraryCommit || 'libraryCommit is not the receipt\'s',
      o.runtime === '2.0.31 (Claude Code)' || 'runtime is not what the stand-in printed',
      o.hub === 'example-org/example-hub' || `hub is ${o.hub}, not example-org/example-hub`,
      typeof o.node === 'string' && o.node.startsWith('v') || 'node is not a version',
      typeof o.os?.platform === 'string' && typeof o.os?.release === 'string' || 'os lacks platform or release',
      (typeof o.collectedOn === 'string' && o.collectedOn.search(/^\d{4}-\d{2}-\d{2}$/) === 0) || 'collectedOn is not a date',
    ],
  },
  {
    n: 2, name: 'no receipt: version and commit are null, nothing else changes', state: { ...CONTROL, receipt: null }, exit: 0,
    check: (o) => [o.harnessVersion === null || 'harnessVersion is not null', o.libraryCommit === null || 'libraryCommit is not null', o.hub === 'example-org/example-hub' || 'hub changed'],
  },
  {
    n: 3, name: 'a receipt that is not JSON: version and commit are null, exit 0', state: { ...CONTROL, receipt: '{ not json' }, exit: 0,
    check: (o) => [o.harnessVersion === null || 'harnessVersion is not null'],
  },
  {
    n: 4, name: 'a receipt with no library block: version and commit are null', state: { ...CONTROL, receipt: { schema_version: 1, files: {} } }, exit: 0,
    check: (o) => [o.harnessVersion === null || 'harnessVersion is not null', o.libraryCommit === null || 'libraryCommit is not null'],
  },
  {
    n: 5, name: 'an ssh remote: owner/repo without the host or the .git suffix', state: { ...CONTROL, remote: 'git@github.com:example-org/example-hub.git' }, exit: 0,
    check: (o) => [o.hub === 'example-org/example-hub' || `hub is ${o.hub}`],
  },
  {
    n: 6, name: 'an ssh:// remote: owner/repo', state: { ...CONTROL, remote: 'ssh://git@github.com/example-org/example-hub' }, exit: 0,
    check: (o) => [o.hub === 'example-org/example-hub' || `hub is ${o.hub}`],
  },
  {
    n: 7, name: 'a remote with a group path: the last two segments', state: { ...CONTROL, remote: 'https://gitlab.example.invalid/group/sub/example-hub.git' }, exit: 0,
    check: (o) => [o.hub === 'sub/example-hub' || `hub is ${o.hub}`],
  },
  {
    n: 8, name: 'no origin remote: hub is null', state: { ...CONTROL, remote: null }, exit: 0,
    check: (o) => [o.hub === null || `hub is ${o.hub}, not null`],
  },
  {
    n: 9, name: 'not a git repository: hub is null, exit 0', state: { ...CONTROL, git: false, remote: null }, exit: 0,
    check: (o) => [o.hub === null || `hub is ${o.hub}, not null`],
  },
  {
    n: 10, name: 'no claude binary on PATH: runtime is null, exit 0', state: { ...CONTROL, claude: null }, exit: 0,
    check: (o) => [o.runtime === null || `runtime is ${o.runtime}, not null`],
  },
  {
    n: 11, name: 'claude --version fails: runtime is null, exit 0', state: { ...CONTROL, claude: 'fail' }, exit: 0,
    check: (o) => [o.runtime === null || `runtime is ${o.runtime}, not null`],
  },
  {
    n: 12, name: 'a local path as the remote: hub is null, and the path is not printed', state: { ...CONTROL, remote: '/srv/git/example-hub.git' }, exit: 0,
    check: (o, raw) => [o.hub === null || `hub is ${o.hub}, not null`, !raw.includes('/srv/git') || 'the local remote path leaked'],
  },
  { n: 13, name: '--help: usage on stdout, exit 0', state: CONTROL, args: ['--help'], exit: 0, raw: (out) => [out.includes('usage:') || 'no usage line'] },
  { n: 14, name: 'an unknown argument: usage, exit 3', state: CONTROL, args: ['--verbose'], exit: 3, raw: (out) => [out.includes('usage:') || 'no usage line'] },
];

/* ------------------------------------------------------------------------------- runner */

function runFixture(f) {
  const root = mkdtempSync(join(tmpdir(), 'feedback-context-'));
  try {
    const { hub, path } = buildHub(root, f.state);
    const run = spawnSync(process.execPath, [SCRIPT, ...(f.args || [])], {
      cwd: hub, encoding: 'utf8', timeout: 20000, env: { PATH: path, HOME: root },
    });
    const output = `${run.stdout || ''}${run.stderr || ''}`;
    const problems = [];
    if (run.status !== f.exit) problems.push(`exit ${run.status}, expected ${f.exit}`);
    if (output.includes(root)) problems.push('the output contains the hub\'s folder');
    if (f.raw) for (const p of f.raw(output)) if (p !== true) problems.push(p);
    if (f.check) {
      let parsed = null;
      try {
        parsed = JSON.parse(run.stdout || '');
      } catch {
        problems.push('stdout is not one JSON object');
      }
      if (parsed) for (const p of f.check(parsed, output)) if (p !== true) problems.push(p);
    }
    if (run.error && run.error.code === 'ETIMEDOUT') problems.push('the script did not finish within 20 seconds');
    return { problems, output };
  } catch (err) {
    return { problems: [`fixture setup failed: ${err && err.message ? err.message : String(err)}`], output: '' };
  } finally {
    if (!KEEP) rmSync(root, { recursive: true, force: true });
  }
}

function main() {
  const wanted = process.argv.slice(2).filter((a) => a.search(/^\d+$/) === 0).map(Number);
  const selected = wanted.length ? FIXTURES.filter((f) => wanted.includes(f.n)) : FIXTURES;
  let failed = 0;
  for (const f of selected) {
    const { problems, output } = runFixture(f);
    if (problems.length) {
      failed += 1;
      process.stdout.write(`  FAIL  ${f.n}. ${f.name} [exit ${f.exit}]\n`);
      for (const p of problems) process.stdout.write(`          - ${p}\n`);
      process.stdout.write(`${output.split('\n').map((l) => `          | ${l}`).join('\n')}\n`);
    } else {
      process.stdout.write(`  PASS  ${f.n}. ${f.name} [exit ${f.exit}]\n`);
    }
  }
  process.stdout.write(failed
    ? `\n${failed} of ${selected.length} fixtures FAILED. The feedback context is not trustworthy until this is green.\n`
    : `\nAll ${selected.length} fixtures passed.\n`);
  process.exit(failed ? 1 : 0);
}

main();

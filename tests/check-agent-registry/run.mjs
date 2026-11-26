#!/usr/bin/env node
/**
 * run.mjs — the fixture suite for check-agent-registry.mjs.
 *
 *   usage:  node run.mjs            run every fixture
 *           node run.mjs 2 6        run only the numbered fixtures
 *           node run.mjs --keep     leave the throwaway hubs on disk
 *
 * A fixture is a HUB STATE: a throwaway hub root with a charter folder and an agent registry,
 * and the shipped script run from that root exactly as the `charters` job runs it. The check
 * reads the working tree and nothing else, so the state is files on disk; there is no remote
 * to build. The script is never imported and never stubbed. Exit code and failure text are
 * asserted. Fixture 1 is the valid control; most others change exactly one thing.
 *
 * Node standard library only. No test framework.
 * Exit 0 if every fixture passes, 1 if any fails.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

const SCRIPT = [
  process.env.HARNESS_CHECK_AGENT_REGISTRY,
  resolve(HERE, '..', '..', 'check-agent-registry.mjs'),
  resolve(HERE, '..', '..', 'scripts', 'check-agent-registry.mjs'),
].filter(Boolean).find((p) => existsSync(p));

if (!SCRIPT) {
  console.error('cannot locate check-agent-registry.mjs. Set HARNESS_CHECK_AGENT_REGISTRY=/path/to/check-agent-registry.mjs.');
  process.exit(4);
}

const SANDBOX_HOME = mkdtempSync(join(tmpdir(), 'agent-registry-home-'));
const ENV = { ...process.env, HOME: SANDBOX_HOME, XDG_CONFIG_HOME: join(SANDBOX_HOME, '.config') };

function writeFiles(root, files) {
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }
}

/* ------------------------------------------------------------------ the hub state */

const charter = (slug) => `---\nname: ${slug}\ndescription: a synthetic seat for the fixture suite\n---\n# ${slug}\n`;

// Only the fields the check reads, plus a purpose so an entry reads like one. The full schema is
// the installer's to validate.
const entry = (id, { status = 'active', path = `.claude/agents/${id}.md`, runtime = true } = {}) => ({
  schema_version: 1,
  agent_id: id,
  purpose: `The ${id} seat, synthetic.`,
  status,
  ...(runtime ? { runtime: { platform: 'primary agent runtime', isolation: 'subagent-fresh-context', ...(path === null ? {} : { definition_path: path }) } } : {}),
});

const registry = (entries) => `${JSON.stringify(entries, null, 2)}\n`;

// The valid control: two seats, a persona template that is not a seat, each seat registered.
const VALID = {
  '.claude/agents/engineer.md': charter('engineer'),
  '.claude/agents/test-writer.md': charter('test-writer'),
  '.claude/agents/persona-reviewer.template.md': charter('<persona-slug>'),
  'governance/agent-registry.json': registry([entry('engineer'), entry('test-writer')]),
};

const without = (files, ...paths) => Object.fromEntries(Object.entries(files).filter(([p]) => !paths.includes(p)));

const FIXTURES = [
  {
    n: 1,
    name: 'control: every charter has its entry, every active entry its charter, and a template is not a seat',
    files: VALID,
    exit: 0,
    includes: ['AGENT REGISTRY OK — 2 charter(s) in .claude/agents'],
    excludes: ['FAIL', 'persona-reviewer'],
  },
  {
    n: 2,
    name: 'a charter with no entry fails, naming the charter and the registry',
    files: { ...VALID, 'governance/agent-registry.json': registry([entry('engineer')]) },
    exit: 1,
    includes: ['FAIL .claude/agents/test-writer.md: no entry in governance/agent-registry.json with agent_id test-writer', 'AGENT REGISTRY FAILED — 1 finding(s).'],
    excludes: ['engineer.md: no entry'],
  },
  {
    n: 3,
    name: 'no registry at all fails, and says how many charters it leaves unregistered',
    files: without(VALID, 'governance/agent-registry.json'),
    exit: 1,
    includes: ['FAIL governance/agent-registry.json: not there, so none of the 2 charter(s) in .claude/agents is registered'],
  },
  {
    n: 4,
    name: 'a registry that is not JSON fails',
    files: { ...VALID, 'governance/agent-registry.json': '[ { "agent_id": "engineer", }\n' },
    exit: 1,
    includes: ['FAIL governance/agent-registry.json: not JSON'],
  },
  {
    n: 5,
    name: 'a registry that is an object, not a top-level array, fails',
    files: { ...VALID, 'governance/agent-registry.json': `${JSON.stringify({ agents: [entry('engineer'), entry('test-writer')] })}\n` },
    exit: 1,
    includes: ['FAIL governance/agent-registry.json: the registry is a top-level array of entries, and this is not one'],
  },
  {
    n: 6,
    name: 'an entry with an agent_id outside the grammar fails, and does not register the charter it was meant for',
    files: { ...VALID, 'governance/agent-registry.json': registry([entry('engineer'), { ...entry('test-writer'), agent_id: 'Test_Writer' }]) },
    exit: 1,
    includes: ['entry 2 has no agent_id in the schema\'s grammar', '"Test_Writer"', 'FAIL .claude/agents/test-writer.md: no entry'],
  },
  {
    n: 7,
    name: 'two entries with one agent_id fail, naming both',
    files: { ...VALID, 'governance/agent-registry.json': registry([entry('engineer'), entry('test-writer'), entry('engineer')]) },
    exit: 1,
    includes: ['agent_id engineer is used by entries 1 and 3'],
  },
  {
    n: 8,
    name: 'an entry whose definition_path is another file fails',
    files: { ...VALID, 'governance/agent-registry.json': registry([entry('engineer'), entry('test-writer', { path: '.claude/agents/engineer.md' })]) },
    exit: 1,
    includes: ['the entry for test-writer names runtime.definition_path .claude/agents/engineer.md, not the charter at .claude/agents/test-writer.md'],
  },
  {
    n: 9,
    name: 'a definition_path written with a leading ./ is the same path',
    files: { ...VALID, 'governance/agent-registry.json': registry([entry('engineer', { path: './.claude/agents/engineer.md' }), entry('test-writer')]) },
    exit: 0,
    includes: ['AGENT REGISTRY OK'],
  },
  {
    n: 10,
    name: 'an active entry whose charter is gone fails',
    files: { ...VALID, 'governance/agent-registry.json': registry([entry('engineer'), entry('test-writer'), entry('gate-runner')]) },
    exit: 1,
    includes: ['the entry for gate-runner is active, and its charter .claude/agents/gate-runner.md is not there'],
  },
  {
    n: 11,
    name: 'a retired entry may outlive its charter',
    files: { ...VALID, 'governance/agent-registry.json': registry([entry('engineer'), entry('test-writer'), entry('gate-runner', { status: 'retired' })]) },
    exit: 0,
    includes: ['AGENT REGISTRY OK'],
  },
  {
    n: 12,
    name: 'an active entry that names no definition_path fails',
    files: { ...VALID, 'governance/agent-registry.json': registry([entry('engineer'), entry('test-writer', { path: null })]) },
    exit: 1,
    includes: ['the entry for test-writer is active and names no runtime.definition_path'],
  },
  {
    n: 13,
    name: 'every failure is listed in one run',
    files: { ...VALID, 'governance/agent-registry.json': registry([entry('engineer'), entry('engineer'), entry('gate-runner')]) },
    exit: 1,
    includes: ['agent_id engineer is used by entries 1 and 2', 'FAIL .claude/agents/test-writer.md: no entry', 'the entry for gate-runner is active', 'AGENT REGISTRY FAILED — 3 finding(s).'],
  },
  {
    n: 14,
    name: 'no charter folder cannot verify: this is not a hub\'s root',
    files: { 'governance/agent-registry.json': registry([entry('engineer')]) },
    exit: 2,
    includes: ['CANNOT VERIFY: no charter folder at .claude/agents', 'REASON: file-unreadable'],
  },
  {
    n: 15,
    name: '--registry and --agents name other paths',
    files: {
      'seats/engineer.md': charter('engineer'),
      'gov/agents.json': registry([entry('engineer', { path: 'seats/engineer.md' })]),
    },
    args: ['--registry', 'gov/agents.json', '--agents', 'seats'],
    exit: 0,
    includes: ['AGENT REGISTRY OK — 1 charter(s) in seats'],
  },
  {
    n: 16,
    name: 'an unknown argument is usage',
    files: VALID,
    args: ['--offline'],
    exit: 3,
    includes: ['unknown argument: --offline', 'usage: node'],
  },
];

/* ---------------------------------------------------------------------- runner */

function runFixture(fixture) {
  const root = mkdtempSync(join(tmpdir(), `agent-registry-fx${String(fixture.n).padStart(2, '0')}-`));
  try {
    writeFiles(root, fixture.files);
    const res = spawnSync(process.execPath, [SCRIPT, ...(fixture.args || [])], { cwd: root, env: ENV, encoding: 'utf8' });
    const output = `${res.stdout || ''}${res.stderr || ''}`;
    const problems = [];
    if (res.status !== fixture.exit) problems.push(`expected exit ${fixture.exit}, got ${res.status}`);
    for (const needle of fixture.includes || []) if (!output.includes(needle)) problems.push(`output does not contain: ${needle}`);
    for (const needle of fixture.excludes || []) if (output.includes(needle)) problems.push(`output should not contain: ${needle}`);
    return { problems, output };
  } finally {
    if (!process.argv.includes('--keep')) rmSync(root, { recursive: true, force: true });
  }
}

function main() {
  const wanted = process.argv.slice(2).filter((a) => /^\d+$/.test(a)).map(Number);
  const selected = wanted.length ? FIXTURES.filter((f) => wanted.includes(f.n)) : FIXTURES;
  process.stdout.write(`script under test: ${SCRIPT}\n${selected.length} of ${FIXTURES.length} fixtures\n\n`);
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
  process.stdout.write(failed ? `\n${failed} of ${selected.length} fixtures FAILED.\n` : `\nAll ${selected.length} fixtures passed.\n`);
  rmSync(SANDBOX_HOME, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
}

main();

#!/usr/bin/env node
// Part of the harness asset library c6f3b4427d58f7c3 (see VERSION.json) · 2026-10-01
/**
 * check-agent-registry.mjs — does every agent the hub can dispatch have an entry?
 *
 *   usage:  node scripts/check-agent-registry.mjs [--registry <file>] [--agents <dir>]
 *
 *   --registry  the agent registry; default governance/agent-registry.json
 *   --agents    the folder of agent charters; default .claude/agents
 *
 * The rule it enforces is the governance one: no unregistered agent operates. A charter in
 * .claude/agents is an agent the runtime can dispatch, so each one needs an entry, and an
 * entry that says it is active needs a charter to govern. It reads the working tree, like
 * the charter-size check beside it in the `charters` job, because it judges the pull request
 * in front of it and not a remote.
 *
 * Rules, all run before it exits:
 *   1. The registry is there, parses, and is a top-level array of objects.
 *   2. Every entry has an `agent_id` in the schema's grammar, and no two entries share one.
 *   3. Every charter `<agents>/<slug>.md` (a `*.template.md` is a template, not an agent) has
 *      an entry whose `agent_id` is `<slug>`.
 *   4. Where that entry names `runtime.definition_path`, it is the charter's own path.
 *   5. An entry whose `status` is `active` names a `runtime.definition_path`, and the file is
 *      there. Any other status may outlive its charter: only `active` may be dispatched.
 *
 * Exit codes, shared with every check in the library:
 *   0  every charter is registered and every active entry has its charter
 *   1  a rule failed; every failure is listed
 *   2  cannot verify: the charter folder is not there, so this is not a hub's root
 *   3  usage
 *   4  internal
 *
 * What this script cannot see
 *   - Whether an entry is right. It checks the entry exists and points at the charter, not
 *     that its tool grant, model or owner match what the charter says. The schema
 *     (governance/agent-registry.schema.json) is the contract for the rest of the entry, and
 *     the installer validates each entry against it.
 *   - An agent that runs without a charter in .claude/agents. It checks the folder it is given.
 */

import { existsSync, readFileSync, readdirSync, statSync, writeSync } from 'node:fs';
import { join, posix } from 'node:path';
import { stdout, stderr } from 'node:process';

const EXIT = { PASS: 0, FAIL: 1, CANNOT_VERIFY: 2, USAGE: 3, INTERNAL: 4 };
const AGENT_ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;

function usage(message) {
  const invoked = process.argv[1] || 'scripts/check-agent-registry.mjs';
  stderr.write(`${message}\nusage: node ${invoked} [--registry <file>] [--agents <dir>]\n`);
  process.exit(EXIT.USAGE);
}

function parseArgs(argv) {
  const opts = { registry: 'governance/agent-registry.json', agents: '.claude/agents' };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--registry' || a === '--agents') {
      const v = argv[i + 1];
      if (!v || v.startsWith('--')) usage(`${a} needs a path`);
      opts[a.slice(2)] = v;
      i += 1;
    } else {
      usage(`unknown argument: ${a}`);
    }
  }
  return opts;
}

// Repository paths are compared as written in the registry: forward slashes, no leading ./
const normalise = (p) => posix.normalize(String(p).replace(/\\/g, '/')).replace(/^\.\//, '');

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!existsSync(opts.agents) || !statSync(opts.agents).isDirectory()) {
    stderr.write(`CANNOT VERIFY: no charter folder at ${opts.agents}; run this from the hub's root, or name the folder with --agents\nREASON: file-unreadable\n`);
    return EXIT.CANNOT_VERIFY;
  }
  const charters = readdirSync(opts.agents)
    .filter((n) => n.endsWith('.md') && !n.endsWith('.template.md'))
    .sort()
    .map((n) => ({ slug: n.slice(0, -'.md'.length), path: normalise(join(opts.agents, n)) }));

  const failures = [];
  const fail = (message) => failures.push(message);

  // Rule 1.
  let entries = null;
  if (!existsSync(opts.registry)) {
    fail(`${opts.registry}: not there, so none of the ${charters.length} charter(s) in ${opts.agents} is registered`);
  } else {
    try {
      entries = JSON.parse(readFileSync(opts.registry, 'utf8'));
    } catch (err) {
      fail(`${opts.registry}: not JSON (${err.message})`);
    }
    if (entries !== null && !Array.isArray(entries)) {
      fail(`${opts.registry}: the registry is a top-level array of entries, and this is not one`);
      entries = null;
    }
  }

  // Rule 2.
  const byId = new Map();
  for (const [i, e] of (entries || []).entries()) {
    if (e === null || typeof e !== 'object' || Array.isArray(e)) {
      fail(`${opts.registry}: entry ${i + 1} is not an object`);
      continue;
    }
    if (typeof e.agent_id !== 'string' || !AGENT_ID.test(e.agent_id)) {
      fail(`${opts.registry}: entry ${i + 1} has no agent_id in the schema's grammar (lower-case words joined by hyphens); found ${JSON.stringify(e.agent_id)}`);
      continue;
    }
    if (byId.has(e.agent_id)) {
      fail(`${opts.registry}: agent_id ${e.agent_id} is used by entries ${byId.get(e.agent_id).at + 1} and ${i + 1}; an id names one agent`);
      continue;
    }
    byId.set(e.agent_id, { at: i, entry: e });
  }
  const definitionPath = (e) => (e.runtime && typeof e.runtime === 'object' && typeof e.runtime.definition_path === 'string' ? e.runtime.definition_path : null);

  // Rules 3 and 4.
  if (entries) {
    for (const c of charters) {
      const found = byId.get(c.slug);
      if (!found) {
        fail(`${c.path}: no entry in ${opts.registry} with agent_id ${c.slug}; add one, validated against governance/agent-registry.schema.json, in the same pull request as the charter`);
        continue;
      }
      const named = definitionPath(found.entry);
      if (named !== null && normalise(named) !== c.path) {
        fail(`${opts.registry}: the entry for ${c.slug} names runtime.definition_path ${named}, not the charter at ${c.path}`);
      }
    }
  }

  // Rule 5.
  for (const [id, { entry }] of byId) {
    if (entry.status !== 'active') continue;
    const named = definitionPath(entry);
    if (named === null) {
      fail(`${opts.registry}: the entry for ${id} is active and names no runtime.definition_path, so it governs no charter`);
    } else if (!existsSync(named)) {
      fail(`${opts.registry}: the entry for ${id} is active, and its charter ${named} is not there; restore the charter, or move the entry out of active`);
    }
  }

  for (const f of failures) stdout.write(`FAIL ${f}\n`);
  if (failures.length) {
    stdout.write(`AGENT REGISTRY FAILED — ${failures.length} finding(s).\n`);
    return EXIT.FAIL;
  }
  stdout.write(`AGENT REGISTRY OK — ${charters.length} charter(s) in ${opts.agents}, each with its entry; every active entry has its charter.\n`);
  return EXIT.PASS;
}

// The last line of an exit 2, 3 or 4 names this script and its code, so a shell line that hides
// the code, with a pipe or `; echo`, still tells the harness's failure record. Written at once,
// so a process.exit() never loses it.
process.on('exit', (code) => { if (code >= 2 && code <= 4) { try { writeSync(2, `HARNESS EXIT: check-agent-registry ${code}\n`); } catch { /* stderr is closed */ } } });

try {
  process.exit(main());
} catch (err) {
  stderr.write(`INTERNAL: ${err && err.stack ? err.stack : String(err)}\n`);
  process.exit(EXIT.INTERNAL);
}

#!/usr/bin/env node
// Part of the harness asset library c6f3b4427d58f7c3 (see VERSION.json) · 2026-10-24
/**
 * feedback-context.mjs — the context `/feedback` adds to a Jira ticket, as one JSON object.
 *
 *   usage:  node scripts/feedback-context.mjs          print the context for the hub in the current folder
 *           node scripts/feedback-context.mjs --help
 *
 * The command runs this script and copies its output into the ticket. The script decides what
 * the ticket may carry, so the decision is in one testable place and not in a prompt.
 *
 * What it prints
 *   - harnessVersion   from docs/harness-install.json, or null when the hub has no receipt
 *   - libraryCommit    the library commit the receipt names, or null
 *   - runtime          the version `claude --version` prints, or null when the binary is absent
 *   - node             this Node version
 *   - os               the platform and the release, as Node reports them
 *   - hub              the origin remote as `owner/repo`, or null when there is no remote
 *   - collectedOn      today's date, as YYYY-MM-DD
 *
 * What it never prints
 *   - a file path, including the hub's own folder
 *   - a prompt, a file's contents or a diff
 *   - an environment variable or a credential
 *
 * Nothing here is a failure. A fact that cannot be read is null, and the ticket says so. The one
 * exit code other than 0 is 3, for an argument this script does not know.
 *
 * Node standard library only.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeSync } from 'node:fs';
import { platform, release } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const EXIT = { PASS: 0, USAGE: 3 };
const RECEIPT_PATH = 'docs/harness-install.json';

function usage(code) {
  const out = code === EXIT.PASS ? process.stdout : process.stderr;
  out.write('usage: node scripts/feedback-context.mjs [--help]\nPrints the context /feedback adds to a ticket, as JSON. Prints no path.\n');
  process.exit(code);
}

/** The receipt's library block, or nulls when the hub has none or it cannot be read. */
function receiptFacts(root) {
  const path = join(root, RECEIPT_PATH);
  if (!existsSync(path)) return { harnessVersion: null, libraryCommit: null };
  try {
    const receipt = JSON.parse(readFileSync(path, 'utf8'));
    const library = receipt && typeof receipt.library === 'object' && receipt.library !== null ? receipt.library : {};
    return {
      harnessVersion: typeof library.harnessVersion === 'string' ? library.harnessVersion : null,
      libraryCommit: typeof library.libraryCommit === 'string' ? library.libraryCommit : null,
    };
  } catch {
    return { harnessVersion: null, libraryCommit: null };
  }
}

/** One command's first output line, or null when it is absent or fails. Never throws. */
function firstLine(command, args, cwd) {
  const r = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'] });
  if (r.error || r.status !== 0 || typeof r.stdout !== 'string') return null;
  const line = r.stdout.split('\n').find((l) => l.trim() !== '');
  return line ? line.trim() : null;
}

/**
 * `owner/repo` from a clone URL, or null. Handles `https://host/owner/repo.git`,
 * `git@host:owner/repo.git` and `ssh://git@host/owner/repo`. The host is dropped on purpose: the
 * ticket names the hub, not where it is hosted. A local path is never a remote worth naming.
 */
export function hubName(url) {
  if (typeof url !== 'string' || url.trim() === '') return null;
  let rest = url.trim();
  const scheme = rest.indexOf('://');
  if (scheme >= 0) {
    rest = rest.slice(scheme + 3);
    const slash = rest.indexOf('/');
    if (slash < 0) return null;
    rest = rest.slice(slash + 1);
  } else {
    const colon = rest.indexOf(':');
    if (colon < 0) return null;
    rest = rest.slice(colon + 1);
  }
  const parts = rest.split('/').filter((p) => p !== '');
  if (parts.length < 2) return null;
  const repo = parts[parts.length - 1].endsWith('.git') ? parts[parts.length - 1].slice(0, -4) : parts[parts.length - 1];
  const owner = parts[parts.length - 2];
  if (owner === '' || repo === '') return null;
  return `${owner}/${repo}`;
}

export function collect(root = process.cwd()) {
  const receipt = receiptFacts(root);
  return {
    harnessVersion: receipt.harnessVersion,
    libraryCommit: receipt.libraryCommit,
    runtime: firstLine('claude', ['--version'], root),
    node: process.version,
    os: { platform: platform(), release: release() },
    hub: hubName(firstLine('git', ['remote', 'get-url', 'origin'], root)),
    collectedOn: new Date().toISOString().slice(0, 10),
  };
}

function main(argv) {
  if (argv.includes('--help') || argv.includes('-h')) usage(EXIT.PASS);
  if (argv.length > 0) usage(EXIT.USAGE);
  process.stdout.write(`${JSON.stringify(collect(), null, 2)}\n`);
  process.exit(EXIT.PASS);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // The last line of an exit 2, 3 or 4 names this script and its code, so a shell line that hides
  // the code, with a pipe or `; echo`, still tells the harness's failure record. Written at once,
  // so a process.exit() never loses it.
  process.on('exit', (code) => { if (code >= 2 && code <= 4) { try { writeSync(2, `HARNESS EXIT: feedback-context ${code}\n`); } catch { /* stderr is closed */ } } });
  main(process.argv.slice(2));
}

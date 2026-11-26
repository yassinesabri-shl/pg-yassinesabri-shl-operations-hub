#!/usr/bin/env node
// Charter size lint: agent charters stay thin (target 20–60 lines, hard cap 80).
// Method depth belongs in the skill a charter loads, not in the charter itself.
//
// The same bytes run in the library and in a hub, so the upgrade can replace an installed copy
// and prove the hub with it. The folder is found from where this file sits: the library keeps
// its charters in accelerator/agents, and a hub keeps them in .claude/agents.
// Exit codes: 0 every charter within the cap · 1 a charter over it · 2 no charter folder found.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FOLDERS = [join('accelerator', 'agents'), join('.claude', 'agents')];
const CAP = 80;

const found = FOLDERS.find((f) => existsSync(join(ROOT, f)));
if (!found) {
  console.error(`CANNOT VERIFY — no charter folder under ${ROOT}: looked for ${FOLDERS.join(' and ')}.`);
  process.exit(2);
}
const DIR = join(ROOT, found);

let failures = 0;
for (const name of readdirSync(DIR)) {
  if (!name.endsWith('.md') || name.endsWith('.template.md')) continue;
  const path = join(DIR, name);
  const lines = readFileSync(path, 'utf8').split('\n').length;
  if (lines > CAP) {
    console.error(`FAIL ${relative(ROOT, path)}: ${lines} lines (cap ${CAP})`);
    failures += 1;
  }
}

if (failures > 0) {
  console.error(`${failures} charter(s) over the ${CAP}-line cap.`);
  process.exit(1);
}
console.log(`Charter sizes OK — all agent charters in ${found} within the ${CAP}-line cap.`);

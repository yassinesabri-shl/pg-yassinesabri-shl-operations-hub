#!/usr/bin/env node
// Part of the harness asset library c6f3b4427d58f7c3 (see VERSION.json) · 2026-11-10
/**
 * spoke-codeowners.mjs — the CODEOWNERS block that protects a spoke's gate files.
 *
 *   usage:  node scripts/spoke-codeowners.mjs render --repo <dir> --owner <@org/team> [--workflows gate|folder] [--path <file>]...
 *           node scripts/spoke-codeowners.mjs write  --repo <dir> --owner <@org/team> [--workflows gate|folder] [--path <file>]...
 *           node scripts/spoke-codeowners.mjs check  --repo <dir> [--ref <commit-or-branch>]
 *
 * The story-gate workflow runs on the `pull_request` event, so GitHub runs the copy of the
 * workflow in the pull request. The secret scan runs the scanner in the pull request too. A pull
 * request can therefore change how it is judged, unless a person who owns the gate reviews every
 * change to these files. This script writes the one block of CODEOWNERS lines that names that
 * person's team, and checks that the block is still there and complete.
 *
 * The block covers:
 *   - checks.env, the pre-commit hook .githooks/pre-commit, and .gitattributes
 *   - the story-gate workflow, or the whole .github/workflows/ folder (`--workflows folder`)
 *   - the CODEOWNERS file itself
 *   - each file that SECRET_SCAN_COMMAND or COVERAGE_COMMAND in checks.env names and that exists
 *   - each scanner configuration file at the root that this script knows by name
 *   - each file given with `--path`
 *
 * render   prints the block. It reads the working tree, because the install writes checks.env
 *          before its first commit.
 * write    writes the block into the CODEOWNERS file that GitHub reads. With no CODEOWNERS file,
 *          it writes .github/CODEOWNERS. A file that holds the block gets the new block in its
 *          place, moved to the end. A file without the block is the team's: the script writes
 *          the file with the block at its end beside it, as <file>.shl-new, and changes nothing
 *          else. A person reads the proposal and moves it into place.
 * check    reads the CODEOWNERS file at `--ref` (default HEAD), or the working tree without
 *          `--ref`, and runs every rule before it exits:
 *            1. GitHub reads the file that holds the block. GitHub reads the first of
 *               .github/CODEOWNERS, CODEOWNERS and docs/CODEOWNERS that exists.
 *            2. The file holds exactly one block, between its begin and end lines.
 *            3. Every rule in the block names one owner, a team in the form @org/team.
 *            4. The block covers every path in the list above, read at the same ref.
 *            5. No rule follows the block. In CODEOWNERS the last matching rule wins, so a later
 *               rule such as `* @someone` would replace the block's owner.
 *
 * The owner is a team, never a person: a person leaves, and a team keeps the review possible.
 * This script cannot see whether the team has write access, or whether the trunk requires a review
 * from code owners. GitHub ignores an owner without write access, and a CODEOWNERS review blocks
 * nothing until branch protection requires it. The spoke install checks both with `gh`.
 * INTEGRATION POINT: the CODEOWNERS file, its three places and its rule form are GitHub's. Another
 * host keeps its owners elsewhere.
 *
 * Exit codes: 0 pass or written · 1 a rule failed, or the owner is not a team · 2 cannot verify
 * (no checks.env, no such ref) · 3 usage · 4 internal. Node standard library only, plus git.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const EXIT = { PASS: 0, FAIL: 1, CANNOT_VERIFY: 2, USAGE: 3, INTERNAL: 4 };
export const BEGIN = '# BEGIN shl-harness gate owners';
export const END = '# END shl-harness gate owners';
// GitHub reads the first of these that exists.
export const PLACES = ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS'];
export const STORY_GATE = '.github/workflows/story-gate.yml';
export const WORKFLOWS_FOLDER = '.github/workflows/';
// The gate's own files, beside the workflow and CODEOWNERS.
export const FIXED = ['checks.env', '.githooks/pre-commit', '.gitattributes'];
// The commands whose files the block covers. Each runs code from the pull request in story-gate.
export const COMMAND_KEYS = ['SECRET_SCAN_COMMAND', 'COVERAGE_COMMAND'];
// Scanner configuration files at the root, by the names their tools read by default.
export const SCANNER_CONFIGS = [
  '.gitleaks.toml', '.gitleaksignore', '.secretlintrc', '.secretlintrc.json', '.secretlintrc.yml',
  '.secretlintrc.yaml', '.secretlintignore', '.secrets.baseline', '.trufflehogignore', '.talismanrc',
];
// A team: @org/team. GitHub's organisation and team slugs.
const TEAM = /^@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[A-Za-z0-9][A-Za-z0-9._-]*$/;
// The package managers whose `run <script>` keeps the command's body in package.json.
const PACKAGE_RUNNERS = ['npm', 'pnpm', 'yarn', 'bun'];

export class OwnersError extends Error {
  // `reason` is a token of REASONS in scripts/spoke-remote.mjs, which this gate does not import.
  // `make reasons` proves the tokens.
  constructor(code, message, reason = null) {
    super(message);
    this.code = code;
    this.reason = reason;
  }
}

export const isTeam = (owner) => String(owner).search(TEAM) === 0;

function git(dir, args) {
  const res = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (res.error) throw new OwnersError(EXIT.INTERNAL, `git could not run: ${res.error.message}`);
  return res;
}

/**
 * A view of the spoke: the working tree, or one commit. `read` returns the text or null, and
 * `isFile` says whether a path is a file there.
 */
export function treeSource(repo) {
  return {
    label: 'the working tree',
    read: (rel) => (existsSync(join(repo, rel)) && statSync(join(repo, rel)).isFile() ? readFileSync(join(repo, rel), 'utf8') : null),
    isFile: (rel) => existsSync(join(repo, rel)) && statSync(join(repo, rel)).isFile(),
  };
}

export function refSource(repo, ref) {
  const res = git(repo, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  if (res.status !== 0) throw new OwnersError(EXIT.CANNOT_VERIFY, `${ref} is not a commit in ${repo}`, 'commit-not-found');
  const commit = res.stdout.trim();
  const type = (rel) => {
    const t = git(repo, ['cat-file', '-t', `${commit}:${rel}`]);
    return t.status === 0 ? t.stdout.trim() : null;
  };
  return {
    label: `${ref} (${commit.slice(0, 12)})`,
    read: (rel) => {
      if (type(rel) !== 'blob') return null;
      return git(repo, ['show', `${commit}:${rel}`]).stdout;
    },
    isFile: (rel) => type(rel) === 'blob',
  };
}

function parseEnv(text) {
  const map = new Map();
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const m = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if (m && !map.has(m[1])) map.set(m[1], m[2].trim());
  }
  return map;
}

// A path inside the repository, in the form CODEOWNERS and git use, or null when the token
// cannot be one: an option, a variable, an absolute path, or a path that leaves the repository.
function repoPath(token) {
  let t = token.replace(/^['"]|['"]$/g, '').replace(/\\/g, '/');
  const eq = t.indexOf('=');
  if (t.startsWith('-')) {
    if (eq < 0) return null;
    t = t.slice(eq + 1);
  }
  if (t === '' || t.includes('$') || t.includes('%') || t.startsWith('/') || t.search(/^[A-Za-z]:/) === 0 || t.startsWith('~')) return null;
  const parts = [];
  for (const p of t.split('/')) {
    if (p === '' || p === '.') continue;
    if (p === '..') return null;
    parts.push(p);
  }
  return parts.length ? parts.join('/') : null;
}

/**
 * The files one command names that exist in the source, and one note when the command runs a
 * package.json script, whose body the block cannot cover by itself.
 */
export function commandFiles(command, source) {
  const files = [];
  const notes = [];
  const words = String(command).split(/\s+|&&|\|\||;|\|/).filter(Boolean);
  if (PACKAGE_RUNNERS.includes(words[0]) && !words.slice(1).some((w) => repoPath(w) && source.isFile(repoPath(w)))) {
    notes.push(`\`${command}\` runs a package.json script. CODEOWNERS cannot protect one script in package.json. Point the command at the script file, for example \`node scripts/secret-scan.mjs\`, or name package.json with --path`);
  }
  for (const w of words) {
    const p = repoPath(w);
    if (p && source.isFile(p) && !files.includes(p)) files.push(p);
  }
  return { files, notes };
}

/**
 * Every path the block must cover, read from one source. `workflowsLine` is the workflow path the
 * block uses: the gate's file, or the whole folder. Throws when the source has no checks.env.
 */
export function requiredPaths(source, { codeowners = PLACES[0], extra = [] } = {}) {
  const checks = source.read('checks.env');
  if (checks === null) throw new OwnersError(EXIT.CANNOT_VERIFY, `${source.label} has no checks.env, so the commands that run in story-gate cannot be read`, 'config-invalid');
  const env = parseEnv(checks);
  const paths = [...FIXED, codeowners];
  const notes = [];
  for (const key of COMMAND_KEYS) {
    const value = env.get(key);
    if (!value || ['none', 'UNRESOLVED'].includes(value)) continue;
    const found = commandFiles(value, source);
    for (const f of found.files) if (!paths.includes(f)) paths.push(f);
    notes.push(...found.notes.map((n) => `${key}: ${n}`));
  }
  for (const name of SCANNER_CONFIGS) if (source.isFile(name) && !paths.includes(name)) paths.push(name);
  for (const e of extra) {
    const p = repoPath(e);
    if (!p) throw new OwnersError(EXIT.USAGE, `--path ${e} is not a path inside the repository`);
    if (!paths.includes(p)) paths.push(p);
  }
  return { paths, notes };
}

// A CODEOWNERS pattern for one path, anchored at the root. A space is escaped, as GitHub reads it.
const pattern = (p) => `/${p.replace(/ /g, '\\ ')}`;

/** The block, as lines, ending with a newline. */
export function renderBlock({ owner, workflows = 'gate', paths }) {
  if (!isTeam(owner)) throw new OwnersError(EXIT.FAIL, `the owner ${owner || '(none)'} is not a team. Name a team as @org/team, never a person: a person leaves, and a team keeps the review possible`);
  if (!['gate', 'folder'].includes(workflows)) throw new OwnersError(EXIT.USAGE, `--workflows takes gate or folder, not ${workflows}`);
  const rows = [workflows === 'folder' ? WORKFLOWS_FOLDER : STORY_GATE, ...paths];
  const width = Math.max(...rows.map((r) => pattern(r).length));
  return [
    BEGIN,
    '# These files decide how story-gate judges a pull request. A change to any of them needs a',
    `# review from ${owner}. spoke-codeowners.mjs writes this block. Keep it the last rules of the file,`,
    '# because the last rule that matches a path wins.',
    ...rows.map((r) => `${pattern(r).padEnd(width)} ${owner}`),
    END,
    '',
  ].join('\n');
}

/** Split a CODEOWNERS text at the block. `block` is null where there is none. */
export function splitBlock(text) {
  const lines = String(text).split(/\r?\n/);
  const begins = lines.map((l, i) => (l.trim() === BEGIN ? i : -1)).filter((i) => i >= 0);
  const ends = lines.map((l, i) => (l.trim() === END ? i : -1)).filter((i) => i >= 0);
  if (!begins.length && !ends.length) return { before: lines, block: null, after: [], problems: [] };
  const problems = [];
  if (begins.length !== 1 || ends.length !== 1) problems.push(`the file holds ${begins.length} begin and ${ends.length} end lines of the block, not one of each`);
  const b = begins[0] ?? 0;
  const e = ends.find((i) => i > b);
  if (e === undefined) {
    problems.push('the block has no end line after its begin line');
    return { before: lines.slice(0, b), block: lines.slice(b), after: [], problems };
  }
  return { before: lines.slice(0, b), block: lines.slice(b, e + 1), after: lines.slice(e + 1), problems };
}

// A rule line: a pattern and its owners. Comments and blank lines are not rules.
function rule(line) {
  const t = line.trim();
  if (t === '' || t.startsWith('#')) return null;
  const m = t.match(/^((?:\\ |\S)+)\s*(.*)$/);
  return { pattern: m[1], owners: m[2].split(/\s+/).filter(Boolean) };
}

/** The file GitHub reads, from a source, or null. */
export function codeownersFile(source) {
  return PLACES.find((p) => source.isFile(p)) || null;
}

/** Every finding of `check`, as sentences. Empty means the block passes. */
export function checkOwners(source, { extra = [] } = {}) {
  const findings = [];
  const read = PLACES.filter((p) => source.isFile(p));
  if (!read.length) return { findings: [`${source.label} has no CODEOWNERS file in ${PLACES.join(', ')}`], file: null, owner: null };
  const file = read[0];
  const others = read.slice(1).filter((p) => splitBlock(source.read(p)).block);
  for (const p of others) findings.push(`${p} holds the block, but GitHub reads ${file} and ignores ${p}`);
  const parts = splitBlock(source.read(file));
  if (!parts.block) {
    findings.push(`${file} holds no block between "${BEGIN}" and "${END}"`);
    return { findings, file, owner: null };
  }
  findings.push(...parts.problems.map((p) => `${file}: ${p}`));
  const rules = parts.block.map(rule).filter(Boolean);
  const owners = new Set(rules.flatMap((r) => r.owners));
  for (const r of rules) {
    if (r.owners.length !== 1) findings.push(`${file}: the block's rule for ${r.pattern} names ${r.owners.length} owners, not one team`);
    for (const o of r.owners) if (!isTeam(o)) findings.push(`${file}: the block's rule for ${r.pattern} names ${o}, which is not a team in the form @org/team`);
  }
  if (owners.size > 1) findings.push(`${file}: the block names ${owners.size} owners (${[...owners].join(', ')}), not one team`);
  const covered = new Set(rules.map((r) => r.pattern));
  let required;
  try {
    required = requiredPaths(source, { codeowners: file, extra });
  } catch (err) {
    if (!(err instanceof OwnersError)) throw err;
    findings.push(err.message);
    required = { paths: [], notes: [] };
  }
  if (!covered.has(pattern(STORY_GATE)) && !covered.has(pattern(WORKFLOWS_FOLDER))) findings.push(`${file}: the block covers neither ${pattern(STORY_GATE)} nor ${pattern(WORKFLOWS_FOLDER)}`);
  for (const p of required.paths) if (!covered.has(pattern(p))) findings.push(`${file}: the block does not cover ${pattern(p)}`);
  const later = parts.after.map(rule).filter(Boolean);
  for (const r of later) findings.push(`${file}: the rule for ${r.pattern} follows the block. The last rule that matches a path wins, so it can replace the block's owner. Move the block to the end`);
  return { findings, file, owner: owners.size === 1 ? [...owners][0] : null, notes: required.notes, workflows: covered.has(pattern(WORKFLOWS_FOLDER)) ? 'folder' : 'gate', patterns: [...covered] };
}

/**
 * What `write` does to one repository's working tree, without writing: the path to write and its
 * text, and whether it is the CODEOWNERS file itself or a proposal beside it.
 */
export function planWrite(repo, { owner, workflows = 'gate', extra = [] }) {
  const source = treeSource(repo);
  const file = codeownersFile(source) || PLACES[0];
  const { paths, notes } = requiredPaths(source, { codeowners: file, extra });
  const block = renderBlock({ owner, workflows, paths });
  const current = source.read(file);
  if (current === null) return { path: file, text: block, kind: 'written', file, notes };
  const parts = splitBlock(current);
  const body = (lines) => {
    const kept = [...lines];
    while (kept.length && kept[kept.length - 1].trim() === '') kept.pop();
    return kept.length ? `${kept.join('\n')}\n\n` : '';
  };
  if (parts.block && !parts.problems.length) {
    const text = `${body([...parts.before, ...parts.after])}${block}`;
    return { path: file, text, kind: text === current ? 'unchanged' : 'replaced', file, notes };
  }
  if (parts.problems.length) throw new OwnersError(EXIT.FAIL, `${file}: ${parts.problems.join('; ')}. Repair the begin and end lines by hand first`);
  return { path: `${file}.shl-new`, text: `${body(parts.before)}${block}`, kind: 'proposed', file, notes };
}

/* ------------------------------------------------------------------------- CLI */

function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!['render', 'write', 'check'].includes(command)) throw new OwnersError(EXIT.USAGE, 'the first argument is render, write or check');
  const o = { command, extra: [], workflows: 'gate' };
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i];
    const value = () => {
      const v = rest[i + 1];
      if (v === undefined || v.startsWith('--')) throw new OwnersError(EXIT.USAGE, `${a} needs a value`);
      i += 1;
      return v;
    };
    if (a === '--repo') o.repo = value();
    else if (a === '--owner') o.owner = value();
    else if (a === '--workflows') o.workflows = value();
    else if (a === '--path') o.extra.push(value());
    else if (a === '--ref') o.ref = value();
    else throw new OwnersError(EXIT.USAGE, `unknown argument ${a}`);
  }
  if (!o.repo) throw new OwnersError(EXIT.USAGE, '--repo <dir> is required');
  if (command !== 'check' && !o.owner) throw new OwnersError(EXIT.USAGE, `${command} needs --owner <@org/team>`);
  if (command !== 'check' && o.ref) throw new OwnersError(EXIT.USAGE, `--ref belongs to check, not ${command}`);
  if (command === 'check' && (o.owner || o.workflows !== 'gate')) throw new OwnersError(EXIT.USAGE, 'check reads the owner and the workflows line from the block, so it takes no --owner or --workflows');
  return o;
}

function main(argv) {
  const o = parseArgs(argv);
  const repo = resolve(o.repo);
  if (!existsSync(repo)) throw new OwnersError(EXIT.CANNOT_VERIFY, `${repo} does not exist`, 'not-a-checkout');
  const say = (line) => process.stdout.write(`${line}\n`);
  const note = (line) => process.stderr.write(`NOTE  ${line}\n`);
  if (o.command === 'render') {
    const source = treeSource(repo);
    const { paths, notes } = requiredPaths(source, { codeowners: codeownersFile(source) || PLACES[0], extra: o.extra });
    process.stdout.write(renderBlock({ owner: o.owner, workflows: o.workflows, paths }));
    notes.forEach(note);
    return EXIT.PASS;
  }
  if (o.command === 'write') {
    const plan = planWrite(repo, { owner: o.owner, workflows: o.workflows, extra: o.extra });
    if (plan.kind !== 'unchanged') {
      mkdirSync(dirname(join(repo, plan.path)), { recursive: true });
      writeFileSync(join(repo, plan.path), plan.text);
    }
    const said = {
      written: `WRITTEN  ${plan.path}: the block, owned by ${o.owner}`,
      replaced: `REPLACED  the block in ${plan.path}, owned by ${o.owner}, at the end of the file`,
      unchanged: `UNCHANGED  ${plan.path} already holds this block`,
      proposed: `PROPOSED  ${plan.path}: ${plan.file} with the block at its end. ${plan.file} is the team's file, so it stays as it is. Read the proposal, then move it into place`,
    };
    say(said[plan.kind]);
    plan.notes.forEach(note);
    return EXIT.PASS;
  }
  const source = o.ref ? refSource(repo, o.ref) : treeSource(repo);
  const result = checkOwners(source);
  (result.notes || []).forEach(note);
  if (result.findings.length) {
    say(`GATE OWNERS NOT PROTECTED  ${source.label}`);
    for (const f of result.findings) say(`  - ${f}`);
    return EXIT.FAIL;
  }
  say(`GATE OWNERS PROTECTED  ${source.label}: ${result.file} gives ${result.owner} every gate file (workflows: ${result.workflows})`);
  return EXIT.PASS;
}

const invoked = (() => {
  try {
    return process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (invoked) {
  // The last line of an exit 2, 3 or 4 names this script and its code, so a shell line that hides
  // the code, with a pipe or `; echo`, still tells the harness's failure record. Written at once,
  // so a process.exit() never loses it.
  process.on('exit', (code) => { if (code >= 2 && code <= 4) { try { writeSync(2, `HARNESS EXIT: spoke-codeowners ${code}\n`); } catch { /* stderr is closed */ } } });
  let code;
  try {
    code = main(process.argv.slice(2));
  } catch (err) {
    if (err instanceof OwnersError) {
      process.stderr.write(`spoke-codeowners: ${err.message}\n`);
      if (err.code === EXIT.CANNOT_VERIFY && err.reason) process.stderr.write(`REASON: ${err.reason}\n`);
      code = err.code;
    } else {
      process.stderr.write(`spoke-codeowners: internal error: ${err && err.stack ? err.stack : String(err)}\n`);
      code = EXIT.INTERNAL;
    }
  }
  process.exit(code);
}

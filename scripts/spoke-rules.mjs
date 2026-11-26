// Part of the harness asset library c6f3b4427d58f7c3 (see VERSION.json) · 2026-09-14
/**
 * spoke-rules.mjs — a spoke's own rules: where they are, what shape they have,
 * and which of them bind a given change.
 *
 * Shared by read-spoke-rules.mjs, check-spoke-rules.mjs and check-registry.mjs.
 * Not a command. It owns four things so the three scripts cannot drift apart:
 *
 *   - the commands file's flat `KEY=value` grammar and the three states of its
 *     `RULES_INDEX` key: a folder path, `none`, or not configured (missing, empty
 *     or `UNRESOLVED`); and the one state of `SECRET_SCAN_COMMAND` that passes, a
 *     command, which `secret-scan.cjs` runs and every spoke must declare; and
 *     the grammar of `HUBS`, the hubs a spoke belongs to, by key prefix, and
 *     of `HARNESS_LIBRARY`, the library the spoke's harness files came from;
 *   - the shape of one rule file: the frontmatter every rule in the library
 *     carries (`name`, `description`, `globs`, `alwaysApply`), one optional key
 *     (`overrides`: the hub or global standards, or single standard rules, this
 *     rule replaces where it binds), a body, and a line cap -- the same cap
 *     `.claude/rules/context-budget.md` puts on a charter, because a rule that
 *     needs more than that is a manual;
 *   - the shape of the folder: flat, `.md` only, names unique, exactly one
 *     always-on rule. A malformed folder binds nobody, so the checkers refuse it
 *     whole rather than loading the half that parses;
 *   - selection: the always-on rule plus every rule whose globs match a path the
 *     design says it touches. Nothing loads a rule by glob here; a script selects
 *     by glob and hands the text in, which is a different thing and is written
 *     down as one in `.claude/rules/estate.md`.
 *
 * Exit codes are the gate's, reported by the scripts that import this:
 *   0 pass · 1 verified and failed · 2 cannot verify · 3 usage · 4 internal.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { catBlobs, git, objectType, parseChecksEnv, quietGitEnv } from './spoke-remote.mjs';

export const RULES_INDEX_KEY = 'RULES_INDEX';
export const RULE_LINE_CAP = 80;
export const RULE_REQUIRED_KEYS = ['name', 'description', 'globs', 'alwaysApply'];
export const RULE_OVERRIDES_KEY = 'overrides';
export const RULE_KEYS = [...RULE_REQUIRED_KEYS, RULE_OVERRIDES_KEY];
export const RULE_NAME = /^[a-z0-9][a-z0-9-]*$/;
// One entry of `overrides`: a hub standard (`std-<topic>`), one of its rules
// (`std-<topic>.<NN>`), or the same with the `global.` prefix for a standard of
// the global context repository. A decision record is never an entry: a spoke
// rule says *how*, and a record decides *what*. `context-docs.mjs` reads the
// same grammar when it marks the standard rules a spoke rule replaces.
export const OVERRIDE_ID = /^((?:global\.)?std-[a-z0-9]+(?:-[a-z0-9]+)*)(\.\d{2,})?$/;
// The value a design's `Rules:` line carries when a spoke declares a folder:
// the folder as a citation, so the design says which commit of which folder it
// was written under. `check-dev-ready.js` applies the same grammar by hand.
export const RULES_CITE = /^([A-Za-z0-9][A-Za-z0-9._-]*)@([0-9a-f]{12}):(.+)$/;
export const RULES_NONE = 'none';
export const SECRET_SCAN_KEY = 'SECRET_SCAN_COMMAND';
export const HUBS_KEY = 'HUBS';
// One entry of HUBS: the prefix of the keys a hub mints, and the hub as the host
// names it. `story-gate.workflow.yml` applies the same grammar in shell, where
// nothing here can be imported.
export const HUBS_ENTRY = /^([A-Z][A-Z0-9]{1,9}) ([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)$/;
export const LIBRARY_KEY = 'HARNESS_LIBRARY';
// `<harnessVersion> <full library commit>`. `scripts/upgrade.mjs` in the library writes it and
// reads it with the same grammar.
export const LIBRARY_VALUE = /^(\d+\.\d+\.\d+\S*|unknown) ([0-9a-f]{40})$/;

const RELATIVE_PATH = /^(?!\/)(?!.*(^|\/)\.\.(\/|$)).+$/;
const CATCH_ALL = /^(\*\*|\*\*\/\*|\*\*\/\*\*|\*)$/;

/* ------------------------------------------------------------- commands file */

// The commands file's reader lives in spoke-remote.mjs, beside the trunk rule
// that reads TRUNK_FOR_HUB with it. Exported here too, for this file's callers.
export { parseChecksEnv };

/**
 * The three states of RULES_INDEX, and a fourth for a value that is none of them.
 *   { state: 'path', path }            a folder, relative to the repository root
 *   { state: 'none' }                  declared on purpose: no written rules
 *   { state: 'not-configured' }        missing, empty or UNRESOLVED
 *   { state: 'invalid', value }        absolute, climbing, or otherwise not a path
 */
export function rulesIndexState(map) {
  const value = map.get(RULES_INDEX_KEY);
  if (value === undefined || value === '' || value === 'UNRESOLVED') return { state: 'not-configured' };
  if (value === RULES_NONE) return { state: 'none' };
  const path = value.replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+$/, '');
  if (path === '' || path === '.' || !RELATIVE_PATH.test(path) || path.split('/').some((s) => s === '')) {
    return { state: 'invalid', value };
  }
  return { state: 'path', path };
}

/**
 * SECRET_SCAN_COMMAND is mandatory in every spoke, and only a command passes.
 *   { state: 'command', command }
 *   { state: 'missing' | 'empty' | 'unresolved' | 'none' }   each refused
 * `secret-scan.cjs` applies the same reading in the spoke, where nothing here can be imported.
 */
export function secretScanState(map) {
  const value = map.get(SECRET_SCAN_KEY);
  if (value === undefined) return { state: 'missing' };
  if (value === '') return { state: 'empty' };
  if (value === 'UNRESOLVED') return { state: 'unresolved' };
  if (value === 'none') return { state: 'none' };
  return { state: 'command', command: value };
}

/**
 * HUBS is mandatory in every spoke: story-gate reads it to choose the hub to clone.
 *   { state: 'hubs', hubs: [{ prefix, hub }] }   in the order written
 *   { state: 'not-configured' }                  missing, empty or UNRESOLVED
 *   { state: 'invalid', findings }               an entry out of grammar, or a prefix twice
 */
export function hubsState(map) {
  const value = map.get(HUBS_KEY);
  if (value === undefined || value === '' || value === 'UNRESOLVED') return { state: 'not-configured' };
  const findings = [];
  const hubs = [];
  for (const raw of value.split(',')) {
    const text = raw.trim();
    const m = text.match(HUBS_ENTRY);
    if (!m) {
      findings.push(`the ${HUBS_KEY} entry "${text}" is not "<PREFIX> <owner>/<repo>"`);
      continue;
    }
    if (hubs.some((h) => h.prefix === m[1])) findings.push(`${HUBS_KEY} lists the prefix ${m[1]} more than once; one prefix names one hub`);
    else hubs.push({ prefix: m[1], hub: m[2] });
  }
  return findings.length ? { state: 'invalid', findings } : { state: 'hubs', hubs };
}

/**
 * HARNESS_LIBRARY, the spoke's own receipt, written by the install and every upgrade.
 *   { state: 'recorded', version, commit, major }   major is null for `unknown`
 *   { state: 'not-configured' }                     missing, empty or UNRESOLVED
 *   { state: 'invalid', value }
 */
export function libraryState(map) {
  const value = map.get(LIBRARY_KEY);
  if (value === undefined || value === '' || value === 'UNRESOLVED') return { state: 'not-configured' };
  const m = value.match(LIBRARY_VALUE);
  if (!m) return { state: 'invalid', value };
  return { state: 'recorded', version: m[1], commit: m[2], major: m[1] === 'unknown' ? null : Number(m[1].split('.')[0]) };
}

export function readLibraryAt(dir, commit, checksPath) {
  if (objectType(dir, commit, checksPath) !== 'blob') return null;
  return libraryState(parseChecksEnv(git(['--git-dir', dir, 'cat-file', 'blob', `${commit}:${checksPath}`])));
}

export function readHubsAt(dir, commit, checksPath) {
  if (objectType(dir, commit, checksPath) !== 'blob') return null;
  return hubsState(parseChecksEnv(git(['--git-dir', dir, 'cat-file', 'blob', `${commit}:${checksPath}`])));
}

/** The same reading of the commands file at a commit in the cache; null where there is no file. */
export function readSecretScanAt(dir, commit, checksPath) {
  if (objectType(dir, commit, checksPath) !== 'blob') return null;
  return secretScanState(parseChecksEnv(git(['--git-dir', dir, 'cat-file', 'blob', `${commit}:${checksPath}`])));
}

/* ---------------------------------------------------------------- one rule */

/**
 * Parse one rule file. Returns the rule with its findings; a rule with findings
 * is malformed and must not be loaded. Findings are prefixed with the path so a
 * folder report reads line by line.
 */
export function parseRule(path, text) {
  const findings = [];
  const at = (m) => findings.push(`${path}: ${m}`);
  const lines = String(text).split(/\r?\n/);
  const lineCount = text.endsWith('\n') ? lines.length - 1 : lines.length;
  const rule = { path, name: null, description: null, globs: [], alwaysApply: null, overrides: [], body: '', lineCount, findings };

  if (lines[0] !== '---') {
    at('does not open with a frontmatter line "---" on line 1');
    return rule;
  }
  const close = lines.indexOf('---', 1);
  if (close === -1) {
    at('frontmatter is never closed with a second "---"');
    return rule;
  }
  const seen = new Set();
  for (let i = 1; i < close; i += 1) {
    const line = lines[i];
    if (line.trim() === '') continue;
    const m = line.match(/^([A-Za-z][A-Za-z0-9_-]*):[ \t]*(.*?)\s*$/);
    if (!m) {
      at(`frontmatter line ${i + 1} is not "key: value": ${JSON.stringify(line)}`);
      continue;
    }
    const [, key, value] = m;
    if (!RULE_KEYS.includes(key)) {
      at(`frontmatter key "${key}" is not one of ${RULE_KEYS.join(', ')}`);
      continue;
    }
    if (seen.has(key)) {
      at(`frontmatter key "${key}" appears twice`);
      continue;
    }
    seen.add(key);
    if (key === 'name') {
      if (!RULE_NAME.test(value)) at(`name "${value}" must be lowercase letters, digits and hyphens`);
      rule.name = value;
    } else if (key === 'description') {
      if (value === '') at('description is empty');
      rule.description = value;
    } else if (key === 'globs') {
      let parsed;
      try {
        parsed = JSON.parse(value);
      } catch {
        parsed = undefined;
      }
      if (!Array.isArray(parsed) || parsed.length === 0 || parsed.some((g) => typeof g !== 'string' || g.trim() === '')) {
        at(`globs must be a one-line JSON array of non-empty strings, got ${JSON.stringify(value)}`);
      } else {
        rule.globs = parsed;
      }
    } else if (key === 'alwaysApply') {
      if (value !== 'true' && value !== 'false') at(`alwaysApply must be the literal true or false, got ${JSON.stringify(value)}`);
      else rule.alwaysApply = value === 'true';
    } else if (key === RULE_OVERRIDES_KEY) {
      rule.overrides = parseOverrides(value, at);
    }
  }
  for (const key of RULE_REQUIRED_KEYS) {
    if (!seen.has(key)) at(`frontmatter is missing "${key}"`);
  }
  rule.body = lines.slice(close + 1).join('\n');
  if (!rule.body.split('\n').some((l) => l.trim() !== '')) at('has no body after the frontmatter');
  if (lineCount > RULE_LINE_CAP) at(`is ${lineCount} lines; the cap is ${RULE_LINE_CAP}. Move method to a skill or split the contract`);
  if (rule.alwaysApply === false && rule.globs.some((g) => CATCH_ALL.test(g.trim()))) {
    at(`is path-scoped but its globs match everything (${rule.globs.map((g) => JSON.stringify(g)).join(', ')}); a rule that binds every change is alwaysApply: true`);
  }
  return rule;
}

/**
 * The `overrides` value: a one-line JSON array of standard ids and standard
 * rule ids, each once, none inside a standard the same array names whole. The
 * form is all a spoke can check, because a spoke reads no hub and no global
 * repository; `read-context.mjs` checks that each id names a standard, and a
 * rule it defines, when the hub reads the spoke.
 */
function parseOverrides(value, at) {
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    parsed = undefined;
  }
  if (!Array.isArray(parsed) || parsed.some((o) => typeof o !== 'string')) {
    at(`${RULE_OVERRIDES_KEY} must be a one-line JSON array of strings, got ${JSON.stringify(value)}`);
    return [];
  }
  if (parsed.length === 0) {
    at(`${RULE_OVERRIDES_KEY} is empty; drop the key when the rule overrides nothing`);
    return [];
  }
  const out = [];
  for (const id of parsed) {
    const m = id.match(OVERRIDE_ID);
    if (!m) {
      at(`${RULE_OVERRIDES_KEY} entry ${JSON.stringify(id)} is not a standard, std-<topic>, or one of its rules, std-<topic>.<NN>, with or without the global. prefix; a decision record is never overridden`);
      continue;
    }
    if (out.includes(id)) {
      at(`${RULE_OVERRIDES_KEY} names ${id} twice`);
      continue;
    }
    out.push(id);
  }
  for (const id of out) {
    const [, standard, rulePart] = id.match(OVERRIDE_ID);
    if (rulePart && out.includes(standard)) at(`${RULE_OVERRIDES_KEY} names ${id} and the whole of ${standard}; name one or the other`);
  }
  return out;
}

/** The standard an override entry belongs to, and the rule it names, or null for the whole standard. */
export function overrideTarget(id) {
  const m = id.match(OVERRIDE_ID);
  return m ? { standard: m[1], rule: m[2] ? id : null } : null;
}

/* --------------------------------------------------------------- the folder */

/**
 * Validate a folder's entries as a set. `entries` is [{ path, type, text }] with
 * `type` 'blob' or 'tree' and `text` the file body for blobs. Returns the rules
 * in folder order and every finding; a set with findings binds nobody.
 */
export function validateRuleSet(folder, entries) {
  const findings = [];
  const rules = [];
  const sorted = [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  for (const e of sorted) {
    if (e.type === 'tree') {
      findings.push(`${e.path}: is a folder; the rules folder is flat`);
      continue;
    }
    if (e.type !== 'blob') {
      findings.push(`${e.path}: is a ${e.type}, which is not a rule file`);
      continue;
    }
    if (!e.path.endsWith('.md')) {
      findings.push(`${e.path}: is not a ".md" file; the rules folder holds rules and nothing else`);
      continue;
    }
    const rule = parseRule(e.path, e.text);
    findings.push(...rule.findings);
    rules.push(rule);
  }
  const names = new Map();
  for (const r of rules) {
    if (r.name === null) continue;
    if (names.has(r.name)) findings.push(`${r.path}: name "${r.name}" is already used by ${names.get(r.name)}`);
    else names.set(r.name, r.path);
  }
  const alwaysOn = rules.filter((r) => r.alwaysApply === true);
  if (rules.length === 0) {
    findings.push(`${folder}: holds no rule files; declare RULES_INDEX=none instead of an empty folder`);
  } else if (alwaysOn.length === 0) {
    findings.push(`${folder}: no rule is alwaysApply: true; exactly one always-on rule carries the repository's stack, naming and commit conventions`);
  } else if (alwaysOn.length > 1) {
    findings.push(`${folder}: ${alwaysOn.length} rules are alwaysApply: true (${alwaysOn.map((r) => r.path).join(', ')}); exactly one is always on, the rest are path-scoped`);
  }
  return { rules, findings };
}

/* --------------------------------------------------------------- selection */

/** A glob to an anchored regular expression: `**`, `*`, `?`, `{a,b}`. */
export function globToRegExp(glob) {
  let out = '^';
  const g = glob.replace(/^\.\/+/, '');
  for (let i = 0; i < g.length; i += 1) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        i += 1;
        if (g[i + 1] === '/') {
          i += 1;
          out += '(?:.*/)?';
        } else {
          out += '.*';
        }
      } else {
        out += '[^/]*';
      }
    } else if (c === '?') {
      out += '[^/]';
    } else if (c === '{') {
      const end = g.indexOf('}', i);
      if (end === -1) {
        out += '\\{';
      } else {
        out += `(?:${g.slice(i + 1, end).split(',').map(escapeRe).join('|')})`;
        i = end;
      }
    } else {
      out += escapeRe(c);
    }
  }
  return new RegExp(`${out}$`);
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** True when the path matches a positive glob and no negative (`!`) glob. */
export function matchesGlobs(path, globs) {
  const p = path.replace(/\\/g, '/').replace(/^\.\/+/, '');
  let positive = false;
  for (const raw of globs) {
    const negative = raw.startsWith('!');
    const re = globToRegExp(negative ? raw.slice(1) : raw);
    if (re.test(p)) {
      if (negative) return false;
      positive = true;
    }
  }
  return positive;
}

/** The always-on rule first, then the path-scoped rules in folder order. */
export function orderRules(rules) {
  return [...rules.filter((r) => r.alwaysApply === true), ...rules.filter((r) => r.alwaysApply !== true)];
}

/** The always-on rule, then every path-scoped rule a path matches, in folder order. */
export function selectRules(rules, paths) {
  return orderRules(rules).filter((r) => r.alwaysApply === true || paths.some((p) => matchesGlobs(p, r.globs)));
}

/**
 * The `Path` column of the first table under the design's "Components changed
 * or added" heading, numbered or not. Fenced lines, header and separator rows,
 * placeholders and duplicates are skipped.
 */
export function designPaths(text) {
  const lines = String(text).split(/\r?\n/);
  const heading = /^#{2,4}\s+(?:\d+(?:\.\d+)*\.?\s+)?Components changed or added\s*$/;
  const paths = [];
  let fence = null;
  let inSection = false;
  let inTable = false;
  let rowIndex = 0;
  for (const line of lines) {
    const fenceOpen = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (fence) {
      if (fenceOpen && fenceOpen[1][0] === fence[0] && fenceOpen[1].length >= fence.length) fence = null;
      continue;
    }
    if (fenceOpen) {
      fence = fenceOpen[1];
      continue;
    }
    if (!inSection) {
      if (heading.test(line)) inSection = true;
      continue;
    }
    if (/^#{1,6}\s/.test(line)) break;
    const isRow = /^\s*\|/.test(line);
    if (!isRow) {
      if (inTable) break;
      continue;
    }
    inTable = true;
    rowIndex += 1;
    if (rowIndex <= 2) continue;
    const cells = line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|');
    const cell = (cells[0] || '').trim().replace(/^`+|`+$/g, '').trim().replace(/^\.\/+/, '');
    if (cell === '' || /^<.*>$/.test(cell) || cell === '…' || cell === '...') continue;
    if (!paths.includes(cell)) paths.push(cell);
  }
  return paths;
}

/* -------------------------------------------------------- reading the folder */

/**
 * Read a spoke's rules at a commit in the cache. Returns
 *   { state, path?, checksAt, rules, findings }
 * where `state` is the RULES_INDEX state ('path' | 'none' | 'not-configured' |
 * 'invalid' | 'missing-folder'). `checksAt` is the commands file path read.
 */
export function readRulesAt(dir, commit, checksPath) {
  if (objectType(dir, commit, checksPath) !== 'blob') {
    return { state: 'no-commands-file', checksAt: checksPath, rules: [], findings: [`commands file ${checksPath} is not at this commit`] };
  }
  const env = parseChecksEnv(git(['--git-dir', dir, 'cat-file', 'blob', `${commit}:${checksPath}`]));
  const idx = rulesIndexState(env);
  const base = { checksAt: checksPath, rules: [], findings: [] };
  if (idx.state === 'invalid') return { ...base, state: 'invalid', findings: [`${checksPath}: ${RULES_INDEX_KEY}=${idx.value} is not a path relative to the repository root, "none" or "UNRESOLVED"`] };
  if (idx.state !== 'path') return { ...base, state: idx.state };
  const type = objectType(dir, commit, idx.path);
  if (type !== 'tree') {
    return { ...base, state: 'missing-folder', path: idx.path, findings: [`${checksPath} says ${RULES_INDEX_KEY}=${idx.path}, and ${idx.path} is not a folder at this commit`] };
  }
  const listing = git(['--git-dir', dir, 'ls-tree', `${commit}:${idx.path}`], { env: quietGitEnv() });
  const listed = listing.split('\n').filter(Boolean).map((row) => {
    const m = row.match(/^\d+ (\w+) ([0-9a-f]+)\t(.+)$/);
    return { path: `${idx.path}/${m[3]}`, type: m[1], sha: m[2] };
  });
  // Every blob's bytes in one call; a tree entry is listed with no text, as before.
  const blobs = catBlobs(dir, listed.filter((e) => e.type === 'blob').map((e) => e.sha));
  const entries = listed.map((e) => ({ path: e.path, type: e.type, text: e.type === 'blob' ? blobs.get(e.sha).toString('utf8') : null }));
  const { rules, findings } = validateRuleSet(idx.path, entries);
  return { state: 'path', path: idx.path, checksAt: checksPath, rules, findings };
}

/**
 * The same read against a checkout on disk, for the spoke's own CI. `indexPath`
 * overrides the commands file's key when given.
 */
export function readRulesLocal(root, { checksPath = 'checks.env', indexPath = null } = {}) {
  let idx;
  if (indexPath !== null) {
    idx = rulesIndexState(new Map([[RULES_INDEX_KEY, indexPath]]));
  } else {
    let text;
    try {
      text = readFileSync(join(root, checksPath), 'utf8');
    } catch {
      return { state: 'no-commands-file', checksAt: checksPath, rules: [], findings: [`no commands file at ${checksPath}`] };
    }
    idx = rulesIndexState(parseChecksEnv(text));
  }
  const base = { checksAt: checksPath, rules: [], findings: [] };
  if (idx.state === 'invalid') return { ...base, state: 'invalid', findings: [`${RULES_INDEX_KEY}=${idx.value} is not a path relative to the repository root, "none" or "UNRESOLVED"`] };
  if (idx.state !== 'path') return { ...base, state: idx.state };
  const folder = join(root, idx.path);
  let names;
  try {
    if (!statSync(folder).isDirectory()) throw new Error('not a directory');
    names = readdirSync(folder);
  } catch {
    return { ...base, state: 'missing-folder', path: idx.path, findings: [`${RULES_INDEX_KEY}=${idx.path}, and ${idx.path} is not a folder in this checkout`] };
  }
  const entries = names.map((name) => {
    const abs = join(folder, name);
    const isDir = statSync(abs).isDirectory();
    return { path: `${idx.path}/${name}`, type: isDir ? 'tree' : 'blob', text: isDir ? null : readFileSync(abs, 'utf8') };
  });
  const { rules, findings } = validateRuleSet(idx.path, entries);
  return { state: 'path', path: idx.path, checksAt: checksPath, rules, findings };
}

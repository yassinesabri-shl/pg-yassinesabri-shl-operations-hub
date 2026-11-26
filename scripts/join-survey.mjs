#!/usr/bin/env node
// Part of the harness asset library c6f3b4427d58f7c3 (see VERSION.json) · 2026-11-09
/**
 * join-survey.mjs: merge the partial surveys of a repository into its one
 * survey.
 *
 *   usage:  node scripts/join-survey.mjs --parts <dir> --out <file>
 *           node scripts/join-survey.mjs --check <dir>/<part id>.md
 *
 * /survey-repo plans the parts with plan-survey.mjs, dispatches the seat once
 * for each part, and writes each return to <dir>/<id>.md. This script reads
 * <dir>/plan.json, then the files in this order:
 *
 *   1. carried.md, where it exists: the rows a refresh keeps
 *   2. one file for each part of the plan, in plan order
 *   3. R.md, where it exists: the part that resolves conflicts
 *
 * Each file must parse as a partial survey (surveys.mjs, part mode), its `part`
 * key must be its file name, and it must name the plan's repository and
 * commit. parseSurvey checks every pointer against the part's own repository
 * and commit, so a part that names the plan's gives pointers that name them
 * too.
 *
 * The rows of a part can be in any order. The rows carry keys, so the order
 * carries no fact, and the survey sorts the rows of each section by key.
 *
 * Rows of one section with the same key merge into one row:
 *
 *   Evidence      the union of the pointers, sorted by path, first line, last line
 *   Version       the union of the versions, split and joined on ", ", sorted
 *   Access        read with write, or any read-write, is read-write
 *   Objects       the union, sorted
 *   What          the cell of the first part file, or of carried.md when no part
 *                 gives the key. A different cell is a note
 *   Provider      must be equal, or the key is a conflict
 *
 * One key is one endpoint, so two parts that describe it in other words agree on
 * the fact. A survey test run stopped the join four times for wording only.
 *
 * A library row of a file must rest only on the manifests in `manifests` of plan.json, or
 * the row is a finding of that file. A plan without `manifests` cannot verify.
 *
 * A row that only one file carries is kept as that file wrote it. One library
 * key under Shared libraries in one file and under Third-party libraries in
 * another is a conflict too. The rows of R.md replace every row with the same
 * section and key, and a library row of R.md replaces the key in both library
 * sections. Open points are the union, in file order. An open point equal to an
 * earlier one in its Unresolved, Owner and Resolves cells merges into it, with
 * the union of the pointers. Each part writes one open point for each property
 * with no value that it uses, so a survey of many parts would repeat it.
 *
 * A Calls row with the provider unknown whose http key matches a Serves key of
 * the joined rows is a call to itself (selfCalls in surveys.mjs). It is a
 * finding of each file that gave the row. The join does not remove the row.
 * The seat removes it, or names the provider.
 *
 * The script writes the survey with renderSurvey and parses it again in survey
 * mode, where an open point must name only keys that some row carries. Each
 * finding there names the part that gave the row or the open point. When a
 * part has a form finding, the script keeps only the open-point findings of
 * that parse, because the part findings already hold the others. It writes
 * --out only on exit 0.
 *
 * Output. Each finding is one line, `<part id>: <finding>`, or
 * `conflict <section> <key>: <part id> says "<a>", <part id> says "<b>"`.
 * Each note is one line, before the findings, and changes no exit code:
 *   note: <section> <key>: kept the What of <part id>, "<a>"; <part id> says "<b>"
 *   note: store keys <literal> and <placeholder> may name one store
 * The second note is for two store keys of one engine where the property of
 * the placeholder holds the literal name as a word, as {storage_orders_bucket}
 * and orders. The join cannot see a property's value, so it merges nothing.
 * On exit 0, stdout ends with the lines /survey-repo copies into the pull
 * request:
 *
 *   JOINED: <ID>@<12> from <n> part(s), <k> carried row(s)
 *   Serves: <n> row(s)
 *   Calls: <n> row(s), <u> with the provider unknown
 *   Data stores: <n> row(s)
 *   Shared libraries: <n> row(s)
 *   Third-party libraries: <n> row(s)
 *   Placeholder names: <n>
 *   Open points: <n>
 *   Not read: <n> file(s), <b> bytes
 *
 * Exit codes:
 *   0  joined, and --out written
 *   1  a part with a form finding, a conflict, a call to itself, or a finding in
 *      the joined survey
 *   2  cannot verify: plan.json is missing or malformed, or a part has no file
 *   3  usage
 *   4  internal
 *
 * Check one part. With --check, the script reads <dir>/plan.json and the one
 * part file, and gives the form findings that the join gives for that file. It
 * also gives each call to itself that the part's own Serves rows show. It
 * does not merge, so it finds no conflict, no call to a key that only another
 * part serves, and no open-point finding of the joined survey. /survey-repo runs it on each part as the seat returns it, and
 * sends the findings to the same seat while that seat is open. The part id is
 * the file name. It must be a part of the plan, or R. The script writes
 * nothing. On exit 0, stdout is `PART OK: <part id>`. On exit 1, it gives one
 * line for each finding, in the form of the join, then
 * `PART FINDINGS: <n> finding(s) in <part id>.md`.
 *
 * Exit codes of --check:
 *   0  the part has no form finding
 *   1  the part has a form finding, or a call to itself
 *   2  cannot verify: plan.json is missing or malformed, or the part file is missing
 *   3  usage, or a file name that is not a part of the plan or R
 *   4  internal
 *
 * What this script cannot see
 *   - Whether a pointer is true. check-survey.mjs proves every pointer against
 *     the repository when the survey's pull request runs survey-gate.
 *   - Whether the parts together cover the repository. The plan does that.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, writeSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { stdout, stderr } from 'node:process';
import { EXIT, SpokeError, REPO_ID, COMMIT, reasonLine } from './spoke-remote.mjs';
import { SECTIONS, UNKNOWN, LOOSE_KEYS, isPlaceholderName, libraryRowsOffManifest, parseSurvey, renderSurvey, notReadRows, selfCalls, selfCallFinding } from './surveys.mjs';

// The parts a plan names. R and carried are not plan parts.
const PLAN_PART = /^P\d+(?:\.\d+)*$/;
const CARRIED = 'carried';
const RESOLVER = 'R';
const LIBRARY_TABLES = ['libraries', 'third_party'];
const JOINED = 'joined';

const byCodeUnit = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const sectionOf = (table) => SECTIONS.find((s) => s.table === table);
// A Version cell joins its versions with ", ". A bare "," belongs to one
// version, as in the specifier >=1.0,<2.0.
const splitVersions = (cell) => String(cell).split(', ').map((s) => s.trim()).filter(Boolean);
const sortedUnion = (lists) => [...new Set(lists.flat())].sort(byCodeUnit);

function usage(message) {
  const invoked = process.argv[1] || 'scripts/join-survey.mjs';
  stderr.write(`${message}\nusage: node ${invoked} --parts <dir> --out <file>\n       node ${invoked} --check <dir>/<part id>.md\n`);
  process.exit(EXIT.USAGE);
}

/* ---------------------------------------------------------------------- plan */

function readPlan(dir) {
  const file = join(dir, 'plan.json');
  if (!existsSync(file)) throw new SpokeError(EXIT.CANNOT_VERIFY, `there is no plan at ${file}. Run plan-survey.mjs first`, 'file-unreadable');
  let plan;
  try {
    plan = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new SpokeError(EXIT.CANNOT_VERIFY, `the plan at ${file} is not JSON: ${err.message}`, 'plan-invalid');
  }
  const bad = (what) => new SpokeError(EXIT.CANNOT_VERIFY, `the plan at ${file} is not one plan-survey.mjs writes: ${what}`, 'plan-invalid');
  if (typeof plan !== 'object' || plan === null) throw bad('it is not an object');
  if (typeof plan.repository !== 'string' || plan.repository.search(REPO_ID) < 0) throw bad('repository is not a repository id');
  if (typeof plan.commit !== 'string' || plan.commit.search(COMMIT) < 0) throw bad('commit is not 40 lower-case hex digits');
  if (!Array.isArray(plan.parts)) throw bad('parts is not a list');
  if (!Array.isArray(plan.excluded)) throw bad('excluded is not a list');
  const odd = plan.excluded.find((e) => !e || typeof e.path !== 'string' || !Number.isInteger(e.bytes) || e.bytes < 0);
  if (odd !== undefined) throw bad('an entry of excluded has no path, or its bytes is not a whole number of 0 or more');
  // A plan from before the manifest rule has no list, and without it the join cannot judge a library row.
  if (!Array.isArray(plan.manifests)) throw bad('manifests is not a list. Run plan-survey.mjs again');
  if (plan.manifests.some((m) => !m || typeof m.path !== 'string')) throw bad('an entry of manifests has no path');
  // The join reads only the id of each part. It does not read `paths` or `files`. A plan from
  // before `files` therefore still joins, and the join does not check the list.
  const ids = plan.parts.map((p) => (p && typeof p.id === 'string' ? p.id : ''));
  const wrong = ids.find((id) => id.search(PLAN_PART) < 0);
  if (wrong !== undefined) throw bad(`"${wrong}" is not a part id P<n> or P<n>.<n>`);
  const twice = ids.find((id, i) => ids.indexOf(id) !== i);
  if (twice !== undefined) throw bad(`part ${twice} is listed twice`);
  return { repository: plan.repository, commit: plan.commit, ids, excluded: plan.excluded, manifests: plan.manifests };
}

/* --------------------------------------------------------------------- parts */

/**
 * Read and check one file. Returns the parsed part, or null when the file is
 * absent. Every finding goes to `findings` with the part id in front.
 */
function readPart(dir, id, plan, findings) {
  const name = `${id}.md`;
  const file = join(dir, name);
  if (!existsSync(file)) return null;
  const parsed = parseSurvey(name, readFileSync(file, 'utf8'), { part: true });
  const say = (m) => findings.push(`${id}: ${m}`);
  for (const f of parsed.findings) say(f);
  if (parsed.part !== null && parsed.part !== id) say(`${name}: part is "${parsed.part}". The file ${name} holds part ${id}`);
  if (parsed.repository !== null && parsed.repository !== plan.repository) say(`${name}: repository is ${parsed.repository}. The plan's repository is ${plan.repository}`);
  if (parsed.commit !== null && parsed.commit !== plan.commit) say(`${name}: commit is ${parsed.commit}. The plan's commit is ${plan.commit}`);
  for (const { row, path } of libraryRowsOffManifest(parsed.rows, plan.manifests)) {
    say(`${name} L${row.line}: "${row.key}" rests on ${path}, which is not a manifest of the plan. A library row rests only on a manifest the plan lists; leave the row out of the survey`);
  }
  return { id, parsed };
}

/* --------------------------------------------------------------------- merge */

const byPointer = (a, b) => byCodeUnit(a.path, b.path) || a.from - b.from || a.to - b.to;

function unionEvidence(lists) {
  const seen = new Map();
  for (const p of lists.flat()) if (!seen.has(p.text)) seen.set(p.text, p);
  return [...seen.values()].sort(byPointer);
}

const quote = (v) => `"${v}"`;

/**
 * One row from the rows of one section and key, each { row, origin }. A key
 * that one file carries keeps its row. Records a conflict for each file whose
 * What or Provider differs from the first file's.
 */
function mergeRows(group, conflicts, notes) {
  const [first] = group;
  if (group.length === 1) return first.row;
  const { table, key } = first.row;
  const row = { ...first.row, evidence: unionEvidence(group.map((g) => g.row.evidence)) };
  // On a refresh, a part read the code again, so its words win over the carried row.
  const worded = group.find((g) => g.origin.id !== CARRIED) || first;
  row.what = worded.row.what;
  for (const g of group) {
    if (g !== first && table === 'calls' && g.row.provider !== first.row.provider) conflicts.push(`conflict ${sectionOf(table).title} ${key}: ${first.origin.id} says ${quote(first.row.provider)}, ${g.origin.id} says ${quote(g.row.provider)}`);
    if (g !== worded && table === 'serves' && g.row.what !== worded.row.what) notes.push(`note: ${sectionOf(table).title} ${key}: kept the What of ${worded.origin.id}, ${quote(worded.row.what)}; ${g.origin.id} says ${quote(g.row.what)}`);
  }
  if (table === 'stores') {
    const access = new Set(group.map((g) => g.row.access));
    row.access = access.has('read-write') || (access.has('read') && access.has('write')) ? 'read-write' : first.row.access;
    row.objects = sortedUnion(group.map((g) => g.row.objects));
  }
  if (LIBRARY_TABLES.includes(table)) row.version = sortedUnion(group.map((g) => splitVersions(g.row.version))).join(', ');
  return row;
}

/**
 * A note for each literal store key and placeholder store key of one engine where a word of the
 * property is the literal name: store:s3:orders and store:s3:{storage_orders_bucket}.
 */
function storeNameNotes(rows) {
  const stores = rows.filter((r) => r.table === 'stores').map((r) => {
    const [, engine, name] = r.key.match(/^store:([^:]+):(.*)$/) || [];
    return { key: r.key, engine, name };
  });
  const literal = stores.filter((s) => s.name && !s.name.startsWith('{'));
  const notes = [];
  for (const p of stores.filter((s) => s.name && s.name.startsWith('{'))) {
    const words = new Set(p.name.slice(1, -1).toLowerCase().split(/[._-]+/));
    for (const l of literal) {
      if (l.engine === p.engine && words.has(l.name.toLowerCase())) notes.push(`note: store keys ${l.key} and ${p.key} may name one store`);
    }
  }
  return notes;
}

/**
 * The joined rows and open points, each with the files it came from. `files`
 * is in read order, and R, when present, is last.
 */
function merge(files, conflicts, notes) {
  const resolver = files.find((f) => f.id === RESOLVER);
  const others = files.filter((f) => f.id !== RESOLVER);
  const replaced = new Set();
  for (const r of resolver ? resolver.parsed.rows : []) {
    for (const table of LIBRARY_TABLES.includes(r.table) ? LIBRARY_TABLES : [r.table]) replaced.add(`${table}\0${r.key}`);
  }

  const groups = new Map();
  for (const f of others) {
    for (const row of f.parsed.rows) {
      const id = `${row.table}\0${row.key}`;
      if (replaced.has(id)) continue;
      if (!groups.has(id)) groups.set(id, []);
      groups.get(id).push({ row, origin: { id: f.id, line: row.line } });
    }
  }

  // A library is shared or a third party's. Keep the section of the file read
  // first, so the joined survey has one row and the conflict is the one finding.
  const order = new Map(files.map((f, i) => [f.id, i]));
  const firstFile = (group) => Math.min(...group.map((g) => order.get(g.origin.id)));
  for (const [id, shared] of groups) {
    const [table, key] = id.split('\0');
    if (table !== 'libraries') continue;
    const third = groups.get(`third_party\0${key}`);
    if (!third) continue;
    const [kept, dropped] = firstFile(shared) <= firstFile(third) ? [shared, third] : [third, shared];
    const keptTitle = sectionOf(kept[0].row.table).title;
    const droppedTitle = sectionOf(dropped[0].row.table).title;
    conflicts.push(`conflict ${keptTitle} ${key}: ${kept[0].origin.id} says ${quote(keptTitle)}, ${dropped[0].origin.id} says ${quote(droppedTitle)}`);
    groups.delete(`${dropped[0].row.table}\0${key}`);
  }

  const rows = [];
  for (const group of groups.values()) rows.push({ row: mergeRows(group, conflicts, notes), origins: group.map((g) => g.origin) });
  for (const row of resolver ? resolver.parsed.rows : []) rows.push({ row, origins: [{ id: RESOLVER, line: row.line }] });

  const openPoints = [];
  const cells = (p) => [p.what, p.owner, p.resolves].join('\0');
  const seen = new Map();
  for (const f of files) {
    for (const point of f.parsed.openPoints) {
      const origin = { id: f.id, line: point.line };
      const same = seen.get(cells(point));
      if (same) {
        same.origins.push(origin);
        same.point = { ...same.point, evidence: unionEvidence([same.point.evidence, point.evidence]) };
      } else {
        const entry = { point, origins: [origin] };
        seen.set(cells(point), entry);
        openPoints.push(entry);
      }
    }
  }
  notes.push(...storeNameNotes(rows.map((r) => r.row)));
  return { rows, openPoints };
}

/* ---------------------------------------------------------------------- join */

/**
 * The findings of the joined survey, each moved to the files that gave its row
 * or open point, at their own lines. Each is { line, looseKey }, where
 * looseKey marks a finding of the open-point rule.
 */
function reparse(text, rows, openPoints) {
  const joined = parseSurvey(JOINED, text);
  const origins = new Map();
  const byKey = new Map(rows.map((r) => [`${r.row.table}\0${r.row.key}`, r.origins]));
  for (const r of joined.rows) origins.set(r.line, byKey.get(`${r.table}\0${r.key}`) || []);
  joined.openPoints.forEach((p, i) => origins.set(p.line, openPoints[i] ? openPoints[i].origins : []));
  const out = [];
  for (const f of joined.findings) {
    const m = f.match(/^joined L(\d+): ([\s\S]*)$/);
    const from = m ? origins.get(Number(m[1])) || [] : [];
    const looseKey = m !== null && m[2].startsWith(LOOSE_KEYS);
    if (!from.length) out.push({ line: `${JOINED}: ${f}`, looseKey });
    for (const o of from) out.push({ line: `${o.id}: ${o.id}.md L${o.line}: ${m[2]}`, looseKey });
  }
  return out;
}

function counts(rows, openPoints) {
  const n = (table) => rows.filter((r) => r.table === table).length;
  const unknown = rows.filter((r) => r.table === 'calls' && r.provider === UNKNOWN).length;
  const placeholders = rows.filter((r) => isPlaceholderName(r.key)).length;
  return [
    `Serves: ${n('serves')} row(s)`,
    `Calls: ${n('calls')} row(s), ${unknown} with the provider unknown`,
    `Data stores: ${n('stores')} row(s)`,
    `Shared libraries: ${n('libraries')} row(s)`,
    `Third-party libraries: ${n('third_party')} row(s)`,
    `Placeholder names: ${placeholders}`,
    `Open points: ${openPoints.length}`,
  ];
}

function parseArgs(argv) {
  if (argv.includes('--check')) {
    if (argv[0] !== '--check' || argv.length > 2) usage('--check takes no other argument: --check <dir>/<part id>.md');
    if (argv[1] === undefined || argv[1].startsWith('--')) usage('--check needs a value');
    return { check: argv[1] };
  }
  const out = { parts: null, out: null };
  const names = new Map([['--parts', 'parts'], ['--out', 'out']]);
  for (let i = 0; i < argv.length; i += 1) {
    const key = names.get(argv[i]);
    if (!key) usage(`unknown argument ${argv[i]}`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) usage(`${argv[i]} needs a value`);
    out[key] = value;
    i += 1;
  }
  for (const key of ['parts', 'out']) if (out[key] === null) usage(`--${key} is required`);
  return out;
}

/** --check: the form findings of one part file, against the plan beside it. */
function checkPart(file) {
  const dir = dirname(file);
  const name = basename(file);
  const plan = readPlan(dir);
  const id = name.endsWith('.md') ? name.slice(0, -'.md'.length) : name;
  if (!name.endsWith('.md') || !(plan.ids.includes(id) || id === RESOLVER)) {
    usage(`the plan names no part ${id}. Give the file <dir>/<part id>.md of a part of plan.json, or of R`);
  }
  if (!existsSync(file)) throw new SpokeError(EXIT.CANNOT_VERIFY, `${file} is missing. Write the seat's return there first`, 'file-unreadable');
  const findings = [];
  const { parsed } = readPart(dir, id, plan, findings);
  // The part sees only its own Serves rows. The join sees every part's.
  for (const self of selfCalls(parsed.rows)) findings.push(`${id}: ${name} L${self.row.line}: ${selfCallFinding(self)}`);
  for (const line of findings) stdout.write(`${line}\n`);
  if (findings.length) {
    stdout.write(`PART FINDINGS: ${findings.length} finding(s) in ${name}\n`);
    process.exit(EXIT.FAIL);
  }
  stdout.write(`PART OK: ${id}\n`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.check) {
    checkPart(args.check);
    return;
  }
  const plan = readPlan(args.parts);
  const findings = [];
  const missing = [];
  const files = [];

  const carried = readPart(args.parts, CARRIED, plan, findings);
  if (carried) files.push(carried);
  for (const id of plan.ids) {
    const part = readPart(args.parts, id, plan, findings);
    if (part) files.push(part);
    else missing.push(`${id}: ${id}.md is missing. The plan names part ${id}. Dispatch the seat for it, and write its return there`);
  }
  const resolver = readPart(args.parts, RESOLVER, plan, findings);
  if (resolver) files.push(resolver);

  // The plan read the content of each large .json file. The join reads no file, so it takes the data rule from plan.json.
  // A file that a content rule takes is an entry of the plan with that rule. A file that a
  // folder makes vendored stays vendored, so the vendored set changes no other row.
  const ruled = (rule) => new Set(plan.excluded.filter((e) => e.rule === rule).map((e) => e.path));
  const notRead = notReadRows(plan.excluded, { numeric: ruled('data'), licensed: ruled('vendored'), quiet: ruled('markup') });
  const conflicts = [];
  const notes = [];
  const { rows, openPoints } = merge(files, conflicts, notes);
  const originsOf = new Map(rows.map((r) => [r.row, r.origins]));
  const selves = selfCalls(rows.map((r) => r.row)).flatMap((self) => originsOf.get(self.row).map((o) => `${o.id}: ${o.id}.md L${o.line}: ${selfCallFinding(self)}`));
  const text = renderSurvey({
    repository: plan.repository,
    commit: plan.commit,
    rows: rows.map((r) => r.row),
    openPoints: openPoints.map((p) => p.point),
    notRead,
  });
  // A missing part leaves the joined survey without its rows, so every finding
  // there could be false. With a form finding in a part, the other rules of
  // the parse repeat the part findings. The open-point rule is the one that
  // part mode skips, so its findings are new and stay.
  const reparsed = missing.length ? [] : reparse(text, rows, openPoints);
  const joined = findings.length ? reparsed.filter((f) => f.looseKey) : reparsed;

  const all = [...missing, ...findings, ...conflicts, ...selves, ...joined.map((f) => f.line)];
  for (const line of notes) stdout.write(`${line}\n`);
  for (const line of all) stdout.write(`${line}\n`);
  if (all.length) {
    stdout.write(`NOT JOINED: ${all.length} finding(s). ${args.out} is not written.\n`);
    // A part with no return file is a file that cannot be read: exit 2 names it.
    if (missing.length) stderr.write(reasonLine('file-unreadable'));
    process.exit(missing.length ? EXIT.CANNOT_VERIFY : EXIT.FAIL);
  }

  mkdirSync(dirname(args.out), { recursive: true });
  writeFileSync(args.out, text);
  const carriedRows = carried ? carried.parsed.rows.length : 0;
  stdout.write(`JOINED: ${plan.repository}@${plan.commit.slice(0, 12)} from ${plan.ids.length} part(s), ${carriedRows} carried row(s)\n`);
  for (const line of counts(rows.map((r) => r.row), openPoints)) stdout.write(`${line}\n`);
  const notReadFiles = notRead.reduce((sum, r) => sum + r.files, 0);
  const notReadBytes = notRead.reduce((sum, r) => sum + r.bytes, 0);
  stdout.write(`Not read: ${notReadFiles} file(s), ${notReadBytes} bytes\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  // The last line of an exit 2, 3 or 4 names this script and its code, so a shell line that hides
  // the code, with a pipe or `; echo`, still tells the harness's failure record. Written at once,
  // so a process.exit() never loses it.
  process.on('exit', (code) => { if (code >= 2 && code <= 4) { try { writeSync(2, `HARNESS EXIT: join-survey ${code}\n`); } catch { /* stderr is closed */ } } });
  try {
    main();
  } catch (err) {
    if (err instanceof SpokeError) {
      stderr.write(`CANNOT VERIFY: ${err.message}\n`);
      if (err.exit === EXIT.CANNOT_VERIFY) stderr.write(reasonLine(err.reason));
      process.exit(err.exit);
    }
    stderr.write(`internal error: ${err && err.stack ? err.stack : String(err)}\n`);
    process.exit(EXIT.INTERNAL);
  }
}

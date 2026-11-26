#!/usr/bin/env node
// Part of the harness asset library c6f3b4427d58f7c3 (see VERSION.json) · 2026-09-28
/**
 * read-survey.mjs — what the service surveys say, and how far each has drifted
 * from its repository's trunk.
 *
 *   usage:  node scripts/read-survey.mjs <ID> [--offline] [--registry <file>]
 *           node scripts/read-survey.mjs --readers <key>[,<key>...] [--offline] [--registry <file>]
 *           node scripts/read-survey.mjs --find <word>[,<word>...] [--registry <file>]
 *           node scripts/read-survey.mjs --graph [--registry <file>]
 *
 * The surveys are read from the hub checkout the caller stands in, and the
 * graph is built from them on the spot and never saved: it can never be behind
 * the surveys, and two survey pull requests never touch the same file.
 *
 *   <ID>        One repository's survey, under a drift line:
 *                 Survey: <ID>@<12> · Trunk: <12> · Drift: <n> of <m> cited files changed, <k> deleted
 *               computed by comparing the survey's commit with the trunk head,
 *               over the files the survey cites. A repository on the list with
 *               no survey is NOT SURVEYED, said once, never a stop.
 *   --readers   For each key, which surveyed repositories read it, each with its
 *               own drift line over the files its rows for that key cite:
 *                 http, event, queue, job  who serves it, and who calls it --
 *                   normalised, so `/users/{id}` finds a call to
 *                   `/users/{user_id}`. Only a call to a listed repository is
 *                   a reader. A serve of http:ANY matches every method, and a
 *                   key of method ANY finds the serves and calls of every
 *                   method. A call to external:<host> reaches a third party,
 *                   never anything the estate serves, whatever its key. A
 *                   call whose provider is `unknown` is a possible reader,
 *                   listed apart under "May be read by": it may reach
 *                   whoever serves the key, and only its code can say. A
 *                   serve or call whose key is a {placeholder} name is listed
 *                   there too, for every key of its kind;
 *                 lib    every repository that uses the library, from either
 *                   library section, with the version it declares;
 *                 store  every repository that touches the store, with its
 *                   access and the objects it touches: a writer depends on
 *                   the record's shape as much as a reader does. Then every listed repository with no
 *               survey, because a repository nobody surveyed is never assumed
 *               to read nothing. This is what /decompose reads before it cuts a
 *               contract change -- an endpoint, an event, a queue message, a
 *               stored record, a shared library -- and what /dev-spec reads for
 *               a design whose §6 changes a served contract.
 *   --find      The keys the surveys carry that a word finds, for a planner who
 *               knows what a requirement changes but not yet its key. A row
 *               matches when a word, in any case, is part of its key, of what
 *               Serves says it does, or of the objects a store row touches.
 *               Matches are grouped by key -- matched as --readers matches --
 *               and each lists who serves it, who calls it and with which
 *               provider, who touches the store or uses the library. Then
 *               every listed repository with no survey. No remote is asked:
 *               this finds keys, and --readers on each key that fits gives
 *               the readers and their drift. A key added after a survey's
 *               commit is not in it, so the code is still read.
 *   --graph     The whole graph as JSON, with the listed repositories that have
 *               no survey: among the rest, which repositories call each
 *               third-party host, which call a key with the provider unnamed,
 *               which serve or call a {placeholder} queue or event name (listed
 *               apart, never unmatched), and which use each third-party
 *               library. No remote is asked.
 *
 * A survey points; it is never cited. Every reader and possible reader this
 * prints is read at a pinned commit through read-spoke.mjs, and that read is
 * what a plan cites.
 *
 * Drift is a fact for the reader to weigh, never a stop: a repository that
 * cannot be reached prints `Trunk: not reached · Drift: unknown` and the run
 * still exits 0, because this script points and does not judge. --offline
 * asks no remote and prints `Drift: not asked`.
 *
 * Exit codes -- the gate's:
 *   0  answered, whatever the drift
 *   1  the repository named is not on the list, or its survey does not parse
 *   2  cannot verify: no registry
 *   3  usage, or a key that is not in the grammar
 *   4  internal
 */

import { stdout, stderr } from 'node:process';
import {
  EXIT, SpokeError, reasonLine, git,
  registryPath, readRegistry, validateRegistry,
  resolveSpokeTrunk, cacheDir, ensureCommit, short,
} from './spoke-remote.mjs';
import {
  KEYS, EXTERNAL_HTTP_KEY, SURVEY_DIR, keyKind, normaliseKey, keysMatch, servedBy, isPlaceholderName, parseSurvey, readSurveysLocal, buildGraph, idFromPath,
} from './surveys.mjs';
import { writeSync } from 'node:fs';

function usage(message) {
  const invoked = process.argv[1] || 'scripts/read-survey.mjs';
  stderr.write(`${message}\nusage: node ${invoked} <ID> [--offline] [--registry <file>]\n       node ${invoked} --readers <key>[,<key>...] [--offline] [--registry <file>]\n       node ${invoked} --find <word>[,<word>...] [--registry <file>]\n       node ${invoked} --graph [--registry <file>]\n`);
  process.exit(EXIT.USAGE);
}

function parseArgs(argv) {
  const out = { id: null, readers: null, find: null, graph: false, offline: false, registry: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--offline') out.offline = true;
    else if (a === '--graph') out.graph = true;
    else if (a === '--readers' || a === '--find' || a === '--registry') {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) usage(`${a} needs a value`);
      out[a.slice(2)] = v;
      i += 1;
    } else if (a.startsWith('--')) usage(`unknown argument ${a}`);
    else if (out.id === null) out.id = a;
    else usage(`one repository at a time; got ${out.id} and ${a}`);
  }
  const ways = [out.id !== null, out.readers !== null, out.find !== null, out.graph].filter(Boolean).length;
  if (ways !== 1) usage('name one repository, or --readers <key>, or --find <word>, or --graph');
  if (out.graph && out.offline) usage('--graph asks no remote; --offline has nothing to switch off');
  if (out.find !== null && out.offline) usage('--find asks no remote; --offline has nothing to switch off');
  if (out.find !== null) {
    out.words = [...new Set(out.find.split(',').map((w) => w.trim().toLowerCase()).filter(Boolean))];
    if (!out.words.length) usage('--find needs at least one word');
  }
  if (out.readers !== null) {
    out.keys = out.readers.split(',').map((k) => k.trim()).filter(Boolean);
    if (!out.keys.length) usage('--readers needs at least one key');
    for (const k of out.keys) {
      const kind = keyKind(k);
      // A key in a query can be the key of a call to external:<host>, which keeps upper case.
      const pattern = kind === 'http' ? EXTERNAL_HTTP_KEY : KEYS[kind];
      if (!pattern || k.search(pattern) !== 0) usage(`"${k}" is not a key: ${Object.keys(KEYS).map((x) => `${x}:`).join(', ')} in the grammar the survey template gives`);
    }
  }
  return out;
}

/**
 * One drift line for one survey, over the files it cites. Never throws for a
 * repository problem: what could not be learned is said in the line.
 */
function driftLine(id, entry, commit, paths, offline) {
  const head = `Survey: ${id}@${short(commit)}`;
  if (offline) return `${head} · Trunk: not asked · Drift: not asked`;
  const files = [...new Set(paths)];
  let trunk;
  let tip;
  let dir;
  try {
    dir = cacheDir(id);
    ({ trunk, head: tip } = resolveSpokeTrunk(entry, dir));
  } catch (err) {
    if (!(err instanceof SpokeError)) throw err;
    return `${head} · Trunk: not reached · Drift: unknown`;
  }
  if (tip === commit) return `${head} · Trunk: ${short(tip)} · Drift: none, the survey is at the trunk head`;
  if (!ensureCommit(dir, entry.url, trunk, commit)) return `${head} · Trunk: ${short(tip)} · Drift: unknown, ${id} does not know the survey's commit`;
  if (!files.length) return `${head} · Trunk: ${short(tip)} · Drift: 0 of 0 cited files`;
  const out = git(['--git-dir', dir, 'diff', '--name-status', '--no-renames', commit, tip, '--', ...files]);
  let changed = 0;
  let deleted = 0;
  for (const line of out.split('\n').filter(Boolean)) {
    if (line.startsWith('D')) deleted += 1;
    else changed += 1;
  }
  return `${head} · Trunk: ${short(tip)} · Drift: ${changed} of ${files.length} cited file(s) changed, ${deleted} deleted`;
}

function loadSurveys() {
  const { surveys } = readSurveysLocal('.');
  const good = new Map();
  const bad = [];
  for (const { path, text } of surveys) {
    const p = parseSurvey(path, text);
    if (p.findings.length || p.repository !== idFromPath(path)) bad.push(p);
    else good.set(p.repository, p);
  }
  return { good, bad };
}

function readOne(args, listed) {
  const id = args.id;
  if (!Object.hasOwn(listed, id)) {
    stdout.write(`NOT LISTED: ${id} is not on the list of repositories; run /add-repo first.\n`);
    return EXIT.FAIL;
  }
  const path = `${SURVEY_DIR}/${id}.md`;
  const { surveys } = readSurveysLocal('.');
  const found = surveys.find((s) => s.path === path);
  stdout.write(`Repository: ${id}\n`);
  if (!found) {
    stdout.write(`NOT SURVEYED: ${id} has no survey; run /survey-repo ${id}. A repository with no survey is never assumed to serve or call nothing.\n`);
    return EXIT.PASS;
  }
  const survey = parseSurvey(found.path, found.text);
  if (survey.findings.length) {
    stdout.write(`NOT WELL FORMED: ${path} does not parse; run check-survey.mjs ${id}.\n`);
    for (const f of survey.findings) stdout.write(`  - ${f}\n`);
    return EXIT.FAIL;
  }
  const paths = survey.rows.flatMap((r) => r.evidence.map((p) => p.path));
  stdout.write(`${driftLine(id, listed[id], survey.commit, paths, args.offline)}\n`);
  stdout.write('Cite: never -- a survey points. Read the code at a pinned commit with read-spoke.mjs, and cite that read.\n\n');
  stdout.write(found.text.endsWith('\n') ? found.text : `${found.text}\n`);
  return EXIT.PASS;
}

function notSurveyed(listed, good) {
  return Object.keys(listed).filter((id) => !good.has(id)).sort();
}

// The tables whose rows read a key of each kind. Serves is not a reader: it is
// the other side of the match, printed as "Served by".
const READER_TABLES = { lib: ['libraries', 'third_party'], store: ['stores'] };
const readerTables = (kind) => READER_TABLES[kind] ?? ['calls'];
const ACCESS_WORDS = { read: 'reads', write: 'writes', 'read-write': 'reads and writes' };

/** What one reader's row says about the key, for its line. */
function readsAs(row) {
  if (row.table === 'serves') return `serves ${row.key}: ${row.what}`;
  if (row.table === 'calls' && row.unknown) return `calls an unnamed provider as ${row.key}`;
  if (row.table === 'calls') return `calls ${row.provider} as ${row.key}`;
  if (row.table === 'stores') return `${ACCESS_WORDS[row.access]} ${row.key} (${row.objects.join(', ')})`;
  return `uses ${row.key} at ${row.version}, ${row.table === 'libraries' ? 'shared inside the estate' : "a third party's"}`;
}

function readReaders(args, listed) {
  const { good, bad } = loadSurveys();
  const graph = buildGraph([...good.values()]);
  for (const b of bad) stdout.write(`note: ${b.path} does not parse and was not read; run check-survey.mjs ${idFromPath(b.path)}\n`);
  for (const key of args.keys) {
    const k = normaliseKey(key);
    const kind = keyKind(key);
    const tables = readerTables(kind);
    const matches = (row) => tables.includes(row.table) && keysMatch(row.key, key);
    // A call to a third party never reads what the estate serves; a call to an
    // unnamed provider may, and is listed apart.
    const reads = (row) => matches(row) && !(row.table === 'calls' && (row.host !== null || row.unknown));
    // A placeholder name may be any queue or event of its kind, so its row is a possible
    // reader of every key of that kind, in Serves or in Calls.
    const placeholderOfKind = (row) => (kind === 'event' || kind === 'queue') && keyKind(row.key) === kind && isPlaceholderName(row.key) && (row.table === 'serves' || row.table === 'calls');
    const mayRead = (row) => (matches(row) && row.table === 'calls' && row.unknown) || (placeholderOfKind(row) && !reads(row));
    stdout.write(`\nKey: ${key}${k !== key ? `  (matched as ${k})` : ''}\n`);
    if (tables.includes('calls')) {
      const servers = servedBy(graph.serves, key);
      stdout.write(`Served by: ${servers.length ? servers.join(', ') : 'no surveyed repository'}\n`);
    }
    const readers = rowsWhere(good, reads);
    stdout.write(`Read by: ${readers.length ? `${repositories(readers)} surveyed repository(ies)` : 'no surveyed repository'}\n`);
    writeReaders(readers, reads, listed, args.offline);
    if (tables.includes('calls')) {
      const maybe = rowsWhere(good, mayRead);
      stdout.write(`May be read by: ${maybe.length ? `${repositories(maybe)} surveyed repository(ies) ${mayReadWhy(maybe)}` : 'no surveyed repository calls this key with the provider unnamed'}\n`);
      writeReaders(maybe, mayRead, listed, args.offline);
    }
  }
  const missing = notSurveyed(listed, good);
  stdout.write(`\nNot surveyed: ${missing.length ? `${missing.join(', ')} -- never ruled out; read each at a pinned commit` : 'none; every listed repository has a survey'}\n`);
  stdout.write('Cite: never -- a survey points. Read each reader and possible reader at a pinned commit with read-spoke.mjs, and cite that read.\n');
  return EXIT.PASS;
}

/**
 * Why the possible readers are possible, true for each of them. A row with a
 * placeholder key is listed for its name. Any other row is a call with the
 * provider unknown.
 */
function mayReadWhy(maybe) {
  const why = [];
  const what = [];
  if (maybe.some(({ row }) => !isPlaceholderName(row.key))) {
    why.push('leaves the provider unnamed');
    what.push('where its call goes');
  }
  if (maybe.some(({ row }) => isPlaceholderName(row.key))) {
    why.push('gives the key only as a {placeholder} name');
    what.push('the name its configuration gives');
  }
  return `whose survey ${why.join(', or ')}. Read each to learn ${what.join(', or ')}`;
}

/** Every { survey, row } whose row passes the test, sorted by repository and key. */
function rowsWhere(good, test) {
  return [...good.values()]
    .flatMap((survey) => survey.rows.filter(test).map((row) => ({ survey, row })))
    .sort((a, b) => (a.survey.repository + a.row.key < b.survey.repository + b.row.key ? -1 : 1));
}

const repositories = (found) => new Set(found.map((r) => r.survey.repository)).size;

/** One line per reader, with its drift over the files its matching rows cite. */
function writeReaders(found, test, listed, offline) {
  for (const { survey, row } of found) {
    const id = survey.repository;
    const paths = survey.rows.filter(test).flatMap((r) => r.evidence.map((p) => p.path));
    const line = Object.hasOwn(listed, id)
      ? driftLine(id, listed[id], survey.commit, paths, offline)
      : `Survey: ${id}@${short(survey.commit)} · Trunk: not listed · Drift: unknown`;
    stdout.write(`- ${id} · ${readsAs(row)} · ${line}\n`);
  }
}

// What each table's row says, for its line under a found key.
const FOUND_AS = {
  serves: (row) => `serves: ${row.what}`,
  calls: (row) => `calls ${row.unknown ? 'an unnamed provider' : row.provider}`,
  stores: (row) => `${ACCESS_WORDS[row.access]} (${row.objects.join(', ')})`,
  libraries: (row) => `uses at ${row.version}, shared inside the estate`,
  third_party: (row) => `uses at ${row.version}, a third party's`,
};
const TABLE_ORDER = ['serves', 'calls', 'stores', 'libraries', 'third_party'];

/** The text of a row a word may be part of: its key, and what it says it does or touches. */
function searchable(row) {
  return [row.key, row.what ?? '', ...(row.objects ?? [])].join('\n').toLowerCase();
}

function readFind(args, listed) {
  const { good, bad } = loadSurveys();
  for (const b of bad) stdout.write(`note: ${b.path} does not parse and was not read; run check-survey.mjs ${idFromPath(b.path)}\n`);
  const groups = new Map();
  for (const survey of good.values()) {
    for (const row of survey.rows) {
      const text = searchable(row);
      if (!args.words.some((w) => text.includes(w))) continue;
      const k = normaliseKey(row.key);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push({ id: survey.repository, row });
    }
  }
  const keys = [...groups.keys()].sort();
  const surveys = new Set(keys.flatMap((k) => groups.get(k).map((f) => f.id)));
  stdout.write(`Find: ${args.words.join(', ')}\n`);
  stdout.write(`Found: ${keys.length ? `${keys.length} key(s) in ${surveys.size} survey(s)` : 'no key in any survey'}\n`);
  for (const k of keys) {
    const found = groups.get(k).sort((a, b) => {
      const t = TABLE_ORDER.indexOf(a.row.table) - TABLE_ORDER.indexOf(b.row.table);
      return t || (a.id + a.row.key < b.id + b.row.key ? -1 : 1);
    });
    stdout.write(`\nKey: ${k}\n`);
    for (const { id, row } of found) {
      stdout.write(`- ${id} · ${FOUND_AS[row.table](row)}${row.key !== k ? ` · as ${row.key}` : ''}\n`);
    }
  }
  const missing = notSurveyed(listed, good);
  stdout.write(`\nNot surveyed: ${missing.length ? `${missing.join(', ')} -- never ruled out; search its code at a pinned commit` : 'none; every listed repository has a survey'}\n`);
  stdout.write('Next: run --readers on every key that fits the change, for its readers and their drift. A key added after a survey\'s commit is not here, so read the code at a pinned commit too.\n');
  stdout.write('Cite: never -- a survey points.\n');
  return EXIT.PASS;
}

function readGraph(listed) {
  const { good, bad } = loadSurveys();
  const graph = buildGraph([...good.values()]);
  const out = { ...graph, not_surveyed: notSurveyed(listed, good), not_read: bad.map((b) => b.path).sort() };
  stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  return EXIT.PASS;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const regPath = registryPath(args.registry);
  const registry = readRegistry(regPath);
  const problems = validateRegistry(registry, regPath);
  if (problems.length) {
    stderr.write(`FAIL: ${regPath} is not well formed; run check-registry first.\n${problems.map((p) => `  - ${p}`).join('\n')}\n`);
    process.exit(EXIT.FAIL);
  }
  const listed = registry.repositories;
  let exit;
  if (args.id !== null) exit = readOne(args, listed);
  else if (args.readers !== null) exit = readReaders(args, listed);
  else if (args.find !== null) exit = readFind(args, listed);
  else exit = readGraph(listed);
  process.exit(exit);
}

// The last line of an exit 2, 3 or 4 names this script and its code, so a shell line that hides
// the code, with a pipe or `; echo`, still tells the harness's failure record. Written at once,
// so a process.exit() never loses it.
process.on('exit', (code) => { if (code >= 2 && code <= 4) { try { writeSync(2, `HARNESS EXIT: read-survey ${code}\n`); } catch { /* stderr is closed */ } } });

try {
  main();
} catch (err) {
  if (err instanceof SpokeError) {
    stderr.write(`${err.exit === EXIT.CANNOT_VERIFY ? 'CANNOT VERIFY' : 'FAIL'}: ${err.message}\n${reasonLine(err.reason)}`);
    process.exit(err.exit);
  }
  stderr.write(`INTERNAL: ${err && err.stack ? err.stack : String(err)}\n`);
  process.exit(EXIT.INTERNAL);
}

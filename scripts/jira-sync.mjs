#!/usr/bin/env node
// Part of the harness asset library c6f3b4427d58f7c3 (see VERSION.json) · 2026-10-09
/**
 * jira-sync.mjs — the Jira mirror: what would it change, and make the tickets of a decomposition
 *
 *   usage:  node scripts/jira-sync.mjs plan  [<KEY> [--fact <fact> [--pr <url>]] | --all]
 *           node scripts/jira-sync.mjs apply [<KEY> [--fact <fact> [--pr <url>]] | --all]
 *           node scripts/jira-sync.mjs apply <KEY> --fact needs-person --link <url>
 *           node scripts/jira-sync.mjs apply <KEY> --fact person-answered
 *           node scripts/jira-sync.mjs epics [<board>]
 *           node scripts/jira-sync.mjs discover [<board>] [--draft]
 *           node scripts/jira-sync.mjs create <SLUG> [--epic <KEY> | --create-epic "<title>"]
 *           node scripts/jira-sync.mjs create <KEY>
 *
 * Jira is a read-only view of the repository: the repository stays the master record, and Jira
 * never decides a harness gate or command. This script works out what a ticket should show,
 * from facts the repository can prove, and says what differs. `plan`, `epics` and `discover`
 * only read. `create` makes the tickets of a decomposition, or of a defect, and records them in a
 * link file. `apply` is the other command that writes: it moves tickets along the routes
 * `trackers.json` names, and adds labels and comments.
 *
 *   plan      For one story or defect, or every one the trunk and the link files name, prints
 *             the facts it found, the ticket's state in Jira, and the actions a later `apply`
 *             would take, as JSON on stdout and a one-line summary per item on stderr.
 *   apply     Plans as `plan` does, then does it, for a ticket that is linked. A move is walked
 *             one hop at a time: each hop re-reads what Jira offers now, takes the one
 *             transition that qualifies, and reads the ticket back to see where it landed, so a
 *             reply that was lost is checked by looking and a hop is never taken twice. When the
 *             route is complete the ticket is labelled `shl-applied-<fact>`, and a move is never
 *             made on a ticket that carries that label, so a person who moved it back stays
 *             moved back. A ticket found already at the target, however it got there, is marked
 *             the same way and not moved. A hop that cannot be taken leaves the ticket where it
 *             stands, labelled `shl-waiting-on-human` with one comment saying why, and that is
 *             exit 0: a report, not a failure; the label comes off once a run gets the ticket
 *             somewhere and nothing is left stuck. A merged or validated fact adds one comment,
 *             and then its label, and a comment goes in only if its marker is not already at the
 *             start of one, so a re-run, or a run after a failure between the two, never says a
 *             thing twice and always finishes. One ticket Jira fails on is that ticket's finding
 *             and does not stop the others; only a refused credential does. A fact that only
 *             becomes possible after an earlier move, such as `started` once the design has been
 *             walked in, is finished in the same call. `apply --all` covers what the trunk alone
 *             proves; the three pull-request facts come with one KEY from the command that has
 *             just queried the pull request.
 *   needs-person
 *             A fact `apply <KEY> --fact needs-person --link <url>` mirrors when the harness stopped and an
 *             escalation waits for a person (`escalation.mjs`, the escalation's `[shl-harness]`
 *             issue in the hub). The story's own ticket gets the label `shl-waiting-on-human`, the
 *             same sign a move the sync could not make already leaves, so a Jira user sees one sign for
 *             "a person must act", and one comment with the link, marked `[shl:needs-person:<hash>]`, so a
 *             second run says nothing twice. The comment holds the link and no detail of the stop. It
 *             never opens a ticket: a story with no linked ticket is left alone. `--fact person-answered`
 *             takes the label off. The label also comes off when a later run moves the ticket on and
 *             nothing is left stuck, as before.
 *   epics     The open Epics in a board's project, so `/decompose` can offer them.
 *   discover  The board project's status ids and the sprint field's id, for `/connect-jira`.
 *             With `--draft`, it reads the connection from the working tree, not the trunk, so
 *             `/connect-jira` can run it on its branch before the pull request merges.
 *   create    Makes the tickets of one decomposition (`create <SLUG>`), each in Backlog, under
 *             an Epic the person chose (`--epic`) or asked to be created (`--create-epic`), or
 *             of one defect (`create <KEY>`), as a sub-task of its story's ticket. It runs only
 *             for work the trunk proves is queued, looks for a ticket carrying each key's label
 *             before it makes one, and never makes a second. It then writes the link file
 *             `docs/estate/tracker-links/<SLUG>.json` and commits it on the branch
 *             `harness/tracker-links-<SLUG>` with harness-commit.mjs, in a worktree of its own:
 *             the person's checkout is never switched, dirtied or left half-committed, and it
 *             may be dirty or on any branch. If the commit fails the ticket keys are still
 *             reported, and running `create` again adopts them by their labels. It never pushes
 *             and never opens a pull request: the code host is the command's. A story's ticket
 *             carries a Context section in its description: the story's `Hub commit:` line, the
 *             `Global:` release of its requirements document, and one row per `Context:` entry
 *             with its pin and where the trunk stands, as scripts/report-context.mjs reads them
 *             at create time. `apply` never edits a description, so drift after the create shows
 *             in the report, not in Jira.
 *
 * Whose Jira? The developer's own: `JIRA_USER` and `JIRA_API_TOKEN`, or the names
 * `docs/estate/trackers.json` gives, read from their environment, never a file. Every request
 * is made as them. An instance whose `auth.method` is `oauth` names one variable instead, which
 * holds that developer's OAuth 2.0 access token, sent as a bearer header to Atlassian's gateway.
 * HARNESS_JIRA_BASE_URL replaces the site's address, for a proxy or a fixture;
 * it replaces nothing else.
 *
 * Where facts come from, and why
 *   - The hub's trunk, never the working tree, with the gates' discipline: force-fetch, confirm
 *     the remote calls the branch its default, and read blobs at the commit confirmed.
 *     HARNESS_TRUNK names the trunk and must match, or the run is exit 2.
 *   - The one exception is `discover --draft`. It reads the tracker records from the working
 *     tree and proves them with check-trackers.mjs, as the trunk read does. It judges nothing
 *     and writes nothing: it takes only the site, the project and the credential variable names.
 *   - `queued`, `design-merged` and `validated` are asked of the sibling checks the hub install
 *     puts beside this file (check-decomposition, check-dev-ready, check-validation), each run
 *     against that trunk. This script never reads a design or a report to judge it.
 *   - `started`, `in-review` and `merged` are facts about a pull request, and this script never
 *     calls a code host. The command that has just queried the pull request passes the fact in:
 *     --fact started | in-review | merged, with --pr <url> for the last two. They need one KEY.
 *
 * Exit codes -- the gate's, and the highest across items:
 *   0  a plan was produced or applied, or no tracker is configured. A ticket waiting on a
 *      person is printed, not failed.
 *   1  verified and failed: a duplicate ticket, a ticket gone or moved, a board changed, two
 *      transitions that both qualify, a tracker file that is not well formed
 *   2  cannot verify: Jira unreachable or refusing the credential, no credential set, the
 *      trunk unreadable or moved during the run, a sibling check not installed
 *   3  usage
 *   4  internal
 *
 * What this script cannot see
 *   - Whether a transition would succeed. It sees the ones Jira offers now and the fields each
 *     asks for; Jira's validators run when one is taken.
 *   - Anything past the first hop of a route: the next hop's transitions exist only once the
 *     ticket is there.
 *   - A pull request. Those facts are the command's to hand in.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { stdout, stderr } from 'node:process';
import { fileURLToPath } from 'node:url';
import { EXIT, SpokeError, reasonIn, reasonLine, git, firstLine, resolveDefaultBranch, quietGitEnv, short } from './spoke-remote.mjs';
import { createClient, JiraError } from './jira.mjs';
import { contextReport, contextReportHubCommitLine, contextRowLine, recordedRelease } from './context-docs.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

const CONFIG = {
  remote: 'origin',
  branch: process.env.HARNESS_TRUNK || 'main',
  trackersPath: 'docs/estate/trackers.json',
  linksDir: 'docs/estate/tracker-links',
  ledgerPath: 'docs/backlog/keys.json',
  backlogDir: 'docs/backlog',
  designDir: 'docs/designs',
  requirementsDir: 'docs/requirements',
  itemSuffix: '.item.md',
  recordSuffix: '.decomposition.md',
  designSuffix: '.lld.md',
  reportSuffix: '.validation.md',
  keyPattern: /^[A-Z][A-Z0-9]{1,9}-\d+$/,
  slugPattern: /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
  itemBoardLine: /^Jira board:[ \t]*(\S.*?)\s*$/m,
  requirementsBoardRow: /^\|[ \t]*Jira board[ \t]*\|[ \t]*`?([a-z][a-z0-9-]*)`?[ \t]*\|/m,
  keyLabel: 'shl-key-',
  appliedLabel: 'shl-applied-',
  waitingLabel: 'shl-waiting-on-human',
  moveOrder: ['design-merged', 'started', 'in-review'],
  passedFacts: ['started', 'in-review', 'merged'],
  // Facts about an escalation, not about a pull request: they never decide a move.
  escalationFacts: ['needs-person', 'person-answered'],
};

/* ------------------------------------------------------------------- usage */

function usage(message) {
  const invoked = process.argv[1] || 'scripts/jira-sync.mjs';
  stderr.write(`${message}\nusage: node ${invoked} plan|apply [<KEY> [--fact started|in-review|merged [--pr <url>]] | --all]\n       node ${invoked} epics [<board>]\n       node ${invoked} discover [<board>] [--draft]\n`);
  process.exit(EXIT.USAGE);
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!command) usage('no command');
  if (!['plan', 'apply', 'epics', 'discover', 'create'].includes(command)) usage(`unknown command ${command}`);
  const out = { command, key: null, slug: null, all: false, draft: false, fact: null, pr: null, link: null, board: null, epic: null, createEpic: null };
  const flags = { '--fact': 'fact', '--pr': 'pr', '--link': 'link', '--epic': 'epic', '--create-epic': 'createEpic' };
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i];
    if (a === '--all') out.all = true;
    else if (a === '--draft') out.draft = true;
    else if (Object.hasOwn(flags, a)) {
      const v = rest[i + 1];
      if (v === undefined || v.startsWith('--')) usage(`${a} needs a value`);
      out[flags[a]] = v;
      i += 1;
    } else if (a.startsWith('--')) usage(`unknown argument ${a}`);
    else if ((command === 'plan' || command === 'apply') && out.key === null) out.key = a;
    else if (command === 'create' && out.key === null && out.slug === null) {
      if (a.search(CONFIG.keyPattern) >= 0) out.key = a;
      else if (a.search(CONFIG.slugPattern) >= 0) out.slug = a;
      else usage(`${a} is neither a harness key nor a slug`);
    } else if (!['plan', 'apply', 'create'].includes(command) && out.board === null) out.board = a;
    else usage(`unexpected argument ${a}`);
  }
  if (out.draft && command !== 'discover') usage('--draft goes with discover: every other command reads the trunk');
  if (command === 'plan' || command === 'apply') {
    if (out.key && out.all) usage('name a KEY or --all, not both');
    if (!out.key && !out.all) usage(`${command} needs a KEY or --all`);
    if (out.key && out.key.search(CONFIG.keyPattern) < 0) usage(`${out.key} is not a harness key`);
    if (out.fact && !out.key) usage('--fact needs one KEY: a fact is about one story');
    if (out.fact && ![...CONFIG.passedFacts, ...CONFIG.escalationFacts].includes(out.fact)) usage(`--fact must be one of ${[...CONFIG.passedFacts, ...CONFIG.escalationFacts].join(', ')}`);
    if (out.pr && !out.fact) usage('--pr goes with --fact');
    if (out.pr && CONFIG.escalationFacts.includes(out.fact)) usage(`--pr goes with ${CONFIG.passedFacts.join(', ')}, not with ${out.fact}`);
    if (out.link && out.fact !== 'needs-person') usage('--link goes with --fact needs-person');
    if (out.fact === 'needs-person' && (!out.link || out.link.search(/^https?:\/\/\S+$/) < 0)) usage('--fact needs-person needs --link <the https address of the escalation>');
    if (out.epic || out.createEpic) usage('--epic and --create-epic go with create');
  } else if (command === 'create') {
    if (!out.key && !out.slug) usage('create needs a SLUG (a decomposition) or a KEY (a defect)');
    if (out.all || out.fact || out.pr || out.link) usage('create takes a SLUG or a KEY, and --epic or --create-epic');
    if (out.epic && out.createEpic) usage('name an existing Epic with --epic or ask for one with --create-epic, not both');
    if (out.key && (out.epic || out.createEpic)) usage('a defect is a sub-task of its story and takes no Epic');
    if (out.epic && out.epic.search(CONFIG.keyPattern) < 0) usage(`--epic needs the Epic's ticket key, such as PROJ-12`);
    if (out.createEpic !== null && out.createEpic.trim() === '') usage('--create-epic needs a title');
  } else if (out.key || out.all || out.fact || out.pr || out.link || out.epic || out.createEpic) {
    usage(`${command} takes only a board id`);
  }
  return out;
}

/* ---------------------------------------------------------------- hub trunk */

function remoteUrl() {
  try {
    return git(['remote', 'get-url', CONFIG.remote]).trim();
  } catch (err) {
    throw new SpokeError(EXIT.CANNOT_VERIFY, `this checkout has no remote called ${CONFIG.remote}; run from the hub checkout`, 'no-remote');
  }
}

// The gate's discipline, as check-fan-in.mjs carries it: fetch the named branch, then confirm
// the remote itself calls that branch its default. HARNESS_TRUNK names the trunk; it does not
// choose one.
function syncHubTrunk() {
  const url = remoteUrl();
  const ref = `${CONFIG.remote}/${CONFIG.branch}`;
  try {
    git(['fetch', '--no-tags', '--prune', '--force', CONFIG.remote, `+refs/heads/${CONFIG.branch}:refs/remotes/${ref}`], { env: quietGitEnv() });
  } catch (err) {
    throw new SpokeError(EXIT.CANNOT_VERIFY, `could not fetch ${ref} (${firstLine(err.stderr) || err.message})`, 'fetch-failed');
  }
  let actual;
  try {
    ({ trunk: actual } = resolveDefaultBranch(url, git(['rev-parse', '--git-dir']).trim()));
  } catch (err) {
    if (!(err instanceof SpokeError)) throw err;
    throw new SpokeError(EXIT.CANNOT_VERIFY, `${CONFIG.remote} reports no default branch, so "${CONFIG.branch}" cannot be confirmed as the trunk (${err.message})`, 'no-default-branch');
  }
  if (actual !== CONFIG.branch) {
    throw new SpokeError(EXIT.CANNOT_VERIFY, `this was pointed at "${CONFIG.branch}" but ${CONFIG.remote}'s default branch is "${actual}"; set HARNESS_TRUNK to the trunk's real name`, 'trunk-mismatch');
  }
  let head;
  try {
    head = git(['rev-parse', '--verify', `${ref}^{commit}`]).trim();
  } catch (err) {
    throw new SpokeError(EXIT.CANNOT_VERIFY, `${ref} does not resolve to a commit after fetch`, 'fetch-failed');
  }
  return { ref, head, url };
}

function readBlob(commit, path) {
  try {
    return git(['show', `${commit}:${path}`]).replace(/^\uFEFF/, '');
  } catch (err) {
    return null;
  }
}

// Entries directly under `dir` at `commit`, by name; `:(top)` anchors the pathspec to the root.
function listNames(commit, dir) {
  let out;
  try {
    out = git(['ls-tree', '-z', '--full-name', '--name-only', commit, '--', `:(top)${dir}/`]);
  } catch (err) {
    return [];
  }
  return out.split('\0').filter(Boolean).map((p) => p.slice(p.lastIndexOf('/') + 1)).sort();
}

function parseJson(text, what, where) {
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new SpokeError(EXIT.FAIL, `${what} ${where} is not JSON: ${err.message}`);
  }
}

/* ----------------------------------------------------------- sibling checks */

function sibling(name) {
  for (const dir of [HERE, resolve(HERE, '..', 'gate')]) {
    for (const ext of ['.js', '.mjs']) {
      const path = join(dir, `${name}${ext}`);
      if (existsSync(path)) return path;
    }
  }
  throw new SpokeError(EXIT.CANNOT_VERIFY, `${name}.js (or .mjs) is not beside ${basename(process.argv[1] || 'jira-sync.mjs')}; the hub install puts the gate and its sibling checks in one directory`, 'script-missing');
}

// A sibling fetches the trunk again and judges its tip. If the tip moved from the one this run
// confirmed, one run must not mix two versions of the repository.
function runSibling(name, arg, hub) {
  const path = sibling(name);
  const res = spawnSync(process.execPath, [path, arg], {
    cwd: process.cwd(),
    env: { ...process.env, HARNESS_TRUNK: CONFIG.branch },
    encoding: 'utf8',
  });
  if (res.error) throw new SpokeError(EXIT.INTERNAL, `could not run ${basename(path)}: ${res.error.message}`);
  const now = git(['rev-parse', '--verify', `${hub.ref}^{commit}`]).trim();
  if (now !== hub.head) throw new SpokeError(EXIT.CANNOT_VERIFY, `${hub.ref} moved from ${short(hub.head)} to ${short(now)} while this ran; run again`, 'trunk-moved');
  if (res.status === EXIT.CANNOT_VERIFY) {
    throw new SpokeError(EXIT.CANNOT_VERIFY, `${basename(path)} ${arg}: ${firstLine(String(res.stderr).replace(/^\s*CANNOT VERIFY:\s*/m, '')) || 'refused to judge'}`, reasonIn(String(res.stderr)));
  }
  if (res.status !== EXIT.PASS && res.status !== EXIT.FAIL) {
    throw new SpokeError(EXIT.INTERNAL, `${basename(path)} ${arg} exited ${res.status}: ${firstLine(res.stderr) || firstLine(res.stdout) || 'no output'}`);
  }
  return res.status === EXIT.PASS;
}

/* ------------------------------------------------------ the tracker records */

// Where the tracker records are read from. Every command reads the trunk. `discover --draft`
// reads the working tree instead, because /connect-jira runs it on its branch before the
// connection is on the trunk. That read judges nothing and writes nothing.
function trunkSource(hub) {
  return { where: `on ${hub.ref}`, read: (path) => readBlob(hub.head, path), list: (dir) => listNames(hub.head, dir) };
}

function workingTreeSource() {
  const read = (path) => {
    try {
      return readFileSync(path, 'utf8').replace(/^\uFEFF/, '');
    } catch (err) {
      return null;
    }
  };
  const list = (dir) => {
    try {
      return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name).sort();
    } catch (err) {
      return [];
    }
  };
  return { where: 'in the working tree', read, list };
}

// Read the connection, the link files and the key ledger from one source, lay them out in a
// temporary folder as a hub keeps them, and ask check-trackers.mjs about that folder. The check
// is the one the hub runs by hand; this uses it unmodified, so the two cannot disagree.
function loadTrackers(source) {
  const text = source.read(CONFIG.trackersPath);
  if (text === null) return null;
  const trackers = parseJson(text, CONFIG.trackersPath, source.where);
  const linkNames = source.list(CONFIG.linksDir).filter((n) => n.endsWith('.json'));
  const linkTexts = {};
  const links = {};
  for (const name of linkNames) {
    linkTexts[name] = source.read(`${CONFIG.linksDir}/${name}`) || '';
    links[name.slice(0, -'.json'.length)] = parseJson(linkTexts[name], `${CONFIG.linksDir}/${name}`, source.where);
  }
  const ledgerText = source.read(CONFIG.ledgerPath);
  const ledger = ledgerText === null ? null : parseJson(ledgerText, CONFIG.ledgerPath, source.where);

  const dir = mkdtempSync(join(tmpdir(), 'jira-sync-'));
  try {
    const put = (rel, body) => { mkdirSync(dirname(join(dir, rel)), { recursive: true }); writeFileSync(join(dir, rel), body); };
    put(CONFIG.trackersPath, text);
    for (const name of linkNames) put(`${CONFIG.linksDir}/${name}`, linkTexts[name]);
    if (ledgerText !== null) put(CONFIG.ledgerPath, ledgerText);
    const res = spawnSync(process.execPath, [sibling('check-trackers')], { cwd: dir, encoding: 'utf8' });
    if (res.error) throw new SpokeError(EXIT.INTERNAL, `could not run check-trackers: ${res.error.message}`);
    if (res.status !== EXIT.PASS) {
      const findings = String(res.stdout).split('\n').filter((l) => /^\s+- /.test(l)).map((l) => l.trim());
      throw new SpokeError(res.status === EXIT.CANNOT_VERIFY ? EXIT.CANNOT_VERIFY : EXIT.FAIL, `the tracker records ${source.where} are not well formed; run check-trackers first:\n  ${findings.join('\n  ') || firstLine(res.stderr)}`, res.status === EXIT.CANNOT_VERIFY ? reasonIn(`${res.stdout}\n${res.stderr}`) : null);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return { trackers, links, ledger };
}

function boardOf(trackers, id) {
  const boardId = id || trackers.default_board;
  const board = trackers.boards[boardId];
  if (!board) throw new SpokeError(EXIT.FAIL, `no board "${boardId}" in ${CONFIG.trackersPath}; boards are ${Object.keys(trackers.boards).join(', ')}`);
  return { id: boardId, ...board, instanceConfig: trackers.instances[board.instance] };
}

function clientFor(board) {
  const inst = board.instanceConfig;
  const baseUrl = process.env.HARNESS_JIRA_BASE_URL || inst.base_url || `https://${inst.site}`;
  const token = process.env[inst.auth.token_env];
  // An OAuth access token says who it is, so there is no user to read.
  if (inst.auth.method === 'oauth') {
    if (!token) {
      throw new SpokeError(EXIT.CANNOT_VERIFY, `set ${inst.auth.token_env} in your environment: Jira is asked as you, with your own OAuth access token, and this hub's file names that variable`, 'credential-missing');
    }
    return createClient({ baseUrl, token, scheme: 'bearer' });
  }
  const user = process.env[inst.auth.user_env];
  if (!user || !token) {
    throw new SpokeError(EXIT.CANNOT_VERIFY, `set ${inst.auth.user_env} and ${inst.auth.token_env} in your environment: Jira is asked as you, with your own token, and this hub's file names those two variables`, 'credential-missing');
  }
  return createClient({ baseUrl, user, token });
}

/* ------------------------------------------------------------------- items */

// Every story and defect this hub knows: the stories on the trunk, the defects the ledger's
// validation blocks minted, and anything a link file names that neither shows.
function collectItems(hub, rec) {
  const items = new Map();
  const slugs = new Set(Object.keys(rec.links));
  for (const name of listNames(hub.head, CONFIG.backlogDir)) {
    if (name.endsWith(CONFIG.recordSuffix)) slugs.add(name.slice(0, -CONFIG.recordSuffix.length));
  }
  for (const slug of [...slugs].sort()) {
    if (slug.search(CONFIG.slugPattern) < 0) continue;
    for (const file of listNames(hub.head, `${CONFIG.backlogDir}/${slug}`).filter((f) => f.endsWith(CONFIG.itemSuffix))) {
      const key = file.slice(0, -CONFIG.itemSuffix.length);
      if (key.search(CONFIG.keyPattern) >= 0) items.set(key, { key, type: 'story', slug, itemPath: `${CONFIG.backlogDir}/${slug}/${file}` });
    }
  }
  const ledger = rec.ledger;
  if (ledger && Array.isArray(ledger.blocks)) {
    for (const b of ledger.blocks) {
      if (b.taken_by !== 'validation' || !Number.isInteger(b.from) || !Number.isInteger(b.to)) continue;
      for (let n = b.from; n <= b.to; n += 1) {
        const key = `${ledger.prefix}-${n}`;
        const parent = items.get(b.key) || null;
        items.set(key, { key, type: 'defect', parent: b.key, slug: parent ? parent.slug : null });
      }
    }
  }
  for (const [slug, file] of Object.entries(rec.links)) {
    for (const [key, link] of Object.entries(file.items || {})) {
      if (!items.has(key)) items.set(key, { key, type: link.type, slug, parent: link.parent || null });
    }
  }
  return items;
}

const linkOf = (rec, item) => (item.slug && rec.links[item.slug] && rec.links[item.slug].items[item.key]) || null;

function resolveBoardId(hub, rec, item, parentBoard) {
  if (item.type === 'defect') return parentBoard;
  if (item.itemPath) {
    const m = (readBlob(hub.head, item.itemPath) || '').match(CONFIG.itemBoardLine);
    if (m) return m[1];
  }
  if (item.slug) {
    const m = (readBlob(hub.head, `${CONFIG.requirementsDir}/${item.slug}/requirements.md`) || '').match(CONFIG.requirementsBoardRow);
    if (m) return m[1];
  }
  return rec.trackers.default_board;
}

/* ------------------------------------------------------------------- facts */

// The report's closing line: `Criteria: <n> · PASS <n> · FAIL <n> · defects raised: <keys|NONE>`.
// check-validation now passes only `FAIL 0` and `NONE`; keys here come from a report an older
// /qa-sprint wrote, and name the defects a legacy defect item is queued under.
function readClosing(text) {
  const line = (text || '').split('\n').find((l) => l.trim().search(/^Criteria:/) >= 0);
  if (!line) return null;
  const parts = line.split('·').map((s) => s.trim());
  const num = (label) => {
    const p = parts.find((x) => x.toUpperCase().startsWith(label));
    const m = p && p.match(/(\d+)\s*$/);
    return m ? Number(m[1]) : null;
  };
  const raised = parts.find((x) => x.search(/^defects raised:/i) >= 0);
  const defects = raised ? raised.replace(/^defects raised:\s*/i, '').split(',').map((s) => s.trim()).filter((s) => s.search(CONFIG.keyPattern) >= 0) : [];
  return { fail: num('FAIL'), pass: num('PASS'), defects };
}

function trunkFacts(hub, item, cache) {
  const notes = [];
  const facts = { queued: false, 'design-merged': false, validated: null };
  const check = (name, arg) => {
    const k = `${name}:${arg}`;
    if (!cache.has(k)) cache.set(k, runSibling(name, arg, hub));
    return cache.get(k);
  };
  const reportOf = (key) => readBlob(hub.head, `${CONFIG.designDir}/${key}${CONFIG.reportSuffix}`);

  if (item.type === 'story') {
    if (item.slug && check('check-decomposition', item.slug)) facts.queued = true;
    else notes.push(`decomposition of ${item.slug || 'its slug'} does not pass check-decomposition, so ${item.key} is not queued`);
  } else {
    const closing = item.parent && reportOf(item.parent) ? readClosing(reportOf(item.parent)) : null;
    if (closing && closing.defects.includes(item.key) && check('check-validation', item.parent)) facts.queued = true;
    else notes.push(`no passing validation report for ${item.parent || 'its parent'} names ${item.key}, so it is not queued`);
  }

  if (readBlob(hub.head, `${CONFIG.designDir}/${item.key}${CONFIG.designSuffix}`) !== null) {
    facts['design-merged'] = check('check-dev-ready', item.key);
    if (!facts['design-merged']) notes.push('the design is on the trunk but the pickup gate does not pass');
  }

  const report = reportOf(item.key);
  if (report !== null) {
    if (!check('check-validation', item.key)) {
      notes.push('a validation report is on the trunk but check-validation does not pass');
    } else {
      // A report on the trunk passes only when every criterion passed: a failing one goes back to
      // /dev-sprint before the code merge and never reaches the hub.
      const closing = readClosing(report);
      if (!closing || closing.fail === null) notes.push('the validation report has no readable Criteria line');
      else if (closing.fail === 0) facts.validated = 'pass';
      else notes.push(`the validation report records ${closing.fail} FAIL and the installed check-validation passed it, so that check is older than this file; ${item.key} is not marked validated`);
    }
  }
  return { facts, notes };
}

/* ----------------------------------------------------------------- planning */

const idOf = (board, name) => (board.status_ids && board.status_ids[name]) || null;

// Where the ticket is, among this board's sprints: in the active one, planned into a later one (a
// person's choice that the sync must not override), or in none.
function sprintState(issue, board) {
  if (!board.sprint_field) return 'unknown';
  const list = issue.fields[board.sprint_field];
  // Jira answers null for a ticket that is in no sprint at all, as every ticket in Backlog is.
  if (list === null) return 'not-in';
  if (!Array.isArray(list)) return 'unknown';
  const mine = list.filter((sp) => sp && sp.boardId === board.board);
  if (mine.some((sp) => sp.state === 'active')) return 'in';
  if (mine.some((sp) => sp.state === 'future')) return 'elsewhere';
  return 'not-in';
}

// The transitions that may be taken to reach `next`: available, and not a loop. A global transition
// ("any status to this one") is how a simple workflow is built, and it qualifies: the route fixes
// the destination one status at a time and only goes forward, so a global transition cannot skip a
// step or go back any more than another can. Plan and apply both choose through this, so they cannot
// disagree about what qualifies.
const qualifying = (transitions, next) => transitions.filter((t) => t.isAvailable && !t.isLooped && t.to.name === next);

async function planMove(client, issue, board, fact, route, notes, findings, key) {
  const names = route;
  const target = names[names.length - 1];
  const byId = names.map((n) => idOf(board, n));
  const useIds = byId.every(Boolean);
  const at = useIds ? byId.indexOf(issue.status.id) : names.indexOf(issue.status.name);
  if (useIds && at === -1 && names.includes(issue.status.name)) {
    notes.push(`${fact}: the ticket's status "${issue.status.name}" has id ${issue.status.id}, not the ${idOf(board, issue.status.name)} the board records; a status may have been renamed`);
  }
  if (at === -1) return { kind: 'none', fact, reason: `status "${issue.status.name}" is not on the route, no action` };
  // Already at the target, however it got there: the fact is satisfied, so the ticket is marked as
  // applied. Without the mark, a person who later sent it back would have it walked forward again.
  if (at === names.length - 1) return { kind: 'mark', fact, reason: `already at ${target}` };
  const next = names[at + 1];
  const options = qualifying(await client.transitions(key), next);
  const base = { kind: 'move', fact, from: { id: issue.status.id, name: issue.status.name }, to: target, hops: names.slice(at + 1) };
  if (options.length > 1) {
    findings.push(`${key}: ${options.length} transitions to "${next}" qualify (${options.map((t) => `${t.id} ${t.name}`).join(', ')}); the sync never picks the first`);
    return { ...base, status: 'blocked', reason: 'ambiguous transition' };
  }
  if (options.length === 0) return { ...base, status: 'blocked', reason: `no available transition to "${next}"` };
  const t = options[0];
  if (t.requiredFields.length) return { ...base, status: 'blocked', reason: `transition "${t.name}" asks for ${t.requiredFields.map((f) => f.name).join(', ')}`, firstHop: { transitionId: t.id, name: t.name } };
  return { ...base, status: 'ready', firstHop: { transitionId: t.id, name: t.name } };
}

async function planItem({ hub, rec, item, clientOf, cache, passed, parentBoards }) {
  const out = { key: item.key, type: item.type, slug: item.slug, parent: item.parent || null, board: null, ticket: null, facts: null, actions: [], notes: [], findings: [] };
  const link = linkOf(rec, item);
  const parentBoard = item.parent && rec.links[item.slug] && rec.links[item.slug].items[item.parent] ? rec.links[item.slug].items[item.parent].board : (parentBoards.get(item.parent) || rec.trackers.default_board);
  const wantedBoardId = resolveBoardId(hub, rec, item, parentBoard);
  const boardId = link ? link.board : wantedBoardId;
  out.board = boardId;
  parentBoards.set(item.key, boardId);
  const board = boardOf(rec.trackers, boardId);
  const client = clientOf(board);
  const mapping = rec.trackers.types[item.type];
  if (!mapping) { out.notes.push(`no mapping for ${item.type} in ${CONFIG.trackersPath}; nothing to mirror`); return out; }
  if (link && wantedBoardId !== link.board) out.findings.push(`${item.key}: board changed to "${wantedBoardId}" since its ticket was linked on "${link.board}"; the ticket is not moved`);

  const { facts, notes } = trunkFacts(hub, item, cache);
  out.notes.push(...notes);
  const given = {};
  if (passed) given[passed.fact] = true;
  out.facts = { queued: facts.queued, 'design-merged': facts['design-merged'], started: !!given.started, 'in-review': !!given['in-review'], merged: !!given.merged, validated: facts.validated };

  if (!link) {
    if (!facts.queued) return out;
    const found = await client.search(`project = ${board.project} AND labels = "${CONFIG.keyLabel}${item.key}"`, { limit: 10 });
    if (found.length > 1) out.findings.push(`${item.key}: ${found.length} tickets carry the label ${CONFIG.keyLabel}${item.key} (${found.map((f) => f.key).join(', ')}); none is chosen`);
    else if (found.length === 1) out.actions.push({ kind: 'adopt', ticket: found[0].key, reason: 'a ticket already carries this key\'s label and no link file names it' });
    else {
      const needsEpic = item.type === 'story' && board.epics === 'ask';
      out.actions.push({ kind: 'create', issueType: mapping.issue_type, project: board.project, status: 'Backlog', ...(item.parent ? { parent: item.parent } : {}), ...(needsEpic ? { epic: 'asked at /decompose' } : {}) });
    }
    return out;
  }

  const ref = link.ticket.slice(link.ticket.indexOf(':') + 1);
  out.ticket = { ref: link.ticket, key: ref };
  let issue;
  try {
    issue = await client.issue(ref, board.sprint_field ? [board.sprint_field] : []);
  } catch (err) {
    if (err instanceof JiraError && err.status === 404) { out.findings.push(`${item.key}: ticket ${ref} is gone (404); it is never recreated unless a person says so`); return out; }
    throw err;
  }
  out.ticket = { ref: link.ticket, key: issue.key, status: issue.status, labels: issue.labels, sprint: sprintState(issue, board) };
  if (issue.project !== board.project) { out.findings.push(`${item.key}: ${issue.key} is in project ${issue.project}, not ${board.project}; it was moved, and the sync does not follow it`); return out; }
  if (issue.labels.includes(CONFIG.waitingLabel)) out.notes.push('the ticket is labelled as waiting on a human');

  // A later pull-request fact being true means the earlier ones are too, so a run that finds a
  // ticket still behind an earlier hop (a `started` that failed, or never came) catches it up in order.
  const later = (fact) => CONFIG.passedFacts.indexOf(passed ? passed.fact : null) >= CONFIG.passedFacts.indexOf(fact);
  const ready = { 'design-merged': facts['design-merged'], started: later('started'), 'in-review': later('in-review') };
  for (const fact of CONFIG.moveOrder) {
    const move = mapping.moves[fact];
    if (!move || !ready[fact]) continue;
    if (issue.labels.includes(`${CONFIG.appliedLabel}${fact}`)) { out.actions.push({ kind: 'none', fact, reason: `already applied (${CONFIG.appliedLabel}${fact}); a person who moved it back wins until the label is removed` }); continue; }
    out.actions.push(await planMove(client, issue, board, fact, move.route, out.notes, out.findings, issue.key));
  }
  // An annotation is wanted while either half is missing, the label or the marker comment, so one
  // that failed between the two is finished by the next run and not lost.
  // Only a comment the acting developer wrote counts, so a person's comment that happens to start
  // with a marker does not stand in for the harness's.
  let mine = null;
  const haveMarker = async (marker) => {
    if (mine === null) {
      const [me, all] = await Promise.all([client.myself(), client.comments(issue.key)]);
      mine = all.filter((c) => c.accountId === me.accountId).map((c) => c.text);
    }
    return mine.some((x) => x.trim().startsWith(marker));
  };
  const annotate = async (fact, labels, marker, extra = {}) => {
    if (!mapping.annotations[fact]) return;
    const missing = labels.filter((l) => !issue.labels.includes(l));
    if (missing.length || !(await haveMarker(marker))) out.actions.push({ kind: 'annotate', fact, labels: missing, marker, ...extra });
  };
  const own = (fact) => (mapping.annotations[fact] ? [mapping.annotations[fact].label] : []);
  if (given.merged) await annotate('merged', own('merged'), '[shl:merged]', { pr: passed.pr || null });
  // A report on the trunk passes only when every criterion passed, so a validated fact is always a
  // pass. A failing report goes back to /dev-sprint before the code merge and never reaches the hub.
  if (facts.validated === 'pass') await annotate('validated', own('validated'), '[shl:validated]');
  // A person is needed. The story's own ticket shows it with the one sign the sync already uses for a
  // step it cannot take, and one comment with the link. The label and the comment are each wanted
  // while either is missing, so a run that failed between the two is finished by the next. Never a
  // new ticket: this part of the plan is reached only for a ticket that a link file names.
  if (given['needs-person']) {
    const marker = `[shl:needs-person:${shortHash(passed.link)}]`;
    const missing = issue.labels.includes(CONFIG.waitingLabel) ? [] : [CONFIG.waitingLabel];
    if (missing.length || !(await haveMarker(marker))) out.actions.push({ kind: 'needs-person', fact: 'needs-person', marker, link: passed.link, labels: missing });
  }
  if (given['person-answered'] && issue.labels.includes(CONFIG.waitingLabel)) out.actions.push({ kind: 'person-answered', fact: 'person-answered' });
  // A ticket whose work finished in a closed sprint is Done, and carrying it into the next sprint
  // would put finished work on the new sprint's board.
  if (board.sprint === 'add' && out.ticket.sprint === 'not-in' && issue.status.category !== 'done') out.actions.push({ kind: 'add-to-sprint', board: board.board });
  return out;
}

/* ------------------------------------------------------------------------ create */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The item file's first heading is `# <KEY> — <title>`.
function titleOf(hub, item) {
  const text = item.itemPath ? readBlob(hub.head, item.itemPath) : null;
  const m = text && text.match(/^#[ \t]+[A-Z][A-Z0-9]{1,9}-\d+[ \t]+[—–-]+[ \t]+(.+?)\s*$/m);
  return m ? m[1] : null;
}

// The Context section of a story's ticket: the story's lines read against the hub's
// history at create time, as scripts/report-context.mjs reads them, so a reader of the ticket
// sees which hub commit held the documents and whether the trunk still does. A finding on the
// lines is a `Not read:` row, never a failure of the create: the gate judges the story, and the
// mirror shows it. A defect has no item file and no section.
function contextSectionOf(hub, item) {
  if (!item.itemPath) return [];
  const text = readBlob(hub.head, item.itemPath);
  if (text === null) return [];
  const report = contextReport({ root: '.', path: item.itemPath, text, trunk: `refs/remotes/${CONFIG.remote}/${CONFIG.branch}` });
  const source = item.slug ? readBlob(hub.head, `${CONFIG.requirementsDir}/${item.slug}/requirements.md`) : null;
  const release = source === null ? null : recordedRelease(source);
  const lines = ['Context', contextReportHubCommitLine(report), release ? `Global: ${release.tag} ${release.commit}` : release === false ? 'Global: not read' : 'Global: none'];
  if (report.context.value === 'none') lines.push('Context: none');
  else lines.push(...report.rows.map(contextRowLine));
  for (const f of [...report.findings, ...report.cannot]) lines.push(`Not read: ${f}`);
  return lines;
}

// `<KEY>: <title>`, cut to Jira's 255 at a word boundary.
function summaryOf(key, title) {
  const full = title ? `${key}: ${title}` : key;
  if (Array.from(full).length <= 255) return full;
  const cut = Array.from(full).slice(0, 252).join('');
  const at = cut.lastIndexOf(' ');
  return `${at > key.length + 2 ? cut.slice(0, at) : cut}...`;
}

const numberOf = (key) => Number(key.slice(key.lastIndexOf('-') + 1));

// Jira's search is eventually consistent: a ticket an earlier run made a moment ago, whose reply
// was lost, can be absent from a search that already shows its neighbours. Look, and while
// anything wanted is still missing look again after a pause, up to `looks` looks in all: two on
// a run that follows nothing uncertain, more (HARNESS_JIRA_SEARCH_LOOKS, default 3) on a run that
// follows a create whose outcome was unknown. The pauses are shared by every ticket of the run.
// This narrows the window; it does not close it, and the rule file says where it stays open.
async function searchLooks(search, look, haveAll) {
  let found = await search();
  for (let n = 1; n < look.looks && !haveAll(found); n += 1) {
    await sleep(look.lagMs);
    const again = await search();
    const seen = new Set(found.map((t) => t.key));
    found = [...found, ...again.filter((t) => !seen.has(t.key))];
  }
  return found;
}

// A create whose outcome Jira never confirmed leaves a note inside this checkout's .git (never in
// the work tree), so the next run on this checkout knows a ticket may exist that the index has not
// caught up with, and looks more times before it decides there is none.
function uncertainFile(slug) {
  return join(resolve(git(['rev-parse', '--git-common-dir']).trim()), `shl-jira-uncertain-${slug}`);
}
function wasUncertain(slug) {
  try { return existsSync(uncertainFile(slug)); } catch { return false; }
}
function setUncertain(slug, on) {
  try {
    if (on) writeFileSync(uncertainFile(slug), `${new Date().toISOString()}\n`);
    else rmSync(uncertainFile(slug), { force: true });
  } catch { /* the note only buys extra looks; losing it loses nothing else */ }
}
function lookFor(slug, lagMs) {
  const asked = Number(process.env.HARNESS_JIRA_SEARCH_LOOKS ?? 3);
  const more = Number.isInteger(asked) && asked >= 2 ? Math.min(asked, 10) : 3;
  return { lagMs, looks: wasUncertain(slug) ? more : 2 };
}

// Every ticket carrying a key's label, by key, whichever project it is in now: a ticket someone
// moved is still the ticket for that key, and a second one must not be made beside it.
async function findByKeyLabels(client, keys, look) {
  const labels = keys.map((k) => `${CONFIG.keyLabel}${k}`);
  const jql = `labels in (${labels.map((l) => `"${l}"`).join(', ')})`;
  const byKey = new Map();
  const index = (found) => {
    byKey.clear();
    for (const t of found) {
      for (const l of t.labels) {
        if (!l.startsWith(CONFIG.keyLabel)) continue;
        const k = l.slice(CONFIG.keyLabel.length);
        if (!byKey.has(k)) byKey.set(k, []);
        byKey.get(k).push({ key: t.key, project: t.project });
      }
    }
    return keys.every((k) => byKey.has(k));
  };
  const found = await searchLooks(() => client.search(jql, { limit: 200 }), look, (f) => index(f));
  index(found);
  return byKey;
}

// The Epic is asked for once per decomposition and recorded in its link file. No Epic key is
// ever configured, because which Epic is a choice for the people doing the work.
async function resolveEpic({ args, recorded, slug, board, client, instanceId, notes, look }) {
  if (recorded) {
    if (args.createEpic !== null) notes.push(`${slug} already has the Epic ${recorded} recorded, so --create-epic makes none and the recorded one is used`);
    return { ref: recorded, key: recorded.slice(recorded.indexOf(':') + 1), existing: true };
  }
  if (board.epics === 'none') {
    if (args.epic || args.createEpic !== null) throw new SpokeError(EXIT.USAGE, `board "${board.id}" does not use Epics (epics: "none"), so --epic and --create-epic do not apply`);
    return null;
  }
  if (args.epic) {
    let epic;
    try {
      epic = await client.issue(args.epic);
    } catch (err) {
      if (err instanceof JiraError && err.status === 404) throw new SpokeError(EXIT.FAIL, `--epic ${args.epic}: no such ticket`);
      throw err;
    }
    if (epic.issueType !== 'Epic') throw new SpokeError(EXIT.FAIL, `--epic ${args.epic} is a ${epic.issueType}, not an Epic`);
    if (epic.project !== board.project) throw new SpokeError(EXIT.FAIL, `--epic ${args.epic} is in project ${epic.project}, but board "${board.id}" is project ${board.project}`);
    return { ref: `${instanceId}:${epic.key}`, key: epic.key, existing: false };
  }
  if (args.createEpic !== null) {
    const label = `shl-slug-${slug}`;
    const found = await searchLooks(
      () => client.search(`project = "${board.project}" AND issuetype = Epic AND labels = "${label}"`, { limit: 10 }),
      look,
      (f) => f.length > 0,
    );
    if (found.length > 1) throw new SpokeError(EXIT.FAIL, `${found.length} Epics carry the label ${label} (${found.map((f) => f.key).join(', ')}); name one with --epic`);
    if (found.length === 1) {
      notes.push(`the Epic ${found[0].key} already carries ${label}, so it is reused and none is created`);
      return { ref: `${instanceId}:${found[0].key}`, key: found[0].key, existing: false };
    }
    const made = await client.createIssue({
      project: board.project, issueType: 'Epic', summary: args.createEpic.trim(), labels: [label],
      description: `An Epic for the decomposition ${slug}, made by the SHL delivery harness. Its stories are mirrored from the repository.`,
    });
    notes.push(`created the Epic ${made.key} for ${slug}`);
    return { ref: `${instanceId}:${made.key}`, key: made.key, existing: false, created: true };
  }
  throw new SpokeError(EXIT.USAGE, `${slug} needs an Epic for its stories: pass --epic <KEY> to use one, or --create-epic "<title>" to make one (node scripts/jira-sync.mjs epics lists the open ones)`);
}

function linkPath(slug) {
  return `${CONFIG.linksDir}/${slug}.json`;
}

// The Epic already chosen for a decomposition: the trunk's link file first, and failing that the
// one on its unmerged link branch (local, or the remote's if it was fetched), because a run that
// failed part-way has recorded the choice there and nowhere else yet.
function recordedEpic(hub, rec, slug) {
  const onTrunk = rec.links[slug] && rec.links[slug].epic;
  if (onTrunk) return { ref: onTrunk, where: `in ${linkPath(slug)} on ${hub.ref}` };
  const branch = `harness/tracker-links-${slug}`;
  for (const ref of [`refs/heads/${branch}`, `refs/remotes/${CONFIG.remote}/${branch}`]) {
    const text = readBlob(ref, linkPath(slug));
    if (text === null) continue;
    let epic;
    try { epic = JSON.parse(text).epic; } catch { continue; }
    if (typeof epic === 'string' && epic) return { ref: epic, where: `on the unmerged branch ${branch}` };
  }
  return null;
}

// True when the unmerged link branch changes nothing but this slug's link file, and every ticket it
// records, and its Epic, is already in the trunk's copy of that file: what a squash merge leaves.
function containedInTrunk(hub, slug, name) {
  try {
    const touched = git(['diff', '--name-only', `${hub.head}...${name}`]).split('\n').filter(Boolean);
    if (!touched.length || touched.some((p) => p !== linkPath(slug))) return false;
    const trunk = JSON.parse(readBlob(hub.head, linkPath(slug)) || 'null');
    const branch = JSON.parse(readBlob(`refs/heads/${name}`, linkPath(slug)) || 'null');
    if (!trunk || !branch) return false;
    if (branch.epic !== undefined && branch.epic !== trunk.epic) return false;
    return Object.entries(branch.items || {}).every(([k, v]) => trunk.items && trunk.items[k] && JSON.stringify(trunk.items[k]) === JSON.stringify(v));
  } catch {
    return false;
  }
}

// Commit the link file on its own branch, in a worktree of its own, so the person's checkout is
// never switched, dirtied or left holding a half-made commit, whatever branch it is on and
// whatever directory this runs from. The branch is cut from the trunk commit this run read; an
// earlier run's branch that is already in the trunk, by ancestry or by a squash merge, is cut
// again, and one still unmerged is added to. The file is always the trunk's entries together with this run's, so a branch that fell
// behind cannot revert what was merged since.
function commitLinkFile(hub, slug, build, subject) {
  const name = `harness/tracker-links-${slug}`;
  let exists = true;
  try { git(['rev-parse', '--verify', '--quiet', `refs/heads/${name}`]); } catch { exists = false; }
  let recut = !exists;
  if (exists) {
    try { git(['merge-base', '--is-ancestor', name, hub.head]); recut = true; } catch { recut = false; }
    // A squash merge leaves the branch's commits outside the trunk's history, though everything
    // they said is in the trunk: that branch is stale, and adding to it would conflict with the
    // trunk's copy of the same file. Cut it again.
    if (!recut) recut = containedInTrunk(hub, slug, name);
  }
  const tmp = mkdtempSync(join(tmpdir(), 'jira-links-'));
  try {
    git(recut ? ['worktree', 'add', '-q', '-B', name, tmp, hub.head] : ['worktree', 'add', '-q', tmp, name]);
  } catch (err) {
    rmSync(tmp, { recursive: true, force: true });
    throw new SpokeError(EXIT.CANNOT_VERIFY, `could not open a worktree on ${name} (${firstLine(err.stderr) || err.message}); if it is checked out elsewhere, switch that checkout away from it`, 'git-failed');
  }
  try {
    const path = join(tmp, linkPath(slug));
    const onBranch = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(build(onBranch), null, 2)}\n`);

    const checker = spawnSync(process.execPath, [sibling('check-trackers')], { cwd: tmp, encoding: 'utf8' });
    if (checker.error || checker.status !== EXIT.PASS) {
      const findings = String(checker.stdout || '').split('\n').filter((l) => /^\s+- /.test(l)).map((l) => l.trim());
      throw new SpokeError(EXIT.FAIL, `the link file ${linkPath(slug)} does not pass check-trackers, so it is not committed:\n  ${findings.join('\n  ') || firstLine(checker.stderr)}`);
    }
    git(['add', '--', linkPath(slug)], { cwd: tmp });
    let staged = true;
    try { git(['diff', '--cached', '--quiet'], { cwd: tmp }); staged = false; } catch { staged = true; }
    if (!staged) return { branch: name, commit: null, note: 'the link file on the branch already says this, so nothing was committed' };
    const res = spawnSync(process.execPath, [sibling('harness-commit'), '--repo', tmp, '-m', subject], { cwd: tmp, encoding: 'utf8' });
    if (res.error || res.status !== 0) throw new SpokeError(EXIT.FAIL, `harness-commit.mjs refused the link-file commit: ${firstLine(res.stderr) || firstLine(res.stdout)}`);
    return { branch: name, commit: git(['rev-parse', 'HEAD'], { cwd: tmp }).trim(), note: null };
  } finally {
    try { git(['worktree', 'remove', '--force', tmp]); } catch { rmSync(tmp, { recursive: true, force: true }); try { git(['worktree', 'prune']); } catch { /* nothing to prune */ } }
  }
}

// One client per instance, made when a board first needs it.
function makeClientOf() {
  const clients = new Map();
  return (board) => {
    if (!clients.has(board.instance)) clients.set(board.instance, clientFor(board));
    return clients.get(board.instance);
  };
}

async function createCommand(args, hub, rec) {
  const all = collectItems(hub, rec);
  let slug;
  let targets;
  if (args.slug) {
    slug = args.slug;
    targets = [...all.values()].filter((i) => i.type === 'story' && i.slug === slug);
    if (!targets.length) throw new SpokeError(EXIT.FAIL, `no story for the slug ${slug} on ${hub.ref}`);
  } else {
    const item = all.get(args.key);
    if (!item) throw new SpokeError(EXIT.FAIL, `${args.key} is not a story or defect on ${hub.ref}, in a link file, or in the key ledger`);
    if (item.type !== 'defect') throw new SpokeError(EXIT.USAGE, `${args.key} is a story: stories are made together, with create ${item.slug}. create <KEY> is for a defect`);
    if (!item.slug) throw new SpokeError(EXIT.FAIL, `the parent story ${item.parent} of ${args.key} is on no decomposition this hub knows, so its link file is unknown`);
    slug = item.slug;
    targets = [item];
  }

  // The Epic is chosen once per decomposition. A run that failed part-way recorded it on the link
  // branch, so a different one named now is refused here, before anything is asked of Jira.
  const priorEpic = args.slug ? recordedEpic(hub, rec, slug) : null;
  if (priorEpic && args.epic && !priorEpic.ref.endsWith(`:${args.epic}`)) {
    throw new SpokeError(EXIT.USAGE, `${slug} already has the Epic ${priorEpic.ref} recorded ${priorEpic.where}, and --epic ${args.epic} names another; the choice is made once. Run create without --epic, or, if the recorded Epic is wrong, correct the link file in a pull request (or delete the unmerged branch) first`);
  }

  // Facts first, from the trunk: nothing is made for work the repository does not prove queued.
  const cache = new Map();
  const planned = [];
  for (const item of targets) {
    const { facts, notes } = trunkFacts(hub, item, cache);
    if (!facts.queued) {
      throw new SpokeError(EXIT.FAIL, `${item.key} is not queued on ${hub.ref}, so nothing is created. ${notes.join('; ')}`);
    }
    const link = linkOf(rec, item);
    if (link) continue;
    // The link file must pass check-trackers, which holds each key to the ledger: check that now,
    // so a ledger that does not know the key stops the run before a ticket exists.
    const n = numberOf(item.key);
    const blocks = ((rec.ledger && rec.ledger.blocks) || []).filter((b) => Number.isInteger(b.from) && n >= b.from && n <= b.to);
    const known = item.type === 'story'
      ? blocks.some((b) => b.taken_by === 'decomposition' && b.slug === item.slug)
      : blocks.some((b) => b.taken_by === 'validation' && b.key === item.parent);
    if (!known) {
      throw new SpokeError(EXIT.FAIL, `${item.key} is in no ${item.type === 'story' ? `decomposition block of the key ledger for ${item.slug}` : `validation block of the key ledger whose key is ${item.parent}`}, so its link could not be recorded; nothing is created`);
    }
    let boardId;
    if (item.type === 'defect') {
      const parentLink = rec.links[item.slug] && rec.links[item.slug].items[item.parent];
      if (!parentLink) throw new SpokeError(EXIT.FAIL, `the parent story ${item.parent} of ${item.key} has no ticket yet; create the decomposition's tickets first (create ${item.slug})`);
      boardId = parentLink.board;
    } else {
      boardId = resolveBoardId(hub, rec, item, rec.trackers.default_board);
    }
    const board = boardOf(rec.trackers, boardId);
    const mapping = rec.trackers.types[item.type];
    if (!mapping) throw new SpokeError(EXIT.FAIL, `no mapping for ${item.type} in ${CONFIG.trackersPath}`);
    planned.push({ item, board, mapping });
  }
  planned.sort((a, b) => numberOf(a.item.key) - numberOf(b.item.key));
  if (!planned.length) {
    stderr.write(`nothing to create: every ${args.slug ? `story of ${slug}` : args.key} already has a ticket linked\n`);
    stdout.write(`${JSON.stringify({ version: 1, slug, created: [], adopted: [], skipped: [], findings: [] }, null, 2)}\n`);
    return EXIT.PASS;
  }

  const clientOf = makeClientOf();
  const me = await clientOf(planned[0].board).myself();
  stderr.write(`acting as ${me.displayName}\n`);

  // What Jira will insist on, before anything is made: the type of every ticket, and the Epic
  // when this run is to make one.
  const checkFields = async (board, issueType, provided, onMissingType, onMissingField) => {
    const need = await clientOf(board).requiredCreateFields(board.project, issueType, provided);
    if (need === null) stderr.write(`NOTE: could not read the create metadata of ${board.project}; creating without checking its required fields\n`);
    else if (need.missingType) throw new SpokeError(EXIT.FAIL, `project ${board.project} has no issue type "${issueType}" (it offers: ${need.available.join(', ') || 'none'}); ${onMissingType}; nothing is created`);
    else if (need.fields.length) throw new SpokeError(EXIT.FAIL, `${board.project} requires ${need.fields.map((f) => `${f.name} (${f.id})`).join(', ')} on ${issueType === 'Epic' ? 'an Epic' : `a ${issueType}`}, and ${onMissingField(need.fields.length)}; nothing is created`);
  };
  const checked = new Set();
  for (const { board, mapping, item } of planned) {
    const k = `${board.project}:${mapping.issue_type}`;
    if (checked.has(k)) continue;
    checked.add(k);
    await checkFields(board, mapping.issue_type, Object.keys(mapping.fields || {}),
      `set the name in ${CONFIG.trackersPath}`,
      (n) => `${CONFIG.trackersPath} has no default for ${n === 1 ? 'it' : 'them'} (types.${item.type}.fields)`);
  }
  const firstStory = planned.find((p) => p.item.type === 'story');
  if (firstStory && args.createEpic !== null && !priorEpic && firstStory.board.epics !== 'none') {
    await checkFields(firstStory.board, 'Epic', [], 'name an existing Epic with --epic instead',
      () => 'an Epic has no place for a default in trackers.json, so make the Epic in Jira and pass --epic <KEY>');
  }

  const look = lookFor(slug, Number(process.env.HARNESS_JIRA_SEARCH_LAG_MS ?? 3000));
  const notes = [];
  const created = [];
  const adopted = [];
  const skipped = [];
  const findings = [];
  let failure = null;
  let epic = null;
  let linkError = null;
  let linkExit = EXIT.FAIL;
  let linkReason = null;
  let committed = { branch: null, commit: null, note: null };

  // From here a ticket may exist in Jira, so whatever goes wrong, what was made is reported and,
  // where possible, recorded: the keys are never lost to a later failure.
  try {
    const stories = planned.filter((p) => p.item.type === 'story');
    if (stories.length) {
      const b = stories[0].board;
      epic = await resolveEpic({ args, recorded: priorEpic && priorEpic.ref, slug, board: b, client: clientOf(b), instanceId: b.instance, notes, look });
    }

    // Look before making: one batched search, never a second ticket for a key.
    const existing = new Map();
    const byProject = new Map();
    for (const p of planned) {
      if (!byProject.has(p.board.project)) byProject.set(p.board.project, []);
      byProject.get(p.board.project).push(p);
    }
    for (const group of byProject.values()) {
      const found = await findByKeyLabels(clientOf(group[0].board), group.map((g) => g.item.key), look);
      for (const [k, v] of found) existing.set(k, v);
    }

    for (const p of planned) {
      const { item, board, mapping } = p;
      const hits = existing.get(item.key) || [];
      if (hits.length > 1) {
        findings.push(`${item.key}: ${hits.length} tickets carry the label ${CONFIG.keyLabel}${item.key} (${hits.map((h) => h.key).join(', ')}); none is chosen, and none is made`);
        skipped.push({ key: item.key, reason: 'duplicate tickets' });
        continue;
      }
      if (hits.length === 1) {
        if (hits[0].project && hits[0].project !== board.project) {
          findings.push(`${item.key}: its ticket ${hits[0].key} is in project ${hits[0].project}, not ${board.project}; it was moved, so none is made beside it and it is not linked`);
          skipped.push({ key: item.key, reason: 'ticket moved to another project' });
          continue;
        }
        adopted.push({ key: item.key, type: item.type, board: board.id, ticket: `${board.instance}:${hits[0].key}`, ...(item.parent ? { parent: item.parent } : {}) });
        continue;
      }
      let parent = null;
      if (item.type === 'defect') {
        const pl = rec.links[item.slug] && rec.links[item.slug].items[item.parent];
        parent = pl ? pl.ticket.slice(pl.ticket.indexOf(':') + 1) : null;
      } else if (epic && epic.key && stories[0].board.project === board.project) {
        parent = epic.key;
      } else if (epic && stories[0].board.project !== board.project) {
        notes.push(`${item.key} is on project ${board.project}, but the Epic is on ${stories[0].board.project}, so it is made without one`);
      }
      const made = await clientOf(board).createIssue({
        project: board.project,
        issueType: mapping.issue_type,
        summary: summaryOf(item.key, titleOf(hub, item)),
        labels: [`${CONFIG.keyLabel}${item.key}`],
        parent,
        description: [
          'Mirrored from the repository by the SHL delivery harness. The repository is the master record.',
          `Harness key: ${item.key}`,
          ...(item.itemPath ? [`Item: ${item.itemPath}`] : []),
          `Hub trunk commit: ${short(hub.head)}`,
          ...contextSectionOf(hub, item),
        ].join('\n'),
        fields: mapping.fields || {},
      });
      created.push({ key: item.key, type: item.type, board: board.id, ticket: `${board.instance}:${made.key}`, ...(item.parent ? { parent: item.parent } : {}) });
    }
  } catch (err) {
    failure = err;
    skipped.push({ key: '(the rest)', reason: err && err.message ? err.message : String(err) });
  }

  // Whatever was made or found is recorded, an Epic made on its own as well, even when a later
  // step failed. A failure to record is reported with the keys, never instead of them.
  const linked = [...created, ...adopted];
  if (linked.length || (epic && epic.created)) {
    try {
      committed = commitLinkFile(hub, slug, (onBranch) => {
        const trunk = rec.links[slug] || { items: {} };
        const items = { ...((onBranch && onBranch.items) || {}), ...(trunk.items || {}) };
        for (const l of linked) items[l.key] = { type: l.type, board: l.board, ticket: l.ticket, ...(l.parent ? { parent: l.parent } : {}) };
        const sorted = Object.fromEntries(Object.entries(items).sort(([a], [b]) => numberOf(a) - numberOf(b)));
        const epicRef = epic ? epic.ref : trunk.epic || (onBranch && onBranch.epic);
        return { schema_version: 1, slug, ...(epicRef ? { epic: epicRef } : {}), items: sorted };
      }, `chore(estate): link ${linked.length} ticket${linked.length === 1 ? '' : 's'} for ${slug}`);
    } catch (err) {
      linkError = err && err.message ? err.message : String(err);
      linkExit = err instanceof SpokeError ? err.exit : EXIT.FAIL;
      linkReason = err instanceof SpokeError ? err.reason : null;
    }
  }

  for (const n of notes) stderr.write(`${n}\n`);
  for (const c of created) stderr.write(`created  ${c.key}  ${c.ticket}\n`);
  for (const a of adopted) stderr.write(`adopted  ${a.key}  ${a.ticket}  (already carried its label)\n`);
  for (const f of findings) stderr.write(`FINDING: ${f}\n`);
  if (committed.branch) stderr.write(`link file committed on ${committed.branch}${committed.commit ? ` at ${short(committed.commit)}` : ` (${committed.note})`}; push it and open the pull request\n`);
  if (linkError) stderr.write(`TICKETS EXIST BUT THE LINK FILE IS NOT COMMITTED: ${linkError}\nRun create again: it adopts those tickets by their labels, makes none twice, and commits the link file\n`);
  stdout.write(`${JSON.stringify({ version: 1, slug, epic: epic ? epic.ref : null, created, adopted, skipped, findings, linkBranch: committed.branch, linkCommit: committed.commit, linkError }, null, 2)}\n`);

  if (!failure) setUncertain(slug, false);
  let exit = findings.length ? EXIT.FAIL : EXIT.PASS;
  if (linkError) exit = Math.max(exit, linkExit);
  if (failure) {
    const code = failure instanceof JiraError || failure instanceof SpokeError ? failure.exit : EXIT.INTERNAL;
    exit = Math.max(exit, code);
    const unsure = failure instanceof JiraError && failure.exit === EXIT.CANNOT_VERIFY;
    if (unsure) setUncertain(slug, true);
    stderr.write(`${code === EXIT.CANNOT_VERIFY ? 'CANNOT VERIFY' : code === EXIT.INTERNAL ? 'INTERNAL' : 'FAIL'}: ${failure.message}.${unsure ? ' Run create again: anything made is found by its label and is never made twice' : ' Fix that, then run create again: what was made is found by its label'}\n`);
  }
  if (exit === EXIT.CANNOT_VERIFY) stderr.write(reasonLine((failure && failure.reason) || linkReason));
  return exit;
}

/* ---------------------------------------------------------------- commands */

// Jira failing on one ticket is that ticket's finding. Only a refused credential stops a whole run,
// because then every other ticket would fail the same way.
const refusesCredential = (err) => err instanceof JiraError && (err.status === 401 || err.status === 403);

// What plan and apply both start from: who is acting, which items, and a way to plan one of them.
async function startRun(args, hub, rec) {
  const clientOf = makeClientOf();
  const defaultBoard = boardOf(rec.trackers, null);
  const me = await clientOf(defaultBoard).myself();
  stderr.write(`acting as ${me.displayName}\n`);
  const all = collectItems(hub, rec);
  let wanted;
  if (args.all) wanted = [...all.values()];
  else if (all.has(args.key)) wanted = [all.get(args.key)];
  else throw new SpokeError(EXIT.FAIL, `${args.key} is not a story or defect on ${hub.ref}, in a link file, or in the key ledger`);

  const cache = new Map();
  const parentBoards = new Map();
  const planOne = async (item) => {
    const passed = args.fact && item.key === args.key ? { fact: args.fact, pr: args.pr, link: args.link } : null;
    try {
      return await planItem({ hub, rec, item, clientOf, cache, passed, parentBoards });
    } catch (err) {
      if (!(err instanceof JiraError) || refusesCredential(err)) throw err;
      return { key: item.key, type: item.type, slug: item.slug, parent: item.parent || null, board: null, ticket: null, facts: null, actions: [], notes: [], findings: [`${item.key}: ${err.message}`], error: { exit: err.exit, message: err.message, reason: err.reason ?? null } };
    }
  };
  return { me, wanted, planOne, clientOf, defaultInstance: defaultBoard.instance };
}

const exitOfItem = (planned) => (planned.error && planned.error.exit === EXIT.CANNOT_VERIFY ? EXIT.CANNOT_VERIFY : planned.findings.length ? EXIT.FAIL : EXIT.PASS);

async function planCommand(args, hub, rec) {
  const { me, wanted, planOne } = await startRun(args, hub, rec);
  const items = [];
  let worst = EXIT.PASS;
  for (const item of wanted) {
    const planned = await planOne(item);
    items.push(planned);
    worst = Math.max(worst, exitOfItem(planned));
  }
  for (const i of items) {
    const verbs = i.actions.filter((a) => a.kind !== 'none').map((a) => (a.kind === 'move' ? `move ${a.fact}${a.status === 'blocked' ? ' (blocked)' : ''}` : a.kind === 'mark' ? `mark ${a.fact}` : a.kind));
    stderr.write(`${i.key}  ${i.type}  ${i.ticket && i.ticket.key ? i.ticket.key : 'no ticket'}  ${verbs.length ? verbs.join(', ') : 'nothing to do'}${i.findings.length ? `  [${i.findings.length} finding(s)]` : ''}\n`);
    for (const f of i.findings) stderr.write(`  FINDING: ${f}\n`);
  }
  stdout.write(`${JSON.stringify({ version: 1, configured: true, hub: { trunk: CONFIG.branch, commit: hub.head }, actingAs: me.displayName, items, findings: items.flatMap((i) => i.findings) }, null, 2)}\n`);
  if (worst === EXIT.CANNOT_VERIFY) stderr.write(reasonLine(items.map((i) => i.error && i.error.reason).find(Boolean)));
  return worst;
}

/* ------------------------------------------------------------------------- apply */

const shortHash = (text) => createHash('sha1').update(text).digest('hex').slice(0, 8);

// Walk a route one hop at a time. Each hop re-reads what Jira offers now, takes the one transition
// that qualifies, and reads the ticket back to see where it landed, because a validator or a
// post-function can put it elsewhere. A hop that cannot be taken stops the walk where it is: the
// ticket is then waiting on a person, and the next run starts from wherever it now stands.
// `taken` is filled as hops are taken, so a failure part-way can still say what was done.
async function walkRoute(client, key, board, route, taken) {
  const target = route[route.length - 1];
  const ids = route.map((n) => idOf(board, n));
  const useIds = ids.every(Boolean);
  const locate = (st) => (useIds ? ids.indexOf(st.id) : route.indexOf(st.name));
  let issue = await client.issue(key);
  for (let hop = 0; hop <= route.length; hop += 1) {
    const at = locate(issue.status);
    if (at === -1) {
      return taken.length
        ? { result: 'waiting', reason: `the ticket is in "${issue.status.name}", which is not on the route to ${target}` }
        : { result: 'skipped', reason: `status "${issue.status.name}" is not on the route` };
    }
    if (at === route.length - 1) return { result: 'done' };
    const next = route[at + 1];
    const options = qualifying(await client.transitions(key), next);
    if (options.length > 1) return { result: 'ambiguous', reason: `${options.length} transitions to "${next}" qualify (${options.map((t) => `${t.id} ${t.name}`).join(', ')}); none was taken` };
    if (options.length === 0) return { result: 'waiting', reason: `no available transition to "${next}"` };
    const t = options[0];
    if (t.requiredFields.length) return { result: 'waiting', reason: `transition "${t.name}" asks for ${t.requiredFields.map((f) => f.name).join(', ')}` };
    try {
      await client.transition(key, t.id);
      issue = await client.issue(key);
    } catch (err) {
      if (!(err instanceof JiraError)) throw err;
      if (err.exit === EXIT.FAIL) return { result: 'waiting', reason: `Jira refused "${t.name}": ${err.message}` };
      // The reply was lost or Jira failed: the transition may have been taken. Look. If the ticket
      // is where the hop leads, carry on as if the reply had arrived; if not, say so and stop.
      const now = await client.issue(key);
      if (now.status.id === issue.status.id) throw err;
      if (now.status.name !== next) {
        taken.push(t.name);
        return { result: 'waiting', reason: `the reply to "${t.name}" was lost (${err.message}) and the ticket is now in "${now.status.name}", not "${next}"` };
      }
      issue = now;
    }
    taken.push(t.name);
    if (issue.status.name !== next) return { result: 'waiting', reason: `after "${t.name}" the ticket is in "${issue.status.name}", not "${next}"` };
  }
  return { result: 'waiting', reason: 'the route did not finish' };
}

// Do what was planned for one ticket. Results go into the caller's array as they happen, so what was
// done survives a failure part-way. Order matters in two places: an annotation's comment goes in
// before its label, so a failure between them leaves a state the next run still wants to finish; and
// a route's applied label is written last, once the ticket is at the target.
async function executeItem(planned, board, mapping, client, results) {
  const key = planned.ticket.key;
  let commentTexts = null;
  // A comment goes in only if its marker is not already at the start of one on the ticket, so a
  // re-run, or a run after a lost reply, never says a thing twice.
  // Only a comment the acting developer wrote counts: a person's comment that starts with the marker
  // must not stand in for the harness's.
  const ensureComment = async (marker, text) => {
    if (commentTexts === null) {
      const [me, all] = await Promise.all([client.myself(), client.comments(key)]);
      commentTexts = all.filter((c) => c.accountId === me.accountId).map((c) => c.text);
    }
    if (commentTexts.some((t) => t.trim().startsWith(marker))) return false;
    await client.addComment(key, `${marker} ${text}`);
    commentTexts.push(marker);
    return true;
  };
  // A label is written after the thing it records. If the write fails, the report still says what was
  // taken, as a failure, so the move is not lost from it and the next run finishes the label.
  const labelAfter = async (a, taken, labels) => {
    try {
      await client.addLabels(key, labels);
    } catch (err) {
      results.push({ kind: a.kind, fact: a.fact, result: 'failed', detail: `${taken.length ? `took ${taken.join(', ')}; ` : ''}writing the label failed: ${err.message}`, took: taken });
      current = null;
      throw err;
    }
  };
  const hadWaitingLabel = planned.ticket.labels.includes(CONFIG.waitingLabel);
  let escalated = false;
  let waiting = false;
  let failed = false;
  let progressed = false;
  let current = null;
  try {
    for (const a of planned.actions) {
      current = a;
      if (a.kind === 'none') continue;
      if (a.kind === 'mark') {
        await labelAfter(a, [], [`${CONFIG.appliedLabel}${a.fact}`]);
        results.push({ kind: 'mark', fact: a.fact, result: 'done', detail: a.reason });
        progressed = true;
      } else if (a.kind === 'move') {
        const move = mapping.moves[a.fact];
        const taken = [];
        let walked;
        try {
          walked = await walkRoute(client, key, board, move.route, taken);
        } catch (err) {
          results.push({ kind: 'move', fact: a.fact, result: 'failed', detail: `${err.message}${taken.length ? `; hops taken before that: ${taken.join(', ')}` : ''}`, took: taken });
          current = null;
          throw err;
        }
        if (walked.result === 'done') {
          await labelAfter(a, taken, [`${CONFIG.appliedLabel}${a.fact}`]);
          results.push({ kind: 'move', fact: a.fact, result: 'done', detail: taken.length ? `took ${taken.join(', ')}` : 'already at the target', took: taken });
          progressed = true;
        } else if (walked.result === 'skipped') {
          results.push({ kind: 'move', fact: a.fact, result: 'skipped', detail: walked.reason });
        } else if (walked.result === 'ambiguous') {
          failed = true;
          results.push({ kind: 'move', fact: a.fact, result: 'failed', detail: walked.reason });
        } else {
          waiting = true;
          await client.addLabels(key, [CONFIG.waitingLabel]);
          const marker = `[shl:waiting:${a.fact}:${shortHash(walked.reason)}]`;
          await ensureComment(marker, `The harness could not move this ticket to "${move.route[move.route.length - 1]}" (${walked.reason}). A person needs to take the next step; the harness tries again on its next run.`);
          results.push({ kind: 'move', fact: a.fact, result: 'waiting', detail: walked.reason, took: taken });
        }
      } else if (a.kind === 'annotate') {
        const text = a.fact === 'merged'
          ? `Merged to the repository's trunk${a.pr ? `: ${a.pr}` : ''}. The harness leaves this ticket's status to the team.`
          : "Validated: every acceptance criterion passed against the merged design. The harness leaves this ticket's status to the team.";
        const said = await ensureComment(a.marker, text);
        if (a.labels && a.labels.length) await client.addLabels(key, a.labels);
        results.push({ kind: 'annotate', fact: a.fact, result: 'done', detail: `${a.labels && a.labels.length ? `labelled ${a.labels.join(', ')}` : 'labels already there'}${said ? ', commented' : ', comment already there'}` });
      } else if (a.kind === 'needs-person') {
        const said = await ensureComment(a.marker, `The harness stopped and an escalation waits for a person. Open it here: ${a.link}`);
        if (a.labels && a.labels.length) await client.addLabels(key, a.labels);
        escalated = true;
        results.push({ kind: 'needs-person', fact: a.fact, result: 'done', detail: `${a.labels && a.labels.length ? `labelled ${a.labels.join(', ')}` : 'label already there'}${said ? ', commented' : ', comment already there'}` });
      } else if (a.kind === 'person-answered') {
        await client.removeLabel(key, CONFIG.waitingLabel);
        results.push({ kind: 'person-answered', fact: a.fact, result: 'done', detail: `took ${CONFIG.waitingLabel} off` });
      } else if (a.kind === 'add-to-sprint') {
        const active = await client.activeSprints(a.board);
        if (active.length === 1) {
          await client.addToSprint(active[0].id, key);
          results.push({ kind: 'add-to-sprint', result: 'done', detail: `added to ${active[0].name}` });
        } else {
          results.push({ kind: 'add-to-sprint', result: 'skipped', detail: `${active.length} active sprints on the board, so none was chosen` });
        }
      }
    }
    // The waiting label comes off only when this run got a ticket somewhere and nothing is left stuck.
    if (hadWaitingLabel && progressed && !waiting && !failed && !escalated) await client.removeLabel(key, CONFIG.waitingLabel);
  } catch (err) {
    if (current !== null) results.push({ kind: 'error', result: 'failed', detail: err.message });
    throw err;
  }
}

async function applyCommand(args, hub, rec) {
  const { me, wanted, planOne, clientOf, defaultInstance } = await startRun(args, hub, rec);
  const announced = new Set([defaultInstance]);
  let worst = EXIT.PASS;
  let stopped = null;
  let reason = null;
  const done = [];
  for (const item of wanted) {
    const entry = { key: item.key, type: item.type, ticket: null, results: [], findings: [] };
    done.push(entry);
    // Plan, do, and plan again while a pass moved the ticket: a fact handed in with `--fact` may only
    // become possible once an earlier move has landed, and one call should finish the chain.
    for (let pass = 0; pass < 4; pass += 1) {
      let planned;
      try {
        planned = await planOne(item);
      } catch (err) {
        // A refused credential stops the run, but what the earlier tickets got is still reported.
        if (!(err instanceof JiraError)) throw err;
        worst = Math.max(worst, err.exit);
        entry.results.push({ kind: 'error', result: 'failed', detail: err.message });
        if (refusesCredential(err)) stopped = err;
        break;
      }
      entry.ticket = planned.ticket && planned.ticket.key ? planned.ticket.key : entry.ticket;
      entry.findings = planned.findings;
      worst = Math.max(worst, exitOfItem(planned));
      if (planned.error) { entry.results.push({ kind: 'error', result: 'failed', detail: planned.error.message }); break; }
      if (!planned.ticket || !planned.ticket.status) {
        for (const a of planned.actions.filter((x) => x.kind === 'create' || x.kind === 'adopt')) {
          entry.results.push({ kind: a.kind, result: 'skipped', detail: 'create makes tickets and records them; apply only updates a ticket that is linked' });
        }
        break;
      }
      const board = boardOf(rec.trackers, planned.board);
      const mapping = rec.trackers.types[planned.type];
      if (!mapping) break;
      if (!announced.has(board.instance)) {
        announced.add(board.instance);
        try {
          const m = await clientOf(board).myself();
          stderr.write(`acting as ${m.displayName} (${board.instance})\n`);
        } catch (err) {
          if (!(err instanceof JiraError)) throw err;
          worst = Math.max(worst, err.exit);
          entry.results.push({ kind: 'error', result: 'failed', detail: err.message });
          if (refusesCredential(err)) stopped = err;
          break;
        }
      }
      const before = entry.results.length;
      try {
        await executeItem(planned, board, mapping, clientOf(board), entry.results);
      } catch (err) {
        if (!(err instanceof JiraError)) throw err;
        worst = Math.max(worst, err.exit);
        reason = reason || err.reason;
        if (refusesCredential(err)) stopped = err;
        break;
      }
      if (entry.results.slice(before).some((r) => r.result === 'failed')) worst = Math.max(worst, EXIT.FAIL);
      if (!entry.results.slice(before).some((r) => r.result === 'done' && (r.kind === 'move' || r.kind === 'mark'))) break;
    }
    if (stopped) break;
  }
  for (const e of done) {
    const said = e.results.filter((r) => r.result !== 'skipped').map((r) => `${r.kind}${r.fact ? ` ${r.fact}` : ''}: ${r.result}${r.detail ? ` (${r.detail})` : ''}`);
    stderr.write(`${e.key}  ${e.type}  ${e.ticket || 'no ticket'}  ${said.length ? said.join('; ') : 'nothing to do'}\n`);
    for (const f of e.findings) stderr.write(`  FINDING: ${f}\n`);
  }
  const waitingOn = done.flatMap((e) => e.results.filter((r) => r.result === 'waiting').map((r) => `${e.key} ${r.fact}: ${r.detail}`));
  if (waitingOn.length) stderr.write(`WAITING ON A HUMAN (not a failure):\n${waitingOn.map((w) => `  ${w}`).join('\n')}\n`);
  stdout.write(`${JSON.stringify({ version: 1, actingAs: me.displayName, items: done, waitingOnAHuman: waitingOn, findings: done.flatMap((e) => e.findings) }, null, 2)}\n`);
  if (worst === EXIT.CANNOT_VERIFY) stderr.write(`CANNOT VERIFY: ${stopped ? stopped.message : 'Jira failed on at least one ticket'}. Run apply again: it starts from where each ticket now stands\n${reasonLine(reason)}`);
  return worst;
}

async function epicsCommand(args, hub, rec) {
  const board = boardOf(rec.trackers, args.board);
  if (board.epics === 'none') {
    stdout.write(`${JSON.stringify({ board: board.id, epics: 'none', open: [] }, null, 2)}\n`);
    return EXIT.PASS;
  }
  const client = clientFor(board);
  const found = await client.search(`project = ${board.project} AND issuetype = Epic AND statusCategory != Done ORDER BY updated DESC`, { limit: 50 });
  stdout.write(`${JSON.stringify({ board: board.id, project: board.project, epics: 'ask', open: found.map((e) => ({ key: e.key, summary: e.summary, status: e.status && e.status.name })) }, null, 2)}\n`);
  return EXIT.PASS;
}

async function discoverCommand(args, hub, rec) {
  const board = boardOf(rec.trackers, args.board);
  const client = clientFor(board);
  const [statuses, sprintField, issueTypes] = await Promise.all([client.projectStatuses(board.project), client.sprintField(), client.issueTypes(board.project)]);
  stdout.write(`${JSON.stringify({ board: board.id, project: board.project, status_ids: statuses, sprint_field: sprintField, issue_types: issueTypes }, null, 2)}\n`);
  return EXIT.PASS;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  // Everything below is relative to the hub's root, wherever this was run from.
  try {
    process.chdir(git(['rev-parse', '--show-toplevel']).trim());
  } catch {
    throw new SpokeError(EXIT.CANNOT_VERIFY, 'run from inside the hub checkout', 'not-a-checkout');
  }
  // A draft read needs no trunk: the connection is not on it yet.
  if (args.draft) {
    const draft = loadTrackers(workingTreeSource());
    if (draft === null) throw new SpokeError(EXIT.CANNOT_VERIFY, `no ${CONFIG.trackersPath} in the working tree; write the connection first, as /connect-jira does`, 'tracker-missing');
    return discoverCommand(args, null, draft);
  }
  const hub = syncHubTrunk();
  const rec = loadTrackers(trunkSource(hub));
  if (rec === null) {
    if (args.command === 'plan' || args.command === 'apply') {
      stdout.write(`${JSON.stringify({ version: 1, configured: false }, null, 2)}\n`);
      stderr.write(`NOT CONFIGURED: no ${CONFIG.trackersPath} on ${hub.ref}, so this hub has no tracker.\n`);
      return EXIT.PASS;
    }
    const draftHint = args.command === 'discover' ? ', or run discover <board> --draft on its branch to read the connection in the working tree' : '';
    throw new SpokeError(EXIT.CANNOT_VERIFY, `no ${CONFIG.trackersPath} on ${hub.ref}; connect a board with /connect-jira first${draftHint}`, 'tracker-missing');
  }
  if (args.command === 'plan') return planCommand(args, hub, rec);
  if (args.command === 'create') return createCommand(args, hub, rec);
  if (args.command === 'apply') return applyCommand(args, hub, rec);
  if (args.command === 'epics') return epicsCommand(args, hub, rec);
  return discoverCommand(args, hub, rec);
}

// exitCode, not process.exit: a long plan written to a pipe is flushed before the process ends.
// The last line of an exit 2, 3 or 4 names this script and its code, so a shell line that hides
// the code, with a pipe or `; echo`, still tells the harness's failure record. Written at once,
// so a process.exit() never loses it.
process.on('exit', (code) => { if (code >= 2 && code <= 4) { try { writeSync(2, `HARNESS EXIT: jira-sync ${code}\n`); } catch { /* stderr is closed */ } } });

main().then((code) => { process.exitCode = code; }, (err) => {
  if (err instanceof SpokeError || err instanceof JiraError) {
    stderr.write(`${err.exit === EXIT.CANNOT_VERIFY ? 'CANNOT VERIFY' : 'FAIL'}: ${err.message}\n${reasonLine(err.reason)}`);
    process.exitCode = err.exit;
    return;
  }
  stderr.write(`INTERNAL: ${err && err.stack ? err.stack : String(err)}\n`);
  process.exitCode = EXIT.INTERNAL;
});

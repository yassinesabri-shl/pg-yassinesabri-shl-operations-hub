#!/usr/bin/env node
/**
 * run.mjs — the fixture suite for check-trackers.mjs.
 *
 *   usage:  node run.mjs            run every fixture
 *           node run.mjs 3 7        run only the numbered fixtures
 *           node run.mjs --keep     leave the throwaway hubs on disk
 *
 * A fixture is a HUB STATE: a throwaway folder with the files the check reads
 * (docs/estate/trackers.json, the link files, the key ledger), and the shipped script run in it
 * as a hub would run it. The script reads files only, so no git remote is involved. The script
 * is never imported and never stubbed. Exit code and messages are asserted.
 *
 * Fixture 1 is the valid control. Every other fixture changes exactly one thing in it.
 *
 * Node standard library only. No test framework.
 * Exit 0 if every fixture passes, 1 if any fails.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

// Two layouts: the library, where the script is two levels up and the presets are under
// templates/; and an adopting hub, where this suite lands at tests/check-trackers/, the script
// at scripts/ and the presets under .claude/jira/.
const first = (...c) => c.filter(Boolean).find((p) => existsSync(p));
const SCRIPT = first(
  process.env.HARNESS_CHECK_TRACKERS,
  resolve(HERE, '..', '..', 'check-trackers.mjs'),
  resolve(HERE, '..', '..', 'scripts', 'check-trackers.mjs'),
);
if (!SCRIPT) {
  console.error('cannot locate check-trackers.mjs. Set HARNESS_CHECK_TRACKERS=/path/to/check-trackers.mjs.');
  process.exit(4);
}
const PRESET_SHL = first(
  resolve(HERE, '..', '..', '..', 'templates', 'jira-preset-shl.json'),
  resolve(HERE, '..', '..', '.claude', 'jira', 'preset-shl.json'),
);
const PRESET_SIMPLE = first(
  resolve(HERE, '..', '..', '..', 'templates', 'jira-preset-simple.json'),
  resolve(HERE, '..', '..', '.claude', 'jira', 'preset-simple.json'),
);

const KEEP = process.argv.includes('--keep');

/* ----------------------------------------------------------------------- the control hub */

const clone = (v) => JSON.parse(JSON.stringify(v));

const CONTROL = {
  trackers: {
    schema_version: 1,
    instances: {
      acme: {
        kind: 'jira-cloud',
        site: 'acme.example.invalid',
        auth: { method: 'api-token', user_env: 'JIRA_USER', token_env: 'JIRA_API_TOKEN' },
      },
    },
    boards: {
      platform: {
        instance: 'acme', project: 'PLAT', board: 42, sprint: 'report', sprint_field: 'customfield_10020', epics: 'ask',
        status_ids: { Backlog: '1', 'In Analysis': '2', 'Ready for Development': '3', 'In Development': '4', 'Awaiting Code Review': '5' },
      },
    },
    default_board: 'platform',
    types: {
      story: {
        issue_type: 'Story',
        moves: {
          'design-merged': { route: ['Backlog', 'In Analysis', 'Ready for Development'] },
          started: { route: ['Ready for Development', 'In Development'] },
          'in-review': { route: ['In Development', 'Awaiting Code Review'] },
        },
        annotations: { merged: { label: 'shl-merged' }, validated: { label: 'shl-validated' } },
      },
      defect: {
        issue_type: 'Defect',
        parent: 'story',
        moves: { started: { route: ['Backlog', 'In Development'] } },
        annotations: { merged: { label: 'shl-merged' }, validated: { label: 'shl-validated' } },
      },
    },
  },
  ledger: {
    schema_version: 1,
    prefix: 'SVC',
    next: 130,
    blocks: [
      { from: 101, to: 102, taken_by: 'decomposition', slug: 'visibility' },
      { from: 120, to: 121, taken_by: 'validation', key: 'SVC-101' },
    ],
  },
  links: {
    visibility: {
      schema_version: 1,
      slug: 'visibility',
      epic: 'acme:PLAT-9',
      items: {
        'SVC-101': { type: 'story', board: 'platform', ticket: 'acme:PLAT-210' },
        'SVC-102': { type: 'story', board: 'platform', ticket: 'acme:PLAT-211' },
        'SVC-120': { type: 'defect', board: 'platform', ticket: 'acme:PLAT-231', parent: 'SVC-101' },
      },
    },
  },
};

function writeJson(root, rel, value) {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`);
}

function buildHub(root, state) {
  if (state.trackers !== null) writeJson(root, 'docs/estate/trackers.json', state.trackers);
  if (state.ledger !== null) writeJson(root, 'docs/backlog/keys.json', state.ledger);
  if (state.links !== null) {
    for (const [slug, body] of Object.entries(state.links)) writeJson(root, `docs/estate/tracker-links/${slug}.json`, body);
    if (Object.keys(state.links).length === 0) mkdirSync(join(root, 'docs/estate/tracker-links'), { recursive: true });
  }
  for (const rel of state.dirs || []) mkdirSync(join(root, rel), { recursive: true });
  for (const [rel, body] of Object.entries(state.extra || {})) writeJson(root, rel, body);
  for (const [rel, target] of Object.entries(state.symlinks || {})) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    symlinkSync(target, join(root, rel));
  }
}

/* ------------------------------------------------------------------------ the fixtures */

// `change` receives a deep copy of the control and edits it. `expect` strings must all appear in
// the output; `absent` strings must not.
const FIXTURES = [
  { n: 1, name: 'the valid control: a connection, a link file and a ledger that agree', exit: 0,
    expect: ['[PASS] connection', '[PASS] visibility.json', 'WELL FORMED: the connection and 1 link file agree'] },
  { n: 2, name: 'no trackers.json at the default path: no tracker, and that is valid', exit: 0,
    change: (s) => { s.trackers = null; s.links = null; s.ledger = null; },
    expect: ['NOT CONFIGURED', 'no tracker'] },
  { n: 3, name: '--file naming a file that is not there is cannot-verify', exit: 2, args: ['--file', 'nowhere.json'],
    expect: ['CANNOT VERIFY'] },
  { n: 4, name: 'a trackers.json that is not JSON is refused', exit: 1,
    change: (s) => { s.trackers = '{ not json'; },
    expect: ['is not JSON'] },
  { n: 5, name: 'an unknown root field is refused', exit: 1,
    change: (s) => { s.trackers.webhook = 'x'; },
    expect: ['.webhook is not a field the schema knows'] },
  { n: 6, name: 'a site written with a scheme is refused', exit: 1,
    change: (s) => { s.trackers.instances.acme.site = 'https://acme.example.invalid'; },
    expect: ['must be a bare host'] },
  { n: 7, name: 'a token value where an environment variable name belongs is refused', exit: 1,
    change: (s) => { s.trackers.instances.acme.auth.token_env = 'a-pasted-token-value'; },
    expect: ['NAME of an environment variable', 'a value is never stored'] },
  { n: 8, name: 'a base_url carrying a credential is refused', exit: 1,
    change: (s) => { s.trackers.instances.acme.base_url = 'https://me:secret@api.example.invalid/ex/jira/abc'; },
    expect: ['must be an https URL with no credential'] },
  { n: 9, name: 'a board on an instance that is not listed is refused', exit: 1,
    change: (s) => { s.trackers.boards.platform.instance = 'other'; },
    expect: ['"other"', 'is not in "instances"'] },
  { n: 10, name: 'a default board that is not a board is refused', exit: 1,
    change: (s) => { s.trackers.default_board = 'nowhere'; },
    expect: ['"default_board" names "nowhere"'] },
  { n: 11, name: 'an Epic key stored in the board config is refused: the Epic is asked for', exit: 1,
    change: (s) => { s.trackers.boards.platform.epics = 'PLAT-9'; },
    expect: ['must be "ask" or "none"', 'no Epic key is stored here'] },
  { n: 12, name: 'a defect mapping with no story mapping is refused', exit: 1,
    change: (s) => { delete s.trackers.types.story; },
    expect: ['needs "types.story" as well'] },
  { n: 13, name: 'a defect whose parent is not the story is refused', exit: 1,
    change: (s) => { s.trackers.types.defect.parent = 'epic'; },
    expect: ['types.defect.parent must be "story"'] },
  { n: 14, name: 'a route of one status is refused', exit: 1,
    change: (s) => { s.trackers.types.story.moves.started.route = ['In Development']; },
    expect: ['at least two status names'] },
  { n: 15, name: 'a route that walks a status the board lists no id for is refused', exit: 1,
    change: (s) => { s.trackers.types.story.moves.started.route = ['Ready for Development', 'In Progress']; },
    expect: ['walks "In Progress"', 'lists no status id for'] },
  { n: 16, name: 'a route that names a status twice is refused', exit: 1,
    change: (s) => { s.trackers.types.story.moves.started.route = ['Backlog', 'In Development', 'Backlog']; },
    expect: ['names a status twice'] },
  { n: 17, name: 'a fact that does not move a ticket, used as a move, is refused', exit: 1,
    change: (s) => { s.trackers.types.story.moves.merged = { route: ['Backlog', 'In Development'] }; },
    expect: ['moves.merged is not a fact that moves a ticket'] },
  { n: 18, name: 'an annotation label with a space is refused', exit: 1,
    change: (s) => { s.trackers.types.story.annotations.merged.label = 'shl merged'; },
    expect: ['must be a label of letters'] },
  { n: 19, name: 'every finding is listed in one run, not just the first', exit: 1,
    change: (s) => { s.trackers.default_board = 'nowhere'; s.trackers.boards.platform.sprint = 'sometimes'; s.trackers.types.defect.parent = 'epic'; },
    expect: ['"default_board" names "nowhere"', '.sprint must be "report" or "add"', 'types.defect.parent must be "story"', '3 finding(s)'] },
  { n: 20, name: 'no links folder yet: the connection is well formed and nothing is linked', exit: 0,
    change: (s) => { s.links = null; },
    expect: ['[SKIP] links', 'no tickets are linked yet'] },
  { n: 21, name: 'a link file filed under a slug it does not say is refused', exit: 1,
    change: (s) => { s.links.visibility.slug = 'other-slug'; },
    expect: ['is filed as "visibility.json" but says slug "other-slug"'] },
  { n: 22, name: 'a ticket in another project than its board is refused', exit: 1,
    change: (s) => { s.links.visibility.items['SVC-101'].ticket = 'acme:OTHER-210'; },
    expect: ['is in project OTHER but board "platform" is project PLAT', 'the repository wins'] },
  { n: 23, name: 'a ticket on an instance trackers.json does not list is refused', exit: 1,
    change: (s) => { s.links.visibility.items['SVC-101'].ticket = 'gone:PLAT-210'; },
    expect: ['names instance "gone", which trackers.json does not list'] },
  { n: 24, name: 'a defect whose parent story is not in the file is refused', exit: 1,
    change: (s) => { s.links.visibility.items['SVC-120'].parent = 'SVC-150'; },
    expect: ['names SVC-150, which is not in this file'] },
  { n: 25, name: 'a defect on a different board than its parent is refused', exit: 1,
    change: (s) => {
      s.trackers.boards.other = { ...clone(s.trackers.boards.platform), project: 'OTHR', board: 7 };
      s.links.visibility.items['SVC-120'] = { type: 'defect', board: 'other', ticket: 'acme:OTHR-1', parent: 'SVC-101' };
    },
    expect: ['a sub-task is created in its parent\'s project'] },
  { n: 26, name: 'a story key in no decomposition block for the slug is refused', exit: 1,
    change: (s) => { s.ledger.blocks[0].slug = 'another'; },
    expect: ['is in no decomposition block of the key ledger for slug "visibility"'] },
  { n: 27, name: 'a defect whose validation block names another story is refused', exit: 1,
    change: (s) => { s.ledger.blocks[1].key = 'SVC-102'; },
    expect: ['is in no validation block of the key ledger whose "key" is SVC-101'] },
  { n: 28, name: 'a link key with another prefix than the ledger is refused', exit: 1,
    change: (s) => { s.links.visibility.items['ABC-101'] = { type: 'story', board: 'platform', ticket: 'acme:PLAT-300' }; },
    expect: ['has prefix ABC, but the key ledger\'s prefix is SVC'] },
  { n: 29, name: 'a malformed Epic reference is refused', exit: 1,
    change: (s) => { s.links.visibility.epic = 'PLAT-9'; },
    expect: ['"epic" must be <instance-id>:<TICKET-KEY>'] },
  { n: 30, name: 'a link file on a hub with no key ledger is checked for shape and says it could not check keys', exit: 0,
    change: (s) => { s.ledger = null; },
    expect: ['[NOTE] the key ledger', 'was not found'] },
  { n: 31, name: 'a stray file in the links folder is refused', exit: 1,
    change: (s) => { s.extra = { 'docs/estate/tracker-links/notes.txt': 'hello' }; },
    expect: ['notes.txt', 'not a link file'] },
  { n: 32, name: 'a story with a parent is refused', exit: 1,
    change: (s) => { s.links.visibility.items['SVC-102'].parent = 'SVC-101'; },
    expect: ['.parent is only for a defect'] },
  { n: 33, name: 'an unknown argument is a usage error', exit: 3, args: ['--bogus'],
    expect: ['unknown argument --bogus'] },
  { n: 34, name: 'the shipped SHL preset, with a connection around it, is well formed', exit: 0, preset: PRESET_SHL,
    expect: ['[PASS] connection'] },
  { n: 35, name: 'the shipped simple preset, with a connection around it, is well formed', exit: 0, preset: PRESET_SIMPLE,
    expect: ['[PASS] connection'],
    // The simple preset walks In Progress and In Review, so the control's status ids change to match.
    statusIds: { Backlog: '1', 'In Progress': '2', 'In Review': '3' } },
  // ---- found by the independent review of this check
  { n: 36, name: 'a trackers.json that is a link leading nowhere is cannot-verify, not "no tracker"', exit: 2,
    change: (s) => { s.trackers = null; s.symlinks = { 'docs/estate/trackers.json': '/nonexistent/target' }; },
    expect: ['CANNOT VERIFY', 'leads nowhere'], absent: ['NOT CONFIGURED'] },
  { n: 37, name: 'a key ledger with no prefix and no blocks is a finding, not a quiet pass', exit: 1,
    change: (s) => { s.ledger = '{}'; },
    expect: ['[FAIL] key ledger', '"prefix" must be the key prefix', '"blocks" must be an array'] },
  { n: 38, name: 'a key ledger that is JSON null is refused as a ledger, and not called "not found"', exit: 1,
    change: (s) => { s.ledger = 'null'; },
    expect: ['the root must be an object with "prefix" and "blocks"'], absent: ['was not found'] },
  { n: 39, name: 'a key ledger whose blocks is not an array is refused', exit: 1,
    change: (s) => { s.ledger.blocks = {}; },
    expect: ['"blocks" must be an array'] },
  { n: 40, name: 'a decomposition block with no slug is refused', exit: 1,
    change: (s) => { delete s.ledger.blocks[0].slug; },
    expect: ['is taken by a decomposition and needs its "slug"'] },
  { n: 41, name: '--ledger naming a file that is not there is cannot-verify, as --file and --links are', exit: 2, args: ['--ledger', 'nope.json'],
    expect: ['CANNOT VERIFY', 'no key ledger at nope.json'] },
  { n: 42, name: 'a link file that is not JSON is that file\'s finding, and the next file is still checked', exit: 1,
    change: (s) => { s.extra = { 'docs/estate/tracker-links/a-broken.json': '{ not json' }; },
    expect: ['[FAIL] a-broken.json', 'is not JSON', '[PASS] visibility.json'] },
  { n: 43, name: 'two broken link files are both listed, not just the first', exit: 1,
    change: (s) => { s.extra = { 'docs/estate/tracker-links/a-broken.json': '{ no', 'docs/estate/tracker-links/b-broken.json': '[ no' }; },
    expect: ['[FAIL] a-broken.json', '[FAIL] b-broken.json'] },
  { n: 44, name: 'a folder named like a link file is cannot-verify for that file, and the others are still checked', exit: 2,
    change: (s) => { s.dirs = ['docs/estate/tracker-links/x.json']; },
    expect: ['[FAIL] x.json', 'cannot read', '[PASS] visibility.json'] },
  { n: 45, name: '--links naming a regular file is cannot-verify, not a crash', exit: 2, args: ['--links', 'docs/estate/trackers.json'],
    expect: ['is not a folder'], absent: ['INTERNAL'] },
  { n: 46, name: 'the default links path being a regular file is cannot-verify, not a crash', exit: 2,
    change: (s) => { s.links = null; s.extra = { 'docs/estate/tracker-links': 'not a folder' }; },
    expect: ['is not a folder'], absent: ['INTERNAL'] },
  { n: 47, name: 'one ticket linked under two keys is refused', exit: 1,
    change: (s) => { s.links.visibility.items['SVC-102'].ticket = 'acme:PLAT-210'; },
    expect: ['is already linked to', 'one ticket, one harness key'] },
  { n: 48, name: 'a key written with a leading zero is not a canonical key', exit: 1,
    change: (s) => { s.links.visibility.items['SVC-0101'] = { type: 'story', board: 'platform', ticket: 'acme:PLAT-400' }; },
    expect: ['"SVC-0101"', 'is not a canonical harness key'] },
  { n: 49, name: 'one key linked in two link files is refused', exit: 1,
    change: (s) => { s.links.other = { schema_version: 1, slug: 'other', items: { 'SVC-101': { type: 'story', board: 'platform', ticket: 'acme:PLAT-500' } } }; },
    expect: ['is also linked in', 'one key, one link file'] },
  { n: 50, name: 'a link of a type trackers.json has no mapping for is refused', exit: 1,
    change: (s) => {
      delete s.trackers.types.defect;
      s.ledger.blocks.push({ from: 120, to: 120, taken_by: 'validation', key: 'SVC-101' });
      s.links.visibility.items['SVC-120'] = { type: 'defect', board: 'platform', ticket: 'acme:PLAT-231', parent: 'SVC-101' };
    },
    expect: ['is "defect", but trackers.json has no mapping for it'] },
  { n: 51, name: 'an inherited name such as toString is not a board', exit: 1,
    change: (s) => { s.trackers.default_board = 'toString'; },
    expect: ['"default_board" names "toString", which is not in "boards"'] },
  { n: 52, name: 'an inherited name such as constructor is not an instance', exit: 1,
    change: (s) => { s.trackers.boards.platform.instance = 'constructor'; },
    expect: ['names "constructor", which is not in "instances"'] },
  { n: 53, name: 'an inherited name in a route is not a status the board lists', exit: 1,
    change: (s) => { s.trackers.types.story.moves.started.route = ['Ready for Development', 'constructor']; },
    expect: ['walks "constructor"', 'lists no status id for'] },
  { n: 54, name: 'a ticket on an inherited-name instance is not on a listed instance', exit: 1,
    change: (s) => { s.links.visibility.items['SVC-101'].ticket = 'constructor:PLAT-210'; },
    expect: ['names instance "constructor", which trackers.json does not list'] },
  { n: 55, name: 'an unknown field is refused at every nesting level', exit: 1,
    change: (s) => {
      s.trackers.instances.acme.extra = 1;
      s.trackers.instances.acme.auth.extra = 1;
      s.trackers.boards.platform.extra = 1;
      s.trackers.types.story.extra = 1;
      s.trackers.types.story.moves.started.extra = 1;
      s.trackers.types.story.annotations.merged.extra = 1;
    },
    expect: ['instances["acme"].extra', 'auth.extra', 'boards["platform"].extra', 'types.story.extra', 'moves.started.extra', 'annotations.merged.extra', '6 finding(s)'] },
  { n: 56, name: 'a story mapping that names a parent is refused', exit: 1,
    change: (s) => { s.trackers.types.story.parent = 'story'; },
    expect: ['types.story.parent is only for a sub-task type'] },
  { n: 57, name: 'a ticket on a different instance than its board is refused', exit: 1,
    change: (s) => {
      s.trackers.instances.beta = { ...clone(s.trackers.instances.acme), site: 'beta.example.invalid' };
      s.links.visibility.items['SVC-101'].ticket = 'beta:PLAT-210';
    },
    expect: ['is on instance "beta" but board "platform" is on "acme"'] },
  { n: 58, name: 'a defect whose parent is another defect is refused', exit: 1,
    change: (s) => {
      s.ledger.blocks.push({ from: 120, to: 121, taken_by: 'validation', key: 'SVC-101' });
      s.links.visibility.items['SVC-120'] = { type: 'defect', board: 'platform', ticket: 'acme:PLAT-231', parent: 'SVC-101' };
      s.links.visibility.items['SVC-121'] = { type: 'defect', board: 'platform', ticket: 'acme:PLAT-232', parent: 'SVC-120' };
    },
    expect: ['names SVC-120, which is not a story'] },
  { n: 59, name: 'an Epic on an instance trackers.json does not list is refused', exit: 1,
    change: (s) => { s.links.visibility.epic = 'nope:PLAT-9'; },
    expect: ['"epic" names instance "nope", which trackers.json does not list'] },
  { n: 60, name: 'an empty links folder is well formed: nothing is linked yet', exit: 0,
    change: (s) => { s.links = {}; },
    expect: ['WELL FORMED', 'no tickets are linked yet'] },
  { n: 61, name: 'a create-field default that names a secret is refused', exit: 1,
    change: (s) => { s.trackers.types.story.fields = { components: [{ name: 'Web' }], password: 'x' }; },
    expect: ['types.story.fields.password names a secret'] },
  { n: 62, name: 'one environment variable for both the user and the token is refused', exit: 1,
    change: (s) => { s.trackers.instances.acme.auth.user_env = 'JIRA_API_TOKEN'; },
    expect: ['names one variable for both the user and the token'] },
  { n: 63, name: 'a base_url on some other host is refused', exit: 1,
    change: (s) => { s.trackers.instances.acme.base_url = 'https://evil.example.invalid/x'; },
    expect: ['neither this instance\'s site nor api.atlassian.com'] },
  { n: 64, name: 'a base_url on Atlassian\'s gateway is accepted', exit: 0,
    change: (s) => { s.trackers.instances.acme.base_url = 'https://api.atlassian.com/ex/jira/abc-123'; },
    expect: ['[PASS] connection'] },
  { n: 65, name: 'a base_url with ".." in its path is refused', exit: 1,
    change: (s) => { s.trackers.instances.acme.base_url = 'https://api.atlassian.com/ex/../x'; },
    expect: ['no ".."'] },
  { n: 66, name: 'a site that is an address is refused', exit: 1,
    change: (s) => { s.trackers.instances.acme.site = '169.254.169.254'; },
    expect: ['must be a bare host name'] },
  { n: 67, name: 'an environment variable name over 64 characters is refused', exit: 1,
    change: (s) => { s.trackers.instances.acme.auth.token_env = `T${'X'.repeat(70)}`; },
    expect: ['at most 64'] },
  { n: 68, name: 'every finding in a link file is counted, not one per file (three here, counting the control defect)', exit: 1,
    change: (s) => {
      s.links.visibility.items['SVC-101'].board = 'nowhere';
      s.links.visibility.items['SVC-102'] = { type: 'story', board: 'nowhere', ticket: 'acme:PLAT-211' };
    },
    expect: ['3 finding(s)'] },
  // ---- inputs far longer than any valid value are refused fast, and never reach a pattern
  { n: 69, name: 'a 200,000-character ledger prefix is refused promptly, and the message is cut short', exit: 1,
    change: (s) => { s.ledger.prefix = 'A'.repeat(200000); },
    expect: ['"prefix" must be the key prefix in capitals'], maxOutput: 20000 },
  { n: 70, name: 'a 200,000-character slug in a link file is refused promptly', exit: 1,
    change: (s) => { s.links.visibility.slug = 'a'.repeat(200000); },
    expect: ['"slug" must be a slug'], maxOutput: 20000 },
  { n: 71, name: 'a 200,000-digit key is refused promptly', exit: 1,
    change: (s) => { s.links.visibility.items[`SVC-${'9'.repeat(200000)}`] = { type: 'story', board: 'platform', ticket: 'acme:PLAT-777' }; },
    expect: ['is not a canonical harness key'], maxOutput: 20000 },
  { n: 72, name: 'a 100,000-digit status id is refused promptly', exit: 1,
    change: (s) => { s.trackers.boards.platform.status_ids.Backlog = '9'.repeat(100000); },
    expect: ['must be a numeric status id as a string'], maxOutput: 20000 },
  { n: 73, name: 'a 100,000-character site is refused promptly', exit: 1,
    change: (s) => { s.trackers.instances.acme.site = `${'a'.repeat(100000)}.example.invalid`; },
    expect: ['must be a bare host name'], maxOutput: 20000 },
  { n: 74, name: 'a 100,000-character ticket is refused promptly', exit: 1,
    change: (s) => { s.links.visibility.items['SVC-101'].ticket = `acme:${'P'.repeat(100000)}-1`; },
    expect: ['must be <instance-id>:<TICKET-KEY>'], maxOutput: 20000 },
  // ---- an OAuth connection: one token variable, no user variable, the gateway for one cloud id
  { n: 75, name: 'an oauth connection with one token variable and the gateway is accepted', exit: 0,
    change: oauthConnection,
    expect: ['[PASS] connection', 'WELL FORMED'] },
  { n: 76, name: 'an oauth connection with no base_url is refused: an OAuth token works only through the gateway', exit: 1,
    change: (s) => { oauthConnection(s); delete s.trackers.instances.acme.base_url; },
    expect: ['base_url is required when the method is "oauth"'] },
  { n: 77, name: 'an oauth connection whose base_url is the site is refused', exit: 1,
    change: (s) => { oauthConnection(s); s.trackers.instances.acme.base_url = 'https://acme.example.invalid'; },
    expect: ['must be https://api.atlassian.com/ex/jira/<cloudId> when the method is "oauth"'] },
  { n: 78, name: 'an oauth connection whose gateway path is not one cloud id is refused', exit: 1,
    change: (s) => { oauthConnection(s); s.trackers.instances.acme.base_url = 'https://api.atlassian.com/ex/jira/abc-123'; },
    expect: ['must be https://api.atlassian.com/ex/jira/<cloudId> when the method is "oauth"'] },
  { n: 79, name: 'an oauth connection that also names a user variable is refused: the token says who it is', exit: 1,
    change: (s) => { oauthConnection(s); s.trackers.instances.acme.auth.user_env = 'JIRA_USER'; },
    expect: ['auth.user_env must not be set when the method is "oauth"'] },
  { n: 80, name: 'an oauth connection with a token value where the variable name belongs is refused', exit: 1,
    change: (s) => { oauthConnection(s); s.trackers.instances.acme.auth.token_env = 'eyJhbGciOiJIUzI1NiJ9'; },
    expect: ['NAME of an environment variable', 'a value is never stored'] },
  { n: 81, name: 'an api-token connection with no user variable is still refused', exit: 1,
    change: (s) => { delete s.trackers.instances.acme.auth.user_env; },
    expect: ['auth.user_env must be the NAME of an environment variable'] },
  { n: 82, name: 'a method the harness does not know is refused, and the message names both methods', exit: 1,
    change: (s) => { s.trackers.instances.acme.auth.method = 'password'; },
    expect: ['must be "api-token" or "oauth", got "password"'] },
];

// The connection for a developer who holds an OAuth access token rather than an API token.
function oauthConnection(s) {
  s.trackers.instances.acme.auth = { method: 'oauth', token_env: 'JIRA_OAUTH_TOKEN' };
  s.trackers.instances.acme.base_url = 'https://api.atlassian.com/ex/jira/11111111-2222-4333-8444-555555555555';
}

/* ---------------------------------------------------------------------------- the runner */

function runFixture(f) {
  const root = mkdtempSync(join(tmpdir(), 'check-trackers-'));
  try {
    const state = clone(CONTROL);
    state.extra = {};
    if (f.preset) {
      const preset = JSON.parse(readFileSync(f.preset, 'utf8'));
      state.trackers.types = preset.types;
      if (f.statusIds) state.trackers.boards.platform.status_ids = f.statusIds;
      state.links = null;
      state.ledger = null;
    }
    if (f.change) f.change(state);
    buildHub(root, state);
    const run = spawnSync(process.execPath, [SCRIPT, ...(f.args || [])], { cwd: root, encoding: 'utf8', timeout: 20000, maxBuffer: 16 * 1024 * 1024 });
    const output = `${run.stdout || ''}${run.stderr || ''}`;
    const problems = [];
    if (run.status !== f.exit) problems.push(`exit ${run.status}, expected ${f.exit}`);
    for (const s of f.expect || []) if (!output.includes(s)) problems.push(`output lacks ${JSON.stringify(s)}`);
    for (const s of f.absent || []) if (output.includes(s)) problems.push(`output has ${JSON.stringify(s)}`);
    if (f.maxOutput && output.length > f.maxOutput) problems.push(`output is ${output.length} characters; a huge input must not flood the terminal (limit ${f.maxOutput})`);
    if (run.error && run.error.code === 'ETIMEDOUT') problems.push('the script did not finish within 20 seconds');
    return { problems, output };
  } catch (err) {
    return { problems: [`fixture setup failed: ${err && err.message ? err.message : String(err)}`], output: '' };
  } finally {
    if (!KEEP) rmSync(root, { recursive: true, force: true });
  }
}

function main() {
  const wanted = process.argv.slice(2).filter((a) => /^\d+$/.test(a)).map(Number);
  const selected = wanted.length ? FIXTURES.filter((f) => wanted.includes(f.n)) : FIXTURES;
  let failed = 0;
  for (const f of selected) {
    if ((f.n === 34 && !PRESET_SHL) || (f.n === 35 && !PRESET_SIMPLE)) {
      failed += 1;
      process.stdout.write(`  FAIL  ${f.n}. ${f.name} [exit ${f.exit}]\n          - the preset file is not where this layout keeps it\n`);
      continue;
    }
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
    ? `\n${failed} of ${selected.length} fixtures FAILED. The tracker check is not trustworthy until this is green.\n`
    : `\nAll ${selected.length} fixtures passed.\n`);
  process.exit(failed ? 1 : 0);
}

main();

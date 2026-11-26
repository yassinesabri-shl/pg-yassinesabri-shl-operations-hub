#!/usr/bin/env node
// Part of the harness asset library c6f3b4427d58f7c3 (see VERSION.json) · 2026-10-09
/**
 * check-trackers.mjs — is the hub's tracker connection well formed, and do its links agree?
 *
 *   usage:  node scripts/check-trackers.mjs [--file <trackers.json>] [--links <dir>] [--ledger <keys.json>]
 *
 * A hub may keep a read-only mirror of its work in an issue tracker (`jira-sync.mjs`). The
 * connection is `docs/estate/trackers.json`, written by `/connect-jira`; the reference from each
 * harness key to its ticket is one link file per decomposition,
 * `docs/estate/tracker-links/<SLUG>.json`. This script proves both are well formed and that
 * they agree with each other and with the key ledger. It reads files only and imports nothing.
 * It never reaches a tracker, so it needs no credential and runs offline.
 *
 * Optional by design. No `trackers.json` at the default path means the hub has no tracker: that
 * is exit 0 and says so. Only a path that is truly absent counts as "no tracker": a path named
 * with --file that is not there, a link that leads nowhere, or anything that cannot be examined
 * is exit 2, never a quiet pass.
 *
 * Three passes, every finding listed before the exit.
 *
 *   1. The connection. The root, the instances, the boards and the two issue types, each field
 *      the schema names and nothing else; an environment variable named where a variable is
 *      named, never a value; a site that is a bare host name; a base_url on that host or on
 *      Atlassian's gateway; an `oauth` connection with one token variable, no user variable and
 *      a base_url that is the gateway for one cloud id; no secret-shaped key among a type's
 *      create-field defaults.
 *   2. What the connection says about itself. The default board is a board; each board's
 *      instance is an instance; a defect is a sub-task of a story and needs the story's mapping;
 *      where a board lists its status ids, every status a route walks is one of them.
 *   3. The key ledger and the links, unless there is no links folder. The ledger is read for the
 *      fields this check uses and is itself a finding if they are not there. Each link file is
 *      `<SLUG>.json` with that slug; each ticket names a known instance, sits in its board's
 *      project and is linked once, in one file; each key is canonical and in one file; each
 *      type has a mapping; a defect names a parent story in the same file and the same board;
 *      and each story's key sits in a decomposition block for the slug and each defect's in a
 *      validation block whose `key` is its parent.
 *
 * Exit codes -- the gate's, and the highest across findings:
 *   0  well formed and in agreement, or no tracker configured
 *   1  a shape or agreement failure
 *   2  cannot verify: a file or folder that is named but not there, or that cannot be read
 *   3  usage
 *   4  internal
 *
 * What this script cannot see
 *   - Whether the site, project, board or status ids are real. That is the tracker's to say, and
 *     `jira-sync.mjs plan` asks it.
 *   - Whether a ticket still exists, or is still in its project. A link file records a ticket
 *     as it was created.
 *   - Whether a value is a secret. It refuses what names a secret and what is not a variable
 *     name; it cannot tell every secret from every other string.
 */

import { lstatSync, readFileSync, readdirSync, statSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { stdout, stderr } from 'node:process';

const EXIT = { PASS: 0, FAIL: 1, CANNOT_VERIFY: 2, USAGE: 3, INTERNAL: 4 };

const DEFAULT_FILE = 'docs/estate/trackers.json';
const DEFAULT_LINKS = 'docs/estate/tracker-links';
const DEFAULT_LEDGER = 'docs/backlog/keys.json';

const INSTANCE_ID = /^[a-z][a-z0-9-]{0,19}$/;
const BOARD_ID = /^[a-z][a-z0-9-]{0,29}$/;
const PROJECT = /^[A-Z][A-Z0-9_]{1,9}$/;
// A host name with at least one dot and a letters-only top level: never an address, never "a..b".
const SITE = /^(?=.{4,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,}$/;
const ENV_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
const SPRINT_FIELD = /^customfield_[0-9]{1,10}$/;
const LABEL = /^[A-Za-z0-9_-]{1,255}$/;
const BASE_URL = /^https:\/\/[A-Za-z0-9][A-Za-z0-9./_-]{0,499}$/;
// Atlassian's gateway for one site, named by the site's cloud id. An OAuth token works only here.
const GATEWAY = /^https:\/\/api\.atlassian\.com\/ex\/jira\/[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/;
const AUTH_METHODS = ['api-token', 'oauth'];
// A harness key as the ledger mints it: a number never starts with a zero.
const KEY = /^[A-Z][A-Z0-9]{1,9}-[1-9][0-9]{0,9}$/;
const SLUG = /^[a-z0-9][a-z0-9-]{0,99}$/;
const TICKET = /^([a-z][a-z0-9-]{0,19}):([A-Z][A-Z0-9_]{1,9})-([1-9][0-9]{0,9})$/;
const PREFIX = /^[A-Z][A-Z0-9]{0,9}$/;
const STATUS_ID = /^[0-9]{1,12}$/;
// A path that climbs: ".." or "." as a whole segment.
const CLIMBS = /(^|\/)\.\.?(\/|$)/;
const SECRET_KEY = /pass(?:word|wd)?|secret|token|api[_-]?key|credential|authorization/i;

// Every value read from a file is tested through these, never directly: a string longer than any
// valid value is refused before a pattern sees it, so no input can make a pattern slow. The
// patterns above are anchored with bounded repetition as well; the two together are the guard.
const MAX_INPUT = 600;
const match = (re, v) => typeof v === 'string' && v.length <= MAX_INPUT && re.test(v);
const matchTicket = (v) => (typeof v === 'string' && v.length <= MAX_INPUT ? TICKET.exec(v) : null);

const MOVES = ['design-merged', 'started', 'in-review'];
const ANNOTATIONS = ['merged', 'validated'];
const TYPES = ['story', 'defect'];
const NAMES = {
  root: ['schema_version', 'instances', 'boards', 'default_board', 'types'],
  instance: ['kind', 'site', 'base_url', 'auth'],
  auth: ['method', 'user_env', 'token_env'],
  board: ['instance', 'project', 'board', 'sprint', 'sprint_field', 'epics', 'status_ids'],
  type: ['issue_type', 'parent', 'fields', 'moves', 'annotations'],
  links: ['schema_version', 'slug', 'epic', 'items'],
  linkItem: ['type', 'board', 'ticket', 'parent'],
};

function usage(message) {
  const invoked = process.argv[1] || 'scripts/check-trackers.mjs';
  stderr.write(`${message}\nusage: node ${invoked} [--file <trackers.json>] [--links <dir>] [--ledger <keys.json>]\n`);
  process.exit(EXIT.USAGE);
}

function parseArgs(argv) {
  const out = { file: null, links: null, ledger: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--file' || a === '--links' || a === '--ledger') {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) usage(`${a} needs a value`);
      out[a.slice(2)] = v;
      i += 1;
    } else usage(`unknown argument ${a}`);
  }
  return out;
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
// Own properties only: "constructor" and "toString" are not a board, an instance or a status.
const has = (o, k) => isObject(o) && Object.hasOwn(o, k);
// A value from a file, quoted for a message and cut short: a huge input is a finding, not a flood.
const q = (v) => {
  const t = JSON.stringify(v);
  return typeof t === 'string' && t.length > 80 ? `${t.slice(0, 77)}...` : t;
};
// A name from a file, printed. Control characters never reach the terminal.
// eslint-disable-next-line no-control-regex
const safe = (v) => String(v).slice(0, 200).replace(/[\u0000-\u001f\u007f-\u009f]/g, '?');

/**
 * What is at a path, without being fooled. Absent is a path that is not there; a link that leads
 * nowhere and anything that cannot be examined are "unreadable", which is cannot-verify, because
 * calling either "not there" would turn a broken file into a hub with no tracker.
 */
function probe(path) {
  let l;
  try {
    l = lstatSync(path);
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return { state: 'absent' };
    return { state: 'unreadable', why: `cannot be examined (${err.code || err.message})` };
  }
  let st;
  try {
    st = statSync(path);
  } catch (err) {
    return { state: 'unreadable', why: l.isSymbolicLink() ? 'is a symbolic link that leads nowhere' : `cannot be read (${err.code || err.message})` };
  }
  return { state: st.isDirectory() ? 'dir' : st.isFile() ? 'file' : 'other' };
}

// Reads and parses one JSON file. A file that cannot be read is "cannot verify"; one that is
// not JSON is a failure, because there is a file and it is wrong.
function readJson(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    return { exit: EXIT.CANNOT_VERIFY, error: `cannot read ${safe(path)}: ${err.code || err.message}` };
  }
  try {
    return { value: JSON.parse(text) };
  } catch (err) {
    return { exit: EXIT.FAIL, error: `${safe(path)} is not JSON: ${err.message}` };
  }
}

function unknownFields(obj, allowed, where, out) {
  for (const k of Object.keys(obj)) {
    if (!allowed.includes(k)) out.push(`${where}.${safe(k)} is not a field the schema knows`);
  }
}

// Any key at any depth that names a secret.
function secretKeys(value, path = 'fields') {
  const hits = [];
  if (isObject(value)) {
    for (const [k, v] of Object.entries(value)) {
      if (match(SECRET_KEY, k)) hits.push(`${path}.${safe(k)}`);
      hits.push(...secretKeys(v, `${path}.${safe(k)}`));
    }
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => hits.push(...secretKeys(v, `${path}[${i}]`)));
  }
  return hits;
}

/* ------------------------------------------------------------ pass 1 and 2: the connection */

function validateTrackers(t, path = DEFAULT_FILE) {
  const out = [];
  const at = (where) => `${safe(path)}: ${where}`;
  if (!isObject(t)) return [at('the root must be an object')];
  unknownFields(t, NAMES.root, safe(path), out);
  if (t.schema_version !== 1) out.push(at(`"schema_version" must be 1, got ${q(t.schema_version)}`));
  for (const k of ['instances', 'boards', 'types']) {
    if (!isObject(t[k])) out.push(at(`"${k}" must be an object`));
  }
  if (typeof t.default_board !== 'string') out.push(at('"default_board" must be a board id'));
  const instances = isObject(t.instances) ? t.instances : {};
  const boards = isObject(t.boards) ? t.boards : {};
  const types = isObject(t.types) ? t.types : {};

  for (const [id, inst] of Object.entries(instances)) {
    const here = (f) => at(`instances[${q(id)}]${f ? `.${f}` : ''}`);
    if (!match(INSTANCE_ID, id)) out.push(`${here()} is not an instance id: lower-case letters, digits and "-", starting with a letter, at most 20`);
    if (!isObject(inst)) { out.push(`${here()} must be an object`); continue; }
    unknownFields(inst, NAMES.instance, here(), out);
    if (inst.kind !== 'jira-cloud') out.push(`${here('kind')} must be "jira-cloud", got ${q(inst.kind)}`);
    if (typeof inst.site !== 'string' || !match(SITE, inst.site)) {
      out.push(`${here('site')} must be a bare host name such as example.atlassian.net: no scheme, path, port, user name, token or address`);
    }
    if ('base_url' in inst) {
      const b = inst.base_url;
      let host = null;
      try { host = new URL(b).host; } catch { host = null; }
      const rest = typeof b === 'string' ? b.slice('https://'.length) : '';
      const wellFormed = typeof b === 'string' && match(BASE_URL, b) && !b.endsWith('/') && !rest.includes('//') && !match(CLIMBS, rest);
      if (!wellFormed) out.push(`${here('base_url')} must be an https URL with no credential, no "..", no "//" and no trailing "/"`);
      else if (host !== inst.site && host !== 'api.atlassian.com') out.push(`${here('base_url')} is on ${q(host)}, which is neither this instance's site nor api.atlassian.com`);
    }
    if (!isObject(inst.auth)) {
      out.push(`${here('auth')} must be an object`);
    } else {
      unknownFields(inst.auth, NAMES.auth, here('auth'), out);
      const oauth = inst.auth.method === 'oauth';
      if (!AUTH_METHODS.includes(inst.auth.method)) {
        out.push(`${here('auth.method')} must be ${AUTH_METHODS.map(q).join(' or ')}, got ${q(inst.auth.method)}`);
      }
      for (const f of oauth ? ['token_env'] : ['user_env', 'token_env']) {
        const v = inst.auth[f];
        if (typeof v !== 'string' || !match(ENV_NAME, v)) {
          out.push(`${here(`auth.${f}`)} must be the NAME of an environment variable (capitals, digits, "_", at most 64); a value is never stored in this file`);
        }
      }
      if (oauth && 'user_env' in inst.auth) {
        out.push(`${here('auth.user_env')} must not be set when the method is "oauth": an OAuth access token says who it is`);
      }
      if (oauth && !('base_url' in inst)) {
        out.push(`${here('base_url')} is required when the method is "oauth": an OAuth access token works only through https://api.atlassian.com/ex/jira/<cloudId>`);
      } else if (oauth && !match(GATEWAY, inst.base_url)) {
        out.push(`${here('base_url')} must be https://api.atlassian.com/ex/jira/<cloudId> when the method is "oauth", where <cloudId> is the site's cloud id`);
      }
      if (typeof inst.auth.user_env === 'string' && inst.auth.user_env === inst.auth.token_env) {
        out.push(`${here('auth')} names one variable for both the user and the token`);
      }
    }
  }

  for (const [id, board] of Object.entries(boards)) {
    const here = (f) => at(`boards[${q(id)}]${f ? `.${f}` : ''}`);
    if (!match(BOARD_ID, id)) out.push(`${here()} is not a board id: lower-case letters, digits and "-", starting with a letter, at most 30`);
    if (!isObject(board)) { out.push(`${here()} must be an object`); continue; }
    unknownFields(board, NAMES.board, here(), out);
    if (typeof board.instance !== 'string' || !has(instances, board.instance)) {
      out.push(`${here('instance')} names ${q(board.instance)}, which is not in "instances"`);
    }
    if (typeof board.project !== 'string' || !match(PROJECT, board.project)) out.push(`${here('project')} must be a project key such as PLAT`);
    if (!Number.isInteger(board.board) || board.board < 1) out.push(`${here('board')} must be a whole number of at least 1`);
    if (!['report', 'add'].includes(board.sprint)) out.push(`${here('sprint')} must be "report" or "add", got ${q(board.sprint)}`);
    if ('sprint_field' in board && (typeof board.sprint_field !== 'string' || !match(SPRINT_FIELD, board.sprint_field))) {
      out.push(`${here('sprint_field')} must look like customfield_10020; it is discovered, never assumed`);
    }
    if (!['ask', 'none'].includes(board.epics)) out.push(`${here('epics')} must be "ask" or "none", got ${q(board.epics)}; no Epic key is stored here`);
    if ('status_ids' in board) {
      if (!isObject(board.status_ids)) out.push(`${here('status_ids')} must be an object of status name to status id`);
      else {
        for (const [name, sid] of Object.entries(board.status_ids)) {
          if (typeof sid !== 'string' || !match(STATUS_ID, sid)) out.push(`${here(`status_ids[${q(name)}]`)} must be a numeric status id as a string`);
        }
      }
    }
  }

  if (typeof t.default_board === 'string' && !has(boards, t.default_board)) {
    out.push(at(`"default_board" names ${q(t.default_board)}, which is not in "boards"`));
  }

  for (const [name, type] of Object.entries(types)) {
    const here = (f) => at(`types.${safe(name)}${f ? `.${f}` : ''}`);
    if (!TYPES.includes(name)) { out.push(`${here()} is not an issue type the harness mirrors (${TYPES.join(', ')})`); continue; }
    if (!isObject(type)) { out.push(`${here()} must be an object`); continue; }
    unknownFields(type, NAMES.type, here(), out);
    if (typeof type.issue_type !== 'string' || type.issue_type.trim() === '') out.push(`${here('issue_type')} must name the tracker's issue type`);
    if (name === 'defect') {
      if (type.parent !== 'story') out.push(`${here('parent')} must be "story": a defect is a sub-task of its story`);
      if (!has(types, 'story')) out.push(`${here()} needs "types.story" as well: a defect is created under its story's ticket`);
    } else if ('parent' in type) {
      out.push(`${here('parent')} is only for a sub-task type; a story has no parent in this mapping`);
    }
    if ('fields' in type) {
      if (!isObject(type.fields)) out.push(`${here('fields')} must be an object of create-field defaults`);
      else for (const hit of secretKeys(type.fields)) out.push(`${here(hit)} names a secret; create-field defaults are committed and read by every seat, so a credential never goes here`);
    }
    if (!isObject(type.moves)) out.push(`${here('moves')} must be an object`);
    else {
      for (const [fact, move] of Object.entries(type.moves)) {
        const mhere = here(`moves.${safe(fact)}`);
        if (!MOVES.includes(fact)) { out.push(`${mhere} is not a fact that moves a ticket (${MOVES.join(', ')})`); continue; }
        if (!isObject(move)) { out.push(`${mhere} must be an object`); continue; }
        unknownFields(move, ['route'], mhere, out);
        const r = move.route;
        if (!Array.isArray(r) || r.length < 2 || r.some((s) => typeof s !== 'string' || s.trim() === '')) {
          out.push(`${mhere}.route must list at least two status names, the start and the target`);
        } else if (new Set(r).size !== r.length) {
          out.push(`${mhere}.route names a status twice; a route only goes forward`);
        } else {
          for (const [bid, board] of Object.entries(boards)) {
            if (!isObject(board) || !isObject(board.status_ids) || Object.keys(board.status_ids).length === 0) continue;
            for (const s of r) {
              if (!has(board.status_ids, s)) out.push(`${mhere}.route walks ${q(s)}, which board ${q(bid)} lists no status id for; add it, or the sync cannot tell a rename from a different status`);
            }
          }
        }
      }
    }
    if (!isObject(type.annotations)) out.push(`${here('annotations')} must be an object`);
    else {
      for (const [fact, a] of Object.entries(type.annotations)) {
        const ahere = here(`annotations.${safe(fact)}`);
        if (!ANNOTATIONS.includes(fact)) { out.push(`${ahere} is not a fact that annotates a ticket (${ANNOTATIONS.join(', ')})`); continue; }
        if (!isObject(a)) { out.push(`${ahere} must be an object`); continue; }
        unknownFields(a, ['label'], ahere, out);
        if (typeof a.label !== 'string' || !match(LABEL, a.label)) out.push(`${ahere}.label must be a label of letters, digits, "-" and "_"`);
      }
    }
  }
  return out;
}

/* ------------------------------------------------------------- pass 3: the ledger and links */

// Only what this check reads. A ledger that lacks it is a finding, never a quiet pass.
function validateLedger(ledger, path) {
  const at = (where) => `${safe(path)}: ${where}`;
  if (!isObject(ledger)) return [at('the root must be an object with "prefix" and "blocks"')];
  const out = [];
  if (typeof ledger.prefix !== 'string' || !match(PREFIX, ledger.prefix)) out.push(at(`"prefix" must be the key prefix in capitals, got ${q(ledger.prefix)}`));
  if (!Array.isArray(ledger.blocks)) { out.push(at('"blocks" must be an array')); return out; }
  ledger.blocks.forEach((b, i) => {
    const here = at(`blocks[${i}]`);
    if (!isObject(b)) { out.push(`${here} must be an object`); return; }
    if (!Number.isInteger(b.from) || !Number.isInteger(b.to) || b.from < 1 || b.to < b.from) out.push(`${here} needs whole numbers "from" and "to" with from <= to`);
    if (b.taken_by === 'decomposition') {
      if (typeof b.slug !== 'string' || !match(SLUG, b.slug)) out.push(`${here} is taken by a decomposition and needs its "slug"`);
    } else if (b.taken_by === 'validation') {
      if (typeof b.key !== 'string' || !match(KEY, b.key)) out.push(`${here} is taken by a validation and needs the "key" of the work item validated`);
    } else out.push(`${here} "taken_by" must be "decomposition" or "validation", got ${q(b.taken_by)}`);
  });
  return out;
}

function inBlock(block, key) {
  const n = Number(key.slice(key.lastIndexOf('-') + 1));
  return Number.isInteger(block.from) && Number.isInteger(block.to) && n >= block.from && n <= block.to;
}

function validateLinks(file, links, trackers, ledger, seen) {
  const out = [];
  const at = (where) => `${safe(file)}: ${where}`;
  if (!isObject(links)) return [at('the root must be an object')];
  unknownFields(links, NAMES.links, safe(file), out);
  if (links.schema_version !== 1) out.push(at(`"schema_version" must be 1, got ${q(links.schema_version)}`));
  const slug = links.slug;
  const name = file.slice(file.lastIndexOf('/') + 1);
  if (typeof slug !== 'string' || !match(SLUG, slug)) out.push(at(`"slug" must be a slug, got ${q(slug)}`));
  else if (name !== `${slug}.json`) out.push(at(`is filed as ${q(name)} but says slug ${q(slug)}; one decomposition, one file, named for it`));
  const instances = isObject(trackers.instances) ? trackers.instances : {};
  const boards = isObject(trackers.boards) ? trackers.boards : {};
  const types = isObject(trackers.types) ? trackers.types : {};

  if ('epic' in links) {
    const m = matchTicket(links.epic);
    if (!m) out.push(at(`"epic" must be <instance-id>:<TICKET-KEY>, got ${q(links.epic)}`));
    else if (!has(instances, m[1])) out.push(at(`"epic" names instance ${q(m[1])}, which trackers.json does not list`));
  }
  if (!isObject(links.items)) { out.push(at('"items" must be an object keyed by harness key')); return out; }

  const items = links.items;
  for (const [key, item] of Object.entries(items)) {
    const here = (f) => at(`items[${q(key)}]${f ? `.${f}` : ''}`);
    if (!match(KEY, key)) out.push(`${here()} is not a canonical harness key: capitals and digits, "-", then a number with no leading zero`);
    if (!isObject(item)) { out.push(`${here()} must be an object`); continue; }
    unknownFields(item, NAMES.linkItem, here(), out);
    if (!TYPES.includes(item.type)) out.push(`${here('type')} must be "story" or "defect", got ${q(item.type)}`);
    else if (!has(types, item.type)) out.push(`${here('type')} is "${item.type}", but trackers.json has no mapping for it`);
    const board = typeof item.board === 'string' && has(boards, item.board) ? boards[item.board] : undefined;
    if (!board) out.push(`${here('board')} names ${q(item.board)}, which trackers.json does not list`);
    const m = matchTicket(item.ticket);
    if (!m) out.push(`${here('ticket')} must be <instance-id>:<TICKET-KEY>, got ${q(item.ticket)}`);
    else {
      if (!has(instances, m[1])) out.push(`${here('ticket')} names instance ${q(m[1])}, which trackers.json does not list`);
      else if (board && board.instance !== m[1]) out.push(`${here('ticket')} is on instance ${q(m[1])} but board ${q(item.board)} is on ${q(board.instance)}`);
      if (board && m[2] !== board.project) {
        out.push(`${here('ticket')} is in project ${m[2]} but board ${q(item.board)} is project ${board.project}; the file or the ticket is wrong, and the repository wins`);
      }
      const owner = seen.tickets.get(item.ticket);
      if (owner) out.push(`${here('ticket')} ${item.ticket} is already linked to ${owner}; one ticket, one harness key`);
      else seen.tickets.set(item.ticket, `${key} in ${name}`);
    }
    const elsewhere = seen.keys.get(key);
    if (elsewhere) out.push(`${here()} is also linked in ${q(elsewhere)}; one key, one link file`);
    else seen.keys.set(key, name);

    if (item.type === 'defect') {
      const parent = item.parent;
      if (typeof parent !== 'string' || !match(KEY, parent)) out.push(`${here('parent')} must name the defect's parent story`);
      else if (!has(items, parent)) out.push(`${here('parent')} names ${parent}, which is not in this file; a defect's parent story is linked in the same file`);
      else if (items[parent].type !== 'story') out.push(`${here('parent')} names ${parent}, which is not a story`);
      else if (items[parent].board !== item.board) out.push(`${here('board')} is ${q(item.board)} but its parent ${parent} is on ${q(items[parent].board)}; a sub-task is created in its parent's project`);
    } else if ('parent' in item) {
      out.push(`${here('parent')} is only for a defect`);
    }

    if (ledger && match(KEY, key) && TYPES.includes(item.type)) {
      const prefix = key.slice(0, key.lastIndexOf('-'));
      const blocks = ledger.blocks.filter((b) => inBlock(b, key));
      if (prefix !== ledger.prefix) {
        out.push(`${here()} has prefix ${prefix}, but the key ledger's prefix is ${ledger.prefix}`);
      } else if (item.type === 'story') {
        if (!blocks.some((b) => b.taken_by === 'decomposition' && b.slug === slug)) {
          out.push(`${here()} is in no decomposition block of the key ledger for slug ${q(slug)}`);
        }
      } else if (typeof item.parent === 'string') {
        if (!blocks.some((b) => b.taken_by === 'validation' && b.key === item.parent)) {
          out.push(`${here()} is in no validation block of the key ledger whose "key" is ${item.parent}; the ledger says which story a defect came from, and the link file must agree`);
        }
      }
    }
  }
  return out;
}

/* -------------------------------------------------------------------------------- the run */

// Every cannot-verify cause here is a file that cannot be read. The last line names it as a token
// of REASONS in scripts/spoke-remote.mjs, and `make reasons` proves the token.
const UNREADABLE = 'REASON: file-unreadable\n';

function cannot(message) {
  stderr.write(`CANNOT VERIFY: ${message}\n${UNREADABLE}`);
  process.exit(EXIT.CANNOT_VERIFY);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const filePath = args.file || DEFAULT_FILE;

  const pf = probe(filePath);
  if (pf.state === 'absent') {
    if (args.file) cannot(`no tracker file at ${safe(filePath)}`);
    stdout.write(`\nNOT CONFIGURED: no ${DEFAULT_FILE}, so this hub has no tracker. That is a valid state. Connect one with /connect-jira.\n`);
    process.exit(EXIT.PASS);
  }
  if (pf.state === 'unreadable') cannot(`${safe(filePath)} ${pf.why}; that is not the same as having no tracker`);
  if (pf.state !== 'file') cannot(`${safe(filePath)} is not a file`);

  const read = readJson(filePath);
  if (read.error) {
    stderr.write(`${read.exit === EXIT.CANNOT_VERIFY ? 'CANNOT VERIFY' : 'FAIL'}: ${read.error}\n${read.exit === EXIT.CANNOT_VERIFY ? UNREADABLE : ''}`);
    process.exit(read.exit);
  }

  stdout.write(`\ntracker connection  (${safe(filePath)})\n\n`);
  const problems = validateTrackers(read.value, filePath);
  if (problems.length) {
    stdout.write('  [FAIL] connection\n');
    for (const p of problems) stdout.write(`         - ${p}\n`);
    stdout.write(`\nNOT WELL FORMED: ${problems.length} finding(s). Links were not checked.\n`);
    process.exit(EXIT.FAIL);
  }
  stdout.write('  [PASS] connection\n');

  const linksDir = args.links || DEFAULT_LINKS;
  const pl = probe(linksDir);
  if (pl.state === 'absent') {
    if (args.links) cannot(`no links folder at ${safe(linksDir)}`);
    stdout.write(`  [SKIP] links       no ${DEFAULT_LINKS} yet\n\nWELL FORMED: the connection is well formed and no tickets are linked yet.\n`);
    process.exit(EXIT.PASS);
  }
  if (pl.state === 'unreadable') cannot(`${safe(linksDir)} ${pl.why}`);
  if (pl.state !== 'dir') cannot(`${safe(linksDir)} is not a folder`);

  let worst = EXIT.PASS;
  let findings = 0;

  const ledgerPath = args.ledger || DEFAULT_LEDGER;
  const plg = probe(ledgerPath);
  let ledger = null;
  if (plg.state === 'absent') {
    if (args.ledger) cannot(`no key ledger at ${safe(ledgerPath)}`);
  } else if (plg.state === 'unreadable') {
    cannot(`${safe(ledgerPath)} ${plg.why}`);
  } else if (plg.state !== 'file') {
    cannot(`${safe(ledgerPath)} is not a file`);
  } else {
    const l = readJson(ledgerPath);
    const ledgerProblems = l.error ? [l.error] : validateLedger(l.value, ledgerPath);
    if (ledgerProblems.length) {
      stdout.write('  [FAIL] key ledger\n');
      for (const p of ledgerProblems) stdout.write(`         - ${p}\n`);
      findings += ledgerProblems.length;
      worst = Math.max(worst, l.error && l.exit === EXIT.CANNOT_VERIFY ? EXIT.CANNOT_VERIFY : EXIT.FAIL);
    } else {
      ledger = l.value;
    }
  }

  const seen = { tickets: new Map(), keys: new Map() };
  let entries;
  try {
    entries = readdirSync(linksDir).sort();
  } catch (err) {
    cannot(`cannot list ${safe(linksDir)}: ${err.code || err.message}`);
  }
  const files = entries.filter((f) => f.endsWith('.json'));
  for (const f of entries.filter((e) => !e.endsWith('.json'))) {
    stdout.write(`  [FAIL] ${safe(f)}\n         - not a link file: link files are <SLUG>.json\n`);
    findings += 1;
    worst = Math.max(worst, EXIT.FAIL);
  }
  for (const f of files) {
    const path = join(linksDir, f);
    const l = readJson(path);
    const found = l.error ? [l.error] : validateLinks(path, l.value, read.value, ledger, seen);
    if (found.length) {
      stdout.write(`  [FAIL] ${safe(f)}\n`);
      for (const p of found) stdout.write(`         - ${p}\n`);
      findings += found.length;
      worst = Math.max(worst, l.error ? l.exit : EXIT.FAIL);
    } else {
      stdout.write(`  [PASS] ${safe(f)}\n`);
    }
  }
  if (!ledger && plg.state === 'absent') stdout.write(`  [NOTE] the key ledger ${safe(ledgerPath)} was not found, so link keys were not checked against it\n`);
  else if (!ledger) stdout.write('  [NOTE] link keys were not checked against the key ledger, which has findings of its own\n');

  stdout.write('\n');
  if (findings) {
    stdout.write(worst === EXIT.CANNOT_VERIFY
      ? `CANNOT VERIFY: ${findings} finding(s), at least one for a file that could not be read.\n${UNREADABLE}`
      : `NOT IN AGREEMENT: ${findings} finding(s). The repository wins; fix the files.\n`);
    process.exit(worst);
  }
  stdout.write(files.length === 0
    ? 'WELL FORMED: the connection is well formed and no tickets are linked yet.\n'
    : `WELL FORMED: the connection and ${files.length} link file${files.length === 1 ? '' : 's'} agree.\n`);
  process.exit(EXIT.PASS);
}

// The last line of an exit 2, 3 or 4 names this script and its code, so a shell line that hides
// the code, with a pipe or `; echo`, still tells the harness's failure record. Written at once,
// so a process.exit() never loses it.
process.on('exit', (code) => { if (code >= 2 && code <= 4) { try { writeSync(2, `HARNESS EXIT: check-trackers ${code}\n`); } catch { /* stderr is closed */ } } });

try {
  main();
} catch (err) {
  stderr.write(`INTERNAL: ${err && err.stack ? err.stack : String(err)}\n`);
  process.exit(EXIT.INTERNAL);
}

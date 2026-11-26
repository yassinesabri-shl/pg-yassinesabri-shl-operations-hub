// Part of the harness asset library c6f3b4427d58f7c3 (see VERSION.json) · 2026-09-18
/**
 * context-docs.mjs — the context documents an estate holds: where they are, what
 * header they carry, how they become index rows, and which of them a design
 * selects.
 *
 * Shared by check-context.mjs, read-context.mjs, report-context.mjs and
 * jira-sync.mjs. Not a command. It owns five things so the scripts cannot drift
 * apart. The fifth is the context report at the end of this file: the reading of
 * an artefact's `Context:` and `Hub commit:` lines against the hub's history,
 * which report-context.mjs prints and jira-sync.mjs mirrors. The first four:
 *
 *   - the kinds. Eight, each with one home and one rank in `CLAUDE.md` §4:
 *       contract, vendor-doc     the spoke folder its commands file names with
 *                                CONTRACTS_INDEX (`contracts/` by convention)  rank 2
 *       adr                      the hub's `docs/architecture/`              rank 3
 *                                or the spoke folder its commands file names with
 *                                DECISIONS_INDEX (`decisions/` by convention): the
 *                                spoke's own records, id `<repository-id>.ADR-<NNN>`
 *       standard                 the hub's `docs/standards/`                 unranked: it says how
 *       requirements-document    the hub's `docs/requirements/<slug>/requirements.md`
 *                                the document /feature wrote and a person merged; id
 *                                the slug; rank 1 when accepted, 5 when proposed
 *       requirements-source      the hub's `docs/requirements/<slug>/runs/`  rank 5
 *                                filed `<slug>/runs/<yyyymmdd_hhmm>/<file>.md`: under each
 *                                requirements document's folder, one per /feature run
 *       estate-overview          the hub's `docs/estate/overview.md`         unranked: it describes
 *                                one file, one fixed id: what the estate is, part by
 *                                part, for /feature's interview and /decompose's map
 *       exception                the global repository's `docs/exceptions/`  rank 3
 *                                the Board's approval for named hubs to depart from
 *                                named global records, id `EXC-<NNN>` in its file
 *     The global context repository holds three kinds in three flat folders, at
 *     the hub's paths: `adr` in `docs/architecture/`, `standard` in
 *     `docs/standards/` and `exception` in `docs/exceptions/`. Its files carry
 *     their ids without a prefix, and every row adds `global.`, as a spoke's
 *     record carries `<repository-id>.`: `global.ADR-012`, `global.std-go`,
 *     `global.EXC-004`. A global row is read at one commit, the one a feature's
 *     requirements record.
 *     A document in a folder must carry that folder's kind; a folder decides
 *     where, a header says what, and the two must agree. The record, standard
 *     and contract folders are flat. A requirements source is filed two levels
 *     down -- the document's slug, then the stamp of the run that copied it, the
 *     day and the minute it started -- and its id is derived from all three
 *     parts, `<slug>-<yyyymmdd>-<hhmm>-<stem>`, so two runs never share an id,
 *     even two on one day, and a run's files sit beside each other. The
 *     requirements document is one file per slug folder (`layout: 'slug-file'`),
 *     `<slug>/requirements.md`, and its id is the slug, so /feature can open the
 *     one whose index line overlaps an intent by `--names <slug>` instead of
 *     reading the corpus. Its status is derived, never typed: `accepted` when
 *     `requirements-review.md` beside it carries `### VERDICT: APPROVED` and a
 *     `Document revision:` equal to the document's blob hash -- the binding
 *     check-requirements.js enforces -- AND the trunk carries the same bytes,
 *     because a person merging the pull request is the acceptance;
 *     `proposed` otherwise. The trunk is the local ref
 *     refs/remotes/origin/<HARNESS_TRUNK, or main>, read and never fetched: a
 *     stale ref can only show a merged document as proposed, never an unmerged
 *     one as accepted. The review is peeked at for that and is nobody's
 *     document. The estate
 *     overview is one file at one path (`layout: 'file'`); nothing else in
 *     `docs/estate/` -- the list, /add-repo's drafts, the template --
 *     is read as a document. It carries `globs: []` and `alwaysApply: false`,
 *     always: /feature and /decompose read it by rule, a design that wants it
 *     names its id, and nothing puts it in every design's window. So does the
 *     requirements document, for the same reason.
 *   - the header. Every document but a requirements document opens with the
 *     same frontmatter the rule pack uses, plus four keys: `kind`, `owner` (a
 *     role), `revision` (of the original) and `origin` (where the copy came
 *     from). A decision record adds `status`, and its `name` is its number,
 *     `ADR-<NNN>`: it is a summary written for agents of a record the client
 *     keeps elsewhere, and only an Accepted one binds by glob or always-on.
 *     A standard is named by its topic, `std-<topic>`, because the client
 *     keeps no number for it; the prefix `std-` belongs to standards and no
 *     other document's id carries it. It adds `status` too -- Active, or
 *     Reserved for one held for later and read only when named -- and is a
 *     summary: its body is the template's sections in order, every rule under
 *     an id `<name>.<NN>`, every open value an UNRESOLVED line, within
 *     STANDARD_LINE_CAP lines.
 *     A requirements document is read from its title and
 *     its control table (Feature Name, in the shipped template) the same way, by the cells the
 *     requirements gate reads by name. The `description` is one sentence of at
 *     most DESCRIPTION_MAX characters, because the index prints it beside the
 *     id and a glance is the point.
 *   - the folder walk, in the hub on disk and in a spoke's bare cache at one
 *     commit, so every row says which commit it is true of. A row is the index
 *     line read-context.mjs prints for one document -- id, kind, repository,
 *     path, the blob hash of its bytes, the commit it was read at, rank, owner,
 *     revision, origin, description, globs, alwaysApply -- derived on demand
 *     and never saved. The blob hash is what a design's `Context:` entry pins,
 *     so the gate can say when a document moved after a design read it.
 *   - selection: a document binds a design when the design names its id, when a
 *     glob in its header matches a path the design's §3.1 table names, or when
 *     it is always on. A script selects. Nothing loads a document by glob. An
 *     exception carries no globs and is never always on: a design names it.
 *
 * Exit codes are the gate's, reported by the scripts that import this:
 *   0 pass · 1 verified and failed · 2 cannot verify · 3 usage · 4 internal.
 */

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { COMMIT, EXIT, GLOBAL_ID, REPO_ID, RESERVED_IDS, SpokeError, catBlobs, git, isPlaceholder, objectType, quietGitEnv, short } from './spoke-remote.mjs';
import { RULE_NAME, RULES_CITE, RULES_NONE, matchesGlobs, overrideTarget, parseChecksEnv, parseRule } from './spoke-rules.mjs';

export const CONTRACTS_INDEX_KEY = 'CONTRACTS_INDEX';
export const CONTRACTS_CONVENTION = 'contracts';
// A spoke's own decision records: the decisions only its code follows, kept in the
// spoke so that every hub of the spoke reads one copy. A record there is named
// ADR-<NNN> in its file, numbered by the spoke, and its id everywhere else is
// <repository-id>.ADR-<NNN>, so a bare ADR-<NNN> is always the hub's. A spoke
// record narrows the hub's records and never overrides one.
export const DECISIONS_INDEX_KEY = 'DECISIONS_INDEX';
export const DECISIONS_CONVENTION = 'decisions';
export const SPOKE_RECORD_ID = /^([A-Za-z0-9][A-Za-z0-9._-]*)\.(ADR-\d{3,})$/;
export const HUB_RECORD_ID = /^ADR-\d{3,}$/;
export const HUB = 'hub';
// The global layer's repository in a row, and the prefix of every global id.
export const GLOBAL = GLOBAL_ID;
export const GLOBAL_PREFIX = `${GLOBAL_ID}.`;
export const DOC_LINE_CAP = 2000;
// The index prints the description beside the id, so it is one sentence, the
// same way the repository list caps a `purpose`.
export const DESCRIPTION_MAX = 200;

export const DOC_KEYS = ['name', 'description', 'globs', 'alwaysApply', 'kind', 'owner', 'revision', 'origin'];

// The one estate overview: one file, one fixed id, so /feature, /decompose and
// a design can name it without looking it up.
export const OVERVIEW_ID = 'estate-overview';

// kind → where it lives, which scope, and its rank in CLAUDE.md §4 (null: the
// document says how or what is, and §4 ranks what decides). `layout` is flat
// unless said: 'run' files under <slug>/runs/<stamp>/,
// 'slug-file' is one document per slug folder at <folder>/<slug>/<file> with the
// slug as its id, 'file' is exactly one document at <folder>/<file> with the id `id`.
export const KINDS = {
  contract: { scope: 'spoke', rank: 2 },
  'vendor-doc': { scope: 'spoke', rank: 2 },
  adr: { scope: HUB, folder: 'docs/architecture', rank: 3 },
  standard: { scope: HUB, folder: 'docs/standards', rank: null },
  'requirements-document': { scope: HUB, folder: 'docs/requirements', layout: 'slug-file', file: 'requirements.md', rank: 1 },
  'requirements-source': { scope: HUB, folder: 'docs/requirements', layout: 'run', rank: 5 },
  'estate-overview': { scope: HUB, folder: 'docs/estate', layout: 'file', file: 'overview.md', id: OVERVIEW_ID, rank: null },
  // An exception lives only in the global repository, where only the Board
  // merges. It ranks with the records it departs from, and only an Active one.
  exception: { scope: GLOBAL, folder: 'docs/exceptions', rank: 3 },
};
// The kinds the global repository holds, each in the folder KINDS names for it.
export const GLOBAL_KINDS = ['adr', 'standard', 'exception'];
// A requirements document's rank is its status: CLAUDE.md §4 ranks the accepted
// one (on the trunk, its review beside it approving its bytes) at KINDS.rank and
// the same document not yet accepted -- on a branch, an amendment included --
// at this. Cite §4; do not restate it.
export const PROPOSED_RANK = 5;
export const REQUIREMENTS_STATUSES = ['accepted', 'proposed'];
// The cells of the control table (Feature Name, in the shipped template) this
// file reads by name -- the
// same labels check-requirements.js reads (its CONFIG.slugLabel and
// revisionLabel), so a document that passes the gate parses here.
export const REQUIREMENTS_LABELS = { revision: 'Document revision', date: 'Date', owner: 'Owning role', slug: 'Slug' };
// The review's machine surface, shared with check-requirements.js: the one
// verdict line that opens the gate, matched literally, and the line binding
// the review to the document's bytes.
export const APPROVED_VERDICT = '### VERDICT: APPROVED';
const VERDICT_LINE = /^###\s+VERDICT:\s*(.+?)\s*$/;
const REVISION_LINE = /^Document revision:[ \t]*([0-9a-fA-F]{7,40})\s*$/;
// A run folder: `<slug>/runs/<yyyymmdd_hhmm>/`. The slug is the requirements
// document's, the grammar check-requirements.js reads it with; the stamp is the day
// and the minute /feature started, so two runs on one day sit in two folders. A
// folder stamped with the day alone, `<yyyymmdd>`, is the form the library wrote
// before the minute was added; it is still read, because an earlier revision of
// the document cites the files in it and a citation into a moved file is nothing.
export const RUN_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const RUN_STAMP = /^\d{8}(?:_\d{4})?$/;
export const RUN_STAMP_FORM = 'YYYYMMDD_HHMM';
// The id a run file carries: the slug, the stamp and the file's stem, hyphenated.
// The stamp's underscore becomes a hyphen, because an id is lowercase letters,
// digits and hyphens (RULE_NAME) and nothing else.
export function runId(slug, stamp, stem) {
  return `${slug}-${stamp.replace('_', '-')}-${stem}`;
}
// A slug's folder holds the requirements document, its review and the run
// folders. The run walk passes over the first two: the document is the
// slug-file layout's to read, and the review is the requirements gate's alone --
// this file only peeks at it for the document's status.
export const RUNS_DIR = 'runs';
export const GATE_FILES = ['requirements.md', 'requirements-review.md'];
export const REVIEW_FILE = GATE_FILES[1];
export const HUB_KINDS = Object.entries(KINDS).filter(([, k]) => k.scope === HUB).map(([name]) => name);
export const SPOKE_KINDS = Object.entries(KINDS).filter(([, k]) => k.scope === 'spoke').map(([name]) => name);

export const ADR_FILE = /^(ADR-\d{3,})(?:-[a-z0-9]+(?:-[a-z0-9]+)*)?\.md$/;
// A record's id is the number it carries where the client keeps it.
export const ADR_ID = /^ADR-\d{3,}$/;
// The hub copy is of a decided record. Proposed is the draft's stage, beside
// the design that needs it; a rejected record has nothing to follow. A hub's or
// a spoke's record that a global record now states is superseded by that global
// record, named with its prefix (docs/proposals/global-context.md §11.3). A file
// in the global repository carries no prefix, so check-context --global refuses
// the second form there.
export const ADR_STATUSES = ['Accepted', 'Superseded by ADR-<NNN>', 'Superseded by global.ADR-<NNN>', 'Deprecated'];
const ADR_STATUS = /^(Accepted|Deprecated|Superseded by ((?:global\.)?ADR-\d{3,}))$/;
// The shared header plus `status`, after `kind`.
export const ADR_KEYS = [...DOC_KEYS.slice(0, 5), 'status', ...DOC_KEYS.slice(5)];

// A standard is named by its topic: `std-<topic>` in the name, the file name and
// the title. The client keeps no number for a standard, and a number the hub
// gives out lets two branches take the same one; a name two branches share is
// one path, so git stops the second. The original's own id is in `origin`. The
// prefix `std-` belongs to standards, so a design that names one names nothing
// else, and a word in a design's prose never reads as a standard's id.
export const STD_PREFIX = 'std-';
export const STD_FILE = /^(std-[a-z0-9]+(?:-[a-z0-9]+)*)\.md$/;
export const STD_ID = /^std-[a-z0-9]+(?:-[a-z0-9]+)*$/;
// The form a standard was named in before: `STD-<NNN>[-<slug>].md`. Read only to
// say how to rename it; nothing selects or cites it.
export const STD_OLD_FILE = /^STD-\d{3,}(?:-[a-z0-9]+(?:-[a-z0-9]+)*)?\.md$/;
// A standard binds by globs and always-on only when Active. A Reserved one is
// held for later -- a standard for a stack or a kind of change the estate does
// not use yet, or one not yet adopted for this estate -- and is read only by a
// design that names it, the way a record that no longer binds is. A Deprecated
// one no longer binds: its page in Confluence was superseded, rejected or
// retired (PLDC-712 R-09), and the file stays because designs cite its id.
export const STANDARD_STATUSES = ['Active', 'Reserved', 'Deprecated'];
// The shared header plus `status`, after `kind`, as a record's.
export const STD_KEYS = ADR_KEYS;
// The template's sections, every one present and in this order
// (docs/standards/_TEMPLATE.standard.md). `None.` is a section with nothing to say.
export const STANDARD_SECTIONS = ['Applies to', 'Must', 'Should', 'Values', 'Checked by', 'Relations', 'Exceptions', 'Unresolved', 'Origin'];
// A standard is a summary of rules, not a copy of a page; more than this is two standards.
export const STANDARD_LINE_CAP = 200;
// One rule: `- **<name>.<NN>** MUST ...`, the keyword the section's own.
const STD_RULE = /^-\s+\*\*(std-[a-z0-9]+(?:-[a-z0-9]+)*)\.(\d{2,})\*\*\s+(MUST NOT|MUST|SHOULD NOT|SHOULD)\s+\S/;
const RULE_KEYWORDS = { Must: ['MUST', 'MUST NOT'], Should: ['SHOULD', 'SHOULD NOT'] };
// The pinned grammar for an open decision, CLAUDE.md's Rules.
const UNRESOLVED_LINE = /^-\s+UNRESOLVED — .+\. Owner: .+\. Resolves: .+\.$/;
// The marks a source leaves on a value nobody settled. A summary carries the
// gap as an UNRESOLVED line instead, so a value is never read as agreed.
const OPEN_VALUE = /\bTBD\b|\[(?:to confirm|tbc|later)\]/i;

// An exception: the Board's approval for named hubs to depart from named global
// records, numbered EXC-<NNN> in its name, its file and its title. It carries no
// globs and no alwaysApply, because a design that departs names it.
export const EXC_FILE = /^(EXC-\d{3,})(?:-[a-z0-9]+(?:-[a-z0-9]+)*)?\.md$/;
export const EXC_ID = /^EXC-\d{3,}$/;
export const EXC_KEYS = ['name', 'description', 'kind', 'hubs', 'repositories', 'departs', 'status', 'review-by', 'owner', 'approver', 'revision', 'origin'];
// Only an Active exception has effect. A withdrawn one stays, so a design that
// cited it still resolves.
export const EXCEPTION_STATUSES = ['Active', 'Withdrawn'];
// A hub, by the prefix of the keys it mints: the key pattern without its number.
export const HUB_PREFIX = /^[A-Z][A-Z0-9]{1,9}$/;
// What an exception departs from: a global record, or one rule of a global
// standard, by the id it carries in the global repository.
export const DEPARTS_ID = /^(?:ADR-\d{3,}|std-[a-z0-9]+(?:-[a-z0-9]+)*\.\d{2,})$/;
// The sections an exception must fill. The template carries more. The Board
// cannot approve these three empty.
export const EXCEPTION_REQUIRED = ['Reason', 'Scope', 'Alternatives considered'];

// The two caps on what the global layer costs every run of every product
// (`rules/context-budget.md` § The global layer, which states the same numbers).
// The always-on cap is the bytes of every binding always-on global body, as
// read-context.mjs prints it. The index cap is the bytes of every global index
// line, as read-context.mjs prints it, each with its newline. The global
// repository's check (check-context.mjs --global) refuses a commit over either.
export const GLOBAL_ALWAYS_ON_CAP = 8 * 1024;
export const GLOBAL_INDEX_CAP = 16 * 1024;

const RELATIVE_PATH = /^(?!\/)(?!.*(^|\/)\.\.(\/|$)).+$/;

// One entry on a design's `Context:` line: the id, the first twelve characters
// of the blob hash of the bytes the design was written against, and where the
// file is -- the path for a hub document, `<repository-id>:<path>` for one kept
// in a spoke, `global:<path>` for one kept in the global repository. A global
// entry pins the first twelve characters of the global commit, not a blob. That
// commit is the one the feature's `Global:` line records, so the hub alone can
// say that the entry and the line agree. The three gates read the same grammar
// (`contextEntry` in check-dev-ready.js, check-requirements.js and
// check-decomposition.js). The four are kept in step by hand.
// A path carries no space, comma or colon, so the line splits one way;
// checkPath refuses a document whose path would not.
export const CONTEXT_PIN = 12;
export const CONTEXT_ENTRY = /^([a-z0-9][a-z0-9-]*|(?:[A-Za-z0-9][A-Za-z0-9._-]*\.)?ADR-\d{3,}|global\.(?:std-[a-z0-9]+(?:-[a-z0-9]+)*|EXC-\d{3,}))@([0-9a-f]{12}):(?:([A-Za-z0-9][A-Za-z0-9._-]*):)?((?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[^\s,:]+)$/;
const CONTEXT_PATH = /^[^\s,:]+$/;

/** A finding on the document when its path cannot stand in a `Context:` entry. */
function checkPath(doc) {
  if (!CONTEXT_PATH.test(doc.path)) {
    doc.findings.push(`${doc.path}: the path carries a space, a comma or a colon; a design's Context: line names each document by its path, so rename the file`);
  }
  return doc;
}

/* ------------------------------------------------------------ frontmatter */

/**
 * The frontmatter block and the body after it. Returns { fields: Map, body,
 * findings }. `fields` is empty when the block is missing or never closed.
 */
export function splitFrontmatter(path, text) {
  const findings = [];
  const lines = String(text).split(/\r?\n/);
  if (lines[0] !== '---') {
    findings.push(`${path}: does not open with a frontmatter line "---" on line 1`);
    return { fields: new Map(), body: String(text), findings };
  }
  const close = lines.indexOf('---', 1);
  if (close === -1) {
    findings.push(`${path}: frontmatter is never closed with a second "---"`);
    return { fields: new Map(), body: '', findings };
  }
  const fields = new Map();
  for (let i = 1; i < close; i += 1) {
    const line = lines[i];
    if (line.trim() === '') continue;
    const m = line.match(/^([A-Za-z][A-Za-z0-9_-]*):[ \t]*(.*?)\s*$/);
    if (!m) {
      findings.push(`${path}: frontmatter line ${i + 1} is not "key: value": ${JSON.stringify(line)}`);
      continue;
    }
    if (fields.has(m[1])) {
      findings.push(`${path}: frontmatter key "${m[1]}" appears twice`);
      continue;
    }
    fields.set(m[1], m[2]);
  }
  return { fields, body: lines.slice(close + 1).join('\n'), findings };
}

/* ----------------------------------------------------------- one document */

/**
 * Parse a headered context document -- every kind but the requirements document. `expectKinds` is
 * the set the folder allows. Returns the document with its findings; a
 * document with findings is malformed and is not a row.
 */
export function parseDocument(path, text, expectKinds) {
  const { fields, body, findings } = splitFrontmatter(path, text);
  const at = (m) => findings.push(`${path}: ${m}`);
  const doc = { path, name: null, description: null, globs: [], alwaysApply: null, kind: null, owner: null, revision: null, origin: null, body, findings };
  if (fields.size === 0 && findings.length) return doc;

  const isAdr = fields.get('kind') === 'adr';
  const isException = fields.get('kind') === 'exception';
  const keys = isAdr ? ADR_KEYS : fields.get('kind') === 'standard' ? STD_KEYS : isException ? EXC_KEYS : DOC_KEYS;
  for (const key of fields.keys()) {
    if (!keys.includes(key)) at(`frontmatter key "${key}" is not one of ${keys.join(', ')}`);
  }
  for (const key of keys) {
    if (!fields.has(key)) at(`frontmatter is missing "${key}"`);
  }
  const value = (k) => (fields.has(k) ? fields.get(k) : null);

  const name = value('name');
  if (name !== null) {
    if (isAdr) {
      if (!ADR_ID.test(name)) at(`name "${name}" must be ADR-<NNN>, the number the record carries where it is kept`);
    } else if (fields.get('kind') === 'standard') {
      if (!name.match(STD_ID)) at(`name "${name}" must be std-<topic> (lowercase letters, digits and hyphens), the name the file and the title carry`);
    } else if (isException) {
      if (!name.match(EXC_ID)) at(`name "${name}" must be EXC-<NNN>, the number the exception carries in its file and its title`);
    } else if (!RULE_NAME.test(name)) at(`name "${name}" must be lowercase letters, digits and hyphens; it is the id a design names`);
    else if (name.startsWith(STD_PREFIX)) at(reservedPrefix(name));
    doc.name = name;
  }
  for (const key of ['description', 'owner', 'revision', 'origin']) {
    const v = value(key);
    if (v === null) continue;
    if (isPlaceholder(v)) at(`${key} is empty or a placeholder (${JSON.stringify(v)}); write the value or do not add the document`);
    else if (key === 'description' && v.length > DESCRIPTION_MAX) at(`description is ${v.length} characters; the cap is ${DESCRIPTION_MAX}. A description says what the document is in one sentence, because the index prints it`);
    doc[key] = v;
  }
  const globs = value('globs');
  if (globs !== null) {
    let parsed;
    try {
      parsed = JSON.parse(globs);
    } catch {
      parsed = undefined;
    }
    if (!Array.isArray(parsed) || parsed.some((g) => typeof g !== 'string' || g.trim() === '')) {
      at(`globs must be a one-line JSON array of strings (empty for a document selected by name only), got ${JSON.stringify(globs)}`);
    } else {
      doc.globs = parsed;
    }
  }
  const always = value('alwaysApply');
  if (always !== null) {
    if (always !== 'true' && always !== 'false') at(`alwaysApply must be the literal true or false, got ${JSON.stringify(always)}`);
    else doc.alwaysApply = always === 'true';
  }
  const kind = value('kind');
  if (kind !== null) {
    if (!(kind in KINDS)) at(`kind "${kind}" is not one of ${Object.keys(KINDS).join(', ')}`);
    else if (!expectKinds.includes(kind)) at(`kind "${kind}" does not live in this folder; this folder holds ${expectKinds.join(' or ')} and ${article(kind)} ${kind} lives in ${homeOf(kind)}`);
    doc.kind = kind;
  }
  if (doc.kind === 'estate-overview') {
    // The overview orients the interview and the planner, who read it by rule; a
    // design that wants it names its id. Globs or always-on would put one page
    // about the whole estate into every design's window.
    if (doc.globs.length) at('an estate overview carries globs: [] -- /feature and /decompose read it by rule, and a design that wants it names its id');
    if (doc.alwaysApply === true) at('an estate overview is never alwaysApply: true -- always on is every design, forever, in the window, and the overview orients the interview and the planner instead');
  }
  if (doc.kind === 'adr') checkAdr(doc, value('status'), body, at);
  if (doc.kind === 'exception') {
    doc.alwaysApply = false;
    checkException(doc, value, body, at);
  }
  if (!body.split('\n').some((l) => l.trim() !== '')) at('has no body after the frontmatter; a header alone is a row about nothing');
  const lineCount = String(text).split(/\r?\n/).length;
  if (doc.kind === 'standard') {
    const status = value('status');
    doc.status = STANDARD_STATUSES.includes(status) ? status : null;
    if (status !== null && doc.status === null) at(`status ${JSON.stringify(status)} is not one of ${STANDARD_STATUSES.join(', ')}; a Reserved standard is read only by a design that names it, an Active one binds by its globs, and a Deprecated one binds nothing`);
    checkStandard(doc, body, at);
    if (lineCount > STANDARD_LINE_CAP) at(`is ${lineCount} lines; the cap for a standard is ${STANDARD_LINE_CAP}. A standard is a summary of rules; one that needs more is two standards`);
  } else if (lineCount > DOC_LINE_CAP) at(`is ${lineCount} lines; the cap is ${DOC_LINE_CAP}. Split the document, or keep the machine form beside it and copy only the prose`);
  return doc;
}

function homeOf(kind) {
  const k = KINDS[kind];
  if (k.scope === GLOBAL) return `the global repository's ${k.folder}/`;
  if (kind === 'adr') return `the hub's ${k.folder}/, or the spoke folder ${DECISIONS_INDEX_KEY} names (${DECISIONS_CONVENTION}/ by convention)`;
  if (k.scope !== HUB) return `the spoke folder CONTRACTS_INDEX names (${CONTRACTS_CONVENTION}/ by convention)`;
  if (k.layout === 'run') return `the hub's ${k.folder}/<slug>/${RUNS_DIR}/<yyyymmdd_hhmm>/`;
  if (k.layout === 'slug-file') return `the hub's ${k.folder}/<slug>/${k.file}`;
  if (k.layout === 'file') return `the hub's ${k.folder}/${k.file}`;
  return `the hub's ${k.folder}/`;
}

/** The finding for an id that takes the prefix standards own. */
function reservedPrefix(id) {
  return `id "${id}" starts with "${STD_PREFIX}", which names a standard; give this document an id that does not`;
}

const article = (word) => (/^[aeiou]/.test(word) ? 'an' : 'a');

/**
 * The rules a decision record adds to the shared header: a status from
 * ADR_STATUSES, and one number in the name, the file name and the title.
 */
function checkAdr(doc, status, body, at) {
  doc.status = null;
  doc.supersedes = null;
  // The decision as the title states it. report-global.mjs compares a hub
  // record's with a global record's, word for word.
  doc.title = null;
  const file = doc.path.split('/').pop().match(ADR_FILE);
  if (doc.name !== null && file && file[1] !== doc.name) at(`name is ${doc.name} and the file is ${file[1]}; one record, one number`);
  if (status !== null) {
    const s = status.match(ADR_STATUS);
    if (status === 'Superseded') at('a superseded record names the record that replaced it: "Superseded by ADR-<NNN>", or "Superseded by global.ADR-<NNN>" for a global record');
    else if (!s) at(`status ${JSON.stringify(status)} is not one of ${ADR_STATUSES.join(', ')}; a proposed record is a draft beside its design, and a rejected one binds nothing`);
    else {
      doc.status = s[2] ? 'Superseded' : s[1];
      doc.supersedes = s[2] || null;
      const own = doc.name !== null ? doc.name : file ? file[1] : null;
      if (s[2] && own !== null && s[2] === own) at('a record cannot supersede itself');
    }
  }
  const title = maskFences(stripHtmlComments(body).split(/\r?\n/)).find((l) => /^#\s/.test(l));
  if (!title) {
    at('has no title line; the template opens with "# ADR-<NNN>: <the decision>"');
    return;
  }
  const t = title.match(/^#\s+(ADR-\d{3,}):\s*(.+?)\s*$/);
  if (!t) at(`title ${JSON.stringify(title)} is not "# ADR-<NNN>: <the decision>"`);
  else if (doc.name !== null && t[1] !== doc.name) at(`title names ${t[1]} and the name is ${doc.name}; one record, one number`);
  else if (isPlaceholder(t[2])) at('title carries a placeholder instead of the decision');
  else doc.title = t[2];
}

/**
 * The rules an exception adds: its own header (EXC_KEYS), one number in the
 * name, the file name and the title, and the sections the Board cannot approve
 * empty. Whether each departed id exists is a question about the whole global
 * repository, not about one file. The global repository's own check asks it.
 */
function checkException(doc, value, body, at) {
  doc.status = null;
  doc.reviewBy = null;
  const list = (key, problem, hint) => {
    const v = value(key);
    if (v === null) return [];
    let parsed;
    try {
      parsed = JSON.parse(v);
    } catch {
      parsed = undefined;
    }
    if (!Array.isArray(parsed) || !parsed.length || parsed.some((x) => typeof x !== 'string')) {
      at(`${key} must be a one-line JSON array of one or more strings, got ${JSON.stringify(v)}`);
      return [];
    }
    for (const x of parsed) {
      const wrong = problem(x);
      if (wrong) at(`${key}: ${JSON.stringify(x)} ${wrong}. ${hint}`);
    }
    const repeated = [...new Set(parsed.filter((x, i) => parsed.indexOf(x) !== i))];
    if (repeated.length) at(`${key} names ${repeated.map((x) => JSON.stringify(x)).join(', ')} more than once`);
    return parsed;
  };
  doc.hubs = list('hubs', (x) => (x.match(HUB_PREFIX) ? null : 'is not a key prefix'), 'A hub is named by the prefix of the keys it mints, as in its docs/backlog/keys.json');
  doc.repositories = list('repositories', (x) => (!x.match(REPO_ID) ? 'is not a repository id' : RESERVED_IDS.includes(x) ? 'is a reserved id' : null), 'A repository is named by its bare name, as a hub lists it in docs/estate/repositories.json');
  doc.departs = list('departs', (x) => (x.match(DEPARTS_ID) ? null : 'is not a record or a standard rule'), 'An exception departs from a global record, ADR-<NNN>, or from one rule of a global standard, std-<topic>.<NN>, by the id it carries in the global repository');
  const status = value('status');
  if (status !== null) {
    if (EXCEPTION_STATUSES.includes(status)) doc.status = status;
    else at(`status ${JSON.stringify(status)} is not one of ${EXCEPTION_STATUSES.join(', ')}. Only an Active exception has effect`);
  }
  const reviewBy = value('review-by');
  if (reviewBy !== null) {
    const day = reviewBy.match(/^\d{4}-\d{2}-\d{2}$/) ? new Date(`${reviewBy}T00:00:00Z`) : null;
    if (day === null || Number.isNaN(day.getTime()) || day.toISOString().slice(0, 10) !== reviewBy) at(`review-by ${JSON.stringify(reviewBy)} is not a date (YYYY-MM-DD)`);
    else doc.reviewBy = reviewBy;
  }
  const approver = value('approver');
  if (approver !== null && isPlaceholder(approver)) at(`approver is empty or a placeholder (${JSON.stringify(approver)}). Write the body that approved the exception`);
  const file = doc.path.split('/').pop().match(EXC_FILE);
  if (!file) at('is not an exception file (EXC-<NNN>[-<slug>].md). An exception is named by its number');
  else if (doc.name !== null && file[1] !== doc.name) at(`name is ${doc.name} and the file is ${file[1]}. One exception carries one number`);

  const lines = maskFences(stripHtmlComments(body).split(/\r?\n/));
  const title = lines.find((l) => l.search(/^#\s/) === 0);
  const t = title ? title.match(/^#\s+(EXC-\d{3,})\s+—\s+(.+?)\s*$/) : null;
  if (!title) at('has no title line. The template opens with "# EXC-<NNN> — <the departure>"');
  else if (!t) at(`title ${JSON.stringify(title)} is not "# EXC-<NNN> — <the departure>"`);
  else if (doc.name !== null && t[1] !== doc.name) at(`title names ${t[1]} and the name is ${doc.name}. One exception carries one number`);
  else if (isPlaceholder(t[2])) at('title carries a placeholder instead of the departure');

  // Each `## ` heading opens a section, and its lines run to the next heading.
  const sections = new Map();
  let current = null;
  for (const line of lines) {
    const h = line.match(/^##\s+(.+?)\s*$/);
    if (h) {
      current = h[1];
      if (!sections.has(current)) sections.set(current, []);
    } else if (current !== null && !line.startsWith('#')) sections.get(current).push(line);
  }
  for (const name of EXCEPTION_REQUIRED) {
    const content = (sections.get(name) || []).join('\n').trim();
    if (!sections.has(name)) at(`has no "## ${name}" section, and the Board cannot approve an exception without one`);
    else if (content === '' || isPlaceholder(content)) at(`section "${name}" is empty or a placeholder, and the Board cannot approve an exception without it`);
    else if (content.split('\n').some((l) => l.search(/^\s*(?:-\s+)?UNRESOLVED\b/) !== -1)) at(`section "${name}" carries an UNRESOLVED line. An exception states its ${name.toLowerCase()} and does not leave it open`);
  }
}

/**
 * The rules a standard adds to the shared header: one name in the name, the
 * file name and the title, and the template's shape -- every section once and
 * in order, each rule under an id of the standard's own name, every open
 * value an UNRESOLVED line. A body in any other shape is a copy, not a summary.
 */
function checkStandard(doc, body, at) {
  const file = doc.path.split('/').pop().match(STD_FILE);
  if (doc.name !== null && file && file[1] !== doc.name) at(`name is ${doc.name} and the file is ${file[1]}; one standard, one name`);
  const own = doc.name !== null && doc.name.match(STD_ID) ? doc.name : file ? file[1] : null;
  const lines = maskFences(stripHtmlComments(body).split(/\r?\n/));
  const first = lines.findIndex((l) => l.trim() !== '');
  const title = first === -1 ? '' : lines[first];
  const t = title.match(/^#\s+(std-[a-z0-9]+(?:-[a-z0-9]+)*):\s*(.+?)\s*$/);
  if (!t) {
    at(`the body opens with ${JSON.stringify(title)}, not the title "# <name>: <the topic>"; a standard is written from docs/standards/_TEMPLATE.standard.md -- rewrite it with /add-context --kind standard`);
    return;
  }
  if (own !== null && t[1] !== own) at(`title names ${t[1]} and the name is ${own}; one standard, one name`);
  if (isPlaceholder(t[2])) at('title carries a placeholder instead of the topic');

  // Each `## ` heading opens a section; nothing but the template's, in its order.
  const sections = [];
  lines.forEach((line, i) => {
    if (i <= first) return;
    const h = line.match(/^#{1,6}\s+(.+?)\s*$/);
    if (h && line.startsWith('## ')) sections.push({ name: h[1], from: i + 1, lines: [] });
    else if (h) at(`line ${i + 1}: heading ${JSON.stringify(line)} is not one of the template's sections; a standard has ${STANDARD_SECTIONS.length} sections and no others`);
    else if (sections.length) sections[sections.length - 1].lines.push({ text: line, no: i + 1 });
    else if (line.trim() !== '') at(`line ${i + 1}: text between the title and "## ${STANDARD_SECTIONS[0]}"; every line of a standard sits in a section`);
  });
  const names = sections.map((s) => s.name);
  if (names.join('\n') !== STANDARD_SECTIONS.join('\n')) {
    const missing = STANDARD_SECTIONS.filter((s) => !names.includes(s));
    const extra = names.filter((s) => !STANDARD_SECTIONS.includes(s));
    const parts = [];
    if (missing.length) parts.push(`missing ${missing.map((s) => `"${s}"`).join(', ')}`);
    if (extra.length) parts.push(`not the template's: ${extra.map((s) => `"${s}"`).join(', ')}`);
    if (!parts.length) parts.push(`in the order ${names.map((s) => `"${s}"`).join(', ')}`);
    at(`sections are ${parts.join('; ')}; a standard carries ${STANDARD_SECTIONS.map((s) => `"${s}"`).join(', ')}, once each and in that order`);
  }

  const ids = new Map();
  let rules = 0;
  for (const s of sections) {
    const content = s.lines.filter((l) => l.text.trim() !== '');
    if (!content.length) {
      at(`section "${s.name}" (line ${s.from}) is empty; write "None." where there is nothing, so nothing is told from forgotten`);
      continue;
    }
    if (content.length === 1 && content[0].text.trim() === 'None.') continue;
    // An open value is said once, as an UNRESOLVED line; the sections that state
    // what holds never carry one.
    if (s.name !== 'Unresolved' && s.name !== 'Origin') {
      for (const l of content) {
        const open = l.text.match(OPEN_VALUE);
        if (open) at(`line ${l.no}: "${open[0]}" marks a value nobody settled; write it as an UNRESOLVED line under "## Unresolved", never as a rule`);
      }
    }
    if (RULE_KEYWORDS[s.name]) {
      for (const l of content.filter((c) => c.text.startsWith('- '))) {
        const r = l.text.match(STD_RULE);
        if (!r) {
          at(`line ${l.no}: a rule under "${s.name}" opens "- **<name>.<NN>** ${RULE_KEYWORDS[s.name].join(' | ')} ..."`);
          continue;
        }
        rules += 1;
        const id = `${r[1]}.${r[2]}`;
        if (ids.has(id)) at(`line ${l.no}: rule ${id} is also line ${ids.get(id)}; a rule id names one rule`);
        else ids.set(id, l.no);
        if (own !== null && r[1] !== own) at(`line ${l.no}: rule ${id} carries another standard's name; its rules are ${own}.<NN>`);
        if (!RULE_KEYWORDS[s.name].includes(r[3])) at(`line ${l.no}: ${r[3]} belongs under "${s.name === 'Must' ? 'Should' : 'Must'}", not "${s.name}"`);
      }
    }
    if (s.name === 'Unresolved') {
      for (const l of content.filter((c) => c.text.startsWith('- '))) {
        if (!l.text.trim().match(UNRESOLVED_LINE)) at(`line ${l.no}: an open point is "- UNRESOLVED — <what>. Owner: <role>. Resolves: <trigger>."`);
      }
    }
  }
  if (sections.length && !rules) at('carries no rule under "Must" or "Should"; a document with no rule is not a standard');
  // The rule ids, so the global repository's check can prove that an exception
  // departs from a rule the standard defines.
  doc.rules = [...ids.keys()];
}

function stripHtmlComments(text) {
  return text.replace(/<!--[\s\S]*?-->/g, (c) => c.replace(/[^\n]/g, ''));
}

// The same lines with every fenced code block -- its fence lines and what is
// between them -- made empty, so line numbers hold and nothing inside a fence
// reads as a title, a table row or a name. The requirements gate's
// maskNonContent is the fuller rule; this is the part the index needs.
function maskFences(lines) {
  let fence = null;
  return lines.map((line) => {
    const open = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (fence) {
      if (open && open[1][0] === fence[0] && open[1].length >= fence.length) fence = null;
      return '';
    }
    if (open) {
      fence = open[1];
      return '';
    }
    return line;
  });
}

// A table row's cells, read the way check-requirements.js reads one: the rule
// lives in that file's splitRow, and this is a copy so a cell that passes the
// gate reads the same here. Invisible characters are dropped, an escaped pipe
// stays a pipe, and a line that is not `| … |` is not a row.
const INVISIBLE = /[\u200B-\u200F\u202A-\u202E\u2060\uFEFF\u00AD]/g;
export function splitRow(line) {
  const trimmed = String(line).replace(INVISIBLE, '').trim();
  if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) return null;
  if (/(?:^|[^\\])(?:\\\\)*\\$/.test(trimmed.slice(0, -1))) return null;
  return trimmed
    .slice(1, -1)
    .split(/(?<!\\)\|/)
    .map((c) => c.trim().replace(/\\\|/g, '|'));
}

/**
 * The git blob hash of a file's bytes -- the value `git hash-object` prints and
 * the one a review's `Document revision:` line names -- without calling git.
 */
export function blobHash(bytes) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(String(bytes), 'utf8');
  return createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');
}

/**
 * The trunk a requirements document is accepted on: the local remote-tracking
 * ref of the hub's trunk, HARNESS_TRUNK or main, as check-requirements.js names
 * it. Read, never fetched -- the index reads the working directory and reaches
 * nothing.
 */
export const trunkRef = () => `refs/remotes/origin/${process.env.HARNESS_TRUNK || 'main'}`;

/**
 * The blob hash of `path` on the trunk, from the hub at `root`: `{ ref, readable,
 * blob }`, where `readable` is false when there is no git repository or no such
 * ref, and `blob` is null when the ref has no file at that path.
 */
export function trunkBlob(root, path, ref = trunkRef()) {
  const ask = (spec) => {
    try {
      return git(['rev-parse', '--verify', '--quiet', spec], { cwd: root, env: quietGitEnv() }).trim() || null;
    } catch (err) {
      return null;
    }
  };
  if (ask(`${ref}^{commit}`) === null) return { ref, readable: false, blob: null };
  return { ref, readable: true, blob: ask(`${ref}:${path}`) };
}

/**
 * A requirements document's status from the review beside it and the trunk:
 * `accepted` when the review carries exactly one verdict line and it is the
 * approved token, and exactly one `Document revision:` line naming these bytes
 * -- the binding checkReview and checkReviewRevision in check-requirements.js
 * enforce -- and the trunk carries these same bytes, because the merge is the
 * acceptance; `proposed` otherwise, with the reason in one clause. `trunk` is
 * what trunkBlob returns. A review that fails here is the gate's failure, never
 * this file's finding.
 */
export function reviewStatus(reviewText, actual, trunk) {
  const proposed = (reason) => ({ status: 'proposed', reason });
  if (reviewText === null) return proposed(`no ${REVIEW_FILE} beside it`);
  const lines = String(reviewText).split(/\r?\n/);
  const verdicts = lines.filter((l) => VERDICT_LINE.test(l));
  if (verdicts.length !== 1) return proposed(`${REVIEW_FILE} carries ${verdicts.length} verdict lines, not one`);
  if (verdicts[0].trimEnd() !== APPROVED_VERDICT) return proposed(`${REVIEW_FILE} says "${verdicts[0].trim()}", not "${APPROVED_VERDICT}"`);
  const revisions = lines.map((l) => l.match(REVISION_LINE)).filter(Boolean).map((m) => m[1].toLowerCase());
  if (revisions.length !== 1) return proposed(`${REVIEW_FILE} carries ${revisions.length} "Document revision:" lines, not one`);
  if (!actual.startsWith(revisions[0])) return proposed(`${REVIEW_FILE} approves revision ${short(revisions[0])} and the document is ${short(actual)}; it changed after it was reviewed`);
  if (!trunk.readable) return proposed(`approved, but ${trunk.ref} could not be read, so it is not shown as merged`);
  if (trunk.blob === null) return proposed(`approved, not merged: ${trunk.ref} has no copy of it`);
  if (trunk.blob !== actual) return proposed(`approved, not merged: ${trunk.ref} has ${short(trunk.blob)} and this is ${short(actual)}`);
  return { status: 'accepted', reason: `${REVIEW_FILE} approves its bytes (${short(actual)}) and ${trunk.ref} carries them` };
}

/**
 * Parse the requirements document /feature wrote and a person merged -- or one
 * still on its pull request's branch, which reads `proposed` --
 * `docs/requirements/<slug>/requirements.md`. It carries no header: the title
 * and the control table (Feature Name, in the shipped template) are read by the
 * labels the requirements
 * gate reads by name (REQUIREMENTS_LABELS), and the status is derived from the
 * review beside it. `bytes` is the document as a Buffer, because the status
 * compares the review's `Document revision:` with the blob hash of exactly
 * those bytes; `reviewText` is the review's text, or null when there is none;
 * `trunk` is trunkBlob's answer for the document's path. The id is the slug,
 * the folder the document is filed under.
 */
export function parseRequirementsDocument(path, bytes, slug, reviewText, trunk) {
  const findings = [];
  const at = (m) => findings.push(`${path}: ${m}`);
  const text = Buffer.from(bytes).toString('utf8');
  const doc = {
    path, name: slug, kind: 'requirements-document', description: null, owner: null, revision: null, origin: '/feature',
    status: null, statusReason: null, globs: [], alwaysApply: false, body: text, findings,
  };
  if (slug.startsWith(STD_PREFIX)) at(reservedPrefix(slug));
  const labels = REQUIREMENTS_LABELS;
  const lines = maskFences(stripHtmlComments(text).split(/\r?\n/));

  const title = lines.find((l) => /^#\s/.test(l));
  if (!title) {
    at('has no title line; the template opens with "# <Feature name>: <what must become true>"');
  } else {
    const value = title.replace(/^#\s+/, '').replace(/^Requirements\s*[—–:-]\s*/i, '').trim();
    if (value === '' || isPlaceholder(value)) at('title carries a placeholder instead of what must become true');
    // The title is the organisation's, so a long one is cut for the index, not refused.
    else doc.description = value.length > DESCRIPTION_MAX ? `${value.slice(0, DESCRIPTION_MAX - 1)}…` : value;
  }

  // The control table by label: the first row wins for a value, and every Slug row
  // is compared whole, backticks removed, as checkSlugRow does.
  const cells = new Map();
  const slugRows = [];
  lines.forEach((line, i) => {
    const row = splitRow(line);
    if (!row || row.length < 2) return;
    if (row[0] === labels.slug) slugRows.push({ no: i + 1, cell: row[1] });
    else if (!cells.has(row[0])) cells.set(row[0], row[1]);
  });
  const owner = cells.get(labels.owner);
  if (owner === undefined) at(`has no "| ${labels.owner} | <role> |" row in its control table; the index prints the owner beside the id`);
  else if (isPlaceholder(owner)) at(`${labels.owner} is a placeholder (${JSON.stringify(owner)}); write the role accountable for the document`);
  else doc.owner = owner;
  const revision = cells.get(labels.revision);
  if (revision === undefined) at(`has no "| ${labels.revision} | r<n> |" row in its control table`);
  else if (isPlaceholder(revision)) at(`${labels.revision} is a placeholder (${JSON.stringify(revision)})`);
  const date = cells.get(labels.date);
  if (date === undefined) at(`has no "| ${labels.date} | YYYY-MM-DD |" row in its control table`);
  else if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) at(`${labels.date} ${JSON.stringify(date)} is not a date (YYYY-MM-DD)`);
  if (revision !== undefined && !isPlaceholder(revision) && date !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(date)) doc.revision = `${revision}, ${date}`;
  for (const row of slugRows) {
    const value = row.cell.replace(/^`|`$/g, '');
    if (value !== slug) at(`line ${row.no} has "${row.cell}" in the ${labels.slug} cell; expected "| ${labels.slug} | \`${slug}\` |" and nothing else in the cell -- the document is filed under "${slug}", and check-requirements.js reads the cell the same way`);
  }

  const status = reviewStatus(reviewText, blobHash(bytes), trunk);
  doc.status = status.status;
  doc.statusReason = status.reason;
  return doc;
}

/* -------------------------------------------------------------- index rows */

/** One derived index row for a parsed document. */
export function toRow(doc, { repository, commit }) {
  const kindOf = KINDS[doc.kind];
  if (doc.kind === 'adr') {
    // Only an Accepted record ranks; selectRows reads the status the same way. A
    // spoke's record carries the spoke in its id, and so does the record that
    // superseded it, which is the spoke's too, unless a global record superseded
    // it: that id already carries its layer.
    const own = (id) => (id === null || repository === HUB || id.startsWith(GLOBAL_PREFIX) ? id : `${repository}.${id}`);
    return {
      id: own(doc.name),
      kind: 'adr',
      repository,
      path: doc.path,
      blob: doc.blob,
      commit,
      rank: doc.status === 'Accepted' ? kindOf.rank : null,
      status: doc.supersedes ? `Superseded by ${own(doc.supersedes)}` : doc.status,
      owner: doc.owner,
      revision: doc.revision,
      origin: doc.origin,
      description: doc.description,
      globs: doc.globs,
      alwaysApply: doc.alwaysApply,
    };
  }
  if (doc.kind === 'exception') {
    // Only an Active exception ranks. selectRows reads the status the same way.
    // The ids it departs from are global ids, as the row's own id is.
    return {
      id: `${GLOBAL_PREFIX}${doc.name}`,
      kind: doc.kind,
      repository,
      path: doc.path,
      blob: doc.blob,
      commit,
      rank: doc.status === 'Active' ? kindOf.rank : null,
      status: doc.status,
      hubs: doc.hubs,
      repositories: doc.repositories,
      departs: doc.departs.map((d) => `${GLOBAL_PREFIX}${d}`),
      reviewBy: doc.reviewBy,
      owner: doc.owner,
      revision: doc.revision,
      origin: doc.origin,
      description: doc.description,
      globs: [],
      alwaysApply: false,
    };
  }
  if (doc.kind === 'requirements-document') {
    // Rank is status, the two rows of CLAUDE.md §4: accepted, or not yet.
    return {
      id: doc.name,
      kind: doc.kind,
      repository,
      path: doc.path,
      blob: doc.blob,
      commit,
      rank: doc.status === 'accepted' ? kindOf.rank : PROPOSED_RANK,
      status: doc.status,
      owner: doc.owner,
      revision: doc.revision,
      origin: doc.origin,
      description: doc.description,
      globs: [],
      alwaysApply: false,
    };
  }
  return {
    id: repository === GLOBAL ? `${GLOBAL_PREFIX}${doc.name}` : doc.name,
    kind: doc.kind,
    repository,
    path: doc.path,
    blob: doc.blob,
    commit,
    rank: kindOf.rank,
    // A standard's rule ids, as a design cites them, so a spoke rule's
    // `overrides` can be proved against the rules the standard defines.
    ...(doc.kind === 'standard' ? { status: doc.status, rules: (doc.rules || []).map((r) => (repository === GLOBAL ? `${GLOBAL_PREFIX}${r}` : r)) } : {}),
    owner: doc.owner,
    revision: doc.revision,
    origin: doc.origin,
    description: doc.description,
    globs: doc.globs,
    alwaysApply: doc.alwaysApply,
  };
}

/**
 * Global rows first, then the hub's, then repositories by id -- the order of
 * precedence -- and within one, by path.
 */
export function sortRows(rows) {
  const layer = (r) => (r.repository === GLOBAL ? 0 : r.repository === HUB ? 1 : 2);
  return [...rows].sort((a, b) => {
    if (layer(a) !== layer(b)) return layer(a) - layer(b);
    const ra = a.repository;
    const rb = b.repository;
    if (ra !== rb) return ra < rb ? -1 : 1;
    return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
  });
}

/* ---------------------------------------------------------------- the hub */

/**
 * Walk the hub's document folders on disk. Returns { documents, findings,
 * folders, kinds } where `folders` says how many files each folder held and
 * `kinds` how many of each kind were read -- two kinds share
 * `docs/requirements`, and the count line says which is which. Templates
 * (`_TEMPLATE.*`), `README.md` and dotfiles are skipped; every other `.md` file
 * must parse as its folder's kind. The record and standard folders are flat. The
 * requirements documents are one per slug folder, `<slug>/requirements.md`
 * (`layout: 'slug-file'`), read with the review beside them peeked at for the
 * status; the requirements sources are filed `<slug>/runs/<yyyymmdd_hhmm>/<file>.md`
 * (`layout: 'run'`), and that walk passes over the document and its review and
 * reports the folder's shape -- a `.md` file anywhere else under that folder is
 * a finding, never a row. The estate overview is one file at one path (`layout:
 * 'file'`): it is read when present, with its fixed id, and nothing else in its
 * folder is looked at -- `docs/estate/` is the estate's folder, not a document
 * folder.
 */
export function scanHub(root) {
  const documents = [];
  const findings = [];
  const folders = {};
  const kinds = {};
  for (const [kind, k] of Object.entries(KINDS)) {
    if (k.scope !== HUB) continue;
    const abs = join(root, k.folder);
    if (!(k.folder in folders)) folders[k.folder] = 0;
    kinds[kind] = 0;
    if (!existsSync(abs) || !statSync(abs).isDirectory()) continue;
    const listing = (dir) => readdirSync(dir).sort().filter((n) => !(n.startsWith('.') || n.startsWith('_TEMPLATE.') || n === 'README.md'));
    const read = (rel, file, expect) => {
      const name = rel.split('/').pop();
      folders[k.folder] += 1;
      kinds[kind] += 1;
      const bytes = readFileSync(file);
      const text = bytes.toString('utf8');
      if (kind === 'adr' && !ADR_FILE.test(name)) {
        findings.push(`${rel}: is not a decision record file (ADR-<NNN>[-<slug>].md) and not the template; the records folder holds records`);
        return;
      }
      if (kind === 'standard' && name.match(STD_OLD_FILE)) {
        findings.push(`${rel}: names a standard by number, the form before standards were named std-<topic>; rename it with /add-context --rename-standards`);
        return;
      }
      if (kind === 'standard' && !name.match(STD_FILE)) {
        findings.push(`${rel}: is not a standard file (std-<topic>.md) and not the template; a standard is a summary written from docs/standards/_TEMPLATE.standard.md -- re-ingest it with /add-context --kind standard`);
        return;
      }
      const doc = parseDocument(rel, text, [kind]);
      doc.blob = blobHash(bytes);
      checkPath(doc);
      if (expect && doc.name !== null && doc.name !== expect.id) {
        doc.findings.push(`${rel}: id "${doc.name}" must be "${expect.id}" -- ${expect.reason}`);
      }
      const hint = kind === 'adr' && text.split(/\r?\n/)[0] !== '---' ? ' -- a decision record is now a summary for agents; rewrite it with /add-context --kind adr' : '';
      findings.push(...doc.findings.map((f) => (hint && f.includes('does not open with a frontmatter line') ? f + hint : f)));
      if (!doc.findings.length) documents.push(doc);
    };
    if (k.layout === 'file') {
      // One document at one path, present or not. The list, the drafts folder
      // and the template sit beside it and are none of this walk's business.
      const file = join(abs, k.file);
      if (existsSync(file) && statSync(file).isFile()) {
        read(`${k.folder}/${k.file}`, file, { id: k.id, reason: `one ${kind}, one fixed id, so /feature, /decompose and a design can name it` });
      }
      continue;
    }
    if (k.layout === 'slug-file') {
      // One document per slug folder, <folder>/<slug>/<file>, its id the slug.
      // The folder's shape -- a loose file, a name that is not a slug, a stray
      // entry beside the document -- is the run layout's to report, once; this
      // walk reads the document where the shape allows one and nothing else.
      for (const slug of listing(abs)) {
        const slugDir = join(abs, slug);
        if (!statSync(slugDir).isDirectory() || !RUN_SLUG.test(slug)) continue;
        const file = join(slugDir, k.file);
        if (!existsSync(file) || !statSync(file).isFile()) continue;
        const review = join(slugDir, REVIEW_FILE);
        const reviewText = existsSync(review) && statSync(review).isFile() ? readFileSync(review, 'utf8') : null;
        folders[k.folder] += 1;
        kinds[kind] += 1;
        const bytes = readFileSync(file);
        const rel = `${k.folder}/${slug}/${k.file}`;
        const doc = parseRequirementsDocument(rel, bytes, slug, reviewText, trunkBlob(root, rel));
        doc.blob = blobHash(bytes);
        checkPath(doc);
        findings.push(...doc.findings);
        if (!doc.findings.length) documents.push(doc);
      }
      continue;
    }
    if (k.layout !== 'run') {
      for (const name of listing(abs)) {
        const file = join(abs, name);
        if (statSync(file).isDirectory()) {
          findings.push(`${k.folder}/${name}: is a folder; the document folders are flat`);
          continue;
        }
        if (!name.endsWith('.md')) continue;
        read(`${k.folder}/${name}`, file);
      }
      continue;
    }
    // layout 'run': <folder>/<slug>/runs/<yyyymmdd_hhmm>/<file>.md. The slug folder
    // also holds the requirements document and its review, which are the gate's
    // to read; anything else beside them is a finding.
    const filed = `filed ${k.folder}/<slug>/${RUNS_DIR}/<yyyymmdd_hhmm>/<file>.md, one folder per /feature run`;
    for (const slug of listing(abs)) {
      const slugDir = join(abs, slug);
      if (!statSync(slugDir).isDirectory()) {
        findings.push(`${k.folder}/${slug}: is a loose file; a requirements document lives in its own folder as ${k.folder}/<slug>/${GATE_FILES[0]}, and a requirements source is ${filed}`);
        continue;
      }
      if (!RUN_SLUG.test(slug)) {
        findings.push(`${k.folder}/${slug}: is not a slug (lowercase letters, digits and hyphens); the first level is the requirements document's slug, ${filed}`);
        continue;
      }
      for (const entry of listing(slugDir)) {
        const entryPath = join(slugDir, entry);
        if (!statSync(entryPath).isDirectory()) {
          if (GATE_FILES.includes(entry) || !entry.endsWith('.md')) continue;
          findings.push(`${k.folder}/${slug}/${entry}: is not the requirements document, its review or a run folder; a requirements source is ${filed}`);
          continue;
        }
        if (entry !== RUNS_DIR) {
          findings.push(`${k.folder}/${slug}/${entry}: is a folder; the only folder beside the requirements document is ${RUNS_DIR}/, and a requirements source is ${filed}`);
          continue;
        }
        for (const stamp of listing(entryPath)) {
          const stampDir = join(entryPath, stamp);
          const runRel = `${k.folder}/${slug}/${RUNS_DIR}/${stamp}`;
          if (!statSync(stampDir).isDirectory()) {
            findings.push(`${runRel}: is a loose file; a requirements source is ${filed}`);
            continue;
          }
          if (!RUN_STAMP.test(stamp)) {
            findings.push(`${runRel}: is not a run stamp (${RUN_STAMP_FORM}); the folder under ${RUNS_DIR}/ is the day and the minute /feature ran, ${filed}`);
            continue;
          }
          for (const name of listing(stampDir)) {
            const file = join(stampDir, name);
            const rel = `${runRel}/${name}`;
            if (statSync(file).isDirectory()) {
              findings.push(`${rel}: is a folder; a run folder holds files and nothing deeper`);
              continue;
            }
            if (!name.endsWith('.md')) continue;
            read(rel, file, { id: runId(slug, stamp, name.slice(0, -3)), reason: 'the slug, the run stamp with its underscore made a hyphen, and the file name -- so two runs never share an id' });
          }
        }
      }
    }
  }
  const ids = new Map();
  for (const d of documents) {
    if (ids.has(d.name)) findings.push(`${d.path}: id "${d.name}" is already used by ${ids.get(d.name)}`);
    else ids.set(d.name, d.path);
  }
  return { documents, findings, folders, kinds };
}

/**
 * Every always-on rule under `.claude/rules/` must be imported by `CLAUDE.md`
 * with an `@.claude/rules/<file>` line. A runtime that reads neither `globs:`
 * nor the rules folder loads only what the constitution imports, so an
 * always-on rule that is not imported binds nobody there. Returns { imported, findings }.
 */
export function checkAlwaysOnImported(root) {
  const findings = [];
  const imported = [];
  const rulesDir = join(root, '.claude', 'rules');
  if (!existsSync(rulesDir)) return { imported, findings };
  let constitution = null;
  if (existsSync(join(root, 'CLAUDE.md'))) constitution = readFileSync(join(root, 'CLAUDE.md'), 'utf8');
  const importLines = new Set((constitution || '').split(/\r?\n/).map((l) => l.trim()).filter((l) => l.startsWith('@')).map((l) => l.slice(1)));
  for (const name of readdirSync(rulesDir).sort()) {
    if (!name.endsWith('.md')) continue;
    const rel = `.claude/rules/${name}`;
    const rule = parseRule(rel, readFileSync(join(rulesDir, name), 'utf8'));
    if (rule.alwaysApply !== true) continue;
    if (constitution === null) findings.push(`${rel}: is alwaysApply: true and there is no CLAUDE.md to import it`);
    else if (!importLines.has(rel)) findings.push(`${rel}: is alwaysApply: true and CLAUDE.md does not import it (no "@${rel}" line); an always-on rule nothing loads binds nobody`);
    else imported.push(rel);
  }
  return { imported, findings };
}

// A glob that matches every path. A path-scoped rule with one is always on in all but name.
const CATCH_ALL_GLOB = /^(\*\*|\*\*\/\*|\*\*\/\*\*|\*)$/;

/**
 * Every file under `.claude/rules/` must say when Claude Code loads it.
 * Claude Code loads every `.md` file in that folder at session start, and it
 * holds a file back until a matching file is read only when the frontmatter
 * has `paths:`. It does not read `globs:` or `alwaysApply:`. So:
 *   - a file without frontmatter loads in every session;
 *   - an always-on rule (alwaysApply: true) carries no `paths:`;
 *   - a path-scoped rule (alwaysApply: false) carries `paths:`, the same list
 *     as its `globs:`, and no glob that matches every path.
 * Returns { scoped, findings }, `scoped` the path-scoped rules that pass.
 */
export function checkRulesScoped(root) {
  const findings = [];
  const scoped = [];
  const rulesDir = join(root, '.claude', 'rules');
  if (!existsSync(rulesDir)) return { scoped, findings };
  for (const name of readdirSync(rulesDir).sort()) {
    if (!name.endsWith('.md')) continue;
    const rel = `.claude/rules/${name}`;
    const lines = readFileSync(join(rulesDir, name), 'utf8').split(/\r?\n/);
    const close = lines[0] === '---' ? lines.indexOf('---', 1) : -1;
    if (close === -1) {
      findings.push(`${rel}: has no frontmatter, so Claude Code loads it in every session; give it name, description, globs, alwaysApply and paths`);
      continue;
    }
    const keys = new Map();
    for (const line of lines.slice(1, close)) {
      const m = line.match(/^([A-Za-z][A-Za-z0-9_-]*):[ \t]*(.*?)\s*$/);
      if (m) keys.set(m[1], m[2]);
    }
    const always = keys.get('alwaysApply');
    if (always !== 'true' && always !== 'false') {
      findings.push(`${rel}: alwaysApply must be the literal true or false, got ${JSON.stringify(always ?? null)}`);
      continue;
    }
    if (always === 'true') {
      if (keys.has('paths')) findings.push(`${rel}: is alwaysApply: true and has paths:, so Claude Code loads it only when a matching file is read; remove paths:`);
      continue;
    }
    const list = (key) => {
      try {
        const parsed = JSON.parse(keys.get(key));
        return Array.isArray(parsed) && parsed.length > 0 && parsed.every((g) => typeof g === 'string' && g.trim() !== '') ? parsed : null;
      } catch {
        return null;
      }
    };
    const globs = list('globs');
    const paths = list('paths');
    const before = findings.length;
    if (!keys.has('paths')) findings.push(`${rel}: is alwaysApply: false and has no paths:, so Claude Code loads it in every session; add paths: with the same list as globs:`);
    else if (paths === null) findings.push(`${rel}: paths must be a one-line JSON array of non-empty strings, got ${JSON.stringify(keys.get('paths'))}`);
    if (globs === null) findings.push(`${rel}: globs must be a one-line JSON array of non-empty strings, got ${JSON.stringify(keys.get('globs') ?? null)}`);
    if (globs !== null && paths !== null && JSON.stringify(globs) !== JSON.stringify(paths)) {
      findings.push(`${rel}: paths ${JSON.stringify(paths)} and globs ${JSON.stringify(globs)} differ; Claude Code reads paths: and other runtimes read globs:, so the two must be the same list`);
    }
    if ((globs || []).concat(paths || []).some((g) => g.trim().search(CATCH_ALL_GLOB) !== -1)) {
      findings.push(`${rel}: is path-scoped but a glob matches every path; a rule that binds every change is alwaysApply: true`);
    }
    if (findings.length === before) scoped.push(rel);
  }
  return { scoped, findings };
}

/* -------------------------------------------------------------- one spoke */

/**
 * The three states of CONTRACTS_INDEX, and a fourth for a value that is none of
 * them -- the same three RULES_INDEX has, because a missing key is never "fine".
 *   { state: 'path', path }             a folder, relative to the repository root
 *   { state: 'none' }                   declared on purpose: no contracts
 *   { state: 'not-configured' }         missing, empty or UNRESOLVED
 *   { state: 'invalid', value }
 */
export function contractsIndexState(map) {
  return folderIndexState(map, CONTRACTS_INDEX_KEY);
}

/** The same four states for DECISIONS_INDEX, the folder of the spoke's own decision records. */
export function decisionsIndexState(map) {
  return folderIndexState(map, DECISIONS_INDEX_KEY);
}

function folderIndexState(map, key) {
  const value = map.get(key);
  if (value === undefined || value === '' || value === 'UNRESOLVED') return { state: 'not-configured' };
  if (value === 'none') return { state: 'none' };
  const path = value.replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+$/, '');
  if (path === '' || path === '.' || !RELATIVE_PATH.test(path) || path.split('/').some((s) => s === '')) return { state: 'invalid', value };
  return { state: 'path', path };
}

/**
 * Read a spoke's context documents at a commit in the cache. Returns
 *   { state, path?, documents, findings }
 * where `state` is 'path' | 'none' | 'not-configured' | 'invalid' |
 * 'missing-folder' (the declared folder is not at the commit) | 'no-commands-file'.
 * Files that are not `.md` -- a schema beside its prose -- are not documents
 * and are skipped.
 */
export function readDocumentsAt(dir, commit, checksPath, { key = CONTRACTS_INDEX_KEY } = {}) {
  if (objectType(dir, commit, checksPath) !== 'blob') {
    return { state: 'no-commands-file', documents: [], findings: [`commands file ${checksPath} is not at this commit`] };
  }
  const env = parseChecksEnv(git(['--git-dir', dir, 'cat-file', 'blob', `${commit}:${checksPath}`]));
  const idx = folderIndexState(env, key);
  const base = { key, documents: [], findings: [] };
  if (idx.state === 'invalid') return { ...base, state: 'invalid', findings: [`${checksPath}: ${key}=${idx.value} is not a path relative to the repository root, "none" or "UNRESOLVED"`] };
  if (idx.state !== 'path') return { ...base, state: idx.state };
  if (objectType(dir, commit, idx.path) !== 'tree') {
    return { ...base, state: 'missing-folder', path: idx.path, findings: [`${checksPath} says ${key}=${idx.path}, and ${idx.path} is not a folder at this commit`] };
  }
  const listing = git(['--git-dir', dir, 'ls-tree', '-r', `${commit}:${idx.path}`], { env: quietGitEnv() });
  const entries = listing.split('\n').filter(Boolean).map((row) => {
    const m = row.match(/^\d+ (\w+) ([0-9a-f]+)\t(.+)$/);
    return { path: `${idx.path}/${m[3]}`, type: m[1], sha: m[2] };
  });
  const documents = [];
  const findings = [];
  // Every document's bytes in one call, then parsed in path order.
  const wanted = entries.filter((e) => e.type === 'blob' && e.path.endsWith('.md')).sort((a, b) => (a.path < b.path ? -1 : 1));
  const blobs = catBlobs(dir, wanted.map((e) => e.sha));
  for (const e of wanted) {
    const doc = parseSpokeDocument(e.path, blobs.get(e.sha).toString('utf8'), key);
    doc.blob = e.sha;
    checkPath(doc);
    findings.push(...doc.findings);
    if (!doc.findings.length) documents.push(doc);
  }
  findings.push(...repeatedIds(documents));
  return { key, state: 'path', path: idx.path, documents, findings };
}

/**
 * The global repository's documents at one commit in its bare cache: its
 * records, standards and exceptions, each folder flat and at the path KINDS
 * names. Templates (`_TEMPLATE.*`), `README.md`, dotfiles and files that are not
 * `.md` are skipped. A missing folder holds nothing, because a new global
 * repository may not have one yet. Returns { documents, findings, folders }, as
 * scanHub does. The ids are the files' own, without `global.`: toRow adds it.
 */
export function readGlobalDocumentsAt(dir, commit) {
  return readFoldersAt(dir, commit, GLOBAL_KINDS, 'the global repository');
}

/**
 * The documents of `kinds` at one commit of a repository in a bare cache, each
 * kind in the folder KINDS names, read as readGlobalDocumentsAt describes.
 * read-hubs.mjs reads a sibling hub's records and standards with it, because a
 * hub keeps them in the same two folders. `owner` names the repository in a
 * finding.
 */
export function readFoldersAt(dir, commit, kinds, owner) {
  const documents = [];
  const findings = [];
  const folders = {};
  const wanted = [];
  for (const kind of kinds) {
    const { folder } = KINDS[kind];
    folders[folder] = 0;
    const type = objectType(dir, commit, folder);
    if (type === null) continue;
    if (type !== 'tree') {
      findings.push(`${folder}: is not a folder at ${short(commit)}, and ${owner} keeps its ${kind} documents there`);
      continue;
    }
    const listing = git(['--git-dir', dir, 'ls-tree', `${commit}:${folder}`], { env: quietGitEnv() });
    for (const row of listing.split('\n').filter(Boolean)) {
      const m = row.match(/^(\d+) (\w+) ([0-9a-f]+)\t(.+)$/);
      const name = m[4];
      const path = `${folder}/${name}`;
      if (name.startsWith('.') || name.startsWith('_TEMPLATE.') || name === 'README.md') continue;
      if (m[2] === 'tree') {
        findings.push(`${path}: is a folder, and the document folders are flat`);
        continue;
      }
      if (!name.endsWith('.md')) continue;
      folders[folder] += 1;
      if (m[1] === '120000') {
        findings.push(`${path}: is a link, and a document is a file`);
        continue;
      }
      if (kind === 'adr' && !name.match(ADR_FILE)) {
        findings.push(`${path}: is not a decision record file (ADR-<NNN>[-<slug>].md) and not the template. The records folder holds records`);
        continue;
      }
      if (kind === 'standard' && !name.match(STD_FILE)) {
        findings.push(`${path}: is not a standard file (std-<topic>.md) and not the template`);
        continue;
      }
      wanted.push({ kind, path, sha: m[3] });
    }
  }
  // Every document's bytes in one call, then parsed in path order.
  const blobs = catBlobs(dir, wanted.map((w) => w.sha));
  for (const w of wanted.sort((a, b) => (a.path < b.path ? -1 : 1))) {
    const doc = parseDocument(w.path, blobs.get(w.sha).toString('utf8'), [w.kind]);
    doc.blob = w.sha;
    checkPath(doc);
    findings.push(...doc.findings);
    if (!doc.findings.length) documents.push(doc);
  }
  findings.push(...repeatedIds(documents));
  return { documents, findings, folders };
}

/**
 * Both folders of a spoke at a commit: its contracts (CONTRACTS_INDEX) and its own
 * decision records (DECISIONS_INDEX). `documents` and `findings` are the two together.
 */
export function readSpokeDocumentsAt(dir, commit, checksPath) {
  const contracts = readDocumentsAt(dir, commit, checksPath, { key: CONTRACTS_INDEX_KEY });
  if (contracts.state === 'no-commands-file') return { contracts, decisions: { ...contracts, key: DECISIONS_INDEX_KEY }, documents: [], findings: contracts.findings };
  const decisions = readDocumentsAt(dir, commit, checksPath, { key: DECISIONS_INDEX_KEY });
  // A contract's id is lowercase and a record's is ADR-<NNN>, so the two folders cannot share one.
  return { contracts, decisions, documents: [...contracts.documents, ...decisions.documents], findings: [...contracts.findings, ...decisions.findings] };
}

// A spoke's folder holds one kind set: contracts and vendor documents, or decision
// records, each record in a file named by its number as the hub's are.
function parseSpokeDocument(path, text, key) {
  if (key !== DECISIONS_INDEX_KEY) return parseDocument(path, text, SPOKE_KINDS);
  const doc = parseDocument(path, text, ['adr']);
  if (!path.split('/').pop().match(ADR_FILE)) doc.findings.push(`${path}: a decision record's file is ADR-<NNN>-<slug>.md, named by the number it carries`);
  return doc;
}

// One finding per id two documents of one folder share.
function repeatedIds(documents) {
  const findings = [];
  const ids = new Map();
  for (const d of documents) {
    if (ids.has(d.name)) findings.push(`${d.path}: id "${d.name}" is already used by ${ids.get(d.name)}`);
    else ids.set(d.name, d.path);
  }
  return findings;
}

/**
 * The same read against a checkout on disk, for /add-context and for a spoke's
 * own CI. `indexPath` overrides the commands file's key when given. Returns the
 * shape readDocumentsAt returns.
 */
export function readDocumentsLocal(root, { checksPath = 'checks.env', indexPath = null, key = CONTRACTS_INDEX_KEY } = {}) {
  let idx;
  if (indexPath !== null) {
    idx = folderIndexState(new Map([[key, indexPath]]), key);
  } else {
    let text;
    try {
      text = readFileSync(join(root, checksPath), 'utf8');
    } catch {
      return { key, state: 'no-commands-file', documents: [], findings: [`no commands file at ${checksPath}`] };
    }
    idx = folderIndexState(parseChecksEnv(text), key);
  }
  const base = { key, documents: [], findings: [] };
  if (idx.state === 'invalid') return { ...base, state: 'invalid', findings: [`${key}=${idx.value} is not a path relative to the repository root, "none" or "UNRESOLVED"`] };
  if (idx.state !== 'path') return { ...base, state: idx.state };
  const folder = join(root, idx.path);
  if (!existsSync(folder) || !statSync(folder).isDirectory()) {
    return { ...base, state: 'missing-folder', path: idx.path, findings: [`${key}=${idx.path}, and ${idx.path} is not a folder in this checkout`] };
  }
  const files = [];
  const walk = (dir, rel) => {
    for (const name of readdirSync(dir).sort()) {
      if (name.startsWith('.')) continue;
      const abs = join(dir, name);
      const here = `${rel}/${name}`;
      if (statSync(abs).isDirectory()) walk(abs, here);
      else if (name.endsWith('.md')) files.push({ path: here, bytes: readFileSync(abs) });
    }
  };
  walk(folder, idx.path);
  const documents = [];
  const findings = [];
  for (const f of files) {
    const doc = parseSpokeDocument(f.path, f.bytes.toString('utf8'), key);
    doc.blob = blobHash(f.bytes);
    checkPath(doc);
    findings.push(...doc.findings);
    if (!doc.findings.length) documents.push(doc);
  }
  findings.push(...repeatedIds(documents));
  return { key, state: 'path', path: idx.path, documents, findings };
}

/* --------------------------------------------------------------- selection */

/**
 * The document ids a design names: every id from `ids` that appears as a whole
 * token in the design outside code fences. A design that names a document
 * selects it; that is the deterministic half of "which context applies".
 */
export function designNames(text, ids) {
  const body = maskFences(String(text).split(/\r?\n/)).join('\n');
  // A dot before an id joins it to a repository's id: "sample-service.ADR-003" names no ADR-003.
  return ids.filter((id) => new RegExp(`(^|[^A-Za-z0-9_.-])${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9_-])`, 'm').test(body));
}

/**
 * Rows in scope for one repository: the global layer's, the hub's and that
 * repository's. Selected when always on, when a glob matches a path, or when
 * the design names the id. Order: global rows, then hub rows, always-on before
 * the rest, then by path. A decision record that is not Accepted, and a
 * standard or an exception that is not Active, is selected only when named.
 */
/**
 * Whether a row binds. A record that no longer binds -- superseded or
 * deprecated -- a standard held in reserve and a withdrawn exception are read
 * only by a design that names them, and leave the global index.
 */
export function binds(r) {
  if (r.kind === 'adr') return r.status === 'Accepted';
  if (r.kind === 'standard' || r.kind === 'exception') return r.status === 'Active';
  return true;
}

/**
 * The index line read-context.mjs prints for one row, without its newline.
 * The global repository's check counts these bytes against GLOBAL_INDEX_CAP,
 * so the two read one format.
 */
export function indexLine(r) {
  const status = 'status' in r ? ` · ${r.status}` : '';
  return `- ${r.id} · ${r.kind} · ${r.repository} · ${r.rank === null ? 'unranked' : `rank ${r.rank}`}${r.alwaysApply ? ' · always on' : ''}${status} · ${r.description}`;
}

/**
 * The line read-context.mjs prints in a global exception's document block,
 * above its `Cite:` line: the header fields a seat needs to judge whether the
 * exception covers a record (review-artefact § The contradiction test). The
 * printed body has no header, so without this line a seat would read it with
 * git, outside the named scripts. Null for a row of any other kind.
 */
export function exceptionLine(r) {
  if (r.kind !== 'exception') return null;
  return [
    `Hubs: ${r.hubs.join(', ')}`,
    `Departs: ${r.departs.join(', ')}`,
    `Repositories: ${r.repositories.join(', ')}`,
    `Status: ${r.status}`,
    `Review-by: ${r.reviewBy === null ? 'none recorded' : r.reviewBy}`,
  ].join(' · ');
}

/**
 * A document's body as read-context.mjs prints it under its `Cite:` line: the
 * header removed, no blank lines before, one newline after. The global
 * repository's check counts these bytes against GLOBAL_ALWAYS_ON_CAP.
 */
export function printedBody(body) {
  return String(body || '').replace(/^\n+/, '').replace(/\n*$/, '\n');
}

/**
 * The rows of the index read-context.mjs prints: every row, except a global
 * row that no longer binds and a requirements source. A superseded global record, a reserved global
 * standard and a withdrawn exception leave the index, so the Board keeps the
 * index small by superseding (`docs/proposals/global-context.md` §7).
 * `--names global.<id>` still opens one. A requirements source leaves the index
 * because no command reads its line. The /feature runs of its feature and
 * check-requirements.js open a source by its path. The sources are most of
 * the lines in a hub with many features. `--names <id>` still opens one, and
 * `read-context.mjs --sources <slug>` lists the sources of one feature.
 * No global row is a requirements source, so the global index cap counts the same lines.
 */
export function indexRows(rows) {
  return rows.filter((r) => r.kind !== 'requirements-source' && (r.repository !== GLOBAL || binds(r)));
}

/**
 * The slug of the feature a requirements source belongs to: the folder under
 * `docs/requirements/` that holds its run folder. Null for a row of any other kind.
 */
export function sourceSlug(r) {
  if (r.kind !== 'requirements-source') return null;
  return r.path.slice(KINDS['requirements-source'].folder.length + 1).split('/')[0];
}

export function selectRows(rows, repository, { paths = [], names = [] } = {}) {
  const inScope = sortRows(rows.filter((r) => r.repository === GLOBAL || r.repository === HUB || r.repository === repository));
  const always = (r) => r.alwaysApply === true && binds(r);
  const pick = (r) => names.includes(r.id) || (binds(r) && paths.some((p) => matchesGlobs(p, r.globs)));
  return [...inScope.filter(always), ...inScope.filter((r) => !always(r) && pick(r))];
}

/**
 * Which listed repositories each hub standard reaches: for every standard, the
 * repositories in `trees` (id -> every path at the commit the list records)
 * holding a path its globs match. A note, never a finding: a standard for a stack
 * or a kind of change nobody uses yet is a standard all the same, and its globs
 * keep it out of every design until a path matches. Always-on and name-only
 * standards reach by design, not by path, and are not listed.
 */
export function standardsReach(rows, trees) {
  const notes = [];
  for (const r of rows.filter((x) => x.kind === 'standard' && x.repository === HUB && !x.alwaysApply && x.globs.length)) {
    const reached = [...trees].filter(([, paths]) => paths.some((p) => matchesGlobs(p, r.globs))).map(([id]) => id);
    const held = r.status === 'Active' ? '' : `; ${r.status}, so it binds only a design that names it`;
    notes.push(reached.length
      ? `${r.id} reaches ${reached.join(', ')}${held}`
      : `${r.id} reaches no listed repository: its globs ${JSON.stringify(r.globs)} match no path in the ${trees.size} read${held || '; it binds the first design that touches a matching path'}`);
  }
  return notes;
}

/**
 * One `Context:` entry for a row: `<id>@<pin>:<path>`, or
 * `<id>@<pin>:<repository>:<path>` for a spoke's, the pin the blob's. A global
 * row's entry is `<id>@<pin>:global:<path>`, the pin the global commit's,
 * because the commit fixes the bytes and the feature records the commit. An
 * entry the grammar would not read is thrown, never printed: the gate would
 * refuse the line a design copied.
 */
export function contextEntry(row) {
  const where = row.repository === HUB ? row.path : `${row.repository}:${row.path}`;
  const pin = row.repository === GLOBAL ? row.commit : row.blob;
  const entry = `${row.id}@${pin.slice(0, CONTEXT_PIN)}:${where}`;
  if (!CONTEXT_ENTRY.test(entry)) throw new Error(`the Context: entry "${entry}" does not match CONTEXT_ENTRY`);
  return entry;
}

/**
 * `Context: <entry>, <entry>` or `Context: none` -- the line a design carries
 * beside `Rules:`. The pickup gate reads its form with its own copy of the
 * grammar (`contextEntry`, `contextSeparator` in check-dev-ready.js): an id is
 * RULE_NAME (a standard's std-<topic> among them) or ADR_FILE's number, and CONTEXT_ENTRY is the whole entry. The two
 * are kept in step by hand.
 */
export function contextLine(selected) {
  return `Context: ${selected.length ? selected.map(contextEntry).join(', ') : 'none'}`;
}

/* ---------------------------------------------------------------- overrides */

/**
 * Which standards, and which of their rules, the spoke rules in `rules` replace
 * for the standard rows in `rows`. `rules` are the spoke rules that bind the
 * change -- a rule overrides only where it binds -- and `repository` is the
 * spoke's id, for the `by` part. Returns
 *
 *   { byStandard: Map<standard id, ["<id> by <repository>:<rule>", ...]>,
 *     findings: [...], notes: [...], count }
 *
 * A finding is an override of a rule the standard does not define: a typing
 * error nobody meant, and it fails the read. A note is an override of a standard
 * that is not in scope here -- a spoke in two hubs may name a standard only one
 * of them holds -- and it has no effect in this hub, which the note says. The
 * form of each id was checked where the rule was parsed.
 */
export function overrideReport(rows, rules, repository) {
  const standards = new Map(rows.filter((r) => r.kind === 'standard').map((r) => [r.id, r]));
  const byStandard = new Map();
  const findings = [];
  const notes = [];
  let count = 0;
  for (const rule of rules) {
    for (const id of rule.overrides) {
      const target = overrideTarget(id);
      if (target === null) continue;
      const row = standards.get(target.standard);
      if (row === undefined) {
        notes.push(`${repository}:${rule.name} overrides ${id}, and no standard ${target.standard} is in scope here; the override has no effect in this hub`);
        continue;
      }
      if (target.rule !== null && !row.rules.includes(target.rule)) {
        findings.push(`${rule.path}: overrides ${id}, and ${target.standard} defines no such rule${row.rules.length ? `; its rules are ${row.rules.join(', ')}` : ''}`);
        continue;
      }
      if (!byStandard.has(row.id)) byStandard.set(row.id, []);
      byStandard.get(row.id).push(`${id} by ${repository}:${rule.name}`);
      count += 1;
    }
  }
  return { byStandard, findings, notes, count };
}

/**
 * The `Overridden:` line read-context.mjs prints in a standard's document block,
 * above its `Cite:` line, or null when nothing overrides it. Each item is
 * `<id> by <repository>:<rule>`: the id is the whole standard, or one of its
 * rules, as the spoke rule named it.
 */
export function overriddenLine(byStandard, id) {
  const items = byStandard.get(id);
  return items && items.length ? `Overridden: ${items.join(', ')}` : null;
}

/** The header line: how many overrides the selected spoke rules make. */
export function overridesLine(report) {
  return `Overrides: ${report.count ? `${report.count} from ${report.byStandard.size} standard(s)` : 'none'}`;
}

/**
 * The pickup gate's pattern for the `Rules:` label, so --pinned reads the line
 * the gate read: `Rules:` at the left margin, spaces or tabs, then the value.
 */
const RULES_LABEL_LINE = /^Rules:[ \t]*(\S.*?)\s*$/;

/**
 * The design's one `Rules:` line, read for `read-context.mjs --pinned` so the
 * spoke rules are read at the commit the design cites. Masked the way the
 * Context: line is. Returns `{ value, cite: { repository, pin, folder } | null,
 * findings }`: `cite` is null for `Rules: none`, and a finding names a missing
 * or doubled line or a value in neither form.
 */
export function parseRulesLine(text) {
  const claims = [];
  maskFences(stripHtmlComments(String(text)).split(/\r\n|\n|\r/)).forEach((line, i) => {
    const m = line.match(RULES_LABEL_LINE);
    if (m) claims.push({ value: m[1], no: i + 1 });
  });
  if (claims.length !== 1) {
    return { value: null, cite: null, findings: [claims.length
      ? `the design carries ${claims.length} Rules: lines (lines ${claims.map((c) => c.no).join(', ')}); it carries exactly one, as scripts/read-spoke-rules.mjs prints it`
      : 'the design carries no Rules: line; copy the one scripts/read-spoke-rules.mjs printed when the design was written'] };
  }
  const { value, no } = claims[0];
  if (value === RULES_NONE) return { value, cite: null, findings: [] };
  const m = value.match(RULES_CITE);
  if (!m) return { value, cite: null, findings: [`line ${no}: "${value}" is not "none" or <repository-id>@<12-hex>:<folder>; copy the Rules: line scripts/read-spoke-rules.mjs prints`] };
  return { value, cite: { repository: m[1], pin: m[2], folder: m[3] }, findings: [] };
}

/** A Context: entry the line names by id alone, the form before each entry carried a pin. */
const CONTEXT_BARE_ID = /^(?:[a-z0-9][a-z0-9-]*|(?:[A-Za-z0-9][A-Za-z0-9._-]*\.)?ADR-\d{3,}|global\.(?:std-[a-z0-9]+(?:-[a-z0-9]+)*|EXC-\d{3,}))$/;
/** An entry that names a standard by the number it carried before it was named std-<topic>. */
const CONTEXT_OLD_STD = /^(STD-\d{3,})(?:@|$)/;

/**
 * The pickup gate's pattern for the label, so the reader is never stricter than
 * the gate on a line the gate reads: `Context:` at the left margin, spaces or
 * tabs, then the value.
 */
const CONTEXT_LABEL_LINE = /^Context:[ \t]*(\S.*?)\s*$/;

/**
 * The design's one `Context:` line, read for `read-context.mjs --pinned`: a line
 * starting `Context:` at the left margin, outside a code fence and an HTML
 * comment, exactly once -- the lines the gate reads, masked the way the index
 * masks them. `value` is what follows the label (null when there is not exactly
 * one line); `entries` are the entries CONTEXT_ENTRY reads, each with `global`
 * true for one kept in the global repository. `findings` name every bare id,
 * every item that is not an entry, a global id outside the global form or a
 * global form around another id, a repeated id, and a missing or doubled line.
 * `Context: none` is a value with no entries and no findings.
 */
export function parseContextLine(text) {
  const findings = [];
  const claims = [];
  maskFences(stripHtmlComments(String(text)).split(/\r\n|\n|\r/)).forEach((line, i) => {
    const m = line.match(CONTEXT_LABEL_LINE);
    if (m) claims.push({ value: m[1], no: i + 1 });
  });
  if (claims.length !== 1) {
    findings.push(claims.length
      ? `the design carries ${claims.length} Context: lines (lines ${claims.map((c) => c.no).join(', ')}); it carries exactly one, as scripts/read-context.mjs prints it`
      : 'the design carries no Context: line; copy the one scripts/read-context.mjs printed when the design was written');
    return { value: null, entries: [], findings };
  }
  const { value, no } = claims[0];
  if (value === 'none') return { value, entries: [], findings };
  const entries = [];
  for (const item of value.split(', ')) {
    const m = item.match(CONTEXT_ENTRY);
    const old = item.match(CONTEXT_OLD_STD);
    const keeper = m && m[1].match(SPOKE_RECORD_ID);
    const globalId = m !== null && m[1].startsWith(GLOBAL_PREFIX);
    if (m && globalId && m[3] !== GLOBAL) {
      findings.push(`line ${no}: "${item}" is a global document and the entry places it ${m[3] ? `in "${m[3]}"` : 'in the hub'}. A global entry is <id>@<12-hex>:${GLOBAL}:<path>, so copy the line scripts/read-context.mjs prints`);
    } else if (m && !globalId && m[3] === GLOBAL) {
      findings.push(`line ${no}: "${item}" places ${m[1]} in the global layer, and a global document's id starts with "${GLOBAL_PREFIX}". Copy the line scripts/read-context.mjs prints`);
    } else if (m && keeper && keeper[1] !== (m[3] || null)) {
      findings.push(`line ${no}: "${item}" is a decision record of "${keeper[1]}" and the entry places it ${m[3] ? `in "${m[3]}"` : 'in the hub'}; a record's id names the repository that keeps it, so copy the line scripts/read-context.mjs prints`);
    } else if (m && m[1].match(HUB_RECORD_ID) && m[3]) {
      findings.push(`line ${no}: "${item}" places the hub's decision record ${m[1]} in "${m[3]}"; a repository's own record is <repository-id>.ADR-<NNN>, so copy the line scripts/read-context.mjs prints`);
    } else if (m) {
      entries.push({ item, id: m[1], pin: m[2], repository: m[3] || null, path: m[4], global: m[3] === GLOBAL });
    } else if (old) {
      findings.push(`line ${no}: "${old[1]}" names a standard by number, the form before standards were named std-<topic>; re-run scripts/read-context.mjs for the design's paths, copy the line it prints, and amend the merged design by pull request with a human, with a fresh review`);
    } else if (item.match(CONTEXT_BARE_ID)) {
      findings.push(`line ${no}: "${item}" names a document by id alone, with no pin and no path, so nobody can say which bytes the design read; re-run scripts/read-context.mjs for the design's paths, copy the line it prints, and amend the merged design by pull request with a human, with a fresh review`);
    } else {
      findings.push(`line ${no}: "${item}" is not a context entry; copy the line scripts/read-context.mjs prints`);
    }
  }
  const ids = entries.map((e) => e.id);
  const repeated = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];
  if (repeated.length) findings.push(`line ${no}: ${repeated.map((r) => `"${r}"`).join(', ')} named more than once; copy the line scripts/read-context.mjs prints`);
  return { value, entries, findings };
}

// The labels of the line that binds a design to its work item, as the pickup
// gate reads them (`identityLabels` in check-dev-ready.js), and the key grammar.
const DESIGN_KEY_LINE = /^(?:Ticket|Work item):[ \t]*(\S.*?)\s*$/;
const WORK_ITEM_KEY = /^[A-Z][A-Z0-9]{1,9}-\d+$/;

/**
 * The work item key a design names on its `Ticket:` or `Work item:` lines,
 * outside a code fence and an HTML comment: `{ key }`, or `{ finding }` when
 * the lines name no key or more than one.
 */
export function designKey(text) {
  const keys = [...new Set(maskFences(stripHtmlComments(String(text)).split(/\r\n|\n|\r/))
    .map((line) => line.match(DESIGN_KEY_LINE)).filter(Boolean).map((m) => m[1]))];
  if (keys.length === 1 && keys[0].match(WORK_ITEM_KEY)) return { key: keys[0] };
  return { finding: keys.length ? `the design names ${keys.map((k) => `"${k}"`).join(', ')} on its "Ticket:" lines, not one work item key` : 'the design names no work item on a "Ticket:" line' };
}

// The Global: line of a requirements document, the grammar check-requirements.js
// reads (`globalLine`, `globalValue`, `releaseTag`).
const GLOBAL_LABEL_LINE = /^Global:[ \t]*(\S.*?)\s*$/;
const GLOBAL_RELEASE = /^(v\d+\.\d+\.\d+) ([0-9a-f]{40})$/;

/**
 * The release a requirements document records on its one `Global:` line,
 * outside a code fence and an HTML comment: `{ tag, commit }`, null for
 * `Global: none` or no line, or false when the line does not name one release.
 */
export function recordedRelease(text) {
  const values = maskFences(stripHtmlComments(String(text)).split(/\r\n|\n|\r/))
    .map((line) => line.match(GLOBAL_LABEL_LINE)).filter(Boolean).map((m) => m[1]);
  if (values.length > 1) return false;
  if (values.length === 0 || values[0] === 'none') return null;
  const m = values[0].match(GLOBAL_RELEASE);
  return m ? { tag: m[1], commit: m[2] } : false;
}

/* ------------------------------------------------------------- hub commit */

// The `Hub commit:` line an artefact carries beside `Context:`: the commit of the
// hub's HEAD when read-context.mjs read the hub's documents. The blob pins on
// the Context: line prove the bytes; this line says which commit held them, so
// an architect can trace a decision record or a standard to a point in the
// hub's history. The gates read the same label (`hubCommitLine` in
// check-requirements.js, check-decomposition.js and check-dev-ready.js), kept
// in step by hand.
export const HUB_COMMIT_LABEL = 'Hub commit';
const HUB_COMMIT_LABEL_LINE = /^Hub commit:[ \t]*(\S.*?)\s*$/;

/** The line an artefact copies: `Hub commit: <40-hex>`. */
export function hubCommitLine(commit) {
  if (!COMMIT.test(commit)) throw new Error(`the Hub commit: value "${commit}" is not a full commit hash`);
  return `${HUB_COMMIT_LABEL}: ${commit}`;
}

/**
 * The one `Hub commit:` line of an artefact, outside a code fence and an HTML
 * comment: `{ value, commit, findings }`. `commit` is the 40-hex value, or null
 * with a finding when the line is missing, doubled, or not a full commit hash.
 */
export function parseHubCommitLine(text) {
  const claims = [];
  maskFences(stripHtmlComments(String(text)).split(/\r\n|\n|\r/)).forEach((line, i) => {
    const m = line.match(HUB_COMMIT_LABEL_LINE);
    if (m) claims.push({ value: m[1], no: i + 1 });
  });
  if (claims.length !== 1) {
    return { value: null, commit: null, findings: [claims.length
      ? `the design carries ${claims.length} ${HUB_COMMIT_LABEL}: lines (lines ${claims.map((c) => c.no).join(', ')}); it carries exactly one, as scripts/read-context.mjs prints it`
      : `the design carries no ${HUB_COMMIT_LABEL}: line, so nothing says which hub commit held the documents it read; re-run scripts/read-context.mjs for the design's paths, copy the ${HUB_COMMIT_LABEL}: and Context: lines it prints, and amend the merged design by pull request with a human, with a fresh review`] };
  }
  const { value, no } = claims[0];
  if (!COMMIT.test(value)) {
    return { value, commit: null, findings: [`line ${no}: "${HUB_COMMIT_LABEL}: ${value}" is not a full 40-character commit hash; copy the line scripts/read-context.mjs prints`] };
  }
  return { value, commit: value, findings: [] };
}

/**
 * The commit the hub checkout at `root` stands on. The hub's documents are read
 * from the working directory, and this is the commit that read is recorded
 * against. A folder that is no git repository, or one with no commit yet,
 * cannot say, so it is exit 2.
 */
export function hubHead(root) {
  try {
    const head = git(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], { cwd: root, env: quietGitEnv() }).trim();
    if (COMMIT.test(head)) return head;
  } catch {
    // Reported below: the reason is the same for every failure here.
  }
  throw new SpokeError(EXIT.CANNOT_VERIFY, `the hub at ${root} has no HEAD commit to record on the ${HUB_COMMIT_LABEL}: line; the hub's documents are read from a checkout of its trunk`, 'git-failed');
}

/**
 * The selected hub rows whose bytes on disk are not the bytes at `head`: a
 * document edited, added or left unstaged since the last commit. One finding per
 * row. A Hub commit: line names a commit that holds every pinned document, so a
 * selection that includes such a document is refused until it is committed or
 * the change is discarded.
 */
export function uncommittedHubDocuments(root, head, rows) {
  const findings = [];
  for (const r of rows) {
    if (r.repository !== HUB) continue;
    const committed = revParse(['-C', root], `${head}:${r.path}`);
    if (committed === r.blob) continue;
    findings.push(`${r.path} on disk is ${r.blob.slice(0, CONTEXT_PIN)} and ${committed === null ? 'is not in' : `${committed.slice(0, CONTEXT_PIN)} at`} the hub's HEAD ${short(head)}; the ${HUB_COMMIT_LABEL}: line names the commit that holds every document read, so commit the change or discard it, then run again`);
  }
  return findings;
}

function revParse(gitArgs, spec) {
  try {
    return git([...gitArgs, 'rev-parse', '--verify', '--quiet', spec]).trim() || null;
  } catch {
    return null;
  }
}

/** The blob at `ref:path`, or null when `ref` has no file there. */
export function headBlob(gitArgs, ref, path) {
  return revParse(gitArgs, `${ref}:${path}`);
}

/** The bytes of one blob, as text. */
export function blobText(gitArgs, blob) {
  return git([...gitArgs, 'cat-file', 'blob', blob]);
}

/* ---------------------------------------------------------- context report */

// The report of one artefact's `Context:` and `Hub commit:` lines, for a person:
// where every pinned document sits in the hub's history, and whether the trunk
// still holds its bytes. report-context.mjs prints it, and jira-sync.mjs puts
// its rows in a mirrored issue's description, so the two agree on one reading.
// It reads the hub alone, at the local trunk ref, never fetched: a stale ref can
// show drift that a fetch would clear, never a pin as held that the hub lost.

// The kinds of artefact that carry the two lines, by the path each is filed at
// (`KINDS['requirements-document']`, `docs/backlog/<slug>/<KEY>.item.md`,
// `docs/designs/<KEY>.lld.md`), and `artefact` for a path outside those.
export const ARTEFACT_KINDS = { requirements: 'requirements document', story: 'story', design: 'design', other: 'artefact' };
const BACKLOG_DIR = 'docs/backlog';
const ITEM_SUFFIX = '.item.md';
const DESIGN_DIR = 'docs/designs';
const DESIGN_SUFFIX = '.lld.md';
const DESIGN_RULES_LINE = /^Rules:[ \t]*\S/m;
const REPOSITORY_LABEL_LINE = /^Repository:[ \t]*\S/m;

/**
 * Which artefact a path names: by its place first, then by the lines it carries
 * (`Global:` is the requirements document's, `Rules:` the design's,
 * `Repository:` alone the story's), else `artefact`. Also the slug the path
 * carries, for a requirements document or a story, or null.
 */
export function artefactKind(path, text) {
  const parts = String(path).split('/');
  const req = KINDS['requirements-document'];
  if (parts.length === 4 && `${parts[0]}/${parts[1]}` === req.folder && parts[3] === req.file) return { kind: ARTEFACT_KINDS.requirements, slug: parts[2] };
  if (parts.length === 4 && `${parts[0]}/${parts[1]}` === BACKLOG_DIR && parts[3].endsWith(ITEM_SUFFIX)) return { kind: ARTEFACT_KINDS.story, slug: parts[2] };
  if (parts.length === 3 && `${parts[0]}/${parts[1]}` === DESIGN_DIR && parts[2].endsWith(DESIGN_SUFFIX)) return { kind: ARTEFACT_KINDS.design, slug: null };
  const masked = maskFences(stripHtmlComments(String(text)).split(/\r\n|\n|\r/)).join('\n');
  if (recordedRelease(masked) !== null) return { kind: ARTEFACT_KINDS.requirements, slug: null };
  if (masked.search(DESIGN_RULES_LINE) !== -1) return { kind: ARTEFACT_KINDS.design, slug: null };
  if (masked.search(REPOSITORY_LABEL_LINE) !== -1) return { kind: ARTEFACT_KINDS.story, slug: null };
  return { kind: ARTEFACT_KINDS.other, slug: null };
}

function isShallow(gitArgs) {
  try {
    return git([...gitArgs, 'rev-parse', '--is-shallow-repository']).trim() === 'true';
  } catch {
    return false;
  }
}

function commitDate(gitArgs, commit) {
  try {
    return git([...gitArgs, 'show', '-s', '--format=%ci', commit]).trim() || null;
  } catch {
    return null;
  }
}

function textAtRef(gitArgs, ref, path) {
  try {
    return git([...gitArgs, 'show', `${ref}:${path}`]);
  } catch {
    return null;
  }
}

// The global release the artefact's global entries pin: the requirements
// document's own `Global:` line, or the line of the requirements document a
// story or a design traces to, read on the trunk. `{ tag, commit }`, or null
// after a finding or a cannot-verify was recorded.
function releaseOf(report, gitArgs, text) {
  const { kind, slug } = report.artefact;
  const where = 'the artefact carries a global entry, and';
  if (kind === ARTEFACT_KINDS.requirements || kind === ARTEFACT_KINDS.other) {
    const release = recordedRelease(text);
    if (release === null) report.findings.push(`${where} the artefact ${kind === ARTEFACT_KINDS.other ? 'carries no Global: line, or records "Global: none"' : 'records "Global: none"'}, so no global release can be read`);
    else if (release === false) report.findings.push(`${where} the artefact carries no single "Global: vX.Y.Z <40-hex>" line`);
    return release || null;
  }
  if (report.trunk.head === null) return null; // already a cannot-verify
  let documentSlug = slug;
  if (documentSlug === null) {
    const named = designKey(text);
    if (named.finding) {
      report.findings.push(`${where} ${named.finding}, so its requirements document cannot be found`);
      return null;
    }
    let items = [];
    try {
      items = git([...gitArgs, 'ls-tree', '-r', '--name-only', report.trunk.ref, '--', BACKLOG_DIR]).split('\n')
        .filter((p) => p.split('/').length === 4 && p.endsWith(`/${named.key}${ITEM_SUFFIX}`));
    } catch {
      items = [];
    }
    if (items.length !== 1) {
      report.cannot.push(`${where} ${items.length} work items ${named.key}${ITEM_SUFFIX} are under ${BACKLOG_DIR}/ on the hub's trunk, so its requirements document cannot be found`); report.reason = report.reason || 'file-unreadable';
      return null;
    }
    documentSlug = items[0].split('/')[2];
  }
  const req = KINDS['requirements-document'];
  const path = `${req.folder}/${documentSlug}/${req.file}`;
  const documentText = textAtRef(gitArgs, report.trunk.ref, path);
  if (documentText === null) {
    report.cannot.push(`${where} ${path} is not on the hub's trunk (${report.trunk.ref}), so no global release can be read`); report.reason = report.reason || 'global-missing';
    return null;
  }
  const release = recordedRelease(documentText);
  if (release === null || release === false) {
    report.findings.push(`${where} ${path} ${release === null ? 'records "Global: none"' : 'carries no single "Global: vX.Y.Z <40-hex>" line'}, so no global release can be read`);
    return null;
  }
  return release;
}

// The kind, revision and status of the hub document a pinned blob holds, read
// from the bytes at the hub commit. A requirements document is read with the
// review beside it at that commit and the trunk's copy, as the index reads it.
function describeHubBlob(root, gitArgs, hubAt, path, blob) {
  const req = KINDS['requirements-document'];
  const parts = path.split('/');
  if (parts.length === 4 && `${parts[0]}/${parts[1]}` === req.folder && parts[3] === req.file) {
    const bytes = git([...gitArgs, 'cat-file', 'blob', blob], { encoding: null });
    const review = textAtRef(gitArgs, hubAt, `${req.folder}/${parts[2]}/${REVIEW_FILE}`);
    const doc = parseRequirementsDocument(path, bytes, parts[2], review, trunkBlob(root, path, trunkRef()));
    return { kind: doc.kind, revision: doc.revision, status: doc.status };
  }
  const doc = parseDocument(path, blobText(gitArgs, blob), Object.keys(KINDS));
  if (doc.findings.length) return { kind: doc.kind === null ? 'malformed' : doc.kind, revision: doc.revision, status: doc.status === undefined ? null : doc.status };
  return { kind: doc.kind, revision: doc.revision, status: doc.status === undefined ? null : doc.status };
}

/**
 * The report of one artefact: `{ artefact, trunk, hubCommit, release, context,
 * rows, findings, cannot }`. `findings` are what the artefact gets wrong (exit
 * 1); `cannot` is what the hub at `root` cannot answer (exit 2). Every rule
 * runs before returning, so one report lists everything.
 *
 * Each row is one `Context:` entry: `{ id, path, layer, pin, kind, revision,
 * status, held, trunk }`. `layer` is `hub`, `global` or the spoke's id. `held`
 * is the hub commit's short form and date for a hub entry the commit holds,
 * `release` for a global entry at the recorded release, and null otherwise.
 * `trunk` is `current`, `drift: <pin> → <now>`, `drift: <pin> → removed`, or
 * null where the trunk was not compared.
 */
export function contextReport({ root = '.', path, text, trunk = trunkRef() }) {
  const gitArgs = ['-C', root];
  const report = {
    artefact: { path, ...artefactKind(path, text) },
    trunk: { ref: trunk, head: null },
    hubCommit: { value: null, commit: null, date: null, onTrunk: null },
    release: null,
    context: { value: null, entries: [] },
    rows: [],
    findings: [],
    cannot: [],
  };
  report.trunk.head = revParse(gitArgs, `${trunk}^{commit}`);
  if (report.trunk.head === null) {
    report.cannot.push(`${trunk} cannot be read from the hub at ${root}; the report compares every pin with the trunk, and reads it as a local ref, never fetched. Run it in a clone of the hub whose origin is the hub`); report.reason = report.reason || 'trunk-missing';
  }

  const parsed = parseContextLine(text);
  report.context = { value: parsed.value, entries: parsed.entries };
  report.findings.push(...parsed.findings);

  const line = parseHubCommitLine(text);
  report.findings.push(...line.findings);
  report.hubCommit.value = line.value;
  let hubAt = null;
  if (line.commit !== null) {
    const known = revParse(gitArgs, `${line.commit}^{commit}`);
    if (known === null) {
      if (isShallow(gitArgs)) {
        report.cannot.push(`the ${HUB_COMMIT_LABEL}: line names ${short(line.commit)}, a commit this clone cannot see, and this clone is shallow, so the report cannot tell a commit off the trunk from one beyond its depth; fetch full history (fetch-depth: 0) and run again`);
        report.reason = report.reason || 'shallow-clone';
      } else report.findings.push(`the ${HUB_COMMIT_LABEL}: line names a commit the hub does not hold, ${short(line.commit)}; the artefact was written against a hub nobody merged. Re-run scripts/read-context.mjs on an up-to-date trunk, copy the ${HUB_COMMIT_LABEL}: and Context: lines it prints, and amend the artefact by pull request with a human, with a fresh review`);
    } else {
      report.hubCommit.commit = line.commit;
      report.hubCommit.date = commitDate(gitArgs, line.commit);
      if (report.trunk.head !== null) {
        let onTrunk = false;
        try {
          git([...gitArgs, 'merge-base', '--is-ancestor', line.commit, report.trunk.head]);
          onTrunk = true;
        } catch {
          onTrunk = false;
        }
        report.hubCommit.onTrunk = onTrunk;
        if (onTrunk) hubAt = line.commit;
        else report.findings.push(`the ${HUB_COMMIT_LABEL}: line names a commit that is not on ${trunk}, ${short(line.commit)}; the artefact was written against a hub nobody merged. Re-run scripts/read-context.mjs on an up-to-date trunk, copy the ${HUB_COMMIT_LABEL}: and Context: lines it prints, and amend the artefact by pull request with a human, with a fresh review`);
      }
    }
  }

  const globalEntries = parsed.entries.filter((e) => e.global);
  if (globalEntries.length) report.release = releaseOf(report, gitArgs, text);

  for (const e of parsed.entries) {
    const row = { id: e.id, path: e.path, layer: e.global ? GLOBAL : e.repository === null ? HUB : e.repository, pin: e.pin, kind: null, revision: null, status: null, held: null, trunk: null };
    if (e.global) {
      row.kind = e.id.startsWith(`${GLOBAL_PREFIX}${STD_PREFIX}`) ? 'standard' : e.id.match(/^global\.EXC-/) ? 'exception' : 'adr';
      if (report.release !== null) {
        if (report.release.commit.startsWith(e.pin)) row.held = { release: report.release.tag, commit: report.release.commit };
        else report.findings.push(`"${e.id}" pins ${e.pin}, and the Global: line records ${short(report.release.commit)}; a global entry pins the commit on that line, so the two were not written from one release. Re-run scripts/read-context.mjs with --global <that commit> and copy the lines it prints`);
      }
    } else if (e.repository !== null) {
      row.kind = 'not read here';
    } else if (hubAt !== null) {
      const blob = headBlob(gitArgs, hubAt, e.path);
      if (blob !== null && blob.startsWith(e.pin)) {
        row.held = { commit: hubAt, date: report.hubCommit.date };
        Object.assign(row, describeHubBlob(root, gitArgs, hubAt, e.path, blob));
      } else {
        report.findings.push(`"${e.id}" pins ${e.pin} for ${e.path}, and the hub at ${short(hubAt)}, the commit the ${HUB_COMMIT_LABEL}: line names, ${blob === null ? 'has no file there' : `holds ${blob.slice(0, CONTEXT_PIN)} there`}; the two lines were not copied from one run. Re-run scripts/read-context.mjs on an up-to-date trunk, copy the ${HUB_COMMIT_LABEL}: and Context: lines it prints, and amend the artefact by pull request with a human, with a fresh review`);
      }
      if (report.trunk.head !== null) {
        const now = headBlob(gitArgs, report.trunk.head, e.path);
        row.trunk = now === null ? `drift: ${e.pin} → removed` : now.startsWith(e.pin) ? 'current' : `drift: ${e.pin} → ${now.slice(0, CONTEXT_PIN)}`;
      }
    } else if (report.trunk.head !== null) {
      // No hub commit to place the entry at. The trunk is still compared, so a
      // person sees the drift beside the finding.
      const now = headBlob(gitArgs, report.trunk.head, e.path);
      row.trunk = now === null ? `drift: ${e.pin} → removed` : now.startsWith(e.pin) ? 'current' : `drift: ${e.pin} → ${now.slice(0, CONTEXT_PIN)}`;
    }
    report.rows.push(row);
  }
  return report;
}

/** The exit code a report earns: 2 when the hub could not answer, else 1 on a finding, else 0. */
export function contextReportExit(report) {
  if (report.cannot.length) return EXIT.CANNOT_VERIFY;
  if (report.findings.length) return EXIT.FAIL;
  return EXIT.PASS;
}

const dateOf = (date) => (date === null ? 'date not read' : date);

/** The `Hub commit:` header line of a report. */
export function contextReportHubCommitLine(report) {
  const { value, commit, date, onTrunk } = report.hubCommit;
  if (value === null) return `${HUB_COMMIT_LABEL}: not read`;
  if (commit === null) return `${HUB_COMMIT_LABEL}: ${value} (not held by this hub)`;
  const place = onTrunk === null ? 'trunk not compared' : onTrunk ? 'on the trunk' : 'not on the trunk';
  return `${HUB_COMMIT_LABEL}: ${commit} (${short(commit)}, ${dateOf(date)}, ${place})`;
}

/** The one-line count of a report's rows: `Context: none`, or the documents by state. */
export function contextReportCountLine(report) {
  if (report.context.value === 'none') return 'Context: none';
  const rows = report.rows;
  if (!rows.length) return 'Context: not read';
  const global = rows.filter((r) => r.layer === GLOBAL).length;
  const spoke = rows.filter((r) => r.layer !== GLOBAL && r.layer !== HUB).length;
  const drift = rows.filter((r) => r.trunk !== null && r.trunk.startsWith('drift')).length;
  const current = rows.filter((r) => r.trunk === 'current').length;
  const parts = [`${current} current`, `${drift} drift`];
  if (global) parts.push(`${global} at the global release`);
  if (spoke) parts.push(`${spoke} in a spoke`);
  return `Context: ${rows.length} document(s): ${parts.join(', ')}`;
}

/** The `Status:` header line of a report. */
export function contextReportStatusLine(report) {
  if (report.cannot.length) return `Status: CANNOT VERIFY: ${report.cannot.length} reason(s)`;
  if (report.findings.length) return `Status: FAIL: ${report.findings.length} finding(s)`;
  return 'Status: READ';
}

/** The `Pin:` line of one row: where the pinned bytes are held. */
export function contextRowPinLine(row) {
  if (row.layer === GLOBAL) return `Pin: ${row.pin}${row.held === null ? ' · not placed: no global release to read' : ' · the commit of the global release'}`;
  if (row.layer !== HUB) return `Pin: ${row.pin}`;
  if (row.held === null) return `Pin: ${row.pin} · not placed: no hub commit to read`;
  return `Pin: ${row.pin} · held at ${short(row.held.commit)}, ${dateOf(row.held.date)}`;
}

/** The `Trunk:` line of one row: what the trunk holds now, against the pin. */
export function contextRowTrunkLine(row) {
  if (row.layer === GLOBAL) return 'Trunk: at the global release; a global commit never drifts';
  if (row.layer !== HUB) return `Trunk: not read here; scripts/read-context.mjs ${row.layer} --pinned reads the spoke`;
  return `Trunk: ${row.trunk === null ? 'not compared' : row.trunk}`;
}

/** The `Layer:` line of one row: its layer, kind, revision and status. */
export function contextRowMetaLine(row) {
  const meta = [`Layer: ${row.layer}`, `Kind: ${row.kind === null ? 'not read' : row.kind}`];
  if (row.layer === GLOBAL) meta.push(`Release: ${row.held === null ? 'not read' : `${row.held.release} at ${short(row.held.commit)}`}`);
  else if (row.layer === HUB && row.held !== null) {
    meta.push(`Revision: ${row.revision === null ? 'none recorded' : row.revision}`);
    if (row.status !== null) meta.push(`Status: ${row.status}`);
  }
  return meta.join(' · ');
}

/**
 * One row as a single line, for a place that holds one line per document, as
 * a mirrored issue's description does: the id, the kind, the path, the pin and
 * where the trunk stands.
 */
export function contextRowLine(row) {
  const where = row.layer === GLOBAL
    ? (row.held === null ? 'release not read' : `release ${row.held.release}`)
    : row.layer !== HUB ? `in ${row.layer}, not read here`
      : row.trunk === null ? 'trunk not compared' : row.trunk;
  const kind = row.kind === null ? 'not read' : row.kind;
  return `- ${row.id} · ${kind} · ${row.path} · pin ${row.pin} · ${where}`;
}

/** The whole report as the lines report-context.mjs prints to stdout. */
export function contextReportLines(report) {
  const lines = [
    `Artefact: ${report.artefact.path}`,
    `Kind: ${report.artefact.kind}`,
    `Trunk: ${report.trunk.ref}${report.trunk.head === null ? ' not read' : ` at ${report.trunk.head}`}`,
    contextReportHubCommitLine(report),
    ...(report.release === null ? [] : [`Global: ${report.release.tag} ${report.release.commit}`]),
    contextReportCountLine(report),
    contextReportStatusLine(report),
  ];
  for (const row of report.rows) {
    lines.push('---', `Document: ${row.id}`, contextRowMetaLine(row), `Path: ${row.path}`, contextRowPinLine(row), contextRowTrunkLine(row));
  }
  if (!report.rows.length) lines.push('---');
  return lines;
}

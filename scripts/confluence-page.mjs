// Part of the harness asset library c6f3b4427d58f7c3 (see VERSION.json) · 2026-11-25
/**
 * confluence-page.mjs — one Confluence page, read as a record, and the harness summary written from it.
 *
 * Shared by `confluence-sync.mjs`. Not a command. Pure functions: no network, no file, no git.
 * Node standard library only.
 *
 * Two sets of templates meet here:
 *   - the Confluence templates, the pages an author writes from: the ADR template and
 *     Template - Standard (R-10, R-12). This file reads a page by them;
 *   - the harness templates, docs/architecture/_TEMPLATE.adr.md and docs/standards/_TEMPLATE.standard.md
 *     in an installed hub. This file writes the summary in their form, so check-context.mjs parses it.
 *
 * The page's body is Atlassian Document Format (ADF), the JSON tree Confluence's v2 API returns.
 *
 * What the requirements fix (PLDC-712), and where:
 *   - the id from the title: ADR-NNN, or the std-<topic> token (R-02);
 *   - a page with no id, owner, decision (a standard: summary) or readable status is skipped (R-03);
 *   - the status: Approved, Accepted and Solved bind, compared without regard to case (R-06, R-07);
 *     a title with Obsolete, Superseded, Rejected or no longer approved demotes (R-08, R-09);
 *   - the template: Rules and Applies to, a first Decision sentence of 200 characters or fewer, and
 *     no section the template does not have (R-10, R-11);
 *   - a standard: its header's Summary gives the description, its Scope boxes give the globs, its
 *     "In words" line gives Applies to, Contact and Links are never copied, the Values column
 *     "For" becomes "Applies to", and every rule carries std-<topic>.NN (R-12);
 *   - the block "How to write this page" left on a page makes it "needs reformatting";
 *   - the mapping of the page's sections to the summary's (§7.1).
 */

import { DESCRIPTION_MAX } from './context-docs.mjs';

/* ------------------------------------------------------------------ the two Confluence templates */

/** The fields of a page's header: "Label: value" lines in a paragraph, or a two-column table. */
export const ADR_FIELDS = ['Status', 'Date', 'Owner', 'Decided by'];
/** Contact names the person to ask today. It is read so it is known, and never copied. */
export const STANDARD_FIELDS = ['Status', 'Date', 'Owner', 'Contact', 'Decided by', 'Summary'];

/** The ADR template's sections, in its order. Three must be present (R-10). */
export const ADR_SECTIONS = ['Context', 'Decision', 'Rules', 'Applies to', 'Options considered', 'Consequences', 'Links'];
export const ADR_REQUIRED = ['Decision', 'Rules', 'Applies to'];

/**
 * Template - Standard mirrors the harness standard template (R-12): its nine sections, then Links,
 * which is never copied, because the harness template has nine sections and no tenth.
 */
export const STANDARD_SECTIONS = ['Applies to', 'Must', 'Should', 'Values', 'Checked by', 'Relations', 'Exceptions', 'Unresolved', 'Origin', 'Links'];
export const STANDARD_REQUIRED = ['Applies to', 'Must'];
export const STANDARD_COPIED = STANDARD_SECTIONS.filter((s) => s !== 'Links');

/**
 * The Scope boxes under a standard's Applies to, and the globs each gives. Two boxes stand alone:
 * "All code" binds every design (alwaysApply), and "Only when a design asks for this rule explicitly"
 * binds only a design that names the standard (globs []). A language maps by its file extension.
 * Every other box maps through the `scopes` table of docs/estate/confluence.json, because its paths
 * differ from one estate to the next. "Other:" adds the paths written after it, as written.
 */
export const SCOPE_ALL = /^all code$/i;
export const SCOPE_NAMED = /^only when\b/i;
export const SCOPE_OTHER = /^other\s*:?\s*/i;
export const SCOPE_LANGUAGES = {
  python: ['**/*.py'],
  typescript: ['**/*.ts', '**/*.tsx'],
  java: ['**/*.java'],
  go: ['**/*.go'],
};

/** The block that guides an author, which the author deletes before publishing. */
const HOW_TO = /^how to write this page/i;

/** The statuses that bind (R-06). */
export const APPROVED = ['approved', 'accepted', 'solved'];

/* ------------------------------------------------------------------ ADF to text and Markdown */

const BLOCK_TEXT = new Set(['paragraph', 'heading', 'listItem', 'tableRow', 'codeBlock', 'blockquote', 'panel']);

/** Plain text. A hard break and the end of a block are a newline. */
export function plain(node) {
  if (!node) return '';
  if (Array.isArray(node)) return node.map(plain).join('');
  switch (node.type) {
    case 'text': return node.text || '';
    case 'hardBreak': return '\n';
    case 'status': return (node.attrs && node.attrs.text) || '';
    case 'mention': return ((node.attrs && node.attrs.text) || '').replace(/^@/, '');
    case 'emoji': return (node.attrs && (node.attrs.text || node.attrs.shortName)) || '';
    case 'date': return isoDate(node.attrs && node.attrs.timestamp);
    case 'inlineCard': return (node.attrs && node.attrs.url) || '';
    case 'tableCell': case 'tableHeader': return `${(node.content || []).map(plain).join(' ').trim()}\t`;
    default: {
      const inner = (node.content || []).map(plain).join('');
      return BLOCK_TEXT.has(node.type) ? `${inner}\n` : inner;
    }
  }
}

const isoDate = (ms) => { const d = new Date(Number(ms)); return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10); };

/** Text with its spaces folded, and at most one blank line in a row. */
export const tidy = (s) => String(s).replace(/ /g, ' ').replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();

/** One line: every run of white space, newlines included, is one space. */
export const oneLine = (s) => String(s).replace(/\s+/g, ' ').trim();

/** Markdown for a list of block nodes. */
export function markdown(nodes) {
  return (nodes || []).map(block).filter((s) => s !== '').join('\n\n');
}

function block(n) {
  const kids = n.content || [];
  switch (n.type) {
    case 'paragraph': return inline(kids).trim();
    case 'heading': return `**${inline(kids).trim()}**`;
    case 'bulletList': return kids.map((li) => `- ${indent(markdown(li.content))}`).join('\n');
    case 'orderedList': return kids.map((li, i) => `${((n.attrs && n.attrs.order) || 1) + i}. ${indent(markdown(li.content))}`).join('\n');
    case 'taskList': return kids.map((t) => `- [${t.attrs && t.attrs.state === 'DONE' ? 'x' : ' '}] ${inline(t.content || [])}`).join('\n');
    case 'decisionList': return kids.map((d) => `- ${inline(d.content || [])}`).join('\n');
    case 'blockquote': case 'panel': return markdown(kids).split('\n').map((l) => `> ${l}`).join('\n');
    case 'codeBlock': return `\`\`\`${(n.attrs && n.attrs.language) || ''}\n${kids.map((t) => t.text || '').join('')}\n\`\`\``;
    case 'rule': return '';
    case 'table': return table(n);
    case 'expand': case 'nestedExpand': case 'layoutSection': case 'layoutColumn': case 'bodiedExtension': return markdown(kids);
    case 'extension': case 'mediaSingle': case 'mediaGroup': return '';
    case 'blockCard': case 'embedCard': return (n.attrs && n.attrs.url) || '';
    default: return kids.length ? markdown(kids) : '';
  }
}

const indent = (s) => s.split('\n').join('\n  ');

/** The rows of a table, each a list of cells as one line of Markdown. */
export function rows(tableNode) {
  return (tableNode.content || []).map((r) => (r.content || []).map((c) => oneLine(markdown(c.content))));
}

function table(n) {
  const r = rows(n).map((cells) => cells.map((c) => c.replace(/\|/g, '\\|')));
  if (!r.length) return '';
  const width = Math.max(...r.map((x) => x.length));
  const line = (x) => `| ${Array.from({ length: width }, (_, i) => x[i] ?? '').join(' | ')} |`;
  return [line(r[0]), `|${' --- |'.repeat(width)}`, ...r.slice(1).map(line)].join('\n');
}

function inline(nodes) {
  return (nodes || []).map((n) => {
    switch (n.type) {
      case 'text': return marks(n.text || '', n.marks || []);
      case 'hardBreak': return '\n';
      case 'status': return (n.attrs && n.attrs.text) || '';
      case 'mention': return ((n.attrs && n.attrs.text) || '').replace(/^@/, '');
      case 'emoji': return (n.attrs && (n.attrs.text || n.attrs.shortName)) || '';
      case 'date': return isoDate(n.attrs && n.attrs.timestamp);
      case 'inlineCard': return (n.attrs && n.attrs.url) || '';
      default: return n.content ? inline(n.content) : '';
    }
  }).join('');
}

function marks(text, ms) {
  if (!text.trim()) return text;
  let t = text;
  for (const m of ms) {
    if (m.type === 'code') t = `\`${t}\``;
    else if (m.type === 'strong') t = `**${t}**`;
    else if (m.type === 'em') t = `_${t}_`;
    else if (m.type === 'strike') t = `~~${t}~~`;
  }
  const link = ms.find((m) => m.type === 'link');
  return link && link.attrs && link.attrs.href ? `[${t}](${link.attrs.href})` : t;
}

/* ------------------------------------------------------------------ the page's parts */

/**
 * The header fields and the sections of a page. The header is everything before the first section
 * heading. A level-1 heading at the very top repeats the title and is skipped. Every heading of
 * level 1 or 2 opens a section. A deeper heading belongs to the section it sits in.
 */
export function readParts(adf, fields, sectionNames = []) {
  // A heading names a template section whatever its case: "applies to" is "Applies to".
  const canonical = (name) => sectionNames.find((s) => s.toLowerCase() === name.toLowerCase()) || name;
  const header = {};
  const sections = new Map();
  const order = [];
  let current = null;
  let sawContent = false;
  for (const b of (adf && adf.content) || []) {
    if (b.type === 'heading' && ((b.attrs && b.attrs.level) || 1) <= 2) {
      if (!sawContent && current === null && ((b.attrs && b.attrs.level) || 1) === 1) { sawContent = true; continue; }
      current = canonical(oneLine(plain(b)));
      order.push(current);
      if (!sections.has(current)) sections.set(current, []);
      continue;
    }
    sawContent = true;
    if (current === null) readHeader(b, fields, header);
    else sections.get(current).push(b);
  }
  return { header, sections, order };
}

// The cells of a table as plain text. A value keeps every character, so a path such as
// services/**/api/** survives: bold in a cell is a mark, never asterisks.
const plainRows = (tableNode) => (tableNode.content || []).map((r) => (r.content || []).map((c) => oneLine(plain(c.content || []))));

function readHeader(b, fields, header) {
  const put = (label, value) => {
    const key = fields.find((f) => f.toLowerCase() === String(label).replace(/[*:]/g, '').trim().toLowerCase());
    if (key && !(key in header)) header[key] = oneLine(value);
  };
  if (b.type === 'table') for (const r of plainRows(b)) { if (r.length >= 2) put(r[0], r[1]); }
  if (b.type === 'paragraph') {
    // "Status: value", "**Status:** value", or the template's own "**Status: **value", typed as text.
    for (const line of plain(b).split('\n')) {
      const m = line.match(/^\s*(?:\*\*)?\s*([A-Za-z][A-Za-z ]*?)\s*:\s*(?:\*\*)?\s*(.*)$/);
      if (m) put(m[1], m[2]);
    }
  }
}

/** The text of a section, or '' when the page has none. */
const sectionText = (parts, name) => tidy(plain(parts.sections.get(name) || []));

/** The first sentence of a text: up to the first ".", "!" or "?" before a space or the end. */
export function firstSentence(text) {
  const t = oneLine(text);
  const m = t.match(/^(.+?[.!?])(?:\s|$)/);
  return m ? m[1] : t;
}

/**
 * An ADR's Applies to: paths, "whole estate" or "None", as the summary's globs and alwaysApply (§7.1). Null when the text
 * is none of the three: each item must be one path, with "/", "*" or "." in it, one to a line or
 * separated by commas.
 */
export function globsOf(text) {
  const t = oneLine(String(text).replace(/^[-*]\s+/gm, '')).replace(/\.$/, '');
  if (t.match(/^none$/i)) return { globs: [], alwaysApply: false };
  if (t.match(/^whole estate$/i)) return { globs: [], alwaysApply: true };
  const items = String(text).split(/[,;\n]+/).map((s) => s.replace(/^\s*[-*]\s+/, '').replace(/[`'"]/g, '').trim().replace(/\.$/, '')).filter(Boolean);
  if (!items.length) return null;
  for (const i of items) if (i.match(/\s/) || !i.match(/[/*.]/) || i.match(/^https?:/i)) return null;
  return { globs: [...new Set(items)], alwaysApply: false };
}

/* ------------------------------------------------------------------ the id (R-02) */

const ADR_IN_TITLE = /\b(ADR)-(\d{3,})\b/i;
const STD_IN_TITLE = /\b(std-[a-z0-9]+(?:-[a-z0-9]+)*)\b/i;
const OBSOLETE = /\bobsolete\b/i;

/**
 * The record a title names. `kind` is the folder's: 'adr' or 'standard'. Null when the title carries no
 * id of that kind. The sync never invents an id.
 */
export function recordOf(title, kind) {
  const t = String(title || '');
  const obsolete = Boolean(t.match(OBSOLETE));
  if (kind === 'adr') {
    const m = t.match(ADR_IN_TITLE);
    if (!m) return null;
    const id = `ADR-${m[2]}`;
    const after = t.slice(m.index + m[0].length).replace(/^\s*[:–—-]\s*/, '');
    return { kind, id, obsolete, heading: oneLine(after.replace(/\(\s*obsolete\s*\)/ig, '')) };
  }
  const m = t.match(STD_IN_TITLE);
  if (!m) return null;
  const id = m[1].toLowerCase();
  const after = t.slice(m.index + m[0].length).replace(/^\s*[:–—-]\s*/, '');
  return { kind, id, obsolete, heading: oneLine(after.replace(/\(\s*obsolete\s*\)/ig, '')) };
}

/* ------------------------------------------------------------------ the status (R-06 to R-09) */

/**
 * What a status means for the summary.
 *   binds:  the summary is written in full, with `status` (Accepted, Active or Reserved)
 *   retire: an existing summary keeps its file and only its status line changes; no new file
 *   none:   never approved; no file. An existing summary is retired as no longer approved
 * `listed` is true where the requirements list the record (the "Deprecated, listed" rows).
 */
export function statusOf(kind, statusText, obsolete) {
  const s = oneLine(statusText).replace(/[.!]$/, '');
  const low = s.toLowerCase();
  if (obsolete) return { effect: 'retire', status: 'Deprecated', listed: true, why: 'the title says Obsolete (R-08)' };
  if (APPROVED.includes(low)) return { effect: 'binds', status: kind === 'adr' ? 'Accepted' : 'Active', listed: false, why: `status ${s}` };
  if (kind === 'standard' && low === 'reserved') return { effect: 'binds', status: 'Reserved', listed: false, why: 'status Reserved (R-09)' };
  const by = s.match(/^superseded\s+by\s+((?:global\.)?)(ADR-\d{3,})$/i);
  if (by) {
    return kind === 'adr'
      ? { effect: 'retire', status: `Superseded by ${by[1].toLowerCase()}${by[2].toUpperCase()}`, listed: false, why: `status ${s} (R-08)` }
      : { effect: 'retire', status: 'Deprecated', listed: false, why: `status ${s} (R-09)` };
  }
  if (low === 'superseded' || low === 'rejected' || low === 'obsolete') return { effect: 'retire', status: 'Deprecated', listed: true, why: `status ${s} (R-08, R-09)` };
  return { effect: 'none', status: null, listed: false, why: `status ${s || '(none)'} is not approved (R-06)` };
}

/** The status an existing summary takes when its page is no longer approved, archived or deleted (R-08). */
export const NO_LONGER = { effect: 'retire', status: 'Deprecated', listed: true };

/* ------------------------------------------------------------------ one page, judged */

/**
 * Read one page as a record of the kind its folder gives.
 * Returns { record, header, parts, status, unreadable[], reformat[] }:
 *   record      { kind, id, heading, obsolete } or null (no id: R-02, R-03)
 *   unreadable  why R-03 skips the page: no owner, no decision or summary, no readable status
 *   reformat    why the page does not follow its template (R-10, R-11, R-12, Q2)
 */
export function judge({ title, adf, kind, scopes = {} }) {
  const fields = kind === 'adr' ? ADR_FIELDS : STANDARD_FIELDS;
  const parts = readParts(adf, fields, kind === 'adr' ? ADR_SECTIONS : STANDARD_SECTIONS);
  const record = recordOf(title, kind);
  const unreadable = [];
  const reformat = [];
  if (!record) return { record, header: parts.header, parts, status: null, unreadable: [`the title names no ${kind === 'adr' ? 'ADR-NNN' : 'std-<topic>'} (R-02)`], reformat };
  if (hasHowTo(adf)) reformat.push('the block "How to write this page" is still on the page; the author deletes it before publishing');
  if ((parts.header.Owner || '').includes('|')) reformat.push('Owner holds more than one value; keep one');

  const owner = parts.header.Owner || '';
  if (!owner || isBlank(owner)) unreadable.push('no owner (R-03)');
  const statusText = parts.header.Status || '';
  if (!statusText || isBlank(statusText)) unreadable.push('no readable status (R-03)');
  if (kind === 'adr') {
    if (!sectionText(parts, 'Decision')) unreadable.push('no decision (R-03)');
  } else if (!parts.header.Summary || isBlank(parts.header.Summary)) unreadable.push('no summary (R-03)');

  const sections = kind === 'adr' ? ADR_SECTIONS : STANDARD_SECTIONS;
  const required = kind === 'adr' ? ADR_REQUIRED : STANDARD_REQUIRED;
  for (const s of required) if (!parts.sections.has(s)) reformat.push(`no "${s}" section (R-10)`);
  const extra = parts.order.filter((s) => !sections.includes(s));
  if (extra.length) reformat.push(`sections the template does not have: ${extra.map((s) => `"${s}"`).join(', ')}`);
  const twice = parts.order.filter((s, i) => parts.order.indexOf(s) !== i);
  if (twice.length) reformat.push(`a section appears twice: ${[...new Set(twice)].map((s) => `"${s}"`).join(', ')}`);

  if (kind === 'adr') {
    const decision = sectionText(parts, 'Decision');
    if (decision && firstSentence(decision).length > DESCRIPTION_MAX) reformat.push(`the first Decision sentence has ${firstSentence(decision).length} characters, and ${DESCRIPTION_MAX} is the most (R-10)`);
    if (parts.sections.has('Applies to') && !globsOf(sectionText(parts, 'Applies to'))) reformat.push('Applies to holds neither paths, "whole estate" nor "None" (R-10)');
    if (parts.sections.has('Rules') && !ruleLines(parts.sections.get('Rules')).some((l) => l.replace(/[*_]/g, '').match(/^MUST\b/))) reformat.push('Rules holds no MUST or MUST NOT line (R-10)');
  } else {
    const summary = parts.header.Summary || '';
    if (summary && summary.length > DESCRIPTION_MAX) reformat.push(`Summary has ${summary.length} characters, and ${DESCRIPTION_MAX} is the most`);
    if (parts.sections.has('Applies to')) {
      reformat.push(...scopeOf(parts, scopes).problems);
      if (isBlank(inWordsOf(parts))) reformat.push('Applies to has no "In words:" line saying what the standard covers');
    }
    for (const name of ['Must', 'Should']) {
      for (const l of ruleLines(parts.sections.get(name) || [])) {
        const r = standardRule(l);
        if (!r) reformat.push(`a rule under ${name} does not open with ${record.id}.NN and a keyword: "${l.slice(0, 60)}" (R-12)`);
        else if (r.id !== record.id) reformat.push(`rule ${r.id}.${r.nn} carries another standard's id (R-12)`);
        else if (!(name === 'Must' ? r.keyword.startsWith('MUST') : r.keyword.startsWith('SHOULD'))) reformat.push(`rule ${r.id}.${r.nn} says ${r.keyword} under ${name}`);
      }
    }
    if (!ruleLines(parts.sections.get('Must') || []).length && !ruleLines(parts.sections.get('Should') || []).length) reformat.push('the page carries no rule under Must or Should');
  }
  const scope = kind === 'standard' && parts.sections.has('Applies to') ? scopeOf(parts, scopes) : null;
  return { record, header: parts.header, parts, scope, status: statusText ? statusOf(kind, statusText, record.obsolete) : null, unreadable, reformat };
}

/** True when the guidance block an author deletes before publishing is still on the page. */
function hasHowTo(node) {
  if (!node || typeof node !== 'object') return false;
  if ((node.type === 'expand' || node.type === 'nestedExpand') && String((node.attrs && node.attrs.title) || '').trim().match(HOW_TO)) return true;
  if ((node.type === 'paragraph' || node.type === 'heading') && oneLine(plain(node)).match(HOW_TO)) return true;
  return (node.content || []).some(hasHowTo);
}

/**
 * A standard's Scope boxes, as the summary's globs and alwaysApply.
 * Returns { globs, alwaysApply, ticked[], unmapped[], problems[] }. `unmapped` holds the ticked boxes
 * the scopes table gives no paths for: they are dropped, and the run lists them. `problems` make
 * the page "needs reformatting": no box ticked, a box that must stand alone ticked with others,
 * or "Other" ticked with no paths.
 */
export function scopeOf(parts, scopes = {}) {
  const blocks = parts.sections.get('Applies to') || [];
  const ticked = [];
  for (const b of blocks) {
    if (b.type !== 'taskList') continue;
    for (const item of b.content || []) {
      if (item.type !== 'taskItem' || !(item.attrs && item.attrs.state === 'DONE')) continue;
      ticked.push(tidy(plain(item.content || [])));
    }
  }
  const out = { globs: [], alwaysApply: false, ticked: ticked.map((t) => oneLine(t.split('\n')[0])), unmapped: [], problems: [] };
  if (!ticked.length) { out.problems.push('no Scope box is ticked under Applies to'); return out; }
  const labels = out.ticked;
  const alone = labels.filter((l) => l.match(SCOPE_ALL) || l.match(SCOPE_NAMED));
  if (alone.length && labels.length > 1) { out.problems.push(`"${alone[0]}" is ticked with other boxes; tick it alone`); return out; }
  if (labels[0].match(SCOPE_ALL)) { out.alwaysApply = true; return out; }
  if (labels[0].match(SCOPE_NAMED)) return out;
  const table = Object.fromEntries(Object.entries(scopes || {}).map(([k, v]) => [oneLine(k).toLowerCase(), v]));
  const globs = [];
  ticked.forEach((text, i) => {
    const label = labels[i];
    if (label.match(SCOPE_OTHER)) {
      const paths = text.replace(SCOPE_OTHER, '').split(/[,;\n]+/).map((s) => s.replace(/[`'"]/g, '').trim().replace(/\.$/, ''))
        .filter((s) => s && !s.match(/^\[.*\]$/));
      if (!paths.length || paths.some((p) => p.match(/\s/))) out.problems.push('"Other" is ticked with no paths after it, one per line');
      else globs.push(...paths);
      return;
    }
    const lang = SCOPE_LANGUAGES[label.toLowerCase()];
    const mapped = lang || table[label.toLowerCase()];
    if (Array.isArray(mapped) && mapped.length) globs.push(...mapped);
    else out.unmapped.push(label);
  });
  out.globs = [...new Set(globs)];
  return out;
}

/** The "In words" line under a standard's Applies to: the body of the summary's Applies to section. */
function inWordsOf(parts) {
  const blocks = (parts.sections.get('Applies to') || []).filter((b) => b.type !== 'taskList');
  for (const b of blocks) {
    const t = oneLine(plain(b));
    const m = t.match(/^in words\s*:\s*(.*)$/i);
    if (m) return m[1].trim();
  }
  const rest = blocks.filter((b) => !oneLine(plain(b)).match(/^scope\b/i));
  return oneLine(markdown(rest));
}

const isBlank = (v) => oneLine(v) === '' || Boolean(oneLine(v).match(/^\[.*\]$/));

/** One line for each list item of a section, as Markdown, without its bullet. */
function ruleLines(nodes) {
  const out = [];
  for (const b of nodes || []) {
    if (b.type !== 'bulletList' && b.type !== 'orderedList') continue;
    for (const li of b.content || []) {
      const first = (li.content || [])[0];
      const text = oneLine(first ? markdown([first]) : '');
      if (text) out.push(text);
    }
  }
  return out;
}

// "std-api-naming.01 MUST ...", with the id in bold or not.
function standardRule(line) {
  const m = line.match(/^\**\s*(std-[a-z0-9]+(?:-[a-z0-9]+)*)\.(\d{2,})\s*\**\s+(MUST NOT|MUST|SHOULD NOT|SHOULD)\s+(.+)$/);
  return m ? { id: m[1], nn: m[2], keyword: m[3], rest: m[4] } : null;
}

/* ------------------------------------------------------------------ the summary (§7.1) */

/**
 * A table cell set inside a sentence ("Not X, because Y."): its first letter is lowered only when the
 * cell reads as an ordinary phrase, so "Keep every engine" becomes "keep every engine". A first word
 * with another capital (MySQL, AWS) keeps its case, and so does a cell of one word, which is most often
 * a name (Kafka).
 */
export function inSentence(cell) {
  const words = String(cell).trim().split(/\s+/);
  const [first, second] = words;
  if (!first || !second || !first.match(/^[A-Z][a-z]+[,;:]?$/) || !second.match(/^[a-z]/)) return String(cell).trim();
  return first[0].toLowerCase() + String(cell).trim().slice(1);
}

/** The value the summary's origin key holds: the page URL and the page id (R-04). */
export const originOf = (url, pageId) => `${url} (Confluence page ${pageId})`;

/** The page id an origin value names, or null for a summary the sync did not write. */
export function pageIdOf(origin) {
  const m = String(origin || '').match(/\(Confluence page (\d+)\)\s*$/);
  return m ? m[1] : null;
}

/**
 * The summary file for a page that binds. `page` is { id, url, version }. `status` is the harness status.
 * Returns the text, in the harness template's form.
 */
export function summaryOf(judged, page, status) {
  const { record, parts, header } = judged;
  const sec = (name) => {
    const t = markdown(parts.sections.get(name) || []).trim();
    return t && oneLine(t) !== 'None' && oneLine(t) !== 'None.' ? t : 'None.';
  };
  const owner = oneLine(header.Owner);
  const head = (description, g) => [
    '---',
    `name: ${record.id}`,
    `description: ${oneLine(description)}`,
    `globs: ${JSON.stringify(g.globs)}`,
    `alwaysApply: ${g.alwaysApply}`,
    `kind: ${record.kind}`,
    `status: ${status}`,
    `owner: ${owner}`,
    `revision: ${page.version}`,
    `origin: ${originOf(page.url, page.id)}`,
    '---',
    '',
  ];

  if (record.kind === 'adr') {
    const description = firstSentence(sectionText(parts, 'Decision'));
    const g = globsOf(sectionText(parts, 'Applies to')) || { globs: [], alwaysApply: false };
    const heading = record.heading || description.replace(/[.!?]$/, '');
    const options = [];
    for (const b of parts.sections.get('Options considered') || []) {
      if (b.type !== 'table') continue;
      for (const [opt, why] of rows(b).slice(1)) if (opt) options.push(`- Not ${inSentence(opt.replace(/[.]$/, ''))}, because ${inSentence(String(why || '').replace(/[.]$/, ''))}.`);
    }
    const rejected = options.length ? options.join('\n') : sec('Options considered');
    return [
      ...head(description, g),
      `# ${record.id}: ${heading}`,
      '',
      '## Decision', '', sec('Decision'), '',
      '## Rules', '', sec('Rules'), '',
      '## Why', '', sec('Context'), '',
      '## Rejected', '', rejected, '',
      '## Accepted costs', '', sec('Consequences'), '',
    ].join('\n');
  }

  const g = judged.scope || { globs: [], alwaysApply: false };
  const rules = (name) => {
    const lines = ruleLines(parts.sections.get(name) || []).map(standardRule).filter(Boolean)
      .map((r) => `- **${r.id}.${r.nn}** ${r.keyword} ${r.rest}`);
    return lines.length ? lines.join('\n') : 'None.';
  };
  const origin = sec('Origin');
  // The Values table's column "For" is the harness template's "Applies to".
  const values = () => {
    const blocks = (parts.sections.get('Values') || []).map((b) => {
      if (b.type !== 'table' || !(b.content || []).length) return b;
      const [head, ...rest] = b.content;
      const renamed = { ...head, content: (head.content || []).map((c) => (oneLine(plain(c.content || [])).toLowerCase() === 'for' ? { ...c, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Applies to' }] }] } : c)) };
      return { ...b, content: [renamed, ...rest] };
    });
    const t = markdown(blocks).trim();
    return t && oneLine(t) !== 'None' && oneLine(t) !== 'None.' ? t : 'None.';
  };
  return [
    ...head(header.Summary, g),
    `# ${record.id}: ${record.heading || record.id}`,
    '',
    '## Applies to', '', inWordsOf(parts) || 'None.', '',
    '## Must', '', rules('Must'), '',
    '## Should', '', rules('Should'), '',
    '## Values', '', values(), '',
    '## Checked by', '', sec('Checked by'), '',
    '## Relations', '', sec('Relations'), '',
    '## Exceptions', '', sec('Exceptions'), '',
    '## Unresolved', '', sec('Unresolved'), '',
    '## Origin', '', origin === 'None.' ? `Confluence page ${page.id}, version ${page.version}: ${page.url}` : origin, '',
  ].join('\n');
}

/* ------------------------------------------------------------------ an existing summary */

/** The header of a summary on the trunk: { name, status, revision, origin, pageId }, from its frontmatter. */
export function headerOf(text) {
  const lines = String(text).split(/\r?\n/);
  const out = {};
  if (lines[0] !== '---') return out;
  for (let i = 1; i < lines.length && lines[i] !== '---'; i += 1) {
    const m = lines[i].match(/^([A-Za-z][A-Za-z0-9_-]*):[ \t]*(.*?)\s*$/);
    if (m && !(m[1] in out)) out[m[1]] = m[2];
  }
  out.pageId = pageIdOf(out.origin);
  return out;
}

/** The same summary with only its status line changed (R-08). */
export function withStatus(text, status) {
  const lines = String(text).split('\n');
  const close = lines.indexOf('---', 1);
  for (let i = 1; i < close; i += 1) {
    if (lines[i].match(/^status:/)) { lines[i] = `status: ${status}`; return lines.join('\n'); }
  }
  return text;
}

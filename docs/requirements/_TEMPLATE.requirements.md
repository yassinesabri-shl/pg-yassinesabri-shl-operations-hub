# \<Feature name>: \<one line stating what must become true>

<!--
  Requirements document template, v2.3 — the Feature Template shape.

  THIS FILE IS THE SWAPPABLE PART. It fixes the output format only: the section
  order, the headings, the table columns, the wording of the labels. This shape
  is the organisation's own Feature Template — Feature Name, Link to PRD
  Document, Feature Description, Feature Design and Brief, Feature Dependencies,
  Functional and Nonfunctional Requirements, Risks, Open Questions, Change Log —
  with the structures the harness reads moved into it and one heading added,
  Coverage of the sources. Installed as docs/requirements/_TEMPLATE.requirements.md.

  CHANGES FROM THE ORGANISATION'S TEMPLATE. They are listed here so that they
  travel with the template. A hub records its own changes to this file in
  docs/harness-decisions.md.
   - v2.0 — Coverage of the sources added as a tenth heading.
   - v2.0 — Open Questions widened from five columns to the eight-column
     clarification schema.
   - v2.0 — the Figma link demoted from its own field into a constraint row
     under Feature Design and Brief, because a committed design removes options
     rather than describing behaviour.
   - v2.0 — no sign-off block; release is the merge of the pull request, bound
     to a review file by content hash.
   - v2.0 — one Context: line under the Feature Name table, which
     check-requirements.js and check-decomposition.js read.
   - v2.0 — a Source column on Risks, because every statement cites a source.
   - v2.1 — one Global: line beside the Context: line, which
     check-requirements.js reads.
   - v2.2 — the Context: line carries global entries,
     id@12-hex:global:path, at the commit on the Global: line.
   - v2.3 — one Hub commit: line beside the Context: line, which
     check-requirements.js reads.

  WHAT DOES NOT MOVE is the method in .claude/skills/write-requirements/SKILL.md:
  read the whole source before writing; cite every statement; invent nothing the
  source does not support; observable criteria with stable identifiers and a
  negative case; a coverage map over the whole source; no priority, sequence or
  commercial decision; a review file beside the document that a script checks on
  the pull request. Keep those when you change the shape, or the shape is all
  that is left.

  Three readers. A business reader, who merges the pull request and is
  accountable for what the document says. The /decompose step, which cuts it into
  work items and cites it by section title and line range — so keep the section
  titles stable and keep one statement per line where a line will be cited. And
  scripts/check-requirements.js, which runs on the pull request and again on the
  trunk, and reads the structures below.

  FOUR STRUCTURES ARE NOT THE FORMAT'S TO CHANGE, because something downstream
  is written against each. They sit inside the organisation's sections here.
   - The identifier grammar under Functional and Nonfunctional Requirements:
     REQ-<n> and REQ-<n>.AC-<m>. /decompose and every design, test and
     validation report after it cite these numbers, and check-requirements.js
     reads exactly this: a heading whose first word is REQ-<n>, at any heading
     level, and beneath it one table whose first two columns are ID and
     Criterion, with one REQ-<n>.AC-<m> row per criterion. The index table
     above the headings is a summary; the headings are the requirements.
   - The Coverage of the sources table, over the whole source, with a
     disposition and an owner per part. It is what /feature's gate on unmapped
     source reads, and the critic's headline dimension.
   - The Open Questions table's eight-column clarification schema. The schema
     of record is CLAR-log.template.md and that file wins over this one.
   - The one Context: line under the Feature Name table, in the form
     scripts/read-context.mjs --hub prints it, with --global <commit> when the
     Global: line records a release. check-requirements.js reads it,
     and /decompose carries each entry into at least one story. Beside it, the
     one Hub commit: line, as the same run of scripts/read-context.mjs prints it,
     and the one Global: line, as scripts/read-global.mjs --resolve prints it.
  Everything else — the guidance under each heading, the Roles, Dependencies,
  Risks and Change Log tables, the labels — is the organisation's. Record any
  further change in docs/harness-decisions.md. .claude/commands/feature.md
  § The house format says the same thing for a reader who is choosing a format
  rather than filling one in.

  ROWS READ BY NAME. The Feature Name table carries four rows a script reads by
  label: Slug, Document revision, Date and Owning role. scripts/check-requirements.js
  compares the whole Slug cell to the folder name, literally; scripts/read-context.mjs
  prints the other three in the hub's index. Each cell holds its value ALONE:
  the slug in backticks, and nothing else in it — no citation, no note, no
  second value. A citation appended to the Slug cell fails the pull request
  after the critic has approved. Where a row of that table came from a source —
  the interview note that settled the slug or the role — the citation goes on
  the Derives from: line under the table, never in the cell.

  The Feature Name table names no repository, and neither does any other
  section. Which repositories a requirement touches is what /decompose finds,
  reading the repositories themselves; the person who answers the /feature
  interview is not asked it.

  Rules that are not negotiable, whatever format you move to:
   - REQ-<n> and REQ-<n>.AC-<m> identifiers are NEVER renumbered. Append, and mark
     a retired one DEPRECATED with its number intact. Downstream artefacts already
     cite them.
   - Every requirement and every criterion carries a source citation. An uncited
     statement is an invented one.
   - No placeholder cell anywhere: no dash, TBD, N/A, TODO, pending or ?. An
     unknown is written UNRESOLVED — <what>. Owner: <role>. Resolves: <trigger>.
     check-requirements.js reads every table on the page and refuses one. The
     one literal that is not a placeholder is NONE standing alone where a row
     calls for it.
   - Roles, never named individuals, in every Owner, Routed to and Author cell.
     A person leaves; the role still owns the decision.
   - No priority, sequence or commercial decision is originated here. Where the
     source or the owning role states one, it is recorded and cited. The
     Priority column records; it never decides.
   - No typed row releases this document. The review file beside it carries the
     verdict, bound to this document's content hash, and the merge of the pull
     request is the acceptance. Nothing in this document records either.

  Fill-in tokens are written \<like this>. The backslash keeps the raw template
  rendering as text in a markdown viewer, and it is part of the token: replace
  the whole token, backslash included, and leave none behind.
  scripts/check-requirements.js fails a token left anywhere on the page outside
  a code span, in a cell or in part of one. Delete this
  comment, and every other comment, once instantiated.
-->

## Feature Name

<!--
  State the concise, unambiguous name of the feature as it should appear across
  tickets, decks and conversations. Keep it short enough to use as a title
  everywhere it is referenced. It is the first row of this table and the first
  words of the title line above.

  The Slug cell holds the slug alone, in backticks -- kebab-case, two to five
  words, derived from the feature name, and the folder this file is filed
  under; /decompose reuses it. `| Slug | `payments-onboarding` |` passes and
  `| Slug | `payments-onboarding` (interview.md § note 3) |` fails the pull
  request. The Document revision here and the latest row of the Change Log
  agree. The rows of this table cite their notes on the Derives from: line
  below, once.

  The Context: line is copied whole from what scripts/read-context.mjs --hub --names
  printed for this run, with --global <commit> when the Global: line below records
  a release: the decision records, standards and earlier requirements documents
  that bear on the intent. Never typed. A hub entry, id@12-hex:path, is pinned to
  the bytes read. A global entry, id@12-hex:global:path, has an id that starts
  with "global.", and its pin is the first 12 characters of the commit on the
  Global: line. Each document on the line is used below, where it shapes a
  requirement: a decision record or a requirements document named by its id, a
  standard cited by the rule applied, std-<topic>.<NN>. A global document is used
  in the same way: global.ADR-<NNN> by its id, a global standard by its rule,
  global.std-<topic>.<NN>. A global exception, global.EXC-<NNN>, is named beside
  the record it departs from, and both are on the line. Every decision record and
  standard rule cited below is on the line. An always-on document needs no use,
  because scripts/read-context.mjs adds it to every line. scripts/check-requirements.js fails a
  missing line, an unused entry, an unlisted citation, and a global entry that
  does not hold at the recorded commit.

  The Hub commit: line is the one the same run of scripts/read-context.mjs
  printed: the 40-character commit of the hub's HEAD when the hub's documents
  were read. Copy the Hub commit: and Context: lines together, from one run.
  Never type them. The line places every hub entry in the hub's history.
  scripts/check-requirements.js fails a missing or doubled line, a value that is
  not a full commit hash, a commit the hub's trunk does not hold, and a commit
  that does not hold a hub entry's pinned bytes.

  The Global: line is the last line scripts/read-global.mjs --resolve printed for
  this run: the release of the global context repository the document was written
  against, "vX.Y.Z" and its 40-character commit, or "none" when the hub has no
  docs/estate/global.json. Never typed. The decomposition, the stories and the
  designs inherit it. Only an amendment the reviewer approves moves it, and only
  to a newer release. scripts/check-requirements.js fails a release on a hub with
  no global layer, "none" on a hub with one, a tag that is not a release tag, and
  a tag that moved or no longer exists.
-->

| Field | Value |
|---|---|
| Feature name | \<the short name> |
| Slug | `<slug>` |
| Document revision | r\<n> |
| Date | \2026-11-26 |
| Owning role | \<role — never a named individual> |
| Review | `requirements-review.md` — written beside this document by /feature, carrying the critic's verdict and `Document revision: <hash>` for this document's bytes |
| Source locator convention | note identifiers for `interview.md`; \<line ranges, timestamps or named headings> for each copied file — how citations in this document resolve |

Derives from: interview.md § note \<n> — \<the read-back, the owning role and the slug, each by the note that settled it>

Context: \<none | id@12-hex:path, global.id@12-hex:global:path — as scripts/read-context.mjs --hub --names printed it for this run, with --global and the commit on the Global: line when that line records a release>
Hub commit: \<40-hex — as the same run of scripts/read-context.mjs printed it, copied with the Context: line>

Global: \<none | vX.Y.Z 40-hex — the last line scripts/read-global.mjs --resolve printed for this run>

### Roles

<!-- Roles, never named individuals. The Routed to column of Open Questions and
     every Owner cell on this page name one of these. -->

| Role | Interest in this feature | Decisions they own |
|---|---|---|
| \<role> | \<what they need from it> | \<what only they can answer> |

## Link to PRD Document

<!--
  The full Product Requirements Document, and every other business input this
  document is written from, ranked before reading per CLAUDE.md §4.

  Business input that lives outside the repository is copied into the run
  folder, unchanged under the context header, before it is read, and the copy
  is what every citation resolves against — an external page is edited by
  people who have never heard of this document. Name the original and its
  revision here; cite the copy everywhere else. The link to the PRD stays in
  the Copied from column. The interview record is a source like the others:
  /feature wrote it, the person's words are its notes, and a requirement that
  came from an answer cites the note.

  Rank before reading, not after. The rank decides what happens when two
  sources disagree: the higher wins AND the disagreement becomes a row in Open
  Questions. Two sources at the same rank are not resolved here at all.
-->

| Source (the copy in this repository) | Copied from | Revision | Rank | What it contributed |
|---|---|---|---|---|
| `docs/requirements/<SLUG>/runs/<yyyymmdd_hhmm>/interview.md` | written here — the interview /feature ran with the \<owning role> | \<YYYY-MM-DD, the day of the run> | 5 — and it wins a conflict with any other rank-5 input, because the person was shown it and answered | \<the rows of Feature Name, the rows of Assumptions made, every answer carried into a requirement, every parked question in Open Questions> |
| `docs/requirements/<SLUG>/runs/<yyyymmdd_hhmm>/prd-<slug>.md` | \<the PRD's address — page, version history> | \<version, date or commit of the ORIGINAL> | 5 | \<the parts of this document derived from it, and where the interview overrode it> |
| \<a document already tracked in this repository, cited where it is> | \<its origin> | \<revision> | \<its rank in CLAUDE.md §4> | \<what it contributed> |

## Feature Description

<!--
  Describe in a few sentences what the feature does, who it is for and the
  problem it solves: what is true today, what should be true instead, and who
  is worse off until it is. Enough for a reader unfamiliar with the feature,
  written so a reader who joins in six months understands the situation
  without asking anyone. No solution, no technology, no component names.

  The out-of-scope list is load-bearing: it is what a reader uses to tell a
  deliberate exclusion from an oversight. Name the adjacent thing a reader will
  assume is included. An empty list is almost always wrong.

  Terms: only words this document uses in a narrower sense than ordinary usage,
  or that two sources use differently. A glossary of obvious words is padding.
  Delete the table if there are none.
-->

\<Two to four sentences.>

**The outcome this is judged by:** \<the observable change in the business, stated so that
someone could later say whether it happened>

**In scope** — each line citing the source that puts it in:

- \<capability or behaviour> — Derives from: \<source> § \<section title> L\<start>-\<end>
- \<capability or behaviour> — Derives from: \<source> § \<section title> L\<start>-\<end>

**Out of scope** — each line with the reason and the role who owns the exclusion:

- \<the adjacent thing a reader will assume is included> — \<reason>; owner: \<role>
- \<another> — \<reason>; owner: \<role>

**Terms used in a narrow sense:**

| Term | Definition as used here | Source |
|---|---|---|
| \<term> | \<the meaning this document relies on> | \<source> § \<section title> L\<n> |

## Feature Design and Brief

<!--
  Summarise the design intent and the key decisions in a short paragraph, and
  note the current design status (draft, in review or final) so readers know
  how stable it is. The Figma file is linked from the first constraint row.

  A design the business has already committed to removes options rather than
  describing behaviour, so it is a constraint, not a requirement: the
  underlying need is a REQ-<n> below and the stated solution is a row here,
  with its source. That split is what leaves the design step something to
  decide. The same table holds every other constraint — a regulatory
  obligation, a contractual commitment, a stated deadline. A constraint with
  no source is a preference, and a preference here is a design decision taken
  early by the wrong seat.
-->

\<Design intent, key decisions and the design status, in a short paragraph.>

| Constraint | Type | Source | Consequence if it does not hold |
|---|---|---|---|
| The screens follow the Figma file at \<link>, design status \<draft / in review / final> | stated solution | \<source> § \<section title> L\<n> | \<what breaks> |
| \<the constraint, one line> | regulatory / contractual / operational / stated solution | \<source> § \<section title> L\<n> | \<what breaks> |

## Feature Dependencies

<!-- Any other feature, system, team or external factor this feature relies on
     or blocks. Flag the ones that could affect timeline or scope so they are
     visible early. Each row cites the source that names the dependency. -->

| Dependency | Direction | Effect on this feature | Source |
|---|---|---|---|
| \<feature, system, team or external factor> | relies on / blocks | \<what changes if it moves> | \<source> § \<section title> L\<n> |

## Functional and Nonfunctional Requirements

<!--
  What the feature must do (functional) and the quality attributes it must
  meet, such as performance, security or reliability (nonfunctional). Each
  requirement is specific enough to be testable, and each carries its own
  acceptance criteria in its block below.

  The table is the index; the REQ-<n> blocks beneath it are the requirements,
  and check-requirements.js reads the blocks. One line per requirement in the
  table, with the same identifier as its heading.

  Priority is recorded, never decided here. The cell holds what the PRD or the
  owning role stated, cited in the Source column, or the UNRESOLVED marker.
  The writer never picks one.

  One REQ-<n> per behaviour: one thing that must be true, observable from
  outside the system, in the business's own terms. Two behaviours in one
  requirement cannot be accepted separately, and the split then happens
  downstream by somebody with less context.

  Every requirement carries its own criteria table. Criterion identifiers are
  REQ-<n>.AC-<m>, scoped to the requirement. At least one criterion per
  requirement is NEGATIVE — what must not happen, what must be rejected, what
  must fail closed, who must not see it. A set with no negative case describes
  the demonstration, not the system.

  Every threshold, window, volume and limit carries a value or an UNRESOLVED
  marker. A guessed number is worse than a marked gap, because the guess is
  testable and it will pass.
-->

| ID | Requirement | Type | Priority | Source |
|---|---|---|---|---|
| REQ-1 | \<one line stating what must be true> | Functional | \<as the source or the owning role stated it, cited in the Source column; or the UNRESOLVED marker with its owner and trigger> | \<source> § \<section title> L\<n> |
| REQ-2 | \<one line stating what must be true> | Nonfunctional | \<as stated, cited, or the UNRESOLVED marker> | \<source> § \<section title> L\<n> |

### REQ-1 — \<one line stating what must be true>

Derives from: \<source> § \<section title> L\<start>-\<end>

\<One or two sentences of the behaviour, in the business's terms. What, and for whom.
Not how.>

| ID | Criterion | Type | Source |
|---|---|---|---|
| REQ-1.AC-1 | \<one observable, testable statement> | positive | \<source> § \<section title> L\<n> |
| REQ-1.AC-2 | \<one observable, testable statement> | positive | \<source> § \<section title> L\<n> |
| REQ-1.AC-3 | \<what must NOT happen, or must be rejected, or must fail closed> | negative | \<source> § \<section title> L\<n> |

### REQ-2 — \<one line stating what must be true>

Derives from: \<source> § \<section title> L\<start>-\<end>

\<The behaviour.>

| ID | Criterion | Type | Source |
|---|---|---|---|
| REQ-2.AC-1 | \<observable statement> | positive | \<source> § \<section title> L\<n> |
| REQ-2.AC-2 | \<the negative case> | negative | \<source> § \<section title> L\<n> |
| REQ-2.AC-3 | Rejected input is refused within UNRESOLVED — the response-time limit is stated in no source. Owner: \<role>. Resolves: \<trigger>. | negative | \<source> § \<section title> L\<n> |

<!-- The third row above is the shape of a criterion with a genuinely undecided
     threshold. The criterion is still written; only the number is marked. -->

### REQ-3 — \<DEPRECATED — the one line it used to state, kept for the record>

Derives from: \<source> § \<section title> L\<start>-\<end>

| ID | Criterion | Type | Source |
|---|---|---|---|
| REQ-3.AC-1 | DEPRECATED — \<why it was retired, and when> | positive | \<source> § \<section title> L\<n> |

<!-- A retired requirement keeps its number, its citation, its index row and
     its criteria table; each Criterion cell reads DEPRECATED with the reason.
     Deleting the requirement or its table renumbers nothing on this page and
     breaks everything that already cites it, and check-requirements.js refuses
     a REQ-<n> heading with no table beneath it. No story carries a DEPRECATED
     criterion; check-decomposition.js refuses one. -->

## Risks

<!-- Anything that could threaten the feature's timeline, quality or adoption,
     with how likely and how severe each risk is. Every risk has a mitigation
     or an owner so it does not go untracked. A mitigation nobody has decided
     is written in the UNRESOLVED grammar, not left blank.

     A risk is a statement like any other, so it cites the source that names
     it, in the Source column. Likelihood, severity and mitigation are what the
     source or the owning role stated. Where neither stated one, the cell holds
     the UNRESOLVED marker: the writer never rates a risk. A risk that no
     source names is not written. If the writer sees one, it is a row in Open
     Questions, routed to the owning role. If there are none, delete the table
     and leave the single line: NONE -->

| Risk | Likelihood | Severity | Mitigation | Owner | Source |
|---|---|---|---|---|---|
| \<what could go wrong> | low / medium / high, as stated, or the UNRESOLVED marker | low / medium / high, as stated, or the UNRESOLVED marker | \<what is done about it, or the UNRESOLVED marker with its owner and trigger> | \<role> | \<source> § \<section title> L\<n> |

## Coverage of the sources

<!--
  Every part of every source — every section of the PRD and every copied file,
  every note of the interview record — is represented in this document, or
  recorded out of scope with a reason and an owner. This is the only table
  that shows what was NOT written up; every other section shows what was.
  Unmapped source is the commonest defect in this step, because a reader
  cannot tell a deliberate exclusion from a part nobody opened — both look
  like silence. A note that settled a row of Feature Name or of Assumptions
  made is represented by that row; a parked note by its Open Questions row.
-->

| Source part | Locator | Requirements | Disposition | Reason and owner |
|---|---|---|---|---|
| \<section title> | \<source> L\<start>-\<end> | REQ-1, REQ-2 | Represented | Fully carried; no exclusion to own |
| \<section title> | \<source> L\<start>-\<end> | deliberately none | Out of scope | \<the reason>; \<role> |
| \<section title> | \<source> L\<start>-\<end> | none yet, blocked | Unresolved | UNRESOLVED — \<what is undecided>. Owner: \<role>. Resolves: \<trigger>. |

## Open Questions

<!--
  Unresolved decisions and questions, tracked to ensure follow-through, each
  marked blocking (yes) or not (no) in the Blocking column, and routed to a
  role.

  Strict schema. Eight columns, in this order, header text exact. Schema of
  record: CLAR-log.template.md — if the two ever disagree, that file wins.
  Identifiers are CLAR-<SYSTEM>-<section>-<nn>, never reused, never
  renumbered. Routed to names a role, never a person. Status is one of
  Open | Routed | Answered | Closed | Withdrawn; Closed means the answer is
  written into this document.

  Every gap the source left, every contradiction it contains, and every
  threshold nobody has set gets a row here. A long list on a first draft is
  the correct output, not a failure — it is the business input's real state,
  reported at the only point where acting on it is still cheap. One kind of
  gap is not a row: a gap in how — where a file lands, what it is called,
  which branch pattern, which header field. The design settles those. A row
  asks only what would change an acceptance criterion.

  If there are genuinely none, delete the table and leave the single line: NONE
-->

| ID | Question | Source | Blocking | Routed to | Status | Resolution | Resolved |
|---|---|---|---|---|---|---|---|
| CLAR-\OPS-\<section>-01 | \<the ambiguity, as a closed question> | \<source> § \<section title> L\<n> | yes | \<role> | Open |  |  |

### Assumptions made

<!--
  An interpretation you made and could defend is a row here, with a confidence
  tag (CLAUDE.md §6). One you could not defend is a row in the table above.
  There is no third category, and "obvious from context" is the first one
  wearing the second one's clothes.
-->

| # | Interpretation | Why it is defensible | Confidence | Source |
|---|---|---|---|---|
| A-1 | \<what was read into the source> | \<the reason, one line> | \<tag> | \<source> § \<section title> L\<n> |

## Change Log

<!-- Every revision of this document, appended. The latest row's revision is
     the Document revision in the Feature Name table. Author is a role or a
     seat, never a named person. The review beside this document binds to its
     bytes, so a new row here is a new revision to review. -->

| Revision | Date | Author | Change |
|---|---|---|---|
| r1 | \2026-11-26 | \<role or seat> | Initial draft |

<!--
  How this document is released. There is no sign-off block and no row for a
  person to type. The critic's final review is written beside this file as
  requirements-review.md by /feature, with the verdict token and
  `Document revision: <hash>` — the value `git hash-object` prints for this
  document's bytes. scripts/check-requirements.js runs on the pull request and
  refuses a document with no approved review, a review bound to other bytes, an
  identifier outside the grammar, a requirement with no criterion, or a
  placeholder cell. The merge of that pull request is the acceptance, and it is
  the only human act. A requirement the business does not yet want is not held
  back by a row — it is marked DEPRECATED, or held on a blocking clarification
  that /decompose records as Unresolved in its coverage map.

  An APPROVED verdict says the document is internally sound and traceable. It
  says nothing about whether the business wants what it describes; the person
  who merges reads for that.
-->

---

<!--
  Belongs in THIS document: what must become true, for whom, observably; what is out
  of scope and why; the constraints and their sources; what nobody has decided yet.

  Belongs in a WORK ITEM instead (/decompose): the cut into units of deliverable
  work, work-item keys, dependencies between items, item-level AC-<n>.

  Belongs in a DESIGN instead (/dev-spec): file paths, interfaces, data shapes, the
  testing plan, the readiness block.

  If you are naming a component here, you are in the wrong document. If you are
  re-deciding a requirement in a design, so are you.
-->

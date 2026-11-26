---
name: decompose-requirements
description: The product-planner's method for turning a requirements document into a traceable backlog — a record and work-item files in the repository, keys minted from the hub's ledger, stable identifiers, a coverage map, a dependency map, and a script on the pull request in front of every tracker call.
---

<!-- Part of the harness asset library c6f3b4427d58f7c3 (see VERSION.json) · 2026-09-01 -->

# Skill — decompose-requirements

Loaded by the `product-planner` seat (`.claude/agents/product-planner.md`) inside `/decompose`
(`.claude/commands/decompose.md`), which owns the procedure, the state machine and the
round count. The review runs on the `pm-critic` seat (`.claude/agents/pm-critic.md`); both
charters install alongside this file.
`.claude/rules/worker-critic.md` owns the loop; `.claude/rules/workflow.md` owns what a
work item is; `CLAUDE.md` §4 owns which source wins. This file owns how the cut is made.
Where this file and the command disagree, the command wins — it is the procedure.

This is the front of the lifecycle: requirements in, work items out. Everything
downstream — the per-work-item design, its criteria, its tests, its gate — inherits the
identifiers and the traceability minted here. A boundary drawn badly at this step is paid
for at every step after it.

## Inputs

| Input | Form | Where it comes from |
|---|---|---|
| The requirements source | A requirements document on the hub's trunk that `check-requirements <SLUG>` accepts: `REQ-<n>` headings, `REQ-<n>.AC-<m>` criteria, an approved review beside it | The programme, through `/feature`, or a document brought in and reviewed the same way |
| Its revision | A version, a date or a commit — named, never implied | The document, or the human who ran the command |
| Source-of-truth hierarchy | The ranking and its tie-breaker | `CLAUDE.md` §4 — cited, never restated |
| The repository as it is | Read from the tree, not from a plan | The default branch |
| The key ledger | `docs/backlog/keys.json`: the prefix every key carries, the next free number, and one block per artefact that has minted keys | The hub install, with the client's prefix; advanced by every `/decompose` and `/qa-sprint` run |
| The clarification log | The schema of record, eight columns | `docs/designs/CLAR-log.md` |
| The list of repositories | `docs/estate/repositories.json`: one entry per repository the hub knows, with its `purpose` and the commit that purpose was read at | `/add-repo`, one repository at a time |
| The estate overview | `docs/estate/overview.md`, where one is on file: one plain-English page on what the estate is, part by part, and who owns each part. Read first, for orientation; a hub document, cited by its path | `/estate-overview-refresh`, or `/add-context` for a page the lead architect wrote |
| `scripts/read-spoke.mjs` | The one way you read a repository on that list. An id and a path in; the commit, a `Cite:` line and the bytes out. No branch argument, no write path | Installed with the hub |
| `scripts/read-spoke-rules.mjs` | The repository's always-on rule, read at the same pinned commit for orientation, with its `Status:` and a `Cite:` line. No `--design`: selection is the design's job | Installed with the hub; the spoke names the folder in `checks.env` with `RULES_INDEX` |

**The library assumes no format and no tool.** A brief in a document, forty wiki pages and
a single tracker epic are all valid sources, and they do not rank equally. Rank every one
of them against `CLAUDE.md` §4 before you read it — the ranking is written there once and
cited everywhere else, because a second copy of a ranking is a copy that drifts. Rank
first, because the rank decides what happens when two sources disagree: the higher wins and
the disagreement becomes a clarification row. Two sources at the *same* rank are never
resolved by you at all.

Keys come from the ledger and from nowhere else. Read `next`, take as many consecutive numbers
as you have items, record the block against this slug, and move `next` past it — in the same
pull request as the record, so two decompositions racing conflict on the merge instead of
minting one key twice. Nothing downstream — a worktree, a design path, a gate — can tell two
items with one key apart, which is why the ledger, not a person, hands out the numbers. A
missing or malformed ledger is an escalation to the role that owns the hub, never a range you
pick.

## The output shape — files first, tracker second

**The decomposition is a set of versioned files in this repository. A tracker holds a
projection of it, later, after a human says so.**

Two reasons, both structural. A tracker is not a source of truth —
`.claude/rules/workflow.md` § Repository truth beats tracker status settles that for the
whole harness, and a decomposition that exists only on a board cannot be diffed, reviewed,
cited or reverted. And not every adopting team runs the same tracker, so a method that
writes to one is a method most teams cannot run.

| Artefact | Path | One per |
|---|---|---|
| Decomposition record | `docs/backlog/<SLUG>.decomposition.md` | Source revision — the source and its revision, the key block taken, the coverage map, the repository map, the item list, the dependency map, the decisions log and the clarification rows |
| Review file | `docs/backlog/<SLUG>.decomposition-review.md` | Record — the critic's final round, written by `/decompose`, not by you, carrying `Record revision: <hash>` for the record's bytes |
| Work-item file | `docs/backlog/<SLUG>/<KEY>.item.md` | Work item |
| Key ledger | `docs/backlog/keys.json` | Hub — one file, advanced by every run that mints keys |

**`<SLUG>` is the source document, not the epic and not the branch.** Kebab-case, 2–5 words,
derived from the source document's own title and stable for the life of that document:
`payments-onboarding-fsd`, `candidate-portal-brief`. One slug has one record, revised in place:
a later revision of the same source, or a requirement released from its clarification, produces
a new revision of that record at the same path — the record gains a revision, the slug does
not. Derive it from the epic key and `refine` looks for the record under the source slug and
does not find it. This is a **different variable** from `/dev-spec`'s `<BRANCH-SLUG>`, which is
derived per work item from that item's title and appears only in a branch name; the two share no
value and never did.

Those paths are the shipped default. A team that keeps its backlog elsewhere re-points them
once and records the change in `docs/harness-decisions.md`; what does not move is that the
files exist, are reviewed, and are merged before anything is created anywhere else.

**The record is the parent.** There is no epic to ask for and no epic file to write: every
story is a sibling in one record, and the record's key blocks say which stories those are. One
record per slug, revised in place: a changed source produces a new revision of the record at
the same path — `r<n+1>` in its control table, the earlier revision in git history — never a
silent edit. Identifiers already issued keep their numbers, items already cut keep their files,
new items take a new block, and the review is written again against the new bytes.

**A criterion the source retired.** A revision of the source can mark a criterion `DEPRECATED`
that a story already carries. In the new revision of the record, retire the story's row the same
way: write `DEPRECATED` as the first word of its Criterion cell, with the reason and the date.
Keep its `AC-<n>` number and its `Carries` cell, because tests and designs name them. Never
delete the row. `check-decomposition.js` refuses a live row that carries a retired criterion,
and a retired row does not make a requirement `Covered`. A requirement the source retires whole
gets `Out of scope` in the coverage map, with `DEPRECATED` as its reason.

The control table names the source document in exactly one data row, `| Source | <path> |`.
The path is the requirements document in this repository. `check-decomposition.js` reads this
row to find the source. A header cell named `Source` in another table does not count.

**What a work-item file carries.** Every field, on every item. A field left out is found at
review if you are lucky and at pickup if you are not.

| Field | Content |
|---|---|
| Key | Minted once from the ledger's block for this slug, matching the grammar below, on a line of its own written `Key: <KEY>`, and the filename carries it |
| Title | One line naming the unit of deliverable work |
| Repository | **Exactly one** id from `docs/estate/repositories.json`, on a line of its own, written `Repository: <id>` — the same label and grammar the design carries and the gate reads. `/dev-spec` and `/dev-sprint` read it by that label, so it is a line, never a table cell |
| Context | **Exactly one** line under `Repository:`, written `Context: none` or `Context: <id>@<12-hex>:<path>, …`, copied whole from what `node scripts/read-context.mjs <repository> --at <commit> --names <id>,…` printed for this story, never typed. The ids are the decision records, standards and earlier requirements documents that bear on the story, the contracts of its own repository that bear on it, the global documents that bear on it where the source records a release (`global.<id>`, read with `--global <commit>` from the source's `Global:` line, each entry `<id>@<12-hex>:global:<path>` pinned to that commit), and each document on the source's `Context:` line that bears on it. `--names ''` when none bears. Every document on the source's line is on at least one story's line. Each document on the line is used in the story where a reader sees it: a decision record, a requirements document or a contract named by its id, a standard cited by the rule it applies, `std-<topic>.<NN>`. An always-on document is the exception: the script adds it to every line, so the story needs no use of it, and you never invent one. A decision record or a rule of a standard that the story cites is on the line |
| Hub commit | **Exactly one** line under `Context:`, written `Hub commit: <40-hex>`, copied from the same run of `read-context.mjs` that printed the `Context:` line, never typed. It names the hub commit the run read the hub's documents at. Copy the two lines together. `check-decomposition.js` fails a missing line, a short value, a commit the hub's trunk does not hold, and a commit that does not hold a hub entry's pinned bytes |
| Traceability | One line per source section it implements, in the grammar below |
| Acceptance criteria | A table under `## Acceptance criteria` beginning `\| ID \| Criterion \|` with one `Carries` column: `AC-<n>`, one observable statement each, at least one negative case, and each carrying exactly one `REQ-<n>.AC-<m>` the source defines |
| Dependencies | Other items by key, in the direction that blocks |
| Decisions | Each interpretation you made and could defend, with a confidence tag (`CLAUDE.md` §6) |
| Clarifications | Each interpretation you could not defend, as a row in the eight-column schema |
| Tracker key | Free text for a person, never read by a script. Where the hub has a Jira connection the command's second invocation records the ticket in the link file `docs/estate/tracker-links/<SLUG>.json` and never edits an item file. It records the projection and never replaces the key above |

**No `State:` line.** An item is at `TODO` because its file exists, complete and reviewed. Every
later state is read from the repository and its pull requests, never from a line in this file
(`.claude/rules/workflow.md` § Repository truth beats tracker status). A stored status is a second
copy that drifts, and no script reads one.

## Identifiers and the traceability line

**Every item carries a stable identifier and a line naming the source section it derives
from. An item with no such line is not a requirement — it is something you invented.**

- **Work-item keys** match `^[A-Z][A-Z0-9]{1,9}-\d+$` and are minted here, once, from
  `docs/backlog/keys.json`: the ledger's `prefix`, then consecutive numbers from `next`. This is
  the same key the rest of the lifecycle uses — `/dev-spec <KEY>`, `docs/designs/<KEY>.lld.md`,
  the pickup gate. Never reused, never renumbered, never recycled from a withdrawn item. The
  ledger's shape:

      { "schema_version": 1, "prefix": "PROJ", "next": 415,
        "blocks": [ { "from": 412, "to": 414, "taken_by": "decomposition", "slug": "payments-onboarding" } ] }

  One block per run that minted keys — `"taken_by": "decomposition"` with the `slug`. A
  `"taken_by": "validation"` block with a `key` is one an older `/qa-sprint` minted for defects; it
  stays and is read, and no run adds one now, because a failing criterion is fixed on the same
  pull request. Blocks
  never overlap, every block ends below `next`, and the blocks for this slug are, together,
  exactly the keys the item files carry — one block per run, so a re-cut adds a block and
  re-mints nothing. `check-decomposition` reads all of that.
- **Acceptance-criterion identifiers** are `AC-<n>`, unique within their item, and they
  travel unchanged into §4 of that item's design. A design may sharpen the wording of a
  criterion; renumbering it breaks the tests that reference it.
- **Every item criterion names the one `REQ-<n>.AC-<m>` it carries**, in the `Carries` column
  of its own row, with the requirement's own `Derives from:` line in the Source cell beside it.
  The two schemes are deliberately different: `/feature` scopes its criteria to a requirement, you
  scope yours to an item, and the numbers are not the same numbers and are not expected to
  match. Naming the link is what stops a test written against `AC-3` asserting the wrong
  `AC-3`, and this is the place in the chain the link is decided — the design's §4
  `Requirement` column copies it, the validation report copies it from the design, and the
  gate, `check-validation.js` and `check-decomposition` read the copies; nothing downstream
  re-derives it. The identifiers are universal: `check-requirements` refuses a source
  without them, so there is no source with nothing to carry, and the column is never empty and
  never invented. (An earlier version of this file carried an open question here about a source
  with no identifiers; `check-requirements` closed it.)
- **The traceability line**, on every item file, and in the Source cell of every criterion:

      Derives from: <document> § <section title> L<start>-<end>

  Cite by section title *and* line range. A citation that cannot be resolved is not a
  citation, and the critic samples at least 30% of them. Where the source itself declares a
  different locator convention in its `Source locator convention` row — a timestamp, a note
  identifier — cite it
  in that convention rather than manufacturing line numbers for it.
- **A fact read in a repository carries the commit it was read at**, in the grammar
  `scripts/read-spoke.mjs` prints on its `Cite:` line and `.claude/rules/estate.md` fixes:

      <repository-id>@<12-hex-commit>:<path>            the file
      <repository-id>@<12-hex-commit>:<path> L<a>-<b>   the lines

  A citation into a repository without the commit is malformed, and the critic refuses it: a
  branch is a moving name, and a fact cited into a moving name cannot be re-read. The list's
  `purpose` is never cited. It ranks; it does not plan.

**Where no source section supports the item, the item does not exist.** Write a
clarification row into the record instead — the closed question, the role it routes to, whether
it blocks — in the eight-column schema `docs/designs/CLAR-log.md` owns. No work item exists
yet, so nothing is mirrored into the log of a work item. The failure this prevents is the
expensive one: a backlog that reads as agreed, built partly from requirements nobody wrote,
discovered at acceptance when someone asks who asked for this.

## The method

1. **Read the whole source before cutting anything.** All of it, in this turn, before the
   first boundary is drawn. A decomposition begun at section 3 puts its seams where the
   first three sections suggested, and sections 9 and 14 then arrive as awkward additions to
   a shape that was already wrong. If the source will not fit the context allocation, index
   it and read by identifier (`.claude/rules/context-budget.md`) — never skim it and never
   decompose the part you happened to load.
2. **Rank, then reconcile.** Where two sources disagree and one outranks the other, the
   higher wins **and** the disagreement is logged. Where they rank equally, stop on that
   area, log the contradiction, and continue on the parts of the source it does not touch.
2a. **Read the estate before drawing a boundary** — § The repository map, below. Every story
   names one repository, so where the code lands is part of the cut, not something decided
   after it. Read each repository the requirement could touch, at a pinned commit, and write
   the repository map before you cut anything.
3. **Find the units of independently shippable value.** The test is concrete: could a
   reviewer accept this on its own, and would the organisation be better off having shipped
   only this? If the answer to either half is no, you have found a fragment, not an item.
3a. **Cut thin vertical slices, never layers.** A slice is a narrow path through every layer
   of its repository that a user or a caller can actually exercise: one field on a form,
   saved and read back, rather than every field at once. A story per layer — "build the data
   model", "build the API", "build the UI" — is the anti-pattern. None of those stories does
   anything a test can observe from outside, so none can be verified on its own. Where the
   path crosses repositories, the slice is a chain of stories, one per repository, and each
   is exercised by its caller at its own edge: an endpoint a test can call is a slice; a
   table nothing yet writes to is not.
4. **Cut along the seams the domain already has.** Follow the boundaries the source itself
   keeps returning to — the entities, the lifecycle steps, the parties, the contracts
   between them. Do not impose a tidy taxonomy over the top. An invented taxonomy puts
   boundaries where the domain has none, and the symptom is a dependency map in which
   everything depends on everything: each item needs a piece of the others because the line
   was drawn through the middle of one behaviour.
5. **The tree is two levels, and only one of them is an item.** The record is the parent;
   everything you cut is a sibling in it, each independently gateable — one item, one
   design, one pull request, one criterion set. **Never a child item, a subtask, or a
   checklist item that carries state** (`.claude/rules/workflow.md` § Subtasks are banned). A
   parent whose children disagree has no state any gate can read, so no agent can own its
   transition. Where a source suggests a further level, either the item is too big and splits
   into more siblings, or the grouping is a label — put it in the record as a heading over the
   item list, never as a file and never as an item.
5a. **One story, one repository.** Each item names exactly one repository from the list, on its
   `Repository:` line. A change that needs two repositories is two stories, one per repository,
   with a dependency between them in the dependency map — the same map, the same row shape, as
   any other dependency. Never one story with two names, and never a parent with a child per
   repository: subtasks are banned and the ban stands. Where the repository a change needs is
   not in the list, stop on that area with a blocking clarification to the role that owns the
   estate; `/add-repo` comes first, and an id you invented names nothing.
6. **Give every item acceptance criteria.** `AC-<n>`, one observable behaviour each, phrased
   so that a test could hold it, and **at least one negative case** — what must not happen,
   what must be rejected, what must fail closed. Criteria without a negative case describe
   the demo, not the system.
7. **Build the coverage map and the dependency map** (below). Both are outputs of the cut,
   not paperwork about it — they are how anyone checks the cut was complete and orderable.
8. **Record every interpretation.** An interpretation you made and could defend is a row in
   the decisions log with a confidence tag (`CLAUDE.md` §6). An interpretation you made and
   could not defend is a clarification. There is no third category, and "obvious from
   context" is the first one wearing the second one's clothes.

## Sizing and boundaries

| Symptom | Reading | Action |
|---|---|---|
| More than one reason a reviewer could reject it | Too big — it is two items sharing a title | Split along the reasons |
| Will not fit one design and one pull request | Too big | Split into siblings in the same record, each independently gateable |
| Will not fit the context allocation | Too big — a decomposition signal, never a reason to compress the constraints | Split |
| Cannot be accepted on its own | Too small — it is a step inside an item | Merge into the item whose acceptance it serves |
| Builds one layer that no user or caller can exercise | Horizontal — a layer, not a slice | Re-cut as thin vertical slices through every layer of the repository (step 3a) |
| Has no acceptance criterion that is not another item's | Too small | Merge |
| Its criteria restate the source section verbatim | Not decomposed at all — the section was renamed, not cut | Re-cut |
| Leaves a trunk broken until a sibling lands | Cut in the wrong place — the boundary runs through the middle of one change | Re-cut along § Every story leaves the trunk working; where the sibling is in the same repository and the two cannot land apart, merge them |

The two failure directions cost differently, and both cost. Items that are too big stall at
review and get re-cut mid-flight, which the state machine has no move for. Items that are
too small flood the board and bury the ones that matter, and each carries the full overhead
of a design, a review and a merge for a fraction of a behaviour.

## Every story leaves the trunk working

**Each story, merged on its own after the stories it depends on, leaves every repository's
trunk working, deployable, and doing what it did for its users before.** Assume each story
ships to production the moment it merges. Stories merge one at a time, often days apart, and
every other story in flight branches from the same trunk. A story that only works once a
sibling lands breaks the trunk for everyone between the two merges. So the cut has to be safe
at every step, not only at the end.

The test, for each story in dependency order: merge it and every story it depends on, and none
of the others. Does its repository still build, deploy and pass the tests it already has? Does
anything users rely on today still behave the same, unless the story means to change it? Does
every other repository that reads what it changes still work against it? If any answer is no,
the boundary is in the wrong place. The repository map is where the readers are found: a story
that changes what another listed repository reads names that repository's row as its evidence.
The service surveys point at the readers (`node scripts/read-survey.mjs --readers <key>`), and
the row cites what was read at the pinned commit, never the survey. A reader no survey lists is
still a reader, which is why a repository with no survey is never ruled out.

**Every order a story relies on is a `blocks` row.** Where a story keeps the trunk working
only because another merged first, the dependency map says so. An order that is only easier,
not needed, is not a row, and an order that is needed but written nowhere is a finding.

Four cuts pass it:

- **A contract is never replaced in place.** A contract is anything another part reads: an
  endpoint, a message, an event, a shared type or library interface, a configuration key, the
  shape of a stored record. It changes by a new version, or by steps. First, one story adds the
  new form beside the old, and nothing that reads the old one changes. Then one story per
  repository that reads it moves to the new form, each blocked by the first; a move story moves
  every reader in its repository, never some of them. Last, one story removes the old form,
  blocked by every move — or the removal is out of scope with a stated reason, where the source
  does not ask for it.
- **Stored data changes are expand, backfill, contract, each its own story.** Expand adds the
  new shape beside the old and code that reads both. Backfill fills the new shape for records
  that already exist. Contract removes the old shape, blocked by the backfill and by every
  reader's move.
- **Nothing a user can reach lands before what it needs.** The screen, endpoint or job that
  exposes a behaviour depends on every story that behaviour needs, so it merges last. A story
  that ships a slice no user can reach yet — an endpoint no screen calls, though a test can —
  is safe on its own, and is cut that way.
- **A part that must stay hidden has a story that stops hiding it.** Where no order keeps a
  part out of reach until the behaviour is whole, record that as a decision on the item,
  naming the story that completes the behaviour. A later story removes whatever keeps it
  hidden, blocked by that story — or the removal is out of scope with a stated reason. How the
  part is kept hidden is a question `/dev-spec` answers, not this record. The decomposition
  owns the order, and only the order.

## The coverage map

**Every section of the source maps to at least one item, or is recorded as out of scope
with a reason and a role who owns the exclusion.** Every `REQ-<n>` the source defines has a
row that names it in its first cell, and the disposition is one of exactly three words.

| Source section | Lines | Items | Disposition | Reason and owner |
|---|---|---|---|---|
| REQ-3 — account lifecycle | L44-91 | PROJ-412, PROJ-413 | Covered | Fully mapped; no exclusion to own |
| Bulk export | L210-238 | deliberately none | Out of scope | Superseded by the reporting programme; product owner |
| REQ-7 — retention windows | L240-252 | none yet, blocked | Unresolved | UNRESOLVED — retention window is undefined in every source. Owner: risk owner. Resolves: the retention policy is confirmed in writing. |

`Covered` means at least one item criterion carries a `REQ-<n>.AC-<m>` of that requirement, and
`check-decomposition` checks it against the item files. `Out of scope` carries a reason and
a role. `Unresolved` carries the pinned grammar and nothing else — it is how a requirement held
on a blocking clarification waits, with no key minted for it, and no other word does that job.

**Unmapped source sections are the most common defect in a decomposition**, and the reason
is that they are invisible: a reader cannot tell the difference between a section that was
considered and deliberately excluded and a section nobody ever opened. Both look like
silence. Recording the exclusion costs a line and converts an unknown gap into a known
decision.

Check the reverse direction too. No item may claim work its cited sections do not contain —
that is an invented requirement arriving through the back door, and it is caught by reading
the cited lines rather than the item's summary of them.

Where a disposition is unresolved, the cell carries the pinned grammar and nothing else, as
the third row shows.

## The repository map

**Every repository in the list gets a row: the stories that change it, or "does not change"
with the evidence read. A repository with no row was never considered, and nobody can tell
that from one that was.**

The hub knows each repository by a small record — its `purpose`, and the commit `readAt` that
purpose was read at. That record orders the reading, and it is never cited and never rules a
repository out. Where the hub keeps an estate overview, `docs/estate/overview.md` — one page on
what the estate is, part by part — that orders the reading too, and, being a hub document, it is
cited by its path. The requirements document names no repository: the person interviewed for it
knows the business, not the estate, and this map is where the answer is found. A
`Repositories likely touched` row in a document written before that rule is ignored. What a
story cites is the repository itself, read at a pinned commit through `scripts/read-spoke.mjs`,
and what a row rests on is the same. Four moves, in this order:

1. **Order by the overview and the purpose.** Read the estate overview where one is on file.
   Then, for every repository in the list, read `purpose` and `readAt`. Hold both against what
   the requirements document says must become true, and use them to decide which repositories
   to read first and how deeply, never to rule one out: the overview is a page people wrote, and
   a purpose is a summary written at `readAt`; a stale or thin one of either hides a repository
   from a planner who trusts it. This costs
   nothing and is the only step that reads the hub rather than the repository.
2. **Pin every repository, then orient the ones in play.** For every repository in the list,
   without exception, `node scripts/read-spoke.mjs <id> .` for the top-level tree. The header
   prints the trunk commit and a `Cite:` line, and that one read is what a **does not change**
   row rests on: the tree at a pinned commit, never the purpose. Where the commit differs from
   `readAt`, say so in the row and trust what you read. Then, for every repository the
   requirement could touch, `node scripts/read-spoke.mjs <id> README.md`, and at that commit,
   `node scripts/read-spoke-rules.mjs <id> --at <commit>`: with no paths given it prints the
   repository's always-on rule — its own account of stack, layout and naming, written for a
   seat that has never seen the tree — and a `Status:` line. That rule is the best orientation
   the repository offers, and it is a fact like any other: cite it from its `Cite:` line. The
   `Status:` goes into the row's evidence as printed — `<n> rule(s) declared`, `none declared`,
   `NOT CONFIGURED` or `NOT WELL FORMED` — so a repository with no usable rules is known here,
   before a design is written against it, not discovered at design time. You read the rules for
   orientation only. Which rules bind a change is decided by the design's §3.1 paths, and the
   `Rules:` line lives on the design (`.claude/rules/estate.md` §3); a story carries none.
   Where the requirement names a behaviour, search each repository it could touch with
   `node scripts/read-spoke.mjs <id> --grep <text> --at <commit>`, so a second place that holds
   the logic is a row in the map and not a surprise at design time.
   Then, at that commit, `node scripts/read-context.mjs <id> --at <commit>` for the index of the
   context documents in scope: the hub's decision records and standards, and the repository's
   contracts and the third-party API documents it keeps. One line each, no bodies. A contract
   says what an interface promises and who it is for, which the code alone does not; a decision
   record can fix a boundary before you draw one. Open with `--names <id>,…` only the documents
   whose line bears on the cut, and cite what you use from the `Cite:` line printed. Never the
   whole set with `--all`, and never `--design` or `--paths`: selection by path is the design's,
   from its §3.1 table. Once the cut is drawn, each story selects its own documents by name, and
   carries the `Context:` and `Hub commit:` lines the script prints, copied together (§ What a
   work-item file carries). Keep the text printed for each story: `/decompose` hands it to the critic.
3. **Find the keys, then the readers, then read what the cut needs.** First run
   `node scripts/read-survey.mjs --find <words>` with the requirement's own words for what it
   changes (`profile,language`): every key it prints that fits the change is a candidate
   contract, with who serves and who calls it. It points at keys, as the survey points at code;
   a key it does not print can still change, so the code read below can add one. Where the
   requirement changes a contract
   — an endpoint, an event, a queue message, a stored record, a shared library — run
   `node scripts/read-survey.mjs --readers <key>` with the key the survey template's grammar
   gives. Every repository it prints as a reader joins the short list, with its drift line in the
   row's evidence. So does every repository it prints under `May be read by`, a call whose
   provider its survey leaves `unknown`: the read at the pinned commit says whether it reaches the
   service that changes. Every repository it prints as not surveyed is read the ordinary way. For every
   repository on the short list, read the files the
   requirement touches at that pinned commit, with `--at <commit>` so every file comes from one
   commit, and cite each fact as `<id>@<12-hex>:<path> L<a>-<b>`. Read to the depth the
   boundary needs and no deeper: you are placing a story, not designing it. `/dev-spec` reads
   again, later, at its own pinned commit.
4. **Write the map**, one row per repository in the list:

| Repository | Read at | Disposition | Stories, or the evidence read |
|---|---|---|---|
| `transfer-service` | `3f2a9c1e7b4d` | Changes | PROJ-412, PROJ-413. Rules: 3 rule(s) declared, always-on at `transfer-service@3f2a9c1e7b4d:.claude/rules/stack.md` |
| `ledger-service` | `9e8d7c6b5a4f` | Changes | PROJ-414 — the posting rules PROJ-413 depends on live at `ledger-service@9e8d7c6b5a4f:ledger/posting.py L40-88`. Rules: NOT CONFIGURED |
| `notifications` | `1c2d3e4f5a6b` | Does not change | Nothing in the requirement reaches a notification; `notifications@1c2d3e4f5a6b:.` holds `mailer/`, `templates/` and `tests/` and no transfer or ledger surface, and `notifications@1c2d3e4f5a6b:README.md L1-20` names none |

`Read at` is the commit the row's evidence came from, twelve characters, as `Cite:` prints it,
and every row has one. A **does not change** row cites the tree, or the README, read at that
commit; no row rests on the purpose, and no row carries the list's `readAt` in place of a commit
this run read at. `check-decomposition.js` refuses a `Read at` cell that is not a twelve-character
commit. The cost is one tree read per listed repository; what it buys is that a stale purpose
can misorder the reading but cannot hide a repository, which is the gap the handover list used
to carry.

How many repositories one decomposition may read before the reading is itself a sign the
requirement needs splitting is not settled. UNRESOLVED — the number of repositories one
`/decompose` run reads at a pinned commit before the work is split. Owner: harness lead.
Resolves: measured on the first real run. Where the reading will not fit the context
allocation, that is a decomposition signal (`.claude/rules/context-budget.md`), never a reason
to read less of each repository.

## The dependency map

**A decomposition without a dependency map is a list, not a plan.**

| From | To | Type | Why |
|---|---|---|---|
| PROJ-413 | PROJ-412 | blocks | Consumes the account record PROJ-412 creates |
| PROJ-417 | PROJ-414 | shares a contract | Both serve the same versioned interface; the second to land must not break the first |

Three rules on it:

- **Dependencies are declared between items, not inside them.** A dependency mentioned only
  in an item's prose is not in the map, and nothing can order a backlog from prose.
- **The graph is acyclic.** A cycle is not a scheduling problem to be solved by starting
  somewhere; it means a boundary runs through the middle of one behaviour. Re-cut those
  items rather than recording the loop.
- **Dependency order is not priority.** Sequencing by dependency is a fact about the work.
  Ranking by value is a decision about the business, and it is not yours (see Never).

A dependency between two stories in two repositories is a row like any other. Where PROJ-414
in `ledger-service` must land before PROJ-413 in `transfer-service` can be built, the row
reads `PROJ-413 | PROJ-414 | blocks | consumes the posting endpoint PROJ-414 adds`, and the
reader sees the two repositories on the two stories. No edge list, no interface document, no
second structure. Where a story needs a change in another repository that **no story
provides**, that is not a dependency on nothing: it is a missing story, and a clarification
row names the gap and the role who decides whether to cut it.

## The loop — worker and critic, cap 2

A decomposition is a project-management artefact: **cap 2**
(`.claude/rules/worker-critic.md` § Revision caps). The review runs
`Mode: decomposition-review` from `.claude/skills/review-artefact/SKILL.md`, on fresh
context, and never by the planner that wrote the record — single-model self-review is the
weakest grounding there is, and for an artefact the whole delivery inherits from, treat a
self-reviewed decomposition as unreviewed.

- Findings arrive as `CRITICAL`, `IMPORTANT` or `SUGGESTION`. `CRITICAL` and `IMPORTANT`
  block acceptance; `SUGGESTION` does not.
- The verdict is a token the command reads literally: `### VERDICT: APPROVED` or
  `### VERDICT: CHANGES REQUESTED`, followed by `Cycle: <n> of 2`, `Mode: decomposition-review`
  and `Reviewer: <seat name>`. Four lines, the same four in every mode
  (`.claude/rules/worker-critic.md` § Feedback format).
- **The critic writes no file in this mode, and never edits yours.** The review returns
  in-loop; the command persists each round to the system temporary directory and writes the
  final round, verbatim, beside the record as `docs/backlog/<SLUG>.decomposition-review.md`,
  carrying `Record revision: <hash>` for the record's bytes. You touch the record no further
  after the round that approved it, or the review is stale and `check-decomposition` says
  so. `docs/designs/<KEY>.lld-review.md` is the design critic's one write path and is never
  written here.
- Every resubmission carries an explicit change list — what changed, which finding each
  change addresses, and which findings were deliberately not addressed and why. Without it
  the critic has to re-review everything, and a loop that re-reviews everything does not
  converge.
- The round count belongs to the command. An agent that counts its own cap finds a reason
  why this attempt does not count.
- **On reaching the cap: stop.** Escalate to the engineering lead with the record in its
  last reviewed state, the deduplicated findings from both rounds, and the specific question
  a human must answer. Two failed rounds on a decomposition almost always means the source
  is ambiguous about a boundary, and no third round resolves an ambiguity.

## The merge and the check before any tracker item exists

**No work item is created in a tracker before the decomposition pull request is merged and
`check-decomposition <SLUG>` exits 0 against the trunk. This is a hard gate, not a
courtesy.**

An agent that can populate a backlog unattended can flood it. A flooded backlog is
unrecoverable by hand: deleting two hundred wrong tickets costs more than writing them did,
the good ones become indistinguishable from the noise, and every reference, link and report
built on top of them is wrong at the same time. There is no undo for a board, which is why
the control sits before the write rather than after it.

There is no approval block and no row for a person to type. What the second invocation reads
is two facts: the pull request carrying the record reports `MERGED`, and the check exits 0 on
the trunk — the record and its items complete, every key in the ledger's block, and the
critic's approved review bound to the record's bytes. The keys created are exactly the keys in
that block, which the check has just confirmed are exactly the item files on the trunk.

- **You never write the review file, and you never touch the record after the round that
  approved it.** The critic approves the artefact; the command writes the review; a human
  merges the consequence; the check reads the result.
- **A key outside the ledger's block for this slug is not a key.** The block is exactly the
  items cut: no spare, none skipped. A requirement held on a blocking clarification gets no key
  and an `Unresolved` row in the coverage map.
- **The files land first.** The decomposition is merged before the tracker is touched, so a
  call that fails halfway leaves the repository holding the complete, reviewed truth and the
  board holding a recoverable partial copy — never the other way round.
- **This file is a contract, not an integration.** The tracker call is a placeholder for the
  adopting team's own call, substituted once at the call site. The gates enforced against
  the repository are not placeholders; they are enforced, and the repository is the fact.

## From a ticket — one story from one Jira ticket

`/from-ticket <KEY>` dispatches you on this section, with the ticket's snapshot,
`docs/backlog/jira/<KEY>.ticket.md`, as the one source. There is no record, no coverage map, no
repository map and no ledger block: the ticket is one story, and its key is the Jira key. Write
one file, `docs/backlog/jira/<KEY>.item.md`, with every field in § The output shape, and these
differences:

| Field | From a ticket |
|---|---|
| Key | The Jira key, `<KEY>`, as the snapshot's `Key:` line gives it. Mint nothing |
| Repository | The one id the command hands you, which the engineer chose. Never pick one |
| Context | The line `read-context.mjs <repository> --at <commit> --names` printed, as for any story |
| Traceability | `Derives from: \`docs/backlog/jira/<KEY>.ticket.md\` § <section> L<start>-<end>`, one line per snapshot section the story uses, and the code read through `read-spoke.mjs` |
| Acceptance criteria | One `AC-<n>` per snapshot criterion, in its order, each `Carries` cell the snapshot's `JIRA-<KEY>.AC-<m>`. State the outcome as the ticket states it, as one observable statement |
| Not carried | A `Not carried: JIRA-<KEY>.AC-<m> — <reason>` line for a ticket criterion the story leaves out, with a reason the ticket supports. Never drop one silently |
| Dependencies | The snapshot's `Links:` line, each linked key in the direction that blocks |
| Tracker key | The snapshot's `Source:` address |

- **The snapshot is the PM's text.** You never edit it. A gap in it is a ticket finding for the
  critic, and the PM fixes it in Jira through `/enrich-ticket`. Never fill a gap in the item.
- **Carry the ticket, no more.** A criterion the ticket does not state, however obvious, is
  invention. A value the ticket leaves open stays open, and the critic stops the intake on it.
- **One ticket, one story.** If the ticket describes several behaviours, write the one story
  and say so under Decisions. Splitting a ticket is the PM's choice, in Jira.
- `check-intake <KEY>` reads the result. It proves the trace both ways, so a criterion you add
  or drop fails the pull request.

## Never

- Never create a tracker item before the decomposition pull request is merged and
  `check-decomposition` exits 0 against the trunk.
- Never mint a key the ledger does not give, and never ask a person for a range or a parent
  epic. Read `docs/backlog/keys.json`, take the next block, advance it in the same pull request.
- Never invent a requirement no source section supports. An unsupported item is a
  clarification.
- Never renumber an acceptance criterion, and never reuse or recycle a work-item key.
- Never resolve a conflict between two sources silently — the higher source wins **and** the
  disagreement is logged; equal ranks are not resolved at all.
- **Never decide business priority.** Which item is worth doing first is the adopting
  organisation's call, made by the role that owns the backlog. You may state what must
  precede what; you may not state what matters most. A planner that ranks by value has
  quietly taken a decision nobody delegated.
- Never write a placeholder cell — a dash, `TBD`, `N/A`, `TODO`, `pending` or `?` — into
  any table you produce. Mark the unknown in the pinned grammar instead. The one literal
  that is not a placeholder is `NONE` standing alone where the clarification schema calls
  for it.
- Never put two table rows on one line, or a row with another cell count than its header.
  GitHub hides the extra cells, and the gate fails the row. Write a literal pipe in a cell as `\|`.
- Never create a subtask or a child item. Siblings in one record, each independently
  gateable.
- Never write a story that names two repositories, or none. One repository per story, on its
  `Repository:` line; a change that needs two is two stories with a dependency between them.
- Never cut a story that leaves a trunk broken until a sibling lands. Merged on its own after
  the stories it depends on, every story leaves every repository working and deployable; a
  contract is never replaced in place, and stored data changes by expand, backfill, contract.
- Never name a repository the list does not carry, and never invent an id. That is a
  clarification, and `/add-repo` is the answer.
- Never read a repository except through `scripts/read-spoke.mjs` and, for its always-on rule,
  `scripts/read-spoke-rules.mjs`; never cite a fact from one without the commit it was read
  at, and never cite the list's `purpose`. It ranks; it does not plan.
- Never write a `Rules:` line on a story. Which rules bind a change is the design's decision,
  made from its §3.1 paths; you read the always-on rule to place a boundary, not to select.
- Never pad the backlog. Items produced to make the decomposition look thorough cost real
  review time and hide the real ones.
- Never approve your own decomposition, and never treat a passing shape check as the
  acceptance — the merge is.

## Escalate — stop and raise, rather than decide

- Two same-rank sources conflict: surface both, resolve neither.
- The source is silent on behaviour you would otherwise have to invent.
- A section cannot be mapped and cannot be excluded, because nobody owns the answer.
- `docs/backlog/keys.json` is missing, malformed, or carries a block that already overlaps
  the numbers you would take.
- A change the requirement needs lands in a repository the list does not carry, or the list
  is empty. `/add-repo` first; a story cannot name what the hub does not know.
- A repository on the list cannot be read — `scripts/read-spoke.mjs` exits 2. A story placed
  in a repository nobody could open is a guess about where the code lives.
- The revision cap is reached.

The cost of a question is a delay. The cost of a confident wrong cut is a backlog that looks
finished and is not, discovered by someone else, several artefacts downstream.

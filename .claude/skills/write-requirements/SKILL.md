---
name: write-requirements
description: The feature-writer's method for turning business input into a structured requirements document — reading the whole source first, citing every statement, inventing nothing, observable criteria with stable identifiers, a coverage map over the source, and a review beside the document that a script checks before anyone merges it.
---

<!-- Part of the harness asset library c6f3b4427d58f7c3 (see VERSION.json) · 2026-09-20 -->

# Skill — write-requirements

Loaded by the `feature-writer` seat (`.claude/agents/feature-writer.md`) inside `/feature`
(`.claude/commands/feature.md`), which owns the procedure and the round count. The review runs on
the `pm-critic` seat (`.claude/agents/pm-critic.md`) in `feature-review` mode; both charters
install alongside this file. `.claude/rules/worker-critic.md` owns the loop, the caps and the
severity ladder; `CLAUDE.md` §4 owns which source wins; this file owns how the document is
written. Where this file and the command disagree, the command wins — it is the procedure.

This is the front of the lifecycle. `/decompose` begins at "a structured requirements document
exists"; this is the step that produces one. Everything after it — the work items, their
identifiers, the designs, the tests, the acceptance run — is derived from what is written here.
An error at this step is the cheapest in the whole chain to fix and the most expensive to
discover, because every artefact after it treats the error as the thing that was agreed.

**The output format is swappable. This method is not.** The section order, the headings and the
house shape live in `docs/requirements/_TEMPLATE.requirements.md`, which the adopting
organisation replaces with its own. Everything in this file survives that replacement, and so do
four things in the template, because downstream artefacts are written against them: the
`REQ-<n>` / `REQ-<n>.AC-<m>` identifier grammar — a heading whose first word is the `REQ-<n>`,
with a `| ID | Criterion |` table beneath it, which is what `check-requirements`
reads — a coverage map over the whole source, the clarification table's eight-column schema,
and the one `Context:` line with the one `Hub commit:` line and the one `Global:` line beside it.
`.claude/commands/feature.md` § The house format is where that list is stated for the reader
choosing a format. This file names sections by the shipped template's headings: the Feature
Name table, Link to PRD Document, Functional and Nonfunctional Requirements, Risks, Open
Questions, Assumptions made and Change Log. A replacement format maps each name to its own
heading.

## Inputs

| Input | Form | Where it comes from |
|---|---|---|
| The interview record | `docs/requirements/<SLUG>/runs/<yyyymmdd_hhmm>/interview.md` — every question `/feature` asked and every answer the person gave, word for word, one numbered note per exchange. It is business input, and on a run with no other source it is the only one | `/feature`, committed before you are dispatched |
| The business input | Whatever else the organisation has and the intent named: one business requirement, a brief, a set of stakeholder notes, a recorded conversation, or an existing document of unknown quality — copied into the same run folder under the context header, or already tracked in the hub | The programme, through the intent |
| Its revision | A version, a date or a commit — named, never implied. The record's is the day of the run | The input, or the interview |
| The source-of-truth ranking | The ranking and its tie-breaker | `CLAUDE.md` §4 — cited, never restated |
| The system as it is | Where an input describes a change to something that already runs, read the thing that runs | The repository, or the operating team |
| The context documents | The decision records, standards and earlier requirements documents that bear on the intent, as `read-context.mjs --hub --names` printed them, with `--global <commit>` when the global release is a release: one `Context:` line, one `Hub commit:` line, then each body under a `Cite:` line. A global document comes first, its id with the prefix `global.`. Handed in as text. You open no context document yourself | `/feature`, in your dispatch |
| The global release | One line, `Global: vX.Y.Z <40-hex>` or `Global: none`: the release of the global context repository that `read-global.mjs --resolve` printed for this run | `/feature`, in your dispatch |
| The clarification log | The schema of record, eight columns | `docs/designs/CLAR-log.md` |
| The house format | The section order and headings the organisation's readers expect | `docs/requirements/_TEMPLATE.requirements.md` |

**Read the whole source before you write a line of the document.** All of it, in this turn,
including the parts that look like preamble — the scope caveats, the definitions and the
exclusions live there, and they are what decide whether two paragraphs are one requirement or
two. A document begun at section 3 takes its shape from the first three sections, and section
11 then arrives as an awkward addition to a shape that was already wrong. If the source will not
fit the context allocation, index it and read by identifier
(`.claude/rules/context-budget.md`) — never skim it, and never write up the part you happened
to load.

### When the input is thin, or is not one input

| What arrives | What you do |
|---|---|
| One business requirement, a paragraph long | Write what it supports, and nothing around it. A one-requirement document is a legitimate output; padding it to look substantial is not |
| A brief written to sell the work | Separate the claims from the requirements. An outcome the brief promises is a requirement only where it says what the system must do |
| Stakeholder notes, several people, no structure | Attribute each statement to the note it came from. Where two stakeholders disagree, that is a clarification, not an average |
| An existing document of unknown quality | Treat it as a source, never as a draft to tidy. Restate what it supports, cite it, and record what it leaves undefined — inheriting its gaps silently is how an unreviewed document acquires the authority of a reviewed one |
| The interview record, alone or beside the others | Carry each answer exactly as far as its words go. A note written `parked — blocking` or `parked — not blocking` is an Open Questions row with that flag, routed to the role the note names; a parked number is the `UNRESOLVED` marker inside its criterion; a note written `assumed —` is an Assumptions made row; a note carrying a `Row:` line answers the Open Questions row it names, and that row closes (method step 8). Where the record and a copied brief disagree, the record wins — the person was shown the brief and answered — and the disagreement is still logged in Assumptions made. You never ask the person anything: what they said is in the record, and what they did not say is a clarification |
| Several inputs at once | Rank them against `CLAUDE.md` §4 before reading. The rank decides what happens when they disagree; ranking afterwards is ranking to fit what you already wrote |

A thin input produces a thin document with a long clarification list. That is the correct
output, and it is the honest signal that the business input is not yet ready — which is
information somebody needs, delivered at the only point in the lifecycle where acting on it is
still cheap.

## Never invent a requirement — the rule this file exists for

**Where the source is silent, contradictory, or says something you believe is wrong, you write
a clarification. You never write a plausible sentence.**

This is the single most important rule here, and the reason is that the failure is invisible.
Once an invented requirement is in the document it is indistinguishable from a real one: it
reads in the same voice, sits in the same table, carries the same identifier. It is then cut
into a work item, designed against, implemented, tested, and shipped — and every one of those
steps treats it as agreed because the document is what "agreed" means. Nobody discovers it
until someone asks who asked for this, usually at acceptance, with the code already written.

Three forms it takes, all of them easy to write and hard to spot afterwards:

| The temptation | What it looks like | What you write instead |
|---|---|---|
| Filling a gap | The source specifies a create path and no delete path, so you write the delete path the system obviously needs | A clarification: is deletion in scope, and who owns the answer |
| Sharpening a vague statement | The source says "fast"; you write "under 200 milliseconds at the 95th percentile" | A clarification naming the missing threshold. A number nobody agreed is not a tightening, it is a new requirement with a number on it |
| Completing a pattern | Three of four states have a defined transition, so you write the fourth | A clarification. A pattern is evidence about the other three, not about this one |
| Widening a set | The source says "the agent answers all the user's questions" and names no set, so you write a criterion over every question | A criterion over the set the source or §3 Scope names. Where neither names one, a clarification: which set, and who owns the answer. A set nobody named is a requirement on every case the system limits today |

The test is mechanical, and you apply it to every statement before it goes in: **can you point
at the lines of the source this came from?** If you cannot, it is not a requirement. Writing
the clarification costs a row. Writing the sentence costs a release.

**A gap in how is not a gap.** The rule has one boundary, and `/feature` and the critic hold it
too. Where every source is silent on the *realisation* — where a file lands, what it is called,
which branch pattern, which header field, what form an argument takes, how a mechanism works
inside — that silence is correct: this document states what must be true, and the design states
how (method step 3). So it is not a clarification row either. The test is as mechanical as the
one above: **would the answer change an acceptance criterion — something a person outside the
build can observe and accept?** If it would, it is a row, routed to the role that can answer it.
If it would not, write nothing: the engineer settles it in `/dev-spec`, and the design's own
clarification table is where a how-question nobody can settle goes. A row that asks how sends a
design decision to the business, and comes back as a re-run of `/feature` to close a question
`/feature` was never going to answer.

Where the source *contradicts itself*, log both readings and resolve neither. Where two sources
disagree and one outranks the other, the higher wins **and** the disagreement is logged. Where
they rank equally, stop on that area, log it, and carry on with the parts it does not touch
(`CLAUDE.md` §4).

## Identifiers and the traceability line

**Every statement in the document carries an identifier and a line naming where it came from. A
statement with no such line is not a requirement — it is something you invented.**

- **Requirement identifiers** are `REQ-<n>`, minted once, in the order they are written, unique
  within the document. Never renumbered, never reused, never recycled from a withdrawn
  requirement. To retire one, keep the number, keep its criteria table, and write `DEPRECATED`
  with the reason in each Criterion cell: `check-requirements` refuses a `REQ-<n>` heading with
  no table beneath it, and `check-decomposition` refuses a story that carries a retired criterion.
- **Criterion identifiers** are `REQ-<n>.AC-<m>`, scoped to their requirement. The compound form
  is deliberate: `/decompose` mints its own `AC-<n>` inside each work item, and two different
  things called `AC-3` in two artefacts that cite each other is how a test ends up asserting the
  wrong criterion. The link is recorded on the item side —
  `.claude/skills/decompose-requirements/SKILL.md` § Identifiers and the traceability line
  requires every item criterion to
  name the requirement criterion it carries — so the numbers are not the same numbers, are not
  expected to match, and are never left to be inferred.
- **The traceability line**, on every requirement and in the Source cell of every criterion:

      Derives from: <source> § <section title> L<start>-<end>
      Derives from: interview.md § note <n>

  Cite a copied file by section title *and* line range, and the interview record by note. A
  citation that cannot be resolved is not a citation, and the critic samples at least 30% of them.

**When the source has no line numbers.** The interview record never needs them: its notes are
the locator, and `interview.md § note 12` opens to one question and one answer. A copied file
usually does have them, because `/feature` copies the input into the run folder before you read
it and a copied markdown or text file has both headings and lines. Where the copy genuinely has neither — a
transcript with timestamps, a set of numbered notes, an exported thread — cite the smallest
stable locator it does have, declare the convention once in the Feature Name table's `Source
locator convention` row, and use it
consistently. Degrade the locator; never drop it.

| What the source is | The `Derives from:` line | What the `Source locator convention` row declares |
|---|---|---|
| The interview record | `Derives from: interview.md § note 12` | `note identifiers` for `interview.md` |
| A markdown or text file | `Derives from: onboarding-brief.md § Retention L44-58` | `line ranges` |
| A transcript with timestamps | `Derives from: steering-2026-08-14.md § Q&A @00:41:20-00:43:05` | `transcript timestamps` |
| Numbered stakeholder notes | `Derives from: intake-notes.md § note 12` | `note identifiers` |
| A page whose headings are its only stable structure | `Derives from: portal-brief.md § Eligibility` | `named headings` |

  Two rules survive the degradation. **The locator resolves against the copy in the repository**,
  never against the external original — the original is named with its revision in Link to PRD
  Document and is not
  cited again, because the people who edit it have never heard of this document. And **a source
  whose parts cannot be told apart at all is stopped on**, not written up approximately: a wall of
  prose with no headings, no numbering and no timestamps gives a reviewer nothing to open, and a
  citation nobody can open is not a control.
- **Clarification identifiers** follow `docs/designs/CLAR-log.md`: `CLAR-<SYSTEM>-<section>-<nn>`,
  in the eight-column schema, every row naming a role in `Routed to`.
- **A cell a script reads by name holds its value alone.** The Feature Name table's `Slug` cell
  is the slug in
  backticks and nothing else — `| Slug | \`payments-onboarding\` |` — no citation, no note, no
  second value. `check-requirements` compares the whole cell to the folder the document is
  filed under, literally, so `| Slug | \`payments-onboarding\` (interview.md § note 3) |` fails
  the pull request after the critic has approved, when the cap allows no repair. The rule
  above — every statement names where it came from — is met for that table by one `Derives from:` line
  under the table, citing the notes that settled the read-back, the role and the slug; never
  inside a cell. The same holds for every other cell a script reads by name: a `Status` cell
  holds one of its allowed words; a verdict line holds its token. `/feature` commits your document and runs
  `scripts/check-requirements-candidate.mjs <SLUG>` on it — the check the pull request will
  run, on the trunk as it would read after the merge — before the critic is dispatched. Every
  finding it prints on the document comes back to you to fix first; a round spent on a
  mechanical failure the check would have found is a wasted round.
- **The `Context:` line is the one you were handed, copied whole**, on its own line under the
  Feature Name table. Never type it, and never edit an entry. Each document on it shapes the document where a
  reader sees it:
  - name a decision record, or an earlier requirements document, by its id where it constrains a
    requirement, and cite the section you rely on;
  - cite a standard by the rule you apply, `std-<topic>.<NN>`, never by its name alone, and only
    a rule the standard defines;
  - use a global document in the same way: name a global record by its id, `global.ADR-<NNN>`,
    and cite a global standard by the rule you apply, `global.std-<topic>.<NN>`;
  - name a global exception, `global.EXC-<NNN>`, beside the record it departs from, never alone.
    The exception and every record it departs from are on the line;
  - name no decision record and cite no rule of a standard that is not on the line, global or
    hub.

  A global entry is `<id>@<12-hex>:global:<path>`. Its pin is the first twelve characters of the
  commit on the `Global:` line, not of a blob, so the two lines always name one release.

  A document on the line that shapes nothing is a finding for `/feature`, which re-runs the
  script without it. A document missing from the line is a finding too. `check-requirements`
  fails an unused entry and an unlisted citation.

  An always-on document is the exception. The script adds it to every line, whatever ids it is
  given, and `check-requirements` does not fail it when the page does not use it. Use it where it
  constrains a requirement. Where it constrains none, do not invent a use for it.
- **The `Hub commit:` line is the one you were handed, copied whole**, on its own line under the
  `Context:` line. It names the hub commit the script read the hub's documents at. The two lines
  come from one run. Never type it, and never change it. `check-requirements` reads it against
  the hub's trunk.
- **The `Global:` line is the one you were handed, copied whole**, on its own line under the
  `Hub commit:` line. Never type it, and never change it, on a revision or an amendment too. Only
  `/feature` moves it, when an amendment start check passed the move. `check-requirements` reads
  it against the global repository.

## The method

1. **Rank first, then read whole.** One source: read all of it before writing anything. Several:
   rank them against `CLAUDE.md` §4 before you open any of them, because the rank decides what
   happens when they disagree, and ranking afterwards is ranking to fit what you already wrote.
2. **Build the coverage map before writing any requirement.** One row per part of the source.
   It is the only artefact that shows what was *not* written up; everything else shows what was.
3. **Separate what the business needs from how somebody proposed to build it.** Sources arrive
   with solutions embedded in them — a named product, a chosen pattern, a screen layout. Where
   the source states a solution, record the underlying need as the requirement and the stated
   solution as a constraint with its own citation. A requirement written as a solution removes
   the design step's reason to exist, and it is unfalsifiable at acceptance: nobody can test
   "use the queue", only what the queue was for.
4. **Write one requirement per behaviour.** One `REQ-<n>` states one thing that must be true,
   in the voice of the business, observable from outside the system. Two behaviours in one
   requirement cannot be accepted separately, and the split then happens somewhere downstream by
   someone with less context.
5. **Give every requirement acceptance criteria** (below).
6. **Record every interpretation.** An interpretation you made and could defend is a row in the
   assumptions log with a confidence tag (`CLAUDE.md` §6). One you could not defend is a
   clarification. There is no third category, and "obvious from context" is the first one
   wearing the second one's clothes.
7. **Close the coverage map.** Every part of the source represented, or out of scope with a
   reason and an owner. Then read it in the other direction: every requirement traced back to
   lines that actually say it.
8. **Revise on the gap pass.** `/feature` reads the Open Questions table of your first draft and puts every row to the
   person, once, before the critic is dispatched; each answer is appended to the record as a new
   note carrying a `Row:` line that names the row it answers, and you are dispatched again on the
   same folder. An answered row keeps its identifier and gets `Status: Closed`, the resolution in
   the person's terms, the date and a citation to the new note; the requirement it held gets its
   criteria filled from that note, cited. A parked row keeps `Open` with the flag and the role
   the person gave. Nothing is renumbered, and nothing above the new notes has moved. The pass
   does not run when the interview reached its cap or when Open Questions is `NONE`.
9. **On a re-run, resolve what the new notes answer.** `/feature` opens a second run on the same
   slug with the open rows of Open Questions, and the new record carries the answers. An answered row keeps
   its identifier and gets `Status: Closed` — the schema of record, `CLAR-log.template.md`,
   allows `Open | Routed | Answered | Closed | Withdrawn`, and `Closed` is the one that means
   the answer is written into the document — the resolution in the person's terms, the date and
   a citation to the note; the requirement it held gets its criteria filled; a requirement the
   answer withdraws is marked `DEPRECATED` with its number kept. Statements the new run did not
   touch keep their citations into the earlier folders, which are never moved. Nothing is
   renumbered.
   **On an amendment** — the same run, made on the branch of a pull request that is still open,
   because someone found the document wrong before the merge — the new record opens with the
   correction, then the open rows. Revise what the correction's notes settle, in place, exactly
   as above. A wrong assumption is corrected where it stands: its Assumptions made row is
   revised, or withdrawn, on the new note, and every criterion that leaned on it is revised with
   it. The `Document revision` in the Feature Name table goes up by one, `r<n>` to `r<n+1>`, as
   on any revision, so every text a reviewer read has its own name, and the `Date` becomes this
   run's. A number the trunk
   skips is an amendment that was read in the pull request and never merged.
10. **Record the revision in the Change Log.** Every revision you write, the first included,
   appends one Change Log row: the revision, the date, your seat as the author, and what changed
   in one line. The latest row's revision is the `Document revision` in the Feature Name table.
   Never edit or delete an earlier row.
11. **Name the review file** in the Feature Name table's `Review` row — `requirements-review.md`, the file
   `/feature` writes beside the document from the critic's final round — and stop. You write
   nothing into the document after the round that approves it: the review carries the hash of
   the bytes the critic read, and a later edit makes it stale.

## Acceptance criteria

**A criterion states one observable thing, in terms a person outside the build can check, and
at least one criterion per behaviour is negative.**

| Property | What it means | What fails it |
|---|---|---|
| Observable | Stated as an effect visible from outside the system — a response, a record, a rejection, a notification | "the service handles the case correctly", which names no observation |
| Testable | Something could disprove it | "the system is reliable"; a criterion that is true of every possible implementation |
| Singular | One assertion per criterion | Two behaviours joined by "and", which cannot be accepted separately |
| Sourced | Cites the lines it derives from | An uncited criterion, which is an invented one |
| Bounded | Every threshold, window and limit has a stated value, or an `UNRESOLVED` marker | "quickly", "a reasonable number", "as required" |

**At least one negative case per behaviour**, and it is the half that gets left out: what must
*not* happen, what must be rejected, what must fail closed, who must not see it. A criterion set
with no negative case describes the demonstration, not the system — and the defects that reach
production are almost never in the path somebody demonstrated.

Where a threshold is genuinely undecided, the criterion still gets written and the number is
marked: `UNRESOLVED — <what>. Owner: <role>. Resolves: <trigger>.` A criterion with a guessed
number is worse than one with a marked gap, because the guess is testable and will pass.

## The coverage map

**Every part of every source — every note of the interview record, every section of every
copied file — is either represented in this document or recorded as out of scope, with a reason
and a role who owns the exclusion.** A note that settled a row of the Feature Name table or a row
of Assumptions made is
represented by that row; a parked note is represented by its clarification; an answer nobody
carried anywhere is the commonest way a person's decision goes missing.

| Source part | Locator | Requirements | Disposition | Reason and owner |
|---|---|---|---|---|
| Account lifecycle | § Account lifecycle L44-91 | REQ-3, REQ-4, REQ-5 | Represented | Fully carried; no exclusion to own |
| Reporting pack | § Reporting L210-238 | deliberately none | Out of scope | Served by the existing reporting capability; product owner |
| Retention windows | § Retention L240-252 | none yet, blocked | Unresolved | UNRESOLVED — no retention period is stated in any source. Owner: risk owner. Resolves: the retention policy is confirmed in writing. |

**Unmapped source is the commonest defect in this step**, and the reason is that it is
invisible: a reader cannot tell a part that was considered and deliberately excluded from a part
nobody opened. Both look like silence. Recording the exclusion costs one line and converts an
unknown gap into a known decision that somebody's name is against.

Check the reverse direction too. No requirement may claim more than its cited lines contain —
that is an invented requirement arriving through the back door, and it is caught only by reading
the cited lines, never by reading the requirement's summary of them.

## What this document does not decide

**It says what must be true. It does not say what matters most, what happens first, or what it
is worth.**

| Decision | Whose it is | Why not yours |
|---|---|---|
| Business priority — which requirement matters most | The role accountable for the outcome | Ranking by value is a commitment of somebody's budget and somebody's quarter. An agent that ranks has taken a decision nobody delegated, and it is invisible once it is in a table |
| Delivery sequence | The role that owns the backlog, at decomposition | Where the source states that one behaviour presupposes another, that is a cited fact and it belongs in the requirement. The order the work is *done* in is a plan, and a plan is not a requirement |
| Commercial trade-off — cost, scope cut, vendor, contract | The organisation | Nothing in the source authorises it, and it is the class of decision that is expensive to reverse and easy to state confidently |
| The design, the technology, the components | `/dev-spec`, two steps later | A requirement written as a design cannot be accepted on its own terms and removes the design step's reason to exist |

Where a source *states* a priority, a sequence or a commercial constraint, record it as what it
is, attributed, not as your own judgement. Recording somebody's decision is traceability. Making
one is not.

- **A stated priority goes in the Priority cell** of the requirement's row in the index table,
  cited in that row's Source column. Where no source and no note states it, the cell holds the
  `UNRESOLVED` marker, owned by the owning role. You never pick a value, and you never infer one
  from the order of the source or the size of the requirement.
- **A stated sequence or commercial constraint** is a row of the constraints table under Feature
  Design and Brief, with its own citation.
- **A risk is a cited statement.** Each Risks row cites the source that names the risk. Its
  likelihood, severity and mitigation are what the source or the owning role stated, or the
  `UNRESOLVED` marker. You never rate a risk. A risk no source names is an Open Questions row
  routed to the owning role, never a Risks row.

## The loop — worker and critic, cap 2

A requirements document is a specification: **cap 2**, escalating to the feature owner
(`.claude/rules/worker-critic.md` § Revision caps). The review runs `Mode: feature-review` from
`.claude/skills/review-artefact/SKILL.md`, on the `pm-critic` seat, on fresh context, and never
by the writer that produced the document — single-model self-review is the weakest grounding
there is, and for the artefact every later artefact inherits from, treat a self-reviewed
document as unreviewed.

- Findings arrive as `CRITICAL`, `IMPORTANT` or `SUGGESTION`. `CRITICAL` and `IMPORTANT` block
  acceptance; `SUGGESTION` does not.
- The verdict is a token the command reads literally: `### VERDICT: APPROVED` or
  `### VERDICT: CHANGES REQUESTED`, followed by `Cycle: <n> of 2`, `Mode: feature-review` and
  `Reviewer: <seat name>`.
- **The critic writes no file in this mode, and never edits yours.** That seat holds no write
  tool at all: the review returns in-loop, the command persists each round to the system
  temporary directory and writes the final round beside the document as the review file. **You
  touch the document no further after the round that approved it**; the review binds those bytes.
- Every resubmission carries an explicit change list — what changed, which finding each change
  addresses, and which findings were deliberately not addressed and why. Without it the critic
  has to re-review everything, and a loop that re-reviews everything does not converge.
- The round count belongs to the command. An agent that counts its own cap finds a reason why
  this attempt does not count.
- **On reaching the cap: stop.** Escalate to the feature owner with the document in its
  last reviewed state, the deduplicated findings from both rounds, and the specific question a
  human must answer. Two failed rounds here almost always means the business input is ambiguous,
  and a third round produces a more confident write-up of the same unclear text.

## The merge is the acceptance — the document is a proposal until its pull request merges

**Nothing downstream may treat this document as agreed on an agent's say-so. Not the
decomposition, not a design, not a schedule, and not a conversation with a stakeholder.**

An `APPROVED` verdict says the document is internally sound, traceable and complete against its
source. It says nothing about whether the business wants what it describes — that is not a
property of the text, and no reviewer can read it off the page. The two are routinely confused
because they arrive in the same run, minutes apart, and the second one is the one people
remember.

What releases the document is a script and a merge, and no typed row anywhere. `/feature` writes
the critic's final round beside the document as `requirements-review.md`, carrying the
verdict token and `Document revision: <hash>` — `git hash-object` of the bytes the critic read.
`check-requirements <SLUG>` runs on the pull request through `requirements-gate` and
refuses a document with no approved review, a review bound to other bytes, an identifier outside
the grammar, a requirement with no criterion, or a placeholder cell. The feature owner
reads both files with the check green and merges. `/decompose` reads the trunk.

- **You never write the review file and never edit the document after the round that approved
  it.** The critic judges the artefact; the command writes the review; a human merges.
- **A requirement the business does not yet want is held on a blocking clarification**, not on
  a cell. `/decompose` records it as `Unresolved` in its coverage map and mints no key for it.
  One that is withdrawn is marked `DEPRECATED` with its number kept.
- **This file is a contract, not an integration.** Where the document is filed is the adopting
  team's own; substitute it once and record the substitution in `docs/harness-decisions.md`. The
  review file and the check are not substitutable, because they are machine-read: an
  organisation that also records acceptance in a governance register keeps doing that, and the
  merge still happens with the check green. What does not move is that the document is
  versioned, reviewed and checked before anything is cut from it.

## Enriching a ticket — additions to one Jira story, for the PM to approve

`/enrich-ticket <KEY>` dispatches you on this section. The inputs are the ticket as fetched, the
list of gaps the check and the critic found against `.claude/rules/ticket-quality.md` (read that
rule in full before you draft: it is path-scoped, and a runtime does not load it when a seat
starts), the PM's
answers so far, each as a numbered note, and the sources the command read for you: linked
tickets, the epic, the design link's text where the ticket quotes it, and code read through
`read-spoke.mjs`. You write one file, the draft of the ticket's new description, in the system
temporary directory. You never write to Jira and never talk to the PM.

The rules of this file still bind, and three more apply:

1. **Keep the PM's text.** Copy the description as it is. Add to it. Never reword, reorder or
   remove a line the PM wrote. A line you believe is wrong is a question, not an edit.
2. **Mark every addition.** End each added line or table row with `[added: <source>]`, where the
   source is a PM note (`PM note <n>`), a linked ticket key, or a code citation
   `<id>@<12-hex>:<path> L<a>-<b>`. An addition with no source is an invented requirement.
3. **Close each gap, or leave it as a question.** A gap that no source answers stays a question
   for the command to put to the PM. A value only the code can answer, which the PM cannot
   read, is parked for the engineer, and named in the draft's closing list.

End the draft with a list headed `Harness enrichment`, one line per addition and its source, and
one line per gap still open. The command shows the PM the whole draft before anything is sent.

## Never

- Never write a requirement no source supports. An unsupported statement is a clarification.
- Never write a row that asks how. A path, a name, a format, a branch pattern, a header field or
  an inner mechanism is the design's to settle; a row here sends it to the business.
- Never edit the document after the round the critic approved, and never treat the critic's
  verdict as the acceptance — the merge is.
- Never renumber a `REQ-<n>` or a criterion identifier. Append, and deprecate what is retired.
- Never resolve a conflict between two sources silently — the higher source wins **and** the
  disagreement is logged; equal ranks are not resolved at all.
- Never guess a threshold, a window, a volume or a limit. A marked gap is recoverable; a plausible
  number is not, because it will pass its own test.
- **Never set business priority, sequence or commercial trade-off.** Record the ones the source
  states, attributed; make none of your own. A Priority, Likelihood or Severity cell holds what a
  source states, or the `UNRESOLVED` marker.
- Never write a placeholder cell — a dash, `TBD`, `N/A`, `TODO`, `pending` or `?` — into any
  table you produce. Mark the unknown in the pinned grammar instead. The one literal that is not
  a placeholder is `NONE` standing alone where the clarification schema calls for it.
- Never leave a template fill-in token, `\<like this>`, anywhere on the page. Replace the whole
  token, backslash included. `check-requirements` fails one left in a cell, in part of a cell or
  in prose.
- Never put two table rows on one line, or a row with another cell count than its header.
  GitHub hides the extra cells, and the gate fails the row. Write a literal pipe in a cell as `\|`.
- Never inherit an existing document's gaps by tidying it. It is a source, not a draft.
- Never pad. A requirement written to make the document look thorough costs real review time and
  hides the ones that matter.
- Never approve your own document, and never treat a passing shape check as the acceptance.

## Escalate — stop and raise, rather than decide

- Two same-rank sources conflict: surface both, resolve neither.
- The source is silent on behaviour you would otherwise have to invent.
- A part of the source can be neither represented nor honestly marked out of scope, because
  nobody owns the answer.
- The source has no citable structure, or its revision cannot be established.
- The revision cap is reached.

The cost of a question is a delay. The cost of a confident invention is a requirement nobody
asked for, discovered by somebody else, after it has been designed, built and tested.

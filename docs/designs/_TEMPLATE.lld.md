# LLD — <TICKET-KEY>: <one line stating what this ticket builds>

<!--
  Low-level design template, v1.0.

  Two readers. A senior engineer, who approves the design and merges it.
  A gate script, which parses sections 4, 5, 8 and 9 and refuses the ticket if the
  shape is wrong. Write for both. Prose for the human, pure tokens for the machine.

  Rules that are not negotiable:
   - Acceptance-criteria identifiers are NEVER renumbered. Append and deprecate.
   - Every acceptance criterion has a named test in section 5.
   - The section 4 and section 5 tables are machine-parsed, not just read: the gate
     derives the criterion set and the covered set from them and compares both
     against the counts declared in section 8. Declaring 3 and 3 over a section 5
     with one row fails.
   - Section 8 field labels and values are parsed literally. Do not reword them.
   - The `Ticket:` line names this work item and the `Repository:` line names the
     one repository the code lands in, by its bare name. The gate reads both. A
     repository's own CI runs the gate with HARNESS_REPO set to its id, and a
     design written for a different repository fails there.
   - The `Rules:` line names the repository's own rules this design was written
     under: `none`, or the rules folder cited at a commit,
     `<REPOSITORY-ID>@<12-hex>:<folder>`, copied from the `Rules:` line
     `scripts/read-spoke-rules.mjs` prints. The gate reads it literally and
     refuses a placeholder, prose, or a citation into another repository.
   - The `Context:` and `Hub commit:` lines come from one run of
     `scripts/read-context.mjs`. Copy the two lines together. Never type them.
     The gate reads both: the `Hub commit:` is a commit on the hub's trunk that
     holds the bytes every hub entry pins.
   - The `Discovery:` line pins the discovery map beside this design,
     `docs/designs/<TICKET-KEY>.discovery.md`, by the first 12 characters of its
     `git hash-object`. The gate reads the map, and every spoke path this design
     cites is a row of the map's Files read table.
   - No code is written before this document is merged to the default branch.
-->

## 1. Traceability

| Upstream source | Section | Lines | What this ticket implements from it |
|---|---|---|---|
| Work item | <docs/backlog/<slug>/<TICKET-KEY>.item.md> | <L14-31> | <the criteria this design carries forward> |
| Signed functional specification | <§ title> | <L120-148> | <one clause> |
| Signed design specification | <§ title> | <L61-77> | <one clause> |
| Decision record | ADR-004 | <L30-44> | <the decision this obeys> |
| Cross-system contract | <name> v<n> | <L12-20> | <the interface consumed or served> |

Ticket: <TICKET-KEY>
Repository: <REPOSITORY-ID>
Rules: <none | REPOSITORY-ID@12-hex:folder>
Context: <none | id@12-hex:path, id@12-hex:REPOSITORY-ID:path, global.id@12-hex:global:path — as scripts/read-context.mjs printed it for this design>
Hub commit: <40-hex — as the same run of scripts/read-context.mjs printed it, copied with the Context: line>
Guardrails: <off | none | unchecked | prime@12-hex:id, id — as scripts/prime.mjs choose printed it>
Discovery: <TICKET-KEY>.discovery.md@<12-hex — git hash-object of the map, as /dev-spec step 1 writes it>
Supersedes: <none | prior design path>

<!--
  Cite by section title AND line range. A citation that cannot be opened is not a
  citation, and inventing one to fill a row is the failure this section exists to
  make unnecessary.

  Delete any row whose source this work item genuinely has no equivalent for. A
  programme that decomposed a product brief, a set of wiki pages or a tracker epic
  has no signed pair, and that is a legitimate state — say so here, once, in the
  one permitted grammar, and derive every clause below from sources that do
  resolve:

    UNRESOLVED — the signed functional and design specifications this item would
    normally cite. Owner: <role>. Resolves: <the trigger that produces them>.

  What is never acceptable is a row naming a document nobody can open.
-->

<!-- The work-item row is the upstream this design is answerable to. Its AC-<n>
     identifiers travel unchanged into section 4: refine the wording, never the
     number. -->

<!-- The Context: line carries every id on the work item's own Context: line, and
     may add more. Each document on it is used where a reader sees it: a decision
     record or a contract named by its id where it shapes the design, a standard
     cited by the rule it applies, std-<topic>.<NN>. A decision record or a rule
     of a standard named anywhere in this design is on the line. An always-on
     document needs no use: scripts/read-context.mjs adds it to every line.
     The Hub commit: line names the hub commit the same run read the hub's
     documents at. scripts/check-dev-ready.js reads all of this. -->



## 2. Context and current state

<What exists in the codebase today, read from the tree rather than from memory.
Name the modules, the entry points, the tables, the queues. Two to five paragraphs.>

**Read before implementing:**

- <path/to/module> — <why it matters to this ticket>
- <path/to/test> — <the existing coverage this must not break>
- <path/to/contract> — <the versioned interface>
- <folder/rule.md> — <one line per rule the `Rules:` line selected: the always-on rule, then each
  rule whose globs matched a §3.1 path; omit when `Rules: none`>
- <path/to/context-document> (<id>) — <one line per document the `Context:` line names, in its
  order: the path from the script's `Cite:` line, the id in brackets, and what it decides for this
  design; omit when `Context: none`>

**Prime guardrails:** <one line per guardrail the `Guardrails:` line names, in its order: the
title, how §3 meets the rule, and the paths of §3.1 it concerns. Name every guardrail on the list
that this design's code touches. The design meets each one, and departs from none. A rule with
several parts is met part by part: name each part, and how §3 meets it or why this code has none
of it. Omit the list
when the line is `off`, `none` or `unchecked`, and say which in one sentence.>

- <guardrail title> (<g-number from the guardrail list>) — <how §3 meets the rule> — <path, path>

**Security limits:** <one line per limit that a guardrail puts on a required behaviour, and the
product owner accepted in answer to its §9 row. Omit when there is none.>

- <g-number> — <the limit> — sharpens <AC-n> — accepted for <role>, <CLAR id>

**Out of scope:** <the adjacent things a reader will assume are included, and are not.>

## 3. The design

<The implementation, at the level of files, functions, signatures, data shapes and
call order. Specific enough that two engineers would produce the same structure.>

### 3.1 Components changed or added

| Path | Change | Responsibility |
|---|---|---|
| <path> | new / modified | <one line> |

### 3.2 Data and interface changes

    <schema, migration, request/response shape, event payload>

### 3.3 Sequence

    caller -> <entry point> -> <service> -> <adapter> -> <external system>
                                  |
                                  +-> <failure path and what the caller sees>

### 3.4 Failure behaviour

| Failure | Detected by | Behaviour | Observable |
|---|---|---|---|
| <timeout / invalid input / downstream 5xx> | <check> | <fail closed / retry N / reject> | <log field, metric, error code> |

## 4. Acceptance criteria

<!--
  Machine-parsed. The FIRST cell of every criterion row is the identifier, in the
  form AC-<n>, and nothing else — no prefix, no bold, no trailing note. The SECOND
  cell is the criterion, and the gate rejects it empty or as a placeholder: a bare
  dash, TBD, N/A, TODO, NONE, ?, pending. An identifier alone is not a criterion.
  The gate counts these rows to derive the criterion set. Stable identifiers: NEVER
  renumber. To retire one, keep the number and write DEPRECATED as the first word of
  the Criterion cell -- the bare word, no bold, no brackets -- followed by nothing or
  by a reason. That form and no other is what lets a validation report record N/A
  against it. The Requirement column is read by name and every cell is exactly one requirement
  criterion, REQ-<n>.AC-<m>, or JIRA-<KEY>.AC-<m> for a story taken from a Jira ticket,
  copied from the work item's Carries column. The gate
  traces this table to docs/backlog/<SLUG>/<KEY>.item.md on the trunk: exactly the work
  item's AC-<n>, each Requirement id the one its Carries column gives that criterion. It is how
  the requirement reaches the validation report: check-validation.js compares the
  report's column against this one. A deprecated criterion keeps its requirement.
-->

| ID | Criterion | Requirement | Source |
|---|---|---|---|
| AC-1 | <observable, testable statement> | REQ-<n>.AC-<m> | FSD <§ title> L<n> |
| AC-2 | <observable, testable statement> | REQ-<n>.AC-<m> | DSD <§ title> L<n> |
| AC-3 | <negative case: what must NOT happen> | REQ-<n>.AC-<m> | <source> |

## 5. Testing plan

<!--
  Machine-parsed. First cell is the criterion identifier, second cell is the test
  name and must not be empty or a placeholder — a bare dash, TBD, N/A, TODO, NONE,
  ? and pending are all rejected by the gate, in this column and in section 4's.
  Every AC in section 4 appears here exactly once. The gate derives the covered set
  from this column and fails if it is not equal to the section 4 set — an AC with no
  row, or a row naming an AC that section 4 does not define, both fail.
  A criterion the current code already meets — a constraint that something stays as it
  is — starts its Asserts cell with `Holds already:` and cites the lines that meet it
  today. Its test is the one new test allowed to pass at the test commit; every other
  row's test must fail there first. Mark no row that needs new behaviour to pass.
-->

| AC | Test name | Level | Asserts |
|---|---|---|---|
| AC-1 | <test_module::test_name> | unit | <the assertion> |
| AC-2 | <test_module::test_name> | integration | <the assertion> |
| AC-3 | <test_module::test_name> | unit | <the rejection> |

Coverage target for changed lines: <95%+, matching the repository floor>
Test data / fixtures required: <named fixture, seed, stub>

## 6. Cross-system contracts

| Contract | Version | Direction | Change required |
|---|---|---|---|
| <name> | v<n> | consumed / served | none / additive / breaking |

**If any row says breaking:** stop. A breaking contract change is renegotiated
with the owning system and versioned before this ticket is eligible for build.
This document cannot unilaterally redefine a shared interface.

## 7. Answered senior-engineer questions

<!-- Five to ten. Written AND answered. An unanswerable question is a clarification, not a question. -->

1. **<Question about a boundary, a race, a failure path, or a cost>**
   <Answer, with the evidence or the source that settles it.>
2. **<Question>**
   <Answer.>
3. **<Question>**
   <Answer.>
4. **<Question>**
   <Answer.>
5. **<Question>**
   <Answer.>

## 8. Readiness

<!--
  Parsed by the pickup gate. Eight fields. Each appears EXACTLY ONCE in this
  document, on its own line, as a pure token. Not inside prose, not inside a
  table, not restated in a summary. Formatting variants are rejected, not
  normalised. The gate cross-checks these counts against the section 4 and
  section 5 tables it derives them from, and the tables win.

  The heading is a locator: "## 8. Readiness" and "## Readiness" both work, so
  renumbering sections is safe. The field labels and values below are NOT --
  reword one and the gate stops finding it.
-->

Spec Quality: READY
Open Gaps: 0
AC count: 3
AC covered by tests: 3
Contracts referenced: 1
Blocking CLAR: 0
Codebase verified: YES
Self-check verdict: GATE_PASS

## 9. Clarifications

<!--
  Strict schema. Eight columns, in this order, header text exact.
  A malformed row FAILS the gate. It is never skipped.
  A row with Blocking = yes releases this work item only at Closed or Withdrawn.
  Open, Routed and Answered all block: Answered means a human replied, Closed means
  the answer is written back into the design. Before the merge, a person's answer
  gets in by /dev-spec run again on this design's branch (an amendment), never by a
  hand edit, which unapproves the design. After the merge, the fixes of the pull
  request add their answers as Closed rows, through /dev-spec § Amending a merged design.
  If there are no clarifications, delete the table and leave the single line: NONE

  Schema of record: CLAR-log.template.md. If the two ever disagree, that file wins.
-->

| ID | Question | Source | Blocking | Routed to | Status | Resolution | Resolved |
|---|---|---|---|---|---|---|---|
| CLAR-PROJ-auth-01 | <the ambiguity, as a closed question> | FSD <§ title> L<n> | no | <role> | Answered | <the answer, one line> | 2026-11-26 |

## 10. Decisions log

| # | Decision | Alternatives rejected | Why | Date |
|---|---|---|---|---|
| D-1 | <what was decided> | <A, B> | <the reason, one line> | 2026-11-26 |

<!-- A decision recorded here is closed. The next agent does not reopen it. -->

## 11. Review record

Author: <agent or role>
Critic: <agent or role>
Revision rounds used: <n> of 3
Human approver: <role>
Design pull request: <link>

---

<!--
  Companion file, same directory: docs/designs/<TICKET-KEY>.lld-review.md
  It must contain, on its own line and nowhere else in the file, exactly:

  ### VERDICT: APPROVED

  Accepted verdict values: APPROVED | CHANGES REQUESTED
  Only APPROVED opens the gate. The string is matched literally.

  It must also carry, on its own line:

  Design revision: <git hash-object docs/designs/<TICKET-KEY>.lld.md>

  That binds the review to the bytes of THIS file. Amend this design after the
  review is written and the gate refuses it, because the review approves a
  revision and this is no longer that revision. Get it reviewed again.

  A loop that hits its revision cap ends in ESCALATED. That is a loop outcome
  recorded in the iteration record, not a value for this heading.
-->

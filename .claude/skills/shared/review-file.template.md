---
name: review-file
description: The exact shape of a written review — verdict token, cycle, mode, the three severity sections, acceptance-criterion coverage, criterion testability, citation spot-check and verification evidence. Shared by every reviewing seat.
---

<!-- Part of the harness asset library c6f3b4427d58f7c3 (see VERSION.json) · 2026-09-01 -->

<!--
  Shared output shape, not a skill. Every reviewing seat that follows
  .claude/skills/review-artefact/SKILL.md produces this shape, so the humans and the
  scripts downstream only ever learn to read one.

  One shape, eight destinations:
  - feature-review — returned as text; /feature writes the FINAL round, verbatim, beside the
    document as docs/requirements/<SLUG>/requirements-review.md, and
    check-requirements reads it on the pull request.
  - decomposition-review — returned as text; /decompose writes the FINAL round, verbatim,
    beside the record as docs/backlog/<SLUG>.decomposition-review.md, and
    check-decomposition reads it on the pull request.
  - ticket-review — returned as text; /from-ticket writes the FINAL round, verbatim, beside
    the snapshot as docs/backlog/jira/<KEY>.ticket-review.md, and check-intake reads it on
    the pull request. /enrich-ticket keeps its rounds in the temporary directory only.
  - bug-review — returned as text; /bugfix writes the FINAL round, verbatim, beside the
    record as docs/bugs/<KEY>.bug-review.md, and check-bug reads it on the pull request.
  - lld-review — the critic writes docs/designs/<KEY>.lld-review.md. That path is the
    critic's only write path, and the pickup gate reads the file.
  - test-review — returned as text, like code-review: the stubs and tests for one work
    item, before any behaviour exists. The build worker carries the final verdict into the
    pull-request description's test section.
  - code-review — returned as text; the worker carries the final verdict into the
    pull-request description on its last pass. Where the security lens was dispatched
    too, both verdicts arrive in this shape and both are carried across.
  - global-review — returned as text, one round: the hub's decision records and standards
    against the global layer. /check-global prints it, and with --connect copies its findings
    into the pull-request description. Its table is keyed on the hub's documents, not on
    criteria, and it carries no revision line (review-artefact § global-review).
  The pm-critic and the security reviewer hold no write tool in any mode. In the three
  front-of-lifecycle modes the command that holds the round count writes the last round
  into the pull request, unchanged; in test-review and code-review nothing persists the
  file, which is why the worker owns that last carry. Whoever runs the loop persists each interim round
  to the system temporary directory as <KEY-or-SLUG>-<mode>-round-<n>.md, never into the
  worktree.

  Four mechanical constraints on a committed review file:
  - Exactly one line in the whole file may begin with the verdict heading. The gate and
    the two checks count lines starting with that heading and fail on any count other
    than one — so never restate it at the start of another line, in prose or in an
    example. A verdict inside a code fence or an HTML comment does not count in either
    direction: quote the grammar freely, but the real verdict has to be on the page,
    with its `###` as the first character of its line; an indented verdict is not one.
  - Only the approved form opens the gate, and it is matched literally: exact words,
    exact casing, nothing appended. "Approved with comments" is a failure, not a nuance.
  - A committed review carries the revision it approved, under the label for its
    artefact type: `Design revision: <hash>` in lld-review, `Document revision: <hash>`
    in feature-review, `Record revision: <hash>` in decomposition-review and in bug-review, and both
    `Ticket revision: <hash>` and `Item revision: <hash>` in ticket-review. The value is what
    `git hash-object <the artefact>` prints for the file you actually read. Change one
    byte of that artefact and the review stops applying to it, which is the point —
    re-read it and write the new hash. Touching this file does not renew it. The
    record's review binds the record only; an item file is not covered by it.
  - No `<details>`, no `<summary>`, no HTML `<table>`, no `display:none`. A verdict behind
    a disclosure widget is not a verdict a reader sees. Backticks are fine, so a finding
    about HTML can name the tag it is about.

  <lowercase angle-bracket tokens> are authoring guidance, filled per review. Sections
  marked for a mode are omitted in the other modes. Delete every comment in this file
  once instantiated.
-->

## Review: <KEY, or the document's or record's SLUG> — <one line: what is under review>

<!-- The heading is read too: the gate looks for the work-item key in the review, and the two
     checks look for the slug. A review that never names what it reviews fails as evidence about
     nothing. The lines below are the machine surface. The verdict is a token, not a
     sentence. Cycle counts the round you are issuing, against the cap for this
     artefact type in .claude/rules/worker-critic.md — 2 for a requirements document, 2
     for a decomposition, 2 for a ticket intake, 2 for a design, 3 for tests, 3 for code, 1 for global-review. Mode is the one carried in the
     dispatch; there is no default,
     so a dispatch with no Mode line is handed back to the orchestrator and no verdict is
     issued. Reviewer names a seat, never a person.

     The revision line is what makes this file evidence about a revision rather than
     about a filename. Keep the one for the mode, or the two for ticket-review: paste the
     output of `git hash-object <the artefact>` for the file in front of you. Omit them
     all in test-review, code-review and global-review; nothing reads them there. -->

### VERDICT: <APPROVED | CHANGES REQUESTED>
Cycle: <n> of <cap>
Mode: <feature-review | decomposition-review | ticket-review | bug-review | lld-review | test-review | code-review | global-review>
Reviewer: <seat name — a charter name, never a person>
Design revision: <lld-review only: git hash-object of docs/designs/<KEY>.lld.md as you read it>
Document revision: <feature-review only: git hash-object of docs/requirements/<SLUG>/requirements.md as you read it>
Record revision: <decomposition-review: git hash-object of docs/backlog/<SLUG>.decomposition.md as you read it; bug-review: git hash-object of docs/bugs/<KEY>.bug.md as you read it>
Ticket revision: <ticket-review only: git hash-object of docs/backlog/jira/<KEY>.ticket.md as you read it>
Item revision: <ticket-review only: git hash-object of docs/backlog/jira/<KEY>.item.md as you read it>

<!-- SEVERITY — one vocabulary across the whole library: CRITICAL, IMPORTANT,
     SUGGESTION. CRITICAL and IMPORTANT block acceptance; SUGGESTION never does, and
     the verdict follows mechanically: any CRITICAL or IMPORTANT means the
     changes-requested form.

     Every finding carries a location and a proposed fix. A finding without a location
     is not actionable; one without a fix hands the work back without the insight.

     Omit an empty severity section entirely. Do not write it with "none" under it — an
     empty heading reads at a glance as a section someone forgot to fill. -->

#### CRITICAL
- [<file>:<line>] <what is wrong> → <the fix>

#### IMPORTANT
- [<file>:<line>] <what is wrong> → <the fix>

#### SUGGESTION
- [<file>:<line>] <what could be better> → <the fix>

### Acceptance-criterion coverage

<!-- Derive every row yourself, from the criteria table and the testing plan. Never
     copy the author's declared counts: two integers typed by the same author agreeing
     with each other is not evidence, the tables are.
     lld-review — "Covered where" names the testing-plan row's real test.
     code-review — "Covered where" names the implementing location AND the test.
     decomposition-review and feature-review — the table is keyed on the source, not on
     criteria: one row per source part, the item or the requirement carrying it under
     "Covered where", and NO where a part is neither carried nor marked out of scope
     with a reason and an owner.
     One row per criterion, including deprecated ones. Every cell carries a value; an
     unknown is written UNRESOLVED — <what>. Owner: <role>. Resolves: <trigger>. -->

| AC | Criterion (short) | Covered where | Covered |
|---|---|---|---|
| AC-<n> | <short restatement> | <the named test, plus file:line in code-review> | YES |
| AC-<n> | <short restatement> | <what exists today> | NO — <what is missing> |

<!-- Any NO is at least an IMPORTANT finding with its own entry above. The table is the
     evidence for the finding, never a substitute for it. The column is "Covered", not
     "Verdict" — the verdict is the token at the top of this file, and one word meaning
     two things on one page is how a reader takes the wrong one. -->

Derived AC count: <n> · Derived covered: <m> · Author declared: <n> / <m> · Match: <YES | NO>

### Criterion testability — feature-review

<!-- feature-review only. One row per REQ-<n>.AC-<m> in the document, derived from its
     criteria tables, deprecated ones included. Why names the observation from outside the
     system that would disprove the criterion; a YES without one is a tick, not evidence.
     A criterion whose only gap is a bound marked UNRESOLVED is YES, with the marker named
     in Why. A deprecated criterion reads DEPRECATED and is counted in neither Testable nor
     Flagged. Any NO is at least an IMPORTANT finding with its own entry above, so an
     approved review closes on Flagged: 0.
     The second line keeps every flag an earlier round raised, because only the approving
     round is committed: 0 · NONE in round 1; from round 2, one line per criterion an
     earlier round flagged, with the round, that round's reason as the dispatch carries it,
     and how it was resolved. A flag still open belongs on the first line, not here. -->

| Criterion | Criterion (short) | Testable | Why |
|---|---|---|---|
| REQ-<n>.AC-<m> | <short restatement> | YES | <the observation that would disprove it> |
| REQ-<n>.AC-<m> | <short restatement> | NO | <why no observation could disprove it> |

Derived criteria: <n> · Testable: <m> · Flagged: <k> · <the flagged identifiers, or NONE>
Flagged in earlier rounds: <j> · <the flagged identifiers, or NONE>
- REQ-<n>.AC-<m> — round <r>: <the reason it was flagged> → <how it was resolved>

### Citation spot-check

<!-- Present whenever the artefact makes sourced claims — a requirements document citing
     its business input, a decomposition citing its source sections, a design citing its
     specifications. Where the artefact cites
     nothing, write the line with m = 0 rather than deleting the section: a reader must be
     able to tell "nothing to sample" from "nobody sampled".

     One line, closing the arithmetic. Sample at least 30% and resolve each one against
     the cited source yourself; a paraphrase that drifts from what the source says counts
     as drifted. Name the failing citations on the line, and give each one its own finding
     above as well — the line is the arithmetic, the finding is where the fix lives. A
     fabricated citation is CRITICAL and resets the cycle count to zero; say so in the
     finding, so the orchestrator applies the reset. -->

Sampled <n> of <m> citations (minimum 30%) · fabricated or drifted: <k> · <the failing citations, or NONE>

### Spoke requests — lld-review

<!-- lld-review only. One line for each cycle, with the request round of that cycle: how many
     requests, and the repository and commit they ran at. Under it, one line for each request:
     the request as written, its exit code, and the header lines that give its result (Hits: and
     Files: for a grep request, Files: for a files request, Lines: for a read request). Mark each
     grep for the Reach row with "Reach:" and say what its hits show, for example "every hit is
     in a file §3.1 names". Cycle 1 always has a request round with a Reach grep. Write "none"
     only for a later cycle with no request round. Add a line each cycle, and never edit an earlier
     one, as in the round history. The gate does not read this section. Start no line under this
     heading with "###". -->

- Cycle <n>: <count> requests, answered at <repository-id>@<12-hex>
  - Reach: <the grep as written> · exit <code> · Hits: <n> · Files: <n> · <what the hits show>
  - <the request as written> · exit <code> · <Hits: <n> · Files: <n>, or Lines: <n>>
- Cycle <n>: none

### Verification evidence — test-review, code-review and decomposition-review

<!-- Bare ticks are not evidence: every row quotes the machine's own words. The
     reviewing seat holds no shell to run code, so commands, exit codes and output arrive
     inside the dispatch and this table records exactly what arrived. A check whose output was not
     provided is NOT PROVIDED, and NOT PROVIDED never counts as a pass — hand the round
     back and ask for the missing output rather than reasoning around its absence. -->

| Check | Command as run | Exit | Evidence (quoted from the output) |
|---|---|---|---|
| <tests> | <command> | 0 | <the runner's summary line, verbatim> |
| <types> | <command> | 0 | <the checker's summary line, verbatim> |
| <check> | <command> | NOT PROVIDED | NOT PROVIDED — returned to the orchestrator |

<!-- test-review only: the red, one row per new or changed test, quoted from the
     orchestrator's log at the test commit, never from the test writer's own table. Any
     outcome but the first two is a finding with its own entry above. -->

| AC | Test | Outcome at the test commit | The failing line, quoted from the log |
|---|---|---|---|
| AC-<n> | <test name> | <red: assertion · red: not implemented · green · red: wrong reason> | <verbatim> |

### Round history — lld-review

<!-- lld-review only, and the reason is mechanical: this mode has one committed file per
     work item, and each round overwrites it, so without this list round one leaves no
     trace. The other modes return each round to the orchestrator, which already keeps
     them separately — a history there would be a second copy that can disagree with the
     first.

     One line per cycle, appended, never edited. Name the verdict in words; never start a
     line here with the verdict heading, because the gate counts those lines and fails on
     any count but one. The round count belongs to the orchestrator, and this list must
     reconcile with it. -->

- Cycle <n> (<YYYY-MM-DD>): <APPROVED | CHANGES REQUESTED> — CRITICAL <n> · IMPORTANT <n> · SUGGESTION <n>

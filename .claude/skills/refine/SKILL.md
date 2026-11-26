---
name: refine
description: The product-planner's method for tightening one existing work item, or backfilling a decomposition that arrived incomplete — what may be changed, what may not, and why a change of intent is a new item rather than an edit.
---

<!-- Part of the harness asset library c6f3b4427d58f7c3 (see VERSION.json) · 2026-09-01 -->

# Skill — refine

Loaded by the `product-planner` seat (`.claude/agents/product-planner.md`), which names it as
its second method. Its companion is `.claude/skills/decompose-requirements/SKILL.md`: that skill
cuts a source into a backlog, this one repairs a single item in a backlog that already exists.
Same identifiers, same traceability grammar, same cap, same approval gate in front of a tracker.
`.claude/rules/workflow.md` owns what a work item is; `.claude/rules/worker-critic.md` owns
the loop; this file owns the repair.

**No command wraps this method, deliberately.** `/decompose` owns the cut, which has a
beginning and an end; a repair does not, and a command that could be invoked on any item at any
time would be a standing licence to edit the backlog. The repair is dispatched to the planner
seat by the role that owns the backlog, and whoever dispatches it holds the round count and the
escalation. That is the only difference from the decomposition loop — the caps, the severities,
the tokens and the approval gate are properties of the loop, not of the entry point.

**The scope is deliberately one item at a time.** An item that is unclear is a defect in one
artefact. A backlog that is unclear across the board is a defect in the cut, and re-running
the decomposition is cheaper and more honest than refining thirty items into agreement.

## When to reach for it

| Symptom | What it usually means | What refinement does |
|---|---|---|
| A criterion cannot be tested as written | It states an intention, not an observable behaviour | Restate it as something a test can hold, from the source |
| The item has no size a team could commit to | Its boundary is unclear, not its estimate | Establish the boundary against the source; propose a split if it is genuinely two items |
| Criteria are all positive | The negative cases were never written | Add what must not happen, what must be rejected, what must fail closed |
| The item arrived in no record | A handoff was broken, or the record was never written | Take the backfill path below |
| Its traceability line is missing or unresolvable | It was written from a summary, or invented | Resolve it against the source, or open a clarification |
| A dependency surfaced after the cut | Normal — dependencies are discovered during design | Record it in the dependency map, both directions checked |

**When not to reach for it:**

- The item's intent has changed. That is a new item and a clarification, never an edit (see
  below).
- The item has passed the design merge. Editing the acceptance criteria of an item past
  human gate 1 is prohibited outright (`.claude/rules/workflow.md` § Prohibited); the route
  is a clarification and a human amendment.
- The source document has moved to a new revision. That is a new decomposition record, not
  an edit of items written against the old one.
- Several items are wrong in the same way. Re-cut, do not patch.

## Read before you touch

**Refine from the source, never from the item's own text.** An item that is ambiguous is
already carrying drift; rewriting it from itself launders the drift into confident prose and
removes the evidence that anything was ever wrong.

In this turn, before the first edit:

1. The item file in full — `docs/backlog/<SLUG>/<KEY>.item.md` — including its clarification
   rows and its decisions log.
2. The record it belongs to — `docs/backlog/<SLUG>.decomposition.md` — and the key block that
   record took from `docs/backlog/keys.json`.
3. Every source section the item cites, at the revision the record names — resolve the line
   ranges yourself rather than trusting the item's paraphrase of them.
4. Its row in the coverage map and its edges in the dependency map, both held in
   `docs/backlog/<SLUG>.decomposition.md`.
5. Any design that already exists for the key, at `docs/designs/<KEY>.lld.md`. If one does,
   the item is at `SPEC IN PROGRESS` or beyond, and refinement is almost certainly the
   wrong move — establish whether the design has passed human gate 1 before you touch
   anything, because past that merge the criteria are frozen.

If a cited section does not resolve — the document moved, the lines shifted, the section was
renamed — that is a finding, not a formatting problem. Repair the citation against the real
document and record what it used to point at.

## What may change, and what may not

| May change | Condition |
|---|---|
| The wording of a criterion | The behaviour it asserts is unchanged and traceable to the same source lines |
| Missing criteria | Each new one carries the next free `AC-<n>` and its own Source cell |
| Missing negative cases | Same rule — appended, never renumbered in among the existing ones |
| Sizing, as a *proposal* | A split is a scope change; propose it, do not execute it silently |
| Dependency links | Recorded in the dependency map, checked for cycles after the edit |
| Traceability citations | Repaired against the real document, with the previous target noted |
| Confidence tags | Upgraded only when a rank 1–3 source now supports the claim |

| Must not change | Why |
|---|---|
| The item's intent | A different intent is a different item. Editing in place destroys the record that the change happened |
| The item's key | Downstream artefacts, worktrees, branches and designs resolve by that key |
| Any `AC-<n>` number | Tests reference them. To retire a criterion, mark it `DEPRECATED` and keep the number |
| The item's priority | Value ranking belongs to the role that owns the backlog, and refinement is not a route around that |
| A criterion on an item past the design merge | Human gate 1 has already accepted it; it changes by amendment, with a human |

Everything you do change is recorded: what changed, which source line settles it, and the
turn it happened in. An item whose history cannot be reconstructed is an item nobody can
trust to be what it was approved as.

## Proposing a split

An item found to be too big during refinement is not silently divided. The rule from the
decomposition method still binds: more than one reason a reviewer could reject it means it
is two items sharing a title.

1. Write the proposed siblings into the decomposition record — traceability lines, criteria,
   dependencies — as a proposal, not as item files and with no keys minted.
2. Keep the original key on exactly one of them, the one that retains the original intent.
   The others take new keys from the ledger, in a new block, when the split is executed. Never
   renumber, never recycle.
3. Route it: a split changes what was merged, so it goes back through `/decompose`'s review
   and `check-decomposition` on a pull request before anything moves in a tracker.

## The backfill path — a broken handoff or a missing record

An item can arrive without the context that should have come with it: no record, no coverage
row, a traceability line pointing at a document that has since been restructured. Backfill
reconstructs the missing artefacts; it does not invent them.

1. **Rebuild from the source, not from the item.** Find the section the item's behaviour
   actually derives from and read it. If no section supports it, stop — you have found an
   invented requirement, and it is a clarification for the role that owns the source, not a
   gap for you to fill.
2. **Restore the item to its record.** An item belongs to exactly one decomposition record,
   and its key sits in the block that record took from the ledger. Where the record exists and
   the item is simply missing from its Items table or the ledger's block, restore the row and
   the block — `check-decomposition` refuses the record until they agree. Where no record
   exists at all, do not write one from the item: a record inferred from one of its items
   invents scope, and it is a fiction that will be cited later as though it were reviewed. That
   is a clarification for the role that owns the backlog, and the answer is a `/decompose` run.
3. **Restore the coverage row** for the sections involved, in both directions: the section
   maps to the item, and the item claims nothing the section does not contain.
4. **Mark what was reconstructed.** Tag the backfilled content `derived` (`CLAUDE.md` §6),
   name the turn that produced it, and say what evidence it rests on. Never present a
   reconstruction as though it were the original — the next reader's trust in it should
   match the evidence behind it, and only the tag carries that.
5. **Anything still missing stays marked**, in the pinned grammar and nowhere else:
   `UNRESOLVED — <what>. Owner: <role>. Resolves: <trigger>.` Never a bare `TBD`, never an
   empty cell, never a dash standing in for an answer.

## Refining is not re-scoping

**A change of intent is a new item and a clarification, not a silent edit.**

This is the rule the whole skill exists to protect. Sharpening a criterion so a test can
hold it leaves the agreement intact — the same behaviour, stated better. Changing what the
item is for replaces the agreement while keeping its identifier, so every downstream
artefact that cites the key now cites something nobody approved: the design references it,
the tests reference it, the gate reads it, and the audit trail shows a single unchanged
item all the way through.

When the intent has moved:

1. Leave the original item as it is.
2. Mint a new key for the new intent, with its own traceability line and criteria.
3. Open a clarification row naming both keys and the role that decides which survives.
4. Let a human retire the original. Withdrawal of an approved item is their move, not yours.

## The loop — worker and critic, cap 2

A refined item is still a project-management artefact: **cap 2**
(`.claude/rules/worker-critic.md` § Revision caps). The review runs
`Mode: decomposition-review` from `.claude/skills/review-artefact/SKILL.md`, on fresh
context, and never by the planner that made the edit. The seat is `pm-critic`
(`.claude/agents/pm-critic.md`) — the same seat that reviews a full decomposition, because the
lens is the same one.

- Findings are `CRITICAL`, `IMPORTANT` or `SUGGESTION`. `CRITICAL` and `IMPORTANT` block
  acceptance; `SUGGESTION` does not.
- The verdict is a literal token: `### VERDICT: APPROVED` or
  `### VERDICT: CHANGES REQUESTED`, followed by `Cycle: <n> of 2`.
- **The critic writes no file in this mode, and never edits the item.** The review returns
  in-loop; whoever dispatched it persists each round to the system temporary directory and
  writes the final round beside the record as `docs/backlog/<SLUG>.decomposition-review.md`, so
  the record is touched no further after the round that approved it.
- Review is delta-only, so the resubmission carries the change list: what changed, which
  finding each change addresses, and what was deliberately left alone and why. For a
  refinement the delta *is* the artefact, which makes the change list the whole submission.
  Whoever dispatches the review also hands in the diff since the last reviewed round, stored
  the way `/decompose` § What it does, step 6, stores it.
- **On reaching the cap: stop.** Escalate to the engineering lead with the file in its last
  reviewed state, the deduplicated findings from both rounds, and the specific question a
  human must answer. Two rounds of disagreement about one item means the source is
  ambiguous, and the ambiguity is upstream of anything a third round could fix.

## Never

- Never change an item's intent in place.
- Never renumber, reuse or retire an `AC-<n>` identifier by deletion — deprecate and keep
  the number.
- Never change an item's key or its priority.
- Never edit a criterion on an item that has passed the design merge.
- Never resolve a source conflict silently; the higher source wins **and** the disagreement
  is logged, and equal ranks are not resolved at all.
- Never fill a gap with a plausible sentence. A gap the source does not close is a
  clarification with an owner.
- Never push a refined item to a tracker without a recorded human approval naming the key —
  the same hard gate as the decomposition, for the same reason, and the tracker call is the
  same placeholder contract.
- Never refine your own item and mark it accepted.

## Escalate — stop and raise, rather than decide

- The item's cited source cannot be found or has been restructured beyond recognition.
- The item conflicts with its record's coverage map, or with a sibling's criteria.
- Refinement would change intent, and no human has decided whether it should.
- The item is past human gate 1 and is wrong.
- The revision cap is reached.

An item held open for a day with a named question is cheaper than an item quietly rewritten
into something nobody agreed, and only one of the two is recoverable.

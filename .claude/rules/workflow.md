---
name: workflow
description: The work-item state machine, transition ownership, and gate eligibility.
globs: ["**/*"]
alwaysApply: true
---

# Rule — work tracking and the state machine

This rule governs how a work item moves. It is always loaded, because every task is a
transition on this machine whether or not the agent thinks of it that way.

## The state machine

    TODO
      │  (agent: a design has been started)
      ▼
    SPEC IN PROGRESS
      │  [HUMAN GATE 1] the design pull request is merged to the trunk
      │  (agent: the pickup gate then exits 0 against origin/main)
      ▼
    DEV READY  ◀── eligibility is decided by the gate script, not by this status
      │  (agent: implementation begins in a worktree)
      ▼
    IN PROGRESS  ◀──────────────────────────────┐
      │  (agent: non-draft pull request opened,  │
      │   every check but qa-gate green)         │
      ▼                                          │
    IN REVIEW                                    │
      │  (agent: QA starts on the pull request's │
      │   head commit)                           │
      ▼                                          │
    IN TESTING ──── (agent: a criterion FAILs) ──┘  the fix goes to the same branch
      │  [HUMAN] the passing validation report is merged in the hub
      │  [HUMAN GATE 2] the implementation pull request is merged, qa-gate green
      │  (agent: verifies the merge — pull-request state reads MERGED)
      ▼
    DONE

    A merge to the spoke's trunk therefore means the change passed QA.

    BLOCKED is not on this diagram. See "Blocked is a flag" below.

## Transition ownership

Every transition on this machine is agent-owned except the three merges, which are human: the
design pull request, the validation report's pull request in the hub, and the implementation
pull request. Each merge is a gate in front of a transition, not a transition itself — the agent
still has to verify the merge landed before it moves the item. The validation merge comes before
the implementation merge: QA validates the head of the open implementation pull request, and the
spoke's `qa-gate` keeps that pull request from merging until a passing report names its head.

**Two further human merges sit in front of the machine and are not transitions on it**, because
they happen once per requirements document rather than once per item: merging the requirements
document, and merging the decomposition cut from it. Each has a script on its pull request —
`check-requirements.js` and `check-decomposition.js` — and the merge is the only human act; no
row is typed into either artefact. They are in the table below so the whole picture is in one
place. Counting them as gates on a work item is the mistake to avoid — one document producing
forty items still needs each of them once.

This is the canonical ownership table: every transition, the command that owns it, and the
verification that command must produce. It lives here and nowhere else. The commands carry the
same rows in their own transition tables because a command has to state what it owns — those
are the implementation, this is the contract, and if one drifts this file wins.

| Transition | Owned by | Verification the owner must produce |
|---|---|---|
| — | **[HUMAN, the requirements merge]** | the requirements pull request in the hub is merged. `check-requirements.js <SLUG>` ran on it through `requirements-gate` and reported green — the document's identifiers, its criteria, and an approved review bound to its content; the merge is the only human act. Once per document, not per item |
| — | **[HUMAN, the decomposition merge]** | the decomposition pull request in the hub is merged. `check-decomposition.js <SLUG>` ran on it through `decomposition-gate` and reported green — every requirement claimed or excluded, every story in one listed repository, keys from the ledger, an approved review bound to the record; the merge is the only human act. Once per decomposition |
| — | **[HUMAN, the intake merge]** | for a story taken from a Jira ticket, in place of the two merges above: the intake pull request in the hub is merged. `check-intake.js <KEY>` ran on it through `intake-gate` and reported green — a snapshot of the ticket that meets the quality bar, a work item traced to it both ways, and an approved review bound to both; the merge is the only human act, and the person who merges attests that the snapshot matches the ticket. Once per ticket |
| (nothing) → `TODO` | `/decompose` | the item file exists in the backlog directory, traced, reviewed and complete, and `check-decomposition.js <SLUG>` exits 0 against the trunk |
| (nothing) → `TODO` | `/from-ticket` | for a story taken from a Jira ticket: `docs/backlog/jira/<KEY>.item.md` exists beside the ticket's snapshot and its review, and `check-intake.js <KEY>` exits 0 against the trunk |
| `TODO` → `SPEC IN PROGRESS` | `/dev-spec` | `git worktree list` names the hub checkout `/dev-spec` made, on its branch, and the design file is committed on the branch |
| — | **[HUMAN GATE 1]** | the design pull request is merged. No machine check; irreducible |
| `SPEC IN PROGRESS` → `DEV READY` | `/dev-sprint`, first invocation, precondition 1 | the pickup gate exits 0 against the freshly fetched trunk |
| `DEV READY` → `IN PROGRESS` | `/dev-sprint`, first invocation | the same gate exit 0, and the code checkout `/dev-sprint` made is on the branch, cut at the commit it recorded |
| `IN PROGRESS` → `IN REVIEW` | `/dev-sprint`, first invocation or a fix round | a non-draft pull request into the spoke's harness trunk is open, and every check on its head commit is green except `qa-gate`, which stays red until the validation merge |
| `IN REVIEW` → `IN TESTING` | `/qa-sprint`, a validating run, before any seat is dispatched | the implementation pull request was queried: open, not a draft, its base the trunk `read-spoke.mjs` names, every check but `qa-gate` green on its head commit; that head commit is recorded |
| `IN TESTING` → `IN PROGRESS` | `/qa-sprint`, a validating run | at least one criterion is `FAIL` at the recorded head commit. The findings file names that commit, and nothing is written to the hub. `/dev-sprint` runs a fix round on the same branch |
| — | **[HUMAN, the validation merge]** | the validation report's pull request in the hub is merged. `check-validation.js` ran on it and reported green, which means the report is complete and every criterion passed; the merge is the only human act |
| — | **[HUMAN GATE 2]** | the implementation pull request is merged. `qa-gate` ran on it and reported green: the merged report names this repository and this head commit. The merge is the only human act |
| `IN TESTING` → `DONE` | `/qa-sprint`, final run | the implementation pull request was queried and reports `state == MERGED`; `check-validation.js <KEY>` exits 0 against the hub's trunk; and the report's `Repository:` is the story's and its `Spoke commit:` is the merged pull request's head commit |

`/dev-spec` makes the hub checkout and `/dev-sprint` makes the code checkout. Each command
then checks its own transition against git, never against its own report of what it made.

**`/feature` owns no transition either, and for a different reason: it runs before this machine
starts.** It produces the requirements document `/decompose` cuts into items, so at the point it
runs there is no work item to move — the state it advances is the document's own, and the merge
of its pull request, with `check-requirements.js` green on it, is what releases it. Nothing on
this diagram is a proxy for that merge, and no agent performs it. A document found wrong while
its pull request is open is not merged and not hand-edited: `/feature` runs again on that branch
as an amendment, and a fresh review comes back to the same pull request. A requirements document is a
precondition of `(nothing) → TODO`, never a state on this machine.

**`/enrich-ticket` owns no transition, for the same reason.** It runs before the ticket is a story
in the hub. It changes the ticket in Jira, with the PM's approval, so that `/from-ticket` can take
it. A story taken from a ticket has no requirements document: its snapshot is its source, and the
intake merge stands in for the requirements merge and the decomposition merge.

**A design is amended the same way before human gate 1.** A person who wants to answer a question
in its §9, or to change what it says, while its pull request is open does not merge it and does
not edit it by hand: `/dev-spec <KEY>` runs again on the design's branch as an amendment, writes
the person's answers into the design, and a fresh review comes back to the same pull request. It
owns no transition; the item stays at `SPEC IN PROGRESS`. After the merge, the rule below holds.

**`SPEC IN PROGRESS → DEV READY` is not a separate act.** It is the first thing `/dev-sprint`
records when its precondition clears, from the same exit code that authorises the move to
`IN PROGRESS`. `/dev-spec` cannot own it — it ends in front of human gate 1 and the gate cannot
exit 0 before that merge — which is why that command's Never list forbids granting it.

**The pickup gate is a post-merge trunk check by construction.** It reads only
`origin/main`, so it cannot run before the design merge — a design that exists only on a
feature branch fails every gate. Sequence the gate before the merge and you have a check that
can never exit 0, and the tempting local fix, pointing it at the branch, deletes the one
property the gate exists to establish.

**The governing principle.** An agent may advance a work item only when it can
mechanically verify that the advance is legitimate — a script exit code, a pull-request
state read from the API, a review file containing an exact verdict token. Everything else
is human. The three irreducibly human acts **on this machine** are the **design merge**, the
**validation merge** and the **implementation merge**; the requirements merge and the
decomposition merge are human for a different reason — they sit before the machine, and no work
item exists for them to advance.

"I believe this is done" is not verification. Neither is a passing local run of a check
that CI does not also run.

## Repository truth beats tracker status

**A work item marked DEV READY whose repository gates fail is not eligible, regardless of
its tracked status.** Status is a projection. The repository is the fact. Where they
disagree, the repository wins and the status is corrected — never the other way round.

Corollaries:

- Never gate against stale state. Force-fetch the default branch before evaluating any
  gate. If the fetch fails, exit non-zero with a distinct code — a silent stale default
  branch is exactly the bug the gate exists to prevent.
- A gate that cannot determine the answer **fails**. There is no "probably fine".
- Never mark a transition in the tracker before the verification that authorises it. The
  tracker is updated *after* the fact, from the fact.

## Subtasks are banned

One work item is one unit of deliverable work with one design, one pull request, and one
set of acceptance criteria. Do not create subtasks, child items, or checklist items that
carry their own state.

Why: subtasks fork the state machine. A parent in IN REVIEW with three children in
IN PROGRESS has no defined state, so no gate can evaluate it and no agent can own the
transition. If a work item is too large for one design and one pull request, it is not
one work item — split it into siblings in the same decomposition, each independently gateable.

Decomposition happens at planning time, in the backlog, by a human. It does not happen
mid-flight by an agent creating children.

## Blocked is a flag, not a state

When work cannot proceed:

1. Raise a **flag** on the work item with the reason and the role that can unblock it.
2. Leave the item **where it is** in the workflow.
3. Add a clarification row if the blocker is a question: to §9 of the item's design while
   the design is still on a branch; to `docs/designs/<KEY>.clar-log.md`, the item's own log,
   once the design is merged — handed back as text for the orchestrator to write.

Do not move the item to a BLOCKED column. The column destroys the information about what
the item was blocked *during*, which is the only part that helps anyone. A flagged item
in IN PROGRESS tells you an implementation is stalled; the same item in BLOCKED tells you
nothing.

Flags are cleared by the role named on them, not by the agent that raised them.

## Traceability

Every work item must cite its upstream sources by document and section — both the
functional and the design specification where both exist. This is non-negotiable and it
is checked. An item without traceable citations does not pass the gate even if the
implementation is correct, because in twelve months nobody will be able to establish why
the code does what it does.

Citations are spot-checked. Fabricating one is a defect of the same class as a failing
test, not a documentation slip.

## Prohibited

- Creating subtasks or child items (above).
- Editing the acceptance criteria of an item that has passed the design merge. Renumbering
  acceptance criteria IDs, ever — they are stable identifiers referenced by tests.
- Advancing an item on the strength of a status label.
- Closing an item with a blocking clarification in any status other than `Closed` or
  `Withdrawn`. `Answered` is not sufficient — the answer has to be written back into the
  specification first.
- Reopening a merged design to accommodate an implementation difficulty. Raise a
  clarification; the design changes by amendment, with a human in the loop.

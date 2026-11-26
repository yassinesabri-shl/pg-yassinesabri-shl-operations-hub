---
name: draft-adr
description: The method for drafting an architecture decision record for the lead architect — establishing that a decision is real, capturing the constraints that applied at the time, and stating consequences honestly — when a design meets a decision wider than its work item.
---

<!-- Part of the harness asset library c6f3b4427d58f7c3 (see VERSION.json) · 2026-09-01 -->

# Skill — draft-adr

**No seat owns this method.** It is loaded by the `engineer` seat (`.claude/agents/engineer.md`) part-way through `/dev-spec`, when the design cannot be written until something wider than this work item is settled. The engineer writes a draft at `docs/designs/<KEY>.adr-draft.md` from `docs/designs/_TEMPLATE.adr-draft.md`, section for section, and the design's §9 links it from a blocking row routed to the lead architect. The architect takes the draft to where the client keeps its records and decides there; the decision comes back as a summary written by `/add-context --kind adr` (`docs/architecture/_TEMPLATE.adr.md`). Where the template and this file disagree on shape, the template wins.

## When to reach for it

**Two tests, and both must hold: the decision is expensive to reverse, and it binds work
beyond the change in hand.** A cheap reversal needs no ceremony, and a decision nobody
outside this work item inherits has no audience for a draft.

| The decision | Where it belongs |
|---|---|
| Affects one work item, and undoing it costs an afternoon | The decisions log inside that item's design. Closed there, not reopened |
| Sets a boundary other work items have to obey | A draft |
| Changes how the system is divided, stored, sequenced or integrated with | A draft |
| Is reversible only by a co-ordinated change across teams | A draft — reversal cost is the test, not the size of the diff |
| Was taken elsewhere and you are describing it | Neither. Cite the record; if neither the hub nor the design's repository has a summary of it, stop and say which record `/add-context --kind adr` should bring in, and where |
| Is a business call — cost, vendor, timing, risk appetite | Neither. Escalate |

**One draft per decision.** A work item that needs three records is three work items, or two of
the three are designs. A second draft against the same work item is a signal to re-read the first.

## Inputs

| Input | Form | Where it comes from |
|---|---|---|
| The work item and the epic it belongs to | Identifiers already agreed | The backlog |
| The forces | Measurable pressures — a latency budget, a volume, an obligation, a capability the team does not have | The sources the work items cite |
| The constraints | Each with the source that imposes it | Signed sources, versioned contracts, applicable regulation |
| The existing records | Every record summary touching the same surface: the hub's, and the design's repository's own (`<repository-id>.ADR-<NNN>`) | `docs/architecture/` on the trunk, and the repository's `DECISIONS_INDEX` folder through `scripts/read-context.mjs` |
| The codebase as it is | Read from the tree, never from a plan | The default branch |
| The clarification logs | Where a force is asserted by nobody | `docs/designs/*.clar-log.md`, one for each work item |

**Read the existing records before you write a word.** A draft that contradicts an accepted
record is not a new decision, it is a request to change one — and writing it as though the
earlier one did not exist would leave two records giving opposite instructions to whoever
reads them next. Say so in §1 and name the record.

## Establish that a decision is being made

**A draft listing one option is a justification.** The template asks for at least three,
each with its mechanism, a specific downside and a cost to reverse, because the alternatives
are what make the choice legible later. Without them a reader cannot tell a considered
decision from the only thing anyone thought of.

- **A straw option is worse than a missing one.** The test: name the role that would have
  argued for it. If you cannot, you have written a foil, and a reader who spots one stops
  believing the other two.
- **"Do nothing" and "defer" are real options** and they sometimes win. Give them a
  mechanism as well: what happens to the pressure in the meantime, and what the decision
  costs when it is finally taken.
- **Cost to reverse is per option, and it changes answers.** An option that is worse today
  and cheap to unwind beats one that is better today and permanent, whenever the forces are
  contested.
- **If every option scores the same against every force**, either the forces are missing or
  the choice does not matter. Both are conclusions about the draft, not cells to fill.
- Where an option was rejected in conversation, record **why** it lost, not that it lost. A
  rejection with no reason is re-proposed within the year.

## Context — the section the draft exists for

**Write it for a reader two years out who has none of what you have today, and include the
constraints that have since disappeared.**

This is the section that carries the draft's whole value, and it is the one most often
written thinly: two paragraphs on what was built and nothing on what pressed on it. A
decision separated from its pressures reads as arbitrary, and the next reader either
preserves it without knowing why or overturns it without knowing what it was buying.

| Element | The test it has to pass |
|---|---|
| What is true today | Followable by someone who has never opened the codebase |
| What changed, and why the decision is needed now | The trigger is named. A decision with no trigger is a preference |
| The forces | Each measurable or observable, each naming the option it pushes toward. "Performance" is not a force; a stated latency budget at a stated percentile is |
| The constraints | Each names its source. A constraint with no source is a preference in a constraint's clothes |
| The constraints that will expire | Staffing, a delivery date, a licence, a platform the team does not operate yet — stated as such, with the condition that ends them |

**The expiring constraints are what the section turns on, and they are the first thing left
out** — at the time of writing they feel like excuses. Two years later the team has the
platform, the date has passed, and the draft reads as though someone chose the worse option
for no reason. Naming the condition that ends a constraint is also what tells a later reader
the decision is ready to be revisited.

**Test the section by covering the decision.** Hide §3 and give §1 to someone who was not
there. If they cannot reach a decision close to yours, the context is thin — and the fix is
in §1, not in §3.

## Consequences — what this makes harder

**State what this makes worse in the same detail as what it makes better.** A draft with
only benefits is marketing: the next reader discounts the whole document, including the
parts that were true, and the cost you left out is found by whoever operates the system.

- **Accepted costs are costs you are choosing.** Magnitude is bounded and measurable —
  "minimal" is not a magnitude, and a cost with no size cannot be weighed against the next
  option.
- **"None" is a permitted mitigation and a better answer than an invented one.** A
  mitigation nobody will build is a second cost hidden inside the first.
- **New obligations outlive their authors.** Name the role that carries each and the place
  it is enforced, in the adopting team's own terms. An obligation with nowhere to be
  enforced is a wish, and it decays quietly into the failure the draft predicted.
- **If you cannot name a cost, you have not understood the option you chose.** Every
  structural choice buys one property with another. A draft that found a free one has
  almost always skipped the analysis rather than found the exception.

## Never

- Never ship a draft whose options section carries one entry. Either there were
  alternatives and you owe them, or there was no decision and you owe no draft.
- Never put an acceptance criterion, a file path, a function signature or a data shape in a
  draft. Those belong to the design.
- Never write a placeholder cell — a dash, `TBD`, `N/A`, `TODO`, `pending` or `?`. Mark the
  unknown as `UNRESOLVED — <what>. Owner: <role>. Resolves: <trigger>.`
- Never cite a source you have not opened.
- Never write a draft for a decision nobody has to make. Padding costs the architect attention
  that the decisions which actually bind were going to get.
- Never decide for the architect. The draft states the options and the choice you propose; the
  decision is made where the records are kept.

## Escalate — stop and raise, rather than decide

- Two same-rank sources conflict. Surface both, resolve neither (`CLAUDE.md` §4).
- A force is asserted by no source and owned by no role — that is a clarification, not a row
  in the forces table.
- A §5 row is breaking and the owning system has not agreed the new version.
- The decision is a business call. Name the options and hand it over.
- An accepted record contradicts what you are about to propose.

A decision held open for a day with a named question is cheaper than a decision recorded
confidently against forces nobody agreed, because the second one gets cited.

## The draft in the design

- The design's §9 gets one row: `Blocking` `yes`, `Routed to` lead architect, the question
  "Decide <the decision> where the records are kept; the draft is
  `docs/designs/<KEY>.adr-draft.md`". The gate blocks the design while that row is open.
- The draft is committed on the design branch with the design and its review, and is part of
  the design pull request.
- The draft is not reviewed by a critic. The architect reviews it, where the decision is made.
- The draft says where the decision binds. A decision for the whole estate becomes a hub record.
  A decision for one repository's code only becomes that repository's own record,
  `/add-context --kind adr --repo <ID>`, which every hub of the repository reads. A repository's
  record narrows the hub's records and never overrides one. A draft that would contradict an
  `Accepted` hub record says so in its first line, because the architect changes one of the two.
- When the summary is on the trunk that keeps it, the hub's or the repository's, the `/dev-spec` amendment writes the record's number into
  the design's §1 table (`ADR-<NNN>`, or `<repository-id>.ADR-<NNN>`), runs `read-context.mjs` from the hub root checkout (on the trunk brought
  up to date) with `--design` pointing at the design file, copies the printed `Context:` and
  `Hub commit:` lines into the design together, closes the row with the record's number, and deletes the draft in the same
  commit. A draft never reaches the trunk.

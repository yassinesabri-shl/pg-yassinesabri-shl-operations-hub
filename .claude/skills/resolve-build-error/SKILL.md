---
name: resolve-build-error
description: The utility method for clearing one mechanical build, type or lint failure — what counts as mechanical, the smallest-diff rule, the four forbidden routes to green, the three-attempt cap and the handback report.
---

<!-- Part of the harness asset library c6f3b4427d58f7c3 (see VERSION.json) · 2026-09-01 -->

# Skill — resolve-build-error

Loaded by the `build-error-resolver` seat (`.claude/agents/build-error-resolver.md`), a
utility seat dispatched on one failure at a time by whichever seat is running the build —
usually the local fix loop in `.claude/skills/pre-merge-check/SKILL.md`, with the
`sprint-orchestrator` seat (`.claude/agents/sprint-orchestrator.md`) holding the count. That
caller owns the procedure, the shell and the re-run; `.claude/rules/worker-critic.md` owns
the caps and the escalation; this file owns what may be fixed here and what may not. Where
this file and the calling command disagree, the command wins — it is the procedure.

**This file is a contract, not an integration.** The commands whose output you read are
stack specific, and the adopting team substitutes them once, at installation, into
`AGENTS.md` § Manual checks — or, in a hub and its spokes, into the `checks.env` of the
repository the story names, which is handed to you as text. This seat never invents one and
never runs one.

UNRESOLVED — the format, lint, type-check and build commands for this repository. Owner: tech lead. Resolves: toolchain confirmation for the target repository.

## The whole of the remit

**One failure. The smallest diff that clears it. Nothing else in the diff.**

The value of this seat is subtraction. It exists so an unresolved import does not become an
escalation, and it stops being worth having the moment it starts exercising judgement. Two
things follow, and both are load-bearing. A fix carrying a tidy-up is no longer reviewable
as a fix: whoever reads the diff has to work out which lines were the error and which were
your taste, and that costs more attention than the error did. And a mechanical seat that
guesses at intent produces a green build over a live defect, which is strictly worse than
the red build it started with, because a red build is something somebody investigates.

## Inputs

| Input | Form | Where it comes from |
|---|---|---|
| The failure | The build, type-checker, formatter or linter's own output, verbatim | The dispatch — the caller holds the shell |
| Its location | The file and the line the output names | The output, never inferred |
| The attempt number | `<n> of 3` | The caller, which holds the count |
| The tree as it is | Read in the worktree the dispatch names | The worktree |
| The repository's commands | `AGENTS.md` § Manual checks, or the repository's `checks.env` as the dispatch hands it in — read to understand what produced the output | Installation, or `/dev-sprint` |

**You never run the build, and you never assert that a fix worked.** The caller re-runs and
re-dispatches. If the output was not passed in, or arrives summarised or truncated, hand the
dispatch back and ask for it — a failure reconstructed by reading the source is a failure
you invented, and you will fix the one you invented.

## What counts as mechanical

**A failure is mechanical when the tool has already named the fix.** You are transcribing
its answer into the file, not deriving one.

| The failure | The mechanical remedy | Not mechanical when |
|---|---|---|
| An unresolved import, or an unknown module | Add the import the named symbol needs, or correct the path to the module that already holds it | Neither the module nor the symbol exists anywhere. Something has to be written, and what it should contain is a design question |
| A symbol imported from a path that has moved | Re-point the import at the module that exports it now | More than one module exports that name and the output does not say which was meant |
| A formatting failure | Apply the formatter's own stated output at the named location | It would rewrite lines the failure does not name. That is a repository-wide reformat riding on one work item |
| A lint rule with one obvious remedy — an unused import, a missing element, an ordering rule | Change the code so the rule is satisfied | The remedy is to restructure the code, or the rule is arguable. The rule itself is never the thing you change |
| An obvious type mismatch — an argument in the wrong position, a literal of the wrong shape, a field the caller already holds and did not pass | Correct the call site | Correcting it means deciding what the value ought to be, or the declared type is what is wrong |

Everything else is a handback. A handback costs the caller one dispatch; a confident wrong
fix costs a review round, or a defect on the trunk, or both.

## What is never mechanical, whatever the output looks like

- **A test file.** Any test file, for any reason — including a build failure inside one that
  looks exactly like the import fix above. The line is deliberately wider than the rule it
  protects: a seat permitted to edit tests "only mechanically" has to judge whether this
  edit is the mechanical kind at the exact moment it is under most pressure to be useful,
  and this seat exercises no judgement of that sort by design. Hand it to the engineer seat,
  which owns tests.
- **A contract, schema, interface definition or event definition.** A compile error against a
  contract is the finding, not the obstacle in front of the finding. Changing the shape
  locally produces a build that passes and an integration that fails, discovered by someone
  else, later, with nothing pointing back at this edit.
- **A generated type.** It is regenerated from its declared source, and regeneration is a
  command you do not hold. A hand-written duplicate compiles, passes review and drifts
  silently — the worst combination available.
- **A merged migration, or any artefact declared immutable.** New behaviour arrives as a new
  changeset, which is authoring, not resolving.
- **A rule configuration, a strictness setting, an ignore list or a coverage floor.** See
  below.

## The four cheapest routes to green, all closed

**Never widen a type, add a suppression, disable a rule or silence a warning to clear an
error.**

Each of the four works immediately, and each does the same damage: the error was a true
statement about the code, and all four delete the statement rather than the cause.

- **Widening a type** converts a failure the checker caught at build time into one a user
  finds at run time. Nothing was fixed; the discovery was postponed and made more expensive.
- **A suppression** silences one site permanently. It outlives the situation that prompted
  it, so the next person on that line inherits a check that is off with no record of who
  turned it off or why. On a security finding a suppression needs a named human approver and
  a linked justification (`.claude/rules/security.md` § Prohibited), and nothing about this
  dispatch makes you that approver.
- **Disabling a rule** removes it from every file, not the failing one. A control the whole
  team loses to clear a single error, and nobody is told.
- **Silencing a warning** treats a low-severity finding as noise. Severity is a signal to
  somebody with limited attention, and a codebase that silences the cheap findings teaches
  its readers to skim past the expensive ones.

The same reasoning closes the neighbours: never lower a coverage floor, never add an
exclusion, and never mark a test as an expected failure.

## The method

1. **Read the failure in the tool's own words.** The output passed into the dispatch is the
   whole input — never a summary of it, never a previous attempt's account of it.
2. **Open the file and the line it names.** A fix applied from the summary lands somewhere
   else, and the build then reports a different error that looks like progress.
3. **Classify before you edit.** Mechanical, or handback. This is the only judgement in the
   seat, and erring permissively is how a defect reaches the trunk dressed as a fix.
4. **Make the smallest edit that clears that one failure, then stop editing.** Not the
   neighbouring line, not the import ordering, not the name you would have chosen.
5. **Hand back.** Report in the shape below and let the caller re-run. You never establish
   that the fix worked; the build does that, and the build is not yours to run.

## The attempt cap — three, on one failure

**Three attempts, then stop.** Three matches the code cap in
`.claude/rules/worker-critic.md` § Revision caps, because the artefact is code and the same
reasoning binds: a fix that has not landed in three attempts goes on not landing, and the
disagreement is not about effort.

- **The count belongs to the caller.** An agent that counts its own cap finds a reason why
  this attempt does not count.
- **It is counted per failure, across the whole work item — not per round.** The same
  failure presented again in a later round continues the count; it does not restart it.
  Otherwise three rounds of a fix loop quietly buy nine attempts at one error.
- **It is not an extra cap and it never widens another one.** Your attempts sit inside one
  round of whichever loop dispatched you, and they never earn that loop a further round.
- **On the cap: leave the tree as your last attempt left it and say so.** Do not revert, do
  not tidy, do not try a fourth shape. An escalation is only useful if it describes a state
  a human can still inspect. The caller escalates to the tech lead with the failure in the
  machine's words, every edit attempted and what each produced, and the specific question a
  human must answer.

## The handback report

    Failure: <the tool's own line, quoted>
    Location: <file>:<line>
    Attempt: <n> of 3
    Outcome: fixed | handed back
    Change: <one line naming the edit made> | NONE
    Handback: <what needs a decision, and the role it goes to> | NONE

**This is not a token surface and nothing parses it.** `### VERDICT: APPROVED` and
`### VERDICT: CHANGES REQUESTED` belong to the critic seats, `## Readiness:` to persona
seats, and `GATE_PASS` / `GATE_FAIL` to the design author inside a design. This seat emits
none of the three, because a report shaped like a verdict can be read by a gate as an
approval nobody gave. Its only reader is the seat that dispatched you.

`Change` names the edit, not the reasoning behind it. The caller commits it inside the work
item's own history and records it in the handoff ledger
(`docs/designs/<KEY>.handoff.md`) — you hold no `Write`, and the ledger is append-only and
the engineer's.

## Never

- Never edit a test to make it pass, and never edit a test file at all.
- Never change a contract, schema, interface or generated type to make code compile.
- Never widen a type, add a suppression, disable a rule, silence a warning or lower a floor.
- Never let anything travel with the fix — no tidying, no renaming, no refactor you noticed.
- Never fix a failure you were not dispatched on, however obvious it looks in the output.
- Never run a build, a suite or any other command, and never claim a result you were not
  given.
- Never invent a stack command, or read one from anywhere but the repository's commands file as
  the dispatch handed it in.
- Never create a file, commit, open a pull request, move a work item or merge.
- Never emit a verdict token or a readiness value.
- Never retry the identical edit, and never proceed past the third attempt.

## Escalate — hand back rather than decide

- The failure implies the design is wrong, or the fix needs a judgement about intended
  behaviour.
- The failure names a test, a contract, a generated type or an immutable artefact.
- The fix cannot stay inside the location the output names.
- The output was not passed into the dispatch, or arrives summarised or truncated.
- Two plausible fixes exist and the output does not distinguish them. Surface both; pick
  neither.
- The third attempt on one failure did not clear it.

A handback costs one dispatch of the cheapest seat in the library. A mechanical fix applied
to a failure that was not mechanical costs a defect nobody is looking for, on a build that
is green.

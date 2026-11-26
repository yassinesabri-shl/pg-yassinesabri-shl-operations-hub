---
name: pre-merge-check
description: The local check run before a pull request is opened — the check table, the exit-code contract, changed-only scope with a legacy exemption, log-based decisions, and the three-round fix loop. Makes continuous integration a confirmation rather than a discovery.
---

<!-- Part of the harness asset library c6f3b4427d58f7c3 (see VERSION.json) · 2026-09-01 -->

# Skill — pre-merge-check

Loaded at the last step of `/dev-sprint`, before the pull request is opened (`/dev-sprint`
§ What it does — first invocation, step 10). The command owns when this runs and what
happens next; this file owns what is checked, how the result is read, and what the result
is allowed to mean. In `/dev-sprint` it runs in the trusted controller after the approved
candidate was fast-forwarded into it — the same tree the protected-test guard's finalizer ran
the repository's commands on, from the same frozen `checks.env`. A stack row that disagrees with
the finalizer's result on that tree is a finding about the repository's determinism, never a
reason to prefer whichever was green. After a trunk merge (`/dev-sprint` § Bring the branch up
to the trunk), the check runs first on the merged tree, which no finalizer ran. There a failed
stack row means that the trunk changed something the story's code needs, and a trunk round fixes
it through the guard.

**The orchestrating command runs it, inside the worktree.** The critic holds no shell to run
code and never runs a check of any kind (`.claude/agents/dual-mode-critic.md` § Capability). It
reads only the output the orchestrator passes into its dispatch.

**This file is a contract, not an integration.** Every stack-specific command below is a
placeholder the adopting team substitutes once, at installation. The scope rule, the
exit-code contract, the round cap and the pickup gate are not placeholders — they are
enforced against the repository, they hold on every repository, and they are not the
team's to soften.

## Local green is necessary, never sufficient

**The remote pipeline is the authority. This check exists so obviously-broken work never
reaches it.**

That framing is the whole point, and losing it is the commonest way a check like this turns
harmful. A local run uses a different machine, a different dependency resolution, a
different clock and a different degree of concurrency from the pipeline. It cannot promise
the pipeline will pass. What it can do is make the pipeline's failures *interesting* — so
that a red build means something nobody could have caught locally, instead of a missing
import that cost twenty minutes of queue time and a context switch for whoever was watching.

Two consequences follow, and both are load-bearing:

- Green here is permission to open the pull request. It is never evidence that the change
  is correct, and it is never an argument in a review.
- When the pipeline fails on something this check passed, the pipeline is right. The
  correct response is to record the gap in this check, not to re-run the pipeline.

## A run, in order

1. **Resolve the comparison point** — the merge base of this branch and the trunk — and
   record it in the summary header. Every stack row is scoped to it.
2. **Re-run the pickup gate** against the refreshed trunk, first, because its findings are
   about the design rather than the diff and none of them is fixable by editing code. If
   the design moved under you, every stack row below is answering against the wrong
   contract. Dispatch the `gate-runner` seat (`.claude/agents/gate-runner.md`) rather than
   running it inline: one seat runs the gate everywhere it is run, and its output reaches you
   unedited.
3. **Run the stack rows in table order**, each to its own log, capturing the exit code
   explicitly.
4. **Read every log, including the logs of rows that exited zero**, and classify each
   finding as new or legacy.
5. **Write the summary**, in the shape below. It is written on every run, including a
   failing one; a run with no summary is a run nobody can audit.
6. **Exit 0, 1 or 2** by the contract below, and record each command, its exit code and its
   log path in this turn's handoff ledger (`docs/designs/<KEY>.handoff.md`).

## The check table

`<SPOKE-TRUNK>` below is the repository's harness trunk: the `Trunk:` line that
`node <HUB>/scripts/read-spoke.mjs <REPO-ID> .` prints. A repository that two teams share declares
a branch other than its default branch, so never take the trunk from `ls-remote` alone.

Rows marked **stub** carry no command until the adopting team supplies one; the markers
under the table name each gap and its owner. Rows not marked stub are enforced against the
repository itself and ship working.

| Check | What it proves | Auto-fixable | Blocking |
|---|---|---|---|
| Formatting — commit check | The diff carries no formatting-only noise, so review attention goes to behaviour | yes | yes |
| Linting — commit check | Changed code violates no rule the team has already agreed | in part | yes |
| Static types — commit check | The changed code, and everything that depends on it, still type-checks | no | yes |
| Tests — stub | Every suite the repository declares runs, and every test covering changed code passes, including the ones this work item added | no | yes |
| Coverage against both floors | `HARNESS_SPOKE_TRUNK=<SPOKE-TRUNK> node <hub>/scripts/check-coverage.mjs --repo . --base <the trunk commit the branch was cut from> --checks-from-trunk` exits 0: changed lines meet `CHANGED_LINE_FLOOR` and the project figure is not below `PROJECT_COVERAGE_FLOOR`, both read from `checks.env` on the repository's harness trunk. Its `COVERAGE …` record line — both figures, both floors, the checks.env blob — goes into the pull-request body | no | yes |
| Secret scan | No commit on the branch introduces a credential, key, token or connection string: the repository's `SECRET_SCAN_COMMAND`, run by `scripts/secret-scan.cjs --range origin/<SPOKE-TRUNK>..HEAD` from the hub, over every commit, not only the final diff | no | yes |
| Migration immutability — stub | No already-merged changeset was edited; new behaviour arrived as a new changeset | no | yes |
| Repository rules | The rules folder the repository's `checks.env` names with `RULES_INDEX` is well formed at the trunk (`scripts/check-spoke-rules.mjs <REPO-ID>` exits 0), and the design's `Rules:` commit is the trunk's — or the body carries `rules drift` with both commits | no | malformed: yes · drift: reported, not blocking |
| Pickup gate — design document | Exactly one `docs/designs/<KEY>.lld.md` is on the trunk and is readable | no | yes |
| Pickup gate — review file, verdict token and revision | `docs/designs/<KEY>.lld-review.md` is on the trunk carrying the approved verdict token on exactly one line, matched literally, and a `Design revision:` line naming the design as it stands on the trunk | no | yes |
| Pickup gate — readiness contract | §8 of the merged design still parses, and its declared counts still match the sets derived from §4 and §5 | no | yes |
| Pickup gate — clarification table | No blocking clarification row is still open in §9 of the merged design; `Answered` does not release one | no | yes |
| Clarification log of this key | No row in `docs/designs/<KEY>.clar-log.md` is `Blocking: yes` at `Open`, `Routed` or `Answered`. No file means no row | no | yes |
| Acceptance criteria each have a passing test | Every `AC-<n>` in §4 has the test §5 names present in the tree and passing | no | yes |
| Worktree clean | Nothing uncommitted, untracked or scratch remains (`.claude/skills/implement-work-item/SKILL.md` § Commit discipline) | no | yes |

**In a hub and its spokes, the stack rows' commands are the repository's `checks.env`.** The
repository the story names owns that file; `/dev-sprint` reads it from that repository's trunk
through `scripts/read-spoke.mjs` before it dispatches anybody, and hands the commands in as
text. Formatting, linting, static types, tests and coverage are `FORMAT_COMMAND`,
`LINT_COMMAND`, `TYPECHECK_COMMAND`, `TEST_COMMAND` and `COVERAGE_COMMAND` with its two floors;
`none` means the repository has no such step, said on purpose, and the row is reported as such
and passes. `UNRESOLVED`, empty or absent for any of those five is exit 2 for `/dev-sprint` before
this check ever runs, and so is either floor beside a coverage command: the floors are numbers
from 0 to 100, and a floor beside `COVERAGE_COMMAND=none` is refused as a contradiction. The
coverage row is judged by `scripts/check-coverage.mjs`, the same script the repository's
`story-gate` check runs on its pull request, so the two never disagree about the bar. The secret scan row is `SECRET_SCAN_COMMAND`, and it is mandatory in a
spoke: missing, empty, `UNRESOLVED` and `none` are all exit 2 for `/dev-sprint` before this check
runs, because the scan is what stops a secret before it reaches the history
(`.claude/rules/security.md` § Secret handling). The migration immutability row is
`MIGRATION_IMMUTABILITY_COMMAND`, and for it — and the repository-rules row's `RULES_INDEX`, and
only those two — `UNRESOLVED` is `NOT CONFIGURED`, below, rather than a stop.
`RULES_INDEX=none` is a declared fact, reported as `rules: none declared`, and passes. The stack rows run inside the code checkout; the
four gate rows run inside the hub checkout, with `HARNESS_REPO` set to the story's repository,
because the design lives there. Where this file says `AGENTS.md` § Manual checks, read
"`checks.env` in the repository the story names" — the hub's own `AGENTS.md` names the hub's
commands, and the hub holds no code.

**The three commit-check rows are one command, run on the commit as it will be pushed.**
`HARNESS_SPOKE_TRUNK=<SPOKE-TRUNK> node <HUB>/scripts/check-staged.mjs --repo . --head`, run in the code checkout with nothing
staged and a clean tree, runs `FORMAT_COMMAND`, `LINT_COMMAND` and `TYPECHECK_COMMAND` from the
trunk's `checks.env` on the checkout as committed, each judged by its exit code and by the tree
— the same rows `harness-commit.mjs` runs before a commit. It is a second reading, not the
first: the test writer's commits passed these rows when they were made, and the commit the
protected-test guard's finalizer built was judged by the finalizer. Without `--head` the script
judges what is staged, and with nothing staged it runs nothing. Report its rows as it prints
them — `[PASS]`, `[NONE]` with its reason, never folded into a pass — and never re-run the three
commands by hand beside it. The legacy exemption below does not apply to these rows: the spoke
install stops on a trunk that fails any of the three (spoke install step 3), so there is no
legacy finding for it to exempt. Exit 2 from it is exit 2 here. Each commit on the branch
already records its rows as `Harness-Check:` trailers; the pull-request body reports this run.

**The four gate rows are one command, not four.**
`HARNESS_TRUNK=main node scripts/check-dev-ready.js <KEY>` — `.mjs` where the repository
is not a module package, and the prefix only where the trunk is not `main` — is the single
source of the gate's logic, and those four rows are the four gates it runs. Run the script
and report what it says; never re-implement a gate check here, because a second copy of a
gate is a copy that drifts. It force-fetches and reads the trunk, so it is re-run late on
purpose: the trunk moves while a branch is open, and an implementation is only defensible
against the design that is on the trunk *now*. Re-running costs seconds and catches the case
where the design was amended under you.

**The clarification-log row is the fifth, and the gate cannot cover it.** A clarification raised
during implementation is handed back by the worker and written by the orchestrator into
`docs/designs/<KEY>.clar-log.md`, the log of this work item, because §9 of the design is
on the merged trunk and reopening a merged design is prohibited. The gate parses §9 and
therefore cannot see that row at all. Without this check a work item is blocked in the
register and merged anyway — the row exists, nothing reads it, and the pull request opens.
So read the log of this `<KEY>` here, and treat an unreleased blocking row
exactly as the gate treats one in §9: exit 1, do not open the pull request. `Answered` does
not release it; a human writes the answer back and the row moves to `Closed`.

**The gate proves that §5 names a test. It does not run one.** That is why the criteria row
sits outside the gate rows: resolving each named test to a real test in the tree and
watching it pass is the part of the criterion-to-test map only this check covers.

**The stub rows, in the pinned grammar:**

UNRESOLVED — the test command per suite, and how a subset covering the diff is selected. Owner: tech lead. Resolves: toolchain confirmation for the target repository.
UNRESOLVED — the coverage command for this repository: `COVERAGE_COMMAND` in its `checks.env`, printing `project=<n>` and `changed=<n>` (the template states the contract). Owner: tech lead. Resolves: at the spoke install, where the project floor is measured on the trunk and both floors are written beside it.
UNRESOLVED — the migration-immutability command, or its deletion where the repository has no migrations. Owner: tech lead. Resolves: toolchain confirmation for the target repository.

### A row with no command is NOT CONFIGURED, and it is reported every time

**A row is configured when the repository's commands file carries its command line, and not
otherwise** — `AGENTS.md` § Manual checks in a single repository, `checks.env` in the repository
the story names in a hub and its spokes. That file is the only place the repository's commands
live, so its contents are the whole test — a row is never configured because someone remembers
configuring it.

A row with no command line reports `NOT CONFIGURED`. It does not fail the run: on day one
every stack row is a stub, and a check that cannot exit 0 until installation completes is a
check nobody ever sees working. Three guards keep that from becoming a hole:

- The count of `NOT CONFIGURED` rows appears in the summary and in the pull-request body,
  every run. A gap that is restated on every pull request stays expensive.
- Each gap is carried in `docs/harness-decisions.md` § Open items against a named owner,
  alongside every other seam the install left open. It is not a skip; it is an admission.
- Once the command line exists in the commands file, the row can never report `NOT CONFIGURED`
  again. A configured command that will not run is exit 2, below — not a skip, and never a
  pass.

`NOT CONFIGURED` means *nobody has told me what to run*. Exit 2 means *I was told, and I
could not run it*. Those are different facts and they are never merged into one.

## The exit-code contract

**Three codes. No fourth, no warning banner on a zero, no green tick with a caveat.**

| Exit | Meaning | What the caller does |
|---|---|---|
| 0 | Every blocking check ran and found nothing new | Open the pull request with `--base <SPOKE-TRUNK>`, `NOT CONFIGURED` rows reported in the body |
| 1 | A blocking check ran and found something new in changed code | Fix, re-run, within the round cap below |
| 2 | A check could not run to completion | Escalate. Never open the pull request |

Exit 1 and exit 2 are the same colour on a screen and completely different facts.

- **Exit 1 is "I know, and the answer is no."** A check executed, examined the code, and
  produced a finding. There is something to fix, and the thing to fix is in the diff.
- **Exit 2 is "I do not know."** The check did not reach a judgement: a tool was missing, a
  dependency would not resolve, a runner died before it emitted a summary, the coverage
  report was never written, the trunk could not be refreshed. Nothing was examined. No
  statement about the code has been made.

**Conflating them is how a gate silently stops working.** Fold exit 2 into 0 and every
environment breakage reads as a pass — the check keeps reporting green in exactly the
conditions where it is least able to see anything, and nobody notices, because a green tick
is not something anyone investigates. Fold exit 2 into 1 and the team learns that failures
here are usually environmental, and the rational habit becomes re-running until the colour
changes; that teaches the same lesson more slowly and leaves a check whose output nobody
reads. So exit 2 keeps its own code, it never counts as a pass, and it escalates rather
than looping.

Usage errors and internal crashes in the check itself also report 2 — and so do the pickup
gate's own exit 3 and exit 4 when the gate is re-run here. The gate keeps those apart (see
the exit table in `/dev-sprint` § Preconditions) because whoever runs the gate must report
which one it was. Here every non-answer has the identical consequence — do not open the
pull request — and a distinction with no distinct action is noise. Narrowing is allowed;
widening is not, so the gate's exit 1 stays exit 1 and never becomes a 2.

## Scope — changed code only, with the legacy exemption

**Pre-existing findings outside the diff do not block. New findings in changed code do.**

Resolve the comparison point once, at the start of the run, and record it in the summary
header: the merge base of this branch and the trunk. Not the trunk tip, which moves under
you; not the previous commit, which shrinks the diff after every commit. A check whose
answer changes while your code does not is a check nobody trusts twice.

A finding is **new** when:

- its location falls in the changed line set; or
- the change introduced it as a whole-artefact property — a secret string committed, a
  merged changeset edited, a repository coverage figure that now sits below the floor; or
- it sits in an unchanged file that depends on a changed one, and the change caused it. A
  signature you altered producing a type error three modules away is your finding, not
  legacy. Type checking is the row where this matters most: scope it to the changed files
  *plus their dependents*, or it will miss the class of error it exists to catch.

Everything else is legacy. Record it in the log under its own heading, count it in the
summary, and leave the exit code alone.

**Why a check that is red on day one teaches a team the harness is broken.** Point any of
these tools at a repository with history and it will return hundreds of findings, none of
which the current author caused and none of which they can fix inside this work item. The
first run is where the team decides what this check is. If the answer is "a wall of
somebody else's debt", the rational response is to stop reading the output; then to stop
running it; then to add the flag that skips it. Every one of those steps is locally
reasonable, and the sequence is irreversible — a check that has been switched off once does
not recover its credibility by being tightened later. Changed-only scope is what buys the
check a first day it can survive.

Do not fix legacy findings to make the number go down. It enlarges the diff, moves the
reviewer's attention off the work item, and scope creep is a finding in review even when
the extra work is good. Record it and raise it as its own work item.

## Output handling — decide from the log, never from the tail

Every check writes verbose output to its own file under the system temporary directory, and
the decision is made by reading that file:

    <the command — the repository's commands file> > /tmp/<KEY>-pre-merge-<check>.log 2>&1; echo "exit=$?"

- **The exit code is the first signal; the log is the evidence.** Capture the code
  explicitly. An empty log from a runner that died and an empty log from a check with
  nothing to say are indistinguishable without it.
- **Open the log with the file-reading tool and find the runner's own summary line.** Never
  judge from the last lines that happened to scroll past. A coverage shortfall prints before
  the final lines and scrolls away; a crash prints a stack trace that reads like a single
  failure; a runner that died before printing anything looks, at the tail, exactly like a
  clean run.
- **Never pipe a suite through a pager or a tail to check it quickly.** Truncated output is
  how the one failing line gets cut.
- **Logs live in the system temporary directory or a gitignored path — never in the
  worktree, never in the commit.** The worktree-clean row would catch a stray log anyway;
  do not make it do that work.
- **Each run overwrites the previous log for the same check.** The current log describes the
  current state. Round two judged on round one's evidence is the most confident kind of
  wrong.

Write one summary at `/tmp/<KEY>-pre-merge.md`: the comparison point, the round number, one
line per row with its status, the `NOT CONFIGURED` count, the legacy count, and the final
exit code. The description's Checks lines (`docs/designs/_TEMPLATE.pull-request.md`) are taken
from that summary — not from a recollection of it.

## The three-round fix loop

One round is: run every check, read every log, fix, re-run.

1. **Fix in table order.** Formatting first, then lint, then types. A formatting pass
   rewrites lines and invalidates every line-anchored finding below it, so fixing in any
   other order means re-deriving locations you already had.
2. **Fix what is fixable inside this work item.** The auto-fixable column says what a tool
   can do; everything else is yours, and anything the merged design does not cover is a
   clarification, not an improvisation. Where a row is **mechanical** — the tool has already
   named the fix, and applying it is transcription rather than a judgement about what the code
   was meant to do — dispatch the `build-error-resolver` seat
   (`.claude/agents/build-error-resolver.md`) on that one failure, passing the tool's output
   verbatim. It holds no shell to run code: you run the build, it edits, you re-run. Its three attempts are
   counted **per failure across the whole work item, not per round**, so the same failure
   arriving again in round two continues that count rather than restarting it — otherwise three
   rounds here quietly buy nine attempts at one error. Those attempts sit inside your round and
   never earn the loop a further one.
3. **Re-run the full table, not the row you fixed.** Fixes interact — a lint fix that
   extracts a function moves coverage, and a dependency bump moves types.

**At three rounds, stop.** Leave the branch in its last state, do not open the pull request,
and escalate to the tech lead with the check name, the log path, the finding, and what was
tried. Three rounds against the same table is not a tooling problem; it is usually an
ambiguity in the design presenting as churn, and a fourth round is the most expensive way
to discover that.

**This counter is not the code-review cap.** The critic's cap of three
(`.claude/rules/worker-critic.md` § Revision caps) counts review rounds against the diff;
this one counts local check rounds before any review exists. Three rounds here consume no
critic round, and a critic round does not reset this counter. Conflating them is how a work
item quietly acquires six attempts at the same problem.

Never re-run unchanged inputs hoping for a different answer. Same inputs, same answer — and
a result that changes without an input changing means the check is not deterministic, which
is a finding about the check.

## What this check does NOT cover

**It is a floor, not a review.** It has no opinion about whether the code is well designed,
in the right module, or the right thing to build at all.

- **It does not judge design fidelity.** It confirms that each `AC-<n>` has its named test
  present and passing. It cannot confirm that the test asserts the behaviour the criterion
  states rather than merely executing the path — that judgement belongs to the critic in
  code-review mode (`.claude/skills/review-artefact/SKILL.md`).
- **It does not scan for dependency advisories.** That answer moves when an advisory is
  published, with no change to the diff, which breaks the determinism rule above; and
  the repository's commands file carries no command for it. Advisory scanning belongs to the
  pipeline and to a scheduled scan, where a result that changes overnight is the point.
- **Passing is not an argument in a review.** "The pre-merge check was green" is not a
  response to a CRITICAL or an IMPORTANT finding. A critic that approved on the strength of
  the checks passing has approved nothing — `.claude/agents/dual-mode-critic.md` § What you
  do NOT do says exactly that.
- **It replaces nothing upstream or downstream.** Not the pickup gate it re-runs, not the
  critic loop, not either human merge. It sits between the last commit and the pull
  request, and that is the whole of its remit.

## Never

- Never emit a critic verdict token. `### VERDICT:` and `Cycle:` belong to the critic; a
  readiness value belongs to a persona seat. This check's entire output surface is an exit
  code, a summary file and a set of logs. A verdict line written here can be read by a gate
  as an approval nobody gave.
- Never report 0 with a log unread, or with a blocking row unrun.
- Never treat exit 2 as a pass, and never retry it in a loop — that turns an infrastructure
  problem into a silent stall.
- Never widen scope beyond the changed set and its dependents. Changed-only is the rule,
  not a concession granted for the first run.
- Never re-implement a pickup-gate check here instead of running the script. A second copy
  of a gate is a copy that drifts, and the drift is discovered by trusting the wrong one.
- Never narrow, skip or disable a check to reach green, and never add a suppression, an
  exclusion or an ignore entry to satisfy one. On a security finding a suppression needs a
  named human approver and a linked justification, and nothing less releases it
  (`.claude/rules/security.md` § Prohibited).
- Never weaken, skip or delete a test, and never lower a coverage floor. The project floor
  moves by the ratchet at a sprint boundary, never on a branch: the floors judged are always
  the trunk's, so a floor changed on a branch changes nothing until a person merges it.
- Never commit a log, a scratch file or debug output to make the worktree-clean row pass.
- Never fix a legacy finding outside the diff to improve the count.
- Never proceed past round three.
- Never open the pull request non-draft with a blocking row red, or with `NOT CONFIGURED`
  rows left out of the body.

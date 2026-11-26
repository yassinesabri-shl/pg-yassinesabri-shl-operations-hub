---
description: Static acceptance-criteria validation of the head commit of the story's open code pull request, against the design merged in the hub, before the code merge. On a pass, writes the validation report into a pull request in the hub. On a fail, hands the failing criteria back to /dev-sprint as a fix round on the same branch. After the code merge, moves the work item to done.
argument-hint: <KEY>
---

<!-- Part of the harness asset library c6f3b4427d58f7c3 (see VERSION.json) · 2026-09-12 -->

# `/qa-sprint <KEY>`

**This file is a contract, not an integration.** The state moves and the pull-request calls are
placeholders for the team's own tracker and forge calls. Substitute them once, here. Two parts are
not placeholders. Every criterion carries a recorded verdict. A script checks the report before
anything moves.

**Purpose.** Validate the code of the open code pull request against every acceptance criterion
in the design, before a person merges it. The design is on the hub's trunk. The code is the head
commit of the pull request in the repository the story names. This command reads both, at a
commit each.

- When every criterion passes, it writes one report that names both commits. It puts the report
  in front of `check-validation.js` on a pull request in the hub. A person merges that pull
  request. The spoke's `qa-gate` then lets the code pull request merge.
- When a criterion fails, it writes nothing to the hub. It hands the failing rows to
  `/dev-sprint`, which fixes them on the same branch. QA then runs again on the new head commit.

A merge to the spoke's trunk therefore means the change passed QA.

## Inputs

| Input | Form | Where it comes from |
|---|---|---|
| `<KEY>` | `^[A-Z][A-Z0-9]{1,9}-\d+$` | The argument |
| The story's `Repository:` line | One id, `<REPO-ID>`, in `docs/estate/repositories.json` | `docs/backlog/<SLUG>/<KEY>.item.md` on the hub's trunk |
| The design, and its `Repository:` line | `docs/designs/<KEY>.lld.md` on the hub's trunk, at a recorded hub commit, naming the same `<REPO-ID>` | The merged design |
| The acceptance criteria, and the requirement each carries | §4 of that design: the `ID`, `Criterion` and `Requirement` columns | The merged design |
| The acceptance-criterion-to-test map | §5 of the same design | The merged design |
| The spoke's trunk | The `Trunk:` and `Commit:` lines of `node scripts/read-spoke.mjs <REPO-ID> .`, read **now** | The repository list and the spoke's remote |
| The code pull request | Its state, draft flag, base branch, head branch, head commit, and the checks on that head commit | The spoke's pull-request API |
| The report on the hub's trunk | `docs/designs/<KEY>.validation.md` and its `Spoke commit:` line, or absent | The hub's trunk |
| The open hub pull request | A pull request on `validation/<KEY>`, and the `Spoke commit:` its report names, or absent | The hub's pull-request API |

**Where it runs, and who holds what.** The command runs from the hub. The orchestrator reads the
design from the hub's trunk with `git show origin/<HUB-TRUNK>:docs/designs/<KEY>.lld.md`, and
records the commit it read. It hands §4 and §5 to the validating seat **as text**.

The seat works in a **fresh clone of the spoke at the pull request's head branch**, made for this
run in the system temp directory. The orchestrator clones the head branch and requires
`git rev-parse HEAD` to equal the head commit the pull request names. A different commit means
someone pushed during the run. Stop, and run again.

The seat holds that clone and nothing else. It never holds the hub. It never holds the work
item's own checkouts under `.worktrees/<KEY>/`, because those are the engineer's working copies,
not what the pull request carries. The seat returns its rows in-loop. The orchestrator writes them.
The design crosses into the clone as text with its commit, and the rows cross back the same way.

The repository's own rules cross the same way. Before dispatch, the orchestrator runs this from
the hub:

    node scripts/read-spoke-rules.mjs <REPO-ID> --at <the trunk commit read-spoke printed> --paths <the changed files, comma-separated>

The changed files are `git diff --name-only <merge-base>..<head commit>` in the fresh clone,
where the merge base is that of the head commit and the trunk commit. The rules are read at the
trunk, never at the branch, so a pull request cannot change the rules it is judged by. The
orchestrator hands the printed text to the seat beside §4 and §5. A criterion met by code that
breaks a rule handed in is a `FAIL`, with the rule cited in its evidence cell. `Rules: none` in
the output means there is nothing to hand, and the seat is told so. The hub pull request's body
carries the script's `Rules:` line beside the two commits. The seat never opens the folder. It
has no shell to run code.

**Who reads the code.** One validating seat, dispatched by the orchestrator on fresh context. It
holds `Read`, and `Bash` for read-only search only. It is never the seat that built the change.
UNRESOLVED — which shipped charter that seat runs on; no charter names `/qa-sprint` today, and
none of the five review modes is validation. Owner: harness lead. Resolves: the library names or
ships the seat before the first `/qa-sprint` run on a real estate. The checkout rule is settled:
whichever charter it is, it holds the fresh clone and nothing else.

## Which run this is

Read the three facts first: the code pull request, the report on the hub's trunk, and any open
hub pull request on `validation/<KEY>`. Then take the first row that matches.

| # | Code pull request | Hub | Run | What runs |
|---|---|---|---|---|
| 1 | The query failed, or the hub's trunk is unreadable | — | Neither | Report what was read. Move nothing. Escalate as a cannot-verify |
| 2 | None, or closed without a merge | — | Neither | Stop. There is nothing to validate. A closed pull request is a person's decision |
| 3 | Open, but a draft, or its base is not the trunk `read-spoke.mjs` names | — | Neither | Refuse, and name the base |
| 4 | Open, and a check other than `qa-gate` is red or pending on the head commit | — | Neither | Stop. `/dev-sprint` is not finished. Name the check |
| 5 | Open and green | No open hub pull request, and the trunk report is absent or names another commit | **Validate** | Steps 1 to 6 below |
| 6 | Open and green | An open hub pull request whose report names the head commit | Neither | Stop. The validation merge is human |
| 7 | Open and green | An open hub pull request whose report names an older commit | **Validate again** | Steps 1 to 6 below. A passing report becomes a new commit on the same `validation/<KEY>` branch. On a fail, close that stale hub pull request with one comment that names the new head commit |
| 8 | Open and green | The trunk report names the head commit, and `check-qa-gate.mjs` exits 0 | **Release** | Re-run the spoke's `qa-gate` job on the head commit, then stop. See "Release" below |
| 9 | `MERGED` | The trunk report names the merged head commit, and `check-validation.js` exits 0 | **Done** | See "Done" below |
| 10 | `MERGED` | No report on the trunk names the merged head commit | Neither | Escalate to the engineering lead: the code merged without QA. Do not validate code that is already on the trunk |

## Preconditions of a validating run

1. The design is on the hub's trunk and readable. Its `Repository:` line equals the story's.
   Validate against the merged design. Never validate against a branch copy of it or against the
   pull request description. A design that names another repository than its story is a
   repository-integrity problem. Stop and report it.
2. The repository is in the list, and `node scripts/read-spoke.mjs <REPO-ID> .` exits 0 and names
   its trunk. The script applies the trunk rule to the entry's `trunk`, so a shared repository is
   read on its declared branch, never on the other team's default branch. Use no remembered trunk
   name. The base of the pull request must be that trunk.
3. Every acceptance criterion has a stable identifier, a requirement criterion in the
   `Requirement` column, and a named test in §5. If one does not, the pickup gate would not have
   passed. That is a repository-integrity problem, not a QA finding. Stop and report it.

## The state transitions it owns

| Transition | Run | Authorisation |
|---|---|---|
| `IN REVIEW` → `IN TESTING` | A validating run, before any seat is dispatched | The code pull request was queried: open, not a draft, its base the trunk, every check but `qa-gate` green on its head commit. The head commit is recorded |
| `IN TESTING` → `IN PROGRESS` | A validating run | At least one verdict is `FAIL` at the recorded head commit, and the findings file names that commit |
| `IN TESTING` → `DONE` | The final run | The code pull request reports `MERGED`. `check-validation.js <KEY>` exits 0 against the hub's trunk. The report's `Repository:` is the story's, and its `Spoke commit:` is the merged pull request's head commit |

Exit 2 from any check is not a pass. Escalate it, as the pickup gate's exit 2 is escalated.

## What it does — a validating run

1. **Record the head commit, and move the item.** Record the pull request's head commit, in full.
   Move `IN REVIEW` → `IN TESTING`. Clone the head branch fresh, and require its `HEAD` to equal
   the recorded commit.
2. **Enumerate every criterion** from §4 of the merged design, with the requirement criterion
   each carries. Include every one: negative cases, and any criterion marked deprecated. A
   criterion in the design is a criterion under validation.
3. **Validate each one statically against the head commit**, in the fresh clone. The named test
   exists. It asserts the behaviour the criterion states, not only executes the path. The code
   path it covers is the one the design says implements that criterion.
4. **Record a verdict per criterion**, `PASS` or `FAIL`, with the evidence: the test name, the
   file and line, and one line on what was checked. No criterion ends with no verdict. `N/A` is a
   verdict only if the design's Criterion cell for it begins with the bare word `DEPRECATED`. That
   is the form the design template states, and the only form the check reads. It still needs a
   row. On every `FAIL` row, the evidence cell starts with `Fix: test` or `Fix: code`, as the seat
   judges where the fault is. `Fix: test` means the test does not assert the criterion. `Fix: code`
   means the test is right and the code does not meet it.
5. **Write the rows into one of two places.** The seat returns the text. The orchestrator writes
   it verbatim. Both places use the one shape below.
   - **Every verdict `PASS` or `N/A`:** write `docs/designs/<KEY>.validation.md` on a branch cut
     from the hub's trunk, `validation/<KEY>`, never onto the trunk. Commit it with
     `node scripts/harness-commit.mjs -m "docs(<KEY>): validation report"`. In row 7 of the table
     above, the commit goes on the existing branch.
   - **Any `FAIL`:** write `.worktrees/<KEY>/<KEY>.qa-findings.md` in the hub checkout. It is
     never committed and never pushed. It is the fix round's input, and `/dev-sprint` reads it.
     Move `IN TESTING` → `IN PROGRESS`. Write nothing into the hub. In row 7, close the stale hub
     pull request with one comment that names the new head commit.

   The shape is one heading, three lines, one table and one closing line, and nothing else.
   `check-validation.js` reads exactly this shape and fails on anything else, a note included:

       # Validation — <KEY>: <the design's one-line title, as its heading has it>

       Design: docs/designs/<KEY>.lld.md at <the 40-character hub trunk commit the design was read at>
       Repository: <REPO-ID>
       Spoke commit: <the 40-character head commit of the code pull request the code was read at>

       | AC | Criterion (short) | Requirement | Verdict | Evidence |
       |---|---|---|---|---|
       | AC-<n> | <short restatement> | REQ-<n>.AC-<m> | PASS | <test name> · <file>:<line> · <what was checked> |
       | AC-<n> | <short restatement> | REQ-<n>.AC-<m> | FAIL | Fix: code · <what is absent or wrong> · <file>:<line> |

       Criteria: <n> · PASS <n> · FAIL <n> · defects raised: NONE

   The `Requirement` cell is the design's, copied. It is the same `REQ-<n>.AC-<m>`, or
   `JIRA-<KEY>.AC-<m>` for a story taken from a ticket, that the work item's `Carries` column names, and the check compares the two columns. The `Spoke commit:` line
   pins every `<file>:<line>` in the table to one commit, named once (`.claude/rules/estate.md`
   §2). The spoke's `qa-gate` compares it with the pull request's head commit, so a commit pushed
   after QA makes the report out of date. The `Design:` line binds the report to the design: the
   check confirms the commit is on the hub's trunk, and that the design's bytes there are the
   design's bytes now. `defects raised: NONE` is the one legal value. The field stays so that a
   report written before QA moved ahead of the merge still reads.

   Every cell carries a value. `PASS`, `FAIL` and `N/A` are the whole verdict set, matched
   literally. A report on the hub carries no `FAIL`. No placeholder cell: a dash, `TBD`, `TODO`
   or `pending` is an unvalidated criterion wearing a tick. Write each row on its own line, with
   one cell for each header column. Write a literal pipe in a cell as `\|`. This is not the human testing-session
   capture at `docs/designs/_TEMPLATE.testing-session.md`. That file records a person exercising
   the running system, and nothing in this library emits it.
6. **On a pass, open the pull request in the hub, and stop.** In row 7, the existing pull request
   carries the new commit instead. The description names the design commit, the repository, the
   spoke commit and the `Rules:` line. It ends with the watermark, the line
   `Generated-by: SHL Agentic Harness`, on its own after the normal description
   (`.claude/rules/watermark.md`). The hub's `validation-gate` runs `check-validation.js <KEY>` on
   the pull request's content and reports on its head commit. A person merges it. **On a fail,
   stop and say: run `/dev-sprint <KEY>`.**

## Release

The report on the hub's trunk names the head commit, so QA passed on this code. Nothing in the hub
re-runs the spoke's `qa-gate`, and its last run was red. Run the same check locally first:
`HARNESS_TRUNK=main HARNESS_REPO=<REPO-ID> node scripts/check-qa-gate.mjs <KEY> --head <the head commit>`,
from the hub checkout. It must
exit 0. Then re-run the `qa-gate` job of the latest workflow run on that head commit
(`gh run rerun <run-id> --job <job-id>`, or the host's equivalent). A re-run reads the hub's trunk
as it is now. Report "ready for the code merge", and stop. The code merge is human.

## Done

**Run it from the hub's root.** The teardown below removes `.worktrees/<KEY>/`. When this session's
working folder is inside it, stop before any move or removal. Say why: the teardown removes the
folder that holds this session's project hooks. Claude Code then drops those hooks without an error,
so the final run records no cost and no work time. Tell the person to close this session and to
run `/qa-sprint <KEY>` again from the hub's root.

The code pull request reports `MERGED`. Run
`HARNESS_TRUNK=main node scripts/check-validation.js <KEY>` from the hub checkout, against the
freshly fetched trunk. Exit 0 is the precondition for everything below. Exit 1 means the report on
the trunk is incomplete: the item stays where it is, and the findings are reported. Exit 2 is an
escalation. Then require the report's `Spoke commit:` to equal the merged pull request's head
commit. Row 10 of the table covers the case where it does not.

Move the work item to `DONE`. Then remove the work item's checkouts:

- remove `.worktrees/<KEY>/`: the hub worktree, the repository clone beside it, and any findings
  file;
- prune the hub's worktree registration;
- delete the feature branch in the hub and in the repository, locally and on each remote;
- delete the `validation/<KEY>` branch;
- remove the fresh clone of the last validating run, if it is still there.

Nothing else in the flow does this. A live checkout on a merged branch confuses the next
`/dev-spec` or `/dev-sprint` that looks for an existing checkout.

**Where the hub has a Jira connection** (`node scripts/check-trackers.mjs` prints `WELL FORMED`),
run from the hub root `node scripts/jira-sync.mjs apply <KEY> --fact merged --pr <url>` with the
merged code pull request, then `node scripts/jira-sync.mjs apply <KEY>`. The two calls label the
ticket `shl-merged` and `shl-validated`, each with one comment, and move nothing. The harness's `DONE` is not Jira's Done, which
means released. The team's own QA steps follow from the label. Exit 1 or 2 from the sync is
reported and changes nothing above, and the call is safe to run again.

Do not re-validate in this run. The merged report is the record. Reading the code again now would
be a second validation that nobody reviewed.

### Other escalations

These stops raise an escalation as a cap does, and then stop. Each is one call of
`node scripts/escalation.mjs raise --point <ID> --slug <SLUG> [--work-item <KEY>] --runner <forge login> --question "<the one question>" --by-seat sprint-orchestrator`
with the options in the last column. Print what the script prints first in the closing report. Exit
2 means the line did not reach the record: say so first, and carry the question in the report.
The sweep tells the people named in `governance/escalation-points.json` and asks again after the
wait of the path. A question in the session (qa-sprint.not-merged) writes nothing. A merge that waits for the validation report (qa-sprint.merge) is not raised here.

| Point | When | Path | Options |
|---|---|---|---|
| qa-sprint.check-validation | `check-validation.js` exits 2 | check cannot run | none |
| qa-sprint.ledger-fault | a ledger or defect fault, or exit 2 | check cannot run | none |
| qa-sprint.manual-testing | manual testing of the running software is left to a person | handover | none |

## Gates it enforces

| Gate | Behaviour on failure |
|---|---|
| Validation is against the head commit of the open code pull request, in a fresh clone whose `HEAD` is that commit | Refuse to validate the work item's own checkout, a description, or a clone at another commit |
| The pull request's base is the trunk `read-spoke.mjs` names | Refuse, and name the base |
| The design's `Repository:` line equals the story's, and the id is in the list | Refuse. A report about the wrong repository is worse than no report |
| Every criterion in the design has a recorded verdict, with the design's requirement beside it | Refuse to write the report or the findings with fewer rows. An unvalidated criterion is a failed validation |
| The report names the hub commit the design was read at and the head commit the code was read at, both in full | Refuse to open the pull request. A report that names no commit describes no code |
| No placeholder cell | Refuse. A dash, `TBD`, `TODO` or `pending` is an unvalidated criterion wearing a tick |
| One row on one line, one cell for each column | Refuse. GitHub hides the extra cells of a long row |
| A report goes to the hub only when every verdict is `PASS` or `N/A` | A `FAIL` goes into the findings file and back to `/dev-sprint`. Never into a hub pull request |
| The report goes into a pull request in the hub, never onto the trunk | Refuse the write |
| `check-validation.js <KEY>` exits 0 against the hub's trunk before `DONE` | No move. Exit 1: report the findings and stop. Exit 2: escalate |
| A test asserts the behaviour, not only the path | Record a `FAIL` with `Fix: test`. A test that executes without asserting is not coverage |
| The code merge happens only after a passing report names its head commit | The spoke's `qa-gate` enforces it. A merge without one is row 10: escalate |

## The failure branch, and why it works this way

A failing validation goes back to `/dev-sprint` as a **fix round on the same branch**. The item
moves back to `IN PROGRESS`. The fix is a new commit on the open pull request, made through the
same guarded build loop as the first one: the test writer for a `Fix: test` row, the engineer for
a `Fix: code` row, the finalizer and the critic for both. Then `/qa-sprint` runs again on the new
head commit.

Three reasons:

- The trunk holds only code that passed QA. That is the point of trunk-based development. A
  defect found after the merge is code on the trunk that is not ready to deploy.
- The fix is subject to the same controls as the original build. It goes through the frozen
  tests, the finalizer and the critic, and through `story-gate`, `story-gate-code` and `qa-gate`
  again on the new head commit.
- A work item stays one design, one pull request and one set of criteria. Nothing forks it into
  a parent and defect children.

The fix round has a cap (`.claude/rules/worker-critic.md` § Revision caps). Repeated QA failure on
one design is a design ambiguity, and it escalates. A failure that needs a change in another
repository is a clarification, as any second repository is.

`BLOCKED` is a flag, not a state. If validation cannot proceed, flag the item where it is and name
the role that can unblock it. Examples are an unreachable repository and an unreadable design. Do
not move it to a blocked column. The column destroys the information about what the item was
blocked *during*.

## Output

- A validating run that passes: one pull request in the hub on `validation/<KEY>`, carrying
  `docs/designs/<KEY>.validation.md`. It names the design commit, the repository and the head
  commit, and holds one row per acceptance criterion with its requirement, its verdict and the
  evidence. The work item is at `IN TESTING`.
- A validating run that fails: `.worktrees/<KEY>/<KEY>.qa-findings.md` in the hub checkout, in the
  report's shape, naming the head commit. Nothing in the hub. The work item is at `IN PROGRESS`.
- A release run: the spoke's `qa-gate` re-run on the head commit.
- The final run: the work item at `DONE`, with both checkouts and all three branches removed.

## Stopping condition

- A validating run stops when every criterion has a verdict, the rows name both commits, and
  either the hub pull request is open or the findings file is written.
- A release run stops when `qa-gate` has been re-run.
- The final run stops when the check exited 0 and the item is at `DONE`. A final run inside
  `.worktrees/<KEY>/` stops at once, and names the hub's root as the place to run it.

## Never

- Never write the report onto the hub's trunk. It goes into a pull request, and a script runs on
  it.
- Never write a report with a `FAIL` into the hub. A failing row goes back to `/dev-sprint`.
- Never move a work item to `DONE` before the code pull request has merged, or with a criterion
  unrecorded or failed.
- Never fix the code. This command validates. A fix is a `/dev-sprint` fix round with its own
  gates.
- Never edit the design, the acceptance criteria or the testing plan to match what was built.
  That inverts the contract: the design is the specification, and the code is the attempt.
- Never validate the work item's own checkout, a pull request description, or a summary of the
  change. Validate the head commit of the open pull request, in a fresh clone.
- Never read the rules at the branch. Read them at the trunk.
- Never give the validating seat the hub. The design reaches it as text with its commit, and the
  rows leave it the same way.
- Never write a report without its `Spoke commit:` line or its `Requirement` column. A file and
  line with no commit is a pointer into a moving branch. A verdict with no requirement is a
  verdict about nothing anyone asked for.
- Never re-validate in the final run, and never merge either pull request yourself.
- Never validate code that merged without QA. Escalate it.
- Never move the item to a blocked column.
- Never accept a passing test as a passing criterion without checking that it asserts the stated
  behaviour.

## Honest limit

This is **static** acceptance-criteria validation. It reads the code and the tests and judges
whether the criteria are demonstrably covered. It does not exercise the running system end to
end. On work with no visible surface, such as batch, integration and data pipelines, it is the
weakest link in the chain, because there is little for a validator to observe. Where that
describes the estate, expect to invest in synthetic-data fixtures and contract tests before this
step carries much weight. Say so, rather than report a green validation as proof the behaviour is
right.

It reads one repository. A feature that spans two stories in two repositories is validated once
per story, and nothing here watches the two together. The script that checks the report checks
its shape, not its judgement: every criterion has a row, every row a passing verdict and evidence,
the requirement column intact, the counts true. A seat that marks a wrong test `PASS` produces a
report the check accepts. The hub's check reads the `Spoke commit:` line for shape only, because
that commit lives in another repository. The spoke's `qa-gate` compares it with the head commit,
and `check-fan-in.mjs` finds it on the spoke's trunk after the merge. A squash merge of a branch
behind the trunk merges a tree QA never read. Fan-in and `check-dependencies.mjs` accept it when
the merge holds the change QA validated, as they accept a merge commit of that branch. They refuse
it when the merge changed the code QA read.

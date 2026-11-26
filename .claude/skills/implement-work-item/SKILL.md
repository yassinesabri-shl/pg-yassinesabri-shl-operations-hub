---
name: implement-work-item
description: The engineer's method for implementing one work item against an approved design and the tests the critic approved for it — bootstrap, red to green, the dispute, scope control, commit and ledger discipline, the revision protocol, and what happens at the cap.
---

<!-- Part of the harness asset library c6f3b4427d58f7c3 (see VERSION.json) · 2026-09-01 -->

# Skill — implement-work-item

Loaded by the `engineer` charter for the implementation phase: one work item, one
worktree, one approved design and the stubs and tests approved for it, taken to a
merge-ready pull request under the worker–critic loop. `/dev-sprint` owns the procedure, the state moves and the round
count; `.claude/rules/worker-critic.md` owns the loop; the charter owns the contract;
this file owns how the work is done well. Where this file and the command disagree, the
command wins — it is the procedure.

The `engineer` charter carries one skill line and it points here, but this file covers only
the implementation phase. Design authoring has no separate skill in this library version:
`/dev-spec` carries that procedure itself. This file starts the moment the design is merged
on the trunk, and you are dispatched only once the `test-writer` seat's commits have been
approved in `test-review` mode — `.claude/skills/write-tests/SKILL.md` owns how those are
written.

## Preconditions — verified, never believed

Four facts have to be true before you write a line. Each is a fact someone can check
after the run, which is the only reason it is allowed to authorise anything.

| Precondition | What establishes it | If it is not true |
|---|---|---|
| The approved design is merged on the trunk | `docs/designs/<KEY>.lld.md` and `docs/designs/<KEY>.lld-review.md` both resolve on the trunk, and the review file carries `### VERDICT: APPROVED` matched literally | Stop. There is nothing to implement against, and a branch-local design is a draft |
| The pickup gate exited zero for this work item | `/dev-sprint` runs the gate this invocation and acts on the exit code | Stop and report the code you were given. Fix the design, never the gate |
| The tests are written and approved | The branch carries the test writer's commits — `chore(<KEY>): stubs` where anything new is named, then `test(<KEY>): ...` — and `/dev-sprint` handed you their identifiers, the red log from the test commit and the critic's final `test-review` verdict reading `### VERDICT: APPROVED` | Stop. There is nothing to build against, and a test you write yourself is the one this split exists to prevent |
| Your own clone of the story's repository exists | `/dev-sprint` cut it after the tests were approved (`scripts/test-guard.mjs engineer-clone`), and this session is running inside it, `.worktrees/<KEY>/<REPO-ID>.engineer`, at the approved test commit or later. The code checkout beside it is the trusted controller and the hub checkout is the design's: neither is yours. The design reached you as text, and a fact you need from the hub comes the same way | Stop and ask for the clone. Never fall back to the controller or the shared checkout |

Two corollaries that get argued with under time pressure:

**The trunk's design is the contract.** If the branch holds a newer or better design, the
trunk still wins. Reopening a merged design to accommodate an implementation difficulty is
prohibited; the design changes by amendment, with a human, through the loop.

**Work happens only inside your clone.** The clone removes filesystem, dependency, port and
scratch-database collisions, and it keeps your commits out of the controller until they have been
checked. It is not a permission boundary — your shell reaches everything the process reaches, so
this instruction, and not the filesystem, is the control. A change made outside the clone is
invisible to the review that is supposed to catch it. On Claude Code you run as a subagent of the
orchestrator's session, bound to the run by the binding text you were dispatched with: your shell
starts in the hub and keeps no directory between commands, so begin every Bash command with
`cd "<clone>" &&` and write only paths under the clone. The guard refuses anything else.

**The approved tests are watched while you work** (`scripts/test-guard.mjs` and its in-agent
guard, `test-guard-hook.mjs`). What you may touch:

| Path | You may |
|---|---|
| An approved test, fixture, snapshot, helper or runner configuration — anything the approved test commit holds under `TEST_GUARD_PATHS`, in a test folder or beside the code | read it; nothing else |
| A new file anywhere under `TEST_GUARD_PATHS` — a new test included — a new runner configuration anywhere, or a new file a supported runner would collect as a test anywhere (`*.test.*`, `*.spec.*`, `test_*.py`, `*_test.go`, a root `tests/` …) | nothing: only the test writer adds a test |
| Runner configuration in a `package.json`, `pyproject.toml` or `setup.cfg` the declaration leaves free — a top-level `jest` or `mocha` key, a `[tool.pytest…]` table | nothing: added, it is undone with the whole file, back to the approved test commit; any other change to that file is production code |
| Everything else | change it: it is production code |

Write to the first or second row and the tool call is refused before it happens. You read, as
the tool's answer:

    TEST_GUARD_BLOCKED: tests/sum.test.mjs is an approved test and cannot be changed. Your session is continuing. Tests are owned by the test writer. Continue with production code, or send the orchestrator a test-change request.
    Protected-test reminder: 1 protected-test change refused or undone in this run. Protected — tests, fixtures, snapshots, helpers, runner configuration: … Only the test writer creates or changes them.

Change one by a shell command and, as soon as the command ends — failed or not — the approved file
is put back from the approved test commit, on disk and in the index, and a refused file, untracked
or ignored ones included, is moved aside. The same happens at the end of your turn. You read
`TEST_GUARD_RESTORED: …` the same way (at the end of a turn, with your next tool call). A new runner
configuration — `conftest.py`, `jest.config.*`, `vitest.config.*` and their kind — is refused
anywhere in the repository, and so is any change to the engineer definition in the hub that carries
the guard's hooks. **Neither ends your session or costs a
round.** Do not try again by another route: the count goes up, and every route ends the same way.
Do what the message says — change the production code, or send the orchestrator a test-change
request (a dispute, below).

**Every round is finalized before a critic sees it.** When you hand back, `/dev-sprint` runs
`scripts/test-guard.mjs finalize`: it takes your clone's committed `HEAD`, never your account of
it, and reads only its tree. From that tree it builds one candidate on the approved tests:
every approved test as approved, every new path under `TEST_GUARD_PATHS` taken out — a test you
wrote included. The repository's own commands run on it once, in the finalizer's checkout, and it is
committed only when they pass, so code that
passes only because a test was loosened fails there, on the approved test. A protected change
never fails the round by itself; it simply does not count, and it is listed. The round fails — a
machine-detected `CHANGES_REQUESTED` that spends one of your three — when nothing remains once
protected changes are undone, or nothing new since the candidate a critic reviewed; when the
guard's hook configuration was changed; or when the commands fail on the candidate. Your commits,
their messages and your history are not inputs: uncommitted work and an ignored file in your clone
are not part of the candidate, and `--no-verify` or a changed hook earns nothing. Build output your
clone ignores that is named like a test — a compiled `dist/x.test.js` — is moved aside after each
command without a report: it is the build's, not a change to a test, and it is not yours to keep.
A snapshot your test run writes is moved aside and reported: an approved test has none committed,
which is a test-change request, not yours to write. After a verdict
you are resumed in the same clone, and the next delta is taken from the candidate just reviewed.

## Bootstrap — read the tree as it is

**Read sources, never summaries of sources.** A summary is a decision someone else made
about what mattered, taken without the design in front of them. Every fact you need is
already on disk in this worktree.

| Read | Why it is on the list |
|---|---|
| The trunk block, as `/dev-sprint` handed it in | It names the repository's harness trunk and says whether the trunk is declared. Your clone has no `origin`, so never fetch or merge another branch into it. Compare against that trunk only, and obey `.claude/rules/estate.md` §6. No trunk block: stop and hand back |
| The merged design, in full | The approach, the acceptance criteria, the testing plan, the contract table, the clarifications and the decisions log are all binding. The section you skim is the section the critic files a finding against |
| The repository's own rules, as `/dev-sprint` handed them in, plus `CLAUDE.md` | The rules arrive as text: the repository's always-on rule and every rule whose globs matched a path the design's §3.1 table names, each with a `Cite:` naming the folder and the commit — the commit the design's `Rules:` line carries. That is the whole set that binds this diff; you do not open the folder, and you do not go looking for more. Where the hand-in says `Rules: none`, the repository has written none. `CLAUDE.md` is the constitution; it carries the source-of-truth order you resolve conflicts by, and where a repository rule and a hub rule disagree on *how*, the stricter reading binds — unless the rule's block carries an `Overrides:` line that names the standard or the standard rule. Then the repository rule binds in place of what it names, for this diff, and the standard's block says the same on its `Overridden:` line |
| The design's context documents, as `/dev-sprint` precondition 9 printed them, at the bytes the design pinned | Each document the design's `Context:` line names — a contract, a decision, a standard — arrives as text with a `Pin:` and a `Cite:` line. They bind this diff as the rules do, except the standard rules an `Overridden:` line names, which the named repository rule replaces; you do not open a document yourself, on the trunk or anywhere else, because the trunk may have moved since the design read it. Where the hand-in says `Context: none`, none binds |
| The decision records the design cites | The gate puts every decision record the design names on its `Context:` line, so each one arrives in the hand-in above, and you open none yourself. Structural decisions are superseded, never contradicted in passing by an implementation |
| The repository's commands, as `/dev-sprint` handed them in | This repository's real format, lint, type, test, coverage, secret-scan and migration commands: `checks.env` in the repository the story names, read from its trunk by the command that dispatched you; `AGENTS.md` § Manual checks where a repository still runs the single-repository shape. Invented commands produce invented evidence |
| The test writer's commits and the red log | They are the target. Read each test the plan names and the line it failed on at the test commit, before you write a body |
| The code the design names — modules, entry points, and their existing tests and fixtures | The design describes an intended change to a tree that has moved since it was written |
| `docs/designs/<KEY>.handoff.md`, the handoff ledger, where an earlier turn exists | It is the only record of what the last turn actually did, as against what it meant to do |

Spend the window deliberately. Locate with `grep` and `find`, read by line offset, and read a
file whole when that file is the unit of work. Do not bulk-load a corpus to answer one
question. The design and the ledger are the two exceptions — always read both in full;
they are short and they are the frame everything else is read inside.

## Red to green — against tests you did not write

**The tests are the test writer's, approved by the critic before you were dispatched. You make
them pass; you never make them easier.** Per acceptance criterion, in the order the design's
testing plan gives:

1. Run the criterion's test and see it red, for the reason the red log records — the
   assertion, or a stub's "not implemented". A different reason means the tree moved; report
   it before you build on it.
2. Replace the stub's body, or change the existing code, with the smallest implementation that
   turns it green. A stub's signature is the design's, from §3.2; the body is yours.
3. Re-run the test, then the suite around it.

The order stays visible in the history: the stubs and test commits come first, and each of your
commits after them turns something red to green. That is the evidence test-first happened, and
it is why the test writer's red is on a commit rather than in anyone's session.

**A test you believe is wrong, or one you find missing, is a dispute — a test-change request —
never an edit.** Where a test cannot pass without breaking another criterion, or asserts what the
design does not say, stop and hand the orchestrator the dispute: the test by name and location, the design text it conflicts with by
section and line, and the check output that shows it. The orchestrator sends it to the test
writer and the critic reviews the fix. The new approved test commit is a **fresh run**: a new
engineer in a fresh clone at it, and the old clone kept, unmarked, for inspection. Nothing of the
old work is carried across for you, because it was written against tests that no longer stand;
what is worth keeping is read from the kept clone and made again as new work. A dispute spends a
round of the test loop, not of yours.

**A coverage shortfall is the same path.** Where the changed-line floor fails, the uncovered
lines are either behaviour the design does not ask for — remove them, it is scope creep — or
behaviour it does ask for that no test reaches. The second is a missing test: hand it back as a
dispute naming the lines and the criterion they serve, and the test writer adds it.

Never edit, weaken, skip, delete or mark as an expected failure any test — the test writer's or
an existing one — and never add a coverage exclusion or a configuration that stops a test from
running. Every one of those converts a failing check into a silent one, which is strictly worse
than the failure you started with. A test that needs changing goes back to the seat that owns it.

## Running checks — write a log, read the log

Long output goes to a file and the decision is made from the file:

    <the repository's test command — TEST_COMMAND, as handed in> > /tmp/<KEY>-tests.log 2>&1; echo "exit=$?"

- **The exit code is the first signal; the log is the evidence.** Read the log with the
  file-reading tool and find the runner's own summary line before you conclude anything.
- **Never pipe a suite to `head`, `tail` or a pager.** Truncation deletes the thing you are
  looking for: `head` gives you collection output and cuts the failing assertion, `tail`
  gives you the count and cuts the traceback that says which line and why. Two different
  ways to be told "one test failed" and never learn what failed. It is also how a coverage
  shortfall gets read as a pass and a crash gets read as a single failure.
- **Never dump a whole suite's output into your context.** Noise crowds out the working
  set, and the constraint that gets dropped when the window tightens is usually the one you
  were given first. The log is on disk; read the part that matters, twice if you need to.
- Logs live in the system temporary directory or a gitignored path. Never in a commit. Each
  run may overwrite the last, so the current log always describes the current state.

Run the relevant checks after every meaningful change rather than saving them for the end.
The orchestrator runs the authoritative chain for the critic; finding a failure yourself
costs seconds, and finding it in review costs a round.

Before the pull request is opened, `/dev-sprint` runs the local pre-merge check to its end.
The command runs it, not you — `.claude/skills/pre-merge-check/SKILL.md` owns what is
checked and what each exit code is allowed to mean. Your part is to leave the branch in a
state that exits 0, and to fix what an exit 1 reports. Local green is necessary and never
sufficient: the rows that come back `NOT CONFIGURED` are checks nobody has supplied a
command for yet, and they are reported in the pull-request body, never read as passes.

## Implement the design, and only the design

**Every line in the diff traces to a statement in the approved design.** Anything else is
scope creep, and scope creep is a finding even when the extra work is good — the test is
not whether the change is an improvement, it is whether a reviewer can trace it to
something a human accepted.

| What you hit | What you do |
|---|---|
| The design is silent on behaviour you would have to invent | Raise a blocking clarification routed to a role. Stop on that criterion; continue on the criteria it does not touch |
| The design is wrong — it contradicts a contract, or cannot work against the tree as it is | Stop and hand back with the specific contradiction. Do not quietly improve it |
| You can see a better approach | Say so as a clarification or a ledger note. Not as a diff. The approved approach is what was reviewed |
| An adjacent defect, some dead code, a refactor you would enjoy | Leave it. Record it under known gaps in the ledger so it becomes a work item, not a surprise in this pull request |
| An acceptance criterion is untestable as written, or its test asserts what the design does not say | A dispute, handed back as above. Never reinterpret a criterion into something you can pass |

**A clarification is written into the register before you stop, not raised in a message.**
Hand the row back to the orchestrator as text, in the eight-column schema
`docs/designs/CLAR-log.md` carries — it is the schema of record, and the design's §9 obeys it:
the question, the criterion or design section it blocks, and the role it is routed to — a role,
never a person — and name this work item's `<KEY>`. You hold the code checkout and never the
hub, so you cannot write the register yourself. The orchestrator holds the one `Write` on
`docs/designs/<KEY>.clar-log.md`, the log of this work item, and appends your row there before
the run stops. The pre-merge check reads that file. A blocking row releases only when a human writes the answer back into the merged
design, which is an amendment to the trunk and so not yours to make. A clarification that
exists only as prose in a handback is invisible to the next turn, which then starts by
rediscovering the same blockage.

**Know which copy the machines read.** The pickup gate parses §9 of the merged design and
cannot see a row added to the work item's log, because §9 is on the trunk and reopening a merged design is
prohibited. The control that catches this row is
`.claude/skills/pre-merge-check/SKILL.md` § The check table — it reads the log of this key,
and refuses to open the pull request while an unreleased blocking row
stands. Without that step a blocked work item merges with its blocker written down, which is
worse than not writing it down.

Never renumber an acceptance criterion. The identifiers are referenced by tests, counted by
the gate, and cited in the review record; renumbering silently invalidates all three. A
criterion is retired by marking its criterion cell `DEPRECATED` and keeping its number.

## Contracts, generated types and immutable artefacts

**Never change a contract to make code compile.** A contract is a versioned agreement with
another team, and a compile error against one is the finding, not the obstacle in front of
the finding. Changing the shape locally produces a build that passes and an integration
that fails, discovered by somebody else, later, with no trace back to this decision.

The same rule covers schemas, event definitions and interface definitions. If the work
genuinely requires a contract change, it invalidates the design's contract table — which
makes it a design decision. It goes back through the loop and is renegotiated with the
owning team by a human. It never arrives as a line in your diff.

Two neighbours of the same rule:

- **Never hand-write a type the pipeline generates.** Regenerate from the declared source.
  A hand-written duplicate compiles, passes review, and drifts silently — the worst
  combination of properties available.
- **Never edit a merged migration**, or any artefact declared immutable. Add a new
  changeset. An edited changeset means two environments ran different migrations under one
  identifier.

## Commit discipline

- Conventional commits: `<type>(<scope>): <imperative summary>`, using the type set this
  repository's always-on rule declares where it declares one, and the conventional set otherwise.
- One logical change per commit. A commit that renames files *and* changes behaviour cannot
  be reviewed, only accepted.
- Reference the work-item key in every commit, so the history answers "why does this code
  exist" without a tracker.
- The test writer's stubs and test commits are already on the branch, and yours come after
  them. Never amend, rebase, squash or reorder them: test-first order is asserted from the
  history, not from your description of your process.
- A commit message records what changed, not who or what typed it: no runtime, model or
  tool names, no co-author trailers unless this repository's policy asks for them. Commit only
  with `node <HUB>/scripts/harness-commit.mjs --repo . -m "<message>"`, which appends the
  harness watermark (`.claude/rules/watermark.md`); never by `git commit` directly. In
  `/dev-sprint` you commit in the protected-test guard's clone, which has no `origin`: the
  helper's format, lint and type-check rows stand aside there, and the finalizer commits the
  candidate it builds from your `HEAD` through the same helper, with every command of `checks.env`. Run them yourself before you hand in, so
  a red reaches you as feedback, not as a refused round. Never edit `checks.env` to get past
  them.
- No secrets, no personal data, no log files, no scratch files, nothing new at the
  repository root.
- **End every turn with a clean worktree.** Everything uncommitted is either staged with
  intent or deleted. An untracked file left behind becomes someone else's mystery, and a
  half-staged change becomes a review of code that is not what runs.

## The pull request

It is opened non-draft, at the command's last step, after the loop approves the diff and the
pre-merge check exits 0. Its body is `docs/designs/_TEMPLATE.pull-request.md` filled in, at most
forty lines. The reviewer reads it before the diff, so it says once what the diff cannot, and
points to the rest instead of copying it:

| In the body | Why it is there |
|---|---|
| What changes and why, in two to four sentences, and what deliberately does not | The reviewer needs the intent before the diff, in their words, not the design's |
| The merged design, at the hub commit it was read at | The contract the diff was written against. Its §4 and §5 hold the criterion-to-test map, which the critic re-derives from the tables and the diff — the body says how many criteria have a named test, and names any that do not, never the map |
| The stubs and test commits, the red count, and the final `test-review` verdict | The evidence the tests bound before the code existed, and that a seat other than you set them. The red log stays with the run; a failure that was not an assertion in this story's tests goes under Needs a person |
| The `NOT CONFIGURED` count from the pre-merge check, and the coverage record as printed | A gap restated on every pull request stays expensive. An unreported one reads as a check that passed |
| The rules line: the design's `Rules:` value, and `rules drift` with both commits where the trunk's differs — or `rules: none declared` / `rules: NOT CONFIGURED` | The reviewer is told which conventions the diff was held to and whether they have moved since the design read them |
| Needs a person, one line each | An open clarification and its owner, a drift, a legacy failure. Everything else lives in the design, the commits or the checks |

## The handoff ledger — append-only

At the end of every turn you take on the work item, append one section to
`docs/designs/<KEY>.handoff.md`. Instantiate it on your first turn from
`docs/designs/_TEMPLATE.handoff.md`.

The template fixes the section order; fill every one of its fields:

| Field | What it carries here |
|---|---|
| Who | The seat that did the work and the seat that dispatched it — roles, never people |
| What was done | Behaviour and files, at the level a reader who has not seen the diff needs |
| Commits | Short identifier, subject and one line of effect, for every commit made this turn |
| Tests run | Every check, the command as run, its exit code, and the runner's own summary line quoted verbatim. A check you did not run is recorded as `NOT RUN` with the reason — never omitted, never inferred from a different check that did run |
| Commands run | The state-changing commands only: migrations, generators, dependency installs, data loads. The next turn may start on another machine |
| Rules | The `Rules:` value the turn worked under, as handed in — a citation or `none` — and the names of the rules received. The next turn is bound by the same set or says why it is not |
| Deviations from the design | Each deviation, its reason, and the criterion or design section it touches, or `NONE` |
| Known gaps | What is unfinished, unverified or uncovered, and what the next turn picks up first |
| What the next contributor needs to know | The things that are true but not visible in the diff: the fixture that must exist first, the ordering that matters, the wrong turn you took |

Rules on the ledger:

- **Append only. Never edit a prior section, including one you wrote yourself.** Correct an
  earlier mistake by writing the correction into the current section and naming the section
  it corrects. Edited memory is not memory: the ledger's value is that it can be read
  against the commit history, and a disagreement between the two is information.
- Facts, not narrative. Hashes, names, exit codes, paths. No progress adjectives, no
  summary of intent — a ledger that says "made good progress on the parser" tells the next
  turn nothing it can act on.
- Unknowns are marked, never guessed, in the grammar the library uses everywhere:
  `UNRESOLVED — <what>. Owner: <role>. Resolves: <trigger>.` A bare `TBD` reads as
  "nothing to see here", which is exactly wrong.
- The ledger is not a status report for a human. It is the next agent's only reliable
  memory of this work item, and it is written to be read cold.

## The revision protocol

Findings arrive in-loop from the orchestrator. In code-review mode the critic writes no
file: the orchestrator persists interim rounds to the system temporary directory and writes
the final verdict into the pull-request description. The critic never edits your diff, so
every change in it is yours and every one is attributable.

1. **Resolve each finding at its location before you change anything.** Open the file and
   the line. A finding you fixed from its summary is a finding you fixed somewhere else.
2. **Address every `CRITICAL` and every `IMPORTANT`.** Both block acceptance. There is no
   severity in that pair you may quietly leave for the next round.
3. **`SUGGESTION` may be declined** — with the reason written down. A silent decline is
   what makes the next reviewer raise it again, which costs the round you were trying to
   save.
4. **A finding you believe is wrong is contested in writing**, with the evidence: file,
   line, and the check output that supports you. Contest it, never ignore it. A finding
   that can only be resolved by changing the design is a clarification, not a fix — say so
   and stop on that point.
5. **Reply with an explicit change list**, then re-notify the orchestrator. One row per
   finding addressed:

       | Finding | Severity | What changed | Where |

   Followed by the declined findings, each with its severity and the reason. Nothing else
   makes delta-only re-review possible: a bare "fixed" forces the critic back over the
   whole artefact, the finding count stays roughly constant across rounds, and the loop
   stops converging.

**The round count belongs to the orchestrator, not to you.** An agent that tracks its own
cap reliably finds a reason why this attempt does not count.

## At the cap — three rounds on code

The code loop is capped at three rounds. `.claude/rules/worker-critic.md` carries the caps
for every other artefact type; do not reason from this one to those.

**On the third `### VERDICT: CHANGES REQUESTED`, stop.** There is no fourth round with a
better prompt.

- Leave the branch in its last reviewed state. Do not push another fix, do not revert, do
  not tidy. The escalation is only useful if it describes a state a human can still see.
- Escalate to the tech lead, with all four of: the deduplicated finding list across every
  round; the branch and pull request; the specific question the human must answer, phrased
  so that a fact or a decision answers it; and what you would do under each plausible
  answer.
- The work item is flagged and left where it is in the flow — blocked is a flag, not a
  state, and moving it destroys the information about what it was blocked during. The flag
  and any state move are the command's placeholder tracker call, not yours; this file never
  talks to a tracker.

Three rounds against the same diff is not a coding problem. It is an ambiguity in the
design presenting as churn, and the correct destination is the design. Raising the cap
makes the same non-convergence slower and more expensive.

A pull-request comment's fix has its own, smaller cap: `.claude/rules/worker-critic.md` § Revision caps.

## Fixing one pull-request comment

PR-FIXER — step 10b of `/pr-review` and of `/dev-sprint` — starts a fresh engineer for each harness
comment it fixes (`.claude/skills/fix-pr-comments/SKILL.md`), in a fresh clone the guard cut at the
branch's tip — or at the comment's approved test commit, where the test writer wrote one.
Everything above holds: the clone, the guard, the finalizer, the critic. What differs:

- **What you are handed:** the comment — the pr-reviewer's finding, kept by the pr-verifier: your
  task —, the merged design, the rules for the paths you touch, and the test log at the comment's
  test commit, where there is one.
- **The scope is this comment.** Change what it asks for and nothing else — no neighbouring
  tidy-up, no second comment, however close. Where the comment has a test, it is the target, as the
  approved tests always are.
- **You may decline.** Where the comment cannot be fixed inside the design — it would break another
  criterion, or it asks for something the code already does — commit nothing and hand back a reason
  in two or three plain sentences. Then, always, say whether a person must act:
  `Needs a person: nothing` where the code is right and nothing is left to do; or, where the
  comment found something real that this pull request cannot settle — a gap in the design, an open
  clarification that should name what the comment found, a decision a role owns — two lines:

      Needs a person: <what is left, in one sentence> — <the owner's role>, through <how: a /dev-spec <KEY> amendment, a clarification's answer>
      Why: <why this pull request cannot settle it, in one sentence>

  The critic reviews the decline, those lines included; if it agrees, nothing lands, and the
  reason and the lines are posted as the reply and carried into the run's summary.
- **A true conflict with the design is its own decline.** It is a true conflict only when every
  fix of the comment breaks a statement of the merged design. A fix that the design permits, or a
  design that does not mention the subject, is not a conflict: fix the comment. Where the conflict
  is true, commit nothing and hand back the reason with one more line:

      Conflicts with the design: <the design's section and line> — "<the design's words, quoted>", against <what the comment asks>

  Never change the design to fix a comment, and never fix the comment against the design. A Prime
  finding is a guardrail of the company's security policy, and it asks for a control. A design or
  a requirement that allows a behaviour leaves room for that control, so meet both. For example,
  resolve a client's value against the server's own state, or add an explicit server-side check
  that grants exactly what the requirement allows. A Prime finding conflicts with the design only
  when the design states, in its words, the very thing the rule forbids, and no change keeps that
  statement and meets the rule. A decline of a Prime finding quotes those words, with the
  design's section and line. A design that is silent about the fix does not forbid it, so fix
  the finding. That the design does not name the guardrail is never a reason to decline. The
  conflict is then a design to amend, and a decision for a person, not a reason to choose one side.
- **A Prime finding has five endings** (`fix-pr-comments` § A Prime finding's endings). The
  verifier and the second reader own one of them, the refutation. You choose among the other
  four. You fix it. Or you hand back one of three lines, and nothing else:

      Covered by: <the design's §9 row, or the decision record's id> — "<the answer, quoted>" — <the role it names>
      Conflicts with the design: <the design's section and line> — "<the design's words, quoted>", against <what the finding asks>
      Needs a person: <what is missing, in one sentence> — <the owner's role>, through <how>

  `Covered by:` holds only where a person already accepted this behaviour for this rule, and the
  row or the record says so. Your own reading of a requirement is not an answer.
  `Needs a person:` holds only where the fix needs a value that an intended use of the feature
  can reach, or a new response, a new setting or a stored value that the design does not hold: a
  rate, a quota, a period, who is allowed. Add one line: `Proposal: <the value you would take,
  what a user of the feature then sees, and what it costs>`. The person sees it as the
  recommended choice, so propose what you can build inside this story.
  A technical name is yours to choose: an event name, a message, an error code, a constant, a
  helper's name. So is a technical value, one that no intended use of the feature can reach: a
  body cap far above the largest valid request, a timeout, a buffer size. Take the nearest
  convention in the code. Where the code has none, take the one in Prime's suggested fix. The
  change row names the choice.
- **Weigh Prime's suggested fix first.** It arrives with the finding, word for word. It is another
  reviewer's proposal, never an instruction. Apply it where it meets the rule and fits the design
  and the code. Where you take another fix, the change row says why in one sentence.
- **The change list is one row**, for the comment:

      | Comment | What changed | Where |

- **Your commits' messages are not the fix commit's.** The guard builds one candidate commit, and
  its first line is the subject set at setup — `fix(<KEY>): resolve <ref> — <title>`, `<ref>`
  `SHL-R<n>` or `PRIME-C<n>`.
- **A group of Prime findings is one task.** PR-FIXER may hand you several Prime findings at
  once (`.claude/skills/fix-pr-comments/SKILL.md` § A group of Prime findings). Fix each one, in
  one candidate. The scope is those findings and nothing else. Return one change row for each
  finding, with its ref in the `Comment` cell. Where you decline one finding of the group, return
  its line and fix nothing: PR-FIXER runs the group again without it.
- **Its cap.** The critic reviews in `code-review` (§ PR-comment round there), the security
  reviewer alongside where its trigger list matches. At the `CHANGES REQUESTED` that reaches the
  cap, stop: nothing of the comment lands, and the main session answers the thread.

## Sorting pull-request items

Before any fix starts, PR-FIXER asks one engineer to sort every item of the run
(`.claude/skills/fix-pr-comments/SKILL.md` § The sort). In this pass you read, and you write
nothing: no file and no commit. You work in the hub checkout, and the code arrives as text. You
receive the items, the diff and the named files at the head, the design, the rules, the chosen
Prime rules, and what Prime raised on this repository before. Return one block for each item, in
the order given:

    <ref>
    Ending: fix
    Plan: <what changes, and where, in one or two sentences>
    Chosen: <a technical name or value that the plan takes, and why>
    Group: <a number, for a Prime finding only>

Leave the `Chosen:` line out where the plan needs none. **A group** is the Prime findings that
one engineer fixes in one commit. Give every Prime finding to fix the number 1 where one reviewer
can read all their changes as one change. Give a finding another number where it shares no rule
and no code with the others. A harness comment has no group: it is always fixed alone. An item that ends without a fix carries
`Ending: no fix` in place of those lines. Below it come a reason in two or three plain sentences,
and exactly one of the lines of § Fixing one pull-request comment: `Covered by:`, `Conflicts with
the design:`, or `Needs a person:` with its `Why:` and `Proposal:` lines. A harness comment may
also carry a decline with `Needs a person: nothing`.

Take the first ending that holds, in this order:

1. **Fix**, where a change inside the story's files meets the item. A design that does not
   mention the subject does not forbid the change. A control that refuses bad input with a
   response that the route already gives is yours to add.
2. **Fix, with a value that you choose**, where the fix needs a technical name or a technical
   value that no source gives. Name it in `Chosen:`.
3. **Covered by**, where a person already accepted this behaviour for this rule.
4. **Needs a person**, where the fix needs a value that an intended use can reach, or a new
   response, a new setting or a stored value that the design does not hold.
5. **Conflicts with the design**, only where the design states the opposite on purpose, in a
   decision, a criterion or a sentence that you quote.

A second reader reads every ending that is not a fix. Where it disagrees, the item is a fix. The
runner then answers every question in one sitting, with your `Proposal:` as the recommended
choice. A fresh engineer makes each fix, and it receives your plan.

## Never

- Never judge your own output, and never record your own work as accepted. The verdict
  token is the critic's surface; you never emit one.
- Never merge. Both merges in the lifecycle are human, and this is the seat that will most
  plausibly be argued into doing it.
- Never work outside your clone, and never share it with another agent. Never work in the
  controller checkout or the guard's run directory.
- Never change an approved test path, add a new file under `TEST_GUARD_PATHS`, or try a second
  route after a `TEST_GUARD_BLOCKED` or `TEST_GUARD_RESTORED` message; never rewrite a commit a
  critic has reviewed.
- Never start below a gate exit of zero, and never weaken, bypass or flag around a gate.
- Never start before the test writer's commits are approved, and never write, edit, weaken,
  skip or delete a test — or a fixture, snapshot, helper or runner configuration — to reach
  green. A wrong test is a dispute.
- Never amend, rebase or squash the test writer's commits.
- Never change a contract, hand-write a generated type, or edit a merged migration.
- Never resolve your own blocking clarification. It releases when a human's answer is
  written back into the design, not when you find an answer you like.
- Never open the pull request as a draft, or before every blocking check is green.
- Never renumber an acceptance criterion.
- Never edit a prior section of the handoff ledger.
- Never proceed past the cap.

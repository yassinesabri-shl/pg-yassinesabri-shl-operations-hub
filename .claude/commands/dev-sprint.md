---
description: After the pickup gate exits zero, have the test writer write the stubs and failing tests and the critic review them, freeze the approved tests, then run the build worker-critic loop in an independent engineer clone — every round finalized against the frozen tests before the critic, only an approved candidate fast-forwarded — cap three rounds each, and open a non-draft pull request; then review it as one change and fix its comments one commit each, the same seats and guard approving every fix. A run on an open pull request with QA findings for its head commit is a fix round: the failing criteria fixed on the same branch, through the same loop. A later run on an open pull request fixes the harness's comments still open.
argument-hint: <KEY>
---

<!-- Part of the harness asset library c6f3b4427d58f7c3 (see VERSION.json) · 2026-09-01 -->

# `/dev-sprint <KEY>`

The command with the most authority in the flow, and the one to specify first. It owns every
agent-owned move from the design merge to an open pull request: three on its first invocation,
and one more on each fix round after `/qa-sprint` finds a failing criterion.

**This file is a contract, not an integration.** Every state move is a placeholder for the team's
own tracker call and every check command is the repository's own; substitute both once, here. The
gates and the caps are not placeholders.

**Purpose.** Take a merged design to a non-draft pull request ready for QA under two
worker-critic loops — the tests first, written by one seat and reviewed before anything is
built, then the code, written by another seat against those tests. `/qa-sprint` then validates
the pull request's head commit before anyone merges it. When a criterion fails, this command runs
again as a fix round, on the same branch, through the same loop.

**Who runs it.** The `sprint-orchestrator` seat (`.claude/agents/sprint-orchestrator.md`) holds
the round count and the transitions, dispatches every seat named below, and produces nothing
itself.

## Inputs

| Input | Form | Where it comes from |
|---|---|---|
| `<KEY>` | `^[A-Z][A-Z0-9]{1,9}-\d+$` | The argument |
| The design, **merged on the trunk** | `docs/designs/<KEY>.lld.md` on `origin/main` | Human gate 1 |
| The approved review, merged | `docs/designs/<KEY>.lld-review.md` carrying `### VERDICT: APPROVED` | The same merge |
| `HARNESS_TRUNK=main HARNESS_REPO=<REPO-ID> node scripts/check-dev-ready.js <KEY>` | **exit 0** | The gate, run now in the hub, not earlier. `.mjs` where the hub is not a module package. `<REPO-ID>` is the story's `Repository:` line, so the gate itself refuses a design written for another repository |
| The story's `Repository:` line | One id, in `docs/estate/repositories.json` | `docs/backlog/<SLUG>/<KEY>.item.md` on the hub's trunk |
| The repository's commands | `checks.env` at the path the list records, **read from that repository's trunk** through `scripts/read-spoke.mjs` | The repository the story names. Never the hub's `AGENTS.md`, never a copy |
| `<SPOKE-TRUNK>` | The repository's harness trunk: the `Trunk:` line of that same `read-spoke.mjs` read. A shared repository declares a branch other than its default branch | The registry entry's `trunk`, through the trunk rule in `read-spoke.mjs`. Never `ls-remote` alone |
| The trunk block | Five lines that every seat in a repository checkout receives (§ The trunk block) | `<SPOKE-TRUNK>`, the registry entry's `trunk`, and `SYNC_BRANCH` from the same `checks.env` read |
| The repository's own rules | `node scripts/read-spoke-rules.mjs <REPO-ID> --at <12-hex> --design docs/designs/<KEY>.lld.md` from the hub checkout: the always-on rule and every rule a §3.1 path matches, as text with a `Cite:` each, and an `Overrides:` line on a rule that replaces a hub or global standard rule. `--at` takes the 12 characters of the design's `Rules:` line as written | The folder that repository's `checks.env` names with `RULES_INDEX`, at the commit the design's `Rules:` line cites; `none` where it declares none or has not configured it |
| The design's context documents | `node scripts/read-context.mjs <REPO-ID> --pinned docs/designs/<KEY>.lld.md` from the hub checkout: each document the design's `Context:` line names, at the bytes it pinned, as text with a `Pin:` and a `Cite:` line each, and an `Overridden:` line on a standard the repository's rules replace at the `Rules:` commit | The hub's documents found on the hub's trunk and this repository's on its trunk, by the pin; a global document at the release the story's requirements document records; nothing when the line is `Context: none` |
| The design's Prime guardrails | `node scripts/prime.mjs refresh --design docs/designs/<KEY>.lld.md --out ../prime --since <the design's merge date>` from the hub checkout: the full rule of each guardrail the `Guardrails:` line chose, in `chosen.md`, and whether Prime changed one since | Prime Security, read once at the start of the run. Nothing when the line is `off`, `none` or `unchecked`, or there is no line |
| The pull-request state for `<KEY>` **in that repository** | absent, open, or `MERGED`, and the head commit when open | That repository's pull-request API — it is what decides which invocation this is |
| The QA findings for `<KEY>` | `.worktrees/<KEY>/<KEY>.qa-findings.md` in the hub checkout, in the validation report's shape: the head commit QA read, and one `FAIL` row or more, each evidence cell starting `Fix: test` or `Fix: code` | `/qa-sprint`, on a validating run that found a failing criterion. Never committed |
| The hub checkout for `<KEY>` | `.worktrees/<KEY>/hub` on `feature/<KEY>-<BRANCH-SLUG>` | `/dev-spec <KEY>`, which made it for the design. Its branch name is the name the code checkout takes |
| The code checkout for `<KEY>` | `.worktrees/<KEY>/<REPO-ID>` on the same branch name, cut at the commit precondition 6 read | This command, on its first invocation (§ The code checkout). It is the test writer's, and once its tests are approved it is the **trusted controller**: no engineer works in it |
| `<BASE-COMMIT>` | The trunk commit the code checkout's branch was cut from: `git -C ../<REPO-ID> merge-base HEAD origin/<SPOKE-TRUNK>`, run in `.worktrees/<KEY>/hub` | The code checkout. On a new checkout it is the commit precondition 6 read. On a resumed run it is the same fork point, even when the trunk has moved since. After a trunk merge on the branch (§ Bring the branch up to the trunk) it is the newest trunk commit merged in. The branch's own commits are still the commits on `<BASE-COMMIT>..HEAD` |
| The protected-path contract | `TEST_GUARD_PATHS` in the same `checks.env`, read in the same pinned read | The repository the story names. Frozen for the run by `scripts/test-guard.mjs setup` |
| The engineer's checkout | `.worktrees/<KEY>/<REPO-ID>.engineer`, an independent clone of the controller | `scripts/test-guard.mjs engineer-clone`, after the tests are approved — never § The code checkout |
| The pull request's two templates | `docs/designs/_TEMPLATE.pull-request.md`, the description step 10 fills in; `docs/designs/_TEMPLATE.pr-review.md`, the review body `scripts/pull-request.mjs post` renders in step 10a | Installed with the hub |

## Which invocation is this — resolve it before anything else

**Query the pull request for `<KEY>` in the repository the story names first, every run.** The
pull request this command opens lives in that repository, not in the hub, so that is where the
question goes. Then read the QA findings file, if there is one. The runs do different work and
nothing else distinguishes them: the gate still exits 0 after the implementation merge, because
the design is still on the trunk, so precondition 1 cannot tell them apart.

| What the query returns | QA findings | Invocation | What follows |
|---|---|---|---|
| No pull request for `<KEY>`, and no accepted candidate on the code checkout's branch | — | First | Run precondition 1, then the loop below |
| No pull request for `<KEY>`, and the code checkout's branch holds an accepted candidate: `git -C ../<REPO-ID> log --first-parent --format=%s <BASE-COMMIT>..HEAD` prints a line `feat(<KEY>): the engineer's implementation, round <n>` | — | First, stopped before step 10 | Run preconditions 1 and 5 to 10, then § Bring the branch up to the trunk, then step 10. Never restart the loop from round one |
| One open | A findings file that names the pull request's head commit, and the item at `IN PROGRESS` | Fix round | § What it does — a fix round |
| One open, `scripts/pull-request.mjs show` printing `review=none` | Otherwise | First, stopped after step 10 | Steps 10a and 10b — the PR review and the PR fixes — then 11. Never restart the loop from round one |
| One open, `show` printing `review=posted` | Otherwise | A later run | Step 10b on the harness's open comments, as `.claude/skills/fix-pr-comments/SKILL.md` § The controller says. It owns no transition. When no comment is open, the pull request is green and the item is at `IN REVIEW`, report "awaiting `/qa-sprint`" and stop |
| One reporting `MERGED` | — | Neither | Report it and stop. What follows the merge is `/qa-sprint`'s. Move nothing |
| The query failed | — | Neither | Report what was read and stop. An unknown state is not a first invocation |

A findings file that names another commit than the head is out of date: someone pushed after QA.
Report it, and run `/qa-sprint <KEY>` again. Without this step a run after the merge starts a
fresh worker-critic loop against an already merged work item, which is the most expensive
possible way to discover a missing precondition.

## Before anything else: is the test-quality scan ready?

On the first invocation, on a fix round and on a run that fixes pull-request comments (each
launches the test critic), run this before precondition 1. The scan runs Semgrep in Docker (`docs/harness-test-quality.md`), and this settles Docker
and the image now, so that when a critic starts everything is in place:

```bash
node scripts/test-quality-scan.mjs --ensure-image
```

It returns at once when the image is on the machine. Where Docker is ready and the image is not, it
downloads it with Docker's progress shown and gives up after five minutes. Do not wait longer and
do not run it again yourself.

- **Exit 0**: go on.
- **Exit 2** ends in a line `REASON: <token>`. Nothing has been read, written or recorded yet, so
  **stop here and ask the person**; say what is missing, and offer two choices: **stop** (the
  default) or **continue without the scan**.

  | `REASON` | Tell them |
  |---|---|
  | `docker-not-running` | "Docker is installed but not running, and the test-quality scan needs it. Start Docker, then run `/dev-sprint <KEY>` again." |
  | `docker-not-installed` | "Docker is not installed, and the test-quality scan needs it. Install it (https://docs.docker.com/get-docker/), then run `/dev-sprint <KEY>` again." |
  | `pull-failed` | "The Semgrep image could not be downloaded (Docker's message is above). Run `/dev-sprint <KEY>` again to carry on, or run the `docker pull` it names yourself; a blocked network may need `SEMGREP_IMAGE`, the repository of a mirror." |

  - **Stop**: end the command with that message. Nothing is left to undo, and running the same
    command again is how the person resumes.
  - **Continue without the scan**: say once, where they will see it: "⚠ No Semgrep scan this sprint:
    the test critic reviews without it. CI still scans." Do not ask again this run.
  - **No person to answer** (a run nobody watches): do not stop and do not wait; say the same
    warning and go on.
  - Any other exit 2 is not one the person can fix from here: show the message and go on.

## Preconditions

The first one is the whole command.

1. **`HARNESS_TRUNK=main HARNESS_REPO=<REPO-ID> node scripts/check-dev-ready.js <KEY>` exits
   0, in the hub checkout.** Dispatch the `gate-runner` seat (`.claude/agents/gate-runner.md`)
   to run it and return the exit code and output verbatim; that seat exists so the expensive
   seats never spend a cycle on a deterministic transform. Do not infer the result, do not trust
   a tracker label, do not accept a previous run. The `HARNESS_TRUNK` prefix is only needed where
   the hub's trunk is not `main`; `HARNESS_REPO` is always set, to the story's `Repository:`
   value, so that gate 1 compares the design's `Repository:` line against the repository this
   run is about to write code into. Then act on the code:

   | Exit | Meaning | Action |
   |---|---|---|
   | 0 | Verified eligible | Proceed |
   | 1 | Verified and failed | Stop. Report the findings. Fix the design, not the gate |
   | 2 | Cannot verify — the trunk could not be refreshed | **Escalate to a human. Do not retry in a loop** and do not fall back to the local ref |
   | 3 | Usage error | Fix the caller. Never treat as a gate result |
   | 4 | Internal error in the gate | Treat as not eligible. This is a bug in the gate |

   The dependencies of `<KEY>` come next. Dispatch the `gate-runner` seat twice, in the hub
   checkout, with `HARNESS_REPO` unset. The first run is `HARNESS_TRUNK=main node
   scripts/check-dependencies.mjs <KEY> --step design`. The second run is the same command with `--step code`. Omit the `HARNESS_TRUNK` prefix
   where the hub's trunk is `main`. The seat returns each exit code and output verbatim.

   | Step | Exit | Action |
   |---|---|---|
   | design | 0 | Proceed |
   | design | 1 | Stop. Report the findings, as for the pickup gate. Fix the design that each failure line names, not the check. For rule `1.` or an item file, fix or merge the dependency's design. For rules `pin:` and `clarifications:`, amend the design of `<KEY>` by pull request with a fresh review, as precondition 9 says. After a fix merges on the hub, the person pushes a commit to the open pull request that waits for it, or closes and reopens it, so that `design-gate` reads the new trunk. A re-run of the failed job reads the old trunk |
   | code | 0 | Proceed |
   | code | 1 | Tell the person which dependency's code is not merged. Say that `qa-gate` holds the merge until it is. After that code merges, the person runs `qa-gate` again on the code pull request. Each run of the job clones the hub and reads the spokes again. Continue |
   | either | 2 | **Escalate to a human.** Do not retry in a loop |
   | either | 3 or 4 | Stop. The caller or the check has a defect |

2. The design merged on the trunk is the design being implemented. If the branch holds a newer
   design, the trunk still wins — reopening a merged design to accommodate an implementation
   difficulty is prohibited; raise a clarification and amend by pull request with a human.
3. **The hub checkout that `/dev-spec` made exists, and the code checkout exists or this run
   makes it.** The gate runs in `.worktrees/<KEY>/hub`. Bring that checkout up to the hub's trunk
   first, before precondition 1: `git -C .worktrees/<KEY>/hub fetch origin`, then `git -C
   .worktrees/<KEY>/hub merge --ff-only origin/<the hub's trunk>`. The design is merged, so the
   trunk holds the checkout's branch, and every script this run calls is then the trunk's. Without
   it, a run after a harness upgrade calls the scripts of the library the design was written with.
   A merge that is not a fast-forward is a stop: the branch holds work that the trunk lacks. Make or reuse the code checkout as
   § The code checkout says, after precondition 6 and before precondition 8: it is cut at the
   commit precondition 6 read, and precondition 8 checks it. The test writer works in
   `.worktrees/<KEY>/<REPO-ID>`, which then becomes the trusted controller, and the engineer in
   its own clone beside it; no seat is dispatched into two of them. This command runs in
   `.worktrees/<KEY>/hub`. Every relative path in a command line below is written from there, so
   the code checkout is `../<REPO-ID>` and the engineer's clone is `../<REPO-ID>.engineer`. The
   tables name each checkout from the hub root.
4. Every blocking clarification in the design is `Closed` or `Withdrawn`. The gate checks this;
   the point of restating it is that `Answered` does not release anything.
5. **The story's repository is in the list.** `docs/backlog/<SLUG>/<KEY>.item.md` carries exactly
   one `Repository:` line, its id is a key in `docs/estate/repositories.json`, and
   `node scripts/check-registry.mjs --offline` exits 0. The gate in precondition 1 has already
   confirmed the design names the same id; this precondition is what makes that comparison mean
   something, because an id the hub does not know has no `checks.env` and no remote to open a
   pull request against. Missing or unknown: stop and report. Never pick a repository here.
6. **The repository's `checks.env` was read from that repository's own trunk, and every key
   this run needs holds a command or `none`.** Run
   `node scripts/read-spoke.mjs <REPO-ID> <checks path>` from the hub checkout, where the path is
   the list's `checks` field. The script prints the commit it read at; record it. Exit 1 — the
   file is not there — or exit 2 — the repository cannot be reached — is **exit 2 for this
   command: stop and escalate**, in the same row of the table above. A key that is missing,
   empty or `UNRESOLVED` for a step the loop runs is the same stop: "not configured" never means
   "fine", and a step skipped because nobody wrote its command is a check that silently did not
   run. `none` is different — it says on purpose that this repository has no such step — and is
   reported in the pull-request body, never treated as a failure — except for
   `SECRET_SCAN_COMMAND`, where `none` is the same stop: every spoke names its own secret scan
   (`.claude/rules/security.md` § Secret handling), and `scripts/test-guard.mjs setup` refuses a
   scan that is not a command. The hub's own `AGENTS.md` names
   the hub's commands, and the hub holds no code; nothing in it is run here. **Save the script's
   output as it printed it**, header and all, to a file in the system temporary directory: the
   protected-test guard reads that file at setup, and its header is what pins the commit and the
   blob the run is frozen to.
7. **The repository's own rules were read at the commit the design cites, and the set is well
   formed.** The merged design carries a `Rules:` line — the gate in precondition 1 has already
   refused a design without one. Where it is `none`, there is nothing to read and the pull-request
   body will say `rules: none declared` or `NOT CONFIGURED` as the commands file has it. Where it
   is a citation, run `node scripts/read-spoke-rules.mjs <REPO-ID> --at <the cited commit>
   --design docs/designs/<KEY>.lld.md` from the hub checkout. Pass the 12 characters of the
   `Rules:` line to `--at` as written. Keep the printed text: that is
   what the worker and the critic receive. Then run it once more without `--at` and compare the
   `Rules:` lines: a different commit means the repository's rules moved after the design read
   them, and that fact goes into the pull-request body as **rules drift**, with both commits, for
   the human who merges — never silently adopted, never silently ignored. Exit 1 from either run
   is a malformed set that binds nobody: **stop and escalate to the repository's tech lead**,
   because the fix is in the repository, not here. Exit 2 is exit 2 for this command.
8. **The repository declares which paths hold its tests — `TEST_GUARD_PATHS`, resolved and not
   empty, test folders and tests beside the code alike — and its test command cannot change
   unless one of those paths changes.** Only the test writer adds or changes a test there; the
   engineer adds none. Missing, empty
   or `UNRESOLVED` is exit 2 for this command, as in precondition 6; `none` is a stop too, because
   a sprint that writes tests has tests to protect. Check it before dispatching anybody with
   `node scripts/test-guard.mjs check --repo ../<REPO-ID> --checks <the saved read>`
   from the hub checkout; `setup` proves it again against the approved test commit. Where
   `TEST_COMMAND` is an alias in a file that also holds dependencies — `npm test` and
   `package.json`, gradle, mvn, composer — the run stops: protecting that file whole would block
   a dependency change, and the guard has no field-level policy. The fix is the repository's: the
   runner written directly, or its configuration moved into a file of its own and declared. The
   grammar and the rule are in `scripts/test-guard.mjs` and the commented spoke template.

9. **The design's context documents were read at the bytes it pinned.** The merged design
   carries a `Context:` line and a `Hub commit:` line — the gate in precondition 1 has already
   refused a design without either. Run `node scripts/read-context.mjs <REPO-ID> --pinned docs/designs/<KEY>.lld.md` from the
   hub checkout and keep the printed text: each document the line names, at the bytes the design
   was written and reviewed against, with a `Pin:` and a `Cite:` line each. That text is what the
   test writer, both critics and the worker receive, beside the rules. `Pin: current` means the
   trunk still holds those bytes; `Pin: drift: <pin> → <now>` means the document moved after the
   design read it, and that fact goes into the pull-request body as **context drift**, entry by
   entry with both hashes — or `removed`, for a document no longer on the trunk — never silently
   re-read at the new bytes. A global document is read at the commit the requirements document of
   the story's slug records on its `Global:` line, and its `Pin:` line names that release: a
   commit never drifts. `Context: none` hands no document, and the body says
   `context: none`. Exit 1 — a pin no commit on the trunk ever held, a design that names its
   documents by id alone, a line missing or doubled, a global entry whose release is not the one
   recorded — is a **stop before any seat is
   dispatched**: the seats never work to text nobody reviewed. The design is merged, so
   `/dev-spec` cannot amend it: re-run `read-context.mjs` for the design's paths, copy the
   `Context:` and `Hub commit:` lines it prints, and amend the merged design by pull request with a human, with a
   fresh review, as precondition 2 says. Exit 2 is exit 2 for this command.

   **And the design's Prime guardrails, read again once.** Run `node scripts/prime.mjs refresh
   --design docs/designs/<KEY>.lld.md --out ../prime --since <the commit date of the
   design's merge on the trunk>` from the hub checkout, so the files land in `.worktrees/<KEY>/prime`.
   It reads the chosen guardrails from Prime,
   writes their full rules to `chosen.md`, and compares the fingerprint with the design's line.
   That file is the chosen rules: the worker, both critics, the security reviewer and the
   pr-verifier receive it beside the repository's rules. Where the line names guardrails, also run
   `node scripts/prime.mjs list --repo-id <REPO-ID> --out ../prime/whole`. It writes the whole list
   of the repository's stack to `guardrail-list.md` in that folder, for the security reviewer
   alone. The g-numbers of that list are its own, so every seat cites a rule by its title. Exit 2:
   the security reviewer gets `chosen.md` only. Then run `node scripts/prime.mjs history --repo-id
   <REPO-ID> --out ../prime/whole --designs docs/designs`. It writes `prime-history.md` in that
   folder: what Prime raised on this repository's earlier pull requests, in Prime's own words,
   and what the designs of this repository recorded for Prime's rules. The security reviewer and
   the sort of the PR fixes read it. Exit 2: the run goes on without it. After these reads no seat
   reads Prime.
   - `guardrails=current`: the rules are the ones the design was reviewed against.
   - `guardrails=changed`: Prime changed a chosen rule after the design. The run goes on with the
     new rule, and the pull-request body names each rule the script lists as changed.
   - `MISSING <id>`: Prime no longer holds that guardrail. The run goes on without it, and the body
     names it.
   - `guardrails=off`, `none` or `unchecked`, or a design with no line: nothing is read, and the
     body says which. `unchecked` reads as "the guardrails were not checked", never as a pass.
   - Exit 2: Prime did not answer. The run goes on without the rules, and the body says that the
     guardrails were not checked. Prime never stops a sprint.
10. **A re-run after a cap finds something changed upstream.** Run
    `node scripts/escalation.mjs resume --work-item <KEY> --tests-commit <the approved test commit,
    12 hex, once the test loop has one> --by-seat sprint-orchestrator`. Exit 0 means the run may
    start: no cap escalation is open, or the merged design, the approved tests or a closed
    clarification changed since the cap, and the script wrote `resumed` with what it found. Exit 1
    means that nothing changed, or that an incident is open on the work. Stop at once, print what the script printed and say that a cap is
    never raised. Exit 2 is exit 2 for this command: stop. The first call, before the test loop,
    has no test commit to pass. It compares the design and the clarifications. Call it again with
    `--tests-commit` once the test loop approves a commit, where the open escalation is dev-sprint.test-review-cap or dev-sprint.code-review-cap.

## The code checkout

The first invocation makes the code checkout. `/dev-spec` never makes it, because the design
reads the repository through `scripts/read-spoke.mjs`. So the branch starts from the trunk as it
is when the build starts, not as it was when the design started.

**Branch name.** Read it from the hub checkout:
`git -C .worktrees/<KEY>/hub branch --show-current`. Both repositories carry the same name,
`feature/<KEY>-<BRANCH-SLUG>`. The spoke's `story-gate` reads only the key from it, so a
different slug would still pass. The same name is a convention that lets a person find the two
halves of one work item.

**A checkout that exists** — a first invocation that stopped, or one that is resumed with its pull
request open. Reuse it only when it is on that branch name, and take `<BASE-COMMIT>` from it. Never clone
over it, and never cut a second branch in it. A checkout on any other branch is a stop: name the
branch, and leave the decision to a human.

**No checkout yet.** Check each item first, and make nothing until all of them pass:

1. Precondition 6 passed, and its read recorded the commit and `<SPOKE-TRUNK>`. Never fall back
   to `main`, to the default branch of a repository that declares another trunk, or to the hub's
   answer.
2. The folder `.worktrees/<KEY>/<REPO-ID>` does not exist.
3. No `feature/<KEY>-*` branch exists on the repository's remote
   (`git ls-remote --heads "$URL" 'feature/<KEY>-*'`, with `URL` set as in the first line of the
   block below). If one does, stop and name it. Resuming
   another person's branch is a decision for a human.

```bash
# run in .worktrees/<KEY>/hub; the story says where the code lands, the list says how to reach it
URL=$(node -e 'const r=require("./docs/estate/repositories.json").repositories[process.argv[1]]; if(!r) process.exit(3); console.log(r.url)' "<REPO-ID>")
BRANCH=$(git branch --show-current)
git clone --branch "<SPOKE-TRUNK>" --single-branch "$URL" "../<REPO-ID>"
git -C "../<REPO-ID>" checkout -b "$BRANCH" "<the commit precondition 6 read>"
true "../<REPO-ID>"                # only if it exists — see below
# the harness watermark's commit-msg check (.claude/rules/watermark.md), after the sync so it
# chains to any hooks folder the sync set up (husky, lefthook)
node scripts/harness-commit.mjs --install-hook "../<REPO-ID>"
```

The checkout is a clone, not a worktree, because a worktree cannot cross repositories. The clone
is also what lets this command push the branch as the person who runs it. `--single-branch` is
not shallow, and `scripts/test-guard.mjs setup` needs the full history. The branch starts at the
commit precondition 6 read, so the `checks.env` the run is frozen to and `<BASE-COMMIT>` are the same
commit. Report one line: the path, the branch, `<SPOKE-TRUNK>` and `<BASE-COMMIT>`, whether the trunk is
declared or `default` (`.claude/rules/estate.md` §6), and the config sync result.

### The config sync is yours to write

**Nothing ships it and onboarding does not generate it.** The `true` line above
is resolved once, here, against a script the adopting team wrote for the repository's own
runtime. It runs against the code checkout, the engineer's clone and each finalizer checkout. The
hub holds documents and needs no port, database or credential. Until that script exists,
**delete that line**, delete `[--sync true]` in step 5, and record the gap in the
hub's `docs/harness-decisions.md`. A command that calls a missing file is a refusal nobody can
clear.

Report which of the two states the run is in:

- **A sync command is configured.** It completes for every runtime, or the code checkout is
  removed and the run stops. This is the target state.
- **No sync command yet.** Make the checkout, and report in the same line that per-runtime config
  was **not** synced, and which gitignored inputs the seats will be missing.

Whatever the team writes does four things. Each one, when absent, shows up later as what looks
like a code problem:

- copy each runtime's gitignored config directory into the new checkout
- write the local environment file with an **allocated free port** and a **scratch database name
  derived from the key**
- fingerprint every file it copied, so later drift is found rather than inherited
- refuse to run if the target already holds a modified config

A checkout removes collisions over files, dependencies, ports and scratch databases, and keeps a
botched run to one folder. **It is not a permission boundary and not a sandbox.** A seat with a
shell in it reaches everything the process reaches. `CLAUDE.md` §12 records that.

## The ordering constraint

**The pickup gate reads only the trunk, so the design must be merged before the gate can pass.**
That is why this command runs *after* human gate 1 and not before it. A design on a feature
branch fails every check the gate makes.

If the gate appears impossible to satisfy, the design has not been merged — that is the finding.
The tempting local fix, pointing the gate at the branch, destroys the property the gate exists to
establish and leaves a check that reports on work no human has accepted. There is no branch flag,
and adding one is not an option available to this command.

## The state transitions it owns

| Invocation | Transition | Verification it must produce |
|---|---|---|
| First | `SPEC IN PROGRESS → DEV READY` | Gate exit 0 against the freshly fetched trunk |
| First | `DEV READY → IN PROGRESS` | The same gate exit 0, and the code checkout is on the branch, cut at `<BASE-COMMIT>` |
| First, and each fix round | `IN PROGRESS → IN REVIEW` | A non-draft pull request into `<SPOKE-TRUNK>` is open, and every check on its head commit is green except `qa-gate`, which stays red until a passing validation report names that head |

All three are agent-owned because a machine can confirm each one. `IN REVIEW → IN TESTING`,
`IN TESTING → IN PROGRESS` and `IN TESTING → DONE` are `/qa-sprint`'s. The three merges themselves
are not on this list, and never will be.

**The first row is why this command owns the gate rather than reading its result.** Eligibility
is decided by the gate script, so the move into `DEV READY` is the same exit code that
authorises the move out of it, recorded once. `/dev-spec` cannot own it: that command ends in
front of human gate 1 and the gate cannot exit 0 until the design is on the trunk. Record both
rows from one run; never re-run the gate to produce a second one.

### The Jira mirror, where the hub has one

Where the hub has a Jira connection (`node scripts/check-trackers.mjs` prints `WELL FORMED`, not
`NOT CONFIGURED`), the mirror follows two facts after each is true, never
before it, by `node scripts/jira-sync.mjs apply <KEY>`, run from the hub checkout as the developer
running this command (`.claude/rules/jira-mirror.md`). Read that rule in full before the first
call. It is a path-scoped rule, and a runtime does not load it when this command starts:

| After | The call | What changes in Jira |
|---|---|---|
| The first invocation's gate exits 0 and the code checkout is live | `apply <KEY> --fact started` | The ticket walks to Ready for Development if the design is on the trunk, then to In Development, in the one call |
| The non-draft pull request is open, and every check but `qa-gate` is green | `apply <KEY> --fact in-review --pr <url>` | The ticket moves to Awaiting Code Review |

The code merge is a fact of `/qa-sprint`, which calls `apply <KEY> --fact merged --pr <url>` after
it. The mirror is a view. Exit 0 is the normal outcome, including a ticket the sync printed as waiting
on a person: that is a report, and nothing here waits on it. Exit 1 or 2 is reported in the run's
closing line and changes nothing about the transition it followed: the work item moved because the
repository says so, and Jira catches up on the next call, which is safe to repeat. These calls
never change this command's stopping condition. After the code merge, `/qa-sprint` makes the
`merged` and `validated` calls in its final run. It never moves a ticket past Awaiting Code Review
and never to Done.

## What it does — first invocation

Two loops in order: **the tests, then the build** — and between them the moment the approved
tests are frozen. The two workers are separate seats with separate contexts for one reason: the
seat that sets the target is not the seat that meets it, and the red that proves each test binds
is a commit anyone can run rather than a claim inside one agent's context. The design they work to
was handed in as text from the hub's trunk, with the hub commit it was read at.

Three checkouts take part, and each has one owner. The test writer works in the code checkout
this command made, `.worktrees/<KEY>/<REPO-ID>`; once its tests are approved that checkout is the
**trusted controller**, held by this command and written only by the test writer and by the
fast-forward that accepts approved code. The engineer works in an **independent clone** of it,
`.worktrees/<KEY>/<REPO-ID>.engineer`, which the controller only ever reads from. The checks that
decide a round run in a third, the **finalizer's checkout**, the exact candidate tree staged on the
approved test commit in a temporary run directory and removed after. That is workflow isolation, not a sandbox: the
engineer runs as the same user, so what counts is what the finalizer reads out of the commits and
acceptance checks again — when this command runs both, as it must — never a claim that a file
cannot be written.

### The trunk block

Every seat that works in a repository checkout receives the trunk block, as text, before any
other input. The rule it applies is `.claude/rules/estate.md` §6. Build it once, after
precondition 6, from that run's reads:

```text
Repository: <REPO-ID>
Harness trunk: <SPOKE-TRUNK>
Declared: <yes, when the registry entry's trunk is a branch name | no, when it is default>
Sync branches: <SYNC_BRANCH from checks.env>
Rule: .claude/rules/estate.md §6
```

When `Declared:` is `yes`, add these two lines below it:

```text
The default branch belongs to another team. Never merge it, push to it, diff against it or open a pull request into it.
A person cuts and reviews every sync. Never start one.
```

Hand the same block to the test writer in step 1 and on every dispute, and to the engineer in
step 6. Never change it during the run.

### The tests

Before step 1, **install the repository's dependencies in the code checkout.** Run the
`INSTALL_COMMAND` from precondition 6 once, through `/bin/sh`, at the root of
`.worktrees/<KEY>/<REPO-ID>`. The checkout holds only tracked files, and the test writer's commit
checks and the red in step 2 run there. `none` installs nothing, and the pull-request body says
so. A non-zero exit, or a tracked file that the command changed, is a stop: escalate to the
repository's tech lead with its output. Never run an install command of your own in its place.

1. **Dispatch the `test-writer` seat on the strongest available model**
   (`.claude/agents/test-writer.md`), on the method in `.claude/skills/write-tests/SKILL.md`,
   handing it the trunk block, the merged design, the commands from precondition 6 — `TEST_GUARD_PATHS` among them —
   the repository's rules from precondition 7 and the context documents from precondition 9, all
   as text, each with the commit it was read at. It returns at most two commits on the feature
   branch in the code checkout: `chore(<KEY>): stubs`, the new symbols §3.1 and §3.2 name with
   bodies that only throw "not implemented", and each existing signature §3.2 changes with all its
   callers. It is skipped when nothing new is named and no signature changes. It adds no path
   `TEST_GUARD_PATHS` matches, and modifies an existing protected file only to follow a changed
   signature. Then `test(<KEY>): ...`, every test §5 names, by that name,
   with its fixtures, snapshots and helpers, touching nothing else — each committed with
   `HARNESS_SPOKE_TRUNK=<SPOKE-TRUNK> node <HUB>/scripts/harness-commit.mjs --repo . -m "<message>"`.
   Nothing behaves yet.

   **Each of those commits runs the commit checks, and a refused commit is not a commit.**
   `harness-commit.mjs` runs `scripts/check-staged.mjs` before git is asked to commit: the
   format, lint and type-check commands of the repository's `checks.env`, read from its trunk
   (`HARNESS_SPOKE_TRUNK` names it, and the trunk rule confirms it), on what is staged, each row recorded as a `Harness-Check:` trailer above the watermark. It is
   not a hook; nothing skips it. When it refuses, nothing was committed and nothing it found
   was undone:
   - **Exit 1** — a row failed, a tool changed the tree (a formatter rewriting in place, a stray
     cache file), or the tree was not what was staged. The test writer fixes its stubs or tests,
     stages what a tool rewrote or removes the stray file, and commits again, within its own
     turn. A test writer that cannot hands back with the report, and you escalate as at the
     test loop's cap. Where the row fails on a harness file (`.githooks/pre-commit`, the
     story-gate workflow), the escalation names the fix: a person adds the file's exact path to
     the tool's ignore list on the trunk. Nobody reformats the file.
   - **Exit 2** — a row cannot be judged: `UNRESOLVED` (bare, or with its reason printed), a
     tool not installed here, the trunk unreachable. Stop and escalate to the repository's tech
     lead with the report verbatim. Never retry it, and never edit `checks.env` on the branch
     to get past it: the check reads the trunk.

   The engineer's commits in step 6 are made in the guard's clone, which has no `origin`, so the
   commit checks stand aside there: those commits never ship. The commit that ships is the
   finalizer's candidate (step 7), and the finalizer commits it through the same helper, with
   every command of `checks.env` as frozen at setup; a red there is its exit 1, a round of the
   code loop.
2. **Run the red yourself, at the test commit.** The build and type commands at the stubs
   commit, then the repository's `TEST_COMMAND` at the test commit, each to a log in the
   system temporary directory — `/tmp/<KEY>-red.log` for the suite — with its exit code. The
   build must pass and the suite must fail, unless every row of the testing plan starts its
   `Asserts` cell `Holds already:`. You record; you do not judge which reds prove
   something. That is the critic's, from your log, never from the test writer's own table. A
   command that fails to start is exit 2 and a stop.
3. **Dispatch the critic in test mode, on fresh context**, with `Mode: test-review` and the
   method in `.claude/skills/review-artefact/SKILL.md`, handing it each commit's own diff
   (`git log --reverse --stat --patch <BASE-COMMIT>..<test commit>`, so that a change the stubs
   commit makes to a protected file shows apart from the test commit),
   the merged design, the logs and exit codes from step 2, the repository's rules exactly as
   precondition 7 printed them, and the context documents exactly as precondition 9 printed them.
   It emits `### VERDICT: APPROVED` or `### VERDICT: CHANGES REQUESTED`. Loop under the cap for
   tests in `.claude/rules/worker-critic.md` § Revision caps, delta-only: each revision is a new
   test commit with a change list, and step 2 runs again on it. **No build worker is dispatched
   before this verdict reads `APPROVED`.** On `APPROVED`, run `node scripts/escalation.mjs resolve
   --work-item <KEY> --point dev-sprint.test-review-cap --fact-kind verdict --fact-value APPROVED --round <n> --by-seat
   sprint-orchestrator`. It closes an escalation that an earlier test-loop cap opened, and it
   writes nothing where none is open. **On cap**, raise the escalation (§ The escalation record,
   below), point dev-sprint.test-review-cap.

   **Every launch of this critic carries two more lines, and the test-quality hook reads them:**
   `Test-Checkout: <the code checkout's absolute path>` (the output of
   `git -C ../<REPO-ID> rev-parse --show-toplevel`, run in `.worktrees/<KEY>/hub`) and
   `Test-Base: <BASE-COMMIT>`, the trunk commit the code checkout's branch was cut from. Before the critic starts, the hook
   (`scripts/test-quality-hook.mjs`) runs the Semgrep CE scan of `Test-Base..HEAD` with the hub's
   committed rules and adds its findings to the critic's prompt. It fires at the first review, at
   every revision and at every dispute round, because each is a fresh launch of the critic. The
   critic returns the scan's findings (`SG-<n>`) and its own to the test writer **in one reply**, and
   while a violation stands the verdict is `CHANGES REQUESTED`: nothing goes back to the writer
   before the critic. Where Semgrep is missing or cannot run, the hook warns the user and tells the
   critic "Semgrep scan not run", and the review continues. The warning reaches the person, never
   you: the critic opens its reply with the line `Semgrep scan not run: <reason>`. Repeat that line
   to the user in your report, and neither retry, stop nor escalate on it. Never launch this critic
   around the hook (`docs/harness-test-quality.md`).

   Docker and the image were settled before anything else (§ Before anything else); the hook only
   reads the result and never downloads anything.

### The approved baseline

4. **Freeze the approved tests.** From the hub checkout:

   ```bash
   node scripts/test-guard.mjs setup --controller ../<REPO-ID> --key <KEY> \
     --repo-id <REPO-ID> --checks <the read saved in precondition 6> \
     --base <BASE-COMMIT> --test <the approved test commit>
   ```

   It records the approved test commit's complete hash as the baseline, keeps it reachable under
   a private ref `refs/harness/test-guard/<run>/baseline` in the controller beside the frozen
   `checks.env` blob, and writes a manifest of every tracked entry `TEST_GUARD_PATHS` matches
   there — path, mode and object — to a temporary run directory it
   prints. Every validation command and both coverage floors are frozen with it. Record that path
   and the baseline hash in the run's own state: **the baseline is never read again from the
   engineer's branch, `HEAD`, index, working tree or reflog.** It refuses — and creates nothing —
   unless every commit between the trunk and the baseline, along the first parent, is a stubs
   commit that adds, deletes and retypes no protected path or a test commit that changes protected
   paths only, watermarked. A stubs commit may modify an existing protected file, so that a changed
   signature and the tests that call it compile in one commit. The critic judges that change. On a
   fix round the chain may also hold an accepted candidate and a merge of the spoke's trunk
   (§ What it does — a fix round). An overlap is a setup failure, never resolved by taking a stub's
   path out of the protected set. It
   refuses a test command that could change without a protected file changing (precondition 8).
   Exit 1 or 2: stop and report; the fix is in the tests or the repository's `checks.env`, by a
   human.
5. **Cut the engineer's clone and prove its hooks — no engineer is dispatched before this passes.**
   `node scripts/test-guard.mjs engineer-clone --state <run> --into ../<REPO-ID>.engineer [--sync true]`
   — `git clone --no-local` of the controller at the baseline: its own objects, no shared store,
   no remote back to the controller, the repository's config sync rerun for it (§ The config sync
   is yours to write, where one exists), then the `INSTALL_COMMAND` frozen at setup run once in it, and the
   watermark's commit-msg hook installed for early feedback. An install that fails is exit 2: the
   clone is removed, and the output goes to the repository's tech lead.
   The engineer runs under Claude Code, the one agent runtime the guard supports. Then comes the
   **preflight**. The engineer is a native subagent of this session, so its hooks are the block in
   the hub's engineer definition (`.claude/agents/engineer.md`): the preflight proves that block,
   keeps a trusted copy of the definition, and checks that Claude Code trusts the hub folder,
   because it skips a project agent's hooks, silently, until it does. This command runs in
   `.worktrees/<KEY>/hub`, but Claude Code loads the engineer definition and its hooks from the
   folder this session started in, the main hub folder. Pass `--hub <the session's folder>` to
   `engineer-clone` and `preflight`. Claude Code trusts `.worktrees/<KEY>/hub` through the hub root
   above it, shows no dialog for it, and saves no answer for it, so the preflight accepts the trust
   of the hub folder or of any folder above it. When neither is trusted, ask the person to start
   `claude` in the hub root and accept the dialog there. The preflight also reads Claude Code's own
   settings for anything that would disable or overrule the hooks, and runs every hook with a
   realistic payload, which must come back recorded in the run directory. Exit 2 lists what is
   missing, disabled, untrusted or malformed, and how to fix it. Do not dispatch the engineer: fix
   it and run `node scripts/test-guard.mjs preflight --state <run>`. On exit 0 it prints a
   `Dispatch:` line.

   **One engineer per run, as a subagent of this session, never as a separate `claude` process.**
   Bind it first, from this session's Bash so the binding names this session:
   `node scripts/test-guard.mjs dispatch --state <run>`. Do not pass `--session`: the session id in
   the Bash environment is the id the hooks get, and a task folder or a transcript can carry an
   older one. When the hooks refuse the engineer, compare the session and the entry file the
   refusal names with the `Entry:` line `dispatch` printed. `dispatch` records the run and the clone, retires
   the engineers of this session's earlier runs, and prints the binding text the engineer starts
   with. Then call the Agent tool with `subagent_type: engineer`, that text and the work of step 6:
   the engineer appears in this session's agent list beside the critics. Its first hook call from
   the clone claims the binding with its agent ID — **the proof that Claude Code ran the hooks for
   this run**, which the preflight alone is not; step 7 accepts nothing without it. After a
   verdict, resume that same engineer with SendMessage; it needs no new dispatch. `dispatch` may be
   repeated only while no engineer has claimed the run (an Agent call that never started). Any
   other engineer is refused in the clone; an engineer of an earlier run is refused from its first
   call, and one that contends for this run stops it — step 7 then refuses, and the way on is a
   fresh run. Only the clone is handed to the engineer.

   **The in-agent guard watches the clone from then on** (`scripts/test-guard-hook.mjs`, which the
   hooks block runs). Before a file operation it refuses a write to an approved test, a new file in
   a protected location — a new test included, in a test folder or beside the code — or a runner
   configuration. The engineer reads, as tool feedback,
   `TEST_GUARD_BLOCKED: <path> is an approved test and cannot be changed. Your session is
   continuing. Tests are owned by the test writer. Continue with production code, or send the
   orchestrator a test-change request.` After
   every command, failed or not, and at the end of each turn, it does two things. It puts every
   approved test back from the approved test commit, on disk and in the index. It moves aside
   every file the declaration refuses, untracked and ignored ones included, reporting
   `TEST_GUARD_RESTORED: …`. Each message counts the attempts so far and repeats the protected
   paths. The engineer is also refused a write outside the clone — the engineer
   definition that carries its hooks included — and a Bash command that does not start with
   `cd "<clone>" &&`: its shell starts in the hub and keeps no directory between commands.
   **Neither ends the session** and neither spends a round: the engineer carries on with the right
   approach. The guard is early feedback, not a boundary: a shell command can change and run a
   test before the check after it puts the test back. Step 7 decides what counts.

### The build

6. **Dispatch the worker on the strongest available model, with fresh context, into the
   engineer's clone** — as the subagent step 5 bound — on the implementation method in
   `.claude/skills/implement-work-item/SKILL.md`, handing it the trunk block, the merged design, the
   commands, the rules and the context documents as in step 1, the chosen Prime rules from
   precondition 9 where there are any, the identifiers of the stubs and test commits,
   the red log from step 2 and the critic's final `test-review` verdict. It turns the tests
   green — its own commits after the baseline, made with
   `node <HUB>/scripts/harness-commit.mjs --repo . -m "<message>"` from the clone, ending its
   turn on a clean tree — and changes no approved path: never writes, edits, deletes,
   renames or re-modes a test, a fixture, a snapshot, a helper or a runner configuration that the
   approved test commit holds, and adds no new file under `TEST_GUARD_PATHS`: only the test writer
   creates or changes a test. Scope is the design's, not the worker's; the rules are
   the repository's, and a rule handed in binds the diff.

   **A test the worker believes is wrong, or a test it finds missing, comes back to you as a
   test-change request — a dispute**: the test, the design text it conflicts with by section and
   line, and the check output. Stop the engineer: do not resume it while the request is open. Send the dispute to the test writer, with the trunk block, who makes the new test revision
   **in the controller**, on top of the baseline; run step 2 on it and dispatch the critic in
   `test-review` on the dispute and the change only, with the same two lines for the hook. Each dispute spends a round of the test
   loop's cap, never of the build's; at that cap, escalate as for the build — the destination is
   the design's testing plan. Before the test writer commits, close the run:
   `node scripts/test-guard.mjs cleanup --state <run> --keep-engineer` keeps the engineer's clone,
   unmarked, with its work for inspection, and retires that engineer. On `APPROVED` the new
   approved test commit **starts a fresh guarded run**: steps 4 and 5 again — `setup` with
   `--test <the new approved test commit>`, a new clone beside the kept one
   (`../<REPO-ID>.engineer-2`, and so on), the preflight, and `dispatch` of a fresh
   engineer, which starts from the new tests. Nothing of the old work is imported or replayed: the
   fresh engineer may read the kept clone, and whatever it carries over is new work in its own
   clone, finalized like any other. The engineer never keeps working against a baseline the tests
   have left.
7. **Finalize every round, before any critic sees it:**
   `node scripts/test-guard.mjs finalize --state <run>`. It fetches the engineer's exact `HEAD`
   into the controller — uncommitted work is noted and is not part of the candidate — and reads
   only its tree, never the engineer's account of it: its commits, their messages and authors, the
   clone's hooks and index are not inputs. It builds **one candidate tree** from it: each approved
   test as in the approved test commit, each new path the declaration refuses taken out — a test
   the engineer wrote included. Each undone change is listed by path.
   A protected change never fails the round by itself: it simply does not count. A changed or
   removed hook configuration does fail it, after being put back — by the finalizer, or by the
   in-agent guard during the round — and the next round goes on as usual. Then it stages that tree
   on the approved test commit and commits it with `harness-commit.mjs` — the guard's own message,
   a `Harness-Check:` trailer per command and the watermark (`.claude/rules/watermark.md`) — which
   asks git to commit only when `scripts/check-staged.mjs` passes the deterministic signal — the
   install, the build, format, lint, types, the suite, coverage against both `PROJECT_COVERAGE_FLOOR` and
   `CHANGED_LINE_FLOOR` (judged by `scripts/check-coverage.mjs`, the command told the trunk commit
   the branch was cut from and the candidate's tree through `HARNESS_COVERAGE_BASE` and
   `HARNESS_COVERAGE_HEAD`), the secret
   scan, migration immutability, **exactly as `checks.env` stated them at setup**, each judged as
   every harness commit's rows are: a command that changes the tree fails. A round that fails them
   leaves no candidate commit, only its tree. It runs them once, in a fresh checkout, the install
   first, because that checkout holds only tracked files: the candidate
   holds no test the engineer wrote under the declaration, so the suite that runs is the approved
   suite against the engineer's code. Before and after every command, failed or not, it reads
   the protected locations and every runner configuration from the disk, tracked, untracked,
   ignored, linked or case-aliased. It puts approved files back and quarantines anything the
   candidate does not hold before the command's tree is judged, and records each event against
   the candidate tree. Build output
   the spoke ignores that only a runner's test convention makes a test — a compiled
   `dist/x.test.js`, a test copied into `build/lib/` — is quarantined the same way, so no runner
   collects it, but it is recorded as generated and noted, never a failure; a test-named file a
   command leaves where the spoke does not ignore it fails the round, and so does a snapshot a
   test run writes, which is a test-change request. Only a round
   that passes keeps its candidate ref, `refs/harness/test-guard/<run>/candidate-<n>`, which
   acceptance requires: **never skip this step**. `verdict` refuses a round that was never
   finalized, one the finalizer failed, a missing or different candidate ref, and a candidate whose
   protected content differs from the approved tests. That refusal depends on this command
   running acceptance through `verdict`; it is a workflow check, not a boundary against a process
   running as the same user. What this proves is that the approved tests are unchanged and that each
   command exited 0 — **not that every approved test ran**: a runner that collects fewer tests
   and still exits 0 is not caught here, so the critic reads the suite's log. The critic does not
   run any of it, because the critic has no shell to run code. A command that fails to start (exit 126 or 127)
   is exit 2 and a stop, never a skipped row; what it left in the protected locations is undone
   and recorded first, like after any other command.

   | Exit | Meaning | Action |
   |---|---|---|
   | 0 | The candidate is finalized | Step 8, with exactly what the finalizer printed |
   | 1 | Refused — nothing to review once protected changes are undone, nothing new since the reviewed candidate, the guard's hook configuration tampered with, a check red on the candidate | **A machine-detected `CHANGES_REQUESTED` that spends a round of the code loop.** No critic is dispatched and nothing is imported; the controller's branch does not move. Hand the engineer the findings as printed, the undone changes with them: code that passed only because a test was weakened fails here, on the approved test |
   | 2 | Cannot verify — no passed preflight; an engineer binding that does not hold (never dispatched, never claimed, another engineer contending for the run); the controller's state disagrees with the run; a command cannot start; a fetch failed | Stop. A binding that never held: fix the engineer's setup — the hub's trust, its hooks, the dispatch — and run the round again. Another engineer contending for the run: stop it, keep this clone (`cleanup --keep-engineer`) and start a fresh run. Otherwise escalate. No round is spent |
   | 3 | Usage | Fix the caller |

   A commit made with `--no-verify` has no authority here, and neither has a changed hook, a branch
   name, a reflog, a rewritten history or the clone's configuration: what enters the trusted
   branch is the one commit the finalizer built from the engineer's tree, however that tree was
   committed. It never lets a protected change through: it undoes it.

   **A repository the story did not name, discovered mid-run**, is the one thing this loop must
   not absorb. Where the worker finds that the change needs code in another repository — a
   caller to update, a contract to widen, a job that reads what this change writes — the answer
   is a **blocking clarification**, routed to the role that owns the backlog, and a stop. Never a
   second checkout, never a change in the other repository, never a widened story. A change that
   needs two repositories is two stories with a dependency; the missing one is cut in
   `/decompose`, not here. Late, but loud.
8. **Dispatch the critic in code mode, on fresh context, on the finalized candidate**, with
   `Mode: code-review` and the method in `.claude/skills/review-artefact/SKILL.md`, handing it what
   `node scripts/test-guard.mjs hand-in --state <run> --round <n>` prints — the exact candidate
   commit and tree, the delta since the candidate it reviewed last (or since the baseline), the
   diff taken from the controller's copy, what the finalizer undid, and the finalizer's check
   results with what they do not prove —
   with the identifiers of the test writer's commits, the red log from step 2, the merged design,
   the coverage report, and the repository's rules exactly as precondition 7 printed them and the
   context documents exactly as precondition 9 printed them, with the chosen Prime rules where
   there are any — the same text the worker received,
   so worker and critic are bound by one set at one commit. The engineer is not dispatched while
   the critic reviews. It emits `### VERDICT: APPROVED` or `### VERDICT: CHANGES REQUESTED`, with
   every finding carrying a severity, a location and a suggested fix. `CRITICAL` and `IMPORTANT`
   block acceptance; `SUGGESTION` does not. Record it against the exact candidate:
   `node scripts/test-guard.mjs verdict --state <run> --round <n> --candidate <commit> --tree <tree> --verdict <APPROVED | CHANGES_REQUESTED>`.
   On `CHANGES_REQUESTED` nothing moves, and the engineer, resumed with SendMessage, carries on in
   its clone; the next round's delta starts from the candidate just reviewed, by its tree. On
   `APPROVED` — every critic's, where the security seat ran too — it is the acceptance, and it
   trusts neither the round record nor the run state for what it can read itself: from the
   controller's objects it checks that the round's candidate ref still names the reviewed commit
   and tree, that the commit is a single commit on the approved test commit, and that its tree
   holds every approved test exactly as approved and no refused path, by the manifest rebuilt from
   the baseline. The one input it trusts is the finalizer's record that the checks passed on that
   commit. Then it **fast-forwards the controller's feature branch to the candidate: the one
   commit the finalizer built and the critic reviewed, and nothing else.**

   **Where the diff touches a surface on the `security-reviewer` trigger list, dispatch that seat
   too** (`.claude/agents/security-reviewer.md`), in the same round, on fresh context, on the same
   `Mode: code-review` and the security lens in the same skill — and blind to the other critic's
   findings, because a reviewer that reads another's verdict confirms it instead of reading the
   diff. The trigger list is on that charter and it is the charter's, not this command's: keeping
   one copy is what stops the two drifting into disagreeing about when security is looked at. Hand
   it the same material plus any scan output you hold. **Both verdicts read `APPROVED` before the
   loop closes**, and the cap is the same three rounds for the round, not three each. No trigger
   matched means no security round — never simulate one, and never let one critic's `APPROVED`
   stand in for the other's. A design that chose Prime guardrails always has a security round: the
   chosen rules are security rules, so that design matches the trigger whatever the diff touches.

   **You decide whether the trigger matched, by reading the diff. No script makes that call**, so
   record the decision either way: which surface matched, or that none did and what you read to
   conclude it. That sentence travels into the pull-request description. Two consequences worth
   stating plainly. A trigger missed is a change nobody security-reviewed, and it looks identical
   to a change that had nothing to review. And the trigger list is generic by design, so on an
   estate where one bullet describes the whole product surface it fires on nearly every diff —
   which is the correct default; narrowing it is a recorded decision, never a quiet reading.

   **The security reviewer reads the code as Prime will.** Where the design chose Prime
   guardrails, hand it the whole guardrail list of precondition 9 beside `chosen.md`, pasted whole,
   and `prime-history.md` where precondition 9 wrote one. Its reply opens with `Guardrail list:
   <n> rules, g1 to g<n>, ending with "<the title of g<n>>"`: compare the count and the title
   with the `listed=` and `last=` lines that `prime.mjs list` printed, and dispatch it again with
   the whole list where one differs. It reads the change against each entry of the history: Prime
   reads the pull request in the same way. It
   applies the Prime row of the skill's `code-review` dimensions: the words of each rule against
   the code, the code that a changed line calls included.

   **A finding that a person must settle is asked before the next round.** A security finding
   that needs a business value, or a choice that a user of the feature sees, is not the worker's
   to decide. Ask the person, in the shape of `.claude/commands/dev-spec.md` § A question to a
   person, and hand the answer to the engineer as a source, with the role answered for. An answer
   that changes what the merged design says is an amendment of the design: `/dev-spec <KEY>`.

   **A security seat runs at design time only where the repository has Prime guardrails**
   (`/dev-spec` step 3). Without them, an authorisation model that is wrong in the design reaches
   this point unexamined. Treat a change to an authorisation model as a design question first, and
   raise it as a clarification rather than as a finding against the worker.
9. **Loop, capped at three rounds, delta-only on resubmission.** A round is one engineer
   submission: refused by the finalizer, or finalized and judged by the critic. The worker submits
   a change list; the critic reviews only the delta plus what it could plausibly have broken.
   Whole-artefact re-review makes the finding count roughly constant across rounds, which is how a
   loop fails to terminate. When the loop closes with every verdict `APPROVED`, run
   `node scripts/escalation.mjs resolve --work-item <KEY> --point dev-sprint.code-review-cap --fact-kind verdict
   --fact-value APPROVED --round <n> --by-seat sprint-orchestrator`. It closes an escalation that
   an earlier code cap opened, and it writes nothing where none is open. At the cap, raise the
   escalation (§ The escalation record, below).
10. **Bring the branch up to the trunk** (§ Bring the branch up to the trunk). Then **run the
   local pre-merge check to its end in the controller**, now at the accepted candidate
   (`.claude/skills/pre-merge-check/SKILL.md`) — the same tree the finalizer checked, so a stack
   row that disagrees with the finalizer's result is a finding about the repository's determinism.
   After a trunk merge, the section's step 5 has already run this check on the merged tree.
   Then **open a non-draft pull request in the repository the story names** from the controller,
   with `--base <SPOKE-TRUNK>` (`gh pr create --base <SPOKE-TRUNK>`, or the host's equivalent). A
   pull request without a base targets the remote's default branch, which in a shared repository
   is the other team's branch, where `story-gate` does not judge it
   — its description filled in from `docs/designs/_TEMPLATE.pull-request.md`, at most forty
   lines, never a restatement of the design: the compact tampering summary
   `node scripts/test-guard.mjs summary --state <run> --pr-line` prints (`Protected-test guard:
   <n> blocked, <n> restored in the clone, <n> undone by the finalizer in <n> of <n> rounds, <n>
   caught during validation`) as written, and the watermark line
   `Generated-by: SHL Agentic Harness` last, with nothing after it
   (`.claude/rules/watermark.md`) — and move to
   `IN REVIEW`. Non-draft is deliberate: a draft pull request is a place work goes to be
   forgotten, and it does not trigger the review machinery. The pull request opens in the spoke,
   not the hub, because that is where the code is; its branch is `feature/<KEY>-<BRANCH-SLUG>`,
   so the spoke's own required check reads the key, clones the hub and runs the gate for this
   work item as this repository. `story-gate` is one of the checks that must be green, and a red
   one is the wrong-repository bug caught at the last fence — the finding is in the design or
   the story, never in the check. The spoke's second required check, `qa-gate`, stays red: no
   validation report names this head yet. That is expected, and it does not hold up
   `IN REVIEW`. Next, after steps 10a and 10b, is `/qa-sprint <KEY>`, which validates the head commit
   before anyone merges.

   **10a. The PR review: review the pull request as one change, and post what holds.** Load `.claude/skills/fix-pr-comments/SKILL.md` § Step 10a: the
   label `harness-reviewing`; the `pr-reviewer` writes `findings.json` — what is wrong on the
   changed lines, each `blocking`, `should-fix` or `nit`; the `pr-verifier` re-traces every finding
   and votes it in `verified-findings.json`; and `scripts/pull-request.mjs post` posts the findings
   that hold as one review of type COMMENT, `[SHL-R<n>]` each, its body the short shape of
   `docs/designs/_TEMPLATE.pr-review.md`; where the spoke's `checks.env` names a `PRIME_BOT`, the run
   then waits for Prime Security's review of the head, at most `PRIME_WAIT_MINUTES`.
   Nothing else of this command talks to the forge. `/pr-review <pr-id>` runs the same review.

   **10b. The PR fixes: verify, sort, ask, then fix, Prime's findings first.** Load the same skill, § Step 10b: the label `harness-fixing`; the harness's own
   unresolved threads, every severity, at most `HARNESS_FIX_LIMIT` a run, and Prime's findings that
   Prime rates at `PRIME_FIX_SEVERITY` or above, at most
   `PRIME_FIX_LIMIT`, in at most `PRIME_MAX_ROUNDS` rounds. The `pr-verifier` votes on each Prime
   finding. One engineer pass then gives every item its ending, and one second reader reads each
   ending that is not a fix. The runner answers every question in one sitting, before any fix.
   Prime's findings are fixed first, in groups: one commit for each group, and one push for all of
   them, so that Prime's next review reads the fixes of its own findings. The harness's comments
   follow, one commit and one push each. For each fix, the test writer decides whether
   a test comes first and writes it, then a fresh engineer in a fresh guarded run whose candidate
   carries the subject
   `fix(<KEY>): resolve <ref> — <title>`, `<ref>` `SHL-R<n>`, `PRIME-C<n>`, or each `PRIME-C<n>` of a group joined by a comma and a space, the critic on both and the security reviewer where its
   trigger list matches; then a fast-forward push, a reply, and the thread resolved. Where the run
   settled a Prime finding and the runner agrees, it ends with an amendment of the merged design
   that records the result for the next stories, as a pull request in the hub. A thread of
   Prime that repeats an open finding is resolved with a reply. A finding that Prime's later review
   leaves out stays open until the run answers it. One summary
   comment ends the run, and the label `harness-done`, with `harness-needs-person` beside it where
   the summary lists anything for a person. What is left for a person after the sitting goes into
   one escalation.

   To the person these two are the **PR review** and the **PR fixes**, never step numbers or seat
   names. This command is the go-ahead for both: the skill's § What the person sees has the one
   question to ask where the session's own rules still require a confirmation.
11. **Clean up the guard's temporary state, whatever the outcome**:
   `node scripts/test-guard.mjs cleanup --state <run>` prints the summary line once more, then
   removes the private refs, the finalizer's checkouts, the run directory — manifest, event log,
   quarantined files, round records and logs — and the engineer's clone, whose accepted work is
   now in the controller, and retires the run's engineer. On an escalation or a test dispute add
   `--keep-engineer`: the clone is the work in its last state, kept unmarked so the in-agent guard
   stops applying to it, and `/qa-sprint`'s teardown of `.worktrees/<KEY>/` removes it later with
   the rest. Nothing of the guard is kept in the hub's tree; its git directory keeps only the
   retired engineers' IDs for the session. The summary line is the only lasting trace.

## Bring the branch up to the trunk

Other stories merge into `<SPOKE-TRUNK>` while this one is built. A story whose branch does not
hold the trunk is built and tested against old code. A story that depends on another story in the
same repository waits at `qa-gate` until its branch holds that story's code
(`check-dependencies.mjs --step code`, rule 6). So before the pull request opens, and before each
push of a fix round, this command merges the trunk into the branch.

It never merges with a strategy option such as `-X theirs` or `-X ours`, which drop one side of
a conflict with no error. It never rebases the branch, and it never resolves a conflict. All
commands run in `.worktrees/<KEY>/hub`.

1. **Read the trunk again.** Run precondition 6 again, and save its output as precondition 6
   says. The commit it prints is `<TRUNK-NOW>`. The guard judges a trunk merge against that read,
   and a trunk round freezes that `checks.env`.
2. **Stop here if the branch holds it.** Run `git -C ../<REPO-ID> fetch origin <SPOKE-TRUNK>`.
   When `git -C ../<REPO-ID> merge-base --is-ancestor <TRUNK-NOW> HEAD` exits 0, the branch is up
   to date. Record `trunk: <SPOKE-TRUNK> at <12 hex of TRUNK-NOW>, up to date` for the body, and
   go on to the next step of the run.
3. **Test the merge without a change to the checkout.** Run
   `git -C ../<REPO-ID> merge-tree --write-tree --name-only HEAD <TRUNK-NOW>`. Exit 0: go to 4.
   Exit 1 is a conflict: go to 6. Any other exit is exit 2 for this command. The command needs
   git 2.38 or later.
4. **Merge, and commit git's result.**

   ```bash
   git -C ../<REPO-ID> merge --no-ff --no-commit <TRUNK-NOW>
   node scripts/harness-commit.mjs --repo ../<REPO-ID> --trunk-merge <TRUNK-NOW> \
     -m "chore(<KEY>): merge the trunk at <12 hex of TRUNK-NOW>"
   ```

   The helper commits only git's own merge result, and it runs the secret scan on it. It does not
   run format, lint or type-check, because step 5 runs every command on the merged tree. Exit 1
   or 2: run `git -C ../<REPO-ID> merge --abort`, report what the helper printed, and stop. A
   secret that the scan finds is a stop for the security role, as the secret-scan gate says.
   Record `trunk: <SPOKE-TRUNK> at <12 hex>, merged as <12 hex of the merge commit>` for the body.
5. **Prove the merged tree.** Run step 10's pre-merge check at the merge commit. When every row
   passes, go on to the next step of the run. When a stack row fails, the trunk changed something
   that the story's code needs. Fix it in a **trunk round**, through the same guard:
   1. Run step 4 with `--test <the merge commit>`, with the `checks.env` that step 1 read.
   2. Run steps 5 to 9 with the failed rows and their output as the change list. The delta starts
      at the merge commit. Judge the security trigger on that delta. The round has the code loop's
      cap of three, and its cap raises dev-sprint.code-review-cap.
   3. Run step 10's pre-merge check again, at the accepted candidate.

   Bring the branch up to the trunk once in each run. When the trunk moves again after this
   section, the pull request shows it, and a person updates the branch.
6. **On a conflict, stop, and show the person both sides.** Run nothing that changes the
   checkout. Put these in the closing report:
   - the conflicted paths that step 3 printed;
   - `<MERGE-BASE>`, from `git -C ../<REPO-ID> merge-base HEAD <TRUNK-NOW>`;
   - for each path, the story's side, `git -C ../<REPO-ID> diff <MERGE-BASE> HEAD -- <path>`, and
     the trunk's side, `git -C ../<REPO-ID> diff <MERGE-BASE> <TRUNK-NOW> -- <path>`;
   - for each path, the trunk commits that changed it,
     `git -C ../<REPO-ID> log --oneline <MERGE-BASE>..<TRUNK-NOW> -- <path>`.

   Raise point dev-sprint.trunk-conflict (§ Other escalations). Run step 11 to clean up the guard.
   Then tell the person the next steps:
   1. In `.worktrees/<KEY>/<REPO-ID>`, run `git merge <TRUNK-NOW>`, resolve each conflict, and
      commit it.
   2. Leave each protected test as one of the two sides has it. The guard refuses a merge that
      rewrites a test, because a test change is the test writer's.
   3. Run `/dev-sprint <KEY>` again. That run starts at precondition 1, comes to this section,
      and proves the person's merge in step 5.

## What it does — a fix round

`/qa-sprint` validated the pull request's head commit, and at least one criterion failed. It wrote
the failing rows to `.worktrees/<KEY>/<KEY>.qa-findings.md`, moved the item back to `IN PROGRESS`,
and wrote nothing into the hub. This run fixes those rows **on the same branch**, through the same
two loops and the same guard as the first build, and pushes one more commit onto the open pull
request. It never opens a second pull request, and it never raises a defect item.

1. **Run preconditions 1 and 5 to 9 again.** The design is unchanged. A finding that needs the
   design changed is a clarification, never a fix.
2. **Check the controller.** It is on the branch and clean. After a fetch, its `HEAD` is the pull
   request's head commit and the commit the findings file names. Anything else means someone
   pushed during the round. Stop and report it.
3. **Count the fix rounds, and stop at the cap.** The count is the number of accepted candidates
   on `<BASE-COMMIT>..HEAD` along the first parent, minus one. Each guarded run accepts one, so git
   holds the count. Do not count the candidate of a trunk round. Its first parent is a trunk merge
   with the subject `chore(<KEY>): merge the trunk at <12 hex>`. At the cap (`.claude/rules/worker-critic.md` § Revision caps), escalate as the
   code loop's cap does.
4. **Send each `Fix: test` row to the test writer.** It makes a new `test(<KEY>): …` commit on the
   controller's `HEAD`. Run step 2's red at that commit, and dispatch the critic in
   `test-review`, delta-only, charged to the test loop's cap. The engineer never changes a test.
5. **Freeze the baseline at the current head.** Run step 4 with `--test <the controller's HEAD>`.
   The guard accepts the accepted candidate and any merge of the spoke's trunk on the chain, and
   measures coverage from the newest trunk commit merged in.
6. **Run steps 5 to 9** with the `Fix: code` rows, and any new tests, as the change list. The delta
   starts from the commit QA read, because that commit is the baseline. Judge the security trigger
   on that delta.
7. **Bring the branch up to the trunk, run the pre-merge check, and push.** Run § Bring the
   branch up to the trunk, then step 10's pre-merge check in the controller, then
   `git push origin <branch>`, never with force. A rejected push means stop. Rewrite the pull
   request's description: the test section, the guard summary, the coverage line, and one line
   `Fix round <n> for the QA findings at <12 hex>`. It still ends with the watermark. When every
   check but `qa-gate` is green on the new head commit, move `IN PROGRESS → IN REVIEW`, and say:
   run `/qa-sprint <KEY>`.
8. **Clean up**, as step 11 does. Delete the findings file: the new head commit makes it out of
   date.

### The escalation record

A cap raises one escalation: point dev-sprint.test-review-cap for the test loop, dev-sprint.test-dispute for a test dispute and dev-sprint.code-review-cap for the
code loop. This command's orchestrator seat calls the one writer, `scripts/escalation.mjs`, which
its charter lists. The seat never types a row in `docs/designs/CLAR-log.md` § Escalation record: that
table is a view that `escalation.mjs print` writes.

    node scripts/escalation.mjs raise --point dev-sprint.code-review-cap --slug <SLUG> --work-item <KEY> \
      --repository <REPO-ID> --runner <forge login> --question "<the one question>" \
      --parked-ref <the story branch> --parked-commit <12 hex of the last reviewed commit> \
      --design docs/designs/<KEY>.lld.md --tests-commit <the approved test commit, 12 hex> \
      --iteration-run <the loop's run id> --findings-file <the deduplicated findings from every round> \
      --by-seat sprint-orchestrator

The script opens the escalation's `[shl-harness]` issue in the hub, with the `raised` line, one
`notified` line and the findings as the issue's artefacts. The engineering lead is the next
person told. Print what the script prints first in the closing report. Exit 2 means the line did
not reach the record: say so first, and carry the question and the findings in the report itself.
A security `CRITICAL` still open at the cap also raises point dev-sprint.security-critical with the same call and no
`--findings-file`, because an incident never carries findings.

### Other escalations

These stops raise an escalation as a cap does, and then stop. Each is one call of
`node scripts/escalation.mjs raise --point <ID> --slug <SLUG> [--work-item <KEY>] --runner <forge login> --question "<the one question>" --by-seat sprint-orchestrator`
with the options in the last column. Print what the script prints first in the closing report. Exit
2 means the line did not reach the record: say so first, and carry the question in the report.
The sweep tells the people named in `governance/escalation-points.json` and asks again after the
wait of the path. A question in the session (dev-sprint.docker, dev-sprint.not-merged) writes nothing. A merge that waits at human gate 2 (dev-sprint.code-merge) is not raised here: the sweep raises it, once a hub names a way to place a spoke's pull request.

| Point | When | Path | Options |
|---|---|---|---|
| dev-sprint.pickup-gate | the pickup gate exits 2 | check cannot run | none. Never retry in a loop |
| dev-sprint.checks-env | `checks.env` is unreadable, or a needed key is missing, empty or `UNRESOLVED` | check cannot run | `--repository <REPO-ID>` |
| dev-sprint.spoke-rules | the repository's rules set is malformed | check cannot run | `--repository <REPO-ID>` |
| dev-sprint.context-pin | a context pin fault on the merged design | decision owed | `--design docs/designs/<KEY>.lld.md` |
| dev-sprint.commit-checks | the commit checks exit 2 | check cannot run | `--repository <REPO-ID>` |
| dev-sprint.guard-setup | the guard's setup refuses | check cannot run | `--repository <REPO-ID>` |
| dev-sprint.second-repository | a second repository is found mid-run | decision owed | `--design docs/designs/<KEY>.lld.md` |
| dev-sprint.authorisation-change | a change to an authorisation model | decision owed | `--route-first "<role in Routed to>"` |
| dev-sprint.trunk-conflict | the trunk cannot merge into the branch without a conflict (§ Bring the branch up to the trunk, step 6) | decision owed | `--repository <REPO-ID> --parked-ref <the story branch> --parked-commit <12 hex of HEAD>` |

## Gates it enforces

| Gate | Behaviour on failure |
|---|---|
| Pickup gate exit 0 before any code is generated, run with `HARNESS_REPO` set to the story's repository | Refuse to start. On exit 2, escalate and do not retry. A gate 1 failure reading "is asking" is a design for another repository: fix the story or the design, never the environment variable |
| The story's repository is in the list | Refuse to start and name the id. `/add-repo` comes first; nothing is built for a repository the hub does not know |
| `checks.env` read from the repository's own trunk, every needed key a command or `none` | Refuse to start. Unreadable, missing, or a needed key `UNRESOLVED`, empty or absent is exit 2 for this command: stop and escalate, never skip the step |
| The repository's rules read at the design's `Rules:` commit, the set well formed, drift against the trunk reported | A malformed set (exit 1) is a stop and an escalation to the repository's tech lead; `none` and `NOT CONFIGURED` are reported in the body, never a stop; a moved commit is a **rules drift** line in the body with both commits, never a silent re-read |
| The design's context documents read at their pins, drift against the trunk reported | A pin no commit on the trunk ever held, a bare-id line, or a missing or doubled line (exit 1) is a stop before any seat is dispatched, fixed by re-running `read-context.mjs` for the design's paths and amending the merged design by pull request with a human, with a fresh review — never by `/dev-spec`, which refuses a merged design; a moved document is a **context drift** line in the body with both hashes, or `removed`, never a silent re-read |
| A second repository discovered mid-run | Stop with a blocking clarification, handed back as a row for the orchestrator to write into `docs/designs/<KEY>.clar-log.md`. Never a second checkout, never a change outside the repository the story names, never a widened scope |
| Test-first — the test writer's stubs and test commits before any build commit, every new test red at the test commit on its own run — a `Holds already:` row's green — and `test-review` `APPROVED` before the build worker is dispatched | Do not dispatch the build. A test written after the code it covers has been written to pass, not to verify, and one nobody reviewed before the build is a target the builder set for itself |
| The test-quality scan at every `test-review` launch | The hook runs Semgrep CE over the tests the range changes and adds the findings to the critic's prompt; a violation keeps the verdict at `CHANGES REQUESTED`, and one combined reply goes to the test writer. A scan that cannot run is a warning to the user and a note to the critic, never a stop. The spoke's `story-gate` runs the same scan on the pull request and is the backstop: red on a violation, red where it cannot run |
| The protected-path contract | `TEST_GUARD_PATHS` missing, empty or `UNRESOLVED` is exit 2; `none`, a malformed pattern, a stubs commit that adds, deletes or retypes a protected path, a test commit touching anything else, a tracked runner configuration, conventional test or runner-configuring `package.json`, `pyproject.toml` or `setup.cfg` the declaration leaves uncovered, or a test command that can change without a protected file changing is a setup refusal before any engineer is dispatched (`scripts/test-guard.mjs setup`). An alias in a file that also holds dependencies is refused with the limitation stated, never protected by freezing the file |
| The tests are the test writer's | **Refused in the agent, restored after every command, and undone by the finalizer on every round, before any critic**: an edit, deletion, rename, replacement or mode change of an approved entry, a new path under `TEST_GUARD_PATHS` — a new test included — a new runner configuration or a new file a supported runner collects as a test anywhere, or runner configuration added to a free `package.json`, `pyproject.toml` or `setup.cfg`, never reaches the candidate. The refusal and the restoration block one operation and leave the session running; the finalizer's undoing is counted and listed, never a round lost by itself. A wrong or missing test is a test-change request: the engineer stops, the request goes back through the test loop, and its new approved test commit is a fresh run. A test change the declaration does not cover is still a `CRITICAL` finding in `code-review` |
| The critic reviews what the finalizer checked | The critic is dispatched only on a finalized candidate, by its exact commit and tree; a verdict naming another commit or tree is refused, and `APPROVED` moves nothing unless the candidate ref of a passed round still names what was reviewed |
| Only the validated, approved candidate reaches the branch | The controller's branch moves only by fast-forward to the one candidate commit the finalizer built and passed and every critic approved, after acceptance re-reads its tree, its parent and the approved tests in it from the controller. Never the engineer's commits, a squash, a merge commit or a repaired history; never a candidate from the engineer's branch name, index or hooks. The one other commit is a trunk merge: git's own merge of a trunk commit, which `harness-commit.mjs --trunk-merge` checks, or a person's merge that the guard judges |
| The branch holds the trunk before the pull request opens, and before each push of a fix round | § Bring the branch up to the trunk. A clean merge is committed, and the merged tree passes the pre-merge check or a trunk round. A conflict is a stop, both sides shown to a person. Never a merge strategy option, a rebase or a resolution by this command |
| Cap on the test loop, disputes included | On cap: raise the escalation with `escalation.mjs raise --point dev-sprint.test-review-cap` (dev-sprint.test-dispute for a dispute), leave the branch at its last reviewed test commit, stop. The question goes to the design's testing plan |
| A re-run after a cap finds something changed upstream | Refuse, and print what `escalation.mjs resume` printed. A cap is never raised |
| Coverage, in continuous integration | Refuse to open the pull request below either floor the repository's `checks.env` records as `PROJECT_COVERAGE_FLOOR` and `CHANGED_LINE_FLOOR` — that file is the single home of both numbers for that repository, and there are two: whole-project coverage must not fall below its floor, and changed lines meet theirs. Both are blocking checks, never review comments: the repository's `story-gate` check runs `scripts/check-coverage.mjs` on the pull request against the floors on its trunk. The pull-request body carries the record line that script and the finalizer print — both figures, both floors and the `checks.env` blob they came from — so the pass can be read later against the bar in force. `UNRESOLVED` in the command or either floor stops the sprint at setup, and leaves the `story-gate` check red: never read as a pass |
| Format, lint and types pass on what ships | The test writer's commits: `harness-commit.mjs` refuses them (step 1), exit 1 back to the test writer, exit 2 a stop. The engineer's work: the finalizer refuses the round on the candidate (step 7), a round of the code loop. No commit that ships skips both |
| Types clean, lint clean, both suites green | Refuse to open the pull request |
| Secret scan | Refuse. The repository's `SECRET_SCAN_COMMAND` over every commit of the branch, as `.claude/skills/pre-merge-check/SKILL.md` runs it; a secret found in any commit is rotated, never only deleted, because the commit stays in the history. Every commit the loop makes went through `scripts/harness-commit.mjs`, which scanned it first |
| Migration immutability | Refuse. An already-merged changeset that was edited is reverted and a new changeset added — never edited to fit |
| Where the trigger list matched, both critics' verdicts read `APPROVED` | Loop, or escalate at cap. One `APPROVED` and one `CHANGES REQUESTED` is a blocked round, not a majority |
| Three-round cap on the code loop | On cap: raise the escalation with `escalation.mjs raise --point dev-sprint.code-review-cap` (§ The escalation record), flag the work item, leave the work in its last reviewed state — the controller's branch at the baseline, the engineer's clone kept (`cleanup --keep-engineer`) with the work the escalation names by its last round's engineer `HEAD` — stop. A finalizer refusal counts as a round. A security `CRITICAL` still open at the cap raises a second escalation, point dev-sprint.security-critical, to the security role on call as well |
| The pull request is opened non-draft | No draft pull requests |
| Cap on one pull-request comment, as `.claude/rules/worker-critic.md` § Revision caps sets it for its test and its code | Nothing of the comment lands — its unpushed test commit is dropped — the thread is answered "could not fix" and left open, and the next comment goes on. A cap on one comment never stops the phase |
| The forge, one way | Only `scripts/pull-request.mjs`, and only reviews of type COMMENT: never an approval, a change request, a merge, a suggestion block or an edit of the description |
| A fix round starts from the pull request's head commit, and the findings file names that commit | Stop and report. An out-of-date findings file means run `/qa-sprint` again |
| The QA fix-round cap (`.claude/rules/worker-critic.md` § Revision caps) | On cap: escalate to the engineering lead, as the code loop's cap does. Repeated QA failure on one design is a design ambiguity |

Three rounds against the same code is not a coding problem — it is a design ambiguity presenting
as churn. Escalating sends it back to the design, which is the correct answer, and raising the cap
makes it both worse and more expensive.

## Output

- On the feature branch, in the controller: the test writer's stubs and test commits, then the
  build worker's implementation commits after them, fast-forwarded exactly as the finalizer
  passed and the critic approved them.
- A **non-draft** pull request **in the repository the story names**, with the full check chain
  green — its own `checks.env` commands, and its required `story-gate` check, coverage against
  both floors included — and the work item at `IN REVIEW`. Its description is
  `docs/designs/_TEMPLATE.pull-request.md` filled in, at most forty lines: what changes and why;
  the hub commit the design was read at and the repository commit `checks.env` was read at; the
  trunk line that § Bring the branch up to the trunk recorded, which names the trunk commit the
  branch holds; the
  rules line — the design's `Rules:` value, and `rules drift` with both commits where the trunk's
  differs, or `rules: none declared` / `rules: NOT CONFIGURED` as the commands file has it — and
  the guardrails line — `guardrails: off`, `none`, `not checked`, `current`, or `changed` and
  `missing` with each rule's title, as precondition 9's Prime read printed it — and
  the context line — `context: none`, `context: current` when every `Pin:` line precondition 9
  printed says `current`, or `context drift` with each moved entry and both hashes, or `removed`;
  how many acceptance criteria have a named test, against the design's map, which the
  description points to and never copies; the stubs and test commits, the red count and the
  final `test-review` verdict; the candidate, each critic's final verdict and the security
  decision; one line of check results, `NOT CONFIGURED` named; the coverage line the
  finalizer's last round printed,
  `project <n>% (floor <n>) · changed <n>% (floor <n>) · floors from checks.env@<12 hex>`; and,
  one line each, only what needs a person.
- The compact tampering summary in the pull-request description, one line:
  `Protected-test guard: <n> blocked, <n> restored in the clone, <n> undone by the finalizer in
  <n> of <n> rounds, <n> caught during validation` — writes the in-agent guard refused, changes it
  put back after a command, protected changes the finalizer undid in commits (each counted once),
  and changes caught in its own checkout. The guard's run directory — baseline state,
  manifest, event log, quarantined files, round records and logs — and its refs and checkouts
  are removed at the end, on success and on failure; nothing of it lands in the hub.
- One iteration record per worker-critic round, in both loops of the build — never for a pull-request
  comment's rounds, which keep none — **written by the orchestrator** to
  `/tmp/<KEY>-<mode>-round-<N>.json` beside the round's markdown, `artefact_type` `tests` for a
  `test-review` round and `code` for a `code-review` one, against
  `governance/iteration-record.schema.json`. The system temporary directory, never the
  worktree: these are working records, not repository artefacts. `quality` is the share of the
  design's acceptance criteria the critic's own coverage table marked `YES` in that round —
  derived from the table, never estimated, and `0` where the critic returned no table. A code round
  the finalizer refused is recorded as what it is — `verdict` `CHANGES_REQUESTED`,
  `verdict_source` `finalizer`, `signal_source` `machine`, no `critic`, `quality` `0`, and the
  `finalizer` block from the round's record (`iteration_record` in the run directory's
  `rounds/round-<n>.json`, with its counts of approved tests restored and refused paths removed)
  — never as a critic's verdict; a critic's code round carries `verdict_source` `critic` and the
  same block for the candidate it reviewed. This is
  the input to measuring recovery rate later. Nothing in a hub reads it yet; the
  library's own evaluation suite (`evals/` in the harness repository, run on every release)
  writes records in the same shape and grades the critic seats with them.
- One review of type COMMENT on the pull request, its comments
  `[SHL-R<n>]` and its body `docs/designs/_TEMPLATE.pr-review.md`; on the branch after the build, one
  `fix(<KEY>): resolve <ref> — <title>` commit per fixed comment and per group of Prime findings, with its
  `test(<KEY>): <ref> …` commit before it where it needed one; a reply in every thread worked,
  resolved when done; one summary comment per run; the label `harness-done`; and the label
  `harness-needs-person` where the summary lists anything for a person.
- On a fix round: one more accepted candidate on the same branch, pushed to the open pull request,
  its description rewritten with the fix-round line, the findings file deleted, and the work item
  at `IN REVIEW`.
- On cap: an escalation raised with `escalation.mjs raise`, carrying the branch unmodified, the
  deduplicated findings from all three rounds, the specific question the human must answer, and
  the `[shl-harness]` issue that records them.
- On a blocking clarification raised during implementation: the row the worker handed back as
  text, written by the orchestrator into `docs/designs/<KEY>.clar-log.md`, beside the escalation
  it raises. The worker holds its clone of the code and
  never the hub, so the row crosses through the orchestrator; the merged design's §9 cannot take
  it, and the pre-merge check reads that log for exactly this row.

## Stopping condition

First invocation: the pull request is open, non-draft, with every check but `qa-gate` green — or
the cap was hit and it escalated — and steps 10a and 10b ended at `harness-done` or stopped and
said why. A later run: its comments worked and its summary posted. A fix round: the new head
commit is pushed with every check but `qa-gate` green, and the work item is at `IN REVIEW` — or a
cap was hit and it escalated. If the query reported `MERGED`, the stopping condition is
"reported, no move".

Note what *done* means here, because it is what makes an unattended run defensible at all: a
pull request ready for QA, with every check but `qa-gate` green. A machine-checkable stopping condition.
Without one, "autonomous" means "runs until it decides it is finished", and premature completion
is a named failure mode.

## Never

- Never start below gate exit 0, and never bypass, weaken or flag around the gate. Never run it
  without `HARNESS_REPO`, and never change that value to make a design fit.
- Never run a command from anywhere but the repository's own `checks.env`, read from its trunk.
  Not the hub's `AGENTS.md`, not a copy, not a command that "usually works".
- Never cut the code checkout from a remembered trunk, a local ref or a commit other than the one
  precondition 6 read. Never clone over an existing checkout, and never resume a
  `feature/<KEY>-*` branch on the repository's remote that this run did not make.
- Never take the repository from the current folder, the argument or a configured remote. The
  story's `Repository:` line, looked up in the list, is the only source.
- Never hand a seat a rule the script did not print, and never let a seat open the rules folder
  itself. The rules reach worker and critic as one text at one commit, or not at all; a malformed
  set is the repository's to fix, never this command's to read around.
- Never hand a seat a context document the script did not print, and never let a seat open a
  context document itself, on the trunk or anywhere else. The documents reach the seats as one
  read at the pinned bytes, or not at all; a pin nobody merged is the design's to fix, never this
  command's to read around.
- Never touch a second repository, or cut a second checkout, because the change turned out to
  need one. Stop with a clarification; the missing story is `/decompose`'s to cut.
- Never open the pull request in the hub. Code lands in the repository the story names.
- Never merge the trunk with a strategy option (`-X theirs`, `-X ours`), never rebase the branch,
  and never resolve a conflict. A conflict is a stop, with both sides shown to a person.
- Never retry exit 2 in a loop. That converts an infrastructure problem into a silent stall.
- Never merge either pull request. Both merges are human, and this is the command that would
  most plausibly be argued into doing it.
- Never open a draft pull request, and never open one below either coverage floor.
- Never dispatch the build worker before the test writer's commits read `APPROVED` in
  `test-review`, and never let one seat write both the tests and the code.
- Never let the build worker create, write or edit a test, or amend, rebase or squash the test
  writer's commits. A wrong or missing test is a test-change request, and the engineer stops.
- Never dispatch the engineer into the controller, hand it the run directory, or read the
  baseline back from its branch, `HEAD`, index, working tree or reflog.
- Never dispatch the engineer before the preflight passes. Never start it as a separate `claude`
  process, or as a subagent without `test-guard.mjs dispatch`, and never start a second one in a
  run: a different engineer is a fresh run. Never run it under another agent runtime: the guard
  supports Claude Code only. Never treat a warning about hooks as enough.
- Never carry a run across a test dispute: the new approved test commit is a fresh run, and the
  old work is kept for inspection, never imported or replayed by the guard.
- Never skip `finalize`, send a critic a candidate the finalizer did not pass, or accept other
  than through `verdict`, and never import anything but the candidate the critic reviewed. A protected change is undone and listed, never carried and never
  hidden.
- Never end the engineer's session, or spend a round, because the in-agent guard refused or
  restored something; the engineer reads the message and carries on.
- Never read `--no-verify`, a hook, a branch name or the engineer's configuration as acceptance.
- Never claim the separate clone, the in-agent guard, or the guard's refs and records make a test
  file unwritable or tamper-proof. It is workflow isolation; the finalizer and the acceptance are
  the control, and a process running as the same user can still write where they read.
- Never keep the guard's run directory, event log, quarantine, refs or logs after the run, or
  add a per-attempt record to the hub; the summary line is the record.
- Never let the test writer write behaviour. A stub is a signature and one "not implemented".
- Never edit an acceptance criterion, renumber one, or change the design to match the code.
- Never edit an already-merged migration changeset.
- Never proceed past round three of the build loop, or past a pull-request comment's cap.
- Never fix two pull-request comments in one guard run or with one engineer: one run, one fresh
  engineer and one fix commit per comment.
- Never let the critic edit the diff. A critic that can change what was approved creates a
  post-approval mutation window, and the approval record then describes a state that no longer
  exists.
- Never move the item past `IN REVIEW`. QA's moves are `/qa-sprint`'s.
- Never open a second pull request or raise a defect item for a QA finding. A fix round pushes to
  the same branch.
- Never force-push the branch. QA validated a commit on it, and the history is the record.
- Never deploy. Under the default autonomy level nothing deploys unattended and deploy is
  advisory.

---
name: write-tests
description: The test writer's method for one work item against its merged design — which symbols to stub and how, one test per testing-plan row by its exact name, the red that proves each test binds, commit order, the dispute from the build, the revision protocol and the cap.
---

<!-- Part of the harness asset library c6f3b4427d58f7c3 (see VERSION.json) · 2026-09-30 -->

# Skill — write-tests

Loaded by the `test-writer` charter: one work item, one code checkout, one merged design,
taken to a stubs commit and a test commit the critic approves in `test-review` mode, before
any behaviour is written. `/dev-sprint` owns the procedure, the state moves and the round
count; `.claude/rules/worker-critic.md` owns the loop; the charter owns the contract; this
file owns how the work is done well. Where this file and the command disagree, the command
wins — it is the procedure.

**Why the tests are a seat of their own.** A worker that writes the test and the code in one
session decides, alone, what "done" means and then meets it; the red it saw lives only in its
own context and nobody else can check it. Split across two seats, the tests are a fixed target
set before any behaviour exists, their red is a fact on a commit the orchestrator can run, and
the critic reviews them before anything is built on them — the cheapest point to find a weak
one. The rhythm changes with it: every test is written first, then every body, rather than one
test and its code at a time. That is still test-first, and it is the point of the split.

## Preconditions — verified, never believed

| Precondition | What establishes it | If it is not true |
|---|---|---|
| The approved design is merged on the trunk | `/dev-sprint` read it from the hub's trunk and handed it in as text, with the hub commit | Stop. A branch-local design is a draft |
| The pickup gate exited zero for this work item | `/dev-sprint` ran it this invocation | Stop and report what you were given |
| This session runs in the code checkout | `.worktrees/<KEY>/<REPO-ID>`, the repository the story names, on the feature branch, with no commit of this work item on it yet — or, for one pull-request comment, the controller at the branch's tip (§ A pull-request comment) | Stop and ask. Never the hub checkout, never the shared one |

## Bootstrap — read the design first, then the tree

| Read | Why it is on the list |
|---|---|
| The trunk block, as `/dev-sprint` handed it in | It names the repository's harness trunk and says whether the trunk is declared. Compare and diff against that trunk only, and obey `.claude/rules/estate.md` §6. No trunk block: stop and hand back |
| The merged design, in full | §4 is what the tests prove; §5 names each test, its level and what it asserts; §3.1 and §3.2 name the symbols you may stub; §3.4 names the failure paths and their error types; §6 names the contracts you must not reshape |
| The repository's rules and commands, as `/dev-sprint` handed them in | The rules bind your tests as they bind code — naming, layout, fixture conventions. `TEST_COMMAND` and the build and type commands are the ones you run; invented commands produce invented evidence |
| The design's context documents, as `/dev-sprint` precondition 9 printed them, at the bytes the design pinned | The contracts, decisions and standards the design was written against bind your tests as the design does — a contract's field names, a decision's constraint. Each arrives with a `Pin:` and a `Cite:`; you do not open a document yourself. A standard rule an `Overridden:` line names does not bind: the repository rule the line names binds in its place. Where the hand-in says `Context: none`, none binds |
| The existing tests beside the code the design names | Match their layout, runner and fixture style. A test that ignores its neighbours is a finding |
| `docs/designs/<KEY>.handoff.md`, where an earlier turn exists | The only record of what the last turn actually did |

## The stubs commit — signatures, and nothing that behaves

**Stub only what is new, only what the design names, and only as far as the tests need to
run.** In a compiled language a test that calls a missing function does not build, and in Go
one missing symbol stops every test in its package; in an interpreted one it fails on "not
found". Neither is a red that proves anything. A stub makes the test reach the code under test
and fail there.

- **What may be stubbed:** each new class, interface, function, method or field that §3.1 or
  §3.2 names. A test that needs anything else is a clarification, never an invented symbol.
- **What a body holds:** one throw of the language's standard "not implemented" error. No
  branch, no computed value, no call, no default beyond the language's zero value. For the
  stacks met so far:

  | Language | Body |
  |---|---|
  | Go | `panic("not implemented")` |
  | Java | `throw new UnsupportedOperationException("not implemented");` |
  | Python | `raise NotImplementedError` |
  | PHP | `throw new \LogicException('not implemented');` |

  Any other language: its own standard error for the same thing.
- **Declarations are not behaviour.** A type, a struct's fields, an enum's members, a
  method's parameter and return types — write them whole, as §3.2 states them, because the
  tests have to compile against them.
- **A changed signature changes with all its callers, in the stubs commit.** Where §3.2
  changes the signature of an existing function, method or interface, write the new
  declaration as §3.2 states it. Keep the existing body, and leave a new parameter unused. Where
  the existing body does not compile against the new signature, replace it with the "not
  implemented" throw, and give §3.2 as the reason for each test that is then red. Update every
  caller and every implementation in the same commit, because the code does not compile
  otherwise. This includes the existing protected tests and test doubles: change only the call
  or the declaration there, and nothing else in the file. A test that pins new behaviour
  belongs in the test commit.
- **Never a stub for a contract or a generated type.** Generated types are regenerated from
  their declared source; a contract shape changes by renegotiation, never inside this item.
- **Nothing new and no changed signature, no commit.** A change that only alters the bodies of
  existing code needs no stubs. Skip the commit rather than making an empty one.

The build and the type check pass at the stubs commit, and the existing suite stays green: a
stub adds, it never changes what already runs. The one exception is a test that reaches a body
replaced for a changed signature.

**A stub never sits on a protected path.** `TEST_GUARD_PATHS` in the repository's commands names
the paths whose approved contents are the tests — in test folders or beside the code — with their
fixtures, snapshots, helpers and configuration. Once the critic approves your commits,
`/dev-sprint` freezes every tracked entry it covers, and you are the only seat that adds or
changes a test there; the engineer may change everything else: the stubs above all, since their
bodies are its work. So the stubs commit adds and deletes no path the declaration covers, and the
test commit changes no path it misses. The stubs commit modifies an existing protected file only
to follow a changed signature, as above. Setup allows that modification, and the critic refuses
any other change there. An overlap is
not settled by narrowing the declaration: setup refuses it, and the fix is to move the stub or the
test file.

## The test commit — one test per testing-plan row

Per row of §5, in its order:

1. **Write the test the plan names — that name, at that level.** The critic derives the
   criterion-to-test map from the plan and the diff; a renamed test is an uncovered criterion.
2. **Assert what the `Asserts` column says, and nothing weaker.** Ask of each assertion: if the
   behaviour were inverted, would this fail? If not, it tests that the code ran.
3. **Go through the public interface §3.2 names**, not the internals behind it. A test tied to
   a private helper leaves the builder no room and breaks on a harmless change.
4. **An error test names the exact error type** §3.4 or the criterion states — for example
   `pytest.raises(ValueError)`, never a check for any exception. A stub's "not implemented" must
   not satisfy it.
5. **Test data is made up.** No production record, no candidate data of any kind, in a fixture,
   a snapshot or a seed. Where provenance is uncertain, it does not go in.
6. **Change an existing test only where the design changes the behaviour it pins.** Record the
   criterion in the change list; an unexplained change to an old test is a finding.

The commit holds tests and test data only — tests, fixtures, snapshots, test helpers — every
path under `TEST_GUARD_PATHS`. No stub, no helper in production code, no configuration that
selects, skips or excludes a test. A test-runner configuration file the design's tests need is
yours to write only where the declaration protects it; one it does not protect is a finding for
the repository's tech lead, raised as a clarification, because the engineer could change it. The
same holds for a test file a supported runner collects by its convention (`*.test.*`, `*.spec.*`,
`test_*.py`, a root `tests/` …) and for runner settings in `package.json`, `pyproject.toml` or
`setup.cfg`: setup refuses one the declaration leaves uncovered, so a test outside it is a
clarification for the declaration, never a reason to move the test out of sight.

## The red — each test fails, for the reason you expect

**A test that has never failed is worth nothing.** Not "weak" — worth nothing. A green run from a
never-red test is indistinguishable from a green run with the test deleted. Watching it go red
for the stated reason is the evidence, and the split puts that evidence on a commit where the
orchestrator and the critic can see it rather than in your session.

Run the suite at the test commit, to a log, and read the log:

    <the repository's test command — TEST_COMMAND, as handed in> > /tmp/<KEY>-red.log 2>&1; echo "exit=$?"

Never pipe it to `head`, `tail` or a pager, and never dump it whole into your context. Then, per
new or changed test, confirm:

| Outcome at the test commit | What it means | What you do |
|---|---|---|
| Red on the assertion the criterion makes | Proven | Record it |
| Red on a stub's "not implemented" | Proven: the test reached the code under test | Record it |
| Red on "not found", a compile error, a collection error, a missing fixture, a typo | Nothing proven | Fix the test or the stub, run again |
| Green | The test would pass lazy code | Strengthen the assertion until it is red — unless it is the test a pull-request comment asks for of behaviour that already works (§ A pull-request comment) |
| Green, on a row whose `Asserts` cell starts `Holds already:` | Expected: the criterion is a constraint the current code already meets | Record it as `holds already`, and check the assertion would fail if that behaviour broke |

And every test your commits did not add or change is still green. Hand the orchestrator a red
table with the commits; it re-runs the suite itself and passes its own log to the critic, so the
table is your account and never the evidence:

    | AC | Test | Outcome | The failing line, quoted from the log |

## Commit discipline

- Conventional commits: `chore(<KEY>): stubs` and `test(<KEY>): <imperative summary>`, using
  the type set the repository's always-on rule declares where it declares one.
- The stubs commit, where there is one, comes first; the test commit next; no build commit
  exists yet. The order is asserted from the history. A pull-request comment's one test commit
  is the exception: it sits on the branch's tip, after the build.
- No runtime, model or tool names in a message, and no co-author trailers unless the
  repository's policy asks for them. Commit only with
  `node <HUB>/scripts/harness-commit.mjs --repo . -m "<message>"`, which appends the harness
  watermark (`.claude/rules/watermark.md`); never by `git commit` directly. It runs the format,
  lint and type-check commands on what is staged first: stubs and tests pass them as any code
  does, and a refused commit was not made.
- **End every turn with a clean worktree**, and append one section to the handoff ledger —
  who, the commits, the checks with their exit codes, the red table, deviations or `NONE`.

## The revision protocol and the dispute

Findings arrive in-loop from the orchestrator; the critic never edits your commits. Resolve each
finding at its location, address every `CRITICAL` and `IMPORTANT`, decline a `SUGGESTION` only
with a written reason, and contest a finding you believe is wrong in writing, with evidence. A
revision lands as a new `test(<KEY>): ...` commit — never an amended or rebased one; a
pull-request comment's revision replaces its unpushed commit (§ A pull-request comment) — and you
reply with a change list, one row per finding:

    | Finding | Severity | What changed | Where |

**A dispute is a finding from the build.** When the builder finds a test it believes is wrong —
it cannot pass without breaking another criterion, or it asserts what the design does not say —
the orchestrator hands you the dispute: the test, and the design text it conflicts with. Read
both at their locations. Where the test is wrong, fix it in a new test commit and send the change
list. Where the test is right, contest the dispute in writing with the design lines. Where the
design itself is ambiguous, raise a clarification: neither the test nor the design is yours to
bend to fit. Each dispute spends a round of the test loop; the orchestrator counts it.

**A dispute's revision is made in the controller.** By then your checkout is the trusted
controller and the engineer works in a clone of it. Commit the new test revision on top of the
approved baseline, as any revision; once the critic approves it, `/dev-sprint` starts a fresh
guarded run on it, with a fresh engineer in a fresh clone. Nothing the engineer built against the
old tests is carried across by the guard.
The same two rules bind the revision: tests under the protected paths, stubs outside them.

**At the cap, stop.** Leave the branch at its last reviewed test commit and hand back. Rounds
spent on the tests are almost always an unclear testing plan, and the destination is the design.

## A pull-request comment

PR-FIXER — step 10b of `/pr-review` and of `/dev-sprint` — dispatches you first for every harness
comment it fixes (`.claude/skills/fix-pr-comments/SKILL.md`). You are handed the comment — the
pr-reviewer's finding, kept by the pr-verifier: your task —, the merged design and the rules. The
branch already carries the build and any earlier fixes, and you work in the controller at its tip.

- **You decide whether a test comes first.** A comment that asks for different behaviour, or says
  a test is missing or wrong, gets its test. A change no test can observe — an unused import, a
  name, dead code, a structure — gets none: write no commit and return
  `no test needed: <why, in one sentence>`. Then the engineer fixes it alone.
- **A group of Prime findings is one task.** PR-FIXER may hand you several Prime findings at
  once (`.claude/skills/fix-pr-comments/SKILL.md` § A group of Prime findings). Decide for each
  finding whether a test can observe it, and put every test of the group in the one commit. Its
  `<ref>` is each `PRIME-C<n>` that has a test, joined by a comma and a space. Return `no test
  needed` only where no finding of the group can have a test.
- **One commit, tests only.** `test(<KEY>): <ref> <what it pins>`, `<ref>` the comment's `SHL-R<n>`
  or the Prime finding's `PRIME-C<n>`, made with
  `harness-commit.mjs` on the branch's tip, changing only paths `TEST_GUARD_PATHS` covers. No stubs
  commit: the symbols exist.
- **The name carries the comment**, then what it asserts: `SHL-R1 · an order with no basket is
  rejected`. The thread finds it by that name.
- **Change an approved test only when the comment says that test is wrong**, and name the comment
  in the change list. Otherwise add a test beside the others; leave every test the comment does not
  name as it is.
- **Red, with one exception.** The new test is red at your commit for the reason it states, as
  § The red requires. It may pass at once only when the comment asks for a test of behaviour that
  already works — "add a test for the empty basket" where the code already rejects one — and your
  red table says so: `green — a test of behaviour that already works`. Any other green test is one
  lazy code would pass.
- **Its cap.** The critic reviews your commit in `test-review` (§ PR-comment round there), and a
  comment's test has the cap `.claude/rules/worker-critic.md` § Revision caps sets. A revision
  replaces your commit: the main session drops it — it was never pushed — and you commit again on
  the branch's tip, with the change list. At the `CHANGES REQUESTED` that reaches the cap, stop:
  nothing of the comment lands, and the main session answers the thread.

## Never

- Never write behaviour, and never let a stub branch, compute, or call.
- Never stub, or test, a symbol the design does not name.
- Never rename a test the plan names, and never cover a criterion with a test it does not name.
- Never leave a new test green at the test commit, or red for a reason that proves nothing —
  unless the plan marks its row `Holds already:`, or a pull-request comment asks for a test of
  behaviour that already works.
- Never check for "any exception" where the design names an error type.
- Never skip, exclude or mark as expected-failure any test, yours or an existing one.
- Never put real or candidate data in a fixture.
- Never amend, rebase or squash a commit once the critic has seen it. A pull-request comment's
  revision is a new commit on the branch's tip; the main session drops the old one, never you.
- Never judge your own tests, and never proceed past the cap.

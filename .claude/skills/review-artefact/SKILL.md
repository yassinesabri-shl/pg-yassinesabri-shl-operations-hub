---
name: review-artefact
description: The reviewing method for every critic seat — mode resolution, bootstrap reading order, per-mode review dimensions, the verdict format, evidence discipline, delta-only re-review and severity calibration.
---

<!-- Part of the harness asset library c6f3b4427d58f7c3 (see VERSION.json) · 2026-11-11 -->

# Skill — review-artefact

Loaded by three seats. `dual-mode-critic` (`.claude/agents/dual-mode-critic.md`) runs
`lld-review`, `test-review`, `code-review` and `global-review`; `pm-critic` (`.claude/agents/pm-critic.md`) runs
`decomposition-review`, `feature-review`, `ticket-review` and `bug-review`; `security-reviewer`
(`.claude/agents/security-reviewer.md`) runs `code-review` under the security lens below, and
only where the diff touches a triggering surface. **No seat runs a mode its own charter does
not list.** The modes differ in cap, in dimensions and — decisively — in whether a file is
written, and the charters carry different tool grants for exactly that reason. The
charter owns the contract and the tool grant; `.claude/rules/worker-critic.md` owns the
loop, the caps and the severity ladder; the commands own procedure and state; this file
owns how a review is actually done. Where this file and a command disagree, the command
wins — it is the procedure. One further seat is **planned** and will load this file
unchanged: a cross-provider reviewer running this method on a second model provider. It adds
a lens, not a method.

## Purpose and the eight modes

**You judge an artefact against its contract, and the only thing you ever write is your
own review.**

| Mode | What you review | Cap | Where the verdict goes |
|---|---|---|---|
| `feature-review` | a requirements document against the business input it was written from, before any work item exists | 2 | returned in-loop as text; `/feature` writes your final round beside the document as `docs/requirements/<SLUG>/requirements-review.md`, and `check-requirements` reads it |
| `decomposition-review` | a decomposition record and its work-item files, before any design exists | 2 | returned in-loop as text; `/decompose` writes your final round beside the record as `docs/backlog/<SLUG>.decomposition-review.md`, and `check-decomposition` reads it |
| `ticket-review` | a Jira ticket's snapshot and the work item taken from it, before any design exists | 2 | returned in-loop as text; `/from-ticket` writes your final round beside the snapshot as `docs/backlog/jira/<KEY>.ticket-review.md`, and `check-intake` reads it. `/enrich-ticket` dispatches the ticket half only, and writes no file |
| `lld-review` | the per-work-item design, before any code exists | 3 | you write `docs/designs/<KEY>.lld-review.md` |
| `test-review` | the stubs and tests for one work item against its approved design, before any behaviour exists | 3 | returned in-loop as text |
| `code-review` | the candidate the protected-test guard's finalizer passed — its exact commit and tree — against its approved design | 3 | returned in-loop as text |
| `bug-review` | a bug record's chain to the root cause, against its ticket and the code at the pinned commit, before any branch holds a fix | 2 | returned in-loop as text; `/bugfix` writes your final round beside the record as `docs/bugs/<KEY>.bug-review.md`, and `check-bug` reads it |
| `global-review` | the hub's decision records and standards against the global layer at one release, on demand | 1 | returned in-loop as text; `/check-global` prints it, and with `--connect` copies its findings into the pull-request description |

The first six rows are in lifecycle order, and that is the only thing the order means.
`global-review` is outside the lifecycle: a person asks for it. `bug-review` is the review of a
route of its own, `/bugfix`, which runs no other mode. A mode is dispatched, never inferred from
where the work appears to have got to.

The cap column repeats `.claude/rules/worker-critic.md` § Revision caps; that rule wins if
the two ever diverge. A pull-request comment's round in `test-review` or `code-review` has the cap
that rule sets for it, in the same modes with the same tokens (§ PR-comment round, under each).

In `lld-review` you are the last automated check before a human spends attention on the
design, and your review file is what the pickup gate reads once the design is merged: its
final state carries the approved token, or the gate never opens. Catch the mechanical
defects here, so the human's time goes on judgement.

In the other seven modes you write no file at all. The verdict returns in-loop to whoever is
running the loop — the `sprint-orchestrator` seat in `test-review` and `code-review`, the `/decompose` command
itself in `decomposition-review`, the `/feature` command in `feature-review`, the `/from-ticket`
or `/enrich-ticket` command in `ticket-review`, the `/bugfix` command in `bug-review` — and that caller
persists each round to the system temporary directory, never into the worktree. `global-review`
is different: it has one round and no worker, and the `/check-global` command prints that round
and persists nothing. In
`feature-review`, `decomposition-review`, `ticket-review` and `bug-review` the command then writes your
**final** round, verbatim, beside the artefact as its review file, and a script reads it on the
pull request: so your text carries the revision line for the mode — `Document revision:`,
`Record revision:` (also in `bug-review`), or `Ticket revision:` and `Item revision:` — with the hash the dispatch
handed you for the bytes you read. Copy it. You hold no shell command that computes it.
In `test-review` and `code-review` nothing persists the file,
and the **worker** carries the final verdict into the pull-request description on its last
pass — the build worker, for both. Neither you nor
the orchestrator may write the artefact under review. Wanting a second write path is a finding
for the caller, not a scope request.

All eight modes produce the shape at `.claude/skills/shared/review-file.template.md`: one
shape, seven destinations, so everyone downstream learns to read only one.

## Mode resolution — the first thing you do, every dispatch

**The dispatch names the mode. You never infer it from the material in front of you, and
you never default to one.** If the dispatch carries no `Mode:` line, hand the round back to
the orchestrator and ask for one, and issue no verdict.

A guessed mode gets the dimensions wrong and the cap wrong, and a guess of `lld-review`
also writes a review file — a verdict committed onto a branch nobody asked for, at the
exact path the pickup gate reads after the merge. Every other missing input here is handed
back rather than assumed; the mode decides which checks you run at all.

## Bootstrap — read in this order, before you form any judgement

**The contract first, the evidence second, the author's account of the evidence never.**

1. **The contract.** In `test-review` and `code-review` it is the approved design, and the version on the
   trunk is the one that counts: if the branch holds a newer design, the trunk still wins
   and the divergence is itself a finding. In `lld-review` the design *is* the artefact, so
   the contract is the signed specifications it cites. In `decomposition-review` it is the
   source document at the revision the record names — not a later one, and not a summary. In
   `feature-review` it is the business input itself at the revision the document names — the
   interview record in the run folder, whose notes are the person's words, and every copied file
   beside it — which is the only contract that artefact has: nothing upstream of it is signed,
   and the document under review is not evidence about its own source. The index — the hub's
   documents, and the global documents first where the `Global:` line records a release — and
   the context documents `/feature` selected arrive as text with the dispatch, with the
   `Global:` line. Judge the `Context:` and `Global:` lines against them, and open no context
   document yourself. In `global-review` the contract is the global layer at the release the
   dispatch names, and the hub's records and standards are the artefact (§ Review dimensions —
   `global-review`). In `ticket-review` the contract is
   `.claude/rules/ticket-quality.md` for the snapshot, and the snapshot for the work item. The
   snapshot is a copy of the ticket, so the ticket's own words are the source: a gap in them is a
   finding about the ticket, never one you fill. In `bug-review` the contract is the ticket's snapshot
   inside the record, for the claim, and the code at the pinned commit, for the chain. Open each chain
   link yourself with `read-spoke.mjs` at the 12 characters of its commit, never from the investigator's
   summary.
2. **The cited source sections, independently.** Open every sampled citation and read the
   cited lines yourself, never the author's summary of them. Paraphrase drift is invisible
   through the author's eyes, which is why this is a step of its own. A citation into another
   repository, `<id>@<12-hex>:<path>`, opens through `node scripts/read-spoke.mjs <id> <path>
   --at <12-hex>`. Pass the 12 characters of the citation to `--at` as written. Never read the
   trunk, because the trunk may have moved since the author read it. That script is the one
   shell command a reviewing seat holds where its charter grants it, and it has no write path.
   The pm-critic keeps that read, as its charter gives it. In `lld-review` you open no spoke.
   Find each cited spoke file in the hand-in under "Sources handed in". Ask for any other search
   or read in one request round (§ The request round). In `lld-review`, a citation into a hub decision record,
   standard or requirements document names a file in the hub checkout. Open that file with `Read`
   and check the cited lines there. The context hand-in removes each document's frontmatter, so
   its line numbers are not the file's line numbers.
3. **The rules binding the changed paths.** Only those. A rule scoped to paths the change
   does not touch is not in play, and applying it anyway manufactures findings. In a hub and
   its spokes these are the repository's own rules the orchestrator handed in as text — the
   always-on rule and every rule a design path matched, each with a `Cite:` at the commit the
   design's `Rules:` line names — and the hub's always-on rules. You do not open the folder,
   and a rule that was not handed in is not in play; if the hand-in is missing where the
   design's `Rules:` line cites a folder, hand back and ask rather than review without it.
   In `test-review` and `code-review` the design's context documents come the same way: as
   `/dev-sprint` precondition 9 printed them, at the bytes the design pinned, each with a
   `Pin:` and a `Cite:`. You do not open them yourself; if the hand-in is missing where the
   design's `Context:` line names a document, hand back and ask.
4. **The diff against the trunk, in `test-review` and `code-review`.** In `test-review` it is the
   stubs commit and the test commits, each with its own diff, and nothing else exists yet to diff. Not the files — whole-file reading on
   a diff spends the window on code nobody changed. Read a file whole only where the file
   *is* the unit of work: a new module, a contract definition, a design, a backlog item.

Read to the end of the list before writing a finding: a judgement formed at step 1 spends
steps 2 to 4 looking for support.

## Grounding the verdict

Use the ladder in `.claude/rules/worker-critic.md` § Grounding the verdict, strongest rung
first. It is not restated here; read it there. Two consequences for this seat:

- **Prefer the deterministic rung wherever the property is mechanically checkable** — but
  you hold no shell to run code, so you report what the machine found from output the orchestrator
  passed in. You never run it and never assert it.
- **You are the external signal.** Reconstructing the author's reasoning and agreeing with
  it is the bottom rung; when you notice yourself there, go back to the sources.

## Review dimensions — `lld-review`

| Dimension | What you check | What fails |
|---|---|---|
| Traceability | every claim and criterion cites a source by section title and line, and the citation is non-circular | a criterion sourced to the design itself; an uncited requirement, which is an invented one |
| Repository rules | the `Rules:` line is `none` or a citation into the design's own repository, and it is the line `scripts/read-spoke-rules.mjs` prints for that repository at that commit; every rule the script selects for the §3.1 paths is listed under §2 Read before implementing, and the design obeys each | a typed `Rules:` line; `none` where the repository declares a folder; a selected rule absent from §2, which is a convention the design was written blind to; a design that contradicts a rule it lists |
| Context documents | the `Context:` line is the one `scripts/read-context.mjs` prints for this design at the `Rules:` commit, each entry the id, the pin and the path, as `/dev-spec` hands it to you with the index, and the `Hub commit:` line beside it is the one the same run printed; every document it selects is listed under §2 Read before implementing by its path, and the design obeys each. The design applies each document where it names it: a standard's cited rule is the rule the design follows at that place. A standard rule an `Overridden:` line names does not bind this design; the repository rule the line names binds in its place (§ Overrides) | a design that cites a rule and does something else at that place; a design that follows an overridden standard rule against the repository rule that replaced it; a document from the index that plainly bears and is missing; a typed `Context:` line; `none` where the script selects a document; a line of bare ids, the form before the pin and the path; a selected document absent from §2, which is a contract or decision the design was written blind to; one listed by id alone, which leaves the reader to find the file; a design that contradicts a document it lists |
| Global layer | where the requirements document the design traces to records a release, the design follows every binding global record and global standard rule that bears on its paths and its decisions, judged by § The contradiction test. A departure cites an `Active` exception that names this hub, the prefix of the design's key, and the departed id, and stays inside the exception's Scope and repositories; or, for a global standard rule only, the design's repository rule overrides it, which the standard's `Overridden:` line says (§ Overrides). Read the exception's hubs, departs, repositories and status from the line of header fields in its block of the context documents handed in, never with git | a design that contradicts a binding global record or global standard rule without citing an `Active` exception for this hub, or that goes beyond the Scope or the repositories of the exception it cites — `CRITICAL`, because a global record binds every product and only the Global Architecture Board grants a departure (`CLAUDE.md` §4, rank 3). The exception's status, its hubs, its `departs` and the ids on the line are the gate's to fail, not yours |
| Prime guardrails | where `/dev-spec` hands you `chosen.md`, the rules that the design names. Each of them is named under §2 Prime guardrails, and §3 holds what §2 says of it. The `Guardrails:` line is the line `prime.mjs choose` printed for the g-numbers §2 names, as `/dev-spec` hands it to you. You do not check the whole list against the design: the `security-reviewer` does, in the same round, with § The security lens — a design | a rule that §2 names and §3 does not hold; an answer to a question of `/dev-spec` step 4, handed to you as text, that the design does not apply; a limit on a required behaviour with no `Closed` §9 row that carries the product owner's answer — each `IMPORTANT` |
| Acceptance criteria | each is one observable, testable statement with a stable identifier, and at least one is a negative case; each row's `Requirement` cell is the `REQ-<n>.AC-<m>` the work item's `Carries` column names for that criterion | a criterion no test could disprove; a set with no negative case; a renumbered identifier; a requirement cell that differs from the work item's, which is the link to the requirement re-derived where it should be copied — the gate refuses a criterion added or dropped against the work item and a requirement cell that differs from the work item's |
| Scope of change | the design changes only the behaviour the work item's criteria name, and keeps today's behaviour everywhere else. Where a criterion says "all", "every", "always" or "never" over a set the requirements document does not define, the design reads the set as the behaviour the story touches, keeps every refusal, limit and special path the story does not name, and records that reading once in §7 and once in §9, routed to the feature owner with `Blocking` = `no` | a design that changes behaviour no criterion names: `IMPORTANT`, and `CRITICAL` where that behaviour is a refusal or a safety path; a wide criterion met by widening the system, with no §7 reading; a §7 reading with no §9 row, or a §9 row with no §7 reading. A reading recorded in both places is not a finding, and a case the requirement does not name is not one either: the §9 row carries it to the feature owner, and the merge approves the reading |
| Testing plan | one row per criterion, each naming a real, writable test whose level matches what it asserts; a row whose `Asserts` cell starts `Holds already:` names a criterion the current code meets, at lines it cites | a placeholder in the test column; a test depending on fixtures or infrastructure the design does not itself plan; `Holds already:` on a criterion that needs new behaviour, which lets its test skip the red |
| Reach | the design names every place that holds the logic it changes, and your own search in the cycle 1 request round finds no other place (§ The request round). The discovery map lists the author's searches, so search where they did not | a second place that a search finds, and that the design does not name in §3.1 or rule out in §7. `IMPORTANT`, and `CRITICAL` where the second place keeps the old behaviour live |
| Discovery map | the map `docs/designs/<KEY>.discovery.md` arrives as text under "Sources handed in". It lists every file the design cites. Each hit of the author's searches is named in §3.1 or ruled out with a reason. The design did not trust a `Reused` `current` entry where it needs the content of that file | a new design with no map: `IMPORTANT`. A Ruled out reason that the file contradicts: `IMPORTANT`. A search too narrow for the change: `SUGGESTION` |
| Failure behaviour | every failure path names how it is detected, what the system does, and what an operator can observe | a design that specifies only the success path |
| Contract impact | every consumed or served interface is listed with its direction and whether it changes | an interface changed inside this work item rather than renegotiated with its owner |
| Readiness block | the fields are present, each exactly once, on their own line, as pure tokens | a field restated in prose or a table; a reworded label; a formatting variant |
| Dependency clarifications | a §9 row whose question concerns a dependency (a story that a `blocks` row of the decomposition's dependency map names, from this story) has that story's design in its `Source` cell, as `` `docs/designs/<dependency-key>.lld.md` `` | a row about a dependency with no such `Source`. This is `IMPORTANT`, because `check-dependencies` reads that cell and cannot see the row |

Two checks need more than a row. **Reverse coverage** — read the cited sections and hunt
in the other direction: a meaningful requirement in a cited section with no acceptance
criterion against it. The design owes coverage of what it cites, not merely a citation for
what it wrote, and this is the check the author cannot run on themselves.

**Re-derive the readiness block; never read it.** The field list, the permitted values and
the pure-token rule are at `.claude/skills/shared/readiness-block.template.md` — apply them
from there, not from memory. Count the criteria rows, the testing-plan rows and the blocking
clarification rows yourself, then compare field by field against what the author declared.
Two integers typed by one author agreeing with each other is not evidence; the tables are.

### The request round

In `lld-review` your shell is for read-only search only, and you open no spoke.
The orchestrator runs your searches and reads for you, in one request round for each review
round. A request round is not a review round.

**When to ask.** The first dispatch of a review round carries `Request round: 0 of 1`. A dispatch
with no `Request round:` line has no request round, and you return a verdict.

In cycle 1 at `Request round: 0 of 1`, your reply is always a `### REQUESTS` block, never a
verdict. The block holds at least one `grep` for the logic that the design changes, for the
Reach row. The hand-in holds only the files that the design cites. So it cannot show that no
second place holds the logic, and it never satisfies the Reach row. Choose the search terms from
the design and the requirements, as "The requests are your own" below says. The orchestrator refuses
a verdict at `0 of 1` in cycle 1 and dispatches you again.

In a later cycle, a request round is optional. Ask when a check needs a fact that the hand-in does
not hold:
- a search for a second place, when the change puts the logic in a place that cycle 1 did not search
- a cited spoke file that the hand-in missed
- any other spoke file that a finding depends on

In a later cycle, when the hand-in holds every fact you need, return the verdict and ask for
nothing. In cycle 1, add these other requests to the block that holds the Reach search.

**The grammar.** Return a reply with no verdict and no review file. The reply holds one block:

    ### REQUESTS
    - grep "x-request-id" --paths "src/**/*.ts"
    - grep "make(Request)?Id\\(" --regex --ignore-case
    - files "src/**/router*.ts"
    - read "src/legacy/router.ts"

- The block starts at a line that is exactly `### REQUESTS`. It ends at the first blank line or
  at the end of the reply.
- Each request is one line that starts with `- `. The line holds a kind and then its operands.
- The kind is `grep` (text in files), `files` (file paths) or `read` (one file).
- Every text, glob and path is a JSON string, in double quotes. A space, a quote or a backslash
  then has one meaning.
- The flags are `--regex`, `--ignore-case` and `--paths "<glob>"`. `--paths` can occur more than
  one time. The flags apply to `grep` only.
- A glob uses git's `:(glob)` grammar. `*` stays inside one folder, `**/` matches zero or more
  folders, and `?` matches one character.
- Name no repository and no commit. The orchestrator runs every request in the design's
  `Repository:`. The commit is the one that the design cites. The design's `Rules:` line, when it
  is not `none`, and its citations into its `Repository:` each name a commit in 12 characters. The
  orchestrator checks that they all name the same commit. If they name more than one commit, the
  orchestrator stops and escalates to the person. It passes those 12 characters to `--at` as
  written, and the script resolves them to one commit on the trunk.
- Write no line that starts with `### VERDICT:` in the reply.

Keep the block in this form, or the script refuses it:
- Write the block as plain text. Put no code fence around it.
- Put no blank line after `### REQUESTS`.
- End the block with a blank line.
- Start each request with `- `.

The cap is 10 requests. The script refuses the whole reply when it breaks the grammar or the cap,
and then no request runs. The next dispatch then carries the refusal text as its answers, and you
must return a verdict.

**The answers.** The next dispatch carries `Request round: 1 of 1` and the output as text. Each
result starts with `Request <i> of <n>:` and the line as you wrote it, then `Exit:` and the
code. Exit 1 on a `read` is a path that is not at that commit. Exit 1 on a search is `Scope: 0`:
the globs select no file. A hit only finds a location. Cite a `read` result from its `Cite:`
line, never a hit. At `1 of 1` you must return a verdict. A second `### REQUESTS` block in the
same review round breaks the protocol, and the orchestrator escalates it.

A `read` in the round prints at most 400 lines of a file. The script cuts a line over 300
characters with ` [cut]`. Over 400 lines, the body ends with `[cut: <k> more lines]`, and the
`Lines:` value in the header is the full count. A file with a NUL byte prints its header and the
line `[binary file not shown]`.

**The requests are your own.** Choose each search from the design and its sources. Never ask
for a list that the author wrote, and never take the author's account of where the logic lives.
A critic that runs the author's searches finds what the author found.

Record the round in the review file, in "Spoke requests — lld-review"
(`.claude/skills/shared/review-file.template.md`).

### The record of a pull request's fixes

A merged design takes one change: rows that record what the fixes of its pull request settled
for Prime's rules (`.claude/commands/dev-spec.md` § Amending a merged design). The dispatch
carries the difference against the merged revision, `record.md` and the design whole. A critic
approved the merged revision, and a person merged it. So you do not review the design again, and
you run no Reach search. You read the difference, and you check three things:

1. **Each row says what `record.md` says.** A person's words are quoted word for word, with the
   role. A decision names what the code does now and who chose it. No row says more than its
   entry, and no entry is missing.
2. **No other line changed.** The difference holds new rows in §9 and §10, and a count in §8 or
   §11 that a new row changes. Any other changed line is `CRITICAL`.
3. **Each row has the form of its section.** A §9 row has eight cells, `Status` `Closed`, a
   `Source` that opens `Prime `, and a date. A §10 row has five cells, and its decision opens
   `Prime <g-number> <title> — `.

Your review file replaces the earlier one. Its `Design revision:` names the new bytes, so it
vouches for the whole file: the merged bytes by the earlier approval, and the new rows by yours.
Say so in one line of the file.

## Review dimensions — `test-review`

The artefact is the test writer's work: a stubs commit, where anything new is named, and one or
more test commits. The contract is the merged design. Nothing behaves yet, so every dimension
asks one question from a different side: **would these tests catch an implementation that does
not do what the design says?**

| Dimension | What you check | What fails |
|---|---|---|
| Coverage | every criterion in §4 has the test §5 names for it, by that exact name, at that level | a criterion with no test; a renamed test, which breaks the criterion-to-test map; a test the plan does not name standing in for one it does |
| Strength | each test asserts what its `Asserts` cell says, and would fail if the behaviour were inverted | an assertion that the code ran; a weaker comparison than the cell states; a check on a mock's call where the criterion names an outcome |
| The lazy build | the laziest implementation that could pass each test — a hard-coded return, an empty collection, an always-true check — still fails it | a test a constant satisfies; a set of tests that one fixed input passes; a negative case with no positive one beside it |
| The red, and its reason | per the orchestrator's log at the test commit, every new or changed test is red on the assertion its criterion makes or on a stub's "not implemented", and every other test is green; a test whose plan row starts `Holds already:` is green, and would fail if that behaviour broke | a new test green at the test commit on a row the plan does not mark `Holds already:`; a red from "not found", a compile error, a collection error or a missing fixture, which proves nothing; an existing test newly red with no criterion behind it |
| Error types | an error test names the exact error type the design states | a check for any exception, which a stub's "not implemented" satisfies; an error type the design does not name |
| Failure paths | every failure path §3.4 names that a criterion covers has its test | a criterion on a failure with only its success path tested |
| The interface | tests reach behaviour through the public interface §3.2 names | a test that calls a private helper, reads internal state, or pins an implementation choice the design leaves open |
| Stubs | the stubs commit holds only symbols §3.1 or §3.2 names; declarations are whole, and every new body is one "not implemented" throw; an existing signature §3.2 changes keeps its body, or the throw where that body cannot compile, and each protected file the commit modifies changes only a call or a declaration to follow it | a branch, a computed value, a call or a non-zero default in a stub — `CRITICAL`, because it is behaviour nobody reviewed as code; any other change to a protected file in the stubs commit — `CRITICAL`, because setup lets the commit modify such a file and only this row limits what changes; a stubbed symbol the design does not name; a stubbed contract or generated type |
| Changed old tests | each existing test the commits change traces to a criterion whose behaviour the design changes | an old test weakened, moved or deleted with no criterion behind it |
| Test data | fixtures, snapshots and seeds are made up | anything that reads as a production record or candidate data — `CRITICAL`, and the round stops there |
| Scope and repository rules | the commits hold stubs, tests and test data only, and obey the rules handed in; the two subjects `chore(<KEY>): stubs` and `test(<KEY>): …` are the protected-test guard's, which refuses any other, so a rule about commit messages does not reach them | production behaviour, a helper outside the test tree, or a configuration that selects, skips or excludes a test; a breach of a handed-in rule, cited by name and line; a finding against one of the guard's two subjects, which no commit could satisfy |
| Context documents | the tests obey every context document handed in — field names, error codes and constraints as the document states them — cited by document id and line in the finding; a standard rule an `Overridden:` line names is not a document the tests owe (§ Overrides) | a breach of a standard in a handed-in context document, `IMPORTANT` by default and `CRITICAL` where the document says so; a finding against a document that was not handed in, which is a manufactured requirement |
| Static scan | the `STATIC SCAN` block the harness appended to your prompt: Semgrep CE's findings on the test files, run before you started, each `SG-<n>` with its rule, location and fix | a `VIOLATION` left out of your reply, or `APPROVED` while one stands — `IMPORTANT`; a `WARNING` neither confirmed as a finding nor dismissed with a reason; a `NOT COVERED` or `PARTIAL` file you did not read by hand; a block that says "Semgrep scan not run" and a reply that does not say so |

**The scan and your own review are one reply to the test writer.** Return each `VIOLATION` in the
block as a finding of yours — its `SG-<n>`, severity `IMPORTANT`, its location and the fix the rule
gives — in the same findings table as your own, and never `APPROVED` while one stands. Confirm a
`WARNING` as a finding at the severity it deserves, or dismiss it in one line with the reason (a
helper that does assert, a skip CI really sets). Do not re-run, re-derive or argue with the scan:
the rules are the hub's, and a rule you think is wrong is a note to the hub's tech lead, not a
finding withheld. Where the block says "Semgrep scan not run", or there is no block at all, say so
in your reply and review the tests as usual: the scan is the harness's, and its absence is not a
reason to stop or to approve.

**The lazy build is the headline check**, because it is the one a green run can never establish
and the one the test writer is least able to run on its own work. Write the lazy implementation
in your head for each test, and file the finding where it passes. A test on a `Holds already:`
row is the exception: the current code passes it by design, so ask instead whether it fails when
the behaviour it pins breaks.

**A dispute round is a delta like any other.** When the build hands a test back, the dispatch
carries the dispute — the test, the design text it conflicts with, and the check output — and the
test writer's change list or its written contest. Review the changed tests and the dispute, and
nothing else. Where the dispute shows the design is ambiguous, escalate: it is a clarification
for a human, not a finding against either worker.

### PR-comment round — `test-review`

For one harness comment PR-FIXER fixes (step 10b of `/pr-review` and of `/dev-sprint`) the dispatch
carries the comment, the merged design whole, the rules, and the test writer's one commit for the
comment with the orchestrator's log at it. For a group of Prime findings, the dispatch carries
every finding of the group, and "the comment" below is the group. It also carries `Test-Checkout` and `Test-Base`, with
the base the commit's parent, so the `STATIC SCAN` block covers that one commit and is read as in
any other round (§ Review dimensions — `test-review`, Static scan).

- **The whole design is the contract; the scope is that one commit.** The rest of the branch was
  reviewed in its own rounds and is not re-opened.
- **The coverage table has one row per criterion the comment touches.**
- **The red.** The comment's test is red at its commit, for the reason it states — unless the
  comment asks for a test of behaviour that already works. Then a green test is allowed, and the
  question is whether it really tests that behaviour: invert it in your head, and the test must
  fail. A green test for any other comment, or one that would pass the inverted behaviour, is
  `IMPORTANT`.
- **The name** carries the comment, `SHL-R<n> · …` or `PRIME-C<n> · …`; and an approved test changes only where the
  comment says that test is wrong.
- **`Cycle: <n> of <cap>`** — the cap `.claude/rules/worker-critic.md` § Revision caps sets for a
  comment's test.

## Review dimensions — `code-review`

| Dimension | What you check | What fails |
|---|---|---|
| Design conformance | every acceptance criterion is implemented, and every change traces to the design | scope creep — extra work is a finding even when the extra work is good |
| Correctness and failure paths | the failure behaviour the design specifies is the failure behaviour the code has | a swallowed error; a retry on a permanent failure; a path that returns success on a partial write |
| Test quality | the tests are the ones `test-review` approved, and each still asserts the behaviour its criterion states | a build commit that changes a file the test writer's commits hold, or any other test — `CRITICAL`, because a wrong test is a dispute and never an edit; a skipped or deleted test on the way to green; a configuration that stops a test from running |
| Contract and type boundaries | contracts, schemas and generated types are honoured, not adjusted to fit | a contract edited to make code compile; a generated type hand-written; a merged migration modified |
| Security-relevant surfaces | authorisation, input handling, secret handling and logging in the changed paths obey `.claude/rules/security.md` | an authorisation path with a third branch; personal data reaching a log, a fixture or a snapshot; an undefined control resolved permissively |
| Repository rules | the diff obeys every rule handed in — the repository's always-on rule and each path-scoped rule a changed file matched — cited by rule name and line in the finding | a breach of a handed-in rule, `IMPORTANT` by default and `CRITICAL` where the rule says so; a commit type or branch the always-on rule does not allow, except the test writer's `chore(<KEY>): stubs` and `test(<KEY>): …`, whose subjects the protected-test guard fixes; a finding against a rule that was not handed in, which is a manufactured requirement |
| Context documents | the diff obeys every context document handed in — the contracts, decisions and standards the design's `Context:` line names, at their pins — cited by document id and line in the finding; a standard rule an `Overridden:` line names is replaced by the repository rule the line names (§ Overrides) | a breach of a standard in a handed-in context document, `IMPORTANT` by default and `CRITICAL` where the document says so; a finding against a document that was not handed in, which is a manufactured requirement |
| Prime guardrails | where the dispatch hands you `chosen.md`, or the whole guardrail list, the change meets every rule handed in. Apply the test of `verify-pr-findings` § A Prime finding: do the words of the rule hold in the code? Follow each changed line into the code it calls for a security purpose — a validator, a permission check, a log call — and read that code too. A sentence of the design is not evidence that a rule is met: a line of code is. Where the dispatch hands you `prime-history.md`, read the change against each entry: it holds what Prime raised on this repository before, in its own words, and Prime reads this pull request in the same way | a changed line, or code that it calls, that breaks a rule; a rule that the design answers with a reason, with no control in the code and no `Closed` §9 row that carries a person's answer; an access-control rule met only by an object that exists, or by a middleware that lets a role in — each `IMPORTANT`, cited by the rule's title and the line |
| Scope | the diff contains this work item and nothing else | an unrelated refactor riding along, which makes the change unreviewable as one unit |

The test-quality row carries the most weight, because it is the one a green run cannot
establish. The tests were judged in `test-review` before the build began, so here the question
is whether they are still the tests that were judged. In `/dev-sprint` the finalizer has already
answered it for every approved path: the candidate you are handed is one commit the finalizer
built from the engineer's tree, with every approved test as approved and every refused new path
taken out, and the hand-in lists what it undid. So read the diff for two things. What the declaration may have
missed: a test, fixture or runner configuration outside the protected patterns, which is
`CRITICAL` here and a gap in the declaration to name in the finding — the engineer adds no test,
so a test file in the diff is one the declaration failed to cover. Undone changes are not a
finding by themselves; a pattern of them is worth a `SUGGESTION` naming it.

**Review the candidate you were handed, and say which.** The dispatch carries the finalizer's
hand-in: the candidate's exact commit and tree, the delta since the candidate you reviewed last,
the diff, and the check results the finalizer produced in its own checkout. Those results show
that the approved tests are unchanged and that each command exited 0, not that every approved
test ran: read the suite's last log lines in the hand-in against the tests the red log handed in names. Name the
commit and the tree in your first line. Your verdict is recorded against them, and an `APPROVED` moves
nothing if the candidate is not still exactly that commit and tree. A hand-in without them is an
input missing: hand back and ask.

### PR-comment round — `code-review`

For one harness comment PR-FIXER fixes (step 10b of `/pr-review` and of `/dev-sprint`) the dispatch
carries the comment, the merged design whole, the rules for the paths the fix touches, the test log
at the comment's test commit where there is one, and either the finalizer's hand-in for the fix or
the engineer's decline. For a group of Prime findings, the dispatch carries every finding of the
group, and "the comment" below is the group: one commit fixes each finding, and a finding that the
commit leaves unfixed is a `CRITICAL` finding of yours.

- **The whole design is the contract; the scope is the comment's commits** — its test commit where
  there is one, and the fix. The rest of the branch was reviewed already and is not re-opened.
- **The coverage table has one row per criterion the comment touches** — none, where it touches
  none.
- **The fix does what the comment asks, and only that.** A change beyond it is scope creep, as in
  any round; so is a fix for a second comment. Where the test writer wrote no test, the fix changes
  no behaviour.
- **Reviewing a decline.** The engineer may decline a comment with a reason, and there is then no
  candidate: name the decline in your first line instead of a commit and a tree. Read the reason
  against the comment, the design and the code. The reason is followed by `Needs a person:` —
  `nothing`, or what is left, its owner and how, with a `Why:` line; judge them too. A decline that
  rests on an open clarification, or on a design that does not yet say what the comment found,
  leaves work for a person: `Needs a person: nothing` there is `IMPORTANT`, as is a missing line,
  an owner who is not a role, or a `Why:` that does not say why this pull request cannot settle it.
  `APPROVED` agrees with the decline and its lines — nothing lands, and they are posted as the
  reply. `CHANGES REQUESTED` says why the comment must be fixed after all, or what the lines must
  say, and the engineer tries again.
- **`Cycle: <n> of <cap>`** — the cap `.claude/rules/worker-critic.md` § Revision caps sets for a
  comment's code. The security reviewer, dispatched alongside where its trigger list matches,
  counts the same cap.

### The second reader of a pull-request item

PR-FIXER sorts every item before it fixes any (`fix-pr-comments` § The sort). Where an item ends
without a fix, one dispatch hands you every such item: the verifier's refutations and the
engineer's lines, with the code at the head, the design and the rules. The `security-reviewer`
seat reads the Prime findings, and the `dual-mode-critic` seat reads the harness's comments. You
are the only reader between that ending and a closed thread. Read each item against the code,
not against its own words. Return one line for each item, and nothing else:

    <ref>: agrees
    <ref>: disagrees — <why, in one sentence, with the line of the code or of the design>

| The item ends as | You agree only where |
|---|---|
| refuted, `Meets the rule at <path>:<line>` | that line does what the rule's words ask, for every part of the rule |
| refuted, `Does not apply at <path>:<line>` | the rule guards against a condition that this code cannot have, and that line shows it. A requirement that allows the behaviour is not such a condition |
| refuted, `Misread:` or `Not in this change` | the code that the finding describes is not there, or the change does not add or change it |
| `Covered by:` | the row or the record exists, it holds a person's answer, and the answer accepts this behaviour for this rule |
| `Conflicts with the design:` | the quoted words are in the design, they state the opposite on purpose, and no change keeps them and meets the rule. A design that is silent is no conflict |
| `Needs a person:` | the fix needs a value that an intended use of the feature can reach, or a new response, a new setting or a stored value. A technical name or value is the engineer's. The `Proposal:` line is one that the engineer can build inside the story |
| a decline of a harness comment | § PR-comment round — `code-review`, Reviewing a decline, holds |

A disagreement makes the item a fix. This is one read with no rounds: you do not see the item
again.

## The security lens — a design, from `/dev-spec`

Loaded by the `security-reviewer` seat, where `/dev-spec` wrote a guardrail list. You read the
design, and then its revisions, beside the `dual-mode-critic` and blind to it, at the cap of 3.
You write no file. You return your charter's verdict format with `Mode: lld-review`, and your
reply opens with the line `Guardrail list: <n> rules, g1 to g<n>, ending with "<the title of
g<n>>"`.

**One test, the one Prime applies to the code later: do the words of the rule hold?** Read every
rule on the list against the design, part by part. Prime reads the pull request against the
whole list, so a gap you leave returns as a finding on the code.

| For a rule that the design's code touches, the design gives | You check | A finding, `IMPORTANT` |
|---|---|---|
| a line of existing code | open the file at that line, and the code that line calls for this purpose. The code does what the rule's words ask, for every part of the rule | the line does not do it, or does a part of it |
| a change that the design makes | §3 names the change: where it runs, and what it grants, denies, limits or records | a change that §2 names and §3 does not hold |
| a reason: a requirement, a decision or an earlier design allows the behaviour | a reason is not a control. The rule holds only by a control in §3, or by a `Closed` §9 row that carries a person's answer for this rule | a reason with neither |
| nothing | the code touches the rule, and §2 does not name it | the rule, and the part that the code touches |

Mark each finding with one word, so that `/dev-spec` knows who acts:

- `Fix:` — one change meets the rule and changes nothing that a user of the feature sees. Name
  the change. A technical name is part of the fix: propose it.
- `Decision:` — a person must choose. The change is visible to a user, carries a business value
  that no source gives, or needs another role, a decision record or a standard to change. Give
  the choices that meet the rule, the recommended one first.

For an access-control rule, a control is an explicit check of the caller against the object or
the action. That the object exists, or that a middleware lets a role in, is not one, even where a
requirement lets every role in: the check then grants exactly what the requirement allows. A
requirement that no design can meet together with a rule is a `Decision:` for the lead architect.

**Your reply carries the table of the rules.** One row for each guardrail on the list, in its
order, every one of them: the orchestrator counts the rows, and a reply with fewer is not
accepted. A rule with several parts is touched when any part is:

| g | Guardrail (short) | Touched | Met where, or why not touched |
|---|---|---|---|
| g<n> | <title> | YES | <the line of code, or the §3 place, that meets it, part by part> |
| g<n> | <title> | NO | <why this design's code does not touch it, in one clause> |

    Listed: <n> · Rows: <n> · Touched: <t> · Met: <m>

A touched rule that is not met, or met in part, is a finding with its own entry. In each later
round the dispatch hands you your own table of the round before. Copy it, and change only the rows
that the revision touches.

**Where the dispatch hands you `prime-history.md`, your reply carries a second table.** The file
holds what Prime raised on this repository's earlier pull requests, in Prime's own words. Prime
reads the next pull request in the same way. One row for each entry of the file:

| Earlier finding | This story's code can meet it again | Decided where |
|---|---|---|
| <the guardrail's title> | YES | <the line of §3 that meets the rule, or the `Closed` §9 row that holds a person's answer> |
| <the guardrail's title> | NO | <why: the story changes no code of that kind, in one clause> |

A YES row with neither is a finding. So is a decision of the design that keeps a behaviour which
Prime raised before, with no `Closed` §9 row: mark it `Decision:`. On SHOP-2 the design kept two
such behaviours with no row, and Prime raised both again on the pull request.

**Cycle 3 is a confirming pass.** Read the findings of cycle 2 and the lines that the fix
changed, and nothing else. Raise a new finding only on a changed line.

Review a design, not a system: the two rules that open the next section bind here too. A finding
is `CRITICAL` where the gap lets a caller reach data or an action that the requirement denies.

## The security lens — `code-review`, dispatched on a trigger

Loaded by the `security-reviewer` seat (`.claude/agents/security-reviewer.md`), which runs the
mode above at the same cap of 3, on the same verdict surface, and returns in-loop like any
other `code-review`. **It is a lens, not another mode.** The six `code-review` dimensions still
bind; this section deepens one of them — security-relevant surfaces — and replaces none. The
seat is dispatched only where the change touches a triggering surface, so on most changes none
of this runs, which is the point: a reviewer attached to every diff is a reviewer nobody reads.

Two rules outrank the whole list below them.

**Report what you can evidence in the change.** A finding names a file and a line, names the
entry point an attacker starts from, and says what they get. "Consider reviewing
authentication" hands a discipline back to the worker and names nothing to fix; it is not a
finding, and filing it spends the credibility this seat needs on the round where it is right.

**Review a change, not a system.** A systemic concern — two trust levels with no boundary
between them, no rate limit anywhere, an authentication model that should be replaced — is a
clarification for a human with a role in `Routed to`, and it never enters the verdict. A
reviewer that blocks a pull request on the architecture is routed around, and then it reviews
nothing at all.

### Work the list in this order

Ordered by what the mistake costs, not by how often it appears. Rows 1 to 3 change what an
attacker can reach; rows 4 to 9 change how hard the reach is.

| # | What you look for | What in the diff signals it |
|---|---|---|
| 1 | **Missing authorisation on a new surface** — a route, handler, job, tool, consumer or export added with no explicit policy entry | a new entry point whose siblings all carry a guard, decorator, middleware entry or policy row that this one does not; a route registered outside the block the others are registered in; a handler reachable before the check that wraps its neighbours |
| 2 | **Broken access control on an existing surface** — vertical escalation, horizontal escalation, and the object-level check | an identifier taken from the request and used to fetch, update or delete with no test that the authenticated principal owns that object; a role checked on the route and nothing checked on the record; a third branch added inside an authorisation path, which `.claude/rules/security.md` § Access control fails closed forbids; an entitlement derived from a client-supplied field; a positive decision cached past its request |
| 3 | **Injection through any interpreter** — query, template, command, path, deserialiser, expression evaluator, or a prompt sent downstream | concatenation or interpolation building something another engine parses; a parameterised call rewritten as a built string "for the dynamic case"; a deserialiser accepting a type name from input; a template rendered from user text with escaping switched off; retrieved content reaching an argument list |
| 4 | **Secrets in source, configuration or output** | a literal key, token, connection string or certificate added to a tracked file; a value moved out of the environment "temporarily"; a secret printed to prove it loaded; a local settings file written without first confirming it is ignored |
| 5 | **Personal data reaching a log, trace, metric, error report, fixture or snapshot** | a whole object logged or serialised where one field was logged before; an exception handler that attaches the request body; a new telemetry or analytics event carrying a name, an address, an account number or a free-text field; a fixture that reads like a real record rather than a generated one |
| 6 | **Insecure defaults** — the value that applies when nobody configures anything | verification, expiry, signature checking or certificate validation defaulting to off; a permission defaulting to allow; an empty permission set read as "unrestricted"; a development or debug branch reachable in the deployed configuration |
| 7 | **Unsafe file handling** | a stored path built from a user-supplied name; an uploaded file served back without the content type and disposition that stop it executing; an upload with no size or type bound; an archive expanded with no entry limit and no path check; a temporary file created readable by everything on the host |
| 8 | **Dependency and supply chain** | a new dependency; a pin loosened to a range; a lock file changed with no source change to explain it; an install-time or build-time script arriving with a package; a dependency resolved from a source none of the others use |
| 9 | **Cryptography misuse** | an algorithm, mode, padding or hash chosen by hand instead of taken from the platform's high-level primitive; a general-purpose random generator producing a token, salt or key; a fixed initialisation vector or salt; a password stored under a fast general-purpose hash; a secret compared with an ordinary equality operator |

**Take rows 1 to 3 against the diff before forming any opinion about the rest.** They are the
cheapest defects to introduce — an entry point added in a hurry, one identifier trusted because
the one beside it was already checked — and the most expensive to find later. A round spent on
row 9 while row 1 is open is a round that approved an unauthenticated route.

### Severity, read against reachability

The one test is unchanged — would this block a production deployment? — and for this lens it
resolves on whether a path exists, not on what the defect is called.

| Severity | The test |
|---|---|
| `CRITICAL` | an attacker reaches data, funds or a capability they are not entitled to, by a path this change creates or opens, needing no precondition the change does not itself supply |
| `IMPORTANT` | the change removes or weakens a defence, or the path needs a precondition an attacker plausibly holds — a low-privilege account, a guessable or leaked identifier |
| `SUGGESTION` | hardening with no reachable path behind it in this change |

A defect you cannot trace to a reachable path is a `SUGGESTION` at most, whatever a taxonomy
calls it. The name is not the finding; the path is.

### Where this seat's verdict goes

**In-loop, like every other `code-review`, and it writes nothing.** The seat holds no write
tool, so the destination table at the top of this file needs no exception: the orchestrator
persists your round to the system temporary directory alongside the other critic's, and the
**worker** carries both final verdicts into the pull-request description on its last pass.
Because the dispatch is conditional, say in your first line whether the trigger list matched
and which surface matched it — that sentence is what later tells a reader the difference
between a change nobody security-reviewed and one that was reviewed and passed. Both verdicts
read `APPROVED` before the loop closes, or neither does.

Scan output — a dependency audit, a secret scan, a static analyser — arrives in your dispatch
like any other check and goes in the verification-evidence table with the rest. `NOT CONFIGURED`
and `NOT PROVIDED` are different facts and neither is a pass: the first says the repository has
no such command (`.claude/rules/security.md` § Secret handling), the second says one exists and
its output did not reach you.

### What this lens does not do

- It does not add a control the design never specified. That is a clarification for a human, not
  a finding against the worker.
- It does not re-open a surface the change did not touch, however weak that surface looks.
- It does not import a severity vocabulary from an external catalogue. Three severities, the
  same three, and a catalogue identifier is at most supporting detail inside a finding.
- It does not describe an exploit it has not traced through the code in front of it.

## Review dimensions — `decomposition-review`

| Dimension | What you check | What fails |
|---|---|---|
| Coverage of the source | every section of the source is mapped — into an item, or out of scope with a stated reason | an unmapped section, which is a scope cut nobody finds until delivery; "out of scope" with no reason |
| Traceability | every item cites the source sections it implements by title and line range, against the revision the record names, and every item criterion names, in its `Carries` column, the one `REQ-<n>.AC-<m>` it carries and the source defines | an uncited item, which is an invented one; a citation resolved against a different revision; an item criterion with no named requirement criterion behind it, or one the source does not define, which leaves two different `AC-3`s in two artefacts that cite each other |
| Item boundaries | one item is one unit of deliverable work — one design, one pull request, one criterion set — and items are siblings in one record; each is a thin vertical slice through every layer of its repository that a user or a caller can exercise | a parent with children, which has no state a gate can evaluate; two behaviours fused into one item; a story per layer — the data model, the API, the UI — none of which can be verified on its own |
| Acceptance criteria | stable `AC-<n>` identifiers, one observable statement each, at least one negative case per item | a renumbered identifier, which other artefacts already reference; a criterion set covering only the happy path |
| Dependencies | declared between items by identifier, and the graph is acyclic | a dependency stated only in an item's prose, which nothing can order a backlog from; a cycle, which is a boundary error in the cut |
| Trunk safety | walk the stories in dependency order, as if each ships to production on merge: each one, merged after the stories it depends on and before the rest, leaves its repository building, deployable and passing the tests it already has, leaves what users rely on behaving the same unless it means to change it, and leaves every listed repository that reads what it changes working; every order a story relies on is a `blocks` row; a contract changes by a new version or by add, move, remove, and stored data by expand, backfill, contract, each step its own story; whatever a user reaches depends on every story its behaviour needs; a part kept hidden has a later story that stops hiding it, or a stated reason | a story that only works once a sibling it does not depend on lands; a contract replaced in place, or changed while a reader is still on the old form; a move story that moves some of its repository's readers and not all; a removal that does not wait for every move; a stored-data change that lands before the code that reads both shapes, or folds two phases into one story; a reachable behaviour ordered before a part it needs; a part kept hidden with no story to stop hiding it and no reason recorded; a mechanism for hiding it chosen in the record, which is the design's |
| Repository | every item carries exactly one `Repository:` line naming an id in `docs/estate/repositories.json`; every repository in that list has a row in the record's repository map, with stories or with the evidence read; a change that needs two repositories is two stories with a dependency | an item with no repository, two, or one the list does not carry; a listed repository with no row, which nobody can tell from one that was considered; one story spanning two repositories, or a parent with a child per repository |
| Repository citations | every fact cited into a repository carries the commit it was read at, `<id>@<12-hex>:<path>`, and opens through `scripts/read-spoke.mjs <id> <path> --at <commit>` to the lines it names; nothing cites the list's `purpose` | a citation into a repository with no commit, which is a citation into a moving name; a `purpose` cited as if it were the tree; a cited commit the repository does not have |
| Context documents | each story's one `Context:` line is the line `read-context.mjs <repository> --at <commit> --names` printed for it, handed to you as text with the dispatch, and its one `Hub commit:` line is the one the same run printed. Each document on it shapes the story: a decision record, a requirements document or a contract named where it constrains a criterion, a standard cited by the rule it applies, `std-<topic>.<NN>`. A global document shapes it in the same way: `global.ADR-<NNN>` by its id, a global standard by its rule, `global.std-<topic>.<NN>`, and an exception, `global.EXC-<NNN>`, beside the record it departs from. Each document on the source's `Context:` line reaches the stories it bears on | a document that plainly bears on a story and is missing from its line, or one the story contradicts — `IMPORTANT`. A criterion that breaks a cited rule — `IMPORTANT`. A document from the source's line carried only into a story it does not bear on — `IMPORTANT`. An always-on document is on every line because the script adds it there, so its presence and an absent use of it are never a finding. A use invented only to name it — `SUGGESTION`. The line's form, the pins, the citations' presence and the carry of each source document into some story are `check-decomposition`'s to fail, not yours |
| Keys | every key is from the block `docs/backlog/keys.json` records for this slug, the block is exactly the items cut, and `next` has moved past it | a key outside the block; a spare number in it; a counter that did not move; a key range or a parent epic asked of a person |
| Placeholders and typed rows | no placeholder cell anywhere, and no sign-off or approval block at all | a dash, `TBD`, `N/A`, `TODO`, `pending` or `?` in a cell; a block with a typed row, which is `CRITICAL` — the review file and the merge release the record, nothing typed does |

That last row is what an agent under cap pressure reaches for, in the record and in your own
review: where something is genuinely not yet knowable, the only permitted form is
`UNRESOLVED — <what>. Owner: <role>. Resolves: <trigger>.` Dependency order belongs in the
record, being a fact about the work; value order is the backlog owners' decision, so its
absence is never a finding.

## Review dimensions — `feature-review`

The artefact is a requirements document and the contract is the business input it was written
from. Nothing upstream is signed, so every other dimension rests on one question: **does the
source say this?**

| Dimension | What you check | What fails |
|---|---|---|
| Coverage of the source | every part of the input is carried into a requirement, or recorded out of scope with a reason and a role who owns the exclusion | an unmapped part, which is a scope cut nobody finds until acceptance; "out of scope" with no reason or no owner |
| Traceability | every requirement and every criterion carries a locator into the source, and the locator resolves at the revision the document names | an uncited statement, which is an invented one; a locator that does not resolve; a citation against a revision the document does not name |
| Invention | the cited lines, read by you, support what the requirement claims — no more | a threshold, an actor, a state, an exception or a behaviour asserted in the document and absent from the lines it cites; a criterion that says "all", "every", "always" or "never" over a set that neither the cited lines nor §3 Scope define, `IMPORTANT`: it is a requirement on every case the system limits today, and the design cannot tell which ones the person meant |
| Acceptance criteria | `REQ-<n>.AC-<m>` identifiers, one observable statement each, at least one negative case per requirement, nothing renumbered | a criterion no observation could disprove — `IMPORTANT` at least, because it passes against every build and the testability table records it; a requirement whose set is all happy path; a renumbered identifier, which downstream artefacts already cite |
| Bounded values | every threshold, window, volume and limit carries a stated value or the `UNRESOLVED` marker | a guessed number — `CRITICAL`, because it is testable, it will pass, and nobody agreed it |
| Scope of decision | the document states what must be true, and records what matters most, what happens first and what it is worth only where a source states it. Each Priority cell holds the priority a cited line states, cited in its row's Source column, or the `UNRESOLVED` marker. Each Risks row cites the source that names the risk, and its Likelihood and Severity cells hold what that source states, or the marker | a priority, a sequence, a commercial trade-off or a risk rating the writer originated, which is a Priority, Likelihood or Severity value no cited line states — `IMPORTANT`. A risk no source names — `IMPORTANT`. A priority the source states, in its Priority cell and cited, is correct. So is a stated sequence or trade-off recorded as a cited constraint, and so is an `UNRESOLVED` marker in any of these cells |
| No repository named | the document states what must be true and names no repository: which repositories a requirement touches is `/decompose`'s finding, read from the repositories | a Feature Name row, a section or a requirement that picks repositories, which is a decomposition written in the wrong command — `IMPORTANT`. A `Repositories likely touched` row left from an earlier revision is a `SUGGESTION` to drop it: nothing reads it |
| Placeholders and typed rows | no placeholder cell anywhere, and no sign-off block at all | a dash, `TBD`, `N/A`, `TODO`, `pending` or `?` in a cell; a sign-off block with a typed row, which is `CRITICAL` — the review file and the merge release the document, nothing typed does |
| Context documents | the one `Context:` line is the line `read-context.mjs --hub --names` printed, with `--global <commit>` when the `Global:` line records a release, handed to you with the dispatch, and the one `Hub commit:` line beside it is the one the same run printed. Each document on it shapes the page: a decision record or an earlier requirements document named where it constrains a requirement, a standard cited by the rule it applies, `std-<topic>.<NN>`. A global document shapes it in the same way: `global.ADR-<NNN>` by its id, a global standard by its rule, `global.std-<topic>.<NN>`, and an exception, `global.EXC-<NNN>`, beside the record it departs from. Every document in the index that bears on the intent is on the line: a hub document, or a global document that the index lists | a document the index lists and the requirements contradict, or one that plainly bears and is missing from the line — `IMPORTANT`. A requirement that breaks a cited rule — `IMPORTANT`. A citation that names a document the requirement does not follow — `IMPORTANT`. An always-on document is on every line because the script adds it there, so its presence and an absent use of it are never a finding. A use invented only to name it — `SUGGESTION`. The line's form, the pins and the citations' presence are `check-requirements`'s to fail, not yours |
| Global release | the one `Global:` line is the line `/feature` handed you with the dispatch, byte for byte. On an amendment it changed only when the correction asked for a newer release | a `Global:` line that differs from the one handed in, or one that changed on an amendment whose correction did not ask for a move — `IMPORTANT`, because the document then reads a release nobody chose. The line's form, the tag, the commit and the direction of a move are `check-requirements`'s and the amendment start check's to fail, not yours |
| Machine-read cells | the Feature Name table's `Slug` cell holds the slug alone, in backticks, and it is the folder the document is filed under — `\| Slug \| \`payments-onboarding\` \|` and nothing else in the cell. The citation for that table's rows is the `Derives from:` line under the table | a citation, a note or a second value inside that cell — `IMPORTANT`, because `check-requirements` reads the cell literally and fails the pull request after your approval, when the cap allows no repair. Read `\| Slug \| \`payments-onboarding\` (interview.md § note 3) \|` as a failure, however well cited |

**Invention is the headline check, and it is found in one direction only.** Read the citation
first and the requirement second. The other way round, the requirement primes you: you arrive at
the source looking for the sentence you have already read, and a source that nearly says it
reads as one that does. This is the only defect class in the mode that is invisible on the page
— an invented requirement carries an identifier, sits in the same table and reads in the same
voice as a real one, and every artefact after this treats it as agreed. Sample against the
source, not against the summary of it.

Two calibrations are specific to this mode, and both cut against the reflex.

- **A long clarification list is not a finding.** A thin business input honestly written up
  produces a thin document and a page of open questions, and that is the correct output at the
  only point in the lifecycle where acting on it is still cheap. What is a finding is a
  *plausible sentence* where a question belonged. Count the guesses, never the questions. Nor is
  the absence of a row that asks how — where a file lands, what it is called, which branch
  pattern, which header field: the design settles those, and the writer is right to leave them
  out. A row that asks one is a `SUGGESTION`: it sends a design decision to the business, and it
  comes back as a re-run.
- **Your verdict is not the acceptance, and you never assess whether the business wants what
  the document describes.** That is not a property of the text and no reviewer can read it off
  the page. Judge the document against its source; the human who merges judges the source
  against the business.

## Review dimensions — `global-review`

The artefact is the hub's own layer: every `Accepted` decision record and every standard,
`Active` or `Reserved`, that `/check-global` handed in, each with its path. It also holds every
`Accepted` record of each listed spoke, `<repository-id>.ADR-<NNN>`, with the line
`Hubs of <repository-id>:`. That line is the spoke's hubs, or `unknown`. With `unknown`, no
exception covers that spoke's records. The contract is the
global layer at the release the dispatch names: every document the global index lists, handed
in whole with its `Cite:`. A global exception's block also carries a line of its header
fields: `Hubs:`, `Departs:`, `Repositories:`, `Status:` and `Review-by:`. Judge whether an
exception covers a document from that line and the exception's Scope. The dispatch also names this
hub's key prefix, or says the hub has none. Two questions decide every finding. Ask both of each
hub document:

1. **Can one design follow this hub document and the global layer at once?** A no is a
   contradiction.
2. **Does this hub document make a decision that a global document already makes?** A yes is a
   copy. A copy passes the first question, so only the second question finds it.

Bootstrap steps 2 to 4 do not apply. No hub document is a citation you sample, no path
changes, and no diff exists. A hand-in without the release, the prefix line or the hub's
documents is an input missing: hand back and ask.

### Overrides

A repository rule may replace a hub standard or a global standard, whole or one rule of it. The
rule's block in the rules handed in carries `Overrides: <id>, ...`, and the standard's block in the
context documents handed in carries `Overridden: <id> by <repository>:<rule>, ...`. Read the two
lines; never open a folder to find more. Where the lines name a standard rule, that rule does not
bind the artefact, and the named repository rule binds in its place. Where they name a whole
standard, no rule of it binds. A standard rule the lines do not name binds as before. A
repository rule that departs from a standard with no `Overrides:` line is a finding under
Repository rules, because the stricter reading binds there (`.claude/rules/estate.md` §1). An
override is never a finding: the spoke approved it when a person merged the rule. A decision
record is never overridden, so an `Overridden:` line never names one.

### The contradiction test

`/add-context` applies this test to a new hub record, a new standard and a spoke's own record
(G1). It is written once, here, so that the command and this mode never judge one pair
differently.

1. A hub document **contradicts** a global document when one design cannot follow both.
2. A hub document that **narrows** a global document does not contradict it. It makes a smaller
   decision inside the global rule: "Redis, with a 15-minute default expiry" narrows "Redis only".
   Its own decision is the expiry, and the global document does not make that decision.
3. A hub document that **repeats** a global document is a copy. Its decision is the decision of
   the global document, for the same scope, in the same words or in other words. Compare the
   Decision and the Rules of the two documents, not their wording. A copy stays a copy when it
   adds detail to the global decision, such as a grammar, a field name or an example. A hub
   standard rule that states the rule of a global standard is a copy of that rule.
4. An exception **covers** a contradiction only when all of these are true at the same release:
   - its status is `Active`
   - its `hubs` names this hub, by the prefix in `docs/backlog/keys.json`. For a spoke's own
     record, `hubs` names every hub in that spoke's `HUBS` line too, because every hub of the
     spoke reads the one record
   - its `departs` names the global record, or the global standard rule, that the document
     contradicts
   - the document stays inside the exception's Scope and its `repositories`
5. Only a binding global document counts: an `Accepted` record, an `Active` standard and an
   `Active` exception. The global index lists no other kind.

Precedence is `CLAUDE.md` §4, rank 3: a hub document never overrides a global document, except
inside the scope of an exception that covers it.

| Dimension | What you check | What fails |
|---|---|---|
| Contradiction | each hub record, and each rule of each hub standard, against every global document handed in, by the test above | a contradiction that no exception covers — `CRITICAL`. Name the hub document by its path and line, and the global document by its `global.` id and its `Cite:`. Quote the rule of each. The fix names the three outcomes a person chooses from: change the hub document; request an exception, `/add-context --global --kind exception --departs global.<id> --owner <role>`; or, where the hub record states the global decision after all, supersede it as for a duplicate |
| Exception scope | each hub document that departs under an exception, against that exception's Scope and `repositories` | a departure beyond the Scope or the repositories of the exception it relies on — `CRITICAL`, as a contradiction with no exception |
| Duplicate | each hub record and each hub standard rule against every global document, by the second question and test 3: the same decision, whatever the words | a hub record that repeats a global record — `IMPORTANT`. Name the hub document by its path and line, and the global record by its `global.` id and its `Cite:`. The fix: change the hub record's one `status:` line to `Superseded by global.ADR-<NNN>` in a hub pull request, and change nothing else in it, so designs that cite it still resolve. Where the copy adds rules that the global record does not state, list them in the finding. The fix then also names the choice: keep them in a new hub record that narrows the global record, in the same pull request, or drop them. A hub standard rule that repeats a global rule — `IMPORTANT`. The fix: run `/add-context` for the standard again, as a replacement, which leaves the rule out and cites the global document under Relations |

A narrowing is not a finding. A copy that adds detail is not a narrowing: report it as a copy. A
hub document that bears on no global document is not a finding.
This mode uses `CRITICAL` and `IMPORTANT` only: a matter of taste in a hub document is not the
question this pass answers.

**The output differs from the other modes in three places.** The heading is
`## Review: <prefix> hub — records and standards against global <tag>`. The cycle line is
`Cycle: 1 of 1`, and no revision line follows the reviewer line. In place of the two tables of
§ Output format, write one table keyed on the hub's documents and the spoke records, one row for each one handed
in:

| Hub document | Global documents compared | Outcome |
|---|---|---|
| <id> (<path>) | <global ids, or none bears> | <no finding · CRITICAL — contradicts global.<id> · IMPORTANT — repeats global.<id>> |

    Derived hub documents: <n> · Handed in: <n> · Match: <YES | NO>

A `NO` there means a document was left out, which is an unreviewed document: review it before
you return the verdict.

## Review dimensions — `ticket-review`

The artefacts are a ticket snapshot, `docs/backlog/jira/<KEY>.ticket.md`, and the work item taken
from it, `<KEY>.item.md`. The contract is `.claude/rules/ticket-quality.md` for the snapshot and the
snapshot for the item. Read that rule in full before the first finding. It is path-scoped, and a
runtime does not load it when a seat starts. Review in two halves, and report each finding under the half it belongs to,
because the caller acts on the two differently. A ticket finding goes to the PM. An item finding
goes back to the writer of the item. `/enrich-ticket` dispatches the ticket half alone, on a draft
of the new description. Then you review no item, and the dispatch says so.

| Half | Dimension | What you check | What fails |
|---|---|---|---|
| Ticket | Observable outcomes | each `Then` names something a test can observe: a value, a message, a state, a record | an outcome no observation could disprove, such as "works correctly" or "the content follows the designs" — `CRITICAL` |
| Ticket | Stated values | every time, limit, count and threshold an outcome depends on has a value in the ticket | a value left to engineering, to "the current behaviour" or to "the agreed list", with no value given — `CRITICAL` |
| Ticket | The negative case | at least one criterion says what must not happen | a ticket whose criteria are all the happy path — `IMPORTANT` |
| Ticket | Dependencies | each ticket the story depends on is named, with the direction | a dependency stated only as "relationship to" with no direction, or one the description implies and does not name — `IMPORTANT` |
| Ticket | Designable detail | a designer can name the behaviour to change from the ticket and the code, without asking the PM | content that lives only in a linked design or file the ticket does not quote, where a criterion depends on it — `IMPORTANT` |
| Ticket | One story | the criteria describe one behaviour a person accepts in one review | several behaviours a reviewer would accept separately — `SUGGESTION` |
| Ticket | Placed parts | each line under `## Out of scope` states what the story does not change, and the text under `## Design` is about the design. A line may start with the ticket's own label, such as `Scope boundary:` | an assumption, a dependency or a note under either heading, which fills a part the ticket does not have — `CRITICAL` |
| Item | Fidelity | every item criterion states what its `Carries` criterion states, no more and no less | an outcome, a value or a condition the ticket row does not hold, which is invention — `CRITICAL`; a condition the ticket row holds and the item drops — `IMPORTANT` |
| Item | Coverage | every ticket criterion is carried, or named on a `Not carried: <id> — <reason>` line with a reason the ticket supports | a dropped criterion; an exclusion whose reason the ticket does not support — `IMPORTANT` |
| Item | Acceptance criteria | stable `AC-<n>` identifiers, one observable statement each, at least one negative case | a criterion that fuses two ticket rows into one statement no single test can check — `IMPORTANT` |
| Item | Repository and context | one `Repository:` line, and a `Context:` line whose documents bear on the story, handed to you as text | a document that plainly bears and is missing, or one the story contradicts — `IMPORTANT`. The line's form and pins are `check-intake`'s to fail, not yours |

**The ticket is the PM's, and a gap in it is never yours to fill.** Read each gap as a question for
the PM. Never propose the missing value as a finding's fix: write what is missing and why a design
needs it. `/enrich-ticket` proposes values, from sources, and the PM decides.

The mechanical half of the bar — the table's columns, empty and placeholder cells, the
out-of-scope and design sections, the `Fetched:` line — is `check-intake`'s to fail. Report one of
those only where the dispatch says the check did not run. What the two sections say is yours to
judge, in the Placed parts row.

## Review dimensions — `bug-review`

The artefact is a bug record, `docs/bugs/<KEY>.bug.md`. The contract is the ticket's snapshot inside
it, for the claim, and the code at the commit the record pins, for the chain. The dispatch hands you
the record, the open feature pull requests and the merged designs of the repository, as text, for
the clash row. `check-bug` fails the mechanical half: the sections, the link form, the listed
repository and the revision. Report one of those only where the dispatch says the check did not run.

| Dimension | What you check | What fails |
|---|---|---|
| Claim | the claim states what the snapshot and its comments say: the behaviour, the expectation, the version | a fact the ticket does not hold, which is invention — `CRITICAL`; a condition the ticket holds and the claim drops — `IMPORTANT` |
| Chain | each link opened at its commit holds what its row says, and each follows from the one before | a link whose line does not say what its row says, or a gap between two links — `CRITICAL` |
| Root cause | the last link is a line of code, a value or a documented rule that explains the observed behaviour alone | a last link that is a symptom, or a cause that would leave the reported behaviour in place — `CRITICAL` |
| Pin | the pinned commit is the version the ticket names, or the engineer's, and the record says which | a pin the record does not explain, or a trunk read that shows a later fix the record ignores — `IMPORTANT` |
| Size | `one-fix` is true: one cause, one repository, one review | a second root cause, a second repository or a contract change under `Size: one-fix` — `CRITICAL` |
| Reproduction | the layer and the file show the reported behaviour on the pinned commit, and assert the expectation, not the fix | a test that passes on the pinned commit, or one that asserts the fix's own shape — `IMPORTANT` |
| Files to change | every file is on the chain or beside a link, and the chain's cause is in the list | a file with no tie to the chain, or a root cause in no listed file — `IMPORTANT` |
| Clash | each overlap in the handed-in lists is in the clash report | an overlap the lists show and the report omits — `IMPORTANT` |

**Judge the record, never the fix.** The engineer writes the fix against a frozen test, and a critic
reviews it later. A finding about how to fix is a `SUGGESTION` at most.
`UNRESOLVED — whether pm-critic or dual-mode-critic reviews the bug record. The library says
pm-critic: it holds read-spoke and no write, and the command writes the review file. Owner: Bill.
Resolves: at the review of PLDC-714.`

## Output format

The verdict is a token. Downstream scripts match these lines literally — exact words,
exact casing, nothing appended — and read the key or the slug from the heading above them, so a
review that never names what it reviews fails the check:

    ## Review: <KEY, or the document's or record's SLUG> — <one line: what is under review>

    ### VERDICT: <APPROVED | CHANGES REQUESTED>
    Cycle: <n> of <cap>
    Mode: <feature-review | decomposition-review | ticket-review | bug-review | lld-review | test-review | code-review | global-review>
    Reviewer: <seat name — a charter name, never a person>
    <Design revision | Document revision | Record revision>: <git hash-object of the artefact you read; omit in test-review, code-review and global-review>
    Ticket revision: <ticket-review only: git hash-object of the snapshot>
    Item revision: <ticket-review only: git hash-object of the work item>

    #### CRITICAL
    - [<file>:<line>] <what is wrong> → <the fix>
    #### IMPORTANT
    - [<file>:<line>] <what is wrong> → <the fix>
    #### SUGGESTION
    - [<file>:<line>] <what could be better> → <the fix>

Those two values are the whole set. There is no third: "approved with comments" is a failure, not
a nuance. **Exactly one line of a written review may begin with the verdict heading** — the gate
counts those lines and fails on any count other than one, so never repeat it at the start of
another line, in prose, in a comment or in an example. The match is line-anchored, so indent it,
as this file does, if you must show it twice. The real verdict is the opposite: its `###` is the
first character of its line, never indented, never in a quote or a fence, or nothing reads it.

**The verdict follows from the findings mechanically.** Any `CRITICAL` or any `IMPORTANT`
means `CHANGES REQUESTED`; neither means `APPROVED`, possibly with suggestions attached. You
exercised judgement when you assigned the severities, not here. Omit an empty severity
section rather than writing "none".

**Three token surfaces exist and they are not interchangeable.** `### VERDICT:` is yours.
`## Readiness: READY | NEEDS_WORK | NOT_READY` belongs to persona reviewers, who never emit
a verdict. `GATE_PASS` / `GATE_FAIL` is the design author's self-check inside the design. A
value on the wrong surface either fails the gate or reads as an approval nobody gave.

Then two tables, part of every review in the six modes other than `bug-review` and `global-review`.
`bug-review` carries none: its record has no criteria, and the dimensions table above is its
evidence. `global-review` carries its own table instead (§ Review dimensions — `global-review`). **Acceptance-criterion
coverage** — every row derived by you from the tables and the diff, never copied from the
author's counts:

| AC | Criterion (short) | Covered where | Covered |
|---|---|---|---|
| AC-<n> | <short restatement> | <the named test — plus file:line in test-review and code-review> | YES |
| AC-<n> | <short restatement> | <where, or what is absent> | NO — <what is missing> |

    Derived AC count: <n> · Derived covered: <m> · Author declared: <n> / <m> · Match: <YES | NO>

One row per criterion, deprecated ones included. Any `NO` in that column is at least an
`IMPORTANT` finding with its own entry above — the table is evidence, not a substitute for
the finding. The column is headed `Covered`, never `Verdict`: the verdict is the token at
the top of the review, and one word meaning two things on one page is how a reader takes
the wrong one. In `decomposition-review`, `feature-review` and `ticket-review` the table is keyed
on the source instead — one row per source part, the item or the requirement carrying it under "Covered
where", `NO` where a part is neither carried nor marked out of scope with a reason and an
owner. In `feature-review` the identifier column holds the source part, not a criterion: criteria
there are `REQ-<n>.AC-<m>` and belong to the requirement they are scoped to, and keying the
table on them would report criterion coverage while the unmapped source went unreported.

**Criterion testability** — `feature-review` only, and it is where the criteria get their own
table. One row per `REQ-<n>.AC-<m>` in the document, derived by you from the criteria tables,
deprecated ones included:

| Criterion | Criterion (short) | Testable | Why |
|---|---|---|---|
| REQ-<n>.AC-<m> | <short restatement> | YES | <the observation that would disprove it> |
| REQ-<n>.AC-<m> | <short restatement> | NO | <why no observation could disprove it> |

    Derived criteria: <n> · Testable: <m> · Flagged: <k> · <the flagged identifiers, or NONE>
    Flagged in earlier rounds: <j> · <the flagged identifiers, or NONE>
    - REQ-<n>.AC-<m> — round <r>: <the reason it was flagged> → <how it was resolved>

A criterion is testable when you can name an observation from outside the system that would
disprove it, and that observation goes in `Why` — a `YES` with no observation named is a tick,
not evidence. Any `NO` is at least an `IMPORTANT` finding with its own entry above, so an
approved review always closes on `Flagged: 0`. A criterion whose only gap is a bound marked
`UNRESOLVED` is testable in form: write `YES`, name the marker in `Why`, and leave the open
decision to the marker, which already has an owner. A deprecated criterion reads
`DEPRECATED` in `Testable` and is not counted in `Testable` or `Flagged`.

**The second line carries every flag forward.** Only the approving round is committed, and it
closes on `Flagged: 0`, so without this line a flag raised and fixed inside the loop leaves no
trace in the record. In round 1 it reads `Flagged in earlier rounds: 0 · NONE`. From round 2,
list every criterion an earlier round flagged, once each, with the round, the reason that round
gave and how it was resolved: rewritten, with the new wording; deprecated; or, where the change
list showed it was testable all along, the observation that shows it. Copy the earlier round's
reason as the dispatch hands it to you; never reword it to read better beside the resolution. A
flag still open is not listed here: it is on the first line, and it is a finding.

**Citation spot-check** — sample at least 30% of the artefact's citations, resolve each one
against the cited source yourself, and close with one line stating the arithmetic. It is
omitted in `global-review`, where every finding quotes both documents it compares. Where
the artefact cites nothing, write the line with `m` as zero rather than dropping it: a
reader has to be able to tell "nothing to sample" from "nobody sampled".

    Sampled <n> of <m> citations (minimum 30%) · fabricated or drifted: <k> · <the failing citations, or NONE>

A fabricated citation is `CRITICAL` **and resets the cycle count to zero, once per artefact**
(`.claude/rules/worker-critic.md` § Citation spot-check). Say so in the finding, so the caller
applies the reset rather than counting a round — and say so again on a second fabrication
against the same artefact, which spends no reset and escalates instead. The deterrent is the
control: exhaustive verification is unaffordable, and an author knowing that some citations get
opened is what keeps the rest honest.

**In `lld-review` you rewrite the whole review file each round**, so append one line to its
round history: cycle, date, the verdict named in words, finding count by severity. That list
is the only part of the previous round to survive the rewrite, and it reconciles with the
orchestrator's count. The other modes need none — the orchestrator already keeps each round.

## Verification evidence — `test-review`, `code-review` and `decomposition-review`

**Bare ticks are not evidence. Every row quotes the machine's own words.**

| Check | Command as run | Exit | Evidence (quoted from the output) |
|---|---|---|---|
| <tests> | <command> | 0 | <the runner's summary line, verbatim> |
| <types> | <command> | 0 | <the checker's summary line, verbatim> |
| <check> | <command> | NOT PROVIDED | NOT PROVIDED — returned to the orchestrator |

You hold no shell to run code, so this table records **what the orchestrator passed into your dispatch**
and nothing else. If a result you need was not passed in, write `NOT PROVIDED`, hand the
round back and ask for it — it never counts as a pass, and you never reason around an
absent result or accept the author's word that a check was green.

In `test-review` the rows are the build and type checks at the stubs commit and the suite at
the test commit, where a non-zero exit is the expected result, and one more table follows —
**the red**, one row per new or changed test, each quoted from the orchestrator's log, never
from the test writer's table:

| AC | Test | Outcome at the test commit | The failing line, quoted from the log |
|---|---|---|---|
| AC-<n> | <test name> | <red: assertion · red: not implemented · green · red: wrong reason> | <verbatim> |

Any row other than the first two outcomes is a finding with its own entry above.

**A skipped check with no stated reason is itself a `CRITICAL` finding.** Silence here is
the cheapest way for a defect to reach a merge: either the evidence is in the table, or the
reason it is absent is. The section is omitted in `lld-review`, where no code exists yet and
the pickup gate — reading the trunk, without this design on it — cannot exit zero before the
human gate, so its output would evidence nothing. It is omitted in `feature-review` for the
stronger version of the same reason: the artefact is a document about the business, no
repository check has an opinion on it, and a table of `NOT PROVIDED` rows would read as a
missing control rather than an absent one.

## Delta-only re-review

**On a resubmission you review the change list, the changed regions, and what those
changes could plausibly have broken. Nothing else.**

Whole-artefact re-review keeps the finding count roughly constant across rounds — exactly
how a loop fails to converge — and spends the window on material accepted a round ago. The
worker owes you a change list with every resubmission:

| The resubmission must state | Why you need it |
|---|---|
| What changed, file by file | it defines the delta you are reviewing |
| Which finding each change addresses, by severity and location | it lets you close findings individually rather than re-deriving them |
| Which findings were deliberately not addressed, and why | a disagreement stated is reviewable; a finding silently dropped is not |

**In `lld-review`, cycle 3 is a confirming pass.** The worker fixed the findings of cycle 2 and
changed nothing else. Read those findings and the lines that the fix changed, and nothing else.
Raise a new finding only on a changed line. A matter of taste on a changed line is a `SUGGESTION`,
and it does not block the design.

`global-review` has one round, so it has no resubmission. One case is not a resubmission. When `/feature` amends a requirements document whose pull
request is still open, or `/dev-spec` amends a design whose pull request is still open, round 1
of that run is a first round: review the whole artefact, on fresh context, because the review
file you return replaces the earlier one and vouches for every byte. The dispatch also hands you
the correction — for a design, the person's answers and changes, word for word — and the diff
from the start of the run, so you read there first. In `lld-review`, check that every §9 row the
amendment moved to `Closed` has its answer written into the design where it bears, not only into
the row. Rounds after that are delta only, as here.

**Read the diff first, and hold the change list against it.** On a resubmission the dispatch
also hands you `## Diff since the last review`: the diff between the revision the last review
read and the one you review now. The change list is the worker's own account of its work. The
diff shows every changed byte.

- A change in the diff that the change list does not name is part of the delta. Review it as
  you review a listed change. Name the omission in the review. Its severity is the severity of
  what the change breaks, and an omission that breaks nothing is a `SUGGESTION`.
- A change that the change list names and the diff does not show is not made. The finding it
  claims to address stays open.
- An empty diff means that the worker changed nothing. Every finding of the last round stays
  open.

If the change list or the diff is missing, hand the round back and ask for it. Do not substitute a
whole-artefact re-review — that converts a missing input into a burned cycle. The round
count belongs to the orchestrator: you report the cycle you were told you are on, and you
never decide that an attempt does not count.

## Calibration

**One test for severity: would this block a production deployment?**

If it would, it is `CRITICAL`. If it would not, it is at most `IMPORTANT`. If it is a
matter of taste — naming, ordering, a structure you would have chosen differently — it is a
`SUGGESTION`, and it blocks nothing. Two failure modes sit either side of that line.

- **The rubber stamp** approves everything. Check yourself against the mechanics: did you
  re-derive the counts, open the sampled citations, read the failure paths? An approval
  with no evidence trail behind it is an unreviewed artefact.
- **The trigger-happy critic** escalates every preference to `CRITICAL`, and it is the more
  expensive of the two: marking everything critical trains authors to read severity as
  noise, so the one finding that genuinely blocks a deployment arrives in the same tone as
  a naming preference and gets the same treatment. Severity is a signal to somebody with
  limited attention; spend it accordingly.

## Findings are specific, or they are not findings

Every finding carries a location and a proposed direction. Without a location it is not
actionable; without a direction it hands the work back without the insight to act on.

Useless:

    - The retry logic needs work.

Actionable:

    - [orders/reservation.ts:88] the retry wrapper treats a validation rejection as
      retryable, so a permanently invalid order is attempted three times and then surfaces
      as a transport timeout — AC-5 says it must surface as a rejection → narrow the catch
      to the transport error type and let validation failures propagate to the handler.

The difference is not length. The second names where, what is wrong, the observable
consequence, the criterion it violates and a direction; the first leaves the worker guessing
which of three call sites you meant.

## Escalate — return to the orchestrator without a verdict when

- the artefact is internally inconsistent, or its upstream input is wrong.
- two same-rank sources conflict. Surface both and name the conflict; never pick a winner.
- the work under review is materially outside the scope of its contract.
- an input you need was not passed into the dispatch — a check result, a change list, or
  the mode itself — and the round cannot be judged without it.
- the cap has been reached. The loop stops, you issue no further verdict, and the
  orchestrator escalates to the named role with the artefact in its last reviewed state, the
  deduplicated findings from every cycle, and the specific question the human must answer.
  Reaching a cap is information: the input is ambiguous, and cycle N+1 with a better prompt
  does not resolve an ambiguity.

## Never

- Never edit, reformat, rename or "just fix" the artefact under review. A critic that can
  change the work is a second author, and there is then nobody checking.
- Never add a requirement that is not traceable to the design or to the rules. Something
  missing upstream is a clarification for a human, not a finding against the worker.
- Never approve on the grounds that the checks passed. Green is necessary and not
  sufficient — it says nothing about whether the tests would fail on a regression.
- Never re-review the whole artefact on a resubmission, and never resolve a conflict
  between two sources silently.
- Never choose a mode the dispatch did not name, and never issue a verdict without one.
- Never soften a `CRITICAL` because the deadline is close, or because it is round two.
- Never inherit the worker's session. A reviewer who watched the artefact being written has
  already been persuaded by the reasoning it is their job to test.
- Never mark a check passed on the author's word.
- Never write any file but `docs/designs/<KEY>.lld-review.md`, and only in `lld-review` mode.

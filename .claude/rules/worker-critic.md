---
name: worker-critic
description: Roles, revision caps, delta-only re-review and escalation for the acceptance loop.
globs: ["**/*"]
alwaysApply: true
---

# Rule — the worker–critic loop

**Every meaningful agent output goes through a worker–critic loop before acceptance.**
There is no artefact class exempt from this. If something is not worth reviewing, it is
not worth producing. The pull-request reviewer's findings and the pull-request verifier's
verdicts are not artefacts under this loop — the verifier re-traces every finding before anything
is posted, and nothing posted changes code; every change a comment leads to is.

## Roles

| Role | Does | Must not |
|---|---|---|
| Worker | produces the artefact; fixes findings | judge its own output; approve; skip the loop |
| Critic | judges the artefact; emits the verdict token, and in `lld-review` mode commits it as a review file | rewrite the artefact; add requirements not in the specification; write to any path but its own review file |
| Orchestrator | runs the loop; counts cycles; escalates | produce or edit the artefact |

**The critic is read-only with respect to the artefact.** This is structural, not
stylistic. A critic that can edit the work is a second author, and you no longer have a
review — you have two people writing and nobody checking. It also creates a specific race:
a reviewer mutating the diff *after* approval, so the thing that was approved is not the
thing that merges.

**Read-only with respect to the artefact, not write-nothing — and which of the two depends
on the mode.** In `lld-review` mode the critic commits its own review file, at
`docs/designs/<KEY>.lld-review.md` and nowhere else. That is the one write path on the role,
because a downstream gate reads the file and a verdict nothing persists is not a control. In
`test-review` and `code-review` modes the critic writes no file at all: the verdict returns in-loop, and the
orchestrator persists interim rounds to the system temporary directory and carries the final
verdict into the pull-request description. Nothing downstream reads a file, so there is
nothing for the critic to write. In `global-review` mode, which `/check-global` dispatches, the
critic writes no file either: the command prints the verdict, or copies it into its one pull
request.

Scope the write in the tool layer (`write_allow: ["docs/designs/*.lld-review.md"]`, no edit
tool) and record it on the agent's registry entry, so the exception is one glob wide and auditable
rather than a general write grant. The critic's `Bash` grant is for read-only search only, and that
limit is charter text, because `Bash` can write. The human merge and the diff it reads catch a write
outside the glob. The pickup gate binds the review to the design's blob hash, so a design changed
after its review is unapproved. That glob reaches no artefact under
review in either mode, and the review file is not an artefact any critic reviews.

**Fresh context is non-negotiable.** The critic must not inherit the worker's session.
A critic that has watched the artefact being written has already been persuaded by the
reasoning it is supposed to test.

## Revision caps

| Artefact type | Cap | On reaching the cap |
|---|---|---|
| Per-unit design / low-level design | 3 | the third round is a confirming pass on the open findings. Then ask the runner, and escalate what is left to the named human, flag the item |
| Code (a pull request's worth) | 3 | escalate, leave the branch in its last reviewed state |
| Tests (the stubs and test commits for one work item, `test-review`) | 3 | escalate, leave the branch at its last reviewed test commit; a dispute from the build spends a round |
| QA fix rounds (one `/dev-sprint` fix round after each failing `/qa-sprint` run, on the same pull request) | 2 | escalate to the engineering lead, leave the pull request at its last pushed head; repeated QA failure on one design is a design ambiguity. Each fix round has its own code and test caps above |
| Requirements document | 2 | escalate to the feature owner |
| Project-management artefact (plan, backlog decomposition) | 2 | escalate |
| Pull-request comment fix (one comment, `/dev-sprint` step 10b) | 2 for its test, 2 for its code | nothing of the comment lands; the thread is answered and left open; the next comment goes on |
| Hub records against the global layer (`global-review`, `/check-global`) | 1 | no second round: no worker revises the hub's documents, and a person acts on the findings |
| Ticket intake (a Jira ticket's snapshot and its work item, `ticket-review`) | 2 | stop and hand the ticket findings to the PM through `/enrich-ticket`; an item that still fails is escalated |
| Bug record (a bug's chain to its root cause, `bug-review`, `/bugfix`) | 2 | stop before any branch exists, hand the findings to the engineer, and leave no pull request |

**A machine refusal is a round, and it is not a verdict.** In the code loop of `/dev-sprint`
every engineer submission is finalized before any critic sees it (`scripts/test-guard.mjs`): one
candidate commit built from the engineer's tree with the approved tests as approved, and the
repository's own commands run on it in a checkout of it. An undone test change is not a refusal:
it is counted and does not count. A refusal there is a machine-detected
`CHANGES_REQUESTED` that spends one of the three rounds, and no critic is dispatched on it. It is
recorded as the finalizer's — `verdict_source: finalizer` in the iteration record — never as a
critic's verdict, and a critic is never asked to restate it. A critic reviews only a candidate the
finalizer passed, by its exact commit and tree. And the in-agent guard's refusals and
restorations while the engineer works are neither rounds nor verdicts: the session goes on.

**A request round in `lld-review` is not a revision round.** The critic can ask for spoke
searches and reads one time in each review round, with no verdict. The orchestrator runs them and
dispatches the critic again with the output. That dispatch spends no round of the cap of 2. In
cycle 1 the request round is mandatory, because it holds the critic's own search for the Reach
row. A second `### REQUESTS` block in the same review round is an escalation
(`.claude/skills/review-artefact/SKILL.md` § The request round).

**On cap: stop.** Do not attempt cycle N+1 with a better prompt. Reaching the cap is
information — it means the disagreement is not a quality problem but an ambiguity in the
input, and no number of further cycles will resolve it. Escalate with:

- the artefact in its last reviewed state, unmodified
- the full finding list from every cycle, deduplicated
- the specific question the human needs to answer

Caps exist to stop infinite polish loops. Without them, a working harness becomes
an expensive one.

## Delta-only re-review

On resubmission, the critic reviews **only what changed**, plus anything that change could
plausibly have broken. It does not re-review the whole artefact.

Rationale: whole-artefact re-review makes the critic's finding count roughly constant
across cycles, which means the loop never converges. It also burns the window on material
that was already accepted.

The worker must therefore submit a resubmission with an explicit change list: what was
changed, which finding each change addresses, and which findings were deliberately not
addressed and why.

The change list is the worker's own account, so the orchestrator also hands the critic the diff
since the revision the last review read. Each command that runs a loop says how it stores that
revision. The diff defines the delta. The change list explains it.

## Feedback format

Every finding carries a severity, a location, and a suggested fix.

    ### VERDICT: <APPROVED | CHANGES REQUESTED>
    Cycle: <n> of <cap>
    Mode: <the mode the dispatch named>
    Reviewer: <seat name — a charter name, never a person>

    #### CRITICAL
    - [<file>:<line>] <what is wrong> → <the fix>

    #### IMPORTANT
    - [<file>:<line>] <what is wrong> → <the fix>

    #### SUGGESTION
    - [<file>:<line>] <what could be better> → <the fix>

Rules on the format:

- **The verdict is a token.** Exactly `### VERDICT: APPROVED` or
  `### VERDICT: CHANGES REQUESTED`. Downstream gate scripts read this line literally.
  Variants — different capitalisation, an emoji, "approved with comments" — are failures.
- **All four lines, in that order, every mode.** `Cycle:` says how much of the cap is spent,
  `Mode:` says which dimensions were run, `Reviewer:` says which seat ran them. A verdict missing
  one of them cannot be reconciled against the cap or attributed to a seat, and this file is where
  the four are fixed — a charter or a command that shows fewer is the one that is wrong.
- **A design review names the revision it approved.** `Design revision: <git hash-object of the
  design you read>`. It is what makes the file evidence about a revision rather than about a
  filename, and touching the review later does not renew it.
- **`CRITICAL` blocks acceptance. `IMPORTANT` blocks acceptance.** `SUGGESTION` does not.
- **Suggest fixes, do not merely point out problems.** A finding without a proposed
  direction transfers the work back to the worker without transferring the insight.
- **No finding without a location.** "The error handling is inconsistent" is not
  actionable. "`service.py:212` swallows the timeout that `client.py:88` relies on" is.
- Empty severity sections are omitted, not written as "none".

## Grounding the verdict

A critic's judgement is only worth what it is grounded in. Choose by risk, strongest first:

1. **Deterministic signal** — tests, type checks, a gate script. The critic reports what
   the machine found. Strongest available grounding; prefer it wherever the property is
   mechanically checkable.
2. **A different model provider** — the reviewer runs on a different provider than the
   implementer. Different models have different blind spots, and disagreement between them
   is signal rather than noise.
3. **Zero-context adversarial assessment** — for high-stakes designs, a reviewer with no
   access to the upstream corpus, the reference implementation, or any internal document.
   If the design cannot be followed from its own evidence chain, it is not finished.
4. **Persona review** — a reviewer simulating the specific downstream human who will
   accept or reject the work. Catches the class of error that requires perspective rather
   than analysis.
5. **Single-model self-review** — weakest. Intrinsic self-correction with no external
   signal is documented in the field to fail or actively degrade output. For anything
   high-stakes, treat a self-reviewed artefact as unreviewed.

## Citation spot-check

Where an artefact makes sourced claims, the critic samples at least 30% of citations and
verifies them against the cited source. The deterrent — every author knowing that some
citations will be checked — is the actual control. Exhaustive verification is not
affordable; credible sampling is.

A fabricated citation is a `CRITICAL` finding and **resets the cycle count to zero, once per
artefact.** The reset exists so a worker that invented a source starts the review over rather
than spending a round of a cap it has already half-consumed on a document nobody can trust. It
is bounded at one because an unbounded reset is not a cap: a second fabrication on the same
artefact is not a quality problem, it is evidence the author is not reading its sources, and it
escalates to the named human immediately with the artefact in its last reviewed state. The
orchestrator records the reset; a worker never applies one to itself.

## Prohibited

- A critic editing, reformatting or "tidying" the artefact under review.
- A worker marking its own output accepted.
- Skipping the loop because the change is small. Small changes to high-stakes artefacts
  are exactly where the loop pays.
- Proceeding past the cap.
- A critic adding requirements not traceable to the specification. That is a clarification,
  not a finding.
- Re-reviewing the whole artefact on a resubmission.

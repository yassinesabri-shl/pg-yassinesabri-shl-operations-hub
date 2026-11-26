---
description: Fix the Prime Security findings on one story's open pull request by its number, on demand — wait for Prime's review of the head, resolve the threads that repeat an open finding, let the pr-verifier vote on the rest, sort them, ask the person once, and fix each one that needs a fix with its own commit, under the protected-test guard. No harness review is posted. Owns no transition.
argument-hint: <pr-id>
---

<!-- Part of the harness asset library c6f3b4427d58f7c3 (see VERSION.json) · 2026-10-26 -->

# `/prime-review <pr-id>`

**Purpose.** A person asks the harness to fix Prime Security's findings on a story's pull request
now, without a new harness review. It runs the Prime part of the PR review and of the PR fixes
that `/pr-review` and `/dev-sprint` run, and nothing else. To the person this is the **Prime
fixes**, never a step number (`.claude/skills/fix-pr-comments/SKILL.md` § What the person sees).

**Who runs it.** The `sprint-orchestrator` seat (`.claude/agents/sprint-orchestrator.md`), in the
hub checkout, on the method in `.claude/skills/fix-pr-comments/SKILL.md` § Prime only. It
dispatches every seat and produces nothing itself.

## Inputs

| Input | Form | Where it comes from |
|---|---|---|
| `<pr-id>` | the pull request's number, `^[1-9]\d*$` | The argument; a leading `#` is dropped |
| The repository | one id in `docs/estate/repositories.json` | § Find the pull request |
| `<KEY>` | `^[A-Z][A-Z0-9]{1,9}-\d+$` | the pull request's branch, `feature/<KEY>-<BRANCH-SLUG>` |
| The design, the rules, `checks.env`, `TEST_GUARD_PATHS` | as `/dev-sprint` reads them | its preconditions 1 and 5–8, for `<KEY>` and that repository |
| `PRIME_BOT` and the Prime limits | the `checks.env` read precondition 6 saved | the spoke's trunk |
| The chosen Prime rules | `chosen.md`, the full rule of each guardrail the design's `Guardrails:` line chose | `node scripts/prime.mjs refresh`, as step 3 runs it |

## Find the pull request

As `/pr-review` § Find the pull request: the same three steps, the same stops.

## What it does

1. **The preconditions of `/dev-sprint`, for `<KEY>` in that repository**: the fast-forward of
   the hub checkout that precondition 3 starts with, then 1, 5, 6, 7 and 8, as `/pr-review` runs
   them. The same refusals apply, word for word.
2. **Prime is declared.** `PRIME_BOT` in that `checks.env` names a bot. `none`, or no line: stop
   and say that this repository declares no Prime Security bot in its `checks.env`.
3. **The chosen Prime rules, read again once.** Run `/dev-sprint`'s Prime read of precondition 9:
   `node scripts/prime.mjs refresh --design docs/designs/<KEY>.lld.md --out ../prime
   --since <the commit date of the design's merge on the trunk>`, so the files land in
   `.worktrees/<KEY>/prime`. The pr-verifier and every seat of
   a fix receive `chosen.md` beside the rules. Then `node scripts/prime.mjs history --repo-id
   <REPO-ID> --out ../prime/whole --designs docs/designs`, for the sort. Exit 2, or a line that is `off`, `none` or
   `unchecked`: the fixes go on without the rules, and the summary says so.
4. **The controller**, as the skill's § The controller says.
5. **§ Prime only** of the skill: the wait for Prime's review of the head, then the Prime rounds,
   then the summary.

## Output

- On the branch, one `fix(<KEY>): resolve PRIME-C<n> — <policy>` commit per fixed Prime finding,
  with its `test(<KEY>): PRIME-C<n> …` commit before it where it needed one; a reply in every
  Prime thread worked, resolved when done; a reply in every Prime thread that repeats an open
  finding, resolved; one summary comment; the label `harness-done`, and the
  label `harness-needs-person` where the summary lists anything for a person.
- No harness review, and no `[SHL-R<n>]` comment worked. The work item does not move.

## Never

- Never pick a repository when the number matches more than one: ask.
- Never review a pull request whose branch names no work item.
- Never move a work item: this command owns no transition.
- Never work a comment a person wrote, or a harness `[SHL-R<n>]` comment: `/pr-review` owns those.
- Never merge, approve or request changes, and never edit the description.
- Everything the skill's § Never lists.

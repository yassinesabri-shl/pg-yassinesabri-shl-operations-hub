---
description: Review one story's open pull request by its number and fix what holds — the pr-reviewer writes findings.json, the pr-verifier votes on every finding, the findings that hold are posted as one review, and PR-FIXER fixes each harness comment and each Prime Security finding the verifier holds, one commit each, under the protected-test guard. Owns no transition.
argument-hint: <pr-id>
---

<!-- Part of the harness asset library c6f3b4427d58f7c3 (see VERSION.json) · 2026-10-12 -->

# `/pr-review <pr-id>`

**Purpose.** A reviewer asks the harness to review a story's pull request, the same review
`/dev-sprint` runs at steps 10a and 10b, the PR review and the PR fixes: `pr-reviewer` →
`pr-verifier` → PR-FIXER. To the person they are those two names, never step numbers
(`.claude/skills/fix-pr-comments/SKILL.md` § What the person sees).

**Who runs it.** The `sprint-orchestrator` seat (`.claude/agents/sprint-orchestrator.md`), in the
hub checkout, on the method in `.claude/skills/fix-pr-comments/SKILL.md`. It dispatches every seat
and produces nothing itself.

## Inputs

| Input | Form | Where it comes from |
|---|---|---|
| `<pr-id>` | the pull request's number, `^[1-9]\d*$` | The argument; a leading `#` is dropped |
| The repository | one id in `docs/estate/repositories.json` | § Find the pull request |
| `<KEY>` | `^[A-Z][A-Z0-9]{1,9}-\d+$` | the pull request's branch, `feature/<KEY>-<BRANCH-SLUG>` |
| The design, the rules, `checks.env`, `TEST_GUARD_PATHS` | as `/dev-sprint` reads them | its preconditions 1 and 5–8, for `<KEY>` and that repository |

## Find the pull request

1. For each repository in `docs/estate/repositories.json`, run
   `node scripts/pull-request.mjs show --repo-id <REPO-ID> --pr <pr-id>`. Exit 1 is "no such pull
   request there"; exit 2 is a stop.
2. Keep the pull requests whose `branch=` is `feature/<KEY>-<BRANCH-SLUG>` with a key of the form
   above. Exactly one: that is the pull request. None: stop and say no story's pull request has that
   number. More than one: ask the person which repository, and never pick one.
3. `state=open`, or stop and report the state read.

## What it does

1. **The preconditions of `/dev-sprint`, for `<KEY>` in that repository**: the fast-forward of
   the hub checkout that precondition 3 starts with, then 1 (the pickup gate,
   through the `gate-runner` seat), 5 (the story's `Repository:` line names this repository), 6
   (`checks.env` from that repository's trunk, the read saved), 7 (the rules at the design's
   `Rules:` commit) and 8 (`TEST_GUARD_PATHS`). The same refusals apply, word for word.
2. **The controller**, as the skill's § The controller says.
3. **Step 10a**, then **step 10b**, as the skill says: the review is run again even when one is
   already posted — a comment already posted is skipped, and an open one is fixed in 10b.

### Other escalations

These stops raise an escalation as a cap does, and then stop. Each is one call of
`node scripts/escalation.mjs raise --point <ID> --slug <SLUG> [--work-item <KEY>] --runner <forge login> --question "<the one question>" --by-seat pr-review`
with the options in the last column. Print what the script prints first in the closing report. Exit
2 means the line did not reach the record: say so first, and carry the question in the report.
The sweep tells the people named in `governance/escalation-points.json` and asks again after the
wait of the path. A question in the session (pr-review.which-pr, pr-review.confirmation) writes nothing. pr-review.comment-cap, pr-review.needs-person and pr-review.design-conflict belong to the PR fixes: the fix-pr-comments skill raises one of them, once, after the runner was asked.

| Point | When | Path | Options |
|---|---|---|---|
| pr-review.cannot-run | the pull request is not open, or a script exits 2 | check cannot run | none |
| pr-review.run-stopped | the run stops because the remote diverged, setup refused, or a seat returned without its output | check cannot run | none |
| pr-review.live-data | live data or a working credential appears in a finding | incident | no `--findings-file`: an incident never carries findings, and no pull-request comment carries the detail |

## Output

- One review of type COMMENT on the pull request, its comments `[SHL-R<n>]` and its body
  `docs/designs/_TEMPLATE.pr-review.md`; on the branch, one `fix(<KEY>): resolve <ref> — <title>` commit per fixed comment and per group of Prime findings, with
  its `test(<KEY>): <ref> …` commit before it where it needed one, `<ref>` `SHL-R<n>`, `PRIME-C<n>`, or each `PRIME-C<n>` of a group joined by a comma and a space; a reply in every thread
  worked, resolved when done; one summary comment; the label `harness-done`, and the label
  `harness-needs-person` where the summary lists anything for a person.
- The work item does not move.

## Never

- Never pick a repository when the number matches more than one: ask.
- Never review a pull request whose branch names no work item.
- Never move a work item: this command owns no transition.
- Never merge, approve or request changes, and never edit the description.
- Everything the skill's § Never lists.

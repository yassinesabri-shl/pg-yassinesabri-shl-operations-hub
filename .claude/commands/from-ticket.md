---
description: Take one existing Jira story into the hub as a work item, with no requirements document behind it. Fetches the ticket through the Atlassian MCP, writes a snapshot of it, checks it against the quality bar, writes the work item in /decompose's format, has the critic review both, and opens the intake pull request. A weak ticket stops here, with a comment for the PM. Merges nothing.
argument-hint: <JIRA-KEY>
---

<!-- Part of the harness asset library c6f3b4427d58f7c3 (see VERSION.json) · 2026-11-11 -->

# `/from-ticket <JIRA-KEY>`

**This file is a contract, not an integration.** It defines the procedure, the gates, the
outputs and the stopping condition. The reads from Jira, and the one write on a weak ticket, go
through the Atlassian MCP server in the runtime, as the person signed in. This command holds no
credential.

**Purpose.** Let a team build from the Jira stories it already has. A story written in Jira, with
no requirements document and no decomposition behind it, enters the hub at `TODO`, and the
normal flow runs from `/dev-spec`. Only the feature dependency is relaxed. Every gate after the
intake stays on: the design review, the tests, the coverage floors, the secret scan and the
security review.

**Who runs it.** An engineer, at the hub's root. It dispatches two seats: `product-planner`
writes the work item, and `pm-critic` reviews the snapshot and the item.

**When not to run it.** A story that `/decompose` already cut is in the hub: run `/dev-spec` on
it. A ticket that is an epic, a bug or a task is not a story: this command refuses it.

## Inputs

| Input | Form | Where it comes from |
|---|---|---|
| `<JIRA-KEY>` | `^[A-Z][A-Z0-9]{1,9}-\d+$`, the ticket's key. It becomes the story's key | The argument |
| The ticket | Summary, description, issue type, parent, links, labels and `updated` | The MCP tool `getJiraIssue`, as the person signed in |
| The quality bar | `.claude/rules/ticket-quality.md` | Installed with the hub |
| The snapshot shape | `docs/backlog/_TEMPLATE.ticket.md` | Installed with the hub |
| The list of repositories | `docs/estate/repositories.json` on the trunk | `/add-repo` |
| The surveys | `node scripts/read-survey.mjs`, to suggest the repository the story lands in. A suggestion, never the choice | `/survey-repo` |
| `scripts/read-context.mjs` | `<repository> --at <commit> --names <id>,…`: the story's `Context:` line | Installed with the hub |
| `scripts/check-intake.js` | `--draft <file>` on the snapshot before any seat runs, and `<KEY>` on the intake pull request | Installed with the hub |

**Read first.** Read `.claude/rules/ticket-quality.md` and `.claude/rules/jira-mirror.md` in
full before the first precondition. Both rules are path-scoped. A runtime does not load either one
when this command starts.

## Preconditions

Check every one before the first question. A stop names the precondition that failed.

1. The Atlassian MCP server is installed and the person is signed in. Call the MCP tool
   `atlassianUserInfo`. A reply with an account is a pass. Otherwise print the setup steps that
   `/feedback` prints, and stop. Never ask for a credential. Any Atlassian MCP server the person
   is signed in to will do. Its tools carry the server's prefix, such as
   `mcp__<server>__atlassianUserInfo`, and every tool this file names is that server's.
2. The working directory is the hub's root, and `scripts/check-intake.js` is there.
3. `<KEY>` matches the key pattern.
4. No work item for `<KEY>` is on the trunk under any slug (`docs/backlog/*/<KEY>.item.md`). If
   one is, stop and name it: the story is already in the hub, so run `/dev-spec <KEY>`.
5. No branch `intake/<KEY>` exists, locally or on `origin`. If one does, stop and name it.
6. `node scripts/check-registry.mjs --offline` exits 0, and the list names at least one
   repository.

## The state transition it owns

`(nothing) → TODO`, for a story taken from a ticket. The verification is mechanical: the intake
pull request is merged, and `node scripts/check-intake.js <KEY>` exits 0 on the trunk. The merge is
the person's, never this command's. `.claude/rules/workflow.md` § Transition ownership holds the
whole picture.

## The hub checkout

Make the checkout after step 2 passes, and before the first file is written:

```bash
HUB_TRUNK=$(git ls-remote --symref origin HEAD | awk '$1 == "ref:" && $3 == "HEAD" { sub("^refs/heads/", "", $2); print $2 }')
[ -n "$HUB_TRUNK" ] || { echo "origin reports no default branch. Stop." >&2; exit 2; }
git fetch origin                                                  # or stop; never cut from a stale trunk
git worktree add .worktrees/<KEY>/intake -b intake/<KEY> "origin/$HUB_TRUNK"
# the harness watermark's commit-msg check (.claude/rules/watermark.md); per-worktree config
node scripts/harness-commit.mjs --install-hook ".worktrees/<KEY>/intake" --worktree
```

Then work inside `.worktrees/<KEY>/intake`. A run that stops before step 7 removes the checkout
and the branch, because nothing on them was committed.

## What it does

Ask one question at a time. Give lettered choices. Put the suggested answer first.

1. **Fetch the ticket.** Call `getJiraIssue` for `<KEY>`, with the description as markdown, and
   the fields `issuetype`, `parent`, `issuelinks`, `labels` and `updated`. Stop when the issue
   type is not a story, and say which type it is.
2. **Check where the ticket came from.** Two facts say the story is already in the hub:
   - The ticket carries a label `shl-key-<X>`, which the Jira mirror puts on every ticket it
     makes from a decomposition.
   - A link file under `docs/estate/tracker-links/` on the trunk names the ticket.

   Either one is a stop: the story is `<X>`, so run `/dev-spec <X>`. A third fact asks the person.
   The ticket's parent is the epic a link file records for a decomposition. Then the feature
   exists in the hub and this story was added in Jira alone. Ask:
   (a) stop, and refine that decomposition so the story keeps its requirement trace, or
   (b) continue as a ticket story. Record the answer under the item's Decisions.
3. **Write the snapshot.** Fill `docs/backlog/_TEMPLATE.ticket.md` from the ticket into
   `docs/backlog/jira/<KEY>.ticket.md`, as `.claude/rules/ticket-quality.md` § The snapshot says.
   Copy the ticket's text. Add the `ID` column, numbered `JIRA-<KEY>.AC-1` onwards in the
   ticket's order. Put each part under its heading. Find a part by what the ticket marks it as,
   not by its label: a `Scope boundary` row is the out-of-scope part. Where the label is not the
   heading, start the line with the label. Leave a part empty where the ticket has none.
   Copy `updated` into the `Fetched:` line exactly as `getJiraIssue` returns it, with its fraction
   of a second and its zone, such as `<KEY>@2026-11-05T14:39:05.077+0530`.
   Never fill a part the ticket does not fill: a gap is the PM's to close.
4. **Check the snapshot.** Run `node scripts/check-intake.js --draft docs/backlog/jira/<KEY>.ticket.md`.
   Keep its output for the critic. Exit 1 does not stop the run here: the critic's findings join
   the check's, so the PM gets one list.
5. **Write the work item.** Ask the engineer which repository the story lands in. Suggest one
   from `read-survey.mjs` and the list, and never pick one without the answer. Then read the
   repository at its trunk through `read-spoke.mjs`, and run
   `node scripts/read-context.mjs <repository> --at <commit> --names <id>,…` for the documents
   that bear on the story. Dispatch `product-planner` on
   `.claude/skills/decompose-requirements/SKILL.md` § From a ticket. Hand it the snapshot, the
   repository, the `read-context.mjs` output and the person's answer to step 2, if any. It writes
   `docs/backlog/jira/<KEY>.item.md`.
6. **Review both — the `pm-critic` seat, on fresh context** (`.claude/agents/pm-critic.md`), with
   `Mode: ticket-review` and the method in `.claude/skills/review-artefact/SKILL.md`. Hand it the
   snapshot, the item, the step-4 output, the `read-context.mjs` output, and the two values
   `git hash-object` prints for the snapshot and the item. Keep each round in the system temporary
   directory as `<KEY>-ticket-review-round-<n>.md`. Then act on the verdict:
   - **A ticket finding at `CRITICAL` or `IMPORTANT`, or a check failure from step 4:** the ticket
     is not ready. Go to step 8. A ticket finding is never fixed in the snapshot.
   - **Item findings only:** dispatch `product-planner` again with the findings, and the critic
     reviews the delta. Compute the item's hash with `git hash-object -w`, at every dispatch, so
     that the hub's object store keeps each revision. On the resubmission, put the planner's
     change list and the output of `git diff <item revision of the last round> <new item
     revision>` in the dispatch, under the heading `## Diff since the last review`. Cap two
     rounds. On the cap, escalate to the engineering lead with the
     item in its last reviewed state, and stop.
   - **`APPROVED`:** go to step 7.
7. **Write the review file, commit, open the intake pull request, and stop.**
   1. Write the critic's final round, verbatim, at `docs/backlog/jira/<KEY>.ticket-review.md`,
      with `Ticket revision:` and `Item revision:` the hashes it was handed.
   2. Commit the three files with `node scripts/harness-commit.mjs -m "docs(backlog): take <KEY> from Jira"`.
   3. Run the check on the commit as `intake-gate` will, through a candidate trunk. Exit 0 is the
      only way on. A failure is a defect in steps 3 to 7: fix it on the branch in a new commit,
      and never by editing the review file. Run the block in one shell. It reads the trunk again,
      because a variable from the hub checkout does not reach a later shell.

      ```bash
      HUB_TRUNK=$(git ls-remote --symref origin HEAD | awk '$1 == "ref:" && $3 == "HEAD" { sub("^refs/heads/", "", $2); print $2 }')
      [ -n "$HUB_TRUNK" ] || { echo "origin reports no default branch. Stop." >&2; exit 2; }
      candidate=$(mktemp -d)
      git init --bare --quiet --initial-branch="$HUB_TRUNK" "$candidate/trunk.git"
      git push --quiet "$candidate/trunk.git" "HEAD:refs/heads/$HUB_TRUNK"
      git clone --quiet "$candidate/trunk.git" "$candidate/clone"
      (cd "$candidate/clone" && HARNESS_TRUNK="$HUB_TRUNK" node scripts/check-intake.js <KEY>)
      ```

   4. Push `intake/<KEY>`, and open the pull request against the hub's trunk. Its description
      says where the ticket came from, the `Fetched:` line, and that the person who merges reads
      the snapshot beside the ticket. It ends with the line `Generated-by: SHL Agentic Harness`.
   5. Stop in front of the merge.
8. **On a weak ticket, tell the PM, and stop.** Nothing is committed. Remove the checkout and the
   branch. Draft one Jira comment, in plain English, for the PM:
   - what is missing, one line per gap, from the check and the critic's ticket findings;
   - why the design needs it;
   - the next step: "Please run `/enrich-ticket <KEY>` in your own Claude Code session."

   Show the engineer the comment in full and ask: (a) post it (b) edit it (c) do not post.
   On (a), call `addOrEditJiraIssueComment` with it, then `editJiraIssue` to add the label
   `shl-needs-enrichment`. On (c), print it so the engineer can send it another way.

## Gates it enforces

| Gate | Behaviour on failure |
|---|---|
| The ticket is a story, and no story in the hub already carries it | Refuse, and name the story that does. One key is one story |
| The snapshot is a copy of the ticket, never a rewrite | Refuse to fill a part the ticket leaves empty. The gap goes to the PM |
| The snapshot meets the bar: `check-intake.js --draft` exits 0, and the critic finds no ticket finding at `CRITICAL` or `IMPORTANT` | Stop before any commit, and hand the gaps to the PM (step 8) |
| The repository is the engineer's choice, from the list | Refuse to pick one. A story that names the wrong repository passes every later gate |
| Every ticket criterion is carried, or named on a `Not carried:` line with a reason | Refuse the item. `check-intake.js` fails a dropped or an invented criterion |
| One write to Jira, after the engineer approves its full text | Write nothing else. `.claude/rules/jira-mirror.md` § A ticket that is the source |
| The intake pull request is opened, and never merged by this command | The merge is the person's |

## Output

- On a ticket that meets the bar: an open pull request on `intake/<KEY>` carrying
  `docs/backlog/jira/<KEY>.ticket.md`, `<KEY>.item.md` and `<KEY>.ticket-review.md`, and nothing
  else, with `intake-gate` reporting on it. After the merge, `/dev-spec <KEY>`.
- On a weak ticket: nothing in the hub, and, if the engineer approved it, one comment on the
  ticket and the label `shl-needs-enrichment`.

## Stopping condition

Three outcomes, no fourth:

1. The intake pull request is open with `check-intake.js <KEY>` green through the candidate trunk.
2. The ticket is not ready. The gaps are with the PM, and nothing is committed.
3. A precondition failed, the ticket is not a story, or it is already in the hub. The stop names
   which.

## Never

- Never write the snapshot from memory or from a summary. Copy what `getJiraIssue` returned.
- Never fill a gap in the ticket, in the snapshot or in the item. The PM closes it in Jira.
- Never write to Jira except the one comment and the one label of step 8, after the engineer
  approves the comment. Never edit the ticket's description here.
- Never pick the repository. Ask.
- Never mint a key, and never write to `docs/backlog/keys.json`. The story's key is the ticket's.
- Never write a link file. The Jira mirror does not cover ticket stories in this version.
- Never edit the snapshot or the item after the round that approved them. The review binds both.
- Never merge the intake pull request, and never commit to the trunk.

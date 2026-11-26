---
description: Connect the hub to a Jira board — ask for the site, project, board and a mapping, write docs/estate/trackers.json, and open the pull request that records it. Holds no credential. Merges nothing.
argument-hint: [<BOARD-ID>] | --remove <BOARD-ID>
---

<!-- Part of the harness asset library c6f3b4427d58f7c3 (see VERSION.json) · 2026-10-09 -->

# `/connect-jira [<BOARD-ID>]` · `/connect-jira --remove <BOARD-ID>`

**This file is a contract, not an integration.** It defines the procedure, the preconditions and
the stopping condition. The code host and the pull-request mechanism are yours. In this version
the command writes only a file: it records how the hub will reach Jira, `scripts/check-trackers.mjs`
proves the record well formed, and `scripts/jira-sync.mjs discover` is the one read it may make.

**Purpose.** Tell the hub which Jira board its stories are mirrored to, and what each harness fact
does there, in one file, `docs/estate/trackers.json`. Jira is a read-only view of the repository:
the repository stays the master record, and a hub with no such file has no tracker and behaves
exactly as before. Run once to connect, again to add a board, change the mapping or move to
another site. The file is written by this command and never by hand, as `repositories.json` is
written by `/add-repo`.

**It holds no credential.** The file names the environment variables a developer's own
credential is read from, and nothing else. Every change the mirror makes is made as the developer
who runs the command, so the tracker's history shows who did what.

## Inputs

| Input | Form | Where it comes from |
|---|---|---|
| `<BOARD-ID>` | The hub's own name for the board: lower-case letters, digits and `-`, starting with a letter, at most 30. A second board gets a second id | Asked, with a suggestion made from the project key |
| `--remove <BOARD-ID>` | A board already in the file | The argument, second form |
| `docs/estate/trackers.json` | The connection, against `governance/trackers.schema.json` | This command creates it on the first run and edits it after |
| `.claude/jira/preset-shl.json`, `preset-simple.json` | The mapping of the harness's facts to a workflow: which statuses a ticket is walked through | Installed with the hub |
| `scripts/check-trackers.mjs` | The shape and agreement check, run before the pull request opens | Installed with the hub |

## Preconditions

1. The working directory is the hub root, on a clean checkout of the trunk. This command cuts its
   own branch.
2. Nothing the person types for an environment variable is a credential. A value that is not the
   name of a variable (capitals, digits and `_`, starting with a capital) is refused where it is
   typed, and the refusal does not repeat it.
3. For `--remove`: no link file under `docs/estate/tracker-links/` names the board. A board with
   tickets linked to it is not removed; the refusal names the files.
4. For `--remove` of the default board while others remain: ask which remaining board becomes
   `default_board` before anything is written, and suggest the only one if there is only one.
   Removing the last board deletes `docs/estate/trackers.json`, which returns the hub to having
   no tracker; say so before doing it. An instance no board uses any longer is removed with its
   last board.

## What it does

Ask one question at a time, lettered choices, the suggestion first, as the install interview
does. Where the file already holds an answer, offer it as the suggestion.

1. **The site.** A bare host such as `example.atlassian.net`, never a URL and never a
   credential. The instance id is suggested from its first label.
2. **The project key and the board number.** The key as Jira shows it (`PLAT`), the board number
   from the board's address.
3. **The method and the variable names.** Ask which credential each developer holds:
   - **a) An API token** (suggested). The method is `api-token`. Suggest `JIRA_USER` and
     `JIRA_API_TOKEN`.
   - **b) An OAuth access token.** An app that signs the developer in to Atlassian holds it for
     them. The method is `oauth`. Suggest `JIRA_OAUTH_TOKEN`, and write no user variable,
     because the token says who it is. An OAuth token works only through Atlassian's gateway,
     so ask for the site's cloud id and write `base_url` as
     `https://api.atlassian.com/ex/jira/<cloudId>`. The site gives its cloud id at
     `https://<site>/_edge/tenant_info`.

   These are names only. Say that each developer sets the values in their own environment, and
   that the token is theirs.
4. **The mapping.** Offer the two shipped presets and say what each does:
   - **`shl`**: a Story walks Backlog → In Analysis → Ready for Development → In Development →
     Awaiting Code Review, and a Defect sub-task Backlog → In Development. The harness stops
     there; every later step is a person's.
   - **`simple`**: Backlog → In Progress → In Review. The harness never moves a ticket to Done.
   In both, a merge and a validation add a label and a comment and move nothing. Copy the chosen
   preset's `types` into the file. If the person's workflow differs, ask for the status names of
   a route in order, from where the move may start to its target, one move at a time, replace
   that move's `route`, and let `check-trackers.mjs` prove the result. A move the workflow has no
   step for is left out: that fact then adds a label and a comment and moves nothing.
5. **The sprint and the Epics.** `sprint`: `report` (suggested) says whether a ticket is in the
   board's active sprint; `add` puts it there. `epics`: `ask` (suggested) has `/decompose` ask
   which Epic a decomposition's stories go under and offer to create one; `none` for a board that
   does not use Epics. No Epic key is ever stored here.
6. **Write the file on a branch.** Cut the branch, then create the file on the first run, or
   edit the one board and the instance it names. Set `default_board` to this board on the first
   run, and ask on a later run. Run the check, and stop unless it exits 0.

   ```bash
   git checkout -b estate/connect-<BOARD-ID>
   node scripts/check-trackers.mjs                    # exit 0 or stop
   ```

7. **The status ids and the sprint field.** Optional, and recorded when known: each status
   name's numeric id from Jira's workflow page, and the sprint field's id. They let the mirror
   tell a renamed status from a different one. Leaving them out is valid; `check-trackers.mjs`
   says nothing about their absence. Where the person has set their own credential variables,
   read both from the board with the file the branch holds:

   ```bash
   node scripts/jira-sync.mjs discover <BOARD-ID> --draft
   ```

   `--draft` reads the file from the working tree, because the trunk does not hold this
   connection yet. The command prints JSON and writes nothing, and its output is the value to
   record. It also lists the project's issue types. A preset's `issue_type` names must match
   them exactly (one site calls its sub-task type `Subtask`, another `Sub-task`), so correct
   them here.
8. **Commit and open the pull request.** Run the check again after every edit of step 7.

```bash
node scripts/check-trackers.mjs                      # exit 0 or stop
git add docs/estate/trackers.json
node scripts/harness-commit.mjs -m "chore(estate): connect <BOARD-ID> to <INSTANCE-ID>"
# open the pull request in the hub, its description ending with the watermark line
```

The pull request carries one file. Say in its description which preset was chosen and that no
credential is in it.

## Stopping condition

Done when the pull request is open and `check-trackers.mjs` exited 0 on the branch. Not done, and
nothing opened, when any precondition fails or the check exits 1. Exit 2 from the check is an
escalation: say what could not be read.

## Never

- Never ask for, accept or write a token, a password or a key. A value typed where a variable
  name belongs is refused.
- Never write a URL with a credential in it, or a site with a scheme.
- Never edit `docs/estate/trackers.json` by hand, and never write a link file: those belong to
  the Jira mirror's sync script, in a later version of this library, and are never typed.
- Never merge the pull request. A merge is a person's act.

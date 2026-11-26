---
description: Change or remove the Confluence connection of the context sync — show docs/estate/confluence.json, ask what changes (site, space, Key decisions folder, mode, the Scope paths), prove it against Confluence with confluence-sync.mjs discover, and open the pull request that records it. Holds no credential. Merges nothing.
argument-hint: [--show] | --remove
---

<!-- Part of the harness asset library c6f3b4427d58f7c3 (see VERSION.json) · 2026-11-26 -->

# `/connect-confluence` · `/connect-confluence --show` · `/connect-confluence --remove`

**Purpose.** Keep `docs/estate/confluence.json` right. The file tells the context sync
(`scripts/confluence-sync.mjs`, PLDC-712) where this repository's ADRs and standards live in
Confluence. The install writes it with SHL's values: the site `https://shl.atlassian.net`, the
space `PN`, and the id of its Key decisions folder. Run this command to change one of them, to set
the paths of the Scope boxes, or to turn the sync off. The file is written by this command and never
by hand, as `repositories.json` is written by `/add-repo`.

**It holds no credential.** The file names no secret. The `context-sync` workflow reads the service
account from the repository secrets `HARNESS_CONFLUENCE_USER` and `HARNESS_CONFLUENCE_TOKEN`. To
prove a change, this command reads Confluence as the person who runs it, with their own
`CONFLUENCE_USER` and `CONFLUENCE_API_TOKEN` from their environment. They set both in their own
terminal, never in this session.

The same command serves a hub and the global context repository. The level comes from the
repository: a hub has a key ledger, `docs/backlog/keys.json`, and syncs the folder
`Key decisions > hubs > <HUB KEY>`. The global context repository has none, and syncs
`Key decisions > global`.

## Inputs

| Input | Form | Where it comes from |
|---|---|---|
| `--show` | Print the connection on the trunk and what `discover` finds, and change nothing | The argument |
| `--remove` | Delete the connection, so the sync does not run here | The argument |
| `docs/estate/confluence.json` | `{ schema_version: 1, site, space, root_folder, mode, scopes }` | The install writes it. This command edits it |
| `docs/estate/surveys/*.md` | The hub's service surveys, the layout of each spoke | A hub only, to draft the Scope paths |
| `scripts/confluence-sync.mjs discover` | The one read this command makes of Confluence | Installed with the sync |

## Preconditions

1. The working directory is the repository root, on a clean checkout of the trunk. This command
   cuts its own branch.
2. The level is known: `hub` when `docs/backlog/keys.json` is on the trunk, else `global`.
3. To prove a change, the person has set `CONFLUENCE_USER` and `CONFLUENCE_API_TOKEN` in their own
   environment. Without them, say how to set them and stop. Never ask for the token here.
4. Nothing typed is a credential. A site with a user or a token in it, or a value that looks like a
   token, is refused where it is typed, and the refusal does not repeat it.

## What it does

Ask one question at a time, lettered choices, the suggestion first. The value on the trunk is
always the suggestion.

1. **Show the connection.** Read the file on the trunk and run:

   ```bash
   node scripts/confluence-sync.mjs discover --level <LEVEL>
   ```

   Print the site, the space, the mode, the Key decisions folder with its title, the run's folder,
   its "ADRs - …" and "standards - …" folders and their page counts, and anything `missing`. For
   `--show`, stop here.
2. **The site.** An `https://` address such as `https://shl.atlassian.net`, with no path, user or
   token.
3. **The space key.** As Confluence shows it, for example `PN`.
4. **The mode.**
   - **a) `gateway`** (suggested). An API token with scopes works only through
     `api.atlassian.com`. The sync finds the site's cloud id itself.
   - **b) `site`.** A classic API token, with no scopes, on the site's own address.

   Ask which kind of token the service account holds. If unsure, suggest `gateway`.
5. **The Key decisions folder.** Its id, the number in the folder's address. To find it, run:

   ```bash
   node scripts/confluence-sync.mjs discover --level <LEVEL> --draft --find-root
   ```

   and offer each folder in `candidates` with its id.
6. **The Scope paths (a hub only).** For each box that is not a language, ask for its paths in this
   estate: Backend, Frontend, Data and database, and CI/CD and infrastructure. Draft each from the
   surveys: the folders each spoke's survey gives for that kind of code, as a design names its paths.
   The person accepts, edits or skips the draft. A skipped box keeps its empty list, `[]`: a
   standard that ticks it is still synced, with that box left out of its globs, and the run lists
   it. Keep all four keys in the file, so the next person sees which boxes have no paths. In the
   global context repository, keep the four lists empty and say why: a global standard cannot know
   one hub's layout, so its boxes other than the languages map to no paths.
7. **Write the file on a branch, and prove it.**

   ```bash
   git checkout -b estate/confluence-connection   # not estate/connect-<id>, which /connect-jira owns
   # write docs/estate/confluence.json
   node scripts/confluence-sync.mjs discover --level <LEVEL> --draft
   ```

   `--draft` reads the file from the working tree, because the trunk does not hold the change yet.
   Exit 0: every folder is found. Exit 1: a folder is missing, and the output names it. Say who
   creates it (a person with edit rights on Key decisions), and carry the list into the pull
   request. Exit 2: Confluence or the credential cannot be reached. Stop, and open nothing.
8. **For `--remove`.** Delete the file on the branch instead, and say that the `context-sync`
   workflow then does nothing in this repository.
9. **Commit and open the pull request.** In a hub, commit through the harness's helper. The global
   context repository has none, so commit with the watermark paragraph, as its `/add-context` does.

   ```bash
   git add docs/estate/confluence.json                  # or: git rm, for --remove
   node scripts/harness-commit.mjs -m "chore(estate): connect the Confluence context sync"   # a hub
   git commit -m "chore(estate): connect the Confluence context sync" -m "Generated-by: SHL Agentic Harness"   # the global repository
   # open the pull request, its description ending with the watermark line
   ```

   The description says what changed, what `discover` found, and that the workflow needs three
   repository secrets: `HARNESS_CONFLUENCE_USER`, `HARNESS_CONFLUENCE_TOKEN`, and
   `HARNESS_CONTEXT_SYNC_TOKEN`, which lets the sync's pull request start the required checks.

## Stopping condition

Done when the pull request is open and `discover --draft` exited 0 or 1 on the branch. Not done,
and nothing opened, when a precondition fails or `discover` exits 2 or 3.

## Never

- Never ask for, accept or write a token, a password or a key. The file holds no secret.
- Never write to Confluence. `discover` only reads.
- Never edit `docs/estate/confluence.json` by hand.
- Never merge the pull request. A merge is a person's act.

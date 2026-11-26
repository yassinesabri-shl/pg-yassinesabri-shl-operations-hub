---
description: Print a short, readable picture of this hub and of every spoke on its list — what the estate is, which repositories it plans for, and what each one does — from the files on the hub's trunk. Reads no remote. Writes nothing. Asks nothing.
argument-hint: (no arguments)
---

<!-- Part of the harness asset library c6f3b4427d58f7c3 (see VERSION.json) · 2026-10-22 -->

# `/estate-overview`

**This file is a contract, not an integration.** It defines the procedure, the inputs and the
stopping condition. Nothing in this command talks to a tracker, a code host or a remote
repository.

**Purpose.** Give a person who opens the hub one page that says what this estate is and which
repositories belong to it. A new team member reads it first. A lead reads it before a feature,
to recall which spoke owns what. The command reads the hub's own files and prints two things: a
short description of the hub, and one table with one row per spoke. It reads only what the hub
already holds. It does not judge, survey or refresh anything: `/add-repo` and `/survey-repo` do
that.

**Who runs it.** A person types it in the hub. It dispatches no seat and runs no model other than
the session that reads this file. No CI job runs it, and no gate reads its output.

## Inputs

Every input is a file in the hub's working tree. An absent optional file is a fact to report,
never a stop.

| Input | Form | Where it comes from | Required |
|---|---|---|---|
| `docs/estate/repositories.json` | The list of spokes: for each id, `url`, `checks`, `purpose` and `readAt` (`governance/repository-registry.schema.json`) | `/add-repo` | Yes. The hub install writes an empty one |
| `scripts/check-registry.mjs` | With `--offline`: the shape of the list, with no remote asked | Installed with the hub | Yes |
| `docs/estate/overview.md` | The estate overview, kind `estate-overview`: its header `description`, §1 "What the system does", §2 "The parts" with one row per spoke and who to ask, and §4 "Outside the estate" | `/add-context --kind estate-overview` | No |
| `README.md` | The hub's own README. Its H1 and first paragraph name the hub when no overview exists | The team | No |
| `docs/backlog/keys.json` | The key ledger. Its `prefix` is the hub's key prefix, for example `SVC` | The hub install, then `/decompose` | No |
| `docs/harness-install.json` | The install receipt. `library.harnessVersion` is the library version this hub runs, and `hub.trunk` its trunk | The hub install and the upgrade | No |
| `docs/estate/global.json` | The link to the global context repository: its `url` | `/check-global --connect` | No |
| `docs/estate/trackers.json` | The tracker connection: its `default_board` and each board's `project` | `/connect-jira` | No |
| `docs/estate/surveys/<ID>.md` | One service survey per surveyed spoke. Its header `commit` is the commit the spoke was read at | `/survey-repo` | No |
| `docs/requirements/*/`, `docs/backlog/*/*.item.md`, `docs/designs/*.lld.md` | The hub's requirements documents, stories and designs. Counted, never opened | `/feature`, `/decompose`, `/dev-spec` | No |

## Preconditions

Both, checked before anything is read.

1. The working directory is a hub root: `docs/estate/repositories.json` exists. A folder without
   it is not a hub. Say so, and stop. A spoke has no list, and this command has nothing to show
   there.
2. `node scripts/check-registry.mjs --offline` exits 0. Exit 1 means the list does not have the
   shape the schema gives. Print the script's findings, name `/add-repo` as the command that
   writes the list, and stop. Exit 2 means the list is missing: precondition 1 applies.

## What it does

```bash
node scripts/check-registry.mjs --offline                 # the shape of the list, or stop
# read docs/estate/repositories.json, docs/estate/overview.md, README.md, docs/backlog/keys.json,
#      docs/harness-install.json, docs/estate/global.json, docs/estate/trackers.json,
#      docs/estate/surveys/<ID>.md for each id, and count the requirements, stories and designs
# print section 1, the hub; then section 2, the table of spokes; then section 3, the next steps
```

Step by step, and what each step may and may not do.

1. **Read the list.** Take every id under `repositories`, in the order the file holds them. For
   each id keep `url`, `checks`, `purpose` and the first 12 characters of `readAt`. The list is
   the only source of the spokes. A spoke that the overview names and the list does not carry is
   reported in step 4, never added to the table as a spoke.
2. **Read the hub's description.** Prefer `docs/estate/overview.md`. Take its header
   `description`, its §1 paragraph, and from §2 the "What it is for" and "Who to ask" cells of
   each row, keyed by the id in the first cell. Take §4's rows as the systems outside the estate.
   Without an overview, take the H1 and the first paragraph of `README.md`, and say that the hub
   has no estate overview yet. Without both, say that the hub has no description, and go on.
3. **Read the hub's facts.** Each one is optional, and an absent one prints as `none`:
   - the key prefix from `docs/backlog/keys.json`
   - the library version and the trunk from `docs/harness-install.json`
   - the global context repository's URL from `docs/estate/global.json`
   - the tracker: the `default_board` and its `project` from `docs/estate/trackers.json`
   - the counts: folders under `docs/requirements/` that hold a requirements document, files
     `docs/backlog/*/*.item.md`, and files `docs/designs/*.lld.md`. A file or folder whose name
     starts with `_TEMPLATE.` is a template, never counted
   - for each spoke, whether `docs/estate/surveys/<ID>.md` exists, and its header `commit`
4. **Print the overview.** Three sections, in this order, in plain text with Markdown tables.

   **Section 1 — This hub.** The hub's name: the overview's estate name from its H1, or the
   README's H1, or the folder name. Then the description from step 2, at most six sentences,
   quoted as the file has it and never reworded. Then one table of facts:

   | Fact | Value |
   |---|---|
   | Key prefix | `<prefix>`, or `none — no key ledger yet` |
   | Library version | `<harnessVersion>` on trunk `<trunk>`, or `none — no install receipt` |
   | Global context repository | `<url>`, or `none — connect one with /check-global --connect <url>` |
   | Tracker | `<default_board> → <project>`, or `none` |
   | Requirements · stories · designs | `<n> · <n> · <n>` |
   | Spokes on the list | `<n>` |

   **Section 2 — The spokes.** One table, one row per id from step 1, in the list's order. With
   an empty list, print the sentence `No spoke is on the list yet. Add one with /add-repo <URL>.`
   and no table.

   | Spoke | What it does | What it is for · who to ask | Survey | Read at |
   |---|---|---|---|---|
   | `<id>` | The `purpose` from the list, cut after its second sentence. When the text is cut, end the cell with `…` | The overview's §2 cells for this id, as `<what it is for> · <role>`. Without an overview row: `not in the overview` | `yes` when `docs/estate/surveys/<id>.md` exists, with the first 12 characters of its `commit`. Otherwise `none` | The first 12 characters of `readAt` |

   Below the table, one line per spoke with its clone URL and its commands file:
   `<id>: <url> · checks: <checks>`. The URLs stay out of the table so that the table stays
   narrow.

   Then, when the overview has §4 rows, a short table of the systems outside the estate: System,
   What it does, Who owns it, as the overview has them.

   **Section 3 — What needs a person.** A bulleted list, and only the bullets that apply:
   - `The hub has no estate overview. Write one from docs/estate/_TEMPLATE.overview.md and place it with /add-context <file> --kind estate-overview --owner <role> --revision <date> --origin <text>.`
   - `<id> has no survey. Run /survey-repo <id>.` One bullet per spoke without a survey, or one
     bullet `<n> spokes have no survey. Run /survey-repo --missing.` when more than three lack one.
   - `<id> is in the overview and not on the list.` One bullet per §2 row whose id the list does
     not carry.
   - `<id> is on the list and not in the overview.` One bullet per listed id with no §2 row,
     when an overview exists.
   - `The list may be stale. Run node scripts/check-registry.mjs to ask each remote.` Always, as
     the last bullet, because this command never asks a remote.

   With nothing else to list, section 3 holds the last bullet alone.

## Output

Printed text only: the three sections above. Nothing is written to disk, and no file in the hub
changes. The description in section 1 and the `purpose` cells in section 2 are the files' own
words, cut and never reworded, so that a reader can find them again in the file.

## Stopping condition

The three sections are printed. Then stop.

## Never

- Never write, edit, commit or push anything. This command has no branch and no pull request.
- Never ask a remote: no `git fetch`, no `git ls-remote`, no clone. Staleness is
  `check-registry.mjs`'s to report, and the last bullet of section 3 names it.
- Never add a spoke to the table that `docs/estate/repositories.json` does not carry. The list is
  the only list.
- Never reword a `purpose` or the overview's text. Cut it, and mark the cut with `…`.
- Never invent a description, a role or a count. An absent file prints as `none`.
- Never dispatch a seat or run a model for this. The files hold every answer.

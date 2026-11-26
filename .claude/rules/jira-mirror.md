---
name: jira-mirror
description: The optional Jira mirror: one write path, the developer's own credential, when it runs, and what it never does.
globs: ["scripts/jira-*.mjs", "docs/estate/trackers.json", "docs/estate/tracker-links/**"]
alwaysApply: false
paths: ["scripts/jira-*.mjs", "docs/estate/trackers.json", "docs/estate/tracker-links/**"]
---

# Rule — the Jira mirror

<!-- Part of the harness asset library c6f3b4427d58f7c3 (see VERSION.json) · 2026-10-15 -->

Jira is a read-only view of the repository. The repository stays the master record of every story,
and nothing in Jira decides a gate, a command or a seat's work. A hub with no
`docs/estate/trackers.json` has no tracker, and none of this applies.

## One write path

- **`scripts/jira-sync.mjs` is the only thing that writes to Jira.** A command calls it at the
  point it names; no seat, agent or person's session makes a Jira call by any other route, and a
  Jira MCP is not used to write. This is the one sanctioned write path `connector.md` asks for.
  The one exception is a story whose source is its ticket, in § A ticket that is the source.
- **It acts as the developer who runs the command.** Their own `JIRA_USER` and `JIRA_API_TOKEN`
  (the names `trackers.json` gives), read from their environment, never from a file and never
  typed into a message. Every change in Jira's history is therefore theirs. There is no shared
  or service account and no sync in CI.
- **An OAuth connection is the same rule with one variable.** Where `trackers.json` gives the
  method `oauth`, the one variable it names holds the developer's own OAuth 2.0 access token. An
  app that signs the developer in to Atlassian holds that token and sets the variable. The token
  is theirs, so every change is still theirs.
- **The call is the authorisation.** The developer who ran the command is the person making the
  change; the script prints who it is acting as before it writes. No seat holds `tracker-write`.

## What it may do, and when

| When | The call | What changes in Jira |
|---|---|---|
| `/decompose`, second invocation: the decomposition pull request is merged and `check-decomposition.js` exits 0 on the trunk | `create <SLUG>` with `--epic` or `--create-epic` | One ticket per story, in Backlog, under the Epic the person chose. Its description carries a Context section: the story's `Hub commit:` line with its date, the `Global:` release of its requirements document, and one row per `Context:` entry with its pin and where the trunk stands at create time. No later call edits it |
| `/dev-sprint`, first invocation, once the gate has passed and the worktree is live | `apply <KEY> --fact started` | The ticket walks to Ready for Development (if the design is on the trunk) and then to In Development |
| `/dev-sprint`, once the non-draft pull request is open with every check green | `apply <KEY> --fact in-review --pr <url>` | The ticket moves to Awaiting Code Review |
| `/qa-sprint`, final run: the code pull request reports `MERGED` and `check-validation.js` exits 0 on the trunk | `apply <KEY> --fact merged --pr <url>` | The label `shl-merged` and one comment; no move |
| `/qa-sprint`, final run, after the call above | `apply <KEY>` | The label `shl-validated` and one comment; no move |
| Any command that raises an escalation for a story (`escalation.mjs raise` prints the line) | `apply <KEY> --fact needs-person --link <url>` | The label `shl-waiting-on-human` and one comment with the link; no move, and never a new ticket |
| The run that resolves it (`escalation.mjs resolve` prints the line) | `apply <KEY> --fact person-answered` | The label comes off; no move |

No command calls `create <KEY>`. `/qa-sprint` raises no defect item, because a failing validation
goes back to `/dev-sprint` before the code merge. The call remains for a defect item that the key
ledger already holds: it makes that defect's ticket as a sub-task of its story's ticket.

The link file `docs/estate/tracker-links/<SLUG>.json` is how the repository remembers which ticket
is which. The script commits it on `harness/tracker-links-<SLUG>`; the command pushes that branch
and opens a pull request carrying that one file. Its merge is bookkeeping: no gate reads it.

A move is made one hop at a time along the route `trackers.json` names for that fact, each hop
only through the one transition Jira offers that leads to the next status, and only once per
ticket: when the route is complete the ticket is labelled `shl-applied-<fact>`, and a ticket
carrying that label is never moved for that fact again. A person who sends a ticket back
therefore stays sent back. A ticket found already at the target, however it got there, is marked
the same way and not moved. A hop that cannot be taken leaves the ticket where it stands, labelled
`shl-waiting-on-human` with one comment saying why, and the next run starts from there; the label
comes off once a run gets a ticket somewhere and nothing is left stuck. A later pull-request fact
retries the earlier ones in order, so an `in-review` that finds a ticket behind because `started`
failed takes both hops. A comment counts as the harness's only if the acting developer wrote it and
it begins with the marker; a person's comment that starts the same way does not stand in for it. A
ticket in a Done status is never added to the active sprint.

## What it never does

- **Never move a ticket past what the mapping names, and never to Done.** Tech, Architect and
  Director review, CAB, UAT, release assurance and acceptance are a team's own steps. The harness's
  `DONE` means the validation report passed; it is not the tracker's Done.
- **Never make a ticket for work the trunk does not prove queued**, and never a second ticket for
  a key. Before it makes one it looks for a ticket carrying the key's label, `shl-key-<KEY>`.
- **Never recreate a ticket a person deleted**, and never follow a ticket moved to another project.
- **Never ask for an Epic key in configuration.** Which Epic is a choice for the people doing the
  work, so the command asks, once per decomposition, and the link file records the answer.
- **Never push, merge or open a pull request itself.** The code host is the command's.
- **Never put more in Jira than the title, the harness key and where to find the work.**
  Requirement text and acceptance criteria stay in the repository. A ticket that is the source
  of its story is the exception, in the section below.
- **Never block.** A failed call is reported and the command carries on. Exit 1 is a verified
  failure (a duplicate, a missing required field), exit 2 is "cannot verify" (Jira unreachable,
  a refused credential); either way, running it again is safe, because what it made is found by
  its label.

## A ticket that is the source

`/from-ticket` takes a story from a Jira ticket that a person wrote, not from a requirements
document. For that story the ticket is the source, and the repository holds a snapshot of it
(`docs/backlog/jira/<KEY>.ticket.md`). Its acceptance criteria are the PM's, so they belong in the
ticket. Two commands write to such a ticket. Each writes through the Atlassian MCP, as the person
signed in to it, and only after that person approves the full text in the session:

| Command | Who runs it | What it writes |
|---|---|---|
| `/from-ticket`, when the ticket fails `ticket-quality.md` | the engineer | One comment that lists the gaps, and the label `shl-needs-enrichment` |
| `/enrich-ticket` | the PM | The new description, which keeps the PM's text and marks every addition; the label `shl-enriched` added and `shl-needs-enrichment` removed; one comment that lists the additions |

Nothing else is written, and the rest of this rule still binds. No seat calls the MCP to write.
`/enrich-ticket` reads the ticket again before it writes, and stops when the ticket changed since
the PM saw it. A story taken from a ticket is not mirrored in this version: it has no link file,
so `jira-sync.mjs apply <KEY>` exits 1 for it, and the command that called it reports that and
carries on.

## What it cannot close

- **The label is how a ticket is found.** A person who removes a ticket's `shl-key-<KEY>` label,
  before its link file is merged, makes it invisible to the search, and the next `create` may make
  another. The link file is the durable reference: merge it promptly.
- **Nothing locks two people against each other.** Two people running `create` for one
  decomposition at once, or on two machines, can each make the tickets: the script holds no lock
  in Jira or in the repository, and the label search is the only guard. The next run finds the
  duplicates by their labels and reports them without choosing one.
- **Jira's search index lags, and the sync only narrows that.** It looks, pauses and looks again;
  after a create whose outcome Jira never confirmed it looks up to three times
  (`HARNESS_JIRA_SEARCH_LOOKS`, between two and ten, with `HARNESS_JIRA_SEARCH_LAG_MS` between
  looks). That note is kept in the checkout's own `.git`, so a run on another machine, or by
  another person, gets the two ordinary looks. A ticket still out of the index after the last look
  is not seen, and a second one can be made beside it. If a ticket exists with no link, running
  `create` again adopts it once the index has caught up; waiting a minute before running it again
  after a failure costs nothing.
- **The Epic is chosen once.** The Epic a decomposition's link file records, on the trunk or on its
  unmerged `harness/tracker-links-<SLUG>` branch, is the one its stories go under: a different
  `--epic` is refused as a usage error, and `--create-epic` reuses the recorded one. Correct a
  wrong Epic in a pull request on the link file, or delete the unmerged branch, before running again.
- **A squash-merged link branch is cut again**, not added to, once everything it recorded is in the
  trunk. A branch someone else has pushed and still holds is theirs to delete.
- **A name the sync compares is English.** The Epic type is matched as `Epic`, and statuses by the
  names in `trackers.json`.

## Where the rest is

The connection is `docs/estate/trackers.json`, written by `/connect-jira`.

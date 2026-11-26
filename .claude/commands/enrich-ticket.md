---
description: For a PM. Bring one Jira story up to the quality bar before the harness designs from it. Lists what the ticket is missing, proposes what its sources support, asks the PM for the rest, shows the whole new description, and writes it to Jira through the Atlassian MCP only when the PM approves. Keeps the PM's text. Writes nothing to the hub.
argument-hint: <JIRA-KEY>
---

<!-- Part of the harness asset library c6f3b4427d58f7c3 (see VERSION.json) · 2026-11-11 -->

# `/enrich-ticket <JIRA-KEY>`

**This file is a contract, not an integration.** It defines the procedure, the gates and the
stopping condition. Every read from Jira and the one write go through the Atlassian MCP server in
the runtime, as the PM signed in to it. This command holds no credential.

**Purpose.** A weak ticket gives a weak design. This command fixes the ticket before any design
starts, with the PM who owns it. It finds what the ticket lacks against
`.claude/rules/ticket-quality.md`, the same bar `/from-ticket` and `intake-gate` apply. It
proposes only what a source supports. It asks the PM for everything else. Nothing reaches Jira
until the PM has read the whole new description and approved it.

**Who runs it.** The PM who owns the ticket, in their own Claude Code session, in a clone of the
hub. Usually after `/from-ticket` stopped on the ticket and labelled it `shl-needs-enrichment`. It
dispatches two seats: `feature-writer` drafts the additions, and `pm-critic` reviews the draft
against the bar. Only the command talks to the PM.

**What the PM sees.** Plain English. No file path, no git, no exit code. The ticket as it stands,
the ticket as proposed, and one question at a time.

## Inputs

| Input | Form | Where it comes from |
|---|---|---|
| `<JIRA-KEY>` | `^[A-Z][A-Z0-9]{1,9}-\d+$` | The argument |
| The ticket | Summary, description, issue type, parent, links, labels and `updated` | The MCP tool `getJiraIssue`, as the PM |
| Linked tickets and the parent epic | Their summaries and descriptions | `getJiraIssue`, for each key the ticket links |
| The quality bar | `.claude/rules/ticket-quality.md` | The hub clone |
| The code, where the PM can read it | `node scripts/read-spoke.mjs <id> <path>`, at a pinned commit | The hub clone. A PM with no read access to the spoke skips it |
| The PM's answers | One numbered note per answer, word for word | The questions in step 4 |

**Read first.** Read `.claude/rules/ticket-quality.md` and `.claude/rules/jira-mirror.md` in
full before the first precondition. Both rules are path-scoped. A runtime does not load either one
when this command starts.

## Preconditions

1. The Atlassian MCP server is installed and the PM is signed in. Call `atlassianUserInfo`. A
   reply with an account is a pass. Otherwise print the setup steps that `/feedback` prints, and
   stop. Never ask for a credential. Any Atlassian MCP server the PM is signed in to will do. Its
   tools carry the server's prefix, such as `mcp__<server>__atlassianUserInfo`, and every tool
   this file names is that server's.
2. The working directory is the hub's root, and `scripts/check-intake.js` is there.
3. `<KEY>` matches the key pattern, and the ticket is a story.
4. No work item for `<KEY>` is on the hub's trunk (`docs/backlog/*/<KEY>.item.md`). A story
   already in the hub is changed through its own flow, not here.

## The state transition it owns

None. The ticket is not yet a story in the hub. `/from-ticket` makes it one.

## What it does

Ask one question per message. Give lettered choices. Put the suggested answer first, as `a)`.
Quote proposed wording in full. Always offer "park it" for a question the PM cannot answer now.

1. **Fetch the ticket.** Call `getJiraIssue` for `<KEY>`, with the description as markdown. Keep
   its `updated` value: step 7 compares it.
2. **Find the gaps.** Write a draft snapshot from `docs/backlog/_TEMPLATE.ticket.md`, as
   `.claude/rules/ticket-quality.md` § The snapshot says. Write it in the system temporary
   directory, never in the hub. Run `node scripts/check-intake.js --draft <file>`.
   Dispatch `pm-critic` in `Mode: ticket-review`, ticket half only, with the draft and the check's
   output. The check's failures and the critic's ticket findings are the list of gaps.
   An empty list ends the run: tell the PM the ticket is ready, and that the engineer can run
   `/from-ticket <KEY>`.
3. **Show the PM the list.** One line per gap, in plain English, with why a design needs it.
4. **Close each gap, one at a time.** For each one, first read the sources: the ticket, its
   linked tickets, its parent epic, and the code where the PM can read it. Then:
   - **A source answers it:** propose the content, quote the source, and ask
     (a) accept (b) change it (c) park it.
   - **No source answers it:** ask the PM, with a suggested answer where the ticket gives a hint.
   - **Only the code can answer it, and the PM cannot read it:** park it for the engineer.

   Write each answer down as a numbered note, in the PM's words.
5. **Draft the new description.** Dispatch `feature-writer` on
   `.claude/skills/write-requirements/SKILL.md` § Enriching a ticket. Hand it the ticket, the list
   of gaps, the notes and the sources read. It writes the draft in the system temporary directory:
   the PM's text kept as it is, each addition marked with its source, and a closing list headed
   `Harness enrichment`.
6. **Check the draft, and show it.** Fill a draft snapshot from the new description, run
   `check-intake.js --draft` on it, and dispatch the critic again on it. Cap two rounds of this
   step. A finding that remains is put to the PM as a question, or parked. Then show the PM the
   whole description as it stands and as proposed, and the gaps still parked. Ask:
   (a) approve and send to Jira (b) change something (c) stop and send nothing.
7. **On (a), write to Jira.**
   1. Call `getJiraIssue` again. If `updated` moved since step 1, stop. Show the PM what changed,
      and send nothing. Someone edited the ticket while the PM was reviewing.
   2. Call `editJiraIssue` with the approved description. Add the label `shl-enriched`, and remove
      `shl-needs-enrichment` where the ticket carries it.
   3. Call `addOrEditJiraIssueComment` with: "Enriched by the SHL harness. Approved by <the PM's
      name, from atlassianUserInfo> on <date>. Added:" and one line per addition.
8. **Report, and stop.** Say what was sent, and list each gap still parked and who owns it. When
   nothing is parked, say: "The ticket is ready. The engineer can run `/from-ticket <KEY>`."

## Gates it enforces

| Gate | Behaviour on failure |
|---|---|
| One bar: the same `check-intake.js --draft` and `ticket-review` as `/from-ticket` | Never judge a ticket by any other list |
| Every proposal names its source, or is the PM's own answer | Refuse an addition with no source. It is an invented requirement |
| The PM's text is kept: no line reworded, reordered or removed | Refuse the draft. A line the harness believes is wrong is a question for the PM |
| The PM approves the whole new description in the session | Send nothing. Approval of one gap is not approval of the description |
| The ticket did not change since the PM saw it | Send nothing, and show what changed |
| One description edit, the two labels and one comment | Write nothing else. `.claude/rules/jira-mirror.md` § A ticket that is the source |

## Output

- On approve: the ticket's new description in Jira, the label `shl-enriched`, no label
  `shl-needs-enrichment`, and one comment listing the additions.
- Nothing in the hub. The draft and the critic's rounds stay in the system temporary directory.

## Stopping condition

Four outcomes, no fifth:

1. The ticket already met the bar. Nothing was sent.
2. The PM approved, and the description, labels and comment are in Jira.
3. The PM stopped. Nothing was sent.
4. The ticket changed in Jira during the run. Nothing was sent, and the PM sees what changed.

## Never

- Never write to Jira before the PM approves the whole new description in this session.
- Never reword, reorder or remove the PM's text.
- Never propose a value no source supports, and never present a guess as a fact.
- Never write a file in the hub, and never commit.
- Never let a seat talk to the PM, or call the MCP.
- Never treat a parked gap as closed. It stays on the list, with its owner.

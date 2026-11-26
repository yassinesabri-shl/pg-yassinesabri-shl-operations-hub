---
name: ticket-quality
description: The bar a Jira story meets before the harness designs from it. One definition, read by /from-ticket, /enrich-ticket, the critic in ticket-review mode and check-intake.js.
globs: ["docs/backlog/jira/**", "scripts/check-intake.*"]
alwaysApply: false
paths: ["docs/backlog/jira/**", "scripts/check-intake.*"]
---

# Rule — the quality bar for a ticket

<!-- Part of the harness asset library c6f3b4427d58f7c3 (see VERSION.json) · 2026-11-11 -->

A story taken from a Jira ticket has no requirements document behind it. The ticket is its only
source, so the design can be no better than the ticket. This rule is the one definition of a
ticket that is good enough to design from. `/from-ticket` applies it before a story enters the
hub, `/enrich-ticket` applies it before the PM approves a change, and the critic and the gate
apply it to the snapshot in the intake pull request. A weak ticket is fixed before design, never
during it.

## The snapshot

`/from-ticket` copies the ticket into `docs/backlog/jira/<KEY>.ticket.md`, in the shape
`docs/backlog/_TEMPLATE.ticket.md` fixes. The snapshot is a copy, not a rewrite. It changes
only three things:

- It adds an `ID` column to the criteria table: `JIRA-<KEY>.AC-1`, `-2`, … in the order the
  ticket lists them.
- It puts the ticket's parts under fixed headings: `## Description`, `## Acceptance criteria`,
  `## Out of scope` and `## Design`.
- It records where the copy came from: `Key:`, `Source:`, `Fetched: <KEY>@<updated>` and
  `Parent:`.

Write a literal pipe from the ticket's text as `\|` in the snapshot. Each table row then keeps the
cell count of its header. GitHub shows `\|` as `|`.

A ticket names its parts in its own words. A part is the text that the ticket marks as that
part, under any label and in any form: a heading, a table row or a labelled line.

- The out-of-scope part states what the story does not change. Example labels are
  `Out of scope`, `Scope boundary`, `Not in scope` and `Exclusions`.
- The design part is the link to a design, or the reason that there is none. Example labels
  are `Design`, `Figma` and `Mockups`.

Copy the part word for word under its fixed heading. Where the ticket's label is not the
heading, start the line with the label, as in `- Scope boundary: <the ticket's text>`. The
person who merges can then find the text in the ticket.

Text that the ticket does not mark as a part is not that part. Never put an assumption, a
dependency or a note under a heading to fill it.

A part that the ticket does not have stays empty in the snapshot. The check then fails on it, and
`/enrich-ticket` adds it to the ticket. Never fill a part in the snapshot that the ticket does not
fill.

## The bar

| # | The ticket has | Checked by | Severity when missing |
|---|---|---|---|
| 1 | A criteria table with one Given, one When and one Then column | `check-intake.js` | `CRITICAL` |
| 2 | No empty cell in Given, When or Then | `check-intake.js` | `CRITICAL` |
| 3 | No placeholder: `TBC`, `TBD`, `TODO`, `to be confirmed`, `to be defined`, or a cell that only says "see designs" | `check-intake.js` | `CRITICAL` |
| 4 | An out-of-scope section with at least one line | `check-intake.js` | `IMPORTANT` |
| 5 | A design section: a link, or `none — <why>` | `check-intake.js` | `IMPORTANT` |
| 6 | Each Then is an outcome a test can observe: a value, a message, a state, a record | the critic | `CRITICAL` |
| 7 | Each number the outcome depends on is stated: a time, a limit, a count, a threshold. "Engineering identifies the current value" does not state it | the critic | `CRITICAL` |
| 8 | At least one criterion for what must not happen: a failure, a refusal, a limit reached | the critic | `IMPORTANT` |
| 9 | Each linked ticket the story depends on is named, with the direction of the dependency | the critic | `IMPORTANT` |
| 10 | Enough detail for a designer to name the behaviour to change, without asking the PM | the critic | `IMPORTANT` |
| 11 | One story, not several: the criteria describe one behaviour a person can accept in one review | the critic | `SUGGESTION` |
| 12 | Each line of the out-of-scope section states what the story does not change, and the design section is about the design. No other text fills either section | the critic | `CRITICAL` |

`CRITICAL` and `IMPORTANT` stop `/from-ticket`. `SUGGESTION` is reported and stops nothing.

## What the bar never asks for

- A requirements document, a feature, an epic or a parent. A ticket with no parent passes.
- A format the team does not use. The criteria table may carry other columns, such as a
  scenario name, and they are kept as the ticket gives them.
- Wording. The bar judges what the ticket says, not how it says it. The communication rule
  binds the harness's own text, not the PM's.

## Who fixes a ticket that fails

The PM, through `/enrich-ticket <KEY>`, in their own session. The harness proposes only what a
source supports: the ticket, its linked tickets, its epic, its design link, and the code as it
is today. Every other gap is a question for the PM. Nothing reaches Jira before the PM approves
the whole new description in the session. `jira-mirror.md` § A ticket that is the source holds
the write rule.

UNRESOLVED — whether this bar must match the story template agreed for the dashboard.
Owner: Dino. Resolves: when the template is agreed with Noor and Steph.

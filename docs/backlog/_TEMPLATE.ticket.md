<!-- Part of the harness asset library c6f3b4427d58f7c3 (see VERSION.json) · 2026-11-04 -->
<!--
  The ticket snapshot: docs/backlog/jira/<KEY>.ticket.md, written by /from-ticket from one
  Jira story, and read by scripts/check-intake.js and the critic in Mode: ticket-review.
  A copy, not a rewrite (.claude/rules/ticket-quality.md § The snapshot). Copy the ticket's
  text as it is. Leave a part empty when the ticket does not have it; never fill it here.
  Delete this comment.
-->
# <KEY> — <the ticket's summary>

Key: <KEY>
Source: https://<site>/browse/<KEY>
Fetched: <KEY>@<the ticket's updated time, ISO 8601, as Jira gives it>
Parent: <the parent's key, or none>
Links: <each linked key with its relation, such as "TKT-7 (is blocked by)", or none>

## Description

<The ticket's description, without its acceptance-criteria table, its out-of-scope list and its
design link, which have their own sections below.>

## Acceptance criteria

| ID | Given | When | Then |
|---|---|---|---|
| JIRA-<KEY>.AC-1 | <as the ticket gives it> | <as the ticket gives it> | <as the ticket gives it> |

## Out of scope

<The ticket's out-of-scope list, one bullet per line.>

## Design

<The ticket's design link, or "none — <why>" where the ticket says why there is none.>

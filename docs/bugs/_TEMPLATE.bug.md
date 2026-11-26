<!-- Part of the harness asset library c6f3b4427d58f7c3 (see VERSION.json) · 2026-11-20 -->
<!--
  The bug record: docs/bugs/<KEY>.bug.md, written by /bugfix from one Jira bug, and read by
  scripts/check-bug.mjs and the critic in Mode: bug-review. A person who merges the hub pull
  request accepts the root cause in it. The spoke's story-gate reads it again on the fix.
  Copy the ticket's text into the snapshot as it is, and never rewrite it. Every other part is
  the investigation's finding. Write "none" only where a section allows it. Delete this comment.
-->
# <KEY> — <the ticket's summary>

Key: <KEY>
Repository: <the repository id from docs/estate/repositories.json>
Verdict: Bug
Size: one-fix

## Ticket snapshot

Source: https://<site>/browse/<KEY>
Fetched: <KEY>@<the ticket's updated time, ISO 8601, as Jira gives it>
Type: Bug

### Description

<The ticket's description and the comments that changed the claim, as the ticket gives them.>

## Claim

<Five lines or fewer: the observed behaviour, the expected behaviour, the steps, the environment
or version, and what the comments changed.>

## Pinned commit

Pinned: <repository id>@<the first 12 characters of the commit the investigation read>

## Chain

| Link | Location | What happens |
|---|---|---|
| 1 | <repository id>@<12-hex>:<path>:<line> | <what the code does at this link> |

## Reproduction

Layer: <unit, integration or e2e>
File: <the path of the test file where a failing test shows the bug>

## Files to change

- <path>

## Clash report

<none, or each open feature pull request and each merged design whose files overlap the files to
change, with its key.>

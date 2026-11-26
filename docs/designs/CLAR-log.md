# Clarification log — <PROGRAMME / SYSTEM SHORT CODE>

<!--
  Clarification log template, v1.0.

  What this is. The register of every genuine ambiguity an agent has hit
  and could not resolve from an authorised source. It exists so that "block and
  ask" is cheaper for an agent than "assume and continue".

  Three places, one schema. This file is the schema of record: section 9 of the
  low-level design, the log of each work item and the constitution all carry the same
  eight columns and point here rather than restating them. If a copy drifts, this file
  wins.
   - The per-work-item table lives in section 9 of the low-level design. That is
     the copy the pickup gate parses.
   - Each work item also has its own log, `docs/designs/<KEY>.clar-log.md`, in the
     shape that § Log of a work item below shows. It holds the same rows as §9, and
     the rows that a run opens after the design merged. The standing review, the
     escalation service level and the pre-merge check read it. Rows are appended when
     they are opened and updated in place.
   - The log of a work item is a file of its own, so that two designs written at the
     same time change different files. One shared table made the second design pull
     request conflict with the first, and GitHub runs no check on a pull request
     with a conflict.

  Who writes a log of a work item. One agent seat, the sprint orchestrator, whose
  Write is pinned to `docs/designs/<KEY>.clar-log.md` for the work item of its run:
  appended rows and in-place status changes, never a deletion. It writes the file
  with the first row. It mirrors §9 of a design into the file when /dev-spec ends,
  and writes the row a worker hands back as text when /dev-sprint stops on a
  blocking clarification. That worker holds the code checkout, never the hub.
  Before the design merges, a person's answer reaches it by /dev-spec run again on
  the design's branch, and the orchestrator updates the row in place in the same run.
  A human who writes an answer back into the merged design moves the row to Closed
  in both places in the same amendment. No other seat writes a log of a work item,
  and no seat writes this file.

  Identifier scheme:  CLAR-<SYSTEM>-<section>-<nn>
    SYSTEM   short uppercase code for the system or programme, stable forever
    section  lowercase kebab slug for the area of the requirements (auth, pricing, ledger)
    nn       zero-padded sequence within that section, never reused, never renumbered

  Parsing rules, because this table is machine-checked:
   - Eight columns, in the order below, header text matched literally. The gate
     never reads a log of a work item, and it never reads this file.
   - One row is one line. No newlines inside a cell. Escape any pipe inside a cell
     as \| — the gate splits on unescaped pipes only, and writes the pipe back into
     the cell value. The pipe that ends the row is never escaped.
   - A row that does not parse FAILS the gate. It is never skipped.
   - A row with Blocking = yes releases the work item only at Closed or Withdrawn.
     Open, Routed and Answered all block. Answered is a human having replied; it is
     not the answer having landed in the specification.
   - Status is one of: Open | Routed | Answered | Closed | Withdrawn
   - Answered and Closed require a non-empty Resolution.
   - Open and Routed require a non-empty Routed to.
   - If a work item has no clarifications, delete the table and leave the literal
     token NONE alone on its own line. The gate accepts that and requires no empty
     table. A section with neither a table nor NONE fails.
-->

## Column schema

| Column | Allowed values | Rule |
|---|---|---|
| ID | `CLAR-<SYSTEM>-<section>-<nn>` | Unique, never reused, never renumbered |
| Question | Free text, one line, a closed question | Must be answerable yes/no or by choosing a named option |
| Source | `<DOC> <§ title> L<n>` | The exact place the ambiguity was found |
| Blocking | `yes` / `no` | `yes` means no code may be written for this work item until the row reaches `Closed` |
| Routed to | Role name, non-empty when Open or Routed | A role, never a person's name |
| Status | `Open` / `Routed` / `Answered` / `Closed` / `Withdrawn` | Only `Closed` and `Withdrawn` release a blocking row. See the lifecycle below |
| Resolution | Free text, one line; required when Answered or Closed | The decision, not the discussion |
| Resolved | `YYYY-MM-DD`, or empty while unresolved | Date the resolution landed |

Status lifecycle:

    Open ──▶ Routed ──▶ Answered ──▶ Closed
      │                     │
      └────────▶ Withdrawn ◀┘        (the question stopped being real)

`Open` means logged, not yet delivered to a human. `Routed` means delivered and
awaiting an answer. `Answered` means a human replied. `Closed` means the answer is
written back into the specification, which is the only state that unblocks work.

## Log of a work item

Each work item that has a clarification has the file `docs/designs/<KEY>.clar-log.md`. The
file name carries the key, as the design's file name does, so the table has no `Work item`
column. A work item with no clarification has no file. Read the logs of every work item with
`docs/designs/*.clar-log.md`. The file has this shape:

    # Clarification log — PROJ-412

    | ID | Question | Source | Blocking | Routed to | Status | Resolution | Resolved |
    |---|---|---|---|---|---|---|---|
    | CLAR-PROJ-auth-01 | Does step-up authentication apply to read-only advisory views, or only to transactional views? | FSD Authentication L118 | yes | Product owner | Closed | Transactional views only; read-only inherits the session. FSD L118 amended. | 2026-07-02 |
    | CLAR-PROJ-auth-02 | Should a locked account surface a distinct error code to the client? | FSD Authentication L131 | no | Product owner | Answered | Yes, a distinct code, with no reason detail in the payload. | 2026-07-04 |

## Escalation record

<!--
  A view. Nobody edits this table by hand, and no seat writes it.

  The record of every escalation is one JSON line for each event, in the artefact
  `escalation-record.jsonl` of the escalation's `[shl-harness]` issue in the hub. One script,
  `scripts/escalation.mjs`, writes every line, and a line is never edited. `node
  scripts/escalation.mjs print --all` writes the table below from those lines, and a person pastes
  it here when they want a copy in the log.

  /feature and /decompose run before any work item exists and dispatch no orchestrator. On a cap,
  each command calls the same script itself. The record's `work_item` is null and its `slug` names
  the feature, because no key exists yet.

  Columns, in this order: Date | Trigger | Work item | Detail | Notified via | Acknowledged
  | Answered. Trigger is one of the eight in the escalation contract below. `Notified via`
  names the channel actually used, never "escalated". `Acknowledged` and `Answered` are
  timestamps, and they stay empty until a line records them.

  Every command that can reach a cap or a blocking clarification raises the escalation on that
  branch. /dev-spec first offers the runner the chance to answer a blocking row in
  the session, and raises an escalation only for a question that the person leaves open. An
  escalation with no line is an escalation nobody can audit and nobody can chase.
-->

The escalation's `[shl-harness]` issue in the hub is its channel. Each message is a comment there, so GitHub notifies the people who follow the issue, and `Notified via` shows `issue`.

| Date | Trigger | Work item | Detail | Notified via | Acknowledged | Answered |
|---|---|---|---|---|---|---|
| 2026-07-02 | Blocking clarification | PROJ-412 | ESC-PROJ-412-01 at dev-spec.blocking-clarification (resolved): CLAR-PROJ-auth-01 | Team chat + email | 2026-07-02 09:14 | 2026-07-02 11:40 |
| 2026-07-03 | Source contradiction | PROJ-418 | ESC-PROJ-418-01 at feature.contradiction (resolved): CLAR-PROJ-pricing-01 | Team chat | 2026-07-03 08:20 | 2026-07-03 09:05 |
| 2026-07-05 | Revision cap reached | PROJ-421 | ESC-PROJ-421-01 at dev-sprint.code-review-cap (acknowledged): critic loop hit round 3 on the data-access layer | Team chat + tracker flag | 2026-07-05 10:02 |  |
| 2026-07-06 | Undefined control | PROJ-430 | ESC-PROJ-430-01 at clar-log.undefined-control (open): retention window undefined; deny-by-default applied | Team chat | 2026-07-06 07:55 |  |

## Escalation contract

| Trigger | Effect on the work item | Owner of the response | Expectation |
|---|---|---|---|
| Revision cap reached | Paused in place; flagged, not reverted | Engineering lead | Same working day |
| Blocking clarification | Not eligible for build until the row is `Closed`. `Answered` does not release it | Named role in `Routed to` | Next working day |
| Contradiction between sources | Not eligible; both sources cited in the row | Lead architect | Next working day |
| Control undefined | Most restrictive behaviour applied and recorded | Risk owner | Next working day |
| Cannot verify | The run stops before it changes anything. Exit 2 is never a pass | The runner, then the repository's tech lead | Same working day |
| Incident | The story stops at once, in every stage | Security role on call, or the data officer | 60 minutes, any hour |
| Handover | Nothing stops. One item waits for a person | The role the item names | The next standing sweep |
| Gate waiting | The pull request stays open | The role that merges it | Same working day |

Standing rules:

1. An agent may never resolve a blocking clarification itself, including by
   choosing the interpretation the specification "clearly implies".
2. A resolution is not a chat reply. It is written back into the specification,
   the row moves to `Closed`, and only then does work resume.
3. Escalation reaches a human through a channel the human already reads, and each
   `notified` line of the record names which one. The harness runs outside business
   hours, and it must not need to be watched. Until the channel is named, every
   escalation still writes its lines. An unsent escalation that is written down is
   recoverable, and one that is neither is not.
4. Non-blocking clarifications never stop work. They accumulate and are swept
   at the next specification review.

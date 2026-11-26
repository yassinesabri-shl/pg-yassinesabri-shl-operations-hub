---
name: estate-overview
description: <one sentence: what this estate is, for a reader who has never seen it>
globs: []
alwaysApply: false
kind: estate-overview
owner: <the lead architect role, as docs/harness-decisions.md decision 7 names it — a role, never a person>
revision: <YYYY-MM-DD of this edition>
origin: <who wrote it and from what — for example "written by the lead architect from the repository list and the team's own knowledge, /add-context">
---

<!--
  Estate overview template, v1.0.

  One plain-English page that says what the whole system is. /feature reads it
  before every interview, so its questions can name the part of the system a
  request touches and the suggestion it offers stands on something written
  down. /decompose reads it before it maps a requirement onto repositories. A
  design that wants it names its id, estate-overview. Nothing loads it into
  every design: the header's globs: [] and alwaysApply: false are fixed, and
  check-context refuses any other value.

  How to write it:
  - Write for someone who has never seen the system. Short sentences. Everyday
    words. Where a word has a special meaning here, define it in section 3.
  - One row in section 2 per repository in docs/estate/repositories.json, by
    id. Say what the part is FOR and who to ask, not how it is built. The
    list's `purpose` text already says what each repository does technically;
    do not repeat it here.
  - Aim for under 150 lines. This is a map, not a manual.
  - An open point is written in the body as
    UNRESOLVED — <what>. Owner: <role>. Resolves: <trigger>.
    never in the header: the header refuses placeholders, and the id, the
    globs and alwaysApply are fixed by the kind.
  - Place it with
    /add-context <file> --kind estate-overview --owner <role> --revision <date> --origin <text>
    and replace it the same way with a new revision. Delete this comment once
    the page is written; the interview reads the body as it stands.
-->

# <The estate's name>: what it is

## 1. What the system does

<One paragraph. What it is for, who uses it, what goes in and what comes out. Say
which repository a transaction enters through and where it ends up.>

## 2. The parts

One row per repository on the list, by id. What it is for, in the business's words.
Who to ask is a role, never a person.

| Part (repository id) | What it is for | Who to ask |
|---|---|---|
| `<id from docs/estate/repositories.json>` | <what it does for the business, in one sentence> | <role> |

## 3. Words the business uses

| Word | What it means here |
|---|---|
| <word> | <what it means in this estate, in one sentence> |

## 4. Outside the estate

Systems the list does not carry that this estate depends on or feeds, so a request
that reaches one of them is recognised as reaching another team.

| System | What it does | Who owns it |
|---|---|---|
| <a system the list does not carry> | <what it does, in one sentence> | <role or team> |

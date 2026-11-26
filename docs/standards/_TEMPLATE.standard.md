---
name: std-<topic>
description: <one sentence, at most 200 characters: what the standard governs and for which code>
globs: <a one-line JSON array of the paths it binds, [] when it binds only by name>
alwaysApply: false
kind: standard
status: <Active | Reserved | Deprecated>
owner: <the role or the person accountable for it being current, as the source or the person states it>
revision: <the version or date of the original, as its author states it>
origin: <where the original is kept: the page or file a reader opens, and its own id there>
---

<!--
  Standard template, v1.1 — the hub's copy, written for agents.

  The original lives where the client keeps it. This file is a summary of it, written by
  /add-context --kind standard, or by the Confluence sync (scripts/confluence-sync.mjs) from
  an approved page of Template - Standard, and confirmed by the person who merges it. It
  carries only rules that bind work across the estate. Nothing else is written here: no facts
  about one repository or service (they belong in that spoke's contracts or rules), no product
  description or glossary (the estate overview), no history, comparison tables or examples
  that disagree with the rules, and no person's name outside the owner line.

  The same template serves a standard of the global context repository, written there by that
  repository's own /add-context. Every hub reads it as global.std-<topic>, and it binds every
  product from the release tag that carries it.

  - status is Active, Reserved or Deprecated. An Active standard binds every design whose
    paths its globs match (or every design, when always on). A Reserved one is held for later —
    a standard for a stack or a kind of change the estate does not use yet, or one not yet
    adopted for this estate — and binds only a design that names it. A Deprecated one binds
    nothing: its page was superseded, rejected or retired. The file stays, because designs
    cite its id.
  - The name is std- and the topic in kebab case, for example std-api-naming. The file is
    <name>.md, and the name and the title carry the same name. The name never changes after
    the merge, and a name a removed standard held is never used again.
  - Every rule carries an id, <name>.<NN>, unique in the file, for example std-api-naming.01,
    and cites where in the original it comes from. A design or a critic cites the rule by
    that id.
  - Must holds MUST and MUST NOT rules; Should holds SHOULD and SHOULD NOT. A rule a critic
    cannot check from a design or a diff is not written.
  - Cite another standard or a decision record by id; never copy its text.
  - A value nobody has settled is an UNRESOLVED line, never a rule and never a guess.
  - Keep every section, in this order. A section with nothing to say holds the single line
    "None.", so an agent can tell nothing from forgotten. The file stays within 200 lines;
    a standard that needs more is two standards.
-->

# std-<topic>: <the topic, in a few words>

## Applies to

<The code this binds, in words: languages, paths, kinds of change. Anything inside them it does
not cover.>

## Must

- **std-<topic>.01** MUST <one checkable statement>. *(Source: <section, slide or rule id in the original>)*
- **std-<topic>.02** MUST NOT <one checkable statement>. *(Source: <...>)*

## Should

- **std-<topic>.03** SHOULD <a recommendation a reviewer may waive without an exception>. *(Source: <...>)*

## Values

| Value | Setting | Applies to | Source |
|---|---|---|---|
| <a threshold the rules use: a line length, a coverage floor, a timeout> | <the number> | <scope> | <section> |

## Checked by

- **std-<topic>.01** — <script: the checks.env key and command | CI job: its name | review: what the reviewer looks for>.

## Relations

- Defers to: <ADR-<NNN> or std-<topic>>, for <topic>.
- Settled on ingest: <the conflict, the answer, the role that gave it, the date>.

## Exceptions

<The role that grants one, and where it is recorded.>

## Unresolved

- UNRESOLVED — <what>. Owner: <role>. Resolves: <trigger>.

## Origin

<The original's title, its id where it is kept, and its revision. What this summary leaves out,
in one line, and where each part went.>

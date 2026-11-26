---
name: ADR-<NNN>
description: <one sentence, at most 200 characters: what is decided and for which system>
globs: <a one-line JSON array of the paths this binds, [] when none>
alwaysApply: false
kind: adr
status: Accepted
owner: <the role or the person accountable for the record, as the source states it>
revision: <the version of the record where the client keeps it>
origin: <where the client keeps the record: the page or file a reader opens>
---

<!--
  Decision record template, v2.2 — the hub's copy, written for agents.

  The record itself lives where the client keeps its records, and is debated,
  approved and superseded there. This file is a summary of it, written by
  /add-context --kind adr, or by the Confluence sync (scripts/confluence-sync.mjs)
  from an approved page, and confirmed by the person who merges it: it carries
  only what changes how a design or code is written. Nobody reads it as the record.
  A summary the sync wrote names its page in origin, "<url> (Confluence page <id>)",
  and the page's version in revision. The sync replaces it when the page changes.

  The same template serves a spoke's own record, written by
  /add-context --kind adr --repo <ID> into the folder the spoke's checks.env
  names with DECISIONS_INDEX. It keeps ADR-<NNN>, numbered by the spoke, in its
  name and title; everywhere else its id is <ID>.ADR-<NNN>. It narrows the hub's
  records and never overrides one.

  The same template serves a record of the global context repository, written
  there by that repository's own /add-context. It keeps ADR-<NNN>, numbered by
  the Global Architecture Board, in its name and title. Every hub reads it as
  global.ADR-<NNN>, and it binds every product from the release tag that
  carries it.

  status is one of: Accepted · Superseded by ADR-<NNN> · Deprecated. A hub's or a
  spoke's record that a global record now states is Superseded by
  global.ADR-<NNN>. A record in the global repository never carries that prefix.
  Only Accepted binds by globs or alwaysApply; a record that no longer binds is
  read only by a design that names it. A proposed record is a draft beside its design
  (docs/designs/_TEMPLATE.adr-draft.md), never a file here.

  Every section stays short. A section with nothing to say holds the single line
  "None." and is never left out, so an agent can tell nothing from forgotten.
-->

# ADR-<NNN>: <the decision, not the topic>

## Decision

<One sentence, active voice.>

## Rules

- MUST <a rule a design or code can follow and a critic can check>
- MUST NOT <...>

## Why

<The constraints that forced the decision, each with its source. Name any constraint that will
expire, and the condition that ends it.>

## Rejected

- Not <option> — because <the reason it lost>.

## Accepted costs

- <What is worse on purpose. A design must not "fix" it.>

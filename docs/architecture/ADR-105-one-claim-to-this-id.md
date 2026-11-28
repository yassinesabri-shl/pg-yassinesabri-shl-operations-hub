---
name: ADR-105
description: We use Postgres for every new service that needs a relational store.
globs: ["services/orders/**","libs/db/**"]
alwaysApply: false
kind: adr
status: Accepted
owner: Platform architect
revision: 3
origin: https://shl.atlassian.net/wiki/spaces/~71202058c67a3fe34f4165a8b8c49dc509cd2f/pages/474809835/ADR-105+One+claim+to+this+id (Confluence page 474809835)
---

# ADR-105: One claim to this id

## Decision

We use Postgres for every new service that needs a relational store.

## Rules

- MUST use Postgres for a new relational store.
- MUST NOT share a schema between two domains.

## Why

Each team picks its own database today.

## Rejected

- Not keep every engine, because three sets of backups to run.
- Not MySQL everywhere, because no team runs it today.

## Accepted costs

- One backup design for the estate.

---
name: ADR-202
description: The operations hub retries a failed job three times, then parks it.
globs: ["internal/**","jobs/**"]
alwaysApply: false
kind: adr
status: Accepted
owner: Platform architect
revision: 2
origin: https://shl.atlassian.net/wiki/spaces/~71202058c67a3fe34f4165a8b8c49dc509cd2f/pages/474843503/ADR-202+The+operations+hub+retries+a+failed+job+three+times (Confluence page 474843503)
---

# ADR-202: The operations hub retries a failed job three times

## Decision

The operations hub retries a failed job three times, then parks it.

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

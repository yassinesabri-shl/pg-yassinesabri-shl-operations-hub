---
name: ADR-002
description: Every time in the operations estate is stored, compared and sent in UTC as RFC 3339 with the suffix Z; a local time exists only on a screen or a printed label.
globs: ["**/*"]
alwaysApply: true
kind: adr
status: Accepted
owner: operations architect
revision: v1, 2026-10-20
origin: the Larder architecture decision log, record O-002, "Times are UTC"
---

# ADR-002: Every time is UTC, written as RFC 3339 with Z

## Decision

Every time is stored, compared and sent in UTC as RFC 3339 with the suffix `Z`, and is converted to local time only where a person reads it.

## Rules

- MUST write a time on the wire and in a store as RFC 3339 in UTC with the suffix `Z`, such as `2026-10-20T13:59:00Z`.
- MUST write a calendar date with no time, such as a dispatch date, as `YYYY-MM-DD`, and name the time zone it is a date in.
- MUST compare a time to a cut-off in UTC.
- MUST read the current time from a clock the caller passes in, so that a test can fix it.
- MUST NOT read the server's local time zone anywhere.

## Why

The warehouse is in the UK and the cut-off moves by an hour twice a year in local time.
Two pilot orders missed dispatch on the day the clocks changed. Source: the Larder operations pilot review of 2026-10-03.

## Rejected

- Not local time with an offset, such as `+01:00`, because two systems then write one moment two ways, and a string comparison fails.

## Accepted costs

- A cut-off that the business states in UK local time needs a conversion table in the code. The dispatch cut-off is stated in UTC on purpose.

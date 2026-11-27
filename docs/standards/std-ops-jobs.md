---
name: std-ops-jobs
description: How every public API names its ops-jobs.
globs: ["**/*.go"]
alwaysApply: false
kind: standard
status: Active
owner: Lead architect
revision: 1
origin: https://shl.atlassian.net/wiki/spaces/~71202058c67a3fe34f4165a8b8c49dc509cd2f/pages/474810863/std-ops-jobs+Background+jobs (Confluence page 474810863)
---

# std-ops-jobs: Background jobs

## Applies to

Every public HTTP API. Internal events are not covered.

## Must

- **std-ops-jobs.01** MUST use kebab-case in a path segment.
- **std-ops-jobs.02** MUST NOT put a verb in a path.

## Should

- **std-ops-jobs.03** SHOULD keep a path under five segments.

## Values

| Value | Setting | Applies to | Source |
| --- | --- | --- | --- |
| Path segments | 5 at most | All public APIs | API guide, page 2 |

## Checked by

- std-ops-jobs.01 — review: the reviewer reads every new path.

## Relations

None.

## Exceptions

- Granted by: Lead architect

## Unresolved

None.

## Origin

- Source: API guide v2, the API guild space

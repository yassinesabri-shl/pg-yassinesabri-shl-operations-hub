---
name: testing
description: Test-first discipline, and where the two coverage checks of decision 2a live.
globs: ["tests/**", "src/**"]
alwaysApply: false
paths: ["tests/**", "src/**"]
---

# Rule — testing

Every acceptance criterion maps to a named test, written before the code. Coverage is two
blocking checks: whole-project coverage must not fall below its floor, and the lines a change
adds or modifies must meet theirs.

- **Coverage in this hub:** not applicable, by design. A hub holds documents, and its own
  checks are the fixture suites under `tests/`.
- **Coverage in a spoke:** both numbers live in that spoke's `checks.env`
  (`PROJECT_COVERAGE_FLOOR`, `CHANGED_LINE_FLOOR`), on its trunk, never in this file.
  `scripts/check-coverage.mjs` judges them in the spoke's `story-gate` check and in
  `/dev-sprint`'s finalizer, and records the floors applied with each result.
- **The test runner and the coverage command** are each spoke's, named in its `checks.env`.
- **Never, to go green:** a suppression, an exclusion added to meet a floor, or a test marked
  as an expected failure.

UNRESOLVED — the test naming and placement conventions beyond each spoke's own rules. Owner: tech lead. Resolves: at the first sprint.

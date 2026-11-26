---
name: pull-request
description: The description /dev-sprint step 10 writes on a story's pull request in the repository the story names — what changes and why, where it came from, the evidence one line each, and only what needs a person. The design, the commits and the checks hold the rest.
---

<!-- Part of the harness asset library c6f3b4427d58f7c3 (see VERSION.json) · 2026-10-15 -->

<!--
  How to fill it. Replace every <…> and keep the line; where a line's condition does not hold,
  take the line out, never leave a placeholder. At most forty lines from the title to the
  watermark: a reviewer reads this before the diff, so it says once what the diff cannot.

  Leave out what lives elsewhere: the criterion-to-test map and the decisions (the design, §4
  and §5), the red log test by test, a critic's full summary, the list of files, how the
  environment was set up. A fact from those goes in only where a person must act on it, and then
  under Needs a person, one line.

  Three lines are read as written. The `Protected-test guard:` line exactly as
  `scripts/test-guard.mjs summary --pr-line` prints it. The coverage record exactly as the
  finalizer's last round printed it. And the watermark, the last line, with nothing after it:
  no other tool's footer.
-->

## <KEY>: <what changes, in the reader's words>

<Two to four sentences: the behaviour before and after, and what deliberately does not change.>

**From:** design `docs/designs/<KEY>.lld.md` at hub `<12 hex>` · story `docs/backlog/<SLUG>/<KEY>.item.md` · `checks.env` at `<12 hex>`
**Rules:** <rules: none declared | rules: NOT CONFIGURED | <id>@<12 hex>:<folder> | rules drift — design <12 hex>, trunk <12 hex>> · **Guardrails:** <guardrails: off | guardrails: none | guardrails: not checked | guardrails: current | guardrails changed — <title>, … | guardrails missing — <id>, …> · **Context:** <context: none | context: current | context drift — <entry> <12 hex> → <12 hex> | <entry> removed>

### Tests
- <n> of <n> acceptance criteria have a named test (design §5)<; missing: <AC ids and why>>.
- Stubs `<12 hex>`, tests `<12 hex>`. Red at the test commit: <n> failed, each an assertion in this story's tests.
- `test-review` APPROVED, cycle <n> of 3.

### Build
- Candidate `<12 hex>`, round <n> of 3. `code-review` APPROVED, cycle <n> of 3<, <n> non-blocking suggestions>.
- Security: <`security-reviewer` APPROVED, cycle <n> of 3 — <the surfaces that matched> | no trigger matched — <what was read>>.
- Protected-test guard: <n> blocked, <n> restored in the clone, <n> undone by the finalizer in <n> of <n> rounds, <n> caught during validation

### Checks
- Lint <PASS | none> · types <PASS | none> · build <PASS | none> · tests <PASS> · secret scan <clean> · migrations <PASS | none>
- <project <n>% (floor <n>) · changed <n>% (floor <n>) · floors from checks.env@<12 hex>>
- NOT CONFIGURED: <the keys | none>

### Needs a person
- <One line each: an open clarification and its owner, a drift, a NOT CONFIGURED row, a legacy failure, a suggestion worth a decision. Or: nothing.>

Generated-by: SHL Agentic Harness

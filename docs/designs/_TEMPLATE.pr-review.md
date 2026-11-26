---
name: pr-review
description: The body of the one review /dev-sprint step 10a and /pr-review post on a story's pull request — the comment counts, the reviewer's headline, the verifier's tally, any finding no line can carry, and what was dropped, folded away. scripts/pull-request.mjs post renders it; nobody writes it by hand.
---

<!-- Part of the harness asset library c6f3b4427d58f7c3 (see VERSION.json) · 2026-10-15 -->

<!--
  This is the shape `scripts/pull-request.mjs post` renders from findings.json and
  verified-findings.json, kept here so a person can read it and review a change to it. The
  script is what posts it: change the two together, with the pull-request suite's fixture 3.

  The comments are inline on the diff, so the body does not list them again. A part with
  nothing in it is left out: no `Not on a line` without such a finding, no fold without a
  dropped finding or a pre-existing note. The verifier line is counted by the script from the
  verdicts; the verifier's own `verifierSummary` goes to the run's output, not the body. With
  no verifier output, or one the script cannot read, the line is `Verifier: not run — every
  comment is marked not verified` (or `not read — …`).
-->

**SHL harness review** · <n> comments: <n> blocking · <n> should-fix · <n> nit<, <n> already posted>

<The pr-reviewer's `summary`: one or two sentences — the headline risk, or why the change looks clean.>

Verifier: <n> checked · <n> real · <n> refuted · <n> uncertain

**Not on a line**
- <`file` | the pull request> — <title> (<category> · <severity>[; why it could not go on a line])
  <body>

<details><summary>Dropped by the verifier (<n>) · pre-existing (<n>)</summary>

- <F-id> · <title> — <the verifier's one-line reason>

Pre-existing, not introduced here:
- <file:line — the note>

</details>

Generated-by: SHL Agentic Harness

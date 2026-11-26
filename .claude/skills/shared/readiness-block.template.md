---
name: readiness-block
description: The eight-field readiness block a design carries — permitted values, the pure-token rule, and why the gate derives the counts instead of reading them.
---

<!-- Part of the harness asset library c6f3b4427d58f7c3 (see VERSION.json) · 2026-09-01 -->

<!--
  Shared output shape, not a skill. This is the readiness section of a per-work-item
  design (`docs/designs/_TEMPLATE.lld.md`, section 8) written out on its own, so that
  the seats that produce it, the seats that re-derive it and the gate that parses it are
  all reading one description.

  Eight fields. Each appears EXACTLY ONCE in the whole document, on its own line, as a
  pure token, inside the readiness section. Not inside prose. Not inside a table. Not
  restated in a summary at the top of the file. A ninth occurrence anywhere in the
  document is a duplicate, not a convenience, and it fails.

  Copy the heading with the block. The gate locates the section first and then requires
  every field to sit inside it, so eight correct lines pasted under some other heading
  fail as "outside the readiness section" — the same failure as a missing field, for a
  reason that is much harder to see.

  The heading is a locator, not a token: "## Readiness" and "## 8. Readiness" both find
  the section, so renumbering sections is safe. The field labels and the field values
  are not locators — they are matched literally.

  Delete this comment once instantiated.
-->

## 8. Readiness

Spec Quality: READY
Open Gaps: 0
AC count: <n>
AC covered by tests: <n>
Contracts referenced: <n>
Blocking CLAR: 0
Codebase verified: YES
Self-check verdict: GATE_PASS

## Permitted values

<!-- The labels are shown in backticks here, without their colon, so that this
     reference table can never be mistaken by a parser for a ninth occurrence. -->

| Field | Permitted values | What the gate demands | Where the value comes from |
|---|---|---|---|
| `Spec Quality` | `READY` or `NOT_READY` | `READY` | the author's judgement that the design is complete enough to build from |
| `Open Gaps` | a non-negative integer | `0` | the count of behaviours the design leaves undefined |
| `AC count` | a non-negative integer | at least `1` | the number of criterion rows in the acceptance-criteria table |
| `AC covered by tests` | a non-negative integer | equality with the derived covered set | the number of criteria the testing plan names a real test for |
| `Contracts referenced` | a non-negative integer, or `NONE` | any value | the cross-system contracts table |
| `Blocking CLAR` | a non-negative integer | `0` | clarification rows marked blocking and not yet Closed or Withdrawn |
| `Codebase verified` | `YES` or `NO` | `YES` | whether the design was written against the tree as read, not against a plan |
| `Self-check verdict` | `GATE_PASS` or `GATE_FAIL` | `GATE_PASS` | the author's own run of the readiness contract before submitting |

`GATE_PASS` and `GATE_FAIL` are the design's self-check vocabulary and appear nowhere
else. They are not a critic verdict and not a persona readiness value; those are
separate surfaces with separate tokens, and a value borrowed across surfaces either
fails its gate or is read as an approval nobody gave.

## The two rules that make this work

**A formatting variant is a failure, not something to be normalised.** Extra bold,
a trailing full stop, a re-worded label, a value in a table cell, a second copy in an
executive summary — each of these fails rather than being cleaned up and accepted. The
block is cheap to write correctly and the tolerance costs more than it saves: every
normalisation rule is a rule the author no longer has to obey, and the set of accepted
shapes drifts until two designs that look alike parse differently. One shape, matched
literally, is the only version of this that stays true a year in.

**The gate derives the counts; it does not read them.** `AC count` and
`AC covered by tests` are declarations. The gate builds the criterion set from the
acceptance-criteria table and the covered set from the testing plan, compares the two
sets to each other, and compares both against what was declared. The tables win every
time. So editing a declaration to match the prose changes nothing except the audit
trail — it turns an honest disagreement between an author and their own tables into a
false attestation, and the gate reports both the derived number and the declared one
side by side when they differ. If the numbers disagree, the fix is a missing testing-plan
row or a criterion that should never have been counted, never the digit.

The same derivation applies to `Blocking CLAR`: the gate counts the blocking
clarification rows that have not reached Closed or Withdrawn. Answered does not release
a row — a human replying is not the same as the answer being written back into the
design.

## Never

- Never emit a field twice, anywhere in the document, for any reason.
- Never place a field inside a table, a code fence, a bullet or a sentence.
- Never leave a field outside the readiness section. The gate finds the section first,
  then demands the field inside it; a correct value in the wrong place still fails.
- Never reword a label. The label is the parser's only handle on the value.
- Never edit a declared count to make the block pass. Fix the table it disagrees with.
- Never write a value the field does not permit — no `TBD`, no dash, no `N/A`, no
  `pending`, no free text. Where the real value is genuinely not yet knowable, the
  design is not ready, and the honest record is
  `UNRESOLVED — <what>. Owner: <role>. Resolves: <trigger>.` in the body with the field
  left at the value that reflects reality.

---
name: persona-review-block
description: The shape of a persona review — the uncalibrated banner, the readiness surface, objections carrying severity, questions and what the persona accepts. Returned as text; never a critic verdict, never a file.
---

<!-- Part of the harness asset library c6f3b4427d58f7c3 (see VERSION.json) · 2026-09-01 -->

<!--
  The shape of a persona review. Shared output template, not a skill — every persona
  seat that follows .claude/skills/persona-review/SKILL.md returns this shape.

  Returned AS TEXT, never written to a file. Persona seats hold no write tool and no
  shell; nothing downstream reads a persona review mechanically, so the orchestrator
  persists it if the programme wants it kept.

  The readiness line is a token surface, and it is not the critic's verdict surface.
  Three values, exact, upper case, underscored: READY, NEEDS_WORK, NOT_READY. Emit the
  value on the readiness heading below and nowhere else. Never emit a verdict heading —
  that line belongs to the critic, the pickup gate matches it literally, and a
  readiness value placed on a verdict line either fails the gate or, worse, is read
  as an approval nobody gave.

  Every objection carries a severity from the library's one vocabulary — CRITICAL,
  IMPORTANT, SUGGESTION — and the readiness value follows from those severities
  mechanically. The derivation, the two conditions that override it, and the veto-scope
  filter that caps an out-of-lane finding at SUGGESTION are in
  .claude/skills/persona-review/SKILL.md. Do not re-derive them here.

  The banner line below is emitted only by a seat whose charter is marked
  calibration: uncalibrated, or carries no calibration marking at all. A calibrated seat
  omits the line entirely rather than writing a negation of it.

  Lowercase angle-bracket tokens are authoring guidance, filled per review. This comment
  block is guidance too, and is never part of the text a seat returns.
-->

> **UNCALIBRATED.** <the charter's own banner verbatim, or the default wording in the skill>

## Persona: <seat name> — <role in the receiving function>
## Readiness: <READY | NEEDS_WORK | NOT_READY>

### Objections I would raise in the sign-off meeting

1. <CRITICAL | IMPORTANT | SUGGESTION> — [<location>] <the specific defect> — <who it hurts,
   and how they find out> → <the corrected text, or the decision required>

### Questions I would ask the author

1. <a question with a factual answer available to the author, not an opinion> — routed to
   <a role, never a person and never a named tracker product>

### What I accept without argument

- <what passes without objection — a persona that objects to everything gets switched off>

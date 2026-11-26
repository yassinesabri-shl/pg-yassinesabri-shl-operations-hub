---
name: handoff-ledger
description: Append-only record of what each contributor did on a work item — commits, checks run, deviations, gaps, and what the next contributor needs to know.
---

<!-- Part of the harness asset library c6f3b4427d58f7c3 (see VERSION.json) · 2026-09-01 -->

# Handoff ledger — <KEY>

<!--
  One ledger per work item, at `docs/designs/<KEY>.handoff.md`, instantiated from this
  template by the first contributor to touch the item. It lives as long as the item does —
  a ledger opened at handover records only the half of the work nobody needed it for.

  APPEND ONLY. Each contributor appends one section per turn, at the bottom, and never
  edits a section someone else wrote — or one they wrote themselves on an earlier turn.

  An edited ledger is not evidence: once any entry can be revised after the fact,
  nothing in the file distinguishes what happened from what someone later wished had
  happened, and the whole record stops being usable in a post-incident read.

  Got something wrong in an earlier section? Append a new section that corrects it and
  says which one it corrects. The wrong entry stays.

  <lowercase angle-bracket tokens> are authoring guidance, filled per turn. Delete this
  comment once instantiated; leave the rule line below it in place.
-->

**Append only. Never edit a section that is already written — append a correcting section instead.**

---

## Turn <n> — 2026-11-26 — <role or seat name>

**Who.** <the role or seat that did the work, and who dispatched it — roles, never people>

**What was done.** <two to five sentences at the level of behaviour and files, not narrative. What
a reader who has not seen the diff needs in order to know what changed and why.>

**Commits.**

| Commit | Message | What it changes |
|---|---|---|
| <short identifier> | <the commit subject> | <one line> |

**Tests run.**

| Suite or check | Command as run | Exit | Result |
|---|---|---|---|
| <tests> | <command> | 0 | <the runner's summary line, verbatim> |
| <types> | <command> | 0 | <the checker's summary line, verbatim> |
| <check> | <command> | NOT RUN | NOT RUN — <the reason it was not run> |

<!-- Quote the machine, do not summarise it. "All green" is a claim; the runner's own
     summary line is a fact. A check you did not run is recorded as NOT RUN with the
     reason — never omitted, and never inferred from a check that did run. A check that
     failed is recorded with its real exit code and the failing line: a handoff that hides
     a red run makes the next contributor debug your work believing it is theirs. Every
     cell carries a value — never a dash, never TBD, never N/A, never an empty cell. -->

**Commands run.** <every command that changed state — migrations, generators, dependency
installs, data loads. Read-only commands do not belong here; state changes do, because the
next contributor may be starting from a different machine.>

**Rules.** <the `Rules:` value this turn worked under, as `/dev-sprint` handed it in — a
citation `<id>@<12-hex>:<folder>` or `none` — and the names of the rules received. The next turn
is bound by the same set, or records here why it is not.>

**Deviations from the design.** <every place the implementation differs from the merged design,
each with the reason and the acceptance criterion or design section it touches. NONE if there
were none — and if there were, note that a deviation is a signal the design needs amending by a
human, not a licence already taken.>

**Known gaps.** <what is not finished, not covered, or not verified — one marked line each>

    UNRESOLVED — <what>. Owner: <role>. Resolves: <trigger>.

<!-- Never a bare TBD, never an empty section. A gap nobody wrote down is a gap the next
     contributor discovers by hitting it. Where there are none, write NONE. -->

**What the next contributor needs to know.** <the things that are true but not obvious from the
diff: the fixture that has to exist first, the ordering that matters, the wrong turn you took so
they do not take it again, the assumption you made that they should test before relying on.>

---

<!-- Next turn appends below this line. Nothing above it is touched again. -->

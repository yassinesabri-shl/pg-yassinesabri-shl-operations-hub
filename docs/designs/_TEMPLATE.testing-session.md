---
name: testing-session
description: Capture template for a human testing session against a work item — build under test, environment, findings with the shared severity vocabulary, what worked, and how a finding becomes a defect item.
---

<!-- Part of the harness asset library c6f3b4427d58f7c3 (see VERSION.json) · 2026-09-01 -->

# Testing session — <KEY>-TS-<nn>

<!--
  This file is a contract, not an integration. Raising a defect item below is a placeholder
  for the team's own tracker call; substitute it once, in this template, so every session
  instantiated afterwards carries the real call. The requirement that every finding carries a
  severity and a resolved status is not a placeholder.

  What this is. A human exercised the running system against a work item and wrote down what
  they saw. It is the complement to static acceptance-criteria validation, not a duplicate of
  it: static validation reads the code and the tests, and on work with no visible surface that
  is a weak signal. This file is where the observation of the running thing is recorded.

  It is a capture artefact, not a verdict. Nothing here moves a work item on its own — a
  session with no findings does not pass an item, and a session with findings does not fail
  one. The item moves on its validation report; this file is evidence a human can cite in it.

  One file per session, at `docs/designs/<KEY>-TS-<nn>.testing-session.md`. No command in
  this library version emits it — static acceptance-criteria validation is a different step
  and does not exercise the running system. A team wires this into whatever step runs its
  human testing.

  <lowercase angle-bracket tokens> are authoring guidance, filled per session. Delete this
  comment once instantiated.
-->

## Session

| Field | Value |
|---|---|
| Work item | <KEY> |
| Session identifier | <KEY>-TS-<nn> |
| Build under test | <the exact revision tested — commit identifier, plus the build or package identifier if the pipeline produces one> |
| Tested by | <name or role of the person who ran the session> |
| Date | 2026-11-26 |
| Environment | <the named environment the build was running in> |
| Data | <the data set used, and whether it was generated or supplied — never production data> |
| Access used | <the role or permission level the tester held, because behaviour differs by role> |
| Scope of the session | <what was exercised, and what was deliberately not> |

<!-- Every cell carries a value. Where something is genuinely not known, write
     UNRESOLVED — <what>. Owner: <role>. Resolves: <trigger>.
     Never a dash, never TBD, never N/A, never "pending". An empty cell reads as a thing
     nobody thought about, which is indistinguishable from a thing nobody found. -->

## Finding identifiers

Findings are numbered `<session identifier>-F<nn>` — for this session, `<KEY>-TS-<nn>-F01`,
`-F02`, and so on. Session numbers run `01`, `02`, `03` per work item, allocated by reading
which sessions already exist.

**Never derive an identifier from a date.** Two sessions against the same work item on the same
day collide under any date-based scheme, and the date is already a field on the session — an
identifier that repeats it carries no extra information and buys a collision. Numbers are
allocated in order, never reused, and never renumbered once written down: a defect item, a
conversation or a later session will already be citing the old one.

## Findings

<!-- Severity is the library's one vocabulary: CRITICAL, IMPORTANT, SUGGESTION, calibrated the
     same way a critic calibrates it. Would this block a production deployment? Then CRITICAL.
     Would it not block a deployment but is still wrong against the criterion? IMPORTANT. Is it
     a matter of taste — wording, ordering, something you would have built differently? Then
     SUGGESTION. Judge by consequence, never by irritation.

     Nothing here blocks a gate on its own; this file records observations, not verdicts. What
     the severity decides is the next step: CRITICAL and IMPORTANT raise a defect item,
     SUGGESTION does not.

     "Relates to" points at the acceptance criterion the behaviour belongs to, or the design
     section if the behaviour is outside every criterion — which is itself worth noticing, since
     it usually means the criteria missed something rather than that the tester wandered.

     Status values, each carrying its consequence in the same cell:
       Open                          — recorded, not yet triaged
       Defect raised — <defect key>  — a defect item exists and is cited
       Rejected — <reason>           — the observed behaviour is correct; say why
       Withdrawn — <reason>          — the observation was wrong; say why
     A finding is never deleted from this table and never leaves it. A session with findings
     removed is a session nobody can audit. -->

| ID | What was observed | Expected behaviour | Severity | Relates to | Status |
|---|---|---|---|---|---|
| <KEY>-TS-<nn>-F01 | <what the tester did, and what the system did — reproducible from this cell alone> | <what the criterion or design says should have happened, cited> | CRITICAL | AC-<n> | Defect raised — <defect key> |
| <KEY>-TS-<nn>-F02 | <observation> | <expectation> | IMPORTANT | <§ title of the design section> | Open |
| <KEY>-TS-<nn>-F03 | <observation> | <expectation> | SUGGESTION | AC-<n> | Rejected — <why the behaviour is correct as built> |

## What worked

<!-- Not optional and not padding. A session that records only failures cannot be told apart
     from a session that only looked at the broken parts, and the next reader needs to know how
     much of the surface was actually exercised and stood up. -->

- <the criterion or behaviour exercised, and what was seen that satisfied it>
- <the path that was tried hard and did not break, including the edge cases attempted>

## Not exercised

- <what this session did not reach, and why — no environment, no data, no time, out of scope>

<!-- Recorded so that "no findings" is never mistaken for "verified". Untested is a state, and
     it is a different state from passing. Where the session reached everything in its declared
     scope, write NONE — an empty section is unreadable as either. -->

## How a finding becomes a defect item

Each CRITICAL or IMPORTANT finding becomes **one defect item at the start of the flow**, citing
this session's finding identifier, the originating work item key, and the acceptance criterion
or design section it relates to. It gets its own worktree, its own design, its own review round
and its own human gates — a fix applied directly to merged code is an unreviewed change to code
that already passed them. The finding's status is then updated to name that defect item, and the
original work item is not moved, not reopened and not partially amended.

A SUGGESTION does not raise a defect item. It is recorded, and it stays recorded, so that the
same observation made three sessions running is visible as a pattern rather than re-discovered.

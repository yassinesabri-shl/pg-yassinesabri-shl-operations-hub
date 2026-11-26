---
name: authoring
description: How to write and complete a rule in the rule pack. A guide for rule authors, loaded only when a rule is read.
globs: [".claude/rules/**", "docs/estate/_TEMPLATE.rule.md"]
alwaysApply: false
paths: [".claude/rules/**", "docs/estate/_TEMPLATE.rule.md"]
---

<!-- Part of the harness asset library c6f3b4427d58f7c3 (see VERSION.json) · 2026-09-01 -->

# Authoring the rule pack

The rule set is **sixteen**. Seven ship complete because they encode the operating model and
hold on any repository: `workflow.md`, `worker-critic.md`, `context-budget.md`, `security.md`,
`estate.md`, `communication.md`, `watermark.md`.
Nine ship as **stubs** because their substance is repository-specific and only the adopting
team knows it: `contracts.md`, `type-pipeline.md`, `testing.md`, `git-workflow.md`,
`backend.md`, `frontend.md`, `coding-style.md`, `copyright.md`, `connector.md`.

A stub is a marked seam, not a placeholder to delete. Installing a stub tells every agent
"this control exists and is not yet specified — treat the gap as most-restrictive"; deleting
it tells them the control does not exist. Do not invent stub content at install: an invented
rule reads as agreed and nobody agreed it.

**In a hub and its spokes, the code-facing stubs are completed in the spoke, not in the hub.**
A hub holds no code, so `backend`, `frontend`, `coding-style`, `git-workflow`, `testing`,
`contracts`, `type-pipeline`, `copyright` and `connector` have nothing to bind there. Each spoke
writes its own under the folder its `checks.env` names with `RULES_INDEX`, in the same
frontmatter shape, one always-on file and the rest path-scoped; `estate.md` §3 says how the hub
reads them and `scripts/check-spoke-rules.mjs` checks them on the spoke's pull requests. The hub's
stubs stay as stubs, marked seams recording that the control exists; whether they move out of the
hub is the `UNRESOLVED` at the end of `estate.md`.

Every spoke rule follows `docs/estate/_TEMPLATE.rule.md`: the four keys, then Must, Scope,
Checked by, Exceptions, Examples and Origin. `/add-context --kind rule --repo <ID>` drafts one
from a person's intent, after settling it with them, and opens the pull request in the spoke; a
person may write one by hand from the same template. Either way it lands through review and a
human merge. A spoke rule that departs from a hub or global standard on purpose names what it
replaces in the optional `overrides` key, a whole standard or one rule of it; `estate.md` §3
says how the hub reads that and what it checks. The merge in the spoke is the approval.

## What every rule file owes

1. **Frontmatter** — `name`, `description`, `globs` (the paths the rule binds to),
   `alwaysApply` (`true` only for rules that govern every task; path-scoped otherwise).
   A path-scoped rule also carries `paths:`, the same list as `globs:`. Claude Code loads
   every file in `.claude/rules/` at session start, and it reads neither `globs:` nor
   `alwaysApply:`. Only `paths:` makes it wait for a matching file. An always-on rule has no
   `paths:`, and the constitution imports it by path. `scripts/check-context.mjs` checks both.
2. **One contract per rule.** A rule states what must be true, who owns exceptions, and how
   the rule is checked — script, CI job, or review. If two unrelated contracts share a file,
   split the file.
3. **Checkable phrasing.** "Tests are written first" is checkable in a commit history;
   "code should be well tested" is not. Prefer the sentence a critic can cite by line.
4. **No restatement.** Cite the constitution (`CLAUDE.md §n`) and other rules by path;
   never copy their text. A second copy of a rule is a copy that drifts.
5. **Marked unknowns.** Anything the team cannot pin yet stays in the pinned grammar:
   `UNRESOLVED — <what>. Owner: <role>. Resolves: <trigger>.` Never a bare open question.

## Completing a stub

1. Read the stub's "what belongs here" list — it is the checklist of decisions, not content.
2. Write the contract from the repository's reality (its tooling, its pipelines, its
   contracts), citing files and commands that exist. Never guess a fact a command could
   establish.
3. Replace the stub banner, resolve or re-own every `UNRESOLVED` marker, and record the
   completion in `docs/harness-decisions.md` (the register's open-items table carries every
   stub until it is completed).
4. Land it like any other change: through review and a human merge. A rule binds every agent
   from its next session, which is exactly why a human reads it first.

Special case — `testing.md`: the coverage numbers are **never** authored by hand, and never
written into this rule. Decision 2a sets two, and the spoke install writes both into that
spoke's `checks.env` — the whole-project floor from the measured trunk figure rounded down, and
the changed-line floor from the fixed percentage that decision sets. The project floor moves
only at a sprint boundary, and only to a level the repository has already reached. The stub
carries the structure and points at `checks.env`; decision 2a carries the numbers, and
`scripts/check-coverage.mjs` judges them.

## Charter-size policy

The companion drift guard lives in `context-budget.md` ("Charter size — the drift guard"):
charters are 20–60 lines, the accelerator repository's CI fails any charter over 80 lines,
and method lives in skills, once. Rule authors inherit the same discipline: rules state
contracts, skills state procedures.

UNRESOLVED — whether `scripts/check-spoke-rules.mjs` requires the template's six sections, which
would refuse every rule folder written before the template. Owner: harness lead. Resolves: the
first estate whose spokes all follow the template.

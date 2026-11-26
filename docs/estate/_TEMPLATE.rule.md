---
name: <kebab-case-id>
description: <one sentence: what this rule makes true, and where>
globs: ["<path pattern>"]
alwaysApply: false
---

<!--
The rule template. `/add-context --kind rule` writes every spoke rule from this file,
section for section, and drops this comment. A person writing a rule by hand does the same.

- The four keys above are required. One more is optional: `overrides`, a one-line JSON array of
  the hub or global standards this rule replaces where it binds, whole (`std-<topic>`) or one
  rule (`std-<topic>.<NN>`), with the `global.` prefix for a global standard. Example:
  `overrides: ["std-php-services.03", "global.std-logging"]`. Add the key only when the rule
  departs from a standard on purpose; a decision record is never overridden.
  `scripts/check-spoke-rules.mjs` accepts no other key.
- `alwaysApply: true` is for the one rule that binds every change in the repository; its globs
  are then ["**/*"]. Every other rule is path-scoped and names narrower globs.
- The whole file stays within 80 lines. A rule that needs more is two rules, or a skill.
- One contract per file (`.claude/rules/AUTHORING.md`). Keep every section; write `None.` where
  there is nothing.
- Every sentence is one a critic can cite by line: "Local variable names are camelCase", not
  "names should be readable".
- Cite another rule or the constitution by path; never copy its text.
- An open point is `UNRESOLVED — <what>. Owner: <role>. Resolves: <trigger>.`
-->

# Rule — <the rule in a few words>

## Must

- <one checkable statement of what must be true>

## Scope

<The paths the globs name, in words, and any path inside them the rule does not cover.>

## Checked by

<script | CI job | review> — <the checks.env command, the CI job's name, or what a reviewer looks for>.

## Exceptions

<The role that may grant one, and where it is recorded.>

## Examples

- Right: <a short example>
- Wrong: <a short example>

## Origin

<The intent as given, quoted; or the source document's title and revision.> Owner: <role>.

---
name: communication
description: How every agent writes English for a person or another agent — short, literal sentences that a reader cannot misparse.
globs: ["**/*"]
alwaysApply: true
---

<!-- Part of the harness asset library c6f3b4427d58f7c3 (see VERSION.json) · 2026-10-15 -->

# Rule — communication

A reader of harness text cannot ask the author what a sentence means. A critic, a gate runner,
a reviewer at a merge and an engineer in another time zone all read the text once and act on it.
This rule removes the two causes of a wrong reading: a word with more than one meaning, and a
sentence with more than one structure. It applies Simplified Technical English (ASD-STE100) as a
discipline, not as a certified standard.

## Scope

This rule binds every English text an agent writes:

- replies to a person in a session, and handoffs and returns between agents
- commit messages, pull-request descriptions and review comments
- the prose of every artefact: requirements, stories, designs, reviews, reports, clarifications
- charters, skills, commands and rules
- the text a script prints for a person to read

Text that exists before a change is not rewritten only to comply. A change makes the lines it
touches comply, and no others.

## Two modes

| Mode | Applies to | What binds |
|---|---|---|
| Strict | charters, skills, commands, rules, handoffs between agents, critic findings, clarification requests, script output | every rule below |
| Flavoured | replies to a person, commit and pull-request text, requirements, stories, designs, reports | the structural rules. Word choice is advisory |

## Structural rules

1. Use the active voice. Use the passive only when the actor is unknown or does not matter.
2. Write one instruction in each sentence.
3. Keep an instruction to 20 words or fewer, and a description to 25 words or fewer.
4. Do not use a semicolon. Write two sentences.
5. Do not use a phrasal verb. Write "start", not "spin up". Write "remove", not "take off".
6. Do not stack more than three nouns. Write "the queue that holds review tasks", not "the review task queue handler".
7. Keep the subject, the verb and the article. Do not drop words to save space.
8. Use a numbered or bulleted list for three or more steps or conditions.
9. Keep one topic in each paragraph, in six sentences or fewer.
10. Use the simple tenses. Keep a compound form only where it carries a fact that the simple form loses, as in "may have failed".

## Word choice

1. Give one thing one name, and use that name every time in the document.
2. Use one verb for one action. Do not alternate "check", "verify" and "confirm" for the same action.
3. Use the verb, not a noun made from it. Write "analyse the log", not "perform an analysis of the log".
4. Do not use marketing words: seamless, robust, powerful, effortless, dramatically. Give the measurement or delete the word.
5. Do not stack hedges. State the claim, or delete it.
6. Define a domain term the first time it appears, unless the repository's glossary defines it.

## What a rewrite never changes

- **Modality.** "May have failed" stays "may have failed". A hedge records the writer's
  confidence, and confidence is content. When a rule above and modality disagree, modality wins.
- **Facts.** A rewrite adds no cause, frequency or mechanism that the source did not state. It
  drops no condition, exception, number or scope qualifier. Keep the longer sentence instead.
- **Literal text.** Tokens that a script reads (`CLAUDE.md` §5), the `UNRESOLVED —` grammar, the
  watermark trailer, identifiers, paths, code and command lines stay byte for byte.
- **Quoted text.** A stakeholder's words, quoted for traceability, stay as written.
- **Spelling.** British English, and `artefact`.

Short is not the goal. Stop when a sentence has one reading, not when it has the fewest words.
This rule fixes the form of a text. It does not make empty content useful. Say that the content
is empty instead.

## Checked by

The critic reviews every artefact against this rule, because it reviews against the hub's
always-on rules (`review-artefact` skill, step 3). It uses the one severity scale:

- `IMPORTANT`: a Strict-mode sentence with more than one reading, or a rewrite that changed a
  hedge into a fact or added a fact.
- `SUGGESTION`: any other breach.

UNRESOLVED — a script that checks the structural rules on the lines a pull request changes.
Owner: harness lead. Resolves: the library version that ships `check-prose.mjs`.

## Origin

Adapted from the rule categories of ASD-STE100 Issue 9 (January 2025), through the open
`asd-ste100-skill` by Dustin Yuchen Teng (https://github.com/danyuchn/asd-ste100-skill). This
file does not reproduce the ASD dictionary, which ASD does not permit others to redistribute.
Word choice is therefore a direction, not a check against an approved word list.

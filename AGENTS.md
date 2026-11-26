# AGENTS.md — pg-yassinesabri-shl-operations-hub

<!--
  Cross-runtime companion template, v1.0.
  Purpose: this repository is primary-runtime-first. Other agent runtimes do not
  read the constitution automatically, and nothing here loads a rule by file glob.
  This file tells every runtime exactly what to read and which checks to run by hand.
  Keep it LEAN. Everything here is either a pointer or one of the two or three
  rules that are too critical to leave behind a link.
-->

## What this repository is

The hub of the Larder operations estate: a factory producing requirements, decompositions and designs for orders-api (Go) and fulfilment-service (Java). It is not the running system; no application code lives here.

Stack: Markdown documents and Node 24 scripts; the spokes are Go and Java
Package manager / task runner: make
Branching: short-lived branches off `main`; one worktree per work item; merge, never rebase.

<!--
  The three tokens above are UPPER_SNAKE on purpose. Prose placeholders written in
  lowercase with spaces are invisible to the token grep the post-generation
  checklist runs, and a shipped AGENTS.md reading "Stack: <languages, frameworks,
  datastores>" ticks every line green in the one file every non-primary runtime is
  told to read first.
    The hub of the Larder operations estate: a factory producing requirements, decompositions and designs for orders-api (Go) and fulfilment-service (Java). It is not the running system; no application code lives here.  one paragraph: what the system does, and whether this
                      repository is the running system or a factory producing
                      artefacts for one
    Markdown documents and Node 24 scripts; the spokes are Go and Java           languages, frameworks, datastores
    make     e.g. make, uv, pnpm
    main           the default branch, e.g. main, master, develop
-->

## Which runtime is primary

**This repository is `Claude Code`-first.** The source of truth for agent behaviour is:

- `CLAUDE.md` — the constitution, loaded automatically by the primary runtime
- `.claude/rules/*.md` — the rules. `CLAUDE.md` imports the always-on ones by path. The
  primary runtime loads a path-scoped one when a file its `paths:` matches is read. Every other
  runtime reads the path-scoped ones on demand
- `.claude/skills/*/SKILL.md` — procedures, loaded just-in-time by the primary runtime

**Do not trust a runtime to load a rule by its globs.** `globs:` and `alwaysApply:` in a
rule's frontmatter are a declaration of intent. The always-on rules reach an agent because the
constitution imports them. The path-scoped ones reach it because the read list below says to
read them. Claude Code also loads a path-scoped rule when a file its `paths:` matches is read.
Treating any of this as automatic in another runtime is how a security rule ends up binding
nobody.

**If you are not the primary runtime, the constitution does not load automatically either.**
Read the files listed below yourself, and run the checks in the "Manual checks" section by
hand, because you will not receive them as hooks.

## Read list — what to read, and when

Read the first two always. Read the rest only when the "applies when" column matches
the files you are about to touch.

| Read this | Applies when | Why |
|---|---|---|
| `CLAUDE.md` | always | the constitution: scope, permissions, source-of-truth order, escalation |
| `.claude/rules/workflow.md` | always | the work-item state machine and who owns each transition |
| `.claude/rules/worker-critic.md` | you are producing or reviewing an artefact | revision caps, escalation, delta-only re-review |
| `.claude/rules/context-budget.md` | any task touching a large corpus | read order, subagent contract |
| `.claude/rules/security.md` | auth, entitlements, logging, data handling | deny-by-default, no personally identifiable information in logs |
| `.claude/rules/estate.md` | always | who decides what between the hub and its repositories; a fact read in another repository carries its commit |
| `.claude/rules/communication.md` | always | how every text an agent writes reads: short, literal sentences with one reading |
| `.claude/rules/estate.md` | editing `docs/**` | one row per rule this repository adds — see the note below |
| `docs/architecture/` | a design meets a structural decision | the summaries of decided records; a new decision is a draft beside the design for the lead architect, never a file here |
| `contracts/` | touching a cross-system interface | the versioned agreement — you cannot change it here |

<!--
  The first seven rows are the constitution and the six always-on rules the
  accelerator library ships; `CLAUDE.md` imports the same six by path. Repository-specific rules —
  typically some of `backend`, `frontend`, `contracts`, `type-pipeline`, `testing`,
  `git-workflow`, `coding-style`, `copyright`, `connector` — are the adopting team's
  to write, and each one gets its own `estate` row with its own `docs/**`
  taken from this repository's real tree. Delete the `estate` row entirely if
  the repository has no additional rules yet: a read list that points at a file
  which does not exist is a dangling pointer for every runtime that trusts it.
-->

## Manual checks — run these, in this order

The primary runtime runs these as hooks. You do not get the hooks. Run them yourself
before you claim a task is complete.

    # 1. format and lint (fastest signal; fix before anything else)
    none
    none

    # 2. types (both sides of the stack)
    none
    none

    # 3. tests, with both coverage checks (decision 2a)
    node tests/check-dev-ready/run.mjs        # project floor: 0% — and must not fall
    none       # project floor: 0% — and must not fall
    none    # changed lines: 0%

    # 4. repository hygiene
    none
    # The next two are conditional. Neither is probed by the onboarding survey,
    # so neither may be invented: substitute a command this repository really has,
    # or delete the line.
    none — this hub has no migrations      # decision 2a check 6. Delete only if this
                                        # repository has no migrations, and record
                                        # the deletion as an override in the ledger
    none            # only if the team wrote a copyright rule
                                        # and a script to enforce it. Delete otherwise

    # 5. the pickup gate, if you are about to start implementation
    HARNESS_TRUNK=main node scripts/check-dev-ready.js OPS-1
    # The prefix is only needed where the trunk is not `main`; the gate defaults
    # to `main` and the trunk name is runtime configuration, never a source edit.
    # exit 0 = eligible. exit 1 = not eligible. exit 2 = could not determine
    # (usually a stale trunk) — this is a failure, not a pass.
    # The gate reads origin/main, never your working tree: the design pull
    # request must already be merged. A design on a feature branch fails every gate.

Order matters. Do not run the test suite to discover a formatting error.

## Critical rules, duplicated verbatim

These are repeated here in full — not linked — because a runtime that misses them
produces work that has to be thrown away rather than corrected.

**1. Contracts are not negotiable from inside this repository.**
Never silently change a contract, schema, interface or event definition to make code
compile or a test pass. A contract is a versioned agreement with another team. If the
code and the contract disagree, the contract wins until it is formally revised, and the
revision is a human action taken with the other team. Raise a clarification; do not
adjust the shape.

**2. Types are generated in one direction only.**
Never hand-define an enum or a shared type on the consuming side of the pipeline. Types
flow from the single declared source (`none — this hub holds no code`) outward, by generation. A
hand-written duplicate compiles, passes review, and drifts silently — which is the worst
combination of properties available.

**3. Undefined controls default to deny.**
If a permission, an entitlement, or a data-handling rule is not explicitly defined for
what you are about to do, treat it as forbidden and escalate. Never log personally
identifiable information, secrets or tokens. Access checks fail closed.

<!-- Duplicate two or three, never twenty. Once this list gets long the copies drift,
     and a drifted duplicate is worse than a link because both sides look
     authoritative. The bar for a duplicate is the one stated above the list: a
     runtime that misses this rule produces work that has to be thrown away rather
     than corrected. Everything else gets a pointer. -->

## Commit and pull-request contract

**Commits.** `<type>(<scope>): <imperative summary>` — types: `feat`, `fix`, `chore`,
`docs`, `test`, `refactor`. One logical change per commit. Reference the work item key.
Never mention the agent runtime, the model, or the tool in a commit message; the commit
records what changed, not who typed it. No co-author trailers unless the repository
policy explicitly asks for them. Every harness commit is made with
`scripts/harness-commit.mjs`, never by `git commit` directly: it appends the harness watermark,
the final line `Generated-by: SHL Agentic Harness` (`.claude/rules/watermark.md`).

**Pull requests.** One work item per pull request. Body must contain: the work item key,
a link to the per-unit design, the acceptance criteria with the test that covers each,
the checks you ran and their results, and anything you deliberately did not do. A pull
request the harness opens ends its description with the watermark line
`Generated-by: SHL Agentic Harness`, after everything else. Open it non-draft only when every
manual check above passes.

**You do not merge.** The design merge and the implementation merge are human actions, and so are
the two that sit in front of the machine — signing a requirements document and merging a
decomposition. Push, open, report, stop.

## What you must never do

- Merge your own pull request, or any pull request.
- Write outside the paths the constitution permits (§3 of `CLAUDE.md`).
- Edit a migration that has been merged, or any artefact declared immutable.
- Commit a secret, a credential, or personally identifiable data — including in fixtures.
- Copy or fork code from a repository that `docs/estate/repositories.json` does not list
  into this hub or a spoke. `CLAUDE.md` §3 makes every such repository read-only.
- Create files at the repository root, or `*_SUMMARY.md`-style progress logs anywhere.
- Change a contract to make the build green.
- Resolve a contradiction between two sources by picking one. Surface both.
- Claim a task is complete without having run the manual checks above.
- Proceed past a revision cap. Escalate instead.

## If you are unsure

Stop. Raise a clarification row in the work item's design, flag the item, and hand back
to the human. The cost of a question is a delay. The cost of a confident wrong assumption
is discovered at integration, by someone else.

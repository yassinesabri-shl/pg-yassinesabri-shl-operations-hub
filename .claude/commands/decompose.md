---
description: Turn a requirements document into a reviewed, traceable set of work items ready to enter the backlog at its first state. Writes files into a pull request a script checks; creates nothing in a tracker until that pull request is merged and the check passes on the trunk.
argument-hint: <requirements-source>
---

<!-- Part of the harness asset library c6f3b4427d58f7c3 (see VERSION.json) · 2026-09-18 -->

# `/decompose <requirements-source>`

**This file is a contract, not an integration.** Every tracker call below is a placeholder for the
team's own call, and the backlog directory is the team's own path; substitute both once, here. The
gates are not placeholders — they are enforced against the repository, and the repository is the
fact. One placeholder has a shipped answer: where the hub has a Jira connection
(`docs/estate/trackers.json`, written by `/connect-jira`), step 9 is `scripts/jira-sync.mjs
create`, under `.claude/rules/jira-mirror.md`. A hub with no connection leaves the placeholder as
it is.

**No tracker item is created before the decomposition is merged and checked on the trunk.** That
is the rule this command exists to hold, and it is the one an agent under time pressure will
argue its way around: the decomposition is reviewed, the verdict is `APPROVED`, the items are
obviously right, so why not just create them. Because files are reversible and a backlog is not.
A hundred wrong items in a shared tracker is a week of somebody's life spent deleting them, plus
every notification, sprint report and dependency link they touched on the way. The authorisation
is two facts read from the repository: the decomposition pull request reports `MERGED`, and
`scripts/check-decomposition.js <SLUG>` exits 0 against the trunk. Nothing typed by anyone, and
no call fires before both.

**Purpose.** Turn one requirements source into a reviewed, traceable set of work items, each ready
to enter the backlog at its first state. It writes files, and stops in front of a human.

## Inputs

| Input | Form | Where it comes from |
|---|---|---|
| `<requirements-source>` | **A path to a requirements document in this repository** — the one `/feature` wrote and a person merged. Nothing else resolves today | The argument |
| The source document | Readable, with section titles and line numbers stable enough to cite, on the hub's trunk with `check-requirements.js <SLUG>` green | `docs/requirements/<SLUG>/requirements.md` from `/feature`, or the client's own document reviewed the same way |
| Its revision | A version, a date or a commit — named, not implied | The document, or the human who ran the command |
| The key ledger | `docs/backlog/keys.json`: the key prefix, the next free number, and one block per artefact that has minted keys. **Nobody is asked for a key range; this command takes the next block and advances the counter in the same pull request** | The hub install writes it with the client's prefix; every `/decompose` run advances it. A `validation` block that an older `/qa-sprint` minted for defect keys stays, and is read; `/qa-sprint` mints no keys now |
| The source-of-truth hierarchy | `CLAUDE.md` §4, with its tie-breaker | Onboarding |
| The backlog directory | `docs/backlog/`, unless the team substituted another | This file; a substitution is recorded in `docs/harness-decisions.md` |
| The list of repositories | `docs/estate/repositories.json`, well formed, naming at least one repository | `/add-repo`, one repository at a time |
| The estate overview | `docs/estate/overview.md`, where one is on file: one plain-English page on what the estate is, part by part, and who owns each part. Orientation for the repository map; a hub document, cited by its path | `/estate-overview-refresh`, or `/add-context` for a page the lead architect wrote |
| `scripts/read-spoke.mjs` | The one way a seat reads a repository on the list: an id and a path in, the commit and a `Cite:` line out. No branch argument | Installed with the hub |
| `scripts/read-spoke-rules.mjs` | The repository's always-on rule and its `Status:`, read at the same pinned commit, for orientation only | Installed with the hub; the spoke's `checks.env` names the folder with `RULES_INDEX` |
| `scripts/read-context.mjs` | `<id> --at <commit>`: the index of the context documents in scope for one repository — the hub's decision records, standards and merged requirements documents, and that repository's contracts and third-party API documents — one line each, no bodies; `--names <id>,…` opens the ones a line shows bear on the cut, each with a `Cite:` line. Orientation for the boundary, and then, per story, the selection: `--names <id>,…`, or `--names ''`, at the story's repository and commit prints the `Context:` line the story carries. Where the source records a release on its `Global:` line, every run adds `--global <commit>` with that line's commit, and the global documents join the index, each id prefixed `global.` | Installed with the hub; the spoke's `checks.env` names its contracts folder with `CONTRACTS_INDEX` |
| `scripts/read-survey.mjs` | `--find <words>`: every key the surveys carry that a word finds — in the key, in what a serve does, in a store's objects — with who serves, calls, touches or uses it; no remote asked. `--readers <key>`: every surveyed repository that serves or calls a contract, uses a library or touches a store, each with its drift line; apart, every one that calls it with the provider `unknown`; and every listed repository with no survey. Built from the service surveys when asked; points, never cited | Installed with the hub; the surveys come from `/survey-repo` |

## Preconditions

1. The source resolves and is readable in full. Not a summary of it, not a briefing about it, not
   a previous decomposition of it.
2. The source has citable structure. Every item this command writes cites a section title and a
   line range, so a document with no stable sections is not decomposable — report that and stop
   rather than decomposing it approximately.
3. The revision is named. A decomposition is written against one revision of one document; without
   that, nothing downstream can tell whether an item is stale.
4. **The source is on the trunk, and `HARNESS_TRUNK=main node scripts/check-requirements.js
   <SLUG>` exits 0 against it.** That is what "accepted" means for a requirements document: its pull request was merged
   with the check green, so its identifiers are in the grammar, every requirement has a criterion,
   and an approved review is bound to its bytes. A document on a branch, or one the check refuses,
   is not decomposable — report the check's findings and stop. Exit 2 is an escalation, not a
   pass.
5. No decomposition record already exists for this source at this revision. One record per slug,
   revised in place: a changed source, or a requirement released from its blocking clarification,
   produces a **new revision** of the record at the same path — `r<n+1>` in its control table, the
   earlier revision in git history — never a silent edit. Identifiers already issued keep their
   numbers, items already cut keep their files, new items take a new block from the ledger, and the
   review is written again against the new bytes. A revision of the source merges before this
   command runs again: `decomposition-gate` passes on the requirements pull request and prints
   as notes what the record does not carry yet. From that merge until the new revision of the
   record merges, `check-decomposition.js <SLUG>` fails on the trunk. That is correct, and this
   command is the repair. A story that carries a criterion the source now marks `DEPRECATED`
   retires its own row in the new revision: `DEPRECATED` as the first word of the Criterion cell,
   the `AC-<n>` number and the `Carries` cell kept
   (`.claude/skills/decompose-requirements/SKILL.md` § The output shape).
6. The source-of-truth hierarchy is written down, with its tie-breaker. Sources will disagree, and
   the agent resolves by rule rather than by preference.
7. `docs/backlog/keys.json` is on the trunk and well formed: a `prefix`, a `next` number, and a
   `blocks` list. Keys are minted from it here and used unchanged for the rest of the lifecycle, so
   a missing or malformed ledger is an escalation to the role that owns the hub, never a reason to
   invent a numbering scheme or ask a person for a range.
8. **Every requirement in the source is decomposed, excluded with a reason, or held.** There is no
   signed set to read and no row that holds a requirement back. A requirement the business has
   not yet settled is one with a blocking clarification against it in the source's own table:
   record it in the coverage map as `Unresolved`, in the pinned grammar, with the role who owns the
   answer, and mint no key for it. A requirement marked `DEPRECATED` in the source is excluded with
   that as its reason. Everything else is cut. `check-decomposition.js` reads the source's `REQ-<n>`
   set and refuses a record that leaves one unmapped.
9. **Where `/feature` produced the source, `<SLUG>` is already minted and is reused, not re-derived.**
   It is in the `Slug` row of the document's Feature Name table. Deriving a second slug from the same document splits
   the record and the requirements it cites across two names, and `refine` then looks for the
   record under the source slug and does not find it.
10. **The list of repositories is well formed and names at least one repository.**
    `node scripts/check-registry.mjs --offline` exits 0. Every story names exactly one repository
    from that list, so a hub whose list is empty has nothing a story can name: stop, and say that
    `/add-repo` comes first. The list is an index, never the truth. What the planner reads is the
    repository itself, at a pinned commit, through `scripts/read-spoke.mjs`.
11. **A re-run after a cap finds something changed upstream.** Run
    `node scripts/escalation.mjs resume --slug <SLUG> --by-seat decompose`. Exit 0 means the run
    may start: no escalation is open, or the requirements document or a closed clarification
    changed since the cap, and the script wrote `resumed` with what it found. Exit 1 means that
    nothing changed, or that an incident is open on the work. Stop at once, print what the script printed and say that a cap is never
    raised. Exit 2 is exit 2 for this command: stop.

## The state transition it owns

`(nothing) → TODO`, **agent-owned as far as the files are concerned, and no further.** A work item
exists at `TODO` when its file exists in the backlog directory, traced, reviewed and complete. That
is a fact a script can check, which is what makes the move agent-owned at all.

**Creating the corresponding items in a tracker is not part of that transition.** It is a
placeholder call, and it is gated on two facts this command must *read* before it fires: the
decomposition pull request reports `MERGED`, and `HARNESS_TRUNK=main node
scripts/check-decomposition.js <SLUG>` exits 0 against the freshly fetched trunk. An authorisation inferred from the fact that a human
ran the command, relayed verbally by whoever ran it, or read out of a chat thread is not one. If
the pull request is not merged, or the check does not exit 0, the command has already finished.

## What it does

1. **Read the source in full, before opening a template.** All of it, including the sections that
   look like preamble — scope caveats and definitions live there, and they are what decide whether
   two requirements are one item or two. A decomposition written from a skim splits on headings
   rather than on work.
2. **Map the source before splitting it.** One row per source section: the item or items it lands
   in, or **out of scope with a stated reason**. Build this first, because it is the only artefact
   that shows what was *not* decomposed. Everything else shows what was. A section marked out of
   scope with no reason is a scope cut wearing a decision's clothes.
3. **Read the estate before cutting anything — the per-repository stage.** Every story names
   exactly one repository, so the planner has to know which repositories the requirement touches
   before it draws a boundary. Four moves, in this order; the method in
   `.claude/skills/decompose-requirements/SKILL.md` § The repository map carries the detail.
   - Read the estate overview, `docs/estate/overview.md`, where one is on file, and, for every
     repository in the list, its `purpose` and its `readAt`, against what the requirements
     document says must become true. Together they order the reading — which repositories to
     read first, and how deeply. They cost nothing and rule no repository out; the purpose is
     never cited, and the overview is a hub document, cited by its path. The requirements
     document names no repository: its author is not asked, and this stage is where the answer
     is found. A `Repositories likely touched` row in a document written before that rule is
     ignored.
   - For every repository in the list, without exception, run `node scripts/read-spoke.mjs <id> .`.
     The script pins the trunk commit and prints a `Cite:` line, and that tree read is what a
     **does not change** row rests on. Where the commit differs from `readAt`, note it and trust
     what was read, never the purpose. For every repository the requirement could touch, then
     `node scripts/read-spoke.mjs <id> README.md` and `node scripts/read-spoke-rules.mjs <id> --at <commit>`, which with no
     paths prints the repository's always-on rule and its `Status:`. The rule is orientation,
     cited from its `Cite:` line; the `Status:` goes into the row's evidence as printed, so
     `NOT CONFIGURED` or `NOT WELL FORMED` is known here and not first at design time. No
     `--design`, no `Rules:` line on a story: selection is `/dev-spec`'s, from the design's paths.
     Where the requirement names a behaviour, search each repository it could touch with
     `node scripts/read-spoke.mjs <id> --grep <text> --at <commit>`, so a second place that holds
     the logic is a row in the map and not a surprise at design time.
     At the same commit, `node scripts/read-context.mjs <id> --at <commit>` prints the index of
     the context documents in scope — the hub's decision records and standards, and this
     repository's contracts and third-party API documents — one line each, no bodies. Open with
     `--names <id>,…` only the documents whose line bears on the cut: the contract of an
     interface the requirement changes, a decision record that fixes a boundary. Cite each fact
     from the `Cite:` line it prints. Never `--all`, `--design` or `--paths`: selection by path
     is `/dev-spec`'s, from the design. Each story selects its own documents by name in step 4.
     Where the source records a release on its `Global:` line, add `--global <commit>`, with the
     40-hex commit from that line, to every `read-context.mjs` run of this step and of step 4.
     Where it says `Global: none`, or has no line, run without it.
   - Find the keys before the readers. Run `node scripts/read-survey.mjs --find <words>` with the
     words the requirement uses for what it changes — the thing, the field, the screen, the
     record — and take every key it prints that fits the change as a candidate contract. It finds
     keys and never rules one out: a key added after a survey's commit is not in it, and the code
     read below can add more.
   - For every contract the requirement could change — an endpoint, an event, a queue message, a
     stored record, a shared library — run `node scripts/read-survey.mjs --readers <key>`. Every
     repository it prints as a reader goes on the short list and is read at its pinned commit, and
     the story that moves it cites that read, never the survey. Every repository it prints under
     `May be read by` — a call to the key whose provider its survey leaves `unknown` — goes on the
     short list too, and that read settles whether it reaches the service that changes. Every repository it prints as not
     surveyed stays in play: a survey finds readers, and never rules one out.
   - For every repository on the short list, read what the cut needs at that pinned commit, with
     `--at <commit>` so every file comes from one commit, and cite each fact as
     `<id>@<12-hex>:<path> L<a>-<b>`.
   - Write the repository map into the record: one row per repository in the list, carrying
     either the stories that change it or **does not change**, with the evidence read. A
     repository with no row was not considered, and nobody can tell that from one that was.

   A requirement that needs a change in a repository the list does not name is a blocking
   clarification addressed to the role that owns the estate, and `/add-repo` is the answer. It is
   never a story under an invented id, and never a widened story in a repository the list does
   carry.
4. **Draft the decomposition — the `product-planner` seat**, on the method in
   `.claude/skills/decompose-requirements/SKILL.md`. One item is one unit of deliverable work: one
   design, one pull request, one set of acceptance criteria, **one repository**. **Cut thin
   vertical slices, never layers**: each item is a narrow path through every layer of its
   repository that a user or a caller can actually exercise. "Build the data model", "build the
   API", "build the UI" as three items is the anti-pattern, because none of them can be verified
   on its own. Siblings under the
   epic, never subtasks — a parent with children has no defined state, so no gate can evaluate it
   and no agent can own its transition. Each item file carries a key, exactly one `Repository:`
   line naming one id from the list, the source sections it implements by title and line,
   acceptance criteria with `AC-<n>` identifiers and at least one negative case, its dependencies
   by identifier, and every interpretation the planner made recorded as a decision or a
   clarification row. A change that needs two repositories is two stories, one per repository,
   with a dependency between them in the map — the same map that carries every other dependency.
   **Each story carries one `Context:` line**, under `Repository:`. The planner runs
   `node scripts/read-context.mjs <repository> --at <commit> --names <id>,…` at the commit the
   story's repository-map row was read at, with `--global <commit>` as in step 3. A global entry
   on the line pins the source's global commit. The ids are each document that bears on the story,
   and each document on the source's `Context:` line that bears on it. `--names ''` is the run
   when none bears. The planner copies the printed `Context:` line whole, with the `Hub commit:`
   line the same run printed under it, and keeps the printed text: this command hands it to the
   critic. Each document on the source's line is on at least one
   story's line. Each document on a story's line is used in the story: an id named where it
   shapes a criterion, a standard cited by the rule it applies, `std-<topic>.<NN>`.
   **Every story, merged on its own after the stories it depends on, leaves every repository's
   trunk working and deployable**, as if it ships on merge: a contract is never replaced in
   place, stored data changes by expand, backfill, contract, and nothing a user can reach lands
   before what it needs (the skill's § Every story leaves the trunk working).
   Every fact read in a repository is cited as `<id>@<12-hex>:<path>`; a citation into a repository
   without its commit is malformed, and the critic refuses it. **Every item criterion names, in
   its `Carries` column, the one `REQ-<n>.AC-<m>` it carries**, because the two numbering schemes
   are deliberately different and nothing else in the chain records which item criterion answers
   which requirement criterion. The identifiers are universal — `check-requirements.js` refused
   the source without them — so the column is never empty and never invented.
   `check-decomposition.js` refuses a criterion that carries one the source does not define.
   **Keys are minted from `docs/backlog/keys.json`**: read `next`, take as many consecutive numbers
   as there are items, write `{ "from", "to", "taken_by": "decomposition", "slug": "<SLUG>" }` into
   `blocks`, and set `next` past the block — in the same pull request, so two decompositions racing
   conflict on the merge rather than mint one key twice. The blocks recorded for this slug are,
   together, exactly the keys the items carry: no spare numbers, none skipped, and a re-cut adds
   a block rather than re-minting. Each key is minted once and is the same key `/dev-spec`,
   `docs/designs/<KEY>.lld.md` and the pickup gate will use. There is no parent epic to ask for and
   no epic file to write: the record is the parent, and every story is a sibling in it.
5. **Review it — the `pm-critic` seat, on fresh context** (`.claude/agents/pm-critic.md`), with
   `Mode: decomposition-review` and the method in `.claude/skills/review-artefact/SKILL.md`. The
   verdict is a token, on its own line, exactly `### VERDICT: APPROVED` or
   `### VERDICT: CHANGES REQUESTED`, followed by `Cycle: <n> of 2`, `Mode: decomposition-review`
   and `Reviewer: <seat name>` — four lines, the same four everywhere in the library.
   Under the heading `## Review: <SLUG> — <what is under review>`, which is how the check reads
   which decomposition the review is about. `CRITICAL` and `IMPORTANT` block acceptance;
   `SUGGESTION` does not. That seat holds no write tool at all: it returns each round in-loop,
   this command persists the round to the system temporary directory as
   `<SLUG>-decomposition-review-round-<n>.md`, and writes the final round beside the record as
   the review file (step 7). **Nothing is written into the record after the round that approved
   it** — not a summary, not a date — because the review binds those bytes. The
   critic receives, as text, the `read-context.mjs` output kept for each story, and opens no
   context document itself. Among the things the critic checks: every story names exactly
   one repository and it is in the list, every repository in the list has a row in the repository
   map, every story merged in dependency order leaves every trunk working, and every citation
   into a repository carries its commit — opened through
   `scripts/read-spoke.mjs --at`, the same way the planner read it.
6. **Loop, capped at two rounds.** On resubmission the critic reviews only the delta plus what that
   change could plausibly have broken, and the planner submits an explicit change list: what
   changed, which finding each change addresses, and which findings were deliberately not addressed
   and why. The change list is the planner's own account of its work. Only a diff shows the
   critic a change that the list leaves out. A resubmission can change the record, any work item
   and the key ledger, so store all of them as one tree before each critic dispatch:
   1. Run the two commands below from the hub checkout, with `<index>` a new path in the system
      temporary directory. The private index keeps the snapshot out of the staging area.

      ```
      GIT_INDEX_FILE=<index> git add -- docs/backlog/<SLUG>.decomposition.md docs/backlog/<SLUG>/ docs/backlog/keys.json
      GIT_INDEX_FILE=<index> git write-tree
      ```

   2. Record the printed tree id beside the round, and delete `<index>`.
   3. On a resubmission, put the planner's change list in the dispatch. Below it, put the output
      of `git diff <tree of the last reviewed round> <new tree>`, under the heading
      `## Diff since the last review`.

   The round count belongs to this command. On cap: raise the escalation (§ The escalation
   record, below), leave the record in its last reviewed state, and stop.
7. **Write the review file.** The critic's final round, verbatim, at
   `docs/backlog/<SLUG>.decomposition-review.md`, beside the record — the shape
   `.claude/skills/shared/review-file.template.md` fixes, with `Mode: decomposition-review` and
   `Record revision: <hash>`, the value `git hash-object docs/backlog/<SLUG>.decomposition.md`
   prints for the record the critic read. The critic holds no shell to run code, so this command computes
   that value and hands it over with each dispatch. Nothing in the record changes after the round
   that approved it: the hash binds the review to those bytes, and `check-decomposition.js`
   reports a later edit as "the record changed after it was reviewed". There is no approval block
   and no row for anyone to type. Then run `node scripts/escalation.mjs resolve --slug <SLUG>
   --point decompose.review-cap --fact-kind verdict --fact-value APPROVED --round <n> --by-seat decompose`. It
   closes an escalation that an earlier cap opened, and it writes nothing where none is open.
8. **Commit on a branch, open the decomposition pull request, and stop.** `backlog/<SLUG>` is the
   convention, the commit made with `node scripts/harness-commit.mjs -m "docs(backlog): <SLUG>"`. The
   pull request's description ends with the watermark, the line `Generated-by: SHL Agentic Harness`
   on its own after the normal description (`.claude/rules/watermark.md`). The pull request
   carries the record, its review, the item files and the advanced
   `keys.json`, and nothing else. `decomposition-gate` runs `check-decomposition.js <SLUG>` on the
   pull request's content and reports on its head commit; a red check is fixed on the branch
   through another round, never by hand-editing the review. This step exists because step 9's gate
   demands a merged record, and until this command opens the pull request nothing in the flow puts
   one in front of a human — the record sits in a working tree and the second invocation can never
   fire. The merge is not a work-item transition and it is not a third human gate on a work item:
   `CLAUDE.md` §2.2's *exactly two* counts the gates each item passes through, and this one is a
   gate on the backlog that produces them, before any item exists. Do not merge it yourself.
9. **Second invocation, only when the pull request reports `MERGED` and
   `HARNESS_TRUNK=main node scripts/check-decomposition.js <SLUG>` exits 0 against the trunk:
   fire the tracker placeholder**, one call per item, in dependency order. Ask the hub's pull-request API for the
   pull request carrying the record, as `/qa-sprint` does: none is a first invocation, one open is
   a stop with the state reported, one `MERGED` is this. Then run the check from the hub checkout
   against the freshly fetched trunk. Exit 1 means the merged decomposition is incomplete — report
   the findings and create nothing; exit 2 is an escalation. The files land first — the record and
   the item files are merged on the trunk before anything is created anywhere else, so a call that
   fails halfway leaves the repository holding the complete reviewed truth and the board holding a
   recoverable partial copy. A tracker never re-keys an item: the minted key stays the key the
   rest of the lifecycle uses, and the tracker's own reference is a projection beside it. The keys
   created are exactly the keys in the ledger's blocks for this slug, which the check has just
   confirmed are exactly the item files on the trunk; on a re-cut, only the keys with no ticket yet.

   **Where the hub has a Jira connection** (`node scripts/check-trackers.mjs` prints `WELL FORMED`,
   not `NOT CONFIGURED`), the call is the sync script, run from the hub checkout as the developer
   running this command. Read `.claude/rules/jira-mirror.md` in full before the first call. It is
   a path-scoped rule, and a runtime does not load it when this command starts:

   1. `node scripts/jira-sync.mjs epics` lists the board project's open Epics. On a board whose
      `epics` is `"none"` skip this and the next question. Ask **one question**: which Epic do these
      stories go under — an open one, or a new one, suggesting the requirements document's title.
      This is the one place a person is asked for a parent; the answer is recorded once, in the link
      file, and never in configuration.
   2. `node scripts/jira-sync.mjs create <SLUG> --epic <KEY>`, or `--create-epic "<title>"`. It
      creates each story in Backlog, looks for a ticket carrying each key's label first and never
      makes a second, and commits the link file `docs/estate/tracker-links/<SLUG>.json` on the
      branch `harness/tracker-links-<SLUG>`. Exit 0: report what it made. Exit 1 is a verified
      failure (a duplicate, a field Jira insists on): report the findings and stop. Exit 2 is "cannot
      verify": report it and say the call is safe to run again, because what was made is found by its
      label.
   3. Push that branch and open a pull request carrying that one file, its description ending with
      the watermark line. Its merge is bookkeeping and accepts nothing: no gate reads the link file.
      Do not merge it.

### The seats this command dispatches

| Seat | Charter | Method | Holds |
|---|---|---|---|
| `product-planner` | `.claude/agents/product-planner.md` | `.claude/skills/decompose-requirements/SKILL.md` | the record, the item files, and the advanced `keys.json` |
| `pm-critic` | `.claude/agents/pm-critic.md` | `.claude/skills/review-artefact/SKILL.md`, `Mode: decomposition-review` | the verdict, returned in-loop; no write tool of any kind |

The round count and the interim persistence belong to **this command**, not to either seat and
not to the `sprint-orchestrator` — that seat's procedure is the three per-work-item commands, and
a decomposition happens before any work item exists.

`decomposition-review` is one of the four modes in `.claude/skills/review-artefact/SKILL.md`,
alongside `feature-review`, `lld-review` and `code-review`. The method lives in the skill; the seats
that run it are separate. `pm-critic` runs this mode and `feature-review`, and no other; do not hand
any seat a `Mode:` value its charter does not list, and do not dispatch `dual-mode-critic` here.
**There is no default mode.** A dispatch carrying no `Mode:` line is handed back and no verdict is
issued, so name the mode in every dispatch.

### The escalation record

The cap branch above raises one escalation, point decompose.review-cap in `governance/escalation-points.json`. This
command dispatches no orchestrator seat, so it calls the writer itself, from the main session. No
seat's `Write` grant grows.

    node scripts/escalation.mjs raise --point decompose.review-cap --slug <SLUG> --runner <forge login> \
      --question "<the one question a person must answer>" \
      --parked-ref backlog/<SLUG> --parked-commit <12 hex of the last reviewed commit> \
      --design docs/backlog/<SLUG>.decomposition.md \
      --findings-file <the deduplicated findings from both rounds> --by-seat decompose

The script opens the escalation's `[shl-harness]` issue in the hub, with the `raised` line, one
`notified` line and the findings as the issue's artefacts. The engineering lead is the next
person told. This command prints what the script prints, first in its closing report. It never
edits `docs/designs/CLAR-log.md`: the § Escalation record there is a view that `escalation.mjs
print` writes. Exit 2 means the line did not reach the record. Say so first in the report, and
carry the question and the findings in the report itself.

### Other escalations

These stops raise an escalation as a cap does, and then stop. Each is one call of
`node scripts/escalation.mjs raise --point <ID> --slug <SLUG> [--work-item <KEY>] --runner <forge login> --question "<the one question>" --by-seat decompose`
with the options in the last column. Print what the script prints first in the closing report. Exit
2 means the line did not reach the record: say so first, and carry the question in the report.
The sweep tells the people named in `governance/escalation-points.json` and asks again after the
wait of the path. A merge that waits for the decomposition pull request (decompose.merge) is not raised here: the sweep raises it when it is still open at the end of its working day.

| Point | When | Path | Options |
|---|---|---|---|
| decompose.key-ledger | the key ledger is faulty, or `check-registry.mjs` or `check-decomposition.js` exits 2 | check cannot run | none |

## Gates it enforces

| Gate | Behaviour on failure |
|---|---|
| The decomposition pull request reports `MERGED` and `check-decomposition.js <SLUG>` exits 0 against the trunk, before any tracker write | Refuse, and write nothing to the tracker. Never a warning, never "proceeding on the reasonable assumption". A tracker item pointing at an unmerged file is a reference to something no one has accepted |
| The source is on the trunk and `check-requirements.js <SLUG>` exits 0 against it | Refuse to cut. A document nobody merged with the check green is a proposal, and cutting a proposal is work nobody agreed to pay for, discovered at acceptance |
| Every requirement in the source has a row in the coverage map: cut, `Out of scope` with a reason, or `Unresolved` in the pinned grammar | Refuse. `check-decomposition.js` reads the source's `REQ-<n>` set against the map and refuses a record that leaves one unmapped, marks one Covered that no item carries, or uses a disposition outside those three |
| Every item cites at least one source section by title and line | Refuse the item. An uncited item is an invented one |
| Every source section is mapped — to an item, or out of scope with a reason | Refuse. An unmapped section is a silent scope cut, and nobody discovers it until delivery |
| Every item has acceptance criteria with stable `AC-<n>` identifiers and at least one negative case | Refuse the item. A criterion set with no negative case describes the happy path only |
| Every item criterion names, in its `Carries` column, one `REQ-<n>.AC-<m>` the source defines | Refuse the criterion. Two different things called `AC-3` in two artefacts that cite each other is how a test ends up asserting the wrong criterion; `check-decomposition.js` refuses a cell outside the grammar or naming a criterion the source does not have |
| No placeholder cell anywhere in the record or an item file | Refuse. A dash, `TBD`, `N/A`, `TODO`, `pending` or `?` is the cheapest escape available to an agent approaching a cap, which is why it is closed. An unknown is written `UNRESOLVED — <what>. Owner: <role>. Resolves: <trigger>.` `check-decomposition.js` reads every table in every file and refuses one |
| Every key is from a block `docs/backlog/keys.json` records for this slug, the blocks are together exactly the items' keys, and `next` has moved past them | Refuse. `check-decomposition.js` reads the ledger and refuses a key outside the blocks, a spare number in one, a leading zero, or a counter that did not move |
| Dependencies recorded by identifier, and acyclic | Refuse. A cycle between siblings is a boundary error in the split, not a scheduling problem; `check-decomposition.js` finds one and names it |
| Every story, merged on its own after the stories it depends on, leaves every repository's trunk working and deployable, as if it ships on merge — every order it relies on a `blocks` row; a contract changed by a new version or by add, move, remove; stored data by expand, backfill, contract, each step its own story; nothing a user can reach ordered before what it needs; a part kept hidden has a later story that stops hiding it | Refuse the cut. A story that works only once a sibling lands breaks the trunk for every story between the two merges. No script can see this; the critic walks the dependency order, and the human merge reads it |
| Every item carries exactly one `Repository:` line, naming an id in `docs/estate/repositories.json` | Refuse the item. A story with no repository has nowhere to land; one with two is two stories; one naming an id the list does not carry is a clarification, and `/add-repo` comes first |
| Every item carries exactly one `Context:` line and one `Hub commit:` line, copied together from `read-context.mjs <repository> --at <commit> --names`. Each document on it is used in the story, a standard by its rule ids, except an always-on document, which the script adds to every line. Each decision record and standard the story cites is on the line. Each document on the source's `Context:` line is on at least one story's line | Refuse the item. `check-decomposition.js` fails a missing or typed line, an unused entry, an unlisted citation, an entry kept in another repository, a source document that reaches no story, and a `Hub commit:` the hub's trunk does not hold or that does not hold a hub entry's bytes |
| Every repository in the list has a row in the record's repository map — the stories that change it, or **does not change** with the evidence read — and every row's `Read at` is a twelve-character commit | Refuse. A repository with no row was never considered, and that is indistinguishable from one that was. A row with no pinned commit rests on the list's `purpose`, which is never evidence; `check-decomposition.js` refuses both |
| Every citation into a repository carries the commit it was read at, in the grammar `<id>@<12-hex>:<path>` | Refuse the citation. A branch is a moving name; a fact cited into one cannot be re-read. The list's `purpose` is never a citation |
| Two-round cap on the decomposition review | On cap: raise the escalation with `escalation.mjs raise --point decompose.review-cap`, leave the record in its last reviewed state, stop |
| A re-run after a cap finds something changed upstream | Refuse, and print what `escalation.mjs resume` printed. A cap is never raised |
| The verdict is one of the two exact tokens | Refuse to read anything else as a verdict, including "approved with comments" |
| The decomposition pull request is opened, and never merged by this command | Refuse to finish a first invocation with the record only in a working tree. The merge is the human's |

## Output

- `docs/backlog/<SLUG>.decomposition.md` — the record: the source and its revision, the key
  block taken, the coverage map, the repository map, the item list, the dependency graph, the
  decisions taken and the clarification rows.
- `docs/backlog/<SLUG>.decomposition-review.md` — the critic's final round, verbatim, with the
  verdict token and `Record revision: <hash>` for the record's bytes.
- One file per work item at `docs/backlog/<SLUG>/<KEY>.item.md`, each complete, each naming its
  one repository, and each at `TODO`.
- `docs/backlog/keys.json` advanced: one new block for this slug, `next` moved past it.
- An open decomposition pull request on `backlog/<SLUG>` carrying those files and nothing else,
  with `decomposition-gate` reporting on it.
- On a second invocation with the pull request merged and the check green on the trunk: the
  tracker items. Where the hub has a Jira connection, one ticket per story, and a link file on
  `harness/tracker-links-<SLUG>` in a pull request of its own, recording which ticket is which.
- On cap: an escalation raised with `escalation.mjs raise`, carrying the record's last reviewed
  commit, the deduplicated finding list from both rounds, the specific question the human must
  answer, and the `[shl-harness]` issue that records them.

## Stopping condition

First invocation: the verdict reads `APPROVED` within the cap, the record, its review and the
item files are written, the ledger is advanced, and the decomposition pull request is open with
`decomposition-gate` reporting on it — **or** the cap was reached, in which case escalate and
stop. Second invocation: every item in the block has a ticket, and, where the hub has a Jira
connection, the link file is committed and its pull request is open — or the pull request was not
merged or `check-decomposition.js` did not exit 0 against the trunk, in which case the stopping
condition is "reported, nothing created". No third outcome in either case.

Reaching the cap is information. Two failed rounds on a decomposition almost always means the source
is ambiguous about a boundary, and no third round resolves an ambiguity — it produces a more
confident split of the same unclear text.

## Never

- Never create, update or transition a tracker item before the decomposition pull request reports
  `MERGED` and `check-decomposition.js <SLUG>` exits 0 against the trunk. Not one item, not as a
  trial run against the real project.
- Never write a review the critic did not return, never edit the record after the round that
  approved it, and never treat the run's own verdict as the acceptance. The critic approves the
  artefact; the check reads it; a human merges the consequence.
- Never ask a person for a key range, and never mint a key the ledger does not give. A parent Epic
  is asked for in one place only: step 9, on a hub with a Jira connection. Take the next block from `docs/backlog/keys.json`, advance it in the same pull request,
  and record the block against this slug.
- Never let a tracker re-key an item. The key was minted from the ledger and the worktree, the
  design path and the pickup gate already resolve against it.
- Never invent a requirement no source supports, however obviously the estate needs it. That is a
  clarification row addressed to a role, not content.
- Never set business priority or roadmap order. Dependency order is derivable and it is yours;
  value order is not, and a planner that ranks value quietly has taken a decision the people who
  own the backlog are accountable for.
- Never renumber an identifier — an item's or an acceptance criterion's. Append, and deprecate what
  is retired; other artefacts already reference the number.
- Never resolve a conflict between two sources silently. The higher source wins **and** the
  disagreement is logged as a clarification.
- Never create subtasks or child items. Siblings in one record, each independently gateable.
- Never write a story that names two repositories, or none. One repository per story; a change
  that needs two is two stories with a dependency between them.
- Never cut a story that leaves a trunk broken until a sibling lands. A contract is never
  replaced in place; each step of a change to it is its own story, in dependency order.
- Never name a repository the list does not carry. That is a clarification, and `/add-repo` is
  the answer — not an invented id, and not a wider story in a repository the list does carry.
- Never read a repository except through `scripts/read-spoke.mjs` and, for its always-on rule,
  `scripts/read-spoke-rules.mjs`; never cite the list's `purpose`. A fact from a repository
  carries the commit it was read at, or it is not a fact.
- Never put a `Rules:` line on a story. The design selects the rules from its own paths, and
  the pickup gate reads that line there; a second copy on the story is a line nobody checks.
- Never let the critic edit the decomposition or an item file.
- Never carry forward an item whose source section could not be cited by line.
- Never merge the decomposition pull request, and never commit the record straight to the trunk
  to satisfy the merged-record gate. That gate exists so a human reads the cut before a board
  fills up with it.
- Never write a design, a specification or a line of code here. This command produces work items.

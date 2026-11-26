---
description: Turn a free-text intent into one reviewed, traceable requirements document that /decompose can cut into work items. Interviews the person until the document can be written without guessing, writes the interview down as the source it cites, puts the gaps the writer still finds back to the person once, invents nothing, opens a pull request a script checks, and stops in front of the merge. The intent may name Jira tickets by key or link.
argument-hint: <intent, in your own words; name any file or folder in this repository or on disk that the document should be written from, and any Jira ticket by key or link>
---

<!-- Part of the harness asset library c6f3b4427d58f7c3 (see VERSION.json) · 2026-09-20 -->

# `/feature <intent>`

**This file is a contract, not an integration.** The requirements directory and the escalation
role are the team's own; substitute them once, here, and record the substitution in
`docs/harness-decisions.md`. The document's *format* is not substituted here — it lives in
`docs/requirements/_TEMPLATE.requirements.md`, and § The house format below says what survives a
replacement. The gates are not placeholders — they are enforced against the repository, and the
repository is the fact.

**Purpose.** Turn what a person wants — said in their own words, with or without documents to
back it — into one reviewed, traceable requirements document, with every gap written down rather
than filled in. This is the step in front of `/decompose`: that command begins at "a structured
requirements document exists", and this is what produces one. It asks the person questions until
the document can be written without guessing, writes the questions and the answers down as a
source, dispatches the writer, puts the gaps the writer still finds back to the person once,
dispatches the critic, writes the document and the critic's final review beside it, opens a pull
request that `scripts/check-requirements.js` runs on, and stops in front of the merge.

**The idea this command rests on: the interview is the source.** Everything the writer states has
to cite where it came from, and a thought in someone's head cannot be cited. So this command turns
the thought into a file first: every question it asks and every answer it gets, word for word, is
written to `docs/requirements/<SLUG>/runs/<yyyymmdd_hhmm>/interview.md`, one numbered note per
exchange, and that file is business input like any brief. A requirement cites `interview.md § note
12`; the critic opens note 12 and reads what the person actually said; the coverage map shows
which answers were carried and which were not. Nothing changes downstream of that file. The
writer, the critic, the review file, the pull request and the check run exactly as they would on a
copied brief — because to them, that is what it is.

**Who runs it.** A person types `/feature <intent>` into the agent runtime, in the hub. This
command then runs the interview itself — it is the only part of the flow that talks to a person;
no seat does — writes the run folder, holds the round count, the fresh-context rule and the
interim persistence, dispatches the two seats named below, and produces nothing else. The
`sprint-orchestrator` seat is not involved — that seat's procedure is the three per-work-item
commands, and nothing here is a work item yet.

**When not to run it.** Two cases, and both are legitimate.

- **A requirements document already exists and meets the bar** — cited, with observable criteria
  in the `REQ-<n>` / `REQ-<n>.AC-<m>` grammar, no placeholder cell, and an approved
  `requirements-review.md` beside it on the trunk, so that `check-requirements.js <SLUG>`
  exits 0. Hand it to `/decompose` directly. A document that meets every bar but the last is not
  on this path: `requirements-gate` refuses a document with no review, and the way to a review is
  this command, with the document named as a source.
- **The intent is not a statement of what must become true.** A defect report, an operational
  request, a piece of work already covered by a signed requirement — these are work items under an
  existing epic, and they go to the backlog. A requirements document written for one of them is a
  document with one requirement that restates a ticket.

Three cases that look like this one and are not. **Coming back with answers** to a document's open
clarifications is this command again, on the same slug: it opens with those questions and writes
the next revision — see § Running it again. **Correcting a document whose pull request is still
open** — a reviewer found an assumption that does not hold — is this command again too, started
on that pull request's branch — see § Amending an open pull request. And **a thin intent** is not a reason to skip: one
sentence, honestly interviewed and written up, produces a one-requirement document with a long
clarification list, and that is a legitimate output.

## Inputs

| Input | Form | Where it comes from |
|---|---|---|
| `<intent>` | **Free text.** What should become true, for whom, in the person's own words. Any word in it that resolves to a file or a folder — in this repository, or elsewhere on disk — is a **named source**; nothing is typed to mark it. A Jira key or a Jira link is a named source too. A word that resolves to a file is a file source, even when it holds a key, as `docs/ABC-12.md` does. Empty text is asked for, once | The argument |
| The named sources | Files readable in full. A file inside this repository is read where it is; a file outside it is **copied into the run folder** under the context header, and the copy is what is read and cited. A folder is every readable file in it | The argument |
| The named tickets | Each ticket and all its comments, read as the person signed in. `getJiraIssue` reads the ticket, with the fields `summary`, `issuetype`, `status` and `updated`, and the description as markdown. `listJiraIssueComments` reads the comments, with `orderBy: created`. Call it again with `startAt` until `isLast` is true, because a ticket can hold more comments than one page returns. A key matches `^[A-Z][A-Z0-9]{1,9}-\d+$`. A link gives its key from a `/browse/<KEY>` path or a `selectedIssue=<KEY>` parameter. The link's host is the `cloudId`. A key with no link uses the site the person is signed in to. Where the person can reach more than one site, step 1 asks which site holds the key. Step 1 writes each ticket to a file in the system temporary directory, and the interview reads that file. Step 6 copies the file into the run folder, and the writer cites the copy | The argument, then the Atlassian MCP server |
| The person | The one who typed the command, answering for the owning role. Their answers are the interview record | The runtime |
| The interview record | `docs/requirements/<SLUG>/runs/<yyyymmdd_hhmm>/interview.md`, written by this command before any seat is dispatched — see § The run folder | This command |
| The owning role — **the feature owner** | The role accountable for what the document says: it merges the requirements pull request, and it is who every escalation below goes to. A role, never a person. Named at onboarding in `docs/harness-decisions.md`, confirmed in one interview turn | The ledger, then the person |
| The source-of-truth ranking | `CLAUDE.md` §4, with its tie-breaker | Onboarding |
| The grounding | The hub's context documents — the estate overview, decision records, standards and the merged requirements documents — as `node scripts/read-context.mjs --hub` indexes them: the hub alone, no repository named and nothing fetched, one line per document and no bodies. The index has no line for a requirements source. A run reads an earlier run's sources by their paths in the feature's own run folders. When the global release is a release, the call is `--hub --global <commit>`: the index then also lists the global documents at that commit, first, each id with the prefix `global.`, and the global repository is the one remote the call asks. A merged requirements document is one `requirements-document` line carrying its status (`accepted` or `proposed`) and its title; its body is opened by `--hub --names <slug>` only where the line plausibly overlaps the intent, never for every document on the trunk. The list of repositories, for its ids and its `purpose` text | The hub |
| The context documents | The decision records, standards and earlier requirements documents that bear on the intent, selected after the interview by `node scripts/read-context.mjs --hub --names <id>,…`, or `--hub --global <commit> --names <id>,…` when the global release is a release. A global document is named by its `global.` id. The script adds every always-on document of each layer it reads, prints a `Context:` line that pins each document, a `Hub commit:` line that names the hub commit it read at, and then each body. A hub entry pins the bytes read, and a global entry pins the global commit. That printed text is what the writer and the critic receive | Step 7 |
| The global release | The release of the global context repository the document is written against: the last line `node scripts/read-global.mjs --resolve` prints. It is `Global: vX.Y.Z <40-hex>`, or `Global: none` when the hub has no `docs/estate/global.json`. It is resolved before the grounding is read, and its 40-hex commit is the `--global <commit>` of every `read-context.mjs` call in the run. The writer copies the line beside the `Context:` line, and the critic receives it | Step 2 |
| The estate overview | `docs/estate/overview.md`, where one is on file: one plain-English page on what the system is, part by part, who owns each part and the words the business uses. What the interview's suggestions about the estate stand on. A hub document, cited by its path and section | `/estate-overview-refresh`, or `/add-context` for a page the lead architect wrote |
| The system as it runs, where the intent changes something that exists | Read, not summarised — by the writer, never by the interview | The repository, or the operating team |
| The requirements directory | `docs/requirements/`, unless the team substituted another | This file |
| `docs/requirements/_TEMPLATE.requirements.md` | The house format, replaceable; its sections are what the interview walks | Onboarding |
| The list of repositories | `docs/estate/repositories.json` — read for each repository's `purpose` text, so a suggestion about which part of the system the intent touches has something on disk to stand on. Orientation, never cited: the note it grounds is what the document cites. The document names no repository: which repositories a requirement touches is `/decompose`'s question, answered from the repositories themselves, and the person answering here is not asked it | `/add-repo` |

## Preconditions

1. **The working directory is the hub root, on a clean checkout of the trunk — or, to amend a
   requirements pull request that is still open, on a clean checkout of its `requirements/<SLUG>`
   branch.** From the trunk this command cuts its own branch; from a requirements branch it
   works on that branch and cuts none (§ Amending an open pull request). Business input that lives in a wiki page, a mail thread, a chat export or
   a slide pack is saved to a file by the person who has access and named in the intent; this
   command copies it, unchanged, into the run folder. It never fetches a source, except a Jira
   ticket that the intent names.

       UNRESOLVED — a resolver that reads business input from a wiki without a manual
       save. Owner: platform lead. Resolves: the remote-corpus interface ships and the argument
       grammar widens to accept a reference it can resolve.

   **When a ticket remains after the ticket-list turn, the Atlassian MCP server is installed and
   the person is signed in.** Step 1 of § What it does sets the order: the list first, then this
   check, then the read. Call the MCP tool `atlassianUserInfo`. A reply with an account is a
   pass. When the check fails, print the setup steps that `/feedback` prints. Then ask the
   sign-in fallback turn: a) continue without the tickets, b) stop. On a), the interview record's
   heading block names each dropped key, as `Named, not read: <keys>`. Never ask for a credential.
   Any Atlassian MCP server the person is signed in to will do. Its tools carry the server's
   prefix, such as `mcp__<server>__atlassianUserInfo`, and every tool this file names is that
   server's. When no ticket remains, the run skips this check.

2. **Every named source exists and is readable in full.** A word that looks like a path and
   resolves to nothing is reported before the interview starts, and the person says whether it
   was a path or a word; the command does not guess. A named ticket that cannot be read is
   named before the interview starts, with the reason: no access, or no such key. Then the run
   stops. The person removes the ticket from the intent or fixes the access, and runs the
   command again.
3. **Every source has a stable locator.** The interview record has one by construction — its
   numbered notes. A copied markdown or text file has section titles and line numbers. Where a
   copied file genuinely has neither — dated notes, a transcript — cite the smallest stable
   locator it does have and declare it in the Feature Name table's `Source locator convention`
   row. A source with no stable locator at
   all is reported and left out, never written up approximately.
4. **Every copied source has a revision.** Its version, date or edition, as its author states it,
   asked for in the interview if the file does not say. The interview record's revision is the
   date of the run. Without a revision, nothing downstream can tell whether a requirement is
   stale.
5. **The owning role is confirmed.** One interview turn, with the role the decisions ledger names
   as choice a). Where nobody can name it yet, the row reads `UNRESOLVED — the role accountable
   for this requirements document. Owner: delivery lead. Resolves: the role is named in
   docs/harness-decisions.md.` and the run continues; a cap escalation then goes to the delivery
   lead, and the pull request says so.
6. **The source-of-truth ranking is written down**, with its tie-breaker, in `CLAUDE.md` §4. The
   interview record is business input at rank 5, like a copied brief — and where it disagrees
   with another rank-5 input, it wins, because the disagreement was put to the person and their
   answer is the note (§4's table says so). A decision record or a contract still outranks it,
   and a conflict with one of those is a turn, not a quiet override.
7. **This run's folder does not exist yet.** Run folders are stamped to the minute (§ The run
   folder), so any number of runs on one slug, on one day, sit apart. Where a folder with this
   minute's stamp already exists, wait for the next minute: never write into an existing run
   folder, and never delete or move one — an earlier revision of the document cites it.
8. **A re-run after a cap finds something changed upstream.** Where the run reuses a slug, run
   `node scripts/escalation.mjs resume --slug <SLUG> --by-seat feature`. A first run has no slug
   yet and no escalation, so it skips this. Exit 0 means the run may start. Either no escalation is
   open, or the document or a closed clarification changed since the cap and the script wrote
   `resumed` with what it found. Exit 1 means that nothing changed, or that an incident is open on the work.
   Stop at once, print what the script printed and say that a cap is never raised. An answer in
   the argument counts only after it reaches the document or a closed clarification. Exit 2 is
   exit 2 for this command: stop.

## The state transition it owns

`(nothing) → Proposed`, on the **document**, and nothing else. The verification is mechanical:
the file exists in the requirements directory, every requirement carries a citation that
resolves, the coverage map closes over every source including the interview, the review verdict
reads approved within the cap, and the review is beside the document with `Document revision:`
naming the document's hash.

**It owns no work-item transition, because no work item exists yet.** The work-item state
machine in `.claude/rules/workflow.md` begins at `(nothing) → TODO`, which `/decompose` owns.
This command runs before that machine starts.

It does **not** own the merge. A human accepts the document by merging its pull request, or
nobody does, and this command ends in front of that. An approved verdict is not the acceptance: it
says the document is internally sound and traceable to its sources, which is a property of the
text, and says nothing about whether the business wants what the text describes.

### How the human accepts it — one merge, and nothing typed

**Accepting is: merge the requirements pull request.** That is the whole mechanism. There is no
row to type anywhere: the review file beside the document carries the verdict, bound to the
document's bytes, and `requirements-gate` runs `check-requirements.js <SLUG>` on the pull request
and reports on its head commit. The merge is the only human act, and no agent performs it.

| Step | Who | What |
|---|---|---|
| 1 | The feature owner | Read the document, the review and the interview record in the pull request, with `requirements-gate` green. A red check is a finding on the document or the review, fixed on the branch through another round — never by hand-editing the review, whose hash line would then name bytes nobody reviewed |
| 2 | The feature owner | Merge the requirements pull request. `/decompose` reads the trunk, so a document on a branch is decomposable by nothing |

A document someone finds wrong before step 2 is not merged and not hand-edited: it is amended on
its own branch, by this command, and comes back with a fresh review — § Amending an open pull
request. Merging a document known to be wrong would be accepting it.

A requirement the business does not yet want is not held back by a cell. It is held on a blocking
clarification row in Open Questions, which `/decompose` records as `Unresolved` in its coverage map and mints
no key for; or it is marked `DEPRECATED` with its number kept. An organisation that also records
acceptance somewhere else — a governance register, a contract file, a tracker approval — keeps
doing that; the merge is not a substitute for it, and it is not a substitute for the merge.

## What it does

**First, the kind of run — read from the checkout, never typed.**

| The checkout | The kind | What follows |
|---|---|---|
| A clean trunk | A first run, or a revision after the merge — step 2 tells them apart, by whether the index finds the document on the trunk | Steps 1 to 11; for a revision, § Running it again |
| A clean `requirements/<SLUG>`, and `node scripts/check-requirements-amend.mjs <SLUG>` exits 0 | An amendment of the open pull request | § Amending an open pull request |
| Anything else — another branch, uncommitted files, an amend check that exits non-zero | None | Refuse. Print what the script printed, or name the branch and the trunk |

On a requirements branch, ask the branch turn before anything else: say in plain words that this
is the branch of the requirements pull request for `<SLUG>` and that it is not merged, then ask
*a) yes — that pull request is still open, amend it; b) no — stop.* Git cannot tell an open pull
request from one closed without a merge, so the person's answer is the only check there is.

1. **Parse the intent.** Bind the free text. Resolve every word that is an existing file or
   folder as a named source; report any that resolves to nothing (precondition 2). Empty text
   gets one question — *What should become true?* — and the answer is the intent. A Jira link is
   not a path, so it is never reported as a missing path. Then find the named tickets, in this
   order:

   1. Find every word with the key shape and every Jira link (§ Inputs, the named tickets).
      Before the match, remove the punctuation at the ends of each word, as in `ABC-12.` or
      `(ABC-12)`. A word that resolves to a file stays a file source, even when it holds a key.
      A key named more than once is one ticket, as a key, as a link or as both.
   2. Where the search finds a key or a link, ask the ticket-list turn. Show every named source in
      one list, the files and the tickets. A word with the key shape, such as `UTF-8` or
      `SHA-256`, shows in the list too, and the person removes it. Ask in one turn: a) read
      these tickets, b) remove one or more, c) add a ticket that the list missed.
   3. Where a ticket remains, run the sign-in check of precondition 1. Where no ticket remains,
      the run continues exactly as before, with no sign-in check.
   4. Where a remaining key has no link, call `getAccessibleAtlassianResources`. It lists the
      sites the person can reach. Where it lists more than one site, ask the site turn. In it,
      ask which site holds each key with no link.
   5. Read each ticket that remains, with all its comments, before the grounding step (step 2
      of § What it does). A ticket that cannot be read stops the run (precondition 2). Right
      after the read, write each ticket to a file in the system temporary directory. Write the
      body in the shape of § The run folder. Omit the header. The run folder does not exist
      yet, because step 4 of § What it does sets the slug. Step 6 of § What it does copies each
      file into the run folder and adds the header.
   6. Tell the person, in one line for each ticket, how many comments the file omits as
      restricted (§ The run folder).

   The interview grounds its suggestions in the ticket text, as it does in a copied brief. Do
   not follow a ticket's links. A linked ticket is a source only when the intent names it.
2. **Resolve the global release, then load the grounding, before asking anything — the index
   first, bodies by name.** Run `node scripts/read-global.mjs --resolve` and keep the last line
   it prints. Without `docs/estate/global.json` that line is `Global: none`. With the file, it is
   the highest release tag on the global repository's trunk and its commit. A non-zero exit is a
   stop: print what the script printed. Exit 2 means that the global repository did not answer,
   and this command never falls back to an older line. The resolve comes first because the index
   reads the global layer at the release, and the interview stands on the index. An amendment
   takes the line from § Amending an open pull request step 1 instead, and a revision after the
   merge can replace it (§ Running it again, step 1).

   **One release for the whole run.** Where the kept line records a release, every
   `read-context.mjs --hub` call of this run, in this step and in every later one, adds
   `--global <commit>`, with the 40-hex commit from that line. Where the line is `Global: none`,
   no call adds `--global`. Never mix the two in one run, and never pass another commit.

   Run `node scripts/read-context.mjs --hub`, or `--hub --global <commit>` — the hub's documents,
   and with `--global` the global documents at that commit, one line each, no bodies, no
   repository named. Without `--global` nothing is fetched. With it, the global repository is the
   one remote asked. The global lines come first, each id with the prefix `global.`, and a line
   that reads `always on` is a document step 7 adds without being named. That index is the
   pre-digested list
   `.claude/rules/context-budget.md` says to read first. Open the estate overview first, where
   the index lists `estate-overview` (`--hub --names estate-overview` prints it with its `Cite:`
   line): one page on what the system is, part by part, who owns each part and the words the
   business uses. Where there is none, say so once, in plain words — *this hub has no overview
   of the estate yet, so I will ask more about which parts of the system this touches* — and go
   on. **For the merged requirements documents, read their index lines and nothing more.**
   Every one on the trunk is a `requirements-document` line carrying its status — `accepted`,
   or `proposed` — and its title. Open a body, with `--hub --names <slug>`, only where a line
   plausibly overlaps the intent: the same capability, the same nouns, the same part of the
   estate the overview names. A handful at most. **Never open every requirements document**,
   and never open one whose line gives no reason to: at ten or thirty documents the corpus is
   the working set gone, and the index is what stands in for it. Where no line plausibly
   overlaps, say so in one sentence — *no requirements document on the trunk touches this* — and
   go on. Then open the other documents the intent touches, by name — a global document by
   `--names global.<id>`, as a hub document by its id; read the decisions ledger
   for the feature owner; read the repository list for its `purpose` text. This
   is what the interview's suggestions are grounded in, and what a conflict turn quotes.
   **If a requirements document you opened plainly covers the intent, say so before asking
   anything else**, and offer: a) write the next revision of that document (§ Running it again),
   b) narrow the intent to what it does not cover, c) stop. Where that document's line reads
   `proposed` because its pull request is still open, say so, and a) is to amend it from its
   branch (§ Amending an open pull request) — this run stops so the person can switch to it.
3. **Read the intent back, and check it is one thing.** Restate it in two to four plain
   sentences — what it is, who it is for, where the boundary seems to be, naming any document on
   disk that already touches it — and ask whether that is right. If it spans several independent
   capabilities, say so and ask which one to write now; one document per run, and the others are
   named in the pull request as re-run suggestions.
4. **Settle the Feature Name table.** One turn for the owning role (precondition 5). Then propose
   the slug — kebab-case, two to five words, from the document's title — as a turn with the
   suggestion as a). `<SLUG>` is minted here and `/decompose` reuses it. **Never ask which
   repositories the intent touches.** The person answering is the owning role, who knows the
   business and not the estate; `/decompose` reads every repository at a pinned commit and
   answers that itself.
5. **Interview** — § The interview below. The house template's sections are the agenda;
   the rules on how to ask are fixed; the questions are not, because they come from what the
   sources leave open. Stop when every section can be filled without guessing, or is marked, or
   at the cap.
6. **Write the run folder** — § The run folder below: the interview record, every copied source
   under its header. Copy each ticket file from the system temporary directory. Add its header
   to the copy. Commit it on the branch and prove it parses before any seat is dispatched,
   so the writer reads a committed source with stable notes and line numbers.
7. **Select the context documents, then write the document.** From the index read in step 2
   and the interview, name each decision record, standard and earlier requirements document
   that bears on the intent, a global one by its `global.` id. Run
   `node scripts/read-context.mjs --hub --global <commit> --names <id>,…` with those ids and the
   commit step 2 kept, or `--hub --names <id>,…` where step 2 kept `Global: none`. Use
   `--names ''` when none bears. The script adds every always-on document of each layer it reads,
   the global ones first, and prints one `Context:` line and one `Hub commit:` line, then each
   body under a `Cite:` line. The `Hub commit:` line names the hub commit the run read the hub's
   documents at. Each global entry on the line is `<id>@<12-hex>:global:<path>`, its pin the first twelve
   characters of the commit on the `Global:` line. Keep the printed text. That text is what the
   writer receives, as text, in its dispatch, and the writer opens no context document itself.
   Never name the document this run writes, and never type the line.

   Hand the `Global:` line step 2 kept to the writer with the context text. The `Context:` line
   and the `Global:` line come from the same release, because one commit served both.

   **The `feature-writer` seat** (`.claude/agents/feature-writer.md`) writes the document, on
   the method in `.claude/skills/write-requirements/SKILL.md`, into
   `docs/requirements/<SLUG>/requirements.md` from the house format, reading the run folder,
   every source named in the intent, ranked, and the context documents handed in. The seat never talks to the person: what the person
   said is in the record, and a gap the record leaves is a clarification row, not a question the
   seat asks — this command puts those rows to the person itself, once, below. In particular:
   - **Every statement cites its source** — `Derives from: interview.md § note <n>` for an
     answer, `Derives from: <copy> § <section title> L<start>-<end>` for a copied file. Some of
     these are spot-checked, and the deterrent is the actual control. Degrade the locator where a
     copied file has none better; never the citation.
   - **Nothing is invented.** Where every source is silent, contradictory, or plainly wrong, the
     output is a clarification row addressed to a role — never a plausible sentence. A parked
     note is a clarification row. An answer is carried as far as its words go and no further.
   - **Every requirement carries observable criteria** with `REQ-<n>.AC-<m>` identifiers, at
     least one of them negative. Identifiers are minted once and never renumbered.
   - **Every threshold, window, volume and limit** carries a value or the marker
     `UNRESOLVED — <what>. Owner: <role>. Resolves: <trigger>.` A guessed number is worse than a
     marked gap, because it is testable and it will pass.
   - **No priority, no sequence, no commercial trade-off originated here.** A priority that a
     source or a note states goes in the requirement's Priority cell, cited in its Source column;
     a stated sequence or commercial constraint is a cited constraint row. Where nothing states a
     priority, the cell holds the `UNRESOLVED` marker. The same holds for a risk's likelihood and
     severity.
   - **A cell a script reads by name holds its value alone.** The Feature Name table's `Slug`
     cell is
     `| Slug | \`<SLUG>\` |` and nothing else — no citation, no note. `check-requirements.js` compares the `Slug` cell to the folder,
     literally, and a citation appended to it fails the pull request after the critic has
     approved, when the cap allows no repair. That table's rows cite their notes once, on the
     `Derives from:` line under the table.
   - **The `Context:` line is the one the script printed, copied whole**, on its own line under
     the Feature Name table. Each document on it is used where a reader sees it: a decision record or an
     earlier requirements document is named by its id where it shapes a requirement, and a
     standard is cited by the rules it applies, `std-<topic>.<NN>`. A global document is used in
     the same way: a global record named by its id, `global.ADR-<NNN>`, and a global standard
     cited by a rule, `global.std-<topic>.<NN>`. A global exception, `global.EXC-<NNN>`, is named
     beside the record it departs from, and both are on the line. A document the page never
     uses is removed by re-running the script without it, never by editing the line. An
     always-on document is the exception. The script adds it to every line, so the page needs
     no use of it. Never invent a use for it, and never remove it from the line. A decision
     record or a rule of a standard that the page cites is on the line, a global one included.
     `check-requirements.js` reads all of this.
   - **The `Hub commit:` line is the one the same run printed, copied whole**, on its own line
     under the `Context:` line. Never type it. `check-requirements.js` reads it against the hub's
     trunk: the commit is on the trunk and holds every hub entry's pinned bytes.
   - **The `Global:` line is the one this command hands over, copied whole**, on its own line
     under the `Hub commit:` line. Never type it, and never change it. `check-requirements.js` reads
     it against the global repository: the tag is a release tag, it still points at the
     recorded commit, and that commit is on the global trunk.

   **Then run the check the pull request will run, before the critic sees anything.** Commit
   the document on the branch and run `node scripts/check-requirements-candidate.mjs <SLUG>`.
   It builds the candidate trunk `requirements-gate` builds — a bare repository with this
   branch's `HEAD` as the trunk — and runs `check-requirements.js` inside a clone of it, so it
   reports on the document as it would read after the merge; it refuses, naming the files, while
   anything under `docs/requirements/` is uncommitted. At this point no review exists, so the
   expected report is exit `1` with `[PASS]` on `requirements document`, `requirement
   identifiers`, `placeholder cells` and `context documents`, and `requirements review` failing only for
   `expected exactly one docs/requirements/<SLUG>/requirements-review.md … found 0`. **Every other
   line under a `[FAIL]` is a finding the writer fixes before the critic is dispatched**, and it
   costs no round: a round spent on a mechanical failure the check would have found is a wasted
   round. Never run `check-requirements.js` against the branch by any other route — the
   candidate trunk is the one construction that keeps the check honest about what would merge.

   **Then put every clarification row the draft left to the person, once — the gap pass.** The
   writer reads more closely than the interview did: it opens the rules and the scripts the
   intent touches, and it finds the edge the interview walked past — the repeat, the malformed
   file, the case with no style to follow, two notes that read two ways. Those rows are the
   interview's misses, and the person is still in front of the command; left in the document,
   each one costs a merge and a re-run to close. So read the Open Questions table of the
   committed draft and take its
   rows in identifier order, one per turn, under every rule in § The interview: say which
   requirement the row sits under and what it asks, in plain words; quote the note or the lines
   the row cites; suggest a) from that source; offer the park. A row that logs two readings of
   the record is asked as a lettered choice between them. Each answer is a new note, appended
   after the last — `### note <n+1>`, with a fourth line `Row: CLAR-<SYSTEM>-<section>-<nn>`
   naming the row it answers; a park is written as any other park, with the flag and the role the
   person gives. Existing notes are never touched, and the record is cited by note, never by
   line, so every citation into it still resolves. Then re-commit the record, run
   `check-context.mjs --offline` (§ The run folder), and dispatch
   the writer once more on the same folder: an answered row keeps its identifier and gets
   `Status: Closed`, its resolution in the person's terms, the date and a citation to the new
   note, and the requirement it held gets its criteria filled; a parked row keeps `Open` with the
   flag the person gave. Then the candidate check again, as above.

   The pass runs once, and two cases skip it. **Open Questions reads `NONE`** — there is nothing
   to ask. Or
   **the interview ended at its cap** — the cap is the signal that the business input is not
   ready, and a second interview on top of it does not change that; the rows stay, the document
   says so, and § Running it again is the way back. A row the revision leaves — one an answer
   opened, or one the person parked — stays a row for the same reason. What this pass corrects
   is the interview's own judgement that it was done, and that judgement is checked exactly once.
8. **Review it — the `pm-critic` seat, on fresh context** (`.claude/agents/pm-critic.md`), with
   `Mode: feature-review` and the method in `.claude/skills/review-artefact/SKILL.md`. The
   contract is the run folder and the named sources at the revisions Link to PRD Document
   names, plus the
   index from step 2, global lines included, the text `read-context.mjs` printed in step 7 and the `Global:` line, all
   handed in with the dispatch; the critic opens the notes a
   requirement cites and reads what the person said. The verdict is a token, on its
   own line, exactly `### VERDICT: APPROVED` or `### VERDICT: CHANGES REQUESTED`, followed by
   `Cycle: <n> of 2`, `Mode: feature-review` and `Reviewer: <seat name>`, under the heading
   `## Review: <SLUG> — <what is under review>`. `CRITICAL` and `IMPORTANT` block acceptance;
   `SUGGESTION` does not. That seat holds no write tool: it returns each round in-loop, and this
   command persists each round, verbatim as the critic returned it and never a summary, to the
   system temporary directory as `<SLUG>-feature-review-round-<n>.md` — at the cap those files
   are the only record of what each round found and flagged. The critic writes `Document revision: <hash>` under its
   four verdict lines — the value `git hash-object docs/requirements/<SLUG>/requirements.md`
   prints, which this command computes and hands over with each dispatch.
9. **Loop, capped at two rounds.** On resubmission the critic reviews only the delta plus what
   that change could plausibly have broken, and the writer submits an explicit change list. The
   change list is the writer's own account of its work. Only a diff shows the critic a change
   that the list leaves out, so store each revision before you dispatch the critic:
   1. Before each critic dispatch, run
      `git hash-object -w docs/requirements/<SLUG>/requirements.md`. The `-w` flag stores the
      document's bytes in the hub's object store. The printed value is the `Document revision:`
      that the critic records.
   2. On a resubmission, put the writer's change list in the dispatch. Below it, put the output
      of `git diff <revision the last review names> <new revision>`, under the heading
      `## Diff since the last review`.

   The round count belongs to this command. **A finding the record cannot answer is not a reason to
   ask the person again**: the interview is over once the gap pass is done, and a gap the critic
   finds becomes a clarification row in the next round — the person answers it on the re-run.
   On cap: raise the escalation (§ The escalation record, below), leave the document in its last
   reviewed state, and stop.
10. **Write the review file.** The final round's text, verbatim, at
    `docs/requirements/<SLUG>/requirements-review.md`, beside the document, in the shape
    `.claude/skills/shared/review-file.template.md` fixes. Nothing in the document changes after
    the round that approved it — the hash binds the review to those bytes. Then run
    `node scripts/escalation.mjs resolve --slug <SLUG> --point feature.review-cap --fact-kind verdict --fact-value APPROVED --round <n> --by-seat feature`.
    It closes an escalation that an earlier cap opened, and it writes nothing where none is open.

    **Then run the candidate check again, and expect exit `0`.** Commit the review file on the
    branch and run `node scripts/check-requirements-candidate.mjs <SLUG>`: this is the run
    `requirements-gate` will make, on the same construction, and the pull request is not opened
    until it reads `DOCUMENT COMPLETE`. A non-zero exit here is a finding, never something to
    edit around: a failure on the review's shape — the verdict token, `Mode: feature-review`,
    the slug, `Document revision:` naming other bytes — goes back to the critic, which returns
    the round again in the pinned shape, because this command writes no review the critic did
    not return; a failure on the document goes back to the writer and costs a round under the
    cap, exactly as it would have after the push. Nothing is hand-edited to make the check pass.
11. **Commit on the branch, open the requirements pull request, and stop.** On an amendment the
    pull request is already open: push to it instead (§ Amending an open pull request, step 9). `requirements/<SLUG>`
    is the convention. Commit with `node scripts/harness-commit.mjs -m "docs(requirements): <SLUG>"`,
    the one way the harness commits. The pull request's description ends with the watermark, the line `Generated-by: SHL Agentic Harness` on its own
    after the normal description (`.claude/rules/watermark.md`). The pull request carries the document, its review and the run folder, and
    nothing else. Its description names the owning role, the
    number of questions asked, how the gap pass went — asked, answered, parked, or why it did not
    run — the clarifications left open with their blocking flags, and any
    capabilities the split check set aside. `requirements-gate` runs `check-requirements.js <SLUG>`
    on it; `check-context.mjs --offline` proves the run folder parses. Do not merge it yourself.

## The interview

**The agenda is the template; the questions are the gaps.** Walk the sections of
`_TEMPLATE.requirements.md` in order, from Feature Description to Risks:

1. Feature Description: the outcome, scope in and out, and the terms used in a narrow sense.
2. Roles, under Feature Name.
3. Feature Design and Brief: the design intent, its status, and the constraints.
4. Feature Dependencies.
5. Functional and Nonfunctional Requirements: each requirement with its criteria, and its
   priority.
6. Risks.

Step 4 settles the rest of the Feature Name table. Link to PRD Document, Coverage of the sources,
Open Questions, Assumptions made and Change Log record the run, and the writer fills them from
the record. A house format of the team's own is walked the same way, section by section.

**A priority and a risk rating are the person's, never a suggestion.** Where no source states a
requirement's priority, or a risk's likelihood or severity, ask for it. Make a) "leave it marked
for now", never a value. A value the command suggests is a priority the harness originated. A
risk that no source names is asked about only when the person raises it.

For each section, first read what the named
sources and the grounding already settle. **Where a source answers, do not ask** — the writer will
cite the source. Where nothing on disk answers, or two things on disk disagree, that is a question.
So a rich brief produces a short interview and a bare sentence a long one, and either is correct.

The questions that are always asked, because no brief ever answers them: the read-back; the
owning role; for every requirement, *what must not happen* — the negative criterion, the half that
gets left out; for every number the sources leave vague — *fast*, *soon*, *a few* — the value, or
permission to mark it; and the out-of-scope list, pushed on purpose: name the adjacent thing a
reader will assume is included — from the overview's parts, where one is on file — and ask
whether it is. An empty out-of-scope list is almost always wrong.

One more question is always asked: the set behind an "all", "every", "always", "never" or "any"
that no source defines. The person means the cases they have in mind. The design meets the words
against a system that already refuses, hides or limits some cases, and a criterion that says "all"
with no set makes every one of those cases a change. Ask which set, with the suggestion as a).
Example: *You said the agent answers all the user's questions. Today the agent refuses some turns,
such as off-topic ones. a) all the questions it answers today, b) every question, including the
ones it refuses today, c) park it.* The answer becomes a scope line, in or out, or a clarification
row. The interview does not read the code to find those cases: the question names the kind, and
the person names the set.

**How to ask.** These are binding for every turn, because the person may be a businessperson or an
engineer, on a small screen, not reading in their first language.

- **One question per message.** Ask, wait, record, then the next. Never two questions joined by
  "and", never a list. Confirming three examples is three turns.
- **Plain words.** Short sentences. No template vocabulary, no identifiers, no section numbers,
  nothing from this file. "What should happen when the field is empty?", not "What is the
  null-input behaviour?" A term the sources define is the exception: use their word.
- **Say what you are asking about.** The first time a question mentions a document, say in one
  sentence what that document is. The overview and the repository list are documents too: the
  first time either grounds a suggestion, say what it is — *the hub keeps a one-page overview of
  the system; it says…*. Walk a scenario as a small story: the situation, what someone does,
  then the question. Two to four sentences, never a wall. The count line and the change line below are not part of them.
- **Always suggest.** Every question carries a suggested answer, grounded in a source on disk
  (named in the same message), in an earlier answer, or — where there is genuinely no signal —
  said to be the most defensible default. Never a bare open question.
- **Fixed choices are lettered.** When the answers are a known set, list them `a)`, `b)`, `c)`
  and ask for a letter; **`a)` is always the suggestion** and a bare "a" is a complete answer.
  Free text is for what only the person knows: a role, a value, a reason.
- **Show what you ask about.** Proposed wording — a summary, a definition, a scope line — is quoted
  in full inside the question. Never "does this summary work?" about text the person cannot see.
- **Always offer the way out.** Every turn accepts "I don't know" or "park it". A parked question
  becomes a clarification row in Open Questions, routed to a role, and the same message asks whether it blocks
  the requirement it belongs to — suggest *yes* when it gates a behaviour, *no* otherwise. A
  parked **number** stays inside its criterion as the `UNRESOLVED` marker, with the owner and the
  trigger asked for in the same breath.
- **Catch assumptions as they pass.** "I'm assuming", "presumably", "as long as" — record the
  premise and the reason in the note, confirm it back in one line, and it becomes a row in
  Assumptions made.
  When it is unclear whether something is assumed or unknown, ask which.
- **Stop at a conflict.** When an answer contradicts a decision record, a contract, a standard or
  an earlier answer, stop on that turn: name the source, quote the passage, and ask the person to
  choose — correct the answer, or keep it and have the departure recorded as a clarification
  routed to the role that owns the source. Never resolve it silently, in either direction.
- **Check the premise before sending.** Every question carries one — the scenario it walks, the
  "you said" it opens with, the a) it suggests. Read it against every earlier note before the turn
  goes out. Where the premise departs from an earlier answer, the turn is a conflict turn, as
  above: quote the note, show the departure, ask which holds. A premise sent unchecked gets a
  second answer recorded beside the first, and the writer must then log both readings and carry
  neither — a blocking row for a contradiction the interview introduced itself.
- **Ask what, never how.** Where a file lands, what it is called, which branch pattern, which
  header field, what form an argument takes, how a mechanism works inside — those are the design's
  to settle, in `/dev-spec`, and their answers change nothing a person outside the build can
  observe. The test, shared with the writer (`write-requirements` § Never invent): would the
  answer change an acceptance criterion? If not, do not ask it.
- **Never read spoke code to answer a question.** The content of a requirement comes from the
  person and the business documents. What the system does today is the writer's to read, later,
  and the planner's to read in `/decompose`. Ask the person. What the interview may read about
  the estate is the overview and the list's `purpose` text, both in the hub, and nothing else.

**Show the count.** The person sees on every turn how far they are and how far there is to go.

1. Count the turns of the read-back, the Feature Name table and the interview, wherever this run
   asks them. Give no count line to any other turn. These turns have no count line:
   - the empty-intent question
   - the branch turn
   - the ticket-list turn
   - the sign-in fallback turn
   - the site turn
   - the offer in step 2

   The gap pass has its own count in rule 8.
2. `<n>` is the number of the counted turn. The cap of 25 counts the same turns.
3. Estimate the total before the first counted turn. Count one turn for each of these:
   - each turn that this run asks of the read-back, the owning role and the slug
   - each question that is always asked
   - each topic on the agenda that the sources leave open
   - on a revision after the merge, each open row in Open Questions
   - on an amendment, each point of the correction
4. Never show a total above 25. Where the estimate is above 25, show 25.
5. Open every counted turn with one line of its own: `Question <n> of about <total>.` For
   example, *Question 7 of about 22.*
6. Estimate again after each answer. When the total changes, say so in one line before the
   count line: *That answer adds 3 questions, so about 21 now.* Or: *That answer settles 2
   questions, so about 18 now.*
7. When the total is 25, write `of 25` without `about`. On the first turn that shows it, say
   once that the interview stops at 25 and parks the open topics. When the total falls below 25
   again, write `of about <total>` again.
8. Count the gap pass apart, and exactly: `Gap question <n> of <rows>.` `<rows>` is the number
   of Open Questions rows that the pass asks. A conflict turn inside the pass adds one to
   `<rows>`, and the change line says so.
9. Do not record the count line or the change line. The `Asked:` line of the note holds the
   question without them.

**When to stop.** When every section on the agenda can be filled from the sources and the notes
without a guess, or is honestly marked — out of scope with an owner, parked as a clarification, or
`UNRESOLVED` on a number — and every requirement has at least one negative criterion. Or at the
soft cap of **25 questions**: say so, park every section still open as clarification rows, and go
on to write. Never invent to finish sooner. Hitting the cap is information: the business input is
not ready, reported at the only point where that is cheap. Stopping short of it is a judgement,
and the gap pass (step 7) checks that judgement once: the rows the writer still finds come back
to the person before the critic sees the document. Reaching the cap skips that pass, because
then there is nothing to check — the interview did not stop because it believed it was done.

## The run folder

`docs/requirements/<SLUG>/` is the document's own folder: `requirements.md`, its review beside it,
and under `runs/` one folder per run of this command, `runs/<yyyymmdd_hhmm>/`, the stamp being the
day and the minute this run started — `date +%Y%m%d_%H%M`, the machine's local clock, 24-hour — so
two runs on one day sit in two folders and a run never has to wait for tomorrow. `.claude/rules/estate.md`
§4 fixes the shape and `scripts/check-context.mjs` refuses any other — a stray file or folder beside
the document is a finding, and so is a folder under `runs/` that is not a stamp. A run folder holds:

- **`interview.md`** — the record. The context header every hub document carries (`name:
  <SLUG>-<yyyymmdd>-<hhmm>-interview` — the folder's stamp with its underscore written as a hyphen,
  because an id is lowercase letters, digits and hyphens and nothing else — `description`, `globs:
  []`, `alwaysApply: false`, `kind: requirements-source`, `owner: <the owning role>`, `revision:
  2026-11-26`, `origin: interview with the <role>, /feature`), then:

      # Interview — <SLUG> — <YYYY-MM-DD HH:MM>

      Interviewed: <the owning role>. Intent, as typed: "<the argument, verbatim>".
      Named sources: <each path and each ticket key, or none>. Questions asked: <n>. Parked: <n>.
      Named, not read: <each ticket key that the run did not read> (only when the person continued without the tickets)

      ### note 1
      Asked: <the question, as asked, with its lettered choices>
      Answered: <the answer, word for word — a letter, and the text of the option it chose>
      Grounded in: <the source the suggestion came from — a hub document by path and section, "the repository list (purpose of <id>)", an earlier note — or "nothing on disk">

      ### note 2
      …

  Write the `Named, not read:` line only when the person continued without the tickets
  (precondition 1). One note per exchange, numbered in the order asked, never renumbered, never
  merged. A parked
  answer is written `Answered: parked — blocking` or `parked — not blocking`, with whatever the
  person said. An assumption is written `Answered: assumed — <the premise>; because <the reason>`.
  The read-back, the role and the slug are notes too — they are where the Feature Name table's
  rows come from. A gap-pass note (step 7) is appended after the last interview note and carries a fourth
  line, `Row: CLAR-<SYSTEM>-<section>-<nn>`, naming the clarification row it answers; the pass
  also adds one line under `Parked:` in the heading block — `Gap pass: <n> asked, <n> answered,
  <n> parked.`, or `Gap pass: not run — cap reached.`, or `Gap pass: not run — no rows.` Nothing
  else in the record changes after its first commit.
- **Every copied source**, under its own name kebab-cased with `.md`, its bytes unchanged below
  the same header (`name: <SLUG>-<yyyymmdd>-<hhmm>-<stem>`, `revision:` the original's, `origin:` where
  it was saved from). A source already tracked in this repository is not copied; it is cited where
  it is.
- **Every named ticket**, as `jira-<key-lowercase>.md`, such as `jira-abc-12.md` for `ABC-12`.
  The header is the same context header (`name: <SLUG>-<yyyymmdd>-<hhmm>-jira-<key-lowercase>`,
  `description`, `globs: []`, `alwaysApply: false`, `kind: requirements-source`, `owner: <the
  owning role>`, `revision:` the `updated` value exactly as `getJiraIssue` returns it, `origin:`
  the ticket link), then:

      # <KEY> — <summary>

      Link: <url>. Type: <issue type>. Status: <status>. Updated: <updated>.

      ## Description

      <the description, as markdown, unchanged>

      ## Comments (<n>)

      ### Comment 1 — <author display name>, <created>

      <the body, as markdown, unchanged>

  Copy the summary, the description and each comment body unchanged. Copy a body in the format
  that the server returns, HTML included. Number the comments in the order they were created.
  Omit the body of a comment that has a visibility limit. Omit the body of a comment that Jira
  Service Management marks internal (`jsdPublic: false`). Keep the heading of each omitted
  comment, and write the line `Not copied: restricted.` under it. A committed hub file
  reaches every reader of the hub. A ticket with no description keeps the `## Description`
  heading, with
  the line `None.` under it. A ticket with no comments keeps `## Comments (0)`, with the line
  `None.` under it. The section titles are the locators the writer cites, such as
  `jira-abc-12.md § Comment 3 — <author>, <created> L40-52`.
- Nothing else. A file that is not a document — a spreadsheet, a schema — may be copied beside its
  prose; the check skips it.

Then, with the folder committed, `node scripts/check-context.mjs --offline`, which must exit 0
before anything is dispatched. Older run folders for the same
slug are never touched: an earlier revision of the document cites them, and a citation into a file
that moved is a citation into nothing.

## Running it again — coming back with answers

This is the way back **after the merge**, from the trunk. Before the merge, while the pull
request is still open, the way is § Amending an open pull request.

A document with open clarification rows is not stuck: it is merged, `/decompose` cuts what it can
and holds the rest. After the gap pass (step 7) the rows left open are the ones the person parked,
the ones an answer opened, the ones the critic found, and — on a run that hit the cap — every row
the writer found. The way back is this command again, on the same slug, at any later time — an
hour later on the same day, once the person has the answers, is the common case.

1. The grounding step finds the document on the trunk through the index — its
   `requirements-document` line names the slug — opens it by `--hub --names <SLUG>`, and offers
   to write its next revision. **A revision keeps the recorded release.** Where the document's
   `Global:` line records a release, that line replaces the one step 2 resolved, and its commit
   is this run's `--global <commit>`. Read the index again with `--hub --global <commit>` at that
   commit before the interview, because the interview stands on the release the document
   records. Where the document records `Global: none`, or has no line, keep the line step 2
   resolved, and the index step 2 read stands.
2. **The interview opens with the open rows of Open Questions**, oldest first, one per turn, each with a
   suggestion where a source has appeared since, and the park option as always. Then any new
   intent the person typed, on the same agenda.
3. A new run folder, `<SLUG>/runs/<new stamp>/`, holds this run's record and copies. The previous
   folders stay; the document beside them is revised in place.
4. The writer produces revision r<n+1>: an answered row gets `Status: Closed` — the one status
   in `docs/designs/CLAR-log.md`'s schema that means the answer is written into the document —
   its resolution, the date and a citation to the new note; a requirement that was held gets its criteria filled;
   a requirement no longer wanted is marked `DEPRECATED` with its number kept. **No `REQ-<n>` or
   `REQ-<n>.AC-<m>` is renumbered**, ever — `/decompose` and every design after it already cite
   them. Statements that did not change keep their citations into the earlier folders. The
   context documents are selected again, as in step 7, at this run's release, so the `Context:`
   line pins the bytes this revision read, the `Hub commit:` line names this run's hub commit,
   and every global entry pins the recorded commit. The
   `Global:` line stays as the merged document records it. Where it
   records a release, a move to a newer one is an amendment of this revision's open pull
   request (§ Amending an open pull request), because only that start check proves that the
   move goes forward. Where it records `Global: none`, or the document has no line, copy the
   line step 2 resolved. Any release is a move
   forward from `none`, and `check-requirements.js` refuses `none` in a hub with
   `docs/estate/global.json`.
5. Critic, review file, pull request, merge, as above. `/decompose` reads the trunk and cuts the
   requirements the answers released.
6. **Where a decomposition record exists for the slug, the record is now behind the document.**
   `/decompose` reads a source on the trunk, so this pull request cannot carry the next revision
   of the record. `decomposition-gate` runs on this pull request and passes. It prints as notes
   what the record does not carry yet: a story that carries a `DEPRECATED` criterion, a
   requirement with no coverage row, a context document that reaches no story. Any other
   finding of that check is a failure, as on any pull request. After the merge, the person runs
   `/decompose` on the same slug. It writes the next revision of the record. Until that pull
   request merges, `check-decomposition.js <SLUG>` fails on the trunk, and no ticket is created.

## Amending an open pull request — a correction before the merge

A person reading the open requirements pull request finds something wrong: an assumption in
Assumptions made that does not hold, a criterion that says more than the note it cites. Merging a document known to
be wrong is not what a merge means. Editing it by hand unapproves it: the review's `Document
revision:` names the bytes the critic read, and `requirements-gate` fails on one changed byte. The
way is this command again, started on the pull request's own branch. The run is an
**amendment**. It ends in new commits on the same pull request and a fresh review. Then a person
merges it, or does not.

1. **Start on the branch, and check it.** Check out `requirements/<SLUG>` and pull it. Run
   `node scripts/check-requirements-amend.mjs <SLUG>`. It checks, with git alone, that the
   checkout is on that branch, clean, and in step with the remote; that it carries the document
   and its review; and that it is not merged into the trunk. A non-zero exit is a refusal: print
   what it printed, and stop. Exit 0 prints the start commit and the document's hash; keep both.
   Then the branch turn (§ What it does): the person says whether the pull request is still open.

   **When the correction moves the feature to a newer global release**, run
   `node scripts/read-global.mjs --resolve` first. Then start with its last line:
   `node scripts/check-requirements-amend.mjs <SLUG> --global "<the line>"`. The check compares
   the line with the document's `Global:` line at `HEAD`. It refuses an equal or older release,
   and a move back to `Global: none`. Without `--global` the amendment keeps the line. A document
   that records `Global: none`, or has no line, in a hub that now has `docs/estate/global.json`
   must move, because `check-requirements.js` refuses `none` there.

   **The line this step settles is this run's release**, in place of a resolve in step 2 (§ What
   it does). After a move, it is the line passed with `--global`. Without a move, it is the
   document's `Global:` line at `HEAD`. Where that line records a release, every
   `read-context.mjs --hub` call of the amendment adds `--global <commit>` with its 40-hex commit.
   Where it records `Global: none`, or the document has no line, no call adds `--global`.
2. **The correction is input, like any intent.** Anyone may raise one: the reviewer who found it,
   the feature owner, an architect. The runner answers for the owning role, as on
   every run, and the record names who raised it. A correction typed into the intent is the
   intent. A pull request comment is saved to a file by the person and named in the intent, and
   this command copies it into the run folder like any other source. It never fetches a pull
   request comment. A ticket named in the intent follows step 1 of § What it does.
3. **The grounding.** The index lists the branch's own document as `proposed`: approved, not
   merged. That is correct, and it ranks it with the other rank-5 inputs, not above them
   (`CLAUDE.md` §4). Open it by `--hub --names <SLUG>`; it is the document being amended. The
   index and every read in this step take the release step 1 settled, so after a move the
   interview sees the global documents at the new commit.
4. **The interview opens with the correction**, one point per turn, under every rule in § The
   interview. Quote the passage of the document the point is about, and the note or lines that
   passage cites. Suggest a) from the correction, and offer the park. A correction that
   contradicts an earlier note, a decision record or a contract is a conflict turn, whoever raised
   it, never a quiet override. Then the open rows of Open Questions, oldest first, as on a
   revision. Then any
   new intent, on the same agenda. The record's heading block carries one more line: `Correction
   raised by: <role>, <the copied file, a ticket key, or "typed in the intent">.`
5. **A new run folder**, `<SLUG>/runs/<new stamp>/`, holds this run's record and copies. Earlier
   folders, the first run's included, stay exactly as they are. Steps 6 and 7 follow as on any
   run: the folder committed and proved, the writer revising the document in place, the
   candidate check, the gap pass.
6. **What the writer changes, and what it keeps.** The document's `Document revision` goes up
   by one, `r<n>` to `r<n+1>`, on every amendment, so every text a reviewer read in the pull
   request has its own name; its date becomes this run's. The trunk may then skip numbers — r1
   merged, then r3 — and that is expected: the revisions in between were read in the pull request
   and never merged. No `REQ-<n>` or
   `REQ-<n>.AC-<m>` is renumbered. A requirement the correction withdraws is marked `DEPRECATED`
   with its number kept. Statements the correction did not touch keep their citations into the
   earlier folders. A wrong assumption is corrected where it stands: its Assumptions made row is
   revised or
   withdrawn on the new note, and every criterion that leaned on it is revised with it. The
   `Global:` line changes only to the line passed to the start check with `--global`. Otherwise
   it stays byte for byte. The context documents are selected again, as in step 7, at the release
   step 1 settled. After a move, every global entry on the `Context:` line pins the new commit,
   because the selection runs at that commit and prints each global pin from it.
7. **The review starts again at round 1.** The cap is this run's two rounds, because an amendment
   is new input from a person, not another turn of an agent loop. Round 1 is a full review on
   fresh context: the review file it produces replaces the earlier one and vouches for every
   byte. This command also hands the critic the correction and the output of
   `git diff <start commit> -- docs/requirements/<SLUG>/requirements.md`, so it reads there first.
   A round 2 is delta only, as always. On cap: escalate, exactly as in step 9.
8. **Write the review file and run the candidate check**, as in step 10: the final round
   verbatim, and nothing pushed until the candidate check reads `DOCUMENT COMPLETE`.
9. **Commit, push to the same branch, and stop.** Commit with `node scripts/harness-commit.mjs -m
   "docs(requirements): <SLUG> amendment <stamp>"`, then push `requirements/<SLUG>`. Never push
   with force: the earlier commits, the earlier review in the history and the reviewers' comments
   all stay. Open no new pull request. Add to the open one's description a section `### Amendment
   <stamp>`: who raised the correction, what changed in one or two plain sentences, the run
   folder, the questions asked, how the gap pass went, and how many review rounds it took. The
   watermark stays the description's last line. `requirements-gate` runs again on the push. Do
   not merge it.

### The escalation record

The cap branch above raises one escalation, point feature.review-cap in `governance/escalation-points.json`. This
command dispatches no orchestrator seat, so it calls the writer itself, from the main session. No
seat's `Write` grant grows.

    node scripts/escalation.mjs raise --point feature.review-cap --slug <SLUG> --runner <forge login> \
      --question "<the one question a person must answer>" \
      --parked-ref requirements/<SLUG> --parked-commit <12 hex of the last reviewed commit> \
      --design docs/requirements/<SLUG>/requirements.md \
      --findings-file <the deduplicated findings from both rounds> --by-seat feature

The script opens the escalation's `[shl-harness]` issue in the hub, with the `raised` line, one
`notified` line and the findings as the issue's artefacts. The feature owner is the next
person told. This command prints what the script prints, first in its closing report. It never
edits `docs/designs/CLAR-log.md`: the § Escalation record there is a view that `escalation.mjs
print` writes. Exit 2 means the line did not reach the record. Say so first in the report, and
carry the question and the findings in the report itself.

Where the feature owner is `UNRESOLVED` (precondition 5), the script still names the feature owner
as the role, and the pull request says that nobody holds it.

### Other escalations

These stops raise an escalation as a cap does, and then stop. Each is one call of
`node scripts/escalation.mjs raise --point <ID> --slug <SLUG> [--work-item <KEY>] --runner <forge login> --question "<the one question>" --by-seat feature`
with the options in the last column. Print what the script prints first in the closing report. Exit
2 means the line did not reach the record: say so first, and carry the question in the report.
The sweep tells the people named in `governance/escalation-points.json` and asks again after the
wait of the path. A question to the person inside the interview (feature.interview, decompose.parent-epic) waits in the session and writes nothing.

| Point | When | Path | Options |
|---|---|---|---|
| feature.contradiction | the sources contradict and the person cannot choose between them | decision owed | `--path decision-owed` |

## Gates it enforces

| Gate | Behaviour on failure |
|---|---|
| The requirements documents on the trunk are read index first: every one is an index line from `read-context.mjs --hub`, and a body is opened by `--names <slug>` only where its line plausibly overlaps the intent | Refuse to open every document, and refuse to open one whose line gives no reason to. Reading the corpus is the bulk read `.claude/rules/context-budget.md` forbids; the index is the pre-digested list it asks for |
| One question per message, with a suggestion, lettered where the answers are a known set | Rewrite the turn before sending. A form of four goes unanswered, and a bare open question gets a guess back |
| Every counted interview turn opens with its count line, and the total changes when an answer adds or removes questions | Rewrite the turn before sending. Twenty-five questions with no sense of how many remain feel endless to the person |
| Every answer is recorded word for word, in its own numbered note, before the writer is dispatched | Refuse to dispatch. A paraphrased answer is the command's words, not the person's, and the critic can only check what was written |
| A parked question is a clarification row with a blocking flag; a parked number is an `UNRESOLVED` marker | Refuse a plausible sentence in its place. "I don't know" is an answer, and it has one written form |
| A conflict with a ranked source is a turn, and its outcome a note | Refuse to write around it. The higher source wins by default only after the person was shown it |
| The premise of every question is read against the earlier notes before it is sent | Rewrite the turn as a conflict turn. Two answers that disagree because the second question assumed the opposite of the first are a blocking row the interview minted itself |
| No question and no clarification row asks how — a path, a name, a format, a branch pattern, a header field, an inner mechanism | Refuse the turn, and refuse the row. The design settles it in `/dev-spec`, and the design's own clarification table is where the engineer's unanswerable question goes |
| The run folder is committed and parses before any seat runs — and again after the gap pass, before the writer's revision | Refuse to dispatch. A seat that reads an uncommitted record cites line numbers that may move |
| This run's folder is new, and no earlier run folder is touched | Refuse and name the folder. Wait for the next minute; never write into, delete or move an existing run folder |
| An amendment starts only on `requirements/<SLUG>`, after `check-requirements-amend.mjs <SLUG>` exits 0 and the person confirms the pull request is still open | Refuse, and print what the script printed. A merged branch is accepted: changing it is a revision after the merge, from the trunk |
| An amendment pushes to its own pull request's branch, never with force, and opens no second pull request | Refuse the push |
| Every requirement and every criterion cites a note or a copied file by locator | Refuse the statement. An uncited statement is an invented one |
| Every citation resolves to the note or the lines it names | Refuse. A citation that cannot be opened is not a citation |
| Every note and every part of every copied source is represented, or out of scope with a reason and an owner | Refuse. An answer nobody carried is a decision nobody made |
| Every requirement has criteria with stable `REQ-<n>.AC-<m>` identifiers and at least one negative case | Refuse the requirement |
| Every threshold, window, volume and limit is stated or marked | Refuse a guessed value |
| No placeholder cell anywhere | Refuse. `check-requirements.js` reads every table on the page and refuses one too |
| The global release is resolved before the grounding index is read, and every `read-context.mjs --hub` call of the run takes its commit with `--global <commit>`, or no call takes `--global` when the line is `Global: none`. A revision keeps the recorded release, and an amendment takes the release its start check settled | Refuse to read the index before the release is settled, and refuse a call at another commit. A global entry pinned to a commit other than the `Global:` line's fails `check-requirements.js` |
| The document carries one `Context:` line and one `Hub commit:` line, copied together from `read-context.mjs --hub --names`, or `--hub --global <commit> --names` when the `Global:` line records a release. Each entry is a hub entry, `<id>@<12-hex>:<path>`, or a global one, `<id>@<12-hex>:global:<path>`. Each document on it is used on the page, a standard by its rule ids, `std-<topic>.<NN>` or `global.std-<topic>.<NN>`, except an always-on document, which the script adds to every line. Each decision record and standard the page cites is on the line, and so is each global exception it cites, with every record that exception departs from. The writer and the critic receive the documents as text | Refuse to dispatch the writer without the printed text, and refuse a typed line. `check-requirements.js` fails a missing line, an unused entry, an unlisted citation, and a global entry whose path, header, release or exception does not hold at the recorded commit |
| The document carries one `Global:` line, copied from `read-global.mjs --resolve`. Only an amendment that starts with `--global` moves it, and only to a newer release | Refuse a typed line, and refuse a move the start check refused. `check-requirements.js` fails a release in a hub with no global layer, `none` in a hub with one, a tag that is not a release tag, a moved or deleted tag, and a commit that is not on the global trunk. It exits 2 when the global repository does not answer |
| The `Slug` cell is the slug alone, in backticks, and every other cell a script reads by name holds its value alone | Refuse the cell. `check-requirements.js` compares the `Slug` cell to the folder literally, and a citation in it fails the pull request after approval |
| `check-requirements-candidate.mjs <SLUG>` runs on the committed branch before the critic is dispatched, and again before the pull request opens | Refuse to dispatch, or to open the pull request, on a finding it prints. A round spent on a failure the check would have found is a wasted round; a pull request opened red is a document nobody can merge |
| No priority, sequence or commercial trade-off originated by an agent | Refuse the row |
| The document names no repository — no Feature Name row, no section, no requirement that picks one — and the interview never asks which repositories the intent touches | Refuse the row, and the question. Which repositories a requirement touches is `/decompose`'s finding, read from the repositories |
| Twenty-five questions is the soft cap | Stop asking, park what is open, write. Never ask a twenty-sixth to avoid a row |
| Every clarification row the first draft leaves is put to the person once, before the critic, unless Open Questions is `NONE` or the interview ended at its cap | Refuse to dispatch the critic on a draft whose rows were not asked. A row the person could close in one turn costs a merge and a re-run if it is left in the document |
| Two-round cap on the review, and no return to the person inside it | On cap: raise the escalation with `escalation.mjs raise --point feature.review-cap`, leave the document in its last reviewed state, stop |
| A re-run after a cap finds something changed upstream | Refuse, and print what `escalation.mjs resume` printed. A cap is never raised |
| The verdict is one of the two exact tokens | Refuse to read anything else as a verdict |
| The review file is the critic's final round, verbatim, and the document is untouched after it | Refuse to write a review the critic did not return, and refuse to edit the document after the round that approved it |
| The requirements pull request is opened, and never merged by this command | Refuse to finish with the document only in a working tree |

## Output

- `docs/requirements/<SLUG>/runs/<yyyymmdd_hhmm>/interview.md` and every copied source, on the
  branch, each under the header `check-context` proves.
- `docs/requirements/<SLUG>/requirements.md` on the branch — the sources and their revisions, the
  scope, the requirements with their criteria, the constraints, the coverage map over every
  source, the clarification rows and the assumptions log.
- `docs/requirements/<SLUG>/requirements-review.md` on the same branch — the critic's final
  round, verbatim, with the verdict token and `Document revision: <hash>`.
- An open requirements pull request on `requirements/<SLUG>` — on an amendment, the same one,
  with new commits and an `Amendment <stamp>` section in its description — carrying those files and nothing
  else, with `requirements-gate` and `check-context` reporting on it, and a description that says
  how many questions were asked, how the gap pass went, which clarifications are open and which
  of them block.
- A last reply that ends with the numbered list `Next steps` (§ Stopping condition).
- On cap: an escalation raised with `escalation.mjs raise`, carrying the document's last reviewed
  commit, the deduplicated finding list from both rounds, the specific question the human must
  answer, and the `[shl-harness]` issue that records them.

## The house format — what a replacement may change

`docs/requirements/_TEMPLATE.requirements.md` is the shipped house format and an organisation that
has its own replaces it. Replacing it is expected. **Four things are not the format's to change**,
because the gates above, `check-requirements.js` and `/decompose` are written against them:

| Fixed | Where it is read |
|---|---|
| Identifier grammar — `REQ-<n>`, `REQ-<n>.AC-<m>`, never renumbered; each requirement a heading whose first word is its `REQ-<n>`, with a table beginning `\| ID \| Criterion \|` beneath it | `check-requirements.js`, on the pull request and on the trunk; the gates above; every downstream artefact that cites one |
| A coverage map over every source, with a disposition and an owner per part | the gate on unmapped source; `feature-review`'s headline dimension |
| The clarification table's eight-column schema | `docs/designs/CLAR-log.md`, which is the schema of record |
| One `Context:` line, as `read-context.mjs --hub` prints it, with `--global <commit>` when the `Global:` line records a release, and each document on it used on the page. Its entries are hub entries and global entries, `<id>@<12-hex>:global:<path>`. Beside it, one `Hub commit:` line, as the same run prints it, and one `Global:` line, as `read-global.mjs --resolve` prints it | `check-requirements.js`; `/decompose`, which carries each entry into at least one story |

Everything else — section order, headings, numbering convention, front matter, the labels, a RACI
block — is yours, and the interview walks whatever sections your format has. Move those four
into your own shape rather than dropping them, and record the replacement in
`docs/harness-decisions.md`. What never moves at all is the method in
`.claude/skills/write-requirements/SKILL.md`; that file is installed verbatim and is not the format.
This file names sections by the shipped template's headings — the Feature Name table, Link to PRD
Document, Open Questions, Assumptions made — and a replacement format maps each name to its own
heading.

## Stopping condition

Three outcomes, no fourth.

1. The verdict reads `APPROVED` within the cap, the document is written, the review is beside
   it, and the requirements pull request is open — or, on an amendment, pushed to — with
   `requirements-gate` reporting on it. The
   command ends in front of the human who merges it.
2. **The document is written and carries blocking clarifications.** Open the pull request
   anyway, and say so in its description: a requirements document whose honest output is a list
   of questions is doing its job. What is refused is a *guess* in place of a question.
   `/decompose` records a requirement held on a blocking clarification as `Unresolved` and mints
   no key for it; the way back is § Running it again.
3. The cap was reached: escalate to the feature owner, leave the document in its last
   reviewed state, stop.

**Every outcome ends with the next steps.** The last reply of every run, of every kind, ends
with a numbered list headed `Next steps`. Each step names who acts and the exact command or
action. State only steps that the repository supports:

1. After outcome 1 or 2, the first step is the merge: a person reads the requirements pull
   request and merges it. Give its URL, and name `requirements-gate`.
2. Where clarifications are open, one step names them and says to run `/feature` again on the
   same slug with the answers. Before the merge, that run is an amendment on the branch.
3. Where no decomposition record exists for the slug, the step after the merge is
   `/decompose docs/requirements/<SLUG>/requirements.md`.
4. Where a record exists (`docs/backlog/<SLUG>.decomposition.md` on the trunk), say that the
   record is behind the document until `/decompose` runs again, and that `decomposition-gate`
   prints the difference as notes on this pull request. The step after the merge is
   `/decompose` on the same slug, and then the merge of its pull request.
5. After outcome 3, the one step is the question the feature owner must answer, and then
   `/feature` again on the same slug.

Reaching either cap is information, not failure. Twenty-five questions that did not close the
document, or two review rounds that did not converge, mean the business input is not ready, and a
third round produces a more confident write-up of the same unclear text.

## Never

- Never ask two questions in one message, and never ask without a suggestion.
- Never send a question whose premise departs from an earlier answer without showing the
  departure. A contradiction the interview introduces is one the writer must still log.
- Never ask how, and never let a row ask how. A path, a name, a format, a branch pattern, a header
  field or an inner mechanism is the design's to settle.
- Never dispatch the critic on a first draft whose clarification rows the person has not seen,
  unless the interview ended at its cap. The rows are the interview's misses, and the person is
  still there.
- Never paraphrase an answer into the record. The note carries the person's words; the writer
  paraphrases, and cites the note it paraphrased.
- Never write a requirement no note and no source supports, however obviously the business needs
  it. That is a clarification row addressed to a role, not content.
- Never guess a threshold, a window, a volume or a limit. Ask; failing that, mark it.
- Never resolve a contradiction silently — between two answers, between an answer and a document,
  or between two documents. Show it, ask, record the outcome.
- Never read spoke code to answer an interview question — the estate overview and the list's
  `purpose` text are the interview's whole view of the estate — and never let a seat talk to the
  person.
- Never go back to the person inside the review loop. The interview ends when the folder is
  committed; a gap the critic finds is a row, answered on the re-run.
- Never write into a run folder that already exists, and never delete or move one. Wait for the
  next minute instead.
- Never amend a branch that is merged, never push a requirements branch with force, and never
  open a second pull request for an amendment.
- Never cite an external page, thread or slide directly. Copy it in, cite the copy, and name the
  original and its revision in Link to PRD Document.
- Never follow a ticket's links, and never write to Jira from this command. A ticket is read,
  copied and cited, and nothing more.
- Never write a review the critic did not return, never edit the document after the round that
  approved it, and never treat this run's verdict as the acceptance — the merge is.
- Never set business priority, delivery sequence or commercial trade-off. Record the ones a source
  states, attributed; originate none.
- Never renumber a `REQ-<n>` or a criterion identifier. Append, and deprecate what is retired.
- Never mint a work-item key, cut the document into items, or write a design or a line of code.
- Never ask the person which repositories the intent touches, and never name one in the document.
- Never merge the requirements pull request, and never commit the document straight to the trunk.
- Never let `/decompose` proceed on a document that is not on the trunk.

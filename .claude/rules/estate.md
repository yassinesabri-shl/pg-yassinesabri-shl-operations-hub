---
name: estate
description: How the hub and its repositories relate — who decides what, how a fact read in another repository is cited, and which branch of a repository is its trunk.
globs: ["**/*"]
alwaysApply: true
---

<!-- Part of the harness asset library c6f3b4427d58f7c3 (see VERSION.json) · 2026-09-18 -->

# Rule — the estate

The hub holds every requirement, every story and every design. Each spoke holds code. This rule
says six things about the line between them, and nothing else.

## 1. The hub decides whether and what. The repository decides how.

Whether a change is made, and what it must achieve, is decided in the hub: the requirement, the
story, the design, the criteria. How it is built, tested and merged is decided in the repository
it lands in: its commands file, its CI, its own conventions. Where the two seem to disagree on
*how*, the stricter reading wins, unless a spoke rule overrides the standard rule on purpose (§3).
Where they disagree on *whether* or *what*, the hub is wrong or
the story is, and the answer is a clarification row, never a quiet widening.

A story names exactly one repository. A design names the same one on its `Repository:` line, and
the gate reads it. A change that needs two repositories is two stories with a dependency between
them, in the hub's dependency map, as any other dependency is.

## 2. A fact read in another repository carries its commit, or it is malformed.

Every cross-repository read goes through `scripts/read-spoke.mjs`, which prints the commit it read
at and the line to cite it with. The grammar is:

```
<repository-id>@<12-hex-commit>:<path>          the file
<repository-id>@<12-hex-commit>:<path> L<a>-<b> the lines
```

A citation into a spoke without the commit is not a citation, and the checkers that read stories
and designs reject it. The list's `purpose` field orders the reading, is never cited, and rules
no repository out: a plan reads the real tree at a pinned commit, or it has not read it.

A seat can search a spoke with `--grep`, for text in files, or with `--files`, for file paths.
`--grep` searches for fixed text. Add `--regex` to search for one of several texts, as `a|b`. A
search finds a location. It is never cited, the same as a survey (§5). The seat reads the file at
that location and cites the read. The critic in `lld-review` cannot search a spoke. It asks for searches
and reads in one request round, and the orchestrator runs them
(`.claude/skills/review-artefact/SKILL.md` § The request round).

No seat reads a spoke with a shell, a clone of its own, or a credential. One read-only script,
no branch argument, the commit printed every time. That is what lets a planning seat hold it.

A sibling hub, another hub that a shared spoke's `HUBS` line names, is read only by
`/add-context`, through `scripts/read-hubs.mjs`, with the access of the person who runs it. No
seat, no gate and no hub CI job reads a sibling hub.

## 3. The repository's own rules bind the code that lands in it, and reach a seat as text.

A spoke may write down the *how* §1 gives it: stack, layout, naming, commit types, the shape of a
handler — in prose only where no tool in `checks.env` can check it. It says where, in one key of
its commands file, `RULES_INDEX`: a flat folder of `.md` files, each opening with the frontmatter
the hub's rule pack uses (`name`, `description`, `globs`, `alwaysApply`), exactly one of them
always on, none over 80 lines. `none` says on purpose that there are no written rules.
`UNRESOLVED` or a missing key is `NOT CONFIGURED`: reported in every design and pull-request body,
never a stop.
A rule arrives by `/add-context --kind rule --repo <ID>`, drafted from the hub's rule template and
opened as a pull request in the spoke, or by hand from the same template; a person merges either.

Which rules bind a change is decided by the design, not by a reader's taste: the always-on rule,
plus every rule whose globs match a path the design's §3.1 table names. `scripts/read-spoke-rules.mjs`
makes that selection at a pinned commit and prints the text with a `Cite:` per rule and one
`Rules:` line — `<repository-id>@<12-hex-commit>:<folder>`, or `none`. The design carries that line
beside `Repository:`, the pickup gate reads it, and `/dev-sprint` re-reads the folder at the same
commit and reports drift against the trunk. Earlier, `/decompose` reads only the always-on rule and
the `Status:`, at the commit its repository map pins, to place a boundary and to know before any
design is written that a repository is `NOT CONFIGURED`; a story carries no `Rules:` line, because
selection needs the design's paths. The orchestrator hands the printed text to the worker,
the critic and the validating seat; none of them opens the folder.

A spoke rule may override a standard. The hub's standards and the global standards say *how*
for the whole estate, by language and by path. A spoke whose code needs a different *how* writes
its own rule and names what it replaces in the rule's `overrides` key: a whole standard,
`std-<topic>`, or one rule of it, `std-<topic>.<NN>`, with the `global.` prefix for a global
standard. The override holds only where the spoke rule binds: the always-on rule everywhere, a
path-scoped rule where a §3.1 path matches its globs. `scripts/read-spoke-rules.mjs` prints an
`Overrides:` line in the rule's block, and `scripts/read-context.mjs` prints an `Overridden:`
line in the standard's block, naming the rule and the spoke. An overridden standard rule does
not bind that change; the spoke rule binds in its place, and a critic reads the two lines, never
the folder. The spoke's pull request is the approval: a person in the spoke merges the rule, as
for any rule. A spoke never reads a hub, so the spoke's check proves the key's form only; the hub
proves, when it reads the spoke, that each id names a standard and a rule it defines. An id no
standard defines fails the read. A standard not in scope of this hub is a note, because a spoke
in two hubs may name a standard only one of them holds. A decision record is never overridden:
a record decides *what*, and a spoke rule says *how*.

Two things this is not. It is not the runtime loading a rule by glob — nothing here does that, and
`CLAUDE.md` says so; a script selecting by glob and a seat receiving text is a different mechanism
with a commit on it. And it is not a second constitution: a spoke rule says *how*, and where it
disagrees with a hub rule on how, the stricter reading binds unless the spoke rule overrides it
as above; where it tries to say *whether* or
*what*, that is a clarification row (§1), never a quiet override. A malformed folder binds nobody
until it is fixed: the reader refuses the whole set, and the spoke's `story-gate` refuses the pull
request that introduced it, using the hub's checker against the spoke's checkout.

## 4. A context document reaches a seat the same way: by selection, at a commit, as text.

Beyond rules, an estate holds documents a design must obey or cite: the hub's decision records
(`docs/architecture/`), estate-wide standards (`docs/standards/`), one plain-English overview of the
estate (`docs/estate/overview.md` — what the system is, part by part, who owns each part and the words
the business uses; `/feature` reads it before its interview and `/decompose` before its repository map,
a design that wants it names its id `estate-overview`, and it is never always on), the requirements documents
`/feature` wrote and a person merged (`docs/requirements/<slug>/requirements.md` — one per slug folder, its id the
slug, read from its own title and its control table (Feature Name, in the shipped template) with no header; its status is derived, never typed:
`accepted` when `requirements-review.md` beside it carries `### VERDICT: APPROVED` and a `Document revision:` equal
to the document's bytes and the trunk carries those same bytes, `proposed` otherwise — on a pull request's branch, an
amendment included — and `CLAUDE.md` §4 ranks the two; a design that wants one names its
slug, and it is never always on), the business inputs `/feature` ran on
(`docs/requirements/<slug>/runs/<yyyymmdd_hhmm>/` — under each requirements document's own folder, one per run,
stamped with the day and the minute it started so two runs on one day sit apart, holding the interview record and
every file copied in for it), each spoke's contracts — the interfaces it consumes or
serves and the documentation of every third-party API it calls — in the folder its commands file
names with `CONTRACTS_INDEX`, and each spoke's own decision records in the folder it names with
`DECISIONS_INDEX`. A spoke's record binds only that spoke's code, so every hub of the spoke reads
the one copy the spoke keeps. Its file is `ADR-<NNN>-<slug>.md`, numbered by the spoke, and its id
everywhere else is `<repository-id>.ADR-<NNN>`: a bare `ADR-<NNN>` is always the hub's. A spoke's
record narrows the hub's records and never overrides one; where the two conflict, the hub's
record wins and the design stops with a blocking clarification to the lead architect. Every one but a requirements document opens with the rule pack's
frontmatter plus `kind`, `owner` (a role), `revision` and `origin` — a decision record adds `status` — with `description` at most 200 characters
because the index prints it; a requirements document is read from its own structure. A decision record is a summary for agents of a record the client keeps elsewhere, and only an `Accepted` one binds by globs or always-on. A standard is a summary for agents too, named by its topic, `std-<topic>`, because the client keeps no number for it, and written from `docs/standards/_TEMPLATE.standard.md`; it adds `status`, and only an `Active` one binds by globs or always-on — a `Reserved` one, held for a stack the estate does not use yet or not yet adopted, binds only a design that names it: only the rules that bind the estate, each under an id `<name>.<NN>` a design cites, every open value an `UNRESOLVED` line; `/add-context --kind standard` writes it after settling every contradiction with a person. No other document's id starts with `std-`. A
missing key is `NOT CONFIGURED`, reported and never a stop; a folder on disk is not read
until the key says so.

Which documents bind a design is decided the way §3 decides rules: `scripts/read-context.mjs` selects,
at a pinned commit, every document the design names by id, every one whose globs match a §3.1 path,
and every one that is always on, and prints the text with a `Cite:` per document and one `Context:`
line the design carries beside `Rules:`, each entry `<id>@<12-hex>:<path>` — the id, the blob hash of the bytes
read and where the file is, `<repository-id>:<path>` for a spoke's. A document of the global context repository is
`global.<id>@<12-hex>:global:<path>`, its pin the commit on the `Global:` line of the requirements document the design
traces to, and the selection reads it with `--global <commit>` from that line. Beside the `Context:` line, the same run
prints one `Hub commit: <40-hex>` line, the hub commit it read the hub's documents at, and every artefact that carries
a `Context:` line carries that line too, copied with it. The three gates prove that the commit is on the hub's trunk and
holds every hub entry's pinned bytes, and `scripts/report-context.mjs` prints where each entry sits in the hub's
history for a person. The pickup gate reads the line's form,
refuses a hub entry whose file is not on the trunk or whose pinned bytes the trunk never held, and notes —
never fails — one whose bytes moved since the design read them: context drift is the reader's fact to weigh, not the gate's to judge. The gate also reads the use of each document: each id named in the design, a standard cited by a
rule it defines, each cited decision record and standard rule on the line, and each id on the story's
`Context:` line on the design's. For a global entry it reads the global repository at the recorded commit: the path
is there with a header that names the id, and a global exception is `Active`, names this hub and sits beside each
record it departs from. A spoke's `story-gate` reads no global repository: it proves the entry's form and commit. With no design it prints the index — one line per document,
no bodies, and no line for a requirements source — which is what an author reads first, and what `/decompose` reads for every repository the
requirement could touch, opening by `--names` only the documents that bear on the cut: orientation for the
boundary, cited from the `Cite:` line. Once the cut is drawn, `/decompose` selects each story's documents by
`--names` at the story's repository and commit, and the story carries the `Context:` line printed. Each
document on the requirements document's line reaches at least one story. `check-decomposition.js` reads
each story's line as `check-requirements.js` reads a requirements document's, and checks that carry. With `--hub` it prints the hub's index alone, with no
repository and no remote — what `/feature` reads before its interview, when no story names a spoke yet: one
line per merged requirements document, with its status, so an overlap with the intent is found from the index
and the one document is opened by `--names <slug>`, never the corpus. `/feature` resolves the global release
first, and when it is a release every `--hub` read of the run adds `--global <commit>` from it, so the index
and the selection carry the global layer at that commit. After the interview, `--hub --names`
selects the documents that bear on the intent, and the requirements document carries the `Context:` line it
prints: hub entries and global entries, and no repository entry. `check-requirements.js` reads that line's
form and files, and each document's use on the page: an id named, a standard cited by a rule it defines,
`std-<topic>.<NN>` or `global.std-<topic>.<NN>`.
`scripts/check-context.mjs` proves every document parses and every always-on rule is imported; there is
no register — the folders are the fact, and the index is printed when asked.

## 5. A service survey points at a repository's surface. It is never cited.

What each repository serves, what it calls and in which repository or at which third party's host,
which data stores it touches and which libraries it uses is written once per repository in the hub, at
`docs/estate/surveys/<ID>.md`, by `/survey-repo`. Every row opens with a key in a fixed grammar —
`http:<METHOD>:<path>`, `event:`, `queue:`, `job:`, `store:<engine>:<name>`, `lib:` — so a call in
one survey and a serve in another are matched exactly, never guessed, and every row points at its
lines as `<id>@<12-hex>:<path> L<a>-<b>` at the survey's one commit. A call names its provider: a
listed repository, `external:<host>` for a third party, or `unknown` where the code names neither.
A call with an unknown provider is still a row, because only rows are read: an open point holds
only what the grammar cannot key. `scripts/check-survey.mjs` is a
required check on the hub's pull requests: it proves the shape, that the repository and every
provider are listed, that no open point names a key no row carries, and that every pointer is a real range at a commit on the trunk. It reads a
remote only for a survey the pull request changes, so a pull request that touches no survey and
not the list of repositories reads none, and one that changes a survey reads only the repository
it is about. A pull request that changes the list re-checks every survey, because a removed
repository can leave a survey, or a call, naming nobody.

`scripts/read-survey.mjs` builds the graph from the surveys when asked, and never saves it: who
serves each key, who calls it, who calls it with the provider unknown, which third-party hosts each repository calls, which stores and
libraries more than one repository shares, and which calls match no serve. A call matches a serve when the keys are equal after every `{param}`
is written `{}`. `--readers <key>` names the readers of any key: who calls an endpoint, event,
queue or job; who uses a library, from either library section; who reads or writes a store. For
a call it also names, apart, every repository that calls the key with the provider unknown: a
possible reader, read like any other, because only its code says where the call goes.
`--find <words>` finds the keys themselves, for a planner who knows what changes but not its key:
every key a word is part of, or whose serve or store says it, with who serves, calls, touches or
uses it, and no remote asked. `--readers` is what `/decompose` reads before it cuts a contract change and what `/dev-spec` reads for a
design that changes a served contract, one drift line per reader.

A survey is an index, as the list's `purpose` is: it orders reading and rules nothing out. A plan
that finds a reader through a survey reads that repository at a pinned commit through
`read-spoke.mjs` and cites that read, never the survey; a repository with no survey is unsurveyed,
never assumed to read nothing. A survey behind its repository's trunk head says when it was true,
and `/survey-repo` is the refresh.

One exception to §2, stated so it is not a precedent: `/survey-repo` clones the repository into a
disposable directory, and the surveying seat reads that clone, once for each part of a plan, with `Read`, and `Bash` for read-only
search only, as `/qa-sprint`'s validating seat reads the checkout it is given. The seat holds nothing
else and writes nothing. It returns a part, and a script joins the parts into one survey. The check
re-proves every pointer against the remote before the survey can merge.

## 6. A repository's harness trunk is the branch its list entry names. No other branch takes harness work.

Each entry in `docs/estate/repositories.json` names the repository's harness trunk in `trunk`.
`default` is the branch the remote reports as its default branch. Any other value is a
**declared trunk**: a named branch that is not the default branch. `TRUNK_FOR_HUB` in `checks.env`
on the trunk carries the same value. `scripts/read-spoke.mjs` applies this trunk rule on every
read, and prints the result on its `Trunk:` line. A missing branch, or two values that disagree,
stop the read with exit 2. A repository in several hubs has one harness trunk, so the entry in
every hub that its `HUBS` line names carries the same `trunk`.

A declared trunk is for a repository that two teams share. The other team works on the default
branch, without the harness. The harness works only on the declared trunk. Every command and every
seat that works in such a repository obeys these rules:

1. Take the trunk from the `Trunk:` line of a `read-spoke.mjs` read in this run. Never assume `main` or the default branch.
2. Cut every feature branch from the trunk.
3. Open every pull request with `--base <trunk>`. A pull request without a base goes into the default branch.
4. Compare, diff, rebase and measure coverage against the trunk only.
5. Never merge the default branch into a feature branch. Never push to the default branch, and never open a pull request into it.
6. Never start a sync. A sync is the only way the default branch reaches the trunk: a branch that
   matches `SYNC_BRANCH` (`^sync/`), merged with a merge commit. A person cuts it and reviews it.

`story-gate` judges only a pull request into the trunk. On a pull request into the default branch
it passes at once and runs no step. A story sent to the default branch by mistake therefore gets
no gate. On a sync, `story-gate` runs only the secret scan. Where the entry says `default`, the
default branch is the trunk, `SYNC_BRANCH` is `none`, and rules 1 to 4 still bind.

No seat finds the trunk by itself. `/dev-sprint` hands every seat that works in a repository
checkout a trunk block: the repository, its trunk, whether the trunk is declared, and the sync
pattern (`dev-sprint.md` § The trunk block). A seat dispatched into a repository checkout without
a trunk block stops and reports it.

UNRESOLVED — whether the nine repository-specific stubs the hub carries (`coding-style`,
`git-workflow`, `testing`, `backend`, `frontend`, `contracts`, `type-pipeline`, `copyright`,
`connector`) move out of the hub now that a spoke has a home for them. Owner: harness lead.
Resolves: the first estate where a spoke completes one.

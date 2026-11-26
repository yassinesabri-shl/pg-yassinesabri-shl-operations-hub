---
description: Put one context document where the estate reads it — a client's ADR, standard, contract or third-party API document, or the one-page estate overview — with the header the scripts read, prove it parses, and open the pull request. A standard is not copied: it is summarised from the standard template, keeping only the rules that bind the estate, after every contradiction and error in it is settled with the person. Or draft one spoke rule from a stated intent and the rule template, and open the pull request in the spoke. Or request one exception from a global record, and open the pull request in the global context repository. A hub record or standard is checked against the global layer and the sibling hubs first, and a spoke's own record against the global layer. Asks nothing, except to settle a rule's intent, a standard's contradictions or an exception's interview. Merges nothing.
argument-hint: <file> --kind <kind> --repo <ID>|hub --owner <role> --revision <text> --origin <text> [--name <id>] [--status <status>] [--supersedes ADR-<NNN>] [--globs <a,b>] [--always-on] [--skip-hub <prefix>=<reason>]... | --global --kind exception --departs <global.id,...> --owner <role> | --kind rule --repo <ID> (--intent "<text>" | <file>) --globs <a,b> --owner <role> [--name <id>] [--always-on] [--overrides <id,...>] | --remove <id> [--kind rule --repo <ID>] | --rename-standards
---

<!-- Part of the harness asset library c6f3b4427d58f7c3 (see VERSION.json) · 2026-09-18 -->

# `/add-context <file> …` · `/add-context --kind rule …` · `/add-context --global --kind exception …` · `/add-context --remove <id>` · `/add-context --rename-standards`

**This file is a contract, not an integration.** It defines the procedure, the preconditions and
the stopping condition. The code host and the pull-request mechanism are yours. Nothing in this
command talks to a tracker, a wiki or a vendor's site: the document arrives as a file, copied.

**Purpose.** Put one document a design must obey or cite where the estate reads it, in the form
the scripts read: the folder its kind fixes, the header that names its owner, revision and
origin. Run once per document, or once per rule.
Run again with a new revision to replace it. A document this command did not place is context
nothing hands in: `scripts/read-context.mjs` selects from the folders `.claude/rules/estate.md` §4
names and nowhere else.

**A standard is summarised, never copied.** `--kind standard` reads the original whole, refuses
it when it is not a standard, keeps only the rules that bind work across the estate, checks them
against the document itself and against every standard and record already in the hub, asks the
person every question whose answer changes a rule, and writes the summary from
`docs/standards/_TEMPLATE.standard.md` (steps S1 to S8). The original stays where the client keeps
it; the person who merges the pull request confirms the summary matches it.

**A rule is the one kind this command writes from an intent.** `--kind rule` places one file in a spoke's own
rules folder, the folder its `checks.env` names with `RULES_INDEX` (`.claude/rules/estate.md` §3).
The person gives the intent; this command settles it with them, drafts the rule from
`docs/estate/_TEMPLATE.rule.md`, proves the folder with `scripts/check-spoke-rules.mjs` and opens
the pull request. The text is a draft until a person merges it: the pull request quotes the intent
word for word and says the rule was drafted by the harness.

**An exception is requested here, and approved in the global context repository.** With
`--global --kind exception`, this command interviews the person, writes one exception from the
global repository's template, and opens the pull request there (What it does — an exception). The
Global Architecture Board (the Board) approves it, because a product never grants an exception to
itself. The hub requests it, because only the hub knows its repositories and the hub record that
states what the product does instead.

**A hub record or standard is checked against the layers beside it.** Before the pull request
opens, a hub record and a standard are read against the global layer at its newest release, and
against every sibling hub that shares a spoke the document covers (What it does — check a hub
document against the other layers). A spoke's own record is read against the global layer too. A sibling hub is another hub that a shared spoke's `HUBS` line
names. Only this command reads a sibling hub, with the access of the person who runs it. Hub CI
never does.

**Who runs it.** A person types it in the hub. It runs in the hub for every kind; for a spoke
kind it opens a pull request in the spoke from a disposable clone, on a `harness/` branch, which
is the one branch pattern the spoke's `story-gate` lets merge without a design. For an exception,
it opens the pull request in the global repository from a disposable clone. It dispatches no
seat and produces nothing itself beyond the copy, the header and the pull request; for a rule,
the text of the rule as well.

## Inputs

| Input | Form | Where it comes from |
|---|---|---|
| `<file>` | **A path to one file on disk**, markdown or plain text, readable in full. A URL, a wiki page or a mail thread is saved to a file first; this command never fetches. For `adr`, the record as the client keeps it, exported or pasted into a file. For `standard`, the original as the client keeps it, exported whole: the summary is written from it and nothing else. For `rule`, the source of the intent — a page exported from where the team keeps its conventions — given instead of `--intent`, never with it | The argument |
| `--kind` | One of `contract`, `vendor-doc`, `adr`, `standard`, `estate-overview`, `rule`, and `exception` with `--global` only. The two requirements kinds are `/feature`'s, and this command refuses both: business input is copied into its run folder, `docs/requirements/<slug>/runs/<yyyymmdd_hhmm>/`, beside the interview record (`requirements-source`), and the finished document is `docs/requirements/<slug>/requirements.md` (`requirements-document`), which `/feature` writes and a person merges | The argument. The kind decides the folder (table below) and nothing else does |
| `--repo` | `hub`, or a repository id in `docs/estate/repositories.json`. Required for `contract`, `vendor-doc` and `rule`, and then a listed id, never `hub`. Optional for `standard` and `estate-overview`, which always land in the hub: absent, or `hub`; a repository id is refused. For `adr`, absent or `hub` for a hub record, or a listed id for that spoke's own record, which lands in the folder its `checks.env` names with `DECISIONS_INDEX` | The argument |
| `--owner` | The role or the person accountable for the document being current — `tech lead`, `data platform team`, or a name as the source states it. For `rule`, a role, never a person: the role that grants exceptions to the rule, written into its Exceptions and Origin sections | The argument |
| `--revision` | The original's version, date or edition, as its author states it — `v3.2, 2026-08-01`, `2026 edition`. Never the commit that adds the copy. Refused for `rule`: its origin is the intent, quoted in the rule's Origin section and in the pull request | The argument |
| `--origin` | Where the copy came from, so a reader can find the original — `client intranet, page 4412`, `vendor developer portal, downloaded 2026-08-01`. Refused for `rule`: its origin is the intent, quoted in the rule's Origin section and in the pull request | The argument |
| `--name` | The id designs will name: lowercase letters, digits and hyphens. Derived from the file name when absent. Refused for `estate-overview`, whose id is fixed. For `adr`, required, and the grammar is `ADR-<NNN>` (`^ADR-\d{3,}$`), the number the record carries. For `standard`, the grammar is `std-<topic>` (`^std-[a-z0-9]+(?:-[a-z0-9]+)*$`): absent, proposed from the topic and shown before the draft is written (step S6); given, a name `docs/standards/` holds is a replacement, and any other name is a new standard. A name that a removed standard held is refused. For every other kind, a `--name` that starts with `std-` is refused, because that prefix names a standard. For `rule`, proposed from the intent in kebab case (`camel-case-variables`) when absent, and shown before the draft is written. A `--name` that does not match `^[a-z0-9][a-z0-9-]*$` is refused. For `rule`, a `--name` the folder already carries is a replacement | The argument, or derived |
| `--status` | For `adr`: `Accepted`, `Superseded by ADR-<NNN>`, `Superseded by global.ADR-<NNN>` or `Deprecated`, as the record states it. `Superseded by global.ADR-<NNN>` says that a global record now states the decision (`/check-global`). Any other status is refused: a proposed record is a draft beside its design. For `standard`: `Active` or `Reserved`. `Active` binds every design whose paths the globs match, or every design when always on; `Reserved` holds a standard for later — a stack or kind of change the estate does not use yet, or a standard not yet adopted for this estate — and binds only a design that names it. Refused for every other kind | The argument; for `standard`, `Active` when absent |
| `--supersedes` | For `adr` only: the number of the record the new one replaces, `ADR-<NNN>`. The old record's `status:` line changes in the same pull request. Refused when that record is not where the new one lands: the hub's `docs/architecture/` for a hub record, the spoke's `DECISIONS_INDEX` folder for a spoke's own | The argument; absent by default |
| `--globs` | Paths in the target repository this document binds, comma-separated glob patterns — `src/payments/**`. Empty means the document is selected only when a design names it. Refused for `estate-overview`. For `rule`, required and never empty unless `--always-on` is given, when it is refused: `check-spoke-rules` refuses an empty array, and a path-scoped rule may not carry a catch-all glob (`**`, `**/*`, `*`) | The argument; empty by default |
| `--always-on` | The document binds every design: every design in the estate for a hub document, every design landing in the repository for a spoke one. Rare, and said on purpose. Refused for `estate-overview`. For `rule`, the one always-on rule of the folder; it sets the globs to `["**/*"]`, and `--globs` is then not given | The argument; off by default |
| `--overrides <id,...>` | For `rule` only: the hub or global standards this rule replaces where it binds, comma-separated — a whole standard, `std-<topic>`, or one rule, `std-<topic>.<NN>`, with the `global.` prefix for a global standard (`.claude/rules/estate.md` §3). Each id must be in the hub's index (`read-context.mjs --hub`, with `--global` when the hub has a global layer), and a rule id one the standard defines; a decision record is refused. Written as the rule's `overrides` key | The argument; absent by default |
| `--remove <id>` | An id in scope: in the hub's folders, or in a listed spoke's contracts folder or decision-record folder (`<ID>.ADR-<NNN>`). With `--kind rule --repo <ID>`, a rule's name in that spoke's rules folder | The argument, second form |
| `--rename-standards` | Renames every standard the hub names by number, `STD-<NNN>`, to `std-<topic>`, in one pull request (Renaming a numbered standard). Takes no other argument | The argument, fourth form |
| `--intent` | For `rule` only: the rule as the person states it, in quotes — `"all variables must be camel cased"`. Exactly one of `--intent` and `<file>` | The argument |
| `--global` | With `--kind exception` only, and always with it: the document goes to the global context repository that `docs/estate/global.json` names | The argument, third form |
| `--departs` | For an exception only: one id or more, comma-separated, each a global record `global.ADR-<NNN>` or one rule of a global standard `global.std-<topic>.<NN>`, for example `--departs global.ADR-012`. A bare id without `global.` is refused | The argument |
| `--skip-hub <prefix>=<reason>` | For a hub record or a standard only, and only when a sibling hub cannot be read with the person's access: the hub's key prefix and the reason, for example `--skip-hub "SIM=the SIM hub is private to the simulator team"`. Repeat it for a second hub. The reason is the person's words, and the pull request carries it | The argument; absent by default |
| The list of repositories | `docs/estate/repositories.json` | `/add-repo` |

| Kind | Lands at | Rank in `CLAUDE.md` §4 | Header |
|---|---|---|---|
| `contract`, `vendor-doc` | the spoke, in the folder its `checks.env` names with `CONTRACTS_INDEX` | 2 | written by this command |
| `adr` | the hub, `docs/architecture/ADR-<NNN>-<slug>.md`. With `--repo <ID>`: that spoke's own record, `ADR-<NNN>-<slug>.md` in the folder its `checks.env` names with `DECISIONS_INDEX`, its id `<ID>.ADR-<NNN>` everywhere else | 3 once `Accepted`, in the order `CLAUDE.md` §4 sets: a global record, then a hub record, then a spoke's record | written by this command, with `status`; the body is a summary (step 2) |
| `standard` | the hub, `docs/standards/std-<topic>.md` | unranked: it says how, and §4 ranks what | written by this command; the body is a summary written from `docs/standards/_TEMPLATE.standard.md` (steps S1 to S8) |
| `estate-overview` | the hub, `docs/estate/overview.md` — one per estate, the id fixed to `estate-overview`. `/estate-overview-refresh` writes it from the hub's own files. This command places a page that a person wrote from `docs/estate/_TEMPLATE.overview.md` | unranked: it says what the estate is, and §4 ranks what decides | written by this command, with `globs: []` and `alwaysApply: false` fixed — `/feature` and `/decompose` read it by rule, and a design that wants it names its id |
| `rule` | the spoke, in the folder its `checks.env` names with `RULES_INDEX` | unranked: a spoke rule says how (`.claude/rules/estate.md` §1) | none beyond the rule pack's four keys; the body is written from `docs/estate/_TEMPLATE.rule.md` (step R3) |
| `exception` (with `--global`) | the global context repository, `docs/exceptions/EXC-<NNN>-<slug>.md`, its id `global.EXC-<NNN>` in every hub | 3, inside its scope, once the Board tags a release that carries it | written by this command from the global repository's `docs/exceptions/_TEMPLATE.exception.md`, from the interview (steps E1 to E8) |

## Preconditions

All eight, checked before anything is written. For `rule`, preconditions 1, 2 (when a `<file>` is given), 3 and 8 apply; 4 to 7 do not. For `standard`, 1 to 5 apply, and step S1 decides whether the file is a standard at all. For an exception, precondition 1 and the preconditions of its own section apply.

1. The working directory is the hub root, on a clean checkout of the trunk. This command cuts its
   own branch, in the hub or in a clone of the spoke.
2. `<file>` exists, is one file, and is readable in full. A directory is several documents and
   several runs. A file this command cannot read is a document it does not place, and it says so.
3. `--kind` is one of the six, or `exception` with `--global`. `--repo` is absent or `hub` for the three hub kinds, and a listed
   id for the three spoke kinds; a spoke kind with `--repo hub` or no `--repo`, or a hub kind with
   a repository id, is refused before anything is copied, because the folder is the kind's to decide.
   `adr` takes either: no `--repo`, or `hub`, for a decision that binds the estate; a listed id
   for a decision that binds only that repository's code. For
   `estate-overview`, `--name`, `--globs` and `--always-on` are refused too: the id, the globs
   and always-on are the kind's, and `check-context` refuses any other value.
4. `--owner`, `--revision` and `--origin` are given and none is a placeholder. `TBD`, a dash,
   `unknown`, `n/a` — the header refuses them, and so does this command, earlier. A document whose
   revision nobody knows is a document nobody can tell is stale.
5. The id — `--name`, or the file name kebab-cased — matches `^[a-z0-9][a-z0-9-]*$` (for `adr`,
   `^ADR-\d{3,}$`, numbered in the hub for a hub record and in the spoke for a spoke's own record,
   whose id in the index is then `<ID>.ADR-<NNN>`) and is not already in the index `scripts/read-context.mjs --hub` prints, nor in
   any spoke's. Designs name a document by id; two documents answering to one name is a design
   that cannot say which it read. Only a standard's id starts with `std-`. For `standard`, the id
   is `std-<topic>` (`^std-[a-z0-9]+(?:-[a-z0-9]+)*$`). Absent, it is proposed in step S6. Given,
   it names a standard in `docs/standards/` for a replacement, or a new name for a new standard.
   A name that a removed standard held is refused.
6. For a spoke context kind (`contract`, `vendor-doc`): the repository's `checks.env` on its
   trunk carries `CONTRACTS_INDEX` as a folder. `none` is a repository that said it keeps no contracts — stop and say so, because the
   right fix is a one-line change to `checks.env` in the spoke, made on purpose by its team, not
   a folder this command invents. `UNRESOLVED` or missing is `NOT CONFIGURED`: the same stop, with
   the same fix named. For `adr --repo <ID>`, the same check, and the same stop, on
   `DECISIONS_INDEX`.
7. For `adr`: `--name` is `ADR-<NNN>` and the file's record carries that number; `--status` is
   given and is one of the three; and the record states a decision. A record that has not been
   decided is refused, with the way: decide it where the records are kept first. `--supersedes`,
   when given, names a record in the same place: the hub's `docs/architecture/` for a hub record,
   the spoke's `DECISIONS_INDEX` folder for a spoke's own; one that is not there is refused. For a
   spoke's own record, read every `Accepted` hub record its globs or its text touch
   (`scripts/read-context.mjs <ID> --all`). A spoke record narrows the hub's records and never
   overrides one: where it contradicts an `Accepted` hub record, stop, name both records, and route
   the question to the lead architect. One of the two changes first. With a global layer, the
   record is read against it too (step 2a, G1).
8. For `rule`: exactly one of `--intent` and `<file>`; `--owner` given, a role, not a placeholder
   or a person's name; `--globs` given and not a catch-all, or `--always-on` given and `--globs`
   not (the globs are then `["**/*"]`); `--revision` and `--origin` absent; a `--name`, when
   given, matching `^[a-z0-9][a-z0-9-]*$`. The repository's `checks.env` on its
   trunk carries `RULES_INDEX` as a folder, read through `scripts/read-spoke.mjs`. `none` is a
   repository that said it keeps no written rules — stop and say so; the fix is a one-line change
   to `checks.env` in the spoke, made on purpose by its team. `UNRESOLVED` or missing is
   `NOT CONFIGURED`: the same stop, with the same fix named. `read-spoke-rules.mjs <ID> --all` exits 1 in two cases. When
   its `FAIL:` line says `<folder> is not a folder at this commit`, the folder is not yet on the
   trunk: go on, and the first rule must be `--always-on`, because a folder with no always-on rule
   is refused. Any other `FAIL:` finding means the existing set is malformed: stop, name the
   findings, and say the spoke fixes its folder first. This command never edits a rule it did not
   write.
   When `--always-on` is given and the folder already has an always-on rule under another name,
   stop and name it. A `--name` that names a rule already in the folder is a replacement, and
   the pull request says so; replacing the always-on rule keeps `--always-on`. Any other name is
   a new rule and must be free (step R2).
   For `rule --remove`: preconditions 1 and 3, and the `RULES_INDEX` part of 8, apply; the named
   rule exists in the folder. `--intent`, `<file>` and `--globs` are not asked of a removal.

## What it does — add or replace

```bash
# preconditions 1–7; for a spoke context kind, read checks.env from the spoke's trunk:
node scripts/read-spoke.mjs <ID> checks.env                       # CONTRACTS_INDEX=<folder>, or stop; its Trunk: line is <SPOKE-TRUNK>
# hub kind:
git checkout -b context/<name>
# copy <file> unchanged under the header; for adr, write the summary under the header (step 2)
# a hub record: check it against the global layer and the sibling hubs (step 2a), or stop
node scripts/check-context.mjs --offline                          # exit 0, or stop
git add docs/
node scripts/harness-commit.mjs -m "docs(context): add <name>"
# open the pull request in the hub, its description ending with the watermark line
# spoke context kind, and adr --repo <ID>:
node scripts/read-spoke.mjs <ID> checks.env                       # adr --repo: DECISIONS_INDEX=<folder>, or stop; its Trunk: line is <SPOKE-TRUNK>
git clone --quiet --depth 1 --branch <SPOKE-TRUNK> --no-tags <URL> <TMP>
git -C <TMP> checkout -b harness/context-<name>
# copy <file> unchanged under the header into <TMP>/<folder>/<name>.md
# adr --repo: write the summary under the header into <TMP>/<folder>/ADR-<NNN>-<slug>.md (step 2)
# adr --repo: check it against the global layer (step 2a, G1), or stop
node scripts/check-context.mjs --local <TMP>                      # exit 0, or stop
git -C <TMP> add <folder>/
HARNESS_SPOKE_TRUNK=<SPOKE-TRUNK> node scripts/harness-commit.mjs --repo <TMP> -m "docs(contracts): add <name>"   # a spoke's own record: "docs(decisions): add <ID>.ADR-<NNN>"
git -C <TMP> push origin harness/context-<name>
# open the pull request in the spoke with --base <SPOKE-TRUNK>, its description ending with the watermark line; delete <TMP>
```

Step by step, and what each step may and may not do.

1. **Derive the id and the destination.** `<name>` from `--name` or the file name; the folder
   from the kind; for a spoke context kind, the folder from the repository's own `checks.env` at
   its trunk,
   read through `scripts/read-spoke.mjs` so the fact arrives with its commit — `CONTRACTS_INDEX`
   for a contract kind, `DECISIONS_INDEX` for a spoke's own record. For `adr`, the file
   is `ADR-<NNN>-<slug>.md`, the slug from the decision in a few words, in the hub or the spoke.
   A spoke's record keeps `ADR-<NNN>` in its `name:` and its title: the repository is added to
   its id where it is read, so the file is the same whichever hub reads it.
2. **Write the header, then the file, unchanged** (a record: the header, then the summary, which carries only the header and the five sections; drop the template's comment block. A standard is the section below, S1 to S8, and never this step). The header is the rule pack's frontmatter plus
   four keys (five for `adr`, which adds `status`), in this order and no other:

       ---
       name: <name>
       description: <one sentence: what the document is and what system it describes>
       globs: <a one-line JSON array, [] when --globs is absent>
       alwaysApply: <true | false>
       kind: <kind>
       status: <status>      (adr only)
       owner: <role>
       revision: <text>
       origin: <text>
       ---

   The description is this command's one sentence of prose, written from the document's own
   title and first paragraph, at most 200 characters — `check-context` refuses more
   (`DESCRIPTION_MAX` in `context-docs.mjs`); it is what the index prints, so it says which
   system the document describes. Below the header, **the file's bytes, unchanged.** No
   reformatting, no trimmed preamble, no fixed typos: a design cites this copy by line, and a
   reviewer who opens the original must find the same text.

   **A record (`adr`) is the one exception.** Its body is a summary written from
   `docs/architecture/_TEMPLATE.adr.md`: Decision, Rules, Why, Rejected, Accepted costs, each
   short, `None.` where there is nothing. It carries only what changes how a design or code is
   written, taken from the record and nothing else; a rule the record does not state is not
   written. The record stays where the client keeps it, and the person who merges the pull
   request confirms the summary matches it. `--globs` matters most here: it is how a design that
   touches those paths finds the record without naming it. A spoke's own record is written from the
   same template, and its globs are paths in that spoke.
2a. **A record: check it against the other layers.** For `adr` without `--repo`, or with
   `--repo hub`, run G1 and G2 of What it does — check a hub document against the other layers,
   with the draft on the branch. For a spoke's own record, run G1 only, with the draft in the
   clone. G2 does not apply to it: every hub of the spoke reads the same copy, and a spoke record
   is where a decision about a shared spoke belongs. A stop there deletes the branch, or the
   clone, and the draft, and opens no pull request.
3. **Prove it parses.** Hub kind: `node scripts/check-context.mjs --offline` must exit 0, run on
   the branch with the document in place, so `check-context` is green on the pull request's head
   commit. Spoke context kind, and a spoke's own record: `node scripts/check-context.mjs --local <TMP>`, which checks the contracts folder and the record folder, must exit 0 for the
   folder as it will be pushed. A finding at either step is fixed in the header this command wrote,
   never in the copied text, and never by shortening the check.
4. **Open the pull request, and stop.** The pull request's description ends with the watermark, the line `Generated-by: SHL Agentic Harness`
   on its own after the normal description (`.claude/rules/watermark.md`). Hub kind: branch `context/<name>`, commit
   `docs(context): add <name>`, carrying the document and nothing else. Spoke context kind:
   branch `harness/context-<name>` in the spoke, commit `docs(contracts): add <name>`, carrying the one
   file, opened with `--base <SPOKE-TRUNK>`; the clone is deleted. A spoke's own record: the same
   branch, with `<name>` the record's number, and commit `docs(decisions): add <ID>.ADR-<NNN>`,
   carrying the record and, when it supersedes one, the old record's changed `status:` line, opened
   with `--base <SPOKE-TRUNK>` too. The description names the kind, the owner, the revision, the
   origin and — for a hub record — the release G1 read the global layer at, every global document
   and exception it cited, every sibling hub G2 read, and every `Skipped:` line with its reason.
   For a spoke's own record, it names the release G1 read and every global document and exception
   it cited.
   For a spoke context kind, it names the one step that follows the merge:
   `/add-repo <URL> --trunk <the entry's trunk>` in the hub, which moves `readAt` past it, so the new document is read at the commit that carries it.
   That step is not this command's: the estate reads a spoke at the commit the list records, and
   the list moves only by `/add-repo`.

**Replacing a document** is this command again with a new `--revision`, over the same id. The
copy is overwritten, the header rewritten, the rest as above. A revision that did not change is a
re-run and is refused by precondition 5 as an id already present; give the new revision or stop.
Every design whose `Context:` line pins the old bytes will show a **context drift** note in the
pickup gate from the merge on; list those designs (the in-flight check below) in the pull-request
body so the people who own them know before the gate tells them.

**Superseding a record** is this command for the new record, with `--status Accepted` and
`--supersedes ADR-<old>`. In the same pull request it changes the old copy's one `status:` line
to `Superseded by ADR-<new>`, and nothing else in it. It refuses when the old record is not in
the same place as the new one: a hub record supersedes a hub record, and a spoke's own record
supersedes one of the same spoke's.

## What it does — a standard

```bash
# preconditions 1–5:
node scripts/read-context.mjs --hub --all                  # every standard and record on the hub, with its text
git log --name-only --format= origin/<HUB-TRUNK> -- docs/standards/   # every name the folder has held
# with a global layer: read it at the newest release (G1), for S4
# classify (S1), extract (S2), verify (S3), reconcile (S4), ask (S5); draft from the template (S6)
git checkout -b context/<name>
# check the draft against the sibling hubs (G2, step S6a), or stop
node scripts/check-context.mjs --offline                   # exit 0, or stop (S7)
git add docs/standards/
node scripts/harness-commit.mjs -m "docs(context): add <name>"
# open the pull request in the hub, its description the ingest report (S8), ending with the watermark line
```

A standard binds every agent that reads it, so what it says must be what the estate agreed, said
once, in one shape. The original is evidence; the summary is what an agent reads.

S1. **Classify.** A standard says how work is done across the estate, in statements a critic can
    check against a design or a diff. A standard for a language, a technology or a kind of change
    no repository in the estate uses yet is a standard all the same: its globs keep it out of every
    design until a path matches, and `--status Reserved` holds it back even then. Whether anything
    uses it today is never a reason to refuse it. Read the whole file and decide what it is, before
    anything is written:

    | The file is | Then |
    |---|---|
    | A standard | Go on to S2 |
    | A description of the product or a system, a high-level design, a glossary | Refuse, and name the home: the estate overview (`--kind estate-overview`) for what the estate is and the words it uses; a decision record, decided where the client keeps its records, for a choice |
    | Facts about one repository or service — its endpoints, tables, folder layout, build plan, the list of repositories | Refuse, and name the home: that spoke's contracts (`--kind contract`), a spoke rule (`--kind rule`), its survey, or `docs/estate/repositories.json` |
    | A list of files, an index, or instructions to another tool | Refuse |
    | A standard and something else | Refuse, name the parts and their lines, and say the standard part is run again on its own file |
    | Two standards, on two topics | Refuse, and name the topics: one standard per run |

    The refusal is the whole output: no branch, no file, no pull request.

S2. **Extract.** List every normative statement in the file, one line each with its line number,
    and tag it: `estate` (binds every repository it names, by language, path or kind of change —
    including those the estate does not hold yet),
    `spoke:<id>` (binds one repository or service), `product` (says what the product does, not how
    work is done) or `harness` (binds the harness itself, not a design or code). Only `estate`
    lines go on. The rest are listed in the pull request with where they belong; this command
    moves none of them. Narrative, history, comparison tables, worked examples, empty sections,
    repeated provenance and a second header block are not statements, and are left behind.

S3. **Verify the file against itself.** Each check's result goes in the ingest report:
    - every count the file states, recounted;
    - every link: a link to a file the hub does not hold is dropped, never copied;
    - every claim the header would make — owner, revision, what the document covers — supported by
      the body; `--owner` is not supported when the body names another owner or none;
    - two statements in the file that disagree;
    - every value the file leaves open (`[to confirm]`, `TBD`, "being scoped", a proposal);
    - a source that calls itself a draft: whether it binds now is the person's to say (S5);
    - every claim tied to a version — a language, framework, tool or specification — that the file
      states as current: flagged for the person, never corrected by this command;
    - personal names, e-mail addresses and handles: removed; the role stays where the file gives one.

S4. **Reconcile against the estate.** Open, from the index, every standard whose globs overlap
    the new one's or that is always on, every `Accepted` record whose globs overlap, and — for a
    replacement — the standard it replaces. Sort each rule:
    - **duplicate** — another document already states it: left out, and cited under Relations;
    - **refinement** — narrows a rule another document states: kept, and the relation written;
    - **conflict with a record** — an `Accepted` record ranks (`CLAUDE.md` §4, rank 3) and a
      standard is unranked: the rule is left out, the record cited under Relations, and the report
      says so; nothing is asked;
    - **conflict with a standard** — the same rank: §4's tie-breaker holds, and this command never
      picks a winner. It is a question (S5).
    - **conflict with a global document** — a binding global record or standard, read in G1 at the
      newest release. `CLAUDE.md` §4, rank 3, orders the two. G1 decides: stop, unless an
      exception covers it. A rule that repeats a global rule is a duplicate, and a rule that
      narrows one is a refinement, as above.

    And its **reach**: whether the globs match a path in any listed repository, from each one's
    survey and tree (`scripts/read-spoke.mjs <ID> .`); S7 prints the exact answer. A standard that
    reaches none is kept. When `--status` was not given, whether it binds the first design that
    touches a matching path (`Active`) or waits to be adopted (`Reserved`) is a question (S5).

S5. **Ask, in one message.** Ask the person every question whose answer changes a sentence of the
    summary: every conflict from S3 and S4, every open value, every draft source, every flagged
    version claim, every header value the body does not support, and — for a standard that reaches
    no repository and was given no `--status` — whether it is `Active` or `Reserved`. Each question quotes both sides
    with their file and line, and offers the choices. Ask again only about what an answer opened.
    Stop asking when every section of the template can be written from the file and the answers.
    An answer the person does not give is written as an `UNRESOLVED` line under Unresolved, and the
    rule it would have settled is not written: never guessed. An answer that changes another
    standard — "cs-01 should stop setting indentation" — is that standard's own run, named in the
    report, never an edit in this pull request.

S6. **Draft it from the template.** The name is `std-` and the topic in a few words, in kebab
    case: `std-api-naming`. Show the proposed name to the person before you write the draft. The
    name is never one the trunk's `docs/standards/` has held (the `git log` above), and never an
    id another document in the index carries. For a replacement, the name is the one `--name`
    gives. The name never changes after the merge, so a new title keeps the old name. The file is
    `docs/standards/<name>.md`. Read
    `docs/standards/_TEMPLATE.standard.md`, write the header — `name: <name>`, `status:` from
    `--status` (`Active` when absent) — then every
    section in the template's order, with its comment dropped:
    - **Applies to** — the code it binds, in words, and what inside that it does not cover; the
      globs say the same as patterns.
    - **Must** and **Should** — each kept `estate` rule, one per bullet,
      `- **<name>.<NN>** MUST …`, numbered from `.01` in the order the file gives them, with
      its source location. A replacement keeps the id of a rule that did not change.
    - **Values** — every number a rule uses, one row each, with its source.
    - **Checked by** — per rule, `script` when a command a spoke's `checks.env` names checks it,
      `CI job` when a named job does, `review` otherwise, with what the reviewer looks for.
    - **Relations** — duplicates and refinements from S4, records that ranked, and every conflict
      settled in S5: the answer, the role that gave it, the date.
    - **Exceptions** — who grants one and where it is recorded, from the file or the answers, or
      an `UNRESOLVED` line.
    - **Unresolved** — every open value and unanswered question, in the pinned grammar.
    - **Origin** — the original's title, its own id where it is kept, its revision, and one line
      saying what the summary leaves out and where each part went.
    Only what the file states and the person answered is written. The file stays within 200
    lines; a summary that cannot is two standards: stop, and name them.

S6a. **Check the draft against the sibling hubs.** Run G2 of What it does — check a hub document
    against the other layers, with the draft on the branch. A stop there deletes the branch and the
    draft, and opens no pull request.

S7. **Prove it parses.** `node scripts/check-context.mjs --offline` must exit 0, on the branch with
    the standard in place. Then, for the report, `node scripts/check-context.mjs` without
    `--offline`: its `standards reach` section says which listed repositories the standard's globs
    reach at the commit the list records, or that it reaches none — a note, never a finding. It checks the number in the name, the file name and the title, the nine
    sections in order, every rule's id and keyword, the `UNRESOLVED` grammar, no open value outside
    Unresolved, and the 200-line cap. A finding is fixed in the draft and the check re-run, never by
    shortening the check.

S8. **Open the pull request, and stop.** Branch `context/<name>`, commit
    `docs(context): add <name>` (`replace <name>` for a replacement), carrying the one file.
    The description is the ingest report, in this order: the original's title, revision and origin;
    the status, and the reach `check-context` printed (the repositories it binds today, or "binds
    no repository today: it waits for the first design that touches a matching path"); the
    counts — rules kept, left out as duplicates, left out for a record, routed elsewhere; every
    line left behind as `spoke`, `product` or `harness`, with its home; every error found in S3 and
    what was done with it; every question asked and its answer, word for word; every `UNRESOLVED`
    line; for a replacement, the old Must and Should beside the new, and the designs on the hub
    trunk whose `Context:` line pins the old bytes; the release G1 read, the global documents and
    exceptions it cited, the sibling hubs G2 read, and every `Skipped:` line with its reason; then
    the sentence `This standard was
    summarised by the harness from the original above. It binds every agent from the next design
    after the merge; read it against the original.`; and the watermark line
    `Generated-by: SHL Agentic Harness` on its own at the end.

**Adopting a reserved standard** changes its one `status:` line to `Active`, and nothing else, on
branch `context/<name>-adopt`, commit `docs(context): adopt <name>`. Adoption is when the
standard starts to bind, so S4 runs again against the standards and records now on the trunk, G1
and G2 run again, and every conflict it finds is asked (S5) before the pull request opens; an answer that changes a rule
is a replacement, below, never an edit here. The description carries the reach `check-context`
prints and the answers. Holding an active standard back is the same change the other way, to
`Reserved`, with the designs whose `Context:` line cites it listed.

**Replacing a standard** is this command again with `--name <name>` and the new revision of the
original. S1 to S8 run in full: the old summary is evidence of what was agreed, never a source of
rules the new original does not state.

**A hub upgraded from a library that copied standards** fails `check-context` on every standard
in the old shape — a file in `docs/standards/` not named `std-<topic>.md`, or a body that is not
the template's — until each is ingested again from its original with this command and the old
copy removed in the same pull request. The old copy's path leaves the trunk with it, and the pickup
gate refuses a design whose `Context:` line cites a path the trunk does not hold: the pull request
lists every design on the trunk whose `Context:` line names the old id
(`git grep -lE "^Context: (.*, )?<old-id>@" origin/<HUB-TRUNK> -- docs/designs/`), and a design not
yet built is amended to the line `read-context.mjs` prints once the new standard is merged. A file
named `STD-<NNN>-<slug>.md` is not in the old shape. It is a standard named by number, and the
next paragraph renames it.

**Renaming a numbered standard.** A library before standards were named `std-<topic>` gave each
one a number, `STD-<NNN>`. `check-context` refuses each such file until it is renamed.
`/add-context --rename-standards` renames every numbered standard in the hub in one pull request.
Precondition 1 applies. The content does not change, so S1 to S5 do not run:

1. For each `docs/standards/STD-<NNN>-<slug>.md`, propose `std-<slug>` and show the list to the
   person. The person may change a name. Every name follows S6.
2. Rename each file with `git mv` to `docs/standards/<name>.md`.
3. In each file, change the `name:` line, the title and every rule id from `STD-<NNN>` to the new
   name. Change no other byte of the body.
4. In every standard, change each citation of an old `STD-<NNN>` id to the new name.
5. Run `node scripts/check-context.mjs --offline`. It must exit 0.
6. Commit with `node scripts/harness-commit.mjs -m "docs(context): name standards by topic"` on
   branch `context/std-names`.
7. Open the pull request. Its description lists each old id beside its new name. It also lists
   every design on the trunk whose `Context:` line names an old id
   (`git grep -lE "^Context: (.*, )?STD-[0-9]{3,}@" origin/<HUB-TRUNK> -- docs/designs/`). The
   pickup gate refuses such a design until its `Context:` line is the line `read-context.mjs`
   prints after the merge. The description ends with the watermark line
   `Generated-by: SHL Agentic Harness`.

## What it does — check a hub document against the other layers

A hub record (`adr` without `--repo`, or with `--repo hub`) runs these two checks after the draft
is on the branch, and before `check-context.mjs --offline` (step 2a). A spoke's own record runs
G1 only, after the draft is in the clone, and before `check-context.mjs --local` (step 2a). A
standard runs G1 for its reconcile step, S4, and G2 after the draft is on the branch (step S6a).
A replacement and the adoption of a reserved standard run them again. The order of the layers,
and the rule for two hubs, are `CLAUDE.md` §4, rank 3. These checks apply it and do not restate
it.

```bash
# G1, only when docs/estate/global.json exists:
node scripts/read-global.mjs --resolve                                   # Global: vX.Y.Z <40-hex>
node scripts/read-context.mjs --hub --global <commit>                     # the index, global documents first
node scripts/read-context.mjs --hub --global <commit> --names <global.id,...>   # the global documents that bear on the draft
node scripts/read-hubs.mjs --repos <ID>                                   # a spoke's own record under an exception: the spoke's hubs (G1 step 5)
# G2, only when the draft has globs or is always on:
node scripts/read-hubs.mjs --siblings <draft> [--skip-hub "<prefix>=<reason>"]...
```

G1. **Against the global layer.** A hub without `docs/estate/global.json` has no global layer.
    Skip G1, and write nothing about it. Otherwise:
    1. Run `read-global.mjs --resolve`. Exit 2 is a stop: the command cannot prove that the draft
       agrees with the global layer. Exit 1 with `has no release tag` means that no global
       document binds yet: go on, and say so in the pull-request description. Any other
       exit 1 is a malformed `docs/estate/global.json`: stop, and name its findings.
    2. Read the index at the release commit, the last line's 40-hex. Then open with `--names`
       every binding global record and standard whose globs overlap the draft's globs, or whose
       description concerns the draft's subject. The always-on global documents print with every
       selection. Open every `Active` exception in the index that names this hub too, and, for a
       spoke's own record, every one whose `repositories` names that spoke.
    3. Compare the draft with each global document by the contradiction test in
       `.claude/skills/review-artefact/SKILL.md` § `global-review`. `/check-global` judges a hub
       record by the same test, so the two never disagree about one pair. A narrowing passes. A
       duplicate is left out of a record, and a standard cites the global document under
       Relations (S4).
    4. On a contradiction, stop. Name both documents, the draft by its id and the global document
       by its `global.` id, and quote the rule of each. Point the team to an exception:
       `/add-context --global --kind exception --departs global.<id> --owner <role>`. Delete any
       branch, clone and draft this run made, and open no pull request.
    5. Step 4 does not apply when an exception at that release covers the contradiction, by step
       4 of the test. For a spoke's own record, run `read-hubs.mjs --repos <ID>` first: the
       exception covers the record only when its `hubs` names every hub that the last line,
       `hubs: [...]`, prints. Exit 1 or 2 of that script is a stop, and the command names each
       finding. When an exception covers it, the draft is what the product does instead. Go on,
       and cite the exception and the global document in the pull-request description. A standard
       cites both under Relations too.

G2. **Against the sibling hubs.** A draft with no globs that is not always on covers no spoke.
    Skip G2, and write nothing about it. Otherwise run `read-hubs.mjs --siblings <draft>`, with
    each `--skip-hub` the person passed to this command, unchanged. The script reads every listed
    spoke at its trunk head, keeps the spokes whose paths the draft's globs cover, and reads every
    other hub that their `HUBS` lines name, at its trunk, with the person's access.
    1. Exit 0 and `Siblings: none`: no other hub owns a covered spoke. Go on.
    2. Exit 0 and one sibling block or more: compare the draft with every document the script
       printed in full. The index lines below a block are documents whose globs cover none of the
       draft's paths: read their descriptions, and name any that bears on the draft in the
       pull-request description.
    3. On a contradiction, stop. Name both documents: the draft by its id, and the sibling's
       document by its hub prefix, its id and its `Cite:` line. Name the shared spokes. Write the
       conflict for the person as a blocking clarification to the Board, with the three outcomes
       the Board chooses from: a spoke record that both hubs follow, a global record that both
       hubs follow, or an exception. Point the team to a spoke record instead of a hub record:
       `/add-context <file> --kind adr --repo <shared spoke>`. A decision about a shared spoke's
       code lives in the spoke or in the global repository, never in one hub. Delete any branch
       and draft this run made, and open no pull request.
    4. Exit 2: a spoke or a sibling hub cannot be read. Stop, and name it as the script names it.
       A sibling hub that the person's access cannot read may be skipped. The person runs this
       command again with `--skip-hub "<prefix>=<reason>"`, in the person's own words. Never write
       the reason for the person. A spoke that cannot be read cannot be skipped.
    5. Every `Skipped:` line the script printed goes into the pull-request description, with its
       reason, so the reviewer sees the check that did not run.

Hub CI never runs G2, and no gate reads a sibling hub. Hubs would then block each other's merges.

## What it does — an exception

An exception lets named hubs depart from named global records, or global standard rules, in named
repositories, within a written scope, until a review date. It lives in the global context
repository, and only the Board merges it. This command writes the request from the hub and opens
the pull request there. A product never grants an exception to itself.

```text
/add-context --global --kind exception --departs global.ADR-012 --owner "desktop simulator tech lead"
```

```bash
node scripts/read-global.mjs --resolve                       # the URL, the trunk and the newest release
git clone --quiet --no-tags --branch <GLOBAL-TRUNK> <GLOBAL-URL> <TMP>   # the whole trunk history: the check walks it
# read each departed document at the trunk (E1); interview the person (E2)
node scripts/read-hubs.mjs --repos <id,id,...>               # hubs: [...], or stop (E3)
git -C <TMP> log --name-only --format= HEAD -- docs/exceptions/          # every number the trunk held (E4)
git ls-remote --heads <GLOBAL-URL> 'refs/heads/context/EXC-*'            # every number an open request holds (E4)
git -C <TMP> checkout -b context/EXC-<NNN>
# write <TMP>/docs/exceptions/EXC-<NNN>-<slug>.md from the template there (E5, E6)
git -C <TMP> add docs/exceptions/
node scripts/harness-commit.mjs --repo <TMP> -m "docs(exceptions): request EXC-<NNN> for <prefix>"
(cd <TMP> && node scripts/check-context.mjs --global)        # exit 0, or fix, commit again and run it again (E7)
git -C <TMP> push origin context/EXC-<NNN>
# open the pull request in the global repository, its description ending with the watermark line; delete <TMP> (E8)
```

**Preconditions.** Check all five before the command writes anything.

1. Precondition 1 of this command: the hub root, on a clean checkout of the trunk.
2. `docs/estate/global.json` exists and is well formed. A hub without it has no global layer, so
   no global record binds it, and it needs no exception.
3. `--global` comes with `--kind exception`, and `--kind exception` comes with `--global`. The
   command refuses `<file>`, `--repo`, `--name`, `--revision`, `--origin`, `--status`,
   `--supersedes`, `--globs`, `--always-on`, `--remove` and `--skip-hub` here. The template fixes
   the revision (`v1`), the origin (`this repository`) and the status (`Active`). E4 gives the
   number. An exception has no globs: a design names it.
4. `--departs` names one id or more, comma-separated. Each is a global record, `global.ADR-<NNN>`,
   or one rule of a global standard, `global.std-<topic>.<NN>`. A bare id is refused, because a
   hub names every global id with its prefix.
5. `--owner` is a role, never a person, and not a placeholder.

E1. **Read what the exception departs from.** Run `read-global.mjs --resolve`. Exit 2 is a stop.
    Exit 1 with `has no release tag` is not a stop: the exception is written against the trunk.
    Take the URL from its `Global repository:` line and the trunk from its `Trunk:` line. Clone
    the trunk with its whole history, because `check-context.mjs --global` walks it. Then, at the
    clone's `HEAD`, the trunk:
    - each departed record, `ADR-<NNN>` without `global.`, is a file in `docs/architecture/` with
      `status: Accepted`
    - each departed standard rule, `std-<topic>.<NN>`, is a rule under that id in
      `docs/standards/std-<topic>.md`, and the standard has `status: Active`

    A departed id that the trunk does not carry is refused, and so is one that binds nothing: a
    record that is not `Accepted`, or a standard that is not `Active`, needs no exception. Read the
    rule of each, to quote it in the interview. Then look at the newest release, when there is
    one: `git -C <TMP> show <release commit>:<path>`. A departed document that the release does
    not carry, or does not carry as binding, binds no product yet. The pull-request description
    says so, and the Board releases the exception with it or after it.

E2. **Interview the person, one question per turn.** Ask in this order, and quote the departed
    rules in the first question:
    1. **Reason**: why the product cannot follow each departed rule. The fact that prevents it,
       with its source.
    2. **Scope**: which kind of change the exception covers in the listed repositories, and what it
       does not cover.
    3. **Repositories**: one id or more from `docs/estate/repositories.json`. A repository this hub
       does not list is refused, because this hub cannot name its hubs.
    4. **Alternatives considered**: each option the team tried or rejected, and why, with a number
       where one exists.
    5. **What the product does instead**: the hub record that states the product's own decision,
       by its id, `ADR-<NNN>`. A listed spoke's own record, `<repository-id>.ADR-<NNN>`, is
       accepted too. A record that is not on the trunk yet is accepted: it is added after the
       Board releases the exception, and G1 of that later run finds the exception. The text says
       so.
    6. **Exit**: the condition that ends the exception.
    7. **Review date**: `YYYY-MM-DD`, later than today's UTC date. Past it, a hub's gate reports the
       exception as stale and still passes.

    Ask again only when an answer is empty, a placeholder, an `UNRESOLVED` line, or not in the
    form the question asks. An exception carries no `UNRESOLVED` line. When the person does not
    give an answer, stop: delete the clone, and open no pull request.

E3. **Find the hubs.** Run `read-hubs.mjs --repos <the repositories from E2>`. It reads the `HUBS`
    line of each repository's `checks.env` on its trunk. An exception that covers a shared spoke
    must name every hub that owns it, so its last line, `hubs: [...]`, is the header value. Exit 1
    or 2 is a stop: name each finding as the script prints it.

E4. **Number it.** `EXC-<NNN>` is one more than the highest of two numbers, with at least three
    digits:
    - the highest number that any path under `docs/exceptions/` in the trunk's history ever
      carried
    - the highest number that a branch `context/EXC-<NNN>` on the global repository names now.
      Each such branch is a request that another hub may have open
    The first exception is `EXC-001`. A number the history held is never used again, even after
    its file left the trunk. A number that only a deleted branch held is free again. Two requests
    that start in the same minute can still take one number. `global-gate` then refuses the
    second after the first merges, and the team renumbers it.

E5. **Write it from the template.** Read `docs/exceptions/_TEMPLATE.exception.md` in the clone.
    Write `docs/exceptions/EXC-<NNN>-<slug>.md`, with the slug from the departure in a few words.
    The header, in the template's order:
    - `name: EXC-<NNN>`
    - `description:` one sentence, at most 200 characters: which product departs from which
      record, and why
    - `kind: exception`
    - `hubs:` the line from E3
    - `repositories:` the ids from E2, as a one-line JSON array
    - `departs:` the ids from `--departs` without `global.`, as a one-line JSON array
    - `status: Active`, `review-by:` the date from E2, `owner:` from `--owner`,
      `approver: Global Architecture Board`, `revision: v1`, `origin: this repository`

    Then the title, `# EXC-<NNN> — <the departure, in a few words>`, and the five sections in the
    template's order, from the answers and nothing else. Drop the template's comment. A file in the
    global repository carries every global id without `global.`. Name a hub record with its hub's
    prefix, for example `SCR hub record ADR-031`.

E6. **Refuse an empty exception.** Do not commit while Reason, Scope or Alternatives considered is
    empty, a placeholder, or carries an `UNRESOLVED` line. `check-context.mjs --global` refuses the
    same, and the Board cannot approve an exception without them.

E7. **Commit, then prove it.** Commit in the clone with `harness-commit.mjs --repo <TMP>`, so the
    commit ends with the watermark line. Then run the clone's own `scripts/check-context.mjs
    --global` at the clone's root: it is the copy `global-gate` runs. It reads the commit `HEAD`
    names, never the working tree, so an uncommitted change is exit 2. Exit 0 lets the command go
    on. On exit 1, fix the finding in the exception. Then run `git -C <TMP> reset --soft HEAD~1`,
    stage the exception, commit again with `harness-commit.mjs --repo <TMP>`, and run the check
    again. The branch is not pushed yet, so this changes no shared history. A finding in a document this command did not write is a stop: the
    Board fixes its trunk first. A clone with no `scripts/check-context.mjs` is a stop: the global
    repository is not installed (`/shl-onboard --global`).

E8. **Open the pull request, and stop.** Push `context/EXC-<NNN>` to the global repository, and
    open the pull request there. The description carries, in this order:
    1. the hub that requests the exception, by its prefix, and the owner
    2. each departed id with its rule quoted, and whether the newest release carries it as binding
    3. each `Repository:` line `read-hubs.mjs` printed, so the Board sees where each hub came from
    4. the review date, and the newest release read in E1
    5. the sentence `This exception was requested from a product hub by /add-context. Only the Global Architecture Board approves it. A merge is a draft: the exception binds from the first release tag on a commit that carries it.`
    6. the watermark line `Generated-by: SHL Agentic Harness`, alone, at the end

    Delete the clone. Report the number, the pull request and the hubs.

**After the Board approves it.** The Board merges and tags a release. A feature that needs the
exception moves the `Global:` line of its requirements to that release, through an amendment
(`/feature`).
Its design then cites `global.EXC-<NNN>` and every id the exception departs from on its `Context:`
line. The hub record that states what the product does instead is placed with this command, and
G1 accepts it because the exception covers it.

## What it does — a rule

```bash
# preconditions 1–3 and 8:
node scripts/read-spoke.mjs <ID> checks.env                # RULES_INDEX=<folder>, or stop; its Trunk: line is <SPOKE-TRUNK>
node scripts/read-spoke-rules.mjs <ID> --all               # every rule on the trunk now, with its name; Status:
# settle the intent with the person (R1); propose the name (R2); draft from the template (R3)
git clone --quiet --depth 1 --branch <SPOKE-TRUNK> --no-tags <URL> <TMP>
git -C <TMP> checkout -b harness/rule-<name>
# write <TMP>/<folder>/<name>.md
node scripts/check-spoke-rules.mjs --local <TMP>           # exit 0, or stop
git -C <TMP> add <folder>/
HARNESS_SPOKE_TRUNK=<SPOKE-TRUNK> node scripts/harness-commit.mjs --repo <TMP> -m "docs(rules): add <name>"
git -C <TMP> push origin harness/rule-<name>
# open the pull request in the spoke with --base <SPOKE-TRUNK>, its description ending with the watermark line; delete <TMP>
```

R1. **Settle the intent.** Read the intent (`--intent`, or the whole `<file>`), every rule the
    spoke already has and its name (from `read-spoke-rules.mjs <ID> --all`; without `--all` it
    prints only the always-on rule), and enough of the spoke to know its language
    and layout (`read-spoke.mjs <ID> .`, then the files that answer the question). Then ask the
    person, in one message, every question whose answer changes a sentence of the rule: a word
    with two readings, a conflict with the language's own convention, an overlap with a rule
    already in the folder, paths the globs catch that the intent may not mean. Example: for
    "all variables must be camel cased" in a Go repository, ask whether exported names
    (`MixedCaps`, starting with a capital) are meant too. Ask again only about what an answer
    opened. Stop asking when every section of the template can be written from the intent and the
    answers. An answer the person does not give is written as an `UNRESOLVED` line, never guessed.
    A `<file>` that holds more than one contract is refused, with the contracts it holds named:
    one rule per run. Where the intent departs from a hub or global standard that binds the same
    paths — read the index with `read-context.mjs --hub` and open the standards whose globs
    overlap — say so, quote the standard rule, and ask whether the rule overrides it. An answer
    of yes is `--overrides` with that id; an answer of no narrows the draft to fit the standard.
    Never draft a rule that contradicts a standard without the key: the stricter reading would
    bind and the rule would be dead text.

R2. **Name it.** Propose `<name>` from the intent: kebab case, lowercase letters, digits and
    hyphens, a few words (`camel-case-variables`). `--name` overrides it. Refuse a `--name` or
    proposed name that does not match `^[a-z0-9][a-z0-9-]*$`. A `--name` that names a rule in the
    folder is a replacement (see below), and the line shown before the draft says it replaces
    `<name>`. A proposed name the folder already carries is refused;
    the way is a different name, or `--name` to replace that rule.

R3. **Draft it from the template.** Read `docs/estate/_TEMPLATE.rule.md`. Write the four keys —
    `name`, a one-sentence `description`, `globs` as a one-line JSON array from `--globs` (or `["**/*"]` with `--always-on`),
    `alwaysApply` from `--always-on` — and, with `--overrides`, the `overrides` key as a one-line
    JSON array of the ids given, after proving each one against the index and the standard's
    rule ids; then every section, in the template's order, with the
    template's comment dropped:
    - **Must** — the rule as checkable statements, one per bullet, from the intent and the answers
      and nothing else.
    - **Scope** — the globs in words, and any path inside them the rule does not cover.
    - **Checked by** — `script` when a command in the spoke's `checks.env` already checks it
      (name the key and the command), `CI job` when a named job does, `review` otherwise, with
      what the reviewer looks for.
    - **Exceptions** — `--owner` grants one; where it is recorded, from the answers, or an
      `UNRESOLVED` line. With `--overrides`, one sentence here names each standard rule the rule
      replaces and why, from the answers, so a reader of the rule sees the departure.
    - **Examples** — one right and one wrong, in the spoke's language, or `None.`
    - **Origin** — the intent quoted word for word (for a `<file>`, its title and first line),
      the date, and `Owner: <--owner>`.
    The file stays within 80 lines. A draft that cannot is two contracts: stop, and name them.

R4. **Prove the folder.** `node scripts/check-spoke-rules.mjs --local <TMP>` must exit 0 for the
    folder as it will be pushed. A finding is fixed in the draft and the check re-run; never by
    shortening the check.

R5. **Open the pull request, and stop.** Branch `harness/rule-<name>` in the spoke, opened with
    `--base <SPOKE-TRUNK>`, commit
    `docs(rules): add <name>` (`replace <name>` for a replacement), carrying the one file. The
    description carries, in this order: the
    intent quoted word for word; every question asked and its answer; the sentence
    `This rule was drafted by the harness from the intent above. It binds every agent from the
    next design after the merge; read it as new text.`; the designs on the hub trunk whose
    `Rules:` line cites this repository, from
    `git grep -lE "^Rules: <ID>@" origin/<HUB-TRUNK> -- docs/designs/`, which will show
    `rules drift` in `/dev-sprint` from the merge on; and the watermark line
    `Generated-by: SHL Agentic Harness` on its own at the end. The clone is deleted.

**Replacing a rule** is this command again with `--name <existing name>`, a name already in the
folder, and a new intent. The free-name check does not apply. The file is overwritten from the
template, the branch is `harness/rule-<name>`, the commit `docs(rules): replace <name>`, and the
description says it is a replacement and quotes the old Must section beside the new one. Replacing
the folder's always-on rule keeps `--always-on`.

**Removing a rule** is `/add-context --remove <name> --kind rule --repo <ID>`. It deletes the
file on `harness/rule-remove-<name>` in one commit, `docs(rules): remove <name>`, proves the folder with `check-spoke-rules.mjs --local` and
opens the pull request. It needs preconditions 1 and 3, the `RULES_INDEX` part of 8, and a rule
of that name in the folder. It refuses to remove the folder's always-on rule: the folder would be
refused. A design never stops a removal, because it cites the folder at a commit, not the file;
the description lists the designs as R5 does.

## What it does — remove

This section is for the context kinds. A rule removal is described above.

```bash
git grep -lE "^Context: (.*, )?<id>(@|,|$)" origin/<HUB-TRUNK> -- docs/designs/   # in-flight check
# hub kind: delete the file; node scripts/check-context.mjs --offline; commit on context/remove-<id>
# spoke kind: clone, delete the file, check-context --local, commit on harness/context-remove-<id>, push
```

Removal deletes the copy. It never touches a design that cited the document: designs are the
record of what was built against. **A document a design on the hub trunk still carries on its
`Context:` line is not removed**, and the refusal names the keys; retire the design first, or
replace the document instead. The one exception is a standard in the old shape, removed by the
run that ingests it again (step S8): `check-context` refuses it, so it cannot stay on the trunk,
and the pull request names the designs that cite it.

### Other escalations

These stops raise an escalation as a cap does, and then stop. Each is one call of
`node scripts/escalation.mjs raise --point <ID> --slug <SLUG> [--work-item <KEY>] --runner <forge login> --question "<the one question>" --by-seat add-context`
with the options in the last column. Print what the script prints first in the closing report. Exit
2 means the line did not reach the record: say so first, and carry the question in the report.
The sweep tells the people named in `governance/escalation-points.json` and asks again after the
wait of the path. A question in the session (add-context.source-file, add-context.standard-contradiction, add-context.standard-name, add-context.skip-reason, add-context.exception-interview, add-repo.remove-refused) writes nothing. A pull request that waits for its merge (add-context.merge, add-context.rule-override, add-context.exception-approval, survey-repo.merge) is not raised here. The sweep raises a hub pull request (add-context.merge, survey-repo.merge) that is still open at the end of its working day.

| Point | When | Path | Options |
|---|---|---|---|
| add-context.hub-vs-spoke | a hub record contradicts a spoke record | decision owed | none |
| add-context.hub-vs-hub | two hubs contradict each other over a shared spoke | decision owed | none |

## Gates it enforces

| Gate | Behaviour on failure |
|---|---|
| One readable file | Refuse before anything is copied |
| Kind and repository agree | Refuse. A hub kind names no repository id (`--repo` absent or `hub`); a spoke kind names a listed one |
| For `estate-overview`: no `--name`, `--globs` or `--always-on`, and the file lands at `docs/estate/overview.md` | Refuse before anything is copied. One overview, one path, one id |
| For the context kinds: owner, revision and origin given and not placeholders | Refuse before anything is copied. The header would refuse them anyway; this is the same refusal, earlier and with the fix named |
| The description is at most 200 characters | Refuse before anything is copied, and show the sentence with its length. `check-context` enforces the same cap, so a longer one would fail the pull request anyway |
| For the context kinds: id grammar (for `adr`, `ADR-<NNN>`), and unique across the estate | Refuse and name the existing document |
| For a spoke context kind (`contract`, `vendor-doc`): `CONTRACTS_INDEX` is a folder on the repository's trunk; for `adr --repo <ID>`, `DECISIONS_INDEX` is | Refuse. Name the key's value and the one-line change to `checks.env` that fixes it |
| For `adr --repo <ID>`: the record contradicts no `Accepted` hub record | Stop. Name both records and route the question to the lead architect |
| For `adr`: the name is `ADR-<NNN>`, the status is one of the three, and `--supersedes` names a record in the same place | Refuse before anything is written. `--supersedes` is also refused for any kind but `adr`, and with any `--status` but `Accepted`. `--status` is refused for any kind but `adr` and `standard` |
| For the context kinds: the copied text is byte-identical to `<file>` | Refuse to commit. The header is this command's; the text is not. A record (`adr`) and a standard are summaries and a rule is drafted, not copied: all three are exempt |
| For `standard`: the file is a standard, on one topic (S1) | Refuse before anything is written, and name the home of what it is instead |
| For `standard`: only `estate` rules are written; every other line is listed with its home (S2) | Refuse to commit a summary that carries a `spoke`, `product` or `harness` line |
| For `standard`: every conflict with another standard, open value, draft source and unsupported header value is asked (S5) | Refuse to write a rule the file and the answers do not settle; it is an `UNRESOLVED` line |
| For `standard`: `--status` is `Active` or `Reserved`; nothing is refused because no repository uses it yet | Refuse any other status |
| For `standard`: the name is `std-<topic>`, and is either the name of a standard in the folder or a name the folder has never held | Refuse a name without the prefix, and a name the folder held before |
| For every kind but `standard`: the id does not start with `std-` | Refuse. The prefix names a standard |
| For `standard`: `check-context.mjs --offline` exits 0 — the `name:` line, the file and the title carry one name, the nine sections are in order, every rule carries its id, and the file is within 200 lines | Refuse to open the pull request. Print the findings; fix the draft; re-run |
| `check-context.mjs --offline` (hub) or `--local` (spoke) exits 0 | Refuse to open the pull request. Print the findings; fix the header; re-run |
| For a context kind's `--remove`: no design on the trunk carries the id on its `Context:` line | Refuse and list the keys |
| For `rule`: exactly one of `--intent` and `<file>`; `--owner` a role, not a placeholder or a person's name; `--globs` given and not a catch-all (`**`, `**/*`, `*`), or `--always-on` and no `--globs`; no `--revision` or `--origin`; a `--name` matching `^[a-z0-9][a-z0-9-]*$` | Refuse before anything is read |
| For `rule`: `RULES_INDEX` is a folder on the repository's trunk | Refuse. Name the key's value and the one-line change to `checks.env` that fixes it |
| For `rule`: one always-on rule per folder, and replacing it keeps `--always-on`; the first rule in a new folder is always on | Refuse and name the existing always-on rule, or say the first rule must be `--always-on` |
| For `rule`: a new name is free in the folder; a `--name` already in the folder is a replacement, said in the pull request | Refuse a taken proposed name and name the rule that carries it |
| For `rule`: one contract, within 80 lines | Refuse and name the contracts the intent holds |
| For `rule`: `check-spoke-rules.mjs --local` exits 0 | Refuse to open the pull request. Print the findings; fix the draft; re-run |
| For `rule --remove`: the rule exists in the folder and is not its always-on rule | Refuse and say why |
| For a hub record, a standard and a spoke's own record, with a global layer: the draft contradicts no binding global document at the newest release, unless an exception there covers it by the contradiction test in `review-artefact` § `global-review` (G1). For a spoke's own record, the exception names every hub in the spoke's `HUBS` line | Stop. Name both documents, and point the team to `/add-context --global --kind exception`. `read-global.mjs` exit 2 is a stop too, and so is `read-hubs.mjs --repos` exit 1 or 2 for a spoke's own record |
| For a hub record and a standard with globs or always on: the draft contradicts no binding document of a sibling hub that shares a covered spoke (G2) | Stop. Name both documents and the shared spokes, write the clarification to the Board, and point the team to a spoke record |
| For G2: every sibling hub is read, or skipped by `--skip-hub "<prefix>=<reason>"` with the person's reason | Stop on `read-hubs.mjs` exit 2, and name the hub or the spoke. A skipped hub and its reason go into the pull-request description |
| For an exception: `docs/estate/global.json` exists; `--global` and `--kind exception` come together; `--departs` names `global.` ids only; `--owner` is a role; none of the arguments the template fixes is given | Refuse before anything is read |
| For an exception: each departed id is at the global trunk, and binds there (E1) | Refuse, and name the id |
| For an exception: all seven answers are given, and none is a placeholder or `UNRESOLVED`; each repository is listed in this hub; the review date is later than today | Ask again. When the person does not answer, stop and open no pull request |
| For an exception: `read-hubs.mjs --repos` exits 0, and its `hubs:` line is the header (E3) | Stop, and name each finding |
| For an exception: Reason, Scope and Alternatives considered are not empty, not a placeholder and carry no `UNRESOLVED` line (E6) | Refuse to commit. `check-context.mjs --global` refuses the same |
| For an exception: the number is one the global trunk's history never held and no `context/EXC-<NNN>` branch on the global repository names (E4), and `check-context.mjs --global` in the clone exits 0 after the commit (E7) | Refuse to open the pull request. Fix the exception, commit it again, and run the check again |

## Output

- For the context kinds: one file added or replaced, under the kind's hub folder, or under the
  contract kinds' spoke `CONTRACTS_INDEX` folder, or a spoke's `DECISIONS_INDEX` folder for its own record, with the header above the unchanged text (a record: the header above the summary; a standard: the header above the summary, and the ingest report as the pull request's description). For a standard the file refuses (S1): nothing but the refusal and the home it names.
- One pull request, in the hub on `context/<name>` or in the spoke on `harness/context-<name>`.
- For an exception: one file, `docs/exceptions/EXC-<NNN>-<slug>.md`, in the global context
  repository, one pull request there on `context/EXC-<NNN>`, and one line reporting the number,
  the hubs, the repositories, the departed ids and what `check-context --global` said.
- For a hub record and a standard: the release G1 read, the sibling hubs G2 read, and every hub
  it skipped with its reason, in the pull-request description. For a spoke's own record: the
  release G1 read.
- One line reporting the id, the kind, where it landed, the owner, the revision, and what
  `check-context` said.
- For `rule`: one file added, replaced or removed under the spoke's `RULES_INDEX` folder, one pull
  request in the spoke on `harness/rule-<name>` (`harness/rule-remove-<name>` for a removal), and one line reporting the name, the globs,
  always-on or not, and what `check-spoke-rules` said.

## Stopping condition

The pull request is open and any temporary clone is gone. Then stop. Do not merge. For a spoke
context kind, do not run `/add-repo`: it reads the spoke's trunk, and the document is not on it
until a human merges. For `rule`, the same: the pull request is open, the clone is gone, and
nothing is merged. No `/add-repo` step follows a rule. For an exception, the pull request is open
in the global repository and the clone is gone. Do not merge it, and do not tag a release: the
Board does both.

## Never

- Never ask a question, except to settle a rule's intent (step R1), a standard's contradictions,
  open values and errors (step S5), or the seven answers of an exception (step E2, one question
  per turn). Everything else this command
  needs is in its arguments and the two lists. A value it was not given, it refuses; it does not
  guess an owner, a revision or an origin.
- Never fetch. A URL, a wiki page, a portal — saved to a file by the person who has access, then
  given as `<file>`. What is cited is the copy in the repository, never the original.
- Never change the document's text, except a record's summary, a standard's summary and a rule, which this command writes. Not a
  heading, not a typo, not a trailing space. The header is the only thing this command writes
  above a copy.
- Never invent a rank, a kind or a folder. Six context kinds this command places, of the eight
  `context-docs.mjs` fixes: five in the estate, and `exception` in the global repository. The
  other two, `requirements-source` and `requirements-document`, are `/feature`'s, and this
  command refuses both. A sixth kind this command places, `rule`, is
  not one of the seven context kinds: `spoke-rules.mjs` owns its shape, and `check-context`
  never reads it.
- Never write a contracts folder, or a decision-record folder, into a spoke that has not named
  one. `CONTRACTS_INDEX` and `DECISIONS_INDEX` are the spoke's to set, in its own `checks.env`,
  on purpose.
- Never mark a document always-on because it seems important. Always-on is every design, forever,
  in the window; it is for the handful of documents that truly bind every change.
- Never place a document a design has already cited at a different path, or reuse an id for a
  different document. Replace in place, under the same id, with the new revision. Two moves are
  allowed. A standard in the old shape is ingested again under a `std-<topic>` name (step S8). A
  standard named `STD-<NNN>` is renamed to `std-<topic>` (Renaming a numbered standard). In both
  cases the old path cannot stay on the trunk.
- Never write a rule the intent and the answers do not support. A sentence nobody asked for reads
  as agreed, and nobody agreed it (`.claude/rules/AUTHORING.md`).
- Never write a rules folder into a spoke that has not named one. `RULES_INDEX` is the spoke's to
  set, in its own `checks.env`, on purpose.
- Never write a rule into the hub. The hub's rule stubs stay stubs (`.claude/rules/estate.md`,
  the `UNRESOLVED` at its end).
- Never write into a standard what its original does not state and the person did not answer.
  A rule the estate never agreed reads as agreed in every design that cites it.
- Never settle a conflict between two standards. They rank the same (`CLAUDE.md` §4): ask.
- Never refuse a standard because no repository uses it yet. Its globs and its status decide when
  it binds.
- Never edit another standard from a standard's run. An answer that changes one is its own run.
- Never merge the pull request.
- Never write a hub record, or a spoke's own record, that contradicts a binding global document
  outside an exception that covers it (G1), or a hub record about a shared spoke that contradicts
  a sibling hub's record (G2). The first needs an exception, and the second needs the Board.
- Never write the reason for a `--skip-hub`. It is the person's, word for word.
- Never write the prefix `global.` into a file in the global repository, and never use an
  exception's number again.
- Never merge an exception's pull request or tag a release. The Board does both.

---
description: Write the per-work-item low-level design, take it through a critic capped at three rounds, and open the design pull request. Run again on the design's own branch, it amends the design with a person's answers and changes. After the fixes of the story's pull request, it records in the merged design what those fixes settled. Writes no code.
argument-hint: <KEY> [answers or changes]
---

<!-- Part of the harness asset library c6f3b4427d58f7c3 (see VERSION.json) · 2026-09-20 -->

# `/dev-spec <KEY>`

**This file is a contract, not an integration.** The state move below is a placeholder for the
team's own tracker call; substitute it once, here. The gates are not placeholders — they are
enforced against the repository, and the repository is the fact.

**Purpose.** Turn one approved work item and the sources it cites into one machine-checkable
per-work-item design, review it, and hand it to a human. Run again on the design's own branch
before the merge, it takes a person's answers to the design's open questions, and their changes,
into the same design and the same pull request (§ Amending an open design). After the merge,
the fixes of the story's pull request record what they settled for Prime's rules
(§ Amending a merged design). No implementation code is written in this phase, at all.

**Who runs it.** The `sprint-orchestrator` seat (`.claude/agents/sprint-orchestrator.md`) holds
the round count, the fresh-context rule and the transitions; it dispatches the seats named
below and produces nothing itself.

## Inputs

| Input | Form | Where it comes from |
|---|---|---|
| `<KEY>` | `^[A-Z][A-Z0-9]{1,9}-\d+$` | The argument |
| The work item | `docs/backlog/<SLUG>/<KEY>.item.md` on the hub's trunk — its `AC-<n>` identifiers, and the `REQ-<n>.AC-<m>` each carries, travel unchanged into §4, and the gate traces §4 back to it. A story taken from a Jira ticket sits at `docs/backlog/jira/<KEY>.item.md` and carries `JIRA-<KEY>.AC-<m>` instead, which travels the same way | `/decompose`, or `/from-ticket` for a story taken from a ticket. A design with no work item on the trunk does not pass the gate |
| The upstream sources the item cites | Citable by section title **and line**, and each one resolves | The requirements document on the hub's trunk where one exists; for a story taken from a ticket, the ticket's snapshot `docs/backlog/jira/<KEY>.ticket.md`; otherwise whatever the item cites |
| The hub checkout for `<KEY>` | `.worktrees/<KEY>/hub` on `feature/<KEY>-<BRANCH-SLUG>` | This command makes it on a first run (§ The hub checkout). An amendment finds it, or makes it again from the branch |
| `<BRANCH-SLUG>` | 2–4 words, kebab-case, from the story's title | Derived once, by the first run. Used only in the branch name, and **not** the `<SLUG>` in `docs/backlog/<SLUG>/` — that one names the source document a decomposition came from |
| `<HUB-TRUNK>` | The hub remote's default branch, as `git ls-remote --symref origin HEAD` reports it **now** | Asked of the hub's remote on every first run. **Never stored, never substituted at install** |
| The story's `Repository:` line | One id, in `docs/estate/repositories.json`. Copied into the design's `Repository:` line, never typed | The work item |
| The current state of the codebase | The repository the story names, read at one pinned commit through `scripts/read-spoke.mjs` from the hub checkout. Read, not summarised. The same script searches it at that commit: `--grep <text>` finds text in files, and `--files <glob>` finds file paths. A search finds a location, and the read of that location is the fact | The repository's trunk, as the script pins it |
| The repository's own rules | `node scripts/read-spoke-rules.mjs <id> --at <commit> --design <draft>` from the hub checkout: the always-on rule and every rule whose globs match a §3.1 path, as text, with the `Rules:` line the design copies and an `Overrides:` line on a rule that replaces a standard rule | The folder the repository's `checks.env` names with `RULES_INDEX`, at the same pinned commit; `Rules: none` where it declares none or has not configured it |
| `scripts/read-survey.mjs` | `--readers <key>`: every surveyed repository that calls a contract this design changes, uses a library it changes or touches a store it changes, each with its drift line; apart, every one that calls such a contract with the provider `unknown`; and every listed repository with no survey. Points, never cited | Installed with the hub; the surveys come from `/survey-repo` |
| `scripts/read-discovery.mjs` | `<id> --paths <a,b> --at <commit>`: one index line for each earlier discovery map whose Files read or Ruled out folders overlap the paths, and no bodies. `--keys <K1,K2>` prints those maps, each row with a `Pin`: `current`, or `drift` where the file changed. Points, never cited | Installed with the hub. The maps are `docs/designs/<KEY>.discovery.md` on the hub's trunk, written by earlier runs of this command |
| `docs/designs/_TEMPLATE.lld.md` | The shipped template | Onboarding |
| `docs/designs/_TEMPLATE.discovery.md` | The shipped template of the discovery map | Onboarding |

## Preconditions

For a first run. An amendment has its own start, in § Amending an open design.

1. **The hub checkout for `<KEY>` exists, or this run can make it.** On a fresh start the command
   runs at the hub's root and makes the checkout first (§ The hub checkout). Then it works inside
   `.worktrees/<KEY>/hub`. This phase has no code checkout. The design seat holds the hub
   checkout and reads the repository through `scripts/read-spoke.mjs`, so every fact it cites
   arrives with the commit it was read at. `/dev-sprint` makes the code checkout when the build
   starts.
2. **Every source the work item cites resolves, and the design cites the same set.** Not "both
   signed specifications exist" — a programme that decomposed a product brief, a set of wiki
   pages or a tracker epic has a legitimate backlog and no signed parent, and refusing it would
   push the author into inventing a citation to clear the gate. What is refused is an
   *unresolvable* citation. Where a rank-1 signed source is genuinely absent, §1 says so in the
   one permitted grammar — `UNRESOLVED — <what>. Owner: <role>. Resolves: <trigger>.` — and
   every clause below it is derived from sources that do resolve. Never invent a signed
   specification to satisfy a row.
3. The source-of-truth hierarchy is written in `CLAUDE.md` §4, with its tie-breaker. Sources
   will conflict; the agent resolves by rule, not by preference.
4. No design already exists for `<KEY>` on the trunk. Exactly one design per work item.
5. The story carries exactly one `Repository:` line and its id is in `docs/estate/repositories.json`,
   and `node scripts/check-registry.mjs --offline` exits 0.
   The design's `Repository:` line is that value, copied. A story with no repository, or one the
   hub does not know, is a decomposition defect: stop and report it, never pick one here.
6. **A re-run after a cap finds something changed upstream.** Run
   `node scripts/escalation.mjs resume --work-item <KEY> --point dev-spec.review-cap --by-seat sprint-orchestrator`.
   Exit 0 means the run may start. Either no cap escalation is open, or the design on its branch or
   a closed clarification changed since the cap and the script wrote `resumed` with what it found.
   Exit 1 means that nothing changed, or that an incident is open on the work. Stop at once, print
   what the script printed and say that a cap is never raised. An answer in the argument counts
   only after it reaches the design or a closed clarification. Exit 2 is exit 2 for this command:
   stop.
7. **The dependencies of `<KEY>` are known.** Dispatch the `gate-runner` seat
   (`.claude/agents/gate-runner.md`). It runs `HARNESS_TRUNK=main node scripts/check-dependencies.mjs
   <KEY> --step design` in the hub checkout. It returns the exit code and output verbatim. Omit the `HARNESS_TRUNK` prefix where the hub's trunk is `main`. This check is a warning. It is
   not an exit condition, so it does not conflict with § The ordering constraint.

   | Exit | Meaning | Action |
   |---|---|---|
   | 0 | Every dependency design is done, or the story has no `blocks` row | Proceed |
   | 1 | At least one dependency design is not done | Print each `[FAIL]` block to the person. Tell the person that `design-gate` holds the design pull request until each dependency is done. After the fix merges, the person pushes a commit or closes and reopens the pull request, so that `design-gate` reads the new trunk. A re-run of the failed job reads the old trunk. Continue |
   | 2 | Cannot verify | Warn the person that the state of the dependencies is unknown. Continue |
   | 3 or 4 | Usage error or internal error | Stop |

## The state transition it owns

`TODO → SPEC IN PROGRESS`, **agent-owned**, asserted against the worktree and branch rather than
against intent. The verification is mechanical, and it reads git, not this command's own
report: `git worktree list` names `.worktrees/<KEY>/hub`, its branch is
`feature/<KEY>-<BRANCH-SLUG>` cut from the hub's trunk, and the design file is committed on it.

It does **not** own the design merge. That is human gate 1 — one of exactly two actions **per work
item** no agent may perform, the other being the implementation merge — and this command ends in
front of it. Two more human actions sit in front of the machine, once per requirements document
rather than once per item: signing the requirements document, and merging the decomposition.
`.claude/rules/workflow.md` § Transition ownership holds the whole picture.

## The hub checkout

A fresh first run makes the hub checkout before step 1. Run each check first, at the hub's root,
and make nothing until all of them pass:

1. `<KEY>` matches the key pattern. A permissive key check is how a typo gets a checkout, and
   later a design file the gate never finds.
2. Preconditions 4 and 5 hold: no design for `<KEY>` on the trunk, one story with one
   `Repository:` line, and the registry check exits 0.
3. `git ls-remote --symref origin HEAD` names the hub's trunk. A remote that does not answer is a
   stop, not a fallback to a remembered name.
4. `git fetch origin` succeeds. A checkout cut from a stale trunk starts behind.
5. `git worktree list` names no checkout at `.worktrees/<KEY>/hub`, and the folder does not exist.
   A pruned folder with a live registration produces the most confusing failures.
6. No `feature/<KEY>-*` branch exists in the hub, locally or on `origin`
   (`git ls-remote --heads origin 'feature/<KEY>-*'`). If one does, stop and name it.

```bash
HUB_TRUNK=$(git ls-remote --symref origin HEAD | awk '$1 == "ref:" && $3 == "HEAD" { sub("^refs/heads/", "", $2); print $2 }')
[ -n "$HUB_TRUNK" ] || { echo "origin reports no default branch. Stop." >&2; exit 2; }
git fetch origin                                                  # or stop; never cut from a stale trunk
git worktree add .worktrees/<KEY>/hub -b feature/<KEY>-<BRANCH-SLUG> "origin/$HUB_TRUNK"
# the harness watermark's commit-msg check (.claude/rules/watermark.md); per-worktree config,
# so nothing reaches the person's own checkout
node scripts/harness-commit.mjs --install-hook ".worktrees/<KEY>/hub" --worktree
```

Then work inside `.worktrees/<KEY>/hub`. The hub is the repository this command runs in, so its
checkout is a worktree of it. `.worktrees/` is in the hub's `.gitignore`, so the checkout never
shows as uncommitted work. The repository the story names gets its own checkout later, from
`/dev-sprint`, cut from that repository's trunk when the build starts.

**The story decides the repository, and the folder never does.** The design's `Repository:` line
is copied from the story, never inferred from the folder this command runs in or from a remote
already configured. A design for repository A that is built in repository B passes every check
the single-repository shape had. The story, the design and the spoke's check naming the same id
is what closes that hole.

## What it does

**First, the kind of run — read from the checkout, never typed.**

| The checkout | The kind | What follows |
|---|---|---|
| No `.worktrees/<KEY>/hub`, and no `feature/<KEY>-*` branch in the hub, locally or on `origin` | A first run, fresh | § The hub checkout, then steps 1 to 5 |
| `.worktrees/<KEY>/hub` on the branch the first run cut, with no design for `<KEY>` committed on it | A first run | Steps 1 to 5 |
| A clean `feature/<KEY>-<BRANCH-SLUG>` that carries the design and its review, and `node scripts/check-design-amend.mjs <KEY>` exits 0 | An amendment | § Amending an open design |
| Anything else — the trunk, another branch, uncommitted files, an amend check that exits non-zero, a `feature/<KEY>-*` branch with no checkout and no design | None | Refuse. Print what the script printed, or name the branch and the trunk. A branch that exists may be another person's, and resuming it is a decision for a human |

On a design branch, confirm in one turn before anything else. Say in plain words that this is the
branch of the design for `<KEY>` and that it is not merged, then ask *a) a pull request is open
from this branch — amend it; b) no pull request yet — the first run stopped on a question or at
the review limit, so finish it; c) stop.* Git cannot tell an open pull request from one closed
without a merge, or from none, so the person's answer is the only check there is.

1. **Read the codebase, not the plan.** Write the design against the tree as it actually is. A
   design written from a plan describes a codebase that does not exist, and every instruction in
   it has to be re-derived by whoever implements it. This is the single instruction that does
   most of the work in this command. The tree is the repository the story names, and it is read
   from the hub checkout through `node scripts/read-spoke.mjs <id> <path>`: the first read pins
   the trunk commit, every later read passes `--at <commit>` so the whole design describes one
   commit, and every fact is cited as `<id>@<12-hex>:<path> L<a>-<b>` from the script's `Cite:`
   line. `<b>` is never above the file's `Lines:` value. A citation into the repository without
   its commit is malformed, and the critic refuses it. The list's `purpose` is never cited.

   **Find every place first.** A large repository can hold the same logic in two places. Before
   §3.1 is final, search for each name, string and key that the change touches:
   `node scripts/read-spoke.mjs <id> --grep <text> --at <commit>`, with `--paths <glob>` to make
   the search smaller, and `--files <glob>` to find files by path. The text is fixed, so `a\|b`
   finds only the literal text. To find one of several texts in one search, add `--regex` and
   write `a|b`. For each hit outside the files
   §3.1 names, do one of two things:
   - name the path in §3.1
   - say in §7 why it is not in scope

   Read the file at each hit and cite the read, not the hit. A search prints no `Cite:` line. A
   search that exits 1 printed `Scope: 0`: the globs select no file, so correct the glob.

   **Start from earlier discovery, index first.** After the first searches, run
   `node scripts/read-discovery.mjs <id> --paths <a,b> --at <commit>` from the hub checkout. Give
   it the paths that the searches found. It reads the maps on the hub's trunk, which is the branch
   the origin reports, or `HARNESS_TRUNK`. Exit 0 prints a header, a `---` line and one index line
   for each map whose folders overlap the paths. Then run it again with `--keys <K1,K2>`. Name only
   the maps that this story needs. Each row of their Files read and Ruled out tables then carries a
   `Pin` at `<commit>`.
   - Trust a `current` entry for the reason it records.
   - Read a drifted file again at `<commit>`, and list it under Files read. A removed file has
     no row.
   - Do not read an unchanged file only to rule it out again.
   - Read each file that the design cites at `<commit>`, also where its entry is `current`.

   Exit 1 means that a map in scope breaks the grammar or is not the bytes its design pins. It
   also means that a key in `--keys` has no map for this repository. Then the header ends with
   `Status: NOT READ: <n> finding(s)`, and no `---` line follows. Exit 2 means that the script
   cannot verify. On exit 1 or exit 2, stop and report the script's output to the person.

   **Read the repository's own rules the same way.** Once the §3.1 table names the paths this
   design touches, run `node scripts/read-spoke-rules.mjs <id> --at <commit> --design <draft>`
   from the hub checkout. It prints the always-on rule and every rule whose globs match a §3.1
   path — nothing else, because a rule for paths this change does not touch is not in play — each
   with a `Cite:` line, and one `Rules:` line. Copy that line into §1; list each printed rule under
   §2 **Read before implementing** with why it bears on this design. A design written against a
   convention the repository never wrote is a design the critic reads as unreviewed on that point.
   `Rules: none` is what the script prints where the repository declares none or has not
   configured it, and the design says so; it never invents a folder. Selection is by the design's
   own table, so a §3.1 row added late means running the script again.

   **Read the context documents the same way, index first.** Before the first line of the
   design, run `node scripts/read-context.mjs <id>` from the hub checkout with no other argument:
   it prints one line per document in scope — the hub's decision records, standards and
   requirements documents, and this repository's contracts and third-party API documents — and
   no bodies. It prints no line for a requirements source, because a design does not read one. That
   is enough to know a document exists and what it is called. Where the requirements document of
   the story's slug, `docs/requirements/<SLUG>/requirements.md` on the trunk, records a release on
   its `Global:` line, add `--global <commit>`, with the 40-hex commit from that line, to every
   `read-context.mjs` run of this step. The index then carries the global documents first, each
   id prefixed `global.`. Where the line says `Global: none`, or there is no line, run without it.
   Start from the story: each id on
   the work item's `Context:` line is a document the story was written against, and the design
   names each one too. Then write the design so that it *names* what it uses: the contract's id
   in the §6 table, the record's id in the §1 table. A standard is cited by the rule the design
   applies, `std-<topic>.<NN>`, where it applies, never by its name alone. Once
   §3.1 and §6 are drafted, run `node scripts/read-context.mjs <id> --at <commit> --design
   <draft>` at the same commit the `Rules:` line pins. It selects every document the design names,
   every one whose globs match a §3.1 path, and every one that is always on, and prints each with
   a `Cite:` line, one `Context:` line and one `Hub commit:` line. Copy the two lines into §1
   beside `Rules:`, together. The `Hub commit:` line names the hub commit the run read the hub's
   documents at, and the gate proves that commit holds every hub entry's bytes. Each entry on
   it is `<id>@<12-hex>:<path>` — the document, the first twelve characters of the blob hash of
   the bytes read, and where the file is (`<repository-id>:<path>` for one kept in this
   repository) — so the reader sees which file was read and the gate can see whether it moved. A
   global document's entry is `<id>@<12-hex>:global:<path>`, and its pin is the global commit, not
   a blob. A standard whose block carries an `Overridden:` line is replaced, whole or in the rules
   the line names, by the repository rule the line names: design to the repository rule there, and
   cite it, not the standard rule it replaced.
   List each printed document under §2 **Read before implementing** by its path from the `Cite:`
   line, its id in brackets and why it bears on this design; a document named by id alone makes
   the reader run the script to find the file. Read from an up-to-date hub trunk: a hub document's
   pin is of the bytes on disk, and the gate compares it with the trunk.
   `Context: none` is what the script prints when nothing binds, and the design says so. A design
   that calls an external system §6 does not name, or names one the index does not carry, is a
   design written against a document nobody placed: stop, and say which document `/add-context`
   should add. The pickup gate reads the line's form — once, `none` or entries as the script
   prints them — and refuses a placeholder or prose; it refuses a hub entry whose file is not on
   the trunk or whose pinned bytes no commit on the trunk ever held, and prints a **context
   drift** note, without failing, for one whose bytes moved after the design read them. It also
   reads the use of each document: an id on the line that the design never names fails, and so
   do a standard with no rule cited, a cited rule the standard does not define, and a decision
   record or a standard's rule that the design cites and the line does not list. Each id on the
   story's `Context:` line must be on the design's. A global entry must pin the commit on the
   requirements document's `Global:` line, and a global exception it cites must be `Active`, name
   this hub, and sit beside each record it departs from. Whether it is the line the script printed
   is the critic's finding.

   **Read the Prime guardrails yourself, where Prime is on, before the dispatch of step 2.** A
   Prime guardrail is one security rule from Prime Security: a title and a rule of about 30 words.
   This read is the orchestrator's own. Never put it in the engineer's dispatch: the engineer never
   runs `prime.mjs list` or `prime.mjs refresh`, because only those two reach Prime. Read the
   repository's `checks.env` at the pinned commit through `read-spoke.mjs`. Where `PRIME_BOT` is
   missing or `none`, Prime is off for this repository: the design says `Guardrails: off`, and no
   Prime script runs. Otherwise run `node scripts/prime.mjs list --repo-id <id> --out ../prime`
   from the hub checkout, so the files land in `.worktrees/<KEY>/prime`, outside the checkout. Add
   `--stack <value>` where `checks.env` sets `PRIME_STACK` to a list, not `auto`. The script writes
   the guardrail list to `guardrail-list.md` in that folder, and prints counts only. The list holds
   every guardrail of the repository's stack, each with its full rule, numbered `g1`, `g2` and so
   on:
   - first each guardrail Prime already found broken in this repository, from any group;
   - then the rest of the stack, by category;
   - then one line that counts the groups outside the stack.

   Prime reviews every pull request against every guardrail on the list, not only the ones a
   design names.

   **Then read what Prime raised on this repository before.** Run `node scripts/prime.mjs history
   --repo-id <id> --out ../prime --designs docs/designs`. It writes `prime-history.md` in the same
   folder: each guardrail that Prime raised on the repository's earlier pull requests, with those
   pull requests, the files and Prime's own sentences. Prime's search of findings by repository
   holds none of them, so the list alone does not show them. Its second part holds what the
   designs of this repository recorded for Prime's rules: each person's answer, and each decision
   that the fixes of a pull request made (§ Amending a merged design). Hand the file, pasted whole, to every engineer dispatch
   and every security-reviewer dispatch, beside the list. Exit 2 means that Prime did not answer:
   go on without the file, and say so in the report.

   **Paste the whole text of `guardrail-list.md` into every engineer dispatch and every
   security-reviewer dispatch of this run**, with the folder's absolute path beside it: the first design, each
   revision, each amendment, each review and each verdict round. Each seat starts on fresh
   context, and knows no list it was not handed. A path alone is not a hand-in: on SHOP-2, the
   seats handed only the path never opened the list. Paste the file as it is: a list that is cut,
   or that points to the file for the rest, is not the list. The reply of each seat that gets the list opens with the line
   `Guardrail list: <n> rules, g1 to g<n>, ending with "<the title of g<n>>"`. Compare the count
   with the `listed=` line and the title with the `last=` line that `prime.mjs list` printed. Only
   a seat that received the end of the list can name that title. A reply with no such line, with
   another count or with another title is no reply: dispatch the seat again with the whole list. Exit 2 means that Prime did not answer or that no token is set: the
   design says `Guardrails: unchecked`, the step goes on, and the report says why. The token never
   leaves the script.

   **The design comes first. Write no plan of the guardrails before it, and ask nothing before
   it.** The harness plans for the code and follows the guardrails. A question that is asked before
   a design exists is a question about a guess: on SHOP-2, ten such questions came from a plan of
   70 rows. The order is step 2, the design, with the list in front of the engineer. Then step 3,
   two reviewers. Then step 4: the questions, once, about lines of that design, one revision, and
   one confirming pass where a finding is left.

   **Name who reads what this design changes.** Where §6 has a `served` row whose change is
   `additive` or `breaking`, run `node scripts/read-survey.mjs --readers <key>` from the hub
   checkout, with the contract's key in the survey template's grammar. Under §7 answer, as one
   question, who consumes it: every reader the script prints, with its drift line; every
   possible reader it prints under `May be read by`, read at a pinned commit to learn whether its
   call reaches this service; and every listed repository it prints as not surveyed. A `breaking` row with a reader is the stop §6
   already names. The survey points; where the design relies on how a reader calls, read that
   reader at a pinned commit through `scripts/read-spoke.mjs` and cite that read.

   **Write the discovery map.** Write `docs/designs/<KEY>.discovery.md` from
   `docs/designs/_TEMPLATE.discovery.md`. A later story starts from this map, and the gate reads
   it.
   - `Commit:` is the 40-character commit that `read-spoke.mjs` printed. When `Rules:` is not
     `none`, it starts with the commit of the `Rules:` line.
   - Files read lists every spoke file that this step read, with the first 12 characters of its
     `Blob:` line. Each spoke path that the design cites is a row.
   - Searches lists every search, with its hits and the hits kept.
   - Ruled out lists every path with a hit that the design does not name in §3.1, with its
     search and the §7 reason.
   - Reused lists each row taken from an earlier map. Map is the `Cite:` line that
     `read-discovery.mjs` printed for that map. Path and Pin come from the printed row.
   - Write `NONE` for an empty Ruled out or Reused section.

   Step 5 commits the map beside the design, in the same commit. Run
   `git hash-object docs/designs/<KEY>.discovery.md`. Copy its first 12 characters into the
   design's `Discovery:` line. A later read or search updates the map, and then the line.
2. **Write `docs/designs/<KEY>.lld.md`** from the template, dispatching the worker on the
   `engineer` seat (`.claude/agents/engineer.md`). This command and the template carry the
   authoring method; `.claude/skills/implement-work-item/SKILL.md` does **not**, because that skill
   covers the implementation phase and its preconditions start at a merged design. Every section,
   and in particular:
   - **A dependency's design is a source.** Where a dependency's design is merged, read it at the
     trunk commit. Then cite it. An assumption about a dependency whose design is not merged is a
     §9 row with `Blocking` set to `no`. Its `Source` cell is `` `docs/designs/<dependency-key>.lld.md` ``
     with the section and line. Where no line exists yet, the cell is
     `` `docs/designs/<dependency-key>.lld.md` (not merged) ``. Here `<dependency-key>` is the key
     of the dependency, for example `SHOP-1`.
   - **§1 traceability** — every upstream source the work item cites, by section title and line
     range, plus the work-item file itself. Some of these will be spot-checked, and the
     deterrent is the actual control. Where no rank-1 signed source exists, the `UNRESOLVED`
     line of precondition 2 goes here, once, naming an owner and a trigger. The `Ticket:` line
     names this work item and the `Repository:` line names the one repository the code lands
     in, by its bare name, **copied from the story's own `Repository:` line**. The gate reads
     both, refuses a placeholder in either, and — when the repository's own check runs it with
     `HARNESS_REPO` set — refuses a design written for another repository. The `Rules:` line is
     the one `scripts/read-spoke-rules.mjs` printed in step 1, copied; the gate reads it too,
     and refuses a placeholder, prose, or a citation into any repository but this one. The
     `Context:` line is the one `scripts/read-context.mjs` printed in step 1, copied; the gate
     reads its form as well. The `Hub commit:` line is the one the same run printed, copied
     with it; the gate reads it against the hub's trunk.
   - **The `Guardrails:` line** — where step 1 wrote a guardrail list, the engineer reads every
     rule on it, and the design meets each rule that its code touches. A design departs from a
     guardrail only with a person's recorded answer: a `Closed` §9 row whose `Source` names the
     rule and whose `Resolution` holds the person's words and role. The pull request's fixes then
     close Prime's finding with that answer. Where a requirement, a decision or an answer seems to conflict with a rule,
     the engineer designs the behaviour so that it meets both. For example, the server takes a
     request as an action and resolves it from its own state, or an explicit server-side check
     grants exactly what the requirement allows. Where no design meets both, the engineer adds a
     blocking §9 row routed to the lead architect, and the design stops at outcome 2.
     A rule with several parts — payload size, file size and call rate in one rule — is met part
     by part. §2 names each part and how §3 meets it, or why this code has none of it, as "no
     upload, so no file size". A part that needs a value no source gives, such as a rate, is a
     §9 question for the role that owns it, asked now, never left to the code.
     **Where a rule leaves a choice, the design takes the choice that meets the rule, and marks
     it for a person.** A choice is for a person where it changes what a user of the feature sees,
     where it carries a value that no source gives, or where it needs another role, a decision
     record or a standard to change. A refused request, a new error and a new limit are changes
     that a user sees. Each such choice is one §9 row: `Source` is `Prime <g-number> <title>`,
     `Blocking` is `yes`, `Status` is `Open`, `Routed to` is the role that owns it, and the
     question names the choice the design took and the other choices that meet the rule. Step 4
     asks the person. An answer closes the row: `Status` `Closed`, and `Resolution` is the answer
     and the role the person answered for. Every other change that a rule needs is the
     engineer's to make, with no row.
     **A security limit is not a change of what is wanted.** A rule may limit how much or how
     often a required behaviour runs, as a rate limit refuses the 11th request in a minute. The
     design takes such a limit only with the product owner's answer to its §9 row (step 4).
     It then sharpens the wording of the criterion in §4, keeps its id, and names the limit under
     §2 **Security limits**. With no such answer, the limit is a blocking §9 row routed to the
     product owner. A rule that forbids the required behaviour itself is not a limit: add a
     blocking §9 row routed to the feature owner, whose way is `/feature`.
     For an access-control rule — deny by default, function-level, object-level or server-side
     authorisation — §3 names the explicit check: where it runs, what it grants and what it
     denies. That an object exists, or that a middleware lets a role in, does not meet an
     object-level rule, even where a requirement lets every role in: the check then grants exactly
     what the requirement allows.
     **What Prime raised here before is decided in the design.** Where step 1 wrote
     `prime-history.md`, the engineer reads every entry. Prime reads the next pull request in the
     same way. For each entry that the story's code can meet again, §2 **Prime guardrails** names
     the guardrail and one of two things: the line of §3 that meets it, or the §9 row that
     decides it. A decision of the design that keeps a behaviour which Prime raised before is a
     choice for a person, so it is a §9 row as above.
     **An earlier story's answer is where the design starts.** The second part of
     `prime-history.md` holds the answers and decisions that earlier designs of this repository
     recorded. Where this design meets the same question on the same code, §2 names the entry,
     with its story. A recorded decision of the fixes, such as a limit that the engineer chose, is
     taken as it is. A recorded answer of a person was given for that story. So the §9 row is
     still written, and its question gives the earlier answer as the recommended choice.
     **Code that the story does not change is not this design's to fix.** Where only code outside
     the §3.1 paths breaks a rule, §2 names the rule as `not in this story`, with the file. It is
     no §9 row and no question.
     It names each guardrail it applies under §2 **Prime guardrails**, with how §3 applies it
     and the §3.1 paths it concerns. Then it runs `node scripts/prime.mjs choose --out <folder>
     --pick <g3,g7>` and copies the line it prints into §1. `choose` writes the full rules of
     those guardrails to `chosen.md`, and prints `Guardrails: prime@<12-hex>:<id>, <id>`: the
     fingerprint of the rules, then each Prime id. One changed character in a rule changes the
     fingerprint. It reads only the saved list, and asks Prime nothing. Where the code touches no
     rule on the list, `--pick none` prints `Guardrails: none`. The design holds no rule text.
     The gate reads the line's form only, and reads a design with no line as `off`.
     The `Discovery:` line is `Discovery: <KEY>.discovery.md@<12-hex>`,
     the hash of the map that step 1 wrote. The gate reads the map on the trunk and checks these
     facts:
     - The map's head lines agree with the design.
     - `Commit:` starts with the `Rules:` commit, when `Rules:` is not `none`.
     - Every spoke path that the design cites is in Files read.
     - The path of each `drift: <old> → <new>` row of Reused is in Files read.
     - A commit on the trunk held each map pin in Reused.

     A design with no line and no map passes with a note. A design with no line and a map
     fails. Write the line in every new design.
   - **§4 acceptance criteria** — the work item's `AC-<n>` identifiers, carried across
     unchanged. Refine the wording where the design makes a criterion sharper; never renumber,
     and never drop one. One observable testable statement each, at least one negative case.
     The `Requirement` column carries, for every row, the one `REQ-<n>.AC-<m>` the work item's
     `Carries` column names for that criterion, or the one `JIRA-<KEY>.AC-<m>` for a story taken
     from a ticket — copied, never re-derived. The gate reads the
     column by name and refuses an empty cell or anything that is not one such id. It also
     traces the table to the work item on the trunk: it refuses a criterion the work item does
     not define, a work-item criterion the table does not carry, and a `Requirement` id that is
     not the one the work item's `Carries` column gives that criterion. The validation report
     repeats the column, and `check-validation.js` compares the two.
   - **Today's behaviour is the starting point.** A criterion changes only the behaviour it
     names. The design keeps today's behaviour everywhere else, and it never widens the system
     to meet the words of a criterion. The common case is a criterion that says "all", "every",
     "always" or "never" over a set the requirements document does not define. Example: "the
     agent answers all the user's questions", designed against an agent that refuses off-topic
     turns today. Read the set as the behaviour the story touches. Keep every refusal, limit and
     special path the story does not name, as it is today. Record the reading once, for the
     whole class, in two places:
     1. One answered question in §7. It names the criterion, the reading, and the behaviour the
        design keeps, cited at the pinned commit.
     2. One §9 row for the class, routed to the feature owner, with `Blocking` = `no`. The
        merge of the design approves the reading. The next revision of the requirements
        document names the set, and closes the row.

     Never list the cases one by one, in the design or in a question. A list that the next case
     escapes is a loop, and this rule ends it. A reading that drops a behaviour a criterion
     names is not a reading. It is a change to what is wanted, and § Amending an open design,
     step 2, says where that goes.
   - **§5 testing plan** — one row per criterion, each naming a **real** test. A dash, `TBD`,
     `N/A`, `TODO`, `NONE` or `?` in the test-name column is a placeholder, and the gate rejects
     placeholders. It is the cheapest escape available to an agent approaching a cap, which is
     why it is closed.
   - **§7 answered senior-engineer questions** — the how the requirements document left to this
     design on purpose: where a file lands, what it is called, which branch pattern, which header
     field, what form an argument takes. Each is answered here or in §3, from the rules and the
     repository at the pinned commit; one the engineer cannot answer is a row in §9, routed to a
     role — never a question sent back to the requirements document.
   - **§8 readiness** — eight fields, each appearing exactly once, each a pure token, on its own
     line, inside the readiness section. Not in prose, not in a table, not restated in a summary.
   - **§9 clarifications** — the strict eight-column schema, or the literal token `NONE` with no
     table. Every blocking row names a role in `Routed to` — a role, never a person.
   - **A decision wider than this work item** — one that is expensive to reverse and binds work beyond it — is not made in the design. Load `.claude/skills/draft-adr/SKILL.md`, write `docs/designs/<KEY>.adr-draft.md` from `docs/designs/_TEMPLATE.adr-draft.md`, and add a blocking §9 row routed to the lead architect that links the draft. The design is written as far as the decision allows, and stops at outcome 2.
3. **Dispatch the `dual-mode-critic` seat on fresh context** (`.claude/agents/dual-mode-critic.md`),
   with `Mode: lld-review` and the method in `.claude/skills/review-artefact/SKILL.md`. The critic
   reads the design, every source it cites and the rules. It also receives, as text, the index
   and the selection `read-context.mjs` printed in step 1, and opens no context document itself.
   Where step 1 wrote a guardrail list, the critic does not check the list against the design:
   one reader does that, the security reviewer, below. The critic receives `chosen.md`, the rules
   that the design names, and from round 2 the answers of step 4, as text. It checks
   three things:
   - a rule that §2 names and §3 does not hold is `IMPORTANT`
   - an answer of step 4 that the design does not apply is `IMPORTANT`
   - a limit on a required behaviour with no `Closed` §9 row that carries the product owner's
     answer is `IMPORTANT`

   It emits
   `docs/designs/<KEY>.lld-review.md` carrying, on its
   own line, exactly `### VERDICT: APPROVED` or `### VERDICT: CHANGES REQUESTED`, and a
   `Design revision:` line naming the `git hash-object` value of the design it read. It never
   edits the design. Its one write path is its own review file.

   **The critic holds no shell, so this command runs what the review needs and hands over the
   output, as text, with each dispatch:**
   - the value `git hash-object docs/designs/<KEY>.lld.md` prints for the design under review
   - the output of `read-spoke-rules.mjs` from step 1, which the `Rules:` line must equal
   - the index and the selection of `read-context.mjs` from step 1, as above
   - where the design names guardrails, `chosen.md`, and the line `prime.mjs choose --out ../prime
     --pick <the g-numbers §2 names>` prints when this command runs it again, which the
     `Guardrails:` line must equal. It reads only the saved list

   Never ask the critic to run a script. A dispatch that asks for one ends with no verdict, and
   costs one more activation of the seat.

   **Hand in the cited spoke files, and run the request round.** The critic opens no spoke
   itself. Both steps read the design's `Repository:` at one commit, `<commit>`.

   The commit is the one that the design cites. The design's `Rules:` line, when it is not `none`,
   and its citations into its `Repository:` each name a commit in 12 characters. The orchestrator
   checks that they all name the same commit. If they name more than one commit, the orchestrator
   stops and escalates to the person. It passes those 12 characters to `--at` as written, and the
   script resolves them to one commit on the trunk.

   Under "Sources handed in", give the critic every spoke file the design cites, read with
   `node scripts/read-spoke.mjs <id> <path> --at <commit>`. Give it the discovery map there too,
   as text. Put this line in the first dispatch of each review round:

   ```
   Request round: 0 of 1
   ```

   In the dispatch text, tell the critic to return one `### REQUESTS` block first. In cycle 1,
   the block holds at least one search of its own for the Reach row. Give no search terms, so the
   critic stays independent of the author.

   The critic can then return a `### REQUESTS` block with no verdict and no review file. The
   grammar is in `.claude/skills/review-artefact/SKILL.md` § The request round. In cycle 1 the
   block is mandatory. The hand-in holds only the cited files, so only the critic's own search
   shows that no second place holds the logic the design changes.

   Check the first reply of cycle 1 before you use it. It must hold a `### REQUESTS` block with at
   least one line that starts with `- grep `. When it does not:
   1. Discard the reply. If it wrote the review file, restore that file to its state before the
      dispatch.
   2. Dispatch the critic again on fresh context, with the same first dispatch and this line
      after `Request round: 0 of 1`:

      ```
      Refused: in cycle 1, the first reply is a ### REQUESTS block with at least one grep for the Reach row.
      ```

   3. If the new reply also fails this check, stop the loop and report it to the person as an
      escalation.

   This second dispatch is not a review round and not a request round.

   When the critic returns a `### REQUESTS` block:
   1. Save the critic's whole reply in the system temporary directory as
      `<KEY>-lld-review-round-<n>-requests.md`, where `<n>` is the review round.
   2. Run `node scripts/read-spoke.mjs <id> --requests <file> --at <commit>`, with `<id>` the
      design's `Repository:` id and `<commit>` the commit above.
   3. Dispatch the critic again on fresh context, with the first dispatch and the output as text.
      In the new dispatch, this line replaces the `Request round: 0 of 1` line:

      ```
      Request round: 1 of 1
      ```

   Exit 0 gives the answers. Exit 3 means that the reply breaks the grammar or the cap of 10
   requests, and then no request runs. On exit 3, do step 3 with the script's refusal text
   (its stderr) as the answers. Exit 2 means that the spoke cannot be read at that commit, and
   exit 4 is an internal error. On exit 2 or exit 4, stop the loop and report the script's output
   to the person as an escalation. At `1 of 1`, the critic must return a verdict.

   **Where step 1 wrote a guardrail list, dispatch the `security-reviewer` seat beside the critic**
   (`.claude/agents/security-reviewer.md`), in the same round, on fresh context and blind to the
   critic's findings. It runs the security lens of the same skill, § The security lens — a design.
   Hand it the design, the whole `guardrail-list.md`, `prime-history.md` where step 1 wrote it,
   the cited spoke files that the critic gets, and the same request round, with its own count. Add every existing file that the design's §3.1
   table names. It reads the design against every rule on the list, as Prime will read the code.
   It writes no file. It returns a verdict in the critic's tokens, the table of the rules that
   its lens defines, and findings. **Count the rows of the table before you accept the reply.**
   A row count that is not the list's count is no review: dispatch the seat again, and name the
   g-numbers it left out. **Save each reply as `security-review-<round>.md` in the Prime folder
   before the next step.** A round whose reply is not saved is not done, and step 5 counts one
   file for each round. In each later round, hand the seat its own table of the round before: it
   changes only the rows that the revision touches. Each finding is
   marked `Fix:` where one change meets the rule, or `Decision:` where a person must choose, with
   the choices that meet the rule. A `Decision:` finding becomes a §9 row as step 2 says, in the
   next revision. **Both verdicts read `APPROVED` before step 5.** One `APPROVED` and one `CHANGES
   REQUESTED` is a blocked round, not a majority. With no guardrail list, no security reviewer runs
   at design time: never simulate one.

   Where the programme has configured persona seats, dispatch them on the same design in the same
   round, on the method in `.claude/skills/persona-review/SKILL.md` — in parallel and blind to each
   other, because a seat that sees another's findings confirms them instead of reading
   independently. A persona returns `## Readiness: READY | NEEDS_WORK | NOT_READY` as text, writes
   nothing and reports no cycle number; that line is not a verdict and never opens the gate. Its
   objections are input to the worker, exactly like a finding. No persona seat configured means no
   persona round — never simulate one.
4. **Ask once, then loop, capped at three rounds.** After the first review, and before any
   revision, the person answers every question in one sitting, in the shape of § A question to a
   person. The questions are each `Open` §9 row whose `Source` is a Prime guardrail, and each
   `Decision:` finding of a reviewer.
   - **Prepare the questions first.** Dispatch the engineer once, with every `Decision:` finding.
     For each one it returns its own proposal, as the four lines of a choice. It checks every
     choice against the decision records and the standards that the design cites, and it drops a
     choice that one of them forbids, naming the record. For an `Open` §9 row, the proposal is
     the choice that the design already takes. The proposal is choice a).
   - **Ask only what a person owns**: a value that an intended use of the feature can reach, a
     behaviour that a user sees, a risk to accept, or work for another role. A technical name or
     value is the engineer's, and it is no question. A finding on code that the story does not
     change is no question: the design names it as `not in this story` (step 2).
   - **Say the count first**: `<N> questions, then one confirmation`. `<N>` counts every question
     of the sitting. A question that comes later belongs to a new sitting, and you say why it is
     new before you ask it.
   - Check the person's own answer against the rule before you record it. Where it leaves a part
     of the rule unmet, name the part and ask again, as `Question <n> of <N>, again`.
   - The confirmation is one turn: *a) revise the design with these answers; b) I change one of
     them.*
   - Where there is no question, ask nothing, and say so in one line. Where the run has no runner, park every question: its row stays `Open` and blocking.

   Then the engineer revises the design once, with every finding of both reviewers and every
   answer, in the person's words with the role answered for. A `Fix:` finding needs no person: the
   engineer makes the change, and the change list names it. Both reviewers read the revision: this
   is round 2. A design with no finding and no question after the first review needs no second
   round.

   **Round 3 is a confirming pass.** Where round 2 ends with a finding, the engineer fixes those
   findings and changes nothing else. Each reviewer then reads the findings of round 2 and the
   lines that the fix changed, and nothing else. It raises a new finding only on a changed line.
   It raises no new question: a decision that appears in round 3 goes to the person at the cap.

   **At the cap, ask before you escalate.** Where round 3 ends with a finding, show the person
   each open finding in plain words, with the line of the design that it quotes. Then one turn:
   *a) one more fix and one more confirming pass, on these findings only; b) I answer or change
   something now; c) stop, and hand the design to the design approver.* Choice a) is granted once
   in a run. Where a finding is still open after it, ask the turn again with b) and c) only.
   Choice b) starts § Amending an open design in this session. Choice c) is outcome 3 of
   § Stopping condition, with `--asked left`. Where the run has no runner, it is outcome 3
   with `--asked absent`.

   On resubmission each reviewer reads only the delta plus what
   that change could plausibly have broken, and the worker submits an explicit change list:
   what changed, which finding each change addresses, and which findings were deliberately not
   addressed and why. The round count belongs to this command, not to the worker or the critic —
   an agent that tracks its own cap finds a reason why this attempt does not count.

   **Keep each revision that the critic reads, and hand in the diff.** The change list is the
   worker's own account of its work. Only a diff shows the critic a change that the list leaves
   out. Nothing is committed between rounds, so store each revision yourself:
   1. Before each critic dispatch, run `git hash-object -w docs/designs/<KEY>.lld.md`. The `-w`
      flag stores the design's bytes in the hub's object store. The printed value is the
      `Design revision:` that the critic records.
   2. On a resubmission, put the worker's change list in the dispatch. Below it, put the output of
      `git diff <revision the last review names> <new revision>`, under the heading
      `## Diff since the last review`.

   A request round is not a review round, and it is not one of the three rounds. Each review round
   has a cap of one request round, and this command holds that count beside the round count. A
   second `### REQUESTS` block in the same review round breaks the protocol. Stop the loop,
   report it to the person as an escalation, and do not dispatch the critic again. A commit that
   does not match, as the hand-in above says, also stops the loop.
5. **Open the design pull request.** Design, discovery map and review file only, committed in `.worktrees/<KEY>/hub`
   with `node scripts/harness-commit.mjs -m "docs(<KEY>): design"`. Where §9 has a row that is
   not `Closed` or `Withdrawn`, the description lists each one in plain words and then says, in
   plain words, how to answer them or change the design: run `/dev-spec <KEY>` again from this
   design's checkout, `.worktrees/<KEY>/hub`, with the answers or the changes; never edit the
   design by hand, because that unapproves it. Say the same once where §9 is `NONE`, for changes.
   Where §2 names security limits, the description lists each one under `### Security limits`:
   the rule, the limit, the criterion it sharpens and the role that accepted it.
   Where the security reviewer ran, check that the Prime folder holds `security-review-<round>.md`
   for each round of this run, and dispatch nothing again for it: a missing file is a stop that
   you report. The description carries the line `Security review: APPROVED at
   <design revision>, cycle <n>`. Below it, in a `<details>` block, it carries the table of the
   rules from the reviewer's last reply, word for word.
   The pull request's description ends with the watermark, the line `Generated-by: SHL Agentic Harness` on its own
   after the normal description (`.claude/rules/watermark.md`). Then stop.

### A question to a person

Every question that this command, `/dev-sprint` or the PR fixes ask about a rule has one shape. A
person who has not read the design answers it, without opening a file. The question loses no
fact: every identifier that the plain words leave out is in its last line.

**Write it for a tech lead who was not in the session.** In the title, the line, the consequence
and the choices, use the words of the feature and of its users. Use no section number, no record
or rule id, no line number, no status code, no file name and no function name there. Say "the
change log" and not its file. Say "the request is refused" and not its code. Where a term of the
code is needed, say in a few words what it does.

1. **A title in plain words**, as a question, with its place: `Question 2 of 4 · How often may
   one staff member undo a mark?`
2. **What it is about**, in one or two sentences: what the feature does today, or what the design
   plans, at the place that the question changes.
3. **The rule**, in one plain sentence, then Prime's own words, quoted.
4. **What happens if nothing changes**: the finding that Prime is likely to raise on the pull
   request, or the stop that follows. Say so where Prime raised this rule on this repository
   before, and how many times.
5. **The choices**, lettered. Each choice says four things, in a line each: what the system does,
   what a user of the feature sees, what it costs, and whether it adds a stop and who must then
   act. A value that the choice needs is inside the choice, never a second question.
6. **The last choices** are always these three: the person's own answer, *accept this for now, as
   <the role>* where the person can speak for the role that owns the risk, and to park the
   question for that role.
7. **For the record**, one last line: the rule's number and title, the row, the section and line
   of the design, each decision record and standard that a choice touches, and the status codes.

**An earlier answer comes first.** Where `prime-history.md` holds a person's answer to the
same question on the same code, choice a) is that answer, with its story and its date: *a) as
answered for `<KEY>` on `<date>`: `<the answer>`*. The other rules of the recommended choice
still hold for it.

**Choice a) is the recommended one, and "recommended" has one meaning.** It meets the rule. It
stays inside this story. It adds no stop. Among the choices that do all three, it changes least
for a user of the feature. The engineer designed it before the question was asked, and it breaks
no decision record and no standard that the design cites. Where no choice does all of this, mark
no choice as recommended, and say in one line what each choice lacks.

**A choice that adds a stop says so in its fourth line**, in these words: `This stops the run:
<who> must <do what> before the design can continue.` A change to a decision record, a standard
or a requirement is such a stop. Never offer it as if the person could grant it now.

One decision is one question. Where a person's own answer needs something that the session cannot
do, say which part, and offer the nearest answer that the session can build.

### Other escalations

These stops raise an escalation as a cap does, and then stop. Each is one call of
`node scripts/escalation.mjs raise --point <ID> --slug <SLUG> [--work-item <KEY>] --runner <forge login> --question "<the one question>" --by-seat sprint-orchestrator`
with the options in the last column. Print what the script prints first in the closing report. Exit
2 means the line did not reach the record: say so first, and carry the question in the report.
The sweep tells the people named in `governance/escalation-points.json` and asks again after the
wait of the path. A merge that waits at human gate 1 (dev-spec.merge) is not raised here: the sweep raises it when it is still open at the end of its working day.

| Point | When | Path | Options |
|---|---|---|---|
| dev-spec.blocking-clarification | a blocking clarification is still open when the command ends | decision owed | `--route-first "<role in Routed to>"` |
| dev-spec.open-question | a design open question stays in §9 | decision owed | `--route-first "<role in Routed to>"` |
| dev-spec.adr-draft | a decision wider than the work item is written as an ADR draft | decision owed | `--design docs/designs/<KEY>.adr-draft.md` |

## Gates it enforces

| Gate | Behaviour on failure |
|---|---|
| No implementation code in this phase | Refuse. If a source file changed, the phase has failed its charter |
| §4 carries exactly the work item's criteria, and every `Requirement` id is the one the work item's `Carries` column gives that criterion | Refuse. An id the work item does not give that criterion is one no requirement defines, or a real one against the wrong criterion, and the validation report would repeat it as fact; a dropped criterion is a requirement that stops being built |
| The design's `Repository:` line equals the story's, and the id is in the list | Refuse. A design that names a different repository from its story is the wrong-repository bug in writing, and the spoke's check would refuse the code later, more expensively |
| Every citation into the repository carries the commit it was read at | Refuse the citation. `<id>@<12-hex>:<path>` from the `Cite:` line, or it is not a citation |
| The design's `Rules:` line is the one `read-spoke-rules.mjs` printed, and every rule it selected is under §2 Read before implementing | Refuse. A typed `Rules:` line names rules nobody read; a selected rule missing from §2 is a convention the design was written blind to |
| The design's `Context:` line is the one `read-context.mjs` printed at the `Rules:` commit, its `Hub commit:` line is the one the same run printed, and every document it selected is under §2 Read before implementing by its path. It carries each id on the story's `Context:` line. Each document on it is used in the design, a standard by its rule ids, except an always-on document, which the script adds to every line | Refuse. The gate fails a document the design never names, a standard with no rule cited, an unlisted citation and a story document the design dropped. A typed `Context:` line names documents nobody read; a selected document missing from §2 is a contract or decision the design was written blind to, and one listed by id alone leaves the reader to find the file |
| Review file present, carrying `### VERDICT: APPROVED` and the revision of the design on the branch | Loop, or escalate at cap. A design amended after approval needs the round again — the gate will not take the old hash |
| Where step 1 wrote a guardrail list, the security reviewer's verdict on that same revision reads `APPROVED` | Loop, or escalate at cap. One `APPROVED` and one `CHANGES REQUESTED` is a blocked round, not a majority |
| Three-round cap on the design review | On cap: ask the runner (step 4). What is left raises the escalation with `escalation.mjs raise --point dev-spec.review-cap --asked left`, or `--asked absent`. Flag the work item, leave the design in its last reviewed state, stop |
| A re-run after a cap finds something changed upstream | Refuse, and print what `escalation.mjs resume` printed. A cap is never raised |
| Every blocking clarification row names a routing role | Refuse to open the pull request |
| No blocking clarification row is left `Open`, `Routed` or `Answered` | Do not open the pull request. Take the third outcome below |
| §8 readiness fields present exactly once, as pure tokens | Refuse. Formatting variants are rejected, not normalised |
| §5 covers every criterion in §4 with a named test, and cites none that §4 does not define | Refuse. The tables are the evidence; the declared counts are not |
| Every §1 citation resolves to the section and lines it names | Refuse. A citation that cannot be opened is not a citation |
| An absent rank-1 source is marked, not invented | Refuse a fabricated specification reference. The `UNRESOLVED` line is the only permitted form |
| An amendment starts only on the design's own branch, after `check-design-amend.mjs <KEY>` exits 0 and the person confirms which kind it is | Refuse, and print what the script printed. Never amend from the trunk. A merged design takes one change only: the record of its pull request's fixes (§ Amending a merged design) |

**`node scripts/check-dev-ready.js <KEY>` gives no early read in this phase, so do not treat one
as available.** The gate reads only the *trunk*, where this design does not yet exist: gate 1 finds
no design, and gates 3 and 4 — the readiness contract and the clarification table — then report
`skipped: no readable design document` rather than parsing anything. All four fail. Exit 0 is
impossible by construction, and that is correct.

The readiness block and the clarification table are therefore checked *in this phase* by the
critic, which re-derives both from §4, §5 and §9 rather than reading the declared tokens. The gate
checks them after human gate 1 has merged the design, and never before.

## The ordering constraint

**The pickup gate reads only the trunk, so the design must be merged before the gate can pass.**
A design that exists only on a feature branch fails every check the gate makes. The sequence is
`dev-spec` → human gate 1 merges the design → the gate runs against the trunk → `dev-sprint`.

Sequence the gate before the merge and you have built a check that can never exit zero. The
tempting local fix at that point — relaxing check 1 to read the feature branch — deletes the one
property the gate exists to establish: that a human has looked at this design and put it on the
trunk. A permanently red gate gets ignored or bypassed, and both outcomes are worse than not
having it.

So this command never grants `DEV READY`, never merges, and never runs the gate as an exit
condition. It ends in front of a human.

## Output

- `docs/designs/<KEY>.lld.md` on the feature branch.
- `docs/designs/<KEY>.discovery.md` beside it, pinned on the design's `Discovery:` line.
- `docs/designs/<KEY>.lld-review.md` carrying the verdict token.
- Where §9 is not `NONE`: every §9 row mirrored into `docs/designs/<KEY>.clar-log.md`, the
  clarification log of the work item, on the same branch, written by the orchestrator — the one
  seat with `Write` on that file. §9 is the copy the gate reads. The log is the copy the
  pre-merge check and the standing review read, and a row that exists only in §9 is invisible
  to both. The log is a file of the work item alone, so a design pull request changes no file
  that another design pull request changes.
- An open design pull request containing those files and nothing else.
- Where the design stopped on a decision for the lead architect: `docs/designs/<KEY>.adr-draft.md`
  on the pushed branch, deleted by the amendment that cites the record.
- The work item at `SPEC IN PROGRESS`, with the round count recorded.
- On cap, or on a blocking clarification that the person leaves open at the answer turn: an
  escalation raised with `escalation.mjs raise` (point dev-spec.review-cap on the cap, dev-spec.blocking-clarification on a blocking row), the
  blocking row mirrored into `docs/designs/<KEY>.clar-log.md`, the artefact's last reviewed commit,
  the deduplicated finding list from every round, and the specific question the human must answer.

## Stopping condition

Three outcomes, no fourth.

1. The verdict is `APPROVED` within the cap **and** no blocking clarification is open: the
   design pull request is open, and the command ends in front of human gate 1. Before it ends,
   run `node scripts/escalation.mjs resolve --work-item <KEY> --point dev-spec.review-cap --fact-kind verdict
   --fact-value APPROVED --round <n> --by-seat sprint-orchestrator`. It closes an escalation that
   an earlier cap opened, and it writes nothing where none is open.
2. **A blocking clarification is still `Open`, `Routed` or `Answered`.** Do not open the pull
   request. Leave the design and the review on the branch, flag the work item where it is —
   blocked is a flag, never a state — mirror the open rows into
   `docs/designs/<KEY>.clar-log.md`, and offer the person the answer turn below. Raise the escalation with
   `escalation.mjs raise --point dev-spec.blocking-clarification`, naming the role in `Routed to` with `--route-first`, only
   for the rows the person leaves open. This is the likeliest outcome of a first design on
   an unfamiliar codebase and it is not a failure; the alternative, writing `Blocking CLAR: 0`
   and `GATE_PASS` over an open row to reach a defined ending, is the fabrication this command
   exists to make unnecessary.
   `Answered` does not release the row: it means a human replied, not that the answer was
   written back into the design. The answer gets back in one way: an amendment (§ Amending an
   open design) writes the person's own words into the design and takes it through a fresh
   review. The person starts it in this session through the answer turn, or later by running
   this command again on the branch.
3. The cap was reached, and the runner was asked (step 4): raise the escalation,
   flag the work item, leave the design in its last reviewed state, stop. The call is `node
   scripts/escalation.mjs raise --point dev-spec.review-cap --asked <left|absent> --slug <SLUG>
   --work-item <KEY> --repository <id> --runner <forge login> --question "<the open finding, in
   plain words, with the line of the design that it quotes>"
   --parked-ref <the design's branch> --parked-commit <12 hex of the design commit the critic
   read> --design docs/designs/<KEY>.lld.md --findings-file <the deduplicated findings from every
   round> --by-seat sprint-orchestrator`. `--asked left` says that the runner chose to stop, and
   `--asked absent` that the run had no runner. The script refuses the call without it (exit
   1): ask first. Where an escalation of this point is already open on the work item, run
   `node scripts/escalation.mjs resume --work-item <KEY> --point dev-spec.review-cap --by-seat
   sprint-orchestrator` first, so that the new escalation takes its place. Exit 1 there means that
   the open escalation already covers this stop: raise nothing, and name it in the report. The
   call opens the escalation's `[shl-harness]` issue, and the
   design approver is the next person told. Print what it prints first in the closing report. Exit
   2 means the line did not reach the record: say so first, and carry the question and the
   findings in the report itself.

On outcomes 2 and 3, commit the design, the discovery map and the review, and the draft when there is one, with
`node scripts/harness-commit.mjs -m "docs(<KEY>): design, stopped"` and push the branch, but open
no pull request. A pushed branch is what an amendment starts from.

**The answer turn, on outcome 2.** The runner may be able to answer for the role
now. A restart costs them a second run and gains nothing, so ask in one turn after the push.
List each open blocking row in plain words, with the role it is routed to. A row whose `Source`
is a Prime guardrail takes the shape of § A question to a person. Then ask *a) I answer
now for <role> — amend the design in this session; b) leave the questions open for <role>, and
stop.*

- Skip the turn where every open blocking row links a draft. Such a row is answered only by a
  decision record on the hub trunk, and no answer in this session puts one there.
- Where the run has no runner, take b).
- On a), start § Amending an open design at step 1, on this checkout. Skip the confirm turn of
  § What it does: this run knows that no pull request is open. The amendment's own ending then
  applies, with its own three review rounds. Where the person leaves every row open and brings no
  change, the amendment writes nothing. Take b).
- On b), and for each row an amendment leaves open, raise the escalation with `node
  scripts/escalation.mjs raise --point dev-spec.blocking-clarification --slug <SLUG> --work-item <KEY> --runner <forge login>
  --question "<the row's question>" --route-first "<role in Routed to>" --by-seat
  sprint-orchestrator`, one call for each row, and stop. The record is the escalation's
  `[shl-harness]` issue in the hub, so the call commits nothing to the design's branch.

The escalation records a question that leaves the session, so raise none for a row the person
answers in it. The amendment's §9 `Resolution` names the role the person answered for.

The escalation says, in plain words, what the person must answer and how: run `/dev-spec <KEY>`
again from `.worktrees/<KEY>/hub` with the answer. Where there is a draft, it also names the
draft's path on the pushed branch, `docs/designs/<KEY>.adr-draft.md`, so the lead architect can
open it.

Reaching the cap is information, not failure. Two failed rounds on a design usually means the
input is ambiguous, and no further round resolves an ambiguity. Raising the cap makes it worse
and more expensive.

## Amending an open design — answers and changes before the merge

A person reading the design wants to answer a question in §9, or to change what the design says.
Merging a design they know is not finished is not what human gate 1 means. Editing it by hand
unapproves it: the review's `Design revision:` names the bytes the critic read, and `design-gate`
fails on one changed byte, as the pickup gate would after the merge. The way is this command
again, on the design's own branch. The run is an **amendment**. It ends in new commits on the same
branch, a fresh review and the same pull request — or, where the first run stopped before opening
one (outcome 2 or 3), the pull request it never opened. Then a person merges it, or does not.

1. **Start on the branch, and check it.** Work in `.worktrees/<KEY>/hub`. Where that checkout is
   gone — another machine, a removed worktree — make it again from the hub root, on the branch
   that already exists: `git fetch origin`, then `git worktree add .worktrees/<KEY>/hub
   feature/<KEY>-<BRANCH-SLUG>`, then `node scripts/harness-commit.mjs --install-hook
   ".worktrees/<KEY>/hub" --worktree`. Never § The hub checkout: it refuses a branch that exists,
   and it is right to. This phase has no code checkout. Run `node
   scripts/check-design-amend.mjs <KEY>`. It checks, with git alone, that the checkout is on the
   key's branch, clean and in step with the remote; that it carries the design and its review;
   and that nothing of it is on the trunk — neither the branch's tip nor a design for `<KEY>`,
   which is how a squash merge is caught. A non-zero exit is a refusal: print what it printed, and
   stop. Exit 0 prints the start commit and the design's hash; keep both. Then the confirm turn
   (§ What it does), except in an amendment that the answer turn started (§ Stopping condition).
2. **What the person brings.** Answers to §9 rows, and changes to the design. The runner answers for the role a row is routed to, as on every run, and the record names that
   role. A change is typed after the key, or is a pull request comment the person saved to a file
   and named there. This command never fetches a comment from the forge.

   **A change to *what* is wanted is not a design change.** The design says *how* the work item
   is met, in any way its sources allow. It may not say more than the work item and the
   requirements it cites. A change that needs a criterion the work item does not carry, or that
   contradicts the words of a cited requirement, stops in plain words, with the way: amend the
   requirements document first (`/feature`), then the decomposition, then come back — or record
   the question as a §9 row routed to the feature owner. For a story taken from a ticket, the way
   is the ticket: the PM changes it with `/enrich-ticket`, and `/from-ticket` takes it again. A security limit that a Prime guardrail
   requires and the product owner accepts is a design change (§ What it does, step 2). An answer that settles what an ambiguous
   requirement means is a design change, and is what §9 rows are for.

   **The test between the two.** A change is a reading when the design still meets every
   behaviour a criterion names, and keeps today's behaviour where the criterion names none. "All
   the user's questions" read as "all the questions the agent answers today" is a reading, and
   the writer records it as § What it does, step 2, says. A change is a change to what is
   wanted when the design would do something no criterion covers, or would drop a behaviour a
   criterion names. Only the second kind stops the amendment.
3. **The turns — one point per turn, in plain English.** First each change the person brought,
   read back in one or two sentences and confirmed. Then every §9 row that is not `Closed` or
   `Withdrawn`, oldest first: the question in plain words, what the design does about it today,
   and lettered choices with the suggestion as a) — usually what the design already assumes —
   the other options the row names, the person's own answer, and always one choice to leave it
   open. One more choice says the question no longer applies. A change or an answer that
   conflicts with a ranked source is a conflict turn: quote both, and the higher source wins
   unless the person stops to change it (`CLAUDE.md` §4). Last, one turn: anything else?
   Every turn has the shape of § A question to a person: plain words, the recommended choice as
   that section defines it, and the identifiers in the last line. Say the count of turns first.
4. **What the writer changes, and what it keeps.** Dispatch the `engineer` seat on the hub
   checkout with the answers and changes as text, word for word, and the design at the start
   commit.
   - An answered row: the answer is written into the design wherever it bears — §3, §4, §5, §7 —
     and the row moves to `Closed`, its `Resolution` the answer in one line, its `Resolved`
     today's date. `Closed`, not `Answered`: the answer came from a person and is written back in
     this run, and the critic checks that it landed.
   - A row that links a draft: answered when the decision's summary is on the hub trunk. The
     summary merged after the design's pinned commit, so the design's own checkout does not hold
     it. Read it from the hub root checkout, which must be on the trunk and clean:
     `git -C <hub root> branch --show-current` prints the trunk's name and `git -C <hub root>
     status --porcelain` prints nothing. Where either fails, stop and say so — the script reads
     the documents on disk, and a checkout on another branch or with local edits is not the
     trunk the gate compares with. Then bring it up to date (`git -C <hub root> pull --ff-only`).
     Where the record is on that trunk:
     1. Write the record's number into the design's §1 traceability table, which names records by
        id. The design now names it, so the script selects it.
     2. From the hub root checkout, run `node scripts/read-context.mjs <id> --at <commit> --design
        .worktrees/<KEY>/hub/docs/designs/<KEY>.lld.md`, with `<commit>` the spoke commit the
        `Rules:` line pins, and `--global <commit>` as in step 1 where the requirements document
        records a release. The script reads hub documents from the checkout it runs in, so the
        pin is of the trunk's bytes, which is what the gate compares. (`--names <record id>` is an
        alternative, but the design naming the record is what the gate reads.)
     3. Copy the printed `Context:` and `Hub commit:` lines into the design, together. The run
        re-pins every hub document on the line to today's trunk bytes, and names today's hub
        commit, which is what the gate compares; say so in the change list, so the critic does
        not read it as a change nobody asked for.
     4. Close the row, with the record's number in `Resolution`.
     5. Delete `docs/designs/<KEY>.adr-draft.md` in the same commit.

     Where the record is not on the refreshed trunk, the row stays open: say which record
     `/add-context --kind adr` should bring in.
   - A row that no longer applies: `Withdrawn`, the reason in `Resolution`. A row left open stays
     exactly as it was.
   - A change no row asked for: one row in §10, naming the role that asked for it and this
     amendment's stamp.
   - A new question a change raises: a new §9 row, the next number in its section, never a reused
     one.
   - No `AC-<n>` is renumbered or dropped; a deprecated criterion keeps its §5 row. §8 is
     re-derived from §4, §5 and §9, never edited to match.
   - The design keeps the commit it pinned, and a fact the change needs is read at that commit.
     Where §3.1 or §6 changes, run `read-spoke-rules.mjs` and `read-context.mjs` again at that
     commit and copy their lines (§ What it does, step 1). Reading the repository again at a newer commit is a
     change the person asks for by name; then every citation into it, the `Rules:` line and the
     `Context:` line are read again at the new commit, because a design describes one commit.
   - A change that adds a read or a search updates the discovery map. Then run
     `git hash-object docs/designs/<KEY>.discovery.md`, and copy its first 12 characters into the
     `Discovery:` line. Do both before the critic reads the design.

   - A dependency's design that is now merged: run the check of precondition 7 again, through
     the `gate-runner` seat. For each dependency it shows as done, read the design. Close each row that names
     that dependency, with the answer from its design. Run `read-spoke-rules.mjs` and
     `read-context.mjs` again, as in § What it does, step 1. Copy the new `Context:` and `Hub commit:`
     lines. Name this refresh in the change list, so the critic does not read it as a change nobody
     asked for.

   The orchestrator mirrors every changed or new §9 row into `docs/designs/<KEY>.clar-log.md` on
   the same branch: statuses updated in place, new rows appended, nothing deleted.
5. **The review starts again at round 1.** The cap is this run's three rounds, because an amendment
   is new input from a person, not another turn of an agent loop. Round 1 is a full review on
   fresh context: the review file it produces replaces the earlier one and vouches for every
   byte. Hand the critic the answers and changes word for word, and the output of `git diff
   <start commit> -- docs/designs/<KEY>.lld.md`, so it reads there first. The hand-in of the
   cited spoke files and the request round apply as in § What it does, steps 3 and 4. Round 1 is
   cycle 1, so its first reply is the mandatory Reach search. Persona seats, where
   configured, read round 1 as on a first run. A round 2 is delta only, and a round 3 is a
   confirming pass, as always. On cap:
   raise the escalation as outcome 3 says and push nothing — the branch keeps the design and review it had,
   which still agree — and say in the escalation that the edits are left uncommitted in the
   checkout.
6. **Commit, push to the same branch, and stop.** Commit with `node scripts/harness-commit.mjs -m
   "docs(<KEY>): design amendment <yyyymmdd_hhmm>"`, then push the branch. Never push with force:
   the earlier commits, the earlier review in the history and the reviewers' comments all stay.
   - A pull request is open: open no second one. Add to its description a section `### Amendment
     <yyyymmdd_hhmm>`, in plain words: who asked, by role; each question closed, with its answer;
     each change in one or two sentences; the questions still open; how many review rounds it
     took. The watermark stays the description's last line. `design-gate` runs again on the push.
   - No pull request yet: open it as § What it does, step 5, does, if outcome 1 now holds.
   - A blocking row is still open, an old one or one this run raised: outcome 2. Push all the
     same, so the reviewer sees it, and say so first in the description or the escalation;
     `design-gate` stays red until the row is `Closed` or `Withdrawn`, which is correct. The
     answer turn (§ Stopping condition) offers only the rows this run raised, because step 3
     already asked the person about every older row.

   Do not merge it.

## Amending a merged design — the record of a pull request's fixes

The fixes of the story's pull request settle findings of Prime Security. The runner answers a
question, the engineer chooses a value, or the security reviewer agrees with a refutation. The
next story of this repository reads the hub, so the merged design records those results. This is
the only change that a merged design takes. `.claude/skills/fix-pr-comments/SKILL.md` § The
design amendment starts it, when Prime's fixes are done and the runner said yes. It hands in
`record.md`: each entry with its ref, its guardrail as `Prime <g-number> <title>`, and its words.

1. **A branch of its own, cut from the trunk.** From the hub root: `git fetch origin`, then `git
   worktree add -b amendment/<KEY>-<yyyymmdd_hhmm> .worktrees/<KEY>/amend origin/<the hub's
   trunk>`, then `node scripts/harness-commit.mjs --install-hook ".worktrees/<KEY>/amend"
   --worktree`. The hub checkout of the run stays on its own branch. The new checkout must hold
   `docs/designs/<KEY>.lld.md` and its review, because the design is merged. Where it does not,
   stop and say so. Keep the trunk commit as the start commit.
2. **What the writer adds, and nothing else.** Dispatch the `engineer` seat on that checkout with
   `record.md` word for word and the design at the start commit. It adds one row for each entry:
   - **An answer of the runner:** a new row in §9 with the next number. `Source` is `Prime
     <g-number> <title>`, `Blocking` is `no`, `Routed to` is the role, and `Status` is `Closed`.
     `Resolution` holds the runner's words in quotation marks, the role, and `in the fixes of
     pull request #<n>`. `Resolved` is the date of the answer.
   - **A value or a control that a fix added, and a refuted finding:** a new row in §10 with the
     next number. Its decision opens `Prime <g-number> <title> — `. Then it says what the code
     does now, and who chose it: the engineer, or the runner for a role. `Why` names the fix
     commit, or the line that meets the rule.

   It changes no other section, no criterion and no existing row, except a count in §8 or §11
   that a new row changes. §3 to §7 state the design that a person merged, and the code review
   judged every fix against it. The orchestrator mirrors each new §9 row into
   `docs/designs/<KEY>.clar-log.md` on the same branch.
3. **One reader, on the difference.** Dispatch `dual-mode-critic` on fresh context with `Mode:
   lld-review`, the output of `git diff <start commit> -- docs/designs/<KEY>.lld.md`, `record.md`
   and the design whole. A critic approved the merged revision, and a person merged it. So the
   critic reads the added rows (`.claude/skills/review-artefact/SKILL.md` § The record of a pull
   request's fixes). It checks three things. Each row says what `record.md` says, word for word
   where a person spoke. No other line changed. Each row has the form of its section. Its review
   file replaces the earlier one and names the new revision. The cap is three rounds.
4. **Commit, push, and open the pull request.** `node scripts/harness-commit.mjs -m
   "docs(<KEY>): record the fixes of pull request #<n> <yyyymmdd_hhmm>"`. Push the branch, and
   open a pull request against the hub's trunk. Its description says in plain words where the
   record comes from, each answer with its role, each decision, and that no other line of the
   design changed. The watermark is its last line. `design-gate` runs on it. Then `git worktree
   remove .worktrees/<KEY>/amend`. Do not merge it: a person does.
5. **At the cap,** push nothing, and remove the checkout and its branch. Return the critic's last
   blocking finding to the fixes. Their summary names it, and it joins their one escalation.

The record never waits for the code's merge, and the code never waits for the record. Until a
person merges the amendment, the next design of this repository does not see its entries.

## Never

- Never write implementation code. Not a line, not a stub, not "just the interface".
- Never make or open a checkout of the repository the story names. The design seat holds one
  checkout, the hub's, and reads the repository through `scripts/read-spoke.mjs` so every fact
  carries its commit. `/dev-sprint` makes the code checkout.
- Never cut the hub checkout from a local trunk ref, a remembered trunk name or a branch that
  already exists. Ask the remote, fetch, and refuse a `feature/<KEY>-*` branch nobody handed you.
- Never put two table rows on one line, or a row with another cell count than its header.
  GitHub hides the extra cells, and the gate fails the row. Write a literal pipe in a cell as `\|`.
- Never type the `Repository:` line. It is copied from the story, and a story with none is a
  decomposition defect to report.
- Never type the `Rules:` line, and never read a rules folder any other way. It is copied from
  what `scripts/read-spoke-rules.mjs` printed at the pinned commit, and `none` is what the script
  says when the repository declares none — not what an author writes to skip the read.
- Never type the `Context:` line or the `Hub commit:` line. Both are copied, together, from what
  `scripts/read-context.mjs` printed for the draft, and `none` is what the script says when
  nothing binds.
- Never merge the design pull request. That is human gate 1.
- Never grant `DEV READY` or claim the pickup gate passed.
- Never widen the system to meet the words of a criterion. A criterion changes only the
  behaviour it names, and today's behaviour stays everywhere else (§ What it does, step 2).
- Never proceed past round three.
- Never edit a readiness token to match the prose. The gate derives its counts from §4 and §5,
  so editing the declaration changes nothing except the audit trail.
- Never resolve its own blocking clarification. A blocking row releases only at `Closed` or `Withdrawn`, and
  `Closed` means a human's answer was written back into the design — in an amendment, the
  person's own words, never an agent's guess at what they would say.
- Never amend a design by hand or from the trunk, and never push an amendment with force or
  open a second pull request for an open design. After its merge, a design changes only through
  § Amending a merged design, which adds rows and changes no other line.
- Never resolve a conflict between two sources silently. The higher source wins **and** the
  disagreement is logged as a clarification.
- Never renumber an acceptance criterion. Deprecate instead — and note that a deprecated
  criterion still needs a row in §5.
- Never let the critic edit the design, and never accept a verdict that is not one of the two
  exact tokens.

---
description: Check every decision record and standard of the hub, and every spoke's own record, against the global context repository at its newest release, with the critic seat, and print each conflict as CRITICAL and each copy as IMPORTANT. Changes nothing. With --connect <url>, connect a hub that has no global layer yet — the same check, the link file, and one pull request that lists every finding. Asks nothing. Merges nothing.
argument-hint: [--connect <url>] [--skip-repo <id>=<reason>]...
---

<!-- Part of the harness asset library c6f3b4427d58f7c3 (see VERSION.json) · 2026-10-22 -->

# `/check-global` · `/check-global --connect <url>`

**This file is a contract, not an integration.** It defines the procedure, the preconditions and
the stopping condition. The code host and the pull-request mechanism are yours. Nothing in this
command talks to a tracker.

**Purpose.** The global context repository holds the decision records, standards and exceptions
that bind every product. The Global Architecture Board (the Board) owns it, and a release tag makes
its documents binding. A hub that has `docs/estate/global.json` reads it. `CLAUDE.md` §4, rank 3,
sets the order: a hub's record narrows a global record and never overrides one, except inside an
exception that covers it. A spoke's own record narrows a global record in the same way. This
command finds the hub documents and the spoke records that break that order, and the ones that
only repeat a global document.

**Two forms.**

- `/check-global` checks a hub that already has a global layer. It prints its findings and
  changes nothing: no branch, no file, no commit. Run it when the scheduled report lists
  candidate conflicts, or before a feature moves to a newer release.
- `/check-global --connect <url>` connects a hub that has no global layer. It runs the same check
  against the newest release at `<url>`, writes `docs/estate/global.json`, and opens one hub pull
  request that lists every finding. A person merges it only when each `CRITICAL` finding has an
  outcome, so that no conflict reaches a feature unseen.

**Who runs it.** A person types it in the hub. The command dispatches one seat, the
`dual-mode-critic`, in `global-review` mode, on fresh context. No CI job runs this command, no gate
reads its output, and no model runs in CI because of it.

## Inputs

| Input | Form | Where it comes from |
|---|---|---|
| `--connect <url>` | The clone URL of the global context repository, `https://…` or `git@host:owner/repo.git`. **Never a credential**: a URL with a user name or a password in it is refused, because the URL goes into a committed file | The argument; absent for the check alone |
| `docs/estate/global.json` | The hub's link to the global repository: `schema_version` and `url`, and nothing else (`governance/global.schema.json`) | The check alone reads it. `--connect` writes it |
| `scripts/read-global.mjs` | `--resolve`: the newest release on the global trunk, `Global: vX.Y.Z <40-hex>`, or `Global: none` for a hub with no link. `--connect <url>`: the same release for a URL the hub does not link yet, after it refuses a credential and an existing link. It writes nothing | Installed with the hub |
| `scripts/read-context.mjs` | `--hub --global <commit>`: the index of the hub's documents and of every binding global document at that commit, global documents first, each with the prefix `global.`. With `--names`, those documents in full, each with a `Cite:` line. A global exception's block also carries one line of its header fields: `Hubs:`, `Departs:`, `Repositories:`, `Status:` and `Review-by:` | Installed with the hub |
| `--skip-repo <id>=<reason>` | Only when a listed spoke cannot be read: its id and the reason, in the person's words, for example `--skip-repo "sim-desktop=the repository is archived and read-only to this team"`. Repeat it for a second spoke. The spoke's own records are then not checked, and the output says so | The argument; absent by default |
| `docs/estate/repositories.json` | The hub's list of spokes. Each spoke may keep its own decision records, in the folder its `checks.env` names with `DECISIONS_INDEX` | `/add-repo` |
| `scripts/read-hubs.mjs` | `--repos <id>`: the hubs that a spoke's `HUBS` line names, on its trunk, as `hubs: [...]`. An exception covers a spoke's record only when it names each of them | Installed with the hub |
| The hub's key prefix | The `prefix` in `docs/backlog/keys.json`. An exception names a hub by it. A hub with no key ledger has no prefix, and no exception can name it | The hub's trunk |
| The critic | `.claude/agents/dual-mode-critic.md`, with `Mode: global-review` and the method in `.claude/skills/review-artefact/SKILL.md` § Review dimensions — `global-review` | Installed with the hub |

## Preconditions

All six. Preconditions 1 to 5 are checked before anything is read from a remote. The first read
of the global repository, step 1 or C1, proves precondition 6, before the critic runs.

1. The working directory is the hub root, on a clean checkout of the trunk. `--connect` cuts its
   own branch.
2. For the check alone: `docs/estate/global.json` exists. A hub without it has no global layer.
   Say so, name the form that connects one, `/check-global --connect <url>`, and stop. Change
   nothing.
3. For `--connect`: `docs/estate/global.json` does not exist. A hub that has it is connected
   already. Refuse, say that `/check-global` without `--connect` checks it, and stop. A move to
   another global repository is not this command's: it changes what every later feature reads,
   and it is a decision for the Board and the hub's lead architect.
4. For `--connect`: `<url>` carries no credential. `read-global.mjs --connect` refuses one before
   it asks any remote, and never prints the URL in the refusal.
5. For `--connect`: git has an identity in the hub. `git config user.name` and
   `git config user.email` each print a value, because C5 commits. When one prints nothing, stop
   before the critic runs, and name the one that is missing. Ask the person to set it and to run
   the command again:

       git config user.name "<your name>"
       git config user.email "<your email address>"

   Never choose an identity, and never set one for the person.
6. Git can authenticate to the host of the global repository: the URL in
   `docs/estate/global.json`, or `<url>` for `--connect`. `read-global.mjs` reads it with git
   only. When git has no credential for the host, the script exits 2 and says that git could not
   authenticate, with the URL. Stop, and print that message. The person gives git a credential
   and runs the command again:
   - on GitHub: `gh auth setup-git`, which makes the GitHub CLI's login git's credential helper
   - on another host: a git credential helper, or an SSH URL with a key the host accepts

   Never set a credential for the person, and never write one into a URL.

## What it does — the check

```bash
node scripts/read-global.mjs --resolve                                      # Global: vX.Y.Z <40-hex>, or stop
node scripts/read-context.mjs --hub --global <commit>                        # the index: global documents first, then the hub's
node scripts/read-context.mjs --hub --global <commit> --names <hub ids>,<global ids>   # every document below, in full
node scripts/read-context.mjs <id> --global <commit>                         # for each listed spoke: its own records in the index
node scripts/read-context.mjs <id> --global <commit> --names <id>.ADR-<NNN>,...   # a spoke with records: each in full
node scripts/read-hubs.mjs --repos <id>                                      # a spoke with records: the hubs that read them
# dispatch dual-mode-critic, Mode: global-review, with the text above; print its verdict and findings
```

Step by step, and what each step may and may not do.

1. **Resolve the release.** Run `read-global.mjs --resolve`. Take `<commit>`, the 40-hex, and
   `<tag>` from its last line.
   - `Global: none`: precondition 2 applies. Stop.
   - Exit 1 with `has no release tag`: nothing in the global repository binds yet, so nothing can
     conflict. Say so, and stop.
   - Any other exit 1: `docs/estate/global.json` is malformed. Stop, and name its findings.
   - Exit 2: the global repository does not answer, or git could not authenticate to its host
     (precondition 6). Stop, and print the message. The command never checks against a cache or
     an older release.
2. **Read the index.** Run `read-context.mjs --hub --global <commit>`. Exit 1 is a malformed
   document, in the hub or at the release: stop, and name the findings. Exit 2 is a stop.
3. **Select every document, by rule.** The hub's documents are every index line whose repository
   is `hub` and that is a decision record with the status `Accepted`, or a standard, `Active` or
   `Reserved`. A superseded or deprecated hub record binds nothing, so it is not checked. The
   global documents are every line whose id starts with `global.`: the index lists only the
   global documents that bind. Run `read-context.mjs --hub --global <commit> --names` with both
   lists. Never drop a selected document.
3a. **Read each spoke's own records.** For each id in `docs/estate/repositories.json` that no
   `--skip-repo` names, run `read-context.mjs <id> --global <commit>`. Its index lists the
   spoke's own records as `<id>.ADR-<NNN>`. Keep each one with the status `Accepted`.
   - A spoke whose index line says `Spoke records: NOT CONFIGURED` or `none declared` keeps no
     records. Go on.
   - For a spoke with one record or more, run `read-context.mjs <id> --global <commit> --names`
     with those ids, and `read-hubs.mjs --repos <id>`. Keep the spoke's records from the output,
     and the last line of `read-hubs.mjs`, `hubs: [...]`.
   - `read-hubs.mjs` exit 1 or 2: the spoke's hubs are not known. Go on. Hand the critic the line
     `Hubs of <id>: unknown`, with the script's finding. No exception can then cover that spoke's
     records, because nobody can prove that it names every hub of the spoke.
   - `read-context.mjs` exit 1 or 2 for a spoke: stop, and name the spoke and the finding. The
     person may run the command again with `--skip-repo "<id>=<reason>"`, in the person's own
     words. Never write the reason for the person.

   With no hub record, no hub standard and no spoke record, there is nothing to check: say so,
   and go to step 5 with no finding.
4. **Dispatch the critic.** Dispatch the `dual-mode-critic` seat on fresh context, with
   `Mode: global-review` and the method in `.claude/skills/review-artefact/SKILL.md`. The
   dispatch carries, as text:
   - every line `read-global.mjs` printed, the `Global:` line last
   - `Hub: <prefix>` from `docs/backlog/keys.json`, or `Hub: none` when the hub has no key ledger
   - the index from step 2
   - the output of step 3, every document in full with its `Cite:` line, and each global
     exception with its line of header fields
   - for each spoke from step 3a: its own records in full with their `Cite:` lines, and the line
     `Hubs of <id>: hubs: [...]`, or `Hubs of <id>: unknown` with the finding
   - one `Skipped: <id> — <reason>` line for each `--skip-repo`

   The seat reads its method in that skill first. It opens no hub or global document, because
   each one arrives as text, and runs no command. It reads an exception's header from its line of
   header fields, never with git. It asks two questions of each hub document, by the
   contradiction test in that skill, the same test `/add-context` applies to a new record (G1):
   does it contradict a global document, and does it repeat one? It returns its verdict in-loop,
   in one round:
   - `CRITICAL`: a hub record or standard rule contradicts a binding global record or global
     standard rule, and no `Active` exception that names this hub covers it. A spoke's own record
     that contradicts one is `CRITICAL` unless an exception names every hub of that spoke. A departure beyond
     the Scope of the exception it relies on is `CRITICAL` too.
   - `IMPORTANT`: a hub record repeats a global record, and its status becomes
     `Superseded by global.ADR-<NNN>`. A record repeats when it makes the same decision, in other
     words too, and when it adds detail. A hub standard rule that repeats a global rule is
     `IMPORTANT` too.

   When the seat hands back for an input, give it that input and dispatch it again. That is the
   same round, not a second one. Never edit a finding, and never drop one.
5. **Print the result.** Print the release, the number of hub documents and spoke records
   checked, the number of global documents read, every `Skipped:` line with its reason, the
   verdict, and every finding, `CRITICAL` first. With no finding,
   print that the hub's records and standards agree with the global layer at `<tag>`. After each
   `CRITICAL` finding, name the three outcomes a person chooses from:
   1. change the hub document
   2. request an exception: `/add-context --global --kind exception --departs global.<id> --owner <role>`
   3. supersede the hub record, when it states the global decision after all

   The check alone stops here. It wrote nothing.

## What it does — connect a hub

```bash
git config user.name; git config user.email                      # precondition 5: both print a value, or stop and ask
node scripts/read-global.mjs --connect <url>                     # the newest release at <url>; exit 0, or stop. Writes nothing
git checkout -b estate/connect-global
# write docs/estate/global.json: { "schema_version": 1, "url": "<url>" }
# the check, steps 1 to 4, on the branch
git ls-remote --heads origin 'refs/heads/requirements/*'           # the requirements branches that may be open
git add docs/estate/global.json
node scripts/harness-commit.mjs -m "chore(estate): connect the global context repository"
git push origin estate/connect-global
# open the pull request in the hub, its description ending with the watermark line
```

C1. **Read the release before anything is written.** Run `read-global.mjs --connect <url>`. It
    refuses a hub that has `docs/estate/global.json` and a URL with a credential, before it asks
    the remote. Then it resolves the newest release at `<url>`, as `--resolve` does, and counts
    the documents at its commit. Exit 0 lets the command go on. On exit 1, stop and print its
    finding: the hub is connected already, the URL carries a credential, the trunk carries no
    release tag, or the release holds no global document. Exit 2 is a stop: the repository does
    not answer, or git could not authenticate to its host (precondition 6). A stop here writes
    nothing.
C2. **Write the link.** Cut `estate/connect-global` from the trunk. Write
    `docs/estate/global.json` with two keys, in this order, and nothing else:

        {
          "schema_version": 1,
          "url": "<url>"
        }

    The file names no branch, tag or commit. Each feature records its own release.
C3. **Run the check, steps 1 to 4, on the branch.** Step 1 now reads the file that C2 wrote, so
    it proves the link as `requirements-gate` will read it. When its `Global:` line differs from
    the one C1 printed, the Board tagged a release in between. The check reads the line from step
    1, and the description says so. A stop in steps 1 to 4 deletes the branch and the file, and
    opens no pull request.
C4. **List the requirements branches.** Run
    `git ls-remote --heads origin 'refs/heads/requirements/*'`. Each branch may carry an open
    requirements pull request. From the merge on, `requirements-gate` reads the link on the
    trunk, and it fails a requirements document that records `Global: none` or no `Global:` line.
C5. **Commit.** Stage `docs/estate/global.json` alone, and commit with
    `node scripts/harness-commit.mjs -m "chore(estate): connect the global context repository"`.
    The commit carries that one file. Precondition 5 proved the git identity before the critic
    ran, so a missing identity never stops the command here.
C6. **Open the pull request, and stop.** Push `estate/connect-global` and open the pull request in
    the hub. The description carries, in this order:
    1. the URL, the release the check read, `Global: vX.Y.Z <40-hex>`, and the hub's prefix, or
       the sentence that the hub has no key prefix, so no exception can name it
    2. the number of hub documents and spoke records checked, the number of global documents
       read, and every `Skipped:` line with its reason, so the reviewer sees the check that did
       not run
    3. the verdict, and every finding under the heading `CRITICAL` or `IMPORTANT`, each with its
       location, the rule of each document, and its fix. With no finding, the sentence that the
       hub's records and standards agree with the global layer at that release
    4. the sentence `Merge only when each CRITICAL finding has an outcome: the hub record changes, the team requests an exception, or the hub record becomes Superseded by global.ADR-<NNN>.`
    5. the sentence `Features already open keep Global: none. The next /feature records the newest release tag.`
    6. each branch from C4, with the sentence `A requirements pull request that is still open when this merges fails requirements-gate until its document records a release: amend it with /feature, which moves it from Global: none to the newest release.`
       Without a branch, the sentence that no requirements branch is open
    7. the watermark line `Generated-by: SHL Agentic Harness`, alone, at the end

    Report the release, the verdict, the number of findings by severity, and the pull request.

### Other escalations

These stops raise an escalation as a cap does, and then stop. Each is one call of
`node scripts/escalation.mjs raise --point <ID> --slug <SLUG> [--work-item <KEY>] --runner <forge login> --question "<the one question>" --by-seat check-global`
with the options in the last column. Print what the script prints first in the closing report. Exit
2 means the line did not reach the record: say so first, and carry the question in the report.
The sweep tells the people named in `governance/escalation-points.json` and asks again after the
wait of the path. 

| Point | When | Path | Options |
|---|---|---|---|
| check-global.connect-findings | `--connect` finds `CRITICAL` findings | decision owed | none |
| check-global.open-requirements | a requirements pull request is open at connect time | decision owed | none |

## Gates it enforces

| Gate | Behaviour on failure |
|---|---|
| The check alone: `docs/estate/global.json` exists | Stop. Name `/check-global --connect <url>`. Change nothing |
| `--connect`: the hub has no `docs/estate/global.json` | Refuse. Name `/check-global` without `--connect` |
| `--connect`: the URL carries no credential | Refuse before any remote is asked. The refusal does not print the URL |
| `--connect`: `git config user.name` and `git config user.email` each print a value | Stop before any remote is asked. Name the missing one and ask the person to set it. Never choose one |
| `read-global.mjs` exits 0, with a release tag on the global trunk | Stop. Exit 1 with no release tag: nothing binds yet. Exit 1 otherwise: name the findings. Exit 2: the repository does not answer, or git could not authenticate to its host: print the message, which names the fix |
| `--connect`: the release holds at least one global document | Refuse. The URL names another kind of repository, or the Board has not seeded it |
| `read-context.mjs` exits 0 | Stop, and name the findings |
| Every `Accepted` hub record, every hub standard, every `Accepted` record of each spoke not skipped, and every global document the index lists is handed to the critic | Refuse to dispatch with fewer. A document left out is a document nobody checked |
| Every listed spoke is read, or skipped by `--skip-repo "<id>=<reason>"` with the person's reason | Stop on `read-context.mjs` exit 1 or 2 for a spoke, and name it. A skipped spoke and its reason go into the output |
| The verdict and every finding reach the output unchanged | Never edit, merge or drop a finding |
| `--connect`: the commit carries `docs/estate/global.json` alone, through `harness-commit.mjs` | Refuse to commit anything else |

## Output

- The check alone: the release, the counts, the verdict and every finding, printed. Nothing
  written.
- `--connect`: one file, `docs/estate/global.json`, on `estate/connect-global`, one pull request
  in the hub, and one line reporting the release, the verdict, the findings by severity and the
  pull request.

## Stopping condition

The check alone: the findings are printed. Then stop.

`--connect`: the pull request is open. Then stop. Do not merge it. Do not fix a finding in the
same pull request: each outcome is its own pull request, or an exception the Board approves.

## Never

- Never write, edit or commit anything in the check alone.
- Never fix a finding. A changed hub record is a hub pull request. An exception is the Board's.
  A superseded record is a one-line change in a hub pull request.
- Never check against a cache, an older release or the global trunk. The newest release tag is
  what the next feature reads.
- Never write a credential into `docs/estate/global.json`, and never print a URL that carries one.
- Never write a branch, a tag or a commit into `docs/estate/global.json`.
- Never choose or set a git identity or a git credential. Ask the person.
- Never connect a hub that has a global layer already, and never replace its URL.
- Never write the reason for a `--skip-repo`. It is the person's, word for word.
- Never drop a hub document, a spoke record or a global document from the hand-in. The selection is a rule, not
  a judgement.
- Never move an open feature to the newest release. Its requirements move only through an
  amendment that a person approves.
- Never merge the pull request.

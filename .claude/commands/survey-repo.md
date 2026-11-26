---
description: Survey one listed repository at its trunk head — what it serves, what it calls, its data stores and libraries — prove every pointer, and open the hub pull request that adds or refreshes docs/estate/surveys/<ID>.md. Asks nothing. Merges nothing.
argument-hint: <ID> [--full] | --missing
---

<!-- Part of the harness asset library c6f3b4427d58f7c3 (see VERSION.json) · 2026-09-28 -->

# `/survey-repo <ID> [--full]` · `/survey-repo --missing`

**This file is a contract, not an integration.** It defines the procedure, the preconditions and
the stopping condition. The code host and the pull-request mechanism are yours. Nothing in this
command talks to a tracker, and nothing in it writes to the repository it surveys.

**Purpose.** Write one repository's service survey into the hub: what it serves, what it calls
and in which repository or at which third party's host, which data stores it touches and which
libraries it uses, shared inside the estate or a third party's, every
row keyed in the grammar `.claude/skills/survey-repo/SKILL.md` gives and pointed at the lines it
rests on, at one pinned commit. Run once per repository, after `/add-repo` — for an estate
onboarding many repositories, once every one is listed, with `--missing`. Run again when a
person decides the survey is stale; the drift a reader sees says when. A survey points and is
never cited: `/decompose` uses the surveys to find every repository that reads a contract it
changes, then reads each at a pinned commit and cites that read (`.claude/rules/estate.md` §5).

**Who runs it.** A person types it in the hub. It dispatches the seat `service-surveyor` once for
each part of the plan, and once before them for the fact sheet when the plan has fact files. Each seat holds a disposable clone of the repository and nothing else. It
writes nothing, and returns one part or the fact sheet in-loop. This command writes each return to a file, joins the
parts with a script, runs the check, and opens the pull request.

## Inputs

| Input | Form | Where it comes from |
|---|---|---|
| `<ID>` | A key in `docs/estate/repositories.json` | The argument |
| `--full` | Survey the whole repository even where a survey exists | The argument; off by default |
| `--missing` | Survey, one after another, every listed repository with no survey on the hub's trunk | The argument, second form |
| `<URL>` | The clone URL the list holds for `<ID>` | `docs/estate/repositories.json` |
| `<SPOKE-TRUNK>`, `<C>` | The repository's harness trunk and its head commit, as the `Trunk:` and `Commit:` lines of `node scripts/read-spoke.mjs <ID> .` print them now. The script applies the trunk rule to the entry's `trunk`: `default` is the remote's default branch, a declared branch must exist, and `TRUNK_FOR_HUB` on it must agree | Read through the registry. `<C>` is written as the survey's `commit` |
| The previous survey | `docs/estate/surveys/<ID>.md` on the hub's trunk, where one exists | An earlier run of this command |
| The template | `docs/estate/_TEMPLATE.survey.md` | Installed with the hub |
| `<PARTS>` | A temporary directory of its own, outside the hub and not beside the clone, made with a random name. It holds `plan.json`, `carried.md` on a delta, `facts.md` and one `facts.<part id>.md` for each part when the plan has fact files, and one file for each part. A seat holds `<TMP>` only, so it cannot find the return of another part by a path beside its clone | Written by `plan-survey.mjs` and this command. Deleted with the clone |
| `scripts/plan-survey.mjs` | The plan of the parts: full, delta, and the split of one part into two halves. It leaves out the files that the rule table in `scripts/surveys.mjs` matches | Installed with the hub |
| `scripts/join-survey.mjs` | The join of the parts into one survey, with section 7 (Not read), and the count lines for the pull request. With `--check`, the form check of one part | Installed with the hub |
| `scripts/check-survey.mjs` | The shape check and the pointer proof | Installed with the hub |
| `scripts/check-survey-secrets.mjs` | The Docker preflight, and the Gitleaks scan of the files at `<C>` against the repository's `.gitleaksignore` at `<C>` | Installed with the hub |

## Preconditions

All four, checked before anything is written.

1. The working directory is the hub root, on a clean checkout of the trunk. This command cuts its
   own branch.
2. `<ID>` is a key in the list, and `node scripts/check-registry.mjs --offline` exits 0. A
   repository the list does not carry is not surveyed; `/add-repo` comes first.
3. `node scripts/read-spoke.mjs <ID> .` exits 0 and names `<SPOKE-TRUNK>` and `<C>`. An unreachable
   remote, a declared trunk that is missing or a `TRUNK_FOR_HUB` that disagrees is a stop:
   nothing about the repository is known, so nothing is written.
4. No open pull request in the hub already carries `estate/survey-<ID>`. Two surveys of one
   repository in flight is two answers to one question.

## What it does

```bash
node scripts/check-survey-secrets.mjs --ensure-image                # Docker preflight: exit 0, or stop
node scripts/read-spoke.mjs <ID> .                                  # Trunk: <SPOKE-TRUNK>, Commit: <C>; or stop
git clone --quiet --single-branch --branch <SPOKE-TRUNK> --no-tags <URL> <TMP>  # read-only, disposable, the whole trunk history
node scripts/check-survey-secrets.mjs --clone <TMP> --commit <C>    # Gitleaks scan: exit 0, or stop
# full: no survey on the trunk, or --full is given
node scripts/plan-survey.mjs --id <ID> --clone <TMP> --commit <C> --out <PARTS>
# refresh: a survey on the trunk, and no --full
OLD=<commit: from docs/estate/surveys/<ID>.md>
git -C <TMP> fetch --quiet origin <OLD>                             # a refused fetch is not a stop
node scripts/plan-survey.mjs --id <ID> --clone <TMP> --commit <C> --out <PARTS> --previous docs/estate/surveys/<ID>.md --since <OLD>
git -C <TMP> diff --name-status --no-renames <OLD> <C>              # on a delta plan: the name-status list for the seat
# when plan.json has facts: dispatch service-surveyor for the fact sheet, and write its return to <PARTS>/facts.md
node scripts/plan-survey.mjs --id <ID> --clone <TMP> --commit <C> --out <PARTS> --check-facts   # FACTS OK:, or exit 1 as step 4 says
node scripts/plan-survey.mjs --id <ID> --clone <TMP> --commit <C> --out <PARTS> --facts-for <part id>  # the sheet of one part
# for each part in <PARTS>/plan.json: dispatch service-surveyor, and write its return to <PARTS>/<part id>.md
node scripts/join-survey.mjs --check <PARTS>/<part id>.md          # PART OK:, or exit 1: the findings go back to the same seat, as step 4 says
node scripts/plan-survey.mjs --id <ID> --clone <TMP> --commit <C> --out <PARTS> --split <part id>  # a part too long for one reply
node scripts/join-survey.mjs --parts <PARTS> --out docs/estate/surveys/<ID>.md  # JOINED: and the count lines, or exit 1 as step 5 says
git checkout -b estate/survey-<ID>
git add docs/estate/surveys/<ID>.md
node scripts/harness-commit.mjs -m "docs(estate): survey <ID>"
node scripts/check-survey.mjs <ID>                                  # exit 0, or stop
# push, and open the pull request in the hub, its description ending with the watermark line. Delete <TMP> and <PARTS>
```

Step by step, and what each step may and may not do.

1. **Clone at the trunk head.** Before the clone, run `node scripts/check-survey-secrets.mjs --ensure-image`.
   On exit 2, stop. Print its `REASON:` line. Tell the person to install Docker, to start it, or to
   run the command again. Without the scan, the survey cannot continue. The clone lands in a temporary directory outside the hub, is never
   pushed, and is deleted before this command stops. Nothing is cloned into `.worktrees/`. Confirm
   `git -C <TMP> rev-parse HEAD` is `<C>`. The clone holds the whole history of the trunk. Give no
   `--depth` to the clone or to a fetch into it: the scan refuses a shallow clone, because it needs
   the history to match a commit entry.
2. **Scan the clone with Gitleaks.** Run
   `node scripts/check-survey-secrets.mjs --clone <TMP> --commit <C>` before the seat starts. The
   scan runs in Docker, with the rules of the hub and no network. It reads `.gitleaksignore` from
   git at `<C>`. The file is optional. Two kinds of entry accept a finding:
   - A file entry `<path>:<rule>:<line>` accepts the finding at that path and line, for that rule.
   - A commit entry `<commit>:<path>:<rule>:<line>` accepts the finding when `git blame` at `<C>`
     gives every line of it to `<commit>`, and `<path>` and `<line>` are where that commit has the
     first line. This is the fingerprint that the spoke's own Gitleaks scan of the history writes.
     It still matches after the file moves. A line edited after `<commit>` blames to a newer
     commit, so the entry does not match it.

   A rule that matches a path alone reports line 0, and the entry for it ends in `:0`. A finding
   inside an archive has the path `<archive>!<path inside>`. Only a file entry accepts these two,
   because they have no lines to blame. An inline `gitleaks:allow` comment accepts nothing.
   - Exit 0: no finding, or every finding is accepted. Keep the `.gitleaksignore:` line, the
     `gitleaks` line, each `note:` line and each `[ACCEPTED]` line for the pull request.
   - Exit 1: a `[LIVE]` line is an incident. Report it the same day. Stop with no pull request.
     Do not dispatch the seat. Report the `[LIVE]` locations and the `note:` lines to the security
     role, by location only.
   - Exit 2: the scan could not verify. Print its output and stop. Two exit 2 outputs have a
     retry: the clone is not at `<C>`, or the clone is shallow. Then delete the clone and clone it
     again, once, with the command above. Run the scan again on the new clone.
3. **Plan the parts.** With no survey on the trunk, or with `--full`, run the full plan. Otherwise
   fetch `<OLD>` into the clone. Then run the plan with `--previous` and `--since`. A fetch that
   the server refuses is not a stop. Never pass `--budget`. It exists for the fixture suites. The
   script reads the files at `<C>` out of git. It leaves out the files that the rule table in
   `scripts/surveys.mjs` matches. It lists them under `excluded` in `plan.json`, and it prints a
   `Package:` line for each folder that directly holds a licence document, and an `Excluded:`
   line. It cuts the other files into parts, and writes `<PARTS>/plan.json`.
   - Show every `Package:` line to the person before you dispatch a part. Say that the survey
     leaves each of those folders out as a vendored package.
   - The plan exits 2 when the clone is not at `<C>`. Exit 0 proves the commit of the clone, so
     no seat checks it.
   - The plan prints a `Large file:` line for each file above the budget, with its bytes and its
     part. Show these lines to the person before you dispatch a part. The part of a large file is
     still dispatched. The line changes nothing in the plan.
   - The plan also prints a `Manifest:` line for each manifest that a library row can point at,
     and a `Not a manifest:` line for each other dependency list, each with its reason.
     `plan.json` holds them as `manifests` and `notManifests`. Show these lines to the person
     before you dispatch a part. A wrong match is then visible before the paid dispatch.
   - A delta plan also looks again at every library row with a pointer to a file that is not in
     `manifests`, even when the file did not change.
   - The plan of a refresh is full in each of these cases. The `Mode:` line gives the reason.
     - The previous survey has a finding.
     - The previous survey names another repository.
     - The template of the previous survey is not the current template.
     - The commit of the previous survey is not `<OLD>`.
     - `<OLD>` is not in the clone.
   - A delta plan carries every row whose evidence names no changed or deleted file. The script
     re-pins those rows at `<C>` and writes them to `<PARTS>/carried.md`. This command edits no
     row. The rows to look at again are under `rows` in each part of `plan.json`.
   - Each part in `plan.json` has `files`: every file of the part, with its bytes, sorted by
     path. The list holds no excluded file and no binary file. `paths` names the same files as
     folders and files.
   - The plan prints the fact files: a `Fact file:` line for each file of `facts` in `plan.json`,
     a `Fact file left out:` line for each file that does not fit the budget, and a `Facts:`
     line. A plan of fewer than two parts has no fact file. Show these lines to the person before
     you dispatch a part.
   - Keep the `Mode:` line, the `Facts:` line, and on a delta the `Carried:` and `Look again:`
     lines, for the pull request.
   - A full plan has no part when the rule table matches every file. The join then writes a survey
     with empty sections and a section 7.
   - Exit 2: the clone is not at `<C>`, or the clone or the previous survey cannot be read. Print
     the output and stop. Exit 3 and exit 4 are a stop too.
4. **Write the fact sheet, then dispatch `service-surveyor` once for each part** in `plan.json`.
   Each part seat in a large repository reads the same configuration, constants, router and HTTP
   helper. The fact sheet reads them once.
   - When `facts` in `plan.json` is not empty, dispatch `service-surveyor` for the fact sheet
     before any part. Give it `<ID>`, `<C>`, the path `<TMP>` and the paths of `facts` with their
     bytes. It returns the sheet that `.claude/skills/survey-repo/SKILL.md` § The fact sheet
     gives. Write the return word for word to `<PARTS>/facts.md`. The join does not read it.
   - Check the sheet before any part starts:
     `node scripts/plan-survey.mjs --id <ID> --clone <TMP> --commit <C> --out <PARTS> --check-facts`.
     Every part seat copies the names of the sheet. A wrong sheet would give every part the same
     wrong row, and the join would see no conflict. The check gives the form findings, and proves
     every pointer of the sheet against the clone at `<C>`. It cannot see whether a true pointer
     carries a wrong name. The person who merges reads that.
     - Exit 0 prints `FACTS OK: <n> row(s)`. Dispatch the parts with the sheet.
     - Exit 1 prints one line for each finding. Send every finding line to the same seat while it
       is open, or dispatch the sheet once more with its findings where the runtime cannot
       continue a seat. Write the new return over `<PARTS>/facts.md`, and check again. A second
       exit 1: delete `<PARTS>/facts.md`, dispatch the parts with no sheet, and write
       `Fact sheet: none (<n> finding(s))` in the pull request.
     - Exit 2, 3 or 4 is a stop with no pull request. Print the output.
   - The fact sheet seat escalates as a part seat does. A repository with no code is a stop with
     no pull request. On any other escalation, dispatch
     the parts with no sheet, and write `Fact sheet: none (<the escalation>)` in the pull request.
   - When `facts` is empty, dispatch the parts with no sheet.

   When the sheet passed its check, cut it for each part before you dispatch that part:
   `node scripts/plan-survey.mjs --id <ID> --clone <TMP> --commit <C> --out <PARTS> --facts-for <part id>`.
   The script writes `<PARTS>/facts.<part id>.md`: the Stores and Routes sections whole, and each
   property and helper row that the files of the part name or that points into them. It prints
   `FACTS FOR: <part id> <kept> of <n> property and helper row(s)`. Exit 1 or 2 is a stop with no
   pull request. Print the output.

   Give each part dispatch `<ID>`,
   `<C>`, the path `<TMP>`, the template, the part id, the part's `files` with their bytes, the
   paths of `manifests`, the text of `<PARTS>/facts.<part id>.md` when it exists, and the id and
   the purpose of each repository in `docs/estate/repositories.json`. The seat then needs no
   folder walk to find the files of its part, no read to find the names the sheet gives, and no
   read outside the clone to name a provider.

   On a delta, also
   give it the part's `rows` and the name-status list. The seat holds `<TMP>` and nothing else. It
   names no credential. It returns one part and a summary under 2,000 tokens. The dispatches can
   run at the same time. Their order does not change the survey.
   - Write each return word for word to `<PARTS>/<part id>.md`. The file is the seat's return,
     not an edit of it.
   - Keep the `## Secrets` block of each summary, with its part id, for step 7. The block lists
     the location of each secret that the seat saw: path, lines and kind, never the value.
   - Check each part when its return is written:
     `node scripts/join-survey.mjs --check <PARTS>/<part id>.md`. The check gives the form
     findings of the one part, in the form of the join. It also gives each call to itself that
     the part's own Serves rows show. It writes nothing.
     - Exit 0 prints `PART OK: <part id>`. The part is ready for the join.
     - Exit 1 prints one line for each finding. Send every finding line to the same seat, in
       the same dispatch, while the seat is open. The seat keeps its context, so the fix costs
       no new dispatch. Write its new return over `<PARTS>/<part id>.md`, and check again. Do
       this at most two times for one part.
     - A runtime that cannot continue a seat skips the send. Step 5 then dispatches the part once
       more with its findings, as for any form finding of the join.
     - Exit 2, 3 or 4 is a stop with no pull request. Print the output.
   - A part too long for one reply: run `plan-survey.mjs` with `--split <part id>`. The script
     cuts the part into `<part id>.1` and `<part id>.2` in `plan.json`. Dispatch each half. Answer
     a half that is too long in the same way.
   - Exit 1 from `--split` is a stop with no pull request. The report quotes the line the script
     printed. The line is one of these two:
     - `<part id> is one file and cannot split: <path>`. The part is one file, and the line names
       it.
     - `<part id> has no file to split`. The part of a delta plan holds only rows to look at
       again, and their evidence files were all deleted.
   - Any other escalation is a stop with no pull request: a repository with no code. The report
     says so.
   - A plan with no part skips this step. The join then writes the survey from `carried.md`, or
     an empty survey where there is no `carried.md`.
5. **Join the parts.** Run `join-survey.mjs`. It checks each part, merges the rows of one section
   that have one key. It writes section 7 from `excluded`. It writes `docs/estate/surveys/<ID>.md`
   only on exit 0. Keep the `JOINED:` line and the eight count lines after it for the pull request.
   Keep each `note:` line too. A note changes no exit code:
   - `note: 1. Serves <key>: kept the What of <part id>, ...`: two parts describe one route in
     other words. The join keeps the words of the first part.
   - `note: store keys <a> and <b> may name one store`: a literal name and a property in braces
     of one engine, where the property holds the name as a word. The join cannot see the value.
   - Exit 1 prints one line for each finding. Answer each finding of the first exit 1 by its form:
     - `conflict <section> <key>: ...`: two parts give one call different providers, or one
       library in both library sections. Dispatch the seat
       once more, for the part `R`. Give it every conflict line, and the row of that key from each
       part file the line names. Write its return to `<PARTS>/R.md`.
     - `<part id>: <finding>`: a form finding in that part that the check of step 4 did not
       clear, or a call to a key that only another part serves. Dispatch that part once more, with its findings. Write its return over
       `<PARTS>/<part id>.md`.
     - A finding line that starts with `carried:` or `joined:` has no seat to answer it. Stop with
       no pull request. The report names `--full`, because a full plan carries no row.

     Then run the join again. A second exit 1 is a stop with no pull request. The report lists the
     findings.
   - Exit 2 with `<part id>.md is missing`: dispatch that part. Then run the join again. Any
     other exit 2, and exit 3 or exit 4, is a stop.
6. **Commit, then prove.** `node scripts/check-survey.mjs <ID>` reads the committed survey out of
   git, checks its shape, and proves every pointer against the repository at `<C>`. Exit 1 is a
   stop: print the findings. One more dispatch is allowed for each part that gave a row or an open
   point with a finding. Find that part from the start of the finding:
   - `docs/estate/surveys/<ID>.md L<n>:` names a line of the survey. The part is the file in
     `<PARTS>` that holds the same row: the same key in the same section, or the same open point.
   - `<ID>@<12>:<path> L<a>-<b>:` names a pointer. The part is the file in `<PARTS>` that holds
     that pointer.
   - A finding that names neither, or names only `carried.md`, is a stop and a report.

   Give each part its findings. Then run step 5, the commit and this check again. A second failure
   is a stop and a report. Exit 2 is a repository that stopped answering. Try again later.
7. **Open the pull request in the hub.** The pull request's description ends with the watermark, the line `Generated-by: SHL Agentic Harness`
   on its own after the normal description (`.claude/rules/watermark.md`). The branch is
   `estate/survey-<ID>`. The commit is `docs(estate): survey <ID>`. It carries the survey and
   nothing else. Its description names the trunk and `<C>`. With `--full`, it states
   `Mode: full (the person asked for a full survey)`, and does not copy the reason of the plan.
   Without `--full`, it copies the `Mode:` line of the plan, and on a delta the `Carried:` and
   `Look again:` lines. In both cases it copies the `Facts:` line of the plan, and the
   `Fact sheet: none` line where step 4 wrote one. It copies the `JOINED:` line, which gives the number of parts,
   and the eight count lines after it, the `Not read:` line among them, and each `note:` line of
   the join, for the person who merges. It quotes the `[PASS] <ID>` line the check printed. Under
   **For the security role:**, it quotes the `.gitleaksignore:` line,
   the `gitleaks` line and each `note:` line, and lists every `[ACCEPTED]` location apart, marked "accepted by
   `.gitleaksignore`", with the entry that accepts it. The list has the path, the line and the
   rule, never the value. Where the scan found nothing, it says so.
   Then it lists each location of the `## Secrets` blocks of step 4, once, with the part ids
   that report it and the kind. A location that no `[ACCEPTED]` line names, at the same path and
   a line inside its range, is marked "not found by Gitleaks". The scan passed without it, so the
   security role reads it first. Where no seat reported a location, it says so. Then stop.

## What it does — every listed repository with no survey

`--missing` lists the ids in `docs/estate/repositories.json` that have no
`docs/estate/surveys/<ID>.md` on the hub's trunk, in id order, and runs the procedure above for
each in turn, from a clean trunk each time. Each repository has one clone, one plan, one seat for
each part, one branch `estate/survey-<ID>` and **one pull request**. The pull requests touch one
file each, so they merge in any order and never conflict. A repository that stops is reported and
skipped, and the next one is surveyed. A stop is any step above that ends with no pull request.
The table of gates below lists them. The report ends with one line per id: the pull request
opened, or why not. Run it again to survey the ones that stopped.

### Other escalations

These stops raise an escalation as a cap does, and then stop. Each is one call of
`node scripts/escalation.mjs raise --point <ID> --slug <SLUG> [--work-item <KEY>] --runner <forge login> --question "<the one question>" --by-seat survey-repo`
with the options in the last column. Print what the script prints first in the closing report. Exit
2 means the line did not reach the record: say so first, and carry the question in the report.
The sweep tells the people named in `governance/escalation-points.json` and asks again after the
wait of the path.

| Point | When | Path | Options |
|---|---|---|---|
| survey-repo.stopped | a survey finds a credential in the code | incident | no `--findings-file`: the record holds where it is, as a path and a commit |
| survey-repo.stopped | a survey is too long for one reply | check cannot run | `--path check-cannot-run` |

## Gates it enforces

| Gate | Behaviour on failure |
|---|---|
| `<ID>` is listed and the list is well formed | Refuse before any network call; name `/add-repo` |
| Remote answers and names a default branch | Refuse. Nothing is written. Cannot verify, not verified and wrong |
| The clone is at `<C>` | Refuse. Delete the clone; run again |
| `plan-survey.mjs` exits 0 | Exit 2, 3 or 4: print the output and stop with no pull request |
| The fact sheet seat returned a sheet, not an escalation | A clone that is not at `<C>`, or a repository with no code: stop with no pull request. Any other escalation: dispatch the parts with no sheet, and say so in the pull request |
| `plan-survey.mjs --check-facts` exits 0 | Exit 1: send the findings to the sheet seat once. A second exit 1: delete the sheet, dispatch the parts with no sheet, and say so in the pull request. Exit 2, 3 or 4: print the output and stop with no pull request |
| Each seat returned a part, not an escalation | A part too long for one reply: split it with `--split`, and dispatch each half. A part that `--split` cannot split (exit 1): stop with no pull request, and quote the line the script printed. Any other escalation: stop with no pull request, and report it as the seat gave it |
| `join-survey.mjs --check` exits 0 for each part | Exit 1: send the findings to the same seat while it is open, at most two times for one part. A runtime that cannot continue a seat leaves the findings to the join. Exit 2, 3 or 4: print the output and stop with no pull request |
| `join-survey.mjs` exits 0 | Exit 1: one more dispatch for each part with a finding, and one for part `R` where a key is a conflict. Then join again. A finding line that starts with `carried:` or `joined:` is a stop with no pull request, and the report names `--full`. A second exit 1 is a stop with no pull request, and the report lists the findings. Exit 2 for a missing part: dispatch that part, and join again |
| `check-survey-secrets.mjs` exits 0: Gitleaks finds nothing, or `.gitleaksignore` at `<C>` accepts every finding | A `[LIVE]` location is an incident: stop with no pull request, before the seat, and report it by location. Exit 2: print the output and stop. A clone that is not at `<C>`, or is shallow, is cloned again once |
| `check-survey.mjs <ID>` exits 0 | Refuse to open the pull request. Print its findings. Dispatch each part that gave a finding once more. Then join, commit and check again. A second failure is a stop |
| No secret in the survey | The check refuses the shapes it knows; the seat never writes one; accepted locations go to the security role in the description |

## Output

- `docs/estate/surveys/<ID>.md`, added or replaced.
- One pull request in the hub, on `estate/survey-<ID>`; with `--missing`, one per repository
  surveyed.
- One line reporting the id, the trunk and `<C>`, full or delta, the number of parts, the counts
  of the join, and the `[PASS] <ID>` line the check printed.
- The last line printed: `After this pull request merges, run /estate-overview-refresh.`

## Stopping condition

The pull request is open, and the temporary clone and `<PARTS>` are gone. Then stop. Do not merge.

## Never

- Never ask a question. Everything this command needs is in the list, the remote and the clone.
- Never write to the repository being surveyed. Read-only clone, deleted after.
- Never leave the clone or `<PARTS>` behind. Delete both before every stop, with a pull request or
  without one.
- Never survey a repository the list does not carry, or put two surveys in one pull request.
- Never edit a part that the seat returns before writing it. The script re-pins the carried
  rows, so this command edits no row.
- Never write a secret, a masked secret or anything from an `.env` file into the survey or the
  pull request. Locations only, for the security role.
- Never add a date, an author or a section to the survey. The commit dates it.
- Never cite a survey, and never let one rule a repository out. It points; the code decides.
- Never merge the pull request.

---
description: Tell the hub about one repository — clone it read-only, learn its trunk and purpose, draft its commands file, warn when a global exception covers it without naming this hub, and open the pull request that lists it. Asks nothing. Merges nothing.
argument-hint: <URL> --trunk default|<HARNESS-BRANCH> | --remove <ID>
---

<!-- Part of the harness asset library c6f3b4427d58f7c3 (see VERSION.json) · 2026-09-18 -->

# `/add-repo <URL> --trunk default|<HARNESS-BRANCH>` · `/add-repo --remove <ID>`

**This file is a contract, not an integration.** It defines the procedure, the preconditions and
the stopping condition. The code host, the pull-request mechanism and the CI system are yours.
Nothing in this command talks to a tracker, and nothing in it writes to the repository it is
adding.

**Purpose.** Put one repository on the hub's list, `docs/estate/repositories.json`, as facts a
script can re-check: its id, its clone URL, its harness trunk, where its commands file is, what it
does, and the commit all of that was read at. Run once per spoke. Run again to refresh. The list is an index,
never the truth: every command that uses it asks the repository itself at run time, and where the
two disagree, the repository wins and that command stops with a question.

The context documents a spoke keeps are read at the commit the list records for it, so every run
of this command ends by proving they parse there: a refreshed `readAt` never points at a
contracts folder the estate cannot read, and a new spoke's documents are in scope the moment it
is listed. Nothing is saved: `scripts/read-context.mjs` prints the index from the folders when a
design asks.

## Inputs

| Input | Form | Where it comes from |
|---|---|---|
| `<URL>` | A clone URL, `https://…` or `git@host:owner/repo.git`. **Never a credential**: a URL with a user name, password or token in it is refused | The argument |
| `--remove <ID>` | A key already in the list | The argument, second form |
| `<ID>` | Derived: the last path segment of `<URL>` with any `.git` removed. Must match `^[A-Za-z0-9][A-Za-z0-9._-]*$`, the grammar the gate applies to a design's `Repository:` line | Derived, never asked |
| `--trunk default\|<HARNESS-BRANCH>` | The branch the harness treats as this repository's trunk. `default` is the branch the remote reports as its default. A branch name is a declared trunk: a second, protected branch where another team keeps the default branch (the guide's "A spoke that two teams share"). **Required.** Without it, this command stops | The argument. Stored as `trunk` in the entry, and as `TRUNK_FOR_HUB` in the commands file |
| `<SPOKE-TRUNK>` | The branch `--trunk` names: for `default`, the remote's default branch, as `git ls-remote --symref <URL> HEAD` reports it now | Asked of the remote on every run |
| `docs/estate/repositories.json` | The list, against `governance/repository-registry.schema.json` | The hub install writes an empty one; this command adds to it |
| `scripts/check-registry.mjs` | The shape check, run before the pull request opens | Installed with the hub |
| `scripts/check-context.mjs` | Proves every context document in the estate parses, each spoke's at its `readAt` | Installed with the hub |
| `scripts/read-global.mjs` | With `--exceptions <ID>`, the `Active` exceptions at the global layer's newest release that cover the repository and do not name this hub. A hub without `docs/estate/global.json` gets `Global: none` and nothing else | Installed with the hub |
| `checks.env.template` | The shape of the commands file this command drafts | `.claude/spoke/checks.env.template`, installed with the hub as its own unchanged copy of the spoke template |

## Preconditions

All seven, checked before anything is written.

1. The working directory is the hub root, on a clean checkout of the trunk. This command cuts its
   own branch.
2. `<URL>` carries no credential. A URL that does is refused before any network call, with the
   URL redacted in the refusal.
3. `--trunk` is given, as `default` or as a branch name that `git check-ref-format --branch`
   accepts. A missing `--trunk` is a stop. A forgotten flag on a shared repository would put the
   harness gates on the other team's branch without a sign, so the command does not guess.
4. `git ls-remote --symref <URL> HEAD` answers and reports a default branch. Unreachable, or a
   remote with no `HEAD`, is a stop: nothing about the repository is known, so nothing is written.
   For a declared trunk, `git ls-remote --heads <URL> refs/heads/<HARNESS-BRANCH>` must also list the
   branch. A declared trunk missing on the remote is a stop: a person creates it from the tip of
   the default branch and protects it before this command runs.
5. `<ID>` matches the pattern. An id with a slash, a space or a scheme in it is not an id, and a
   listing under a bad id would fail every gate that reads it later.
6. No other id in the list already points at this URL. One repository, one id. A second id for the
   same place is two names for one thing, and a design could name either.
7. For `--remove`: no design on the hub trunk names `Repository: <ID>` without a matching
   `docs/designs/<KEY>.validation.md`, and the repository's remote has no `feature/<KEY>-*` branch
   for any design that names it. QA passes before the code merge, so a report alone does not mean
   the code merged. A repository with work in flight is not removed; the refusal names the keys.

## What it does — add or refresh

```bash
git ls-remote --symref <URL> HEAD                          # the default branch, now; or stop
git ls-remote --heads <URL> refs/heads/<HARNESS-BRANCH>            # a declared trunk only: it exists, or stop
git clone --quiet --depth 1 --branch <SPOKE-TRUNK> --no-tags <URL> <TMP>   # read-only, disposable
# read <TMP>: the top-level tree, the first README found, the commands evidence below
# write purpose, readAt, checks; draft the commands file where the repository has none
node scripts/test-quality-scan.mjs --coverage --repo <TMP>   # which test stacks it holds, and whether the scan has rules for them
node scripts/check-registry.mjs --offline                  # exit 0 or stop
node scripts/check-context.mjs                             # every document parses at readAt; exit 0 or stop
node scripts/read-global.mjs --exceptions <ID>             # a WARNING line per exception that does not name this hub; exit 0 or stop
git checkout -b estate/add-<ID>                            # estate/refresh-<ID> on a second run
git add docs/estate/ scripts/test-quality/rules/ tests/test-quality/fixtures/   # the last two only where a suggested ruleset was adopted
node scripts/harness-commit.mjs -m "chore(estate): add <ID>"
# open the pull request in the hub, its description ending with the watermark line; delete <TMP>
```

Step by step, and what each step may and may not do.

1. **Derive the id, ask the remote for its trunk, clone at depth 1.** `<SPOKE-TRUNK>` is the branch
   `--trunk` names, confirmed on the remote (precondition 4). The clone is read-only in
   fact as well as in intent: it lands in a temporary directory outside the hub, is never pushed,
   and is deleted before this command stops. Nothing is cloned into `.worktrees/`.
2. **Read what a newcomer would read.** The top-level tree from `git ls-tree HEAD`, and the first
   file present of `README.md`, `README`, `README.rst`, `README.txt`, `docs/README.md`. One level
   more for three questions only: whether it already has a secret scanner of its own — a
   `package.json` script or a file under `scripts/` named for one — whether the repository
   already writes down its conventions — a
   `.claude/rules/` or `docs/rules/` folder, a `CLAUDE.md`, a `CONTRIBUTING.md` at the root — and
   whether it keeps contracts — a `contracts/` folder of `.md` files that open with a frontmatter
   header — because those are the three facts the draft's `SECRET_SCAN_COMMAND`, `RULES_INDEX`
   and `CONTRACTS_INDEX` keys need. Nothing deeper. This command is
   orientation, not survey; the deep reading happens in `/decompose`, at a pinned commit, through
   `scripts/read-spoke.mjs`, against the real file.
3. **Write `purpose`.** A few sentences, at most 600 characters, in this order: what the
   repository does, what it owns, its language and runtime, where its tests live. Every sentence
   is backed by the README or the tree. Where the README says nothing, say what the tree shows
   and say the README is silent. **Never guess, never pad, never write a placeholder.** The
   checker refuses `TBD`; a purpose that says "unclear from the README; the tree shows a Python
   package under `src/` and tests under `tests/`" is honest and passes.

   The second sentence, what it owns, is the one that does the work. `/decompose` orders its
   reading of the estate by the purpose, and it orders by what a repository is responsible for:
   the surfaces, the data, the capability this repository holds and no other one does, in the
   words the README uses for its domain. A purpose that names only a language and a tests folder
   orders nothing; every repository in the estate has a stack. Where the README does not say
   what the repository owns, write that it does not say, and name the top-level folders the tree
   shows: the planner reads the tree at a pinned commit either way, and the purpose only decides
   in which order. Nothing is ruled out on the purpose alone, so a thin one costs reading time,
   never coverage; a wrong one costs more, which is why it is never guessed.
4. **Find or draft the commands file.** If the repository already has a `checks.env` at its root,
   record that path and draft nothing. Otherwise draft one from `checks.env.template` into
   `docs/estate/drafts/<ID>.checks.env` in the hub, from the evidence below, and record
   `checks.env` as the path it will have once the spoke install moves it there.

   The draft carries `TRUNK_FOR_HUB` with the `--trunk` value, and `SYNC_BRANCH=none` for
   `default` or `SYNC_BRANCH=^sync/` for a declared trunk. These two are never `UNRESOLVED`:
   this command knows both. Where the repository already has a `checks.env` that names another
   `TRUNK_FOR_HUB`, stop and name both values: the repository and the list must agree.

   The draft keeps the two token names of the template: `HUB_TOKEN_SECRET`, the secret that
   reads every hub in `HUBS` and starts its `observability-gates` workflow, and `SPOKE_READ_TOKEN_SECRET`, the secret that reads the
   spokes of the hub's list. The `qa-gate` job needs the second when a story has a `blocks`
   dependency and the dependency's spoke is private. That spoke can be the story's own spoke. Ask the tech lead for both names, and keep the template's names where the
   team has no others. Tell the tech lead that the hub's `HARNESS_SPOKE_READ_TOKEN` has the right
   scope for the second secret: read-only on every spoke of the hub's list. Never write a token's
   value.

   **You choose each command, from evidence in the clone.** Find the tool the repository already
   uses for the step — a configuration file, a script, a `Makefile` target, a step in its own CI
   — and draft the command that runs it, naming in the draft's header the file each command
   came from. The table is examples, not the whole list: a repository whose formatter is
   configured some other way still has a formatter. Never choose a tool for the team: a
   repository that has no formatter does not get one here.

   **A formatter that rewrites in place is a finished answer.** Draft the command the repository
   already has — `make format`, `npm run format`, `black .` — whether it rewrites files or only
   checks them. The commit checks judge every row by its exit code and by the tree, so a
   rewrite fails the row exactly as a `--check` failure does. Never ask for a check-only form,
   and never add a target or a script to the repository for one.

   | Evidence in the clone | Draft |
   |---|---|
   | `package.json` with a `test` script that runs one tool | `TEST_COMMAND` as that tool run directly — `node --test …` as written, a dependency's binary through `npx` (`npx jest …`, `npx vitest run …`) — **never `npm test`**: `package.json` also holds the dependencies, so the protected-test guard cannot protect the alias without freezing them, and `/dev-sprint` refuses it. A script that chains several steps: `UNRESOLVED`, the script named in the draft's header. `format`, `lint`, `build`, `typecheck` scripts may stay `npm run …` — the guard binds only the test command |
   | A formatter's own configuration (`.prettierrc`, `[tool.black]` or `[tool.ruff.format]` in `pyproject.toml`, `rustfmt.toml`, `.clang-format`) with no script that runs it | `FORMAT_COMMAND` as the tool's own command over the repository, in the form its documentation gives: `npx prettier --write .`, `black .`, `ruff format .`, `cargo fmt` |
   | `pyproject.toml` or `pytest.ini` or `tests/` with `test_*.py` | `TEST_COMMAND=pytest` |
   | `go.mod` | `TEST_COMMAND=go test ./...` |
   | `Cargo.toml` | `TEST_COMMAND=cargo test` |
   | A `Makefile` with a `test` target | `TEST_COMMAND=make test`, with `Makefile` in `TEST_GUARD_PATHS` — which freezes every target in it for the engineer, so prefer the command the target runs where it is one line; the same for `format` (or `fmt`), `lint`, `build` and `typecheck` targets, which the guard does not bind |
   | A step in the repository's own CI that formats, lints or type-checks | That step's command, as the CI file states it |
   | Test folders, test-file names, fixtures, snapshots, helpers, runner configuration | `TEST_GUARD_PATHS` as comma-separated patterns for what the tree shows: the folders (`tests/**`, `test/**`, `spec/**`, `src/test/**`), the naming conventions where tests sit beside code (`**/*_test.go`, `**/*.test.ts`, `**/test_*.py`), snapshot and fixture folders under them (`**/__snapshots__/**`), the runner configuration files present or that the runner would read (`pytest.ini`, `**/conftest.py`, `jest.config.*`, `vitest.config.*`, `.mocharc.*`, `phpunit.xml*`), any file `TEST_COMMAND` names, and `checks.env` itself. Never a pattern that would cover a production file or a stub. Runner configuration kept inside a file that also holds dependencies (`[tool.pytest.ini_options]` in `pyproject.toml`, a `jest` key in `package.json`, `[tool:pytest]` in `setup.cfg`) is protected only with the whole file: setup refuses it otherwise. Draft the file into the declaration and say in the draft's header that this freezes its dependencies for every sprint, or propose moving the settings into a runner file of its own; the tech lead chooses. Every tracked file the tree shows under a supported runner's test convention must be covered too, or `check` refuses the draft |
   | A lockfile or a dependency manifest — `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `composer.lock`, `poetry.lock`, `requirements.txt`, `go.sum`, a `pom.xml` — or an install step in the repository's CI | `INSTALL_COMMAND` as the install step the CI runs, in a form that does not rewrite the lockfile: `npm ci`, `composer install`, `go mod download`. No install step in the CI: the form the lockfile implies, named in the draft's header for the spoke install to prove. No manifest and no lockfile: `none — <what you looked for and did not find>` |
   | A `package.json` script named `secret-scan`, `secrets` or `scan:secrets` | `SECRET_SCAN_COMMAND=npm run --silent <that script>` |
   | A Node script under `scripts/` whose name says it scans for secrets (`secret-scan.mjs`, `scan-secrets.js`) | `SECRET_SCAN_COMMAND=node scripts/<that file>` |
   | A scanner that does not run the same on Windows, Linux and Mac — a `.gitleaks.toml`, a `pre-commit` hook, a `Makefile` target, a shell script | Nothing drafted from it: `SECRET_SCAN_COMMAND=UNRESOLVED`, and the draft's header names what was found and that the team wraps it in a portable script before the spoke install, which refuses until then |
   | A folder of rule files with the pack's frontmatter (`.claude/rules/`, `docs/rules/`) | `RULES_INDEX=<that folder>`, as a draft the spoke install proves with `check-spoke-rules.mjs`. A lone `CLAUDE.md` or `CONTRIBUTING.md` is evidence that conventions exist, not a folder: leave the key `UNRESOLVED` and name the file in the draft's header |
   | A `contracts/` folder of `.md` files that open with a frontmatter header | `CONTRACTS_INDEX=contracts`, as a draft the spoke install proves with `check-context.mjs --local`. A folder of schemas or OpenAPI files with no headed `.md` beside them is a machine form, not a document set: leave the key `UNRESOLVED` and name the folder in the draft's header |
   | A folder of decision-record files named `ADR-<NNN>-<slug>.md` that open with the header a hub's records carry (`decisions/`, `docs/decisions/`) | `DECISIONS_INDEX=<that folder>`, as a draft the spoke install proves with `check-context.mjs --local`. Records without the header are the team's own log, not summaries: leave the key `UNRESOLVED` and name the folder in the draft's header |
   | No formatter, linter, type checker or build step anywhere: no configuration, script, target or CI step for it | `none — <what you looked for and did not find>` for that key, for example `TYPECHECK_COMMAND=none — plain JavaScript: no tsconfig, no type-check script or CI step`, or `BUILD_COMMAND=none — an interpreted service: no build target, script or CI step`. Only these four keys, and `INSTALL_COMMAND` in the row above: they are steps a repository may not have, and the person who merges the install pull request accepts each `none`. A repository always has tests to run and coverage to measure, so those stay `UNRESOLVED` when nothing is found |
   | Evidence that does not settle a step: two formatters configured, a configuration with nothing that runs it and no standard command | `UNRESOLVED — <what is unclear>. Owner: tech lead. Resolves: <the choice to make>.` |
   | None of the above for any other step | The key present, its value the literal `UNRESOLVED`, so `/dev-sprint` stops on it rather than skipping the step — except `RULES_INDEX`, `CONTRACTS_INDEX` and `DECISIONS_INDEX`, where `UNRESOLVED` is `NOT CONFIGURED` and reported, never a stop. `TEST_GUARD_PATHS` `UNRESOLVED` does stop `/dev-sprint`. `SECRET_SCAN_COMMAND` is never `none`: with no scanner found, the draft says the spoke install will refuse until the repository has one |

   A drafted command is a **guess with evidence**, and the draft says so in its header. It is
   proven in one place only: the spoke install, which runs every command in the file once on the
   spoke's trunk and checks the tree after each. A wrong command fails there. The drafted
   declaration is checked here, against the clone, with
   `node scripts/test-guard.mjs check --repo <TMP> --checks docs/estate/drafts/<ID>.checks.env`:
   its findings go in the pull-request description, and a pattern that names a folder or a test
   command the guard would refuse is fixed in the draft before the pull request opens. A
   `SECRET_SCAN_COMMAND` that is not yet a command is one of its findings: reported, as the
   spoke install will refuse it.

   **The test stacks.** Run `node scripts/test-quality-scan.mjs --coverage --repo <TMP>`. It reads
   the clone's files and the hub's rules (no Docker, no Semgrep) and prints which test stacks the
   repository holds and which of them the scan covers, ending `TEST STACKS: <n> covered, <m> not
   covered.` Exit 0 whatever it finds; any other exit is a stop, since the hub's rules could not be
   read. With every stack covered, or no tests, the pull-request description carries that one line
   and nothing is asked. With a `[NOT COVERED]` line, **ask once, for the whole repository**, naming
   each stack, its count, and what the line says about a suggested ruleset. Two answers, per stack:
   - **Carry on, and let the hub flag it.** Nothing is installed. The test critic reads those tests
     by hand, and the spoke's CI lists them as not covered, with a warning on the pull request,
     never as clean. This is the only answer where the line says `no suggested ruleset ships`; the
     description then says a person can write `scripts/test-quality/rules/hub-<language>.yml`
     (`docs/harness-test-quality.md`, "Adding rules to this hub").
   - **Adopt the suggested ruleset**, where the line says one is ready (`hub-<language>.yml`). Say
     before asking that it binds **every spoke of this hub**, not only this one, since a hub has one
     rule folder. Adopting copies two things into this pull request's branch, and nothing else:
     `scripts/test-quality/suggested/hub-<language>.yml` to `scripts/test-quality/rules/`, and the
     fixture folder `tests/test-quality/fixtures-suggested/<language>/` to
     `tests/test-quality/fixtures/<language>/` (the hub's own `--rules` run wants a fixture for every
     rule). Then prove it where Docker runs: `node tests/test-quality/run.mjs --rules` must exit 0.
     Exit 2 (no Docker) is not a stop: say in the description that it was not proven. Anything else
     is a stop; remove the two copies and say which finding failed. The pull request's merge is the
     hub operator's acceptance of the rules, like any change to how work is judged.
   The library's rules for the languages it covers arrived with the hub; this is the one place a
   rule is added for a language it does not. Where no one can answer (an unattended run), the
   answer is *carry on*, and the description says it was not asked.
   `UNRESOLVED` stays `UNRESOLVED` where the evidence is not there — `/dev-sprint` stops on it,
   which is the point. Both coverage
   numbers are left `UNRESOLVED` in the draft; they are measured at the spoke install, never
   carried in.
5. **Write the entry.** `url` exactly as given; `checks`; `purpose`; `readAt` the head commit of
   `<SPOKE-TRUNK>` from step 1; `trunk` the `--trunk` value, `default` or the branch name. On a refresh,
   overwrite `purpose`, `checks`, `readAt` and `trunk`; never `url`. If the URL has
   changed, that is a removal and an addition, and a human does both on purpose.
6. **Check the shape.** `node scripts/check-registry.mjs --offline` must exit 0. It is offline
   because the remote was asked thirty seconds ago and this is a check of what was written, not
   of the world.
7. **Prove the context documents parse.** `node scripts/check-context.mjs` must exit 0. This is
   the full run, not `--offline`: it reads every listed spoke's contracts folder at the commit
   the list now records, so the new or refreshed entry's documents are read from the repository
   itself, at `readAt`, and every other spoke's at theirs. A repository that has no commands file
   yet — the case step 4 drafts for — has nothing to read and is reported `NOT CONFIGURED`, never
   a stop; its documents are read on the refresh after its spoke install lands the file. Exit 1 is
   a document that does not parse — in this repository or another — or an always-on hub rule
   nobody imports; exit 2 is a listed repository that could not be reached. Either is a stop: a
   `readAt` whose documents cannot be read is a `readAt` no design can cite. The findings name
   the document or the repository; a spoke's document is fixed in the spoke, and this command is
   run again once its trunk carries the fix.
7a. **Warn about global exceptions.** `node scripts/read-global.mjs --exceptions <ID>` reads the
   global layer at its newest release. It prints one `WARNING:` line for each `Active` exception
   whose `repositories` names this repository and whose `hubs` does not name this hub. The code in
   the repository may follow that exception, and this hub's designs still follow the global
   record. A hub without `docs/estate/global.json` gets the one line `Global: none`: add nothing to
   the pull request. A global repository with no release tag binds nothing yet, and the script
   says so. Exit 0 lets the command go on. Exit 2 is a stop, as in step 7: the command cannot
   prove that no exception applies. Exit 1 is a malformed `docs/estate/global.json`: stop, and
   name its findings. A warning never stops the command.
8. **Open the pull request in the hub.** The pull request's description ends with the watermark, the line `Generated-by: SHL Agentic Harness`
   on its own after the normal description (`.claude/rules/watermark.md`). The branch is `estate/add-<ID>` or `estate/refresh-<ID>`.
   The commit is `chore(estate): add <ID>` or `chore(estate): refresh <ID>`. The pull request
   carries the entry and, where one was drafted, the draft, and — only where the person adopted one — the suggested ruleset and its fixture, and nothing else. Its description
   names the trunk and the commit read, says which commands were drafted from which evidence and
   which are `UNRESOLVED` — the `TEST STACKS` line, with each not-covered stack and the answer given —
   and, where `SECRET_SCAN_COMMAND` is, that the spoke install refuses
   this repository until it carries a portable scanner of its own — and quotes the `[…] <ID>` line `check-context` printed for the
   repository: how many documents it holds, or that its `CONTRACTS_INDEX` is `none` or
   `NOT CONFIGURED`. It quotes every `WARNING:` line from step 7a, with the way out the line names:
   the team asks the Board for an exception that names this hub, or accepts that this hub's
   designs follow the global record. It ends with the next step, **`/survey-repo <ID>` once every repository the
   estate needs is listed**: a survey's calls can name only repositories already on the list, so
   estates onboarding many repositories list them all, then run `/survey-repo --missing` once.
   Then stop.

## What it does — remove

```bash
git grep -l "^Repository: <ID>$" origin/<HUB-TRUNK> -- docs/designs/   # in-flight check, precondition 6
# delete repositories["<ID>"], docs/estate/drafts/<ID>.checks.env and docs/estate/surveys/<ID>.md if present
node scripts/check-registry.mjs --offline
git checkout -b estate/remove-<ID> && git add -A docs/estate/
node scripts/harness-commit.mjs -m "chore(estate): remove <ID>"
# open the pull request in the hub, its description ending with the watermark line
```

Removal deletes the entry, the draft and the repository's service survey: a survey of an
unlisted repository points at nothing, and the hub's `survey-gate` refuses one. The same check
refuses another repository's survey that still names this one as a provider: refresh that survey
with `/survey-repo` first, or the removal waits. No remote is asked, because nothing about any other
repository changed, and a repository that is no longer listed is simply out of scope for
`read-context.mjs`. Removal does not touch the spoke, does not delete designs that named the
repository, and does not rewrite history.
Designs are the record of what was built; a repository leaving the list does not unbuild them.

## Gates it enforces

| Gate | Behaviour on failure |
|---|---|
| URL carries no credential | Refuse before any network call. Redact the URL in the message |
| `--trunk` is given | Refuse. Nothing is written. Print the two forms: `--trunk default` and `--trunk <HARNESS-BRANCH>` |
| Remote answers and names a default branch | Refuse. Nothing is written. Exit 2 in spirit: cannot verify, not verified and wrong |
| A declared trunk exists on the remote | Refuse. Nothing is written. Say that a person creates the branch from the tip of the default branch and protects it first |
| An existing `checks.env` names the same `TRUNK_FOR_HUB` as `--trunk` | Refuse and name both values |
| Id grammar | Refuse and print the id derived and the pattern |
| One id per URL | Refuse and name the existing id |
| `check-registry.mjs --offline` exits 0 | Refuse to open the pull request. Print its findings; fix the entry; re-run |
| `check-context.mjs` exits 0 (not run for `--remove`) | Refuse to open the pull request. Print its findings: a document that does not parse is fixed where it lives, a repository that could not be reached is asked again; re-run |
| `read-global.mjs --exceptions <ID>` exits 0 (not run for `--remove`) | Refuse to open the pull request on exit 1 or 2. A `WARNING:` line is never a refusal: it goes into the description |
| Purpose is not a placeholder and is at most 600 characters | The checker enforces it; this command writes to pass it |
| For `--remove`: no in-flight design names the id | Refuse and list the keys |

## Output

- One entry added, refreshed or removed in `docs/estate/repositories.json`.
- Where drafted: `docs/estate/drafts/<ID>.checks.env`, header stating it is a draft and what it
  was drafted from.
- One pull request in the hub, on `estate/add-<ID>`, `estate/refresh-<ID>` or `estate/remove-<ID>`.
- One line reporting the id, the trunk and head commit read, the purpose written, each command
  as drafted, found or `UNRESOLVED`, the `[…] <ID>` line `check-context` printed for it, and the
  number of exception warnings.
- The last line printed: `After this pull request merges, run /estate-overview-refresh.`

## Stopping condition

The pull request is open and the temporary clone is gone. Then stop. Do not merge. Do not open a
pull request in the spoke: that is the spoke install, a separate procedure a human starts.

## Never

- Never ask a question. Everything this command needs is in the URL and the remote. A repository
  it cannot read is a repository it does not list, and it says so.
- Never write a credential, a token name's value, or anything from `.env` files it finds.
- Never guess the trunk. `--trunk` names it, and the entry stores the name. Every command that
  needs the trunk applies the trunk rule through the scripts: `default` is asked of the remote at
  run time, a declared branch must exist there, and `TRUNK_FOR_HUB` on that branch must name the
  same trunk.
- Never write to the repository being added. Read-only clone, deleted after.
- Never scan an organisation, a group or a host for repositories. One URL, given on purpose.
- Never list one URL under two ids, or change an entry's URL in place.
- Never invent a purpose, pad one, or leave a placeholder. Say what the evidence shows and where
  it is silent.
- Never write a purpose that names only the stack. What the repository owns, in the domain's
  words, or the honest statement that the README does not say, comes before the language.
- Never draft a command without evidence for it; write `UNRESOLVED` and let `/dev-sprint` stop.
- Never draft `TEST_COMMAND` as an alias defined in a file that also holds dependencies, and never
  draft a `TEST_GUARD_PATHS` pattern that covers production code or a stub.
- Never write a rule file into the draft, or point `RULES_INDEX` at a folder the tree does not
  have. A repository's conventions are its team's to write; this command records where they are.
- Never write a contract into the draft, or point `CONTRACTS_INDEX` at a folder the tree does not
  have. The same rule, for the same reason.
- Never merge the pull request.

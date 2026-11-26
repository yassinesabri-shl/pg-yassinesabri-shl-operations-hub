<!-- Part of the harness asset library c6f3b4427d58f7c3 (see VERSION.json) · 2026-10-15 -->

# Test quality scan — Semgrep CE at every test review

A static scan of the tests a work item adds, run by Semgrep Community Edition with rules this hub
ships. It finds what a reader can see without running anything: a test that is skipped, asserts
nothing, asserts a constant or asserts "any error", is empty, or is mostly mocks. It does not
replace running the tests (`/dev-sprint` step 2) or the critic's review; it hands the critic what a
machine can see, so the critic spends its attention on the lazy build and the design.

```
  test writer ──commits──▶ orchestrator dispatches the critic in test-review
                                   │
                  hook (scripts/test-quality-hook.mjs, PreToolUse on Agent)
                                   │  scan Test-Base..HEAD of the writer's checkout
                                   │  rules + pin: this hub's COMMITTED HEAD
                                   ▼
                  the critic's prompt + the scan ──▶ ONE reply to the test writer
                                                     (scan findings SG-n + its own)

  spoke pull request ──▶ story-gate ──▶ the same scanner, the hub's trunk rules ──▶ red or green
```

## Where it runs

| Where | When | Reads rules from | If Semgrep is missing or cannot run |
|---|---|---|---|
| The hook, in the hub | every launch of the critic in `test-review`: the first review, every revision, every dispute round, and the test for each pull-request comment (`Test-Base` H, so only T′) | the hub's committed `HEAD` | a warning to you (Docker not running, the image not pulled, anything else); the critic is told "Semgrep scan not run" and opens its reply with that line and the reason, which the orchestrator relays, since the warning never reaches it; the review continues |
| `story-gate`, in the spoke's CI | every pull request | the hub clone's trunk | the check fails: exit 2 is a failure to verify |

The CI step is the backstop. The hook is not a gate: a violation reaches the critic, whose reply
is `CHANGES REQUESTED` while one stands, and the hook never blocks a review.

## What reads what

One shared folder in the hub holds everything: `scripts/test-quality/ruleset.json` (the rules'
version and the one Semgrep version they are written for) and `scripts/test-quality/rules/*.yml`:
the library's rule files, and this hub's own beside them (below). `/shl-onboard` installs the
library's files with the hub and `--upgrade` updates exactly those. **A spoke has no copy, no choice
of language and nothing to install.** The scanner reads the folder with `git` at a *committed*
revision, so an uncommitted edit in the hub changes nothing locally, and nothing in a spoke — its
branch, a `.semgrepignore`, a rules folder it adds — can change how its tests are judged. Semgrep
itself is told to ignore inline `nosem` comments, and the scanned files are exported from the
commit into a temporary folder with an empty ignore file of our own, because Semgrep's default skips
`test/` and `tests/` folders.

## Running Semgrep — Docker, and what to pull

The harness installs nothing. Semgrep runs as the image `semgrep/semgrep:<pin>`, the pin being the
one in `scripts/test-quality/ruleset.json`. There is no Python to install; you need Docker running,
and the image once.

| Where | When | How | What checks it |
|---|---|---|---|
| The machine that runs `/dev-sprint` (the hub operator's) | once, before the first sprint after the hub is installed or upgraded, and again whenever an upgrade moves the pin | `docker pull "semgrep/semgrep:$(node -p "require('./scripts/test-quality/ruleset.json').semgrep")"`: about 430 MB compressed, and the only slow step; a scan then starts in about two seconds | the hook, at every launch: Docker not running or the image not pulled is a warning to you with the command to run, not a stop. The hook never downloads; `/dev-sprint` fetches a missing image at the start of a run, before the test writer (`node scripts/test-quality-scan.mjs --ensure-image`, Docker's progress shown), and, if Docker is stopped, not installed or the download fails, stops and tells you what to do and to run `/dev-sprint` again (or lets you continue without the scan), so `docker pull` here is only a way to do it ahead of time |
| The spoke's CI | every run — the runner is thrown away | the `story-gate` step runs the scanner with `--pull`, which pulls the image if it is missing; no Python, no `pip` | the scanner, which exits 2 on a missing Docker, a failed pull or a report from another version |

The container gets no network, a read-only root filesystem, the rules and the test files mounted
read-only, one writable folder for the two reports, no Linux capabilities, no new privileges and
the caller's own user. `SEMGREP_IMAGE` names a mirror of the image repository (the scanner adds the
pin as the tag; a spoke's CI reads it from a repository variable of that name). Docker is the only way Semgrep runs: there is
no Semgrep install to point the scanner at.

Spoke developers' own machines need nothing. The pin lives in one file, in the hub; moving it is a
hub upgrade.

## Registering the hook

The hub's `.claude/settings.json` carries one entry: `PreToolUse`, matcher `Agent`, command
`node "$CLAUDE_PROJECT_DIR/scripts/test-quality-hook.mjs"`. Open the hub in Claude Code once and
accept the folder's trust dialog, or Claude Code does not run project hooks. The hook only rewrites
the critic's prompt: it makes no permission decision, and every other dispatch and tool call is
untouched.

## Licence, network and privacy

- **The engine** is Semgrep Community Edition, LGPL-2.1: running it needs no licence from Semgrep.
- **The rules** are this library's own, not Semgrep's registry rules: the Semgrep Rules License
  allows internal use but not redistributing the registry's rules, and this library ships rules into
  every hub. Our rules are covered by the licence this library is delivered under, which is not yet
  settled: UNRESOLVED — the licence and copyright terms. Owner: engagement lead. Resolves: on
  agreement of the delivery contract.
- **Network.** Only pulling the image touches it (Docker Hub, or your mirror). A scan runs with
  `--network none`, passes `--metrics=off --disable-version-check`, sets `SEMGREP_SEND_METRICS=off`,
  never hands the container `SEMGREP_APP_TOKEN` or any other variable of yours, and uses a local rules
  folder: no login, no registry, no `semgrep ci`, no upload.
- **Privacy.** It reads only test source files the range changes, and writes a SARIF report to the
  temporary folder (or to the path you give it with `--sarif`). It scans for code patterns, never
  for personal data.

## Severity

`ERROR` is a clear violation: the critic must return it as a finding, and the verdict is `CHANGES
REQUESTED` while one stands; CI is red. `WARNING` is uncertain: the critic confirms or dismisses
it, CI stays green. A finding is `SG-<n>`, with its rule, `path:line` and the fix.

## What is covered

Chosen from the test frameworks the estate's spokes use. Each rule has a fixture (`tests/test-quality/fixtures/`) that marks exactly what it must flag.

| Stack | Frameworks | ERROR | WARNING |
|---|---|---|---|
| Java | JUnit 5 and 4, TestNG (partly), Mockito, AssertJ, Spring Boot Test | `@Disabled` / `@Ignore` / `enabled = false` on a method or class; `assertTrue(true)`, `assertEquals(x, x)` and kin; `assertThrows(Exception.class …)` or `Throwable`, `@Test(expected = Exception.class)`, `isInstanceOf(Exception.class)` — unless the exception is captured; an empty `@Test` (not `contextLoads`) | `Assumptions.assume*`; `RuntimeException.class`; no assertion, `verify`, `expected` or MockMvc `andExpect` in a test; six or more `when`/`given`/`doReturn` stubs in one test |
| Go | `testing`, testify `assert` / `require` / `mock`, gomock `EXPECT()` | an unconditional `t.Skip` / `Skipf` / `SkipNow` or suite `s.T().Skip`; `assert.True(t, true)`, `assert.Equal(t, x, x)` and kin; an empty `TestXxx` | a skip behind an `if`; a test with no `t.Error` / `t.Fatal` / testify call / helper taking `t`; six or more `.On(` / `.EXPECT()` |
| PHP | PHPUnit 7.5 and later, Mockery, PHPUnit's mock builder | `markTestSkipped` / `markTestIncomplete`; `assertTrue(true)`, `assertEquals($x, $x)` and kin; `expectException(\Exception::class)` or `Throwable` without a message or code, and `@expectedException Exception`; an empty `testXxx` | a conditional `markTestSkipped`; no assertion, expectation, Mockery expectation or `check*` helper; six or more mock set-ups |
| JS / TS | Jest (with jest-preset-angular and Angular `TestBed`), Vitest, Testing Library, `node:test` with `node:assert`; the same `describe` / `it` / `test` / `expect` shape in Mocha, Jasmine, Cypress and Playwright | `.skip` / `.only` / `.todo` / `.fixme` / `.failing`, `xit`, `fit`, `this.skip()`, `{ skip: true }` and a title with no body; `expect(x).toBe(x)`, `expect(true).toBe(true)`, `assert.equal(x, x)`; `toThrow()` or `toThrow(Error)`, `assert.throws(fn)`; an empty `it` / `test` | no `expect` / `assert` / Testing Library `getBy` / `done` in a test; seven or more `jest.fn` / `vi.fn` / `spyOn` / `mockReturnValue` set-ups |
| Python | pytest, unittest, `unittest.mock`, pytest-mock | `pytest.mark.skip` / `xfail`, `pytest.skip` / `xfail` / `importorskip`, `unittest.skip`, `expectedFailure`, an unconditional `skipTest`; `assert True`, `assert x == x`, `assertTrue(True)`; `pytest.raises(Exception)` or `assertRaises(Exception)` without `match=` or `as`; a `pass`-only test | `skipif` / `skipIf` / `skipUnless` and any skip behind an `if`; no `assert` / `assert*` / `raises` / `check_*` in a test; seven or more patches or mocks; four stacked `@patch` |

A changed test file the scan has no rules for — Ruby, Kotlin, C#, Scala, Swift, Dart, Elixir, Rust or
C/C++, recognised as a test by its folder (`test`, `tests`, `spec`, `__tests__`, `*.Tests`) or its name
(`*Test`, `*Tests`, `*Spec`, `*_test`, `*_spec`, `test_*`, `*.test.*`) — is listed as `[NOT COVERED]` and never
counted as clean. It does not fail the scan: the test critic reads it by hand, and in GitHub Actions each such file gets a warning
annotation on the pull request ("Not checked by the test-quality scan"), so the gap is visible there too.

## Which stacks a repository holds

```bash
node scripts/test-quality-scan.mjs --coverage --repo <checkout> [--hub <hub>] [--rev <revision>]
```

Reads the checkout's committed files and the hub's rules (no Docker, no Semgrep) and prints the
test stacks the repository holds, those the rules cover with their counts and those with tests and
no rules as `[NOT COVERED]`, saying whether a suggested ruleset is ready for it; exit 0 either way, 2
where the hub's rules cannot be read. `/add-repo` runs it while it lists a spoke and, if a stack is not
covered, asks the owner once: **carry on** (the critic reads those tests by hand, CI warns on the pull
request) or **adopt the suggested ruleset** (see below). The library's rules for the languages it covers
arrive with the hub; nothing else is installed without that answer.

## Suggested rulesets

The library ships starter rules, off, for languages it has no rules for: `scripts/test-quality/suggested/hub-kotlin.yml`
(JUnit, kotlin.test), `hub-csharp.yml` (xUnit, NUnit, MSTest) and `hub-ruby.yml` (RSpec, Minitest). Each has
three ERROR rules: a skipped or ignored test, an assertion that cannot fail, an empty test. They are proven
against their fixtures with real Semgrep (`tests/test-quality/run.mjs --rules`, fixture 103), and they are the
same kind of rule a hub writes itself, with ids that start `hub-`.

Adopting one is a pull request in the hub: copy the file to `scripts/test-quality/rules/` and its
`tests/test-quality/fixtures-suggested/<language>/` to `tests/test-quality/fixtures/<language>/`, run
`node tests/test-quality/run.mjs --rules`, merge. `/add-repo` does this when asked. From the merge it is the
hub's rule: it binds every spoke of the hub, an upgrade never touches it, and it can be edited or deleted.
They are starting points, not a full ruleset for those languages: the library's rules for Java, Go, PHP,
JS/TS and Python also warn about tests with no assertion and tests that mock too much, and these do not.
The adopted copy is the hub's: a later change to the suggested file in the library does not reach it.

## What is not covered

- **Languages and frameworks with no rules:** Ruby (RSpec, Minitest), Kotlin, C# (xUnit, NUnit,
  MSTest), Scala, Swift, Dart, Elixir, Rust, C and C++; Groovy / Spock; PHP Pest and Codeception;
  Go Ginkgo / Gomega and goconvey; nose; Cucumber and other BDD step definitions; end-to-end tools
  beyond the shared `describe` / `it` shape (Cypress commands, Playwright fixtures).
- **Checks that need more than a pattern:** Semgrep reads one file at a time and cannot count
  across files or run anything. "Excessively mocked" is a count inside one test, a heuristic;
  "no assertion" looks for the usual assertion calls and names, so an assertion hidden in a helper
  with another name is a warning, not a fact; a test that only snapshots, or only asserts a mock was
  called, counts as asserting. An exception captured and then inspected, or narrowed with a message
  or code, is not flagged as broad. Go's testify `assert.Error(t, err)` ("any error") is common
  enough that flagging it would only teach reviewers to ignore warnings, so it is not flagged.
- **Known gaps inside a covered stack.** PHP tests marked only by `#[Test]` or `@test`, with no `test`
  prefix, are not checked, and `@doesNotPerformAssertions` is not honoured (that test gets the
  "no assertion" warning). Go testify suite methods (`func (s *Suite) TestX()`) are not checked for
  assertions. A test file outside the folders and names each rule lists in its `paths:` is not
  read and is not reported either.
- **The lazy build.** Whether a hard-coded return would pass the tests is the critic's check, and
  is not mechanisable here.
- **Files Semgrep cannot read:** a partly parsed file is reported `[PARTIAL]` and the rest is
  checked; an unparseable one, a timeout or a rule error is exit 2.

## Adding rules to this hub

A hub keeps its own rules in the same place as the library's: `scripts/test-quality/rules/`, as
files named `hub-<name>.yml`. The scanner reads every file in that folder from the hub's committed
revision, hashes them together into the SARIF stamp, and judges a hub rule exactly as it judges a
library one. An upgrade replaces only the files it installed, so a `hub-*.yml` file is never
touched, listed or proposed over.

1. Write the rule file, with `paths.include` naming the test files it applies to, `severity: ERROR`
   for a clear violation or `WARNING` for something a reviewer should judge, and an `id` that starts
   with `hub-`. A rule id may be used once in the folder: the scanner stops with exit 2 on a
   repeat, because Semgrep would keep one of the two and say nothing. A hub rule can therefore
   neither replace nor silence a library rule.
2. Add a fixture under `tests/test-quality/fixtures/<language>/<a path in a spoke>`, marking each line
   the rule must flag with `// ruleid: <rule>` (or `# ruleid:`) and each it must not with `// ok:`.
3. Run `node tests/test-quality/run.mjs --rules`. It fails on a finding no marker expects, a marker no
   finding meets, and a rule with no fixture.
4. Open a pull request in the hub. A person merges it, like any change to how work is judged. From
   the next critic launch it is in the hook's scan, and from that merge it is in every spoke's CI,
   because both read the committed hub, not the pull request being judged.

A hub rule can be for a language the library has no rules for. Name it in the rule's `languages:` as
Semgrep does — `kotlin`, `csharp`, `ruby`, `scala`, `swift`, `dart`, `elixir`, `rust`, `c` or `cpp` — and the scanner
exports that language's changed files (`kt kts`, `cs`, `rb`, …) to Semgrep and stops listing them as
`[NOT COVERED]`. Give the rule a `paths.include` for the test files: without one it reads every file
of that language. Any other language needs the library to add it. There is one rule folder per hub, so every
spoke of a hub is judged by the same rules; a rule that should bind one spoke only has to say so in
its `paths.include`.

## Adding a rule or a framework to the library

A rule is a YAML file in `accelerator/gate/test-quality/rules/` with `paths.include` naming the
test files it applies to, and a fixture under `accelerator/gate/tests/test-quality/fixtures/<language>/`
that marks each line it must flag with `// ruleid: <rule>` (or `# ruleid:`) and each it must not with
`// ok:`. `node tests/test-quality/run.mjs --rules` runs them with real Semgrep, and fails on a
finding no marker expects, a marker no finding meets, and a rule with no fixture. Raise
`ruleset` in `ruleset.json` with the change; move `semgrep` only after re-running that against the
new version, and say so in the release notes, because every hub operator pulls the new image.

## Exit codes

`0` clean, or warnings only · `1` violations · `2` cannot verify (Docker not installed or not running, the image not pulled, Semgrep
not the pinned version, crashed, timed out (`--timeout`; the hook allows 100 s) or wrote nothing
readable; a file it could not parse; a rule id defined twice; no rules at that hub revision; a commit
it cannot read) · `3` usage · `4` internal. In the hook, 2 is a warning to you and
a note to the critic; in CI it is a failure.

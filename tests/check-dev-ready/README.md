# Fixture suite — `check-dev-ready.js`

The gate has veto power over the whole delivery pipeline and nothing else checks it.
This is the suite that checks it. One runner, no dependencies.

```
node run.mjs            # every fixture
node run.mjs 9 13       # only those fixtures
node run.mjs --keep     # leave the throwaway repositories on disk for inspection
```

Exit 0 if every fixture passes, 1 if any fails. Nothing is written outside the
system temporary directory.

**`run.mjs` is the list.** Every fixture carries its number, its name, the expected
exit code and a comment saying why it exists, and the runner prints the whole set on
every run. Nothing in this file repeats it: a fixture inventory in prose is one that
is wrong the first time somebody adds a case, and a suite whose documentation
disagrees with it is a suite people stop believing.

## What a fixture is here

A **repository state**, not a unit mock. Each case builds a throwaway git
repository with a real bare `origin`, commits design files to the default branch,
copies the shipped `check-dev-ready.js` to `scripts/check-dev-ready.js`, and runs
it exactly as an agent would — `node scripts/check-dev-ready.js PROJ-412`. The
gate is never imported, never stubbed and never patched: the file under test is
the file that ships. Each fixture asserts the **exit code** and the **failure
message text**, because a gate that fails for the wrong reason has not been
tested.

Fixtures run with a private `HOME`, so a developer's global gitconfig — hooks,
commit signing, a different default branch — cannot change a result.

Most fixtures are the valid design of fixture 1 with exactly one thing changed.
Fixture 1 is the control: if it stops exiting 0, the suite is telling you the
gate got stricter, not that a fixture is wrong. A few cases change the repository
rather than the document — the environment the gate runs in, the directory it is
run from, a second or third commit, a symbolic link — because that is where the
defect lives.

One helper is worth knowing about before you write a case. A review has to name
the revision of the design it approved, so `review()` emits a placeholder and the
repository builder substitutes the blob hash git will actually store. A fixture
that changes the design in a later commit deliberately does **not** get that
substitution: the review keeps naming the revision it really read, which is the
whole point of the check.

## The classes of fixture, and why each one is a class

**Shape of the document.** Counts, tokens, columns, the derived criterion-to-test
map, the clarification schema. Fixtures 9, 10, 11 and 13 exist because the gate
once passed all four of them. Before the counts were derived from the tables, the
integrity check compared two integers the same author had typed in the same
block, so a three-criterion design with one test row exited 0 with a green audit
trail. Before `Answered` was moved into the non-releasing set, a blocking
ambiguity answered in chat and never written back into the specification reached
build the same way.

The remote-unreachable case is the one people skip. It is the difference between
*I do not know* and *I know, and the answer is no*, and a gate that guesses
manufactures evidence. Exit 2 is expected only where the remote cannot be read
or its trunk cannot be confirmed.

The unnumbered-headings case exercises the one tolerated formatting variation:
`## Readiness` and `## 8. Readiness` locate the same section, so renumbering the
design template is safe. Field labels and values are still matched literally.

The untouched-template case is the one people are surprised by. A design template
is written to teach, so its cells carry authoring guidance in angle brackets, and
that guidance is *meant* to ship. Rename the file and the guidance becomes a
design with three criteria, three test rows, agreeing counts and a `GATE_PASS`
the author wrote — green, and empty. Placeholder detection covers that form for
the same reason it covers `TBD`: it is the cheapest content-free way to satisfy
the criterion-to-test map. The whole cell has to be bracketed, so a criterion
that mentions `<Foo>` or `> 1MB` inside a real sentence is unaffected.

**Regions a reader does not read.** One defect seen from both sides. The gate
parses lines, and a fence marker, a comment marker, four spaces of indentation
and a link reference definition are all invisible to a line: content at column
zero inside any of them used to be indistinguishable from real document content.
Read one way, a design whose body is a fenced example under the words "not
written yet" passed all four gates. Read the other, an honest design that quoted
the readiness block as a sample was refused for declaring it twice. Both
directions are in the suite, and a change that fixes one by breaking the other
fails here. Marker variants are deliberate: a fix that knows only about three
backticks closes nothing.

**Where the mask stops looking like a renderer.** The mask is a line scanner
approximating a block parser, and every case in this class is a place the
approximation used to depart from CommonMark: indented code needs no preceding
blank line and is counted from a list item's content column rather than the
margin; a link reference definition's title runs over as many lines as it likes
and renders as nothing; an HTML block ends with the *line* that closes it, so
text after `-->` is raw HTML and never a heading; a table cannot interrupt a
paragraph. Each of these was reachable, and each one is now pinned. Before adding
to this class, check the construct against a real renderer first — the fixture is
only worth having if the gate and the page disagree.

**Markup the mask cannot help with.** `<details>`, `<summary>`, an HTML `<table>`
and a `display:none` style leave their content in the file and take it off the
page. Blanking them would be the gate refusing to read a document that says what
it says, so it refuses them by name instead, in both files. Backticks are the
escape, and there is a case for that too: a design for something that renders
HTML has to be able to state its own criteria.

**What the repository says, not what the environment says.** These are not about
documents at all. A gate that reads a branch the environment named, out of a
remote it does not report, from a pathspec relative to wherever it happened to be
run, is not reading the trunk — it is reading whatever it was pointed at, and a
caller keying on the exit code cannot tell the difference. The revision-binding
cases belong here too: a review is evidence about a revision, and a design
rewritten after approval has to stop being approved however the commits are
arranged.

**The start of an amendment.** The suite also covers `check-design-amend.mjs`,
which says whether `/dev-spec` may amend a design whose pull request is still
open. Those fixtures are marked `amend: true`: they check out the branch
`/dev-spec` would have cut, move the checkout or the remote — a later push, a
local commit, a merge, a squash merge — and run that script instead of the gate.
The squash case is the one to keep: no commit is shared with the trunk, so only
the design already on the trunk shows the merge.

## Adding one

Add the case to `FIXTURES` in `run.mjs`: a name, the file overrides, the expected
exit code, and the substrings the output must contain. Add it in the same commit
as the check it covers. A check that arrives without a fixture is a check nobody
will notice has stopped working.

**Watch the new fixture fail first.** Copy the gate aside, run the fixture against
the copy, and confirm the gate lets the input through. A fixture that has never
been seen to fail proves nothing about the check it claims to cover.

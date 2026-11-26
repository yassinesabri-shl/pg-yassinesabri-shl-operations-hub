# Fixture suite — `read-discovery.mjs`

The script selects the discovery maps of earlier stories by folder. It marks each
pinned file `current` or `drift` against a spoke at one commit. This suite checks
it. One runner, no dependencies.

```
node run.mjs            # every fixture
node run.mjs 2 6        # only those fixtures
node run.mjs --keep     # leave the throwaway repositories on disk
```

The runner exits 0 when every fixture passes, and 1 when any fixture fails. It
writes nothing outside the system temporary directory.

**`run.mjs` is the list.** Each fixture carries its number, its name and the
exit code it expects. This file does not repeat them.

## What a fixture is here

A fixture is a repository state, not a unit mock. Each case builds these:

- a throwaway hub with a bare `origin`, with the maps merged on its trunk
- a registry that names the spoke
- a real bare spoke remote with two commits. Commit 2 changes
  `src/ledger/post.ts` and removes `src/ledger/old.ts`

The suite then runs the shipped script from the hub, as `/dev-spec` runs it. It
asserts the exit code and the text. The script is never imported or stubbed.

Fixtures run with a private `HOME`, so a developer's git configuration cannot
change a result. Fixture 1 is the control. Most other fixtures change one thing.

The map grammar is in the gate (`check-dev-ready.js`) and in this script. The two
copies are kept in step by hand. When the gate's grammar changes, change the
script and add a fixture here that the old script fails.

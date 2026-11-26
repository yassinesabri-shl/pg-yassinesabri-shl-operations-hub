# Discovery — <KEY>

<!--
  Discovery map template, v1.0. Part of the harness asset library c6f3b4427d58f7c3 (see VERSION.json) · 2026-11-14

  One map for each design, at docs/designs/<KEY>.discovery.md, beside
  docs/designs/<KEY>.lld.md. /dev-spec step 1 writes it. It records what the
  design seat read in the spoke, the searches it ran, the hits it ruled out and
  the rows it reused from an earlier story's map. The design pins the map on its
  `Discovery:` line with the first 12 characters of `git hash-object` of this
  file. scripts/read-discovery.mjs reads the maps on the trunk for a later story.

  The pickup gate reads this file. Delete this comment or keep it: the gate does
  not read a comment.
  - The three head lines: `Ticket:` is the design's key. `Repository:` is the
    design's repository. `Commit:` is the 40-character spoke commit that
    scripts/read-spoke.mjs printed. When the design's `Rules:` line is not
    `none`, `Commit:` starts with the commit of that line.
  - Find each section by its title. A section number is optional.
  - Path: relative to the spoke's root, as git prints it. Write no "./", no
    "." or ".." segment, no doubled or trailing "/", and no space, comma or
    colon.
  - Blob: the first 12 characters of the `Blob:` line that
    scripts/read-spoke.mjs printed for the path at `Commit:`.
  - Search: the scripts/read-spoke.mjs arguments after the repository id. It
    starts with `--grep ` or `--files `.
  - Hits and Kept: whole numbers. Kept is not more than Hits.
  - A Ruled out Search is a Search cell of the Searches table, copied.
  - Files read and Searches hold one row or more. Ruled out and Reused hold a
    table, or the token NONE on its own and no table.
  - Reused: Map is the `Cite:` line that scripts/read-discovery.mjs printed
    for that map, `<OTHER-KEY>.discovery.md@<12-hex>`. Path and Pin come from
    the printed row. Pin is `current`, `drift: <12-hex> → <12-hex>` or
    `drift: <12-hex> → removed`.
  - Why and Reason: one plain sentence each. A placeholder fails.
  - Each spoke path that the design cites is a row of Files read.
  - The path of each `drift: <old> → <new>` row of Reused is in Files read.
    Read a drifted file again. A removed file has no row in Files read.
-->

Ticket: <KEY>
Repository: <REPOSITORY-ID>
Commit: <40-hex — the Commit: line that scripts/read-spoke.mjs printed>

## Files read

| Path | Blob | Why |
|---|---|---|
| <path/to/file.ext> | <12-hex> | <what the design needs from this file> |

## Searches

| Search | Hits | Kept |
|---|---|---|
| `--grep <text> --paths <glob>` | <n> | <n> |

## Ruled out

| Path | Blob | Search | Reason |
|---|---|---|---|
| <path/to/other.ext> | <12-hex> | `--grep <text> --paths <glob>` | <why this hit is not in the change> |

## Reused

| Map | Path | Pin |
|---|---|---|
| <OTHER-KEY>.discovery.md@<12-hex> | <path/to/file.ext> | <current \| drift: 12-hex → 12-hex \| drift: 12-hex → removed> |

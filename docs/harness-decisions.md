<!-- Part of the harness asset library c6f3b4427d58f7c3 (see VERSION.json) · 2026-09-01 -->

# Harness decisions — pg-yassinesabri-shl-operations-hub

<!--
  The on-disk form of the Stage 1 decision record and the Stage 4 handover — one durable
  record, not a third document. Stage 1 writes §1–§2 before generation begins; generation
  appends §3–§5; Stage 4 prints its handover FROM this file. Lowercase angle-bracket tokens
  are authoring guidance and are filled per install; delete this comment once instantiated.
  Two standing rules (generation reference §4):
  - Absence is never inferred: all nine decisions get a row, default or override, asked or
    unasked — "we took the default" and "nobody asked" are different facts.
  - The register is a projection; the file headers are the fact. Where they disagree, the
    headers are right and the register is stale.
-->

## 1. Header

| Field | Value |
|---|---|
| Library hash | <the upstreamLibraryHash from VERSION.json> |
| Library file count | <the fileCount from VERSION.json> |
| Library content hash | <the contentHash from VERSION.json — this is the value that changes between library versions> |
| Library commit | <git -C $LIB rev-parse HEAD at generation; the receipt at docs/harness-install.json names the same commit> |
| Generated on | 2026-11-26 |
| Interviewed role | <the role that sat the interview — a role, never a named individual> |
| Primary runtime | <the primary agent runtime> |

## 2. The nine decisions

One row per decision. This is the section somebody reads in six months when they want to
know why a cap is 3. Every override here also carries an `SHL-OVERRIDE` line in the file it
shaped — one authoritative copy of the reason, in the machine-readable form.

| # | Decision | Recommended default | Chosen | Default or override | Override reason | Reference page |
|---|---|---|---|---|---|---|
| 1 | `delivery-plane` | <the default> | <what was chosen> | <which> | <one sentence, or none> | <path> |
| 2a | `deterministic-signal` | <the default> | <what was chosen> | <which> | <one sentence, or none> | <path> |
| 2b/9 | `persona-roster` | none — elicited | <the roster, or open> | <which> | <one sentence, or none> | <path> |
| 3 | `source-of-truth-hierarchy` | <the default> | <what was chosen> | <which> | <one sentence, or none> | <path> |
| 4 | `human-gate-map` | <the default> | <what was chosen> | <which> | <one sentence, or none> | <path> |
| 5 | `deny-by-default-scope` | <the default> | <what was chosen> | <which> | <one sentence, or none> | <path> |
| 6 | `eligibility-bar` | <the default> | <what was chosen> | <which> | <one sentence, or none> | <path> |
| 7 | `escalation-contract` | <the default> | <what was chosen> | <which> | <one sentence, or none> | <path> |
| 8 | `autonomy-level` | <the default> | <what was chosen> | <which> | <one sentence, or none> | <path> |

## 3. Every file

One row per file the run wrote. This table is what makes the copy rule checkable rather
than aspirational: a verbatim row is checked with `diff` against the library, an adapted row
is checked against its declared substitution list. The machine form of this table, with the
hash of every file written, is the install receipt `docs/harness-install.json`, written by
`node $LIB/scripts/upgrade.mjs --adopt` from the merged trunk; where the two disagree, the
receipt is right and this table is stale.

| Source | Destination | Mode | Substitutions applied |
|---|---|---|---|
| <accelerator/ path> | <target path> | <adapt or verbatim or new> | <the list actually applied, or none> |

## 4. Open items

Every `UNRESOLVED` marker written, every stub rule installed, and every `skill:` reference
removed — each with an owning role. An item leaves this table only when the file it lives in
changes, through review.

| Item | Where it lives | Owner (role) | Resolves when |
|---|---|---|---|
| <the marker or stub> | <file and line or section> | <role> | <trigger> |

## 5. What is uncalibrated

State it here rather than let it be inferred. At minimum: the persona roster where there was
no rejection history to mine (elicited = uncalibrated until fed back), and the eval surface,
which is a starter rather than an instrumented control — the newest, least field-proven
layer in the harness.

| Surface | Status | Calibration path |
|---|---|---|
| <persona roster / eval cases / other> | <uncalibrated or partial> | <what makes it calibrated, and who owns that> |

## 6. The estate

One row per spoke, written at the end of that spoke's install (`install-spoke.md` step 14) and
never before it. Each cell is an observation. The list itself lives in
`docs/estate/repositories.json`; this table records what was done to each repository the list
names, which the list does not carry.

| Repository id | Installed on | `checks.env` came from | Exception recorded | Probe (step 11) | `story-gate` required | Gate owners (step 7) |
|---|---|---|---|---|---|---|
| pg-yassinesabri-shl-orders-api | 2026-11-26 | the playground's own file, `examples/playground/install/orders-api/checks.env` | `^harness/` | not run: installed by the playground | requested by the playground |
| pg-yassinesabri-shl-fulfilment-service | 2026-11-26 | the playground's own file, `examples/playground/install/fulfilment-service/checks.env` | `^harness/` | not run: installed by the playground | requested by the playground |

## 7. Upgrades

One row per library version brought in, written by `scripts/upgrade.mjs` when it opens the
upgrade pull request and never by hand. Observations only: the current state of every file is
the receipt's, `docs/harness-install.json`. A file the upgrade could not settle lands beside the
original as `<name>.shl-new` and is listed in §4 until a person merges or deletes it.

| Date | From library commit | To library commit | Replaced | Merged | Proposed (`.shl-new`) | Pull request |
|---|---|---|---|---|---|---|
| <date> | <12 hex> | <12 hex> | <count of verbatim files replaced> | <count of adapted files merged clean> | <count, each listed in §4> | <reference> |

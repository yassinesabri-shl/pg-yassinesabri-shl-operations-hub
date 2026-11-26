# Decomposition — paid-at-cut-off

| Field | Value |
|---|---|
| Source | `docs/requirements/paid-at-cut-off/requirements.md` |
| Source revision | r1, merged 2026-10-20 with `check-requirements.js` green |
| Record revision | r1 |
| Date | 2026-10-20 |
| Key block | OPS-1 to OPS-2, taken from `docs/backlog/keys.json`; `next` moved to 3 in the same pull request |
| Review | `paid-at-cut-off.decomposition-review.md`, beside this record — the critic's final round, bound to this record's content hash |

## Coverage map

| Source section | Lines | Items | Disposition | Reason and owner |
|---|---|---|---|---|
| REQ-1 — a paid order states the time it was paid | L59-69 | OPS-1 (AC-1, AC-2, AC-3 carry REQ-1.AC-1, AC-2, AC-3) | Covered | pg-yassinesabri-shl-orders-api records the move to `paid` and is the one place the time can come from |
| REQ-2 — the pick list decides the cut-off from the payment time | L71-79 | OPS-2 (AC-1, AC-2, AC-3 carry REQ-2.AC-1, AC-2, AC-3) | Covered | pg-yassinesabri-shl-fulfilment-service builds the pick list |
| §7 Constraints | L81-85 | OPS-1, OPS-2 | Covered | UTC is OPS-1 AC-1 and the parse in OPS-2 AC-1 |
| §3 Scope — out of scope | L40-41 | deliberately none | Out of scope | Customer care's view, parked as CLAR-OPS-paid-01; operations lead |
| §2 Purpose and business outcome | L23-30 | deliberately none | Out of scope | The situation and the outcome, not a requirement; requirements author |
| §4 Definitions and §5 Parties | L43-55 | deliberately none | Out of scope | Terms and roles; requirements author |
| §9 CLAR-OPS-paid-01 | L103 | deliberately none | Out of scope | Non-blocking, and about customer care's screens, which neither repository serves; customer care lead |
| §10 Assumption A-1 | L109 | OPS-1 | Covered | The payment time is the time of the move to `paid`, which OPS-1 AC-1 states |
| §1 Document control and §8 Coverage map | L3-21, L87-97 | deliberately none | Out of scope | Document metadata and the document's own map; requirements author |

## Repository map

One row per repository the hub lists. `Read at` is the trunk commit the row's evidence came from,
as `scripts/read-spoke.mjs` printed it.

| Repository | Read at | Disposition | Stories, or the evidence read |
|---|---|---|---|
| `pg-yassinesabri-shl-orders-api` | `14070b378bfa` | Changes | OPS-1. The order is `pg-yassinesabri-shl-orders-api@14070b378bfa:internal/orders/order.go L27-36`, which keeps its transitions and no payment time; the answer's shape is `pg-yassinesabri-shl-orders-api@14070b378bfa:internal/httpapi/wire.go L28-38`; the move to `paid` is recorded by `Move`, `pg-yassinesabri-shl-orders-api@14070b378bfa:internal/orders/store.go L82-97` |
| `pg-yassinesabri-shl-fulfilment-service` | `0bc6fc437a94` | Changes | OPS-2. The pick list finds the payment time by searching the transitions, `pg-yassinesabri-shl-fulfilment-service@0bc6fc437a94:src/main/java/larder/fulfilment/picking/PickListService.java L41-43`, through `reached`, `pg-yassinesabri-shl-fulfilment-service@0bc6fc437a94:src/main/java/larder/fulfilment/orders/Order.java L16-20` |

## Items

| Key | Title | Repository | Carries |
|---|---|---|---|
| OPS-1 | Record the payment time on the order | `pg-yassinesabri-shl-orders-api` | REQ-1.AC-1, REQ-1.AC-2, REQ-1.AC-3 |
| OPS-2 | Decide the dispatch cut-off from the order's payment time | `pg-yassinesabri-shl-fulfilment-service` | REQ-2.AC-1, REQ-2.AC-2, REQ-2.AC-3 |

## Dependency map

| From | To | Type | Why |
|---|---|---|---|
| OPS-2 | OPS-1 | blocks | The pick list reads `paid_at`, and only pg-yassinesabri-shl-orders-api can write it (D-2) |

Acyclic: one edge.

## Decisions

| # | Decision | Alternatives rejected | Why | Date |
|---|---|---|---|---|
| D-1 | Two stories, one per repository | One story spanning both | A story names one repository; the seam is the one the state machine already has: pg-yassinesabri-shl-orders-api records, pg-yassinesabri-shl-fulfilment-service reads | 2026-10-20 |
| D-2 | OPS-2 depends on OPS-1 | No edge, with pg-yassinesabri-shl-fulfilment-service falling back to the transitions | REQ-2 asks for one source of the payment time; a fallback keeps the second source the brief asks to remove | 2026-10-20 |

## Clarifications

NONE

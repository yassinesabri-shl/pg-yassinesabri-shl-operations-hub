# OPS-2 — Decide the dispatch cut-off from the order's payment time

Key: OPS-2
Repository: pg-yassinesabri-shl-fulfilment-service
Context: ADR-002@9d215bd6f370:docs/architecture/ADR-002-times-are-utc.md, std-java-services@43ae1246246d:docs/standards/std-java-services.md, std-service-testing@818b73056094:docs/standards/std-service-testing.md, pg-yassinesabri-shl-fulfilment-service.ADR-001@b7c25b575973:pg-yassinesabri-shl-fulfilment-service:decisions/ADR-001-dispatch-cut-off.md
Hub commit: 650360aa7e48beb75f3129ddfdad9dbd5ab28b93
Tracker key: not created — the playground estate has no tracker, so the second invocation of
`/decompose` has not run. A real run writes the tracker's own reference here.

## Traceability

Derives from: `docs/requirements/paid-at-cut-off/requirements.md` § REQ-2 — The pick list decides the cut-off from the payment time L71-79

Read in the repository, at one pinned commit, through `scripts/read-spoke.mjs`:

- `pg-yassinesabri-shl-fulfilment-service@0bc6fc437a94:src/main/java/larder/fulfilment/orders/Order.java L8-20` — `Order`, the record of an order as pg-yassinesabri-shl-orders-api answers it
- `pg-yassinesabri-shl-fulfilment-service@0bc6fc437a94:src/main/java/larder/fulfilment/picking/PickListService.java L41-43` — where the pick list finds the payment time today
- `pg-yassinesabri-shl-fulfilment-service@0bc6fc437a94:src/main/java/larder/fulfilment/picking/DispatchCutoff.java L18-26` — the cut-off rule

## Acceptance criteria

| ID | Criterion | Type | Carries | Source |
|---|---|---|---|---|
| AC-1 | A paid order whose `paid_at` is one second before the cut-off for a dispatch date is on that date's pick list | positive | REQ-2.AC-1 | requirements § REQ-2 L77 |
| AC-2 | A paid order whose `paid_at` is exactly the cut-off is not on that date's pick list | negative | REQ-2.AC-2 | requirements § REQ-2 L78; `pg-yassinesabri-shl-fulfilment-service@0bc6fc437a94:src/main/java/larder/fulfilment/picking/DispatchCutoff.java L18-26` |
| AC-3 | A paid order with no `paid_at` is not on the pick list, is not moved to `picking`, and its id is in the answer's list of orders left out | negative | REQ-2.AC-3 | requirements § REQ-2 L79 |

The cut-off itself stays as pg-yassinesabri-shl-fulfilment-service.ADR-001 decides it, compared in UTC as ADR-002
requires. `paid_at` is a field of the `Order` record, as std-java-services.02 requires, and the
tests fix the clock and test one second before, at, and after the cut-off, as
std-service-testing.06 requires.

## Dependencies

Depends on OPS-1: pg-yassinesabri-shl-orders-api must answer `paid_at` before the pick list can read it (record D-2).

## Decisions

| # | Interpretation | Why it is defensible | Confidence | Source |
|---|---|---|---|---|
| D-1 | The pick list no longer reads the transitions to find the payment time | REQ-2 asks for one source, and a second one is how the disputed order arose | high | requirements § 2 L23-30 |

## Clarifications

NONE

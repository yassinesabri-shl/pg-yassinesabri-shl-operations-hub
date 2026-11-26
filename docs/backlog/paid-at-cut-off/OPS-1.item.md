# OPS-1 — Record the payment time on the order

Key: OPS-1
Repository: pg-yassinesabri-shl-orders-api
Context: ADR-001@530e736ef701:docs/architecture/ADR-001-orders-api-owns-order-state.md, ADR-002@9d215bd6f370:docs/architecture/ADR-002-times-are-utc.md, std-go-services@726fc51b9f2c:docs/standards/std-go-services.md, std-service-testing@818b73056094:docs/standards/std-service-testing.md, pg-yassinesabri-shl-orders-api.ADR-001@3a92a6422d2f:pg-yassinesabri-shl-orders-api:decisions/ADR-001-one-process-in-memory.md
Hub commit: 650360aa7e48beb75f3129ddfdad9dbd5ab28b93
Tracker key: not created — the playground estate has no tracker, so the second invocation of
`/decompose` has not run. A real run writes the tracker's own reference here.

## Traceability

Derives from: `docs/requirements/paid-at-cut-off/requirements.md` § REQ-1 — A paid order states the time it was paid L59-69

Read in the repository, at one pinned commit, through `scripts/read-spoke.mjs`:

- `pg-yassinesabri-shl-orders-api@14070b378bfa:internal/orders/order.go L27-36` — `Order`, which keeps transitions and no payment time
- `pg-yassinesabri-shl-orders-api@14070b378bfa:internal/orders/store.go L82-97` — `Move`, the one place a transition is recorded
- `pg-yassinesabri-shl-orders-api@14070b378bfa:internal/httpapi/wire.go L28-38` — `orderBody`, the order as the API answers it

## Acceptance criteria

| ID | Criterion | Type | Carries | Source |
|---|---|---|---|---|
| AC-1 | After `POST /v1/orders/{id}/transitions` to `paid`, the order's answer carries `paid_at`, the time of that transition in RFC 3339 UTC with the suffix `Z` | positive | REQ-1.AC-1 | requirements § REQ-1 L67; `pg-yassinesabri-shl-orders-api@14070b378bfa:internal/orders/store.go L82-97` |
| AC-2 | An order in the state `placed`, or `cancelled` from `placed`, answers with no `paid_at` field | negative | REQ-1.AC-2 | requirements § REQ-1 L68 |
| AC-3 | After the order moves on to `picking`, `packed` and `dispatched`, `paid_at` is the same value as after the move to `paid` | negative | REQ-1.AC-3 | requirements § REQ-1 L69 |

pg-yassinesabri-shl-orders-api writes the time, because ADR-001 makes it the only writer of an order's state, and in
UTC, as ADR-002 requires. The order stays in the one in-memory store under its lock, as
pg-yassinesabri-shl-orders-api.ADR-001 decides, and the tests pass `go test -race`, as std-go-services.05 requires.
Each test fixes the clock, as std-service-testing.03 requires.

## Dependencies

OPS-2 depends on this item (record D-2). This item depends on nothing.

## Decisions

| # | Interpretation | Why it is defensible | Confidence | Source |
|---|---|---|---|---|
| D-1 | `paid_at` is left out of the answer, not written as `null`, for an unpaid order | A missing field is what the answer does for every other value that does not apply, and pg-yassinesabri-shl-fulfilment-service maps only the fields it reads | medium | `pg-yassinesabri-shl-orders-api@14070b378bfa:internal/httpapi/wire.go L28-38` |

## Clarifications

NONE

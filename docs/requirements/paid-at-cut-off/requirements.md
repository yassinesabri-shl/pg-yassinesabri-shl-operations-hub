# Requirements — payment time on the order: the dispatch cut-off reads when an order was paid from the order itself

## 1. Document control

| Field | Value |
|---|---|
| Document revision | r1 |
| Date | 2026-10-20 |
| Owning role | Operations lead |
| Review | `requirements-review.md`, beside this document — the critic's final round, bound to this document's content hash; `check-requirements.js` reads both on the pull request and on the trunk |
| Slug | `paid-at-cut-off` |
| Source locator convention | note identifiers for `interview.md`; line ranges for the brief — both in `runs/20261020_1100/` |

**Sources this document is written from**, ranked before reading, per `CLAUDE.md` §4:

| Source (the copy in this repository) | Copied from | Revision | Rank | What it contributed |
|---|---|---|---|---|
| `docs/requirements/paid-at-cut-off/runs/20261020_1100/interview.md` | written here — the interview `/feature` ran with the operations lead | 2026-10-20 | 5 — wins a conflict with the brief | The owning role, where a left-out order is reported (REQ-2.AC-3), and the parked question |
| `docs/requirements/paid-at-cut-off/runs/20261020_1100/warehouse-brief.md` | the Larder operations team's shared folder, page "Cut-off and payment time" | version 1, 2026-10-16 | 5 | Every requirement and the constraint |

Both rank 5. The interview sharpens the brief once, at REQ-2.AC-3, and no conflict arose.

## 2. Purpose and business outcome

The warehouse builds each morning's pick list from the orders paid before the cut-off. Today the
pick list works out the payment time by searching each order's history of state changes, and two
people reading one disputed order gave two different payment times.

**The outcome this is judged by:** every paid order states one payment time, and the pick list
decides the cut-off from that time alone.

## 3. Scope

**In scope** — each line citing the source that puts it in:

- A payment time on every paid order, and none on an unpaid one — Derives from: `warehouse-brief.md` § What we need L24-28
- The pick list's cut-off decided from that payment time — Derives from: `warehouse-brief.md` § What we need L30-34

**Out of scope** — each line with the reason and the role who owns the exclusion:

- Showing the payment time to customer care — parked as a question that does not block the warehouse; owner: operations lead — Derives from: `warehouse-brief.md` § Not yet agreed L42; `interview.md` § note 4

## 4. Definitions

| Term | Definition as used here | Source |
|---|---|---|
| Payment time | The moment pg-yassinesabri-shl-orders-api recorded the order's move to `paid`, under ADR-001, which makes pg-yassinesabri-shl-orders-api the only system that changes an order's state | `warehouse-brief.md` § What we need L24 |
| Cut-off | The last moment an order can be paid and still be picked for a dispatch date | `warehouse-brief.md` § What we need L30-31 |

## 5. Parties

| Role | Interest in this document | Decisions they own | Source |
|---|---|---|---|
| Operations lead | Owns the outcome and signs this document | The cut-off rule | `interview.md` § note 2 |
| Customer care lead | May want the payment time on screen | Whether customer care sees it (CLAR-OPS-paid-01) | `warehouse-brief.md` § Not yet agreed L42 |

## 6. Requirements

### REQ-1 — A paid order states the time it was paid

Derives from: `warehouse-brief.md` § What we need L24-28

Every paid order carries one payment time, written in UTC as ADR-002 requires.

| ID | Criterion | Type | Source |
|---|---|---|---|
| REQ-1.AC-1 | A paid order carries its payment time, in UTC | positive | `warehouse-brief.md` § What we need L24, § Constraints L38 |
| REQ-1.AC-2 | An order that is not paid yet carries no payment time | negative | `warehouse-brief.md` § What we need L24-25 |
| REQ-1.AC-3 | The payment time of an order does not change when the order moves to a later state | negative | `warehouse-brief.md` § What we need L27-28 |

### REQ-2 — The pick list decides the cut-off from the payment time

Derives from: `warehouse-brief.md` § What we need L30-34

| ID | Criterion | Type | Source |
|---|---|---|---|
| REQ-2.AC-1 | An order paid one second before the cut-off is on the pick list for that dispatch date | positive | `warehouse-brief.md` § What we need L30-31 |
| REQ-2.AC-2 | An order paid at the cut-off is not on the pick list for that dispatch date | negative | `warehouse-brief.md` § What we need L31 |
| REQ-2.AC-3 | A paid order with no payment time is left out of the pick list, and the pick list names it | negative | `warehouse-brief.md` § What we need L33-34; `interview.md` § note 3 |

## 7. Constraints

| Constraint | Type | Source | Consequence if it does not hold |
|---|---|---|---|
| Every time is in UTC | operational | `warehouse-brief.md` § Constraints L38; ADR-002 | Two systems write one moment two ways, and the cut-off comparison fails on the day the clocks change |

## 8. Coverage map

| Source part | Locator | Requirements | Disposition | Reason and owner |
|---|---|---|---|---|
| Context header and copy note | L1-13 | deliberately none | Out of scope | Metadata added when the brief was copied in; recorded in §1; requirements author |
| Why we are asking | L15-20 | deliberately none | Represented | Carried into §2 as the situation |
| What we need — the payment time | L24-28 | REQ-1 | Represented | Fully carried |
| What we need — the cut-off | L30-34 | REQ-2 | Represented | Fully carried, with where a left-out order is named from the interview |
| Constraints | L36-38 | REQ-1 | Represented | REQ-1.AC-1 and the §7 row |
| Not yet agreed | L40-42 | deliberately none | Unresolved | Raised as CLAR-OPS-paid-01, non-blocking; customer care lead |
| Interview notes 1-4 | `interview.md` § note 1-4 | REQ-2 | Represented | Notes 1 and 2 confirm the reading and the role; note 3 is REQ-2.AC-3; note 4 is CLAR-OPS-paid-01 |

## 9. Clarifications

| ID | Question | Source | Blocking | Routed to | Status | Resolution | Resolved |
|---|---|---|---|---|---|---|---|
| CLAR-OPS-paid-01 | Should customer care see an order's payment time? | `warehouse-brief.md` § Not yet agreed L42; `interview.md` § note 4 | no | Customer care lead | Open |  |  |

## 10. Assumptions and decisions

| # | Interpretation | Why it is defensible | Confidence | Source |
|---|---|---|---|---|
| A-1 | The payment time is the time pg-yassinesabri-shl-orders-api recorded the move to `paid`, not a time the payment provider reports | ADR-001 makes pg-yassinesabri-shl-orders-api the only writer of an order's state, and the brief asks for one place | derived | `warehouse-brief.md` § What we need L24 |

Context: ADR-001@530e736ef701:docs/architecture/ADR-001-orders-api-owns-order-state.md, ADR-002@9d215bd6f370:docs/architecture/ADR-002-times-are-utc.md
Hub commit: 650360aa7e48beb75f3129ddfdad9dbd5ab28b93

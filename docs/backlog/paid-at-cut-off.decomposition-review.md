## Review: paid-at-cut-off — the decomposition against the requirements document

### VERDICT: APPROVED
Cycle: 1 of 2
Mode: decomposition-review
Reviewer: pm-critic
Record revision: 79aaab3569f39c409ee1ffb49c4640da18a1ee36

#### SUGGESTION
- [docs/backlog/paid-at-cut-off.decomposition.md:40] OPS-2's AC-3 names a list of orders left out in the pick list's answer; name the field in the design → the design states it, and the story need not

### Acceptance-criterion coverage

| AC | Criterion (short) | Covered where | Covered |
|---|---|---|---|
| REQ-1 L59-69 | a payment time on a paid order, none before, never changed | OPS-1 AC-1, AC-2, AC-3 | YES |
| REQ-2 L71-79 | the cut-off from the payment time; a left-out order named | OPS-2 AC-1, AC-2, AC-3 | YES |
| §7 Constraints L81-85 | UTC | OPS-1 AC-1 | YES |

Derived AC count: 3 · Derived covered: 3 · Author declared: 3 / 3 · Match: YES

### Citation spot-check

Sampled 4 of 12 citations (minimum 30%) · fabricated or drifted: 0 · NONE — `pg-yassinesabri-shl-fulfilment-service@0bc6fc437a94:src/main/java/larder/fulfilment/picking/PickListService.java L41-43` searches the transitions, as the repository map says

<!--
  Written beside the record by /decompose from the critic's returned text. The hash above is the
  record's bytes as reviewed.
-->

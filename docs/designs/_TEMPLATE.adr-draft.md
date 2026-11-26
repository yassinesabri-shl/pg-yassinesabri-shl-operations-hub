# ADR draft — <KEY>: <state the decision, not the topic>

<!--
  Draft decision record template, v2.0. A draft is what `/dev-spec` writes when a design
  meets a decision wider than its work item. It sits beside the design at
  `docs/designs/<KEY>.adr-draft.md`, the design's §9 links it from a blocking row routed to
  the lead architect, and the architect takes it to where the client keeps its records and
  decides there. It never becomes a record in this repository: the hub's record is the summary
  `/add-context --kind adr` writes once the decision is made, and the draft is deleted in the
  same amendment that cites it.

  Title discipline: the title is the decision in the imperative or the declarative.
    good  "<KEY>: Serve advisory eligibility from a read model, not the ledger"
    bad   "<KEY>: Eligibility architecture"
  A topic title invites a document that surveys. A decision title forces a document
  that decides.

  Length: two pages. If it is longer, the options are not yet narrowed.
-->

Work item: <KEY> · Design: docs/designs/<KEY>.lld.md · Routed to: lead architect

## 1. Context

<Two to four paragraphs. What is true today, what changed, and why a decision is
required now. Written so a reader who joins in six months understands the situation
without asking anyone.>

**Forces** — the pressures pulling in different directions:

| Force | Pushes toward |
|---|---|
| <e.g. read latency budget of 200ms at the 95th percentile> | <a denormalised read path> |
| <e.g. audit requirement for a single authoritative balance> | <reading from the ledger> |
| <e.g. team owns no streaming infrastructure today> | <the simpler synchronous option> |

**Constraints that are non-negotiable** — anything here removes options rather than
weighting them. State the source; a constraint without a source is a preference:

- <constraint> — source: <signed specification § title L<n> | contract <name> v<n> | applicable national technology-risk-management guidelines>
- <constraint> — source: <...>

## 2. Options considered

<!-- At least three. Each with a concrete downside. An option with no downside was not analysed. -->

### Option A — <name>

<Two or three sentences of mechanism: what would actually be built.>

- **Upside:** <specific>
- **Downside:** <specific and real, not a token concession>
- **Cost to reverse:** <low / medium / high, and why>

### Option B — <name>

<Mechanism.>

- **Upside:** <specific>
- **Downside:** <specific>
- **Cost to reverse:** <...>

### Option C — <name, often "do nothing" or "defer">

<Mechanism.>

- **Upside:** <specific>
- **Downside:** <specific>
- **Cost to reverse:** <...>

## 3. Decision

**We will <the decision, one sentence, active voice>.**

<Two or three paragraphs of reasoning. Which force won, and why. Name the option
that came closest and the specific reason it lost — that sentence is what stops the
question being reopened every sprint.>

## 4. Consequences

**Accepted costs** — things that are now worse, on purpose:

| Cost | Magnitude | Mitigation, or none |
|---|---|---|
| <e.g. eventual consistency of up to 2s on the read path> | <bounded, measurable> | <a staleness indicator in the response> |

**New obligations** — work this decision creates for whoever operates the system:

| Obligation | Owner | Where it is enforced |
|---|---|---|
| <e.g. a reconciliation job with an alert on drift> | <role> | <CI check, runbook, monitor> |
| <e.g. a coverage floor on the projection code> | <role> | <CI> |

## 5. Impact on cross-system contracts

| Contract | Version | Change | Owning system | Renegotiation needed |
|---|---|---|---|---|
| <name> | v<n> → v<n+1> | additive / breaking / none | <system> | yes / no |

If any row says breaking: the decision cannot be accepted until the owning system has
agreed the new version. A decision record cannot unilaterally redefine a shared
interface.

---

<!--
  Belongs in THIS draft: the choice between architectural options, the forces, the
  constraints, the reversal cost, cross-system impact. Belongs in the DESIGN instead: file
  paths, function signatures, data shapes, acceptance criteria, the testing plan. The record
  the hub keeps is shorter still: Decision, Rules, Why, Rejected, Accepted costs
  (`docs/architecture/_TEMPLATE.adr.md`). Write §3's 'came closest and why it lost' sentence
  so the architect can carry it into that summary's Rejected section unchanged.
-->
